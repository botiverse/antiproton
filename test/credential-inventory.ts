/**
 * `GET /admin/credential-inventory` (cf/src/credential-inventory.ts, #1128's List): each provisioned agent's
 * connection mounts, as its object reads them, against its binding, its connector events and its open egress residue.
 * Run through the Worker's own `fetch`, with D1 as node:sqlite under every migration and a stand-in for the agents'
 * objects that answers what each mount holds and records what was asked.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { setLogSink } from "../src/core/log.ts";
import type { ConnectionHolding } from "../cf/src/credential-inventory.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker, AgentDO } = await import("../cf/src/index.ts");
const { adminCredentialInventory, ASK_AT_ONCE } = await import("../cf/src/credential-inventory.ts");
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentRef, importKek, seal } from "../src/runtime/secrets.ts";
import { OAUTH_PREFIX } from "../cf/src/github-refresh.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const logged: string[] = [];
setLogSink((line) => logged.push(line));

const TOKEN = "operator-token-" + "o".repeat(24);
const held = (connectorId: string | null): ConnectionHolding => ({ alias: "github", plugin: "github", key: "agent", connectorId });

function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { prepare: (q: string) => stmt(q), raw: db } as unknown as D1Database & { raw: DatabaseSync };
}

/**
 * Agents in two tenants, one per class:
 *  t-a/A both: bound, key on the mount (renewed from that connector);
 *  t-a/B mount_only: deleted, binding gone with a recorded removal, key still on the mount, residue open;
 *  t-a/C binding_only: bound, nothing on the mount;
 *  t-a/D neither; t-a/E: its object did not answer; t-b/F: mount only, with no removal recorded.
 */
function world(objects: Record<string, ConnectionHolding[] | null | "throw"> = {}) {
  const db = d1();
  const agent = (t: string, r: string, status = "active", deletedAt: number | null = null) =>
    db.raw.prepare("INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 's', 'https://raft.example', 'n', '', ?, 1, 1, ?)").run(t, r, `raft_${r}`, status, deletedAt);
  const bind = (t: string, r: string, connector: string) =>
    db.raw.prepare("INSERT INTO provisioned_connections(tenant_id, raft_agent_id, provider, account, connected_by, connected_at, connector_id) VALUES (?, ?, 'github', 'octo', 'u', 5, ?)").run(t, r, connector);
  const event = (t: string, r: string, action: string, at: number, provider: string | null = "github") =>
    db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES (?, 'k1', ?, ?, 'u', 'system', ?, NULL, ?)").run(t, r, action, at, provider);
  agent("t-a", "A"); bind("t-a", "A", "k1"); event("t-a", "A", "create", 5);
  agent("t-a", "B", "deleted", 9); event("t-a", "B", "bind", 5); event("t-a", "B", "deleted_agent_unbound", 9);
  db.raw.prepare("INSERT INTO egress_residue(tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen) VALUES ('t-a', 'raft_B', 'sandbox', 'box-b', 'p1', 'GH_TOKEN', 'project_residue', 7, 8)").run();
  db.raw.prepare("INSERT INTO egress_residue(tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen, resolved_at, resolved_by) VALUES ('t-a', 'raft_B', 'sandbox', 'box-b', 'p0', 'OLD', 'project_residue', 1, 2, 3, 'listing_absent')").run();
  agent("t-a", "C"); bind("t-a", "C", "k1");
  agent("t-a", "D");
  agent("t-a", "E"); bind("t-a", "E", "k1");
  agent("t-b", "F");
  // Residue of an agent the registry does not list.
  db.raw.prepare("INSERT INTO egress_residue(tenant_id, agent_id, alias, box_id, secret_id, title, reason_code, first_seen, last_seen) VALUES ('t-b', 'raft_GONE', 'sandbox', 'box-g', 'p9', 'X', 'project_residue', 4, 4)").run();
  const answers: Record<string, ConnectionHolding[] | null | "throw"> = {
    "a/t-a/raft_A": [held("k1")], "a/t-a/raft_B": [held("k1")], "a/t-a/raft_C": [{ alias: "github", plugin: "github", key: "none", connectorId: null }],
    "a/t-a/raft_D": [], "a/t-a/raft_E": "throw", "a/t-b/raft_F": [held(null)], ...objects,
  };
  const asked: string[] = [];
  const AGENT = {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      adminConnectionHoldings: async (t: string, a: string, plugins: string[]) => {
        asked.push(n);
        must(`a/${t}/${a}` === n && JSON.stringify(plugins) === '["github"]', `asked ${n} for ${t}/${a} ${JSON.stringify(plugins)}`);
        const r = answers[n];
        if (r === "throw") throw new Error("the object is away");
        return r === undefined ? null : r;
      },
    }),
  };
  const rows = () => db.raw.prepare("SELECT * FROM admin_audit ORDER BY id").all() as any[];
  return { db, asked, rows, env: { CONTROL_DB: db, AGENT, AUTOMATION_TOKEN: TOKEN } };
}

