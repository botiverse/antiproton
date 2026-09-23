/**
 * What postMessage reports, from the shapes PiAgent.say actually returns.
 *
 * The refusal case is the one that matters: on 2026-09-22 two τ² trials posted
 * an empty user message, the lane refused it, and the report said "queued".
 * The judgement is a pure function so the shape a lane returns can be handed
 * to it here without a bound runtime, a model, or an object.
 */
import { messageLanded } from "../cf/src/runtime.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }); }
}

// The shapes, as the harness returns them (test/pi-agent.ts drives the real ones).
const admitted = { ok: true, value: { operationId: "op-1", kind: "run", startedAt: 1 } };
const queued = { ok: true, value: { entryId: "e-1" } };
const refusedEmpty = {
  ok: false,
  error: { _tag: "InvalidMessage", name: "InvalidMessage", lane: "main", reason: "empty",
    message: "Acceptance must append at least one message" },
};

check("a run admitted is a prompt, not queued", () => {
  const r = messageLanded(admitted, "prompt");
  if (r.mode !== "prompt" || r.queued) throw new Error(JSON.stringify(r));
});

check("a message the lane queued is reported under the mode it joined", () => {
  const s = messageLanded(queued, "steer");
  if (s.mode !== "steer" || !s.queued) throw new Error(JSON.stringify(s));
  const f = messageLanded(queued, "followUp");
  if (f.mode !== "followUp" || !f.queued) throw new Error(JSON.stringify(f));
  // A prompt that found the lane busy was steered by say(): no operation id, so it is queued.
  const p = messageLanded(queued, "prompt");
  if (p.mode !== "steer" || !p.queued) throw new Error(JSON.stringify(p));
});

check("a refusal is thrown with the lane's own tag, never reported as queued", () => {
  let threw: Error | null = null;
  try { messageLanded(refusedEmpty, "prompt"); } catch (e) { threw = e as Error; }
  if (!threw) throw new Error("an InvalidMessage result was reported as landed");
  if (!threw.message.includes("InvalidMessage") || !threw.message.includes("at least one message")) {
    throw new Error(`the refusal lost its reason: ${threw.message}`);
  }
});

check("no result at all is not a refusal (a followUp returns nothing to judge)", () => {
  const r = messageLanded(undefined, "followUp");
  if (r.mode !== "followUp" || !r.queued) throw new Error(JSON.stringify(r));
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
