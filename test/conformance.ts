/**
 * Runtime conformance suite (A layer).
 *
 * These are the §14 rows that do not need a model, a SaaS, or a network: they
 * are the ones that decide whether the architecture stands up. Any StorageAdapter
 * that passes this file is a candidate Runtime backend — that is how the db9 vs
 * self-hosted-Postgres decision gets settled by measurement, not by discussion.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { Kernel, commandId, type HarnessAdapter } from "../src/runtime/kernel.ts";
import type { Json } from "../src/core/types.ts";

const TENANT = "tenant-a";
const OTHER = "tenant-b";

/** Deterministic, model-free harness: one command per inbound message. */
const echoHarness: HarnessAdapter = {
  kind: "echo",
  stateVersion: 1,
  async initialize() {
    return { log: [] };
  },
  async advance({ state, events }) {
    const log = [...((state as any)?.log ?? [])];
    const commands: Array<{ kind: string; payload: Json }> = [];
    for (const e of events) {
      log.push(`${e.sequence}:${e.kind}`);
      if (e.kind === "message") commands.push({ kind: "tool.call", payload: { seq: e.sequence } });
    }
    return {
      state: { log },
      status: commands.length ? "waiting" : "runnable",
      commands,
      waits: [],
    };
  },
};

async function fixture() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(TENANT, "agent-1");
  await store.createTask(TENANT, "agent-1", "task-1", { log: [] });
  return store;
}

const msg = (store: SqliteStore, text: string, dedupKey?: string) =>
  store.appendEvent({
    tenantId: TENANT,
    agentId: "agent-1",
    taskId: "task-1",
    kind: "message",
    payload: { text },
    dedupKey,
  });

