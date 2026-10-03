/**
 * A model-call message whose job id the agent holds no row for. The runtime used to read that as the
 * main session's job, where `takeJob` found nothing and the message was acked as "already answered"
 * with no trace. Now the runtime throws `UnknownJob`, the object answers it as a value, and the
 * consumer acks and logs it rather than delivering or retrying. A job the agent does hold behaves as
 * before. The runtime is the real one over sqlite; the stub stands in for the object's RPC methods
 * with the same translation the object uses (`replyingUnknownJob`).
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent } from "../cf/src/provision/steps.ts";
import {
  UnknownJob, consumeModelCalls, isUnknownJobReply, replyingUnknownJob,
  type ModelJobStub, type ModelQueueDeps, type ModelQueueMessage, type QueuedModelCall,
} from "../cf/src/model-queue.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { MAIN_SESSION } from "../src/store/pi-storage.ts";
import { ensureAgentTables } from "../src/runtime/pi-agent.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const T = "t", A = "agent-1", SESSION = "conv-a";
const REQUEST = { model: { api: "offloaded", provider: "openai-compatible", id: "m" }, context: { messages: [] } };

async function runtime() {
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "deepseek-flash" },
  } as any);
  await rt.ready();
  // An agent with a model binding, as provisioning makes one: the runtime opens a session only for that.
  const adopted = await adoptProvisionedAgent(rt, T, A, { name: "Cody", instructions: "", raftOrigin: "https://raft.example", avatar: "0badcafe" });
  if (!adopted.ok) throw new Error(`adopt: ${adopted.error}`);
  // Which sessions the runtime opens, so a fallback to the main one is visible.
  const opened: string[] = [];
  const agent = rt.agent.bind(rt);
  rt.agent = (tenantId: string, agentId: string, session?: string) => {
    opened.push(session ?? MAIN_SESSION);
    return agent(tenantId, agentId, session);
  };
  const addJob = (id: string, session: string) => (ensureAgentTables(host.sql, session), host.sql.exec(
    "INSERT INTO pi_model_jobs(id, request, created_at, session) VALUES (?,?,?,?)", id, JSON.stringify(REQUEST), Date.now(), session));
  const answerOf = (id: string) =>
    (host.sql.exec("SELECT answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as { answer: string | null } | undefined)?.answer;
  return { rt, host, opened, addJob, answerOf };
}

/** The object's two RPC methods over a real runtime, translated as the object does. */
function stubOver(rt: AgentRuntime, calls: string[]): ModelJobStub {
  return {
    takeJob: (t, a, j, taker) => { calls.push(`take ${j}`); return replyingUnknownJob(() => rt.takeJob(t, a, j, taker)); },
    releaseJob: (t, a, j, taker) => { calls.push(`release ${j}`); return replyingUnknownJob(() => rt.releaseJob(t, a, j, taker)); },
    deliverAnswer: (t, a, j, answer) => { calls.push(`deliver ${j}`); return replyingUnknownJob(() => rt.deliverAnswer(t, a, j, answer)); },
  };
}

function message(jobId: string) {
  const m = { acked: 0, retried: 0 };
  const msg: ModelQueueMessage = {
    body: { doId: "do-1", tenantId: T, agentId: A, jobId },
    ack() { m.acked++; },
    retry() { m.retried++; },
  };
  return { msg, m };
}

function deps(stub: ModelJobStub, providerCalls: string[]): ModelQueueDeps {
  return {
    stub: () => stub,
    async call(_job: unknown, m: QueuedModelCall) {
      providerCalls.push(m.jobId);
      return { role: "assistant", content: [{ type: "text", text: "hi" }], jobId: m.jobId };
    },
    givenUp: (m: QueuedModelCall) => ({ role: "assistant", content: [], stopReason: "error", jobId: m.jobId }),
  };
}

function captureLog() {
  const lines: Array<Record<string, unknown>> = [];
  setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return lines;
}

await check("runtime: an unknown job id throws UnknownJob on take and on deliver, and never opens the main session", async () => {
  const { rt, host, opened, addJob } = await runtime();
  // First with no jobs table at all, then with one that holds another job.
  must(host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'pi_model_jobs'").toArray().length === 0, "the jobs table already exists");
  for (const op of ["take", "deliver", "addJob", "take", "deliver"] as const) {
    if (op === "addJob") { addJob("job-other", SESSION); continue; }
    let thrown: unknown = null;
    try {
      if (op === "take") await rt.takeJob(T, A, "job-missing");
      else await rt.deliverAnswer(T, A, "job-missing", { role: "assistant", content: [] });
    } catch (e) { thrown = e; }
    must(thrown instanceof UnknownJob && thrown.jobId === "job-missing", `${op}: ${String(thrown)}`);
  }
  must(opened.length === 0, `sessions opened for an unknown job: ${opened.join(",")}`);
  host.dispose();
});

await check("runtime: a known job is taken and answered in its own session, unchanged", async () => {
  const { rt, host, opened, addJob, answerOf } = await runtime();
  addJob("job-a", SESSION);
  const job = await rt.takeJob(T, A, "job-a") as Record<string, unknown> | null;
  must(job && JSON.stringify(job.model) === JSON.stringify(REQUEST.model) && "operatorModel" in job, JSON.stringify(job));
  must(await rt.deliverAnswer(T, A, "job-a", { role: "assistant", content: [], jobId: "job-a" }) === true, "deliver did not write");
  must(answerOf("job-a"), "no answer on the row");
  must(await rt.takeJob(T, A, "job-a") === null, "an answered job was taken again");
  must(await rt.deliverAnswer(T, A, "job-a", { role: "assistant", content: [] }) === false, "an answered job was answered twice");
  must(opened.length === 4 && opened.every((s) => s === SESSION), `sessions opened: ${opened.join(",")}`);
  host.dispose();
});

await check("consumer: an unknown job id is acked and logged with job, tenant and agent; not delivered, not retried, no provider call", async () => {
  const { rt, host, opened } = await runtime();
  const lines = captureLog();
  const calls: string[] = [], provider: string[] = [];
  const { msg, m } = message("job-missing");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stubOver(rt, calls), provider));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-missing", `stub calls: ${calls.join("|")}`);
  must(provider.length === 0, "the provider was called");
  must(opened.length === 0, `sessions opened: ${opened.join(",")}`);
  const line = lines.find((l) => l.evt === "model_job.unknown");
  must(line && line.jobId === "job-missing" && line.tenantId === T && line.agentId === A && line.phase === "take", JSON.stringify(lines));
  host.dispose();
});

