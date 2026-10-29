/**
 * Egress residue (#1130): a project-scope run9 registration carrying a box's placeholder, which run9 injects into the
 * boxes its label matches and antiproton never removes (the run9 project is shared with production). Found by a
 * sandbox mount's withdrawal (`Holding.withdraw`, src/plugins/sandbox.ts), kept in D1 (`egress_residue`, migration
 * 0033) so it outlives the mount and the agent, and reported on every later withdrawal until a complete project listing
 * shows it gone. The data #1128's List reads.
 *
 * Also where an unclean box's reason becomes an action (`ACTION_OF`): only what the next delete can finish is
 * `retry_delete`.
 */
import type { Withdrawal } from "../../src/plugins/types.ts";

/**
 * Why a held thing is not clean after an agent's delete. `not_withdrawn`, `listing_failed` (registrations left, or run9
 * refusing, unreachable or answering what cannot be read) and `project_listing_failed` (the project-scope listing
 * failed, so residue was never checked) are what the next delete retries. The rest no retry fixes: `project_residue`
 * (a project-scope registration still acts for the box), `stranded` (made under a key since replaced),
 * `no_credential` (no key to reach it), `deletion_unconfirmed` (let go, but not made under this kind of key, so a
 * "deleted" cannot be believed).
 */
export type UncleanCode = "not_withdrawn" | "listing_failed" | "project_listing_failed" | "project_residue" | "stranded" | "no_credential" | "deletion_unconfirmed";
/**
 * What to do about each: `retry_delete` (the next delete can finish it); `needs_operator_cleanup` (a known object an
 * operator can reach, #1128: project-scope residue, or a box whose deletion cannot be believed); `await_provider_reclaim`
 * (nothing reachable with any current key: a stranded box, or a box whose mount holds no key at all, which #1128,
 * starting from the agent's mount as well, cannot list or reach either). Only the first is retryable.
 */
export type UncleanAction = "retry_delete" | "needs_operator_cleanup" | "await_provider_reclaim";
export const ACTION_OF: Record<UncleanCode, UncleanAction> = {
  not_withdrawn: "retry_delete", listing_failed: "retry_delete", project_listing_failed: "retry_delete",
  project_residue: "needs_operator_cleanup", deletion_unconfirmed: "needs_operator_cleanup",
  stranded: "await_provider_reclaim", no_credential: "await_provider_reclaim",
};
export const MESSAGE_OF: Partial<Record<UncleanAction, string>> = {
  needs_operator_cleanup: "retrying the delete cannot clear this; it needs an operator (botiverse/antiproton#1128, planned)",
  // Nothing here says waiting fixes it: reclaim needs the box idle, and the token itself does not expire.
  await_provider_reclaim: "Cannot be located or deleted with current keys. The credential stops working only after the provider reclaims this box, " +
    "and reclaim requires that nothing uses the box any more; a running background job keeps it alive. OAuth App tokens do not expire on their own.",
};

export const RESIDUE_REASON = "a project-scope registration carrying this box's placeholder: run9 injects it into the boxes its label matches, " +
  "and antiproton never removes project-scope secrets (the run9 project is shared with production), so a person must";

/** How long a resolved residue row is kept before the daily cleanup drops it. Unresolved rows are never dropped. */
export const RESOLVED_RESIDUE_KEEP_MS = 180 * 24 * 60 * 60 * 1000;

/** One residue record, by the names #1128's List uses. */
export interface ResidueRow {
  tenantId: string; agentId: string; alias: string; boxId: string; secretId: string; title: string; reasonCode: string;
  firstSeen: number; lastSeen: number; resolvedAt: number | null; resolvedBy: string | null; resolvedRef: string | null;
}

export interface ResidueStore {
  /** Findings of one withdrawal, kept: a new one with `first_seen` now, one seen before with `last_seen` moved on. */
  record(tenantId: string, agentId: string, alias: string, findings: Withdrawal["project"]["findings"], at: number): Promise<void>;
  /**
   * The open rows of this agent's mount that a complete listing (`ids`, every secret it had) no longer has: resolved,
   * `listing_absent`, by `ref`. Never called with a listing that failed or could not be read.
   */
  resolveAbsent(tenantId: string, agentId: string, alias: string, ids: string[], at: number, ref: string): Promise<number>;
  /** The agent's open rows, by the table's own columns: never joined to the registry, so a deleted agent's are listed. */
  open(tenantId: string, agentId: string): Promise<ResidueRow[]>;
  /** Drop rows resolved before `before`; never an open one. How many went. */
  dropResolved(before: number): Promise<number>;
}

const rowOf = (r: any): ResidueRow => ({
  tenantId: String(r.tenant_id), agentId: String(r.agent_id), alias: String(r.alias), boxId: String(r.box_id), secretId: String(r.secret_id),
  title: String(r.title), reasonCode: String(r.reason_code), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen),
  resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at), resolvedBy: r.resolved_by == null ? null : String(r.resolved_by),
  resolvedRef: r.resolved_ref == null ? null : String(r.resolved_ref),
});

