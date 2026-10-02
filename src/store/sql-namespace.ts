/**
 * Where a component's tables live, kept apart from the SQL that names them.
 *
 * This is a fail-closed tripwire for the SQL we run ourselves — pi-durable's fixed statements and our
 * own — catching an upstream schema or statement change and our own bugs; it is not a sandbox for
 * untrusted SQL, and nothing passes untrusted SQL to it.
 *
 * Two components that each own a schema can share one database only if their
 * names cannot meet: pi-durable and AgentDO both have a `tasks` table, and a
 * Durable Object has exactly one SQLite database with no `ATTACH` and no
 * schemas (both are refused with SQLITE_AUTH). So a component's SQL is written
 * with its own logical names, and a `SqlNamespace` decides what each one is
 * called physically. On Durable Object SQLite that is a prefix, `pd_tasks`; on a
 * store with real schemas it would be `pd.tasks`, and only the namespace
 * changes — which is why this is an interface handed to the code that runs the
 * SQL rather than a prefix written into it. The same interface is meant to hold
 * our own tables later.
 *
 * The rewrite is an allowlist, not a pattern. A component declares every table
 * and index its schema creates; an identifier is rewritten only when it is one
 * of those names and stands where the grammar admits only a table or index
 * name; the same name anywhere else throws, since it could be a column or an
 * alias; string literals, comments and bound values are never touched; and a
 * statement that would create any name not on the list throws, so a
 * schema change upstream cannot land outside the namespace — it has to be read
 * and listed before it can land at all.
 */

export type SqlObjectKind = "table" | "index";

export interface SqlNamespace {
  /** The namespace's own name, `pd` for pi-durable. */
  readonly name: string;
  /**
   * The physical identifier for a logical name, as it is written in SQL. The kind is passed because
   * schema-based dialects do not qualify both alike: Postgres creates an index in its table's schema
   * and refuses a qualified index name in `CREATE INDEX`.
   */
  qualify(object: string, kind: SqlObjectKind): string;
}

/** Durable Object SQLite: one flat database, so the namespace is a name prefix, `pd_tasks`. */
export function prefixedNamespace(name: string): SqlNamespace {
  if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`namespace name must be lowercase letters and digits: ${name}`);
  return { name, qualify: (object) => `${name}_${object}` };
}

/** A component's logical schema: every table and index it creates. */
export type SqlObjects = { readonly tables: readonly string[]; readonly indexes: readonly string[] };

/** Words that may stand between CREATE and the kind of object it creates. */
const CREATE_MODIFIERS = new Set(["temp", "temporary", "unique", "virtual"]);
/** The kinds of object a CREATE names; a view or trigger name is never on a list, so creating one always throws. */
const CREATED_KINDS = new Set(["table", "index", "view", "trigger"]);
/** The conflict clause words in `UPDATE OR <word> <table>`. */
const CONFLICT_WORDS = new Set(["rollback", "abort", "replace", "fail", "ignore"]);
/**
 * The statements a component may run: the kinds pi-durable 1.0's SQLite storage and src/store/ap-store.ts
 * issue, and nothing else. PRAGMA, VACUUM, ATTACH, DETACH, REINDEX, ANALYZE, EXPLAIN and the transaction
 * statements address the database rather than a listed object, so they are refused whatever they name.
 */
const STATEMENT_KINDS = new Set(["select", "insert", "replace", "update", "delete", "create", "drop", "alter"]);
/**
 * Words that end a FROM or JOIN list at their own parenthesis depth: after them a comma is not a new
 * table. Ending a list early is the unsafe direction, so each is a reserved word SQLite refuses as an
 * alias, with or without AS. `do` and `window` are not here for that reason: SQLite accepts both as
 * an alias (`FROM meta do, sqlite_master`). A WINDOW clause after FROM therefore leaves the list
 * open, and its second window name reads as an unlisted table and throws, which is the safe failure.
 */
