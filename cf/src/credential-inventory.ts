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
 * optionally within one tenant. Every call past the token, refusals included, is a row in admin_audit (migration 0033); a 401 is a log line only. Never a
 * credential value, nor anything derived from one: a key on a mount is reported by its presence and the connector its
 * renewal names (`readConnectionHoldings`). A hash of a key would confirm a guessed or leaked one and match it across
 * systems, so there is none.
 *
 * What it cannot see: run9's egress registrations (only the residue already recorded in egress_residue is listed);
 * agents this deployment did not provision (console agents have no binding and no connector events); and a mount
 * whose object did not answer (`object: "failed"`, its connections `unknown`) or holds no such agent (`object:
 * "no_agent"`, its connections `no_object`).
 */
import { isOperator } from "./auth.ts";
import { CONNECTION_PLUGIN, type ConnectionProvider } from "./provision/connect.ts";
import { logEvent } from "../../src/core/log.ts";
import { agentRef, isAgentRef, open, type Sealed } from "../../src/runtime/secrets.ts";
import { OAUTH_PREFIX, reasonCode } from "./github-refresh.ts";
import type { MountRecord } from "../../src/core/types.ts";

/** One mount of a connection plugin, as the agent's object reads it (`readConnectionHoldings`). */
export interface ConnectionHolding {
  alias: string;
  plugin: string;
  /**
   * `agent`: a key of the agent's own is on it (a connection's, or one put there in the console); `shared`: the
   * deployment's seeded account; `none`: nothing; `dangling`: the mount names a key of the agent's that is not stored.
   */
  key: "agent" | "shared" | "none" | "dangling";
  /**
   * The connector the key's renewal record names; null when none is recorded (a key that does not renew, or older) or
   * the record cannot be opened here (no SECRET_KEK, or sealed under another).
   */
  connectorId: string | null;
}

/**
 * What an agent's mounts of each plugin hold, read from its store with SELECTs only: no runtime is built, nothing is
 * readied, renewed or written, and the key itself is never opened (only the renewal record, for its connector).
 *
 * Reads with direct SELECTs and never builds the runtime: building it runs migrations and creates tables, with
 * possible side effects. Tests cannot prove this (the object's constructor already creates tables); only review keeps
 * it so.
 */
export async function readConnectionHoldings(
  store: { findMountsByPlugin(t: string, a: string, plugin: string): Promise<MountRecord[]>; getSecret(t: string, a: string, name: string): Promise<Sealed | null> },
  kek: CryptoKey | null, tenantId: string, agentId: string, plugins: readonly string[],
): Promise<ConnectionHolding[]> {
  const out: ConnectionHolding[] = [];
  for (const plugin of plugins) {
    for (const mount of await store.findMountsByPlugin(tenantId, agentId, plugin)) {
      // As the runtime decides it (cf/src/runtime.ts detachConnectionIfFrom, and GithubRefresher.read in
      // cf/src/github-refresh.ts): the store's own mount and secret reads, the key named by the reference, its renewal
      // record under OAUTH_PREFIX + that name. A copy of that reading, held to the runtime's by a test
      // (test/github-token-refresh.ts) until #1135 makes it one function.
      const name = isAgentRef(mount.secretRef) ? mount.secretRef!.slice(agentRef("").length) : null;
      if (name === null) {
        out.push({ alias: mount.alias, plugin, key: mount.secretRef ? "shared" : "none", connectorId: null });
        continue;
      }
      if (!(await store.getSecret(tenantId, agentId, name))) { out.push({ alias: mount.alias, plugin, key: "dangling", connectorId: null }); continue; }
      let connectorId: string | null = null;
      const rec = kek ? await store.getSecret(tenantId, agentId, OAUTH_PREFIX + name) : null;
      if (kek && rec) { try { connectorId = (JSON.parse(await open(kek, rec)) as { connectorId?: string | null }).connectorId ?? null; } catch { /* stays null */ } }
      out.push({ alias: mount.alias, plugin, key: "agent", connectorId });
    }
  }
  return out;
}

/**
 * The tables and columns `readConnectionHoldings` reads through the store (`findMountsByPlugin`, `getSecret`). Every
 * layout the object store has had carries them: `mounts` and `secrets` have only gained or dropped other columns
 * (src/store/durable-object.ts `init`: policy, tool_snapshot added; last4 dropped). An object without one is listed
 * `layout_unknown`, never read as "no key".
 */
