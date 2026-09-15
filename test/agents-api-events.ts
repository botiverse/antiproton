/**
 * Session events as a diff between reads (task #17, step 3): no replay of what
 * the client already has, the order the SDK relies on, and a stream that ends
 * where the SDK's helper stops.
 */
import { eventsBetween, pumpSessionEvents, type Snapshot } from "../cf/src/agents-api/events.ts";
import { sessionTranscript } from "../cf/src/agents-api/transcript.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

let seq = 0;
const entry = (message: Record<string, unknown>) => ({ type: "message", id: `e${++seq}`, parentId: null, seq, timestamp: 1_757_840_000_000 + seq * 1000, message });
const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }] });
const ids = { sessionId: "sess_1", agentId: "ag_1" };
const snap = (entries: unknown[], running: boolean): Snapshot => ({ ...sessionTranscript({ entries, running }, ids), status: running ? "in_progress" : "idle" });
let n = 0;
const eventId = () => `evt_${++n}`;
const sessionWith = (status: string) => ({ id: "sess_1", object: "agent.session", status });

/**
 * The SDK's own stop rule, re-implemented: follow the first turn created; stop at its end followed by idle.
 * Depends on: openai 7.15.0 — lib/agents/turn-state.js (TurnState.accept / terminal). When it changes,
 *   update this function to match, then re-check cf/src/agents-api/events.ts.
 */
function sdkStopsAt(events: Array<{ type: string; turn_id?: unknown }>): number {
  let turn: unknown, ended = false;
  for (const [i, e] of events.entries()) {
    if (e.type === "agent.session.turn.created" && turn === undefined) turn = e.turn_id;
    if (/^agent\.session\.turn\.(completed|failed|cancelled)$/.test(e.type) && turn !== undefined && e.turn_id === turn) ended = true;
    if (e.type === "agent.session.failed" || (e.type === "agent.session.idle" && ended)) return i;
  }
  return -1;
}

const history = [user("earlier"), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done before" }] })];

await check("what the client already has is not sent again", () => {
  const base = snap(history, false);
  const events = eventsBetween(base, snap(history, false), ids, sessionWith, eventId);
  assert(events.length === 0, `replayed: ${events.map((e) => e.type)}`);
});

await check("a turn run from idle: created, items, text, done, completed, then idle — and the SDK stops exactly at that idle", () => {
  const base = snap(history, false);
  const started = [...history, user("list files")];
  const midway = [...started, entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "shell", arguments: { command: "ls" } }] })];
  const finished = [...midway,
    entry({ role: "toolResult", toolCallId: "c1", toolName: "shell", isError: false, content: [{ type: "text", text: "a.txt" }] }),
    entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "One file." }] })];
  const reads = [snap(started, true), snap(midway, true), snap(finished, false)];
  const all: any[] = [];
  let prev = base;
  for (const next of reads) { all.push(...eventsBetween(prev, next, ids, sessionWith, eventId)); prev = next; }
  const types = all.map((e) => e.type.replace("agent.session.", ""));
  assert(types.join() === [
    "in_progress", "turn.created", "turn.in_progress", "turn.item.added",
    "turn.item.added",
    "turn.item.done", "turn.item.added", "turn.item.added", "turn.output_text.delta", "turn.output_text.done", "turn.item.done",
    "turn.completed", "idle",
  ].join(), `order: ${types}`);
  assert(sdkStopsAt(all) === all.length - 1, `the SDK would stop at ${sdkStopsAt(all)} of ${all.length}`);
  assert(all[1].turn.id === all[1].turn_id && all[11].usage === null && all[12].session.status === "idle", "event payloads");
  assert(new Set(all.map((e) => e.event_id)).size === all.length, "event ids repeat, and the SDK drops repeats");
  assert(all.every((e) => !("error" in e)), "a top-level error field makes the SDK throw");
});

await check("a turn queued and finished between two reads still ends with idle", () => {
  const base = snap(history, false);
  const next = snap([...history, user("quick"), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] })], false);
  const events = eventsBetween(base, next, ids, sessionWith, eventId);
  assert(events[events.length - 1]?.type === "agent.session.idle", `last: ${events.map((e) => e.type)}`);
  assert(sdkStopsAt(events) === events.length - 1, "the SDK would not stop");
});

await check("a turn already running when the client connected ends, but does not end the SDK's iteration", () => {
  // The client never saw it created, so it is not the turn the SDK follows.
  const base = snap(history, true);
  const events = eventsBetween(base, snap(history, false), ids, sessionWith, eventId);
  assert(events.map((e) => e.type).join() === "agent.session.turn.completed,agent.session.idle", `events: ${events.map((e) => e.type)}`);
  assert(sdkStopsAt(events) === -1, "a turn the client never saw created ended the iteration");
});