async function get(w: ReturnType<typeof world>, query: string, headers: Record<string, string> = { "x-harness-token": TOKEN, "x-claimed-caller": "cody" }, method = "GET") {
  const res = await worker.fetch(new Request(`https://x/admin/credential-inventory${query}`, { method, headers }), w.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body };
}
const stateOf = (body: any, r: string) => body.agents.find((a: any) => a.raft_agent_id === r)?.connections?.[0]?.state;

await check("each agent's github connection is reconciled: both, mount only, binding only, neither, and unknown where the object did not answer; deleted agents included", async () => {
  const w = world();
  const r = await get(w, "?tenantId=t-a&limit=25");
  must(r.status === 200, `${r.status} ${r.text}`);
  const states = Object.fromEntries(["A", "B", "C", "D", "E"].map((x) => [x, stateOf(r.body, x)]));
  must(JSON.stringify(states) === JSON.stringify({ A: "both", B: "mount_only", C: "binding_only", D: "neither", E: "unknown" }), `states: ${JSON.stringify(states)}`);
  const b = r.body.agents.find((a: any) => a.raft_agent_id === "B");
  must(b.status === "deleted" && b.deleted_at === 9 && b.object === "answered", `the deleted agent: ${JSON.stringify(b)}`);
  must(r.body.agents.find((a: any) => a.raft_agent_id === "E").object === "failed", "the unanswered object");
  must(JSON.stringify(r.body.counts) === JSON.stringify({ agents: 5, both: 1, mount_only: 1, binding_only: 1, neither: 1, unknown: 1, no_object: 0, layout_unknown: 0, residue: 1 }), `counts: ${JSON.stringify(r.body.counts)}`);
  // Only the tenant asked for; no other tenant's object asked.
  must(!r.body.agents.some((a: any) => a.tenant_id !== "t-a") && !w.asked.some((n) => n.startsWith("a/t-b/")), `asked: ${w.asked.join(", ")}`);
});

