/**
 * The operator's credential inventory, `GET /admin/credential-inventory` (#1128's "List" half): for each provisioned
 * agent, deleted ones included, whether its connection mounts hold a key, reconciled against the binding
 * (`provisioned_connections`) and the connector events, with the agent's open egress residue.
 *
 * Records are the index, resources the authority: D1 says which agents there are and what was recorded about them;
 * what a mount holds is asked of the agent's own object, never inferred from D1. A deleted agent's object storage is
 * kept, so its mounts are asked too.
 *
 * Read-only and bounded: one page of agents per call (at most INVENTORY_PAGE_MAX objects asked), resumed by `cursor`,
 * optionally within one tenant. Every call, refused ones included, is a row in admin_audit (migration 0033). Never a
 * credential value: a key on a mount is reported by its presence and a fingerprint (`AgentRuntime.connectionHoldings`).
 *
 * What it cannot see: run9's egress registrations (only the residue already recorded in egress_residue is listed);
 * agents this deployment did not provision (console agents have no binding and no connector events); and a mount
 * whose object did not answer (`object: "failed"`, its connections `unknown`).
 */
import { isOperator } from "./auth.ts";
import { CONNECTION_PLUGIN, type ConnectionProvider } from "./provision/connect.ts";
import { logEvent } from "../../src/core/log.ts";

/** One mount of a connection plugin, as the agent's object reads it (`AgentRuntime.connectionHoldings`). */
export interface ConnectionHolding {
  alias: string;
  plugin: string;
  /**
   * `agent`: a key of the agent's own is on it (a connection's, or one put there in the console); `shared`: the
   * deployment's seeded account; `none`: nothing; `dangling`: the mount names a key of the agent's that is not stored.
   */
  key: "agent" | "shared" | "none" | "dangling";
  /** The connector the key's renewal record names; null when none is recorded (a key that does not renew, or older). */
  connectorId: string | null;
  /** `sha256:` and 16 hex characters of the key's hash; null when there is no key or it could not be opened here. */
  fingerprint: string | null;
}

export type Reconciled = "both" | "mount_only" | "binding_only" | "neither" | "unknown";

export const INVENTORY_PAGE_DEFAULT = 10;
export const INVENTORY_PAGE_MAX = 25;
/** Objects asked at once within a page. */
const ASK_AT_ONCE = 5;
const EVENTS_PER_AGENT = 20;
const UNLISTED_RESIDUE_MAX = 100;
/** The events that take a binding away: a mount still holding a key after one of these is what this list looks for. */
const REMOVALS = ["unbind", "disconnect", "origin_mismatch_removed", "deleted_agent_unbound"];

export interface InventoryDeps {
  token: string | undefined;
  db: D1Database;
  /** The agent's object's answer; null when the object holds no such agent (its storage was wiped). */
  holdings: (tenantId: string, agentId: string, plugins: readonly string[]) => Promise<ConnectionHolding[] | null>;
  now: () => number;
}

