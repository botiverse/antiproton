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
import { updateAgentSettings, agentSettings, subagentsDisabledBy } from "../src/runtime/agent-settings.ts";
import { subagentActivityFor } from "../cf/src/activity-raft.ts";
import { DELEGATE_GUIDANCE, subagentTool } from "../src/runtime/subagents.ts";
import { recordBackgroundJob } from "../src/runtime/background-jobs.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { childWithheld, childMayCall, SUBAGENTS_READ_ONLY } from "../src/runtime/subagents.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { setLogSink } from "../src/core/log.ts";
import { sessionFor } from "../cf/src/transcript-read.ts";
import { sessionsWithWork } from "../src/runtime/pi-agent.ts";
import { returnPendingBriefing, takePendingBriefing, readBackstop } from "../src/runtime/overflow-backstop.ts";
import { subagentModelChoice } from "../cf/src/model-request.ts";
import { savesState } from "../src/plugins/raft.ts";
import { SUBAGENT_MAX_TURNS, SUBAGENT_LIFETIME_MS, REPORT_MAX_ATTEMPTS, recordSubagent } from "../src/runtime/subagents.ts";

const logs: any[] = [];
setLogSink((line) => { try { logs.push(JSON.parse(line)); } catch { /* not ours */ } });

/** A plugin whose writes act as the agent and that declares nothing, as every built-in one; how often its write ran. */
let posts = 0;
const chatter: Plugin = {
  id: "chatter", version: "1.0.0",
  tools: [
    { name: "post", description: "Post a message as the agent.", parameters: { type: "object", properties: { text: { type: "string" } } }, sideEffects: "write", idempotency: "none" },
    { name: "peek", description: "Read messages.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" },
  ] as never,
  async invoke(tool: string) { if (tool === "post") posts++; return { ok: true, tool }; },
} as Plugin;

