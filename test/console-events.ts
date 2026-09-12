/**
 * The events tab, checked as a trace rather than a list.
 *
 * The tab used to dump every record's payload as JSON. It now pairs the
 * calls a model turn issued with the results that came back for them, by
 * call id, and draws them: a waterfall on one time axis, then a card per
 * turn with its calls, each with what was asked, what came back, how long
 * it took and how it ended. The JavaScript the agent ran is shown as code.
 * These checks hold the pairing, the durations, the statuses, and that the
 * raw records are still there underneath.
 */
import { eventList } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const T = 1_789_200_000_000;
const ev = (sequence: number, kind: string, dt: number, payload: any) => ({ sequence, kind, payload, createdAt: T + dt });
const SOURCE = "const issues = await tool`gh.issues.list ${{ repo: \"botiverse/antiproton\", state: \"open\" }}`;\noutput({ count: issues.length, flaky: issues.filter(i => /flaky/.test(i.title)).length });";
const events = [
  ev(1, "message", 0, { text: "Open an issue about the flaky test.", at: T }),
  ev(2, "model.response", 2100, { text: "", reasoning: "I should look at the open issues first.", toolCalls: [
    { id: "call_a", name: "run_js", arguments: { source: SOURCE } },
    { id: "call_b", name: "gh.issues.create", arguments: { repo: "botiverse/antiproton", title: "pi-loop: intermittent timeout on cold start", labels: ["flaky"] } },
  ], usage: { promptTokens: 4120, completionTokens: 210, cachedPromptTokens: 3800, reasoningTokens: 60 }, finishReason: "toolUse", at: T + 2100 }),
  ev(3, "js.result", 3400, { tool: "run_js", callId: "call_a", isError: false, status: "succeeded", outputs: [{ count: 3, flaky: 1 }], at: T + 3400 }),
  ev(4, "tool.result", 5900, { tool: "gh.issues.create", callId: "call_b", isError: false, status: "succeeded", result: { number: 42, url: "https://github.com/botiverse/antiproton/issues/42" }, at: T + 5900 }),
  ev(5, "model.response", 7300, { text: "Opened #42.", usage: { promptTokens: 4400, completionTokens: 40, cachedPromptTokens: 4100 }, finishReason: "stop", at: T + 7300 }),
  ev(6, "message", 20000, { text: "Now close it again.", at: T + 20000 }),
  ev(7, "model.response", 21500, { toolCalls: [{ id: "call_c", name: "run_js", arguments: { source: "await tool`gh.issues.close ${{ number: 42 }}`" } }], usage: { promptTokens: 4600, completionTokens: 30 }, finishReason: "toolUse", at: T + 21500 }),
  ev(8, "js.result", 22000, { tool: "run_js", callId: "call_c", isError: true, status: "failed", outputs: [], error: { code: "tool_error", message: "gh.issues.close: 403 forbidden" }, at: T + 22000 }),
  ev(9, "model.failed", 23000, { error: "upstream: 529 overloaded", at: T + 23000 }),
  ev(10, "compaction", 24000, { summary: "Opened issue #42; closing it failed with 403.", tokensBefore: 9000, at: T + 24000 }),
  ev(11, "tool.result", 25000, { tool: "gh.issues.get", callId: "call_old", isError: false, status: "succeeded", result: { number: 42, state: "open" }, at: T + 25000 }),
];
const html = eventList(events);

check("the summary chips count what the trace contains", () => {
  must(/3 model turns/.test(html), "three model turns");
  must(/2 tool calls/.test(html), "two tool calls: one a turn issued, one whose result arrived without a logged call");
  must(/2 js runs/.test(html), "two js runs");
  must(/2 failed/.test(html), "one failed run and one failed model call");
  must(/4120 \+ 4400 \+ 4600|13120 in/.test(html), "prompt tokens summed");
});

check("every call a turn issued is paired with its result by call id, with a duration and a status", () => {
  must(/id="call-call_a"[\s\S]*?run_js[\s\S]*?<span class="badge ok">ran<\/span>[\s\S]*?\+2\.1s · 1\.3s/.test(html), "run_js call_a: ran, issued at +2.1s, took 1.3s");
  must(/id="call-call_b"[\s\S]*?gh\.issues\.create[\s\S]*?<span class="badge ok">ok<\/span>[\s\S]*?\+2\.1s · 3\.8s/.test(html), "gh.issues.create: ok, took 3.8s");
  must(/id="call-call_c"[\s\S]*?<span class="badge bad">failed<\/span>/.test(html), "the failed run says failed");
  must(/gh\.issues\.close: 403 forbidden/.test(html), "the error message is on the failed run");
  must(count(html, /class="call /g) === 4, `four call rows (three issued, one orphan), got ${count(html, /class="call /g)}`);
});

check("the JavaScript the agent ran is shown as code, open, and its outputs under it", () => {
  const a = /id="call-call_a"([\s\S]*?)<\/div>\s*<div class="call|id="call-call_a"([\s\S]*?)$/.exec(html)!;
  const block = a[1] ?? a[2] ?? "";
  must(/<details open><summary>source<\/summary><pre class="code">/.test(block), "source is open by default");
  must(/tool`gh\.issues\.list/.test(block.replace(/&#96;|&grave;/g, "`")) || /gh\.issues\.list/.test(block), "the source is the agent's, verbatim");
  must(/&quot;count&quot;: 3/.test(block), "the outputs are under it");
  must(!/<script/.test(html), "nothing the agent wrote runs on this page");
});

check("a result with no matching call is shown on its own rather than dropped", () => {
  must(/id="call-call_old"[\s\S]*?gh\.issues\.get/.test(html), "the orphan result has a row");
});

check("the waterfall has a bar per turn and per call, on one axis, linking to the cards", () => {
  must(count(html, /class="wf-row"/g) === 7, `three turns + four calls = seven bars, got ${count(html, /class="wf-row"/g)}`);
  must(/href="#call-call_old"/.test(html), "the orphan result has a bar too");
  must(/href="#turn-1"/.test(html) && /href="#call-call_b"/.test(html), "bars link to cards");
  must(/<i class="js"/.test(html) && /<i class="model"/.test(html) && /<i class="op"/.test(html), "bars are coloured by kind");
  must(/<i class="js bad"/.test(html), "the failed run's bar is red");
  must(/<span>25\.0s<\/span>/.test(html), "the axis ends at the last record");
});

check("what the person said, a model failure and a compaction each have their own row", () => {
  must(/<div class="step user">[\s\S]*?Open an issue about the flaky test\./.test(html), "the person's message");
  must(/<div class="step fail">[\s\S]*?529 overloaded/.test(html), "the model failure");
  must(/compaction[\s\S]*?9000 tokens before/.test(html), "the compaction with its size");
});

check("the raw records are still there, closed, and the empty state still reads", () => {
  must(/<details class="raw"><summary>raw records · 11<\/summary>/.test(html), "raw section with the count");
  must(count(html, /<div class="ev">/g) === 11, "one raw row per record");
  must(eventList([]) === `<div class="empty">no events</div>`, "empty state");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
