/**
 * Held calls of a Raft-hosted agent, as the provider sees them (docs/raft-approvals.md): the item Raft's action card is
 * built from, the provider-wide copy Raft reconciles against (D1 `provider_approvals`, migration 0028), and the signed
 * "go pull" hint antiproton sends Raft when a hold changes.
 *
 * The agent's object is the source of truth (its `approvals` table). After every change of a hold's state its alarm
 * pass publishes it (`publishApprovals`): the item to D1, then the hint to Raft. The hint carries ids only, so a lost
 * or forged one costs a pull and nothing else; a failed hint is retried a bounded number of times and then left to
 * Raft's reconcile, and never holds up the hold itself.
 */
import type { ApprovalRecord, ApprovalState, DecidedBy, Json } from "../../src/core/types.ts";
import type { ProvisionedAgent } from "./control-plane.ts";
import { logEvent } from "../../src/core/log.ts";
import { mapApproval } from "../../src/store/approvals-schema.ts";

/** One held call, as `GET /provision/…/approvals` answers it. Arguments are redacted and bounded before they get here. */
export interface ApprovalItem {
  operationId: string;
  providerAgentId: string;
  raftAgentId: string;
  raftServerId: string;
  status: ApprovalState;
  /** The mount the call goes through, the plugin behind it, and the tool. */
  mount: string;
  plugin: string | null;
  tool: string;
  /** The plugin's own service and action, when the call names them (Raft Agent Login's `invoke`); null otherwise. */
  service: string | null;
  action: string | null;
  /** What is being approved, display-ready: credentials replaced, at most ARGS_SUMMARY_MAX characters. */
  args: { summary: string; truncated: boolean; redactions: number; withheld: boolean };
  /**
   * What an approved call's run came to, once it ended (`executed` or `failed`): its result or error, redacted like
   * `args` and at most ARGS_SUMMARY_MAX characters. Null before the run ends, and for a hold that was not approved.
   */
  outcome: { summary: string; truncated: boolean; redactions: number; withheld: boolean } | null;
  /** "agent": the agent asked for a person (`confirm`); "policy": the mount's policy holds the tool. */
  heldBy: "agent" | "policy";
  policyKey: string | null;
  /** A bridged request's method, path, repository and body (redacted, bounded); null for a plain tool call. */
  route: Json | null;
  /** One line, built here: what approving does, and when an undecided hold expires. */
  description: string;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  decidedBy: DecidedBy | null;
}

export const ARGS_SUMMARY_MAX = 800;
const ARG_VALUE_MAX = 200;
const ARG_KEYS_MAX = 12;
const NAME_MAX = 120;

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const named = (v: unknown) => (typeof v === "string" && v.trim() ? cut(v.trim(), NAME_MAX) : null);

/** A redaction of `value` (cf/src/eval-read.ts `redactCredentials` with the agent's sealed values), or null: withhold. */
export type Redact = (value: unknown) => { value: unknown; redactions: number } | null;

/**
 * The display text of a call's arguments: a bridged request as `METHOD path` and its body, anything else as one
 * `name: value` line per top-level field. Redacted first, whole; bounded after. When the redaction cannot run (the
 * agent's sealed values could not be opened) nothing of the arguments is shown.
 */
