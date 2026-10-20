/**
 * Who read an agent's conversation, and why (cf/src/read-audit.ts): the row as D1 keeps it under the repository's
 * migrations, the reason as a caller gives it, the gate in front of a read — a personal assistant's needs a reason and a
 * written row, another agent's goes ahead when the row cannot be written — and `/admin/transcript` behind that gate.
 * The provisioning exports' half is in test/eval-seed.ts.
 *
 *   node test/read-audit.ts
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { auditRead, d1ReadAudit, readReason, READ_REASON_MAX, type ReadAudit, type ReadAuditRow } from "../cf/src/read-audit.ts";
import { adminTranscript, type TranscriptSource } from "../cf/src/admin-transcript.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

/** D1 as node:sqlite with every migration applied, in order, as the other D1 suites make it. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { db, d1: { prepare: (q: string) => stmt(q) } };
}

const ROW = { route: "/admin/transcript", tenantId: "t", agentId: "a", session: "t_a", tokenKind: "operator", tokenLabel: null, reason: "a user report", assistant: true };
const quiet = async <T>(fn: () => Promise<T>) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

await check("migration 0026 makes admin_read_audit, and a row is kept as given, metadata only", async () => {
  const { db, d1: database } = d1();
  await d1ReadAudit(database).record({ ...ROW, outcome: "read" }, 1_800_000_000_000);
  const rows = db.prepare("SELECT * FROM admin_read_audit").all() as any[];
  must(rows.length === 1, show(rows));
  const r = rows[0];
  must(r.at === 1_800_000_000_000 && r.route === "/admin/transcript" && r.tenant_id === "t" && r.agent_id === "a" && r.session === "t_a" &&
    r.token_kind === "operator" && r.token_label === null && r.reason === "a user report" && r.assistant === 1 && r.outcome === "read", show(r));
  const columns = (db.prepare("PRAGMA table_info(admin_read_audit)").all() as any[]).map((c) => c.name);
  must(show(columns) === show(["id", "at", "route", "tenant_id", "agent_id", "session", "token_kind", "token_label", "reason", "assistant", "outcome"]), show(columns));
});

await check("the reason: reason= first, then X-Read-Reason; trimmed, control characters out, cut; empty is none", () => {
  const r = (url: string, headers: Record<string, string> = {}) => readReason(new Request(`https://x${url}`, { headers }));
  must(r("/p?reason=%20bug%20123%20") === "bug 123", "query");
  must(r("/p", { "x-read-reason": "from the header" }) === "from the header", "header");
  must(r("/p?reason=q", { "x-read-reason": "h" }) === "q", "the query wins");
  must(r("/p?reason=a%0Ab") === "a b", "control characters");
  must(r("/p?reason=%20%20") === null && r("/p") === null, "empty");
  must(r(`/p?reason=${"x".repeat(READ_REASON_MAX + 50)}`)!.length === READ_REASON_MAX, "cut");
});

await check("an assistant's read: no reason is 400 with no row; a row that cannot be written refuses it (503); written, it goes ahead", async () => {
  const rows: ReadAuditRow[] = [];
  const ok: ReadAudit = { async record(row) { rows.push(row); } };
  const down: ReadAudit = { async record() { throw new Error("D1 down"); } };
  const none = await auditRead(ok, { ...ROW, reason: null });
  must(none?.status === 400 && ((await none.json()) as any).code === "read_reason_required" && rows.length === 0, "no reason");
  const failed = await quiet(() => auditRead(down, ROW));
  must(failed?.status === 503 && ((await failed.json()) as any).code === "read_audit_failed", "audit down");
  const unconfigured = await quiet(() => auditRead(null, ROW));
  must(unconfigured?.status === 503, "no audit store");
  must(await auditRead(ok, ROW) === null && rows.length === 1 && rows[0]!.outcome === "read", show(rows));
});

await check("another agent's read: no reason is fine and recorded as null; a row that cannot be written does not refuse it", async () => {
  const rows: ReadAuditRow[] = [];
  must(await auditRead({ async record(row) { rows.push(row); } }, { ...ROW, assistant: false, reason: null }) === null && rows[0]!.reason === null, show(rows));
  must(await quiet(() => auditRead({ async record() { throw new Error("D1 down"); } }, { ...ROW, assistant: false })) === null, "refused");
});

await check("/admin/transcript: an assistant's needs a reason (400, the object not read) and is recorded with it; another's is recorded as read", async () => {
  const TOKEN = "operator-token-for-tests";
  const asked: string[] = [];
  const source = (assistant: boolean): TranscriptSource => ({
    async adminTranscript(t, a, k) { asked.push(`${t}/${a} ${k}`); return { total: 0, shown: 0, events: [] }; },
    async isAssistantAgent() { return assistant; },
  });
  const { db, d1: database } = d1();
  const audit = d1ReadAudit(database);
  const req = (q: string, headers: Record<string, string> = {}) =>
    new Request(`https://antiproton.ai/admin/transcript${q}`, { headers: { "x-harness-token": TOKEN, ...headers } });
  const refused = await adminTranscript(req("?tenantId=t&agentId=a"), TOKEN, () => source(true), audit);
  must(refused.status === 400 && refused.headers.get("cache-control") === "no-store" && asked.length === 0, `refused: ${refused.status}`);
  const read = await adminTranscript(req("?tenantId=t&agentId=a", { "x-read-reason": "owner asked" }), TOKEN, () => source(true), audit);
  must(read.status === 200 && asked.length === 1, `with a reason: ${read.status}`);
  const other = await adminTranscript(req("?tenantId=t&agentId=b"), TOKEN, () => source(false), audit);
  must(other.status === 200 && asked.length === 2, `another agent: ${other.status}`);
  const rows = db.prepare("SELECT agent_id, token_kind, reason, assistant, outcome FROM admin_read_audit ORDER BY id").all() as any[];
  must(show(rows) === show([
    { agent_id: "a", token_kind: "operator", reason: "owner asked", assistant: 1, outcome: "read" },
    { agent_id: "b", token_kind: "operator", reason: null, assistant: 0, outcome: "read" },
  ]), show(rows));
});

// ---- through the Worker: the /agent/* reads and the console's /ui/transcript ------------------------------------------

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");
const { sessionCookieFor } = await import("../cf/src/auth.ts");
const { setLogSink } = await import("../src/core/log.ts");
setLogSink(() => {});

const OPERATOR = "operator-token-audit";
const SESSION = "s".repeat(32);

/** The Worker's env: an object that is (or is not) an assistant's and records what it is asked, and a D1 that records inserts. */
function world(assistant: boolean, auditDown = false) {
  const asked: string[] = [], inserted: unknown[][] = [];
  const object = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "isAssistantAgent") return async () => assistant;
      if (prop === "uiVersion") return async () => "v1";
      if (prop === "uiTranscript") return async () => { asked.push("uiTranscript"); return { total: 0, shown: 0, events: [], byOp: {}, busy: null }; };
      return async () => { asked.push(String(prop)); return { ok: true }; };
    },
  });
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => null, all: async () => ({ results: [] }),
    run: async () => {
      if (q.startsWith("INSERT INTO admin_read_audit")) { if (auditDown) throw new Error("D1 down"); inserted.push(b); }
      return { meta: { changes: 1 } };
    },
  });
  const env = {
    AGENT: { idFromName: (n: string) => n, get: () => object },
    CONTROL_DB: { prepare: (q: string) => stmt(q), batch: async () => [] },
    ARTIFACTS: {}, SESSION_SECRET: SESSION, AUTOMATION_TOKEN: OPERATOR,
  };
  return { env, asked, inserted };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

