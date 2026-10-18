/**
 * The daily friction scan (cf/src/friction-scan.ts), its object-side read (cf/src/friction-read.ts) and the trace
 * flush's day index (cf/src/trace-r2.ts `noteTraceDays`).
 *
 * The properties held here are boundaries more than features: whose conversations may be read (the tenant list, the
 * bench never), what may reach the private report (no user message, no credential), what may reach a public issue
 * (no excerpt, no raw id), that issues are off unless both switches are set, and that the step cannot break the
 * cron it rides in.
 */
import { register } from "node:module";
import {
  activeAgents, dailyCron, fileIssues, frictionDaily, inScope, issueBody, issueTrackerFrom, renderMarkdown, scanDay,
  tenantScope, writeReport, SCAN_DEFAULTS, type FrictionBucket, type IssueTracker, type WindowReader,
} from "../cf/src/friction-scan.ts";
import { readFrictionWindow, FRICTION_LIMITS, type FrictionWindow } from "../cf/src/friction-read.ts";
import { noteTraceDays, traceIndexKey } from "../cf/src/trace-r2.ts";
import { agentHash } from "../cf/src/friction.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { attachmentEpisode, ghEpisode, SECRET_TOKEN, USER_SECRET } from "./spec/friction-fixtures.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** An R2 bucket in memory: list with prefix, delimiter, limit and cursor; every call recorded. */
function bucket(keys: string[] = []) {
  const store = new Map<string, string>(keys.map((k) => [k, ""]));
  const calls: string[] = [];
  const b: FrictionBucket & { store: Map<string, string>; calls: string[]; failList?: boolean } = {
    store, calls,
    async list(o) {
      calls.push(`list ${o.prefix}${o.delimiter ? " /" : ""}`);
      if (b.failList) throw new Error("r2 list unavailable");
      const all = [...store.keys()].filter((k) => k.startsWith(o.prefix)).sort();
      const objects: string[] = []; const prefixes = new Set<string>();
      for (const k of all) {
        const rest = k.slice(o.prefix.length);
        const i = o.delimiter ? rest.indexOf(o.delimiter) : -1;
        if (i >= 0) prefixes.add(o.prefix + rest.slice(0, i + 1)); else objects.push(k);
      }
      const start = o.cursor ? Number(o.cursor) : 0, limit = o.limit ?? 1000;
      const page = objects.slice(start, start + limit);
      const truncated = start + limit < objects.length;
      return { objects: page.map((key) => ({ key })), delimitedPrefixes: [...prefixes], truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
    },
    async get(key) { calls.push(`get ${key}`); return store.has(key) ? { text: async () => store.get(key)! } : null; },
    async put(key, body) { calls.push(`put ${key}`); store.set(key, body); },
    async delete(keys) { for (const k of [keys].flat()) { calls.push(`delete ${k}`); store.delete(k); } },
  };
  return b;
}

const DAY = "2026-10-18";
const HOSTED = "raft_bccd5969-5c94-498c-9221-625f87d5ca12", AGENT = "raft_379d8c2b-a014-49bd-893b-70acaf32461c";
const OTHER = "raft_f94d930c-0000-4000-8000-000000000001", OTHER_AGENT = "raft_d0cedb21-5803-47f8-9792-59667221f97c";

/** Objects that answer every agent with the calibration episodes, recording who was read. */
function objects() {
  const read: string[] = [];
  const window: WindowReader = async (t, a) => {
    read.push(`${t}/${a}`);
    return { conversations: [{ id: "main.1", events: attachmentEpisode(), truncated: false }, { id: "sub_8a4f448c39e2623b", events: ghEpisode(Date.parse("2026-10-18T10:00:00Z")), truncated: false }], truncated: false } satisfies FrictionWindow;
  };
  return { read, window };
}
const indexed = (...pairs: Array<[string, string]>) => pairs.map(([t, a]) => traceIndexKey(DAY, t, a));

// ---------- whose conversations ----------

await check("an empty or missing tenant list scans nothing: no listing, no object read, no report", async () => {
  for (const v of [undefined, "", " , ", "not a valid id!"]) {
    const b = bucket(indexed([HOSTED, AGENT])); const o = objects();
    const out = await frictionDaily({ FRICTION_SCAN_TENANTS: v }, { bucket: b, window: o.window, tracker: null }, Date.parse("2026-10-19T03:17:00Z"));
    must(out === "no tenants in scope", `${JSON.stringify(v)}: ${out}`);
    must(o.read.length === 0 && b.calls.length === 0, `${JSON.stringify(v)}: read ${o.read} calls ${b.calls}`);
  }
});

await check("a tenant not on the list is never read, even when the index names it", async () => {
  const b = bucket(indexed([HOSTED, AGENT], [OTHER, OTHER_AGENT])); const o = objects();
  const r = await scanDay({ bucket: b, window: o.window }, tenantScope(HOSTED), DAY);
  must(o.read.length === 1 && o.read[0] === `${HOSTED}/${AGENT}`, `read ${o.read}`);
  must(!JSON.stringify(r).includes(OTHER), "the other tenant appears in the report");
  // The per-agent check holds on its own too, not only the listing's prefix.
  must(inScope(tenantScope(HOSTED), HOSTED, AGENT) && !inScope(tenantScope(HOSTED), OTHER, OTHER_AGENT), "the list does not decide inScope");
  // And when the index is missing, the fallback lists the listed tenant's prefix only.
  const f = bucket([`trace/${HOSTED}/${AGENT}/1-2.ndjson`, `trace/${OTHER}/${OTHER_AGENT}/1-2.ndjson`]); const o2 = objects();
  await scanDay({ bucket: f, window: o2.window }, tenantScope(HOSTED), DAY);
  must(o2.read.length === 1 && o2.read[0] === `${HOSTED}/${AGENT}`, `fallback read ${o2.read}`);
  must(!f.calls.some((c) => c.includes(OTHER)), `the fallback listed the other tenant: ${f.calls}`);
});

await check("`*` scans every hosted raft_ tenant and never bench, nor a tenant that is not hosted", async () => {
  const keys = indexed([HOSTED, AGENT], [OTHER, OTHER_AGENT], ["bench", "tau2-1"], ["t-github_5317095", "u-a"], [HOSTED, "bench-agent-1"]);
  const b = bucket(keys); const o = objects();
  await scanDay({ bucket: b, window: o.window }, tenantScope("*"), DAY);
  must(o.read.sort().join() === [`${HOSTED}/${AGENT}`, `${OTHER}/${OTHER_AGENT}`].sort().join(), `read ${o.read}`);
  // A list that names bench explicitly still never reads it.
  const o2 = objects();
  await scanDay({ bucket: bucket(keys), window: o2.window }, tenantScope("bench,*"), DAY);
  must(!o2.read.some((x) => x.startsWith("bench")), `bench read: ${o2.read}`);
  must(!inScope(tenantScope("bench"), "bench", "x") && tenantScope("bench").kind === "list", "bench on the list is in scope");
  // The fallback under `*` lists trace/raft_ tenants only.
  const f = bucket([`trace/${HOSTED}/${AGENT}/1-2.ndjson`, `trace/bench/tau2-1/1-2.ndjson`, `trace/demo/u-a/1-2.ndjson`]); const o3 = objects();
  const r = await scanDay({ bucket: f, window: o3.window }, tenantScope("*"), DAY);
  must(r.source === "listing" && o3.read.join() === `${HOSTED}/${AGENT}`, `fallback ${r.source} read ${o3.read}`);
  must(!f.calls.some((c) => c === "list trace/ /" || c.includes("trace/bench") || c.includes("trace/demo")), `fallback listed beyond raft_: ${f.calls}`);
});

await check("the work is bounded: at most maxAgents objects, and none after the budget", async () => {
  const many = Array.from({ length: 30 }, (_, i) => [HOSTED, `raft_agent-${String(i).padStart(2, "0")}`] as [string, string]);
  const o = objects();
  const r = await scanDay({ bucket: bucket(indexed(...many)), window: o.window }, tenantScope("*"), DAY, { ...SCAN_DEFAULTS, maxAgents: 5 });
  must(o.read.length === 5 && r.coverage.truncated.agents, `read ${o.read.length}, truncated ${r.coverage.truncated.agents}`);
  let t = 0; const o2 = objects();
  const r2 = await scanDay({ bucket: bucket(indexed(...many)), window: o2.window, now: () => (t += 1000) }, tenantScope("*"), DAY, { ...SCAN_DEFAULTS, budgetMs: 3500, concurrency: 1 });
  must(o2.read.length < 30 && r2.coverage.truncated.budget, `read ${o2.read.length} with a 3.5 s budget`);
});

// ---------- the report ----------

await check("the report names both calibration root causes, and carries no user message and no credential", async () => {
  const o = objects();
  const r = await scanDay({ bucket: bucket(indexed([HOSTED, AGENT])), window: o.window, build: "abc1234" }, tenantScope(HOSTED), DAY);
  must(r.roots.length === 2, `roots ${JSON.stringify(r.roots.map((x) => x.key))}`);
  must(r.roots.some((x) => x.key.startsWith("raft: attachment <uuid>")) && r.roots.some((x) => x.key.startsWith("gh: github <n>: Bad credentials")), "a root cause is missing");
  must(r.roots.every((x) => /^fr_[0-9a-f]{16}$/.test(x.fingerprint)), "a root without a fingerprint");
  const out = JSON.stringify(r) + renderMarkdown(r);
  for (const leak of [USER_SECRET, "4471", SECRET_TOKEN, "hunter2", "token=abc", "IMG_2214"]) must(!out.includes(leak), `${leak} reached the report`);
  must(out.includes(AGENT) && out.includes("seq"), "the report lost its ids");
});

await check("writing a report puts json and md under friction/, and deletes reports past 30 days and an old index day", async () => {
  const b = bucket(["friction/2026-09-01.json", "friction/2026-09-01.md", "friction/2026-09-18.json", "friction/2026-09-19.md",
    "friction-state/issues.json", traceIndexKey("2026-09-01", HOSTED, AGENT), traceIndexKey(DAY, HOSTED, AGENT)]);
  const r = await scanDay({ bucket: b, window: objects().window }, tenantScope(HOSTED), DAY);
  const w = await writeReport(b, r, "2026-10-19");
  must(w.keys.join() === "friction/2026-10-18.json,friction/2026-10-18.md" && b.store.has("friction/2026-10-18.md"), JSON.stringify(w));
  must(!b.store.has("friction/2026-09-01.json") && !b.store.has("friction/2026-09-01.md") && !b.store.has("friction/2026-09-18.json"), "an old report survived");
  must(b.store.has("friction/2026-09-19.md") && b.store.has("friction-state/issues.json"), "a report inside 30 days, or the issue state, was deleted");
  must(!b.store.has(traceIndexKey("2026-09-01", HOSTED, AGENT)) && b.store.has(traceIndexKey(DAY, HOSTED, AGENT)), "the index horizon is wrong");
});

// ---------- public issues ----------

function tracker() {
  const made: Array<{ title: string; body: string; labels: string[] }> = []; const comments: Array<{ issue: number; body: string }> = [];
  const t: IssueTracker & { made: typeof made; comments: typeof comments } = {
    made, comments,
    async find() { return null; },
    async create(title, body, labels) { made.push({ title, body, labels }); return 100 + made.length; },
    async comment(issue, body) { comments.push({ issue, body }); },
  };
  return t;
}

await check("issues are off by default: neither the switch nor the token alone turns them on, and the cron files none", async () => {
  must(issueTrackerFrom({}) === null, "on with nothing set");
  must(issueTrackerFrom({ FRICTION_ISSUES: "1" }) === null, "on without a token");
  must(issueTrackerFrom({ FRICTION_GITHUB_TOKEN: "x" }) === null, "on without the switch");
  must(issueTrackerFrom({ FRICTION_ISSUES: "true", FRICTION_GITHUB_TOKEN: "x" }) === null, "on with a switch that is not 1");
  must(issueTrackerFrom({ FRICTION_ISSUES: "1", FRICTION_GITHUB_TOKEN: "x" }) !== null, "control: both set is still off");
  // The cron with only the switch set: no tracker is built, nothing is fetched, and the issue state is never touched.
  let fetched = 0; const real = globalThis.fetch;
  globalThis.fetch = (async () => { fetched++; return new Response("{}"); }) as typeof fetch;
  try {
    const b = bucket(indexed([HOSTED, AGENT]));
    const out = await frictionDaily({ FRICTION_SCAN_TENANTS: HOSTED, FRICTION_ISSUES: "1" }, { bucket: b, window: objects().window }, Date.parse("2026-10-19T03:17:00Z"));
    must(/issues off/.test(out) && !b.calls.some((c) => c.includes("friction-state")), `${out} ${b.calls}`);
    must(fetched === 0, `fetched ${fetched} time(s)`);
  } finally { globalThis.fetch = real; }
});

await check("an issue body carries no excerpt, command, raw agent id or conversation id; a risky template is withheld", async () => {
  const r = await scanDay({ bucket: bucket(indexed([HOSTED, AGENT])), window: objects().window, build: "abc1234" }, tenantScope(HOSTED), DAY);
  const t = tracker();
  await fileIssues(bucket(), t, r);
  must(t.made.length >= 2, `made ${t.made.length}`);
  const text = JSON.stringify(t.made);
  const excerpts = [...r.roots.flatMap((x) => x.examples.flatMap((e) => e.evidence)), ...r.groups.flatMap((g) => g.examples.map((e) => e.evidence))]
    .filter((e) => /^(\[\w+\] )?(agent|cmd): /.test(e)).map((e) => e.replace(/^(\[\w+\] )?(agent|cmd): /, "").slice(0, 24));
  must(excerpts.length > 3, "the report has no excerpts to test against");
  for (const e of excerpts) must(!text.includes(e), `an excerpt reached an issue: ${e}`);
  for (const id of [AGENT, HOSTED, "main.1", "sub_8a4f448c39e2623b", "做不到", "ls -a", "which raft"]) must(!text.includes(id), `${id} reached an issue`);
  must(text.includes(await agentHash(AGENT)) && text.includes("abc1234") && text.includes(`${DAY}T00:00Z`), "the hash, build or window is missing");
  must(t.made.every((m) => m.labels.join() === "agent-friction"), "label");
  // A template that could hold user text (not plain ASCII, or naming a host that is not ours) is left out.
  const risky = { ...r.groups[0]!, cls: "tool_error" as const, key: "fs: 用户的文件 <path> 不存在", agents: [AGENT] };
  const body = await issueBody(DAY, null, risky, 0);
  must(!body.includes("用户") && /withheld/.test(body), body);
  const host = await issueBody(DAY, null, { ...risky, key: "web: fetch failed for <url:intranet.acme-corp.example> and acme-corp.example" }, 0);
  must(!host.includes("acme-corp") && host.includes("<url>") && host.includes("<host>"), host);
});

await check("issues: one per new qualifying fingerprint, a comment only when its counts change, none for probes", async () => {
  const b = bucket(); const t = tracker();
  const r = await scanDay({ bucket: bucket(indexed([HOSTED, AGENT])), window: objects().window }, tenantScope(HOSTED), DAY);
  const first = await fileIssues(b, t, r);
  must(first.created === t.made.length && first.commented === 0, JSON.stringify(first));
  must(t.made.every((m) => !/env_probe|inability_text|repeated_call/.test(m.title)), `a probe was filed: ${t.made.map((m) => m.title)}`);
  must(t.made.some((m) => m.title.includes(r.roots[0]!.fingerprint)), "an episode root was not filed");
  const again = await fileIssues(b, t, r);
  must(again.created === 0 && again.commented === 0, `same counts: ${JSON.stringify(again)}`);
  const more = structuredClone(r); more.groups.find((g) => g.fingerprint === r.roots[0]!.fingerprint)!.count += 2;
  const third = await fileIssues(b, t, more);
  must(third.created === 0 && third.commented === 1 && t.comments[0]!.issue >= 101, JSON.stringify(third));
});

// ---------- the cron ----------

await check("the cron step is fail-soft: a friction step that throws or hangs does not fail the cron, retention still runs", async () => {
  const quiet = console.warn; const loud = console.log; const logged: string[] = [];
  console.warn = (...a: unknown[]) => logged.push(a.join(" ")); console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    const counter = { retained: 0 };
    await dailyCron(async () => { counter.retained++; }, async () => { throw new Error("scan exploded"); });
    must(counter.retained === 1 && logged.some((l) => l.includes("scan exploded")), `retained ${counter.retained} logged ${logged}`);
    const t0 = Date.now();
    await dailyCron(async () => { counter.retained++; }, () => new Promise(() => {}), 50);
    must(Number(counter.retained) === 2 && Date.now() - t0 < 2000 && logged.some((l) => l.includes("cut off")), "a hanging scan held the cron");
    let ran = false, threw: unknown = null;
    try { await dailyCron(async () => { throw new Error("fold failed"); }, async () => { ran = true; return "ok"; }); } catch (e) { threw = e; }
    must(ran && String((threw as Error)?.message) === "fold failed", "a retention failure was hidden, or skipped the scan");
  } finally { console.warn = quiet; console.log = loud; }
});