export const HOLDINGS_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  mounts: ["tenant_id", "agent_id", "alias", "plugin", "secret_ref", "public_config"],
  secrets: ["tenant_id", "agent_id", "name", "ciphertext", "iv"],
};

/** What of HOLDINGS_LAYOUT an object's storage lacks (`table` or `table.column`), by SELECTs that read no row. */
export function layoutMissing(sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } }): string[] {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(HOLDINGS_LAYOUT)) {
    if (sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length === 0) { missing.push(table); continue; }
    for (const c of columns) { try { sql.exec(`SELECT "${c}" FROM "${table}" LIMIT 0`); } catch { missing.push(`${table}.${c}`); } }
  }
  return missing;
}

/**
 * `unknown`: the object did not answer; ask again later. `no_object`: it answered that it holds no such agent, so there
 * is no mount to read. Asking again changes nothing, and it is never "nothing there": a person judges it
 * (NO_OBJECT_NOTE).
 */
export type Reconciled = "both" | "mount_only" | "binding_only" | "neither" | "unknown" | "no_object" | "layout_unknown";

/**
 * The object cannot say why it holds no agent: one whose provisioning never reached it and one whose storage was wiped
 * look the same from here, and the registry row exists either way.
 */
export const NO_OBJECT_NOTE = "cannot distinguish never provisioned from storage wiped; do not treat as clean";

export const INVENTORY_PAGE_DEFAULT = 10;
export const INVENTORY_PAGE_MAX = 25;
/** Objects asked at once within a page. */
export const ASK_AT_ONCE = 5;
/** How long one object is waited for before it is listed `failed` (`unknown`): a hung object must not hold the page. */
export const OBJECT_TIMEOUT_MS = 10_000;
const EVENTS_PER_AGENT = 20;
const UNLISTED_RESIDUE_MAX = 100;
/** The events that take a binding away: a mount still holding a key after one of these is what this list looks for. */
const REMOVALS = ["unbind", "disconnect", "origin_mismatch_removed", "deleted_agent_unbound"];
/** The events that make one. */
const BINDINGS = ["create", "bind"];

/**
 * An event's `reason` as codes only. Stored reasons hold free text (an object's error message, origins): never
 * answered. A JSON reason keeps its booleans, numbers and code-shaped `outcome`, `via` and `provider`; any other text
 * is reduced to its renewal reason code (`reasonCode`).
 */
export function reasonCodes(reason: string | null): Record<string, string | number | boolean> | null {
  if (reason === null) return null;
  let v: unknown;
  try { v = JSON.parse(reason); } catch { return { code: reasonCode(reason) ?? "other" }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { code: "other" };
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "boolean" || typeof x === "number") out[k] = x;
    else if ((k === "outcome" || k === "via" || k === "provider") && typeof x === "string" && /^[a-z_]{1,40}$/.test(x)) out[k] = x;
  }
  return out;
}

const DB_FAILED = "the inventory's records could not be read or written, so nothing is answered";

