/**
 * A personal assistant's private notes of what its checks decided (src/store/assistant-decisions.ts): the table both
 * stores make, one row per wake with the last note kept, 30 days' retention pruned on write, the operator's read with
 * SELECTs only, and `GET /admin/assistant-decisions` (cf/src/admin-assistant-decisions.ts) behind the operator's token
 * and the read audit. The tool and the wake's trace row are in test/raft-assistant-mode.ts.
 *
 *   node test/assistant-decisions.ts
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  ASSISTANT_DECISIONS_RETENTION_MS, AssistantDecisionTables, readAssistantDecisions, type AssistantDecision,
} from "../src/store/assistant-decisions.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { adminAssistantDecisions, type AssistantDecisionsSource } from "../cf/src/admin-assistant-decisions.ts";
import { d1ReadAudit, type ReadAudit, type ReadAuditRow } from "../cf/src/read-audit.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const note = (checkId: string, notedAt: number, o: Partial<AssistantDecision> = {}): AssistantDecision => ({
  checkId, wokeAt: notedAt - 1_000, notedAt, sent: 1, reason: `why ${checkId}`,
  sources: [{ conversation: "c0ffee00-0000-4000-8000-000000000001", msg: "aaaaaaa1-1111-4222-8333-444455556666", ownerVisible: true }], ...o,
});

await check("the sqlite store makes the table at init: a note is kept with its fields, a second note of the same wake replaces it", async () => {
  const store = new SqliteStore();
  await store.init();
  const now = Date.now();
  store.assistantDecisions.put("t", "a", note("chk-1", now, { sent: 2, reason: "first" }));
  store.assistantDecisions.put("t", "a", note("chk-1", now + 5, { sent: 0, reason: "second", sources: [] }));
  store.assistantDecisions.put("t", "b", note("chk-1", now));
  const got = store.assistantDecisions.get("t", "a", "chk-1");
  must(got && got.sent === 0 && got.reason === "second" && got.sources.length === 0 && got.notedAt === now + 5 && got.wokeAt === now + 5 - 1_000, `last wins: ${show(got)}`);
  must(store.assistantDecisions.list("t", "a").length === 1, "one row per wake");
  must(store.assistantDecisions.get("t", "b", "chk-1")?.reason === "why chk-1", "another agent's row is its own");
  await store.close();
});

await check("retention: a write drops this agent's notes older than 30 days, keeps younger ones and other agents'", () => {
  const host = sqliteHost();
  let now = T0;
  const t = new AssistantDecisionTables(host, { now: () => now }).ensure();
  t.put("t", "a", note("old", T0));
  t.put("t", "a", note("young", T0 + 2 * DAY));
  t.put("t", "b", note("other", T0));
  now = T0 + ASSISTANT_DECISIONS_RETENTION_MS + 1;
  t.put("t", "a", note("new", now));
  const ids = t.list("t", "a").map((d) => d.checkId);
  must(show(ids) === show(["new", "young"]), `after 30 days: ${show(ids)}`);
  must(t.get("t", "b", "other") !== null, "another agent's row went with this agent's write");
  // The prune alone, as a check's end runs it.
  now = T0 + 2 * DAY + ASSISTANT_DECISIONS_RETENTION_MS + 1;
  t.prune("t", "a");
  must(show(t.list("t", "a").map((d) => d.checkId)) === show(["new"]), `pruned: ${show(t.list("t", "a"))}`);
  host.dispose();
});

await check("the operator's read: noted in [from, to), newest first; an object without the table reads none and makes none", () => {
  const host = sqliteHost();
  must(show(readAssistantDecisions(host.sql, "t", "a")) === "[]", "no table");
  must(host.sql.exec("SELECT name FROM sqlite_master WHERE name = 'assistant_decisions'").toArray().length === 0, "the read made the table");
  const t = new AssistantDecisionTables(host, { now: () => T0 + 3 * DAY }).ensure();
  for (const [id, d] of [["d0", 0], ["d1", 1], ["d2", 2]] as const) t.put("t", "a", note(id, T0 + d * DAY));
  const got = readAssistantDecisions(host.sql, "t", "a", { from: T0 + DAY, to: T0 + 3 * DAY });
  must(show(got.map((d) => d.checkId)) === show(["d2", "d1"]), show(got));
  host.dispose();
});

/** D1 as node:sqlite with every migration applied, as test/read-audit.ts makes it. */
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