export function argsSummary(request: { args?: unknown; route?: unknown }, redact: Redact): { summary: string; truncated: boolean; redactions: number; withheld: boolean; route: Json | null } {
  const r = redact({ args: request.args ?? null, route: request.route ?? null });
  if (!r) return { summary: "", truncated: false, redactions: 0, withheld: true, route: null };
  const { args, route } = r.value as { args: unknown; route: Record<string, unknown> | null };
  let text: string;
  if (route && typeof route === "object") {
    const where = route.repo ? ` (${String(route.repo)}${route.pr !== undefined ? ` #${String(route.pr)}` : ""})` : "";
    text = `${String(route.method ?? "")} ${String(route.path ?? "")}${where}${typeof route.body === "string" && route.body ? `\n${route.body}` : ""}`;
  } else if (args && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>);
    const lines = entries.slice(0, ARG_KEYS_MAX).map(([k, v]) => `${k}: ${cut(typeof v === "string" ? v : JSON.stringify(v) ?? "null", ARG_VALUE_MAX)}`);
    if (entries.length > ARG_KEYS_MAX) lines.push(`(${entries.length - ARG_KEYS_MAX} more fields)`);
    text = lines.join("\n");
  } else {
    text = JSON.stringify(args ?? null) ?? "null";
  }
  const truncated = text.length > ARGS_SUMMARY_MAX;
  return { summary: truncated ? cut(text, ARGS_SUMMARY_MAX) : text, truncated, redactions: r.redactions, withheld: false, route: route ?? null };
}

/** A run's outcome as the card shows it: redacted whole, then bounded, withheld when the redaction cannot run. */
export function outcomeSummary(text: string, redact: Redact): { summary: string; truncated: boolean; redactions: number; withheld: boolean } {
  const r = redact(text);
  if (!r) return { summary: "", truncated: false, redactions: 0, withheld: true };
  const t = String(r.value);
  const truncated = t.length > ARGS_SUMMARY_MAX;
  return { summary: truncated ? cut(t, ARGS_SUMMARY_MAX) : t, truncated, redactions: r.redactions, withheld: false };
}

/** The one-line description of what deciding does, or what was decided. */
export function approvalDescription(a: { status: ApprovalState; mount: string; tool: string; service: string | null; action: string | null;
  route: Json | null; expiresAt: string | null }): string {
  const what = a.service && a.action ? `${a.service} ${a.action} (${a.mount}.${a.tool})` : `${a.mount}.${a.tool}`;
  const route = a.route && typeof a.route === "object" ? a.route as Record<string, unknown> : null;
  const via = route ? `, sending ${String(route.method ?? "")} ${String(route.path ?? "")}` : "";
  if (a.status === "pending") {
    return `Approving runs ${what} once, exactly as shown, with this agent's ${a.mount} mount${via}; denying runs nothing. ` +
      `Either way the agent is told.${a.expiresAt ? ` Undecided at ${a.expiresAt}, it is denied as expired.` : ""}`;
  }
  if (a.status === "approved") return `Approved: ${what} is being run once, as shown; the agent is told the result when it ends.`;
  if (a.status === "executed") return `Approved and executed: ${what} was run once, as shown, and the agent was told the result.`;
  if (a.status === "failed") return `Approved, but the run failed: ${what} did not succeed, and the agent was told why.`;
  if (a.status === "denied") return `Denied: ${what} was not run, and the agent was told.`;
  return `Expired: nobody decided in time, so ${what} was not run, and the agent was told.`;
}

/** The item for one row. `plugin` is the mount's, read by the caller (null: the mount is gone). */
export function approvalItem(a: ApprovalRecord, ids: { providerAgentId: string; raftAgentId: string; raftServerId: string },
  plugin: string | null, redact: Redact): ApprovalItem {
  const req = (a.request && typeof a.request === "object" ? a.request : {}) as Record<string, unknown>;
  const args = req.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args as Record<string, unknown> : {};
  const s = argsSummary({ args: req.args, route: req.route }, redact);
  const base = {
    operationId: a.operationId, ...ids, status: a.state, mount: a.mountAlias, plugin, tool: a.tool,
    service: named(args.service), action: named(args.action),
    args: { summary: s.summary, truncated: s.truncated, redactions: s.redactions, withheld: s.withheld },
    outcome: a.outcome ? outcomeSummary(a.outcome.summary, redact) : null,
    heldBy: req.heldBy === "agent" ? "agent" as const : "policy" as const,
    policyKey: typeof req.policyKey === "string" ? req.policyKey : null,
    route: s.route,
    createdAt: iso(a.createdAt)!, expiresAt: iso(a.expiresAt), decidedAt: iso(a.decidedAt), decidedBy: a.decidedBy,
  };
  return { ...base, description: approvalDescription(base) };
}

