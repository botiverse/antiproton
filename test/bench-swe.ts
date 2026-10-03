/**
 * SWE-bench on the object, set up the way bench/swebench/cf.ts sets it up (`benchSweStart`), on both engines:
 * the grader's shell reaches the machine the task mounted and gets the command's real output even when the
 * command outlives the sandbox's grace window, and the agent cannot hand that machine back before the grader
 * has run in it — not by calling the tool, not from run_js, and does not find the tools by searching.
 *
 * Why this exists: the mount moved from `node` to `sandbox` and the grader kept calling `node.shell`, so every
 * grading call answered `no mount named "node"`; the withheld `node.release` named nothing, so the agent was
 * offered `sandbox__release` and called it; and once the shell worked, any grading command longer than 5 s
 * came back `running` with no output and graded as a failure. Nothing failed, because no test started a SWE
 * task. These cases name no alias of their own: they ask the task what it mounted.
 *
 * The whole `AgentDO` under node, as test/bench-pd.ts runs it, with the model faked at the queue and run9
 * faked at `fetch` as a small stateful service: boxes are created and deleted, executions run for as long as
 * they are told to on a clock the test owns, and every operation is recorded. A release that was carried out
 * is a DELETE in that record and a box gone from it, which is what the refusal cases look for.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { refuseWithheld } from "../src/runtime/pi-tools.ts";
import { handleSandboxCall } from "../src/runtime/dynamic-worker-executor.ts";
import { settleShell, type ShellAnswer } from "../bench/swebench/grade.ts";
import { decideFromPoll } from "../bench/poll-fallback.ts";
import { BACKGROUND_MAX_MS, BACKGROUND_STOP_GRACE_MS } from "../src/runtime/background-jobs.ts";

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

/** How long, on the test's clock, a command marked SLOW runs: longer than the sandbox's 5 s grace window. */
const SLOW_MS = 8_000;
/** Each look at an execution moves the clock this far, so the grace window passes in two looks, not five seconds. */
const STEP_MS = 3_000;
const SLOW_OUTPUT = "FAILED t.py::test_x\n1 failed in 7.9s";

