/**
 * Cancel and the API caller's functions on the `pd` engine (src/runtime/durable-agent.ts), measured against
 * `pi085` doing the same thing. Run over node:sqlite by test/pd-cancel.ts and on a real Durable Object's
 * storage by cf/src/conformance.ts (test/pd-cancel-do.sh).
 *
 * The world is test/spec/pd-tools-spec.ts's (the real gateway, test plugins, the same catalogue) plus one
 * function the caller runs, `get_weather`, wired on each engine the way cf/src/runtime.ts `agent()` wires it:
 * pi085's `clientTools` over the lane, pd's `clientTools` definitions; and the cancel marker with pi085's
 * entry projector and pd's `markerNotes`. What is compared is what the model is sent (`seen`, every request
 * through `toRequest`) and the turns the Agents API reads (`sessionTranscript` over `entries()`).
 *
 * A pass is driven as `AgentRuntime.step` drives it: `step()`, and when nothing is left open,
 * `resumeClientCalls()`, stepping again at once if it says a run is due.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import { CLIENT_PENDING, clientTools } from "../../src/runtime/client-calls.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import { pdAbortedBlock } from "../../src/runtime/durable-tools.ts";
import { parkVerdict, readSnapshot } from "../../src/runtime/durable-drive.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import { CANCELLED_NOTE, sessionTranscript, TURN_CANCELLED } from "../../cf/src/agents-api/transcript.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";
import {
  calls, MODEL, say, seen, stepUntil, SYSTEM, toolMessages, toolOptions, world,
  type Engine, type Request, type Turn, type World,
} from "./pd-tools-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const WEATHER = [{ name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } }];
const NOTE_PROJECTOR = {
  [TURN_CANCELLED]: (entry: { timestamp: number }) => [{ role: "user" as const, content: [{ type: "text" as const, text: CANCELLED_NOTE }], timestamp: entry.timestamp }],
};

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
    ...toolOptions(w), clientTools: WEATHER, markerNotes: { [TURN_CANCELLED]: CANCELLED_NOTE },
  });
  return { name: "pd", agent, dispatched, pd: host };
}

type Job = { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };

/**
 * Drive until nothing is open and nothing is due, as `AgentRuntime.step` does, answering each model call from
 * `script` in turn (`at` counts the turns used so far, across calls). Returns the requests seen and the last outcome.
 */