type Cursor = { t: string; r: string };
const encodeCursor = (c: Cursor) => btoa(JSON.stringify([c.t, c.r])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeCursor(s: string): Cursor | null {
  try {
    const v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" ? { t: v[0], r: v[1] } : null;
  } catch { return null; }
}

export async function adminCredentialInventory(request: Request, url: URL, deps: InventoryDeps): Promise<Response> {
  const db = deps.db;
  const claimedCaller = (request.headers.get("x-claimed-caller") ?? "").trim().slice(0, 64) || null;
  // As /admin/withdraw-egress: no id is written until the token is checked, and none past 128 characters.
  let tenantId = url.searchParams.get("tenantId") ?? "";
  const tooLong = tenantId.length > 128;
  const authorized = isOperator(deps.token, request.headers.get("x-harness-token"));
  if (tooLong || !authorized) tenantId = "";
  const audit = async (outcome: string, counts?: Record<string, number>, id?: number): Promise<number | null> => {
    const at = deps.now();
    logEvent("admin.credential_inventory", { tenantId: tenantId || null, claimedCaller, outcome, at: new Date(at).toISOString(), ...(counts ?? {}) });
    if (id !== undefined) {
      await db.prepare("UPDATE admin_audit SET outcome = ?, counts = ?, finished_at = ? WHERE id = ?")
        .bind(outcome, counts ? JSON.stringify(counts) : null, at, id).run();
      return id;
    }
    const row = await db.prepare(
      "INSERT INTO admin_audit (at, route, tenant_id, claimed_caller, outcome, counts) VALUES (?, '/admin/credential-inventory', ?, ?, ?, ?) RETURNING id",
    ).bind(at, tenantId || null, claimedCaller, outcome, counts ? JSON.stringify(counts) : null).first<{ id: number }>();
    return row ? Number(row.id) : null;
  };
  if (!authorized) { await audit("unauthorized"); return Response.json({ error: "unauthorized" }, { status: 401 }); }
  if (tooLong) { await audit("ids_too_long"); return Response.json({ error: "tenantId is at most 128 characters" }, { status: 400 }); }
  if (request.method !== "GET") { await audit("wrong_method"); return Response.json({ error: "GET" }, { status: 405 }); }
  if (!claimedCaller) {
    await audit("no_claimed_caller");
    return Response.json({ error: "x-claimed-caller is required: who is calling, as free text" }, { status: 400 });
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? INVENTORY_PAGE_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > INVENTORY_PAGE_MAX) {
    await audit("bad_limit");
    return Response.json({ error: `limit is a whole number from 1 to ${INVENTORY_PAGE_MAX}` }, { status: 400 });
  }
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw === null ? null : decodeCursor(cursorRaw);
  if (cursorRaw !== null && (cursor === null || (tenantId && cursor.t !== tenantId))) {
    await audit("bad_cursor");
    return Response.json({ error: "cursor is not one this route gave for this tenant" }, { status: 400 });
  }

  // Written before any object is asked: a call the Worker does not live to finish stays 'started'.
  const id = await audit("started");
  if (id === null) return Response.json({ error: "the audit row could not be written, so nothing was read" }, { status: 503 });

  const page = (await db.prepare(
    "SELECT tenant_id, raft_agent_id, agent_id, status, deleted_at FROM provisioned_agents" +
    " WHERE (? = '' OR tenant_id = ?) AND (tenant_id > ? OR (tenant_id = ? AND raft_agent_id > ?))" +
    " ORDER BY tenant_id, raft_agent_id LIMIT ?",
  ).bind(tenantId, tenantId, cursor?.t ?? "", cursor?.t ?? "", cursor?.r ?? "", limit + 1).all<{
    tenant_id: string; raft_agent_id: string; agent_id: string; status: string; deleted_at: number | null;
  }>()).results;
  const more = page.length > limit;
  const rows = page.slice(0, limit);
  const providers = Object.keys(CONNECTION_PLUGIN) as ConnectionProvider[];
  const plugins = providers.map((p) => CONNECTION_PLUGIN[p]);

  const agentView = async (a: typeof rows[number]) => {
    let object: "answered" | "no_agent" | "failed" = "answered";
    let mounts: ConnectionHolding[] = [];
    try {
      const h = await deps.holdings(a.tenant_id, a.agent_id, plugins);
      if (h === null) object = "no_agent"; else mounts = h;
    } catch { object = "failed"; }
    const bindings = (await db.prepare(
      "SELECT provider, connector_id, account, connected_at, broken_at FROM provisioned_connections WHERE tenant_id = ? AND raft_agent_id = ?",
    ).bind(a.tenant_id, a.raft_agent_id).all<{ provider: string; connector_id: string | null; account: string | null; connected_at: number; broken_at: number | null }>()).results;
    const events = (await db.prepare(
      "SELECT action, connector_id, provider, acting_role, at, reason FROM connector_events WHERE tenant_id = ? AND raft_agent_id = ? ORDER BY at DESC LIMIT ?",
    ).bind(a.tenant_id, a.raft_agent_id, EVENTS_PER_AGENT).all<{ action: string; connector_id: string | null; provider: string | null; acting_role: string; at: number; reason: string | null }>()).results;
    const eventCount = (await db.prepare("SELECT COUNT(*) AS n FROM connector_events WHERE tenant_id = ? AND raft_agent_id = ?")
      .bind(a.tenant_id, a.raft_agent_id).first<{ n: number }>())?.n ?? 0;
    // By egress_residue's own columns: no join to the registry, so nothing is left out for the agent's status.
    const residue = (await db.prepare(
      "SELECT alias, box_id, secret_id, title, reason_code, first_seen, last_seen, reopened_count FROM egress_residue" +
      " WHERE tenant_id = ? AND agent_id = ? AND resolved_at IS NULL ORDER BY first_seen",
    ).bind(a.tenant_id, a.agent_id).all()).results;
    const connections = providers.map((provider) => {
      const plugin = CONNECTION_PLUGIN[provider];
      const mine = mounts.filter((m) => m.plugin === plugin);
      const onMount = mine.some((m) => m.key === "agent");
      const binding = bindings.find((b) => b.provider === provider) ?? null;
      const state: Reconciled = object === "failed" ? "unknown"
        : onMount && binding ? "both" : onMount ? "mount_only" : binding ? "binding_only" : "neither";
      // The newest event that took a binding away (an event recorded before 0032 names no provider).
      const lastRemoval = events.find((e) => REMOVALS.includes(e.action) && (e.provider === null || e.provider === provider)) ?? null;
      return {
        provider, plugin, state, mounts: mine,
        binding: binding ? { connector_id: binding.connector_id, account: binding.account, connected_at: binding.connected_at, broken_at: binding.broken_at } : null,
        // Whether the key's renewal record names the connector the binding names; false when it names another, or none.
        ...(state === "both" ? { sameConnector: mine.some((m) => m.key === "agent" && m.connectorId !== null && m.connectorId === binding!.connector_id) } : {}),
        ...(state === "mount_only" ? { removalRecorded: lastRemoval !== null } : {}),
        lastRemoval,
      };
    });
    return {
      tenant_id: a.tenant_id, raft_agent_id: a.raft_agent_id, agent_id: a.agent_id, status: a.status, deleted_at: a.deleted_at,
      object, connections, events: { count: Number(eventCount), recent: events }, residue,
    };
  };
  let agents: Array<Awaited<ReturnType<typeof agentView>>>;
  try {
    agents = [];
    for (let i = 0; i < rows.length; i += ASK_AT_ONCE) agents.push(...await Promise.all(rows.slice(i, i + ASK_AT_ONCE).map(agentView)));
  } catch (e) {
    await audit("failed", undefined, id).catch(() => {});
    logEvent("admin.credential_inventory", { tenantId: tenantId || null, failed: true, errorName: (e as Error)?.name ?? "unknown" });
    return Response.json({ error: "the inventory could not be read" }, { status: 503 });
  }
  // Residue whose agent is not in the registry at all, once, on the scope's last page: read by its own columns, so a
  // row is never lost to a registry that no longer lists its agent.
  const unlisted = more ? null : (await db.prepare(
    "SELECT tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen, reopened_count FROM egress_residue r" +
    " WHERE (? = '' OR r.tenant_id = ?) AND r.resolved_at IS NULL" +
    " AND NOT EXISTS (SELECT 1 FROM provisioned_agents p WHERE p.tenant_id = r.tenant_id AND p.agent_id = r.agent_id)" +
    " ORDER BY r.tenant_id, r.agent_id, r.first_seen LIMIT ?",
  ).bind(tenantId, tenantId, UNLISTED_RESIDUE_MAX + 1).all()).results;

  const counts: Record<string, number> = { agents: agents.length, both: 0, mount_only: 0, binding_only: 0, neither: 0, unknown: 0,
    residue: agents.reduce((n, a) => n + a.residue.length, 0) };
  for (const a of agents) for (const c of a.connections) counts[c.state]! += 1;
  await audit("listed", counts, id);
  const last = rows[rows.length - 1];
  return Response.json({
    at: new Date(deps.now()).toISOString(), ...(tenantId ? { tenantId } : {}), counts, agents,
    ...(unlisted ? { residueOfUnlistedAgents: unlisted.slice(0, UNLISTED_RESIDUE_MAX), ...(unlisted.length > UNLISTED_RESIDUE_MAX ? { residueOfUnlistedAgentsTruncated: true } : {}) } : {}),
    ...(more && last ? { cursor: encodeCursor({ t: last.tenant_id, r: last.raft_agent_id }) } : {}),
  }, { headers: { "cache-control": "no-store" } });
}

