/**
 * Each agent's record of the deployment catalogue (`AgentRuntime.DEFAULT_MOUNTS`, cf/src/runtime.ts): what it
 * last reconciled against, and what became of each entry on it. Shared by the two stores
 * (src/store/durable-object.ts, src/store/sqlite.ts) so both keep the same rows by the same rule; each runs
 * `applySeedPass` inside its own transaction.
 *
 * Two tables. `seed_reconcile` is one row per agent: the key of the last pass (`key`, built by the runtime from the
 * catalogue, the agent's kind, its plugin choices and which plugins the deployment cannot run), the catalogue
 * revision it carried, and `chosen` — the agent's mounts are its caller's explicit list (a bench arm, the Agents
 * API's pick), so it is never reconciled. `seed_outcomes` is one row per catalogue entry (alias and `since`) the
 * agent has been reconciled against.
 *
 * The rule that is only here: an entry whose outcome is `added` or `present` is never added again, whatever the key
 * says and whether or not its alias has been freed since (a rename, a removal). `declined`, `unavailable` and
 * `refused` are re-judged whenever the key moves, which is what makes them not terminal.
 */
import type { MountRecord } from "../core/types.ts";
import { appendTrace } from "../trace/outbox.ts";
import { seededRow } from "../trace/seams.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

export type SeedOutcome = "added" | "present" | "declined" | "not-for" | "unavailable" | "refused";

/** One entry's outcome on one agent. `at` is when this outcome was first recorded, not when it was last confirmed. */
export interface SeedOutcomeRow {
  alias: string; since: number; plugin: string;
  outcome: SeedOutcome; reason: string | null; at: number;
}

export interface SeedRecord {
  /** The key of the last pass that ran; null when none has. */
  key: string | null;
  /** The catalogue revision (its highest `since`) that pass carried. */
  revision: number | null;
  /** The agent's mounts are its caller's explicit list; never reconciled. */
  chosen: boolean;
  at: number | null;
  outcomes: SeedOutcomeRow[];
}

/**
 * The runtime's judgement of one entry, made from what only the runtime knows (the entry's `for` against the
 * agent's kind, the plugin's `unavailable()`, the owner's choice, the seed's validation). What depends on the
 * agent's mounts — whether the alias is taken, whether the plugin is already held — is judged by `applySeedPass`,
 * inside the transaction that would add the mount, so two passes cannot both see it free.
 */
export type SeedPlan = { alias: string; plugin: string; since: number } & (
  | { withheld: "declined" | "not-for" | "unavailable" | "refused"; reason: string }
  | { mount: MountRecord }
);

export type SeedPassResult =
  | { ran: false; why: "unchanged" | "chosen" }
  /** `changed`: the entries whose outcome this pass recorded or moved. `added`: those it mounted. */
  | { ran: true; changed: SeedOutcomeRow[]; added: SeedOutcomeRow[] };

