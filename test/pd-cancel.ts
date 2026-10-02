/**
 * Cancel and the API caller's functions on the `pd` engine: the cases of test/spec/pd-cancel-spec.ts over
 * node:sqlite, and, node's only (the conformance worker does not carry the runtime), the Agents API contract through
 * `AgentRuntime` — `cancelSession`, `waitingClientCalls`, `submitToolResults` and `step` — on an object of each engine. `npm run pd-cancel:do` runs the spec's cases
 * on a real Durable Object.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { CANCELLED_NOTE, sessionTranscript } from "../cf/src/agents-api/transcript.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { DurableAgent } from "../src/runtime/durable-agent.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { pdCancelCases } from "./spec/pd-cancel-spec.ts";
import { afterPdCommits } from "./spec/pd-commits.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const USAGE = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const WEATHER = { name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } };
type Job = { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };

/**
 * One Agents API agent on an AgentRuntime over node:sqlite, its object recording `engine`. `pass()` is what
 * AgentDO's alarm does: one `step`, then the model's queue answers what it dispatched from `script`; it returns the
 * step's outcome. `holdNext()` resolves `reached` as the next pi-durable commit ends (`afterPdCommits`).
 */
async function apiAgent(engine: "pi085" | "pd") {
  const raw = sqliteHost();
  let reachedNext: (() => void) | null = null;
  const host = afterPdCommits(raw, () => { const r = reachedNext; reachedNext = null; r?.(); });
  const holdNext = () => ({ reached: new Promise<void>((r) => { reachedNext = r; }) });
  if (engine === "pd") {
    const ap = new ApStore(raw, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { openai: { tools: [WEATHER] } });
  await rt.bindOperatorModel("t", "a");
  const agent = await rt.agent("t", "a");
  check(agent instanceof (engine === "pd" ? DurableAgent : PiAgent), `${engine}: opened ${agent.constructor.name}`);
  const answered = new Set<string>();
  const requests: ReturnType<typeof toRequest>[] = [];
  const replies: Array<(r: ReturnType<typeof toRequest>) => ModelResponse> = [];
  /** Alarms and deliveries until nothing is due, the model answering from `replies` in order. */
  const settle = async () => {
    for (let guard = 0; guard < 60; guard++) {
      const t0 = Date.now();
      const out = await rt.step("t", "a");
      // Nothing here runs long: a pass near the runtime's step deadline (30 s) was held open by something the park
      // rule did not let go, and would otherwise repeat sixty times before this says so.
      check(Date.now() - t0 < 10_000, `${engine}: a pass held the object open for ${Date.now() - t0} ms and left ${show(out)}`);
      let delivered = false;
      for (const id of sent.filter((x) => !answered.has(x))) {
        answered.add(id);
        const job = await rt.takeJob("t", "a", id).catch(() => null) as Job | null;
        if (!job) continue;
        const req = toRequest(job.context);
        requests.push(req);
        const reply = replies.shift();
        check(reply, `${engine}: an unscripted model call: ${show(req.messages.slice(-2))}`);
        await rt.deliverAnswer("t", "a", id, fromResponse(reply(req), job.model, id));
        delivered = true;
      }
      if (delivered) continue;
      if (out.wakeInMs === null) return out;
      await sleep(Math.min(out.wakeInMs, 3_000));
    }
    throw new Error(`${engine}: did not settle`);
  };
  /** AgentDO's `apiSessionStatus` and `apiTranscript`, as the Agents API reads them. */
  const view = async () => {
    const running = await agent.running();
    const pending = running ? [] : await rt.waitingClientCalls("t", "a", "main");
    const { turns, items } = sessionTranscript({ entries: await rt.branchEntries("t", "a", "main"), running, pending }, { sessionId: "s", agentId: "a" });
    return {
      status: running ? "in_progress" : pending.length ? "requires_action" : "idle",
      turns: turns.map((t) => t.status), pending,
      items: items.map(({ id: _i, turn_id: _t, ...rest }) => show(rest)),
    };
  };
  return { rt, agent, sent, requests, replies, settle, view, holdNext, dispose: () => raw.dispose() };
}

const runtimeCases: DriveCase[] = [{
  group: "runtime", name: "through AgentRuntime: cancel a running turn, cancel on idle, a client call round trip — the same Agents API reading on both engines",
  run: async () => {
    const out: Record<string, { views: unknown[]; requests: unknown[]; cancelled: Array<string | null> }> = {};
    for (const engine of ["pi085", "pd"] as const) {
      const a = await apiAgent(engine);
      try {
        const views: unknown[] = [];
        const cancelled: Array<string | null> = [];
        // A running turn, cancelled while its model call is out.
        await a.rt.postMessage("t", "a", "write a long story");
        await a.rt.step("t", "a");
        check(a.sent.length === 1, `${engine}: no model call dispatched`);
        views.push(await a.view());
        const first = await a.rt.cancelSession("t", "a");
        cancelled.push(first.cancelledTurn === null ? null : "id");
        await a.settle();
        views.push(await a.view());
        // Cancel on idle: nothing reported, nothing written.
        const entries = (await a.rt.branchEntries("t", "a", "main")).length;
        const second = await a.rt.cancelSession("t", "a");
        cancelled.push(second.cancelledTurn);
        check((await a.rt.branchEntries("t", "a", "main")).length === entries, `${engine}: a cancel on idle wrote something`);
        // A function the caller runs: the turn requires action, the caller's result continues it.
        a.replies.push(() => ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }] }));
        await a.rt.postMessage("t", "a", "weather in Paris?");
        const paused = await a.settle();
        check(paused.wakeInMs === null, `${engine}: the pass waiting on the caller asked for a wake: ${show(paused)}`);
        const waiting = await a.view();
        views.push(waiting);
        const turnId = String((waiting.pending[0] as { turn_id?: string } | undefined)?.turn_id ?? "");
        check(show((await a.rt.submitToolResults("t", "a", "main", [{ turnId: "turn_0", callId: "call_1", output: "x", isError: false }])).unknown) === show(["call_1"]),
          `${engine}: a result naming the wrong turn was kept`);
        const kept = await a.rt.submitToolResults("t", "a", "main", [{ turnId, callId: "call_1", output: "{\"temp\":21}", isError: false }]);
        check(kept.unknown.length === 0, `${engine}: the caller's result was refused: ${show(kept)}`);
        a.replies.push(() => ({ text: "21 degrees", finishReason: "stop", truncated: false, usage: USAGE }));
        await a.settle();
        views.push(await a.view());
        out[engine] = { views, cancelled, requests: a.requests.map((r) => r.messages.filter((m) => m.role !== "system")) };
        await a.agent.close();
      } finally { a.dispose(); }
    }
    const [pi, pd] = [out.pi085!, out.pd!];
    check(show(pi.cancelled) === show(["id", null]) && show(pd.cancelled) === show(["id", null]), `cancelledTurn: pi085 ${show(pi.cancelled)}, pd ${show(pd.cancelled)}`);
    const statuses = (v: unknown[]) => v.map((x) => { const { status, turns } = x as { status: string; turns: string[] }; return { status, turns }; });
    check(show(statuses(pd.views)) === show([
      { status: "in_progress", turns: ["in_progress"] },
      { status: "idle", turns: ["cancelled"] },
      { status: "requires_action", turns: ["cancelled", "waiting"] },
      { status: "idle", turns: ["cancelled", "completed"] },
    ]), `pd: ${show(statuses(pd.views))}`);
    pi.views.forEach((v, i) => {
      const { pending: a, ...x } = v as { pending: Array<{ turn_id: string }> };
      const { pending: b, ...y } = pd.views[i] as { pending: Array<{ turn_id: string }> };
      // A turn id is a sequence number, which differs between the engines' transcripts.
      const strip = (p: Array<{ turn_id: string }>) => p.map(({ turn_id: _t, ...rest }) => rest);
      check(show(x) === show(y) && show(strip(a)) === show(strip(b)), `view ${i} differs\n pi085 ${show(v)}\n pd    ${show(pd.views[i])}`);
    });
    for (const [engine, r] of [["pi085", pi], ["pd", pd]] as const) {
      check(r.requests.length === 2 && show(r.requests[0]).includes(CANCELLED_NOTE.slice(1, 40)) && show(r.requests[1]).includes("{\\\"temp\\\":21}"),
        `${engine}: the model read ${show(r.requests)}`);
    }
  },
}];

