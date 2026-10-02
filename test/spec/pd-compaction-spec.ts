/**
 * Compaction on the `pd` engine: pi-durable's compaction task, vendored with a `poll` phase
 * (src/vendor/pi/pi-durable/dist/harness/compaction.js), so its summary is a deferred model call through
 * `ap_model_jobs` like a generation's. Run over node:sqlite by test/pd-compaction.ts and on a real Durable
 * Object's storage by cf/src/conformance.ts (test/pd-compaction-do.sh).
 *
 * Each case drives DurableAgent over PdHost as the runtime does — `say`, `compact`, `step`, the worker's
 * `takeJob` and `deliver` with the real conversion (`toRequest` / `fromResponse`) — and reads what the object
 * holds: the job rows, the usage and trace outboxes, and the transcript. A "new object" is a new `PdHost` on the
 * same storage, what an eviction leaves; a "crash" is a host whose every commit from some point on fails.
 *
 * Upstream's compaction strips `deferred` from the summary request, so on this provider its summary is a
 * `deferred` message it reads as no text. The first case is the one that fails then: with upstream's task in
 * place of the vendored one, a manual compaction starts no job and fails "Summarization produced no text".
 */
import { setLogSink } from "../../src/core/log.ts";
import { fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import type { StepOutcome } from "../../src/runtime/engine.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { pendingTrace } from "../../src/trace/outbox.ts";
import { pendingUsage } from "../../src/usage/outbox.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";

const POLL = { firstMs: 200, maxMs: 800 };
const MODEL = { provider: "queue", id: "m1", contextWindow: 100_000 };
const OWNER = { tenantId: "t", agentId: "a" };
const PROMPT = "You are a terse test assistant.";
/** Small enough that two long turns have something to compact; no background threshold. */
const MANUAL = { keepRecentTokens: 10, reserveTokens: 1000, backgroundTokens: 0 };
/** A background compaction past ~1000 tokens of context: a long turn crosses it. */
const THRESHOLD = { keepRecentTokens: 10, reserveTokens: 1000, backgroundTokens: 98_000 };
/** The summarizer's system prompt (harness/compaction.js): how a summary job is told from a generation's. */
const SUMMARIZER = "You are a context summarization assistant.";
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const LONG = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(200)}`;

const reply = (text: string, input: number, output: number): ModelResponse =>
  ({ text, finishReason: "stop", truncated: false, usage: { promptTokens: input, completionTokens: output, reasoningTokens: 0, cachedPromptTokens: 0 } });

type Job = { id: string; answer: string | null; state: string | null; dispatched_at: number | null; request: string };
const jobs = (storage: DurableSqlHost): Job[] => {
  if (storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'ap_model_jobs'").toArray().length === 0) return [];
  return storage.sql.exec("SELECT id, answer, state, dispatched_at, request FROM ap_model_jobs ORDER BY created_at, rowid").toArray() as unknown as Job[];
};
const isSummary = (j: Job) => j.request.includes(SUMMARIZER);
const open = (storage: DurableSqlHost) => jobs(storage).filter((j) => j.answer === null && j.state === null);
const usagePairs = (storage: DurableSqlHost) => pendingUsage(storage.sql as never, 0).map((r) => [r.key, r.quantity]);
const traceRows = (storage: DurableSqlHost) => pendingTrace(storage.sql as never, 0).rows;
/** The compaction tasks' records, for a failure message: what a compaction that started no job ended as. */
const compactionTasks = (storage: DurableSqlHost) =>
  storage.sql.exec("SELECT record FROM pd_tasks WHERE json_extract(record, '$.kind') = 'pi.compaction'").toArray().map((r) => JSON.parse(String(r.record)).state);

type Fault = (writes: readonly StorageWrite[]) => void;
function pdObject(storage: DurableSqlHost, compaction: typeof MANUAL, extra: { commitFault?: Fault } = {}) {
  const dispatched: string[] = [];
  const host = new PdHost({ storage, poll: POLL, minParkMs: 1, compaction, ...(extra.commitFault ? { commitFault: extra.commitFault } : {}) });
  const agent = DurableAgent.open({
    host, ...OWNER, model: MODEL, systemPrompt: PROMPT,
    dispatch: async (id) => { dispatched.push(id); },
    unknownJob: (id) => new UnknownJob(id),
  });
  return { host, agent, dispatched };
}

/** The worker: the stored request through `toRequest`, the reply through `fromResponse`. */
async function answer(agent: DurableAgent, id: string, res: ModelResponse) {
  const job = await agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
  check(job, `job ${id} was not handed out`);
  toRequest(job.context);
  const message: AnsweredMessage = fromResponse(res, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id);
  check(await agent.deliver(id, message) === true, `deliver of ${id} was refused`);
}

/**
 * Step until nothing is left to wake for, or until every open job is one `pick` leaves unanswered (then the last
 * step's outcome is returned: parked on it). `pick` answers a job, or returns null to leave it out.
 */
async function run(storage: DurableSqlHost, agent: DurableAgent, pick: (j: Job) => ModelResponse | null): Promise<StepOutcome> {
  let out = await agent.step();
  for (let guard = 0; out.wakeInMs !== null; guard++) {
    check(guard < 80, `never settled: ${show(out)}; jobs ${show(jobs(storage).map((j) => [j.id, j.state, j.answer !== null, isSummary(j)]))}`);
    const waiting = open(storage);
    let answered = 0;
    for (const j of waiting) {
      const res = pick(j);
      if (res) { await answer(agent, j.id, res); answered++; }
    }
    if (waiting.length > 0 && answered === 0) return out;
    await sleep(out.wakeInMs);
    out = await agent.step();
  }
  return out;
}
/** A generation's job answered with `text`; a summary's left out. */
const turnsOnly = (text: string) => (j: Job) => (isSummary(j) ? null : reply(text, 120, 30));

async function longConversation(storage: DurableSqlHost, agent: DurableAgent) {
  await agent.say(LONG("first"));
  await run(storage, agent, turnsOnly("one"));
  await agent.say(LONG("second"));
  await run(storage, agent, turnsOnly("two"));
}
const TURN_USAGE = [["m1:input", 120], ["m1:output", 30]];
const SUMMARY_USAGE = [["m1:input", 300], ["m1:output", 40]];

/** What a conversation's next generation is sent: its last generation job's messages. */
const lastSent = (storage: DurableSqlHost) => {
  const gen = jobs(storage).filter((j) => !isSummary(j)).at(-1);
  check(gen, "no generation job");
  return show((JSON.parse(gen.request) as { context: { messages: unknown[] } }).context.messages);
};

/** A fault that, once `trigger` matches a batch, fails that commit and every later one: the object is dead from there. */
function dying(trigger: (writes: readonly StorageWrite[]) => boolean) {
  const state = { dead: false, fired: 0 };
  const fault: Fault = (writes) => {
    if (!state.dead && trigger(writes)) state.dead = true;
    if (state.dead) { state.fired++; throw new Error("the object died inside this commit"); }
  };
  return { state, fault };
}
const isSummaryPoll = (writes: readonly StorageWrite[]) => writes.some((w) => w.type === "task" && w.value.kind === "pi.compaction"
  && (w.value.state as { checkpoint?: { phase?: unknown } }).checkpoint?.phase === "poll");

export function pdCompactionCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, body: (host: DurableSqlHost) => Promise<void>) =>
    cases.push({ group, name, run: () => withHost(body) });

  add("manual", "compact on a long conversation: one deferred summary job, parked while it is out, the real summary placed, its usage billed once, and the next turn sent the summary instead of the turn", async (storage) => {
    const o = pdObject(storage, MANUAL);
    await longConversation(storage, o.agent);
    const before = usagePairs(storage);
    check(show(before) === show([...TURN_USAGE, ...TURN_USAGE]), `control: the turns billed ${show(before)}`);

    const started = await o.agent.compact();
    check(typeof started.operationId === "string" && started.operationId.length > 0, `compact returned ${show(started)}`);
    const parked = await o.agent.step();
    const summaries = jobs(storage).filter(isSummary);
    check(summaries.length === 1, `expected one summary job, found ${summaries.length}; compaction tasks ${show(compactionTasks(storage))}`);
    check(parked.wakeInMs !== null && parked.wakeInMs > 0 && !o.host.open, `while the summary is out the object parks: ${show(parked)}, harness open ${o.host.open}`);
    const [job] = summaries;
    check(job!.answer === null && job!.state === null && show(o.dispatched).includes(job!.id), `the summary job ${show(job)}, dispatched ${show(o.dispatched)}`);
    const request = JSON.parse(job!.request) as { context: { messages: Array<{ role: string; content: unknown }> }; options?: { deferred?: unknown; maxTokens?: unknown } };
    check(request.context.messages[0]?.role === "system" && String(request.context.messages[0]?.content).startsWith(SUMMARIZER), `the summarizer's prompt: ${show(request.context.messages[0])}`);
    check(show(request.context.messages[1]).includes("[User]: first"), "the summarized range starts at the first turn");
    check(request.options?.deferred === true && Number(request.options?.maxTokens) > 0, `options ${show(request.options)}`);
    check(show(usagePairs(storage)) === show(before), `billed before the answer: ${show(usagePairs(storage))}`);

    // Asked again while one is out: the same one, no second job.
    const again = await o.agent.compact();
    check(again.operationId === started.operationId, `a second compact started ${show(again)}, not ${show(started)}`);
    await o.agent.step();
    check(jobs(storage).filter(isSummary).length === 1, `a second compact made another summary job: ${jobs(storage).filter(isSummary).length}`);

    await answer(o.agent, job!.id, reply("## Goal\nthe offloaded summary", 300, 40));
    const end = await run(storage, o.agent, () => null);
    check(end.wakeInMs === null && !o.host.open, `then idle: ${show(end)}`);
    check(jobs(storage).find((j) => j.id === job!.id)?.state === "consumed", `the summary job ${show(jobs(storage).find((j) => j.id === job!.id))}`);
    check(show(usagePairs(storage)) === show([...before, ...SUMMARY_USAGE]), `usage ${show(usagePairs(storage))}`);
    check(traceRows(storage).length === 2 && traceRows(storage).every((r) => r.spanId !== job!.id), `trace: the two turns' calls only, ${show(traceRows(storage).map((r) => [r.kind, r.spanId, r.status]))}`);

    const branch = await o.agent.branch();
    check(branch[0]?.type === "compaction" && (branch[0] as { summary?: unknown }).summary === "## Goal\nthe offloaded summary", `the branch starts at the summary: ${show(branch[0])}`);
    check(!show(branch).includes("first lorem") && show(branch).includes("second lorem"), "the summarized turn left the branch, the kept one stayed");
    check((await o.agent.entries({})).filter((e) => e.type === "compaction").length === 1, "one compaction entry");

    // More steps and a new object add no row and no job.
    await o.agent.step();
    await o.agent.close();
    const next = pdObject(storage, MANUAL);
    await next.agent.step();
    check(show(usagePairs(storage)) === show([...before, ...SUMMARY_USAGE]), `usage after more steps and a new object: ${show(usagePairs(storage))}`);
    check(jobs(storage).length === 3, `jobs ${jobs(storage).length}`);

    await next.agent.say("third");
    await run(storage, next.agent, turnsOnly("three"));
    const sent = lastSent(storage);
    check(sent.includes(SUMMARY_PREFIX) && sent.includes("the offloaded summary"), `the next request carries the summary: ${sent.slice(0, 300)}`);
    check(!sent.includes("first lorem") && sent.includes("second lorem") && sent.includes("third"), "and not the summarized turn");
    await next.agent.close();
  });

  add("threshold", "a background compaction started in a run does not block it: the turn is answered and ends while the summary is out, the summary lands after, and the next turn is sent it", async (storage) => {
    const o = pdObject(storage, THRESHOLD);
    await o.agent.say(LONG("first"));
    await run(storage, o.agent, turnsOnly("one"));
    await o.agent.say(LONG("second"));
    const parked = await run(storage, o.agent, turnsOnly("two"));
    const summaries = open(storage).filter(isSummary);
    check(summaries.length === 1, `a background compaction started one summary, open ${show(open(storage).map((j) => [j.id, isSummary(j)]))}; tasks ${show(compactionTasks(storage))}`);
    check(open(storage).every(isSummary), "the run's own call was answered without waiting for it");
    check(parked.wakeInMs !== null && !o.host.open, `parked on the summary alone: ${show(parked)}`);
    check(await o.agent.running() === false, "the turn is not reported running while only the background summary is out");
    const branch = await o.agent.branch();
    check(show(branch).includes("\"two\""), `the turn's answer is in: ${show(branch.map((e) => e.type))}`);
    await answer(o.agent, summaries[0]!.id, reply("## Goal\nthreshold summary", 300, 40));
    await run(storage, o.agent, () => null);
    check((await o.agent.branch())[0]?.type === "compaction", "the summary was placed");
    await o.agent.say("third");
    await run(storage, o.agent, turnsOnly("three"));
    const sent = lastSent(storage);
    check(sent.includes("threshold summary") && !sent.includes("first lorem"), `the next request carries the summary, not the turn: ${sent.slice(0, 300)}`);
    await o.agent.close();
  });

  add("cancel", "a cancel while the summary is out cancels its job and places nothing; the late answer is billed once and never placed", async (storage) => {
    const o = pdObject(storage, MANUAL);
    await longConversation(storage, o.agent);
    const before = usagePairs(storage);
    await o.agent.compact();
    await o.agent.step();
    const job = open(storage).find(isSummary);
    check(job, `no summary job; tasks ${show(compactionTasks(storage))}`);
    check(await o.agent.cancel("cancelled") !== null, "nothing was cancelled");
    check(jobs(storage).find((j) => j.id === job.id)?.state === "cancelled", `after cancel ${show(jobs(storage).find((j) => j.id === job.id))}`);
    check(await o.agent.takeJob(job.id) === null, "a cancelled summary job was handed out again");
    const status = await o.agent.status();
    check(show(status.detail).includes("\"tasks\":[]"), `a live task remains: ${show(status.detail).slice(0, 300)}`);
    check(show(usagePairs(storage)) === show(before), `billed before any answer: ${show(usagePairs(storage))}`);
    check(await o.agent.deliver(job.id, fromResponse(reply("## Goal\ntoo late", 300, 40), { api: "offloaded", provider: MODEL.provider, id: MODEL.id }, job.id)) === true, "the late answer was refused");
    for (let i = 0; i < 2; i++) await o.agent.step();
    check(show(usagePairs(storage)) === show([...before, ...SUMMARY_USAGE]), `the late answer billed ${show(usagePairs(storage))}`);
    check(!(await o.agent.branch()).some((e) => e.type === "compaction"), "the cancelled summary was placed");
    await o.agent.close();
  });

  add("crash", "a new object while the summary is out: it resumes the poll, places the summary once and bills it once, with the one job dispatched once", async (storage) => {
    const first = pdObject(storage, MANUAL);
    await longConversation(storage, first.agent);
    const before = usagePairs(storage);
    await first.agent.compact();
    const parked = await first.agent.step();
    const job = open(storage).find(isSummary);
    check(job && parked.wakeInMs !== null, `no summary job: ${show(parked)}; tasks ${show(compactionTasks(storage))}`);
    await first.agent.close();

    const next = pdObject(storage, MANUAL);
    await answer(next.agent, job.id, reply("## Goal\nafter the eviction", 300, 40));
    await run(storage, next.agent, () => null);
    check(jobs(storage).filter(isSummary).length === 1, `summary jobs ${jobs(storage).filter(isSummary).length}`);
    check(jobs(storage).find((j) => j.id === job.id)?.state === "consumed", "the job was not consumed");
    check(!next.dispatched.includes(job.id) && first.dispatched.filter((id) => id === job.id).length === 1, `dispatched ${show(first.dispatched)} then ${show(next.dispatched)}`);
    check(show(usagePairs(storage)) === show([...before, ...SUMMARY_USAGE]), `usage ${show(usagePairs(storage))}`);
    const entries = await next.agent.entries({});
    check(entries.filter((e) => e.type === "compaction").length === 1 && show(entries).includes("after the eviction"), `compaction entries ${show(entries.filter((e) => e.type === "compaction"))}`);
    await next.agent.close();
  });

  add("crash", "a crash before the commit that records the summary's job: no row, nothing dispatched; the new object asks once, places once and bills once", async (storage) => {
    const setup = pdObject(storage, MANUAL);
    await longConversation(storage, setup.agent);
    await setup.agent.close();
    const before = usagePairs(storage);
    const turns = jobs(storage).length;

    const { state, fault } = dying(isSummaryPoll);
    const crashed = pdObject(storage, MANUAL, { commitFault: fault });
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      await crashed.agent.compact();
      await crashed.agent.step().catch(() => {});
      await crashed.agent.close().catch(() => {});
      await crashed.host.close().catch(() => {});
    } finally { setLogSink(null); }
    check(state.fired > 0, `control: the fault never fired, so nothing was tested; tasks ${show(compactionTasks(storage))}`);
    check(jobs(storage).length === turns && crashed.dispatched.length === 0, `a commit that never landed left ${show(jobs(storage).slice(turns))}, dispatched ${show(crashed.dispatched)}`);

    const next = pdObject(storage, MANUAL);
    await run(storage, next.agent, (j) => (isSummary(j) ? reply("## Goal\nafter the crash", 300, 40) : null));
    const summaries = jobs(storage).filter(isSummary);
    check(summaries.length === 1 && summaries[0]!.state === "consumed", `summary jobs ${show(summaries.map((j) => [j.id, j.state]))}`);
    check(show(next.dispatched) === show([summaries[0]!.id]), `dispatched ${show(next.dispatched)}`);
    check(show(usagePairs(storage)) === show([...before, ...SUMMARY_USAGE]), `usage ${show(usagePairs(storage))}`);
    const entries = await next.agent.entries({});
    check(entries.filter((e) => e.type === "compaction").length === 1 && show(entries).includes("after the crash"), "one summary placed");
    await next.agent.close();
  });

  return cases;
}