export const SEED_RECORD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seed_reconcile (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, key TEXT, revision INTEGER,
     chosen INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id))`,
  `CREATE TABLE IF NOT EXISTS seed_outcomes (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, since INTEGER NOT NULL,
     plugin TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, alias, since))`,
];

const outcomeRow = (r: any): SeedOutcomeRow => ({
  alias: String(r.alias), since: Number(r.since), plugin: String(r.plugin),
  outcome: String(r.outcome) as SeedOutcome, reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
  at: Number(r.at),
});

export function readSeedRecord(sql: Sql, tenantId: string, agentId: string): SeedRecord {
  const s = sql.exec("SELECT key, revision, chosen, updated_at FROM seed_reconcile WHERE tenant_id=? AND agent_id=?",
    tenantId, agentId).toArray()[0];
  const outcomes = sql.exec(
    "SELECT alias, since, plugin, outcome, reason, at FROM seed_outcomes WHERE tenant_id=? AND agent_id=? ORDER BY since, alias",
    tenantId, agentId).toArray().map(outcomeRow);
  return {
    key: s?.key ?? null, revision: s?.revision === null || s?.revision === undefined ? null : Number(s.revision),
    chosen: Number(s?.chosen ?? 0) === 1, at: s ? Number(s.updated_at) : null, outcomes,
  };
}

export function markSeedsChosen(sql: Sql, tenantId: string, agentId: string, now: number) {
  sql.exec(
    `INSERT INTO seed_reconcile(tenant_id, agent_id, key, revision, chosen, updated_at) VALUES (?,?,NULL,NULL,1,?)
     ON CONFLICT(tenant_id, agent_id) DO UPDATE SET chosen=1, updated_at=excluded.updated_at`,
    tenantId, agentId, now);
}

/**
 * One pass, inside the caller's transaction. Reads the agent's row first: an unchanged key is that one read and
 * nothing else, and so is an agent whose mounts were chosen. Otherwise every entry is judged, the mounts it adds are
 * inserted with their trace rows, and the key is written last — all or none of it, by the caller's transaction.
 */
export function applySeedPass(
  sql: Sql, tenantId: string, agentId: string,
  pass: { key: string; revision: number; plan: readonly SeedPlan[] }, now: number,
): SeedPassResult {
  const state = sql.exec("SELECT key, chosen FROM seed_reconcile WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0];
  if (Number(state?.chosen ?? 0) === 1) return { ran: false, why: "chosen" };
  if (state && state.key === pass.key) return { ran: false, why: "unchanged" };

  const prior = new Map<string, SeedOutcomeRow>();
  for (const r of sql.exec("SELECT alias, since, plugin, outcome, reason, at FROM seed_outcomes WHERE tenant_id=? AND agent_id=?",
    tenantId, agentId).toArray()) prior.set(`${r.alias}@${r.since}`, outcomeRow(r));
  const mounts = sql.exec("SELECT alias, plugin FROM mounts WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()
    .map((r: any) => ({ alias: String(r.alias), plugin: String(r.plugin) }));

  const changed: SeedOutcomeRow[] = [];
  const added: SeedOutcomeRow[] = [];
  for (const p of pass.plan) {
    const before = prior.get(`${p.alias}@${p.since}`);
    // Settled once the agent has had it, whether this added it or found it there: the alias may have been freed
    // since (a rename, a removal), and adding it back would hand the agent a second copy of a plugin it already has
    // under another name, or undo an operator's removal the next time an unrelated plugin choice or the deployment's
    // configuration moved the key. Only an entry the agent never had (declined, unavailable, refused, or no outcome
    // yet: a new catalogue row) is judged again.
    if (before?.outcome === "added" || before?.outcome === "present") continue;
    let outcome: SeedOutcome;
    let reason: string | null = null;
    if ("withheld" in p) {
      outcome = p.withheld;
      reason = p.reason;
    } else {
      const have = mounts.find((m) => m.alias === p.alias);
      const elsewhere = mounts.find((m) => m.plugin === p.plugin);
      if (have && have.plugin === p.plugin) outcome = "present";
      else if (have) { outcome = "refused"; reason = `${p.alias} is a ${have.plugin} mount, not the ${p.plugin} seed`; }
      // Two identical tool sets under two aliases confuse the model, and an operator's rename (`web` -> `x`) would
      // otherwise bring a second `web` back.
      else if (elsewhere) { outcome = "present"; reason = `already mounted as ${elsewhere.alias}`; }
      else {
        const m = p.mount;
        sql.exec(
          `INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, connection_id, plugin,
             tool_version, public_config, secret_ref, policy, tool_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          tenantId, agentId, m.alias, m.installationId, m.connectionId, m.plugin, m.toolVersion,
          JSON.stringify(m.publicConfig ?? null), m.secretRef, m.policy ? JSON.stringify(m.policy) : null,
          m.toolSnapshot ? JSON.stringify(m.toolSnapshot) : null);
        mounts.push({ alias: m.alias, plugin: m.plugin });
        outcome = "added";
      }
    }
    if (before && before.outcome === outcome && before.reason === reason) continue;
    const row: SeedOutcomeRow = { alias: p.alias, since: p.since, plugin: p.plugin, outcome, reason, at: now };
    sql.exec(
      `INSERT INTO seed_outcomes(tenant_id, agent_id, alias, since, plugin, outcome, reason, at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, alias, since) DO UPDATE SET
         plugin=excluded.plugin, outcome=excluded.outcome, reason=excluded.reason, at=excluded.at`,
      tenantId, agentId, p.alias, p.since, p.plugin, outcome, reason, now);
    // In this transaction, beside the mount it reports (src/trace/seams.ts).
    appendTrace(sql, [seededRow({ tenantId, agentId, ...row })]);
    changed.push(row);
    if (outcome === "added") added.push(row);
  }
  sql.exec(
    `INSERT INTO seed_reconcile(tenant_id, agent_id, key, revision, chosen, updated_at) VALUES (?,?,?,?,0,?)
     ON CONFLICT(tenant_id, agent_id) DO UPDATE SET key=excluded.key, revision=excluded.revision, updated_at=excluded.updated_at`,
    tenantId, agentId, pass.key, pass.revision, now);
  return { ran: true, changed, added };
}
