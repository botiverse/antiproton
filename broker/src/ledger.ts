/**
 * Who owns what, and what existed for how long.
 *
 * One Durable Object for the whole deployment, not one per tenant, because the
 * questions this exists to answer are cross-tenant: "what has everyone used"
 * cannot be assembled from objects that can only see themselves. That is
 * precisely the gap this fills — container lifetimes are already written into
 * each agent's own connection state, and being inside a per-agent object is
 * exactly why nothing can report on them.
 *
 * Ownership and audit are the same row. A box's row is created when the box is,
 * and closed when it goes; "who may touch this" and "how long did this exist"
 * are two readings of one fact, and keeping them apart would let them disagree.
 *
 * **Append-only.** Rows are closed, never deleted. A deleted box that left no
 * trace is the case an audit exists for.
 *
 * **No money here.** Seconds and counts only. Rates change, and an amount
 * computed from the rate of the day it was written is wrong from then on
 * without anything saying so — the cost belongs to whoever reads, at the rate
 * that is current when they read.
 */
export interface BoxRow {
  tenantId: string;
  agentId: string;
  boxId: string;
  startedAt: number;
  /** Null while it is still there — which is the reading that matters. */
  endedAt: number | null;
  execs: number;
}

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS boxes (
     box_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     started_at INTEGER NOT NULL, ended_at INTEGER, execs INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS boxes_by_tenant ON boxes (tenant_id, started_at)`,
  // Reachable by their own ids, so ownership is recorded rather than derived.
  `CREATE TABLE IF NOT EXISTS execs (
     exec_id TEXT PRIMARY KEY, box_id TEXT NOT NULL, tenant_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS snaps (
     snap_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, at INTEGER NOT NULL)`,
  // A token is a name for a tenant, kept as a hash: the broker can recognise
  // one presented to it and cannot reproduce one it was never given.
  `CREATE TABLE IF NOT EXISTS tokens (
     hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
     issued_at INTEGER NOT NULL, note TEXT)`,
];

export class Ledger {
  #sql: Sql;
  #now: () => number;

  constructor(sql: Sql, now: () => number = () => Date.now()) {
    this.#sql = sql;
    this.#now = now;
    for (const stmt of SCHEMA) this.#sql.exec(stmt);
  }

  /** The ids one caller may name. Small by construction: one tenant's own. */
  owned(tenantId: string) {
    const ids = (q: string, col: string) =>
      new Set<string>(this.#sql.exec(q, tenantId).toArray().map((r: any) => String(r[col])));
    return {
      boxes: ids("SELECT box_id FROM boxes WHERE tenant_id=? AND ended_at IS NULL", "box_id"),
      execs: ids("SELECT exec_id FROM execs WHERE tenant_id=?", "exec_id"),
      snaps: ids("SELECT snap_id FROM snaps WHERE tenant_id=?", "snap_id"),
    };
  }

  boxCreated(c: { tenantId: string; agentId: string }, boxId: string) {
    this.#sql.exec(
      `INSERT INTO boxes(box_id, tenant_id, agent_id, started_at) VALUES (?,?,?,?)
       ON CONFLICT(box_id) DO NOTHING`,
      boxId, c.tenantId, c.agentId, this.#now(),
    );
  }

  /** Closed, not removed: a box that vanished without a trace is the case this exists for. */
  boxGone(boxId: string) {
    this.#sql.exec("UPDATE boxes SET ended_at=? WHERE box_id=? AND ended_at IS NULL", this.#now(), boxId);
  }

  execCreated(c: { tenantId: string }, boxId: string, execId: string) {
    // The count moves only when the row is new. Written the other way round
    // first, and a test caught it: the insert ignores a repeat, but the
    // increment did not, so a retried call — and this plugin retries, that is
    // how the create-conflict path works — added a command that never ran.
    // An audit that counts retries is not a record of what happened.
    if (this.#sql.exec("SELECT exec_id FROM execs WHERE exec_id=?", execId).toArray().length) return;
    this.#sql.exec(
      "INSERT INTO execs(exec_id, box_id, tenant_id, at) VALUES (?,?,?,?)",
      execId, boxId, c.tenantId, this.#now(),
    );
    this.#sql.exec("UPDATE boxes SET execs = execs + 1 WHERE box_id=?", boxId);
  }

  snapCreated(c: { tenantId: string }, snapId: string) {
    this.#sql.exec(
      "INSERT INTO snaps(snap_id, tenant_id, at) VALUES (?,?,?) ON CONFLICT(snap_id) DO NOTHING",
      snapId, c.tenantId, this.#now(),
    );
  }

  /** What a tenant has, as the plugin's own list call expects to see it. */
  boxesOf(tenantId: string): BoxRow[] {
    return this.#sql
      .exec("SELECT * FROM boxes WHERE tenant_id=? AND ended_at IS NULL ORDER BY started_at", tenantId)
      .toArray()
      .map(row);
  }

  /** Everything, for the audit. Open intervals included, deliberately. */
  since(from: number): BoxRow[] {
    return this.#sql.exec("SELECT * FROM boxes WHERE started_at >= ? ORDER BY started_at", from).toArray().map(row);
  }

  tokenFor(hash: string): { tenantId: string; agentId: string } | null {
    const r = this.#sql.exec("SELECT tenant_id, agent_id FROM tokens WHERE hash=?", hash).toArray()[0];
    return r ? { tenantId: String(r.tenant_id), agentId: String(r.agent_id) } : null;
  }

  /**
   * The key this tenant already has, if it has one.
   *
   * Asked so that a key can be minted the first time a tenant needs one, with
   * nobody typing anything: a person configures no credential for the sandbox
   * today and must not start — the mount has always carried the operator's
   * reference, and the console has always shown it as not theirs to change.
   * Per-tenant keys exist so the broker can tell callers apart, which is the
   * whole point of it; that is a reason for us to have one each, not a reason
   * for anyone to be asked for one.
   */
  keyOf(tenantId: string): string | null {
    const r = this.#sql
      .exec("SELECT hash FROM tokens WHERE tenant_id=? ORDER BY issued_at LIMIT 1", tenantId)
      .toArray()[0];
    return r ? String(r.hash) : null;
  }

  issue(hash: string, tenantId: string, agentId: string, note: string | null) {
    this.#sql.exec(
      `INSERT INTO tokens(hash, tenant_id, agent_id, issued_at, note) VALUES (?,?,?,?,?)
       ON CONFLICT(hash) DO UPDATE SET tenant_id=excluded.tenant_id, agent_id=excluded.agent_id`,
      hash, tenantId, agentId, this.#now(), note,
    );
  }
}

const row = (r: any): BoxRow => ({
  tenantId: String(r.tenant_id), agentId: String(r.agent_id), boxId: String(r.box_id),
  startedAt: Number(r.started_at), endedAt: r.ended_at == null ? null : Number(r.ended_at),
  execs: Number(r.execs ?? 0),
});

/**
 * Seconds a box has existed, counting an open one up to now.
 *
 * The open ones are the reason to look: a box nobody released goes on costing
 * money, and leaving it out of the total would hide exactly the case the total
 * is being read for.
 */
export function secondsOf(b: BoxRow, now: number): number {
  return Math.max(0, Math.round(((b.endedAt ?? now) - b.startedAt) / 1000));
}

/** One line per tenant. No prices: quantities are the fact, money is a reading. */
export function usage(rows: BoxRow[], now: number) {
  const by = new Map<string, { tenantId: string; boxes: number; open: number; seconds: number; execs: number }>();
  for (const b of rows) {
    const t = by.get(b.tenantId) ?? { tenantId: b.tenantId, boxes: 0, open: 0, seconds: 0, execs: 0 };
    t.boxes += 1;
    if (b.endedAt === null) t.open += 1;
    t.seconds += secondsOf(b, now);
    t.execs += b.execs;
    by.set(b.tenantId, t);
  }
  return [...by.values()].sort((a, b) => b.seconds - a.seconds);
}
