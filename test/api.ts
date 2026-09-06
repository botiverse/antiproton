/** HTTP surface (§10.1): command idempotency, tenant isolation, resumable event
 *  stream, explicit interrupt scope. Runs the real scheduler with a scripted model. */
import { SqliteStore } from "../src/store/sqlite.ts";
import { createApi } from "../src/api/server.ts";
import { Scheduler } from "../src/runtime/scheduler.ts";
import { Kernel } from "../src/runtime/kernel.ts";
import { CommandExecutor } from "../src/runtime/commands.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { CodegenHarness } from "../src/harness/codegen.ts";
import type { ModelAdapter, ModelMessage, ModelResponse } from "../src/model/types.ts";
import type { ExecutorHost } from "../src/runtime/executor.ts";
import type { ToolResult } from "../src/core/tools.ts";

const A_KEY = "key-a", B_KEY = "key-b";

class Scripted implements ModelAdapter {
  readonly id = "scripted";
  #i = 0;
  async complete(_m: ModelMessage[]): Promise<ModelResponse> {
    const script = ["```js\noutput('working');\n```", "all done"];
    return {
      text: script[Math.min(this.#i++, script.length - 1)]!,
      finishReason: "stop", truncated: false,
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 },
    };
  }
}
const host: ExecutorHost = {
  async invoke(): Promise<ToolResult> {
    return { status: "succeeded", operationId: "op_x", result: {} };
  },
};

async function rig(retentionFloor = 0) {
  const store = new SqliteStore(":memory:");
  await store.init();
  const harness = new CodegenHarness({ maxTurns: 4 });
  const commands = new CommandExecutor(store, new Scripted(), host, new QuickJsExecutor());
  const kernel = new Kernel(store, harness, { holder: "api-worker", leaseTtlMs: 30_000 });
  const scheduler = new Scheduler(
    store,
    async (tenantId, taskId) => {
      const task = await store.loadTask(tenantId, taskId);
      if (!task) return;
      return kernel.step(tenantId, taskId, null, (cmd) =>
        commands.dispatch({ tenantId, agentId: task.agentId, taskId }, cmd),
      );
    },
    { intervalMs: 40 },
  );
  const server = createApi(store, {
    tokens: new Map([[A_KEY, "tenant-a"], [B_KEY, "tenant-b"]]),
    retentionFloor,
    sseIntervalMs: 40,
    sseKeepaliveMs: 120,
    async onNewTask(tenantId, agentId, taskId) {
      await store.createTask(tenantId, agentId, taskId, await harness.initialize({}));
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, path: string, key = A_KEY, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const done = async () => {
    scheduler.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  };
  return { store, scheduler, server, base, call, done };
}

type Test = { row: string; name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ row, name, fn });
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(`assertion failed: ${w}`); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const settle = async (s: Scheduler, n = 12) => { for (let i = 0; i < n; i++) await s.tick(); };

test("鉴权", "no token, no access; the token is the only source of tenant identity", async () => {
  const r = await rig();
  const anon = await fetch(`${r.base}/agents`, { method: "POST" });
  eq(anon.status, 401, "unauthorized without a key");
  eq((await r.call("POST", "/agents", "bogus-key")).status, 401, "unknown key rejected");
  eq((await fetch(`${r.base}/health`)).status, 200, "health needs no auth");
  await r.done();
});

test("消息建任务", "a message with no taskId opens one and the scheduler picks it up", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  const msg = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "do the thing" });
  eq(msg.status, 202, "accepted");
  assert(msg.body.taskId, "task opened");
  await settle(r.scheduler);
  const tasks = await r.call("GET", `/agents/${agent.agentId}/tasks`, A_KEY);
  eq(tasks.body.tasks[0].status, "completed", "task ran to completion through the scheduler");
  await r.done();
});

test("命令去重", "a retried requestId replays the first answer instead of acting twice", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  const payload = { text: "same message", requestId: "req-1" };
  const first = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, payload);
  const second = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, payload);
  eq(second.body.replayed, true, "second call marked as replay");
  eq(second.body.taskId, first.body.taskId, "same task, no second one opened");
  eq((await r.call("GET", `/agents/${agent.agentId}/tasks`, A_KEY)).body.tasks.length, 1, "exactly one task");
  await r.done();
});

test("跨租户", "tenant B cannot see or touch tenant A's thread, task or operation", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  const { body: msg } = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "secret" });
  await r.store.recordOperation({
    operationId: "op-secret", tenantId: "tenant-a", agentId: agent.agentId, taskId: msg.taskId,
    mountAlias: "gh", tool: "github.issues.list", toolVersion: "1.0.0",
  });
  eq((await r.call("POST", `/threads/${thread.threadId}/messages`, B_KEY, { text: "hi" })).status, 404, "thread hidden");
  eq((await r.call("POST", `/tasks/${msg.taskId}/interrupt`, B_KEY, {})).status, 404, "task hidden");
  eq((await r.call("GET", `/operations/op-secret`, B_KEY)).status, 404, "operation hidden");
  eq((await r.call("GET", `/agents/${agent.agentId}/tasks`, B_KEY)).body.tasks.length, 0, "task list empty");
  await r.done();
});

