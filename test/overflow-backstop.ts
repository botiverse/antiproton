/**
 * The context-overflow backstop for pi085's main conversation (src/runtime/overflow-backstop.ts, `#overflowBackstop`
 * in cf/src/runtime.ts).
 *
 * The runtime rows drive the real `AgentRuntime` over node:sqlite with the model scripted through the queue, as
 * test/stable-prompt.ts does. An overflow is answered the way production answers it: the queue consumer's refusal
 * (cf/src/model-request.ts `callQueuedModel`), whose `errorMessage` is fixed text and whose provider text is in
 * `providerError`.
 */
import { AgentRuntime, HARNESS_NOTICE } from "../cf/src/runtime.ts";
import { errorMessage, fromResponse } from "../src/model/pi-bridge.ts";
import { ModelRequestRefused } from "../src/model/openai-compatible.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { canonJson } from "../src/core/canon-json.ts";
import { acceptInbound, ensureInboundTable } from "../src/runtime/inbound.ts";
import { currentMainId, logicalMain, mainSessions, physicalSession } from "../cf/src/fresh-context.ts";
import { readDiagnosis } from "../cf/src/diagnose-read.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { piTables } from "../src/store/pi-storage.ts";
import {
  buildBriefing, isContextOverflowAnswer, MAX_CONSECUTIVE_OVERFLOWS, readBackstop, SessionNeedsReset, type BriefingEntry,
} from "../src/runtime/overflow-backstop.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

const identity = { api: "offloaded", provider: "openai-compatible", id: "m1" };
const DEEPSEEK_OVERFLOW = JSON.stringify({ error: {
  message: "This model's maximum context length is 131072 tokens. However, you requested 140211 tokens (139211 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.",
  type: "invalid_request_error", param: null, code: "invalid_request_error" } });
/** What the queue consumer answers for a refused request (cf/src/model-request.ts `callQueuedModel`). */
const refused = (status: number, body: string, jobId?: string) => {
  const e = new ModelRequestRefused(status, body);
  return { ...errorMessage(e.message, identity), providerError: e.turnError, ...(jobId ? { jobId } : {}) };
};
const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };

// ---- recognising an overflow ---------------------------------------------------------------------------------------

