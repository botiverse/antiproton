/**
 * A command that outlives its call is handed over, not waited on.
 *
 * Waiting cost the whole turn: pi serialises every tool call in a turn when
 * one of them asks for it, so an agent waiting on a container ran nothing else
 * and thought nothing else — three quarters of billed Worker time on a
 * SWE-bench task (cody, 2026-09-14). So the call waits a short grace and then
 * hands back a job.
 *
 * The property these cases exist for is that **both endings agree**: a command
 * that finishes inside the grace and the same command finished later through
 * `pollBackground` must produce the same result, because the model cannot tell
 * which way its work came back and nothing downstream should have to.
 */
import { sandboxPlugin } from "../src/plugins/sandbox.ts";
import { Backgrounded } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const plugin = sandboxPlugin(null as any, "local");
const BOX = { boxId: "b1", createdAt: 1, lastUsedAt: 1, execs: 0, sessions: [], envs: [] };

/** run9, answering with the exec states given, one per GET. */
function run9(states: string[], extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let written: unknown = null;
  let i = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path.replace("https://sandbox.example", "")}`);
    if (/\/execs$/.test(path)) return new Response(JSON.stringify({ exec_id: "e1" }));
    if (/\/kill$/.test(path)) return new Response("{}");
    const state = states[Math.min(i++, states.length - 1)]!;
    return new Response(JSON.stringify({ state, exit_code: state === "succeeded" ? 0 : null, output_summary: "hello" }));
  }) as any;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", graceMs: 0, ...extra },
    connection: { get: async () => BOX, set: async (v: unknown) => { written = v; } },
    sibling: async () => null,
  };
  return { ctx, calls, written: () => written };
}

const original = globalThis.fetch;

await check("跑得完的命令照旧在这次调用里给出结果", async () => {
  const { ctx } = run9(["succeeded"], { graceMs: 10_000 });
  const r: any = await plugin.invoke("shell", { command: "echo hi" }, ctx);
  if (r instanceof Backgrounded) throw new Error("a command that had already finished was handed over anyway");
  if (r.state !== "succeeded" || r.exitCode !== 0) throw new Error(`not the finished result: ${JSON.stringify(r).slice(0, 120)}`);
});

await check("跑不完的命令交回一个句柄,而不是把这一轮占住", async () => {
  const { ctx } = run9(["running"]);
  const r: any = await plugin.invoke("shell", { command: "sleep 600" }, ctx);
  if (!(r instanceof Backgrounded)) throw new Error(`the call held on instead of handing over: ${JSON.stringify(r).slice(0, 120)}`);
  if ((r.handle as any).execId !== "e1" || (r.handle as any).boxId !== "b1") {
    throw new Error(`the handle cannot find the work again: ${JSON.stringify(r.handle)}`);
  }
  if (JSON.stringify(r.handle).includes("ak") || JSON.stringify(r.handle).includes("sk")) {
    throw new Error("the handle carries a credential");
  }
});

await check("两种结局给出【同一个结果】—— 这是这组用例真正守的东西", async () => {
  // The same command, finished in the call and finished through the poll. If
  // these ever differ, the model's result depends on how long its command
  // happened to take.
  const a = run9(["succeeded"], { graceMs: 10_000 });
  const inline: any = await plugin.invoke("shell", { command: "echo hi" }, a.ctx);

  const b = run9(["succeeded"]);
  const later: any = await plugin.pollBackground!({ boxId: "b1", execId: "e1" }, b.ctx);
  if (later.done !== true) throw new Error("a terminal execution was reported unfinished");

  if (JSON.stringify(later.result) !== JSON.stringify(inline)) {
    throw new Error(`the two endings disagree:\n  inline: ${JSON.stringify(inline)}\n  polled: ${JSON.stringify(later.result)}`);
  }
});

await check("还在跑时 poll 说没完,而且【一个字节都不写连接状态】", async () => {
  // Writing state from a poll would race a second job finishing at the same
  // moment — the read-modify-write `exclusive` exists to prevent, in a place
  // `exclusive` does not reach (Piper, 2026-09-14).
  const { ctx, written } = run9(["running"]);
  const r: any = await plugin.pollBackground!({ boxId: "b1", execId: "e1" }, ctx);
  if (r.done !== false) throw new Error(`a running execution was reported done: ${JSON.stringify(r)}`);
  if (written() !== null) throw new Error(`poll wrote connection state: ${JSON.stringify(written())}`);
});

await check("取消就是去把它杀掉", async () => {
  const { ctx, calls } = run9(["running"]);
  await plugin.cancelBackground!({ boxId: "b1", execId: "e1" }, ctx);
  if (!calls.some((c) => c === "POST /projects/default/workspace/execs/e1/kill")) {
    throw new Error(`cancelling did not kill the execution: ${JSON.stringify(calls)}`);
  }
});

globalThis.fetch = original;
console.log(`\n  A command that outlives its call\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
