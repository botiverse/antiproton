/**
 * Where a component's tables live, kept apart from the SQL that names them.
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
 * following `(` would make it a table-valued function instead; `either` is REINDEX and ANALYZE.
 */
type Role = "from" | "table" | "index" | "either" | "created-table" | "created-index" | "created-other" | "renamed";

/**
 * Rewrites the logical names in one SQL text to the namespace's physical ones.
 *
 * A listed name is rewritten only where SQLite's grammar admits nothing but a table or index name:
 * after FROM (not `IS DISTINCT FROM`), JOIN, a comma continuing a FROM or JOIN list, INTO, UPDATE
 * [OR <conflict>], TABLE in CREATE / DROP / ALTER [IF [NOT] EXISTS], INDEX in CREATE / DROP,
 * `ON` directly after the index name of a CREATE INDEX, REFERENCES, INDEXED BY, REINDEX, ANALYZE,
 * and RENAME TO. Anywhere else a listed name could be a column, an alias, a CTE or a function, so
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
    // Named parameters (`:x`, `@x`, `$x`) and numbers are not identifiers, whatever their letters spell.
    if ((c === ":" || c === "@" || c === "$") && i + 1 < sql.length && isIdentStart(sql[i + 1])) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql[j])) j++;
      push("literal", "param", i, j); i = j;
      continue;
    }
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

  const roles: (Role | undefined)[] = [];
  const at = (k: number) => (k >= 0 ? tokens[k] : undefined);
  const word = (k: number, ...texts: string[]) => {
    const t = at(k);
    return t !== undefined && t.type === "word" && texts.includes(t.text);
  };
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
    const p1 = at(k - 1);
    if (p1 === undefined) return undefined;
    if (p1.type === "punct") {
      // `FROM a, b` and `JOIN a, b`: a comma straight after a FROM item continues the list.
      if (p1.text === "," && roles[k - 2] === "from") return "from";
      return undefined;
    }
    if (p1.type !== "word") return undefined;
    switch (p1.text) {
      case "from": return word(k - 2, "distinct") ? undefined : "from";
      case "join": return "from";
      case "into": return "table";
      case "update":
        // `ON CONFLICT ... DO UPDATE SET` names no table, and the `OR` of `UPDATE OR <conflict>` is not one.
        if (word(k - 2, "do")) return undefined;
        if (word(k, "or") && CONFLICT_WORDS.has(at(k + 1)?.text ?? "")) return undefined;
        return "table";
      case "references": return "table";
      case "reindex": case "analyze": return "either";
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
      if (role === "from" || role === "table" || role === "index" || role === "either") {
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
