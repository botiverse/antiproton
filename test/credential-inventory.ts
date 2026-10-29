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
const { default: worker } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const logged: string[] = [];
setLogSink((line) => logged.push(line));

const TOKEN = "operator-token-" + "o".repeat(24);
const held = (connectorId: string | null, fp = "sha256:0123456789abcdef"): ConnectionHolding =>
  ({ alias: "github", plugin: "github", key: "agent", connectorId, fingerprint: fp });

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
    "a/t-a/raft_A": [held("k1")], "a/t-a/raft_B": [held("k1", "sha256:fedcba9876543210")], "a/t-a/raft_C": [{ alias: "github", plugin: "github", key: "none", connectorId: null, fingerprint: null }],
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
  must(JSON.stringify(r.body.counts) === JSON.stringify({ agents: 5, both: 1, mount_only: 1, binding_only: 1, neither: 1, unknown: 1, residue: 1 }), `counts: ${JSON.stringify(r.body.counts)}`);
  // Only the tenant asked for; no other tenant's object asked.
  must(!r.body.agents.some((a: any) => a.tenant_id !== "t-a") && !w.asked.some((n) => n.startsWith("a/t-b/")), `asked: ${w.asked.join(", ")}`);
});

await check("the mount comes from the object, not from D1: a binding with a key the object no longer has is binding_only, a key with no binding is mount_only", async () => {
  const w = world({ "a/t-a/raft_A": [], "a/t-a/raft_C": [held("k1")] });
  const r = await get(w, "?tenantId=t-a&limit=25");
  must(stateOf(r.body, "A") === "binding_only" && stateOf(r.body, "C") === "both", `A ${stateOf(r.body, "A")}, C ${stateOf(r.body, "C")}`);
  // An object that holds no such agent (its storage wiped) holds nothing.
  const w2 = world({ "a/t-a/raft_A": null });
  const r2 = await get(w2, "?tenantId=t-a&limit=25");
  const a = r2.body.agents.find((x: any) => x.raft_agent_id === "A");
  must(a.object === "no_agent" && a.connections[0].state === "binding_only", `a wiped object: ${JSON.stringify(a)}`);
});

await check("the event table is audited: a mount-only key says whether a removal was recorded, and which", async () => {
  const w = world();
  const ra = await get(w, "?tenantId=t-a&limit=25");
  const b = ra.body.agents.find((a: any) => a.raft_agent_id === "B").connections[0];
  must(b.removalRecorded === true && b.lastRemoval?.action === "deleted_agent_unbound" && b.lastRemoval.at === 9, `B: ${JSON.stringify(b)}`);
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

await check("never a credential value: only presence and the fingerprint the object gave", async () => {
  const SECRET = "ghu_" + "s".repeat(36);
  const w = world({ "a/t-a/raft_A": [{ ...held("k1"), fingerprint: "sha256:aaaaaaaaaaaaaaaa" }] });
  w.db.raw.prepare("UPDATE provisioned_connections SET account = 'octo' WHERE raft_agent_id = 'A'").run();
  const from = logged.length;
  const r = await get(w, "?tenantId=t-a&limit=25");
  const a = r.body.agents.find((x: any) => x.raft_agent_id === "A").connections[0];
  must(a.mounts[0].fingerprint === "sha256:aaaaaaaaaaaaaaaa" && a.mounts[0].key === "agent", `A's mount: ${JSON.stringify(a.mounts)}`);
  must(!r.text.includes(SECRET) && !r.text.includes(TOKEN) && !logged.slice(from).some((l) => l.includes(TOKEN)) && !JSON.stringify(w.rows()).includes(TOKEN), "a token in the answer, the log or the audit");
});

await check("every call is an admin_audit row, refusals included: a 401 names no tenant, a listing is written started before any object is asked", async () => {
  const w = world();
  let atFirstAsk: string[] | null = null;
  const get0 = w.env.AGENT.get;
  w.env.AGENT.get = (n: string) => { const o = get0(n); return { adminConnectionHoldings: async (...x: [string, string, string[]]) => { atFirstAsk ??= w.rows().map((r) => r.outcome); return o.adminConnectionHoldings(...x); } }; };
  must((await get(w, "?tenantId=t-a", { "x-harness-token": "wrong", "x-claimed-caller": "cody" })).status === 401, "a wrong token was let in");
  must((await get(w, "?tenantId=t-a", { "x-harness-token": TOKEN })).status === 400, "no claimed caller was let in");
  must((await get(w, "?tenantId=t-a", { "x-harness-token": TOKEN, "x-claimed-caller": "cody" }, "POST")).status === 405, "a POST was let in");
  must((await get(w, `?tenantId=${"t".repeat(129)}`)).status === 400, "a long tenant id was let in");
  const ok = await get(w, "?tenantId=t-a&limit=25");
  must(ok.status === 200 && w.asked.length === 5, `${ok.status}, asked ${w.asked.length}`);
  const rows = w.rows();
  must(JSON.stringify(rows.map((r) => r.outcome)) === JSON.stringify(["unauthorized", "no_claimed_caller", "wrong_method", "ids_too_long", "listed"]), `outcomes: ${JSON.stringify(rows.map((r) => r.outcome))}`);
  must(rows[0].tenant_id === null && rows[3].tenant_id === null && rows[4].tenant_id === "t-a" && rows[4].claimed_caller === "cody" && rows.every((r) => r.route === "/admin/credential-inventory" && r.agent_id === null), `rows: ${JSON.stringify(rows)}`);
  must(JSON.parse(rows[4].counts).mount_only === 1 && typeof rows[4].finished_at === "number", `the listing's row: ${JSON.stringify(rows[4])}`);
  must(JSON.stringify(atFirstAsk) === JSON.stringify(["unauthorized", "no_claimed_caller", "wrong_method", "ids_too_long", "started"]), `rows when the first object was asked: ${JSON.stringify(atFirstAsk)}`);
  // Reads only: nothing in D1 but the audit rows changed.
  const counts = ["provisioned_agents", "provisioned_connections", "connector_events", "egress_residue"].map((t) => (w.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n);
  must(JSON.stringify(counts) === JSON.stringify([6, 3, 3, 3]), `rows per table: ${JSON.stringify(counts)}`);
});

await check("an audit row that cannot be written: nothing is read and no object is asked", async () => {
  const w = world();
  w.db.raw.exec("DROP TABLE admin_audit");
  let threw = false;
  let r: Awaited<ReturnType<typeof get>> | null = null;
  try { r = await get(w, "?tenantId=t-a"); } catch { threw = true; }
  must(w.asked.length === 0 && (threw || (r !== null && r.status >= 500)), `asked ${w.asked.length}, ${r?.status} ${r?.text}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