test("中断范围", "task interrupt bumps one generation; agent interrupt names every task it hit", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  const { body: one } = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "job one" });
  const { body: two } = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "job two" });
  const single = await r.call("POST", `/tasks/${one.taskId}/interrupt`, A_KEY, { requestId: "int-1" });
  eq(single.body.generation, 1, "generation bumped");
  eq((await r.call("POST", `/tasks/${one.taskId}/interrupt`, A_KEY, { requestId: "int-1" })).body.replayed, true, "idempotent");
  const all = await r.call("POST", `/agents/${agent.agentId}/interrupt`, A_KEY, {});
  assert(all.body.interrupted.includes(two.taskId), "agent-level scope is explicit and enumerated");
  await r.done();
});

test("事件流续读", "the SSE stream replays from a cursor and resumes without gaps", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "go" });
  await settle(r.scheduler);

  const read = async (after: number) => {
    const res = await fetch(`${r.base}/agents/${agent.agentId}/events?after=${after}&once=1`, {
      headers: { authorization: `Bearer ${A_KEY}` },
    });
    const text = await res.text();
    return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  };
  const all = await read(0);
  assert(all.length >= 3, `stream carried the run (${all.length} events)`);
  const resumed = await read(all[0]!);
  eq(resumed.join(","), all.slice(1).join(","), "resume from a cursor yields exactly the remainder");
  await r.done();
});

test("流保活", "an idle stream keeps sending bytes so client timeouts do not kill it", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const res = await fetch(`${r.base}/agents/${agent.agentId}/events?after=0`, {
    headers: { authorization: `Bearer ${A_KEY}` },
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !text.includes(": keepalive")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  assert(text.includes(": connected"), "stream opens with a byte immediately");
  assert(text.includes(": keepalive"), "idle stream emits keepalive comments");
  await r.done();
});

test("游标过期", "an aged-out cursor fails loudly and points at a snapshot", async () => {
  const r = await rig(50);
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const res = await fetch(`${r.base}/agents/${agent.agentId}/events?after=3`, {
    headers: { authorization: `Bearer ${A_KEY}` },
  });
  eq(res.status, 410, "gone, not a silent gap");
  const body = await res.json();
  eq(body.error, "cursor_expired", "explicit reason");
  eq(body.snapshot, `/agents/${agent.agentId}/snapshot`, "recovery path given");
  eq((await r.call("GET", body.snapshot, A_KEY)).status, 200, "snapshot is readable");
  await r.done();
});

test("operation 查询与取消", "operations are queryable and cancellable, terminal ones refuse", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  const { body: msg } = await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "go" });
  await r.store.recordOperation({
    operationId: "op-live", tenantId: "tenant-a", agentId: agent.agentId, taskId: msg.taskId,
    mountAlias: "gh", tool: "github.actions.run", toolVersion: "1.0.0",
  });
  eq((await r.call("GET", "/operations/op-live", A_KEY)).body.status, "pending", "queryable");
  eq((await r.call("POST", "/operations/op-live/cancel", A_KEY, {})).body.status, "cancelled", "cancellable");
  eq((await r.call("POST", "/operations/op-live/cancel", A_KEY, {})).status, 409, "already terminal");
  await r.done();
});

test("坏输入", "malformed requests are refused with a reason, never a 500", async () => {
  const r = await rig();
  const { body: agent } = await r.call("POST", "/agents", A_KEY, {});
  const { body: thread } = await r.call("POST", `/agents/${agent.agentId}/threads`, A_KEY, {});
  eq((await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "  " })).status, 400, "empty text");
  eq((await r.call("POST", `/threads/${thread.threadId}/messages`, A_KEY, { text: "x", taskId: "nope" })).status, 404, "unknown task");
  eq((await r.call("GET", "/nope", A_KEY)).status, 404, "unknown route");
  const bad = await fetch(`${r.base}/agents`, {
    method: "POST", headers: { authorization: `Bearer ${A_KEY}` }, body: "{not json",
  });
  eq(bad.status, 400, "invalid json body");
  await r.done();
});

let pass = 0, fail = 0;
console.log(`\n  HTTP API & scheduler\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try { await t.fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(20)} ${t.name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(20)} ${t.name}\n      \x1b[31m${(e as Error).message}\x1b[0m`); }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
