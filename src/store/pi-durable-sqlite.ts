/**
 * pi-durable's `SqliteDatabase` facade over a Durable Object's own SQLite.
 *
 * `@earendil-works/pi-durable/storage/sqlite` is a portable storage core that
 * asks for four async statements and an async `transaction(callback)`. A Durable
 * Object offers neither directly: `transactionSync` takes only a synchronous
 * callback, and the runtime rejects SQL `BEGIN` and `SAVEPOINT`. What it does
 * offer is `ctx.storage.transaction(async () => ...)`, which commits `sql.exec`
 * writes made across awaits and rolls them back when the closure throws — a
 * savepoint over the object's one connection. Being a savepoint over the one
 * connection is also its hazard: any `sql.exec` issued while it is open, on any
 * table, joins it and rolls back with it. Every call through this facade waits
 * behind an open transaction (the queue below), but the queue orders only this
 * facade's calls — other code in the object that runs `sql.exec` while one is
 * open is not kept out. `test/pi-durable.ts` pins the facade's half: a throwing
 * transaction leaves no rows, and a write queued behind it survives.
 *
 * pi-durable's schema names a table `tasks`, and so does `AgentDO`'s
 * (src/store/durable-object.ts). Its migrations say `CREATE TABLE tasks` with no
 * `IF NOT EXISTS`, so in an object that has ours pi-durable fails to open, and
 * in one where pi-durable came first ours would silently adopt its table. Every
 * name pi-durable's schema creates is therefore rewritten to carry `pd_`. The statement set is fixed and small, so
 * the rewrite is an allowlist rather than a pattern: an identifier is renamed
 * only when it is one of the names below, string literals and bound values are
 * never touched, and a statement that would create any name not on the list
 * throws — so an upstream schema change cannot land unprefixed beside our
 * tables, and has to be read before it can land at all.
 */
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

/** The slice of `ctx.storage` this needs, and all that a test must fake. */
export type DurableSqlHost = {
  sql: { exec(query: string, ...bindings: SqlBinding[]): { toArray(): Array<Record<string, SqlCell>> } };
  transaction<T>(closure: () => Promise<T>): Promise<T>;
};
type SqlBinding = string | number | null | Uint8Array;
/** A Durable Object returns blobs as `ArrayBuffer`; node:sqlite returns `Uint8Array` and may return `bigint`. */
type SqlCell = string | number | bigint | null | ArrayBuffer | Uint8Array;

export const PI_DURABLE_PREFIX = "pd_";

/**
 * Everything pi-durable's schema creates (`dist/storage/sqlite/migrations.js`):
 * its nine tables, `durable_schema` among them, and their sixteen indexes.
 * Indexes share the table namespace in SQLite, so they are prefixed too.
 * Depends on: @earendil-works/pi-durable 1.0.0 — an upgrade that adds a
 * migration fails here (a CREATE of an unlisted name) and in
 * test/spec/pi-durable-spec.ts, which compares this list with the migrations.
 */
export const PI_DURABLE_TABLES = [
  "durable_schema", "durable_metadata", "record_ids", "conversations", "entries",
  "tasks", "submissions", "documents", "document_revisions",
] as const;
export const PI_DURABLE_INDEXES = [
  "conversations_by_owner_conversation", "conversations_by_owner_task",
  "entries_by_conversation", "entry_heads_by_conversation",
  "tasks_by_status", "tasks_by_conversation", "tasks_by_kind", "tasks_by_abort_requested", "tasks_by_background",
  "submissions_by_request", "submissions_by_conversation", "submissions_by_status",
  "documents_by_address", "documents_by_scope", "documents_by_scope_kind",
  "document_revisions_by_kind",
] as const;
const KNOWN: ReadonlySet<string> = new Set<string>([...PI_DURABLE_TABLES, ...PI_DURABLE_INDEXES]);

/** Words after which the next identifier is the name of something being created. */
const CREATED_KINDS = new Set(["table", "index", "view", "trigger"]);
const CREATE_MODIFIERS = new Set(["temp", "temporary", "unique", "virtual", "if", "not", "exists"]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

const refuse = (why: string, sql: string) =>
  new Error(`pi-durable SQL refused by the ${PI_DURABLE_PREFIX} prefix facade: ${why}\n  in: ${sql.slice(0, 200)}`);

/**
 * Rewrites pi-durable's own table and index names to carry the prefix.
 *
 * A known name is renamed wherever it stands as a bare identifier, including as
 * the qualifier in `tasks.id`. Three positions are refused rather than guessed
 * at, because in each one the same word could be something the rename must not
 * touch: after `.` (a column, or `main.tasks`), after `AS` (an alias, which
 * would rename a key in the returned row), and in quotes. A `CREATE` of any
 * table, index, view or trigger, or a `RENAME TO`, whose name is not on the
 * list throws.
 */
export function prefixPiDurableSql(sql: string): string {
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
    const lower = raw.toLowerCase();
    if (naming) {
      if (!KNOWN.has(lower)) throw refuse(`it would create "${raw}", which is not on the list of pi-durable's schema objects`, sql);
      naming = false;
      namedLast = true;
    } else namedLast = false;
    if (!KNOWN.has(lower)) return raw;
    if (quoted) throw refuse(`the quoted identifier "${raw}" names one of pi-durable's objects`, sql);
    if (prev === ".") throw refuse(`"${raw}" after "." is a column or a schema-qualified name, not a table to rename`, sql);
    if (prev === "as") throw refuse(`"${raw}" after AS is an alias, and renaming it would rename a row key`, sql);
    return PI_DURABLE_PREFIX + raw;
  };

  while (i < sql.length) {
    const c = sql[i];
    // String literals and comments are copied untouched: data is never rewritten.
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw refuse("an unterminated string literal", sql);
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
      if (end === -1) throw refuse("an unterminated comment", sql);
      out += sql.slice(i, end + 2); i = end + 2;
      continue;
    }
    if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const end = sql.indexOf(close, i + 1);
      if (end === -1) throw refuse("an unterminated quoted identifier", sql);
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
      if (c === "." && namedLast) throw refuse("a schema-qualified name in a CREATE or RENAME", sql);
      namedLast = false;
      prev = c;
    }
    out += c; i++;
  }
  if (naming) throw refuse("a CREATE or RENAME with no name", sql);
  return out;
}

