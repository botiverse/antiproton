/**
 * The pd engine's transcript as the 0.85 readers see it (src/runtime/pd-transcript.ts).
 *
 * Three things are held: each pi-durable entry kind projects to the 0.85 entry the readers expect; a
 * conversation renders through the readers (`entriesToEvents`, `callTurns`, `sessionTranscript`) the same on
 * pd as on pi085, ids and times aside; and the operator's read-only scan (`readPdEntries`) is what the
 * engine itself returns, while writing nothing.
 *
 * The parity is checked twice. A real conversation run on both engines (test/spec/pd-conversation.ts)
 * compares what each actually stored. Tool calls and the cancel marker cannot be run on pd yet (no tools are
 * offered until mounts are bridged, and cancel arrives with client calls), so those are compared on records
 * written in the shapes pi-durable's own writers use (harness/tool.js `appendToolResult`, harness/generation.js
 * `appendAssistant`) against the 0.85 entries of the same conversation.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { entriesToEvents } from "../cf/src/pi-view.ts";
import { callTurns, sessionTranscript, TURN_CANCELLED } from "../cf/src/agents-api/transcript.ts";
import { projectEntries, readPdEntries, readPdRecords, unwrapSummary } from "../src/runtime/pd-transcript.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { converse, SCRIPT } from "./spec/pd-conversation.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

type Host = ReturnType<typeof sqliteHost>;
function dump(host: Host): string {
  const tables = host.sql.exec("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").toArray() as any[];
  const rows = tables.filter((t) => t.type === "table")
    .map((t) => [t.name, host.sql.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`).toArray()]);
  return JSON.stringify({ tables, rows });
}

const T0 = 1_790_000_000_000;
const usage = (input: number, output: number, cacheRead = 0, reasoning?: number) => ({
  input, output, cacheRead, cacheWrite: 0, ...(reasoning === undefined ? {} : { reasoning }), totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const record = (id: number, kind: string, extra: Partial<EntryRecord> = {}): EntryRecord =>
  ({ id, conversationId: 0, kind, ...extra }) as unknown as EntryRecord;
const assistant = (content: unknown[], stopReason: string, at: number, u = usage(0, 0)) =>
  ({ role: "assistant", content, api: "offloaded", provider: "p", model: "m1", usage: u, stopReason, timestamp: T0 + at });

// ---- projection, one kind at a time ------------------------------------------------------------

await check("pi.user: one message entry carrying the user message, its id and seq the record's, its time the message's", () => {
  const [e, ...rest] = projectEntries([record(7, "pi.user", { model: [{ role: "user", content: "hi", timestamp: T0 + 5 }] as any })]);
  assert(rest.length === 0 && e?.type === "message", show(e));
  assert(e.id === "7" && e.seq === 7 && e.parentId === null && e.timestamp === T0 + 5, show(e));
  assert(show((e as any).message) === show({ role: "user", content: "hi", timestamp: T0 + 5 }), show(e));
});

await check("pi.assistant: tool calls, usage and stop reason pass as plain data; a pi-ai 1.0-only field rides along", () => {
  const m = { ...assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." },
    { type: "toolCall", id: "c1", name: "shell", arguments: { command: "ls" } }], "toolUse", 10, usage(100, 20, 40, 5)), thinkingLevel: "low" };
  const source = record(9, "pi.assistant", { model: [m] as any });
  const [e] = projectEntries([source]);
  assert(e?.type === "message" && show((e as any).message) === show(m), show(e));
  // A copy, not the record's own object: what the 0.85 side holds is not a pi-ai 1.0 value it could mutate.
  assert((e as any).message !== m && (e as any).message.content !== m.content, "the message object itself crossed");
  assert(Object.getPrototypeOf((e as any).message) === Object.prototype, "not a plain object");
});

await check("pi.tool-result: the tool result message, its content verbatim (a diagnostics block included, as the model saw it)", () => {
  const ok = { role: "toolResult", toolCallId: "c1", toolName: "shell", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: T0 + 20 };
  const failed = { role: "toolResult", toolCallId: "c2", toolName: "shell", content: [{ type: "text", text: "<harness>\n[error] boom\n</harness>" }], isError: true, timestamp: T0 + 21 };
  const out = projectEntries([
    record(11, "pi.tool-result", { model: [ok] as any, data: { diagnostics: [] } }),
    record(12, "pi.tool-result", { model: [failed] as any, data: { diagnostics: [{ severity: "error", code: "x", message: "boom" }] } }),
  ]);
  assert(out.length === 2 && show((out[0] as any).message) === show(ok) && show((out[1] as any).message) === show(failed), show(out));
  assert(out[1]!.parentId === "11", `parent chain: ${show(out.map((e) => e.parentId))}`);
});

await check("pi.compaction: a compaction entry whose summary is unwrapped from pi-durable's <summary> wrapper", () => {
  const wrapped = "The conversation history before this point was compacted into the following summary:\n\n<summary>\nGoal: X\n</summary>";
  const [e] = projectEntries([record(30, "pi.compaction", { head: 12 as any, data: { reason: "threshold" },
    model: [{ role: "user", content: [{ type: "text", text: wrapped }], timestamp: T0 + 30 }] as any })]);
  assert(e?.type === "compaction" && e.summary === "Goal: X" && e.timestamp === T0 + 30, show(e));
  assert(show((e as any).details) === show({ reason: "threshold" }) && e.fromHook === false && Array.isArray(e.retainedTail), show(e));
  assert(unwrapSummary("not wrapped") === "not wrapped", "an unwrapped summary was changed");
});

await check("pi.reset: a custom pi.reset entry, with the handoff text when there is one; pi.system: nothing", () => {
  const out = projectEntries([
    record(2, "pi.system", { model: [{ role: "system", content: "", timestamp: T0 }] as any }),
    record(40, "pi.reset", { head: 40 as any }),
    record(41, "pi.reset", { head: 41 as any, model: [{ role: "user", content: [{ type: "text", text: "carry on with Y" }], timestamp: T0 + 41 }] as any }),
  ]);
  assert(out.length === 2, `pi.system was shown: ${show(out)}`);
  assert(out[0]!.type === "custom" && out[0]!.customType === "pi.reset" && show((out[0] as any).data) === "{}", show(out[0]));
  assert(show((out[1] as any).data) === show({ handoff: "carry on with Y" }), show(out[1]));
  assert(out[0]!.parentId === null && out[1]!.parentId === "40", "the system record took a place in the parent chain");
});

await check("any other kind: a custom entry named by the kind with its data, the cancel marker included; its time the model note's, else data.at, else the previous", () => {
  const out = projectEntries([
    record(50, "pi.user", { model: [{ role: "user", content: "go", timestamp: T0 + 50 }] as any }),
    record(51, TURN_CANCELLED, { data: { operationId: "op1" } }),
    record(52, "app.note", { data: { at: T0 + 99, n: 1 } }),
    record(53, TURN_CANCELLED, { data: { operationId: "op2" },
      model: [{ role: "user", content: [{ type: "text", text: "[cancelled]" }], timestamp: T0 + 120 }] as any }),
  ]);
  assert(out.length === 4 && out.slice(1).every((e) => e.type === "custom"), show(out));
  assert(out[1]!.customType === TURN_CANCELLED && show((out[1] as any).data) === show({ operationId: "op1" }) && out[1]!.timestamp === T0 + 50, show(out[1]));
  assert(out[2]!.customType === "app.note" && out[2]!.timestamp === T0 + 99, show(out[2]));
  assert(out[3]!.timestamp === T0 + 120 && !("message" in out[3]!), `a context-only note became a message: ${show(out[3])}`);
});

// ---- parity: the same conversation, rendered on both engines -------------------------------------

/**
 * A rendering with what legitimately differs between engines taken out: sequence numbers (pd's are the
 * object's entry ids, pi085's its own counter, and pi085 keeps deferred placeholders between) become their
 * rank among those the rendering names, and every time becomes "T" (null stays null).
 */