await check("the mount comes from the object, not from D1: a binding with a key the object no longer has is binding_only, a key with no binding is mount_only", async () => {
  const w = world({ "a/t-a/raft_A": [], "a/t-a/raft_C": [held("k1")] });
  const r = await get(w, "?tenantId=t-a&limit=25");
  must(stateOf(r.body, "A") === "binding_only" && stateOf(r.body, "C") === "both", `A ${stateOf(r.body, "A")}, C ${stateOf(r.body, "C")}`);
  // A shared account's ref, or a ref to a key that is not stored, is not a key the agent holds.
  const w3 = world({ "a/t-a/raft_D": [{ alias: "github", plugin: "github", key: "shared", connectorId: null }, { alias: "gh2", plugin: "github", key: "dangling", connectorId: null }],
    "a/t-a/raft_C": [{ alias: "github", plugin: "github", key: "dangling", connectorId: null }] });
  const r3 = await get(w3, "?tenantId=t-a&limit=25");
  must(stateOf(r3.body, "D") === "neither" && stateOf(r3.body, "C") === "binding_only", `D ${stateOf(r3.body, "D")}, C ${stateOf(r3.body, "C")}`);
  // An object whose storage lacks what the read needs: said, never "no key".
  const w4 = world({ "a/t-a/raft_A": { layoutMissing: ["secrets", "mounts.secret_ref"] } as any });
  const r4 = await get(w4, "?tenantId=t-a&limit=25");
  const a4 = r4.body.agents.find((x: any) => x.raft_agent_id === "A");
  must(a4.object === "layout_unknown" && a4.connections[0].state === "layout_unknown" && JSON.stringify(a4.layoutMissing) === '["secrets","mounts.secret_ref"]' && r4.body.counts.layout_unknown === 1,
    `an old layout: ${JSON.stringify(a4)}`);
  // An object that holds no such agent: no mount to read, never "nothing there", and said so.
  for (const r0 of ["A", "D"]) {
    const w2 = world({ [`a/t-a/raft_${r0}`]: null });
    const r2 = await get(w2, "?tenantId=t-a&limit=25");
    const a = r2.body.agents.find((x: any) => x.raft_agent_id === r0);
    must(a.object === "no_agent" && a.connections[0].state === "no_object" && r2.body.counts.no_object === 1
      && a.objectNote === "cannot distinguish never provisioned from storage wiped; do not treat as clean", `${r0}, no agent in its object: ${JSON.stringify(a)}`);
  }
});

await check("the event table is audited: a mount-only key says whether a removal was recorded, and which", async () => {
  const w = world();
  const ra = await get(w, "?tenantId=t-a&limit=25");
  const b = ra.body.agents.find((a: any) => a.raft_agent_id === "B").connections[0];
  must(b.removalRecorded === true && b.lastRemoval?.action === "deleted_agent_unbound" && b.lastRemoval.at === 9, `B: ${JSON.stringify(b)}`);
  // A removal followed by more events than an agent's recent list holds, and a newer removal of another provider's.
  for (let i = 0; i < 25; i++) w.db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k1', 'B', 'broken', 'u', 'system', ?, NULL, 'github')").run(100 + i);
  w.db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k2', 'B', 'unbind', 'u', 'system', 200, NULL, 'gitlab')").run();
  const later = (await get(w, "?tenantId=t-a&limit=25")).body.agents.find((a: any) => a.raft_agent_id === "B");
  must(later.events.recent.length === 20 && !later.events.recent.some((e: any) => e.action === "deleted_agent_unbound")
    && later.connections[0].removalRecorded === true && later.connections[0].lastRemoval?.at === 9, `B after 26 newer events: ${JSON.stringify(later.connections[0])}`);
  // Codes only from a stored reason: never its free text, and under `reasonCode`.
  w.db.raw.prepare(`INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k1', 'B', 'unbind', 'u', 'system', 300, ?, 'github')`)
    .run(JSON.stringify({ via: "disconnect", outcome: "not_cleared", bindingKept: false, error: "gh is held by a background task in /secret/path", agentOrigin: "https://x.example" }));
  w.db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k1', 'B', 'broken', 'u', 'system', 301, 'the token endpoint answered 502 without an OAuth error', 'github')").run();
  const coded = await get(w, "?tenantId=t-a&limit=25");
  const be = coded.body.agents.find((a: any) => a.raft_agent_id === "B");
  must(JSON.stringify(be.connections[0].lastRemoval.reasonCode) === JSON.stringify({ via: "disconnect", outcome: "not_cleared", bindingKept: false })
    && JSON.stringify(be.events.recent[0].reasonCode) === JSON.stringify({ code: "http-502" }) && be.events.recent.every((e: any) => !("reason" in e)) && !("reason" in be.connections[0].lastRemoval)
    && !coded.text.includes("background task") && !coded.text.includes("x.example") && !coded.text.includes("token endpoint"), `codes: ${JSON.stringify(be.connections[0].lastRemoval)} ${JSON.stringify(be.events.recent.slice(0, 2))}`);
  // A removal followed by a re-bind no longer speaks for the present: a later gap nothing recorded is not covered.
  w.db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k1', 'B', 'bind', 'u', 'system', 400, NULL, 'github')").run();
  const rebound = (await get(w, "?tenantId=t-a&limit=25")).body.agents.find((a: any) => a.raft_agent_id === "B").connections[0];
  must(rebound.state === "mount_only" && rebound.removalRecorded === false && rebound.lastRemoval.at === 300, `after a re-bind: ${JSON.stringify(rebound)}`);
  // And against the current binding's connected_at, whatever the state: A was bound at 5; a removal at 3 is older.
  w.db.raw.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at, reason, provider) VALUES ('t-a', 'k1', 'A', 'unbind', 'u', 'system', 3, NULL, 'github')").run();
  const aNow = (await get(w, "?tenantId=t-a&limit=25")).body.agents.find((a: any) => a.raft_agent_id === "A").connections[0];
  must(aNow.state === "both" && aNow.removalRecorded === false && aNow.lastRemoval.at === 3, `A: ${JSON.stringify(aNow)}`);
  w.db.raw.prepare("DELETE FROM connector_events WHERE raft_agent_id = 'A' AND action = 'create'").run();
  w.db.raw.prepare("UPDATE provisioned_connections SET connected_at = 2 WHERE raft_agent_id = 'A'").run();
  const aOld = (await get(w, "?tenantId=t-a&limit=25")).body.agents.find((a: any) => a.raft_agent_id === "A").connections[0];
  must(aOld.removalRecorded === true, `A with its binding older than the removal: ${JSON.stringify(aOld)}`);
  const rb = await get(w, "?tenantId=t-b&limit=25");
  const f = rb.body.agents.find((a: any) => a.raft_agent_id === "F").connections[0];
  must(f.state === "mount_only" && f.removalRecorded === false && f.lastRemoval === null, `F: ${JSON.stringify(f)}`);
  const a = ra.body.agents.find((x: any) => x.raft_agent_id === "A");
  must(a.connections[0].sameConnector === true && a.events.count === 1 && a.events.recent[0].action === "create", `A: ${JSON.stringify(a)}`);
});

