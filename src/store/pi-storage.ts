/**
 * pi's durable `Storage` contract, backed by SQLite.
 *
 * pi's own backends materialise the whole session in memory, and the class that
 * does it says so: "intentionally unsuitable for database backends and
 * long-running sessions that may not fit in memory. Those backends should query
 * indexed durable state and update durable aggregates within each commit
 * transaction." That is the shape implemented here — nothing is held in memory
 * between calls, and `SessionStats` is a row that each commit updates rather
 * than a fold over the log.
 *
 * The point of implementing *their* interface rather than ours is that the
 * interface arrives with an executable specification: `createStorageConformance`
 * ships in the package, and `test/pi-storage.ts` runs all 21 of its cases
 * against this class. The parts of a session store that are hard to get right —
 * mixed-write atomicity, rollback across four tables, cursor-before-limit
 * ordering, admission order under concurrent commits — are exactly the parts we
 * would otherwise be testing against our own assumptions.
 *
 * One class serves both backends. The Durable Object gives `transactionSync`
 * directly; `test/pi-storage.ts` supplies the same three methods over
 * node:sqlite, so what the conformance suite certifies is what the object runs.
 */
import {
  prepareStorageCommit,
  resolveListReadOptions,
  validateCommittedWrites,
  type CommitResult,
  type CommittedWrite,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type ListElement,
  type ListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";

type Usage = SessionStats["usage"];

/** The slice of Durable Object storage this needs, and all that a test must fake. */
export type SqlHost = {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
  transactionSync<T>(cb: () => T): T;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pi_entries (
     id TEXT PRIMARY KEY, parent_id TEXT, seq INTEGER NOT NULL UNIQUE,
     timestamp INTEGER NOT NULL, type TEXT NOT NULL, custom_type TEXT, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pi_entries_seq ON pi_entries(seq)`,
  `CREATE INDEX IF NOT EXISTS pi_entries_parent ON pi_entries(parent_id)`,
  `CREATE TABLE IF NOT EXISTS pi_usage (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pi_usage_seq ON pi_usage(seq)`,
  `CREATE TABLE IF NOT EXISTS pi_values (
     namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
     PRIMARY KEY (namespace, key))`,
  `CREATE TABLE IF NOT EXISTS pi_list (
     namespace TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
     PRIMARY KEY (namespace, key, seq))`,
  `CREATE TABLE IF NOT EXISTS pi_meta (name TEXT PRIMARY KEY, body TEXT NOT NULL)`,
];

const CLOSED = "pi storage is closed";

/**
 * Usage arithmetic, reimplemented rather than imported: pi keeps `addUsage` at
 * `harness/utils/usage.js`, which its export map does not publish. The optional
 * fields have to stay absent when neither side has them, because the
 * conformance suite compares totals with deepStrictEqual.
 */
export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
      ? {} : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined
      ? {} : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

export class PiSqliteStorage implements Storage {
  #host: SqlHost;
  #now: () => number;
  #state: "open" | "closing" | "closed" = "open";
  /**
   * Commits are admitted synchronously and applied one at a time. A caller may
   * fire two without awaiting the first, and the second may name the first's
   * entry as its parent, so admission order has to be the order they land in.
   */
  #queue: Promise<unknown> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(host: SqlHost, opts: { now?: () => number } = {}) {
    this.#host = host;
    this.#now = opts.now ?? (() => Date.now());
    for (const stmt of SCHEMA) host.sql.exec(stmt);
  }

  #all(q: string, ...b: unknown[]): any[] { return this.#host.sql.exec(q, ...b).toArray(); }
  #one(q: string, ...b: unknown[]): any { return this.#all(q, ...b)[0]; }

  #meta<T>(name: string, fallback: T): T {
    const row = this.#one("SELECT body FROM pi_meta WHERE name = ?", name);
    return row === undefined ? fallback : JSON.parse(row.body) as T;
  }

  #setMeta(name: string, body: unknown) {
    this.#host.sql.exec(
      "INSERT INTO pi_meta(name, body) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      name, JSON.stringify(body));
  }

  #stats(): SessionStats {
    return {
      messageCount: this.#meta<number>("message_count", 0),
      usage: this.#meta<Usage>("usage", emptyUsage()),
    };
  }

  /** Reads reject the moment close is called, before the drain finishes. */
  #read<T>(fn: () => T): Promise<T> {
    if (this.#state !== "open") return Promise.reject(new Error(CLOSED));
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }

  commit(writes: Write[], _context: Context): Promise<CommitResult> {
    if (this.#state !== "open") return Promise.reject(new Error(CLOSED));
    const result = this.#queue.then(() => this.#commitNow(writes));
    // A failed commit must not poison the ones queued behind it.
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * No state check here, deliberately. Closing seals *admission*; a commit that
   * was already admitted still has to land, which is what lets close() promise
   * that nothing accepted was dropped.
   */
  #commitNow(writes: Write[]): CommitResult {
    return this.#host.transactionSync(() => {
      const firstSeq = this.#meta<number>("next_seq", 1);
      const prepared = prepareStorageCommit(writes, firstSeq, this.#now());
      // Validation runs inside the transaction so a rejected batch leaves the
      // sequence high-water mark where it was, along with everything else.
      validateCommittedWrites(prepared.writes, firstSeq, {
        hasEntryOrUsageId: (id) =>
          this.#one("SELECT 1 AS x FROM pi_entries WHERE id = ?", id) !== undefined ||
          this.#one("SELECT 1 AS x FROM pi_usage WHERE id = ?", id) !== undefined,
        hasEntryId: (id) => this.#one("SELECT 1 AS x FROM pi_entries WHERE id = ?", id) !== undefined,
      });
      const stats = this.#apply(prepared.writes);
      return { ...prepared.result, stats };
    });
  }

  #apply(writes: readonly CommittedWrite[]): SessionStats {
    let { messageCount, usage } = this.#stats();
    let nextSeq: number | null = null;

    for (const write of writes) {
      nextSeq = write.seq + 1;
      switch (write.kind) {
        case "entry": {
          const { kind: _kind, ...entry } = write;
          this.#host.sql.exec(
            `INSERT INTO pi_entries(id, parent_id, seq, timestamp, type, custom_type, body)
             VALUES (?,?,?,?,?,?,?)`,
            entry.id, entry.parentId, entry.seq, entry.timestamp, entry.type,
            entry.customType ?? null, JSON.stringify(entry));
          if (entry.type === "message") messageCount += 1;
          break;
        }
        case "usage": {
          const { kind: _kind, ...row } = write;
          this.#host.sql.exec("INSERT INTO pi_usage(id, seq, body) VALUES (?,?,?)",
            row.id, row.seq, JSON.stringify(row));
          usage = addUsage(usage, row.usage);
          break;
        }
        case "value": {
          if (write.op === "delete") {
            this.#host.sql.exec("DELETE FROM pi_values WHERE namespace = ? AND key = ?",
              write.namespace, write.key);
          } else {
            this.#host.sql.exec(
              `INSERT INTO pi_values(namespace, key, seq, body) VALUES (?,?,?,?)
               ON CONFLICT(namespace, key) DO UPDATE SET seq = excluded.seq, body = excluded.body`,
              write.namespace, write.key, write.seq, JSON.stringify(write.value ?? null));
          }
          break;
        }
        case "list": {
          if (write.op === "delete") {
            this.#host.sql.exec("DELETE FROM pi_list WHERE namespace = ? AND key = ?",
              write.namespace, write.key);
          } else {
            this.#host.sql.exec("INSERT INTO pi_list(namespace, key, seq, body) VALUES (?,?,?,?)",
              write.namespace, write.key, write.seq, JSON.stringify(write.value ?? null));
          }
          break;
        }
      }
    }

    // An empty commit is legal and must not move the mark or the totals.
    if (nextSeq !== null) {
      this.#setMeta("next_seq", nextSeq);
      this.#setMeta("message_count", messageCount);
      this.#setMeta("usage", usage);
    }
    return { messageCount, usage };
  }

  getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    return this.#read(() => {
      const found = new Map<string, Entry>();
      if (ids.length === 0) return found;
      const rows = this.#all(
        `SELECT body FROM pi_entries WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
      const byId = new Map<string, Entry>();
      for (const r of rows) { const e = JSON.parse(r.body) as Entry; byId.set(e.id, e); }
      // Requested order, not storage order, and absent ids simply stay absent.
      for (const id of ids) { const e = byId.get(id); if (e !== undefined) found.set(id, e); }
      return found;
    });
  }

  getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    return this.#read(() => {
      const row = this.#one("SELECT seq, body FROM pi_values WHERE namespace = ? AND key = ?",
        address.namespace, address.key);
      if (row === undefined) return undefined;
      return { address, value: JSON.parse(row.body) as T, seq: Number(row.seq) };
    });
  }

  scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    return this.#read(() => {
      // substr rather than LIKE: SQLite's LIKE folds ASCII case, which would
      // match keys that are not under this prefix. ORDER BY uses BINARY, whose
      // byte order over UTF-8 is the code-point order pi sorts by.
      const rows = this.#all(
        `SELECT key, seq, body FROM pi_values
          WHERE namespace = ? AND substr(key, 1, length(?)) = ? ORDER BY key`,
        prefix.namespace, prefix.key, prefix.key);
      return rows.map((r) => ({
        address: { namespace: prefix.namespace, key: String(r.key), kind: "value" } as Value<T>,
        value: JSON.parse(r.body) as T,
        seq: Number(r.seq),
      }));
    });
  }

  readList<T>(
    address: ValueList<T>, options: ListReadOptions | undefined, _context: Context,
  ): Promise<ListElement<T>[]> {
    return this.#read(() => {
      const resolved = resolveListReadOptions(options);
      const asc = resolved.order === "asc";
      const bounds = resolved.cursor === undefined
        ? { clause: "", args: [] as unknown[] }
        : { clause: asc ? " AND seq > ?" : " AND seq < ?", args: [resolved.cursor.seq] };
      const rows = this.#all(
        `SELECT seq, body FROM pi_list WHERE namespace = ? AND key = ?${bounds.clause}
          ORDER BY seq ${asc ? "ASC" : "DESC"} LIMIT ?`,
        address.namespace, address.key, ...bounds.args, resolved.limit);
      return rows.map((r) => ({ seq: Number(r.seq), value: JSON.parse(r.body) as T }));
    });
  }

  scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    return this.#read(() => this.#branch(query));
  }

  scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
    return this.#read(() => this.#branch(query).map((entry) => ({
      id: entry.id,
      parentId: entry.parentId,
      seq: entry.seq,
      timestamp: entry.timestamp,
      type: entry.type,
      ...(entry.customType === undefined ? {} : { customType: entry.customType }),
    })));
  }

  /**
   * One recursive query walks the ancestry, then the path is re-linked in
   * JavaScript. The relink is not redundant: it is what distinguishes a chain
   * that ends at a root from one whose parent row is missing, which pi requires
   * to be an error rather than a short answer.
   */
  #branch(query: StorageBranchScan): Entry[] {
    const rows = this.#all(
      `WITH RECURSIVE ancestry(id, parent_id, body) AS (
         SELECT id, parent_id, body FROM pi_entries WHERE id = ?
         UNION ALL
         SELECT e.id, e.parent_id, e.body FROM pi_entries e
           JOIN ancestry a ON e.id = a.parent_id)
       SELECT id, parent_id, body FROM ancestry`,
      query.start);
    if (rows.length === 0) throw new Error(`Unknown branch start: ${query.start}`);

    const byId = new Map<string, Entry>();
    for (const r of rows) { const e = JSON.parse(r.body) as Entry; byId.set(e.id, e); }

    const path: Entry[] = [];
    let entry = byId.get(query.start)!;
    for (;;) {
      path.push(entry);
      if (entry.parentId === null) break;
      const parent = byId.get(entry.parentId);
      if (parent === undefined) throw new Error("Corrupt branch: missing parent");
      entry = parent;
    }

    if (query.order === "oldestFirst") path.reverse();

    // Order first, then stop, then filter, then cursor, then limit. The stop is
    // inclusive of the entry that triggered it.
    const stopped: Entry[] = [];
    for (const candidate of path) {
      stopped.push(candidate);
      if (candidate.id === query.stopAtId || candidate.type === query.stopAtType) break;
    }
    const filtered = stopped.filter((c) =>
      (query.type === undefined || c.type === query.type) &&
      (query.customType === undefined || c.customType === query.customType) &&
      (query.cursor === undefined ||
        (query.order === "oldestFirst" ? c.seq > query.cursor.seq : c.seq < query.cursor.seq)));
    return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
  }

  scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    return this.#read(() => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (query.type !== undefined) { where.push("type = ?"); args.push(query.type); }
      if (query.customType !== undefined) { where.push("custom_type = ?"); args.push(query.customType); }
      if (query.fromSeq !== undefined) { where.push("seq >= ?"); args.push(query.fromSeq); }
      if (query.toSeq !== undefined) { where.push("seq <= ?"); args.push(query.toSeq); }
      const rows = this.#all(
        `SELECT body FROM pi_entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} ${limitClause(query.limit)}`,
        ...args);
      return rows.map((r) => JSON.parse(r.body) as Entry);
    });
  }

  scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    return this.#read(() => {
      const where: string[] = [];
      const args: unknown[] = [];
      if (query.fromSeq !== undefined) { where.push("seq >= ?"); args.push(query.fromSeq); }
      if (query.toSeq !== undefined) { where.push("seq <= ?"); args.push(query.toSeq); }
      const rows = this.#all(
        `SELECT body FROM pi_usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} ${limitClause(query.limit)}`,
        ...args);
      return rows.map((r) => JSON.parse(r.body) as UsageRow);
    });
  }

  getStats(_context: Context): Promise<SessionStats> {
    return this.#read(() => this.#stats());
  }

  /** Seals admission at once, drains what was already admitted, and is idempotent. */
  close(_context: Context): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#closePromise = this.#queue.then(() => { this.#state = "closed"; });
    return this.#closePromise;
  }
}

/** A limit of zero is a real answer — an empty page — not "no limit". */
function limitClause(limit: number | undefined): string {
  if (limit === undefined) return "";
  return `LIMIT ${Math.max(0, Math.trunc(limit))}`;
}