function normal(rendered: unknown): unknown {
  const text = JSON.stringify(rendered, (_k, v) => v instanceof Map ? Object.fromEntries(v) : v);
  const seqs = new Set<number>();
  for (const m of text.matchAll(/(?:turn_|item_)(\d+)|"sequence":(\d+)/g)) seqs.add(Number(m[1] ?? m[2]));
  const rank = new Map([...seqs].sort((a, b) => a - b).map((s, i) => [s, i + 1]));
  const renamed = text.replace(/(turn_|item_)(\d+)/g, (_m, p, n) => `${p}${rank.get(Number(n))}`);
  const TIMES = new Set(["at", "createdAt", "created_at", "started_at", "completed_at", "timestamp"]);
  return JSON.parse(renamed, (k, v) => k === "sequence" ? rank.get(v) : TIMES.has(k) && v !== null ? "T" : v);
}

function renderings(entries: unknown[]) {
  return {
    events: normal(entriesToEvents(entries as any)),
    callTurns: normal(callTurns(entries)),
    api: normal(sessionTranscript({ entries, running: false }, { sessionId: "s", agentId: "a" })),
  };
}

await check("a real two-turn conversation run on both engines renders the same through entriesToEvents, callTurns and sessionTranscript", async () => {
  const hosts = { pi085: sqliteHost(), pd: sqliteHost() };
  try {
    const pi = await converse(hosts.pi085, "pi085");
    const pd = await converse(hosts.pd, "pd");
    const piEntries = await pi.agent.entries({ order: "asc" });
    const pdEntries = await pd.agent.entries({ order: "asc" });
    const a = renderings(piEntries), b = renderings(pdEntries);
    const events = a.events as any[];
    // The control: the rendering holds the conversation, so equal is not two empty lists.
    assert(events.length === 4 && events.filter((e) => e.kind === "model.response").map((e) => e.payload.text).join() === SCRIPT.map((t) => t.reply).join(),
      `pi085 rendering: ${show(a.events)}`);
    assert(show(a.events) === show(b.events), `entriesToEvents differ\npi085 ${show(a.events)}\npd    ${show(b.events)}`);
    assert(show(a.callTurns) === show(b.callTurns), `callTurns differ: ${show(a.callTurns)} vs ${show(b.callTurns)}`);
    assert(show(a.api) === show(b.api), `sessionTranscript differs\npi085 ${show(a.api)}\npd    ${show(b.api)}`);
    const turns = (a.api as any).turns;
    assert(turns.length === 2 && turns[1].usage.input_tokens === 20 && turns[1].usage.output_tokens_details.reasoning_tokens === 1, `turns ${show(turns)}`);
    await pi.agent.close(); await pd.agent.close();
  } finally { hosts.pi085.dispose(); hosts.pd.dispose(); }
});

