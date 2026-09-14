/**
 * A session's pi entries as Agents API items and turns (task #17): turn
 * boundaries, statuses, usage, and item shapes the SDK reads.
 */
import { sessionTranscript, TURN_CANCELLED } from "../cf/src/agents-api/transcript.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const T0 = 1_757_840_000_000;
let seq = 0;
const entry = (message: Record<string, unknown>, atMs: number) => ({ type: "message", id: `e${++seq}`, parentId: null, seq, timestamp: T0 + atMs, message });
const user = (text: string, at: number) => entry({ role: "user", content: [{ type: "text", text }] }, at);
const usage = (input: number, output: number, cacheRead = 0, reasoning = 0) => ({ input, output, cacheRead, reasoning });

const entries = [
  // turn 1: think, say something, call a tool, get the result, answer
  user("list the files", 0),
  entry({ role: "assistant", stopReason: "toolUse", usage: usage(100, 20, 40, 5), content: [
    { type: "thinking", thinking: "I should look" }, { type: "text", text: "Looking." },
    { type: "toolCall", id: "c1", name: "sandbox__shell", arguments: { command: "ls" } }] }, 1_000),
  entry({ role: "toolResult", toolCallId: "c1", toolName: "sandbox__shell", isError: false, content: [{ type: "text", text: "a.txt" }] }, 2_000),
  entry({ role: "assistant", stopReason: "stop", usage: usage(150, 10), content: [{ type: "text", text: "One file: a.txt" }] }, 3_500),
  // a compaction between turns is not an item
  { type: "compaction", id: "cx", parentId: null, seq: ++seq, timestamp: T0 + 4_000, summary: "s", retainedTail: [], tokensBefore: 1 },
  // turn 2: the model call fails
  user("again", 10_000),
  entry({ role: "assistant", stopReason: "error", errorMessage: "provider 500", content: [] }, 11_000),
  // turn 3: a tool call still out
  user("run the tests", 20_000),
  entry({ role: "assistant", stopReason: "toolUse", usage: usage(200, 30), content: [
    { type: "toolCall", id: "c2", name: "sandbox__shell", arguments: { command: "npm test" } }] }, 21_000),
];
const ids = { sessionId: "sess_1", agentId: "ag_1" };

await check("turns split at user messages, with status, timestamps, error and summed usage", () => {
  const { turns } = sessionTranscript({ entries, running: true }, ids);
  assert(turns.map((t) => t.status).join() === "completed,failed,in_progress", `statuses ${turns.map((t) => t.status)}`);
  const [one, two, three] = turns;
  assert(one!.id === "turn_1" && one!.object === "agent.session.turn" && one!.session_id === "sess_1" && one!.agent_id === "ag_1", `turn 1 ids ${JSON.stringify(one)}`);
  assert(one!.created_at === Math.floor(T0 / 1000) && one!.completed_at === Math.floor((T0 + 3_500) / 1000), `turn 1 times ${one!.created_at} ${one!.completed_at}`);
  assert(one!.usage?.input_tokens === 250 && one!.usage.output_tokens === 30 && one!.usage.total_tokens === 280
    && one!.usage.input_tokens_details.cached_tokens === 40 && one!.usage.output_tokens_details.reasoning_tokens === 5, `usage ${JSON.stringify(one!.usage)}`);
  assert(two!.error?.message === "provider 500" && two!.usage === null, `turn 2 ${JSON.stringify(two)}`);
  assert(three!.completed_at === null && three!.error === null, `turn 3 ${JSON.stringify(three)}`);
});

