/**
 * The shell tool as one terminal session: each call starts where the previous one ended (tygg, 2026-09-15:
 * agents were writing `cd /testbed && …` into every call, because each run9 exec is a fresh process).
 *
 * The report of where a command ended is checked against a real /bin/sh, since a wrong quote or a lost exit
 * code only shows up in a shell; the wiring is checked against run9 answers given here.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxPlugin, splitCwd, withCwdTrailer } from "../src/plugins/sandbox.ts";
import { Backgrounded } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const sh = (command: string) => {
  const r = spawnSync("/bin/sh", ["-lc", withCwdTrailer(command)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, ...splitCwd(r.stdout) };
};
const base = realpathSync(mkdtempSync(join(tmpdir(), "shell-cwd-")));

await check("a cd at the end of a long output is reported, and the output comes back without the report", () => {
  // Vera's case: the directory has to be read right, and a lot of output must not push it out.
  const r = sh(`mkdir -p ${base}/sub && cd ${base}/sub && seq 1 100000`);
  assert(r.code === 0, `exit ${r.code}`);
  assert(r.cwd === `${base}/sub`, `reported ${r.cwd}`);
  assert(r.output.trimEnd().endsWith("\n100000") && !r.output.includes("__AP_CWD__"), `output tail: ${r.output.slice(-40)}`);
});

await check("the command's own exit status survives the report", () => {
  const failed = sh(`cd ${base} && false`);
  assert(failed.code === 1 && failed.cwd === base, `false: exit ${failed.code}, cwd ${failed.cwd}`);
  const three = sh(`cd ${base}; (exit 3)`);
  assert(three.code === 3 && three.cwd === base, `exit 3: exit ${three.code}, cwd ${three.cwd}`);
});

await check("a trailing comment or a dangling && cannot swallow the report", () => {
  const comment = sh(`cd ${base} # go there`);
  assert(comment.cwd === base, `after a comment: ${comment.cwd}`);
  // A dangling && joins the report's line (the shell continues the list there), so the report still runs.
  const dangling = sh(`cd ${base} &&`);
  assert(dangling.cwd === base && dangling.code === 0, `after a dangling &&: exit ${dangling.code}, cwd ${dangling.cwd}`);
});

await check("only a report at the very end is one; a marker the command printed itself stays in the output", () => {
  const mid = splitCwd("before\n__AP_CWD__/fake\nafter\n");
  assert(mid.cwd === null && mid.output === "before\n__AP_CWD__/fake\nafter\n", `a marker mid-output was taken: ${JSON.stringify(mid)}`);
  const none = splitCwd("plain output\n");
  assert(none.cwd === null && none.output === "plain output\n", `no report: ${JSON.stringify(none)}`);
  const empty = splitCwd("\n__AP_CWD__/work\n");
  assert(empty.cwd === "/work" && empty.output === "", `empty output with a report: ${JSON.stringify(empty)}`);
});

// ---- the wiring, against run9 answers given here

/** run9: each POST returns the next exec id; each GET answers from `answers` for that exec. */
function run9(box: Record<string, unknown>, answers: Record<string, Array<Record<string, unknown>>>) {
  const posts: Array<{ path: string; body: any }> = [];
  const writes: any[] = [];
  const served: Record<string, number> = {};
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url).replace("https://sandbox.example", "");
    if (init?.method === "POST" && /background-execs$/.test(path)) {
      posts.push({ path, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    }
    const id = /execs\/(e\d+)$/.exec(path)?.[1] ?? "";
    const list = answers[id] ?? [{ state: "running" }];
    const i = served[id] = (served[id] ?? -1) + 1;
    return new Response(JSON.stringify(list[Math.min(i, list.length - 1)]));
  }) as any;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000 },
    connection: { get: async () => box, set: async (v: unknown) => { writes.push(v); } },
    sibling: async () => null,
  };
  return { ctx, posts, writes };
}
const BOX = { boxId: "b1", createdAt: 1, lastUsedAt: 1, execs: 0, sessions: [], envs: [] };
const plugin = sandboxPlugin(null as any, "local");

await check("a new box's first command enters the working directory; the next starts where it ended, with no cd", async () => {
  const first = run9({ ...BOX }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "1\n2\n__AP_CWD__/tmp\n" }] });
  const r1: any = await plugin.invoke("shell", { command: "cd /tmp && seq 1 2" }, first.ctx);
  assert(first.posts.length === 1 && first.posts[0]!.body.workdir === undefined, `first call sent workdir ${first.posts[0]?.body.workdir}`);
  assert(first.posts[0]!.body.command.join(" ").includes("cd /work"), "the first call did not enter the working directory");
  assert(r1.cwd === "/tmp" && r1.output === "1\n2", `first result: ${JSON.stringify(r1).slice(0, 160)}`);
  const saved = first.writes.at(-1);
  assert(saved?.cwd === "/tmp" && saved.execs === 1 && saved.lastUsedAt > 1, `saved state: ${JSON.stringify(saved)}`);

  const second = run9({ ...BOX, cwd: "/tmp", execs: 1 }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "/tmp\n__AP_CWD__/tmp\n" }] });
  const r2: any = await plugin.invoke("shell", { command: "pwd" }, second.ctx);
  assert(second.posts[0]!.body.workdir === "/tmp", `second call did not start in /tmp: ${JSON.stringify(second.posts[0]?.body)}`);
  assert(!second.posts[0]!.body.command.join(" ").includes("cd /work"), "the second call still glued a cd in front");
  assert(r2.output === "/tmp" && r2.cwd === "/tmp", `second result: ${JSON.stringify(r2).slice(0, 160)}`);
});

