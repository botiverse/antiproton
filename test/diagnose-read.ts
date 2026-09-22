/**
 * /admin/diagnose's report (cf/src/diagnose-read.ts), on a real SQLite database
 * built by the classes production runs.
 *
 * The property is the one test/transcript-read.ts holds for the transcript:
 * reading changes nothing, not a row and not a table, including through the
 * plugins asked what their mounts hold, which get a connection they cannot
 * write. Checked by dumping the whole database before and after.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { readDiagnosis } from "../cf/src/diagnose-read.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { recordBackgroundJob } from "../src/runtime/background-jobs.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

type Host = ReturnType<typeof sqliteHost>;

function dump(host: Host): string {
  const tables = host.sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").toArray() as any[];
  const rows = tables.filter((t) => t.type === "table")
    .map((t) => [t.name, host.sql.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`).toArray()]);
  return JSON.stringify({ tables, rows });
}

const message = (id: string, parentId: string | null, text: string) =>
  ({ kind: "entry", entry: { id, parentId, type: "message", message: { role: "user", content: text, timestamp: 1 } } }) as any;

/** A plugin whose report reads its mount's state, and one whose report tries to change it. */
const reader = {
  id: "reader",
  holds: {
    async activity(ctx: any) { const s = await ctx.connection.get(); return { live: s ? { id: String(s.boxId), startedAt: 1, lastUsedAt: 2 } : null }; },
    async usage() { return []; },
    async release() { return false; },
  },
} as any;
let writerTried = false;
const writer = {
  id: "writer",
  holds: {
    async activity(ctx: any) { writerTried = true; await ctx.connection.set({ touched: true }); return { live: { id: "w", startedAt: 1, lastUsedAt: 1 } }; },
    async release() { return false; },
  },
} as any;
/** A plugin whose record only says how much of it would not read — no live box, no finished stretches. */
const recorder = {
  id: "recorder",
  holds: {
    async activity() { return { live: null, unreadable: 3 }; },
    async usage() { return []; },
    async release() { return false; },
  },
} as any;

async function agentObject() {
  const host = sqliteHost();
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  const main = new PiSqliteStorage(host);
  await main.commit([message("m1", null, "hello")], CTX);
  await main.commit([message("m2", "m1", "stored at r2://antiproton-artifacts/t/demo/u-a/out.txt")], CTX);
  const mount = (alias: string, plugin: string, secretRef: string | null) => store.addMount({
    tenantId: "demo", agentId: "u-a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
    toolVersion: "1.0.0", publicConfig: { account: alias }, secretRef, policy: null,
  });
  await mount("sandbox", "reader", "operator:run9");
  await mount("scratch", "writer", null);
  // A mount whose credential is the agent's own, so the report can be asked WHEN it was attached.
  await mount("gh", "reader", "agent:gh");
  await store.putSecret("demo", "u-a", "gh", { ciphertext: "x", iv: "y", account: "someone", verified: true });
  // A row under the OPERATOR mount's alias too, so "an operator ref is not dated" is decided by the ref's
  // kind rather than by there being nothing to find — without this the assertion passes either way.
  await store.putSecret("demo", "u-a", "sandbox", { ciphertext: "z", iv: "w", account: null, verified: false });
  await store.putConnection("demo", "u-a", "sandbox", { boxId: "box-1" } as any);
  recordBackgroundJob(host.sql as any, { tenantId: "demo", agentId: "u-a" },
    { id: "op1", session: "main", mount: "sandbox", tool: "sandbox__shell", handle: {} }, 1_000);
  return { host, store };
}

const deps = (store: DurableObjectStore) => ({ store, plugins: [reader, writer], alarm: async () => null, now: () => 5_000 });

await check("reading the report changes nothing, including through a plugin that tries to write its mount", async () => {
  const { host, store } = await agentObject();
  const before = dump(host);
  assert(before.includes("background_jobs") && before.includes("mounts"), "the object was not built, so this compared nothing");
  writerTried = false;
  const report = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a", deps(store)) as any;
  assert(report !== null, "an agent the object holds read as null");
  assert(writerTried, "the writing plugin was never asked, so the read-only connection was not exercised");
  assert(dump(host) === before, "the database changed while the report was read");
  host.dispose();
});

await check("a mount's credential is dated, so 'was it attached then?' is a read rather than an excavation", async () => {
  const { host, store } = await agentObject();
  const r = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a", deps(store)) as any;
  const gh = r.mounts.find((m: any) => m.alias === "gh");
  assert(typeof gh?.secretTimes?.createdAt === "number" && gh.secretTimes.createdAt > 0,
    `when it was attached: ${JSON.stringify(gh?.secretTimes)}`);
  assert(gh.secretTimes.verified === true && gh.secretTimes.lastUsedAt === null, `state: ${JSON.stringify(gh.secretTimes)}`);
  // Times, and nothing that says whose account it is or what the value was.
  assert(!("account" in gh.secretTimes) && !JSON.stringify(gh.secretTimes).includes("someone"),
    `the report named the account: ${JSON.stringify(gh.secretTimes)}`);
  // A replacement moves `updatedAt` and leaves `createdAt` where it was — which is what makes the field
  // answer "was there one at that time" rather than only "is there one now".
  const first = gh.secretTimes;
  await new Promise((r) => setTimeout(r, 5));
  await store.putSecret("demo", "u-a", "gh", { ciphertext: "x2", iv: "y2", account: "someone", verified: true });
  const again = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a", deps(store)) as any;
  const after = again.mounts.find((m: any) => m.alias === "gh").secretTimes;
  assert(after.createdAt === first.createdAt && after.updatedAt > first.updatedAt,
    `after a replacement: ${JSON.stringify({ first, after })}`);
  // An operator's secret is not in this agent's store, so there is nothing to date.
  assert(r.mounts.find((m: any) => m.alias === "sandbox").secretTimes === null,
    "an operator ref was dated from a row that happens to share the alias");
  host.dispose();
});

