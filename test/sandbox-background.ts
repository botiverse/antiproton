/**
 * A command that outlives its call is handed over, not waited on.
 *
 * Waiting cost the whole turn: pi serialises every tool call in a turn when
 * one of them asks for it, so an agent waiting on a container ran nothing else
 * and thought nothing else — three quarters of billed Worker time on a
 * SWE-bench task. So the call waits a short grace and then
 * hands back a job.
 *
 * The property these cases exist for is that **both endings agree**: a command
 * that finishes inside the grace and the same command finished later through
 * `background.poll` must produce the same result, because the model cannot tell
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
    if (/execs$/.test(path)) return new Response(JSON.stringify({ exec_id: "e1" }));
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


await check("命令起在 run9 的【background 路由】上 —— 否则根本杀不掉", async () => {
  // `POST /execs/{id}/kill` answers 400 `exec is not background mode` for an
  // execution started on the plain route, and the command runs to completion
  // no matter what our ledger says (measured on our own box, 2026-09-14). So
  // which route starts it is not a detail of plumbing: it is the difference
  // between a cancel that works and one that only looks like it did.
  const { ctx, calls } = run9(["running"]);
  await plugin.invoke("shell", { command: "sleep 600" }, ctx);
  const started = calls.filter((c) => c.startsWith("POST") && c.includes("/boxes/"));
  if (!started.some((c) => c.endsWith("/background-execs"))) {
    throw new Error(`the command was started on a route run9 will not kill: ${JSON.stringify(started)}`);
  }
});

await check("两种结局给出【同一个结果】—— 这是这组用例真正守的东西", async () => {
  // The same command, finished in the call and finished through the poll. If
  // these ever differ, the model's result depends on how long its command
  // happened to take.
  const a = run9(["succeeded"], { graceMs: 10_000 });
  const inline: any = await plugin.invoke("shell", { command: "echo hi" }, a.ctx);

  const b = run9(["succeeded"]);
  const later: any = await plugin.background!.poll({ boxId: "b1", execId: "e1" }, b.ctx);
  if (later.done !== true) throw new Error("a terminal execution was reported unfinished");

  if (JSON.stringify(later.result) !== JSON.stringify(inline)) {
    throw new Error(`the two endings disagree:\n  inline: ${JSON.stringify(inline)}\n  polled: ${JSON.stringify(later.result)}`);
  }
});

await check("还在跑时 poll 说没完,而且【一个字节都不写连接状态】", async () => {
  // Writing state from a poll would race a second job finishing at the same
  // moment — the read-modify-write `exclusive` exists to prevent, in a place
  // `exclusive` does not reach.
  const { ctx, written } = run9(["running"]);
  const r: any = await plugin.background!.poll({ boxId: "b1", execId: "e1" }, ctx);
  if (r.done !== false) throw new Error(`a running execution was reported done: ${JSON.stringify(r)}`);
  if (written() !== null) throw new Error(`poll wrote connection state: ${JSON.stringify(written())}`);
});

/**
 * run9 for the cancelling cases: the kill's answers and the states the
 * execution reports afterwards are given separately, because the whole point
 * of these cases is that those two can disagree.
 */
function killing(kills: number[], states: string[]) {
  const calls: string[] = [];
  let k = 0, s = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url).replace("https://sandbox.example", "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (/\/kill$/.test(path)) {
      const status = kills[Math.min(k++, kills.length - 1)]!;
      return new Response(status === 200 ? "{}" : "no such exec", { status });
    }
    const state = states[Math.min(s++, states.length - 1)]!;
    return new Response(JSON.stringify({ state, exit_code: null, output_summary: "" }));
  }) as any;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", graceMs: 0 },
    connection: { get: async () => BOX, set: async () => {} },
    sibling: async () => null,
  };
  return { ctx, calls };
}