await check("open egress residue is listed by the table's own columns and names, the deleted agent's included; resolved rows are not; an unlisted agent's residue comes on the last page", async () => {
  const w = world();
  const r = await get(w, "?tenantId=t-a&limit=25");
  const b = r.body.agents.find((a: any) => a.raft_agent_id === "B");
  must(b.residue.length === 1 && JSON.stringify(Object.keys(b.residue[0]).sort()) === JSON.stringify(["alias", "box_id", "first_seen", "last_seen", "reason_code", "reopened_count", "secret_id", "title"])
    && b.residue[0].secret_id === "p1" && b.residue[0].box_id === "box-b" && b.residue[0].title === "GH_TOKEN" && b.residue[0].reason_code === "project_residue", `B's residue: ${JSON.stringify(b.residue)}`);
  must(Array.isArray(r.body.residueOfUnlistedAgents) && r.body.residueOfUnlistedAgents.length === 0, `t-a's unlisted: ${JSON.stringify(r.body.residueOfUnlistedAgents)}`);
  const rb = await get(w, "?tenantId=t-b&limit=25");
  must(rb.body.residueOfUnlistedAgents?.length === 1 && rb.body.residueOfUnlistedAgents[0].agent_id === "raft_GONE" && rb.body.residueOfUnlistedAgents[0].secret_id === "p9", `t-b's unlisted: ${rb.text}`);
});

