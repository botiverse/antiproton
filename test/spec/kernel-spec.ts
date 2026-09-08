/**
 * Kernel conformance CONTRACT. Implementation-agnostic on purpose: the same
 * assertions run against sqlite in Node and against Durable Object storage at
 * the edge. A backend that passes this is a candidate; one that does not is
 * not, whatever else it offers.
 */
import { Kernel, commandId, type HarnessAdapter } from "../../src/runtime/kernel.ts";
import type { StorageAdapter } from "../../src/core/store.ts";
import type { Json } from "../../src/core/types.ts";

export interface SpecResult { row: string; name: string; ok: boolean; error?: string }

export async function kernelSpec(
  newStore: () => Promise<StorageAdapter>,
): Promise<SpecResult[]> {
  // Shared backends keep state between runs, so every fixture gets fresh ids.
  const RUN = Math.random().toString(36).slice(2, 8);
  let N = 0;
  let TENANT = "", OTHER = "", AGENT = "", TASK = "";
  const open: StorageAdapter[] = [];

  /** Deterministic, model-free harness: one command per inbound message. */
  const echoHarness: HarnessAdapter = {
    kind: "echo",
    stateVersion: 1,
    async initialize() { return { log: [] }; },
    async migrate(s: Json) { return s; },
    async advance({ state, events }) {
      const log = [...((state as any)?.log ?? [])];
      const commands: Array<{ kind: string; payload: Json }> = [];
      for (const e of events) {
        log.push(`${e.sequence}:${e.kind}`);
        if (e.kind === "message") commands.push({ kind: "tool.call", payload: { seq: e.sequence } });
      }
      return { state: { log }, status: commands.length ? "waiting" : "runnable", commands, waits: [] };
    },
  };

  async function fixture() {
    N++;
    TENANT = `tn-${RUN}-${N}`;
    OTHER = `other-${RUN}-${N}`;
    AGENT = `ag-${RUN}-${N}`;
    TASK = `tk-${RUN}-${N}`;
    const store = await newStore();
    await store.init();
    open.push(store);
    await store.createAgent(TENANT, AGENT);
    await store.createTask(TENANT, AGENT, TASK, { log: [] });
    return store;
  }

  const msg = (store: StorageAdapter, text: string, dedupKey?: string) =>
    store.appendEvent({
      tenantId: TENANT, agentId: AGENT, taskId: TASK,
      kind: "message", payload: { text }, dedupKey,
    });

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

    const crashed = await k.step(TENANT, TASK, "before_commit");
    eq(crashed.outcome, "crashed_before_commit", "crash outcome");
    const t0 = await store.loadTask(TENANT, TASK);
    eq(t0!.checkpointVersion, 0, "checkpoint untouched");
    eq((await store.claimOutbox(10, TENANT)).length, 0, "outbox empty");

    let dispatched = 0;
    const again = await k.step(TENANT, TASK, null, async () => {
      dispatched++;
    });
    eq(again.outcome, "committed", "replay commits");
    eq(dispatched, 1, "dispatched exactly once");
    // Same advance inputs must yield the same command id.
    eq(
      commandId(TASK, 0, 0, 0, "tool.call", { seq: 1 }),
      commandId(TASK, 0, 0, 0, "tool.call", { seq: 1 }),
      "command id is derived, not random",
    );
    await store.close().catch(() => {});
  });

  test("请求发送后崩溃", "post-commit crash still dispatches, exactly once", async () => {
    const store = await fixture();
    const k = new Kernel(store, echoHarness, { holder: "w1" });
    await msg(store, "hello");

    const r = await k.step(TENANT, TASK, "after_commit");
    eq(r.outcome, "crashed_after_commit", "committed but undispatched");
    eq((await store.loadTask(TENANT, TASK))!.checkpointVersion, 1, "checkpoint advanced");

    const recovery = new Kernel(store, echoHarness, { holder: "w2" });
    let seen = 0;
    eq(await recovery.drainOutbox(async () => void seen++, 100, TENANT), 1, "recovery dispatches 1");
    eq(await recovery.drainOutbox(async () => void seen++, 100, TENANT), 0, "nothing left");
    eq(seen, 1, "exactly once overall");
    await store.close().catch(() => {});
  });

  test("双 worker 抢租约", "two workers cannot hold the same lease", async () => {
    const store = await fixture();
    const a = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    const b = await store.acquireLease(TENANT, TASK, "w2", 30_000);
    assert(a, "w1 acquires");
    eq(b, null, "w2 refused");
    await store.close().catch(() => {});
  });

  test("旧 worker 恢复写入", "fencing rejects a resurrected worker's write", async () => {
    const store = await fixture();
    await msg(store, "hello");
    const stale = await store.acquireLease(TENANT, TASK, "w1", 0); // expires immediately
    const fresh = await store.acquireLease(TENANT, TASK, "w2", 30_000);
    assert(stale && fresh && fresh.fencingToken > stale.fencingToken, "tokens are monotonic");

    const task = await store.loadTask(TENANT, TASK);
    const ok = await store.commitAdvance({
      tenantId: TENANT, taskId: TASK, generation: 0,
      fencingToken: fresh.fencingToken, expectedCheckpointVersion: task!.checkpointVersion,
      checkpoint: { by: "w2" }, status: "runnable", consumedThrough: 1, waits: [], commands: [],
    });
    assert(ok.ok, "fresh worker commits");

    const zombie = await store.commitAdvance({
      tenantId: TENANT, taskId: TASK, generation: 0,
      fencingToken: stale.fencingToken, expectedCheckpointVersion: 1,
      checkpoint: { by: "w1" }, status: "runnable", consumedThrough: 1, waits: [], commands: [],
    });
    assert(!zombie.ok && zombie.reason === "fenced", "zombie write fenced");
    eq((await store.loadTask(TENANT, TASK))!.checkpoint.by, "w2", "state not clobbered");
    await store.close().catch(() => {});
  });

  test("旧 generation 返回", "stale generation cannot advance, but the result survives", async () => {
    const store = await fixture();
    const lease = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    await store.recordOperation({
      operationId: `${TASK}-op1`, tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
    });
    const newGen = await store.interrupt(TENANT, TASK);
    eq(newGen, 1, "interrupt bumps generation");

    const late = await store.commitAdvance({
      tenantId: TENANT, taskId: TASK, generation: 0,
      fencingToken: lease!.fencingToken, expectedCheckpointVersion: 0,
      checkpoint: { stale: true }, status: "runnable", consumedThrough: null, waits: [], commands: [],
    });
    assert(!late.ok && late.reason === "stale_generation", "old generation rejected");

    await store.completeOperation(TENANT, `${TASK}-op1`, "succeeded", "r2://blob/1");
    const op = await store.getOperation(TENANT, `${TASK}-op1`);
    eq(op!.status, "succeeded", "external result is still recorded as fact");
    await store.close().catch(() => {});
  });

  test("重复消息 / 回调", "duplicate delivery is consumed once", async () => {
    const store = await fixture();
    const first = await msg(store, "hi", "provider-evt-42");
    const second = await msg(store, "hi", "provider-evt-42");
    eq(first.inserted, true, "first insert");
    eq(second.inserted, false, "duplicate rejected");
    eq(second.eventId, first.eventId, "same event returned");
    eq((await store.pendingEvents(TENANT, TASK, "harness")).length, 1, "one pending event");
    await store.close().catch(() => {});
  });

  test("工具先完成后注册等待", "result before wait registration does not park forever", async () => {
    const store = await fixture();
    await store.recordOperation({
      operationId: `${TASK}-fast`, tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
    });
    await store.completeOperation(TENANT, `${TASK}-fast`, "succeeded", null);
    const r = await store.registerWait(TENANT, TASK, 0, { kind: "operation", operationId: `${TASK}-fast` });
    eq(r, "already_satisfied", "wait resolves at registration time");
    await store.close().catch(() => {});
  });

  test("新消息与回收竞争", "release refuses to park while unconsumed work exists", async () => {
    const store = await fixture();
    const lease = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    await msg(store, "arrives just before parking");
    eq(
      await store.releaseIfNoWork(TENANT, TASK, lease!.fencingToken, "harness"),
      "has_work",
      "lost wakeup prevented",
    );
    const k = new Kernel(store, echoHarness, { holder: "w1" });
    await k.step(TENANT, TASK, null, async () => {});
    const l2 = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    eq(
      await store.releaseIfNoWork(TENANT, TASK, l2!.fencingToken, "harness"),
      "released",
      "parks once drained",
    );
    await store.close().catch(() => {});
  });

  test("并发提交", "optimistic checkpoint version rejects a concurrent second write", async () => {
    const store = await fixture();
    const lease = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    const base = {
      tenantId: TENANT, taskId: TASK, generation: 0, fencingToken: lease!.fencingToken,
      expectedCheckpointVersion: 0, status: "runnable" as const,
      consumedThrough: null, waits: [], commands: [],
    };
    assert((await store.commitAdvance({ ...base, checkpoint: { n: 1 } })).ok, "first commit");
    const second = await store.commitAdvance({ ...base, checkpoint: { n: 2 } });
    assert(!second.ok && second.reason === "version_conflict", "second rejected");
    await store.close().catch(() => {});
  });

  test("事件顺序", "event sequence is monotonic per agent", async () => {
    const store = await fixture();
    const a = await msg(store, "1"), b = await msg(store, "2"), c = await msg(store, "3");
    assert(a.sequence < b.sequence && b.sequence < c.sequence, "strictly increasing");
    const evts = await store.pendingEvents(TENANT, TASK, "harness");
    eq(evts.map((e) => e.sequence).join(","), [a, b, c].map((x) => x.sequence).join(","), "ordered read");
    await store.close().catch(() => {});
  });

  test("跨租户访问", "another tenant sees nothing", async () => {
    const store = await fixture();
    await msg(store, "secret");
    await store.recordOperation({
      operationId: `${TASK}-x`, tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh_work", tool: "github.issues.list", toolVersion: "1.0.0",
    });
    eq(await store.loadTask(OTHER, TASK), null, "task hidden");
    eq((await store.pendingEvents(OTHER, TASK, "harness")).length, 0, "events hidden");
    eq(await store.getOperation(OTHER, `${TASK}-x`), null, "operation hidden");
    const lease = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    const cross = await store.commitAdvance({
      tenantId: OTHER, taskId: TASK, generation: 0, fencingToken: lease!.fencingToken,
      expectedCheckpointVersion: 0, checkpoint: { hacked: true }, status: "runnable",
      consumedThrough: null, waits: [], commands: [],
    });
    assert(!cross.ok && cross.reason === "no_task", "cross-tenant write rejected");
    await store.close().catch(() => {});
  });

  test("operation 跨执行存活", "an operation outlives its execution and wakes the task", async () => {
    const store = await fixture();
    await store.recordOperation({
      operationId: `${TASK}-slow`, tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh_work", tool: "github.actions.run", toolVersion: "1.0.0",
    });
    eq(
      await store.registerWait(TENANT, TASK, 0, { kind: "operation", operationId: `${TASK}-slow` }),
      "registered",
      "parked on a pending operation",
    );
    const lease = await store.acquireLease(TENANT, TASK, "w1", 30_000);
    eq(
      await store.releaseIfNoWork(TENANT, TASK, lease!.fencingToken, "harness"),
      "released",
      "execution resources released while waiting",
    );

    // ... much later, with no worker alive:
    await store.completeOperation(TENANT, `${TASK}-slow`, "succeeded", "r2://blob/9");
    const l2 = await store.acquireLease(TENANT, TASK, "w2", 30_000);
    eq(
      await store.releaseIfNoWork(TENANT, TASK, l2!.fencingToken, "harness"),
      "has_work",
      "completion woke the task",
    );
    const evts = await store.pendingEvents(TENANT, TASK, "harness");
    eq(evts.length, 1, "one wakeup event");
    eq(evts[0]!.kind, "operation.completed", "uniform wakeup channel");
    await store.close().catch(() => {});
  });


  test("凭据派生的会话态", "connection state is per mount, survives calls, and expires", async () => {
    const store = await fixture();
    // Two mounts of the same plugin: different accounts of one service. Their
    // sessions must not be able to see each other, or a token leaks sideways.
    for (const alias of ["gh_work", "gh_personal"]) {
      await store.addMount({
        tenantId: TENANT, agentId: AGENT, alias, plugin: "github",
        installationId: `inst-${alias}`, connectionId: null, toolVersion: "1.0.0",
        publicConfig: {}, secretRef: `env:TOKEN_${alias}`,
      });
    }
    eq(await store.getConnection(TENANT, AGENT, "gh_work"), null, "absent before first exchange");

    await store.putConnection(TENANT, AGENT, "gh_work", { token: "work-1" });
    eq((await store.getConnection(TENANT, AGENT, "gh_work") as any).token, "work-1", "readable again");
    eq(await store.getConnection(TENANT, AGENT, "gh_personal"), null, "sibling mount unaffected");
    eq(await store.getConnection(OTHER, AGENT, "gh_work"), null, "another tenant sees nothing");

    await store.putConnection(TENANT, AGENT, "gh_work", { token: "work-2" });
    eq((await store.getConnection(TENANT, AGENT, "gh_work") as any).token, "work-2", "refresh overwrites");

    // An expired session must read as absent: handing it back sends the plugin
    // out with a token the far side has already rejected.
    await store.putConnection(TENANT, AGENT, "gh_personal", { token: "old" }, Date.now() - 1000);
    eq(await store.getConnection(TENANT, AGENT, "gh_personal"), null, "expired reads as absent");
    await store.close().catch(() => {});
  });

  test("检查点体积上限", "an oversized checkpoint is refused, not silently billed", async () => {
    const store = await fixture();
    const fat: HarnessAdapter = {
      kind: "fat", stateVersion: 1,
      async initialize() { return {}; },
      async migrate(s: Json) { return s; },
      async advance() {
        // A harness that puts static configuration in its state.
        return { state: { blob: "x".repeat(400_000) }, status: "runnable", commands: [], waits: [] };
      },
    };
    await msg(store, "go");
    const k = new Kernel(store, fat, { holder: "w1", maxCheckpointBytes: 256 * 1024 });
    const r = await k.step(TENANT, TASK, null, async () => {});
    eq(r.outcome, "rejected", "oversized checkpoint refused");
    assert(String(r.reason).startsWith("checkpoint_too_large"), `reason: ${r.reason}`);
    eq((await store.loadTask(TENANT, TASK))!.checkpointVersion, 0, "nothing was written");
    await store.close().catch(() => {});
  });

  test("预算耗尽", "an exhausted tenant stops advancing instead of spending on", async () => {
    const store = await fixture();
    await store.setQuota(TENANT, "steps", 2);
    const k = new Kernel(store, echoHarness, { holder: "w1" });

    await msg(store, "one");
    eq((await k.step(TENANT, TASK, null, async () => {})).outcome, "committed", "first step runs");
    await msg(store, "two");
    eq((await k.step(TENANT, TASK, null, async () => {})).outcome, "committed", "second step runs");

    await msg(store, "three");
    const r = await k.step(TENANT, TASK, null, async () => {});
    eq(r.outcome, "rejected", "third step refused");
    assert(String(r.reason).startsWith("quota_exceeded"), `reason: ${r.reason}`);
    // Refusal must park the task, not leave it spinning on the same events.
    eq((await store.loadTask(TENANT, TASK))!.status, "blocked", "task parked");
    await store.close().catch(() => {});
  });

  test("预算跨租户隔离", "one tenant exhausting its budget does not touch another's", async () => {
    const store = await fixture();
    await store.setQuota(TENANT, "tool_calls", 1);
    eq((await store.consumeQuota(TENANT, "tool_calls", 1)).allowed, true, "first allowed");
    eq((await store.consumeQuota(TENANT, "tool_calls", 1)).allowed, false, "second refused");
    // A different tenant has its own ledger, and no limit configured.
    eq((await store.consumeQuota(OTHER, "tool_calls", 50)).allowed, true, "other tenant unaffected");
    await store.close().catch(() => {});
  });

  test("账户级默认预算", "a tenant with no budget of its own inherits the account default", async () => {
    const store = await fixture();
    await store.setQuota("*", "model_tokens", 100);
    eq((await store.consumeQuota(TENANT, "model_tokens", 60)).allowed, true, "within default");
    eq((await store.consumeQuota(TENANT, "model_tokens", 60)).allowed, false, "default enforced");
    // An explicit tenant budget overrides the account default.
    await store.setQuota(OTHER, "model_tokens", 1000);
    eq((await store.consumeQuota(OTHER, "model_tokens", 900)).allowed, true, "own budget wins");
    await store.close().catch(() => {});
  });

  test("并发扣费不超支", "concurrent charges cannot both spend the last of a budget", async () => {
    const store = await fixture();
    await store.setQuota(TENANT, "tool_calls", 10);
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => store.consumeQuota(TENANT, "tool_calls", 1)),
    );
    const granted = rs.filter((r) => r.allowed).length;
    eq(granted, 10, "exactly the budget was granted");
    const [u] = await store.usage(TENANT);
    eq(u!.used, 10, "ledger agrees with what was granted");
    await store.close().catch(() => {});
  });

  test("预算窗口重置", "a windowed budget refills, a lifetime cap does not", async () => {
    const store = await fixture();
    await store.setQuota(TENANT, "steps", 1, 50);
    eq((await store.consumeQuota(TENANT, "steps", 1)).allowed, true, "first allowed");
    eq((await store.consumeQuota(TENANT, "steps", 1)).allowed, false, "refused inside the window");
    await new Promise((r) => setTimeout(r, 70));
    eq((await store.consumeQuota(TENANT, "steps", 1)).allowed, true, "refilled after the window");
    await store.close().catch(() => {});
  });

  test("重放不重复副作用", "a replayed write is answered unknown, not performed twice", async () => {
    const store = await fixture();
    // Two calls under one key: the first records the attempt, the second must
    // not repeat it. `unknown` is the honest answer — it may already have
    // landed, which is precisely why it is not retried blindly.
    // Run-unique, because a persistent backend keeps rows between runs and a
    // fixed id would collide with the previous run's — which is exactly how
    // this case first failed on Durable Objects while passing on in-memory
    // sqlite.
    const opId = (k: string) => `${TASK}-${k}`;
    await store.recordOperation({
      operationId: opId("k1"), tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh", tool: "github.issues.create", toolVersion: "1.0.0",
    });
    // A derived id is written once; a replay must not raise or duplicate.
    await store.recordOperation({
      operationId: opId("k1"), tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh", tool: "github.issues.create", toolVersion: "1.0.0",
    });
    const ops = await store.getOperation(TENANT, opId("k1"));
    assert(ops, `the operation exists (tenant=${TENANT} id=${opId("k1")})`);
    eq(ops!.status, "pending", "the first record stands; the replay did not reset it");
    await store.completeOperation(TENANT, opId("k1"), "succeeded", null);
    await store.recordOperation({
      operationId: opId("k1"), tenantId: TENANT, agentId: AGENT, taskId: TASK,
      mountAlias: "gh", tool: "github.issues.create", toolVersion: "1.0.0",
    });
    eq((await store.getOperation(TENANT, opId("k1")))!.status, "succeeded",
       "a replay cannot roll a completed operation back to pending");
    await store.close().catch(() => {});
  });

  test("检查点迁移", "a checkpoint written by an older harness is migrated exactly once", async () => {
    const store = await fixture();
    let migrations = 0;
    const v2: HarnessAdapter = {
      kind: "versioned", stateVersion: 2,
      async initialize() { return { v: 2, log: [] }; },
      async migrate(state: Json, from: number) {
        migrations++;
        return { ...(state as any), v: 2, migratedFrom: from };
      },
      async advance({ state, events }) {
        const log = [...((state as any)?.log ?? []), ...events.map((e) => e.kind)];
        return { state: { ...(state as any), log }, status: "runnable", commands: [], waits: [] };
      },
    };
    // The task was opened by a v1 harness.
    const TASK2 = `${TASK}-v1`;
    await store.createTask(TENANT, AGENT, TASK2, { v: 1, log: [] }, 1);
    eq((await store.loadTask(TENANT, TASK2))!.stateVersion, 1, "stored at v1");

    const k = new Kernel(store, v2, { holder: "w1" });
    await store.appendEvent({
      tenantId: TENANT, agentId: AGENT, taskId: TASK2, kind: "message", payload: { text: "a" },
    });
    eq((await k.step(TENANT, TASK2, null, async () => {})).outcome, "committed", "first advance");
    eq(migrations, 1, "migrated once");
    const t1 = await store.loadTask(TENANT, TASK2);
    eq(t1!.stateVersion, 2, "committed at the harness's version");
    eq((t1!.checkpoint as any).migratedFrom, 1, "migrate saw where it came from");

    // Resuming must not migrate again.
    await store.appendEvent({
      tenantId: TENANT, agentId: AGENT, taskId: TASK2, kind: "message", payload: { text: "b" },
    });
    eq((await k.step(TENANT, TASK2, null, async () => {})).outcome, "committed", "second advance");
    eq(migrations, 1, "not migrated a second time");
    await store.close().catch(() => {});
  });

  const results: SpecResult[] = [];
  for (const t of tests) {
    try { await t.fn(); results.push({ row: t.row, name: t.name, ok: true }); }
    catch (err) { results.push({ row: t.row, name: t.name, ok: false, error: (err as Error).message }); }
  }
  for (const s of open) await s.close().catch(() => {});
  return results;
}