/** What a provider's decision came to (AgentDO `provisionDecide`), before it is an HTTP answer. */
export type ProvisionDecideResult =
  | { ok: true; replay: boolean; item: ApprovalItem }
  | { ok: false; code: "approval_not_found" | "approval_expired" | "approval_already_decided"; item?: ApprovalItem };

// ---- the provider-wide copy (D1 provider_approvals) -----------------------------------------------------------

export interface IndexRow {
  tenantId: string; agentId: string; operationId: string;
  raftOrigin: string; raftServerId: string; raftAgentId: string;
  status: ApprovalState; item: ApprovalItem; createdAt: number; expiresAt: number | null; updatedAt: number;
}

/** Where a page ended: the last row's sort key. Opaque to Raft. */
export interface Cursor { u: number; t: string; a: string; o: string }

export const encodeCursor = (c: Cursor) => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeCursor(s: string): Cursor | null {
  try {
    const c = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof c?.u === "number" && typeof c.t === "string" && typeof c.a === "string" && typeof c.o === "string" ? c : null;
  } catch { return null; }
}

/** Who may read which rows: a platform token its origin's, a tenant token its own tenant's (and only at its origin). */
export type IndexScope = { raftOrigin: string; tenantId: string | null };

export interface ApprovalIndex {
  /**
   * Write a hold's state. It only moves forward (`STATE_RANK`), and the same state twice changes nothing. A deleted
   * agent's hold is still written, as its kept record (`markAgentDeleted`): marked, without the arguments' text.
   */
  upsert(row: IndexRow): Promise<void>;
  list(scope: IndexScope, q: { status: ApprovalState | null; updatedSince: number | null; after: Cursor | null; limit: number }):
    Promise<{ rows: IndexRow[]; next: Cursor | null }>;
  /**
   * The agent was deleted at `at`: its copies are kept as the record of who decided what (migration 0029), no longer
   * listed, without the arguments' text (`AUDIT_DROPS`). Repeating it keeps the first `at`.
   */
  markAgentDeleted(tenantId: string, agentId: string, at: number): Promise<void>;
  /**
   * A live agent's ended holds whose last change is before `ended`; a deleted agent's holds whose delete is before
   * `deleted`. First marks the holds of an agent the registry says is deleted whose delete did not mark them.
   */
  prune(before: { ended: number; deleted: number }): Promise<void>;
}

/**
 * How long the provider-wide copy keeps a live agent's hold after it ended (denied, expired, executed, failed): 30
 * days. The copy is what Raft reconciles its cards against; the agent's own object keeps every hold it made.
 */
