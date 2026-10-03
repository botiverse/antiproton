/**
 * The `pd` engine (src/runtime/durable-agent.ts): `DurableAgent` over `PdHost`, on pi-durable's
 * harness, its offloaded provider and the `ap_model_jobs` table. Run over node:sqlite by
 * test/durable-agent.ts and on a real Durable Object's storage by cf/src/conformance.ts
 * (test/durable-agent-do.sh).
 *
 * The queue consumer is the real conversion in both directions, as test/spec/durable-drive-spec.ts
 * does it: `toRequest` on what `takeJob` hands out, `fromResponse` on the model's reply, then
 * `deliver`. Only the model is faked. A "new object" is a new `PdHost` on the same storage — what an
 * eviction leaves: the rows, and nothing in memory.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { durableOffloadedProvider } from "../../src/model/durable-offloaded.ts";
import { errorMessage, fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { DurableAgent, PdHost, POLL_BACKSTOP_MS, type DurableAgentOptions, type PdHostOptions } from "../../src/runtime/durable-agent.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { createModels } from "pi-ai-1/models";
import { consumeModelCalls, replyingUnknownJob, UnknownJob, type ModelJobStub, type ModelQueueDeps } from "../../cf/src/model-queue.ts";
import type { DriveCase, TimerProbe, WithDriveHost } from "./durable-drive-spec.ts";

/**
 * The poll interval of these objects: longer than a case may take, so a turn that completes after an answer
 * completed because the answer woke it. A case about the interval itself passes its own (`object`'s `opts`).
 */
const POLL_MS = 60_000;
const MODEL = { provider: "queue", id: "m1", contextWindow: 100_000 };

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const reply = (text: string): ModelResponse => ({
  text, finishReason: "stop", truncated: false, usage: { promptTokens: 3, completionTokens: 2, reasoningTokens: 0, cachedPromptTokens: 0 },
});

/**
 * A case that cannot finish fails here, by name, with every host it opened closed — never runs on. A step that
 * cannot park returns after `STEP_DEADLINE_MS` (the runtime's is 30 s), so a case that steps until something
 * happens fails within `CASE_DEADLINE_MS`. The slowest case passes in about 2 s.
 */
const STEP_DEADLINE_MS = 3_000;
const CASE_DEADLINE_MS = 15_000;
/** The hosts the running case opened, closed at its deadline. Cases run one at a time. */
let caseHosts: PdHost[] = [];

/** One object's engine, as AgentRuntime builds it, with what a case reads: dispatches and polls. */
function object(storage: DurableSqlHost, polls: Array<{ id: string; ready: boolean }> = [], opts: Partial<PdHostOptions> = {}) {
  const dispatched: string[] = [];
  const host = new PdHost({
    storage, pollAfterMs: POLL_MS, minParkMs: 1, stepDeadlineMs: STEP_DEADLINE_MS, onPoll: (id, ready) => polls.push({ id, ready }), ...opts,
  });
  caseHosts.push(host);
  const agent = (session?: string, extra: Partial<DurableAgentOptions> = {}) => DurableAgent.open({
    host, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: "You are a terse test assistant.",
    dispatch: async (id) => { dispatched.push(id); },
    unknownJob: (id) => new UnknownJob(id),
    ...(session === undefined ? {} : { session }),
    ...extra,
  });
  return { host, agent, dispatched, polls };
}

type Jobs = Array<{ id: string; answer: string | null; dispatched_at: number | null; request: string }>;
const jobs = (storage: DurableSqlHost): Jobs =>
  storage.sql.exec("SELECT id, answer, dispatched_at, request FROM ap_model_jobs ORDER BY created_at").toArray() as unknown as Jobs;

/** The worker: take the job, run the real conversion, answer. */
async function consume(agent: DurableAgent, id: string, text: string) {
  const job = await agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
  check(job, `job ${id} was not handed out`);
  const { messages } = toRequest(job.context);
  const answer = fromResponse(reply(text), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id);
  check(await agent.deliver(id, answer) === true, `deliver of ${id} was refused`);
  return messages;
}

