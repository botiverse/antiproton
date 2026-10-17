/**
 * cf/scripts/subagent-trial.mjs: what it reads from an agent's trace rows to compare the agent before and after
 * subagents — per UTC day and in total, the model calls and tokens of the main conversation and of the subagents, the
 * main context per call (median, p90), rebuilds, delegations by kind, child turns by outcome, and report sizes.
 */
import { quantile, summarize } from "../cf/scripts/subagent-trial.mjs";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const DAY1 = Date.parse("2026-10-20T10:00:00Z"), DAY2 = Date.parse("2026-10-21T10:00:00Z");
const call = (at: number, session: string, input: number, output: number) => ({ at, kind: "model.call", status: "stop", attrs: { model: "m1", session, input, output } });
const rows = [
  call(DAY1, "main", 1000, 50), call(DAY1 + 1, "main", 3000, 60), call(DAY1 + 2, "sub_a", 9000, 400),
  { at: DAY1 + 3, kind: "subagent.start", status: "spawn", spanId: "sub_a", parentId: "c1", attrs: { parentSession: "main", turn: 1, how: "spawn" } },
  { at: DAY1 + 4, kind: "subagent.turn", status: "done", spanId: "sub_a", attrs: { parentSession: "main", turn: 1, reportChars: 1200 } },
  { at: DAY1 + 5, kind: "subagent.turn", status: "report_failed", spanId: "sub_a", attrs: { attempts: 1 } },
  { at: DAY1 + 6, kind: "rebuild.decision", status: "ran", attrs: { shadow: false, trigger: "cold-wake" } },
  { at: DAY1 + 7, kind: "rebuild.decision", status: "declined", attrs: { shadow: true } },
  call(DAY2, "main", 2000, 70), call(DAY2 + 1, "sess_api", 5000, 80),
  { at: DAY2 + 2, kind: "subagent.start", status: "follow_up", spanId: "sub_a", parentId: "c2", attrs: { how: "follow_up" } },
  { at: DAY2 + 3, kind: "subagent.start", status: "wake", spanId: "sub_a", attrs: { how: "wake" } },
  { at: DAY2 + 4, kind: "subagent.turn", status: "cancelled", spanId: "sub_a", attrs: { reportChars: 300 } },
  { at: DAY2 + 5, kind: "subagent.turn", status: "stopped", spanId: "sub_b", attrs: { reportChars: 0 } },
];

check("per day and in total: calls and tokens split main and sub, the main context's median and p90, rebuilds that ran", () => {
  const out = summarize(rows);
  must(out.days.map((d: any) => d.day).join() === "2026-10-20,2026-10-21", show(out.days.map((d: any) => d.day)));
  const [d1, d2] = out.days as any[];
  must(show(d1.modelCalls) === show({ main: 2, sub: 1 }) && show(d1.inputTokens) === show({ main: 4000, sub: 9000 }) && show(d1.outputTokens) === show({ main: 110, sub: 400 }), show(d1));
  must(d1.mainInputTokens.median === 1000 && d1.mainInputTokens.p90 === 3000 && d1.rebuilds === 1, show(d1));
  // An Agents API session is one of the agent's own conversations: main, not sub.
  must(show(d2.modelCalls) === show({ main: 2, sub: 0 }), show(d2.modelCalls));
  must(out.total.modelCalls.main === 4 && out.total.inputTokens.main === 11000 && out.total.mainInputTokens.calls === 4, show(out.total));
});

check("delegations by kind, child turns by outcome (a retry is not a turn), report sizes without the stopped", () => {
  const t = summarize(rows).total as any;
  must(show(t.delegations) === show({ spawn: 1, follow_up: 1, wake: 1 }), show(t.delegations));
  must(show(t.childTurns) === show({ done: 1, failed: 0, cancelled: 1, stopped: 1 }), show(t.childTurns));
  must(t.reportChars.total === 1500 && t.reportChars.reports === 2 && t.reportChars.median === 300, show(t.reportChars));
});

check("the window: from <= at < to", () => {
  const t = summarize(rows, { from: DAY2, to: DAY2 + 4 }).total as any;
  must(t.modelCalls.main === 2 && t.delegations.follow_up === 1 && t.childTurns.cancelled === 0, show(t));
  must(quantile([], 0.5) === null && quantile([5, 1, 3], 0.5) === 3 && quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) === 9, "quantile");
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.name}`);
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`); }
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