// ---------------------------------------------------------------- test harness
type Test = { name: string; row: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ name, row, fn });

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${what}`);
}
const eq = (a: unknown, b: unknown, what: string) =>
  assert(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---------------------------------------------------------------------- cases

test("崩溃在提交前", "pre-commit crash is a no-op and replay does not double-dispatch", async () => {
  const store = await fixture();
  const k = new Kernel(store, echoHarness, { holder: "w1" });
  await msg(store, "hello");

  const crashed = await k.step(TENANT, "task-1", "before_commit");
  eq(crashed.outcome, "crashed_before_commit", "crash outcome");
  const t0 = await store.loadTask(TENANT, "task-1");
  eq(t0!.checkpointVersion, 0, "checkpoint untouched");
  eq((await store.claimOutbox(10)).length, 0, "outbox empty");

  let dispatched = 0;
  const again = await k.step(TENANT, "task-1", null, async () => {
    dispatched++;
  });
  eq(again.outcome, "committed", "replay commits");
  eq(dispatched, 1, "dispatched exactly once");
  // Same advance inputs must yield the same command id.
  eq(
    commandId("task-1", 0, 0, 0, "tool.call", { seq: 1 }),
    commandId("task-1", 0, 0, 0, "tool.call", { seq: 1 }),
    "command id is derived, not random",
  );
  await store.close();
});

test("请求发送后崩溃", "post-commit crash still dispatches, exactly once", async () => {
  const store = await fixture();
  const k = new Kernel(store, echoHarness, { holder: "w1" });
  await msg(store, "hello");

  const r = await k.step(TENANT, "task-1", "after_commit");
  eq(r.outcome, "crashed_after_commit", "committed but undispatched");
  eq((await store.loadTask(TENANT, "task-1"))!.checkpointVersion, 1, "checkpoint advanced");

  const recovery = new Kernel(store, echoHarness, { holder: "w2" });
  let seen = 0;
  eq(await recovery.drainOutbox(async () => void seen++), 1, "recovery dispatches 1");
  eq(await recovery.drainOutbox(async () => void seen++), 0, "nothing left");
  eq(seen, 1, "exactly once overall");
  await store.close();
});

test("双 worker 抢租约", "two workers cannot hold the same lease", async () => {
  const store = await fixture();
  const a = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  const b = await store.acquireLease(TENANT, "task-1", "w2", 30_000);
  assert(a, "w1 acquires");
  eq(b, null, "w2 refused");
  await store.close();
});

test("旧 worker 恢复写入", "fencing rejects a resurrected worker's write", async () => {
  const store = await fixture();
  await msg(store, "hello");
  const stale = await store.acquireLease(TENANT, "task-1", "w1", 0); // expires immediately
  const fresh = await store.acquireLease(TENANT, "task-1", "w2", 30_000);
  assert(stale && fresh && fresh.fencingToken > stale.fencingToken, "tokens are monotonic");

  const task = await store.loadTask(TENANT, "task-1");
  const ok = await store.commitAdvance({
    tenantId: TENANT, taskId: "task-1", generation: 0,
    fencingToken: fresh.fencingToken, expectedCheckpointVersion: task!.checkpointVersion,
    checkpoint: { by: "w2" }, status: "runnable", consumedThrough: 1, waits: [], commands: [],
  });
  assert(ok.ok, "fresh worker commits");

  const zombie = await store.commitAdvance({
    tenantId: TENANT, taskId: "task-1", generation: 0,
    fencingToken: stale.fencingToken, expectedCheckpointVersion: 1,
    checkpoint: { by: "w1" }, status: "runnable", consumedThrough: 1, waits: [], commands: [],
  });
  assert(!zombie.ok && zombie.reason === "fenced", "zombie write fenced");
  eq((await store.loadTask(TENANT, "task-1"))!.checkpoint.by, "w2", "state not clobbered");
  await store.close();
});

test("旧 generation 返回", "stale generation cannot advance, but the result survives", async () => {
  const store = await fixture();
  const lease = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  await store.recordOperation({
    operationId: "op-1", tenantId: TENANT, agentId: "agent-1", taskId: "task-1",
    mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
  });
  const newGen = await store.interrupt(TENANT, "task-1");
  eq(newGen, 1, "interrupt bumps generation");

  const late = await store.commitAdvance({
    tenantId: TENANT, taskId: "task-1", generation: 0,
    fencingToken: lease!.fencingToken, expectedCheckpointVersion: 0,
    checkpoint: { stale: true }, status: "runnable", consumedThrough: null, waits: [], commands: [],
  });
  assert(!late.ok && late.reason === "stale_generation", "old generation rejected");

  await store.completeOperation(TENANT, "op-1", "succeeded", "r2://blob/1");
  const op = await store.getOperation(TENANT, "op-1");
  eq(op!.status, "succeeded", "external result is still recorded as fact");
  await store.close();
});

test("重复消息 / 回调", "duplicate delivery is consumed once", async () => {
  const store = await fixture();
  const first = await msg(store, "hi", "provider-evt-42");
  const second = await msg(store, "hi", "provider-evt-42");
  eq(first.inserted, true, "first insert");
  eq(second.inserted, false, "duplicate rejected");
  eq(second.eventId, first.eventId, "same event returned");
  eq((await store.pendingEvents(TENANT, "task-1", "harness")).length, 1, "one pending event");
  await store.close();
});

test("工具先完成后注册等待", "result before wait registration does not park forever", async () => {
  const store = await fixture();
  await store.recordOperation({
    operationId: "op-fast", tenantId: TENANT, agentId: "agent-1", taskId: "task-1",
    mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
  });
  await store.completeOperation(TENANT, "op-fast", "succeeded", null);
  const r = await store.registerWait(TENANT, "task-1", 0, { kind: "operation", operationId: "op-fast" });
  eq(r, "already_satisfied", "wait resolves at registration time");
  await store.close();
});

test("新消息与回收竞争", "release refuses to park while unconsumed work exists", async () => {
  const store = await fixture();
  const lease = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  await msg(store, "arrives just before parking");
  eq(
    await store.releaseIfNoWork(TENANT, "task-1", lease!.fencingToken, "harness"),
    "has_work",
    "lost wakeup prevented",
  );
  const k = new Kernel(store, echoHarness, { holder: "w1" });
  await k.step(TENANT, "task-1", null, async () => {});
  const l2 = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  eq(
    await store.releaseIfNoWork(TENANT, "task-1", l2!.fencingToken, "harness"),
    "released",
    "parks once drained",
  );
  await store.close();
});

test("并发提交", "optimistic checkpoint version rejects a concurrent second write", async () => {
  const store = await fixture();
  const lease = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  const base = {
    tenantId: TENANT, taskId: "task-1", generation: 0, fencingToken: lease!.fencingToken,
    expectedCheckpointVersion: 0, status: "runnable" as const,
    consumedThrough: null, waits: [], commands: [],
  };
  assert((await store.commitAdvance({ ...base, checkpoint: { n: 1 } })).ok, "first commit");
  const second = await store.commitAdvance({ ...base, checkpoint: { n: 2 } });
  assert(!second.ok && second.reason === "version_conflict", "second rejected");
  await store.close();
});

test("事件顺序", "event sequence is monotonic per agent", async () => {
  const store = await fixture();
  const a = await msg(store, "1"), b = await msg(store, "2"), c = await msg(store, "3");
  assert(a.sequence < b.sequence && b.sequence < c.sequence, "strictly increasing");
  const evts = await store.pendingEvents(TENANT, "task-1", "harness");
  eq(evts.map((e) => e.sequence).join(","), [a, b, c].map((x) => x.sequence).join(","), "ordered read");
  await store.close();
});

test("跨租户访问", "another tenant sees nothing", async () => {
  const store = await fixture();
  await msg(store, "secret");
  await store.recordOperation({
    operationId: "op-x", tenantId: TENANT, agentId: "agent-1", taskId: "task-1",
    mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
  });
  eq(await store.loadTask(OTHER, "task-1"), null, "task hidden");
  eq((await store.pendingEvents(OTHER, "task-1", "harness")).length, 0, "events hidden");
  eq(await store.getOperation(OTHER, "op-x"), null, "operation hidden");
  const lease = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  const cross = await store.commitAdvance({
    tenantId: OTHER, taskId: "task-1", generation: 0, fencingToken: lease!.fencingToken,
    expectedCheckpointVersion: 0, checkpoint: { hacked: true }, status: "runnable",
    consumedThrough: null, waits: [], commands: [],
  });
  assert(!cross.ok && cross.reason === "no_task", "cross-tenant write rejected");
  await store.close();
});

test("operation 跨执行存活", "an operation outlives its execution and wakes the task", async () => {
  const store = await fixture();
  await store.recordOperation({
    operationId: "op-slow", tenantId: TENANT, agentId: "agent-1", taskId: "task-1",
    mountAlias: "gh_work", tool: "github.actions.run", toolVersion: "1.0.0",
  });
  eq(
    await store.registerWait(TENANT, "task-1", 0, { kind: "operation", operationId: "op-slow" }),
    "registered",
    "parked on a pending operation",
  );
  const lease = await store.acquireLease(TENANT, "task-1", "w1", 30_000);
  eq(
    await store.releaseIfNoWork(TENANT, "task-1", lease!.fencingToken, "harness"),
    "released",
    "execution resources released while waiting",
  );

  // ... much later, with no worker alive:
  await store.completeOperation(TENANT, "op-slow", "succeeded", "r2://blob/9");
  const l2 = await store.acquireLease(TENANT, "task-1", "w2", 30_000);
  eq(
    await store.releaseIfNoWork(TENANT, "task-1", l2!.fencingToken, "harness"),
    "has_work",
    "completion woke the task",
  );
  const evts = await store.pendingEvents(TENANT, "task-1", "harness");
  eq(evts.length, 1, "one wakeup event");
  eq(evts[0]!.kind, "operation.completed", "uniform wakeup channel");
  await store.close();
});

// ------------------------------------------------------------------- runner
let pass = 0, fail = 0;
console.log(`\n  Runtime conformance — backend: sqlite\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try {
    await t.fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(22)} ${t.name}`);
  } catch (err) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(22)} ${t.name}`);
    console.log(`      \x1b[31m${(err as Error).message}\x1b[0m`);
  }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