await check("the Worker's scheduled handler survives a friction scan whose bucket fails, and honours the kill switch", async () => {
  const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
    " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
    " export class RpcTarget {} export const env = {};";
  register("data:text/javascript," + encodeURIComponent(
    `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
  const { default: worker } = await import("../cf/src/index.ts");
  const stmt: any = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) };
  const reads: string[] = [];
  const failing = bucket(indexed([HOSTED, AGENT])); failing.failList = true;
  const env = (extra: Record<string, unknown>, b: FrictionBucket) => ({
    CONTROL_DB: { prepare: () => stmt, batch: async () => [] }, ARTIFACTS: b, FRICTION_SCAN_TENANTS: "*",
    AGENT: { idFromName: (n: string) => n, get: () => ({ frictionWindow: async () => { reads.push("read"); return null; } }) }, ...extra,
  });
  const quiet = console.warn; const loud = console.log; const logged: string[] = [];
  console.warn = (...a: unknown[]) => logged.push(a.join(" ")); console.log = (...a: unknown[]) => logged.push(a.join(" "));
  try {
    await worker.scheduled({ scheduledTime: Date.parse("2026-10-19T03:17:00Z"), cron: "17 3 * * *" } as never, env({}, failing) as never);
    must(logged.some((l) => l.includes("r2 list unavailable")), `the failure was not logged: ${logged}`);
    const off = bucket(indexed([HOSTED, AGENT]));
    await worker.scheduled({ scheduledTime: Date.parse("2026-10-19T03:17:00Z"), cron: "17 3 * * *" } as never, env({ FRICTION_SCAN_DISABLED: "1" }, off) as never);
    must(off.calls.length === 0 && reads.length === 0, `the kill switch let it read: ${off.calls}`);
    const on = bucket(indexed([HOSTED, AGENT]));
    await worker.scheduled({ scheduledTime: Date.parse("2026-10-19T03:17:00Z"), cron: "17 3 * * *" } as never, env({}, on) as never);
    must(Number(reads.length) === 1 && on.store.has("friction/2026-10-18.json"), `control: the scan did not run: ${on.calls}`);
    // The on-demand route: the same switch, and the operator's token.
    const res = await worker.fetch(new Request(`https://x/admin/friction-scan?day=${DAY}`, { method: "POST", headers: { "x-harness-token": "tok" } }),
      env({ AUTOMATION_TOKEN: "tok", FRICTION_SCAN_DISABLED: "1" }, bucket()) as never, { waitUntil() {}, passThroughOnException() {} } as never);
    must(res.status === 503, `kill switch on the route: ${res.status}`);
    const dry = bucket(indexed([HOSTED, AGENT]));
    const res2 = await worker.fetch(new Request(`https://x/admin/friction-scan?day=${DAY}&write=0`, { method: "POST", headers: { "x-harness-token": "tok" } }),
      env({ AUTOMATION_TOKEN: "tok" }, dry) as never, { waitUntil() {}, passThroughOnException() {} } as never);
    const body = await res2.json() as any;
    must(res2.status === 200 && body.written === null && body.report.day === DAY && !dry.calls.some((c) => c.startsWith("put")), `dry run: ${res2.status} ${dry.calls}`);
  } finally { console.warn = quiet; console.log = loud; }
});

