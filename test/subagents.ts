/**
 * Subagents (src/runtime/subagents.ts, issue #926) through `AgentRuntime`, on an object of each engine over node:sqlite:
 * `send_to_agent` behind the agent's setting, children in the same object, reports delivered as messages to the parent,
 * the cap, depth, follow-ups, stop and delete cascading to children, a restart mid-child, a failed and a cancelled child,
 * the model option, `model.call` rows naming their session, Raft activity seeing only the agent, and usage under the parent.
 *
 * The queue is played by the test: `pass()` is what AgentDO's alarm does (one `step`), then the model answers each
 * dispatched job from `reply`, which is told which session asked.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { statusEvents } from "../src/runtime/status.ts";
import { SUBAGENT_CAP, SUBAGENT_TOOL, admitSubagent, turnEnd } from "../src/runtime/subagents.ts";
import { updateAgentSettings, agentSettings } from "../src/runtime/agent-settings.ts";
import { recordBackgroundJob } from "../src/runtime/background-jobs.ts";
import type { Plugin } from "../src/plugins/types.ts";

/** A mount whose work goes to the background and is done at the first poll (test/overflow-backstop.ts has the same). */
const builder: Plugin = {
  id: "builder", version: "1.0.0",
  tools: [{ name: "build", description: "Build.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" }] as never,
  async invoke() { return { ok: true }; },
  background: { async poll() { return { done: true, result: "built" }; }, async cancel() {} },
} as Plugin;

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

const USAGE = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage: USAGE } as ModelResponse);
const calls = (...cs: Array<{ id: string; args: Record<string, unknown> }>): ModelResponse => ({
  text: "", finishReason: "tool_calls", truncated: false, usage: USAGE,
  toolCalls: cs.map((c) => ({ id: c.id, name: SUBAGENT_TOOL, arguments: c.args })),
} as ModelResponse);
type Req = ReturnType<typeof toRequest>;
type Reply = ModelResponse | { error: string };
type Job = { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0]; operatorModel?: string | null; operatorProvider?: string | null };

const USER_MODELS = { offered: [{ id: "cheap", label: "Cheap", provider: "deepseek", model: "m-cheap" }] };

