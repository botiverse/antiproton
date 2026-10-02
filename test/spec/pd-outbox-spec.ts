/**
 * What the `pd` engine writes inside pi-durable's own commit (src/runtime/pd-outbox.ts, the vendored
 * storage's commit hook): usage and trace outbox rows, and `ap_model_jobs` rows. Run over node:sqlite by
 * test/pd-outbox.ts and on a real Durable Object's storage by cf/src/conformance.ts (test/pd-outbox-do.sh).
 *
 * The parity case runs one scripted conversation through both engines on the same storage — pd first,
 * its rows read and the outboxes emptied, then PiAgent (pi085), which writes its rows inside
 * `Storage.commit` (src/store/pi-storage.ts) — and compares the rows field for field, leaving out only
 * what names an instance (seq, span id) or an instant (at, ms, whose presence is still compared). The
 * worker is the real conversion in both directions (`toRequest` / `fromResponse`); only the model is
 * faked. A "new object" is a new `PdHost` on the same storage: what an eviction leaves. A "crash" is a
 * host whose every commit from some point on fails (`commitFault`), so nothing after it is durable, and
 * which is then dropped.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { AssistantEntry, UsageDoc, type ConversationId, type StorageWrite } from "@earendil-works/pi-durable";
import { errorMessage, fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import type { Booked } from "../../src/runtime/pd-outbox.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import { statusEvents } from "../../src/runtime/status.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { pendingTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";
import { pendingUsage, type OutboxRow } from "../../src/usage/outbox.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";

const POLL = { firstMs: 200, maxMs: 800 };
const MODEL = { provider: "queue", id: "m1", contextWindow: 100_000 };
const OWNER = { tenantId: "t", agentId: "a" };
const PROMPT = "You are a terse test assistant.";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const usageOf = (input: number, output: number, reasoning: number, cached: number) =>
  ({ promptTokens: input, completionTokens: output, reasoningTokens: reasoning, cachedPromptTokens: cached });

/**
 * The conversation both engines are given: an answer with every billed counter, a reply cut off before
 * it said anything (an `error`, not retried: its message is not a transient one), and one cut off after
 * it said something (`length`).
 */
const SCRIPT: Array<{ say: string; reply: ModelResponse }> = [
  { say: "Q1", reply: { text: "A1", finishReason: "stop", truncated: false, usage: usageOf(120, 30, 7, 40) } },
  { say: "Q2", reply: { text: "", finishReason: "length", truncated: true, usage: usageOf(200, 50, 50, 0) } },
  { say: "Q3", reply: { text: "A3, cut", finishReason: "length", truncated: true, usage: usageOf(90, 10, 0, 20) } },
];

/** What the script must produce, per answer in order: its usage rows, and the trace row's status and verdict. */
const EXPECTED_USAGE = [
  ["m1:input", 120], ["m1:output", 30], ["m1:cache_read", 40], ["m1:reasoning", 7],
  ["m1:input", 200], ["m1:output", 50], ["m1:reasoning", 50],
  ["m1:input", 90], ["m1:output", 10], ["m1:cache_read", 20],
];
const EXPECTED_TRACE = [["stop", "ok"], ["error", "failed"], ["length", "ok"]];
const Q1_USAGE = EXPECTED_USAGE.slice(0, 4);

