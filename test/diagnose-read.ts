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
  async activity(ctx: any) { const s = await ctx.connection.get(); return { live: s ? { id: String(s.boxId), startedAt: 1, lastUsedAt: 2 } : null }; },
  async usage() { return []; },
} as any;
let writerTried = false;
const writer = {
  id: "writer",
  async activity(ctx: any) { writerTried = true; await ctx.connection.set({ touched: true }); return { live: { id: "w", startedAt: 1, lastUsedAt: 1 } }; },
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