const FROM_LIST_ENDS = new Set([
  "where", "group", "having", "order", "limit", "union", "intersect", "except", "returning", "set", "values", "select",
]);
/** What can open a parenthesis at a FROM item and make it a subquery rather than a parenthesised join. */
const SUBQUERY_STARTS = new Set(["select", "with", "values"]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

type Token = {
  /** `word` is a bare identifier or keyword; `quoted` an identifier in quotes; `punct` one character. */
  type: "word" | "quoted" | "punct" | "literal";
  /** Lowercased for words and punctuation; the unquoted name for `quoted`. */
  text: string;
  raw: string;
  start: number;
  end: number;
};

/**
 * What the grammar admits at a word's position. `from` is a table in a FROM or JOIN item, where a
 * following `(` would make it a table-valued function instead.
 */
type Role = "from" | "table" | "index" | "created-table" | "created-index" | "created-other" | "renamed";

/**
 * Rewrites the logical names in one SQL text to the namespace's physical ones.
 *
 * Only SELECT, INSERT, REPLACE, UPDATE, DELETE, CREATE, DROP and ALTER statements are admitted, and
 * DROP VIEW / DROP TRIGGER are not (no view or trigger can be listed); anything else throws.
 *
 * A listed name is rewritten only where SQLite's grammar admits nothing but a table or index name:
 * the start of every item of a FROM or JOIN list, INTO, UPDATE [OR <conflict>], TABLE in CREATE /
 * DROP / ALTER [IF [NOT] EXISTS], INDEX in CREATE / DROP, `ON` directly after the index name of a
 * CREATE INDEX, REFERENCES, INDEXED BY, and RENAME TO. A FROM or JOIN list is followed per
 * parenthesis depth: it starts at FROM (not `IS DISTINCT FROM`) or JOIN, a comma at its depth starts
 * a new item whatever came before it — an alias with or without AS, a parenthesised subquery, an
 * `ON` or `USING` constraint — and it ends only at a clause keyword (WHERE, GROUP, ORDER, LIMIT, …),
 * at `;`, or at the `)` that closes its depth. An item that is itself a parenthesis is a subquery
 * when it starts with SELECT, WITH or VALUES, and otherwise a parenthesised join, whose first word is
 * an item too. Anywhere else a listed name could be a column, an alias, a CTE or a function, so
 * it throws rather than being rewritten or passed through — a column that shares a table's name
 * would otherwise be renamed with it. It also throws when quoted, before or after a `.` (a
 * qualified column or a schema-qualified name), when it names a table where an index belongs or
 * the reverse, and when a FROM item is followed by `(`. A CREATE of any table, index, view or
 * trigger, or a `RENAME TO`, whose name is not on the list throws, and so does any unlisted name
 * in a table or index position: the component can address nothing outside its namespace.
 */
export function qualifySql(sql: string, objects: SqlObjects, namespace: SqlNamespace): string {
  const known = new Map<string, SqlObjectKind>();
  for (const t of objects.tables) known.set(t.toLowerCase(), "table");
  for (const i of objects.indexes) known.set(i.toLowerCase(), "index");
  const refuse = (why: string) =>
    new Error(`SQL refused by the "${namespace.name}" namespace: ${why}\n  in: ${sql.slice(0, 200)}`);

  // Tokens, without whitespace or comments. String literals, comments and bound values are never touched.
  const tokens: Token[] = [];
  const push = (type: Token["type"], text: string, start: number, end: number) =>
    tokens.push({ type, text, raw: sql.slice(start, end), start, end });
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw refuse("an unterminated string literal");
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      push("literal", "'", i, j + 1); i = j + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw refuse("an unterminated comment");
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const end = sql.indexOf(close, i + 1);
      if (end === -1) throw refuse("an unterminated quoted identifier");
      push("quoted", sql.slice(i + 1, end), i, end + 1); i = end + 1;
      continue;
    }
    // Only `?` and `?NNN` parameters. A named one (`:x`, `@x`, `$x`, `#x`) is refused: SQLite's TCL
    // form `$a(...)` runs to the next `)`, quotes included, so tokenizing it as a name would put a
    // quote inside it out of step with SQLite's and let a string hide a statement. Nothing we run
    // uses them.
    if (c === ":" || c === "@" || c === "$" || c === "#") throw refuse(`a named parameter ("${c}"); only ? and ?NNN are admitted`);
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      push("literal", "number", i, j); i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql[j])) j++;
      push("word", sql.slice(i, j).toLowerCase(), i, j); i = j;
      continue;
    }
    push("punct", c, i, i + 1); i++;
  }

  const at = (k: number) => (k >= 0 ? tokens[k] : undefined);
  const word = (k: number, ...texts: string[]) => {
    const t = at(k);
    return t !== undefined && t.type === "word" && texts.includes(t.text);
  };

  // Statement kinds, and where each FROM or JOIN item starts. One flag per open parenthesis: whether
  // that depth is inside a FROM or JOIN list. Nothing here rewrites; it only marks and refuses.
  const fromItems = new Set<number>();
  {
    let inFrom: boolean[] = [false];
    let statementStart = true;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (statementStart) {
        if (t.type === "punct" && t.text === ";") continue;
        if (t.type !== "word" || !STATEMENT_KINDS.has(t.text)) {
          throw refuse(`a statement that starts with "${t.raw}": only ${[...STATEMENT_KINDS].join(", ").toUpperCase()} are admitted`);
        }
        if (t.text === "drop" && word(k + 1, "view", "trigger")) {
          throw refuse(`a DROP ${tokens[k + 1].raw.toUpperCase()} statement: no view or trigger is on a namespace's list`);
        }
        statementStart = false;
      }
      const d = inFrom.length - 1;
      if (t.type === "punct") {
        if (t.text === ";") {
          if (d !== 0) throw refuse("a `;` inside parentheses");
          inFrom = [false];
          statementStart = true;
        } else if (t.text === "(") {
          const next = tokens[k + 1];
          // A parenthesised join's first word is a FROM item; a subquery's is its own statement.
          const join = fromItems.has(k) && !(next?.type === "word" && SUBQUERY_STARTS.has(next.text));
          inFrom.push(join);
          if (join) fromItems.add(k + 1);
        } else if (t.text === ")") {
          if (d === 0) throw refuse("an unbalanced `)`");
          inFrom.pop();
        } else if (t.text === "," && inFrom[d]) {
          fromItems.add(k + 1);
        }
        continue;
      }
      if (t.type !== "word") continue;
      if ((t.text === "from" && !word(k - 1, "distinct")) || t.text === "join") {
        inFrom[d] = true;
        fromItems.add(k + 1);
      } else if (FROM_LIST_ENDS.has(t.text)) {
        inFrom[d] = false;
      }
    }
    if (inFrom.length !== 1) throw refuse("an unclosed `(`");
  }

  const roles: (Role | undefined)[] = [];
  /** Index of the keyword before an optional `IF EXISTS` / `IF NOT EXISTS` that ends just before `k`. */
  const beforeIfExists = (k: number) => {
    if (word(k - 1, "exists") && word(k - 2, "if")) return k - 3;
    if (word(k - 1, "exists") && word(k - 2, "not") && word(k - 3, "if")) return k - 4;
    return k - 1;
  };
  /** True when the CREATE that `kindAt` belongs to stands directly before it, past its modifiers. */
  const createdAt = (kindAt: number) => {
    let k = kindAt - 1;
    while (word(k, ...CREATE_MODIFIERS)) k--;
    return word(k, "create");
  };
  const roleOf = (k: number): Role | undefined => {
    // The words of an `IF [NOT] EXISTS` are the clause, not the name it precedes.
    if (word(k, "if") && (word(k + 1, "exists") || (word(k + 1, "not") && word(k + 2, "exists")))) return undefined;
    if (word(k, "not") && word(k - 1, "if") && word(k + 1, "exists")) return undefined;
    if (word(k, "exists") && (word(k - 1, "if") || (word(k - 1, "not") && word(k - 2, "if")))) return undefined;
    if (fromItems.has(k)) return "from";
    const p1 = at(k - 1);
    if (p1 === undefined || p1.type !== "word") return undefined;
    switch (p1.text) {
      case "into": return "table";
      case "update":
        // `ON CONFLICT ... DO UPDATE SET` names no table, and the `OR` of `UPDATE OR <conflict>` is not one.
        if (word(k - 2, "do")) return undefined;
        if (word(k, "or") && CONFLICT_WORDS.has(at(k + 1)?.text ?? "")) return undefined;
        return "table";
      case "references": return "table";
      case "on":
        // Only `CREATE INDEX <name> ON <table>`; `JOIN ... ON <expr>` is an expression.
        return roles[k - 2] === "created-index" ? "table" : undefined;
      case "by": return word(k - 2, "indexed") ? "index" : undefined;
      case "to": return word(k - 2, "rename") ? "renamed" : undefined;
    }
    if (CONFLICT_WORDS.has(p1.text) && word(k - 2, "or") && word(k - 3, "update")) return "table";
    const kindAt = beforeIfExists(k);
    const kind = at(kindAt);
    if (kind?.type !== "word" || !CREATED_KINDS.has(kind.text)) return undefined;
    if (createdAt(kindAt)) return kind.text === "table" ? "created-table" : kind.text === "index" ? "created-index" : "created-other";
    // DROP TABLE / ALTER TABLE / DROP INDEX, with IF EXISTS only where the grammar allows it.
    if (kind.text === "table" && word(kindAt - 1, "drop", "alter")) return "table";
    if (kind.text === "index" && word(kindAt - 1, "drop")) return "index";
    return undefined;
  };

  let out = "";
  let copied = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "word" && t.type !== "quoted") continue;
    const role = roleOf(k);
    roles[k] = role;
    const name = t.type === "word" ? t.text : t.text.toLowerCase();
    const kind = known.get(name);
    const next = at(k + 1);
    if (role === "created-table" || role === "created-index" || role === "created-other" || role === "renamed") {
      if (kind === undefined) throw refuse(`it would create "${t.type === "word" ? t.raw : t.text}", which is not on the namespace's list`);
      if (next?.type === "punct" && next.text === ".") throw refuse("a schema-qualified name in a CREATE or RENAME");
    }
    if (kind === undefined) {
      // An unlisted name where only a table or index can stand is outside the namespace: reading or
      // writing it would reach another component's table. pi-durable 1.0 addresses nothing but its
      // own listed objects, sqlite_master and pragma tables included, so there are no exceptions.
      if (role === "from" || role === "table" || role === "index") {
        throw refuse(`"${t.type === "word" ? t.raw : t.text}" stands where a table or index name belongs, and is not on the namespace's list`);
      }
      continue;
    }
    const shown = t.type === "word" ? t.raw : t.text;
    if (t.type === "quoted") throw refuse(`the quoted identifier "${shown}" is a listed name`);
    const p1 = at(k - 1);
    if (p1?.type === "punct" && p1.text === ".") throw refuse(`"${shown}" after "." is a column or a schema-qualified name, not a table to rewrite`);
    if (p1?.type === "word" && p1.text === "as") throw refuse(`"${shown}" after AS is an alias, and rewriting it would rename a row key`);
    if (next?.type === "punct" && next.text === ".") throw refuse(`"${shown}" before "." qualifies a column or names a schema; only a bare table name is rewritten`);
    if (role === undefined) throw refuse(`"${shown}" is a listed name in a position that is not a table or index name (a column, alias or function with the same name would be renamed)`);
    if (role === "from" && next?.type === "punct" && next.text === "(") throw refuse(`"${shown}" followed by "(" in FROM is a table-valued function, not a table`);
    const wants = role === "from" || role === "table" || role === "created-table" ? "table"
      : role === "index" || role === "created-index" ? "index"
      : role === "renamed" ? "table" : undefined;
    if (wants !== undefined && wants !== kind) throw refuse(`"${shown}" is a listed ${kind} where the grammar wants a ${wants}`);
    if (role === "created-other") throw refuse(`"${shown}" would be created as a view or trigger`);
    out += sql.slice(copied, t.start) + namespace.qualify(t.raw, kind);
    copied = t.end;
  }
  // A CREATE or RENAME TO that ends before its name.
  const last = tokens.at(-1);
  if (last !== undefined) {
    const k = tokens.length;
    if (word(k - 1, "to") && word(k - 2, "rename")) throw refuse("a CREATE or RENAME with no name");
    const kindAt = beforeIfExists(k);
    if (word(kindAt, ...CREATED_KINDS) && createdAt(kindAt)) throw refuse("a CREATE or RENAME with no name");
  }
  return out + sql.slice(copied);
}

/**
 * `qualifySql` for one component in one namespace, remembered per distinct text. A component's
 * statement set is fixed, and the texts that vary (scans assemble their WHERE from a handful of
 * clauses) are a bounded set too; the cap only bounds a caller that broke that assumption.
 */
export class SqlQualifier {
  #objects: SqlObjects;
  #namespace: SqlNamespace;
  #seen = new Map<string, string>();

  constructor(objects: SqlObjects, namespace: SqlNamespace) {
    this.#objects = objects;
    this.#namespace = namespace;
  }

  get namespace(): SqlNamespace { return this.#namespace; }

  rewrite(sql: string): string {
    let hit = this.#seen.get(sql);
    if (hit === undefined) {
      hit = qualifySql(sql, this.#objects, this.#namespace);
      if (this.#seen.size >= 512) this.#seen.clear();
      this.#seen.set(sql, hit);
    }
    return hit;
  }
}