await check("取消就是去把它杀掉,而且要【确认它真的停了】", async () => {
  const { ctx, calls } = killing([200], ["killed"]);
  await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx);
  if (!calls.some((c) => c === "POST /projects/default/workspace/execs/e1/kill")) {
    throw new Error(`cancelling did not kill the execution: ${JSON.stringify(calls)}`);
  }
  if (!calls.some((c) => c === "GET /projects/default/workspace/execs/e1")) {
    throw new Error(`cancelling never checked that it had stopped: ${JSON.stringify(calls)}`);
  }
});

await check("杀不掉就【说出来】,不能咽下去", async () => {
  // The defect this case exists for: with three jobs running, a refused fourth
  // was cancelled through this path, the kill did not take, and the command
  // ran to completion in the container — with no job id, so nothing could list
  // it or cancel it. A swallowed failure is a cancellation
  // that did not happen, still billing, with nothing left that can name it.
  const { ctx } = killing([404], ["running"]);
  let threw: string | null = null;
  await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx)
    .catch((e) => { threw = String((e as Error).message); });
  if (threw === null) throw new Error("a kill that never took was reported as a successful cancel");
  if (!String(threw).includes("e1")) throw new Error(`the failure does not say which execution: ${threw}`);
});

await check("两种失败【说的不是一回事】,调用方要能分开它们", async () => {
  // The caller reports this to the agent, so the words are part of the
  // contract. A refused kill is a statement about the process — nothing
  // stopped it. An accepted kill whose state has not settled is not: claiming
  // "it kept running" there would pass on a claim we never made (Vera).
  // Built one at a time: `killing` installs its stub on the spot, so two
  // fixtures made up front would both answer with the second one's rules.
  const said = async (kills: number[]) => {
    const { ctx } = killing(kills, ["running"]);
    let msg = "";
    await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx).catch((e) => { msg = String((e as Error).message); });
    return msg;
  };
  const a = await said([400]);
  const b = await said([200]);
  for (const m of [a, b]) {
    if (!/could not confirm/i.test(m)) throw new Error(`a cancel that proved nothing claimed more than it knew: ${m}`);
  }
  // run9's own answer is what tells the runtime the kill was refused, and the
  // status code is the part of it that is actionable.
  if (!a.includes("400")) throw new Error(`a refused kill does not carry run9's answer: ${a}`);
  if (!/kill accepted/.test(b) || b.includes("400")) {
    throw new Error(`an accepted kill is not told apart from a refused one: ${b}`);
  }
});

await check("杀请求成功、但进程还在跑 —— 这也是【没停】", async () => {
  // "The kill returned 200" is our record; "the process is gone" is the fact,
  // and the bill follows the fact.
  const { ctx } = killing([200], ["running"]);
  let threw = false;
  await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx).catch(() => { threw = true; });
  if (!threw) throw new Error("an execution still running after an accepted kill was reported as stopped");
});

await check("杀请求被拒、但它其实早就结束了 —— 不算失败", async () => {
  // A kill refused for an execution that has already ended is not a failure to
  // report: the state, not the kill's answer, is what is asked.
  const { ctx } = killing([404], ["succeeded"]);
  await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx);
});

await check("只杀一次、只确认一次 —— 重试归运行时,不在插件里绕圈", async () => {
  // The kill most likely to be refused is the one sent the instant an exec
  // starts, which is when the cap fires. Retrying here would look like the fix
  // and would instead hide the state the runtime needs: it is what keeps a
  // refused job tracked and asks again at its ceiling.
  const { ctx, calls } = killing([409], ["running"]);
  await plugin.background!.cancel({ boxId: "b1", execId: "e1" }, ctx).catch(() => {});
  const kills = calls.filter((c) => c.endsWith("/kill")).length;
  const gets = calls.filter((c) => !c.endsWith("/kill")).length;
  if (kills !== 1 || gets !== 1) throw new Error(`one kill and one check, not ${kills} and ${gets}: ${JSON.stringify(calls)}`);
});

globalThis.fetch = original;
console.log(`\n  A command that outlives its call\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