await check("a conversation with tool calls, a failed call and a cancel marker renders the same from pd records as from pi085 entries", () => {
  const u1 = { role: "user", content: "list the files", timestamp: T0 };
  const a1 = assistant([{ type: "thinking", thinking: "I should look" }, { type: "text", text: "Looking." },
    { type: "toolCall", id: "c1", name: "sandbox__shell", arguments: { command: "ls" } }], "toolUse", 1_000, usage(100, 20, 40, 5));
  const r1 = { role: "toolResult", toolCallId: "c1", toolName: "sandbox__shell", content: [{ type: "text", text: "[\"a.txt\"]" }], isError: false, timestamp: T0 + 2_000 };
  const a2 = assistant([{ type: "text", text: "One file: a.txt" }], "stop", 3_500, usage(150, 10));
  const u2 = { role: "user", content: "run js", timestamp: T0 + 10_000 };
  const a3 = assistant([{ type: "toolCall", id: "c2", name: "run_js", arguments: { code: "1" } }], "toolUse", 11_000, usage(10, 5));
  const r2 = { role: "toolResult", toolCallId: "c2", toolName: "run_js", content: [{ type: "text", text: "{\"x\":1}" }], isError: true, timestamp: T0 + 11_500 };
  const a4 = assistant([], "error", 12_000);
  const u3 = { role: "user", content: "write a story", timestamp: T0 + 20_000 };
  const a5 = assistant([{ type: "toolCall", id: "c3", name: "sandbox__shell", arguments: { command: "sleep 9" } }], "toolUse", 21_000, usage(50, 5));
  const messages = [u1, a1, r1, a2, u2, a3, r2, { ...a4, errorMessage: "provider 500" }, u3, a5];

  // pd: what its writers append, with the prompt first and ids from the object's shared counter.
  const records: EntryRecord[] = [record(3, "pi.system", { model: [{ role: "system", content: "", timestamp: T0 }] as any })];
  let id = 5;
  for (const m of messages) {
    const kind = m.role === "user" ? "pi.user" : m.role === "assistant" ? "pi.assistant" : "pi.tool-result";
    records.push(record(id, kind, { model: [m] as any, ...(kind === "pi.tool-result" ? { data: { diagnostics: [] } } : {}) }));
    id += 3;
  }
  records.push(record(id, TURN_CANCELLED, { data: { operationId: "op9" },
    model: [{ role: "user", content: [{ type: "text", text: "[cancelled]" }], timestamp: T0 + 22_000 }] as any }));

  // pi085: the same conversation as pi's storage keeps it — message entries and a custom marker, its own seq.
  let seq = 0;
  const piEntries: any[] = messages.map((m) => ({ type: "message", id: `e${++seq}`, parentId: seq > 1 ? `e${seq - 1}` : null, seq, timestamp: m.timestamp, message: m }));
  piEntries.push({ type: "custom", customType: TURN_CANCELLED, id: `e${++seq}`, parentId: `e${seq - 1}`, seq, timestamp: T0 + 22_000, data: { operationId: "op9" } });

  const pd = projectEntries(records);
  const a = renderings(piEntries), b = renderings(pd);
  const kinds = (a.events as any[]).map((e) => e.kind).join();
  assert(kinds === "message,model.response,tool.result,model.response,message,model.response,js.result,model.failed,message,model.response",
    `the control rendering: ${kinds}`);
  assert(show(a.events) === show(b.events), `entriesToEvents differ\npi085 ${show(a.events)}\npd    ${show(b.events)}`);
  assert(show(a.callTurns) === show(b.callTurns) && Object.keys(a.callTurns as object).length === 3, `callTurns: ${show(a.callTurns)} vs ${show(b.callTurns)}`);
  assert(show(a.api) === show(b.api), `sessionTranscript differs\npi085 ${show(a.api)}\npd    ${show(b.api)}`);
  const statuses = (b.api as any).turns.map((t: any) => t.status).join();
  assert(statuses === "completed,failed,cancelled", `turn statuses on pd: ${statuses}`);
});

