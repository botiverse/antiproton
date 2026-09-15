/**
 * The runners' poll fallback takes a turn's answer when the push was lost, and never a previous turn's answer.
 */
import { decideFromPoll } from "../bench/poll-fallback.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const turn = [
  { sequence: 4, kind: "message" },
  { sequence: 28, kind: "model.response" },
  { sequence: 37, kind: "message" },
  { sequence: 61, kind: "model.response" },
  { sequence: 71, kind: "tool.result" },
  { sequence: 193, kind: "model.response" },
];

await check("the lost final answer is taken from poll (the stalled trial: answered at seq 193, socket stopped at 71)", () => {
  const d = decideFromPoll({ status: "idle", answer: "Your exchange has been submitted.", events: turn }, 71);
  assert(d?.kind === "answer" && d.text.startsWith("Your exchange") && d.seq === 193, `decision: ${JSON.stringify(d)}`);
});

await check("a previous turn's answer is never taken: a new message with no reply after it yet", () => {
  const events = [...turn, { sequence: 210, kind: "message" }];
  const d = decideFromPoll({ status: "idle", answer: "Your exchange has been submitted.", events }, 193);
  assert(d === null, `a stale answer ended the new turn: ${JSON.stringify(d)}`);
});

await check("nothing while the object is still running, or once the socket already delivered that answer", () => {
  assert(decideFromPoll({ status: "running", answer: null, events: turn }, 71) === null, "a running turn was treated as answered");
  assert(decideFromPoll({ status: "idle", answer: "x", events: turn }, 193) === null, "an answer the socket delivered was taken again");
});

await check("a failed model call after the latest message ends the turn as failed", () => {
  const events = [{ sequence: 4, kind: "message" }, { sequence: 9, kind: "model.failed" }];
  const d = decideFromPoll({ status: "idle", answer: null, events }, 4);
  assert(d?.kind === "failed" && d.seq === 9, `decision: ${JSON.stringify(d)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