// The statement set is fixed, so the rewrite is computed once per distinct text. The texts that
// vary (scans assemble their WHERE from a handful of clauses) are a bounded set too; the cap is
// only so that a caller that broke that assumption costs memory linearly in nothing.
const REWRITTEN = new Map<string, string>();
function rewrite(sql: string): string {
  let hit = REWRITTEN.get(sql);
  if (hit === undefined) {
    hit = prefixPiDurableSql(sql);
    if (REWRITTEN.size >= 512) REWRITTEN.clear();
    REWRITTEN.set(sql, hit);
  }
  return hit;
}

/**
 * The Durable Object binds no `bigint`, and pi-durable's value type allows one. A safe integer is
 * passed as a number; anything else throws rather than being narrowed or stringified, because a
 * silently different value in a STRICT INTEGER column is worse than a refusal.
 */
function bindValue(value: SqliteValue): SqlBinding {
  if (typeof value !== "bigint") return value;
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  throw new RangeError(`cannot bind ${value}n: a Durable Object binds integers only as JavaScript numbers`);
}

function readRow(row: Record<string, SqlCell>): Record<string, SqliteValue> {
  const out: Record<string, SqliteValue> = {};
  for (const [key, cell] of Object.entries(row)) out[key] = cell instanceof ArrayBuffer ? new Uint8Array(cell) : cell;
  return out;
}

function query(host: DurableSqlHost, sql: string, params: readonly SqliteValue[]): Array<Record<string, SqliteValue>> {
  return host.sql.exec(rewrite(sql), ...params.map(bindValue)).toArray().map(readRow);
}

/**
 * One operation at a time, in call order. A plain statement runs at once when nothing is queued,
 * so a read outside a transaction costs no extra turn; anything issued while a transaction is open
 * waits for it to settle.
 */
class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  run<T>(operation: () => T): Promise<T> {
    if (this.#pending > 0) return this.enqueue(async () => operation());
    try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#pending++;
    const settled = this.#tail.then(operation).finally(() => { this.#pending--; });
    this.#tail = settled.then(() => undefined, () => undefined);
    return settled;
  }
}

// The row type is the caller's claim about its own SELECT; nothing here can check it, which is the
// contract pi-durable's `get<T>`/`all<T>` declare.
const asRows = <T extends object>(rows: Array<Record<string, SqliteValue>>) => rows as unknown as T[];

class TransactionHandle implements SqliteExecutor {
  #host: DurableSqlHost;
  #active = true;
  constructor(host: DurableSqlHost) { this.#host = host; }
  revoke() { this.#active = false; }

  #use<T>(operation: (host: DurableSqlHost) => T): Promise<T> {
    if (!this.#active) return Promise.reject(new Error("SQLite transaction handle is no longer active"));
    try { return Promise.resolve(operation(this.#host)); } catch (error) { return Promise.reject(error); }
  }
  exec(sql: string) { return this.#use((h) => { query(h, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.#use((h) => { query(h, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((h) => asRows<T>(query(h, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((h) => asRows<T>(query(h, sql, params))); }
}

export class PiDurableSqlite implements SqliteDatabase {
  #host: DurableSqlHost;
  #queue = new SerialQueue();
  #closed = false;

  constructor(host: DurableSqlHost) { this.#host = host; }

  #use<T>(operation: (host: DurableSqlHost) => T): Promise<T> {
    return this.#queue.run(() => {
      if (this.#closed) throw new Error("database is closed");
      return operation(this.#host);
    });
  }
  exec(sql: string) { return this.#use((h) => { query(h, sql, []); }); }
  run(sql: string, ...params: SqliteValue[]) { return this.#use((h) => { query(h, sql, params); }); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((h) => asRows<T>(query(h, sql, params))[0]); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#use((h) => asRows<T>(query(h, sql, params))); }

  /**
   * The host's transaction rejects with the closure's own error after rolling back. If the rollback
   * itself failed, the Durable Object gives no separate signal, so the "different error" pi-durable's
   * contract asks for in that case cannot be produced here.
   */
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#queue.enqueue(async () => {
      if (this.#closed) throw new Error("database is closed");
      const handle = new TransactionHandle(this.#host);
      try {
        return await this.#host.transaction(async () => {
          try { return await callback(handle); } finally { handle.revoke(); }
        });
      } finally { handle.revoke(); }
    });
  }

  close() { return this.#queue.run(() => { this.#closed = true; }); }
}
