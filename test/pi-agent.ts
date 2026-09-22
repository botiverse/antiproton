/**
 * The whole object-side path, with a fake worker standing in for the queue.
 *
 * This is the shape the Durable Object runs: a message is accepted as a pure
 * write, an alarm calls step(), step() suspends rather than waiting, the worker
 * answers, and the next step() finishes the run. The assertion that matters
 * most is negative — no step() ever waits for the model, because that is what
 * the object is billed for.
 */
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { MountedTool } from "../src/runtime/pi-tools.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 500) }); }
}

const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
const TOOLS: MountedTool[] = [{
  name: "lookup", description: "look something up", address: "demo.lookup",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  sideEffects: "read", idempotency: "none",
}];

/** Everything the worker does: take the job, answer it, hand it back. */
function worker(agent: PiAgent) {
  const seen: any[] = [];
  return {
    seen,
    pending(host: ReturnType<typeof sqliteHost>) {
      return host.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray() as any[];
    },
    answer(id: string, res: Partial<{ text: string; toolCalls: any[] }>) {
      const request = agent.takeJob(id);
      if (!request) throw new Error(`job ${id} was not available`);
      seen.push(request);
      // Like the worker: the answer names the job that produced it.
      agent.deliver(id, fromResponse({
        text: res.text ?? "", finishReason: res.toolCalls ? "tool_calls" : "stop",
        truncated: false, toolCalls: res.toolCalls,
        usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 },
      } as any, { api: "offloaded", provider: MODEL.provider, id: MODEL.id }, id));
    },
  };
}

async function fixture(invoke?: (c: any) => Promise<any>) {
  const host = sqliteHost();
  const dispatched: string[] = [];
  const calls: any[] = [];
  const agent = await PiAgent.open({
    host, sessionId: "s", systemPrompt: "be brief", model: MODEL,
    tools: TOOLS,
    toolHost: { async invoke(c) { calls.push(c); return invoke ? invoke(c) : { status: "succeeded", result: { ok: true } }; } },
    async dispatch(id) { dispatched.push(id); },
  });
  return { host, agent, dispatched, calls, w: worker(agent) };
}

await check("说一句话是纯写入,step 之前模型还没被叫", async () => {
  const f = await fixture();
  await f.agent.say("hello");
  if (f.w.pending(f.host).length !== 0) throw new Error("a job existed before any drive");
  await f.agent.close();
});

await check("空闲时发 steer 也会启动一轮,而不是石沉大海", async () => {
  const f = await fixture();
  // The page sends every message as a steer, because usually the agent is
  // working. On an idle lane that used to queue against a run that never
  // started, and the first thing anyone typed vanished.
  await f.agent.say("hello", "steer");
  const out = await f.agent.step();
  if (out.open !== 1) throw new Error("a steer on an idle lane started nothing");
  if (f.w.pending(f.host).length !== 1) throw new Error("no model call was made");

  // And while a run is in flight a second message joins it rather than
  // starting a rival run — the lane refuses, and that refusal is the signal.
  const before = (await f.agent.lane.inspectExecution(CTX)).current?.id;
  await f.agent.say("also this", "prompt");
  const after = (await f.agent.lane.inspectExecution(CTX)).current?.id;
  if (!before || after !== before) throw new Error("a message during a run started a second run");

  f.w.answer(f.w.pending(f.host)[0]!.id, { text: "ok" });
  await f.agent.step();
  await f.agent.close();
});

await check("step 挂起而不是等待,并把活派给队列", async () => {
  const f = await fixture();
  await f.agent.say("hello");
  const out = await f.agent.step();
  if (out.open !== 1) throw new Error(`expected one open operation, got ${out.open}`);
  if (out.wakeInMs === null) throw new Error("nothing scheduled a wake");
  const jobs = f.w.pending(f.host);
  if (jobs.length !== 1) throw new Error(`expected one job, got ${jobs.length}`);
  if (f.dispatched.length !== 1) throw new Error(`job not dispatched: ${f.dispatched.length}`);
  await f.agent.close();
});

await check("工具轮次:模型要工具,工具走 gateway,再问一次模型,收尾", async () => {
  const f = await fixture();
  await f.agent.say("look up cats");
  await f.agent.step();

  f.w.answer(f.w.pending(f.host)[0]!.id,
    // The name the harness registered, which is mount-qualified: the model can
    // only call what it was offered.
    { toolCalls: [{ id: "c1", name: "demo__lookup", arguments: { q: "cats" } }] });
  const second = await f.agent.step();
  if (f.calls.length !== 1) throw new Error(`gateway not reached: ${f.calls.length}`);
  if (f.calls[0].tool !== "demo.lookup") throw new Error(`wrong address ${f.calls[0].tool}`);
  if (second.open !== 1) throw new Error("the run should still be going after the tool");

  f.w.answer(f.w.pending(f.host)[0]!.id, { text: "cats are fine" });
  const third = await f.agent.step();
  if (third.open !== 0) throw new Error(`run did not finish: open=${third.open}`);
  if (third.settled[0]?.status !== "completed") {
    throw new Error(`unexpected status ${JSON.stringify(third.settled)}`);
  }
  const entries = await f.agent.storage.scanEntries({ order: "asc" }, CTX);
  if (!JSON.stringify(entries).includes("cats are fine")) throw new Error("the answer is not in the log");
  await f.agent.close();
});

