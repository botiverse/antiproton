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
import { converse } from "./spec/pd-conversation.ts";
import { unansweredObject, HANDOFF } from "./spec/pd-unanswered.ts";
import { conversation, eventList, trajectory } from "../cf/src/ui.ts";
import { entriesToEvents } from "../cf/src/pi-view.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
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

await check("a pd agent is read from pi-durable's entries, not pi's tables: what the console shows, and nothing written", async () => {
  const host = sqliteHost();
  try {
    const { rt, agent } = await converse(host, "pd");
    const owner = { tenantId: "demo", agentId: "u-a" };
    const shownInConsole = {
      ...transcriptEvents(await agent.entries({ order: "asc" }), host.sql, MAIN_SESSION, owner, 0),
      byOp: approvalsByOp(await rt.store.listApprovals("demo")),
    };
    await agent.close();
    // The control: a pd object has no pi tables, so a read of them could not show this conversation.
    assert(host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'pi_entries'").toArray().length === 0, "a pd object has pi_entries, so this does not tell the reads apart");
    const before = dump(host);
    const read = readTranscript(host.sql, "demo", "u-a", "t_u-a");
    assert(read !== null && read.events.map((e) => e.kind).join() === "message,model.response,message,model.response",
      `read ${JSON.stringify(read).slice(0, 300)}`);
    assert(JSON.stringify(read) === JSON.stringify(shownInConsole), `read ${JSON.stringify(read).slice(0, 200)}\nconsole ${JSON.stringify(shownInConsole).slice(0, 200)}`);
    assert(readTranscript(host.sql, "demo", "u-a", "task_nope") === null, "a conversation the agent does not hold was read");
    assert(dump(host) === before, "the database changed while it was being read");
  } finally { host.dispose(); }
});

await check("pd: a run that failed before its first model call and a transcript reset are in the transcript, and the console draws both", async () => {
  const host = sqliteHost();
  try {
    await unansweredObject(host);
    const before = dump(host);
    const read = readTranscript(host.sql, "demo", "u-a", "t_u-a")!;
    const kinds = read.events.map((e) => e.kind).join();
    // pd-unanswered.ts's runs in order; each failure follows what its run left, and run 2's is its own reply.
    assert(kinds === [
      "message", "model.failed", "message", "model.failed", "message", "model.failed",
      "message", "model.response", "tool.result", "model.failed", "message", "model.failed", "model.failed",
      "message", "model.response", "message", "model.response", "model.failed",
      "compaction", "message", "model.response", "compaction", "reset"].join(), `events: ${kinds}`);
    const failed = read.events[1]!;
    assert(failed.payload.error === "no_model: Model gone/m is not available" && failed.createdAt === read.events[0]!.createdAt,
      `the failure: ${JSON.stringify(failed)}`);
    const reset = read.events.at(-1)!;
    assert(reset.payload.handoff === HANDOFF && reset.createdAt > 0, `the reset: ${JSON.stringify(reset)}`);
    assert(dump(host) === before, "the database changed while it was being read");

    // What a person sees: the trajectory and the chat say there was a reset and show its handoff; the events tab too.
    const drawn = trajectory(read.events, read.byOp, null);
    assert(drawn.includes("model failed") && drawn.includes("Model gone/m is not available"), "the trajectory does not show the failure");
    assert(drawn.includes("conversation reset") && drawn.includes("<strong>one</strong>"), "the trajectory does not show the reset and its handoff");
    const chat = trajectory(conversation(read.events), read.byOp, null);
    assert(chat.includes("conversation reset"), "the chat does not show the reset");
    assert(eventList(read.events as any).includes("conversation reset"), "the events tab does not show the reset");
  } finally { host.dispose(); }
});

await check("a reset with no handoff is still drawn, and a custom entry that is not a reset is still not an event", () => {
  const events = entriesToEvents([
    { type: "custom", customType: "pi.reset", id: "1", parentId: null, seq: 1, timestamp: 5, data: {} },
    { type: "custom", customType: "agents_api.turn_cancelled", id: "2", parentId: "1", seq: 2, timestamp: 6, data: { operationId: "op" } },
  ] as any);
  assert(JSON.stringify(events) === JSON.stringify([{ sequence: 1, kind: "reset", payload: { at: 5 } }]), `events: ${JSON.stringify(events)}`);
  const drawn = trajectory(events.map((e) => ({ ...e, createdAt: 5 })), {}, null);
  assert(drawn.includes("conversation reset") && !drawn.includes("handoff the agent starts from"), `drawn: ${drawn.slice(0, 300)}`);
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
