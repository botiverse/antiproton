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
import { fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { DEFAULT_POLL, DurableAgent, PdHost, type DurableAgentOptions } from "../../src/runtime/durable-agent.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { createModels } from "pi-ai-1/models";
import { replyingUnknownJob, UnknownJob } from "../../cf/src/model-queue.ts";
import type { DriveCase, TimerProbe, WithDriveHost } from "./durable-drive-spec.ts";

const POLL = { firstMs: 300, maxMs: 1_200 };
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
function object(storage: DurableSqlHost, polls: Array<{ id: string; ready: boolean }> = []) {
  const dispatched: string[] = [];
  const host = new PdHost({
    storage, poll: POLL, minParkMs: 1, stepDeadlineMs: STEP_DEADLINE_MS, onPoll: (id, ready) => polls.push({ id, ready }),
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
    const parked = await a.step();
    check(parked.wakeInMs !== null && parked.wakeInMs > 0 && parked.wakeInMs <= POLL.firstMs && parked.open === 1, `step: ${show(parked)}`);
    check(!o.host.open, "the harness is still open after a park");
    if (activeTimers) check(activeTimers() === 0, `live timers after the park: ${activeTimers()}`);
    const rows = jobs(storage);
    check(rows.length === 1 && rows[0]!.answer === null && rows[0]!.dispatched_at !== null, `jobs ${show(rows)}`);
    check(show(o.dispatched) === show([rows[0]!.id]), `dispatched ${show(o.dispatched)}`);
    // Also what pins PdHost passing no `onSleep`: the poll sleep must be seen by the read its checkpoint's commit
    // brings. Seen only at settle's 1 s recheck, the 300 ms sleep would be over and the job fetched before the park.
    check(o.polls.length === 0, `polled before the park ended (the park waited for settle's recheck?): ${show(o.polls)}`);
    const id = rows[0]!.id;
    const asked = await consume(a, id, "Paris");
    check(asked.some((m) => m.role === "user" && m.content === "Capital of France?") && asked.some((m) => m.role === "system" && m.content.includes("terse test assistant")),
      `the model was asked ${show(asked)}`);
    check(await a.takeJob(id) === null, "an answered job was handed out again");
    check(await a.deliver(id, fromResponse(reply("again"), { api: "x", provider: "queue", id: "m1" }, id)) === false, "a second answer was accepted");
    await sleep(parked.wakeInMs);
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

  add("turn", "close mid-poll, reopen as a new object: the turn completes with one job and exactly one fetch", async (storage) => {
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
    const parked = await b.step();
    check(parked.wakeInMs !== null && polls.length === 0, `reopened before pollAt: ${show(parked)}, polls ${show(polls)}`);
    await sleep(parked.wakeInMs);
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
    await sleep(x.wakeInMs);
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
    await sleep(parked.wakeInMs);
    // The step's pass is in flight — its poll is due — when the message arrives. A second harness
    // opened for the message would be a second scheduler running the same poll.
    const [stepped] = await Promise.all([a.step(), a.say("Q2", "steer")]);
    check(stepped.wakeInMs !== null && !o.host.open, `step: ${show(stepped)}, open ${o.host.open}`);
    if (activeTimers) check(activeTimers() === 0, `live timers after the park: ${activeTimers()}`);
    const rows = jobs(storage);
    check(o.polls.filter((p) => p.id === first!.id).length === 1, `fetches of the first job: ${show(o.polls)}`);
    check(rows.length === 2, `jobs ${rows.length}: the steer should be one more call`);
    await consume(a, rows[1]!.id, "A2");
    await sleep(stepped.wakeInMs);
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
      await sleep(out.wakeInMs);
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
    await sleep(parked.wakeInMs);
    check((await a.step()).wakeInMs === null, "did not finish");
    check(show(turns(await a.entries({}))) === show(["user: Q1", "assistant(stop): A1"]), `entries ${show(turns(await a.entries({})))}`);
    await a.close();
  });

  add("turn", "with no answer the poll interval doubles to its cap, one fetch per wake, one job", async (storage) => {
    const o = object(storage);
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
    // 600, 1200, then the cap: read with slack for the time a step takes.
    const near = (got: number, want: number) => got <= want && got > want - 250;
    check(near(waits[0]!, 600) && near(waits[1]!, 1_200) && near(waits[2]!, 1_200), `waits ${show(waits)}`);
    check(jobs(storage).length === 1, `a not-ready poll started a new call: ${jobs(storage).length} jobs`);
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

  add("jobs", "the default poll interval: 2 s, doubling per not-ready poll, capped at 30 s", async () => {
    const models = createModels();
    models.setProvider(durableOffloadedProvider({
      port: { async start() { return "mj_1"; }, async poll() { return null; } },
      id: "queue", pollAfterMs: DEFAULT_POLL.firstMs, maxPollAfterMs: DEFAULT_POLL.maxMs, models: [{ id: "m1", contextWindow: 1_000 }],
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
    check(show(seen) === show([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]), `intervals ${show(seen)}`);
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