type Jobs = Array<{ id: string; answer: string | null; created_at: number; answered_at: number | null; dispatched_at: number | null; state: string | null; conversation_id: number | null }>;
const pdJobs = (storage: DurableSqlHost): Jobs => {
  if (storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'ap_model_jobs'").toArray().length === 0) return [];
  return storage.sql.exec("SELECT id, answer, created_at, answered_at, dispatched_at, state, conversation_id FROM ap_model_jobs ORDER BY created_at, rowid").toArray() as unknown as Jobs;
};

type Fault = (writes: readonly StorageWrite[]) => void;
function pdObject(storage: DurableSqlHost, extra: { commitFault?: Fault; dispatch?: (id: string) => Promise<void> } = {}) {
  const dispatched: string[] = [];
  const booked: Booked[] = [];
  const host = new PdHost({
    storage, poll: POLL, minParkMs: 1, onBooked: (b) => booked.push(b),
    ...(extra.commitFault ? { commitFault: extra.commitFault } : {}),
  });
  const agent = DurableAgent.open({
    host, ...OWNER, model: MODEL, systemPrompt: PROMPT,
    dispatch: async (id) => { dispatched.push(id); await extra.dispatch?.(id); },
    unknownJob: (id) => new UnknownJob(id),
  });
  return { host, agent, dispatched, booked };
}

/** The worker: the real conversion of the request, then the answer `answer` builds for this job. */
async function consume(agent: DurableAgent, id: string, answer: (model: { api: string; provider: string; id: string }, id: string) => AnsweredMessage) {
  const job = await agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
  check(job, `job ${id} was not handed out`);
  toRequest(job.context);
  check(await agent.deliver(id, answer({ api: job.model.api, provider: job.model.provider, id: job.model.id }, id)) === true, `deliver of ${id} was refused`);
}
const replying = (res: ModelResponse) => (model: { api: string; provider: string; id: string }, id: string) => fromResponse(res, model, id);
const MODEL_REF = { api: "offloaded", provider: MODEL.provider, id: MODEL.id };

/** Step until the turn is over, answering each job as it appears with the next of `answers`. */
async function pdTurn(storage: DurableSqlHost, agent: DurableAgent, say: string | null, answers: Array<ReturnType<typeof replying>>) {
  if (say !== null) await agent.say(say);
  let out = await agent.step();
  for (let guard = 0; out.wakeInMs !== null; guard++) {
    check(guard < 50, `the turn "${say}" did not end: ${show(out)}`);
    const open = pdJobs(storage).find((j) => j.answer === null && j.state === null);
    if (open) {
      const next = answers.shift();
      check(next, `the turn "${say}" asked for more answers than scripted`);
      await consume(agent, open.id, next);
    }
    await sleep(out.wakeInMs);
    out = await agent.step();
  }
  check(answers.length === 0, `the turn "${say}" left ${answers.length} answers unasked for`);
}

/** pi085 on the same storage: PiAgent with a usage owner, as cf/src/runtime.ts opens it. */
async function runPi085(storage: DurableSqlHost) {
  const agent = await PiAgent.open({
    host: storage as never, sessionId: "s", systemPrompt: PROMPT, model: MODEL, tools: [],
    toolHost: { async invoke() { throw new Error("no tool is offered"); } } as never,
    usageOwner: OWNER, dispatch: async () => {},
  });
  for (const turn of SCRIPT) {
    await agent.say(turn.say);
    let out = await agent.step();
    for (let guard = 0; out.wakeInMs !== null || out.open > 0; guard++) {
      check(guard < 50, `pi085: the turn "${turn.say}" did not end: ${show(out)}`);
      const open = storage.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray()[0];
      if (open) {
        const id = String(open.id);
        check(agent.takeJob(id), `pi085: job ${id} was not handed out`);
        agent.deliver(id, fromResponse(turn.reply, MODEL_REF, id));
      }
      out = await agent.step();
    }
  }
  await agent.close();
}

const outboxes = (storage: DurableSqlHost) => ({
  usage: pendingUsage(storage.sql as never, 0),
  trace: pendingTrace(storage.sql as never, 0).rows,
});
const usagePairs = (storage: DurableSqlHost) => outboxes(storage).usage.map((r) => [r.key, r.quantity]);
/** A row without what names an instance or an instant. */
const usageShape = (r: OutboxRow) => ({ tenantId: r.tenantId, agentId: r.agentId, resource: r.resource, key: r.key, quantity: r.quantity, unit: r.unit });
const traceShape = (r: TraceOutboxRow) => ({
  tenantId: r.tenantId, agentId: r.agentId, kind: r.kind, status: r.status, verdict: r.verdict,
  parentId: r.parentId ?? null, hasMs: typeof r.ms === "number", attrs: r.attrs,
});
const transitions = (rows: readonly TraceOutboxRow[]) => statusEvents(OWNER.agentId, rows).map((e) => e.detail ? `${e.status}|${e.detail}` : e.status);

/** pi-durable's whole state, as a comparable value: what a rolled-back commit must leave exactly as it was. */
const pdState = (storage: DurableSqlHost) => show(["durable_metadata", "entries", "tasks", "documents", "document_revisions", "submissions", "conversations"].map((t) =>
  storage.sql.exec(`SELECT * FROM pd_${t} ORDER BY 1, 2`).toArray()));
const isPollBatch = (writes: readonly StorageWrite[]) =>
  writes.some((w) => w.type === "task" && (w.value.state as { checkpoint?: { phase?: unknown } }).checkpoint?.phase === "poll");
const hasAnswer = (writes: readonly StorageWrite[]) =>
  writes.some((w) => w.type === "entry" && w.value.kind === "pi.assistant");

/** A fault that, once `trigger` matches a batch, fails that commit and every later one: the object is dead from there. */
function dying(trigger: (writes: readonly StorageWrite[]) => boolean) {
  const state = { dead: false, fired: 0 };
  const fault: Fault = (writes) => {
    if (!state.dead && trigger(writes)) state.dead = true;
    if (state.dead) { state.fired++; throw new Error("the object died inside this commit"); }
  };
  return { state, fault };
}
/** Wait out whatever the dead host still has in flight: its commits all fail, so it stops by itself. */
async function drop(o: ReturnType<typeof pdObject>) {
  await o.agent.close().catch(() => {});
  await o.host.close().catch(() => {});
}

export function pdOutboxCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, body: (host: DurableSqlHost) => Promise<void>) =>
    cases.push({ group, name, run: () => withHost(body) });

  add("parity", "a scripted conversation (stop, error, length): exactly the expected usage and trace rows, the same as pi085 writes field for field, with the same status transitions", async (storage) => {
    const o = pdObject(storage);
    for (const turn of SCRIPT) await pdTurn(storage, o.agent, turn.say, [replying(turn.reply)]);
    const pd = outboxes(storage);
    const jobs = pdJobs(storage);
    check(jobs.length === SCRIPT.length, `pd made ${jobs.length} model calls for ${SCRIPT.length} turns`);
    check(jobs.every((j) => j.state === "consumed" && j.conversation_id !== null), `jobs ${show(jobs)}`);
    check(show(o.dispatched) === show(jobs.map((j) => j.id)), `dispatched ${show(o.dispatched)}, jobs ${show(jobs.map((j) => j.id))}`);
    check(show(pd.usage.map((r) => [r.key, r.quantity])) === show(EXPECTED_USAGE), `pd usage ${show(pd.usage.map((r) => [r.key, r.quantity]))}`);
    check(pd.usage.every((r) => r.tenantId === "t" && r.agentId === "a" && r.resource === "model.tokens" && r.unit === "tokens"), `pd usage ${show(pd.usage)}`);
    check(show(pd.trace.map((r) => [r.status, r.verdict])) === show(EXPECTED_TRACE), `pd trace ${show(pd.trace)}`);
    // Each span joins back to its job and measures the job's own instants; a row's `at` is its commit's.
    pd.trace.forEach((r, i) => {
      const job = jobs[i]!;
      check(r.kind === "model.call" && r.spanId === job.id && r.ms === job.answered_at! - job.created_at && r.at >= job.answered_at!, `pd trace row ${i} ${show(r)} for job ${show(job)}`);
    });
    await o.agent.close();

    storage.sql.exec("DELETE FROM usage_outbox");
    storage.sql.exec("DELETE FROM trace_outbox");
    await runPi085(storage);
    const pi = outboxes(storage);
    check(pi.usage.length > 0 && pi.trace.length > 0, `control: pi085 wrote ${pi.usage.length} usage and ${pi.trace.length} trace rows`);
    check(show(pd.usage.map(usageShape)) === show(pi.usage.map(usageShape)), `usage differs:\n pd    ${show(pd.usage.map(usageShape))}\n pi085 ${show(pi.usage.map(usageShape))}`);
    check(show(pd.trace.map(traceShape)) === show(pi.trace.map(traceShape)), `trace differs:\n pd    ${show(pd.trace.map(traceShape))}\n pi085 ${show(pi.trace.map(traceShape))}`);
    check(show(transitions(pd.trace)) === show(transitions(pi.trace)), `status differs: pd ${show(transitions(pd.trace))}, pi085 ${show(transitions(pi.trace))}`);
    check(show(transitions(pd.trace)) === show(["thinking", "online", "thinking", "error", "thinking", "online"]), `status ${show(transitions(pd.trace))}`);
  });

  add("parity", "a failed attempt pi-durable retries is billed and traced, each attempt once", async (storage) => {
    const o = pdObject(storage);
    const failed = (model: { api: string; provider: string; id: string }, id: string): AnsweredMessage => ({
      ...errorMessage("503 service unavailable", model), usage: { ...fromResponse(SCRIPT[0]!.reply, model).usage, input: 11, output: 0, cacheRead: 0, reasoning: undefined, totalTokens: 11 }, jobId: id,
    } as AnsweredMessage);
    await pdTurn(storage, o.agent, "Q1", [failed, replying(SCRIPT[0]!.reply)]);
    const rows = outboxes(storage);
    check(pdJobs(storage).length === 2 && pdJobs(storage).every((j) => j.state === "consumed"), `jobs ${show(pdJobs(storage))}: the failed attempt was not retried`);
    check(show(rows.trace.map((r) => r.status)) === show(["error", "stop"]), `trace ${show(rows.trace)}`);
    check(show(usagePairs(storage)) === show([["m1:input", 11], ...Q1_USAGE]), `usage ${show(rows.usage)}`);
    await o.agent.close();
  });

  add("pi.usage", "a commit that adds to pi.usage with no entry (compaction's shape) bills the delta; a tool's under `unknown`; an importer's entry that leaves pi.usage alone bills nothing", async (storage) => {
    const o = pdObject(storage);
    await pdTurn(storage, o.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    check(show(usagePairs(storage)) === show(Q1_USAGE), `control: the turn billed ${show(usagePairs(storage))}`);
    storage.sql.exec("DELETE FROM usage_outbox");
    const id = (await o.host.conversation("main")) as ConversationId;
    const commit = (fn: Parameters<Awaited<ReturnType<PdHost["handle"]>>["commit"]>[0]) =>
      o.host.withHarness(async (h) => (await o.host.handle(h, id)).commit(fn, bg));
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    // Compaction's commit: its model call's usage added to an existing key, and to a new one, with no entry.
    await commit(async (tx) => {
      const u = await tx.doc(UsageDoc, id);
      const m = u.models["queue/m1"]!;
      m.input += 1000; m.output += 25; m.totalTokens += 1025;
      u.models["other/vendor/m2"] = { ...zero, input: 7, cacheWrite: 3, totalTokens: 10 };
    });
    check(show(usagePairs(storage)) === show([["m1:input", 1000], ["m1:output", 25], ["vendor/m2:input", 7], ["vendor/m2:cache_write", 3]]),
      `the compaction-shaped commit billed ${show(usagePairs(storage))}`);
    storage.sql.exec("DELETE FROM usage_outbox");
    // A tool result's usage: pi-storage bills it under the model `unknown`.
    await commit(async (tx) => { (await tx.doc(UsageDoc, id)).tools.search = { ...zero, input: 5, output: 2, totalTokens: 7 }; });
    check(show(usagePairs(storage)) === show([["unknown:input", 5], ["unknown:output", 2]]), `the tool's usage billed ${show(usagePairs(storage))}`);
    storage.sql.exec("DELETE FROM usage_outbox");
    // An importer's entry, usage and all, that does not touch pi.usage: not spend, nothing billed or traced.
    const traceBefore = outboxes(storage).trace.length;
    await commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, id, { model: [{
        role: "assistant", content: [{ type: "text", text: "imported" }], api: "offloaded", provider: "queue", model: "m1",
        usage: { ...zero, input: 999, totalTokens: 999 }, stopReason: "stop", timestamp: 1, jobId: "mj_imported",
      } as never] });
    });
    check(outboxes(storage).usage.length === 0, `the import billed ${show(usagePairs(storage))}`);
    check(outboxes(storage).trace.length === traceBefore + 1, "control: the imported entry did reach the hook (its trace row)");
    await o.agent.close();
  });

  add("jobs", "a crash before the commit that records a job: no row and nothing dispatched; the new object makes one job, dispatches it once and bills once", async (storage) => {
    const { state, fault } = dying(isPollBatch);
    const crashed = pdObject(storage, { commitFault: fault });
    await crashed.agent.say("Q1");
    await crashed.agent.step().catch(() => {});
    await drop(crashed);
    check(state.fired > 0, "control: the fault never fired, so nothing was tested");
    check(pdJobs(storage).length === 0, `a commit that never landed left job rows: ${show(pdJobs(storage))}`);
    check(crashed.dispatched.length === 0, `a commit that never landed dispatched ${show(crashed.dispatched)}`);
    check(outboxes(storage).usage.length === 0, `usage before any answer: ${show(usagePairs(storage))}`);

    const next = pdObject(storage);
    await pdTurn(storage, next.agent, null, [replying(SCRIPT[0]!.reply)]);
    const jobs = pdJobs(storage);
    check(jobs.length === 1 && jobs[0]!.state === "consumed", `jobs after recovery ${show(jobs)}`);
    check(show(next.dispatched) === show([jobs[0]!.id]), `dispatched after recovery ${show(next.dispatched)}`);
    check(show(usagePairs(storage)) === show(Q1_USAGE), `usage after recovery ${show(usagePairs(storage))}`);
    await next.agent.close();
  });

  add("jobs", "a crash after the commit that records a job, before its dispatch: the next object dispatches it exactly once", async (storage) => {
    const first = pdObject(storage, { dispatch: async () => { throw new Error("the object died before the dispatch"); } });
    await first.agent.say("Q1");
    const parked = await first.agent.step();
    check(parked.wakeInMs !== null, `step: ${show(parked)}`);
    await first.agent.close();
    const [job] = pdJobs(storage);
    check(job && job.dispatched_at === null && job.state === null && first.dispatched.length === 1, `after the crash: ${show(pdJobs(storage))}, tried ${show(first.dispatched)}`);

    const next = pdObject(storage);
    for (let i = 0; i < 3; i++) await next.agent.step();
    check(show(next.dispatched) === show([job.id]), `dispatched on resume: ${show(next.dispatched)}`);
    await pdTurn(storage, next.agent, null, [replying(SCRIPT[0]!.reply)]);
    check(show(next.dispatched) === show([job.id]), `dispatched by the end: ${show(next.dispatched)}`);
    check(show(usagePairs(storage)) === show(Q1_USAGE), `usage ${show(usagePairs(storage))}`);
    await next.agent.close();
  });

  add("jobs", "cancel, then the answer arrives: the row is kept as cancelled, nothing is called again, and the late answer is billed once", async (storage) => {
    const o = pdObject(storage);
    await o.agent.say("Q1");
    await o.agent.step();
    const [job] = pdJobs(storage);
    check(job, "no job");
    const request = await o.agent.takeJob(job.id);
    check(request, "the job was not handed out");
    check(await o.agent.cancel("cancelled") !== null, "nothing was cancelled");
    check(pdJobs(storage)[0]!.state === "cancelled", `after cancel ${show(pdJobs(storage))}`);
    check(outboxes(storage).usage.length === 0, `billed before any answer: ${show(usagePairs(storage))}`);
    check(await o.agent.takeJob(job.id) === null, "a cancelled job was handed out again");
    check(await o.agent.deliver(job.id, fromResponse(SCRIPT[0]!.reply, MODEL_REF, job.id)) === true, "the late answer was refused");
    check(show(usagePairs(storage)) === show(Q1_USAGE), `the late answer billed ${show(usagePairs(storage))}`);
    check(await o.agent.deliver(job.id, fromResponse(SCRIPT[0]!.reply, MODEL_REF, job.id)) === false, "a second delivery was taken");
    for (let i = 0; i < 2; i++) await o.agent.step();
    const again = pdObject(storage);
    await again.agent.step();
    check(show(usagePairs(storage)) === show(Q1_USAGE), `after more steps and a new object: ${show(usagePairs(storage))}`);
    check(outboxes(storage).trace.length === 0, `trace ${show(outboxes(storage).trace)}`);
    await o.agent.close();
    await again.agent.close();
  });

  add("jobs", "an answer delivered and then cancelled before a poll took it is billed exactly once, whichever got there first", async (storage) => {
    const o = pdObject(storage);
    await o.agent.say("Q1");
    await o.agent.step();
    const [job] = pdJobs(storage);
    check(job, "no job");
    await consume(o.agent, job.id, replying(SCRIPT[0]!.reply));
    await o.agent.cancel("cancelled");
    for (let i = 0; i < 2; i++) await o.agent.step();
    const final = pdJobs(storage)[0]!;
    check(final.state === "cancelled" || final.state === "consumed", `job ${show(final)}`);
    check(show(usagePairs(storage)) === show(Q1_USAGE), `billed ${show(usagePairs(storage))} (job ${final.state})`);
    await o.agent.close();
  });

  add("all-or-nothing", "a throw in the commit hook rolls the commit back: pi-durable's state, the job and the outboxes as before; the next object completes the turn and bills once", async (storage) => {
    const o = pdObject(storage);
    await o.agent.say("Q1");
    const parked = await o.agent.step();
    const [job] = pdJobs(storage);
    check(job && parked.wakeInMs !== null, `no job: ${show(parked)}`);
    await o.agent.close();
    await consume(o.agent, job.id, replying(SCRIPT[0]!.reply));
    await sleep(parked.wakeInMs);
    const before = { pd: "", jobs: show(pdJobs(storage)), out: show(outboxes(storage)) };

    // pi-durable's state as the failing commit found it: the hook runs before the batch is applied. Commits
    // before it (the scheduler taking the task) land, and are not what is tested.
    const { state, fault } = dying((writes) => {
      const fires = hasAnswer(writes);
      if (fires) before.pd = pdState(storage);
      return fires;
    });
    const crashed = pdObject(storage, { commitFault: fault });
    await crashed.agent.step().catch(() => {});
    await drop(crashed);
    check(state.fired > 0, "control: the fault never fired, so nothing was tested");
    check(before.pd !== "" && pdState(storage) === before.pd, "pi-durable's state moved under a rolled-back commit");
    check(show(pdJobs(storage)) === before.jobs, `the job moved: ${show(pdJobs(storage))}`);
    check(show(outboxes(storage)) === before.out, `the outboxes moved: ${show(outboxes(storage))}`);

    const next = pdObject(storage);
    await pdTurn(storage, next.agent, null, []);
    check(pdJobs(storage)[0]!.state === "consumed", `job ${show(pdJobs(storage))}`);
    check(show(usagePairs(storage)) === show(Q1_USAGE), `usage ${show(usagePairs(storage))}`);
    check(show(outboxes(storage).trace.map((r) => [r.status, r.spanId])) === show([["stop", job.id]]), `trace ${show(outboxes(storage).trace)}`);
    await next.agent.close();
  });

  add("replay", "no double billing: steps, new objects and redeliveries after a turn add no row and dispatch nothing", async (storage) => {
    const o = pdObject(storage);
    await pdTurn(storage, o.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    const rows = show(outboxes(storage));
    const [job] = pdJobs(storage);
    check(await o.agent.deliver(job!.id, fromResponse(SCRIPT[0]!.reply, MODEL_REF, job!.id)) === false, "a redelivery was taken");
    for (let i = 0; i < 2; i++) await o.agent.step();
    await o.agent.close();
    for (let i = 0; i < 2; i++) {
      const again = pdObject(storage);
      await again.agent.step();
      check(again.dispatched.length === 0, `a new object dispatched ${show(again.dispatched)}`);
      await again.agent.close();
    }
    check(show(outboxes(storage)) === rows, `rows changed: ${show(outboxes(storage))}`);
  });

  return cases;
}