await check("the report says what the old one said about mounts, events, jobs and rendering, and that the lane is not read", async () => {
  const { host, store } = await agentObject();
  const r = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a", deps(store)) as any;
  const sandbox = r.mounts.find((m: any) => m.alias === "sandbox");
  assert(sandbox?.secret === "operator" && sandbox.connection === true && sandbox.config.account === "sandbox", `mounts: ${JSON.stringify(r.mounts)}`);
  assert(r.mountReports.sandbox?.activity.live?.id === "box-1", `the reading plugin's report: ${JSON.stringify(r.mountReports)}`);
  assert(!("scratch" in r.mountReports), `a plugin that could only report by writing was reported: ${JSON.stringify(r.mountReports)}`);
  assert(r.entries === 2 && r.eventKinds.message === 2 && r.lastEvents.length === 2, `events: ${JSON.stringify({ e: r.entries, k: r.eventKinds })}`);
  assert(!JSON.stringify(r.lastEvents).includes("r2://antiproton-artifacts/t/demo/u-a/"), "a raw reference reached the report");
  assert(r.backgroundJobs[0]?.id === "op1" && r.backgroundJobs[0].state === "running", `jobs: ${JSON.stringify(r.backgroundJobs)}`);
  assert(r.rendered.ok === true && r.rendered.bytes > 0, `rendered: ${JSON.stringify(r.rendered)}`);
  assert(r.execution.readable === false, `execution: ${JSON.stringify(r.execution)}`);
  assert(r.alarmFailures === 0 && Array.isArray(r.releaseErrors) && Array.isArray(r.alarmErrors) && Array.isArray(r.modelJobs), "optional tables read as empty");
  host.dispose();
});

await check("a mount that can only say its record would not read still reaches the report", async () => {
  // The fixture borrows neither the plugin name under test nor the alias: what
  // matters is that "I could not tell" is not read as "there is nothing".
  const { host, store } = await agentObject();
  await store.addMount({
    tenantId: "demo", agentId: "u-a", alias: "tape", plugin: "recorder", installationId: "i-tape",
    connectionId: null, toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const r = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a",
    { store, plugins: [reader, writer, recorder], alarm: async () => null, now: () => 5_000 }) as any;
  assert(r.mountReports.tape?.activity.unreadable === 3,
    `the unreadable-only mount was dropped from the report: ${JSON.stringify(r.mountReports)}`);
  host.dispose();
});

check("a claimed object whose store was never initialised reads as a report, not a missing table", async () => {
  // An agent the Agents API only named: the constructor's tables and an owner row, and none of the store's (Ada, #347).
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  await new PiSqliteStorage(host).commit([message("m1", null, "hello")], CTX);
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  const before = dump(host);
  assert(!before.includes('"mounts"'), "the store's tables exist, so this case checks nothing");
  let report: any = null;
  try { report = await readDiagnosis(host.sql, "demo", "u-a", "t_u-a", deps(store)); }
  catch (e) { assert(false, `a claimed, uninitialised object threw: ${(e as Error).message}`); }
  assert(report !== null && report.entries === 1, `report: ${JSON.stringify(report).slice(0, 200)}`);
  assert(Array.isArray(report.mounts) && report.mounts.length === 0 && report.modelBinding === null && report.state.keys === 0,
    `empty readings: ${JSON.stringify({ mounts: report.mounts, binding: report.modelBinding, state: report.state })}`);
  assert(dump(host) === before, "reading an uninitialised object changed it");
  host.dispose();
});

await check("an agent or conversation the object does not hold is null, and an unclaimed object gains no table", async () => {
  const { host, store } = await agentObject();
  const before = dump(host);
  for (const [t, a, k] of [["demo", "u-b", "t_u-b"], ["other", "u-a", "t_u-a"], ["demo", "u-a", "task_nope"]] as const) {
    assert(await readDiagnosis(host.sql, t, a, k, deps(store)) === null, `${t}/${a} ${k} read as a report`);
  }
  assert(dump(host) === before, "a refused read changed the database");
  host.dispose();
  const empty = sqliteHost();
  const emptyStore = new DurableObjectStore({ storage: { sql: empty.sql, transactionSync: empty.transactionSync } } as any);
  assert(await readDiagnosis(empty.sql, "demo", "u-a", "t_u-a", deps(emptyStore)) === null, "an empty object read as a report");
  assert(empty.sql.exec("SELECT name FROM sqlite_master").toArray().length === 0, "reading an empty object created a table");
  empty.dispose();
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