await check("bounded: at most limit objects asked per call, the rest by cursor, across tenants when none is named; limit over the maximum is refused", async () => {
  const w = world();
  const seen: string[] = [];
  let cursor: string | undefined;
  let calls = 0;
  do {
    const before = w.asked.length;
    const r = await get(w, `?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    must(r.status === 200 && w.asked.length - before <= 2 && r.body.agents.length <= 2, `page ${calls}: ${r.status} ${r.text}`);
    must(cursor === undefined || r.body.residueOfUnlistedAgents === undefined || r.body.cursor === undefined, "unlisted residue on a page that is not the last");
    seen.push(...r.body.agents.map((a: any) => `${a.tenant_id}/${a.raft_agent_id}`));
    cursor = r.body.cursor;
    calls += 1;
  } while (cursor && calls < 10);
  must(JSON.stringify(seen) === JSON.stringify(["t-a/A", "t-a/B", "t-a/C", "t-a/D", "t-a/E", "t-b/F"]) && calls === 3, `seen ${calls} pages: ${seen.join(", ")}`);
  for (const bad of ["?limit=26", "?limit=0", "?limit=x", "?cursor=nope", `?tenantId=t-b&cursor=${btoa(JSON.stringify(["t-a", "A"]))}`]) {
    const before = w.asked.length;
    const r = await get(w, bad);
    must(r.status === 400 && w.asked.length === before, `${bad}: ${r.status} ${r.text}`);
  }
});

await check("never a credential value or anything derived from one: a mount is its alias, plugin, key presence and connector, whatever else an object answers", async () => {
  const SECRET = "ghu_" + "s".repeat(36);
  const w = world({ "a/t-a/raft_A": [{ ...held("k1"), token: SECRET, fingerprint: "sha256:aaaaaaaaaaaaaaaa" } as ConnectionHolding] });
  w.db.raw.prepare("UPDATE provisioned_connections SET account = 'octo' WHERE raft_agent_id = 'A'").run();
  const from = logged.length;
  const r = await get(w, "?tenantId=t-a&limit=25");
  const a = r.body.agents.find((x: any) => x.raft_agent_id === "A").connections[0];
  must(JSON.stringify(a.mounts) === JSON.stringify([{ alias: "github", plugin: "github", key: "agent", connectorId: "k1" }]), `A's mount: ${JSON.stringify(a.mounts)}`);
  must(!r.text.includes("sha256:") && !r.text.includes(SECRET) && !r.text.includes(TOKEN) && !logged.slice(from).some((l) => l.includes(TOKEN)) && !JSON.stringify(w.rows()).includes(TOKEN), "a token in the answer, the log or the audit");
});

await check("every authenticated call is an admin_audit row, refusals included; a 401 is a log line only; a listing is written started before any object is asked", async () => {
  const w = world();
  let atFirstAsk: string[] | null = null;
  const get0 = w.env.AGENT.get;
  w.env.AGENT.get = (n: string) => { const o = get0(n); return { adminConnectionHoldings: async (...x: [string, string, string[]]) => { atFirstAsk ??= w.rows().map((r) => r.outcome); return o.adminConnectionHoldings(...x); } }; };
  const from = logged.length;
  must((await get(w, "?tenantId=t-a", { "x-harness-token": "wrong", "x-claimed-caller": "cody" })).status === 401, "a wrong token was let in");
  must(w.rows().length === 0 && logged.slice(from).some((l) => /"outcome":"unauthorized"/.test(l) && /"tenantId":null/.test(l)), "a 401 wrote a row, or logged nothing");
  must((await get(w, "?tenantId=t-a", { "x-harness-token": TOKEN })).status === 400, "no claimed caller was let in");
  must((await get(w, "?tenantId=t-a", { "x-harness-token": TOKEN, "x-claimed-caller": "cody" }, "POST")).status === 405, "a POST was let in");
  must((await get(w, `?tenantId=${"t".repeat(129)}`)).status === 400, "a long tenant id was let in");
  const ok = await get(w, "?tenantId=t-a&limit=25");
  must(ok.status === 200 && w.asked.length === 5, `${ok.status}, asked ${w.asked.length}`);
  const rows = w.rows();
  must(JSON.stringify(rows.map((r) => r.outcome)) === JSON.stringify(["no_claimed_caller", "wrong_method", "ids_too_long", "listed"]), `outcomes: ${JSON.stringify(rows.map((r) => r.outcome))}`);
  must(rows[2].tenant_id === null && rows[3].tenant_id === "t-a" && rows[3].claimed_caller === "cody" && rows.every((r) => r.route === "/admin/credential-inventory" && r.agent_id === null), `rows: ${JSON.stringify(rows)}`);
  must(JSON.parse(rows[3].counts).mount_only === 1 && typeof rows[3].finished_at === "number", `the listing's row: ${JSON.stringify(rows[3])}`);
  must(JSON.stringify(atFirstAsk) === JSON.stringify(["no_claimed_caller", "wrong_method", "ids_too_long", "started"]), `rows when the first object was asked: ${JSON.stringify(atFirstAsk)}`);
  // Reads only: nothing in D1 but the audit rows changed.
  const counts = ["provisioned_agents", "provisioned_connections", "connector_events", "egress_residue"].map((t) => (w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
  must(JSON.stringify(counts) === JSON.stringify([6, 3, 3, 3]), `rows per table: ${JSON.stringify(counts)}`);
});

const DB_FAILED = "the inventory's records could not be read or written, so nothing is answered";
await check("D1 failing: a fixed 503 and never D1's text; an audit row that cannot be written, or comes back with no id, and no object is asked; a 401 does not touch D1", async () => {
  const w = world();
  w.db.raw.exec("DROP TABLE admin_audit");
  const r = await get(w, "?tenantId=t-a");
  must(r.status === 503 && r.body?.error === DB_FAILED && !/no such table|admin_audit|SQLITE/i.test(r.text) && w.asked.length === 0, `no audit table: ${r.status} ${r.text}, asked ${w.asked.length}`);
  must((await get(w, "?tenantId=t-a", { "x-harness-token": "wrong" })).status === 401, "a 401 reached D1");
  // An insert that answers no row.
  const w2 = world();
  const real = w2.env.CONTROL_DB as any;
  w2.env.CONTROL_DB = { prepare: (q: string) => q.startsWith("INSERT INTO admin_audit") ? { bind: () => ({ first: async () => null }) } : real.prepare(q) } as any;
  const r2 = await get(w2, "?tenantId=t-a");
  must(r2.status === 503 && r2.body?.error === DB_FAILED && w2.asked.length === 0, `no id back: ${r2.status} ${r2.text}, asked ${w2.asked.length}`);
  // A read failing after the objects are asked, and the unlisted-residue read on the last page.
  for (const table of ["egress_residue", "connector_events"]) {
    const w3 = world();
    w3.db.raw.exec(`DROP TABLE ${table}`);
    const r3 = await get(w3, "?tenantId=t-a&limit=25");
    must(r3.status === 503 && r3.body?.error === DB_FAILED && !/no such table|SQLITE/i.test(r3.text), `no ${table}: ${r3.status} ${r3.text}`);
    must(w3.rows().at(-1)?.outcome === "failed", `the row after ${table} failed: ${JSON.stringify(w3.rows())}`);
  }
});

await check("objects are asked at most ASK_AT_ONCE at a time; one that hangs is listed failed after its timeout, logged by class only", async () => {
  const w = world();
  let inFlight = 0, most = 0;
  const get0 = w.env.AGENT.get;
  w.env.AGENT.get = (n: string) => ({ adminConnectionHoldings: async (...x: [string, string, string[]]) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    if (n === "a/t-a/raft_C") return new Promise(() => {});
    return get0(n).adminConnectionHoldings(...x);
  } }) as any;
  const from = logged.length, started = Date.now();
  const res = await adminCredentialInventory(new Request("https://x/admin/credential-inventory?limit=6", { headers: { "x-harness-token": TOKEN, "x-claimed-caller": "cody" } }),
    new URL("https://x/admin/credential-inventory?limit=6"), { token: TOKEN, db: w.env.CONTROL_DB as any, now: () => Date.now(), objectTimeoutMs: 60,
      holdings: (t, a, p) => (w.env.AGENT.get(`a/${t}/${a}`) as any).adminConnectionHoldings(t, a, p) });
  const body: any = await res.json();
  // The page waited for the hung object as long as its timeout, not the default ten seconds or forever.
  must(Date.now() - started < 3000, `the page took ${Date.now() - started} ms`);
  must(ASK_AT_ONCE === 5 && most === ASK_AT_ONCE, `at most ${most} at once`);
  const c = body.agents.find((a: any) => a.raft_agent_id === "C");
  must(c.object === "failed" && c.connections[0].state === "unknown", `the hung object: ${JSON.stringify(c)}`);
  const lines = logged.slice(from).filter((l) => /"outcome":"object_failed"/.test(l));
  must(lines.some((l) => /"agentId":"raft_C"/.test(l) && /"errorName":"timeout"/.test(l)) && lines.some((l) => /"agentId":"raft_E"/.test(l) && /"errorName":"Error"/.test(l))
    && !lines.some((l) => l.includes("the object is away")), `the failure lines: ${lines.join(" | ")}`);
});

/**
 * The object's own half, on a whole AgentDO under node: what it runs, what it schedules and what it keeps, recorded.
 * A look must not make the object the agent's, initialise it, set an alarm or write anything, whether the object holds
 * the agent (a deleted one, its storage kept) or not (no storage for it at all).
 */
function wholeObject(host = sqliteHost()) {
  const kv = new Map<string, unknown>();
  const writes: string[] = [];
  const statements: string[] = [];
  let alarmAt: number | null = null;
  const sql = { exec: (q: string, ...b: unknown[]) => { statements.push(q); const rows = host.sql.exec(q, ...b).toArray(); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
  const ctx = {
    storage: {
      sql, transactionSync: host.transactionSync,
      get: async (k: string) => kv.get(k), list: async () => new Map(kv),
      put: async (k: string, v: unknown) => { writes.push(`put ${k}`); kv.set(k, v); },
      delete: async (k: string) => { writes.push(`delete ${k}`); return kv.delete(k); },
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { writes.push("setAlarm"); alarmAt = at; }, deleteAlarm: async () => { writes.push("deleteAlarm"); alarmAt = null; },
      blockConcurrencyWhile: async (f: () => Promise<unknown>) => f(),
    },
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {}, waitUntil: () => {}, blockConcurrencyWhile: async (f: () => Promise<unknown>) => f(),
  };
  const D: any = new AgentDO(ctx as never, { SECRET_KEK: KEK_B64, ARTIFACT_BUCKET: "b", CONTROL_DB: d1() } as never);
  /** Rows only, by table: an empty table (schema the runtime may create, idempotently) is no row. */
  const rows = () => {
    const out: Record<string, unknown[]> = {};
    for (const t of host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray()) {
      const r = host.sql.exec(`SELECT * FROM "${t.name}"`).toArray();
      if (r.length) out[String(t.name)] = r;
    }
    return JSON.stringify(out);
  };
  const count = (table: string) => { try { return Number((host.sql.exec(`SELECT COUNT(*) AS n FROM "${table}"`).toArray()[0] as any).n); } catch { return 0; } };
  return { D, host, kv, writes, statements, rows, count, alarm: () => alarmAt };
}
const KEK_B64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
/** Every request the process makes while `fn` runs: a renewal is one. */
async function fetchesDuring<T>(fn: () => Promise<T>): Promise<{ value: T; fetched: string[] }> {
  const inner = globalThis.fetch, fetched: string[] = [];
  globalThis.fetch = (async (u: unknown) => { fetched.push(String(u)); return new Response("{}", { status: 500 }); }) as typeof fetch;
  try { return { value: await fn(), fetched }; } finally { globalThis.fetch = inner; }
}

// The object's constructor runs on any call to any object, this one included, and makes its tables (and pi's `main`
// session row) itself; the runtime's schema creation is idempotent. An empty schema is allowed; an owner row is not.
await check("the object's half, no agent in it: null, and afterwards no owner row, no secret, no alarm, and a second call is still null (empty schema allowed)", async () => {
  const o = wholeObject();
  try {
    const { value, fetched } = await fetchesDuring(() => o.D.adminConnectionHoldings("t-a", "raft_X", ["github"]));
    must(value === null, "an object with no agent answered");
    must(o.count("owner") === 0 && o.count("secrets") === 0 && o.alarm() === null && !o.writes.includes("setAlarm") && fetched.length === 0,
      `owner ${o.count("owner")}, secrets ${o.count("secrets")}, alarm ${o.alarm()}, writes ${JSON.stringify(o.writes)}, fetched ${fetched.length}`);
    must((await o.D.adminConnectionHoldings("t-a", "raft_X", ["github"])) === null && o.count("owner") === 0, "a second call");
    // Through the route, as for an agent with a registry row and no storage in its object.
    const w = world();
    w.env.AGENT = { idFromName: (n: string) => n, get: () => o.D } as any;
    const r = await get(w, "?tenantId=t-a&limit=1");
    must(r.body.agents[0].object === "no_agent" && r.body.agents[0].connections[0].state === "no_object", `the route: ${r.text}`);
    must(o.count("owner") === 0 && o.count("secrets") === 0 && o.alarm() === null, "the route's call left an owner, a secret or an alarm");
    // An owner table that cannot be read is not an agent either: null (no_object), never "nothing on the mount".
    o.host.sql.exec("DROP TABLE owner");
    must((await o.D.adminConnectionHoldings("t-a", "raft_X", ["github"])) === null, "an unreadable owner table");
  } finally { o.host.dispose(); }
});

await check("the object's half, a deleted agent's kept storage, by a cold object: key present with its connector, a dangling ref not held, no row changed, no alarm, no request", async () => {
  const host = sqliteHost();
  try {
    // The agent's storage as a provisioned agent left it: the object claimed, a github mount with a key and its
    // (expired) renewal record, and a second whose key is not stored.
    const first = wholeObject(host);
    first.D.ctx.storage.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self', 't-a', 'raft_B')");
    await first.D.runtime().ready();
    for (const alias of ["gh", "gh2"]) host.sql.exec("INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, plugin, tool_version, public_config, secret_ref) VALUES ('t-a', 'raft_B', ?, 'i', 'github', '1', '{}', ?)", alias, agentRef(alias));
    const kek = await importKek(KEK_B64);
    const put = async (name: string, value: string) => { const s = await seal(kek, value); host.sql.exec("INSERT INTO secrets(tenant_id, agent_id, name, ciphertext, iv, created_at, updated_at) VALUES ('t-a', 'raft_B', ?, ?, ?, 1, 1)", name, s.ciphertext, s.iv); };
    await put("gh", "ghu_" + "k".repeat(36));
    await put(OAUTH_PREFIX + "gh", JSON.stringify({ v: 1, refreshToken: "ghr_r", expiresAt: 1, refreshExpiresAt: Date.now() + 1e9, connectorId: "k1" }));
    // A cold object over it, as after the delete: nothing of the runtime built.
    const o = wholeObject(host);
    const before = o.rows();
    const { value: got, fetched } = await fetchesDuring(() => o.D.adminConnectionHoldings("t-a", "raft_B", ["github"]));
    must(JSON.stringify(got) === JSON.stringify([{ alias: "gh", plugin: "github", key: "agent", connectorId: "k1" }, { alias: "gh2", plugin: "github", key: "dangling", connectorId: null }]), `the answer: ${JSON.stringify(got)}`);
    must(o.rows() === before && o.alarm() === null && !o.writes.includes("setAlarm") && fetched.length === 0, `rows changed, an alarm, or a request: ${JSON.stringify(o.writes)} ${JSON.stringify(fetched)}`);
    // Another agent's name on this object: null, and still nothing changed.
    must((await o.D.adminConnectionHoldings("t-a", "raft_C", ["github"])) === null && o.rows() === before, "another agent's name");
    // A layout without what the read needs: named, not read as "no key", and nothing created to fill it.
    host.sql.exec("ALTER TABLE mounts DROP COLUMN secret_ref");
    must(JSON.stringify(await o.D.adminConnectionHoldings("t-a", "raft_B", ["github"])) === '{"layoutMissing":["mounts.secret_ref"]}', "a mounts table without secret_ref");
    host.sql.exec("DROP TABLE secrets");
    const old = await o.D.adminConnectionHoldings("t-a", "raft_B", ["github"]);
    must(JSON.stringify(old) === '{"layoutMissing":["mounts.secret_ref","secrets"]}' && o.count("secrets") === 0
      && host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'secrets'").toArray().length === 0, `no secrets table: ${JSON.stringify(old)}`);
  } finally { host.dispose(); }
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
