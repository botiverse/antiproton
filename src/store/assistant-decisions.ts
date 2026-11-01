/**
 * What a personal assistant's check decided, kept for us and never shown to its owner: one row per wake (a doorbell's
 * check or a morning brief), written by the assistant's `note_decision` tool (src/plugins/raft-assistant.ts
 * `noteDecision`), with how many messages the wake sent, one sentence on why, and the messages it went on. It is how
 * empty, repeated and missed messages are measured, and how "why didn't you tell me X" is answered.
 *
 * The reason and the sources are the owner's data, so they live here, in the agent's own storage, and nowhere else: no
 * trace row, log line or outbox row carries them (the wake's `raft.assistant_decision` row is counts only). Read by an
 * operator through `GET /admin/assistant-decisions` (cf/src/admin-assistant-decisions.ts), audited as a conversation
 * read is.
 *
 * Kept `ASSISTANT_DECISIONS_RETENTION_MS` (30 days): every write deletes this agent's older rows in the same
 * transaction, the one place that already runs for every wake that has anything to keep.
 *
 * Shared by both storage backends, as `PluginDbTables` is, so the table is defined once; the operator's read
 * (`readAssistantDecisions`) is SELECTs alone, for a route that must not run the store's migrations.
 */
import type { SqlHost } from "./pi-storage.ts";

export const ASSISTANT_DECISIONS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS assistant_decisions (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, check_id TEXT NOT NULL,
     woke_at INTEGER NOT NULL, noted_at INTEGER NOT NULL, sent INTEGER NOT NULL, reason TEXT NOT NULL, sources TEXT NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, check_id))`,
  `CREATE INDEX IF NOT EXISTS assistant_decisions_by_time ON assistant_decisions (tenant_id, agent_id, noted_at)`,
];

/** How long a decision is kept. */
export const ASSISTANT_DECISIONS_RETENTION_MS = 30 * 24 * 3_600_000;
/** The most one read returns. */
export const ASSISTANT_DECISIONS_READ_MAX = 500;

/**
 * One source the wake went on. `ownerVisible` is true only when the message's id was in an owner read's result in the
 * same wake (the owner inbox or the owner messages tool), so the owner could see it; "unknown" otherwise, which says
 * nothing either way.
 */
export interface DecisionSource { conversation: string; msg: string; ownerVisible: true | "unknown" }

export interface AssistantDecision {
  /** Raft's check id for a check Raft runs, else the short session's key: one row per wake, the last note kept. */
  checkId: string;
  /** When the wake posted its session; the note's own time when that was not seen. */
  wokeAt: number;
  notedAt: number;
  sent: number;
  reason: string;
  sources: DecisionSource[];
}

type Sql = SqlHost["sql"];

function rowOf(r: Record<string, unknown>): AssistantDecision {
  let sources: DecisionSource[] = [];
  try {
    const raw = JSON.parse(String(r.sources ?? "[]"));
    if (Array.isArray(raw)) sources = raw as DecisionSource[];
  } catch { /* a damaged cell reads as no sources rather than failing the read */ }
  return {
    checkId: String(r.check_id), wokeAt: Number(r.woke_at), notedAt: Number(r.noted_at), sent: Number(r.sent),
    reason: String(r.reason), sources,
  };
}

const SELECT = "SELECT check_id, woke_at, noted_at, sent, reason, sources FROM assistant_decisions";

export class AssistantDecisionTables {
  #host: SqlHost;
  #now: () => number;

  constructor(host: SqlHost, opts: { now?: () => number } = {}) {
    this.#host = host;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Creates the table when it is missing. Returns `this`, so a fixture is one expression. */
  ensure(): this {
    for (const stmt of ASSISTANT_DECISIONS_SCHEMA) this.#host.sql.exec(stmt);
    return this;
  }

  /** Writes the wake's decision, replacing an earlier note of the same wake, and drops this agent's expired rows. */
  put(tenantId: string, agentId: string, d: AssistantDecision): void {
    this.#host.transactionSync(() => {
      this.#host.sql.exec(
        `INSERT INTO assistant_decisions(tenant_id, agent_id, check_id, woke_at, noted_at, sent, reason, sources) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, agent_id, check_id) DO UPDATE SET
           woke_at=excluded.woke_at, noted_at=excluded.noted_at, sent=excluded.sent, reason=excluded.reason, sources=excluded.sources`,
        tenantId, agentId, d.checkId, d.wokeAt, d.notedAt, d.sent, d.reason, JSON.stringify(d.sources),
      );
      this.prune(tenantId, agentId);
    });
  }

  /** Deletes this agent's rows noted more than `ASSISTANT_DECISIONS_RETENTION_MS` ago. */
  prune(tenantId: string, agentId: string): void {
    this.#host.sql.exec("DELETE FROM assistant_decisions WHERE tenant_id=? AND agent_id=? AND noted_at < ?",
      tenantId, agentId, this.#now() - ASSISTANT_DECISIONS_RETENTION_MS);
  }

  get(tenantId: string, agentId: string, checkId: string): AssistantDecision | null {
    const r = this.#host.sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND check_id=?`, tenantId, agentId, checkId).toArray()[0];
    return r ? rowOf(r as Record<string, unknown>) : null;
  }

  list(tenantId: string, agentId: string, range: { from?: number; to?: number } = {}): AssistantDecision[] {
    return readAssistantDecisions(this.#host.sql, tenantId, agentId, range);
  }
}

/**
 * One agent's decisions noted in [from, to), newest first, at most `ASSISTANT_DECISIONS_READ_MAX`. SELECTs only; an
 * object that never made the table reads as having none.
 */
export function readAssistantDecisions(sql: Sql, tenantId: string, agentId: string, range: { from?: number; to?: number } = {}): AssistantDecision[] {
  const exists = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'assistant_decisions'").toArray().length > 0;
  if (!exists) return [];
  const from = range.from ?? 0, to = range.to ?? Number.MAX_SAFE_INTEGER;
  return (sql.exec(`${SELECT} WHERE tenant_id=? AND agent_id=? AND noted_at >= ? AND noted_at < ? ORDER BY noted_at DESC LIMIT ?`,
    tenantId, agentId, from, to, ASSISTANT_DECISIONS_READ_MAX).toArray() as Array<Record<string, unknown>>).map(rowOf);
}