const TOKEN = "operator-token";
const RECORDS = [note("chk-9", T0)];
function source() {
  const asked: Array<[string, string, number, number]> = [];
  const open = (_t: string, _a: string): AssistantDecisionsSource => ({
    adminAssistantDecisions: async (t, a, from, to) => { asked.push([t, a, from, to]); return a === "a" ? RECORDS : null; },
  });
  return { asked, open };
}
const get = (q: string, headers: Record<string, string> = {}) => new Request(`https://x/admin/assistant-decisions?${q}`, { headers });
const quiet = async <T>(fn: () => Promise<T>) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

await check("GET /admin/assistant-decisions: the operator's token or nothing, and never an object opened without it", async () => {
  for (const headers of [{}, { "x-harness-token": "wrong" }]) {
    const s = source();
    const res = await adminAssistantDecisions(get("tenantId=t&agentId=a&reason=x", headers), TOKEN, s.open, null);
    must(res.status === 401 && s.asked.length === 0, `${show(headers)}: ${res.status} ${show(s.asked)}`);
  }
  const unset = source();
  must((await adminAssistantDecisions(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": "" }), undefined, unset.open, null)).status === 401 && unset.asked.length === 0, "no token configured opened");
});

await check("GET /admin/assistant-decisions: always audited as an assistant's read: a reason is required, a row written, a failed write refuses", async () => {
  const { db, d1: database } = d1();
  const s = source();
  const none = await adminAssistantDecisions(get("tenantId=t&agentId=a", { "x-harness-token": TOKEN }), TOKEN, s.open, d1ReadAudit(database), T0);
  must(none.status === 400 && (await none.json()).code === "read_reason_required" && s.asked.length === 0, `no reason: ${none.status}`);
  const res = await adminAssistantDecisions(get("tenantId=t&agentId=a&from=2026-09-20T00:00:00Z&to=1790000000000", { "x-harness-token": TOKEN, "x-read-reason": "why no DM on 10-01" }), TOKEN, s.open, d1ReadAudit(database), T0);
  must(res.status === 200 && res.headers.get("cache-control") === "no-store", `read: ${res.status}`);
  const body = await res.json() as any;
  must(show(body.records) === show(RECORDS) && body.from === Date.parse("2026-09-20T00:00:00Z") && body.to === 1_790_000_000_000, `body: ${show(body)}`);
  must(show(s.asked) === show([["t", "a", Date.parse("2026-09-20T00:00:00Z"), 1_790_000_000_000]]), `asked: ${show(s.asked)}`);
  const rows = db.prepare("SELECT route, tenant_id, agent_id, session, token_kind, reason, assistant, outcome FROM admin_read_audit").all() as any[];
  must(rows.length === 1 && rows[0].route === "/admin/assistant-decisions" && rows[0].agent_id === "a" && rows[0].reason === "why no DM on 10-01" &&
    rows[0].assistant === 1 && rows[0].outcome === "read" && rows[0].session === null, `audit: ${show(rows)}`);
  const failing: ReadAudit = { record: async (_r: ReadAuditRow) => { throw new Error("D1 down"); } };
  const s2 = source();
  const refused = await quiet(() => adminAssistantDecisions(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s2.open, failing, T0));
  must(refused.status === 503 && s2.asked.length === 0, `audit down: ${refused.status} ${show(s2.asked)}`);
});

await check("GET /admin/assistant-decisions: the last 30 days by default, a bad range is a 400, an agent the object lacks a 404", async () => {
  const s = source();
  const res = await adminAssistantDecisions(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
  must(res.status === 200 && show(s.asked) === show([["t", "a", T0 - 30 * DAY, T0]]), `default: ${show(s.asked)}`);
  for (const q of ["from=yesterday", "from=20&to=10"]) {
    const r = await adminAssistantDecisions(get(`tenantId=t&agentId=a&reason=x&${q}`, { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
    must(r.status === 400, `${q}: ${r.status}`);
  }
  const missing = await adminAssistantDecisions(get("tenantId=t&agentId=nobody&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
  must(missing.status === 404, `missing: ${missing.status}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      \x1b[31m${r.error}\x1b[0m`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