/** Wait, with the harness open, until a generation's checkpoint says `poll`: the middle of a poll sleep. */
async function untilPolling(host: PdHost) {
  for (let i = 0; i < 400; i++) {
    const phase = await host.withHarness(async (h) =>
      (await h.inspect(BACKGROUND)).tasks.map((t) => (t.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase));
    if (phase.includes("poll")) return;
    await sleep(5);
  }
  throw new Error("the generation never reached its poll sleep");
}
/** Wait until the transcript ends with the answer `text`; how long after `t0` that was. */
async function untilAnswer(agent: DurableAgent, text: string, t0: number): Promise<number> {
  for (let i = 0; i < 400; i++) {
    if (turns(await agent.entries({})).at(-1) === `assistant(stop): ${text}`) return Date.now() - t0;
    await sleep(5);
  }
  throw new Error(`the answer ${text} never reached the transcript`);
}
const turns = (entries: Array<{ type: string; message?: unknown }>) => entries.map((e) => {
  const m = (e as { message: { role: string; content: unknown; stopReason?: string } }).message;
  const text = typeof m.content === "string" ? m.content
    : (m.content as Array<{ type: string; text?: string }>).map((c) => (c.type === "text" ? c.text : "")).join("");
  return m.role === "assistant" ? `assistant(${m.stopReason}): ${text}` : `${m.role}: ${text}`;
});

export function durableAgentCases(withHost: WithDriveHost, activeTimers: TimerProbe): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, body: (host: DurableSqlHost) => Promise<void>) =>
    cases.push({ group, name, run: () => withHost(async (storage) => {
      caseHosts = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`case "${name}" passed its ${CASE_DEADLINE_MS} ms deadline`)), CASE_DEADLINE_MS);
        // Not a timer of the engine's: unref'd, so node's live-timer probe does not count it (workerd has no unref).
        (timer as { unref?: () => void }).unref?.();
      });
      try { await Promise.race([body(storage), deadline]); }
      catch (error) {
        // The body may still be running: close what it opened so it stops, then fail with the case's error.
        await Promise.allSettled(caseHosts.map((h) => h.close()));
        throw error;
      } finally { clearTimeout(timer); }
    }) });

  add("turn", `say → an ap job is written and dispatched → step parks${activeTimers ? " with no harness or timer left" : " with no harness left"} → deliver → step: the answer is the transcript`, async (storage) => {
    const o = object(storage);
    const a = o.agent();
    const said = await a.say("Capital of France?") as { value: { operationId?: string } };
    check(said.value.operationId, `an idle conversation did not start a run: ${show(said)}`);
    const t0 = Date.now();
    const parked = await a.step();
    const took = Date.now() - t0;
    check(parked.wakeInMs !== null && parked.wakeInMs > 0 && parked.wakeInMs <= POLL_MS && parked.open === 1, `step: ${show(parked)}`);
    check(!o.host.open, "the harness is still open after a park");
    if (activeTimers) check(activeTimers() === 0, `live timers after the park: ${activeTimers()}`);
    const rows = jobs(storage);
    check(rows.length === 1 && rows[0]!.answer === null && rows[0]!.dispatched_at !== null, `jobs ${show(rows)}`);
    check(show(o.dispatched) === show([rows[0]!.id]), `dispatched ${show(o.dispatched)}`);
    // Also what pins PdHost passing no `onSleep`: the poll sleep must be seen by the read its checkpoint's commit
    // brings. Seen only at settle's 1 s recheck, the step would take that second.
    check(o.polls.length === 0, `polled before the park ended: ${show(o.polls)}`);
    check(took < 900, `the park took ${took} ms (did it wait for settle's 1 s recheck?)`);
    const id = rows[0]!.id;
    const asked = await consume(a, id, "Paris");
    check(asked.some((m) => m.role === "user" && m.content === "Capital of France?") && asked.some((m) => m.role === "system" && m.content.includes("terse test assistant")),
      `the model was asked ${show(asked)}`);
    check(await a.takeJob(id) === null, "an answered job was handed out again");
    check(await a.deliver(id, fromResponse(reply("again"), { api: "x", provider: "queue", id: "m1" }, id)) === false, "a second answer was accepted");
    // The wake the delivery asks of the object: at once, not at the park's time.
    const done = await a.step();
    check(done.wakeInMs === null && done.open === 0, `after the answer: ${show(done)}`);
    check(show(o.polls) === show([{ id, ready: true }]), `polls ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Capital of France?", "assistant(stop): Paris"]), `entries ${show(turns(await a.entries({})))}`);
    check(show(turns(await a.branch())) === show(["user: Capital of France?", "assistant(stop): Paris"]), `branch ${show(turns(await a.branch()))}`);
    const e = await a.entries({ order: "desc", limit: 1 });
    check(e.length === 1 && turns(e)[0] === "assistant(stop): Paris" && e[0]!.type === "message", `desc/limit ${show(e)}`);
    check(!(await a.running()), "still running after the answer");
    check(show(await a.tools()) === "[]", "an agent opened with no tools is offered some");
    await a.close();
  });

  add("turn", "close mid-poll, reopen as a new object, answer: its first step completes the turn with one job and exactly one fetch", async (storage) => {
    const polls: Array<{ id: string; ready: boolean }> = [];
    const first = object(storage, polls);
    const a = first.agent();
    await a.say("Q1");
    await untilPolling(first.host);
    check(first.host.open, "control: the harness is open while it sleeps");
    await a.close();
    check(!first.host.open, "close left the harness open");
    const [row] = jobs(storage);
    check(row && polls.length === 0, `before the answer: jobs ${show(jobs(storage))}, polls ${show(polls)}`);
    const second = object(storage, polls);
    const b = second.agent();
    await consume(b, row.id, "A1");
    check(!second.host.open && polls.length === 0, `the delivery opened a harness or polled: polls ${show(polls)}`);
    const done = await b.step();
    check(done.wakeInMs === null, `after the answer: ${show(done)}`);
    check(jobs(storage).length === 1, `a reopen called the model again: ${jobs(storage).length} jobs`);
    check(show(polls) === show([{ id: row.id, ready: true }]), `fetches ${show(polls)}`);
    check(show(turns(await b.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await b.entries({})))}`);
    await b.close();
  });

  add("turn", "two overlapping step() calls, from two agents on one host, run the turn once", async (storage) => {
    const o = object(storage);
    const a = o.agent(), again = o.agent();
    await a.say("Q1");
    // Closed, so both steps race to open the harness and to resume the generation.
    await a.close();
    const [x, y] = await Promise.all([a.step(), again.step()]);
    check(show(x) === show(y) && x.wakeInMs !== null, `outcomes ${show([x, y])}`);
    const rows = jobs(storage);
    check(rows.length === 1 && o.dispatched.length === 1, `jobs ${rows.length}, dispatches ${o.dispatched.length}: the generation ran twice`);
    await consume(a, rows[0]!.id, "A1");
    const [p, q] = await Promise.all([a.step(), again.step()]);
    check(p.wakeInMs === null && q.wakeInMs === null, `after the answer: ${show([p, q])}`);
    check(o.polls.length === 1, `fetches ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("turn", `a message during a step goes through the step's harness: one fetch per answer${activeTimers ? ", nothing left running" : ""}`, async (storage) => {
    const o = object(storage);
    const a = o.agent();
    await a.say("Q1");
    const parked = await a.step();
    check(parked.wakeInMs !== null, `step: ${show(parked)}`);
    const [first] = jobs(storage);
    await consume(a, first!.id, "A1");
    // The step's pass is in flight — the answer woke its poll — when the message arrives. A second harness
    // opened for the message would be a second scheduler running the same poll.
    const [stepped] = await Promise.all([a.step(), a.say("Q2", "steer")]);
    check(stepped.wakeInMs !== null && !o.host.open, `step: ${show(stepped)}, open ${o.host.open}`);
    if (activeTimers) check(activeTimers() === 0, `live timers after the park: ${activeTimers()}`);
    const rows = jobs(storage);
    check(o.polls.filter((p) => p.id === first!.id).length === 1, `fetches of the first job: ${show(o.polls)}`);
    check(rows.length === 2, `jobs ${rows.length}: the steer should be one more call`);
    await consume(a, rows[1]!.id, "A2");
    check((await a.step()).wakeInMs === null, "did not finish");
    check(o.polls.length === 2, `fetches ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1", "user: Q2", "assistant(stop): A2"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("turn", "a message whose harness closes as it is admitted is submitted once", async (storage) => {
    // The interleaving, pinned: the moment the submission's row is written, the harness starts to close
    // (what a park does). The admitted commit completes, so the input is durable — and the harness is
    // closed before `say` reads the submission back, which is when a retry would submit it again.
    let host: PdHost | undefined;
    let armed = false;
    let closes = 0;
    const closing: DurableSqlHost = {
      ...storage,
      sql: { exec: (q, ...b) => {
        if (armed && /INSERT INTO pd_submissions/i.test(q)) { armed = false; closes++; queueMicrotask(() => { void host!.close(); }); }
        return storage.sql.exec(q, ...b);
      } },
      transactionSync: (c) => storage.transactionSync(c),
    };
    const o = object(closing);
    host = o.host;
    const a = o.agent();
    armed = true;
    await a.say("Q1");
    check(closes === 1, `control: the close was ${closes === 0 ? "never triggered" : "triggered more than once"}`);
    // Run the conversation to rest, answering every call it makes.
    for (let i = 0; i < 6; i++) {
      const out = await a.step();
      if (out.wakeInMs === null) break;
      for (const row of jobs(storage).filter((r) => r.answer === null)) await consume(a, row.id, "A");
    }
    const t = turns(await a.entries({}));
    check(show(t) === show(["user: Q1", "assistant(stop): A"]), `transcript ${show(t)}`);
    await a.close();
  });

  add("turn", "a step whose pass failed does not stick: the next step runs a fresh pass and completes the turn", async (storage) => {
    // The sweep's read fails once, so the first pass rejects before it opens a harness.
    let failNext = false;
    const flaky: DurableSqlHost = {
      ...storage,
      sql: { exec: (q, ...b) => {
        if (failNext && q.includes("dispatched_at IS NULL OR")) { failNext = false; throw new Error("injected: the sweep's read failed"); }
        return storage.sql.exec(q, ...b);
      } },
      transactionSync: (c) => storage.transactionSync(c),
    };
    const o = object(flaky);
    const a = o.agent();
    await a.say("Q1");
    await a.close();
    failNext = true;
    let thrown: unknown;
    try { await a.step(); } catch (e) { thrown = e; }
    check(thrown instanceof Error && thrown.message.includes("injected"), `the first step should fail: ${String(thrown)}`);
    // Not the old rejected promise: a fresh pass, which resumes the generation and parks.
    const parked = await a.step().catch((e: unknown) => {
      throw new Error(`the step after a failed one was handed the old rejection instead of a fresh pass: ${String(e)}`);
    });
    check(parked.wakeInMs !== null, `the step after a failed one: ${show(parked)}`);
    const [row] = jobs(storage);
    check(row, "no job after the fresh pass");
    await consume(a, row.id, "A1");
    check((await a.step()).wakeInMs === null, "did not finish");
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("turn", "with no answer every poll waits the same interval, no doubling: one fetch per wake, one job", async (storage) => {
    const o = object(storage, [], { pollAfterMs: 300 });
    const a = o.agent();
    await a.say("Q1");
    let out = await a.step();
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      check(out.wakeInMs !== null, `wake ${i}: ${show(out)}`);
      await sleep(out.wakeInMs);
      const before = o.polls.length;
      out = await a.step();
      check(o.polls.length - before === 1, `wake ${i}: ${o.polls.length - before} fetches`);
      check(out.wakeInMs !== null, `wake ${i} did not park: ${show(out)}`);
      waits.push(out.wakeInMs);
    }
    // Read with slack for the time a step takes.
    check(waits.every((w) => w <= 300 && w > 50), `waits ${show(waits)}`);
    check(jobs(storage).length === 1, `a not-ready poll started a new call: ${jobs(storage).length} jobs`);
    await a.close();
  });

  // ---- the delivery wakes the task waiting for it (the poll interval is only the backstop) -------------------------

  add("wake", "an answer while the harness is open and the generation sleeps: the delivery wakes it, and the answer is in at once, with no step", async (storage) => {
    const o = object(storage);
    const a = o.agent();
    await a.say("Q1");
    await untilPolling(o.host);
    const [row] = jobs(storage);
    check(row && o.host.open, "control: the harness is not open with a job out");
    const t0 = Date.now();
    await consume(a, row.id, "A1");
    const ms = await untilAnswer(a, "A1", t0);
    check(ms < 1_000, `the answer took ${ms} ms to reach the transcript (the poll is ${POLL_MS} ms away)`);
    check(show(o.polls) === show([{ id: row.id, ready: true }]), `polls ${show(o.polls)}`);
    const done = await a.step();
    check(done.wakeInMs === null && done.open === 0, `after the answer: ${show(done)}`);
    await a.close();
  });

  add("wake", `an answer while parked: the object's next step wakes the generation, which does not wait for its pollAt${activeTimers ? ", and nothing is left running" : ""}`, async (storage) => {
    const o = object(storage);
    const a = o.agent();
    await a.say("Q1");
    const parked = await a.step();
    check(parked.wakeInMs !== null && parked.wakeInMs > POLL_MS / 2 && !o.host.open, `control: not parked for the poll: ${show(parked)}`);
    const [row] = jobs(storage);
    const t0 = Date.now();
    await consume(a, row!.id, "A1");
    const done = await a.step();
    const ms = Date.now() - t0;
    check(done.wakeInMs === null && done.open === 0, `the step after the answer: ${show(done)}`);
    check(ms < 1_000, `deliver to the answer took ${ms} ms`);
    check(show(o.polls) === show([{ id: row!.id, ready: true }]), `polls ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    if (activeTimers) check(activeTimers() === 0, `live timers after the turn: ${activeTimers()}`);
    await a.close();
  });

  add("wake", "a wake with no answer is harmless: one more fetch, not ready, a new pollAt committed; the answer then completes the turn", async (storage) => {
    const o = object(storage);
    const a = o.agent();
    await a.say("Q1");
    await untilPolling(o.host);
    const pollAt = () => o.host.withHarness(async (h) => {
      const t = (await h.inspect(BACKGROUND)).tasks.find((x) => (x.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase === "poll");
      return { id: t?.record.id, at: (t?.record.state as { checkpoint?: { pollAt?: number } } | undefined)?.checkpoint?.pollAt };
    });
    const before = await pollAt();
    check(before.id !== undefined && before.at !== undefined, `control: no poll checkpoint ${show(before)}`);
    await o.host.withHarness(async (h) => { h.wake([before.id!]); });
    let after = before;
    for (let i = 0; i < 200 && (after.at === before.at || o.polls.length === 0); i++) { await sleep(5); after = await pollAt(); }
    const [row] = jobs(storage);
    check(show(o.polls) === show([{ id: row!.id, ready: false }]), `the early wake's fetches: ${show(o.polls)}`);
    check(after.id === before.id && after.at! > before.at!, `pollAt ${before.at} -> ${after.at}`);
    check(jobs(storage).length === 1 && o.dispatched.length === 1, "the early wake called the model again");
    const t0 = Date.now();
    await consume(a, row!.id, "A1");
    check(await untilAnswer(a, "A1", t0) < 1_000, "the answer after the early wake was slow");
    check(show(o.polls.map((p) => p.ready)) === show([false, true]), `polls ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("wake", "a lost wake (none asked): the step after the answer parks for the poll, and the poll at the backstop completes the turn", async (storage) => {
    const o = object(storage, [], { noWake: true, pollAfterMs: 400 });
    const a = o.agent();
    await a.say("Q1");
    const parked = await a.step();
    check(parked.wakeInMs !== null, `control: not parked ${show(parked)}`);
    const [row] = jobs(storage);
    await consume(a, row!.id, "A1");
    const early = await a.step();
    check(early.wakeInMs !== null && o.polls.length === 0, `with no wake the step should park for the poll: ${show(early)}, polls ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1"]), "control: the answer arrived with no wake");
    await sleep(early.wakeInMs);
    const done = await a.step();
    check(done.wakeInMs === null, `the backstop's step did not finish: ${show(done)}`);
    check(show(o.polls) === show([{ id: row!.id, ready: true }]), `polls ${show(o.polls)}`);
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("wake", "a cancel as the delivery wakes the generation: the turn ends once, nothing runs on, and the next turn works", async (storage) => {
    const o = object(storage);
    const a = o.agent();
    await a.say("Q1");
    await untilPolling(o.host);
    const [row] = jobs(storage);
    const job = await a.takeJob(row!.id) as { model: { api: string; provider: string; id: string } };
    // Not awaited: the cancel lands while the woken generation fetches and classifies.
    const delivered = a.deliver(row!.id, fromResponse(reply("A1"), job.model, row!.id));
    const cancelled = await a.cancel("ap.turn_cancelled");
    await delivered;
    const idle = await a.step();
    check(idle.wakeInMs === null && idle.open === 0 && !(await a.running()), `after the cancel: ${show(idle)}`);
    if (activeTimers) check(activeTimers() === 0, `live timers after the cancel: ${activeTimers()}`);
    const t = turns((await a.entries({})).filter((e) => e.type === "message"));
    const answered = t.includes("assistant(stop): A1");
    // Either the answer was classified before the abort mark (the cancel then found the turn done) or not (cancelled).
    check(answered ? cancelled === null : typeof cancelled === "string", `answer in ${answered}, cancel said ${show(cancelled)}: ${show(t)}`);
    check(t.filter((x) => x.startsWith("assistant")).length <= 1, `answered twice: ${show(t)}`);
    await a.say("Q2");
    const parked = await a.step();
    check(parked.wakeInMs !== null, `the next turn: ${show(parked)}`);
    const next = jobs(storage).filter((r) => r.answer === null);
    check(next.length === 1, `jobs out ${show(next.map((r) => r.id))}`);
    await consume(a, next[0]!.id, "A2");
    check((await a.step()).wakeInMs === null, "the next turn did not finish");
    const after = turns((await a.entries({})).filter((e) => e.type === "message"));
    check(after.at(-1) === "assistant(stop): A2", `entries ${show(after)}`);
    await a.close();
  });

  for (const order of ["together", "deliver then step"] as const) add("wake", `a retryable error answer, delivered ${order === "together" ? "with" : "then"} the object's step: the retry keeps its backoff (no wake left over for it)`, async (storage) => {
    {
      const o = object(storage);
      const a = o.agent();
      await a.say(`Q ${order}`);
      await untilPolling(o.host);
      const [row] = jobs(storage).filter((r) => r.answer === null);
      const job = await a.takeJob(row!.id) as { model: { api: string; provider: string; id: string } };
      const err = { ...errorMessage("429 rate limit exceeded", job.model as never), jobId: row!.id };
      const before = o.dispatched.length;
      const t0 = Date.now();
      // What AgentDO does: deliver, then the step it asks for at once.
      const out = order === "together"
        ? (await Promise.all([a.deliver(row!.id, err as never), a.step()]))[1]
        : (await a.deliver(row!.id, err as never), await a.step());
      await sleep(100);
      check(o.dispatched.length === before, `${order}: the retry was dispatched ${Date.now() - t0} ms after the error, inside its backoff`);
      check(out.wakeInMs !== null && out.wakeInMs > 1_000, `${order}: the step did not park for the backoff: ${show(out)}`);
      await sleep(out.wakeInMs);
      await a.step();
      check(o.dispatched.length === before + 1, `${order}: the retry was not dispatched after its backoff (${o.dispatched.length - before})`);
      await a.close();
    }
  });

  add("wake", "an answer delivered while the poll is fetching (not sleeping, so not woken) is found when the poll's next sleep starts", async (storage) => {
    let onFetch: (() => void) | null = null;
    const polls: Array<{ id: string; ready: boolean }> = [];
    const o = object(storage, polls, { onPoll: (id, ready) => { polls.push({ id, ready }); const f = onFetch; onFetch = null; f?.(); } });
    const a = o.agent();
    await a.say("Q1");
    await untilPolling(o.host);
    const [row] = jobs(storage);
    const job = await a.takeJob(row!.id) as { model: { api: string; provider: string; id: string } };
    let t0 = 0;
    // The answer lands right after the fetch read the row and found nothing: the poll is not asleep.
    onFetch = () => { t0 = Date.now(); void a.deliver(row!.id, fromResponse(reply("A1"), job.model, row!.id)); };
    const id = await o.host.withHarness(async (h) => (await h.inspect(BACKGROUND)).tasks[0]!.record.id);
    await o.host.withHarness(async (h) => { h.wake([id]); });
    const ms = await untilAnswer(a, "A1", 0).then(() => Date.now() - t0);
    check(ms < 1_000, `the answer took ${ms} ms (the poll is ${POLL_MS} ms away)`);
    check(show(polls.map((p) => p.ready)) === show([false, true]), `polls ${show(polls)}`);
    await a.close();
  });

  add("jobs", "a lost dispatch is resent within the redelivery interval while parked, not at the poll backstop", async (storage) => {
    const o = object(storage, [], { pollAfterMs: POLL_BACKSTOP_MS, redeliveryMs: 400 });
    let fail = true;
    const sent: string[] = [];
    const a = o.agent(undefined, { dispatch: async (id) => { if (fail) { fail = false; throw new Error("queue down"); } sent.push(id); } });
    await a.say("Q1");
    const parked = await a.step();
    check(sent.length as number === 0 && jobs(storage).length === 1, `control: the dispatch was not lost: ${show(jobs(storage))} / sent ${show(sent)}`);
    check(parked.wakeInMs !== null && parked.wakeInMs <= 400, `parked for ${parked.wakeInMs} ms, past the redelivery`);
    await sleep(parked.wakeInMs);
    const again = await a.step();
    check(sent.length === 1, `not resent: ${show(jobs(storage))}`);
    // Dispatched now: the park comes back at its redelivery, still before the backstop.
    check(again.wakeInMs !== null && again.wakeInMs <= 400 && again.wakeInMs > 200, `after the resend: ${show(again)}`);
    await a.close();
  });

  add("jobs", "a message and the wake it asks for, while the dispatch is in flight: one queue send, and a second taker is refused while the first holds the job", async (storage) => {
    const o = object(storage, [], { redeliveryMs: 600, takeHoldMs: 1_200 });
    // The commit's dispatch is held open, as a queue send that has not returned: the window the wake's sweep ran in.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sent: string[] = [];
    const a = o.agent(undefined, { dispatch: async (id) => { sent.push(id); if (sent.length === 1) await held; } });
    await a.say("Q1");
    for (let i = 0; i < 400 && sent.length === 0; i++) await sleep(5);
    check(sent.length === 1 && jobs(storage).length === 1, `control: the dispatch is not in flight: sent ${show(sent)}, jobs ${show(jobs(storage))}`);
    const parked = await a.step();
    check(parked.wakeInMs !== null, `step: ${show(parked)}`);
    release();
    await sleep(20);
    const id = jobs(storage)[0]!.id;
    check(show(sent) === show([id]), `queue sends ${show(sent)}: the wake's sweep sent a job whose dispatch was in flight`);
    // Two attempts for it anyway (a queue that delivered twice): one model call.
    const [first, second] = [await a.takeJob(id, "try-1"), await a.takeJob(id, "try-2")];
    check(first !== null && second === null, `takes: try-1 ${first === null ? "refused" : "granted"}, try-2 ${second === null ? "refused" : "granted"}`);
    // The holder's own name is no key: only a release ends a take, and only the holder's.
    check(await a.takeJob(id, "try-1") === null, "the holder's name took the job again while it held it");
    check(await a.releaseJob(id, "try-2") === false && await a.takeJob(id, "try-3") === null, "a non-holder released the take");
    check(await a.releaseJob(id, "try-1") === true, "the holder's release did nothing");
    check(await a.takeJob(id, "try-3") !== null, "a taker after the release was refused");
    // A holder that died: its take lapses after the hold, and the next taker is granted.
    await sleep(1_250);
    check(await a.takeJob(id, "try-4") !== null, "a taker after the hold was refused");
    check(await a.takeJob(id, "try-3") === null, "a second taker within the new take's hold was granted");
    // Without a taker the request is only read.
    check(await a.takeJob(id) !== null, "a read without a taker was refused");
    await a.close();
  });

  add("jobs", "a model call longer than the redelivery interval: the sweep does not send the job again and no second taker is granted; once the hold lapses it is sent and taken", async (storage) => {
    const RED = 300, HOLD = 1_500;
    const o = object(storage, [], { redeliveryMs: RED, takeHoldMs: HOLD });
    const sent: string[] = [];
    const a = o.agent(undefined, { dispatch: async (id) => { sent.push(id); } });
    await a.say("Q1");
    for (let i = 0; i < 400 && sent.length === 0; i++) await sleep(5);
    const parked = await a.step();
    const id = sent[0]!;
    check(await a.takeJob(id, "try-1") !== null, "the first taker was refused");
    const takenAt = Date.now();
    // The model call runs on past the redelivery the object parked for.
    check(parked.wakeInMs !== null && parked.wakeInMs <= RED, `parked for ${show(parked)}`);
    await sleep(RED + 50);
    const during = await a.step();
    check(show(sent) === show([id]), `sends while the call runs: ${show(sent)}`);
    check(await a.takeJob(id, "try-2") === null, "a second taker was granted while the first one's call runs");
    // Parked for the end of the hold: not at once (a busy loop), not past it (a dead taker never recovered).
    const holdLeft = takenAt + HOLD - Date.now();
    check(during.wakeInMs !== null && during.wakeInMs <= holdLeft + 50 && during.wakeInMs >= holdLeft - 300,
      `parked for ${show(during)} with ${holdLeft} ms of the hold left`);
    // The taker died without releasing: at the end of the hold the job is sent again and taken.
    await sleep(during.wakeInMs);
    const after = await a.step();
    check(show(sent) === show([id, id]), `sends after the hold: ${show(sent)}`);
    check(await a.takeJob(id, "try-3") !== null, "the taker after the hold was refused");
    check(after.wakeInMs !== null && after.wakeInMs > 0, `after the resend: ${show(after)}`);
    await a.close();
  });

  add("jobs", "the consumer: a failed call gives its take back, so the retry takes the job; another attempt during a call is refused; a give-up does not answer a job a live call holds", async (storage) => {
    const o = object(storage, [], { redeliveryMs: 600 });
    const sent: string[] = [];
    const a = o.agent(undefined, { dispatch: async (id) => { sent.push(id); } });
    await a.say("Q1");
    for (let i = 0; i < 400 && sent.length === 0; i++) await sleep(5);
    await a.step();
    const id = sent[0]!;
    const stub: ModelJobStub = {
      takeJob: (_t, _a, j, taker) => replyingUnknownJob(() => a.takeJob(j, taker)),
      releaseJob: (_t, _a, j, taker) => replyingUnknownJob(() => a.releaseJob(j, taker)),
      deliverAnswer: (_t, _a, j, answer) => replyingUnknownJob(() => a.deliver(j, answer as Parameters<DurableAgent["deliver"]>[1])),
    };
    const calls: string[] = [];
    let behaviour: "fail" | "hold" | "answer" = "fail";
    let unhold!: () => void;
    const deps: ModelQueueDeps = {
      stub: () => stub,
      async call(job, m) {
        calls.push(behaviour);
        if (behaviour === "fail") throw new Error("provider 503");
        if (behaviour === "hold") await new Promise<void>((resolve) => { unhold = resolve; });
        return fromResponse(reply("A1"), (job as { model: { api: string; provider: string; id: string } }).model, m.jobId);
      },
      givenUp: (m) => ({ ...errorMessage("given up", { api: "x", provider: "queue", id: "m1" }), jobId: m.jobId }),
    };
    const message = () => {
      const m = { acked: 0, retried: 0 };
      return { m, msg: { body: { doId: "d", tenantId: "t", agentId: "a", jobId: id }, ack() { m.acked++; }, retry() { m.retried++; } } };
    };
    const err = console.error; console.error = () => {};
    try {
      const one = message();
      await consumeModelCalls({ queue: "model-calls", messages: [one.msg] }, deps);
      check(one.m.retried === 1 && show(calls) === show(["fail"]), `the failing attempt: ${show(one.m)} calls ${show(calls)}`);
      // The retry: whatever id the queue gives it, it takes the job and calls the model.
      behaviour = "hold";
      const two = message();
      const running = consumeModelCalls({ queue: "model-calls", messages: [two.msg] }, deps);
      for (let i = 0; i < 400 && calls.length < 2; i++) await sleep(5);
      check(show(calls) === show(["fail", "hold"]), `the retry after a failed call was refused: calls ${show(calls)}`);
      // While it calls: a duplicate is acked without a call, and the dead letter queue's give-up answers nothing.
      const dup = message(), dead = message();
      await consumeModelCalls({ queue: "model-calls", messages: [dup.msg] }, deps);
      await consumeModelCalls({ queue: "model-calls-dlq", messages: [dead.msg] }, deps);
      check(dup.m.acked === 1 && dead.m.acked === 1 && calls.length === 2, `during the call: dup ${show(dup.m)} dead ${show(dead.m)} calls ${show(calls)}`);
      check(jobs(storage)[0]!.answer === null, `the give-up answered a job a live call holds: ${jobs(storage)[0]!.answer}`);
      unhold();
      await running;
      check(two.m.acked === 1 && JSON.stringify(JSON.parse(jobs(storage)[0]!.answer!)).includes("A1"), `the live call's answer: ${jobs(storage)[0]!.answer}`);
    } finally { console.error = err; }
    await a.close();
  });

  add("jobs", "the consumer: the dead letter queue's give-up answers a job no live call holds", async (storage) => {
    const o = object(storage, [], { redeliveryMs: 600 });
    const sent: string[] = [];
    const a = o.agent(undefined, { dispatch: async (id) => { sent.push(id); } });
    await a.say("Q1");
    for (let i = 0; i < 400 && sent.length === 0; i++) await sleep(5);
    await a.step();
    const id = sent[0]!;
    const stub: ModelJobStub = {
      takeJob: (_t, _a, j, taker) => replyingUnknownJob(() => a.takeJob(j, taker)),
      releaseJob: (_t, _a, j, taker) => replyingUnknownJob(() => a.releaseJob(j, taker)),
      deliverAnswer: (_t, _a, j, answer) => replyingUnknownJob(() => a.deliver(j, answer as Parameters<DurableAgent["deliver"]>[1])),
    };
    const deps: ModelQueueDeps = {
      stub: () => stub,
      async call() { throw new Error("no model call on the dead letter queue"); },
      givenUp: (m) => ({ ...errorMessage("given up", { api: "x", provider: "queue", id: "m1" }), jobId: m.jobId }),
    };
    let acked = 0;
    await consumeModelCalls({ queue: "model-calls-dlq", messages: [{ body: { doId: "d", tenantId: "t", agentId: "a", jobId: id }, ack() { acked++; }, retry() {} }] }, deps);
    check(acked === 1 && String(jobs(storage)[0]!.answer).includes("given up"), `give-up: acked ${acked}, answer ${jobs(storage)[0]!.answer}`);
    await a.close();
  });

  add("jobs", "the default park while a job is out is its redelivery, 2 min, not the 5 min backstop", async (storage) => {
    const o = object(storage, [], { pollAfterMs: POLL_BACKSTOP_MS });
    const a = o.agent();
    await a.say("Q1");
    const parked = await a.step();
    check(parked.wakeInMs !== null && parked.wakeInMs <= 120_000 && parked.wakeInMs > 110_000, `parked ${show(parked)}`);
    await a.close();
  });

  add("jobs", "an unknown job id is UnknownJob on take and on deliver, and the RPC wrapper answers it by shape", async (storage) => {
    const a = object(storage).agent();
    for (const [what, call] of [
      ["takeJob", () => a.takeJob("mj_nope")],
      ["deliver", () => a.deliver("mj_nope", fromResponse(reply("x"), { api: "x", provider: "queue", id: "m1" }, "mj_nope"))],
    ] as const) {
      let thrown: unknown;
      try { await call(); } catch (e) { thrown = e; }
      check(thrown instanceof UnknownJob && thrown.jobId === "mj_nope", `${what}: ${String(thrown)}`);
      check(show(await replyingUnknownJob(call)) === show({ unknownJob: "mj_nope" }), `${what} through replyingUnknownJob`);
    }
    check(jobs(storage).length === 0, "an unknown id wrote a row");
  });

  add("jobs", "the default poll interval is the lost-wake backstop, 5 min, the same after every not-ready poll", async () => {
    const models = createModels();
    models.setProvider(durableOffloadedProvider({
      port: { async start() { return "mj_1"; }, async poll() { return null; } },
      id: "queue", pollAfterMs: POLL_BACKSTOP_MS, models: [{ id: "m1", contextWindow: 1_000 }],
    }));
    const model = models.getModel("queue", "m1");
    check(model, "model not registered");
    const first = await models.stream(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, { deferred: true }).result();
    let handle = first.deferred;
    const seen = [handle?.pollAfterMs];
    for (let i = 0; i < 5 && handle; i++) {
      handle = (await models.fetchDeferred(model, handle)).deferred;
      seen.push(handle?.pollAfterMs);
    }
    check(POLL_BACKSTOP_MS === 300_000 && show(seen) === show(Array(6).fill(300_000)), `intervals ${show(seen)}`);
  });

  add("engine", "the host serves one agent: a second agent on the same object is refused", async (storage) => {
    const o = object(storage);
    o.agent();
    let thrown: unknown;
    try { o.agent(undefined, { agentId: "other" }); } catch (e) { thrown = e; }
    check(thrown instanceof Error && thrown.message.includes("one agent per object"), `second agent: ${String(thrown)}`);
  });

  add("engine", "compact with nothing to compact: an operation that ends with no model job and no entry (test/pd-compaction.ts has the rest)", async (storage) => {
    const a = object(storage).agent();
    const started = await a.compact();
    check(typeof started.operationId === "string", `compact returned ${show(started)}`);
    const out = await a.step();
    check(out.wakeInMs === null, `step ${show(out)}`);
    const jobs = storage.sql.exec("SELECT COUNT(*) AS n FROM ap_model_jobs").toArray()[0]?.n;
    check(Number(jobs) === 0, `model jobs ${String(jobs)}`);
    check((await a.entries({})).every((e) => e.type !== "compaction"), "a compaction entry was written");
    // Cancel and client calls are step 8's (test/pd-cancel.ts); with nothing recorded, resuming finds nothing to do.
    check(await a.resumeClientCalls() === false, "resumeClientCalls must be false with no client call: runtime.step calls it every pass");
  });

  return cases;
}