/** A mount whose work goes to the background and is done at the first poll (test/overflow-backstop.ts has the same). */
/** A plugin whose writes act on the caller's own scratch and which says so (`actsAs: "self"`): its writes are a subagent's too. */
let scratched = 0;
const scratch: Plugin = {
  id: "scratch", version: "1.0.0", actsAs: "self",
  tools: [{ name: "note", description: "Keep a note for yourself.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" }] as never,
  async invoke() { scratched++; return { ok: true }; },
} as Plugin;

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
type Rules = { layers: { agent: any; tenant: any; deployment: any; owner: string | null }; pickerOff: boolean };
async function world(engine: "pi085" | "pd", opts: { on?: boolean; builder?: boolean; chatter?: boolean; sandbox?: boolean; rulesTtlMs?: number; slowBuilder?: number; retentionMs?: number; defaultOn?: boolean; disabled?: boolean } = {}) {
  const rules: { now: Rules | null; reads: number; fail: boolean } = { now: null, reads: 0, fail: false };
  const raw = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(raw, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const fault = { at: null as null | ((phase: string, id: string) => void | Promise<void>) };
  const standIn = standInLoader();
  // A mount whose background work ends only at the `slowBuilder`-th poll; `slow.polls` and `slow.cancelled` say what it saw.
  const slow = { polls: 0, cancelled: 0 };
  const slowPlugin = {
    id: "slow", version: "1.0.0",
    tools: [{ name: "build", description: "Build slowly.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" }],
    async invoke() { return { ok: true }; },
    background: {
      async poll() { slow.polls++; return slow.polls >= (opts.slowBuilder ?? 1) ? { done: true, result: "built slowly" } : { done: false }; },
      async cancel() { slow.cancelled++; },
    },
  } as unknown as Plugin;
  const plugins = [...(opts.builder || opts.chatter ? [builder] : []), ...(opts.chatter ? [chatter, scratch] : []), ...(opts.slowBuilder ? [slowPlugin] : [])];
  /** A runtime over this object, as a fresh isolate makes one: nothing opened, nothing remembered. */
  const isolate = () => new AgentRuntime({
    subagentFault: (phase: string, id: string) => fault.at?.(phase, id),
    subagentModelRules: async () => {
      rules.reads++;
      if (rules.fail) throw new Error("D1 did not answer");
      return rules.now ?? { layers: { agent: null, tenant: null, deployment: null, owner: null }, pickerOff: false };
    },
    subagentRulesTtlMs: opts.rulesTtlMs ?? 0,
    ...(opts.retentionMs !== undefined ? { subagentRetentionMs: opts.retentionMs } : {}),
    ...(opts.defaultOn ? { subagentsDefault: true } : {}),
    ...(opts.disabled ? { subagentsDisabled: true } : {}),
    ...(opts.sandbox ? { loader: standIn.loader, makeToolBinding: standIn.makeToolBinding } : {}),
    ctx: { storage: { sql: raw.sql, transactionSync: raw.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: opts.sandbox === true, autoRelease: false, userModels: USER_MODELS, ...(plugins.length ? { extraPlugins: plugins } : {}),
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  const w = {
    raw, sent, engine, rt: isolate(), isolate, fault, rules, slow,
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
  for (const [on, id, alias] of [[opts.builder || opts.chatter, "builder", "builder"], [opts.chatter, "chatter", "chat"], [opts.chatter, "scratch", "scratch"], [!!opts.slowBuilder, "slow", "slow"]] as const) {
    if (!on) continue;
    await w.rt.store.setPluginChoice("t", "a", id, "enable");
    must((await w.rt.addMount("t", "a", { alias, plugin: id, config: {} })).ok, `the ${id} mount was refused`);
  }
  await w.rt.bindOperatorModel("t", "a");
  // `on`: true stores the setting (the default for these cases), false stores the per-agent kill switch, and with
  // `defaultOn` nothing is stored, so the runtime's default decides.
  if (!opts.defaultOn && opts.on !== false) must(updateAgentSettings(raw.sql as never, { subagents: true }, "test").ok, "setting refused");
  if (opts.defaultOn && opts.on === false) must(updateAgentSettings(raw.sql as never, { subagents: false }, "test").ok, "setting refused");
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

/** The text of every message of a conversation (the main one unless named), oldest first. */
async function mainTexts(w: World, role: "user" | "assistant" = "user", session = "main"): Promise<string[]> {
  const entries = await w.rt.branchEntries("t", "a", session) as any[];
  return entries.filter((e) => e.type === "message" && e.message?.role === role).map((e) => {
    const c = e.message.content;
    return typeof c === "string" ? c : (c ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
  });
}
/** Each subagent report the conversation received, one per block: reports owed together arrive as one message. */
const reports = async (w: World, session = "main") => (await mainTexts(w, "user", session))
  .filter((t) => /^\[(subagent |\d+ subagent reports)/.test(t))
  .flatMap((t) => t.split(/(?=\[subagent sub_)/).filter((b) => b.startsWith("[subagent ")));
/** The messages that carried reports. */
const reportMessages = async (w: World, session = "main") => (await mainTexts(w, "user", session)).filter((t) => /^\[(subagent |\d+ subagent reports)/.test(t));
const rowsOf = (w: World) => w.raw.sql.exec("SELECT * FROM subagents ORDER BY created_at, id").toArray() as any[];
const toolNames = (req: Req) => (req.tools ?? []).map((t: any) => t.name ?? t.function?.name);
const taskOf = (req: Req) => {
  const u = req.messages.filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((p: any) => p.text ?? "").join(""));
  return u[0] ?? "";
};
const trace = (w: World) => pendingTrace(w.raw.sql as never, 0).rows;

for (const engine of (process.env.ENGINES ?? "pi085,pd").split(",").filter((e) => e === "pi085" || e === "pd") as Array<"pi085"|"pd">) {
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

  for (const phase of ["report-decided", "report-posted"] as const) {
    await check(`${engine}: a crash at ${phase} delivers the report exactly once`, async () => {
      const w = await world(engine);
      let parentCalls = 0;
      w.reply = (session) => {
        if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok"); }
        return say("the one report");
      };
      let crashed = 0;
      w.fault.at = (p) => { if (p === phase && crashed === 0) { crashed++; throw new Error(`crash at ${p}`); } };
      await w.rt.postMessage("t", "a", "go", "prompt", "main");
      for (let i = 0; i < 12 && !crashed; i++) { await pass(w).catch((e) => { if (!/crash at/.test(String(e))) throw e; }); await sleep(5); }
      must(crashed === 1, "the crash never happened");
      must(rowsOf(w)[0]?.state === "reporting", `not owed after the crash: ${show(rowsOf(w))}`);
      // The isolate is gone; a fresh one finds the report owed.
      w.rt = w.isolate();
      await w.rt.ready();
      await settle(w);
      const rs = await reports(w);
      must(rs.length === 1 && rs[0]!.includes("the one report"), `reports: ${show(rs)}`);
      must(rowsOf(w)[0]?.state === "idle" && rowsOf(w)[0]?.outcome === "done", show(rowsOf(w)));
    });
  }

  await check(`${engine}: a crash after two reports were posted together: after the restart neither is posted again`, async () => {
    const w = await world(engine);
    let parentCalls = 0, release = false;
    w.reply = (session, req) => {
      if (session === "main") return ++parentCalls === 1 ? calls({ id: "c1", args: { task: "part A" } }, { id: "c2", args: { task: "part B" } }) : say("ok");
      return release ? say(`report of ${/part (\w)/.exec(taskOf(req))?.[1]}`) : null;
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    let crashed = 0;
    w.fault.at = (p) => { if (p === "report-posted" && crashed === 0) { crashed++; throw new Error("crash at report-posted"); } };
    release = true;
    for (let i = 0; i < 12 && !crashed; i++) { await pass(w).catch((e) => { if (!/crash at/.test(String(e))) throw e; }); await sleep(5); }
    must(crashed === 1 && (await reportMessages(w)).length === 1, `control: ${crashed} crashes, ${(await reportMessages(w)).length} messages`);
    w.fault.at = null;
    w.rt = w.isolate();
    await w.rt.ready();
    await settle(w);
    must((await reportMessages(w)).length === 1 && (await reports(w)).length === 2, `posted again: ${(await reportMessages(w)).length} messages, ${(await reports(w)).length} reports`);
    must(rowsOf(w).every((r) => r.state === "idle"), show(rowsOf(w)));
  });

  for (const phase of ["report-decided", "report-posted", "report-written"] as const) {
    await check(`${engine}: two reports posted together to a BUSY parent, then ${phase === "report-written" ? "a post that commits and then throws" : `a crash at ${phase}`}: each lands once`, async () => {
      const w = await world(engine);
      let parentCalls = 0, releaseChildren = false, parentBusy = false;
      w.reply = (session, req) => {
        if (session === "main") {
          parentCalls++;
          if (parentCalls === 1) return calls({ id: "c1", args: { task: "part A" } }, { id: "c2", args: { task: "part B" } });
          return parentBusy ? null : say(`parent ${parentCalls}`);
        }
        return releaseChildren ? say(`report of ${/part (\w)/.exec(taskOf(req))?.[1]}`) : null;
      };
      await w.rt.postMessage("t", "a", "go", "prompt", "main");
      for (let i = 0; i < 6; i++) await pass(w);
      // The parent runs: its model call is out and held, so a report posted now is queued behind it.
      parentBusy = true;
      await w.rt.postMessage("t", "a", "keep working", "prompt", "main");
      for (let i = 0; i < 3; i++) await pass(w);
      let crashed = 0;
      w.fault.at = (p) => { if (p === phase && crashed === 0) { crashed++; throw new Error(`crash at ${p}`); } };
      releaseChildren = true;
      for (let i = 0; i < 12 && !crashed; i++) { await pass(w).catch((e) => { if (!/crash at/.test(String(e))) throw e; }); await sleep(5); }
      must(crashed === 1, "the fault never fired");
      // A crash is an isolate gone; a post that threw is retried by the same one once due.
      w.fault.at = null;
      if (phase !== "report-written") { w.rt = w.isolate(); await w.rt.ready(); }
      w.raw.sql.exec("UPDATE subagents SET report_retry_at = 0 WHERE state = 'reporting'");
      for (let i = 0; i < 4; i++) { await pass(w); await sleep(5); }
      parentBusy = false;
      await settle(w);
      const blocks = await reports(w);
      for (const n of ["A", "B"]) {
        const seen = blocks.filter((b) => b.includes(`report of ${n}`)).length;
        must(seen === 1, `${phase}: the report of ${n} landed ${seen} times: ${show(blocks.map((b) => b.slice(0, 60)))}`);
      }
      must(rowsOf(w).every((r) => r.state === "idle"), show(rowsOf(w)));
    });
  }

  await check(`${engine}: A's report posted alone, a crash, then B owed beside it: B is delivered once and A is not posted again`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    const released = new Set<string>();
    w.reply = (session, req) => {
      if (session === "main") return ++parentCalls === 1 ? calls({ id: "c1", args: { task: "part A" } }, { id: "c2", args: { task: "part B" } }) : say("ok");
      const n = /part (\w)/.exec(taskOf(req))?.[1] ?? "?";
      return released.has(n) ? say(`report of ${n}`) : null;
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    let crashed = 0;
    w.fault.at = (p) => { if (p === "report-posted" && crashed === 0) { crashed++; throw new Error("crash at report-posted"); } };
    released.add("A");
    for (let i = 0; i < 12 && !crashed; i++) { await pass(w).catch((e) => { if (!/crash at/.test(String(e))) throw e; }); await sleep(5); }
    must(crashed === 1 && (await reports(w)).length === 1, `control: ${crashed}, ${(await reports(w)).length}`);
    w.fault.at = null;
    w.rt = w.isolate();
    await w.rt.ready();
    // B's answer lands before the restarted isolate's first pass, so that pass owes A (still marked owed) and B together.
    released.add("B");
    for (const id of w.sent.filter((x) => !w.answered.has(x))) {
      const job = await w.rt.takeJob("t", "a", id).catch(() => null) as Job | null;
      if (!job) continue;
      w.answered.add(id); w.held.delete(id);
      const req = toRequest(job.context);
      w.requests.push({ session: sessionOfJob(w, id), req, operatorModel: job.operatorModel ?? null });
      await w.rt.deliverAnswer("t", "a", id, fromResponse(w.reply(sessionOfJob(w, id), req) as ModelResponse, job.model, id), undefined);
    }
    await settle(w);
    const blocks = await reports(w);
    must(blocks.filter((b) => b.includes("report of A")).length === 1 && blocks.filter((b) => b.includes("report of B")).length === 1,
      `A ${blocks.filter((b) => b.includes("report of A")).length}, B ${blocks.filter((b) => b.includes("report of B")).length}`);
  });

  await check(`${engine}: A and B posted together, a crash, then C owed beside them: only C is posted`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    const released = new Set<string>();
    w.reply = (session, req) => {
      if (session === "main") return ++parentCalls === 1 ? calls(...["A", "B", "C"].map((n, i) => ({ id: `c${i}`, args: { task: `part ${n}` } }))) : say("ok");
      const n = /part (\w)/.exec(taskOf(req))?.[1] ?? "?";
      return released.has(n) ? say(`report of ${n}`) : null;
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    const answerHeld = async () => {
      for (const id of w.sent.filter((x) => !w.answered.has(x))) {
        const job = await w.rt.takeJob("t", "a", id).catch(() => null) as Job | null;
        if (!job) continue;
        const req = toRequest(job.context), r = w.reply(sessionOfJob(w, id), req);
        if (r === null) continue;
        w.answered.add(id); w.held.delete(id);
        w.requests.push({ session: sessionOfJob(w, id), req, operatorModel: job.operatorModel ?? null });
        await w.rt.deliverAnswer("t", "a", id, fromResponse(r as ModelResponse, job.model, id), undefined);
      }
    };
    let crashed = 0;
    w.fault.at = (p) => { if (p === "report-posted" && crashed === 0) { crashed++; throw new Error("crash at report-posted"); } };
    released.add("A"); released.add("B");
    await answerHeld();
    for (let i = 0; i < 6 && !crashed; i++) { await pass(w).catch((e) => { if (!/crash at/.test(String(e))) throw e; }); await sleep(5); }
    must(crashed === 1 && (await reportMessages(w)).length === 1 && (await reports(w)).length === 2, "control: A and B were not posted together");
    w.fault.at = null;
    w.rt = w.isolate();
    await w.rt.ready();
    released.add("C");
    await answerHeld();
    await settle(w);
    const blocks = await reports(w);
    for (const n of ["A", "B", "C"]) {
      const seen = blocks.filter((b) => b.includes(`report of ${n}`)).length;
      must(seen === 1, `the report of ${n} landed ${seen} times`);
    }
  });

  await check(`${engine}: a report dropped after its attempts leaves the parent a notice that it could not be delivered`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("the lost report");
    w.fault.at = (p) => { if (p === "report-posting") throw new Error("the parent's lane said no"); };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    const has = () => w.raw.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'subagents'").toArray().length > 0;
    for (let i = 0; i < 30 && !(has() && rowsOf(w)[0]?.state === "idle"); i++) {
      await pass(w);
      if (has()) w.raw.sql.exec("UPDATE subagents SET report_retry_at = 0 WHERE state = 'reporting'");
    }
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    const notices = (await mainTexts(w)).filter((t) => t.includes(`the report of subagent ${child} (undelivered ${child}/1) could not be delivered`));
    must(notices.length === 1, `notices: ${show(await mainTexts(w))}`);
    must(!(await mainTexts(w)).some((t) => t.includes("the lost report")), "the dropped report itself landed");
  });

  await check(`${engine}: an isolate dying mid-spawn: the replayed send finds the child it made, and the parent is told about it`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "the only child" } });
        return say(JSON.stringify(req.messages).includes("[subagent ") ? "thanks" : "started it");
      }
      return say("child answer");
    };
    let hung = false;
    w.fault.at = (p) => { if (p === "task-posted" && !hung) { hung = true; return new Promise<void>(() => {}); } };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 12 && !hung; i++) { await Promise.race([pass(w), sleep(1_000)]); }
    must(hung, "the spawn never reached its task being posted");
    must(rowsOf(w).length === 1, show(rowsOf(w)));
    // The isolate died there: its pass never returns. A fresh one recovers the interrupted call and runs it again.
    w.fault.at = null;
    w.rt = w.isolate();
    await w.rt.ready();
    await settle(w);
    must(rowsOf(w).length === 1, `a second child: ${show(rowsOf(w))}`);
    const children = new Set(w.requests.filter((r) => r.session.startsWith("sub_")).map((r) => r.session));
    must(children.size === 1 && children.has(rowsOf(w)[0].id), show([...children]));
    const results = w.requests.filter((r) => r.session === "main").flatMap((r) => r.req.messages.filter((m: any) => m.role === "tool"))
      .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    must(results.length > 0 && results.every((t) => t.includes(`"agent":"${rowsOf(w)[0].id}"`) && /"status":"started"/.test(t)), `the parent was not told: ${show(results)}`);
    must((await reports(w)).length === 1, show(await reports(w)));
  });

  await check(`${engine}: a subagent is read-only: offered only reads and a self-acting plugin's writes; any other call, a program's by alias or plugin id, is refused`, async () => {
    const w = await world(engine, { chatter: true, sandbox: true });
    posts = 0; scratched = 0;
    let parentCalls = 0, childCalls = 0;
    w.reply = (session) => {
      if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "tell everyone hi" } }) : say("ok"); }
      childCalls++;
      return childCalls === 1
        ? ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "j1", name: "run_js", arguments: { source:
            // A write of an undeclared plugin by alias and by plugin id; a write of a new plugin that declares nothing; and
            // a self-acting plugin's write, which goes through.
            "for (const t of ['chat.post', 'chatter.post', 'builder.build', 'scratch.note']) { try { output(t + ': ' + JSON.stringify(await tool([t + ' ', ''], { text: 'hi' }))); } catch (e) { output(t + ': ' + String(e?.message ?? e)); } }" } }] } as ModelResponse)
        : say("done reading");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const parentTools = toolNames(w.requests.find((r) => r.session === "main")!.req);
    const childTools = toolNames(w.requests.find((r) => r.session.startsWith("sub_"))!.req);
    for (const t of ["chat__post", "chat__peek", "builder__build", "scratch__note", "jobs"]) must(parentTools.includes(t), `the agent lost ${t}: ${show(parentTools)}`);
    for (const t of ["chat__post", "builder__build", "jobs", SUBAGENT_TOOL]) must(!childTools.includes(t), `the child was offered ${t}: ${show(childTools)}`);
    for (const t of ["chat__peek", "scratch__note", "run_js"]) must(childTools.includes(t), `the child lost ${t}, which it may have: ${show(childTools)}`);
    must(posts === 0 && scratched === 1, `the child's program wrote: posts ${posts}, scratch ${scratched}`);
    const result = JSON.stringify(w.requests.filter((r) => r.session.startsWith("sub_"))[1]!.req.messages.filter((m: any) => m.role === "tool"));
    must((result.match(/chat\.post is not a read, and a subagent only reads/g) ?? []).length === 2, `chat.post not refused by alias and by plugin id: ${result.slice(0, 700)}`);
    must(/builder\.build is not a read, and a subagent only reads/.test(result) && !/scratch\.note[^"]*not a read/.test(result), `the undeclared plugin or the self plugin: ${result.slice(0, 700)}`);
  });

  await check(`${engine}: a ceiling cancel that throws still leaves no model call after the next pass`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    // A child that never ends on its own: every answer asks for a tool it is not offered.
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "loop" } }) : say("ok"))
      : ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: `l${w.requests.length}`, name: "nonexistent_tool", arguments: {} }] } as ModelResponse);
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    const child = rowsOf(w)[0]!.id as string;
    must(w.requests.filter((r) => r.session === child).length > 0, "control: the child never called the model");
    w.raw.sql.exec("UPDATE subagents SET turn_started_at = turn_started_at - ? WHERE id = ?", 31 * 60_000, child);
    let threw = 0;
    w.fault.at = (p) => { if (p === "ceiling-cancel" && threw === 0) { threw++; throw new Error("the cancel did not get through"); } };
    await pass(w);
    must(threw === 1 && rowsOf(w)[0]!.outcome === "cancelled", `control: ${threw} ${show(rowsOf(w))}`);
    w.fault.at = null;
    await pass(w);
    const after = w.requests.filter((r) => r.session === child).length;
    for (let i = 0; i < 5; i++) { await pass(w); await sleep(10); }
    must(w.requests.filter((r) => r.session === child).length === after, `the child kept calling the model: ${w.requests.filter((r) => r.session === child).length - after} more`);
    // Ended, not only left unstepped: a run left in its lane would resume on the session's next post.
    must(!(await (await w.rt.agent("t", "a", child)).running()), "the child's run is still in its lane");
  });

  await check(`${engine}: an Agents API session's cancel opens no finished child of it: twenty of them, none opened`, async () => {
    const w = await world(engine);
    for (let i = 0; i < 20; i++) {
      const id = `sub_${String(i).padStart(16, "0")}`;
      recordSubagent(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id, parentSession: "sess_x", callId: `c${i}`, modelOption: null, provider: null, model: null, turnOp: null, turnKey: null, now: Date.now() });
      w.raw.sql.exec("UPDATE subagents SET state = 'idle', outcome = 'done' WHERE id = ?", id);
    }
    w.rt = w.isolate();
    await w.rt.ready();
    const opens = () => trace(w).filter((r) => r.kind === "harness.open" && String(r.spanId).includes("#sub_")).length;
    const before = opens();
    await w.rt.cancelSessionTree("t", "a", "sess_x");
    must(opens() === before, `the cancel opened ${opens() - before} finished children`);
  });

  await check(`${engine}: two reports dropped together leave the parent one notice naming both`, async () => {
    const w = await world(engine);
    let parentCalls = 0, release = false;
    w.reply = (session, req) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "A" } }, { id: "c2", args: { task: "B" } }) : say("ok"))
      : release ? say(`lost ${taskOf(req).slice(-1)}`) : null;
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    w.fault.at = (p) => { if (p === "report-posting") throw new Error("the parent's lane said no"); };
    release = true;
    const has = () => w.raw.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'subagents'").toArray().length > 0;
    for (let i = 0; i < 40 && !(has() && rowsOf(w).every((r) => r.state === "idle")); i++) {
      await pass(w);
      w.raw.sql.exec("UPDATE subagents SET report_retry_at = 0 WHERE state = 'reporting'");
    }
    await settle(w);
    const notices = (await mainTexts(w)).filter((t) => t.includes("could not be delivered"));
    must(notices.length === 1 && rowsOf(w).every((r) => notices[0]!.includes(r.id)), `notices: ${show(notices)}`);
  });

  await check(`${engine}: a stop landing while a task is being posted leaves no run: the spawn cancels it itself, and says so`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => {
      if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "late child" } }) : say("ok"); }
      return say("the child ran");
    };
    // What a stop does to a spawn whose post is in flight, landing in that window: the row marked stopped
    // (`stopRunningSubagents`) and the child's session cancelled, which has nothing to cancel yet. The stop's abort of
    // the parent's own turn is left out: in one isolate it would take the spawn's detached post down with it, which a
    // stop arriving from another request does not.
    let stopped = false;
    w.fault.at = async (p, id) => {
      if (p !== "task-posting" || stopped) return;
      stopped = true;
      w.raw.sql.exec("UPDATE subagents SET state = 'idle', outcome = 'stopped' WHERE id = ?", id);
      await w.rt.cancelSession("t", "a", id);
    };
    logs.length = 0;
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 8 && !stopped; i++) await pass(w);
    must(stopped, "the stop never landed");
    const child = rowsOf(w)[0]!.id as string;
    // The spawn's own check cancelled the run its post started: nothing was left for the sweep.
    must(!logs.some((l) => l.evt === "subagent.stray"), "the stray sweep caught the run, not the spawn");
    const results = w.requests.filter((r) => r.session === "main").flatMap((r) => r.req.messages.filter((m: any) => m.role === "tool"))
      .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    must(results.some((t) => /was stopped while .* was being started/.test(t)), `the parent was not told: ${show(results)}`);
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
    must(!w.requests.some((r) => r.session === child), `the stopped child called the model: ${w.requests.filter((r) => r.session === child).length}`);
    must(rowsOf(w)[0]!.outcome === "stopped" && (await reports(w)).length === 0, show(rowsOf(w)));
  });

  await check(`${engine}: a subagent run with work and no running row is cancelled by the next pass; a stop cancels it at once`, async () => {
    for (const how of ["sweep", "stop"] as const) {
      const w = await world(engine, { builder: true });
      let parentCalls = 0;
      const loop = () => ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: `b${w.requests.length}`, name: "builder__build", arguments: {} }] } as ModelResponse);
      w.reply = (session) => {
        if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "loop" } }) : say("ok"); }
        return loop();
      };
      await w.rt.postMessage("t", "a", "go", "prompt", "main");
      for (let i = 0; i < 6; i++) await pass(w);
      const child = rowsOf(w)[0]!.id as string;
      must(w.requests.some((r) => r.session === child), "control: the child never called the model");
      // What a lost race leaves: the row says no turn runs, the session still runs one.
      w.raw.sql.exec("UPDATE subagents SET state = 'idle', outcome = 'stopped' WHERE id = ?", child);
      logs.length = 0;
      if (how === "stop") {
        await w.rt.stopTurn("t", "a", "provider_stop");
        must(!(await (await w.rt.agent("t", "a", child)).running()), `${how}: the stop left the child's run alive`);
      }
      const before = w.requests.filter((r) => r.session === child).length;
      for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
      const after = w.requests.filter((r) => r.session === child).length;
      must(after - before <= 1, `${how}: the untracked child kept calling the model: ${after - before} more calls`);
      if (how === "sweep") must(logs.some((l) => l.evt === "subagent.stray" && l.subagent === child), "the sweep did not name it");
    }
  });

  await check(`${engine}: a stop landing while a report is being posted: the parent's turn it started is cancelled`, async () => {
    const w = await world(engine);
    let parentCalls = 0, stopped = false;
    w.reply = (session) => {
      if (session === "main") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say(`parent call ${parentCalls}`); }
      return say("report text");
    };
    w.fault.at = async (p) => { if (p === "report-posting" && !stopped) { stopped = true; await w.rt.stopTurn("t", "a", "provider_stop"); } };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 12 && !stopped; i++) { await pass(w); await sleep(5); }
    must(stopped, "the stop never landed");
    const mainBefore = w.requests.filter((r) => r.session === "main").length;
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
    const mainAfter = w.requests.filter((r) => r.session === "main").length;
    must(mainAfter === mainBefore, `the stopped parent answered the report: ${mainAfter - mainBefore} calls`);
    must(rowsOf(w)[0]!.outcome === "stopped" && rowsOf(w)[0]!.state === "idle", show(rowsOf(w)));
  });

  await check(`${engine}: an Agents API session's cancel and delete reach its subagents`, async () => {
    for (const how of ["cancel", "delete"] as const) {
      const w = await world(engine);
      let parentCalls = 0;
      w.reply = (session) => {
        if (session === "sess_1") { parentCalls++; return parentCalls === 1 ? calls({ id: "c1", args: { task: "x" } }) : say("ok"); }
        return null;
      };
      await w.rt.postMessage("t", "a", "go", "prompt", "sess_1");
      for (let i = 0; i < 6; i++) await pass(w);
      must(rowsOf(w)[0]?.state === "running" && rowsOf(w)[0]?.parent_session === "sess_1", show(rowsOf(w)));
      const out = await w.rt.cancelSessionTree("t", "a", "sess_1", how === "delete" ? { childrenOnly: true } : {});
      must(out.stoppedSubagents.length === 1 && rowsOf(w)[0]!.outcome === "stopped", `${how}: ${show(out)} ${show(rowsOf(w))}`);
      w.reply = () => say("late");
      const sent = w.sent.length;
      for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
      must(w.sent.slice(sent).every((id) => !sessionOfJob(w, id).startsWith("sub_")) && (await reports(w)).length === 0, `${how}: the child went on`);
    }
  });

  await check(`${engine}: the model option obeys an administrator's pin and the picker switch, at the spawn and at each call`, async () => {
    const w = await world(engine);
    w.rules.now = { layers: { agent: null, tenant: { provider: null, model: "m1" }, deployment: null, owner: null }, pickerOff: false };
    let parentCalls = 0, child = 0;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "pinned", model: "cheap" } });
        if (parentCalls === 2) { w.rules.now = null; return calls({ id: "c2", args: { task: "free", model: "cheap" } }); }
        return say("ok");
      }
      child++;
      // Pinned after the spawn: the next call runs on the agent's model.
      w.rules.now = { layers: { agent: { provider: null, model: "m1" }, tenant: null, deployment: null, owner: null }, pickerOff: false };
      return child === 1 ? calls({ id: "b1", args: { task: "never runs" } }) : say("done");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const results = w.requests.filter((r) => r.session === "main").flatMap((r) => r.req.messages.filter((m: any) => m.role === "tool"))
      .map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    must(results.some((t) => /an administrator has set this agent's model/.test(t)), `a locked agent's child was started on the option: ${show(results)}`);
    const childCalls = w.requests.filter((r) => r.session.startsWith("sub_"));
    must(childCalls.length >= 2 && childCalls[0]!.operatorModel === "m-cheap" && childCalls.slice(1).every((c) => c.operatorModel === "m1"),
      `a pin set after the spawn was not applied: ${show(childCalls.map((c) => c.operatorModel))}`);
  });

  await check(`${engine}: one report that fails to post does not hold up another conversation's, or the rest of the pass`, async () => {
    const w = await world(engine);
    const calls_ = new Map<string, number>();
    let release = false;
    w.reply = (session, req) => {
      if (!session.startsWith("sub_")) {
        const n = (calls_.get(session) ?? 0) + 1;
        calls_.set(session, n);
        return n === 1 ? calls({ id: `c_${session}`, args: { task: `from ${session}` } }) : say("ok");
      }
      return release ? say(`answer to ${/from (\w+)/.exec(taskOf(req))?.[1]}`) : null;
    };
    let failing: string | null = null;
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await w.rt.postMessage("t", "a", "go", "prompt", "sess_b");
    for (let i = 0; i < 6; i++) await pass(w);
    failing = rowsOf(w).find((r) => r.parent_session === "main")?.id ?? null;
    must(failing && rowsOf(w).length === 2, show(rowsOf(w)));
    w.fault.at = (p, id) => { if (p === "report-posting" && id === failing) throw new Error("the parent's lane said no"); };
    release = true;
    for (let i = 0; i < 12; i++) { await pass(w); await sleep(5); }
    must((await reports(w, "sess_b")).length === 1 && (await reports(w, "main")).length === 0, `the other conversation's report did not arrive`);
    const owed = rowsOf(w).find((r) => r.id === failing)!;
    must(owed.state === "reporting" && owed.report_attempts >= 1 && owed.report_retry_at > Date.now() - 1_000, show(owed));
    must(trace(w).some((r) => r.kind === "subagent.turn" && r.status === "report_failed" && r.spanId === failing), "no trace row for the failed post");
    // Tried again once it is due, and lands.
    w.fault.at = null;
    w.raw.sql.exec("UPDATE subagents SET report_retry_at = 0 WHERE id = ?", failing);
    await settle(w);
    must((await reports(w, "main")).length === 1 && rowsOf(w).every((r) => r.state === "idle"), show(rowsOf(w)));
  });

  await check(`${engine}: a background wake respects the owed report, the turn cap and the lifetime`, async () => {
    const w = await world(engine, { builder: true });
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("child");
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    const wake = (id: string) => {
      recordBackgroundJob(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id, session: child, mount: "builder", tool: "builder__build", handle: {} }, Date.now());
      w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0 WHERE id = ?", id);
    };
    for (const [why, set] of [
      ["owed a report", "state = 'reporting', report = 'r'"],
      ["out of turns", `state = 'idle', report = NULL, turns = ${SUBAGENT_MAX_TURNS}`],
      ["past its lifetime", `state = 'idle', turns = 1, created_at = ${Date.now() - SUBAGENT_LIFETIME_MS - 1}`],
    ] as const) {
      w.raw.sql.exec(`UPDATE subagents SET ${set} WHERE id = ?`, child);
      const turns = rowsOf(w)[0]!.turns, sent = w.sent.length;
      wake(`op_${why.replace(/ /g, "_")}`);
      await w.rt.step("t", "a");
      must(rowsOf(w)[0]!.turns === turns && w.sent.slice(sent).every((id) => sessionOfJob(w, id) !== child), `${why}: the wake started a run`);
    }
  });


  await check(`${engine}: a parent in a non-main conversation is woken by each of three reports, arriving across passes, with no other input`, async () => {
    const w = await world(engine);
    const P = "sess_api1";
    let parentCalls = 0;
    const released = new Set<string>();
    w.reply = (session, req) => {
      if (session === P) {
        parentCalls++;
        return parentCalls === 1 ? calls(...[1, 2, 3].map((i) => ({ id: `c${i}`, args: { task: `part ${i}` } }))) : say(`noted ${parentCalls}`);
      }
      const n = /part (\d)/.exec(taskOf(req))?.[1] ?? "?";
      return released.has(n) ? say(`report of part ${n}`) : null;
    };
    await w.rt.postMessage("t", "a", "start", "prompt", P);
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w).length === 3 && rowsOf(w).every((r) => r.parent_session === P && r.state === "running"), show(rowsOf(w)));
    for (const n of ["1", "2", "3"]) {
      released.add(n);
      const callsBefore = w.requests.filter((r) => r.session === P).length;
      let landed = false;
      for (let i = 0; i < 10 && !landed; i++) {
        await pass(w);
        landed = (await reports(w, P)).some((t) => t.includes(`report of part ${n}`));
      }
      must(landed, `report ${n} never became visible in ${P}: ${show(await reports(w, P))}`);
      // pi085 steps only the sessions its list says have work: the report put the parent on it.
      if (engine === "pi085") must(sessionsWithWork(w.raw.sql as never).includes(P), `${P} was not marked to be stepped`);
      for (let i = 0; i < 4 && w.requests.filter((r) => r.session === P).length === callsBefore; i++) await pass(w);
      const after = w.requests.filter((r) => r.session === P);
      must(after.length > callsBefore, `report ${n}: the parent made no model call`);
      must(JSON.stringify(after.at(-1)!.req.messages).includes(`report of part ${n}`), `report ${n}: the parent's call did not carry it`);
    }
    must((await reports(w, P)).length === 3 && (await reports(w, "main")).length === 0, `reports went elsewhere: ${show(await reports(w, "main"))}`);
  });

  await check(`${engine}: an operator can read a subagent's transcript by its session; another sub_ id is not one`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("child answer");
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    w.raw.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
    w.raw.sql.exec("INSERT OR IGNORE INTO owner VALUES ('self', 't', 'a')");
    const child = rowsOf(w)[0]!.id as string;
    must(sessionFor(w.raw.sql as never, "t", "a", child) === child, "a child's session is not readable by its id");
    must(sessionFor(w.raw.sql as never, "t", "a", "sub_0000000000000000") === null, "an unknown sub_ id was read as a conversation");
    must(sessionFor(w.raw.sql as never, "t", "other", child) === null, "another agent's id reads this agent's child");
  });


  await check(`${engine}: a finished child's background job that needs five polls completes and is reported: the sweep leaves it alone`, async () => {
    const w = await world(engine, { slowBuilder: 5 });
    let parentCalls = 0;
    w.reply = (session, req) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "start the slow build" } }) : say("ok"))
      : say(JSON.stringify(req.messages).includes("[background job op_slow") ? "the slow build finished" : "the build is running");
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    must((await reports(w)).length === 1 && rowsOf(w)[0]!.state === "idle", show(rowsOf(w)));
    recordBackgroundJob(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id: "op_slow", session: child, mount: "slow", tool: "slow__build", handle: {} }, Date.now());
    logs.length = 0;
    for (let i = 0; i < 12 && w.slow.polls < 5; i++) {
      w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0 WHERE id = 'op_slow' AND state = 'running'");
      await pass(w);
    }
    await settle(w);
    must(w.slow.cancelled === 0 && !logs.some((l) => l.evt === "subagent.stray"), `the idle child's job was taken for a stray run: cancelled ${w.slow.cancelled}`);
    must(w.slow.polls >= 5, `polled ${w.slow.polls} times`);
    const rs = await reports(w);
    must(rs.length === 2 && rs[1]!.includes("the slow build finished"), show(rs));
  });

  await check(`${engine}: a stop and the person's next message while a report is being posted: the message is answered, no report lands`, async () => {
    const w = await world(engine);
    let parentCalls = 0, stopped = false;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "t" } });
        return say(JSON.stringify(req.messages).includes("a new question") ? "the answer to the new question" : "ok");
      }
      return say("report text");
    };
    w.fault.at = async (p) => {
      if (p !== "report-posting" || stopped) return;
      stopped = true;
      await w.rt.stopTurn("t", "a", "provider_stop");
      await w.rt.postMessage("t", "a", "a new question", "prompt", "main");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 12 && !stopped; i++) { await pass(w); await sleep(5); }
    must(stopped, "the stop never landed");
    await settle(w);
    must((await reports(w)).length === 0, `a report landed after the stop: ${show(await reports(w))}`);
    const answers = await mainTexts(w, "assistant");
    must(answers.includes("the answer to the new question"), `the person's message after the stop was not answered: ${show(answers)}`);
  });

  await check(`${engine}: a report that never posts is dropped after its attempts: report_dropped, and the child no longer counts as busy`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("unpostable report");
    w.fault.at = (p) => { if (p === "report-posting") throw new Error("the parent's lane said no"); };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    const has = () => w.raw.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'subagents'").toArray().length > 0;
    for (let i = 0; i < 30 && !(has() && rowsOf(w)[0]?.state === "idle"); i++) {
      await pass(w);
      if (has()) w.raw.sql.exec("UPDATE subagents SET report_retry_at = 0 WHERE state = 'reporting'");
    }
    const row = rowsOf(w)[0]!;
    must(row.state === "idle" && row.outcome === "report_failed" && row.report_attempts === REPORT_MAX_ATTEMPTS, show(row));
    must(trace(w).filter((r) => r.kind === "subagent.turn" && r.status === "report_dropped").length === 1, "no report_dropped row");
    must(!/subagent/.test(w.rt.notIdle() ?? ""), `still counted as busy: ${w.rt.notIdle()}`);
  });

  await check(`${engine}: the model rules: a change is traced and told in the next report; an unreadable read keeps the decision; reads are shared`, async () => {
    for (const how of ["pinned", "unreadable", "cached"] as const) {
      const w = await world(engine, how === "cached" ? { rulesTtlMs: 60_000 } : {});
      let parentCalls = 0, childCalls = 0;
      w.reply = (session) => {
        if (session === "main") return ++parentCalls === 1 ? calls({ id: "c1", args: { task: "work", model: "cheap" } }) : say("ok");
        childCalls++;
        if (childCalls === 1) {
          if (how === "pinned") w.rules.now = { layers: { agent: { provider: null, model: "m1" }, tenant: null, deployment: null, owner: null }, pickerOff: false };
          if (how === "unreadable") w.rules.fail = true;
        }
        return childCalls < 4 ? calls({ id: `x${childCalls}`, args: { task: "loop" } }) : say("done");
      };
      await w.rt.postMessage("t", "a", "go", "prompt", "main");
      await settle(w);
      const models = w.requests.filter((r) => r.session.startsWith("sub_")).map((r) => r.operatorModel);
      const changed = trace(w).filter((r) => r.kind === "subagent.model_changed");
      const report = (await reports(w))[0] ?? "";
      if (how === "pinned") {
        must(models[0] === "m-cheap" && models.slice(1).every((m) => m === "m1"), show(models));
        must(changed.length === 1 && changed[0]!.attrs.from === "m-cheap" && changed[0]!.attrs.to === "agent", show(changed));
        must(/it ran on the agent's own model, not m-cheap: an administrator has set this agent's model/.test(report), `the report does not say: ${report}`);
      } else if (how === "unreadable") {
        must(models.length >= 4 && models.every((m) => m === "m-cheap"), `a failed read moved the subagent: ${show(models)}`);
        must(changed.length === 0 && !/it ran on/.test(report), show(changed));
      } else {
        must(models.length >= 4 && w.rules.reads === 1, `${w.rules.reads} reads for ${models.length} calls and a spawn`);
      }
    }
  });

  await check(`${engine}: a stop opens no finished child: twenty of them, none opened`, async () => {
    const w = await world(engine);
    for (let i = 0; i < 20; i++) {
      const id = `sub_${String(i).padStart(16, "0")}`;
      recordSubagent(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id, parentSession: "main", callId: `c${i}`, modelOption: null, provider: null, model: null, turnOp: null, turnKey: null, now: Date.now() });
      w.raw.sql.exec("UPDATE subagents SET state = 'idle', outcome = 'done' WHERE id = ?", id);
    }
    w.rt = w.isolate();
    await w.rt.ready();
    const opens = () => trace(w).filter((r) => r.kind === "harness.open" && String(r.spanId).includes("#sub_")).length;
    const before = opens();
    const t0 = Date.now();
    await w.rt.stopTurn("t", "a", "provider_stop");
    must(opens() === before, `the stop opened ${opens() - before} finished children in ${Date.now() - t0} ms`);
  });


  await check(`${engine}: three children finishing in the same pass report in one message, and the parent runs once`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    let release = false;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        return parentCalls === 1 ? calls(...[1, 2, 3].map((i) => ({ id: `c${i}`, args: { task: `part ${i}` } }))) : say(`noted ${parentCalls}`);
      }
      return release ? say(`report of part ${/part (\d)/.exec(taskOf(req))?.[1]}`) : null;
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w).length === 3 && rowsOf(w).every((r) => r.state === "running"), show(rowsOf(w)));
    const before = w.requests.filter((r) => r.session === "main").length;
    // All three answers land before the next pass, so it finds every turn ended together.
    release = true;
    for (const id of w.sent.filter((x) => !w.answered.has(x))) {
      const job = await w.rt.takeJob("t", "a", id).catch(() => null) as Job | null;
      if (!job) continue;
      w.answered.add(id); w.held.delete(id);
      const req = toRequest(job.context);
      w.requests.push({ session: sessionOfJob(w, id), req, operatorModel: job.operatorModel ?? null });
      await w.rt.deliverAnswer("t", "a", id, fromResponse(w.reply(sessionOfJob(w, id), req) as ModelResponse, job.model, id), undefined);
    }
    await settle(w);
    const msgs = await reportMessages(w);
    must(msgs.length === 1 && (await reports(w)).length === 3, `${msgs.length} messages for ${(await reports(w)).length} reports`);
    for (const n of [1, 2, 3]) must(msgs[0]!.includes(`report of part ${n}`) && /\(report sub_[0-9a-f]+\/1\)/.test(msgs[0]!), `part ${n} missing`);
    const after = w.requests.filter((r) => r.session === "main").length - before;
    must(after === 1, `the parent ran ${after} times for three reports`);
  });

  await check(`${engine}: an Agents API agent's delete stops its turn and its subagents in its object; its settings answer 404`, async () => {
    const w = await world(engine);
    await w.rt.store.updateAgentConfig("t", "a", { openai: { tools: [] } } as never);
    let parentCalls = 0;
    w.reply = (session) => session === "sess_api" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "long" } }) : say("ok")) : null;
    await w.rt.postMessage("t", "a", "go", "prompt", "sess_api");
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w)[0]?.state === "running", show(rowsOf(w)));
    // `agents.remove`, as cf/src/index.ts wires it: the object's stopTurn with `delete`.
    await w.rt.stopTurn("t", "a", "delete");
    must(rowsOf(w)[0]!.outcome === "stopped", show(rowsOf(w)));
    w.reply = () => say("late");
    const sent = w.sent.length;
    for (let i = 0; i < 6; i++) { await pass(w); await sleep(10); }
    must(w.sent.length === sent, `${w.sent.length - sent} model calls after the delete`);
    must(await w.rt.agentSettingsOf("t", "a") === null, "the deleted agent's settings still answer");
  });

  await check(`${engine}: a turn whose engine id was never recorded (a queued post) is read from the session: reported done, not held to the ceiling`, async () => {
    const w = await world(engine);
    let parentCalls = 0, release = false;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : release ? say("answered all the same") : null;
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    // What a post that was queued rather than started leaves: a running row with no engine id for its turn.
    w.raw.sql.exec("UPDATE subagents SET turn_op = NULL");
    release = true;
    await settle(w);
    const row = rowsOf(w)[0]!;
    must(row.state === "idle" && row.outcome === "done", `the turn was not read from the session: ${show(row)}`);
    const rs = await reports(w);
    must(rs.length === 1 && rs[0]!.includes("answered all the same") && / done after /.test(rs[0]!), show(rs));
  });

  await check(`${engine}: a background completion that cannot be posted frees the child's slot at once: no turn, no report, no false cancel`, async () => {
    const w = await world(engine, { builder: true });
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("first answer");
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    recordBackgroundJob(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id: "op_bgw", session: child, mount: "builder", tool: "builder__build", handle: {} }, Date.now());
    w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0 WHERE id = 'op_bgw'");
    w.fault.at = (p) => { if (p === "wake-posting") throw new Error("the child's lane said no"); };
    await w.rt.step("t", "a");
    const row = rowsOf(w)[0]!;
    must(row.state === "idle" && row.outcome === "failed" && row.turns === 2, `the slot is still held: ${show(row)}`);
    must(trace(w).some((r) => r.kind === "subagent.turn" && r.status === "failed" && r.attrs.why === "its background completion could not be delivered"), "no trace row");
    w.fault.at = null;
    await settle(w);
    must((await reports(w)).length === 1, `a report for a turn that never ran: ${show(await reports(w))}`);
  });

  await check(`${engine}: retention archives a finished child after its time: its transcript goes, its row stays, a follow-up is refused`, async () => {
    const w = await world(engine, { retentionMs: 60_000 });
    let parentCalls = 0, child: string | null = null;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "t" } });
        const last = req.messages.at(-1) as any;
        if (child && last?.role === "user" && JSON.stringify(last.content).includes("and now")) return calls({ id: "c2", args: { task: "more", agent: child } });
        return say("ok");
      }
      return say("done");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    child = rowsOf(w)[0]!.id as string;
    const tablesOf = () => w.raw.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_s_%'").toArray().map((r: any) => String(r.name)).filter((n) => n.includes(child!.slice(4).toLowerCase()));
    const listed = () => engine === "pd" ? w.raw.sql.exec("SELECT 1 FROM ap_conversations WHERE task_id = ?", child).toArray().length : tablesOf().length;
    must(listed() > 0, "control: the child has nothing to delete");
    // Not yet: finished just now.
    await w.rt.step("t", "a");
    must(rowsOf(w)[0]!.state === "idle", "archived before its time");
    w.raw.sql.exec("UPDATE subagents SET finished_at = ? WHERE id = ?", Date.now() - 120_000, child);
    await w.rt.step("t", "a");
    must(rowsOf(w)[0]!.state === "archived" && listed() === 0, `not archived: ${show(rowsOf(w)[0])}, ${listed()} left`);
    if (engine === "pi085") must(w.raw.sql.exec("SELECT 1 FROM pi_sessions WHERE session = ?", child).toArray().length === 0, "its session row stayed");
    await w.rt.postMessage("t", "a", "and now", "prompt", "main");
    await settle(w);
    const results = w.requests.filter((r) => r.session === "main").flatMap((r) => r.req.messages.filter((m: any) => m.role === "tool")).map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    must(results.some((t) => /finished long ago and its transcript is gone/.test(t)), `the follow-up to an archived child: ${show(results.slice(-1))}`);
  });

  await check(`${engine}: retention keeps a child that owes a report or has a job running, and archives at most five a pass`, async () => {
    const w = await world(engine, { retentionMs: 60_000 });
    const old = Date.now() - 3_600_000;
    for (let i = 0; i < 9; i++) {
      const id = `sub_${String(i).padStart(16, "0")}`;
      recordSubagent(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id, parentSession: "main", callId: `c${i}`, modelOption: null, provider: null, model: null, turnOp: "1", turnKey: null, now: old });
      w.raw.sql.exec("UPDATE subagents SET state = 'idle', outcome = 'done', finished_at = ? WHERE id = ?", old, id);
    }
    // One owes a report, one has its own background job still running.
    w.raw.sql.exec("UPDATE subagents SET state = 'reporting', report = 'r' WHERE id = 'sub_0000000000000000'");
    recordBackgroundJob(w.raw.sql as never, { tenantId: "t", agentId: "a" }, { id: "op_keep", session: "sub_0000000000000001", mount: "x", tool: "x__y", handle: {} }, Date.now());
    w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = ? WHERE id = 'op_keep'", Date.now() + 3_600_000);
    w.raw.sql.exec("UPDATE subagents SET report_retry_at = ? WHERE state = 'reporting'", Date.now() + 3_600_000);
    const archived = () => rowsOf(w).filter((r) => r.state === "archived").map((r) => r.id);
    await w.rt.step("t", "a");
    must(archived().length === 5, `one pass archived ${archived().length}`);
    await w.rt.step("t", "a");
    must(archived().length === 7 && !archived().includes("sub_0000000000000000") && !archived().includes("sub_0000000000000001"), show(archived()));
  });

  await check(`${engine}: a finished child's harness is not kept in the isolate`, async () => {
    const w = await world(engine);
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : say("done");
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    const opens = () => trace(w).filter((r) => r.kind === "harness.open" && String(r.spanId).includes(`#${child}@`)).length;
    const before = opens();
    await w.rt.agent("t", "a", child);
    must(opens() === before + 1, `the finished child's harness was still cached (${opens() - before} new opens)`);
  });

  await check(`${engine}: follow-ups cannot carry a child past its lifetime or its turns`, async () => {
    const w = await world(engine);
    let parentCalls = 0, child: string | null = null;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c1", args: { task: "t" } });
        const last = req.messages.at(-1) as any;
        if (child && last?.role === "user" && JSON.stringify(last.content).includes("again")) return calls({ id: `f${parentCalls}`, args: { task: "more", agent: child } });
        return say("ok");
      }
      return say("done");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    child = rowsOf(w)[0]!.id as string;
    const results = () => w.requests.filter((r) => r.session === "main").flatMap((r) => r.req.messages.filter((m: any) => m.role === "tool")).map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    w.raw.sql.exec("UPDATE subagents SET created_at = ? WHERE id = ?", Date.now() - SUBAGENT_LIFETIME_MS - 1, child);
    await w.rt.postMessage("t", "a", "again", "prompt", "main");
    await settle(w);
    must(results().some((t) => /takes no more tasks: it is older than 2 hours/.test(t)), `past its lifetime: ${show(results().slice(-1))}`);
    w.raw.sql.exec("UPDATE subagents SET created_at = ?, turns = ? WHERE id = ?", Date.now(), SUBAGENT_MAX_TURNS, child);
    await w.rt.postMessage("t", "a", "again", "prompt", "main");
    await settle(w);
    must(results().some((t) => /takes no more tasks: it has had 10 turns/.test(t)), `past its turns: ${show(results().slice(-1))}`);
    must(rowsOf(w)[0]!.turns === SUBAGENT_MAX_TURNS, show(rowsOf(w)[0]));
  });

  await check(`${engine}: on by default for a hosted agent and its Agents API sessions; a stored false turns it off; the deployment's kill switch beats a stored true`, async () => {
    const offered = async (w: World, session = "main") => (await (await w.rt.agent("t", "a", session)).tools()).some((t) => t.name === SUBAGENT_TOOL);
    const on = await world(engine, { defaultOn: true });
    must(await offered(on) && await offered(on, "sess_api") && !await offered(on, "sub_0000000000000000"), "not on by default (or a child got it)");
    must((await on.rt.agentSettingsOf("t", "a"))!.settings.subagents === true, "the admin read does not say on");
    const killed = await world(engine, { defaultOn: true, on: false });
    must(!await offered(killed), "a stored false did not turn it off");
    const everywhere = await world(engine, { disabled: true });
    must(agentSettings(everywhere.raw.sql as never).subagents === true, "control: this agent's own setting is on");
    must(!await offered(everywhere) && (await everywhere.rt.agentSettingsOf("t", "a"))!.disabledEverywhere === true, "the kill switch did not win");
    must(subagentsDisabledBy({ SUBAGENTS_DISABLED: "1" }) && !subagentsDisabledBy({}) && !subagentsDisabledBy({ SUBAGENTS_DISABLED: "0" }) && !subagentsDisabledBy({ SUBAGENTS_DISABLED: "true" }), "the env switch");
  });

  await check(`${engine}: the trace carries what a trial compares: main context per call, tokens per session, delegations, child turns and report sizes`, async () => {
    const w = await world(engine);
    let parentCalls = 0, child: string | null = null;
    w.reply = (session, req) => {
      if (session === "main") {
        parentCalls++;
        if (parentCalls === 1) return calls({ id: "c_trial", args: { task: "read it" } });
        const last = req.messages.at(-1) as any;
        if (child && last?.role === "user" && JSON.stringify(last.content).includes("again")) return calls({ id: "c_trial2", args: { task: "more", agent: child } });
        return say("ok");
      }
      return say("a short report");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    child = rowsOf(w)[0]!.id as string;
    await w.rt.postMessage("t", "a", "again", "prompt", "main");
    await settle(w);
    const rows = trace(w);
    const calls_ = rows.filter((r) => r.kind === "model.call");
    must(calls_.every((r) => typeof r.attrs.session === "string" && typeof r.attrs.input === "number" && typeof r.attrs.output === "number"), `a model.call row without session or tokens: ${show(calls_.map((r) => r.attrs))}`);
    const starts = rows.filter((r) => r.kind === "subagent.start");
    must(starts.length === 2 && starts[0]!.status === "spawn" && starts[0]!.parentId === "c_trial" && starts[1]!.status === "follow_up" && starts[1]!.parentId === "c_trial2"
      && starts.every((r) => r.spanId === child && r.attrs.parentSession === "main"), show(starts));
    const ends = rows.filter((r) => r.kind === "subagent.turn" && r.status === "done");
    const reportsNow = await reports(w);
    must(ends.length === 2 && ends.every((r, i) => r.attrs.reportChars === reportsNow[i]!.length), `reportChars: ${show(ends.map((r) => r.attrs.reportChars))} vs ${show(reportsNow.map((t) => t.length))}`);
    // Ids and counts only: neither the task nor the answer is in any of these rows.
    must(!JSON.stringify([...starts, ...ends]).includes("read it") && !JSON.stringify(ends).includes("a short report"), "a row carries text");
  });

  await check(`${engine}: Raft subagent events: off, a child makes none at all; on, exactly SubagentStart, its steps, SubagentStop, and no text`, async () => {
    const w = await world(engine, { chatter: true });
    let parentCalls = 0, childCalls = 0;
    w.reply = (session) => {
      if (session === "main") return ++parentCalls === 1 ? calls({ id: "c_ev", args: { task: "SECRET TASK TEXT" } }) : say("ok");
      return ++childCalls === 1 ? ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "k1", name: "chat__peek", arguments: {} }] } as ModelResponse) : say("SECRET REPORT TEXT");
    };
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    await settle(w);
    const child = rowsOf(w)[0]!.id as string;
    const rows = trace(w);
    must(rows.some((r) => r.kind === "tool.call" && r.attrs.task === child), "control: the child made no tool call");
    // Off (the default): the events are what they were, none from or about the child.
    must(subagentActivityFor(w.raw.sql as never, {}) === undefined && subagentActivityFor(w.raw.sql as never, { SUBAGENT_ACTIVITY: "0" }) === undefined, "the flag is not off by default");
    const off = activityEvents("a", rows);
    const parentOnly = activityEvents("a", rows.filter((r) => !(r.kind === "subagent.start" || r.kind === "subagent.turn" || r.attrs.session === child || r.attrs.task === child)));
    must(show(off) === show(parentOnly) && !off.some((e) => e.subagent || e.hookEventName === "SubagentStart" || e.hookEventName === "SubagentStop"), `off, a child made events: ${show(off.filter((e) => !parentOnly.some((p) => p.eventId === e.eventId)))}`);
    // On: the marker, the shape, the parent's own step for send_to_agent with no marker.
    const on = activityEvents("a", rows, subagentActivityFor(w.raw.sql as never, { SUBAGENT_ACTIVITY: "1" }));
    const marked = on.filter((e) => e.subagent);
    const lin = { parentToolUseId: "c_ev", taskId: child };
    const start = marked.filter((e) => e.hookEventName === "SubagentStart");
    must(start.length === 1 && show(start[0]!.subagent) === show({ ...lin, phase: "started" }), `SubagentStart: ${show(start)}`);
    const steps = marked.filter((e) => e.hookEventName === "PreToolUse" || e.hookEventName === "PostToolUse");
    // Named as the agent's own steps are named (`hookEvents`: `<mount>__<tool>` from the row).
    must(steps.length === 2 && steps.every((e) => /^chat__.*peek$/.test(String(e.toolName)) && show(e.subagent) === show({ ...lin, phase: "active" })), `child steps: ${show(steps)}`);
    const stop = marked.filter((e) => e.hookEventName === "SubagentStop");
    must(stop.length === 1 && show(stop[0]!.subagent) === show({ ...lin, phase: "ended" }) && stop[0]!.outcome === "done" && typeof stop[0]!.reportChars === "number" && stop[0]!.reportChars! > 0, `SubagentStop: ${show(stop)}`);
    must(!marked.some((e) => e.hookEventName === "Stop" || e.hookEventName === "UserPromptSubmit"), "a child's Stop or prompt");
    const parentSend = on.filter((e) => !e.subagent && e.toolName === SUBAGENT_TOOL);
    must(parentSend.length === 2 && parentSend.map((e) => e.hookEventName).join() === "PreToolUse,PostToolUse", `the parent's own send_to_agent step: ${show(parentSend)}`);
    must(!JSON.stringify(on).includes("SECRET"), "an event carries task or report text");
    must(marked.every((e) => e.status === undefined), "a child's event carries the agent's status");
    must(show(on.filter((e) => !e.subagent && e.toolName !== SUBAGENT_TOOL)) === show(off), "turning it on changed the agent's own events");
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
    // Each stopped turn has its end in the trace.
    const stoppedRows = trace(w).filter((r) => r.kind === "subagent.turn" && r.status === "stopped");
    must(stoppedRows.length === 3 && rowsOf(w).every((c) => stoppedRows.some((t) => t.spanId === c.id && t.verdict === "cancelled")), show(stoppedRows));
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
    // A deleted agent's settings are not there to read or change, though its rows stay as a record.
    must(await w.rt.agentSettingsOf("t", "a") === null, "the deleted agent's settings still answer");
    const patch = await w.rt.updateAgentSettings("t", "a", { subagents: false }, "test");
    must(!patch.ok && (patch as any).status === 404, show(patch));
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