const taken = new WeakMap<Eng, Set<string>>();
async function drive(e: Eng, script: Turn[], at: { n: number }, requests: Request[]) {
  const answered = taken.get(e) ?? new Set<string>();
  taken.set(e, answered);
  for (let guard = 0; guard < 300; guard++) {
    const t0 = Date.now();
    const out = await e.agent.step();
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

/** The model's job rows still in the engine's table: what a late answer could land on. */
function jobRows(storage: DurableSqlHost, e: Eng): number {
  const table = e.name === "pd" ? "ap_model_jobs" : "pi_model_jobs";
  return Number(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]!.n);
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

/** The session's items as the Agents API lists them, ids aside (they are entry sequence numbers, which differ). */
async function apiItems(e: Eng): Promise<string[]> {
  const running = await e.agent.running();
  const pending = running ? [] : await e.agent.waitingClientCalls();
  const { items } = sessionTranscript({ entries: await e.agent.branch(), running, pending }, { sessionId: "s", agentId: "a" });
  return items.map(({ id: _id, turn_id: _turn, ...rest }) => show(rest));
}

function sameItems(r: { pi085: { items: string[] }; pd: { items: string[] } }, what: string) {
  check(show(r.pi085.items) === show(r.pd.items), `${what}: the Agents API's items differ\n pi085 ${show(r.pi085.items)}\n pd    ${show(r.pd.items)}`);
}

/** What `AgentRuntime.cancelSession` does with an engine. */
async function cancelSession(e: Eng): Promise<string | null> {
  const cancelled = await e.agent.cancel(TURN_CANCELLED);
  if ((await e.agent.dropClientCalls()) > 0 && !cancelled) await e.agent.markCancelled(TURN_CANCELLED);
  return cancelled;
}

const markers = async (e: Eng) => (await e.agent.entries({})).filter((x) => x.type === "custom" && x.customType === TURN_CANCELLED).length;

/** Every request the same, in order, as the model reads it. */
function sameRequests(a: Request[], b: Request[], what: string, differs?: (pi: string, pd: string) => boolean) {
  check(a.length === b.length, `${what}: model calls: pi085 ${a.length}, pd ${b.length}`);
  a.forEach((p, i) => {
    const x = seen(p), y = seen(b[i]!);
    check(show(x.tools) === show(y.tools), `${what}: request ${i}: tools differ`);
    x.messages.forEach((m, j) => check(m === y.messages[j] || (differs?.(m, y.messages[j]!) ?? false),
      `${what}: request ${i}, message ${j} differs\n pi085 ${m}\n pd    ${y.messages[j]}`));
    check(x.messages.length === y.messages.length, `${what}: request ${i}: ${x.messages.length} messages on pi085, ${y.messages.length} on pd`);
  });
}

const texts = (req: Request) => req.messages.filter((m) => m.role !== "system").map((m) => (typeof m.content === "string" ? m.content : show(m.content)));

export function pdCancelCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, run: () => Promise<void>) => cases.push({ group, name, run });

  /** Run `body` once per engine, each on fresh storage, and hand back what each returned. */
  async function each<T>(body: (e: Eng, w: World, storage: DurableSqlHost) => Promise<T>, pdOpts?: { stepDeadlineMs?: number }): Promise<{ pi085: T; pd: T }> {
    const out: Partial<Record<"pi085" | "pd", T>> = {};
    for (const which of ["pi085", "pd"] as const) {
      await withHost(async (storage) => {
        const w = await world(storage);
        const e = which === "pi085" ? await pi085(storage, w) : pd(storage, w, pdOpts);
        try { out[which] = await body(e, w, storage); } finally { await e.agent.close(); }
      });
    }
    return out as { pi085: T; pd: T };
  }

  // ---- cancel ---------------------------------------------------------------------------

  add("cancel", "mid model call: the job is dropped, the marker written, the turn cancelled then idle; a second cancel changes nothing; the next request carries the note", async () => {
    const r = await each(async (e, _w, storage) => {
      const requests: Request[] = [];
      await e.agent.say("write a long story");
      await e.agent.step();
      check(e.dispatched.length === 1 && jobRows(storage, e) === 1, `${e.name}: no model call in flight (${show(e.dispatched)})`);
      const before = await apiView(e);
      check(before.status === "in_progress", `${e.name}: before the cancel ${show(before)}`);
      const cancelled = await cancelSession(e);
      check(typeof cancelled === "string" && cancelled.length > 0, `${e.name}: a running turn was not cancelled (${show(cancelled)})`);
      check(jobRows(storage, e) === 0, `${e.name}: the model call's row is still there, so its answer could land`);
      check(!(await e.agent.running()), `${e.name}: still running after the cancel`);
      check(await markers(e) === 1, `${e.name}: ${await markers(e)} cancel markers`);
      const after = await apiView(e);
      const entries = (await e.agent.entries({})).length;
      // Cancel on idle: nothing reported, nothing written.
      check(await cancelSession(e) === null, `${e.name}: cancelling an idle session reported a cancellation`);
      check((await e.agent.entries({})).length === entries && await markers(e) === 1, `${e.name}: cancelling an idle session wrote something`);
      await e.agent.say("just say OK");
      await drive(e, [say("OK")], { n: 0 }, requests);
      return { after, requests, final: await apiView(e), items: await apiItems(e) };
    });
    sameItems(r, "after a cancel mid model call");
    for (const [name, v] of Object.entries(r)) {
      check(show(v.after) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `${name}: after the cancel ${show(v.after)}`);
      check(show(v.final) === show({ status: "idle", turns: ["cancelled", "completed"], pending: [] }), `${name}: after the next turn ${show(v.final)}`);
    }
    sameRequests(r.pi085.requests, r.pd.requests, "after a cancel mid model call");
    const t = texts(r.pd.requests[0]!);
    const at = (needle: string) => t.findIndex((x) => x.includes(needle));
    check(at("write a long story") >= 0 && at("write a long story") < at(CANCELLED_NOTE.slice(1, 40)) && at(CANCELLED_NOTE.slice(1, 40)) < at("just say OK"),
      `the note is not between the cancelled request and the new one: ${show(t)}`);
  });

  add("cancel", "mid tool call: the turn is cancelled then idle; the next request is the same but for the cut-off call's result (pd: aborted, pi085: its late outcome)", async () => {
    const r = await each(async (e, w) => {
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
      await e.agent.say("what happened?");
      await drive(e, [say("it was cancelled")], { n: 0 }, requests);
      return { after, requests, invoked: [...w.invoked] };
    });
    for (const [name, v] of Object.entries(r)) {
      check(show(v.after) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `${name}: after the cancel ${show(v.after)}`);
      check(show(v.invoked) === show(["web.slow"]), `${name}: the plugin ran ${show(v.invoked)}`);
    }
    // The one difference, and why it stays. pi085's abort waits for the call to return and records its real result.
    // pd's abort mark commits first, and pi-durable then refuses the call's own result: the result is pi-durable's
    // "aborted" (@earendil-works/pi-durable 1.0.0 dist/harness/tool.js, the task's `abort`).
    // The rest of the request — the call, the note, the next message — is the same.
    const c1 = (m: string) => JSON.parse(m) as { role: string; tool_call_id?: string; content: string };
    sameRequests(r.pi085.requests, r.pd.requests, "after a cancel mid tool call", (pi, pdm) =>
      c1(pi).tool_call_id === "c1" && c1(pi).content === show({ slow: "done" }) && c1(pdm).tool_call_id === "c1"
      && c1(pdm).content === pdAbortedBlock("web__slow"));
  });

  add("cancel", "on idle, after a finished turn: null, nothing written, the turn stays completed", async () => {
    const r = await each(async (e) => {
      await e.agent.say("hello");
      await drive(e, [say("hi")], { n: 0 }, []);
      const before = (await e.agent.entries({})).length;
      const cancelled = await cancelSession(e);
      return { cancelled, same: (await e.agent.entries({})).length === before, view: await apiView(e) };
    });
    for (const [name, v] of Object.entries(r)) {
      check(v.cancelled === null && v.same, `${name}: cancel on idle returned ${show(v.cancelled)}, entries unchanged ${v.same}`);
      check(show(v.view) === show({ status: "idle", turns: ["completed"], pending: [] }), `${name}: ${show(v.view)}`);
    }
  });

  // ---- client calls -------------------------------------------------------------------------

  add("client", "round trip: the call waits for the caller with nothing open and no alarm; the result continues the turn with a clean context", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_1", "get_weather", { city: "Paris" }]), say("21 degrees")];
      await e.agent.say("weather in Paris?");
      const t0 = Date.now();
      const paused = await drive(e, script, at, requests);
      const pauseMs = Date.now() - t0;
      // Parked on the caller: the step asked for no wake and, on pd, closed the harness (a read below reopens one,
      // without resuming it).
      check(paused.open === 0 && paused.wakeInMs === null, `${e.name}: the paused step said ${show(paused)}`);
      if (e.name === "pd") check(!e.pd!.open, "pd: the harness is still open while only the caller is awaited");
      const waiting = await apiView(e);
      const waitingItems = await apiItems(e);
      const rows = await e.agent.waitingClientCalls();
      check(!(await e.agent.resumeClientCalls()), `${e.name}: resumed before the caller answered`);
      await e.agent.answerClientCalls([{ callId: "call_1", output: "{\"temp\":21}", isError: false }]);
      await e.agent.answerClientCalls([{ callId: "call_1", output: "again", isError: false }]);
      await drive(e, script, at, requests);
      return { pauseMs, waiting, waitingItems, rows, requests, final: await apiView(e), left: await e.agent.waitingClientCalls(), items: await apiItems(e) };
    });
    sameItems({ pi085: { items: r.pi085.waitingItems }, pd: { items: r.pd.waitingItems } }, "while waiting on the caller");
    sameItems(r, "after the caller's result");
    for (const [name, v] of Object.entries(r)) {
      check(v.pauseMs < 2_500, `${name}: pausing for the caller took ${v.pauseMs} ms`);
      check(show(v.waiting) === show({ status: "requires_action", turns: ["waiting"], pending: ["call_1"] }), `${name}: while waiting ${show(v.waiting)}`);
      check(v.rows.length === 1 && v.rows[0]!.name === "get_weather" && JSON.parse(v.rows[0]!.arguments).city === "Paris", `${name}: waiting rows ${show(v.rows)}`);
      check(show(v.final) === show({ status: "idle", turns: ["completed"], pending: [] }) && v.left.length === 0, `${name}: after ${show(v.final)} ${show(v.left)}`);
      const second = v.requests[1]!;
      check(!show(second).includes(CLIENT_PENDING) && show(toolMessages(second)) === show(["{\"temp\":21}"]), `${name}: the model read ${show(toolMessages(second))}`);
    }
    sameRequests(r.pi085.requests, r.pd.requests, "client call round trip");
  });

  add("client", "the park rule: a tool waiting on the caller is parked with no alarm when externalWaits names it, and held open when it does not", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w, { stepDeadlineMs: 10_000 });
      try {
        await e.agent.say("weather?");
        const t0 = Date.now();
        const out = await drive(e, [calls(["call_9", "get_weather", { city: "Oslo" }])], { n: 0 }, []);
        const ms = Date.now() - t0;
        check(out.open === 0 && out.wakeInMs === null && !e.pd!.open, `the step left ${show(out)}, open ${e.pd!.open}`);
        check(ms < 5_000, `the step took ${ms} ms: it waited out its deadline instead of parking on the caller`);
        // The same state, live: resumed, the tool runs again, finds no answer and waits in-process. The verdict on it
        // with the call named, and — the control — without.
        const ap = await e.pd!.store();
        const conversation = await e.pd!.conversation("main");
        const verdicts = await e.pd!.withHarness(async (h) => {
          h.resume();
          for (let i = 0; i < 200; i++) {
            const t = (await h.inspect(BACKGROUND)).tasks.find((x) => x.record.kind === "pi.tool");
            if (t?.state.kind === "running" && show(t.record.state).includes("execute")) break;
            await sleep(10);
          }
          const named = await readSnapshot(h, BACKGROUND, () => e.pd!.now, 5, () => new Map([[conversation, new Set(ap.pendingClientCalls(conversation).map((c) => c.callId))]]));
          const bare = await readSnapshot(h, BACKGROUND, () => e.pd!.now, 5);
          check(named && bare, "no snapshot");
          return { named: parkVerdict(named), bare: parkVerdict(bare) };
        });
        check(verdicts.named.verdict === "external" && show(verdicts.named).includes("call_9"), `with the call named: ${show(verdicts.named)}`);
        check(verdicts.bare.verdict === "wait", `control: without it the verdict is ${show(verdicts.bare)}`);
      } finally { await e.agent.close(); }
    });
  });

  add("client", "a result arriving while the harness is open is handed to the waiting tool; one arriving while parked reopens it", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w, { stepDeadlineMs: 10_000 });
      try {
        // A batch with a slow call beside the caller's: the slow call keeps the harness open, so the client tool waits in-process.
        await e.agent.say("weather and a slow thing");
        await e.agent.step();
        const [job] = e.dispatched;
        const taken = await e.agent.takeJob(job!) as Job;
        await e.agent.deliver(job!, fromResponse(calls(["c_slow", "web__slow", {}], ["call_open", "get_weather", { city: "Rome" }])({ messages: [] }), taken.model, job!));
        const { step } = await stepUntil(e, w.slow.arrived);
        for (let i = 0; i < 100 && (await e.agent.waitingClientCalls()).length === 0; i++) await sleep(10);
        check(e.pd!.open, "control: the harness closed while a slow call ran");
        const { notWaiting } = await e.pd!.answerClientCalls(await e.pd!.conversation("main"), [{ callId: "call_open", output: "warm", isError: false }]);
        check(notWaiting.length === 0, `the open harness's waiting tool was not told: ${show(notWaiting)}`);
        w.slow.open();
        await step;
        const requests: Request[] = [];
        await drive(e, [say("done")], { n: 0 }, requests);
        check(show(toolMessages(requests[0]!)) === show([show({ slow: "done" }), "warm"]), `the model read ${show(toolMessages(requests[0]!))}`);

        // Parked: nothing waits in this isolate, so the answer resumes the harness and the replayed tool reads it.
        await e.agent.say("and in Oslo?");
        const at = { n: 0 };
        await drive(e, [calls(["call_parked", "get_weather", { city: "Oslo" }]), say("cold")], at, requests);
        check(!e.pd!.open, "control: not parked");
        await e.agent.answerClientCalls([{ callId: "call_parked", output: "cold", isError: false }]);
        check(e.pd!.open, "the answer to a parked call did not reopen the harness");
        // No step yet: the resumed harness replays the tool, which takes the answer from its row.
        const ap = await e.pd!.store();
        const conversation = await e.pd!.conversation("main");
        for (let i = 0; i < 200 && ap.clientCall(conversation, "call_parked")?.state !== "used"; i++) await sleep(10);
        check(ap.clientCall(conversation, "call_parked")?.state === "used", `the replayed tool did not take the answer: ${show(ap.clientCall(conversation, "call_parked"))}`);
        await drive(e, [calls(["call_parked", "get_weather", { city: "Oslo" }]), say("cold")], at, requests);
        check(show(toolMessages(requests.at(-1)!).at(-1)) === show("cold"), `the model read ${show(toolMessages(requests.at(-1)!))}`);
      } finally { await e.agent.close(); }
    });
  });

  add("client", "cancelling while the caller's function waits in an open harness ends the wait: aborted, forgotten, and a late answer runs nothing", async () => {
    await withHost(async (storage) => {
      const w = await world(storage);
      const e = pd(storage, w, { stepDeadlineMs: 10_000 });
      try {
        await e.agent.say("weather and a slow thing");
        await e.agent.step();
        const [job] = e.dispatched;
        const taken = await e.agent.takeJob(job!) as Job;
        await e.agent.deliver(job!, fromResponse(calls(["c_slow", "web__slow", {}], ["call_w", "get_weather", { city: "Rome" }])({ messages: [] }), taken.model, job!));
        const { step } = await stepUntil(e, w.slow.arrived);
        for (let i = 0; i < 100 && (await e.agent.waitingClientCalls()).length === 0; i++) await sleep(10);
        check(e.pd!.open && (await e.agent.waitingClientCalls()).length === 1, "control: the caller's function is not waiting in an open harness");
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
        const results = (await e.agent.entries({})).filter((x) => (x as { message?: { role?: string } }).message?.role === "toolResult")
          .map((x) => (x as unknown as { message: { toolCallId: string; content: Array<{ text?: string }> } }).message);
        const text = (id: string) => results.find((m) => m.toolCallId === id)?.content.map((c) => c.text ?? "").join("");
        check(text("call_w") === CLIENT_PENDING && text("c_slow") === pdAbortedBlock("web__slow"), `results ${show(results)}`);
        check(show(await apiView(e)) === show({ status: "idle", turns: ["cancelled"], pending: [] }), `after ${show(await apiView(e))}`);
      } finally { await e.agent.close(); }
    });
  });

  add("client", "input while the turn waits on the caller starts a new turn at once; a later answer goes back to the call, as on pi085", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_q", "get_weather", { city: "Rome" }]), say("hello"), say("hot then")];
      await e.agent.say("weather in Rome?");
      await drive(e, script, at, requests);
      const waiting = await apiView(e);
      await e.agent.say("actually, just say hello");
      await drive(e, script, at, requests);
      const after = await apiView(e);
      const afterItems = await apiItems(e);
      await e.agent.answerClientCalls([{ callId: "call_q", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      return { waiting, after, afterItems, answered: await apiView(e), items: await apiItems(e), requests };
    });
    for (const [name, v] of Object.entries(r)) {
      check(show(v.waiting) === show({ status: "requires_action", turns: ["waiting"], pending: ["call_q"] }), `${name}: waiting ${show(v.waiting)}`);
      // The new input is answered at once; the call still waits for the caller.
      check(show(v.after) === show({ status: "requires_action", turns: ["waiting", "completed"], pending: ["call_q"] }), `${name}: after the input ${show(v.after)}`);
      check(v.afterItems.some((x) => x.includes("actually, just say hello")) && v.afterItems.some((x) => x.includes("\"hello\"")), `${name}: items ${show(v.afterItems)}`);
      // The answer goes back to the call: the turn in between leaves the branch, as pi085's navigateTree leaves it.
      check(show(v.answered) === show({ status: "idle", turns: ["completed"], pending: [] }), `${name}: after the answer ${show(v.answered)}`);
      check(v.requests.length === 3 && show(toolMessages(v.requests[1]!)) === show([CLIENT_PENDING]) && show(toolMessages(v.requests[2]!)) === show(["hot"]),
        `${name}: the model read ${show(v.requests.map(toolMessages))}`);
    }
    sameItems({ pi085: { items: r.pi085.afterItems }, pd: { items: r.pd.afterItems } }, "after input while waiting");
    sameItems(r, "after the late answer");
    sameRequests(r.pi085.requests, r.pd.requests, "input while waiting on the caller");
  });

  add("client", "a result that arrives before the tool runs is used at once, and nothing waits", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      await e.agent.answerClientCalls([{ callId: "call_2", output: "sunny", isError: false }]);
      await e.agent.say("weather?");
      await drive(e, [calls(["call_2", "get_weather", { city: "Oslo" }]), say("sunny")], { n: 0 }, requests);
      return { requests, view: await apiView(e) };
    });
    for (const [name, v] of Object.entries(r)) {
      check(v.requests.length === 2 && show(toolMessages(v.requests[1]!)) === show(["sunny"]), `${name}: ${show(v.requests.map(toolMessages))}`);
      check(show(v.view) === show({ status: "idle", turns: ["completed"], pending: [] }), `${name}: ${show(v.view)}`);
    }
    sameRequests(r.pi085.requests, r.pd.requests, "early answer");
  });

  add("client", "two caller functions in one batch: requires action for both, continues only once both are answered, the model reads both answers", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["call_x", "get_weather", { city: "Rome" }], ["call_y", "get_weather", { city: "Oslo" }]), say("hot and cold")];
      await e.agent.say("weather in Rome and Oslo?");
      await drive(e, script, at, requests);
      const both = await apiView(e);
      await e.agent.answerClientCalls([{ callId: "call_x", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      const one = await apiView(e);
      const calledAfterOne = requests.length;
      await e.agent.answerClientCalls([{ callId: "call_y", output: "cold", isError: true }]);
      await drive(e, script, at, requests);
      return { both, one, calledAfterOne, requests, items: await apiItems(e) };
    });
    sameItems(r, "two caller functions");
    for (const [name, v] of Object.entries(r)) {
      check(show(v.both.pending) === show(["call_x", "call_y"]) && v.both.status === "requires_action", `${name}: ${show(v.both)}`);
      check(show(v.one.pending) === show(["call_y"]) && v.one.status === "requires_action" && v.calledAfterOne === 1, `${name}: after one answer ${show(v.one)}, ${v.calledAfterOne} model calls`);
      check(v.requests.length === 2 && show(toolMessages(v.requests[1]!)) === show(["hot", "cold"]), `${name}: the model read ${show(v.requests.map(toolMessages))}`);
    }
    sameRequests(r.pi085.requests, r.pd.requests, "two caller functions");
  });

  add("client", "a batch with a call that runs here: its result and the caller's both reach the model", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      const at = { n: 0 };
      const script = [calls(["c_read", "web__read_page", { url: "u" }], ["call_b", "get_weather", { city: "Rome" }]), say("ok")];
      await e.agent.say("both");
      await drive(e, script, at, requests);
      const view = await apiView(e);
      await e.agent.answerClientCalls([{ callId: "call_b", output: "hot", isError: false }]);
      await drive(e, script, at, requests);
      return { view, requests };
    });
    for (const [name, v] of Object.entries(r)) check(show(v.view.pending) === show(["call_b"]), `${name}: ${show(v.view)}`);
    sameRequests(r.pi085.requests, r.pd.requests, "mixed batch");
  });

  add("client", "cancelling a turn that waits on the caller: the call is forgotten, the turn cancelled then idle, and the next request reads the same", async () => {
    const r = await each(async (e) => {
      const requests: Request[] = [];
      await e.agent.say("weather?");
      await drive(e, [calls(["call_c", "get_weather", { city: "Lima" }])], { n: 0 }, requests);
      const before = await apiView(e);
      const cancelled = await cancelSession(e);
      await drive(e, [], { n: 0 }, requests);
      const after = await apiView(e);
      const left = await e.agent.waitingClientCalls();
      const late = await e.agent.answerClientCalls([{ callId: "call_c", output: "late", isError: false }]);
      void late;
      await drive(e, [], { n: 0 }, requests);
      await e.agent.say("never mind, say hi");
      await drive(e, [say("hi")], { n: 0 }, requests);
      return { before, cancelled, after, left, requests, markers: await markers(e), items: await apiItems(e) };
    });
    sameItems(r, "after cancelling a wait on the caller");
    for (const [name, v] of Object.entries(r)) {
      check(v.before.status === "requires_action", `${name}: before ${show(v.before)}`);
      check(show(v.after) === show({ status: "idle", turns: ["cancelled"], pending: [] }) && v.left.length === 0, `${name}: after ${show(v.after)} ${show(v.left)}`);
      check(v.markers === 1, `${name}: ${v.markers} markers`);
      check(v.requests.length === 2, `${name}: ${v.requests.length} model calls (a late answer must not continue the cancelled turn)`);
    }
    // pi085's run ended at the pause, so its cancel finds none and the marker is markCancelled's; pd's tool is the run.
    check(r.pi085.cancelled === null && typeof r.pd.cancelled === "string", `cancelled: pi085 ${show(r.pi085.cancelled)}, pd ${show(r.pd.cancelled)}`);
    sameRequests(r.pi085.requests, r.pd.requests, "after cancelling a wait on the caller");
  });

  return cases;
}