await check("items: user message, reasoning, commentary, function call and output, final answer, in order", () => {
  const { items } = sessionTranscript({ entries, running: true }, ids);
  const kinds = items.map((i) => `${i.type}${i.role ? `:${i.role}` : ""}${i.phase ? `:${i.phase}` : ""}`);
  assert(kinds.join() === [
    "message:user", "reasoning", "message:assistant:commentary", "function_call", "function_call_output", "message:assistant:final_answer",
    "message:user",
    "message:user", "function_call",
  ].join(), `kinds ${kinds}`);
  assert(new Set(items.map((i) => i.id)).size === items.length, "item ids repeat, so an after cursor could not find its place");
  const call = items[3]!;
  assert(call.call_id === "c1" && call.name === "sandbox__shell" && call.arguments === JSON.stringify({ command: "ls" }) && call.status === "completed", `call ${JSON.stringify(call)}`);
  const out = items[4]!;
  assert(out.call_id === "c1" && out.output === "a.txt" && out.error === null && out.status === "completed", `output ${JSON.stringify(out)}`);
  assert((items[5]!.content as any)[0].type === "output_text" && (items[5]!.content as any)[0].text === "One file: a.txt", "final answer content");
  assert(items.every((i) => i.turn_id.startsWith("turn_")) && items[6]!.turn_id === "turn_6", `turn ids ${items.map((i) => i.turn_id)}`);
  assert(items[8]!.status === "in_progress", `open call ${items[8]!.status}`);
});

await check("a finished turn with an unanswered call leaves it incomplete, not in progress", () => {
  const { items, turns } = sessionTranscript({ entries: [
    user("go", 0),
    entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c9", name: "x", arguments: {} }] }, 1_000),
    entry({ role: "assistant", stopReason: "aborted", content: [] }, 2_000),
  ], running: false }, ids);
  assert(turns[0]!.status === "cancelled", `status ${turns[0]!.status}`);
  assert(items.find((i) => i.type === "function_call")!.status === "incomplete", "an abandoned call still reads in progress");
});

await check("a prompt not yet picked up is queued; the last turn is in progress while the lane runs even after a stop", () => {
  const queued = sessionTranscript({ entries: [user("hello", 0)], running: false }, ids).turns[0]!;
  assert(queued.status === "queued" && queued.started_at === null, `queued ${JSON.stringify(queued)}`);
  const steering = sessionTranscript({ entries: [
    user("hello", 0), entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] }, 1_000),
  ], running: true }, ids).turns[0]!;
  assert(steering.status === "in_progress" && steering.completed_at === null, `running ${JSON.stringify(steering)}`);
});

await check("a failed tool result is reported as an error, not as output", () => {
  const { items } = sessionTranscript({ entries: [
    user("go", 0),
    entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c3", name: "x", arguments: {} }] }, 1_000),
    entry({ role: "toolResult", toolCallId: "c3", toolName: "x", isError: true, content: [{ type: "text", text: "denied" }] }, 2_000),
  ], running: true }, ids);
  const out = items.find((i) => i.type === "function_call_output")!;
  assert(out.status === "failed" && out.output === null && out.error === "denied", `output ${JSON.stringify(out)}`);
});

await check("a turn with the cancel marker is cancelled, its open call incomplete, and the marker is not an item", () => {
  // What pi leaves after an abort (measured): the user message, deferred placeholders, and nothing else.
  const { items, turns } = sessionTranscript({ entries: [
    user("go", 0),
    entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c7", name: "x", arguments: {} }] }, 1_000),
    entry({ role: "assistant", stopReason: "deferred", content: [] }, 1_500),
    { type: "custom", customType: TURN_CANCELLED, id: "m", parentId: null, seq: ++seq, timestamp: T0 + 2_000, data: { operationId: "op" } },
    user("next", 3_000),
  ], running: true }, ids);
  assert(turns[0]!.status === "cancelled" && turns[0]!.completed_at === Math.floor((T0 + 2_000) / 1000), `turn ${JSON.stringify(turns[0])}`);
  assert(turns[1]!.status === "in_progress", `the next turn ${turns[1]!.status}`);
  assert(items.find((i) => i.type === "function_call")!.status === "incomplete", "the open call still reads in progress");
  assert(items.length === 3, `items ${items.map((i) => i.type)}`);
  const bare = sessionTranscript({ entries: [user("go", 0), { type: "custom", customType: TURN_CANCELLED, id: "m2", parentId: null, seq: ++seq, timestamp: T0 + 500 }], running: false }, ids);
  assert(bare.turns[0]!.status === "cancelled", `a turn cancelled before any reply: ${bare.turns[0]!.status}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
