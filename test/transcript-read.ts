/**
 * The operator's read of a conversation (cf/src/transcript-read.ts), on a real
 * SQLite database built by the classes production runs.
 *
 * The property is that reading changes nothing: not a row, not a table. Opening
 * the agent re-pins mounts and reconciles the session, and the store's init runs
 * migrations (Ada, #336), so the read must go around all of them. Checking that
 * by what the code calls proves less than checking the database, so the whole
 * database is dumped before and after, schema included. And the read must show
 * what the console shows, so it is compared with the console's own inputs.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { readTranscript, transcriptEvents, approvalsByOp } from "../cf/src/transcript-read.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { PiSqliteStorage, MAIN_SESSION } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

type Host = ReturnType<typeof sqliteHost>;

/** Every table's definition and every row, in a stable order. */
function dump(host: Host): string {
  const tables = host.sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").toArray() as any[];
  const rows = tables.filter((t) => t.type === "table")
    .map((t) => [t.name, host.sql.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`).toArray()]);
  return JSON.stringify({ tables, rows });
}

const message = (id: string, parentId: string | null, text: string) =>
  ({ kind: "entry", entry: { id, parentId, type: "message", message: { role: "user", content: text, timestamp: 1 } } }) as any;

/** An agent's object as production leaves it: the store's tables, the owner row, two conversations, an approval. */
async function agentObject() {
  const host = sqliteHost();
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  const main = new PiSqliteStorage(host);
  await main.commit([message("m1", null, "hello")], CTX);
  await main.commit([message("m2", "m1", "the file is r2://antiproton-artifacts/t/demo/u-a/out.txt")], CTX);
  await store.createTask("demo", "u-a", "task_2", {});
  await new PiSqliteStorage(host, { session: "task_2" }).commit([message("s1", null, "second conversation")], CTX);
  await store.requireApproval({ tenantId: "demo", operationId: "op1", agentId: "u-a", taskId: "t_u-a",
    mountAlias: "gh", tool: "create_issue", request: { title: "x" } } as any);
  return { host, store, main };
}

await check("reading changes nothing: every table and row is the same after reads that find and reads that do not", async () => {
  const { host } = await agentObject();
  const before = dump(host);
  assert(before.includes("pi_entries") && before.includes("approvals"), "the object was not built, so this compared nothing");
  const found = [readTranscript(host.sql, "demo", "u-a", "t_u-a"), readTranscript(host.sql, "demo", "u-a", "task_2")];
  const missing = [
    readTranscript(host.sql, "demo", "u-a", "task_nope"),
    readTranscript(host.sql, "demo", "u-b", "t_u-b"),
    readTranscript(host.sql, "other", "u-a", "t_u-a"),
  ];
  assert(found.every((r) => r !== null), "a conversation the object holds read as null");
  assert(missing.every((r) => r === null), `a conversation the object does not hold was read: ${JSON.stringify(missing).slice(0, 160)}`);
  assert(dump(host) === before, "the database changed while it was being read");
  host.dispose();
});

await check("an object nothing has claimed reads as null and gains no table", async () => {
  const host = sqliteHost();
  assert(readTranscript(host.sql, "demo", "u-a", "t_u-a") === null, "an empty object read as a conversation");
  assert(host.sql.exec("SELECT name FROM sqlite_master").toArray().length === 0, "reading created a table");
  host.dispose();
});

await check("it shows what the console shows: the same events, masked references, and approvals by operation", async () => {
  const { host, store, main } = await agentObject();
  const read = readTranscript(host.sql, "demo", "u-a", "t_u-a");
  // The console's inputs (uiTranscript): pi's own storage scan and the store's approvals, through the same helpers.
  const owner = { tenantId: "demo", agentId: "u-a" };
  const shownInConsole = {
    ...transcriptEvents(await main.scanEntries({ order: "asc" }, CTX), host.sql, MAIN_SESSION, owner, 0),
    byOp: approvalsByOp(await store.listApprovals("demo")),
  };
  assert(JSON.stringify(read) === JSON.stringify(shownInConsole), `read ${JSON.stringify(read).slice(0, 200)}\nconsole ${JSON.stringify(shownInConsole).slice(0, 200)}`);
  assert(read!.events.length === 2 && read!.byOp.op1?.tool === "gh.create_issue", `read ${JSON.stringify(read).slice(0, 200)}`);
  assert(!JSON.stringify(read).includes("r2://antiproton-artifacts/t/demo/u-a/"), "a raw reference was not masked");
  const second = readTranscript(host.sql, "demo", "u-a", "task_2");
  assert(second?.events.length === 1 && JSON.stringify(second).includes("second conversation"), `task_2 read ${JSON.stringify(second).slice(0, 200)}`);
  host.dispose();
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