/**
 * `submitToolResults` and `cancelSession` on a pd object, each with another session's message committing in the
 * middle: `answerClientCalls` is wrapped to return only once that commit has ended, and `dropClientCalls` to start
 * only then. The result is kept and the turn cancelled all the same.
 */
runtimeCases.push({
  group: "runtime", name: "pd: a caller's result and a cancel, with another session's commit landing between their writes",
  run: async () => {
    const a = await apiAgent("pd");
    try {
      let posting: Promise<unknown> = Promise.resolve();
      let opened = 0;
      /** Post to another session; resolves once its commit has ended. */
      const holdOne = async (what: string) => {
        const hold = a.holdNext();
        posting = a.rt.postMessage("t", "a", `meanwhile, after ${what}`, "prompt", "s9");
        await hold.reached;
        opened++;
      };
      const engine = a.agent as DurableAgent;
      const answer = engine.answerClientCalls.bind(engine);
      engine.answerClientCalls = async (results) => { await answer(results); await holdOne("the results"); };
      const drop = engine.dropClientCalls.bind(engine);
      engine.dropClientCalls = async () => { await holdOne("the cancel"); return drop(); };

      a.replies.push(() => ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "call_h", name: "get_weather", arguments: { city: "Oslo" } }] }));
      await a.rt.postMessage("t", "a", "weather in Oslo?");
      await a.settle();
      const turnId = String((await a.rt.waitingClientCalls("t", "a", "main"))[0]?.turn_id ?? "");
      check(turnId, "control: no call is waiting on the caller");
      const kept = await a.rt.submitToolResults("t", "a", "main", [{ turnId, callId: "call_h", output: "cold", isError: false }]);
      check(kept.unknown.length === 0, `the result was refused: ${show(kept)}`);
      await posting;
      a.replies.push(() => ({ text: "cold", finishReason: "stop", truncated: false, usage: USAGE }), () => ({ text: "ok", finishReason: "stop", truncated: false, usage: USAGE }));
      await a.settle();
      a.replies.push(() => ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "call_k", name: "get_weather", arguments: { city: "Lima" } }] }));
      await a.rt.postMessage("t", "a", "and in Lima?");
      await a.settle();
      const out = await a.rt.cancelSession("t", "a");
      await posting;
      check(typeof out.cancelledTurn === "string", `nothing was cancelled: ${show(out)}`);
      check(opened === 2, `control: ${opened} commits landed between the writes, not 2`);
      await a.agent.close();
    } finally { a.dispose(); }
  },
});

const only = process.argv[2];
const results = await runDriveCases([
  ...pdCancelCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }),
  ...runtimeCases,
].filter((c) => !only || c.name.includes(only))
  // PD_TRACE=1 names each case as it starts: a case that hangs is otherwise silent until the whole run is killed.
  .map((c) => ({ ...c, run: async () => { if (process.env.PD_TRACE) console.error(`start ${c.group}: ${c.name.slice(0, 60)}`); await c.run(); } })));

console.log(`\n  pd cancel and client calls — node:sqlite\n  ${"─".repeat(56)}`);
let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`  ${group}`); }
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name} \x1b[2m(${r.ms} ms)\x1b[0m`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
