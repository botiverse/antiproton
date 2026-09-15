/**
 * Function tools the caller runs (Agents API, task #17 step 5), on a real pi lane:
 * a call pauses the turn without holding the step, the caller's result continues
 * it with a clean model context, and an early result never pauses at all.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import {
  answerClientCall, CLIENT_PENDING, clientTools, dropClientCalls, pendingClientCalls, resumeClientCalls,
} from "../src/runtime/client-calls.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 600) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
const USAGE = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const WHO = { api: "offloaded", provider: MODEL.provider, id: MODEL.id } as any;
const SESSION = "main";

async function fixture() {
  const host = sqliteHost();
  const ref: { agent: PiAgent | null } = { agent: null };
  const weather = clientTools(
    [{ name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    { sql: host.sql as any, session: SESSION, lane: () => ref.agent!.lane as any,
      branch: (tip) => ref.agent!.storage.scanBranch({ start: tip, order: "oldestFirst" }, CTX) as any });
  const lookup = {
    name: "lookup", label: "lookup", description: "runs here", parameters: { type: "object", properties: {} } as any,
    async execute() { return { content: [{ type: "text" as const, text: "\"found\"" }], details: {} }; },
  };
  const agent = await PiAgent.open({
    host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: [], extraTools: [...weather, lookup] as any,
    toolHost: { async invoke() { return { status: "succeeded", result: {} }; } }, async dispatch() {},
  });
  ref.agent = agent;
  const pending = () => host.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray() as any[];
  const reply = (r: { text?: string; toolCalls?: any[] }) => {
    const job = pending()[0];
    assert(job, "no model call was waiting");
    agent.takeJob(String(job.id));
    agent.deliver(String(job.id), fromResponse({ text: r.text ?? "", finishReason: r.toolCalls ? "tool_calls" : "stop", truncated: false, toolCalls: r.toolCalls, usage: USAGE } as any, WHO));
  };
  const nextRequest = () => {
    const job = pending()[0];
    return job ? (agent.takeJob(String(job.id)) as any) : null;
  };
  const resume = () => resumeClientCalls({
    sql: host.sql as any, session: SESSION, lane: agent.lane as any,
    branch: (tip) => agent.storage.scanBranch({ start: tip, order: "oldestFirst" }, CTX) as any,
  });
  return { host, agent, reply, nextRequest, resume, pending };
}
const roles = (req: any) => (req?.context?.messages ?? []).map((m: any) => `${m.role}${m.toolCallId ? `:${m.toolCallId}` : ""}`);

await check("a client call pauses the turn and the step returns; the caller's result continues it with a clean context", async () => {
  const f = await fixture();
  await f.agent.say("weather in Paris?");
  await f.agent.step();
  f.reply({ toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }] });
  const t0 = Date.now();
  const paused = await Promise.race([f.agent.step(), new Promise((r) => setTimeout(() => r("hung"), 5000))]);
  const pauseMs = Date.now() - t0;
  assert(paused !== "hung", "the step waited for the caller");
  // The pause ends when the abort lands, not on a timer: a wait that misses the abort runs to its 2 s cap,
  // and the caller then sees every function's output 2 s late (preview, 2026-09-15).
  assert(pauseMs < 1000, `pausing took ${pauseMs} ms: the tool waited out its cap instead of the abort`);
  assert((await f.agent.lane.inspectExecution(CTX)).current === null, "the run is still current while waiting for the caller");
  const waiting = pendingClientCalls(f.host.sql as any, SESSION);
  assert(waiting.length === 1 && waiting[0]!.call_id === "call_1" && waiting[0]!.name === "get_weather" && JSON.parse(waiting[0]!.arguments).city === "Paris",
    `waiting: ${JSON.stringify(waiting)}`);
  assert(!(await f.resume()), "resumed before the caller answered");

  assert(answerClientCall(f.host.sql as any, SESSION, "call_1", { output: "{\"temp\":21}", isError: false }), "the answer was refused");
  assert(!answerClientCall(f.host.sql as any, SESSION, "call_1", { output: "again", isError: false }), "a second answer to the same call was taken");
  assert(await f.resume(), "all calls answered, but the turn did not continue");
  await f.agent.step();
  const req = f.nextRequest();
  assert(roles(req).join() === "user,assistant,toolResult:call_1", `the model saw ${roles(req)}`);
  assert(!JSON.stringify(req).includes(CLIENT_PENDING), "the placeholder reached the model");
  assert(JSON.stringify(req).includes("{\\\"temp\\\":21}"), "the caller's result did not reach the model");
  assert(pendingClientCalls(f.host.sql as any, SESSION).length === 0 && !(await f.resume()), "the call was left waiting");
  await f.agent.close();
});

await check("a result that arrives before the tool runs is used at once, and nothing pauses", async () => {
  const f = await fixture();
  answerClientCall(f.host.sql as any, SESSION, "call_2", { output: "sunny", isError: false });
  await f.agent.say("weather?");
  await f.agent.step();
  f.reply({ toolCalls: [{ id: "call_2", name: "get_weather", arguments: { city: "Oslo" } }] });
  const out = await f.agent.step();
  assert(!out.settled.some((s) => s.status === "aborted"), `the run was aborted: ${JSON.stringify(out)}`);
  const req = f.nextRequest();
  assert(roles(req).join() === "user,assistant,toolResult:call_2" && JSON.stringify(req).includes("sunny"), `the model saw ${roles(req)}`);
  assert(!(await f.resume()), "an early answer was treated as a pause");
  await f.agent.close();
});

await check("in a mixed batch the call that ran here keeps its result when the turn continues", async () => {
  const f = await fixture();
  await f.agent.say("both");
  await f.agent.step();
  f.reply({ toolCalls: [{ id: "call_a", name: "lookup", arguments: {} }, { id: "call_b", name: "get_weather", arguments: { city: "Rome" } }] });
  await f.agent.step();
  assert(pendingClientCalls(f.host.sql as any, SESSION).map((c) => c.call_id).join() === "call_b", "the client call is not waiting");
  answerClientCall(f.host.sql as any, SESSION, "call_b", { output: "hot", isError: false });
  assert(await f.resume(), "did not continue");
  await f.agent.step();
  const req = f.nextRequest();
  assert(roles(req).join() === "user,assistant,toolResult:call_a,toolResult:call_b", `the model saw ${roles(req)}`);
  await f.agent.close();
});

await check("two caller functions in one batch both reach the model with the caller's results, never as aborted", async () => {
  // The first call's pause requests the abort; pi may then cancel the second before it runs and record an
  // aborted result for it. The caller answers both, and the model must see both answers (task #17, 2026-09-15).
  const f = await fixture();
  await f.agent.say("weather in Rome and Oslo?");
  await f.agent.step();
  f.reply({ toolCalls: [
    { id: "call_x", name: "get_weather", arguments: { city: "Rome" } },
    { id: "call_y", name: "get_weather", arguments: { city: "Oslo" } },
  ] });
  await f.agent.step();
  const waiting = pendingClientCalls(f.host.sql as any, SESSION).map((c) => c.call_id).join();
  // The caller is asked for both: a call pi cancelled before it ran is still the caller's to answer.
  assert(waiting === "call_x,call_y", `waiting for ${waiting || "none"}, not both calls`);
  assert(!(await f.resume()), "resumed before the caller answered");
  answerClientCall(f.host.sql as any, SESSION, "call_x", { output: "hot", isError: false });
  assert(!(await f.resume()), "resumed with one of the two calls still unanswered");
  answerClientCall(f.host.sql as any, SESSION, "call_y", { output: "cold", isError: false });
  assert(await f.resume(), `did not continue (waiting before the answers: ${waiting || "none"})`);
  await f.agent.step();
  const req = f.nextRequest();
  assert(roles(req).join() === "user,assistant,toolResult:call_x,toolResult:call_y", `the model saw ${roles(req)} (waiting was ${waiting || "none"})`);
  const results = (req?.context?.messages ?? []).filter((m: any) => m.role === "toolResult");
  const text = (m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join("");
  assert(text(results[0]) === "hot" && text(results[1]) === "cold" && results.every((m: any) => !m.isError),
    `the model saw ${JSON.stringify(results.map((m: any) => ({ id: m.toolCallId, text: text(m), isError: m.isError })))} (waiting was ${waiting || "none"})`);
  await f.agent.close();
});

await check("in a batch, a call the caller answered early is not asked for again, and both answers reach the model", async () => {
  // Whether pi runs call_y (the early answer is used) or cancels it first (the answer waits in its row), the pause
  // recorded for call_x must not turn call_y back into a call the caller is asked for.
  const f = await fixture();
  answerClientCall(f.host.sql as any, SESSION, "call_y", { output: "sunny", isError: false });
  await f.agent.say("weather in Rome and Oslo?");
  await f.agent.step();
  f.reply({ toolCalls: [
    { id: "call_x", name: "get_weather", arguments: { city: "Rome" } },
    { id: "call_y", name: "get_weather", arguments: { city: "Oslo" } },
  ] });
  await f.agent.step();
  const waiting = pendingClientCalls(f.host.sql as any, SESSION).map((c) => c.call_id).join();
  assert(waiting === "call_x", `waiting for ${waiting || "none"}; only call_x is unanswered`);
  answerClientCall(f.host.sql as any, SESSION, "call_x", { output: "hot", isError: false });
  assert(await f.resume(), "did not continue once call_x was answered");
  await f.agent.step();
  const req = f.nextRequest();
  const results = (req?.context?.messages ?? []).filter((m: any) => m.role === "toolResult");
  const text = (m: any) => (m.content ?? []).map((c: any) => c.text ?? "").join("");
  assert(roles(req).join() === "user,assistant,toolResult:call_x,toolResult:call_y" && text(results[0]) === "hot" && text(results[1]) === "sunny"
    && results.every((m: any) => !m.isError),
    `the model saw ${JSON.stringify(results.map((m: any) => ({ id: m.toolCallId, text: text(m), isError: m.isError })))}`);
  assert(pendingClientCalls(f.host.sql as any, SESSION).length === 0 && !(await f.resume()), "a call was left waiting after the turn continued");
  await f.agent.close();
});

await check("an early answer used before its batch pauses is not turned back into a call the caller is asked for", async () => {
  // The order pi does not produce in the fixture above, forced: call_y runs first and uses its early answer, and only
  // then does call_x pause and record its batch. Without the "used" state the answer row was gone, and the batch
  // recorded call_y as waiting again: the caller would be asked for a call that had already run.
  const host = sqliteHost();
  const entry = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "call_x", name: "get_weather", arguments: { city: "Rome" } },
    { type: "toolCall", id: "call_y", name: "get_weather", arguments: { city: "Oslo" } },
  ] } };
  const lane = { async inspectExecution() { return { current: { id: "op_1" }, tipId: "tip" }; }, async requestAbort() { return { ok: true }; } };
  const [tool] = clientTools(
    [{ name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: {} } }],
    { sql: host.sql as any, session: SESSION, lane: () => lane as any, branch: async () => [entry] });
  const aborted = { abortSignal: AbortSignal.abort() };
  answerClientCall(host.sql as any, SESSION, "call_y", { output: "sunny", isError: false });
  const y = await tool!.execute("call_y", { city: "Oslo" }, undefined, undefined, undefined, aborted);
  assert((y.content[0] as any).text === "sunny", `call_y did not use its early answer: ${JSON.stringify(y)}`);
  const x = await tool!.execute("call_x", { city: "Rome" }, undefined, undefined, undefined, aborted).then(() => "returned", (e) => String(e?.message ?? e));
  assert(x === CLIENT_PENDING, `call_x did not pause: ${x}`);
  const waiting = pendingClientCalls(host.sql as any, SESSION).map((c) => c.call_id).join();
  assert(waiting === "call_x", `waiting for ${waiting || "none"}; call_y already ran with the caller's answer`);
  assert(!answerClientCall(host.sql as any, SESSION, "call_y", { output: "again", isError: false }), "call_y was open to a second answer");
});

await check("a failed caller function reaches the model as an error; dropping a session's calls forgets them", async () => {
  const f = await fixture();
  await f.agent.say("weather?");
  await f.agent.step();
  f.reply({ toolCalls: [{ id: "call_3", name: "get_weather", arguments: {} }] });
  await f.agent.step();
  answerClientCall(f.host.sql as any, SESSION, "call_3", { output: "Tool handler failed.", isError: true });
  assert(await f.resume(), "did not continue");
  await f.agent.step();
  const msgs = f.nextRequest()?.context?.messages ?? [];
  const result = msgs.find((m: any) => m.role === "toolResult");
  assert(result?.isError === true, `the failure reached the model as ${JSON.stringify(result)}`);

  const g = await fixture();
  await g.agent.say("weather?");
  await g.agent.step();
  g.reply({ toolCalls: [{ id: "call_4", name: "get_weather", arguments: {} }] });
  await g.agent.step();
  assert(dropClientCalls(g.host.sql as any, SESSION) === 1 && pendingClientCalls(g.host.sql as any, SESSION).length === 0, "the waiting call was not dropped");
  await f.agent.close();
  await g.agent.close();
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
