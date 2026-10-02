/**
 * The park contract (src/runtime/durable-drive.ts) and the pi-ai 1.0 offloaded
 * provider (src/model/durable-offloaded.ts), on pi-durable's harness over our
 * SQLite facade. Run over node:sqlite by test/durable-drive.ts and on a real
 * Durable Object's storage by cf/src/conformance.ts (test/durable-drive-do.sh).
 *
 * "The queue" here is a table in the same database and a consumer that runs
 * the real conversion in both directions — `toRequest` on the stored job and
 * `fromResponse` on the model's reply (src/model/pi-bridge.ts) — so what
 * crosses between the provider and the consumer is the JSON a `pi_model_jobs`
 * row holds, and nothing else. Only the model itself is faked.
 *
 * A "wake" is what an alarm or a request will do in the object: open a harness
 * on the same storage, resume it (or submit), and settle. Between wakes no
 * harness is open, which is the point.
 */
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import {
  createRegistry, defineExtension, defineTask, defineTool, section, Harness, type HarnessOptions, type HarnessSettings,
  type TaskInspection,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "pi-ai-1";
import { createModels } from "pi-ai-1/models";
import { durableOffloadedProvider, readAnswer, type ModelJobRequest } from "../../src/model/durable-offloaded.ts";
import { fromResponse, errorMessage, toRequest } from "../../src/model/pi-bridge.ts";
import type { ModelMessage, ModelResponse, ToolDefinition } from "../../src/model/types.ts";
import { DEFAULT_MIN_PARK_MS, parkVerdict, readSnapshot, type DriveSnapshot, settle, type ParkVerdict, type SettleResult } from "../../src/runtime/durable-drive.ts";
import { PiDurableSqlite, type DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";

export type DriveCase = { group: string; name: string; run(): Promise<void> };
/** Hands each case a host with no tables, and cleans up after it. */
export type WithDriveHost = (use: (host: DurableSqlHost) => Promise<void>) => Promise<void>;
/** Live timers in this isolate, where the runtime can count them (node can; workerd cannot). */
export type TimerProbe = (() => number) | undefined;

const POLL_AFTER_MS = 300;
const RETRY_BASE_MS = 300;
const PROVIDER = "queue";
const MODEL = "m1";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

type JobRow = { id: string; request: string; answer: string | null };

/** `pi_model_jobs`, reduced to what the provider and the consumer touch, in the case's own database. */
function jobTable(host: DurableSqlHost, pollDelayMs = 0) {
  host.sql.exec("CREATE TABLE IF NOT EXISTS drive_jobs (id TEXT PRIMARY KEY, request TEXT NOT NULL, answer TEXT)");
  let seq = 0;
  const rows = () => host.sql.exec("SELECT id, request, answer FROM drive_jobs ORDER BY rowid").toArray()
    .map((r): JobRow => ({ id: String(r.id), request: String(r.request), answer: r.answer === null ? null : String(r.answer) }));
  let polls = 0;
  const port = {
    async start(request: ModelJobRequest) {
      const id = `mj_${++seq}_${Date.now()}`;
      host.sql.exec("INSERT INTO drive_jobs (id, request) VALUES (?, ?)", id, JSON.stringify(request));
      return id;
    },
    async poll(id: string) {
      polls++;
      if (pollDelayMs > 0) await sleep(pollDelayMs);
      const row = rows().find((r) => r.id === id);
      return row?.answer ? readAnswer(row.answer) : null;
    },
  };
  /**
   * The queue consumer, as `runQueuedModelCall` does it: parse the stored request,
   * convert it with `toRequest`, ask the model, store `fromResponse` of the reply.
   */
  const consume = (id: string, model: (messages: ModelMessage[], tools?: ToolDefinition[]) => ModelResponse | { error: string }) => {
    const row = rows().find((r) => r.id === id);
    check(row && row.answer === null, `job ${id} is not open`);
    const job = JSON.parse(row.request);
    const { messages, tools } = toRequest(job.context);
    const identity = { api: String(job.model.api), provider: String(job.model.provider), id: String(job.model.id) };
    const reply = model(messages, tools);
    const answer = "error" in reply ? { ...errorMessage(reply.error, identity), jobId: id } : fromResponse(reply, identity, id);
    host.sql.exec("UPDATE drive_jobs SET answer = ? WHERE id = ?", JSON.stringify(answer), id);
  };
  return { port, rows, consume, polls: () => polls };
}

const reply = (text: string): ModelResponse => ({
  text, finishReason: "stop", truncated: false, usage: { promptTokens: 3, completionTokens: 2, reasoningTokens: 0, cachedPromptTokens: 0 },
});

const countTool = defineTool({
  name: "count",
  description: "Count from 1 to n",
  parameters: Type.Object({ n: Type.Number() }),
  execute: async () => ({}),
});
/**
 * A task that sleeps in a phase the park table does not know — what a new pi-durable phase or an
 * extension's own task calling `runtime.sleep` would look like to `parkVerdict`.
 */
const NapTask = defineTask<Record<string, never>, { phase: "nap"; until: number }, null>({
  name: "drive-test.nap",
  version: 1,
  initial: () => ({ phase: "nap", until: 0 }),
  phases: {
    nap: async (_task, runtime, context) => {
      await runtime.sleep(runtime.now() + 60_000, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});
const extension = defineExtension({
  name: "drive-test",
  sections: [section("preamble", () => "You are a terse test assistant.", { tag: false })],
  tools: [countTool],
  tasks: [NapTask],
});

function world(host: DurableSqlHost, settings: HarnessSettings = {}, activeTimers?: TimerProbe, pollDelayMs = 0) {
  const jobs = jobTable(host, pollDelayMs);
  const models = createModels();
  models.setProvider(durableOffloadedProvider({
    port: jobs.port, id: PROVIDER, pollAfterMs: POLL_AFTER_MS, models: [{ id: MODEL, contextWindow: 100_000 }],
  }));
  const registry = createRegistry();
  registry.install(extension);
  const reports: string[] = [];
  const options: HarnessOptions = {
    models, registry,
    settings: { stream: { deferred: true }, retry: { enabled: true, maxRetries: 3, baseDelayMs: RETRY_BASE_MS }, ...settings },
    onReport: (e) => reports.push(e instanceof Error ? e.message : String(e)),
  };
  const open = async () => Harness.open(await SqliteStorage.open(new PiDurableSqlite(host, prefixedNamespace("pd"))), options, bg);
  /** Each verdict, with the live timers at that moment where they can be counted. */
  const verdicts: Array<{ verdict: ParkVerdict; timers?: number }> = [];
  const drive = (h: Harness): Promise<SettleResult> =>
    settle(h, { context: bg, deadlineMs: 10_000, minParkMs: 1, onVerdict: (verdict) => verdicts.push({ verdict, ...(activeTimers ? { timers: activeTimers() } : {}) }) });
  /** What an alarm does: open, resume, settle. */
  const wake = async () => { const h = await open(); h.resume(); return drive(h); };
  /** What a request does: open, submit, settle. */
  const submit = async (text: string, whenBusy?: "steer" | "followUp") => {
    const h = await open();
    const root = await h.root(bg, { agent: { model: { provider: PROVIDER, modelId: MODEL }, instructions: "Answer in one word." } });
    await root.submit({ type: "input", content: text, ...(whenBusy ? { whenBusy } : {}) }, bg);
    return drive(h);
  };
  /** The conversation's turns as role(stopReason): text, read on a harness that is never resumed. */
  const transcript = async () => {
    const h = await open();
    try {
      const view = await (await h.root(bg)).context(bg);
      // pi-durable places the prompt and tool declarations as a system message after the first input;
      // it is a declaration, not a turn, and `jobContext` folds it (the wire-format cases cover that).
      return view.messages.filter((m) => m.role !== "system").map((m) => {
        const text = typeof m.content === "string" ? m.content
          : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        return m.role === "assistant" ? `assistant(${m.stopReason}): ${text}` : `${m.role}: ${text}`;
      });
    } finally { await h.close(bg); }
  };
  return { jobs, open, wake, submit, transcript, verdicts, reports };
}

function parked(r: SettleResult): Extract<SettleResult, { state: "parked" }> {
  check(r.state === "parked", `expected parked, got ${show(r)}`);
  return r;
}

export function durableDriveCases(withHost: WithDriveHost, activeTimers: TimerProbe): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, body: (host: DurableSqlHost) => Promise<void>) =>
    cases.push({ group, name, run: () => withHost(body) });

  add("provider", "a job carries the consumer's wire format: system prompt and tools as fields, no system message", async (host) => {
    const w = world(host);
    const r = parked(await w.submit("Capital of France?"));
    const [row] = w.jobs.rows();
    check(row, "no job was written");
    const job = JSON.parse(row.request);
    check(show(Object.keys(job).sort()) === show(["context", "model", "options"]), `job keys ${show(Object.keys(job))}`);
    check(show(Object.keys(job.context).sort()) === show(["messages", "systemPrompt", "tools"]), `context keys ${show(Object.keys(job.context))}`);
    check(job.context.messages.every((m: { role: string }) => m.role !== "system"), "a system message reached the job");
    const { messages, tools } = toRequest(job.context);
    check(messages.length === 2, `request messages ${show(messages)}`);
    check(messages[0]?.role === "system" && messages[0].content.includes("terse test assistant") && messages[0].content.includes("Answer in one word."),
      `system prompt ${show(messages[0])}`);
    check(messages[1]?.role === "user" && messages[1].content === "Capital of France?", `user turn ${show(messages[1])}`);
    check(tools?.length === 1 && tools[0]?.name === "count", `tools ${show(tools)}`);
    check(show(job.model).includes(`"provider":"${PROVIDER}"`) && job.model.id === MODEL, `model ${show(job.model)}`);
    check(r.parkedUntil > 0, "parked");
  });

  add("park", `(1) submit parks with T = the checkpoint's pollAt${activeTimers ? ", and no timer outlives close" : " (live timers not countable here)"}`, async (host) => {
    const w = world(host, {}, activeTimers);
    const before = Date.now();
    const r = parked(await w.submit("Q1"));
    if (activeTimers) {
      // The control: the sleep is a live timer while the harness is open, so the probe can see one.
      const atPark = w.verdicts.at(-1);
      check(atPark?.verdict.verdict === "park" && (atPark.timers ?? 0) > 0, `no live timer seen before close: ${show(atPark)}`);
      check(activeTimers() === 0, `live timers after close: ${activeTimers()}`);
    }
    check(w.jobs.rows().length === 1 && w.jobs.polls() === 0, `jobs ${w.jobs.rows().length}, polls ${w.jobs.polls()}`);
    check(r.sleepers.length === 1 && r.sleepers[0]?.phase === "poll", `sleepers ${show(r.sleepers)}`);
    check(r.parkedUntil >= before + POLL_AFTER_MS && r.parkedUntil <= Date.now() + POLL_AFTER_MS, `T ${r.parkedUntil - before} ms after submit`);
    const h = await w.open();
    try {
      const ins = await h.inspect(bg);
      const checkpoint = ins.tasks[0]?.record.state.checkpoint;
      check(show(checkpoint).includes(`"pollAt":${r.parkedUntil}`), `stored checkpoint ${show(checkpoint)} vs T ${r.parkedUntil}`);
    } finally { await h.close(bg); }
  });

  add("park", "(2) answer delivered, wake at T: completes with one fetch, transcript is the answer", async (host) => {
    const w = world(host);
    const r = parked(await w.submit("Q1"));
    w.jobs.consume(w.jobs.rows()[0]!.id, () => reply("Paris"));
    await sleep(r.parkedUntil - Date.now());
    const polls = w.jobs.polls();
    const done = await w.wake();
    check(done.state === "idle", `after wake: ${show(done)}`);
    check(w.jobs.polls() - polls === 1, `fetches after reopen: ${w.jobs.polls() - polls}`);
    const t = await w.transcript();
    check(show(t) === show(["user: Q1", "assistant(stop): Paris"]), `transcript ${show(t)}`);
  });

  add("park", "(3) wake at T with no answer: one fetch, parks again later, and again — no busy loop", async (host) => {
    const w = world(host);
    let r = parked(await w.submit("Q1"));
    for (let i = 0; i < 3; i++) {
      await sleep(r.parkedUntil - Date.now());
      const polls = w.jobs.polls();
      const again = parked(await w.wake());
      check(w.jobs.polls() - polls === 1, `wake ${i}: ${w.jobs.polls() - polls} fetches`);
      check(again.parkedUntil > r.parkedUntil && again.parkedUntil > Date.now(), `wake ${i}: T ${again.parkedUntil} after ${r.parkedUntil}`);
      r = again;
    }
    check(w.jobs.rows().length === 1, `jobs ${w.jobs.rows().length}: a not-ready poll must not start a new call`);
  });

  add("park", "(4) pollAt already past at reopen: polls instead of parking at a past T", async (host) => {
    // A fetch that takes a while, so the harness is read while it is in flight: the window in which
    // the checkpoint still says `poll` with a `pollAt` that has passed.
    const w = world(host, {}, undefined, 150);
    const r = parked(await w.submit("Q1"));
    await sleep(r.parkedUntil - Date.now() + 2 * POLL_AFTER_MS);
    const polls = w.jobs.polls();
    const woke = Date.now();
    const again = parked(await w.wake());
    check(again.parkedUntil > woke, `parked at ${again.parkedUntil - woke} ms from wake: in the past`);
    check(w.jobs.polls() - polls === 1, `fetches: ${w.jobs.polls() - polls}`);
  });

  add("park", "(5) input while parked re-parks at the same T; the steer runs after the answer", async (host) => {
    const w = world(host);
    const r = parked(await w.submit("Q1"));
    const polls = w.jobs.polls();
    const steer = parked(await w.submit("STEER", "steer"));
    check(steer.parkedUntil === r.parkedUntil, `re-parked at ${steer.parkedUntil}, was ${r.parkedUntil}`);
    check(w.jobs.polls() === polls && w.jobs.rows().length === 1, `input while parked fetched or called: polls ${w.jobs.polls() - polls}, jobs ${w.jobs.rows().length}`);
    w.jobs.consume(w.jobs.rows()[0]!.id, () => reply("A1"));
    await sleep(r.parkedUntil - Date.now());
    const second = parked(await w.wake());
    const rows = w.jobs.rows();
    check(rows.length === 2, `jobs after the answer: ${rows.length}`);
    const seen = toRequest(JSON.parse(rows[1]!.request).context).messages.map((m) => `${m.role}: ${m.content}`);
    check(show(seen.slice(1)) === show(["user: Q1", "assistant: A1", "user: STEER"]), `second call saw ${show(seen)}`);
    w.jobs.consume(rows[1]!.id, () => reply("A2"));
    await sleep(second.parkedUntil - Date.now());
    const done = await w.wake();
    check(done.state === "idle", `after the second answer: ${show(done)}`);
    const t = await w.transcript();
    check(show(t) === show(["user: Q1", "assistant(stop): A1", "user: STEER", "assistant(stop): A2"]), `transcript ${show(t)}`);
  });

  add("park", "(6) a retryable error parks for the retry backoff, then calls again", async (host) => {
    const w = world(host);
    const r = parked(await w.submit("Q1"));
    w.jobs.consume(w.jobs.rows()[0]!.id, () => ({ error: "503 Service Unavailable: the model is overloaded" }));
    await sleep(r.parkedUntil - Date.now());
    const backoff = parked(await w.wake());
    check(backoff.sleepers.length === 1 && backoff.sleepers[0]?.phase === "retry", `sleepers ${show(backoff.sleepers)}`);
    check(backoff.parkedUntil > Date.now(), "retry T is in the past");
    check(w.jobs.rows().length === 1, `a new call started before the backoff: ${w.jobs.rows().length} jobs`);
    await sleep(backoff.parkedUntil - Date.now());
    const polling = parked(await w.wake());
    check(polling.sleepers[0]?.phase === "poll" && w.jobs.rows().length === 2, `after backoff: ${show(polling)}, jobs ${w.jobs.rows().length}`);
    w.jobs.consume(w.jobs.rows()[1]!.id, () => reply("Paris"));
    await sleep(polling.parkedUntil - Date.now());
    check((await w.wake()).state === "idle", "did not finish");
    const t = await w.transcript();
    check(t.at(-1) === "assistant(stop): Paris", `transcript ${show(t)}`);
  });

  add("verdict", "the guard: a poll sleeper parks only while pollAt is strictly ahead of now", async (host) => {
    const w = world(host);
    const h = await w.open();
    const root = await h.root(bg, { agent: { model: { provider: PROVIDER, modelId: MODEL } } });
    await root.submit({ type: "input", content: "Q1" }, bg);
    // Read the parked state, then judge the same snapshot at other instants.
    let snapshot;
    for (let i = 0; i < 200 && !snapshot; i++) {
      const s = await readSnapshot(h, bg, Date.now);
      if (s && parkVerdict(s, 1).verdict === "park") snapshot = s;
      else await sleep(5);
    }
    await h.close(bg);
    check(snapshot, "never reached a parkable state");
    const v = parkVerdict(snapshot, 1);
    check(v.verdict === "park", show(v));
    const T = v.until;
    const at = (now: number) => parkVerdict({ ...snapshot, now }, 1).verdict;
    check(at(T - 1) === "park", `now = T-1: ${at(T - 1)}`);
    check(at(T) === "wait", `now = T: ${at(T)} — a sleeper due now is about to fetch`);
    check(at(T + 1) === "wait", `now = T+1: ${at(T + 1)} — a past T parks into a loop`);
    check(parkVerdict({ ...snapshot, now: T - 50 }, 100).verdict === "wait", "minParkMs not honoured");
    // The production default: a sleeper due in under a second is not parked.
    check(parkVerdict({ ...snapshot, now: T - (DEFAULT_MIN_PARK_MS - 1) }).verdict === "wait", "default parked a sleeper due in < 1000 ms");
    check(parkVerdict({ ...snapshot, now: T - DEFAULT_MIN_PARK_MS }).verdict === "park", "default refused a sleeper due in 1000 ms");
  });

  add("verdict", "queued input with no run is work; with a run holding the conversation it waits for the boundary", async (host) => {
    const w = world(host);
    const h = await w.open();
    const root = await h.root(bg, { agent: { model: { provider: PROVIDER, modelId: MODEL } } });
    await root.submit({ type: "input", content: "Q1" }, bg);
    let snapshot;
    for (let i = 0; i < 200 && !snapshot; i++) {
      const s = await readSnapshot(h, bg, Date.now);
      if (s && parkVerdict(s, 1).verdict === "park") snapshot = s;
      else await sleep(5);
    }
    await h.close(bg);
    check(snapshot, "never reached a parkable state");
    const [id, docs] = [...snapshot.docs][0]!;
    const item = { id: snapshot.inspection.submissions[0]!.id, mode: "steer" as const, content: "later" };
    const withInbox = new Map([[id, { ...docs, inbox: { items: [item] } }]]);
    check(parkVerdict({ ...snapshot, docs: withInbox }, 1).verdict === "park", "queued input behind a sleeping run should park");
    const noRun = new Map([[id, { inbox: { items: [item] }, live: { ...docs.live, run: undefined } }]]);
    check(parkVerdict({ ...snapshot, docs: noRun }, 1).verdict === "wait", "queued input with no run must not park");
    const partial = {
      role: "assistant" as const, content: [], api: "offloaded", provider: PROVIDER, model: MODEL, stopReason: "pending" as const, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const streaming = new Map([[id, { ...docs, live: { ...docs.live, generation: { attempt: 1, message: partial } } }]]);
    check(parkVerdict({ ...snapshot, docs: streaming }, 1).verdict === "wait", "a committed partial must not park");
    const toolRunning = new Map([[id, { ...docs, live: { ...docs.live, tools: [{ callId: "c1", name: "count", status: "running" as const }] } }]]);
    check(parkVerdict({ ...snapshot, docs: toolRunning }, 1).verdict === "wait", "a running tool slot must not park");
    const empty = { ...snapshot, inspection: { ...snapshot.inspection, tasks: [], submissions: [] }, docs: new Map() };
    check(parkVerdict(empty).verdict === "idle", "nothing live should be idle");
  });

  add("verdict", "a running task with an unrecognised or malformed checkpoint is not parked, and is named as such", async (host) => {
    const w = world(host);
    const h = await w.open();
    const root = await h.root(bg, { agent: { model: { provider: PROVIDER, modelId: MODEL } } });
    await root.submit({ type: "input", content: "Q1" }, bg);
    let snapshot;
    for (let i = 0; i < 200 && !snapshot; i++) {
      const s = await readSnapshot(h, bg, Date.now);
      if (s && parkVerdict(s, 1).verdict === "park") snapshot = s;
      else await sleep(5);
    }
    await h.close(bg);
    check(snapshot, "never reached a parkable state");
    const base = snapshot;
    const [task] = base.inspection.tasks;
    check(task && task.record.state.status === "running", "no running task in the parked snapshot");
    const T = Date.now() + 60_000;
    const withCheckpoint = (checkpoint: JsonValue): DriveSnapshot => {
      const record: TaskInspection["record"] = { ...task.record, state: { status: "running", checkpoint } };
      return { ...base, inspection: { ...base.inspection, tasks: [{ ...task, record }] } };
    };
    const malformed: JsonValue[] = [{ phase: "ready" }, { phase: "pol", pollAt: T }, { pollAt: T }, { phase: "poll" }, { phase: "poll", pollAt: String(T) }, "poll", null];
    for (const checkpoint of malformed) {
      const v = parkVerdict(withCheckpoint(checkpoint), 1);
      check(v.verdict === "wait" && v.reason.includes("unrecognised checkpoint"), `${show(checkpoint)}: ${show(v)}`);
    }
    const working = parkVerdict(withCheckpoint({ phase: "request", attempt: 1 }), 1);
    check(working.verdict === "wait" && working.reason.includes("is working (request)"), `request: ${show(working)}`);
    const sleeping = parkVerdict(withCheckpoint({ phase: "poll", attempt: 1, pollAt: T }), 1);
    check(sleeping.verdict === "park", `the well-formed control did not park: ${show(sleeping)}`);
  });

  add("verdict", "settle on a task sleeping in an unknown phase: no spin — one read per commit or recheck, then timeout", async (host) => {
    const w = world(host);
    const h = await w.open();
    const root = await h.root(bg, { agent: { model: { provider: PROVIDER, modelId: MODEL } } });
    await root.commit((tx) => tx.createTask(NapTask, {}, { ownership: { kind: "conversation" } }), bg);
    h.resume();
    const verdicts: ParkVerdict[] = [];
    const recheckMs = 100, deadlineMs = 600;
    const r = await settle(h, { context: bg, minParkMs: 1, recheckMs, deadlineMs, onVerdict: (v) => verdicts.push(v) });
    await h.close(bg);
    check(r.state === "timeout", `expected timeout, got ${show(r)}`);
    check(r.last.verdict === "wait" && r.last.reason.includes("unrecognised checkpoint"), `last verdict ${show(r.last)}`);
    // Without commits, reads happen once per recheck: about deadline / recheck of them, never a tight loop.
    check(verdicts.length >= 2 && verdicts.length <= deadlineMs / recheckMs + 3, `${verdicts.length} reads in ${deadlineMs} ms`);
  });

  return cases;
}

export async function runDriveCases(cases: DriveCase[]) {
  const results: Array<{ group: string; name: string; ok: boolean; ms: number; error?: string }> = [];
  for (const c of cases) {
    const t0 = Date.now();
    try { await c.run(); results.push({ group: c.group, name: c.name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { results.push({ group: c.group, name: c.name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? (e.stack ?? e.message).slice(0, 600) : String(e) }); }
  }
  return results;
}

/**
 * The same conversation through both providers: the 0.85 one the live runtime
 * uses (src/model/pi-offloaded.ts) and the 1.0 one above. Each world gets its own
 * plain objects, parsed from one JSON text, and each port keeps only the JSON of
 * the request it was handed — so nothing crosses between the two pi-ai copies
 * but strings. The stored context, and what `toRequest` makes of it, must be
 * byte-identical: the consumer cannot tell which runtime wrote the job.
 */
export async function wireFormatCases(old: {
  /** `offloadedProvider` from src/model/pi-offloaded.ts and `createModels` from 0.85, wired by the caller. */
  startOldJob(conversationJson: string): Promise<string>;
}): Promise<DriveCase[]> {
  const conversation = JSON.stringify({
    systemPrompt: "You are a terse test assistant.\n\nAnswer in one word.",
    messages: [
      { role: "user", content: "Capital of France?", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Let me count." }, { type: "toolCall", id: "c1", name: "count", arguments: { n: 2 } }],
        api: "offloaded", provider: PROVIDER, model: MODEL, stopReason: "toolUse", timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: "toolResult", toolCallId: "c1", toolName: "count", content: [{ type: "text", text: "1\n2\n" }], isError: false, timestamp: 3 },
    ],
    tools: [{ name: "count", description: "Count from 1 to n", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }],
  });
  const startNewJob = async () => {
    let request = "";
    const models = createModels();
    models.setProvider(durableOffloadedProvider({
      port: { async start(r) { request = JSON.stringify(r); return "mj_new"; }, async poll() { return null; } },
      id: PROVIDER, models: [{ id: MODEL, contextWindow: 100_000 }],
    }));
    const model = models.getModel(PROVIDER, MODEL);
    check(model, "1.0 model not registered");
    const message = await models.stream(model, JSON.parse(conversation), { deferred: true }).result();
    check(message.stopReason === "deferred", `1.0 provider answered ${message.stopReason}`);
    return request;
  };
  return [{
    group: "provider", name: "the same conversation through the 0.85 and 1.0 providers stores the same job context",
    run: async () => {
      const [before, after] = [JSON.parse(await old.startOldJob(conversation)), JSON.parse(await startNewJob())];
      check(show(after.context) === show(before.context), `context differs:\n 0.85 ${show(before.context)}\n 1.0  ${show(after.context)}`);
      check(show(toRequest(after.context)) === show(toRequest(before.context)), "toRequest differs");
      for (const k of ["id", "api", "provider"]) check(before.model[k] === after.model[k], `model.${k}: ${before.model[k]} vs ${after.model[k]}`);
    },
  }];
}