await check("an overflow is recognised in every shape this deployment is answered in, and nothing else is", () => {
  const yes: Array<[string, unknown]> = [
    ["DeepSeek through the queue: fixed errorMessage, provider text in providerError", refused(400, DEEPSEEK_OVERFLOW)],
    ["DeepSeek's text as the errorMessage itself", { ...errorMessage("This model's maximum context length is 131072 tokens. Please reduce the length of the messages.", identity) }],
    ["OpenAI Responses: context_length_exceeded", refused(400, JSON.stringify({ error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again.", type: "invalid_request_error", code: "context_length_exceeded" } }))],
    ["an OpenAI-compatible code alone", refused(400, JSON.stringify({ error: { message: "bad request", type: "invalid_request_error", code: "context_length_exceeded" } }))],
    ["a 400 saying too many tokens", refused(400, "Bad Request: too many tokens in the prompt")],
    ["a gateway's prompt too long", refused(413, JSON.stringify({ error: { message: "prompt is too long: 213462 tokens > 200000 maximum" } }))],
  ];
  for (const [what, m] of yes) must(isContextOverflowAnswer(m), `not recognised: ${what}: ${show(m)}`);
  const no: Array<[string, unknown]> = [
    ["the queue's fixed text alone", errorMessage(new ModelRequestRefused(400, "").message, identity)],
    ["an auth refusal", refused(401, JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error" } }))],
    ["a rate limit that names tokens", refused(429, JSON.stringify({ error: { message: "Rate limit reached: too many tokens per min (TPM)" } }))],
    ["a server error", errorMessage("500 Internal Server Error", identity)],
    ["an output limit", errorMessage("the model reached its output limit before writing an answer", identity)],
    ["an invalid tool schema", refused(400, JSON.stringify({ error: { message: "Invalid schema for function 'x': In context=('properties', 'timeout')", type: "invalid_request_error" } }))],
    ["a successful answer, however large its input", { ...fromResponse({ text: "ok", finishReason: "stop", truncated: false, usage: { ...usage, promptTokens: 5_000_000 } }, identity), usage: { input: 5_000_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5_000_001, cost: {} } }],
    ["nothing", null],
  ];
  for (const [what, m] of no) must(!isContextOverflowAnswer(m), `read as an overflow: ${what}: ${show(m)}`);
});

// ---- the briefing, as a pure function -------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 11, 14, 0);
let seqN = 0;
const entry = (message: unknown, at: number): BriefingEntry => ({ id: `e${++seqN}`, timestamp: at, message });
const user = (text: string, at: number) => entry({ role: "user", content: [{ type: "text", text }], timestamp: at }, at);
const wrote = (text: string, at: number, calls: Array<{ id: string; name: string; arguments: unknown }> = []) =>
  entry({ role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", ...c }))], stopReason: calls.length ? "toolUse" : "stop", timestamp: at }, at);
const result = (id: string, name: string, isError: boolean, text: string, at: number) =>
  entry({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: at }, at);
const ANNOUNCES = /rebuil|reset|restor|summar|compact|fresh|new conversation|context (?:was|has been)/i;

await check("the briefing: messages newest first with their labels, the tool calls with how each ended, the wake last, nothing announced", () => {
  const entries: BriefingEntry[] = [
    user("first question", T0),
    wrote("", T0 + 60_000, [{ id: "c1", name: "chat__send_message", arguments: { text: "on it" } }]),
    result("c1", "chat__send_message", false, "sent", T0 + 61_000),
    wrote("", T0 + 62_000, [{ id: "c2", name: "chat__broken", arguments: { why: 1 } }]),
    result("c2", "chat__broken", true, "upstream said no\nmore detail", T0 + 63_000),
    wrote("all done", T0 + 120_000),
    entry({ role: "assistant", content: [], stopReason: "deferred", timestamp: T0 + 121_000 }, T0 + 121_000),
    user("the wake", T0 + 180_000),
    entry({ role: "assistant", content: [], stopReason: "error", errorMessage: "x", timestamp: T0 + 181_000 }, T0 + 181_000),
  ];
  const b = buildBriefing(entries, { conversation: "main" });
  must(b.text.endsWith("the wake"), `the wake is not last:\n${b.text}`);
  must(b.messages === 3 && b.actions === 2 && b.wake, `blocks: ${show(b)}`);
  const at = (s: string) => b.text.indexOf(s);
  must(at("[main · 2026-10-11 14:02Z · you wrote]\nall done") >= 0, `the agent's text is not labelled:\n${b.text}`);
  must(at("[main · 2026-10-11 14:01Z · you sent with chat__send_message]\non it") >= 0, `the agent's send is not quoted:\n${b.text}`);
  must(at("[main · 2026-10-11 14:00Z · received]\nfirst question") >= 0, `the first message is not quoted:\n${b.text}`);
  must(at("all done") < at("on it") && at("on it") < at("first question"), "not newest first");
  must(at("chat__broken {\"why\":1} — failed: upstream said no more detail") >= 0 && at("chat__send_message {\"text\":\"on it\"} — ok") >= 0, `tool calls:\n${b.text}`);
  must(at("chat__broken") < at("chat__send_message {"), "tool calls not newest first");
  must(!ANNOUNCES.test(b.text), `the briefing announces something:\n${b.text}`);
  must(b.tokens === Math.ceil(b.text.length / 4) && b.tokens <= b.budgetTokens, `tokens: ${b.tokens}`);
});

await check("the briefing keeps to its budget: the wake and the tool calls always, then as many recent messages as fit", () => {
  const entries: BriefingEntry[] = [];
  for (let i = 0; i < 40; i++) entries.push(user(`message ${i} ${"x".repeat(3_000)}`, T0 + i * 1000));
  entries.push(user("the wake", T0 + 100_000));
  const b = buildBriefing(entries, { conversation: "main", budgetTokens: 4_000 });
  must(b.tokens <= 4_000, `over budget: ${b.tokens}`);
  must(b.messages > 0 && b.messages < 40, `messages kept: ${b.messages}`);
  must(b.text.includes("message 39 ") && !b.text.includes("message 0 "), "the newest are not the ones kept");
  must(b.text.endsWith("the wake"), "the wake is not last");
  const huge = buildBriefing([user("w".repeat(100_000), T0)], { conversation: "main", budgetTokens: 1_000 });
  must(huge.tokens <= 1_000 && huge.wake && huge.text.includes("(cut at 2000 characters)"), `a huge wake: ${huge.tokens}`);
});

await check("a notice the wake carried at its head is left out when its text was recorded", () => {
  const head = `${HARNESS_NOTICE}Your instructions above show what was true when this conversation began.\n\nmore`;
  const b = buildBriefing([user(`${head}\n\nthe wake`, T0)], { conversation: "main", noticeHeads: [head] });
  must(b.text === "the wake", `not stripped: ${show(b.text)}`);
  const kept = buildBriefing([user(`${head}\n\nthe wake`, T0)], { conversation: "main" });
  must(kept.text.startsWith(HARNESS_NOTICE), "control: without the recorded head the text is quoted as it is");
});

// ---- the runtime ---------------------------------------------------------------------------------------------------

type Ctx = { systemPrompt: string; messages: any[]; tools: Array<{ name: string }> };
type Answer = (ctx: Ctx, jobId: string) => unknown;
type World = { host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string>; calls: Ctx[]; answer: Answer };

const chat: Plugin = {
  id: "chat", version: "1.0.0",
  tools: [
    { name: "send_message", description: "Send a message.", parameters: { type: "object", properties: { text: { type: "string" } } }, sideEffects: "write", idempotency: "none" },
    { name: "broken", description: "Always fails.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "safe" },
  ] as never,
  async invoke(tool: string) { if (tool === "broken") throw new Error("upstream said no"); return { ok: true }; },
} as Plugin;

function runtimeOver(w: { host: ReturnType<typeof sqliteHost>; sent: string[] }): AgentRuntime {
  const standIn = standInLoader();
  return new AgentRuntime({
    ctx: { storage: { sql: w.host.sql, transactionSync: w.host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [chat],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { w.sent.push(job.commandId); },
  } as never);
}

async function world(): Promise<World> {
  const base = { host: sqliteHost(), sent: [] as string[], answered: new Set<string>(), calls: [] as Ctx[], answer: (() => null) as Answer };
  const w = { ...base, rt: runtimeOver(base) } as World;
  await w.rt.ready();
  await w.rt.store.createAgent("t", "a");
  for (const [alias, plugin] of [["state", "state"], ["chat", "chat"]] as const) {
    await w.rt.store.setPluginChoice("t", "a", plugin, "enable");
    const added = await w.rt.addMount("t", "a", { alias, plugin, config: { account: alias } });
    must(added.ok, `the ${alias} mount was refused: ${show(added)}`);
  }
  await w.rt.bindOperatorModel("t", "a");
  await w.rt.reconcileSeeds("t", "a");
  const pending = await w.rt.store.pendingSeedNotices("t", "a");
  await w.rt.store.takeSeedNotices("t", "a", new Set(pending.map((n) => `${n.alias}@${n.since}`)));
  // What /admin/diagnose needs to name the agent (AgentDO's claim).
  w.host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  w.host.sql.exec("INSERT OR REPLACE INTO owner(k, tenant_id, agent_id) VALUES ('self','t','a')");
  return w;
}

const say = (text: string) => (_c: Ctx, id: string) => fromResponse({ text, finishReason: "stop", truncated: false, usage } as ModelResponse, identity, id);
const callTool = (name: string, args: unknown) => (_c: Ctx, id: string) =>
  fromResponse({ text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id: `call_${id}`, name, arguments: args }] } as ModelResponse, identity, id);
const overflow = (_c: Ctx, id: string) => refused(400, DEEPSEEK_OVERFLOW, id);
/** Answers in turn, the last one for every call after. */
const script = (...answers: Answer[]): Answer => { let n = 0; return (c, id) => answers[Math.min(n++, answers.length - 1)]!(c, id); };

/** Step and answer until the object asks for nothing; the number of model calls it made. */
async function settle(w: World): Promise<number> {
  const before = w.calls.length;
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !w.answered.has(id));
    for (const id of pending) {
      w.answered.add(id);
      const job = await w.rt.takeJob("t", "a", id) as { context: Ctx } | null;
      if (!job) continue;
      w.calls.push(JSON.parse(JSON.stringify(job.context)));
      await w.rt.deliverAnswer("t", "a", id, w.answer(w.calls.at(-1)!, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return w.calls.length - before;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error("the object did not settle: the backstop is looping");
}
async function turn(w: World, text: string): Promise<number> {
  await w.rt.postMessage("t", "a", text, "prompt", "main");
  return settle(w);
}
async function push(w: World, text: string) {
  ensureInboundTable(w.host.sql as never);
  acceptInbound(w.host.sql as never, { hookId: "h1", alias: "chat", dedupeKey: null, message: text, now: Date.now() });
  return w.rt.deliverPendingInbound("t", "a");
}

const remember = (w: World, key: string, value: string) => w.rt.store.putState("t", "a", key, { value, ref: null, bytes: value.length });
const textOf = (m: any): string => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
const traceRows = (w: World, kind: string) => (w.host.sql.exec("SELECT status, attrs FROM trace_outbox WHERE kind = ? ORDER BY seq", kind).toArray() as any[])
  .map((r) => ({ status: String(r.status), attrs: JSON.parse(String(r.attrs)) }));
const hasTable = (w: World, name: string) => w.host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = ?", name).toArray().length > 0;
const diagnose = async (w: World) => await readDiagnosis(w.host.sql, "t", "a", "t_a", {
  store: new DurableObjectStore({ storage: { sql: w.host.sql, transactionSync: w.host.transactionSync } } as never),
  plugins: [], alarm: async () => null,
}) as any;

/** The request of `next` begins with the whole request of `prev`, byte for byte. */
function extendsRequest(prev: Ctx, next: Ctx) {
  must(next.systemPrompt === prev.systemPrompt, "the system prompt moved");
  must(canonJson(next.tools) === canonJson(prev.tools), "the tool list moved");
  for (let i = 0; i < prev.messages.length; i++) must(canonJson(next.messages[i]) === canonJson(prev.messages[i]), `message ${i} was rewritten`);
}

await check("ordinary turns: the backstop writes nothing and every request extends the last", async () => {
  const w = await world();
  w.answer = script(callTool("chat__send_message", { text: "hi" }), say("done"));
  must(await turn(w, "hello") === 2, "control: the turn made its two calls");
  w.answer = say("again");
  await turn(w, "second");
  extendsRequest(w.calls[1]!, w.calls[2]!);
  must(!hasTable(w, "overflow_backstop") && !hasTable(w, "notice_heads"), "the backstop wrote on a normal path");
  must(currentMainId(w.host.sql as never) === "main" && !traceRows(w, "rebuild.decision").length, "a normal turn was rebuilt");
});

await check("an overflow: rebuilt once into a new transcript, briefed from the old one with the wake last, and the wake answered", async () => {
  const w = await world();
  await remember(w, "memory", "- prefers tea");
  w.answer = script(callTool("chat__send_message", { text: "hi there" }), callTool("chat__broken", {}), say("all done"));
  must(await turn(w, "hello") === 3, "control: the first turn made its three calls");
  // Moved after the conversation began, so the wake carries a notice of it.
  await remember(w, "memory", "- prefers tea\n- likes rain");
  w.answer = script(overflow, say("answered after"));
  const made = await turn(w, "second");
  must(made === 2, `calls this wake: ${made} (the failed one and the rebuilt one)`);
  const failed = w.calls.at(-2)!, rebuilt = w.calls.at(-1)!;
  must(textOf(failed.messages.at(-1)).includes("Your instructions above show what was true"), "control: the failed request carried the memory notice");

  const sessions = mainSessions(w.host.sql as never);
  must(sessions.length === 2 && sessions[1]!.cause === "rebuild" && currentMainId(w.host.sql as never) === sessions[1]!.sessionId, `transcripts: ${show(sessions)}`);
  const archived = physicalSession(w.host.sql as never, "main");
  must(archived && w.host.sql.exec(`SELECT COUNT(*) AS n FROM ${piTables(archived).entries} WHERE body LIKE '%hello%'`).toArray()[0]!.n as number > 0, "the old transcript is not readable");

  must(rebuilt.messages.length === 1 && rebuilt.messages[0].role === "user", `the rebuilt request: ${rebuilt.messages.length} messages`);
  const brief = textOf(rebuilt.messages[0]);
  must(brief.endsWith("second") && !brief.includes(HARNESS_NOTICE) && !brief.includes("Your instructions above"), `the wake is not last, or carries the old notice:\n${brief}`);
  must(/\[main · [^\]]+ · received\]\nhello/.test(brief), `the first message is not in the briefing:\n${brief}`);
  must(/\[main · [^\]]+ · you wrote\]\nall done/.test(brief) && /you sent with chat__send_message\]\nhi there/.test(brief), `the agent's own messages are not in the briefing:\n${brief}`);
  must(/chat__broken \{\} — failed: /.test(brief) && /chat__send_message \{"text":"hi there"\} — ok/.test(brief), `the tool calls are not in the briefing:\n${brief}`);
  must(!ANNOUNCES.test(brief), `the briefing announces the rebuild:\n${brief}`);
  // The working set as it is now, in the new transcript's own snapshot, and no notice of it.
  must(rebuilt.systemPrompt.includes("- likes rain") && !failed.systemPrompt.includes("- likes rain"), "the rebuilt system prompt does not carry the current working set");

  const rows = traceRows(w, "rebuild.decision");
  must(rows.length === 1 && rows[0]!.status === "ran", `rebuild rows: ${show(rows)}`);
  const a = rows[0]!.attrs;
  must(a.trigger === "window" && a.strategy === "briefing" && a.acted === true && a.conversation === "main" && a.from === "main" && a.to === sessions[1]!.sessionId, `attrs: ${show(a)}`);
  must(a.tokensBefore > 0 && a.tokensAfter > 0 && a.budgetTokens === 8000 && a.messages >= 3 && a.actions === 2 && a.wake === true, `attrs: ${show(a)}`);
  const opens = traceRows(w, "harness.open").filter((r) => r.status === "rebuild");
  must(opens.length === 1 && opens[0]!.attrs.detail.includes("strategy=briefing"), `harness.open rows: ${show(traceRows(w, "harness.open").map((r) => r.status))}`);

  // The rebuilt conversation goes on as any other: the next request extends it, with no notice.
  w.answer = say("third answered");
  must(await turn(w, "third") === 1, "the next wake did not make one call");
  extendsRequest(rebuilt, w.calls.at(-1)!);
  must(!textOf(w.calls.at(-1)!.messages.at(-1)).includes(HARNESS_NOTICE), "the next wake carries a notice the snapshot already shows");
  must(readBackstop(w.host.sql as never).consecutive === 0, "a run that ended well did not reset the count");

  const d = (await diagnose(w)).mainConversation;
  must(d.conversation === "main" && d.rebuilds === 1 && d.transcripts.length === 2 && d.transcripts[1].cause === "rebuild" && d.needsReset === null, `diagnose: ${show(d)}`);
});

await check("an overflow that the rebuild does not cure: stopped, needs_reset, and later wakes make no call", async () => {
  const w = await world();
  w.answer = say("fine");
  await turn(w, "hello");
  w.answer = overflow;
  const made = await turn(w, "second");
  must(made === 2, `calls this wake: ${made} (the failed one and the rebuilt one, then stop)`);
  const b = readBackstop(w.host.sql as never);
  must(b.needsReset?.reason === "rebuilt-request-overflowed" && b.rebuilds === 1, `state: ${show(b)}`);
  const rows = traceRows(w, "rebuild.decision");
  must(rows.map((r) => r.status).join() === "ran,declined" && rows[1]!.attrs.acted === false, `rows: ${show(rows)}`);
  must(traceRows(w, "session.needs_reset").length === 1, "no needs_reset row");

  const p = await push(w, "a push after");
  must(p.posted === 0 && p.failed === 1, `the push: ${show(p)}`);
  must(await settle(w) === 0, "a model call after needs_reset");
  let threw: unknown = null;
  try { await w.rt.postMessage("t", "a", "typed", "steer", "main"); } catch (e) { threw = e; }
  must(threw instanceof SessionNeedsReset, `a post was not refused: ${String(threw)}`);
  must(mainSessions(w.host.sql as never).length === 2, "rebuilt again after the guard stopped");
  must((await diagnose(w)).mainConversation.needsReset?.reason === "rebuilt-request-overflowed", "diagnose does not show needs_reset");

  // An operator's fresh context clears it, and the agent answers again.
  const fresh = await w.rt.freshContext("t", "a");
  must(fresh.ok, `fresh context: ${show(fresh)}`);
  must(readBackstop(w.host.sql as never).needsReset === null, "fresh context did not clear needs_reset");
  w.answer = say("back");
  must(await turn(w, "after the reset") === 1, "the agent did not answer after the reset");
  const chain = logicalMain(w.host.sql as never);
  must(chain.conversation === mainSessions(w.host.sql as never).at(-1)!.sessionId && chain.rebuilds === 0, `a fresh context is not a conversation of its own: ${show(chain)}`);
});

await check(`overflows ${MAX_CONSECUTIVE_OVERFLOWS} times in a row, each rebuilt request answered: stopped at the count`, async () => {
  const w = await world();
  w.answer = say("fine");
  await turn(w, "hello");
  // Each rebuilt request is answered with a tool call, and the call after it overflows: the run never ends well.
  w.answer = script(overflow, callTool("chat__send_message", { text: "x" }), overflow, callTool("chat__send_message", { text: "y" }), overflow, say("never"));
  const made = await turn(w, "second");
  must(made === 5, `calls: ${made}`);
  const b = readBackstop(w.host.sql as never);
  must(b.needsReset?.reason === "consecutive-overflows" && b.consecutive === MAX_CONSECUTIVE_OVERFLOWS && b.rebuilds === 2, `state: ${show(b)}`);
  must(traceRows(w, "rebuild.decision").map((r) => r.status).join() === "ran,ran,declined", "rows");
});

await check("an overflow while a push is being handed over waits for that push's run, and is judged with it", async () => {
  const w = await world();
  w.answer = say("fine");
  await turn(w, "hello");
  w.answer = script(overflow, overflow, say("answered"));
  await w.rt.postMessage("t", "a", "second", "prompt", "main");
  ensureInboundTable(w.host.sql as never);
  acceptInbound(w.host.sql as never, { hookId: "h1", alias: "chat", dedupeKey: null, message: "third", now: Date.now() });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const pass = w.rt.deliverPendingInbound("t", "a", { beforeFirstPost: () => held });
  // The run of "second" ends on an overflow while the push is mid-way: not rebuilt under it.
  must(await settle(w) === 1, "control: the run of the second message made its call");
  must(mainSessions(w.host.sql as never).length === 1, "rebuilt while a push was being handed over");
  release();
  must((await pass).posted === 1, "the push was not posted");
  must(await settle(w) === 2, "the push's run: its overflow and the rebuilt call");
  const brief = textOf(w.calls.at(-1)!.messages[0]);
  must(brief.endsWith("third") && brief.includes("second"), `the briefing:\n${brief}`);
  must(traceRows(w, "rebuild.decision").map((r) => r.status).join() === "ran" && readBackstop(w.host.sql as never).needsReset === null, "not one rebuild");
});

await check("a failure that is not an overflow is left as it was", async () => {
  const w = await world();
  w.answer = say("fine");
  await turn(w, "hello");
  w.answer = (_c, id) => ({ ...refused(401, JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } })), jobId: id });
  must(await turn(w, "second") === 1, "a non-overflow failure was retried");
  must(currentMainId(w.host.sql as never) === "main" && !traceRows(w, "rebuild.decision").length && !hasTable(w, "overflow_backstop"), "a non-overflow failure was rebuilt");
  w.answer = say("ok again");
  must(await turn(w, "third") === 1, "the next wake did not run");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