export function d1EgressResidue(db: D1Database): ResidueStore {
  return {
    async record(tenantId, agentId, alias, findings, at) {
      for (const f of findings) {
        await db.prepare(
          `INSERT INTO egress_residue (tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, 'project_residue', ?, ?)
           ON CONFLICT (tenant_id, agent_id, secret_id) DO UPDATE SET last_seen = excluded.last_seen WHERE egress_residue.resolved_at IS NULL`,
        ).bind(tenantId, agentId, alias, f.boxId, f.secretId, f.name.slice(0, 120), at, at).run();
      }
    },
    async resolveAbsent(tenantId, agentId, alias, ids, at, ref) {
      const r = await db.prepare(
        `UPDATE egress_residue SET resolved_at = ?, resolved_by = 'listing_absent', resolved_ref = ?
          WHERE tenant_id = ? AND agent_id = ? AND alias = ? AND resolved_at IS NULL AND secret_id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(at, ref.slice(0, 120), tenantId, agentId, alias, JSON.stringify(ids)).run();
      return Number(r.meta?.changes ?? 0);
    },
    async open(tenantId, agentId) {
      const r = await db.prepare("SELECT * FROM egress_residue WHERE tenant_id = ? AND agent_id = ? AND resolved_at IS NULL ORDER BY first_seen, secret_id")
        .bind(tenantId, agentId).all<any>();
      return (r.results ?? []).map(rowOf);
    },
    async dropResolved(before) {
      const r = await db.prepare("DELETE FROM egress_residue WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(before).run();
      return Number(r.meta?.changes ?? 0);
    },
  };
}

/** One box after an agent's delete or the egress hook, as answered: clean with how, or why not and what to do. */
export interface BoxEnd {
  alias: string; id: string; clean: boolean; via?: "withdrawn" | "deleted"; why?: string; review?: string;
  code?: UncleanCode; action?: UncleanAction; message?: string;
  projectResidue?: Array<{ secretId: string; title: string; reasonCode: string; reason: string; firstSeen: string }>;
}

/** An unclean box's code as its action and message. */
export function unclean(end: Omit<BoxEnd, "action" | "message">, code: UncleanCode): BoxEnd {
  const action = ACTION_OF[code];
  return { ...end, clean: false, code, action, ...(MESSAGE_OF[action] ? { message: MESSAGE_OF[action] } : {}) };
}

/**
 * The boxes as a withdrawal left them, with residue kept in D1 laid over them. Each mount's findings are recorded; a
 * mount whose project listing was `complete` resolves its open rows that listing no longer had (by `ref`); then every
 * open row of the agent is reported, on its box, or on a box no longer held. A box with residue is never clean. A box
 * no longer held reports its residue with the reason the listing gives: `project_listing_failed` when it failed
 * (retryable), `no_credential` when there was no key to list with (no retry fixes that), else `project_residue`.
 */
export async function withResidue(
  store: ResidueStore, tenantId: string, agentId: string,
  boxes: BoxEnd[], projects: Array<{ alias: string } & Withdrawal["project"]>, at: number, ref: string,
): Promise<BoxEnd[]> {
  for (const p of projects) {
    if (p.findings.length) await store.record(tenantId, agentId, p.alias, p.findings, at);
    if (p.state === "complete") await store.resolveAbsent(tenantId, agentId, p.alias, p.ids, at, ref);
  }
  const open = await store.open(tenantId, agentId);
  const residueOf = (boxId: string) => open.filter((r) => r.boxId === boxId).map((r) => ({
    secretId: r.secretId, title: r.title, reasonCode: r.reasonCode, reason: RESIDUE_REASON, firstSeen: new Date(r.firstSeen).toISOString(),
  }));
  const out = boxes.map((b) => {
    const residue = residueOf(b.id);
    if (!residue.length) return b;
    // The box's own reason stands when it has one; a box otherwise clear is held back by its residue.
    return b.clean ? unclean({ ...b, projectResidue: residue }, "project_residue") : { ...b, projectResidue: residue };
  });
  const held = new Set(boxes.map((b) => b.id));
  for (const boxId of new Set(open.map((r) => r.boxId))) {
    if (held.has(boxId)) continue;
    const alias = open.find((r) => r.boxId === boxId)!.alias;
    const state = projects.find((p) => p.alias === alias)?.state;
    const code: UncleanCode = state === "failed" ? "project_listing_failed" : state === "no_credential" ? "no_credential" : "project_residue";
    const why = state === "failed" ? "the project-scope listing failed, so this box's residue could not be checked"
      : state === "no_credential" ? "no credential to list project-scope registrations with"
      : "the box is gone; project-scope registration(s) carrying its placeholder are still there";
    out.push(unclean({ alias, id: boxId, clean: false, why, projectResidue: residueOf(boxId) }, code));
  }
  return out;
}

/**
 * The daily cleanup (cf/src/index.ts `scheduled`): resolved rows past RESOLVED_RESIDUE_KEEP_MS dropped, never an open
 * one, and each run recorded in admin_audit, whatever it dropped.
 */
export async function cleanupResidue(db: D1Database, now: number): Promise<number> {
  const dropped = await d1EgressResidue(db).dropResolved(now - RESOLVED_RESIDUE_KEEP_MS);
  await db.prepare("INSERT INTO admin_audit (at, route, outcome, counts, finished_at) VALUES (?, 'cron:egress-residue-cleanup', 'cleaned', ?, ?)")
    .bind(now, JSON.stringify({ dropped }), now).run();
  return dropped;
}