export interface InventoryDeps {
  token: string | undefined;
  db: D1Database;
  /** The agent's object's answer; null when the object holds no such agent (its storage was wiped). */
  holdings: (tenantId: string, agentId: string, plugins: readonly string[]) => Promise<ConnectionHolding[] | null | { layoutMissing: string[] }>;
  now: () => number;
  objectTimeoutMs?: number;
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
  // No id is kept from an unchecked caller, nor one past 128 characters.
  let tenantId = url.searchParams.get("tenantId") ?? "";
  const tooLong = tenantId.length > 128;
  const authorized = isOperator(deps.token, request.headers.get("x-harness-token"));
  if (tooLong || !authorized) tenantId = "";
  // A 401 is logged only, never a D1 row: this route is in production for good, and a stranger's requests must not
  // write to the database at their own rate.
  if (!authorized) {
    logEvent("admin.credential_inventory", { tenantId: null, claimedCaller, outcome: "unauthorized", at: new Date(deps.now()).toISOString() });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Past the token, every D1 failure is a fixed 503 and a log line with the error's class: D1's text never reaches a
  // response.
  try { return await inventory(); } catch (e) {
    logEvent("admin.credential_inventory", { tenantId: tenantId || null, claimedCaller, outcome: "db_failed", errorName: (e as Error)?.name ?? "unknown" });
    return Response.json({ error: DB_FAILED }, { status: 503 });
  }

  async function inventory(): Promise<Response> {
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
  if (id === null) return Response.json({ error: DB_FAILED }, { status: 503 });

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

  // Three ids name one agent here, and a swapped one answers an empty list, not an error:
  //  - `agent_id` (the provider's agent id, `raft_<raft id>`): egress_residue.agent_id, and the object's name,
  //    agentObjectName(tenant_id, agent_id), through `deps.holdings`;
  //  - `raft_agent_id` (Raft's id): provisioned_connections and connector_events;
  //  - `tenant_id`: all of them.
  const agentView = async (a: typeof rows[number]) => {
    let object: "answered" | "no_agent" | "failed" | "layout_unknown" = "answered";
    let missing: string[] = [];
    let mounts: ConnectionHolding[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const h = await Promise.race([
        deps.holdings(a.tenant_id, a.agent_id, plugins),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), deps.objectTimeoutMs ?? OBJECT_TIMEOUT_MS); }),
      ]);
      if (h !== null && !Array.isArray(h) && !(Array.isArray(h.layoutMissing) && h.layoutMissing.every((x) => typeof x === "string"))) throw new TypeError("not a list");
      // Field by field: whatever else an object answers (an older build's, or a mistake) is not passed on.
      if (h === null) object = "no_agent";
      else if (!Array.isArray(h)) { object = "layout_unknown"; missing = h.layoutMissing.slice(0, 20); }
      else mounts = h.map((m) => ({ alias: m.alias, plugin: m.plugin, key: m.key, connectorId: m.connectorId }));
    } catch (e) {
      object = "failed";
      // Its class or shape only: an object's error message can quote what it was reading.
      logEvent("admin.credential_inventory", { tenantId: a.tenant_id, agentId: a.agent_id, outcome: "object_failed",
        errorName: (e as Error)?.message === "timeout" ? "timeout" : (e as Error)?.name ?? typeof e });
    } finally { clearTimeout(timer); }
    const bindings = (await db.prepare(
      "SELECT provider, connector_id, account, connected_at, broken_at FROM provisioned_connections WHERE tenant_id = ? AND raft_agent_id = ?",
    ).bind(a.tenant_id, a.raft_agent_id).all<{ provider: string; connector_id: string | null; account: string | null; connected_at: number; broken_at: number | null }>()).results;
    type EventRow = { action: string; connector_id: string | null; provider: string | null; acting_role: string; at: number; reason: string | null };
    // `reasonCode`, not `reason`: the stored text never comes back under a name that invites it.
    const asCodes = (e: EventRow | null) => e && { action: e.action, connector_id: e.connector_id, provider: e.provider, acting_role: e.acting_role, at: e.at, reasonCode: reasonCodes(e.reason) };
    const events = (await db.prepare(
      "SELECT action, connector_id, provider, acting_role, at, reason FROM connector_events WHERE tenant_id = ? AND raft_agent_id = ? ORDER BY at DESC LIMIT ?",
    ).bind(a.tenant_id, a.raft_agent_id, EVENTS_PER_AGENT).all<EventRow>()).results.map(asCodes);
    const eventCount = (await db.prepare("SELECT COUNT(*) AS n FROM connector_events WHERE tenant_id = ? AND raft_agent_id = ?")
      .bind(a.tenant_id, a.raft_agent_id).first<{ n: number }>())?.n ?? 0;
    // By egress_residue's own columns: no join to the registry, so nothing is left out for the agent's status.
    const residue = (await db.prepare(
      "SELECT alias, box_id, secret_id, title, reason_code, first_seen, last_seen, reopened_count FROM egress_residue" +
      " WHERE tenant_id = ? AND agent_id = ? AND resolved_at IS NULL ORDER BY first_seen",
    ).bind(a.tenant_id, a.agent_id).all()).results;
    // Per provider, each by its own query, however many events came after: the newest event that took a binding away,
    // and the newest that made one (an event recorded before 0032 names no provider).
    const newest = (actions: string[], provider: string) => db.prepare(
      `SELECT action, connector_id, provider, acting_role, at, reason FROM connector_events WHERE tenant_id = ? AND raft_agent_id = ?` +
      ` AND action IN (${actions.map(() => "?").join(", ")}) AND (provider = ? OR provider IS NULL) ORDER BY at DESC LIMIT 1`,
    ).bind(a.tenant_id, a.raft_agent_id, ...actions, provider).first<EventRow>();
    const removals = new Map<string, EventRow | null>(), bound = new Map<string, EventRow | null>();
    for (const provider of providers) {
      removals.set(provider, await newest(REMOVALS, provider));
      bound.set(provider, await newest(BINDINGS, provider));
    }
    const connections = providers.map((provider) => {
      const plugin = CONNECTION_PLUGIN[provider];
      const mine = mounts.filter((m) => m.plugin === plugin);
      const onMount = mine.some((m) => m.key === "agent");
      const binding = bindings.find((b) => b.provider === provider) ?? null;
      const state: Reconciled = object === "failed" ? "unknown" : object === "no_agent" ? "no_object" : object === "layout_unknown" ? "layout_unknown"
        : onMount && binding ? "both" : onMount ? "mount_only" : binding ? "binding_only" : "neither";
      const lastRemoval = removals.get(provider) ?? null;
      // A removal speaks for the present only when nothing bound it since: neither the current binding nor a later
      // bind event. An older removal, followed by a re-bind, must not cover a later removal nothing recorded.
      // connected_at is the latest bind's time: a re-bind overwrites it, and a disconnect deletes the row
      // (`d1Connections` `put`, cf/src/control-plane.ts).
      const boundAt = Math.max(binding?.connected_at ?? -Infinity, bound.get(provider)?.at ?? -Infinity);
      const removalRecorded = lastRemoval !== null && lastRemoval.at >= boundAt;
      return {
        provider, plugin, state, mounts: mine,
        binding: binding ? { connector_id: binding.connector_id, account: binding.account, connected_at: binding.connected_at, broken_at: binding.broken_at } : null,
        // Whether the key's renewal record names the connector the binding names; false when it names another, or none.
        ...(state === "both" ? { sameConnector: mine.some((m) => m.key === "agent" && m.connectorId !== null && m.connectorId === binding!.connector_id) } : {}),
        removalRecorded, lastRemoval: asCodes(lastRemoval),
      };
    });
    return {
      tenant_id: a.tenant_id, raft_agent_id: a.raft_agent_id, agent_id: a.agent_id, status: a.status, deleted_at: a.deleted_at,
      object, ...(object === "no_agent" ? { objectNote: NO_OBJECT_NOTE } : {}), ...(object === "layout_unknown" ? { layoutMissing: missing } : {}), connections, events: { count: Number(eventCount), recent: events }, residue,
    };
  };
  let agents: Array<Awaited<ReturnType<typeof agentView>>>;
  try {
    agents = [];
    for (let i = 0; i < rows.length; i += ASK_AT_ONCE) agents.push(...await Promise.all(rows.slice(i, i + ASK_AT_ONCE).map(agentView)));
  } catch (e) {
    await audit("failed", undefined, id).catch(() => {});
    throw e;
  }
  // Residue whose agent is not in the registry at all, once, on the scope's last page: read by its own columns, so a
  // row is never lost to a registry that no longer lists its agent.
  const unlisted = more ? null : (await db.prepare(
    "SELECT tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen, reopened_count FROM egress_residue r" +
    " WHERE (? = '' OR r.tenant_id = ?) AND r.resolved_at IS NULL" +
    " AND NOT EXISTS (SELECT 1 FROM provisioned_agents p WHERE p.tenant_id = r.tenant_id AND p.agent_id = r.agent_id)" +
    " ORDER BY r.tenant_id, r.agent_id, r.first_seen LIMIT ?",
  ).bind(tenantId, tenantId, UNLISTED_RESIDUE_MAX + 1).all()).results;

  const counts: Record<string, number> = { agents: agents.length, both: 0, mount_only: 0, binding_only: 0, neither: 0, unknown: 0, no_object: 0, layout_unknown: 0,
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
}