/** run9, faked: boxes, executions on the test's clock, and a record of every operation. */
const run9 = {
  boxes: new Map<string, { image: string }>(),
  /** `doneAt` Infinity is a command that never ends by itself (HANG); `killable` false is one a kill does not stop (UNKILLABLE). */
  execs: new Map<string, { doneAt: number; output: string; killable: boolean; killed?: boolean }>(),
  ops: [] as Array<{ method: string; path: string; body: string }>,
  /** Run, not awaited, when a command containing FINISH starts: the runner ending the task while the agent's call
   *  is in flight. Not awaited because the runner's request is its own event, not part of the call: a cancel
   *  waits for the running turn, and the turn is waiting on this call. */
  onFinishCommand: null as null | (() => void),
  reset() { this.boxes.clear(); this.execs.clear(); this.ops.length = 0; this.onFinishCommand = null; },
  deletes() { return this.ops.filter((o) => o.method === "DELETE" && /\/boxes\/[^/]+$/.test(o.path)); },
  creates() { return this.ops.filter((o) => o.method === "POST" && /\/workspace\/boxes$/.test(o.path)); },
};
const realFetch = globalThis.fetch;
let execN = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input?.url ?? input));
  const method = String(init?.method ?? "GET");
  const path = url.pathname;
  const body = typeof init?.body === "string" ? init.body : "";
  run9.ops.push({ method, path, body });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  let m: RegExpExecArray | null;
  if (method === "POST" && /\/workspace\/boxes$/.test(path)) {
    const b = JSON.parse(body);
    run9.boxes.set(b.box_id, { image: b.source_image_ref });
    return json({ box_id: b.box_id });
  }
  if (method === "GET" && /\/workspace\/boxes$/.test(path)) {
    return json([...run9.boxes.keys()].map((id) => ({ box_id: id, state: "ready" })));
  }
  if ((m = /\/workspace\/boxes\/([^/]+)\/background-execs$/.exec(path)) && method === "POST") {
    if (!run9.boxes.has(m[1]!)) return json({ error: "no such box" }, 404);
    const argv = JSON.parse(body).command as string[];
    const line = argv.join(" ");
    const slow = line.includes("SLOW");
    if (line.includes("FINISH") && run9.onFinishCommand) run9.onFinishCommand();
    const id = `e${++execN}`;
    run9.execs.set(id, {
      doneAt: line.includes("HANG") ? Infinity : clock + (slow ? SLOW_MS : 0), output: slow ? SLOW_OUTPUT : "fast",
      killable: !line.includes("UNKILLABLE"),
    });
    return json({ exec_id: id });
  }
  if ((m = /\/workspace\/execs\/([^/]+)$/.exec(path)) && method === "GET") {
    const e = run9.execs.get(m[1]!);
    if (!e) return json({ error: "no such exec" }, 404);
    clock += STEP_MS;
    if (e.killed) return json({ state: "killed", exit_code: 137, output_summary: "" });
    return clock < e.doneAt ? json({ state: "running" }) : json({ state: "succeeded", exit_code: 0, output_summary: e.output });
  }
  if ((m = /\/workspace\/execs\/([^/]+)\/kill$/.exec(path)) && method === "POST") {
    const e = run9.execs.get(m[1]!);
    if (!e) return json({ error: "no such exec" }, 404);
    if (e.killable) e.killed = true;
    return json({});
  }
  if ((m = /\/workspace\/boxes\/([^/]+)\/stop$/.exec(path)) && method === "POST") return json({});
  if ((m = /\/workspace\/boxes\/([^/]+)$/.exec(path)) && method === "DELETE") {
    run9.boxes.delete(m[1]!);
    return json({});
  }
  if (/\/secrets$/.test(path)) return json([]);
  return json({ error: `not faked: ${method} ${path}` }, 404);
}) as typeof fetch;

const IMAGE = "docker.io/swebench/sweb.eval.x86_64.example_1776_repo-1:latest";
const NO_D1 = {
  prepare: () => { const s: any = { bind: () => s, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }; return s; },
  batch: async () => [],
};

/** The dotted addresses the next run_js program calls, with these arguments, in order. */
let program: Array<{ tool: string; args: Record<string, unknown> }> = [];

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
    // A Worker Loader whose every program is `program`: it makes its host calls through the binding the
    // executor hands it, exactly as a loaded program's `tools` would, and ends.
    LOADER: {
      load: ({ env: e }: { env: { TOOLS: { invoke(s: string[], v: unknown[]): Promise<unknown> } } }) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const outputs = [];
            for (const call of program) outputs.push(await e.TOOLS.invoke([call.tool], [call.args]));
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
  /** Fire whatever alarm is set, up to `passes` times, moving the clock to it; the jobs sent meanwhile stay queued. */
  const passAlarms = async (passes: number) => {
    for (let i = 0; i < passes && state.alarmAt !== null; i++) {
      clock = Math.max(clock, state.alarmAt);
      await D.alarm();
    }
  };
  return { D, raw, nextJob, jobs, passAlarms, state };
}

const USAGE = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 });
const calls = (...c: Array<{ id: string; name: string; arguments: unknown }>) => ({
  role: "assistant", stopReason: "toolUse", api: "x", provider: "x", model: "m1", usage: USAGE, timestamp: 0,
  content: c.map((x) => ({ type: "toolCall", ...x })),
});
const resultOf = (job: any, callId: string) =>
  (job?.context?.messages ?? []).find((m: any) => m.role === "toolResult" && m.toolCallId === callId);