await check("模型还没答完时,重复的 step 不会把 transcript 撑大", async () => {
  const f = await fixture();
  await f.agent.say("hello");
  await f.agent.step();
  const afterFirst = (await f.agent.storage.scanEntries({ order: "asc" }, CTX)).length;

  // Twenty passes while the answer is still out. pi records what the provider
  // says, and "not ready yet" is something it said — which is right for a real
  // batch API, where asking is the only way to find out. Here the provider is a
  // table in this object, so a pass that has nothing to collect must not ask,
  // or a long run pays for its own waiting twice: once in rows, and again in
  // every prompt built from them.
  for (let i = 0; i < 20; i++) await f.agent.step();
  const afterPolls = (await f.agent.storage.scanEntries({ order: "asc" }, CTX)).length;
  if (afterPolls > afterFirst) throw new Error(`20 passes added ${afterPolls - afterFirst} entries`);

  // And once the answer is in, the very next pass collects it.
  f.w.answer(f.w.pending(f.host)[0]!.id, { text: "collected" });
  const out = await f.agent.step();
  if (out.open !== 0) throw new Error("the answer was not collected on the next pass");
  const entries = await f.agent.storage.scanEntries({ order: "asc" }, CTX);
  if (!JSON.stringify(entries).includes("collected")) throw new Error("the answer never landed");
  await f.agent.close();
});

await check("模型还在跑的时候,不会被重复派单", async () => {
  // A duplicate dispatch is not a harmless retry. `takeJob` refuses a job only
  // once it has an answer, so a second worker picks up a call that is still
  // running and asks the provider again — and the losing answer's tokens are
  // billed all the same. One τ² run sent eleven calls fifty-one times.
  let clock = 1_700_000_000_000;
  const host = sqliteHost();
  const dispatched: string[] = [];
  const agent = await PiAgent.open({
    host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: TOOLS,
    toolHost: { async invoke() { return { status: "succeeded", result: {} }; } },
    async dispatch(id) { dispatched.push(id); },
    now: () => clock,
  });
  await agent.say("hello");
  await agent.step();
  if (dispatched.length !== 1) throw new Error(`first pass sent ${dispatched.length}`);

  for (let i = 0; i < 20; i++) { clock += 1_000; await agent.step(); }
  if (dispatched.length !== 1) {
    throw new Error(`20 passes over 20s re-sent a call in flight ${dispatched.length - 1} times`);
  }

  // The sweep still exists for the case it was written for: an answer that
  // never comes at all, because the object died between the write and the send
  // or the queue lost the message.
  clock += 121_000;
  await agent.step();
  if (dispatched.length !== 2) throw new Error("a silent call was never reclaimed");

  const jobs = host.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray() as any[];
  if (jobs.length !== 1) throw new Error(`re-sending made ${jobs.length} jobs out of one`);
  worker(agent).answer(jobs[0]!.id, { text: "done" });
  if ((await agent.step()).open !== 0) throw new Error("did not settle after the answer");
  await agent.close();
});

await check("等一个会被送来的答案时,闹钟不再每秒醒一次", async () => {
  // The alarm's delay is this number. Waking every second to ask whether the
  // model has answered was 55 alarm passes for 11 calls, all of them billed —
  // and every one of them asked a question the worker was about to answer
  // unprompted.
  const f = await fixture();
  await f.agent.say("hello");
  const out = await f.agent.step();
  if (out.open !== 1) throw new Error("nothing was left in flight");
  if ((out.wakeInMs ?? 0) < 30_000) {
    throw new Error(`the object rearms after ${out.wakeInMs}ms while the queue holds the call`);
  }
  await f.agent.close();
});

await check("对象被驱逐:重新 open 后接着跑完", async () => {
  const f = await fixture();
  await f.agent.say("hello");
  await f.agent.step();
  const jobId = f.w.pending(f.host)[0]!.id;
  await f.agent.close();

  // A second PiAgent over the same database, which is every wake.
  const again = await PiAgent.open({
    host: f.host, sessionId: "s", systemPrompt: "be brief", model: MODEL,
    tools: TOOLS, toolHost: { async invoke() { return { status: "succeeded", result: {} }; } },
    async dispatch() {},
  });
  if (again.openOnWake.length !== 1) {
    throw new Error(`the suspended run was not reported: ${JSON.stringify(again.openOnWake)}`);
  }
  worker(again).answer(jobId, { text: "answered after a restart" });
  const out = await again.step();
  if (out.open !== 0) throw new Error("did not finish after the restart");
  const entries = await again.storage.scanEntries({ order: "asc" }, CTX);
  if (!JSON.stringify(entries).includes("answered after a restart")) {
    throw new Error("the answer was lost across the restart");
  }
  await again.close();
});

