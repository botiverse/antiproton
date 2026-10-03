/**
 * SWE-bench on the object, set up the way bench/swebench/cf.ts sets it up (`benchSweStart`), on both engines:
 * the grader's shell (`benchSweShell`) reaches the machine the task mounted, and the agent is never able to
 * release that machine before the grader has run in it.
 *
 * Why this exists: the mount moved from `node` to `sandbox` and the grader kept calling `node.shell`, so
 * every grading call answered `no mount named "node"` and every instance scored unresolved; the withheld
 * `node.release` named nothing, so the agent was offered `sandbox__release` and called it. Nothing failed,
 * because no test started a SWE task. These cases name no alias of their own: they ask the task what it
 * mounted, so a future rename that moves one caller and not the other turns them red.
 *
 * The whole `AgentDO` under node, as test/bench-pd.ts runs it, with the model faked at the queue and run9
 * faked at `fetch`: a request reaching run9 is the proof that a call reached the machine's plugin.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { refuseWithheld } from "../src/runtime/pi-tools.ts";
import { handleSandboxCall } from "../src/runtime/dynamic-worker-executor.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

let clock = Date.now();
Date.now = () => ++clock;

/** Every request that left for run9, and its body. Each answers 503: reaching it is all these cases ask. */
const run9: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  run9.push({ url, body: typeof init?.body === "string" ? init.body : "" });
  return new Response(JSON.stringify({ error: "run9 is faked in this test" }), { status: 503, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const IMAGE = "docker.io/swebench/sweb.eval.x86_64.example_1776_repo-1:latest";
const NO_D1 = {
  prepare: () => { const s: any = { bind: () => s, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }; return s; },
  batch: async () => [],
};

/** One bench object as bench/objects.ts names it, with the operator's run9 account configured. */
function object() {
  const raw = sqliteHost();
  const jobs: string[] = [];
  const state = { alarmAt: null as number | null };
  const ctx = {
    storage: {
      sql: raw.sql, transactionSync: raw.transactionSync,
      getAlarm: async () => state.alarmAt,
      setAlarm: async (at: number) => { state.alarmAt = at; },
      deleteAlarm: async () => { state.alarmAt = null; },
    },
    id: { toString: () => "do-swe" }, getWebSockets: () => [],
    // run_js's way back to the object (cf/src/index.ts `SandboxTools`), without the hop through the namespace.
    exports: {
      SandboxTools: ({ props }: { props: { execId: string } }) => ({
        invoke: (strings: string[], values: unknown[]) => handleSandboxCall(props.execId, strings, values),
      }),
    },
  };
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async () => ({}), head: async () => null, list: async () => ({ objects: [] }), get: async () => null },
    ARTIFACT_BUCKET: "b", CONTROL_DB: NO_D1, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    RUN9: JSON.stringify({ ak: "ak", sk: "sk" }),
    // A Worker Loader whose every program is the one in `program`: it makes its host calls through the
    // binding the executor hands it, exactly as a loaded program's `tools` would, and ends.
    LOADER: {
      load: ({ env: e }: { env: { TOOLS: { invoke(s: string[], v: unknown[]): Promise<unknown> } } }) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const outputs = [];
            for (const call of program) outputs.push(await e.TOOLS.invoke([call], [{}]));
            return Response.json({ ok: true, outputs, sent: program.length });
          },
        }),
      }),
    },
  };
  const D = new AgentDO(ctx as never, env as never) as any;
  /** The next model job the object sends, firing the alarm until it has sent one. */
  const nextJob = async (agentId: string) => {
    for (let i = 0; i < 20 && !jobs.length; i++) {
      if (state.alarmAt === null) break;
      clock = Math.max(clock, state.alarmAt);
      await D.alarm();
    }
    must(jobs.length, "the object sent no model job");
    const id = jobs.shift()!;
    return { id, job: await D.takeJob("bench", agentId, id) as any };
  };
  return { D, raw, nextJob };
}