export const APPROVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a deleted agent's holds are kept after its delete: a year. Once deleted, no provider route reads its object,
 * so these rows are where who decided what for it is read. Each deleted agent's rows are the holds it had made by its
 * delete, moving forward only, so they are bounded by the deletes of a year.
 */
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The item's fields a deleted agent's copy drops: the free text of what was asked (the arguments' summary, a bridged
 * request's body), the agent's to keep. Kept: the route's method, path, repository and pull request, which say what
 * the decision applied to; `outcome`, which tells `policy_denied` from a failed run; and the description, built from
 * the mount, tool and route alone. `outcome` is the run's result or error, redacted and bounded (`outcomeSummary`), and
 * can still carry free text of the result's own.
 */
const AUDIT_DROPS = "'$.args', '$.route.body'";
/** When the row's agent was deleted, by the registry; null for a live agent. Correlated on `provider_approvals`. */
const DELETED_AT = "(SELECT COALESCE(p.deleted_at, p.updated_at) FROM provisioned_agents p WHERE p.tenant_id = provider_approvals.tenant_id AND p.agent_id = provider_approvals.agent_id AND p.status = 'deleted')";
/** The row's agent is deleted in the registry. */
const AGENT_DELETED = "EXISTS (SELECT 1 FROM provisioned_agents p WHERE p.tenant_id = provider_approvals.tenant_id AND p.agent_id = provider_approvals.agent_id AND p.status = 'deleted')";

/**
 * How far along a state is: a copy only moves forward (pending, then approved, then an end), so a write that arrives
 * late cannot put back a state the hold has left.
 */
const STATE_RANK = (col: string) => `(CASE ${col} WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END)`;

export function d1ApprovalIndex(db: D1Database): ApprovalIndex {
  return {
    async upsert(r) {
      // Whether the agent is deleted is read here, in the statement, not from the publisher's registry read: a hold
      // decided or expired after the delete still reaches its kept record, and one that lands as the delete marks the
      // rows is written marked and without the arguments' text either way.
      const item = JSON.stringify(r.item);
      await db.prepare(
        "INSERT INTO provider_approvals(tenant_id, agent_id, operation_id, raft_origin, raft_server_id, raft_agent_id, status, item, created_at, expires_at, updated_at, agent_deleted_at) " +
        `SELECT ?, ?, ?, ?, ?, ?, ?, CASE WHEN d.at IS NULL THEN ? ELSE json_remove(?, ${AUDIT_DROPS}) END, ?, ?, ?, d.at ` +
        "FROM (SELECT (SELECT COALESCE(p.deleted_at, p.updated_at) FROM provisioned_agents p WHERE p.tenant_id = ? AND p.agent_id = ? AND p.status = 'deleted') AS at) d WHERE true " +
        "ON CONFLICT(tenant_id, agent_id, operation_id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at, updated_at = excluded.updated_at, " +
        "agent_deleted_at = COALESCE(provider_approvals.agent_deleted_at, excluded.agent_deleted_at), item = excluded.item " +
        `WHERE ${STATE_RANK("excluded.status")} > ${STATE_RANK("provider_approvals.status")}`,
      ).bind(r.tenantId, r.agentId, r.operationId, r.raftOrigin, r.raftServerId, r.raftAgentId, r.status, item, item,
        r.createdAt, r.expiresAt, r.updatedAt, r.tenantId, r.agentId).run();
    },
    async list(scope, q) {
      // A deleted agent's rows are left out, marked (`markAgentDeleted`) or not yet: the registry says it is deleted
      // first. Either one alone hides them.
      const where = ["raft_origin = ?", "agent_deleted_at IS NULL", `NOT ${AGENT_DELETED}`];
      const binds: unknown[] = [scope.raftOrigin];
      if (scope.tenantId !== null) { where.push("tenant_id = ?"); binds.push(scope.tenantId); }
      if (q.status !== null) { where.push("status = ?"); binds.push(q.status); }
      if (q.updatedSince !== null) { where.push("updated_at >= ?"); binds.push(q.updatedSince); }
      if (q.after) {
        where.push("(updated_at > ? OR (updated_at = ? AND (tenant_id > ? OR (tenant_id = ? AND (agent_id > ? OR (agent_id = ? AND operation_id > ?))))))");
        binds.push(q.after.u, q.after.u, q.after.t, q.after.t, q.after.a, q.after.a, q.after.o);
      }
      const { results } = await db.prepare(
        `SELECT * FROM provider_approvals WHERE ${where.join(" AND ")} ORDER BY updated_at, tenant_id, agent_id, operation_id LIMIT ?`,
      ).bind(...binds, q.limit + 1).all();
      const rows = (results as any[]).map((r): IndexRow => ({
        tenantId: String(r.tenant_id), agentId: String(r.agent_id), operationId: String(r.operation_id),
        raftOrigin: String(r.raft_origin), raftServerId: String(r.raft_server_id), raftAgentId: String(r.raft_agent_id),
        status: String(r.status) as ApprovalState, item: JSON.parse(String(r.item)), createdAt: Number(r.created_at),
        expiresAt: r.expires_at === null ? null : Number(r.expires_at), updatedAt: Number(r.updated_at),
      }));
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);
      return { rows: page, next: more && last ? { u: last.updatedAt, t: last.tenantId, a: last.agentId, o: last.operationId } : null };
    },
    async markAgentDeleted(tenantId, agentId, at) {
      await db.prepare(
        `UPDATE provider_approvals SET agent_deleted_at = COALESCE(agent_deleted_at, ?), item = json_remove(item, ${AUDIT_DROPS}) WHERE tenant_id = ? AND agent_id = ?`,
      ).bind(at, tenantId, agentId).run();
    },
    async prune(before) {
      // Each spelled as its partial index (migration 0029). The mark first, from the registry's deleted agents (a few
      // rows, not a scan of the copy): a delete whose mark failed leaves rows only until the next prune, and they are
      // then a deleted agent's, dropped a year after its delete, never at 30 days as a live agent's: the batch is one
      // transaction, so the 30-day delete only ever sees them marked.
      await db.batch([
        db.prepare(`UPDATE provider_approvals SET agent_deleted_at = ${DELETED_AT}, item = json_remove(item, ${AUDIT_DROPS}) ` +
          "WHERE agent_deleted_at IS NULL AND (tenant_id, agent_id) IN (SELECT tenant_id, agent_id FROM provisioned_agents WHERE status = 'deleted')"),
        db.prepare("DELETE FROM provider_approvals WHERE agent_deleted_at IS NULL AND status IN ('denied', 'expired', 'executed', 'failed') AND updated_at < ?")
          .bind(before.ended),
        db.prepare("DELETE FROM provider_approvals WHERE agent_deleted_at IS NOT NULL AND agent_deleted_at < ?").bind(before.deleted),
      ]);
    },
  };
}

