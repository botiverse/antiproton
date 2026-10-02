/**
 * Cancel and the API caller's functions on the `pd` engine (src/runtime/durable-agent.ts): what each does, and the
 * Agents API's reading of it (status, turns, pending calls), which is the same contract on both engines and so is
 * checked on `pi085` too where nothing engine-specific is involved. Run over node:sqlite by test/pd-cancel.ts and on a
 * real Durable Object's storage by cf/src/conformance.ts (test/pd-cancel-do.sh).
 *
 * The world is test/spec/pd-tools-spec.ts's (the real gateway, test plugins, the same catalogue) plus one
 * function the caller runs, `get_weather`, wired on each engine the way cf/src/runtime.ts `agent()` wires it:
 * pi085's `clientTools` over the lane, pd's `clientTools` definitions; and the cancel marker with pi085's
 * entry projector and pd's `cancelNote`.
 *
 * A pass is driven as `AgentRuntime.step` drives it: `step()`, and when nothing is left open,
 * `resumeClientCalls()`, stepping again at once if it says a run is due.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import { clientTools } from "../../src/runtime/client-calls.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import { ClientCallsDoc, waitingCalls } from "../../src/runtime/durable-tools.ts";
import { parkVerdict, readSnapshot } from "../../src/runtime/durable-drive.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import { CANCELLED_NOTE, sessionTranscript, TURN_CANCELLED } from "../../cf/src/agents-api/transcript.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";
import {
  calls, MODEL, say, stepUntil, SYSTEM, toolMessages, toolOptions, world,
  type Engine, type Request, type Turn, type World,
} from "./pd-tools-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const WEATHER = [{ name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } }];
const NOTE_PROJECTOR = {
  [TURN_CANCELLED]: (entry: { timestamp: number }) => [{ role: "user" as const, content: [{ type: "text" as const, text: CANCELLED_NOTE }], timestamp: entry.timestamp }],
};
/** What pi-durable 1.0.0 ends a call cut off by its turn's abort with (dist/harness/tool.js, the task's `abort`). */
const ABORTED = "was aborted";

type Eng = Engine & { name: "pi085" | "pd" };

async function pi085(storage: DurableSqlHost, w: World): Promise<Eng> {
  const dispatched: string[] = [];
  const ref: { agent: PiAgent | null } = { agent: null };
  const caller = clientTools(WEATHER, {
    sql: storage.sql as never, session: "main", lane: () => ref.agent!.lane as never,
    branch: (tip) => ref.agent!.storage.scanBranch({ start: tip, order: "oldestFirst" }, BACKGROUND as never) as never,
  });
  const opts = toolOptions(w);
  const agent = await PiAgent.open({
    host: storage, sessionId: "t/a", session: "main", systemPrompt: SYSTEM, model: MODEL,
    dispatch: async (id) => { dispatched.push(id); }, ...opts,
    extraTools: [...(opts.extraTools as unknown[]), ...caller] as never,
    entryProjectors: NOTE_PROJECTOR as never,
  });
  ref.agent = agent;
  return { name: "pi085", agent, dispatched };
}

/** pd's step deadline in these cases unless one says otherwise. */
const STEP_DEADLINE_MS = 3_000;

function pd(storage: DurableSqlHost, w: World, opts: { stepDeadlineMs?: number } = {}): Eng {
  const dispatched: string[] = [];
  const host = new PdHost({ storage, pollAfterMs: 20, minParkMs: 1, stepDeadlineMs: opts.stepDeadlineMs ?? STEP_DEADLINE_MS });
  const agent = DurableAgent.open({
    host, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: SYSTEM,
    dispatch: async (id) => { dispatched.push(id); }, unknownJob: (id) => new UnknownJob(id),
    ...toolOptions(w), clientTools: WEATHER, cancelNote: CANCELLED_NOTE,
  });
  return { name: "pd", agent, dispatched, pd: host };
}

type Job = { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };

/**
 * Drive until nothing is open and nothing is due, as `AgentRuntime.step` does, answering each model call from
 * `script` in turn (`at` counts the turns used so far, across calls). Returns the last outcome.
 */