/** The dotted addresses the next run_js program calls, in order. */
let program: string[] = [];

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const engine of ["pd", "pi085"] as const) {
  const taskId = `swe_${engine}`;
  const agentId = `b_${taskId}`;
  const o = object();
  let started: any = null;
  let offered: string[] = [];

  await check(`${engine}: a SWE task starts on the engine it asked for`, async () => {
    started = await o.D.benchSweStart(taskId, { policy: "fix it", image: IMAGE, engine });
    must(started.engine === engine && started.mode === "swe", `benchSweStart answered ${show(started)}`);
  });

  await check(`${engine}: the grader's shell reaches the machine the task mounted, built from the instance's image`, async () => {
    run9.length = 0;
    const res = await o.D.benchSweShell(taskId, "git diff") as any;
    // The failure this suite was written for: the grader addressing a mount the task does not have.
    must(res?.error?.code !== "not_mounted", `the grader addressed a mount this task does not have: ${show(res)}`);
    must(run9.length > 0, `the grader's shell never reached run9: ${show(res)}`);
    must(run9.some((r) => r.body.includes(IMAGE)), `no request asked for the instance's image: ${show(run9.map((r) => r.url))}`);
  });

  await check(`${engine}: the agent is offered the machine's shell and not its release`, async () => {
    await o.D.benchSay(taskId, "fix the bug");
    const { id, job } = await o.nextJob(agentId);
    offered = (job?.context?.tools ?? []).map((t: any) => String(t.name));
    must(offered.some((n) => n.endsWith("__shell")), `no shell offered: ${show(offered)}`);
    must(!offered.some((n) => n.endsWith("__release")), `the agent was offered a release: ${show(offered)}`);
    // Hand the turn back finished, so the next case starts from an idle task.
    await o.D.deliverAnswer("bench", agentId, id, { role: "assistant", content: [{ type: "text", text: "done" }], api: "x", provider: "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
  });

  await check(`${engine}: a model call to the release releases nothing`, async () => {
    const shell = offered.find((n) => n.endsWith("__shell"));
    must(shell, "no shell was offered, so the release's name cannot be derived");
    const release = shell.replace(/__shell$/, "__release");
    await o.D.benchSay(taskId, "tidy up");
    const first = await o.nextJob(agentId);
    run9.length = 0;
    await o.D.deliverAnswer("bench", agentId, first.id, {
      role: "assistant", stopReason: "toolUse", api: "x", provider: "x", model: "m1", usage: USAGE, timestamp: 0,
      content: [{ type: "toolCall", id: "c_rel", name: release, arguments: {} }],
    }, 5);
    const second = await o.nextJob(agentId);
    const reply = (second.job?.context?.messages ?? []).find((m: any) => m.role === "toolResult" && m.toolCallId === "c_rel");
    must(reply, `the call got no tool result: ${show(second.job?.context?.messages?.slice(-2))}`);
    must(reply.isError, `the release was carried out: ${show(reply)}`);
    must(run9.length === 0, `the call reached run9: ${show(run9.map((r) => r.url))}`);
    await o.D.deliverAnswer("bench", agentId, second.id, { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
  });

  await check(`${engine}: a run_js program naming the release by address is refused`, async () => {
    // run_js passes a dotted address to the host without looking it up in the offered list, so the
    // catalogue alone cannot stop this; the refusal at dispatch does.
    const shell = offered.find((n) => n.endsWith("__shell"));
    must(shell && offered.includes("run_js"), `run_js or a shell missing: ${show(offered)}`);
    program = [`${shell.replace(/__shell$/, "")}.release`];
    await o.D.benchSay(taskId, "tidy up from a script");
    const first = await o.nextJob(agentId);
    run9.length = 0;
    await o.D.deliverAnswer("bench", agentId, first.id, {
      role: "assistant", stopReason: "toolUse", api: "x", provider: "x", model: "m1", usage: USAGE, timestamp: 0,
      content: [{ type: "toolCall", id: "c_js", name: "run_js", arguments: { source: "ignored by the fake loader" } }],
    }, 5);
    const second = await o.nextJob(agentId);
    const reply = (second.job?.context?.messages ?? []).find((m: any) => m.role === "toolResult" && m.toolCallId === "c_js");
    must(reply, `run_js got no tool result: ${show(second.job?.context?.messages?.slice(-2))}`);
    must(show(reply).includes("withheld"), `the program's release was not refused: ${show(reply).slice(0, 600)}`);
    must(run9.length === 0, `the call reached run9: ${show(run9.map((r) => r.url))}`);
    await o.D.deliverAnswer("bench", agentId, second.id, { role: "assistant", content: [{ type: "text", text: "ok" }], api: "x", provider: "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
  });

  o.raw.dispose();
}

await check("a withheld address is refused at dispatch, and nothing else is", () => {
  // run_js passes a dotted address to the host without looking it up in the offered list, so leaving the
  // tool out of the list does not stop a program naming it; the host asks this before every dispatch.
  const held = new Set(["sandbox.release"]);
  const r = refuseWithheld("sandbox.release", held);
  must(r?.status === "rejected" && r.error.code === "withheld", `not refused: ${show(r)}`);
  must(refuseWithheld("sandbox.shell", held) === null, "a tool that is not withheld was refused");
  must(refuseWithheld("sandbox.release", new Set()) === null, "an agent withholding nothing was refused");
});

globalThis.fetch = realFetch;
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