for (const engine of ["pd", "pi085"] as const) {
  const taskId = `swe_${engine}`;
  const agentId = `b_${taskId}`;
  const o = object();
  run9.reset();
  let offered: string[] = [];
  /** The mount's alias, as the model is offered it: read from the list, never written down here. */
  let alias = "";
  const box = () => [...run9.boxes.keys()][0];

  await check(`${engine}: a SWE task starts on the engine it asked for`, async () => {
    const started = await o.D.benchSweStart(taskId, { policy: "fix it", image: IMAGE, engine });
    must(started.engine === engine && started.mode === "swe", `benchSweStart answered ${show(started)}`);
  });

  await check(`${engine}: a grading command longer than the grace window answers with its real output`, async () => {
    // What the driver does (bench/swebench/cf.ts `shell`): the shell, then the job until it ends.
    const first: ShellAnswer = await o.D.benchSweShell(taskId, "echo SLOW && python -m pytest t.py");
    must(first?.error?.code !== "not_mounted", `the grader addressed a mount this task does not have: ${show(first)}`);
    must(run9.ops.some((r) => r.body.includes(IMAGE)), `no box was made from the instance's image: ${show(run9.ops.map((r) => r.path))}`);
    must(first.status === "running" && first.background, `the command did not outlive the grace window, so this case tests nothing: ${show(first)}`);
    const done = await settleShell(first, (bg) => o.D.benchSweJob(taskId, bg.alias, bg.handle),
      { deadlineAt: clock + 60_000, sleep: async () => {} });
    must(done.status === "succeeded" && String(done.result?.output ?? "").includes(SLOW_OUTPUT),
      `grading read ${show(done).slice(0, 300)}, not the command's output`);
    must(box(), "no box exists after the shell");
  });

  await check(`${engine}: the agent is offered the machine's shell, and neither release nor start_from`, async () => {
    await o.D.benchSay(taskId, "fix the bug");
    const { id, job } = await o.nextJob(agentId);
    offered = (job?.context?.tools ?? []).map((t: any) => String(t.name));
    const shell = offered.find((n) => n.endsWith("__shell"));
    must(shell, `no shell offered: ${show(offered)}`);
    alias = shell.slice(0, -"__shell".length);
    must(!offered.includes(`${alias}__release`) && !offered.includes(`${alias}__start_from`), `offered: ${show(offered)}`);
    await o.D.deliverAnswer("bench", agentId, id, say("done"), 5);
  });

  await check(`${engine}: called directly, release and start_from are refused, the box survives, and search does not find them`, async () => {
    must(alias && box(), "the earlier cases did not leave a box and an alias");
    const before = box();
    await o.D.benchSay(taskId, "tidy up");
    const first = await o.nextJob(agentId);
    run9.ops.length = 0;
    await o.D.deliverAnswer("bench", agentId, first.id, calls(
      { id: "c_rel", name: `${alias}__release`, arguments: {} },
      { id: "c_from", name: `${alias}__start_from`, arguments: { name: "kept" } },
      { id: "c_find", name: "tools__search", arguments: { query: "release start_from shell" } },
    ), 5);
    const second = await o.nextJob(agentId);
    for (const c of ["c_rel", "c_from"]) {
      const r = resultOf(second.job, c);
      must(r?.isError, `${c} was carried out: ${show(r).slice(0, 300)}`);
    }
    const found = show(resultOf(second.job, "c_find"));
    must(found.includes(`${alias}__shell`), `search found nothing, so it says nothing about withheld tools: ${found.slice(0, 400)}`);
    must(!found.includes(`${alias}__release`) && !found.includes(`${alias}__start_from`), `search found a withheld tool: ${found.slice(0, 400)}`);
    must(run9.deletes().length === 0, `a release reached run9: ${show(run9.deletes())}`);
    must(box() === before, `the box is gone: ${show([...run9.boxes.keys()])}`);
    await o.D.deliverAnswer("bench", agentId, second.id, say("ok"), 5);
  });

  await check(`${engine}: from run_js, release and start_from by address are refused and the box survives`, async () => {
    // run_js passes a dotted address to the host without looking it up in the offered list, so leaving the
    // tools out of the list cannot stop this; the refusal at dispatch does.
    must(offered.includes("run_js"), `run_js not offered: ${show(offered)}`);
    const before = box();
    program = [{ tool: `${alias}.release`, args: {} }, { tool: `${alias}.start_from`, args: { name: "kept" } }];
    await o.D.benchSay(taskId, "tidy up from a script");
    const first = await o.nextJob(agentId);
    run9.ops.length = 0;
    await o.D.deliverAnswer("bench", agentId, first.id, calls({ id: "c_js", name: "run_js", arguments: { source: "ignored by the fake loader" } }), 5);
    const second = await o.nextJob(agentId);
    const r = show(resultOf(second.job, "c_js"));
    must((r.match(/withheld/g) ?? []).length >= 2, `the program's calls were not both refused: ${r.slice(0, 600)}`);
    must(run9.deletes().length === 0, `a release reached run9: ${show(run9.deletes())}`);
    must(box() === before, `the box is gone: ${show([...run9.boxes.keys()])}`);
    await o.D.deliverAnswer("bench", agentId, second.id, say("ok"), 5);
  });

  await check(`${engine}: the runner's own release does delete the box (the fake can see a release)`, async () => {
    const before = box();
    must(before, "no box to release");
    const res = await o.D.benchSweRelease(taskId) as any;
    must(run9.deletes().some((d) => d.path.endsWith(`/boxes/${before}`)) && !run9.boxes.has(before), `not released: ${show(res)}`);
  });

  o.raw.dispose();
}

