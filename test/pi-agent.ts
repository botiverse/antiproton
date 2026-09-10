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
      agent.deliver(id, fromResponse({
        text: res.text ?? "", finishReason: res.toolCalls ? "tool_calls" : "stop",
        truncated: false, toolCalls: res.toolCalls,
        usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 },
      } as any, { api: "offloaded", provider: MODEL.provider, id: MODEL.id }));
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
    { toolCalls: [{ id: "c1", name: "lookup", arguments: { q: "cats" } }] });
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
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