const taken = new WeakMap<Eng, Set<string>>();
async function drive(e: Eng, script: Turn[], at: { n: number }, requests: Request[], onPass?: () => Promise<void>) {
  const answered = taken.get(e) ?? new Set<string>();
  taken.set(e, answered);
  for (let guard = 0; guard < 300; guard++) {
    const t0 = Date.now();
    const out = await e.agent.step();
    await onPass?.();
    // No pass driven here has work that runs that long (a slow call is stepped by `stepUntil` instead): a pd step that
    // reaches its deadline was held open by something the park rule did not let go.
    check(e.name !== "pd" || Date.now() - t0 < STEP_DEADLINE_MS - 500,
      `pd: the step held the harness open until its deadline (${Date.now() - t0} ms) and left ${show(out)}`);
    const pending = e.dispatched.filter((id) => !answered.has(id));
    for (const id of pending) {
      answered.add(id);
      // A cancelled call's job is gone: the worker's take is refused (the runtime acks it as UnknownJob) or answered null.
      const job = await Promise.resolve(e.agent.takeJob(id)).catch(() => null) as Job | null;
      if (!job) continue;
      const req = toRequest(job.context) as Request;
      requests.push(req);
      const turn = script[at.n++];
      check(turn, `${e.name}: the model was called ${at.n} times; the script has ${script.length} turns. Last: ${show(req.messages.slice(-2))}`);
      await e.agent.deliver(id, fromResponse(turn(req), job.model, id));
      await onPass?.();
    }
    if (pending.length) continue;
    if (out.open === 0 && out.wakeInMs === null) {
      if (await e.agent.resumeClientCalls()) continue;
      return out;
    }
    check(out.wakeInMs !== null && out.wakeInMs <= 5_000, `${e.name}: stuck: ${show(out)}`);
    await sleep(out.wakeInMs);
  }
  throw new Error(`${e.name}: did not settle`);
}

/**
 * The model's jobs still out: what a poll could take a late answer from. pi085 deletes a cancelled job's row; pd
 * keeps it marked `cancelled`, so a late answer is billed rather than lost (test/spec/pd-outbox-spec.ts).
 */
function jobRows(storage: DurableSqlHost, e: Eng): number {
  const query = e.name === "pd" ? "SELECT COUNT(*) AS n FROM ap_model_jobs WHERE state IS NULL" : "SELECT COUNT(*) AS n FROM pi_model_jobs";
  return Number(storage.sql.exec(query).toArray()[0]!.n);
}

/** The Agents API's view of the session: its turns' statuses, and whether it is running. */
async function apiView(e: Eng) {
  const running = await e.agent.running();
  const pending = running ? [] : await e.agent.waitingClientCalls();
  const entries = await e.agent.branch();
  const { turns } = sessionTranscript({ entries, running, pending }, { sessionId: "s", agentId: "a" });
  const status = running ? "in_progress" : pending.length ? "requires_action" : "idle";
  return { status, turns: turns.map((t) => t.status), pending: pending.map((p) => p.call_id) };
}

/**
 * Every reading of the session's turns, by turn id, as a client polling the Agents API would see them: `sample()` takes
 * one. `check()` asserts that a turn that read terminal never reads otherwise afterwards, so each turn ends once.
 */
function turnHistory(e: Eng) {
  const seen = new Map<string, string[]>();
  const terminal = new Set(["completed", "failed", "cancelled"]);
  return {
    async sample() {
      const running = await e.agent.running();
      const pending = running ? [] : await e.agent.waitingClientCalls();
      const { turns } = sessionTranscript({ entries: await e.agent.branch(), running, pending }, { sessionId: "s", agentId: "a" });
      for (const t of turns) {
        const h = seen.get(t.id) ?? [];
        if (h.at(-1) !== t.status) h.push(t.status);
        seen.set(t.id, h);
      }
    },
    check(what: string) {
      for (const [id, h] of seen) {
        const end = h.findIndex((x) => terminal.has(x));
        check(end === -1 || end === h.length - 1, `${e.name}, ${what}: turn ${id} read ${show(h)}: terminal, then not`);
      }
      return [...seen.values()].map((h) => h.at(-1));
    },
  };
}

/** What `AgentRuntime.cancelSession` does with an engine. */
async function cancelSession(e: Eng): Promise<string | null> {
  const cancelled = await e.agent.cancel(TURN_CANCELLED);
  if ((await e.agent.dropClientCalls()) > 0 && !cancelled) await e.agent.markCancelled(TURN_CANCELLED);
  return cancelled;
}

const markers = async (e: Eng) => (await e.agent.entries({})).filter((x) => x.type === "custom" && x.customType === TURN_CANCELLED).length;

/** The text of every tool result in the transcript, by call id. */
async function results(e: Eng): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const x of await e.agent.entries({})) {
    const m = (x as { message?: { role?: string; toolCallId?: string; content?: Array<{ text?: string }> } }).message;
    if (m?.role === "toolResult") out.set(String(m.toolCallId), (m.content ?? []).map((c) => c.text ?? "").join(""));
  }
  return out;
}

const texts = (req: Request) => req.messages.filter((m) => m.role !== "system").map((m) => (typeof m.content === "string" ? m.content : show(m.content)));