await check("GET /agent/state with the automation token: an assistant's needs a reason and is audited first; another's is audited as read", async () => {
  const a = world(true);
  const bare = await worker.fetch(new Request("https://x/agent/state?tenantId=t&agentId=a&taskId=k", { headers: { "x-harness-token": OPERATOR } }), a.env as never, ctx);
  must(bare.status === 400 && !a.asked.includes("taskState") && a.inserted.length === 0, `no reason: ${bare.status} ${show(a.asked)}`);
  const said = await worker.fetch(new Request("https://x/agent/state?tenantId=t&agentId=a&taskId=k&reason=incident%2017", { headers: { "x-harness-token": OPERATOR } }), a.env as never, ctx);
  must(said.status === 200 && a.asked.includes("taskState"), `with a reason: ${said.status} ${show(a.asked)}`);
  must(show(a.inserted[0]!.slice(1)) === show(["/agent/state", "t", "a", "k", "automation", null, "incident 17", 1, "read"]), show(a.inserted));
  const down = world(true, true);
  const refused = await quiet(async () => worker.fetch(new Request("https://x/agent/state?tenantId=t&agentId=a&reason=r", { headers: { "x-harness-token": OPERATOR } }), down.env as never, ctx));
  must(refused.status === 503 && !down.asked.includes("taskState"), `audit down: ${refused.status}`);
  const other = world(false);
  const plain = await worker.fetch(new Request("https://x/agent/activity?tenantId=t&agentId=b", { headers: { "x-harness-token": OPERATOR } }), other.env as never, ctx);
  must(plain.status === 200 && show(other.inserted[0]!.slice(1, 3)) === show(["/agent/activity", "t"]) && other.inserted[0]![7] === null, `another agent: ${plain.status} ${show(other.inserted)}`);
});

await check("GET /ui/transcript in the console: an assistant's needs a reason; given one, the read is audited with the viewer", async () => {
  const cookie = (await sessionCookieFor(SESSION,
    { email: "owner@x.test", name: null, username: null, picture: null, source: "github", agentId: "u-a", tenantId: "demo" }, "gh-u-a")).split(";")[0]!;
  const a = world(true);
  const bare = await worker.fetch(new Request("https://x/ui/transcript", { headers: { cookie } }), a.env as never, ctx);
  must(bare.status === 400 && !a.asked.includes("uiTranscript"), `no reason: ${bare.status} ${show(a.asked)}`);
  const said = await worker.fetch(new Request("https://x/ui/transcript", { headers: { cookie, "x-read-reason": "checking a reply" } }), a.env as never, ctx);
  must(said.status === 200 && a.asked.includes("uiTranscript"), `with a reason: ${said.status}`);
  must(a.inserted.length === 1 && a.inserted[0]![1] === "/ui/transcript" && a.inserted[0]![5] === "console" && a.inserted[0]![7] === "checking a reply", show(a.inserted));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      \x1b[31m${r.error}\x1b[0m`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