// ---- the read-only scan is the engine's view ------------------------------------------------------

await check("readPdEntries reads what DurableAgent.entries() returns, and writes nothing; entries() filters by type and customType", async () => {
  const host = sqliteHost();
  try {
    const { agent } = await converse(host, "pd");
    const viaEngine = await agent.entries({ order: "asc" });
    await agent.close();
    const before = dump(host);
    const read = readPdEntries(host.sql, "main");
    assert(read.length === 4 && show(read) === show(viaEngine), `read ${show(read)}\nengine ${show(viaEngine)}`);
    assert(readPdRecords(host.sql, "task_nope").length === 0, "a session with no conversation read as one");
    assert(dump(host) === before, "the read changed the database");
    assert((await agent.entries({ type: "custom" })).length === 0 && (await agent.entries({ type: "message", order: "desc", limit: 1 }))[0]?.id === viaEngine.at(-1)!.id,
      "entries() did not filter by type");
    const branch = await agent.branch();
    assert(show(branch) === show(viaEngine), `branch ${show(branch)}`);
    await agent.close();
  } finally { host.dispose(); }
});

await check("an object with no pd tables reads as no entries and gains no table", () => {
  const host = sqliteHost();
  assert(readPdEntries(host.sql, "main").length === 0, "an empty object read entries");
  assert(host.sql.exec("SELECT name FROM sqlite_master").toArray().length === 0, "reading created a table");
  host.dispose();
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