/** The sandbox mount's alias, read from the shell the model was offered. */
const SANDBOX_ALIAS_OF = (job: any) => {
  const shell = (job?.context?.tools ?? []).map((t: any) => String(t.name)).find((n: string) => n.endsWith("__shell"));
  must(shell, "no shell offered");
  return shell.slice(0, -"__shell".length);
};

/**
 * How a SWE task ends, on both engines (bench/swebench/cf.ts, cf/src/index.ts `benchSweFinish`). Each case is a
 * fault seen on a production run: the runner graded at an agent's "waiting for the queued commands" while a
 * background job was still out; a stalled agent's shell command after release provisioned a new box; and a job
 * left on the released box failed about forty minutes later and woke the idle agent into another turn.
 */
for (const engine of ["pd", "pi085"] as const) {
  /** A started task on a fresh object, its first model job taken. */
  const begin = async (name: string) => {
    const taskId = `swe_${name}_${engine}`;
    const agentId = `b_${taskId}`;
    const o = object();
    run9.reset();
    await o.D.benchSweStart(taskId, { policy: "fix it", image: IMAGE, engine });
    await o.D.benchSay(taskId, "fix the bug");
    const first = await o.nextJob(agentId);
    const shellName = (first.job?.context?.tools ?? []).map((t: any) => String(t.name)).find((n: string) => n.endsWith("__shell"));
    must(shellName, "no shell offered");
    /** What the runner decides from the object's poll (bench/swebench/cf.ts `look`). */
    const decide = async () => decideFromPoll(await o.D.benchPoll(taskId), 0);
    return { o, taskId, agentId, first, shellName: shellName as string, decide };
  };

  await check(`${engine}: an agent that says "waiting" while a background job runs is not taken as answered until the job ends and it settles`, async () => {
    const { o, taskId, agentId, first, shellName, decide } = await begin("wait");
    await o.D.deliverAnswer("bench", agentId, first.id, calls({ id: "c_slow", name: shellName, arguments: { command: "echo SLOW && python -m pytest" } }), 5);
    const second = await o.nextJob(agentId);
    const started = show(resultOf(second.job, "c_slow"));
    must(/background|job/i.test(started), `the command did not go to the background, so this case tests nothing: ${started.slice(0, 300)}`);
    await o.D.deliverAnswer("bench", agentId, second.id, say("Waiting for the queued commands to finish."), 5);
    await o.passAlarms(1);
    // The state the production runner graded in: idle, a text reply after the latest message, a job out.
    const paused = await o.D.benchPoll(taskId);
    must(paused.status === "idle" && String(paused.answer).startsWith("Waiting") && paused.background === 1,
      `not the paused state this case is about: ${show(paused)}`);
    const early = await decide();
    must(early === null, `taken as answered with a background job still out: ${show(early)}`);
    // The job ends on a later pass; its result is a message that starts the agent's next turn.
    const third = await o.nextJob(agentId);
    must(show(third.job?.context?.messages ?? []).includes("1 failed in 7.9s"), `the job's result did not reach the agent: ${show(third.job?.context?.messages?.slice(-1)).slice(0, 400)}`);
    must(await decide() === null, "taken as answered while the woken turn is still running");
    await o.D.deliverAnswer("bench", agentId, third.id, say("Fixed."), 5);
    await o.passAlarms(1);
    const d = await decide();
    must(d?.kind === "answer" && d.text === "Fixed.", `the settled agent's answer was not taken: ${show(d)}`);
    o.raw.dispose();
  });

  await check(`${engine}: after release, the agent's turn is cancelled and its next shell call creates no box`, async () => {
    const { o, taskId, agentId, first, shellName } = await begin("release");
    await o.D.deliverAnswer("bench", agentId, first.id, calls({ id: "c_ls", name: shellName, arguments: { command: "ls" } }), 5);
    // The agent is mid-turn: its next model call is out when the runner's budget ends and it releases.
    const second = await o.nextJob(agentId);
    const boxes = () => run9.boxes.size;
    must(boxes() === 1, `the agent's first call made no box: ${show([...run9.boxes.keys()])}`);
    const res = await o.D.benchSweRelease(taskId) as any;
    must(boxes() === 0, `release left a box: ${show([...run9.boxes.keys()])}`);
    must(res?.finish?.cancelledTurn, `release did not cancel the running turn: ${show(res)}`);
    const createsBefore = run9.creates().length;
    // The model's answer to the call that was out arrives anyway, asking for the shell.
    await o.D.deliverAnswer("bench", agentId, second.id, calls({ id: "c_again", name: shellName, arguments: { command: "ls" } }), 5).catch(() => false);
    await o.passAlarms(10);
    must(run9.creates().length === createsBefore && boxes() === 0,
      `a call after release provisioned a box: ${show(run9.creates().slice(createsBefore).map((c) => c.path))}`);
    const poll = await o.D.benchPoll(taskId);
    must(poll.status === "idle", `the agent is still running after release: ${show(poll)}`);
    o.raw.dispose();
  });

  await check(`${engine}: after finish, a call the agent makes is refused and the runner's grading shell still works`, async () => {
    const { o, taskId, agentId, first, shellName } = await begin("finish");
    await o.D.deliverAnswer("bench", agentId, first.id, calls({ id: "c_ls", name: shellName, arguments: { command: "ls" } }), 5);
    const second = await o.nextJob(agentId);
    await o.D.benchSweFinish(taskId);
    const createsBefore = run9.creates().length, execsBefore = run9.execs.size;
    await o.D.deliverAnswer("bench", agentId, second.id, calls({ id: "c_rm", name: shellName, arguments: { command: "git checkout ." } }), 5).catch(() => false);
    await o.passAlarms(10);
    must(run9.execs.size === execsBefore && run9.creates().length === createsBefore, `the agent reached the machine after finish: ${show(run9.ops.slice(-4))}`);
    const graded: ShellAnswer = await o.D.benchSweShell(taskId, "git diff --stat");
    must(graded.status === "succeeded", `the grader's shell was refused after finish: ${show(graded)}`);
    o.raw.dispose();
  });

  await check(`${engine}: after finish, a message to the agent is refused and starts no model call`, async () => {
    const { o, taskId, agentId, first } = await begin("say");
    await o.D.deliverAnswer("bench", agentId, first.id, say("Done."), 5);
    await o.passAlarms(1);
    await o.D.benchSweFinish(taskId);
    o.jobs.length = 0;
    // Anything that reaches the transcript after the end — here a message — must not become a turn.
    const said = await o.D.benchSay(taskId, "one more thing");
    must(said?.refused, `the message was taken: ${show(said).slice(0, 200)}`);
    await o.passAlarms(5);
    must(o.jobs.length === 0, `a turn started after finish: ${o.jobs.length} model call(s)`);
    o.raw.dispose();
  });

  await check(`${engine}: a program's calls after the task ends mid-program are refused and reach no machine`, async () => {
    const { o, taskId, agentId, first } = await begin("midway");
    const alias = SANDBOX_ALIAS_OF(first.job);
    // The first call starts a box; the runner ends the task while that call is in flight (finish: a release
    // would wait on the mount the call holds); the second is the stalled agent's next command.
    let finished: Promise<unknown> | null = null;
    run9.onFinishCommand = () => { finished = o.D.benchSweFinish(taskId); };
    program = [{ tool: `${alias}.shell`, args: { command: "echo FINISH" } }, { tool: `${alias}.shell`, args: { command: "ls" } }];
    await o.D.deliverAnswer("bench", agentId, first.id, calls({ id: "c_js", name: "run_js", arguments: { source: "ignored by the fake loader" } }), 5);
    await o.passAlarms(5);
    must(finished, "the task was never finished mid-program, so this case tests nothing");
    await finished;
    const execs = run9.ops.filter((r) => r.method === "POST" && /background-execs$/.test(r.path));
    must(execs.length >= 1 && execs[0]!.body.includes("FINISH"), `the program's first call did not run, so this case tests nothing: ${execs.length}`);
    const lsRuns = execs.slice(1);
    must(lsRuns.length === 0, `the call after the end ran: ${show(lsRuns.map((r) => r.path))}`);
    must(run9.creates().length === 1, `boxes provisioned: ${run9.creates().length}`);
    // The machine is the grader's now; releasing it leaves nothing behind.
    await o.D.benchSweRelease(taskId);
    await o.passAlarms(5);
    must(run9.boxes.size === 0 && run9.creates().length === 1, `after release: boxes ${show([...run9.boxes.keys()])}, provisioned ${run9.creates().length}`);
    o.raw.dispose();
  });

  await check(`${engine}: release stops a running background job, and a late failure of one it could not stop starts no turn and no box`, async () => {
    const { o, taskId, agentId, first, shellName } = await begin("late");
    await o.D.deliverAnswer("bench", agentId, first.id, calls(
      { id: "c_hang", name: shellName, arguments: { command: "echo HANG && sleep 100000" } },
      { id: "c_stuck", name: shellName, arguments: { command: "echo HANG UNKILLABLE && sleep 100000" } },
    ), 5);
    const second = await o.nextJob(agentId);
    await o.D.deliverAnswer("bench", agentId, second.id, say("Waiting on the sandbox shell to return results."), 5);
    must((await o.D.benchPoll(taskId)).background === 2, `both commands should be background jobs: ${show(await o.D.benchPoll(taskId))}`);
    const res = await o.D.benchSweRelease(taskId) as any;
    must(res?.finish?.stoppedJobs?.length === 1 && res.finish.stillRunning?.length === 1,
      `release should stop the killable job and report the other: ${show(res?.finish)}`);
    const createsBefore = run9.creates().length;
    o.jobs.length = 0;
    // Past the ceiling and its grace: the unkillable job is given up as failed, as on the production run.
    clock += BACKGROUND_MAX_MS + BACKGROUND_STOP_GRACE_MS + 60_000;
    await o.passAlarms(10);
    must((await o.D.benchPoll(taskId)).background === 0, "the unkillable job was never given up, so this case tests nothing");
    must(o.jobs.length === 0, `a late job result started a model call: ${o.jobs.length}`);
    must(run9.creates().length === createsBefore, `a late job result led to a new box: ${show(run9.creates().slice(createsBefore))}`);
    const poll = await o.D.benchPoll(taskId);
    must(poll.status === "idle", `the agent was woken: ${show(poll)}`);
    o.raw.dispose();
  });
}

await check("a withheld address is refused at dispatch, and nothing else is", () => {
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