// ---------- the day index ----------

await check("the day index: one marker per agent per day, written once, and written again after a failed put", async () => {
  const host = sqliteHost(); const puts: string[] = []; let fail = true;
  const sink = { async put(key: string) { if (fail) { fail = false; throw new Error("r2 down"); } puts.push(key); } };
  let threw = false;
  try { await noteTraceDays(sink, host.sql, "t1", "a1", ["2026-10-18"]); } catch { threw = true; }
  must(threw && puts.length === 0, "the failure was swallowed inside noteTraceDays");
  must(await noteTraceDays(sink, host.sql, "t1", "a1", ["2026-10-18", "2026-10-19"]) === 2, "the failed day was not retried");
  must(await noteTraceDays(sink, host.sql, "t1", "a1", ["2026-10-18", "2026-10-19"]) === 0, "a day was indexed twice");
  must(puts.join() === `${traceIndexKey("2026-10-18", "t1", "a1")},${traceIndexKey("2026-10-19", "t1", "a1")}`, puts.join());
});

await check("the index is read when present; a day without one falls back to listing", async () => {
  const b = bucket([...indexed([HOSTED, AGENT]), `trace/${HOSTED}/${OTHER_AGENT}/1-2.ndjson`]);
  const a = await activeAgents(b, DAY, tenantScope("*"), 10);
  must(a.source === "index" && a.agents.length === 1 && a.agents[0]!.agentId === AGENT, JSON.stringify(a));
  const c = await activeAgents(b, "2026-10-10", tenantScope("*"), 10);
  must(c.source === "listing" && c.agents.length === 1 && c.agents[0]!.agentId === OTHER_AGENT, JSON.stringify(c));
});