// ---- the signed hint to Raft ---------------------------------------------------------------------------------

export const SIGNATURE_HEADER = "x-antiproton-signature-256";
export const TIMESTAMP_HEADER = "x-antiproton-timestamp";
export const DELIVERY_HEADER = "x-antiproton-delivery-id";
/** How far a hint's timestamp may be from the receiver's clock, either way. */
export const SIGNATURE_WINDOW_S = 300;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hmacKey = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);

/** `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`: the value of SIGNATURE_HEADER. */
export async function signHint(secret: string, timestamp: number, body: string): Promise<string> {
  return `sha256=${hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

/** What Raft does with a hint, as code: the timestamp within the window, then the signature over exactly those bytes. */
export async function verifyHint(secret: string, headers: { signature: string | null; timestamp: string | null }, body: string, nowS: number): Promise<boolean> {
  const ts = Number(headers.timestamp);
  if (!headers.timestamp || !Number.isInteger(ts) || Math.abs(nowS - ts) > SIGNATURE_WINDOW_S) return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(headers.signature ?? "");
  if (!m) return false;
  const sig = new Uint8Array(m[1]!.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig, new TextEncoder().encode(`${ts}.${body}`));
}

/** The hint's `type`, by the state published. */
export const hintType = (s: ApprovalState) => s === "pending" ? "approval.requested" : s === "expired" ? "approval.expired"
  : s === "executed" ? "approval.executed" : s === "failed" ? "approval.failed" : "approval.decided";

/**
 * Where hints go for an agent made at `raftOrigin`: that origin plus RAFT_APPROVAL_CALLBACK_PATH, signed with
 * RAFT_APPROVAL_CALLBACK_SECRET. Null (no hints; Raft reconciles by polling) unless both are set. The origin is the
 * agent's own, never configured, so a hint about one Raft's agents cannot be sent to another address.
 */
export function hintTarget(env: { RAFT_APPROVAL_CALLBACK_PATH?: string; RAFT_APPROVAL_CALLBACK_SECRET?: string }, raftOrigin: string):
  { url: string; secret: string } | null {
  const path = env.RAFT_APPROVAL_CALLBACK_PATH?.trim(), secret = env.RAFT_APPROVAL_CALLBACK_SECRET;
  if (!path || !path.startsWith("/") || path.startsWith("//") || !secret) return null;
  try {
    const url = new URL(path, raftOrigin);
    return url.origin === new URL(raftOrigin).origin ? { url: url.toString(), secret } : null;
  } catch { return null; }
}

// ---- publishing, from the agent's alarm pass -----------------------------------------------------------------

/** How many times a hint is sent before it is left to Raft's reconcile. */
export const HINT_ATTEMPTS = 6;
const HINT_TIMEOUT_MS = 5_000;
/** 30 s, 1, 2, 4, 8 min, then every 15 min. */
export const publishBackoffMs = (attempts: number) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };

export interface PublishDeps {
  sql: Sql;
  tenantId: string;
  agentId: string;
  now(): number;
  /** The agent's provisioning record; null: not a provisioned agent (nothing to publish to). */
  registry(): Promise<ProvisionedAgent | null>;
  /** The item for a row, redacted with the agent's sealed values. */
  item(a: ApprovalRecord, reg: ProvisionedAgent): Promise<ApprovalItem>;
  index: ApprovalIndex;
  /** Where hints go; null: none are sent. */
  target(reg: ProvisionedAgent): { url: string; secret: string } | null;
  fetch: typeof fetch;
  newId(): string;
}

function ensurePublishTable(sql: Sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS approval_publish (
    operation_id TEXT PRIMARY KEY, for_state TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0)`);
}