/** One agent on an AgentRuntime over node:sqlite, its object recording `engine`, its `subagents` setting as given. */
async function world(engine: "pi085" | "pd", opts: { on?: boolean; builder?: boolean } = {}) {
  const raw = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(raw, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  /** A runtime over this object, as a fresh isolate makes one: nothing opened, nothing remembered. */
  const isolate = () => new AgentRuntime({
    ctx: { storage: { sql: raw.sql, transactionSync: raw.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false, userModels: USER_MODELS, ...(opts.builder ? { extraPlugins: [builder] } : {}),
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  const w = {
    raw, sent, engine, rt: isolate(), isolate,
    answered: new Set<string>(),
    /** Jobs `reply` chose to leave out, for now. */
    held: new Set<string>(),
    /** Each request the model was sent: the session that asked, the request, and the model the queue would call. */
    requests: [] as Array<{ session: string; req: Req; operatorModel: string | null }>,
    /** Answers the model with, by the session asking; returning null leaves the job out (not answered). */
    reply: (_session: string, _req: Req): Reply | null => say("ok"),
  };
  await w.rt.ready();
  await w.rt.store.createAgent("t", "a", { name: "Ada", description: "d" } as never);
  if (opts.builder) {
    await w.rt.store.setPluginChoice("t", "a", "builder", "enable");
    must((await w.rt.addMount("t", "a", { alias: "builder", plugin: "builder", config: {} })).ok, "the builder mount was refused");
  }
  await w.rt.bindOperatorModel("t", "a");
  if (opts.on !== false) must(updateAgentSettings(raw.sql as never, { subagents: true }, "test").ok, "setting refused");
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

/** Which session a model job belongs to, from the engine's own job table. */
function sessionOfJob(w: World, id: string): string {
  if (w.engine === "pi085") return String((w.raw.sql.exec("SELECT session FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as any)?.session);
  const r = w.raw.sql.exec("SELECT c.task_id AS s FROM ap_model_jobs j JOIN ap_conversations c ON c.conversation_id = j.conversation_id WHERE j.id = ?", id).toArray()[0] as any;
  return String(r?.s);
}

/** One alarm pass, then every dispatched job answered that `reply` answers. Returns the step's outcome. */
async function pass(w: World) {
  const out = await w.rt.step("t", "a");
  for (const id of w.sent.filter((x) => !w.answered.has(x))) {
    const session = sessionOfJob(w, id);
    const job = await w.rt.takeJob("t", "a", id).catch(() => null) as Job | null;
    if (!job) { w.answered.add(id); continue; }
    const req = toRequest(job.context);
    const r = w.reply(session, req);
    if (r === null) { w.held.add(id); continue; }
    w.held.delete(id);
    w.answered.add(id);
    w.requests.push({ session, req, operatorModel: job.operatorModel ?? null });
    const model = { ...job.model, id: job.operatorModel ?? job.model.id };
    const answer = "error" in r
      ? { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: r.error, timestamp: Date.now(), jobId: id }
      : fromResponse(r, model, id);
    await w.rt.deliverAnswer("t", "a", id, answer, undefined);
  }
  return out;
}

/**
 * Passes until nothing is left to do: no job out that `reply` would answer, and no wake asked for sooner than a
 * minute (a longer one is the poll backstop of a job left out on purpose).
 */
async function settle(w: World, max = 120) {
  for (let i = 0; i < max; i++) {
    const before = w.answered.size;
    const out = await pass(w);
    if (w.answered.size !== before) continue;
    if (w.sent.some((x) => !w.answered.has(x) && !w.held.has(x))) { await sleep(5); continue; }
    if (out.wakeInMs === null || out.wakeInMs > 60_000) return out;
    await sleep(Math.min(out.wakeInMs, 50));
  }
  throw new Error(`${w.engine}: did not settle`);
}

/** The text of every message of the main conversation, oldest first. */
async function mainTexts(w: World, role: "user" | "assistant" = "user"): Promise<string[]> {
  const entries = await w.rt.branchEntries("t", "a", "main") as any[];
  return entries.filter((e) => e.type === "message" && e.message?.role === role).map((e) => {
    const c = e.message.content;
    return typeof c === "string" ? c : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
  });
}
const reports = async (w: World) => (await mainTexts(w)).filter((t) => t.startsWith("[subagent "));
const rowsOf = (w: World) => w.raw.sql.exec("SELECT * FROM subagents ORDER BY created_at, id").toArray() as any[];
const toolNames = (req: Req) => (req.tools ?? []).map((t: any) => t.name ?? t.function?.name);
const taskOf = (req: Req) => {
  const u = req.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  return u[0] ?? "";
};
const trace = (w: World) => pendingTrace(w.raw.sql as never, 0).rows;

for (const engine of (process.env.ENGINES ?? "pi085,pd").split(",") as Array<"pi085"|"pd">) {
  await check(`${engine}: the setting off means no ${SUBAGENT_TOOL}; on, the main conversation is offered it`, async () => {
    const off = await world(engine, { on: false });
    must(!(await (await off.rt.agent("t", "a")).tools()).some((t) => t.name === SUBAGENT_TOOL), "offered with the setting off");
    const exported = await off.rt.offeredTools("t", "a");
    must(!exported!.tools.some((t) => t.name === SUBAGENT_TOOL), "exported with the setting off");
    // The same object, switched on: the cached harness is rebuilt with the tool (its key carries the settings).
    must(updateAgentSettings(off.raw.sql as never, { subagents: true }, "test").ok, "refused");
    must((await (await off.rt.agent("t", "a")).tools()).some((t) => t.name === SUBAGENT_TOOL), "not offered after switching on");
    // And off again takes it away.
    must(updateAgentSettings(off.raw.sql as never, { subagents: false }, "test").ok, "refused");
    must(!(await (await off.rt.agent("t", "a")).tools()).some((t) => t.name === SUBAGENT_TOOL), "still offered after switching off");
  });

  await check(`${engine}: three subagents in parallel deliver three reports to the parent; the parent's turn ended after spawning; children have no ${SUBAGENT_TOOL}`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls(...[1, 2, 3].map((i) => ({ id: `c${i}`, args: { task: `count the files in /w/part${i}; report the number` } })));
        return say(`noted (${parentCalls})`);
      }
      const n = /part(\d)/.exec(taskOf(req))?.[1];
      return say(`part${n}: ${Number(n) * 10} files`);
    };
    await w.rt.postMessage("t", "a", "split the count in three", "prompt", "main");
    await settle(w);
    const rs = await reports(w);
    must(rs.length === 3, `reports: ${show(rs)}`);
    for (const i of [1, 2, 3]) must(rs.some((r) => r.includes(`part${i}: ${i * 10} files`) && / done after /.test(r)), `no report for part${i}: ${show(rs)}`);
    const rows = rowsOf(w);
    must(rows.length === 3 && rows.every((r) => r.state === "idle" && r.outcome === "done" && r.parent_session === "main"), show(rows));
    // The spawn answered at once: the parent's second call (after the tool results) came before any child report.
    const firstParentAfter = w.requests.findIndex((r, i) => r.session === "main" && i > 0);
    const firstReportSeen = w.requests.findIndex((r) => r.session === "main" && r.req.messages.some((m: any) => JSON.stringify(m.content).includes("[subagent ")));
    must(firstParentAfter >= 0 && firstParentAfter < firstReportSeen, `the parent waited: ${firstParentAfter} ${firstReportSeen}`);
    // The tool results said started, with the ids.
    const toolResults = w.requests.filter((r) => r.session === "main")[1]!.req.messages.filter((m: any) => m.role === "tool");
    must(toolResults.length === 3 && toolResults.every((m: any) => /"status":"started"/.test(typeof m.content === "string" ? m.content : JSON.stringify(m.content))), show(toolResults));
    // Depth 1: no child was offered the tool; the parent was.
    const childReqs = w.requests.filter((r) => r.session.startsWith("sub_"));
    must(childReqs.length === 3, `child calls: ${childReqs.length}`);
    must(childReqs.every((r) => !toolNames(r.req).includes(SUBAGENT_TOOL)), `a child was offered the tool: ${show(childReqs.map((r) => toolNames(r.req)))}`);
    must(toolNames(w.requests[0]!.req).includes(SUBAGENT_TOOL), `the parent was not offered it: ${show(toolNames(w.requests[0]!.req))}`);
    // A child saw only its task, none of the parent's conversation.
    must(childReqs.every((r) => !JSON.stringify(r.req.messages).includes("split the count in three")), "a child saw the parent's conversation");
  });

  await check(`${engine}: a fourth spawn while three run is refused, and nothing starts`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session !== "main") return null;
      parentCalls++;
      return parentCalls === 1 ? calls(...[1, 2, 3, 4].map((i) => ({ id: `c${i}`, args: { task: `task ${i}` } }))) : say("waiting");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    const rows = rowsOf(w);
    must(rows.length === SUBAGENT_CAP && rows.every((r) => r.state === "running"), show(rows));
    const results = w.requests.filter((r) => r.session === "main")[1]!.req.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.stringify(m.content));
    must(results.length === 4 && results.filter((t) => /status\\+":\\+"started/.test(t)).length === 3, show(results));
    must(/already running, the most this agent may have at once/.test(results[3]!), `the fourth: ${results[3]}`);
  });

  await check(`${engine}: a follow-up to the same subagent keeps its history`, async () => {
    const w = await world(engine);
    let parentCalls = 0, child: string | null = null;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "remember the word BLUE and say ready" } });
        const m = /subagent (sub_[0-9a-f]+) — done/.exec(JSON.stringify(req.messages));
        if (m && !child) { child = m[1]!; return calls({ id: "c2", args: { task: "what was the word?", agent: child } }); }
        return say("ok");
      }
      const all = JSON.stringify(req.messages);
      return say(all.includes("what was the word?") ? (all.includes("BLUE") ? "the word was BLUE" : "I do not know") : "ready");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const rs = await reports(w);
    must(rs.length === 2 && rs[1]!.includes("the word was BLUE"), `reports: ${show(rs)}`);
    const rows = rowsOf(w);
    must(rows.length === 1 && rows[0].turns === 2 && rows[0].id === child, show(rows));
  });

  await check(`${engine}: a background job a subagent left ends after its report: the turn it starts is reported too`, async () => {
    const w = await world(engine, { builder: true });
    let parentCalls = 0;
    w.reply = (session, req) => {
      if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "start the build" } }) : say("ok"); }
      return say(JSON.stringify(req.messages).includes("[background job op_bg") ? "the build finished: built" : "the build is running");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    must((await reports(w)).length === 1, show(await reports(w)));
    recordBackgroundJob(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id: "op_bg", session: child, mount: "builder", tool: "builder__build", handle: {} }, Date.now());
    w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0 WHERE id = 'op_bg'");
    await settle(w);
    const rs = await reports(w);
    must(rs.length === 2 && rs[1]!.includes("the build finished: built"), show(rs));
    must(rowsOf(w)[0]!.turns === 2 && rowsOf(w)[0]!.state === "idle", show(rowsOf(w)));
  });

  await check(`${engine}: a follow-up to a subagent still running, or to an id this conversation never started, is refused`, async () => {
    const w = await world(engine);
    let parentCalls = 0, child: string | null = null;
    w.reply = (session, req) => {
      if (session !== "main") return null;
      parentCalls++;
      if (parentCalls === 1) return calls({ id: "c1", args: { task: "slow" } });
      if (parentCalls === 2) {
        child = /"agent\\+":\\+"(sub_[0-9a-f]+)/.exec(JSON.stringify(req.messages))?.[1] ?? null;
        return calls({ id: "c2", args: { task: "more", agent: child } }, { id: "c3", args: { task: "more", agent: "sub_nothere" } });
      }
      return say("ok");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 8; i++) await pass(w);
    const results = w.requests.filter((r) => r.session === "main")[2]!.req.messages.filter((m: any) => m.role === "tool").slice(-2).map((m: any) => JSON.stringify(m.content));
    must(/is still working on its last task/.test(results[0]!), results[0]!);
    must(/no subagent \\+"sub_nothere\\+" was started from this conversation/.test(results[1]!), results[1]!);
    must(rowsOf(w).length === 1 && rowsOf(w)[0].turns === 1, show(rowsOf(w)));
  });

  await check(`${engine}: stopping the parent stops every child: no report, and no model call after the stop`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session !== "main") return null;
      parentCalls++;
      return parentCalls === 1 ? calls(...[1, 2, 3].map((i) => ({ id: `c${i}`, args: { task: `long task ${i}` } }))) : say("started three");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    const out = w.sent.filter((x) => !w.answered.has(x));
    must(out.length === 3 && out.every((id) => sessionOfJob(w, id).startsWith("sub_")), `children's calls out: ${show(out.map((id) => sessionOfJob(w, id)))}`);
    // Zero-wait: with the parent's turn over and every child waiting on the model, a pass parks — it returns at once and
    // asks to come back only at the lost-answer backstop, not in a second (pd's "still running").
    const t0 = Date.now();
    const parked = await w.rt.step("t", "a");
    must(Date.now() - t0 < 5_000 && parked.wakeInMs !== null && parked.wakeInMs > 60_000, `did not park: ${show(parked)} in ${Date.now() - t0} ms`);
    const stop = await w.rt.stopTurn("t", "a", "provider_stop");
    must(stop.result === "interrupted", show(stop));
    must(rowsOf(w).every((r) => r.state === "idle" && r.outcome === "stopped"), show(rowsOf(w)));
    const sentAtStop = w.sent.length;
    // The answers to the calls that were out arrive and start nothing.
    w.reply = (session) => say(`late answer from ${session}`);
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
    must(w.sent.length === sentAtStop, `model calls after the stop: ${w.sent.slice(sentAtStop).map((id) => sessionOfJob(w, id))}`);
    must((await reports(w)).length === 0, `a report after the stop: ${show(await reports(w))}`);
  });

  await check(`${engine}: deleting the agent stops every child the same way`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session !== "main") return null;
      parentCalls++;
      return parentCalls === 1 ? calls({ id: "c1", args: { task: "long task" } }, { id: "c2", args: { task: "long task 2" } }) : say("started");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w).length === 2 && rowsOf(w).every((r) => r.state === "running"), show(rowsOf(w)));
    await w.rt.stopTurn("t", "a", "delete");
    must(rowsOf(w).every((r) => r.outcome === "stopped"), show(rowsOf(w)));
    const sentAtStop = w.sent.length;
    w.reply = () => say("late");
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
    must(w.sent.length === sentAtStop && (await reports(w)).length === 0, `after delete: ${w.sent.length - sentAtStop} calls, ${(await reports(w)).length} reports`);
  });

  await check(`${engine}: a restart while a child waits on the model still delivers its report`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session !== "main") return null;
      parentCalls++;
      return parentCalls === 1 ? calls({ id: "c1", args: { task: "survive" } }) : say("ok");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w)[0]?.state === "running", show(rowsOf(w)));
    // Evicted: a fresh isolate, nothing in memory; the queue answers the child's call through it.
    w.rt = w.isolate();
    await w.rt.ready();
    w.reply = (session) => session.startsWith("sub_") ? say("survived the restart") : say("thanks");
    await settle(w);
    const rs = await reports(w);
    must(rs.length === 1 && rs[0]!.includes("survived the restart"), show(rs));
  });

  await check(`${engine}: a child whose model call fails, and one cancelled at its ceiling, report so`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        return parentCalls === 1 ? calls({ id: "c1", args: { task: "fail please" } }, { id: "c2", args: { task: "hang please" } }) : say("ok");
      }
      return taskOf(req).includes("fail please") ? { error: "provider exploded" } : null;
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 8; i++) { await pass(w); await sleep(5); }
    const failed = (await reports(w)).filter((r) => / failed after /.test(r));
    must(failed.length === 1 && failed[0]!.includes("provider exploded"), show(await reports(w)));
    // The other passes its ceiling.
    w.raw.sql.exec("UPDATE subagents SET turn_started_at = turn_started_at - ? WHERE state = 'running'", 31 * 60_000);
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(5); }
    const cancelled = (await reports(w)).filter((r) => / cancelled after /.test(r));
    must(cancelled.length === 1 && /longer than 30 minutes/.test(cancelled[0]!), show(await reports(w)));
    must(rowsOf(w).map((r) => r.outcome).sort().join() === "cancelled,failed", show(rowsOf(w)));
    const sent = w.sent.length;
    for (let i = 0; i < 4; i++) { await pass(w); await sleep(5); }
    must(w.sent.filter((id, i) => i >= sent && sessionOfJob(w, id).startsWith("sub_")).length === 0, "the cancelled child called the model again");
  });

  await check(`${engine}: model picks an owner option, which the queue calls; an unknown one is refused`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session === "main") {
        parentCalls++;
        return parentCalls === 1
          ? calls({ id: "c1", args: { task: "cheap work", model: "cheap" } }, { id: "c2", args: { task: "x", model: "gpt-9000" } })
          : say("ok");
      }
      return say("done cheaply");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = w.requests.filter((r) => r.session.startsWith("sub_"));
    must(child.length === 1 && child[0]!.operatorModel === "m-cheap", show(child.map((c) => c.operatorModel)));
    must(w.requests.filter((r) => r.session === "main").every((r) => r.operatorModel === "m1"), show(w.requests.map((r) => [r.session, r.operatorModel])));
    const results = w.requests.filter((r) => r.session === "main")[1]!.req.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.stringify(m.content));
    // Refused, and nothing started: the parameter is an enum of the options (pi and pi-durable check it), and the body
    // checks the option again, for a list that moved since the harness was built.
    must(/gpt-9000/.test(results[1]!) && /(must be equal to one of the allowed values|no model option)/.test(results[1]!), results[1]!);
    must(rowsOf(w).length === 1 && rowsOf(w)[0].model_option === "cheap", show(rowsOf(w)));
    // Spend is the parent agent's: every usage row is agent `a`, the child's model among them.
    const usage = w.raw.sql.exec("SELECT DISTINCT agent_id, key FROM usage_outbox").toArray() as any[];
    must(usage.length > 0 && usage.every((u) => u.agent_id === "a"), show(usage));
    must(usage.some((u) => String(u.key).includes("m-cheap")), `the child's spend is not under the parent: ${show(usage)}`);
  });

  await check(`${engine}: model.call rows name their session; a child's Stop is neither Raft activity nor status`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("parent done"); }
      return say("child done");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const rows = trace(w);
    const calls_ = rows.filter((r) => r.kind === "model.call");
    const child = calls_.filter((r) => String(r.attrs.session).startsWith("sub_"));
    const parent = calls_.filter((r) => r.attrs.session === "main");
    must(child.length === 1 && child[0]!.status === "stop", show(calls_.map((r) => [r.status, r.attrs.session])));
    must(parent.length === calls_.length - 1, show(calls_.map((r) => r.attrs.session)));
    const turn = rows.filter((r) => r.kind === "subagent.turn");
    must(turn.length === 1 && turn[0]!.parentId === "c1" && turn[0]!.spanId === child[0]!.attrs.session && turn[0]!.status === "done", show(turn));
    // Activity: one Stop per parent stop, none from the child; no status event dated at the child's end.
    const events = activityEvents("a", rows);
    const stops = events.filter((e) => e.hookEventName === "Stop");
    must(stops.length === parent.filter((r) => r.status === "stop").length, `Stop events ${stops.length}: ${show(events.map((e) => e.hookEventName))}`);
    must(!events.some((e) => e.eventId === `a:${child[0]!.seq}`), "the child's model.call became an event");
    must(activityEvents("a", [child[0]!]).length === 0 && statusEvents("a", [child[0]!]).length === 0, "a child's Stop maps to an event");
    const online = statusEvents("a", rows).filter((e) => e.status === "online");
    must(online.length === parent.filter((r) => r.status === "stop").length, `online ${online.length}: ${show(statusEvents("a", rows))}`);
  });
}