// ---------- the object's read ----------

await check("the object's window: in-window events only, user messages and reasoning left out, strings capped, a stranger is null", async () => {
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self', ?, ?)", HOSTED, AGENT);
  const from = Date.parse(`${DAY}T00:00:00Z`);
  let now = from - 3_600_000;
  const pi = new PiSqliteStorage(host, { now: () => now });
  const entry = (id: string, parentId: string | null, message: unknown) => ({ kind: "entry", entry: { id, parentId, type: "message", message } }) as any;
  await pi.commit([entry("u0", null, { role: "user", content: "yesterday", timestamp: now })], CTX);
  now = from + 60_000;
  await pi.commit([entry("u1", "u0", { role: "user", content: USER_SECRET, timestamp: now })], CTX);
  await pi.commit([entry("a1", "u1", { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "reading" }, { type: "toolCall", id: "c1", name: "artifacts__read", arguments: { ref: "artifact://x.jpg" } }], stopReason: "toolUse", timestamp: now })], CTX);
  await pi.commit([entry("r1", "a1", { role: "toolResult", toolCallId: "c1", toolName: "artifacts__read", content: [{ type: "text", text: JSON.stringify({ kind: "text", text: "�".repeat(9000) }) }], isError: false, timestamp: now })], CTX);
  const w = readFrictionWindow(host.sql, HOSTED, AGENT, from, from + 86_400_000, { ...FRICTION_LIMITS, maxString: 100 });
  must(w !== null && w.conversations.length === 1 && w.conversations[0]!.id === "main", JSON.stringify(w)?.slice(0, 300));
  const ev = w.conversations[0]!.events;
  must(ev.length === 2 && ev.every((e) => e.kind !== "message"), `kinds ${ev.map((e) => e.kind)}`);
  const text = JSON.stringify(w);
  must(!text.includes("bank PIN") && !text.includes("yesterday") && !text.includes("private reasoning"), "a user message, an out-of-window event or reasoning left the object");
  must(String(ev[1]!.payload.result.text).length === 100, `not capped: ${String(ev[1]!.payload.result.text).length}`);
  must(readFrictionWindow(host.sql, HOSTED, "someone-else", from, from + 86_400_000) === null, "a stranger's window was answered");
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
