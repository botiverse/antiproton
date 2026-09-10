/**
 * The object must not wait for the model.
 *
 * Durable Objects bill wall clock with no exemption for network I/O, so a
 * Durable Object that awaits a completion is paying for the provider's latency.
 * That is why the model call leaves the object, and it is the one property that
 * adopting pi's loop must not cost us — pi's `drive()` calls the model itself.
 *
 * What makes the two compatible is pi's deferred protocol: a provider may answer
 * `stopReason: "deferred"` with a handle, the harness suspends the operation
 * durably, and the caller is free to stop. These cases assert exactly that
 * sequence, because if it does not hold the whole design is wrong.
 */
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { offloadedProvider, type OffloadPort } from "../src/model/pi-offloaded.ts";
import { sqliteHost } from "./sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 500) }); }
}

const PROVIDER = "queue";
const MODEL = "test-model";

/** Stands in for the queue: a job is started, and answers only when told. */
function fakeQueue() {
  const started: string[] = [];
  const answers = new Map<string, AssistantMessage>();
  let n = 0;
  const port: OffloadPort = {
    async start() { const id = `job-${++n}`; started.push(id); return id; },
    async poll(id) { return answers.get(id) ?? null; },
  };
  return {
    port, started,
    deliver(id: string, text: string) {
      answers.set(id, {
        role: "assistant", content: [{ type: "text", text }],
        api: "offloaded", provider: PROVIDER, model: MODEL,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      });
    },
  };
}

async function fixture() {
  const q = fakeQueue();
  const host = sqliteHost();
  const storage = new PiSqliteStorage(host);
  const session = new StorageBackedSession(
    { id: "s1", createdAt: Date.now(), storageVersion: 1 }, storage as any);
  const models = createModels();
  models.setProvider(offloadedProvider({
    port: q.port, id: PROVIDER, models: [{ id: MODEL, contextWindow: 128_000 }], pollAfterMs: 10,
  }));
  const { harness } = await AgentHarness.create({
    session: session as any,
    models,
    model: models.getModel(PROVIDER, MODEL)!,
    systemPrompt: "you are a test",
    streamOptions: { deferred: true },
  }, CTX);
  return { q, host, storage, harness, lane: await harness.lane("main", CTX) };
}

const unwrap = (r: any, what: string) => {
  if (r?.ok === false || r?.error) throw new Error(`${what} failed: ${JSON.stringify(r).slice(0, 300)}`);
  return r.value ?? r;
};

await check("模型没答之前,drive 返回 waiting 而不是阻塞", async () => {
  const f = await fixture();
  const admitted = unwrap(await f.lane.accept({ kind: "prompt", prompt: "hello" }, CTX), "accept");
  const out = unwrap(await f.lane.drive({ operationId: admitted.operationId }, CTX), "drive");
  if (out.kind !== "waiting" || out.reason !== "deferred") {
    throw new Error(`expected to suspend, got ${JSON.stringify(out).slice(0, 200)}`);
  }
  if (f.q.started.length !== 1) throw new Error(`the job did not reach the queue: ${f.q.started.length}`);
  await f.harness.close(CTX);
});

await check("答案回来后,同一个 operation 接着跑完", async () => {
  const f = await fixture();
  const admitted = unwrap(await f.lane.accept({ kind: "prompt", prompt: "hello" }, CTX), "accept");
  const first = unwrap(await f.lane.drive({ operationId: admitted.operationId }, CTX), "drive");
  if (first.kind !== "waiting") throw new Error("expected a suspend first");

  f.q.deliver(f.q.started[0]!, "the answer");
  const second = unwrap(
    await f.lane.drive({ operationId: admitted.operationId, pollDeferred: true }, CTX), "drive");
  if (second.kind !== "settled") {
    throw new Error(`expected to settle, got ${JSON.stringify(second).slice(0, 300)}`);
  }
  if (second.outcome.status !== "completed") {
    throw new Error(`operation did not complete: ${JSON.stringify(second.outcome).slice(0, 200)}`);
  }
  const entries = await f.storage.scanEntries({ order: "asc" }, CTX);
  if (!JSON.stringify(entries).includes("the answer")) {
    throw new Error("the delivered answer never became an entry");
  }
  await f.harness.close(CTX);
});

await check("挂起是持久的:对象被驱逐也接得回来", async () => {
  const f = await fixture();
  const admitted = unwrap(await f.lane.accept({ kind: "prompt", prompt: "hello" }, CTX), "accept");
  await f.lane.drive({ operationId: admitted.operationId }, CTX);
  await f.harness.close(CTX);

  // The queue answers while nothing is awake, then a rebuilt harness picks the
  // operation up from storage. This is the wake path in one test.
  f.q.deliver(f.q.started[0]!, "answered while asleep");
  const storage2 = new PiSqliteStorage(f.host);
  const session2 = new StorageBackedSession(
    { id: "s1", createdAt: Date.now(), storageVersion: 1 }, storage2 as any);
  const models = createModels();
  models.setProvider(offloadedProvider({
    port: f.q.port, id: PROVIDER, models: [{ id: MODEL, contextWindow: 128_000 }],
  }));
  const { harness: b, open } = await AgentHarness.create({
    session: session2 as any, models, model: models.getModel(PROVIDER, MODEL)!,
    systemPrompt: "you are a test", streamOptions: { deferred: true },
  }, CTX);
  if (open.length !== 1) throw new Error(`a suspended run was not reported open: ${JSON.stringify(open)}`);

  const laneB = await b.lane("main", CTX);
  const out = unwrap(await laneB.drive({ operationId: open[0]!.operationId, pollDeferred: true }, CTX), "drive");
  if (out.kind !== "settled") throw new Error(`did not finish after wake: ${JSON.stringify(out).slice(0, 300)}`);
  const seen = await laneB.findEntries(undefined, CTX);
  if (!JSON.stringify(seen).includes("answered while asleep")) {
    throw new Error("the answer delivered during sleep was lost");
  }
  await b.close(CTX);
});

console.log(`\n  Model calls that the object does not wait for\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
