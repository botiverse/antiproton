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
 * of those names; string literals, comments and bound values are never touched;
 * and a statement that would create any name not on the list throws, so a
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

/** Words after which the next identifier is the name of something being created. */
const CREATED_KINDS = new Set(["table", "index", "view", "trigger"]);
const CREATE_MODIFIERS = new Set(["temp", "temporary", "unique", "virtual", "if", "not", "exists"]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/**
 * Rewrites the logical names in one SQL text to the namespace's physical ones.
 *
 * A listed name is rewritten wherever it stands as a bare identifier, including as
 * the qualifier in `tasks.id`. Three positions are refused rather than guessed
 * at, because in each one the same word could be something the rewrite must not
 * touch: after `.` (a column, or `main.tasks`), after `AS` (an alias, which
 * would rename a key in the returned row), and in quotes. A `CREATE` of any
 * table, index, view or trigger, or a `RENAME TO`, whose name is not on the
 * list throws.
 */
export function qualifySql(sql: string, objects: SqlObjects, namespace: SqlNamespace): string {
  const known = new Map<string, SqlObjectKind>();
  for (const t of objects.tables) known.set(t.toLowerCase(), "table");
  for (const i of objects.indexes) known.set(i.toLowerCase(), "index");
  const refuse = (why: string) =>
    new Error(`SQL refused by the "${namespace.name}" namespace: ${why}\n  in: ${sql.slice(0, 200)}`);

  let out = "";
  let i = 0;
  // The last significant token, lowercased: a word, or a single punctuation character.
  let prev = "";
  // Set while the next identifier names an object being created or renamed.
  let naming = false;
  let creating = false;
  // The previous identifier was a created name, so a following `.` means it was a schema qualifier.
  let namedLast = false;

  const identifier = (raw: string, quoted: boolean) => {
    const kind = known.get(raw.toLowerCase());
    if (naming) {
      if (kind === undefined) throw refuse(`it would create "${raw}", which is not on the namespace's list`);
      naming = false;
      namedLast = true;
    } else namedLast = false;
    if (kind === undefined) return raw;
    if (quoted) throw refuse(`the quoted identifier "${raw}" is a listed name`);
    if (prev === ".") throw refuse(`"${raw}" after "." is a column or a schema-qualified name, not a table to rewrite`);
    if (prev === "as") throw refuse(`"${raw}" after AS is an alias, and rewriting it would rename a row key`);
    return namespace.qualify(raw, kind);
  };

  while (i < sql.length) {
    const c = sql[i];
    // String literals and comments are copied untouched: data is never rewritten.
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw refuse("an unterminated string literal");
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      out += sql.slice(i, j + 1); i = j + 1; prev = "'"; namedLast = false;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? sql.length : end;
      out += sql.slice(i, j); i = j;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw refuse("an unterminated comment");
      out += sql.slice(i, end + 2); i = end + 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const end = sql.indexOf(close, i + 1);
      if (end === -1) throw refuse("an unterminated quoted identifier");
      out += sql.slice(i, end + 1);
      identifier(sql.slice(i + 1, end), true);
      prev = "ident"; i = end + 1;
      continue;
    }
    // Named parameters (`:x`, `@x`, `$x`) and numbers are not identifiers, whatever their letters spell.
    if ((c === ":" || c === "@" || c === "$") && i + 1 < sql.length && isIdentStart(sql[i + 1])) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql[j])) j++;
      out += sql.slice(i, j); i = j; prev = "param"; namedLast = false;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      out += sql.slice(i, j); i = j; prev = "number"; namedLast = false;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < sql.length && isIdentPart(sql[j])) j++;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      i = j;
      if (lower === "create") { creating = true; out += word; prev = lower; namedLast = false; continue; }
      if (creating && !naming && CREATED_KINDS.has(lower)) { naming = true; creating = false; out += word; prev = lower; continue; }
      if (naming && CREATE_MODIFIERS.has(lower)) { out += word; prev = lower; continue; }
      if (creating && CREATE_MODIFIERS.has(lower)) { out += word; prev = lower; continue; }
      if (lower === "to" && prev === "rename") { naming = true; out += word; prev = lower; continue; }
      creating = false;
      out += identifier(word, false);
      prev = lower;
      continue;
    }
    if (!/\s/.test(c)) {
      if (c === "." && namedLast) throw refuse("a schema-qualified name in a CREATE or RENAME");
      namedLast = false;
      prev = c;
    }
    out += c; i++;
  }
  if (naming) throw refuse("a CREATE or RENAME with no name");
  return out;
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
