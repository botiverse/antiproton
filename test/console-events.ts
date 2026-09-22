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
import { eventList, trajectory } from "../cf/src/ui.ts";

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

/**
 * The identity a failed call was made with, drawn on that call.
 *
 * It arrives on `operation.completed` rather than on the result, because the
 * tool's envelope is a string by the time the transcript sees it. The two
 * events share `callId` and nothing else, so these checks hold the join, the
 * three states worth a badge, the one that is deliberately not drawn, and that
 * the page never matches the plugin's wording.
 */
const anon = (callId: string, identity: string, credentialRef?: string) =>
  ev(30, "operation.completed", 22500, { operationId: "op_x", status: "failed", resultRef: null, callId, identity, ...(credentialRef ? { credentialRef } : {}) });
const withIdentity = (identity: string, credentialRef?: string) =>
  eventList([...events, anon("call_c", identity, credentialRef)]);
const rowOf = (h: string, id: string) => {
  const from = h.indexOf(`id="call-${id}"`);
  if (from < 0) throw new Error(`no row for ${id}`);
  const next = h.indexOf('<div class="call ', from);
  return h.slice(from, next < 0 ? h.length : next);
};

check("an anonymous failure says so on the call, and the title says who can fix it", () => {
  const none = rowOf(withIdentity("none"), "call_c");
  must(/<span class="badge" title="[^"]*attaches an account[^"]*">anonymous · no account<\/span>/.test(none),
    `the badge names the state and the action: ${none.slice(0, 400)}`);

  const deployed = rowOf(withIdentity("unreadable", "operator"), "call_c");
  must(/>anonymous · credential unreadable</.test(deployed), "a credential that did not arrive is not a missing account");
  must(/title="[^"]*whoever deploys[^"]*will not help[^"]*"/.test(deployed),
    "an operator credential sends the reader to whoever deploys, and rules out the wrong fix");

  const mine = rowOf(withIdentity("unreadable", "agent"), "call_c");
  must(/title="[^"]*write it again[^"]*"/.test(mine), "an agent credential sends the reader to whoever holds it");
  must(!/attaches an account/.test(mine), "and never says attach, which is the one action that cannot help here");
});

check("a call that did use an account says that too, without a warning", () => {
  const row = rowOf(withIdentity("attached"), "call_c");
  must(/<span class="badge" title="[^"]*was used[^"]*">account used<\/span>/.test(row), "plain badge: this is not a misconfiguration");
  must(!/badge warn[^>]*>account used/.test(row), "an account that was used is not a warning");
  must(!/badge warn[^>]*>anonymous/.test(withIdentity("none")), "nor is the identity itself an alarm: the status badge already carries that");
});

check("nothing reported draws nothing, and a trace with no identity is untouched", () => {
  must(!/account used|anonymous ·/.test(withIdentity("unreported")),
    "`unreported` means nobody said; a badge would claim the page found out");
  must(!/account used|anonymous ·/.test(html), "a trace whose records carry no identity gains nothing");
  must(!/account used|anonymous ·/.test(eventList([...events, ev(31, "operation.completed", 22500, { operationId: "op_x", status: "failed", resultRef: null, identity: "none" })])),
    "an identity with no callId cannot be tied to a call, so it is not drawn on one");
});

check("one call id can cover several operations, so a badge needs them to agree", () => {
  // A `run_js` script's host calls are all recorded under the id of the one
  // tool call the model issued, and they can hit different mounts. An identity
  // belongs to a mount, so one row may only claim one when they all say it.
  const two = (a: any, b: any) => eventList([...events,
    { sequence: 30, kind: "operation.completed", payload: { operationId: "op_1", status: "failed", resultRef: null, callId: "call_c", ...a }, createdAt: T + 22500 },
    { sequence: 31, kind: "operation.completed", payload: { operationId: "op_2", status: "failed", resultRef: null, callId: "call_c", ...b }, createdAt: T + 22600 }]);

  const agree = rowOf(two({ identity: "none" }, { identity: "none" }), "call_c");
  must(/>anonymous · no account</.test(agree), "two operations saying the same thing is still one fact");
  must(count(agree, /anonymous · no account/g) === 1, "and it is said once, not once per operation");

  must(!/account used|anonymous ·/.test(two({ identity: "none" }, { identity: "attached" })),
    "two mounts disagreeing is not something one badge can say truthfully");
  must(!/account used|anonymous ·/.test(two({ identity: "unreadable", credentialRef: "agent" }, { identity: "unreadable", credentialRef: "operator" })),
    "same state, different people to fix it: the badge would send half the readers to the wrong one");
  must(!/account used|anonymous ·/.test(two({ identity: "none" }, { identity: "attached" }, )),
    "and the last one to arrive does not win");
  must(!/account used|anonymous ·/.test(eventList([...events,
    { sequence: 30, kind: "operation.completed", payload: { operationId: "op_1", status: "failed", resultRef: null, callId: "call_c", identity: "none" }, createdAt: T + 22500 },
    { sequence: 31, kind: "operation.completed", payload: { operationId: "op_2", status: "failed", resultRef: null, callId: "call_c", identity: "attached" }, createdAt: T + 22600 },
    { sequence: 32, kind: "operation.completed", payload: { operationId: "op_3", status: "failed", resultRef: null, callId: "call_c", identity: "none" }, createdAt: T + 22700 }])),
    "a third operation agreeing with the first does not revive a claim the second broke");
});

check("the identity is keyed on the call, not on the wording or the order", () => {
  const other = rowOf(withIdentity("none"), "call_a");
  must(!/account used|anonymous ·/.test(other), "the badge lands on the call the record names, not on its neighbours");
  const t = trajectory([...events, anon("call_c", "none")], {});
  must(/>anonymous · no account</.test(t), "the transcript view draws it too, where a person watches a run");
  must(!/operation\.completed/.test(t), "and the completion itself is still not a step of its own");
});

/** The tool step of the transcript view, by the label the view gives it. */
const toolStep = (html: string, tool: string) =>
  html.split('<div class="step').map((s) => `<div class="step${s}`)
    .find((s) => s.includes(`tool ${tool}`)) ?? "";

check("the transcript view shows what a tool returned, and never the word undefined", () => {
  // `tool.result` carries the return under `result`. This reader asked for
  // `content` — the name the payload had before the loop became pi's — so every
  // tool step drew `<pre>undefined</pre>`. Nothing failed: the element was
  // there, with a word in it.
  const step = toolStep(trajectory(events, {}), "gh.issues.create");
  must(step, "the tool call has no step in the transcript view at all");
  must(/<pre>[\s\S]*?&quot;number&quot;: 42[\s\S]*?<\/pre>/.test(step),
    `the result body does not carry what the tool returned: ${step.slice(0, 200)}`);
  must(!/undefined/.test(step), `the step prints the word undefined: ${step.slice(0, 200)}`);
});

check("a call waiting on approval is drawn as held in the transcript view too", () => {
  // The held check reads the same body, so the missing field cost the badge as
  // well as the text — and this is the one a person is watching for.
  const held = ev(12, "tool.result", 26000, { tool: "gh.issues.close", callId: "call_h",
    isError: false, status: "succeeded", result: { status: "awaiting_approval" }, at: T + 26000 });
  const step = toolStep(trajectory([...events, held], {}), "gh.issues.close");
  must(/class="step held"/.test(step), `a held call is not drawn as held: ${step.slice(0, 160)}`);
  must(/held for approval/.test(step), "the badge must say why it is waiting");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