await check("the default reaches no measurement: the bench tenant and an evaluation's tool choice get it only by their own setting, and harness minimal never", async () => {
  const runtime = (raw: ReturnType<typeof sqliteHost>) => new AgentRuntime({
    ctx: { storage: { sql: raw.sql, transactionSync: raw.transactionSync } }, bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false, subagentsDefault: true,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async () => {},
  } as never);
  const offered = async (tenant: string, config: Record<string, unknown>, stored?: boolean) => {
    const raw = sqliteHost();
    const rt = runtime(raw);
    await rt.ready();
    await rt.store.createAgent(tenant, "a", config as never);
    await rt.bindOperatorModel(tenant, "a");
    if (stored !== undefined) updateAgentSettings(raw.sql as never, { subagents: stored }, "test");
    return (await (await rt.agent(tenant, "a")).tools()).some((t) => t.name === SUBAGENT_TOOL);
  };
  must(await offered("t", { name: "Ada" }), "control: a hosted agent has it by default");
  must(!await offered("bench", { name: "Ada" }) && await offered("bench", { name: "Ada" }, true), "the bench tenant");
  const chosen = { name: "Ada", toolConfig: { mounts: null, harness: "default" } };
  must(!await offered("t", chosen) && await offered("t", chosen, true), "an evaluation's tool choice");
  const minimal = { name: "Ada", toolConfig: { mounts: null, harness: "minimal" } };
  must(!await offered("t", minimal) && !await offered("t", minimal, true), "harness minimal");
});