/** Poll `probe` until it is true, up to two seconds. */
async function until(probe: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}

export function pdCancelCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, run: () => Promise<void>) => cases.push({ group, name, run });

  /** Run `body` once per engine, each on fresh storage: for what the Agents API reads, which is the same on both. */
  async function each(body: (e: Eng, w: World, storage: DurableSqlHost) => Promise<void>, pdOpts?: { stepDeadlineMs?: number }): Promise<void> {
    for (const which of ["pi085", "pd"] as const) {
      await withHost(async (storage) => {
        const w = await world(storage);
        const e = which === "pi085" ? await pi085(storage, w) : pd(storage, w, pdOpts);
        try { await body(e, w, storage); } finally { await e.agent.close(); }
      });
    }
  }

  /** Run `body` on the pd engine alone. */
  async function onPd(body: (e: Eng, w: World, storage: DurableSqlHost) => Promise<void>, pdOpts?: { stepDeadlineMs?: number }): Promise<void> {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w, pdOpts);
      try { await body(e, w, storage); } finally { await e.agent.close(); }
    });
  }

  // ---- cancel ---------------------------------------------------------------------------

  add("cancel", "mid model call: the job is cancelled, the marker written, the turn cancelled then idle; a second cancel changes nothing; the next request carries the note", async () => {
    await each(async (e, _w, storage) => {
      const requests: Request[] = [];
      await e.agent.say("write a long story");
      await e.agent.step();
      check(e.dispatched.length === 1 && jobRows(storage, e) === 1, `${e.name}: no model call in flight (${show(e.dispatched)})`);
      const before = await apiView(e);
      check(before.status === "in_progress", `${e.name}: before the cancel ${show(before)}`);
      const cancelled = await cancelSession(e);
      check(typeof cancelled === "string" && cancelled.length > 0, `${e.name}: a running turn was not cancelled (${show(cancelled)})`);
      check(jobRows(storage, e) === 0, `${e.name}: the model call is still out, so its answer could land`);
      check(!(await e.agent.running()), `${e.name}: still running after the cancel`);
      check(await markers(e) === 1, `${e.name}: ${await markers(e)} cancel markers`);
      const after = await apiView(e);
      check(show(after) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `${e.name}: after the cancel ${show(after)}`);
      const entries = (await e.agent.entries({})).length;
      // Cancel on idle: nothing reported, nothing written.
      check(await cancelSession(e) === null, `${e.name}: cancelling an idle session reported a cancellation`);
      check((await e.agent.entries({})).length === entries && await markers(e) === 1, `${e.name}: cancelling an idle session wrote something`);
      await e.agent.say("just say OK");
      await drive(e, [say("OK")], { n: 0 }, requests);
      const final = await apiView(e);
      check(show(final) === show({ status: "idle", turns: ["cancelled", "completed"], pending: [] }), `${e.name}: after the next turn ${show(final)}`);
      const t = texts(requests[0]!);
      const at = (needle: string) => t.findIndex((x) => x.includes(needle));
      check(at("write a long story") >= 0 && at("write a long story") < at(CANCELLED_NOTE.slice(1, 40)) && at(CANCELLED_NOTE.slice(1, 40)) < at("just say OK"),
        `${e.name}: the note is not between the cancelled request and the new one: ${show(t)}`);
    });
  });

  add("cancel", "mid tool call: the turn is cancelled then idle, the call ran once, and on pd its result is pi-durable's aborted result", async () => {
    await each(async (e, w) => {
      const requests: Request[] = [];
      await e.agent.say("go slow");
      await e.agent.step();
      const [job] = e.dispatched;
      const taken = await e.agent.takeJob(job!) as Job;
      await e.agent.deliver(job!, fromResponse(calls(["c1", "web__slow", {}])({ messages: [] }), taken.model, job!));
      const { step } = await stepUntil(e, w.slow.arrived);
      // pi085's abort waits for the gateway call in flight; the plugin is let go a moment after the cancel starts,
      // as a real one eventually returns.
      const cancelling = cancelSession(e);
      await sleep(50);
      w.slow.open();
      const cancelled = await cancelling;
      await step.catch(() => {});
      check(typeof cancelled === "string", `${e.name}: the turn in a tool call was not cancelled`);
      // What the abort left settles on the next pass.
      await drive(e, [], { n: 0 }, requests);
      const after = await apiView(e);
      check(show(after) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `${e.name}: after the cancel ${show(after)}`);
      check(show(w.invoked) === show(["web.slow"]), `${e.name}: the plugin ran ${show(w.invoked)}`);
      if (e.name === "pd") check((await results(e)).get("c1")?.includes(ABORTED), `pd: the cut-off call's result is ${show([...(await results(e))])}`);
      await e.agent.say("what happened?");
      await drive(e, [say("it was cancelled")], { n: 0 }, requests);
      check(requests.length === 1 && texts(requests[0]!).some((x) => x.includes(CANCELLED_NOTE.slice(1, 40))), `${e.name}: the next request ${show(requests.map(texts))}`);
    });
  });

  add("cancel", "on idle, after a finished turn: null, nothing written, the turn stays completed", async () => {
    await each(async (e) => {
      await e.agent.say("hello");
      await drive(e, [say("hi")], { n: 0 }, []);
      const before = (await e.agent.entries({})).length;
      const cancelled = await cancelSession(e);
      check(cancelled === null && (await e.agent.entries({})).length === before, `${e.name}: cancel on idle returned ${show(cancelled)}`);
      check(show(await apiView(e)) === show({ status: "idle", turns: ["completed"], pending: [] }), `${e.name}: ${show(await apiView(e))}`);
    });
  });

  // ---- client calls -------------------------------------------------------------------------

  add("client", "round trip: the call waits for the caller with nothing open and no alarm; the result continues the turn, and a second result for it is ignored", async () => {
    await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_1", "get_weather", { city: "Paris" }]), say("21 degrees")];
      await e.agent.say("weather in Paris?");
      const t0 = Date.now();
      const paused = await drive(e, script, at, requests);
      check(Date.now() - t0 < 2_500, `${e.name}: pausing for the caller took ${Date.now() - t0} ms`);
      check(paused.open === 0 && paused.wakeInMs === null, `${e.name}: the paused step said ${show(paused)}`);
      if (e.name === "pd") check(!e.pd!.open, "pd: the harness is still open while only the caller is awaited");
      const waiting = await apiView(e);
      check(show(waiting) === show({ status: "requires_action", turns: ["waiting"], pending: ["call_1"] }), `${e.name}: while waiting ${show(waiting)}`);
      const rows = await e.agent.waitingClientCalls();
      check(rows.length === 1 && rows[0]!.name === "get_weather" && JSON.parse(rows[0]!.arguments).city === "Paris", `${e.name}: waiting rows ${show(rows)}`);
      check(!(await e.agent.resumeClientCalls()), `${e.name}: resumed before the caller answered`);
      await e.agent.answerClientCalls([{ callId: "call_1", output: "{\"temp\":21}", isError: false }]);
      await e.agent.answerClientCalls([{ callId: "call_1", output: "again", isError: false }]);
      await drive(e, script, at, requests);
      const final = await apiView(e);
      check(show(final) === show({ status: "idle", turns: ["completed"], pending: [] }) && (await e.agent.waitingClientCalls()).length === 0, `${e.name}: after ${show(final)}`);
      check(requests.length === 2 && show(toolMessages(requests[1]!)) === show(["{\"temp\":21}"]), `${e.name}: the model read ${show(requests.map(toolMessages))}`);
    });
  });

  add("client", "the park rule: a tool waiting on the caller is parked with no alarm when its call is unanswered in ap.clientCalls, and held open when it is not named", async () => {
    await onPd(async (e) => {
      await e.agent.say("weather?");
      const t0 = Date.now();
      const out = await drive(e, [calls(["call_9", "get_weather", { city: "Oslo" }])], { n: 0 }, []);
      check(out.open === 0 && out.wakeInMs === null && !e.pd!.open, `the step left ${show(out)}, open ${e.pd!.open}`);
      check(Date.now() - t0 < 5_000, "the step waited out its deadline instead of parking on the caller");
      // The same state, live: resumed, the tool runs again, finds no answer and waits. The verdict on it with the
      // document read, and — the control — without.
      const verdicts = await e.pd!.withHarness(async (h) => {
        h.resume();
        for (let i = 0; i < 200; i++) {
          const t = (await h.inspect(BACKGROUND)).tasks.find((x) => x.record.kind === "pi.tool");
          if (t?.state.kind === "running" && show(t.record.state).includes("execute")) break;
          await sleep(10);
        }
        const fromDoc = async (ids: ReadonlySet<ConversationId>) => new Map(await Promise.all([...ids].map(async (id) =>
          [id, new Set(waitingCalls(await h.snapshot(ClientCallsDoc, id, BACKGROUND)).map((c) => c.callId))] as const)));
        const named = await readSnapshot(h, BACKGROUND, () => e.pd!.now, 5, fromDoc);
        const bare = await readSnapshot(h, BACKGROUND, () => e.pd!.now, 5);
        check(named && bare, "no snapshot");
        return { named: parkVerdict(named), bare: parkVerdict(bare) };
      });
      check(verdicts.named.verdict === "external" && show(verdicts.named).includes("call_9"), `with the document read: ${show(verdicts.named)}`);
      check(verdicts.bare.verdict === "wait", `control: without it the verdict is ${show(verdicts.bare)}`);
    }, { stepDeadlineMs: 10_000 });
  });

  add("client", "a result arriving while the harness is open reaches the waiting tool with no step; one arriving while parked reopens it and the replayed tool takes it", async () => {
    await onPd(async (e, w) => {
      // A batch with a slow call beside the caller's: the slow call keeps the harness open, so the client tool waits in it.
      await e.agent.say("weather and a slow thing");
      await e.agent.step();
      const [job] = e.dispatched;
      const taken = await e.agent.takeJob(job!) as Job;
      await e.agent.deliver(job!, fromResponse(calls(["c_slow", "web__slow", {}], ["call_open", "get_weather", { city: "Rome" }])({ messages: [] }), taken.model, job!));
      const { step } = await stepUntil(e, w.slow.arrived);
      await until(async () => (await e.agent.waitingClientCalls()).length === 1, "the caller's function to wait");
      check(e.pd!.open, "control: the harness closed while a slow call ran");
      await e.agent.answerClientCalls([{ callId: "call_open", output: "warm", isError: false }]);
      await until(async () => (await results(e)).get("call_open") === "warm", "the waiting tool to return the answer");
      check(!(await results(e)).has("c_slow"), "control: the slow call finished first");
      w.slow.open();
      await step;
      const requests: Request[] = [];
      await drive(e, [say("done")], { n: 0 }, requests);
      check(show(toolMessages(requests[0]!)) === show([show({ slow: "done" }), "warm"]), `the model read ${show(toolMessages(requests[0]!))}`);

      // Parked: nothing waits in this isolate, so the answer resumes the harness and the replayed tool reads it.
      await e.agent.say("and in Oslo?");
      const at = { n: 0 };
      const script = [calls(["call_parked", "get_weather", { city: "Oslo" }]), say("cold")];
      await drive(e, script, at, requests);
      check(!e.pd!.open, "control: not parked");
      // Recording it forgot the answered call whose tool is done: the document holds only what can still be read.
      const conversation = await e.pd!.conversation("main");
      const recorded = await e.pd!.withHarness((h) => h.snapshot(ClientCallsDoc, conversation, BACKGROUND));
      check(show(Object.keys(recorded?.calls ?? {})) === show(["call_parked"]), `ap.clientCalls holds ${show(recorded)}`);
      await e.agent.answerClientCalls([{ callId: "call_parked", output: "cold", isError: false }]);
      check(e.pd!.open, "the answer to a parked call did not reopen the harness");
      await until(async () => (await results(e)).get("call_parked") === "cold", "the replayed tool to take the answer");
      await drive(e, script, at, requests);
      check(show(toolMessages(requests.at(-1)!).at(-1)) === show("cold"), `the model read ${show(toolMessages(requests.at(-1)!))}`);
    }, { stepDeadlineMs: 10_000 });
  });

  add("client", "eviction while the caller's function waits: a fresh host on the same storage takes the answer and finishes the turn", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const first = pd(storage, w);
      const script = [calls(["call_e", "get_weather", { city: "Kyiv" }]), say("mild")];
      await first.agent.say("weather in Kyiv?");
      await drive(first, script, { n: 0 }, []);
      check((await first.agent.waitingClientCalls()).length === 1, "control: nothing waits on the caller");
      // The isolate goes away: a new host and agent, as a cold object builds them.
      await first.agent.close();
      const second = pd(storage, w);
      try {
        const view = await apiView(second);
        check(show(view) === show({ status: "requires_action", turns: ["waiting"], pending: ["call_e"] }), `after the eviction ${show(view)}`);
        await second.agent.answerClientCalls([{ callId: "call_e", output: "mild", isError: false }]);
        const requests: Request[] = [];
        await drive(second, script, { n: 1 }, requests);
        check(requests.length === 1 && show(toolMessages(requests[0]!)) === show(["mild"]), `the model read ${show(requests.map(toolMessages))}`);
        check(show(await apiView(second)) === show({ status: "idle", turns: ["completed"], pending: [] }), `after ${show(await apiView(second))}`);
      } finally { await second.agent.close(); }
    });
  });

  add("client", "cancelling while the caller's function waits in an open harness ends the wait: aborted, forgotten, and a late answer runs nothing", async () => {
    await onPd(async (e, w) => {
      await e.agent.say("weather and a slow thing");
      await e.agent.step();
      const [job] = e.dispatched;
      const taken = await e.agent.takeJob(job!) as Job;
      await e.agent.deliver(job!, fromResponse(calls(["c_slow", "web__slow", {}], ["call_w", "get_weather", { city: "Rome" }])({ messages: [] }), taken.model, job!));
      const { step } = await stepUntil(e, w.slow.arrived);
      await until(async () => (await e.agent.waitingClientCalls()).length === 1, "the caller's function to wait");
      check(e.pd!.open, "control: the caller's function is not waiting in an open harness");
      // The slow call is let go a moment after the cancel starts (see "mid tool call").
      const cancelling = cancelSession(e);
      await sleep(50);
      w.slow.open();
      const cancelled = await cancelling;
      await step.catch(() => {});
      check(typeof cancelled === "string", `the turn was not cancelled: ${show(cancelled)}`);
      const requests: Request[] = [];
      await drive(e, [], { n: 0 }, requests);
      check((await e.agent.waitingClientCalls()).length === 0 && await markers(e) === 1, "the call was not forgotten, or the marker not written once");
      await e.agent.answerClientCalls([{ callId: "call_w", output: "late", isError: false }]);
      await drive(e, [], { n: 0 }, requests);
      check(requests.length === 0, `a late answer continued the cancelled turn: ${requests.length} model calls`);
      const r = await results(e);
      check(r.get("call_w")?.includes(ABORTED) && r.get("c_slow")?.includes(ABORTED), `results ${show([...r])}`);
      check(show(await apiView(e)) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `after ${show(await apiView(e))}`);
    }, { stepDeadlineMs: 10_000 });
  });

  add("client", "input while the turn waits on the caller is queued: the session still requires action and parks with no alarm; the answer continues the turn, then the input is answered", async () => {
    await onPd(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_q", "get_weather", { city: "Rome" }]), say("hot, and hello")];
      await e.agent.say("weather in Rome?");
      await drive(e, script, at, requests);
      await e.agent.say("also, say hello");
      const parked = await drive(e, script, at, requests);
      check(parked.open === 0 && parked.wakeInMs === null && !e.pd!.open, `queued input kept the object awake: ${show(parked)}`);
      const before = requests.length;
      check(before === 1, `the input started a model call before the answer: ${before}`);
      const queued = await apiView(e);
      check(show(queued) === show({ status: "requires_action", turns: ["waiting"], pending: ["call_q"] }), `with the input queued ${show(queued)}`);
      await e.agent.answerClientCalls([{ callId: "call_q", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      // One model call reads both: the caller's result, then the input placed at the run's next boundary.
      const t = texts(requests[1]!);
      check(requests.length === 2 && show(toolMessages(requests[1]!)) === show(["hot"]) && t.at(-1)!.includes("also, say hello"),
        `the model read ${show(t)}`);
      const done = await apiView(e);
      check(show(done) === show({ status: "idle", turns: ["completed", "completed"], pending: [] }), `after the answer ${show(done)}`);
    });
  });

  add("client", "cancelling a turn that waits on the caller with input queued behind it withdraws the input too", async () => {
    await onPd(async (e) => {
      const requests: Request[] = [];
      await e.agent.say("weather?");
      await drive(e, [calls(["call_z", "get_weather", { city: "Lima" }])], { n: 0 }, requests);
      await e.agent.say("and then tell a joke");
      await drive(e, [], { n: 0 }, requests);
      check(typeof await cancelSession(e) === "string", "the waiting turn was not cancelled");
      await drive(e, [], { n: 0 }, requests);
      check(requests.length === 1, `the withdrawn input ran: ${requests.length} model calls`);
      const shown = (await e.agent.entries({})).map((x) => show(x));
      check(!shown.some((x) => x.includes("tell a joke")), "the queued input reached the transcript");
      check(show(await apiView(e)) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `after ${show(await apiView(e))}`);
    });
  });

  add("client", "a result that arrives before the tool runs is used at once, and nothing waits", async () => {
    await each(async (e) => {
      const requests: Request[] = [];
      await e.agent.answerClientCalls([{ callId: "call_2", output: "sunny", isError: false }]);
      await e.agent.say("weather?");
      await drive(e, [calls(["call_2", "get_weather", { city: "Oslo" }]), say("sunny")], { n: 0 }, requests);
      check(requests.length === 2 && show(toolMessages(requests[1]!)) === show(["sunny"]), `${e.name}: ${show(requests.map(toolMessages))}`);
      check(show(await apiView(e)) === show({ status: "idle", turns: ["completed"], pending: [] }), `${e.name}: ${show(await apiView(e))}`);
    });
  });

  add("client", "two caller functions in one batch: requires action for both, continues only once both are answered, the model reads both answers", async () => {
    await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_x", "get_weather", { city: "Rome" }], ["call_y", "get_weather", { city: "Oslo" }]), say("hot and cold")];
      await e.agent.say("weather in Rome and Oslo?");
      await drive(e, script, at, requests);
      const both = await apiView(e);
      check(show(both.pending) === show(["call_x", "call_y"]) && both.status === "requires_action", `${e.name}: ${show(both)}`);
      await e.agent.answerClientCalls([{ callId: "call_x", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      const one = await apiView(e);
      const calledAfterOne = requests.length;
      check(show(one.pending) === show(["call_y"]) && one.status === "requires_action" && calledAfterOne === 1, `${e.name}: after one answer ${show(one)}, ${calledAfterOne} model calls`);
      await e.agent.answerClientCalls([{ callId: "call_y", output: "cold", isError: true }]);
      await drive(e, script, at, requests);
      check(requests.length === 2 && show(toolMessages(requests[1]!)) === show(["hot", "cold"]), `${e.name}: the model read ${show(requests.map(toolMessages))}`);
    });
  });

  add("client", "a batch with a call that runs here: its result and the caller's both reach the model", async () => {
    await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["c_read", "web__read_page", { url: "u" }], ["call_b", "get_weather", { city: "Rome" }]), say("ok")];
      await e.agent.say("both");
      await drive(e, script, at, requests);
      check(show((await apiView(e)).pending) === show(["call_b"]), `${e.name}: ${show(await apiView(e))}`);
      await e.agent.answerClientCalls([{ callId: "call_b", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      check(requests.length === 2 && show(toolMessages(requests[1]!)) === show([show({ title: "page u" }), "hot"]), `${e.name}: the model read ${show(requests.map(toolMessages))}`);
    });
  });

  add("client", "cancelling a turn that waits on the caller: the call is forgotten, the turn cancelled then idle, a late answer continues nothing", async () => {
    await each(async (e) => {
      const requests: Request[] = [];
      await e.agent.say("weather?");
      await drive(e, [calls(["call_c", "get_weather", { city: "Lima" }])], { n: 0 }, requests);
      check((await apiView(e)).status === "requires_action", `${e.name}: before ${show(await apiView(e))}`);
      const cancelled = await cancelSession(e);
      // pi085's run ended at the pause, so its cancel finds none and the marker is markCancelled's; pd's tool is the run.
      check(e.name === "pi085" ? cancelled === null : typeof cancelled === "string", `${e.name}: cancelled ${show(cancelled)}`);
      await drive(e, [], { n: 0 }, requests);
      check(show(await apiView(e)) === show({ status: "idle", turns: ["cancelled"], pending: [] }) && (await e.agent.waitingClientCalls()).length === 0,
        `${e.name}: after ${show(await apiView(e))}`);
      await e.agent.answerClientCalls([{ callId: "call_c", output: "late", isError: false }]);
      await drive(e, [], { n: 0 }, requests);
      await e.agent.say("never mind, say hi");
      await drive(e, [say("hi")], { n: 0 }, requests);
      check(await markers(e) === 1, `${e.name}: ${await markers(e)} markers`);
      check(requests.length === 2, `${e.name}: ${requests.length} model calls (a late answer must not continue the cancelled turn)`);
      check(texts(requests[1]!).some((x) => x.includes(CANCELLED_NOTE.slice(1, 40))), `${e.name}: no note in ${show(texts(requests[1]!))}`);
    });
  });

  // ---- turn status sequences: each turn ends once, whatever the order of input, answers and steps ------------------

  add("sequence", "input while the turn requires action, then the answer: every turn reads terminal at most once, and all end completed", async () => {
    await each(async (e) => {
      const history = turnHistory(e);
      const at = { n: 0 };
      // pi085 answers the input at once (its own turn), then the caller's result continues the first turn; pd queues the
      // input behind the result, so one model call answers both.
      const script = e.name === "pi085"
        ? [calls(["call_s", "get_weather", { city: "Rome" }]), say("hello"), say("hot")]
        : [calls(["call_s", "get_weather", { city: "Rome" }]), say("hot, and hello")];
      await e.agent.say("weather in Rome?");
      await drive(e, script, at, [], history.sample);
      await e.agent.say("also, say hello");
      await history.sample();
      await drive(e, script, at, [], history.sample);
      await e.agent.answerClientCalls([{ callId: "call_s", output: "hot", isError: false }]);
      await history.sample();
      await drive(e, script, at, [], history.sample);
      const last = history.check("input during requires_action");
      check(show(await apiView(e)) === show({ status: "idle", turns: (await apiView(e)).turns.map(() => "completed"), pending: [] }), `${e.name}: final ${show(await apiView(e))}`);
      check(last.every((x) => x === "completed"), `${e.name}: final ${show(last)}`);
    });
  });

  add("sequence", "the answer arrives while a later turn runs (pi085), or while input waits behind it (pd): no turn reads terminal and then not", async () => {
    await each(async (e) => {
      const history = turnHistory(e);
      const at = { n: 0 };
      const script = e.name === "pi085"
        ? [calls(["call_r", "get_weather", { city: "Oslo" }]), say("later"), say("cold")]
        : [calls(["call_r", "get_weather", { city: "Oslo" }]), say("cold, and later")];
      await e.agent.say("weather in Oslo?");
      await drive(e, script, at, [], history.sample);
      await e.agent.say("meanwhile, something else");
      // One pass only: on pi085 the later turn's model call is now out, unanswered.
      await e.agent.step();
      await history.sample();
      await e.agent.answerClientCalls([{ callId: "call_r", output: "cold", isError: false }]);
      await history.sample();
      await drive(e, script, at, [], history.sample);
      const last = history.check("answer while a later turn runs");
      check(last.every((x) => x === "completed"), `${e.name}: final ${show(last)}`);
    });
  });

  add("sequence", "a steer while a turn runs a tool: the steered turn completes once and stays completed", async () => {
    await each(async (e) => {
      const history = turnHistory(e);
      const requests: Request[] = [];
      const at = { n: 0 };
      await e.agent.say("read the page");
      await e.agent.step();
      await history.sample();
      await e.agent.say("and then summarise it", "steer");
      await history.sample();
      await drive(e, [calls(["c_p", "web__read_page", { url: "u" }]), say("summary")], at, requests, history.sample);
      const last = history.check("steer during a running turn");
      check(last.length === 2 && last.every((x) => x === "completed"), `${e.name}: final ${show(last)}`);
    });
  });

  // ---- what ap.clientCalls keeps -------------------------------------------------------------------------------------

  add("client", "a call id used again later gets its own answer, not the earlier call's", async () => {
    await onPd(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_same", "get_weather", { city: "Paris" }]), say("mild"), calls(["call_same", "get_weather", { city: "Tokyo" }]), say("humid")];
      await e.agent.say("weather in Paris?");
      await drive(e, script, at, requests);
      await e.agent.answerClientCalls([{ callId: "call_same", output: "Paris-answer", isError: false }]);
      await drive(e, script, at, requests);
      await e.agent.say("and Tokyo?");
      await drive(e, script, at, requests);
      const waiting = await e.agent.waitingClientCalls();
      check(waiting.length === 1 && JSON.parse(waiting[0]!.arguments).city === "Tokyo", `the second call took the first one's answer: waiting ${show(waiting)}, model read ${show(requests.map(toolMessages))}`);
      await e.agent.answerClientCalls([{ callId: "call_same", output: "Tokyo-answer", isError: false }]);
      await drive(e, script, at, requests);
      check(show(toolMessages(requests.at(-1)!).at(-1)) === show("Tokyo-answer"), `the model read ${show(requests.map(toolMessages))}`);
    });
  });

  add("client", "an answer for a call that already has its result (after a cancel, or repeated) keeps nothing in ap.clientCalls", async () => {
    await onPd(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const doc = async () => {
        const id = await e.pd!.conversation("main");
        return Object.keys((await e.pd!.withHarness((h) => h.snapshot(ClientCallsDoc, id, BACKGROUND)))?.calls ?? {});
      };
      await e.agent.say("weather?");
      await drive(e, [calls(["call_l", "get_weather", { city: "Lima" }])], at, requests);
      check(typeof await cancelSession(e) === "string", "control: not cancelled");
      await e.agent.answerClientCalls([{ callId: "call_l", output: "late", isError: false }]);
      check(show(await doc()) === show([]), `a late answer after the cancel was kept: ${show(await doc())}`);
      const script = [calls(["call_m", "get_weather", { city: "Rome" }]), say("ok"), calls(["call_n", "get_weather", { city: "Oslo" }])];
      const at2 = { n: 0 };
      await e.agent.say("weather in Rome?");
      await drive(e, script, at2, requests);
      await e.agent.answerClientCalls([{ callId: "call_m", output: "hot", isError: false }]);
      await drive(e, script, at2, requests);
      // call_m returned; the next call's record forgets it, and a repeat of its answer must not bring it back.
      await e.agent.say("and Oslo?");
      await drive(e, script, at2, requests);
      await e.agent.answerClientCalls([{ callId: "call_m", output: "again", isError: false }]);
      check(show(await doc()) === show(["call_n"]), `ap.clientCalls holds ${show(await doc())}`);
    });
  });

  return cases;
}