await check("consumer: an unknown job id on the dead letter queue is acked and logged, and given up on nothing", async () => {
  const { rt, host } = await runtime();
  const lines = captureLog();
  const calls: string[] = [];
  const { msg, m } = message("job-missing");
  await consumeModelCalls({ queue: "model-calls-dlq", messages: [msg] }, deps(stubOver(rt, calls), []));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-missing", `stub calls: ${calls.join("|")}`);
  must(lines.some((l) => l.evt === "model_job.unknown" && l.jobId === "job-missing" && l.phase === "give_up"), JSON.stringify(lines));
  host.dispose();
});

await check("consumer: a job that disappears between take and deliver is acked and logged, not retried", async () => {
  const { rt, host, addJob } = await runtime();
  addJob("job-a", SESSION);
  const lines = captureLog();
  const calls: string[] = [];
  const inner = stubOver(rt, calls);
  const stub: ModelJobStub = {
    takeJob: inner.takeJob,
    releaseJob: inner.releaseJob,
    async deliverAnswer(t, a, j, answer, ms) {
      host.sql.exec("DELETE FROM pi_model_jobs WHERE id = ?", j); // cancelled while the provider ran
      return inner.deliverAnswer(t, a, j, answer, ms);
    },
  };
  const { msg, m } = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stub, []));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(lines.some((l) => l.evt === "model_job.unknown" && l.jobId === "job-a" && l.phase === "deliver"), JSON.stringify(lines));
  host.dispose();
});

await check("consumer: a known job is taken, called and delivered into its session, then acked; nothing is logged as unknown", async () => {
  const { rt, host, addJob, answerOf, opened } = await runtime();
  addJob("job-a", SESSION);
  const lines = captureLog();
  const calls: string[] = [], provider: string[] = [];
  const { msg, m } = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stubOver(rt, calls), provider));
  setLogSink(null);
  must(m.acked === 1 && m.retried === 0, JSON.stringify(m));
  must(calls.join("|") === "take job-a|deliver job-a" && provider.join() === "job-a", `${calls.join("|")} / ${provider.join()}`);
  must(answerOf("job-a")?.includes("\"hi\""), `answer: ${answerOf("job-a")}`);
  must(opened.every((s) => s === SESSION), `sessions opened: ${opened.join(",")}`);
  must(!lines.some((l) => l.evt === "model_job.unknown"), JSON.stringify(lines));
  // A redelivery after success: taken as null, acked, no provider call, nothing logged.
  const again = message("job-a");
  await consumeModelCalls({ queue: "model-calls", messages: [again.msg] }, deps(stubOver(rt, calls), provider));
  must(again.m.acked === 1 && provider.length === 1, `${JSON.stringify(again.m)} / ${provider.join()}`);
  host.dispose();
});

await check("consumer: each attempt, giving up too, takes under a fresh name; a failed one releases that name and is retried", async () => {
  const log: string[] = [];
  const stub: ModelJobStub = {
    async takeJob(_t, _a, _j, taker) { log.push(`take ${taker}`); return REQUEST; },
    async releaseJob(_t, _a, _j, taker) { log.push(`release ${taker}`); return true; },
    async deliverAnswer() { log.push("deliver"); return true; },
  };
  const failing: ModelQueueDeps = { ...deps(stub, []), async call() { throw new Error("provider 503"); } };
  const { msg, m } = message("job-a");
  const err = console.error; console.error = () => {};
  try {
    await consumeModelCalls({ queue: "model-calls", messages: [msg, msg] }, failing);
    await consumeModelCalls({ queue: "model-calls-dlq", messages: [msg] }, deps(stub, []));
  } finally { console.error = err; }
  must(m.retried === 2 && m.acked === 1, JSON.stringify(m));
  const names = log.map((l) => l.split(" ")[1]);
  must(log.map((l) => l.split(" ")[0]).join("|") === "take|release|take|release|take|deliver", log.join("|"));
  must(names[0] && names[0] === names[1] && names[2] === names[3] && names[0] !== names[2] && names[4] && names[4] !== names[0] && names[4] !== names[2],
    `takers ${log.join("|")}`);
});

await check("consumer: any other failure is still retried, not acked", async () => {
  const stub: ModelJobStub = {
    async takeJob() { throw new Error("object unavailable"); },
    async releaseJob() { return true; },
    async deliverAnswer() { return true; },
  };
  const { msg, m } = message("job-a");
  const err = console.error; console.error = () => {};
  try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps(stub, [])); }
  finally { console.error = err; }
  must(m.acked === 0 && m.retried === 1, JSON.stringify(m));
});

await check("the reply shape is recognised and nothing else is", async () => {
  must(isUnknownJobReply({ unknownJob: "j" }), "reply not recognised");
  for (const v of [null, false, true, {}, { unknownJob: 1 }, REQUEST]) must(!isUnknownJobReply(v), `misread ${JSON.stringify(v)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