await check("rules: Raft subagent events: a turn ended at its ceiling is outcome ceiling; the agent's status never rides a child's event", () => {
  const T = Date.parse("2026-10-20T10:00:00Z");
  const row = (seq: number, at: number, kind: string, status: string, attrs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ seq, at, tenantId: "t", agentId: "a", kind, spanId: `s${seq}`, status, verdict: "ok", attrs, ...extra }) as never;
  const lineage = { lineage: (x: string) => (x === "sub_x" ? "c_x" : null) };
  const rows = [
    // The agent's own model call ends at T (status online), and a child's tool call ends at the same instant.
    row(1, T, "model.call", "stop", { model: "m1", session: "main" }),
    row(2, T, "tool.call", "succeeded", { tool: "peek", mount: "chat", task: "sub_x" }, { ms: 0 }),
    row(3, T + 10, "subagent.turn", "cancelled", { parentSession: "main", turn: 1, reportChars: 120 }, { spanId: "sub_x", parentId: "c_x" }),
    row(4, T + 20, "subagent.turn", "report_failed", { parentSession: "main", attempts: 1 }, { spanId: "sub_x", parentId: "c_x" }),
  ];
  const on = activityEvents("a", rows, lineage);
  const stop = on.filter((e) => e.hookEventName === "SubagentStop");
  must(stop.length === 1 && stop[0]!.outcome === "ceiling" && stop[0]!.reportChars === 120, `the ceiling: ${show(stop)}`);
  must(on.filter((e) => e.subagent).every((e) => e.status === undefined), `the agent's status rode a child's event: ${show(on.filter((e) => e.subagent && e.status))}`);
  must(on.some((e) => !e.subagent && e.status === "online"), `the agent's own status is gone: ${show(on)}`);
});

