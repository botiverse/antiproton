/**
 * `POST /admin/withdraw-egress`, the verification hook for observing an agent's egress withdrawal against a real
 * run9 box (#1130): it exists only where EGRESS_VERIFY_ROUTE is "1" (cf/wrangler.preview.jsonc; never production),
 * and is otherwise the same 404 as any unknown path. With it: the operator's token, a self-declared caller, and an
 * agent this deployment provisioned, read from its own D1 before any object is opened. Every call leaves an audit
 * line naming the caller, never the token. Run through the Worker's own `fetch`, with a stand-in for the agents'
 * objects that records what reached them.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { setLogSink } from "../src/core/log.ts";

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

/** D1 as node:sqlite with every migration, and one provisioned agent. `raw` is the database, for reading rows back. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  db.prepare("INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, status, created_at, updated_at) VALUES ('t-p', 'A1', 'raft_A1', 's', 'https://raft.example', 'n', '', 'active', 1, 1)").run();
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { prepare: (q: string) => stmt(q), raw: db } as unknown as D1Database & { raw: DatabaseSync };
}

/** The deployment: its D1, and agents' objects that record each call that reached one. */
function env(flag: string | undefined, opts: { throws?: string } = {}) {
  const reached: string[] = [];
  const db = d1();
  /** The audit rows as the object is called: the row must already say the call started. */
  const atCall: string[] = [];
  const objects = {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      withdrawEgress: async (t: string, a: string) => {
        reached.push(`${n} ${t}/${a}`);
        atCall.push(...(db.raw.prepare("SELECT outcome FROM admin_audit").all() as any[]).map((r) => r.outcome));
        if (opts.throws) throw new Error(opts.throws);
        return { things: [{ alias: "sandbox", id: "box1", clean: true, ownKey: true }], failed: [] };
      },
    }),
  };
  const rows = () => db.raw.prepare("SELECT * FROM admin_audit ORDER BY id").all() as any[];
  return { reached, atCall, rows, env: { CONTROL_DB: db, AGENT: objects, AUTOMATION_TOKEN: TOKEN, ...(flag === undefined ? {} : { EGRESS_VERIFY_ROUTE: flag }) } };
}

async function send(e: ReturnType<typeof env>, path: string, headers: Record<string, string> = { "x-harness-token": TOKEN, "x-claimed-caller": "cody" }, method = "POST") {
  const res = await worker.fetch(new Request(`https://x${path}`, { method, headers }), e.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: res.status, text: await res.text() };
}

await check("without EGRESS_VERIFY_ROUTE the route is not there: the same 404 as any unknown path, and no object is reached", async () => {
  for (const flag of [undefined, "", "0", "true"]) {
    const e = env(flag);
    const r = await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1");
    const unknown = await send(e, "/admin/no-such-route-at-all?tenantId=t-p&agentId=raft_A1");
    must(r.status === 404 && r.text === unknown.text && unknown.status === 404, `flag ${JSON.stringify(flag)}: ${r.status} ${r.text} vs ${unknown.status} ${unknown.text}`);
    must(e.reached.length === 0 && e.rows().length === 0, `flag ${JSON.stringify(flag)}: an object was reached, or an audit row written`);
  }
});

await check("with EGRESS_VERIFY_ROUTE=1: the token and a claimed caller are required, an unknown id is 404; every refused attempt is a stored audit row, and no object is opened", async () => {
  const e = env("1");
  must((await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1", { "x-claimed-caller": "cody" })).status === 401, "no token");
  must((await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1", { "x-harness-token": TOKEN, "x-claimed-caller": "cody" }, "GET")).status === 405, "GET");
  must((await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1", { "x-harness-token": TOKEN })).status === 400, "no claimed caller");
  must((await send(e, "/admin/withdraw-egress?tenantId=t-p", { "x-harness-token": TOKEN, "x-claimed-caller": "cody" })).status === 400, "no agent");
  const nobody = await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_NOBODY");
  must(nobody.status === 404 && e.reached.length === 0, `an unknown agent: ${nobody.status} ${nobody.text}, reached ${e.reached.join(", ")}`);
  const outcomes = e.rows().map((r) => r.outcome);
  must(JSON.stringify(outcomes) === JSON.stringify(["unauthorized", "wrong_method", "no_claimed_caller", "no_agent_named", "no_such_agent"]), `the audit rows: ${JSON.stringify(e.rows())}`);
  must(e.rows().every((r) => r.route === "/admin/withdraw-egress" && typeof r.at === "number") && !JSON.stringify(e.rows()).includes(TOKEN), "a row is malformed, or holds the token");
});

await check("with EGRESS_VERIFY_ROUTE=1: the audit row says started before the object is called; an object that throws leaves object_threw, and nothing it said is stored", async () => {
  const leak = "ghu_LEAKFROMTHROW00000000000000000000000";
  const e = env("1", { throws: `boom ${leak}` });
  const r = await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1");
  must(r.status === 503 && !r.text.includes(leak), `${r.status} ${r.text}`);
  must(JSON.stringify(e.atCall) === JSON.stringify(["started"]), `the rows as the object was called: ${JSON.stringify(e.atCall)}`);
  const rows = e.rows();
  must(rows.length === 1 && rows[0].outcome === "object_threw" && rows[0].claimed_caller === "cody" && typeof rows[0].finished_at === "number"
    && !JSON.stringify(rows).includes(leak), `the row: ${JSON.stringify(rows)}`);
});

await check("with EGRESS_VERIFY_ROUTE=1: a provisioned agent's withdrawal runs, and the call is audited with the claimed caller, never the token", async () => {
  const e = env("1");
  const from = logged.length;
  const r = await send(e, "/admin/withdraw-egress?tenantId=t-p&agentId=raft_A1");
  must(r.status === 200 && JSON.parse(r.text).things?.[0]?.id === "box1" && e.reached.length === 1, `${r.status} ${r.text}`);
  const rows = e.rows();
  must(rows.length === 1 && rows[0].outcome === "withdrawn" && rows[0].claimed_caller === "cody" && rows[0].agent_id === "raft_A1"
    && JSON.parse(rows[0].counts).things === 1 && !JSON.stringify(rows).includes(TOKEN), `the stored row: ${JSON.stringify(rows)}`);
  const audit = logged.slice(from).filter((l) => /"evt":"admin.withdraw_egress"/.test(l));
  must(audit.length === 2 && /"outcome":"started"/.test(audit[0]!) && /"outcome":"withdrawn"/.test(audit[1]!) && /"claimedCaller":"cody"/.test(audit[0]!) && /"agentId":"raft_A1"/.test(audit[0]!) && /"at":"/.test(audit[0]!)
    && !audit.some((l) => l.includes(TOKEN)), `the audit: ${audit.join(" | ")}`);
});

await check("production's config never sets EGRESS_VERIFY_ROUTE; preview's sets it", async () => {
  const prod = readFileSync(new URL("../cf/wrangler.jsonc", import.meta.url), "utf8");
  const preview = readFileSync(new URL("../cf/wrangler.preview.jsonc", import.meta.url), "utf8");
  must(!prod.includes("EGRESS_VERIFY_ROUTE") && /"EGRESS_VERIFY_ROUTE":\s*"1"/.test(preview), "the flag is in production's config, or missing from preview's");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
