/**
 * The usage and trace outboxes of the `pd` engine (src/runtime/pd-outbox.ts), derived from what
 * pi-durable committed. Run over node:sqlite by test/pd-outbox.ts and on a real Durable Object's
 * storage by cf/src/conformance.ts (test/pd-outbox-do.sh).
 *
 * The parity case runs one scripted conversation through both engines on the same storage — pd first,
 * its rows read and the outboxes emptied, then PiAgent (pi085), which writes its rows inside
 * `Storage.commit` (src/store/pi-storage.ts) — and compares the rows field for field, leaving out only
 * what names an instance (seq, span id) or an instant (at, ms, whose presence is still compared). The
 * worker is the real conversion in both directions (`toRequest` / `fromResponse`); only the model is
 * faked. A "new object" is a new `PdHost` on the same storage: what an eviction leaves.
 */
import { setLogSink } from "../../src/core/log.ts";
import { errorMessage, fromResponse, toRequest, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import type { ModelResponse } from "../../src/model/types.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import { OUTBOX_MARK, type DerivePass } from "../../src/runtime/pd-outbox.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import { statusEvents } from "../../src/runtime/status.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { pendingTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";
import { pendingUsage, type OutboxRow } from "../../src/usage/outbox.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";

const POLL_MS = 200;
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

type Jobs = Array<{ id: string; answer: string | null; created_at: number; answered_at: number | null }>;
const pdJobs = (storage: DurableSqlHost): Jobs =>
  storage.sql.exec("SELECT id, answer, created_at, answered_at FROM ap_model_jobs ORDER BY created_at, rowid").toArray() as unknown as Jobs;

function pdObject(storage: DurableSqlHost, extra: { outboxFault?: (stage: "appended") => void } = {}) {
  const dispatched: string[] = [];
  const passes: DerivePass[] = [];
  const host = new PdHost({ storage, pollAfterMs: POLL_MS, minParkMs: 1, onOutboxPass: (p) => passes.push(p), ...extra });
  const agent = DurableAgent.open({
    host, ...OWNER, model: MODEL, systemPrompt: PROMPT,
    dispatch: async (id) => { dispatched.push(id); },
    unknownJob: (id) => new UnknownJob(id),
  });
  return { host, agent, dispatched, passes };
}
/** How the passes so far compared with pi.usage, those that compared anything. */
const checks = (passes: readonly DerivePass[]) => passes.flatMap((p) => (p.check ? [p.check.state] : []));

/** The worker: the real conversion of the request, then the answer `answer` builds for this job. */
async function consume(agent: DurableAgent, id: string, answer: (model: { api: string; provider: string; id: string }, id: string) => AnsweredMessage) {
  const job = await agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
  check(job, `job ${id} was not handed out`);
  toRequest(job.context);
  check(await agent.deliver(id, answer({ api: job.model.api, provider: job.model.provider, id: job.model.id }, id)) === true, `deliver of ${id} was refused`);
}
const replying = (res: ModelResponse) => (model: { api: string; provider: string; id: string }, id: string) => fromResponse(res, model, id);

/** Step until the turn is over, answering each job as it appears with the next of `answers`. */
async function pdTurn(storage: DurableSqlHost, agent: DurableAgent, say: string, answers: Array<ReturnType<typeof replying>>) {
  await agent.say(say);
  let out = await agent.step();
  for (let guard = 0; out.wakeInMs !== null; guard++) {
    check(guard < 50, `the turn "${say}" did not end: ${show(out)}`);
    const open = pdJobs(storage).find((j) => j.answer === null);
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

async function runPd(storage: DurableSqlHost) {
  const o = pdObject(storage);
  for (const turn of SCRIPT) await pdTurn(storage, o.agent, turn.say, [replying(turn.reply)]);
  return o;
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
        agent.deliver(id, fromResponse(turn.reply, { api: "offloaded", provider: MODEL.provider, id: MODEL.id }, id));
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
/** A row without what names an instance or an instant. */
const usageShape = (r: OutboxRow) => ({ tenantId: r.tenantId, agentId: r.agentId, resource: r.resource, key: r.key, quantity: r.quantity, unit: r.unit });
const traceShape = (r: TraceOutboxRow) => ({
  tenantId: r.tenantId, agentId: r.agentId, kind: r.kind, status: r.status, verdict: r.verdict,
  parentId: r.parentId ?? null, hasMs: typeof r.ms === "number", attrs: r.attrs,
});
const transitions = (rows: readonly TraceOutboxRow[]) => statusEvents(OWNER.agentId, rows).map((e) => e.detail ? `${e.status}|${e.detail}` : e.status);
const mark = (storage: DurableSqlHost) => storage.sql.exec("SELECT through_seq FROM ap_outbox_marks WHERE outbox = ?", OUTBOX_MARK).toArray()[0]?.through_seq ?? null;
/** Pairs of entries whose ids are in the opposite order to their commits: what the id mark relies on being none. */
const inversions = (storage: DurableSqlHost) => Number(storage.sql.exec(
  "SELECT COUNT(*) AS n FROM pd_entries a JOIN pd_entries b ON a.id < b.id AND a.commit_seq > b.commit_seq").toArray()[0]!.n);

/**
 * The storage, with every read the outbox makes of `pd_entries` measured in rows read. On a Durable
 * Object the cursor says (`rowsRead`); node:sqlite does not, so there the statement's plan is asked:
 * a SEARCH on the rowid reads the rows it returns, a SCAN reads the table.
 */
function measured(storage: DurableSqlHost) {
  const reads: number[] = [];
  const exec = storage.sql.exec.bind(storage.sql);
  const sql = {
    exec(query: string, ...bindings: Parameters<DurableSqlHost["sql"]["exec"]>[1][]) {
      const cursor = exec(query, ...bindings);
      if (!/FROM pd_entries WHERE id > \?/.test(query)) return cursor;
      return {
        toArray() {
          const rows = cursor.toArray();
          const counted = (cursor as { rowsRead?: unknown }).rowsRead;
          if (typeof counted === "number") { reads.push(counted); return rows; }
          const plan = exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings).toArray().map((r) => String(r.detail)).join(" ");
          reads.push(/\bSCAN\b/.test(plan) ? Number(exec("SELECT COUNT(*) AS n FROM pd_entries").toArray()[0]!.n) : rows.length);
          return rows;
        },
      };
    },
  } as DurableSqlHost["sql"];
  const host: DurableSqlHost = {
    sql, transactionSync: (closure) => storage.transactionSync(closure),
  };
  return { host, reads };
}

const assistantEntries = (storage: DurableSqlHost) =>
  storage.sql.exec("SELECT COUNT(*) AS n FROM pd_entries WHERE json_extract(record, '$.kind') = 'pi.assistant'").toArray()[0]!.n;

export function pdOutboxCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, body: (host: DurableSqlHost) => Promise<void>) =>
    cases.push({ group, name, run: () => withHost(body) });

  add("parity", "a scripted conversation: exactly the expected usage and trace rows, the same as pi085 writes field for field, with the same status transitions", async (storage) => {
    const o = await runPd(storage);
    const pd = outboxes(storage);
    const jobs = pdJobs(storage);
    check(jobs.length === SCRIPT.length, `pd made ${jobs.length} model calls for ${SCRIPT.length} turns`);
    check(show(pd.usage.map((r) => [r.key, r.quantity])) === show(EXPECTED_USAGE), `pd usage ${show(pd.usage.map((r) => [r.key, r.quantity]))}`);
    check(pd.usage.every((r) => r.tenantId === "t" && r.agentId === "a" && r.resource === "model.tokens" && r.unit === "tokens"), `pd usage ${show(pd.usage)}`);
    check(show(pd.trace.map((r) => [r.status, r.verdict])) === show(EXPECTED_TRACE), `pd trace ${show(pd.trace)}`);
    // Each span joins back to its job, and measures the job's own instants.
    pd.trace.forEach((r, i) => {
      const job = jobs[i]!;
      check(r.kind === "model.call" && r.spanId === job.id && r.ms === job.answered_at! - job.created_at, `pd trace row ${i} ${show(r)} for job ${show(job)}`);
    });
    check(checks(o.passes).length >= SCRIPT.length && checks(o.passes).every((c) => c === "match"), `pi.usage compared ${show(checks(o.passes))}`);
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
    check(Number(storage.sql.exec("SELECT COUNT(*) AS n FROM pd_entries").toArray()[0]!.n) > SCRIPT.length * 2 && inversions(storage) === 0,
      `entry ids out of commit order: ${inversions(storage)} inversions`);
  });

  add("idempotency", "a pass run again derives nothing: no duplicate row, the mark where it was", async (storage) => {
    const o = pdObject(storage);
    await pdTurn(storage, o.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    const before = outboxes(storage);
    const at = mark(storage);
    check(before.usage.length === 4 && before.trace.length === 1 && typeof at === "number" && at > 0, `after the turn: ${show(before)}, mark ${at}`);
    for (let i = 0; i < 2; i++) {
      const pass = await o.host.deriveOutbox();
      check(pass && pass.entries === 0 && pass.usage === 0 && pass.trace === 0 && pass.through === at, `pass ${i}: ${show(pass)}`);
    }
    // A new object on the same storage is the case that matters: nothing in memory says what was derived.
    const again = pdObject(storage);
    const pass = await again.host.deriveOutbox();
    check(pass && pass.entries === 0 && pass.through === at, `a new object's pass: ${show(pass)}`);
    check(show(outboxes(storage)) === show(before), `rows changed: ${show(outboxes(storage))}`);
    await o.agent.close();
  });

  add("cost", "a pass reads only the entries committed since the last one, not the table: 2,000 entries before, a few rows after", async (storage) => {
    const { host, reads } = measured(storage);
    const o = pdObject(host);
    await pdTurn(host, o.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    // 2,000 more entries, committed as pi-durable commits them: one sequence, ids past the counter, the
    // counter and the sequence moved. In a conversation nothing reads, so the turns below are unchanged.
    const FILLER = 2_000;
    const meta = storage.sql.exec("SELECT next_id, next_seq FROM pd_durable_metadata").toArray()[0]!;
    const firstId = Number(meta.next_id), seq = Number(meta.next_seq);
    for (let i = 0; i < FILLER; i++) {
      const id = firstId + i;
      storage.sql.exec("INSERT INTO pd_record_ids (id, record_type) VALUES (?, 'entry')", id);
      storage.sql.exec("INSERT INTO pd_entries (id, conversation_id, head, commit_seq, record) VALUES (?, 999999, NULL, ?, ?)",
        id, seq, JSON.stringify({ id, conversationId: 999999, kind: "test.filler", data: { i } }));
    }
    storage.sql.exec("UPDATE pd_durable_metadata SET next_id = ?, next_seq = ?", String(firstId + FILLER), seq + 1);
    reads.length = 0;
    const catchUp = await o.host.deriveOutbox();
    // The control: the measurement does see a read of the filler, so a small number below is not blindness.
    check(catchUp?.through === seq && reads.reduce((a, b) => a + b, 0) >= FILLER, `the pass over the filler read ${show(reads)}: ${show(catchUp)}`);
    reads.length = 0;
    const usageBefore = outboxes(storage).usage.length;
    await pdTurn(host, o.agent, "Q2", [replying(SCRIPT[2]!.reply)]);
    const total = reads.reduce((a, b) => a + b, 0);
    check(reads.length > 0 && total <= 20, `the passes of a turn after ${FILLER} entries read ${total} rows (${show(reads)})`);
    check(show(outboxes(storage).usage.slice(usageBefore).map((r) => [r.key, r.quantity])) === show(EXPECTED_USAGE.slice(7)),
      `the turn's usage ${show(outboxes(storage).usage.slice(usageBefore))}`);
    check(inversions(storage) === 0, `entry ids out of commit order: ${inversions(storage)} inversions`);
    await o.agent.close();
  });

  add("crash", "a crash between pi-durable's commit and the pass: nothing is half-written, and the next object derives the rows once", async (storage) => {
    let faults = 0;
    const crashed = pdObject(storage, { outboxFault: () => { faults++; throw new Error("the object died here"); } });
    await pdTurn(storage, crashed.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    await crashed.agent.close();
    // The fault fires after the rows are appended: every pass reached it, and each one left nothing.
    check(faults > 0, "control: the fault never fired, so nothing was tested");
    check(assistantEntries(storage) === 1, `pi-durable committed ${assistantEntries(storage)} answers`);
    const left = outboxes(storage);
    check(left.usage.length === 0 && left.trace.length === 0 && mark(storage) === null, `a failed pass left ${show(left)}, mark ${mark(storage)}`);

    const next = pdObject(storage);
    const out = await next.agent.step();
    check(out.wakeInMs === null, `the turn is over: ${show(out)}`);
    const rows = outboxes(storage);
    check(show(rows.usage.map((r) => [r.key, r.quantity])) === show(EXPECTED_USAGE.slice(0, 4)), `usage after recovery ${show(rows.usage)}`);
    check(show(rows.trace.map((r) => [r.status, r.spanId])) === show([["stop", pdJobs(storage)[0]!.id]]), `trace after recovery ${show(rows.trace)}`);
    await next.host.deriveOutbox();
    check(show(outboxes(storage)) === show(rows), "a second pass after recovery added rows");
    await next.agent.close();
  });

  add("trigger", "a pass runs on pi-durable's commit, not only at the end of a step", async (storage) => {
    const o = pdObject(storage);
    await o.agent.say("Q1");
    const parked = await o.agent.step();
    check(parked.wakeInMs !== null, `step: ${show(parked)}`);
    await consume(o.agent, pdJobs(storage)[0]!.id, replying(SCRIPT[0]!.reply));
    await sleep(parked.wakeInMs);
    // The host's drive, without the step's own pass after it.
    await o.host.drive();
    for (let i = 0; i < 100 && outboxes(storage).trace.length === 0; i++) await sleep(5);
    check(outboxes(storage).trace.length === 1, `no pass ran after the commit: ${show(outboxes(storage))}`);
    await o.agent.close();
  });

  add("pi.usage", "a failed attempt pi-durable retries is billed and traced, and pi.usage counts it too", async (storage) => {
    const o = pdObject(storage);
    const failed = (model: { api: string; provider: string; id: string }, id: string): AnsweredMessage => ({
      ...errorMessage("503 service unavailable", model), usage: { ...fromResponse(SCRIPT[0]!.reply, model).usage, input: 11, output: 0, cacheRead: 0, reasoning: undefined, totalTokens: 11 }, jobId: id,
    } as AnsweredMessage);
    await pdTurn(storage, o.agent, "Q1", [failed, replying(SCRIPT[0]!.reply)]);
    const rows = outboxes(storage);
    check(pdJobs(storage).length === 2, `jobs ${pdJobs(storage).length}: the failed attempt was not retried`);
    check(show(rows.trace.map((r) => r.status)) === show(["error", "stop"]), `trace ${show(rows.trace)}`);
    check(show(rows.usage.map((r) => [r.key, r.quantity])) === show([["m1:input", 11], ...EXPECTED_USAGE.slice(0, 4)]), `usage ${show(rows.usage)}`);
    const sums = storage.sql.exec("SELECT v FROM ap_meta WHERE k = 'outbox.usage'").toArray()[0];
    check(sums && JSON.parse(String(sums.v)).models["queue/m1"].input === 131, `derived totals ${show(sums)}`);
    // Every pass that compared, from the failed attempt's commit on, agreed with pi.usage.
    check(checks(o.passes).length >= 2 && checks(o.passes).every((c) => c === "match"), `pi.usage compared ${show(checks(o.passes))}`);
    await o.agent.close();
  });

  add("pi.usage", "a disagreement with pi.usage is a structured warning, and the rows are left as derived", async (storage) => {
    const o = pdObject(storage);
    await pdTurn(storage, o.agent, "Q1", [replying(SCRIPT[0]!.reply)]);
    await o.agent.close();
    check(checks(o.passes).every((c) => c === "match"), `control: before the damage ${show(checks(o.passes))}`);
    // Damage our side of the comparison: the totals say fewer input tokens than pi-durable counted.
    const totals = JSON.parse(String(storage.sql.exec("SELECT v FROM ap_meta WHERE k = 'outbox.usage'").toArray()[0]!.v));
    totals.models["queue/m1"].input -= 1;
    storage.sql.exec("UPDATE ap_meta SET v = ? WHERE k = 'outbox.usage'", JSON.stringify(totals));
    const before = outboxes(storage);
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      await o.agent.say("Q2");
      await o.host.deriveOutbox();
    } finally { setLogSink(null); }
    check(checks(o.passes).at(-1) === "mismatch", `the pass did not see it: ${show(checks(o.passes))}`);
    const warned = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "pd.outbox.usage_mismatch");
    check(warned.length >= 1 && warned[0].tenantId === "t" && warned[0].agentId === "a" && typeof warned[0].through === "number"
      && JSON.parse(warned[0].derived).models["queue/m1"].input === 119 && JSON.parse(warned[0].counted).models["queue/m1"].input === 120,
    `log ${show(lines)}`);
    check(show(outboxes(storage)) === show(before), "a mismatch changed the rows");
    await o.agent.close();
  });

  return cases;
}