await check("rules: the tool tells the model to delegate big reads for a short report, and to do changes itself", () => {
  const t = subagentTool({ models: [], send: async () => ({}) });
  for (const words of ["any read that would bring a lot of raw content into your context", "short, structured report", "Do changes, messages and decisions yourself",
    "subagents are read-only", "Don't delegate a single small lookup"]) must(t.description.includes(words), `the description lacks: ${words}`);
  must(!/[Dd]elegate rarely|Delegate only \(a\)/.test(t.description), "the old rarely-delegate wording is still there");
  must(t.description.includes(DELEGATE_GUIDANCE), "not the shared guidance");
});

await check("rules: a subagent may call only declared reads and a self-acting plugin's writes; every built-in write is withheld", async () => {
  const rt = new AgentRuntime({ ctx: { storage: { sql: sqliteHost().sql } }, bucket: {} as never, bucketName: "b", models: { resolve: () => null }, loader: {} as never, makeToolBinding: () => null } as never);
  for (const p of rt.plugins()) {
    must((p as any).actsAs === undefined, `${p.id} declares actsAs, and every built-in plugin's writes may act as the agent`);
    const tools = (p.tools ?? []).map((t: any) => ({ address: `${p.id}.${t.name}`, sideEffects: t.sideEffects }));
    const withheld = childWithheld(tools, () => p.actsAs);
    for (const t of tools) must(withheld.has(t.address) === (t.sideEffects !== "read"), `${t.address} (${t.sideEffects}) ${withheld.has(t.address) ? "withheld" : "offered"}`);
  }
  // The ones that act as the agent by name, as the review listed them: GitHub writes, an HTTP send, the sandbox shell, raft.
  const by = (id: string) => rt.plugins().find((p) => p.id === id)!;
  for (const [plugin, tool] of [["github", "api"], ["github", "issue_comment"], ["http", "send"], ["sandbox", "shell"], ["sandbox", "run"], ["raft", "messages_send"], ["state", "secret_put"]] as const) {
    const t = (by(plugin).tools as any[]).find((x) => x.name === tool);
    must(t && !childMayCall(t, by(plugin).actsAs), `${plugin}.${tool} is callable by a subagent`);
  }
  // MCP lists its tools from the server; one not marked read-only is a write (src/plugins/mcp.ts), and withheld.
  must(!childMayCall({ sideEffects: "write" }, by("mcp").actsAs) && childMayCall({ sideEffects: "read" }, by("mcp").actsAs), "MCP");
  // A tool that declares no side effect, and a plugin that declares nothing: withheld; `self` lets a write through.
  must(!childMayCall({}, undefined) && !childMayCall(undefined, undefined) && childMayCall({ sideEffects: "write" }, "self"), "the defaults");
  must(SUBAGENTS_READ_ONLY.includes("cannot change anything"), "the words");
});