await check("the pump writes SSE frames, reads again quickly while work runs, keeps the line alive, and stops at its ceiling", async () => {
  const base = snap(history, false);
  const reads = [snap([...history, user("go")], true), snap([...history, user("go")], true)];
  let clock = 0; const sleeps: number[] = []; const written: string[] = [];
  const outcome = await pumpSessionEvents({
    baseline: base, sessionId: "sess_1", sessionWith, eventId, maxMs: 40_000,
    read: async () => reads[Math.min(reads.length - 1, sleeps.length - 1)]!,
    write: async (t) => { written.push(t); },
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  assert(outcome === "ceiling", `outcome ${outcome}`);
  assert(/^event: agent\.session\.in_progress\ndata: \{.*\}\n\n/.test(written[0] ?? ""), `first frame: ${JSON.stringify(written[0])}`);
  assert(sleeps.every((ms) => ms === 1000), `delays while running: ${sleeps}`);
  assert(written.some((t) => t === ": keepalive\n\n"), "no keepalive over 40 s of silence");
});

await check("a client that goes away ends the pump", async () => {
  let clock = 0;
  const outcome = await pumpSessionEvents({
    baseline: snap(history, true), sessionId: "sess_1", sessionWith, eventId,
    read: async () => snap(history, false),
    write: async () => { throw new Error("stream closed"); },
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  assert(outcome === "closed", `outcome ${outcome}`);
});

await check("a call for the caller: the call is shown, then requires_action; its result continues the turn through idle, where the SDK stops", () => {
  const base = snap(history, false);
  const callMsg = entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "cw", name: "get_weather", arguments: { city: "Oslo" } }] });
  const asked = user("weather?");
  const placeholder = entry({ role: "toolResult", toolCallId: "cw", toolName: "get_weather", isError: true, content: [{ type: "text", text: "waiting" }] });
  const waitingEntries = [...history, asked, callMsg, placeholder];
  const pending = [{ call_id: "cw", name: "get_weather", arguments: "{\"city\":\"Oslo\"}", turn_id: `turn_${asked.seq}` }];
  const waiting: Snapshot = { ...sessionTranscript({ entries: waitingEntries, running: false, pending }, ids), status: "requires_action", pending };
  const first = eventsBetween(base, waiting, ids, sessionWith, eventId);
  const types = first.map((e) => e.type.replace("agent.session.", ""));
  assert(types.at(-1) === "requires_action" && types.includes("turn.item.added"), `events: ${types}`);
  assert(!first.some((e) => (e as any).item?.type === "function_call_output"), "the placeholder was sent as the call's output");
  assert(sdkStopsAt(first) === -1, "the SDK would stop while its function is still to run");
  // After the result: the branch no longer has the placeholder.
  const done = [...history, asked, callMsg,
    entry({ role: "toolResult", toolCallId: "cw", toolName: "get_weather", isError: false, content: [{ type: "text", text: "sunny" }] }),
    entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Sunny in Oslo." }] })];
  const second = eventsBetween(waiting, snap(done, false), ids, sessionWith, eventId);
  const all = [...first, ...second];
  const doneTypes = second.map((e) => e.type.replace("agent.session.", ""));
  assert(doneTypes.includes("turn.item.done") && doneTypes.includes("turn.completed") && doneTypes.at(-1) === "idle", `after: ${doneTypes}`);
  assert(second.some((e) => (e as any).item?.type === "function_call_output" && (e as any).item.output === "sunny"), "the real output was not sent");
  assert(sdkStopsAt(all) === all.length - 1, `the SDK would stop at ${sdkStopsAt(all)} of ${all.length}`);
});

await check("with change notices the pump waits for them instead of sleeping, and reads as soon as one arrives", async () => {
  const reads: number[] = []; const waits: number[] = []; let sleeps = 0; let clock = 0;
  const started = snap([...history, user("go")], true);
  const outcome = await pumpSessionEvents({
    baseline: snap(history, false), sessionId: "sess_1", sessionWith, eventId, maxMs: 30_000,
    // The fake clock moves on every read and sleep too, so a pump that ignores notices reaches its ceiling and
    // fails the assertions below instead of spinning for ever.
    read: async () => { reads.push(clock); clock += 10; return started; },
    write: async () => {},
    sleep: async (ms) => { sleeps++; clock += ms; },
    wait: async (ms) => { waits.push(ms); clock += 1_000; return "changed"; },
    now: () => clock,
  });
  assert(outcome === "ceiling" && sleeps === 0, `the pump slept ${sleeps} times despite change notices`);
  assert(waits.length === reads.length && waits.length > 0, `waits ${waits.length} vs reads ${reads.length}`);
  assert(waits[0] === 15_000 && waits[1] === 5_000, `fallbacks: idle first then active: ${waits.slice(0, 3)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