await check("rules: the cap's refusal names what runs; a turn's end reads failed, cancelled and done", () => {
  must(admitSubagent([{ id: "sub_1", turnStartedAt: 0 }, { id: "sub_2", turnStartedAt: 0 }]).ok, "two refused");
  const r = admitSubagent([1, 2, 3].map((i) => ({ id: `sub_${i}`, turnStartedAt: 0 })), 3, 5_000);
  must(!r.ok && /sub_1 \(running 5s\)/.test(r.message), show(r));
  const msg = (role: string, extra: Record<string, unknown>, ts = 10) => ({ type: "message", timestamp: ts, message: { role, ...extra } }) as never;
  must(turnEnd([msg("assistant", { stopReason: "stop", content: [{ type: "text", text: "hi" }] })], 0, { status: "completed" }).outcome === "done", "done");
  must(turnEnd([msg("assistant", { stopReason: "error", errorMessage: "x" })], 0, { status: "completed" }).outcome === "failed", "error");
  must(turnEnd([], 0, { status: "failed", error: "bad config" }).text === "bad config", "failed before a call");
  must(turnEnd([msg("assistant", { stopReason: "stop", content: [] }, 1)], 5, { status: "completed" }).outcome === "failed", "an answer from before the turn counted");
  must(turnEnd([], 0, { status: "aborted" }).outcome === "cancelled", "aborted");
  const sql = sqliteHost().sql;
  must(agentSettings(sql as never).subagents === false, "on by default");
  const bad = updateAgentSettings(sql as never, { subagents: "yes" }, "t");
  must(!bad.ok && agentSettings(sql as never).subagents === false, show(bad));
  must(!updateAgentSettings(sql as never, { other: true }, "t").ok, "an unknown setting was accepted");
  // A child's tool call is no activity either: its task is the child's session.
  const toolRow = { seq: 1, at: 1000, tenantId: "t", agentId: "a", kind: "tool.call", spanId: "op_1", status: "succeeded", verdict: "ok", ms: 5, attrs: { tool: "shell", mount: "sandbox", task: "sub_abc" } } as never;
  must(activityEvents("a", [toolRow]).length === 0 && statusEvents("a", [toolRow]).length === 0, "a child's tool call maps to an event");
  const mainTool = { ...(toolRow as object), attrs: { tool: "shell", mount: "sandbox", task: "main" } } as never;
  must(activityEvents("a", [mainTool]).length === 2, "the agent's own tool call no longer maps");
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.name}`);
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`); }
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