console.log(`\n  The object-side loop\n  ${"─".repeat(56)}`);
await check("取消一轮:模型调用被丢掉,留下一条点名这一轮的标记;空闲时取消什么也不报;之后还能再说话", async () => {
  const f = await fixture();
  await f.agent.say("hello");
  await f.agent.step();
  if (f.w.pending(f.host).length !== 1) throw new Error("no model call to cancel");
  const cancelled = await f.agent.cancel("test.turn_cancelled");
  if (!cancelled) throw new Error("a running turn was not cancelled");
  if ((await f.agent.lane.inspectExecution(CTX)).current !== null) throw new Error("the run is still current after cancel");
  const jobs = f.host.sql.exec("SELECT COUNT(*) AS n FROM pi_model_jobs").toArray()[0] as any;
  if (Number(jobs.n) !== 0) throw new Error("the model call was left out, so its answer could still land");
  const entries = await f.agent.storage.scanEntries({ order: "asc" }, CTX) as any[];
  const marker = entries.find((e) => e.type === "custom" && e.customType === "test.turn_cancelled");
  if (!marker || marker.data?.operationId !== cancelled) throw new Error(`no marker naming the run: ${JSON.stringify(marker)}`);
  if ((await f.agent.cancel("test.turn_cancelled")) !== null) throw new Error("cancelling an idle lane reported a cancellation");
  await f.agent.say("again");
  await f.agent.step();
  if (f.w.pending(f.host).length !== 1) throw new Error("the lane took no new prompt after the cancel");
  await f.agent.close();
});

await check("取消标记若被投射,下一轮模型请求里就有那句说明,被取消的请求不会被当成还没做完", async () => {
  const host = sqliteHost();
  const agent = await PiAgent.open({
    host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: TOOLS,
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch() {},
    entryProjectors: { "test.turn_cancelled": (e) => [{ role: "user", content: [{ type: "text", text: "NOTE: cancelled" }], timestamp: e.timestamp }] },
  });
  const w = worker(agent);
  await agent.say("write a long story");
  await agent.step();
  if (!(await agent.cancel("test.turn_cancelled"))) throw new Error("nothing was cancelled");
  await agent.say("just say OK");
  await agent.step();
  const job = w.pending(host)[0];
  if (!job) throw new Error("no model call after the new prompt");
  const request: any = agent.takeJob(String(job.id));
  const texts = (request?.context?.messages ?? []).map((m: any) => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : String(m.content)));
  const at = (needle: string) => texts.findIndex((t: string) => t.includes(needle));
  if (at("NOTE: cancelled") < 0) throw new Error(`the note is not in the model's context: ${JSON.stringify(texts)}`);
  if (!(at("write a long story") < at("NOTE: cancelled") && at("NOTE: cancelled") < at("just say OK"))) {
    throw new Error(`the note is not between the cancelled request and the new one: ${JSON.stringify(texts)}`);
  }
  await agent.close();
});

await check("落库的最终条目写着是哪个 job 答的它", async () => {
  // The spine's first link, measured on the real commit path: the answer is
  // delivered with the job id, pi assembles and commits the final entry from
  // it, and the stored body must still say the id. Red if the field is
  // dropped anywhere between deliver and the entry table.
  const f = await fixture();
  await f.agent.say("hello");
  await f.agent.step();
  const [job] = f.w.pending(f.host);
  if (!job) throw new Error("no job was queued");
  f.w.answer(job.id, { text: "done" });
  for (let i = 0; i < 5 && (await f.agent.step()).open !== 0; i++) { /* settle */ }
  const bodies = (f.host.sql.exec("SELECT body FROM pi_entries ORDER BY seq").toArray() as any[])
    .map((r) => JSON.parse(String(r.body)));
  const answered = bodies.filter((b) => b?.message?.role === "assistant" && b.message.stopReason !== "deferred");
  if (answered.length !== 1) throw new Error(`expected one answered entry, found ${answered.length}`);
  if (answered[0].message.jobId !== job.id) {
    throw new Error(`the stored answer names ${JSON.stringify(answered[0].message.jobId)}, not job ${job.id}`);
  }
  const placeholders = bodies.filter((b) => b?.message?.stopReason === "deferred");
  if (!placeholders.length) throw new Error("no placeholder entry was recorded for the call");
  await f.agent.close();
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