await check("a directory that is gone: the command runs once more in the working directory, and the agent is told", async () => {
  const gone = run9({ ...BOX, cwd: "/tmp/was-here" }, {
    e1: [{ state: "error", reason: "failed to start run9ch exec" }],
    e2: [{ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }],
  });
  const r: any = await plugin.invoke("shell", { command: "echo ok" }, gone.ctx);
  assert(gone.posts.length === 2, `expected one retry, saw ${gone.posts.length} starts`);
  assert(gone.posts[0]!.body.workdir === "/tmp/was-here" && gone.posts[1]!.body.workdir === undefined, `workdirs: ${gone.posts.map((p) => p.body.workdir)}`);
  assert(gone.posts[1]!.body.command.join(" ").includes("cd /work"), "the retry did not enter the working directory");
  assert(r.state === "succeeded" && r.output === "ok" && /\/tmp\/was-here no longer exists/.test(String(r.note)), `result: ${JSON.stringify(r).slice(0, 200)}`);
  assert(gone.writes.at(-1)?.cwd === "/work", `saved cwd: ${gone.writes.at(-1)?.cwd}`);
});

await check("an explicit workdir runs this command there, a relative one from the current directory, and the shell follows", async () => {
  const abs = run9({ ...BOX, cwd: "/work" }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "x\n__AP_CWD__/srv/app\n" }] });
  const r: any = await plugin.invoke("shell", { command: "git status", workdir: "/srv/app" }, abs.ctx);
  assert(abs.posts[0]!.body.workdir === "/srv/app", `explicit workdir not sent: ${JSON.stringify(abs.posts[0]?.body)}`);
  assert(!abs.posts[0]!.body.command.join(" ").includes("cd "), "an explicit workdir still glued a cd in front");
  assert(r.cwd === "/srv/app" && abs.writes.at(-1)?.cwd === "/srv/app", `after an explicit workdir: ${r.cwd}, saved ${abs.writes.at(-1)?.cwd}`);

  const rel = run9({ ...BOX, cwd: "/srv/app" }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "__AP_CWD__/srv/app/tests\n" }] });
  await plugin.invoke("shell", { command: "ls", workdir: "tests/../tests" }, rel.ctx);
  assert(rel.posts[0]!.body.workdir === "/srv/app/tests", `relative workdir resolved to ${rel.posts[0]?.body.workdir}`);

  const fresh = run9({ ...BOX }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "__AP_CWD__/opt\n" }] });
  await plugin.invoke("shell", { command: "ls", workdir: "/opt" }, fresh.ctx);
  assert(fresh.posts[0]!.body.workdir === "/opt" && !fresh.posts[0]!.body.command.join(" ").includes("cd /work"),
    `on a new box an explicit workdir must win over the bootstrap: ${JSON.stringify(fresh.posts[0]?.body)}`);
});

await check("an explicit workdir that does not exist is refused by name, never run somewhere else", async () => {
  const missing = run9({ ...BOX, cwd: "/work" }, { e1: [{ state: "error", reason: "failed to start run9ch exec" }] });
  const r: any = await plugin.invoke("shell", { command: "make", workdir: "/nope" }, missing.ctx);
  assert(missing.posts.length === 1, `a named directory that is missing was retried elsewhere: ${missing.posts.length} starts`);
  assert(r.state === "error" && /\/nope does not exist/.test(String(r.note)), `result: ${JSON.stringify(r).slice(0, 200)}`);
  assert(!missing.writes.some((w: any) => w?.cwd && w.cwd !== "/work"), "the shell moved after a refused workdir");
});

await check("a command that ends under /tmp is told its files will not survive idle time; elsewhere nothing is said", async () => {
  const inTmp = run9({ ...BOX, cwd: "/work" }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "__AP_CWD__/tmp/build\n" }] });
  const r: any = await plugin.invoke("shell", { command: "cd /tmp/build" }, inTmp.ctx);
  assert(/do not survive while the container sits idle/.test(String(r.cwdNote)), `no warning under /tmp: ${JSON.stringify(r).slice(0, 200)}`);
  const inWork = run9({ ...BOX, cwd: "/work" }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "__AP_CWD__/work/tmp-like\n" }] });
  const w: any = await plugin.invoke("shell", { command: "cd /work/tmp-like" }, inWork.ctx);
  assert(w.cwdNote === undefined, `a warning outside /tmp: ${w.cwdNote}`);
});

await check("an exec run9 could not start is a finished result, not a job that never ends", async () => {
  const stuck = run9({ ...BOX }, { e1: [{ state: "error", reason: "failed to start run9ch exec" }] });
  const r: any = await plugin.invoke("shell", { command: "true" }, stuck.ctx);
  assert(!(r instanceof Backgrounded), "an exec in run9's error state was handed over as a job");
  assert(r.state === "error" && /failed to start/.test(String(r.error)), `result: ${JSON.stringify(r).slice(0, 160)}`);
});

await check("a command finished later through the poll reports its directory but does not move the shell", async () => {
  const later = run9({ ...BOX, cwd: "/work" }, { e1: [{ state: "succeeded", exit_code: 0, output_summary: "done\n__AP_CWD__/srv\n" }] });
  const writesBefore = later.writes.length;
  const polled: any = await plugin.pollBackground!({ boxId: "b1", execId: "e1" } as any, later.ctx);
  assert(polled.done && polled.result.output === "done" && polled.result.cwd === "/srv", `polled: ${JSON.stringify(polled).slice(0, 160)}`);
  assert(later.writes.length === writesBefore, "the poll wrote connection state");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