await check("pi085: a report goes through the agent's post: dropped like a background completion while main needs a reset, and carries a pending briefing", async () => {
  for (const how of ["needs-reset", "briefing"] as const) {
    const w = await world("pi085");
    let parentCalls = 0;
    w.reply = (session) => session === "main" ? (++parentCalls === 1 ? calls({ id: "c1", args: { task: "t" } }) : say("ok")) : null;
    await w.rt.postMessage("t", "a", "go", "prompt", "main");
    for (let i = 0; i < 6; i++) await pass(w);
    must(rowsOf(w)[0]?.state === "running", show(rowsOf(w)));
    returnPendingBriefing(w.raw.sql as never, "BRIEFING: what the conversation was about");
    if (how === "needs-reset") {
      takePendingBriefing(w.raw.sql as never);
      w.raw.sql.exec("UPDATE overflow_backstop SET needs_reset_at = ?, needs_reset_reason = 'test'", Date.now());
      must(readBackstop(w.raw.sql as never).needsReset !== null, "control: needs_reset");
    }
    w.reply = (session) => session === "main" ? say("ok") : say("child report");
    const before = w.requests.filter((r) => r.session === "main").length;
    await settle(w);
    const main = w.requests.filter((r) => r.session === "main").slice(before);
    if (how === "needs-reset") {
      must(main.length === 0 && (await reports(w)).length === 0, `a report reached a main that needs a reset: ${main.length} calls`);
      must(rowsOf(w)[0]!.state === "idle", `the report is still owed, to be refused on every pass: ${show(rowsOf(w))}`);
    } else {
      const text = JSON.stringify(main[0]?.req.messages ?? []);
      must(/BRIEFING: what the conversation was about/.test(text) && /\[subagent /.test(text), `the report did not carry the briefing: ${text.slice(-400)}`);
    }
  }
});

await check("rules: every raft operation that can hold a call for a question is a write, so a subagent never reaches one", async () => {
  // A subagent's raft calls run on a state of their own (`savesState`). A held question is resumed with the state the
  // hold wrote; a subagent would resume one with none. It cannot get one: only these operations ask, and each is a
  // write of a plugin that speaks as the agent, which a subagent is neither offered nor let call, resumed included.
  const { RAFT_OPERATIONS } = await import("@botiverse/raft-sdk") as any;
  const asking = (RAFT_OPERATIONS as any[]).filter((o) => o.mayInterrupt);
  must(asking.length > 0, "control: the manifest names no operation that asks");
  const tools = raftPlugin.tools.map((t: any) => ({ address: `raft.${t.name}`, sideEffects: t.sideEffects }));
  const withheld = childWithheld(tools, () => raftPlugin.actsAs);
  for (const op of asking) must(withheld.has(`raft.${op.toolName}`), `${op.toolName} asks questions and a subagent may call it`);
});

await check("rules: a subagent's model option under pins and the picker switch; raft saves no state for a subagent", () => {
  const um = { offered: [{ id: "cheap", label: "Cheap", provider: "deepseek", model: "m-cheap" }, { id: "dflt", label: "Default", provider: "deepseek", model: "m1" }] };
  const none = { agent: null, tenant: null, deployment: null, owner: null };
  must(subagentModelChoice(none, um, "m1", "cheap", false).ok, "a free agent was refused its option");
  for (const layers of [{ ...none, agent: { provider: null, model: "m1" } }, { ...none, tenant: { provider: "deepseek", model: "m2" } }]) {
    const r = subagentModelChoice(layers, um, "m1", "cheap", false);
    must(!r.ok && /administrator has set this agent's model/.test(r.error), `a pin was not honoured: ${show(r)}`);
  }
  const off = subagentModelChoice(none, um, "m1", "cheap", true);
  must(!off.ok && /not enabled for this Raft server/.test(off.error), `the picker switch was not honoured: ${show(off)}`);
  must(subagentModelChoice(none, um, "m1", "dflt", true).ok, "the default was refused under the switch");
  must(!subagentModelChoice(none, um, "m1", "nope", false).ok, "an unknown option was accepted");
  const read = { consumes: { model: [] } } as never, seen = { consumes: { model: ["seen"] } } as never;
  must(savesState(read, { caller: { taskId: "main" } } as never), "the agent's reads no longer save state");
  must(!savesState(read, { caller: { taskId: "sub_ab12" } } as never), "a subagent's read saves state");
  must(!savesState(seen, { caller: { taskId: "main" } } as never), "a history read saves state");
});

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