/**
 * Publish every hold whose state has not been published yet: the item to D1, then the hint. Bounded per pass. A
 * failure is kept with when to try again (`publishBackoffMs`); after HINT_ATTEMPTS failed hints the state is marked
 * published anyway, since the copy in D1 is what Raft's reconcile reads. An agent that was not provisioned publishes
 * nothing; a deleted one writes D1 only, its kept record, and hints nothing. Answers when the next try is due (null: nothing left).
 */
export async function publishApprovals(d: PublishDeps): Promise<{ published: number; failed: number; nextAt: number | null }> {
  const { sql } = d;
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").toArray().length > 0;
  if (!has) return { published: 0, failed: 0, nextAt: null };
  // Most passes have nothing to publish: asked of `approvals` alone, so an agent that never held a call gets no table.
  const any = sql.exec("SELECT 1 AS x FROM approvals WHERE tenant_id = ? AND agent_id = ? AND (published_state IS NULL OR published_state != state) LIMIT 1",
    d.tenantId, d.agentId).toArray().length > 0;
  if (!any) return { published: 0, failed: 0, nextAt: null };
  ensurePublishTable(sql);
  const rows = sql.exec(
    `SELECT a.*, p.for_state AS p_state, p.indexed AS p_indexed, p.attempts AS p_attempts, p.next_at AS p_next
       FROM approvals a LEFT JOIN approval_publish p ON p.operation_id = a.operation_id
      WHERE a.tenant_id = ? AND a.agent_id = ? AND (a.published_state IS NULL OR a.published_state != a.state)
      ORDER BY a.created_at LIMIT 50`, d.tenantId, d.agentId).toArray() as any[];
  if (!rows.length) return { published: 0, failed: 0, nextAt: null };
  const now = d.now();
  const fresh = (r: any) => r.p_state === r.state;
  const due = rows.filter((r) => !fresh(r) || Number(r.p_next ?? 0) <= now);
  const markPublished = (r: any) => {
    sql.exec("UPDATE approvals SET published_state = ? WHERE tenant_id = ? AND operation_id = ?", r.state, d.tenantId, r.operation_id);
    sql.exec("DELETE FROM approval_publish WHERE operation_id = ?", r.operation_id);
  };
  let published = 0, failed = 0;
  if (due.length) {
    let reg: ProvisionedAgent | null;
    try { reg = await d.registry(); }
    catch (e) {
      // The registry could not be read: nothing is decided about these rows; the next pass asks again.
      console.warn(`approval publish of ${d.tenantId}/${d.agentId}: the registry could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      return { published: 0, failed: due.length, nextAt: now + publishBackoffMs(1) };
    }
    if (!reg) {
      for (const r of due) markPublished(r);
      return { published: 0, failed: 0, nextAt: null };
    }
    // A deleted agent's holds still reach D1, as its kept record (a decision or expiry that lands after the delete),
    // and no hint goes to Raft, which retired the agent's cards with it.
    const deleted = reg.status === "deleted";
    for (const r of due) {
      const attempts = fresh(r) ? Number(r.p_attempts ?? 0) : 0;
      let indexed = fresh(r) && Number(r.p_indexed ?? 0) === 1;
      try {
        if (!indexed) {
          const a = mapApproval(r);
          await d.index.upsert({
            tenantId: d.tenantId, agentId: d.agentId, operationId: a.operationId, raftOrigin: reg.raftOrigin, raftServerId: reg.raftServerId,
            raftAgentId: reg.raftAgentId, status: a.state, item: await d.item(a, reg), createdAt: a.createdAt, expiresAt: a.expiresAt, updatedAt: d.now(),
          });
          indexed = true;
        }
        const target = deleted ? null : d.target(reg);
        if (target) {
          const body = JSON.stringify({ type: hintType(r.state), operationId: r.operation_id, providerAgentId: d.agentId,
            raftAgentId: reg.raftAgentId, raftServerId: reg.raftServerId, status: r.state });
          const ts = Math.floor(d.now() / 1000);
          const res = await d.fetch(target.url, {
            method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(HINT_TIMEOUT_MS),
            headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: await signHint(target.secret, ts, body), [DELIVERY_HEADER]: d.newId() },
          });
          await res.body?.cancel().catch(() => {});
          if (!res.ok) throw new HintRefused(`Raft answered the hint with HTTP ${res.status}`);
        }
        markPublished(r);
        published++;
        logEvent("approval.published", { tenantId: d.tenantId, agentId: d.agentId, operationId: r.operation_id, state: r.state, hinted: target !== null });
      } catch (e) {
        failed++;
        const n = attempts + 1;
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        // Bounded only once the copy is in D1: Raft's reconcile reads that, so a hint that never lands loses nothing.
        if (indexed && n >= HINT_ATTEMPTS) {
          markPublished(r);
          logEvent("approval.hint_given_up", { tenantId: d.tenantId, agentId: d.agentId, operationId: r.operation_id, state: r.state, attempts: n, error: why });
          continue;
        }
        sql.exec(`INSERT INTO approval_publish(operation_id, for_state, indexed, attempts, next_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(operation_id) DO UPDATE SET for_state = excluded.for_state, indexed = excluded.indexed, attempts = excluded.attempts, next_at = excluded.next_at`,
          r.operation_id, r.state, indexed ? 1 : 0, n, now + publishBackoffMs(n));
        console.warn(`approval publish of ${d.tenantId}/${d.agentId} ${r.operation_id} (${r.state}) failed, attempt ${n}: ${why}`);
      }
    }
  }
  const left = sql.exec(
    `SELECT MIN(COALESCE(p.next_at, 0)) AS n FROM approvals a LEFT JOIN approval_publish p ON p.operation_id = a.operation_id AND p.for_state = a.state
      WHERE a.tenant_id = ? AND a.agent_id = ? AND (a.published_state IS NULL OR a.published_state != a.state)`, d.tenantId, d.agentId).toArray()[0] as any;
  return { published, failed, nextAt: left?.n === null || left?.n === undefined ? null : Math.max(Number(left.n), now) };
}

class HintRefused extends Error {}
