/**
 * Every run_js stretch leaves a `js.run` trace row (cf/src/runtime.ts `#turnTools`, src/trace/seams.ts `jsRunRow`):
 * a program that does not parse calls no mount, so before this nothing in the trace said it ran, and preview's loop
 * of 300+ unparsable programs (2026-10-15) was invisible there. The real runtime over node:sqlite, run_js on the
 * Worker Loader stand-in (test/spec/worker-stand-in.ts), which evaluates the generated module for real.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { toolRefusedRow } from "../src/trace/seams.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

const BROKEN = "const r = await tool`raft__messages_read ${ { target: \"#onboarding-owner\", limit: 10, consume: false, before: 3e2834a7 } }`;";
const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const runJs = (i: number, source: string): ModelResponse => ({
  text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id: `call_${i}`, name: "run_js", arguments: { source } }],
} as ModelResponse);
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

/** One turn of the real runtime, answering its model calls from `script` in order; the sqlite host and how many it used. */
async function drive(script: ModelResponse[]) {
  const host = sqliteHost();
  const sent: string[] = [];
  const answered = new Set<string>();
  const standIn = standInLoader();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada", description: "d" } as never);
  await rt.bindOperatorModel("t", "a");
  await rt.postMessage("t", "a", "read the thread", "prompt", "main");
  let i = 0;
  for (let guard = 0; guard < 200; guard++) {
    const out = await rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = sent.filter((id) => !answered.has(id));
    for (const id of pending) {
      answered.add(id);
      const job = await rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string } } | null;
      if (!job) continue;
      await rt.deliverAnswer("t", "a", id, fromResponse(script[i++]!, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) break;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  return { host, i };
}

await check("an unparsable program and a working one each leave a js.run row: how it ended, its code, the call it answers", async () => {
  const script = [runJs(0, BROKEN), runJs(1, BROKEN), runJs(2, "output(42);"), say("done")];
  const { host, i } = await drive(script);
  must(i === 4, `the turn did not run its script: ${i} calls`);
  const rows = pendingTrace(host.sql as any, 0).rows.filter((r) => r.kind === "js.run");
  must(show(rows.map((r) => [r.spanId, r.status, r.verdict, r.attrs.code ?? null, r.attrs.session])) === show([
    ["call_0", "failed", "failed", "eval_error", "main"],
    ["call_1", "failed", "failed", "eval_error", "main"],
    ["call_2", "completed", "ok", null, "main"],
  ]), `js.run rows: ${show(rows)}`);
  must(rows.every((r) => typeof r.ms === "number" && r.ms >= 0 && r.attrs.hostCalls === 0), show(rows));
  // A reading only: Raft is not sent these.
  must(!activityEvents("a", rows).length, "js.run rows became activity events");
});

await check("a program's calls refused before any operation existed each leave a tool.refused row: who refused, the code, never the arguments", async () => {
  // Three refusers, one call each: run_js (a model-form name not in the tool list), the gateway (an address that
  // names no mount), the executor (arguments that are not an object). None of them became an operation, so none has a
  // tool.call row; before tool.refused nothing in the trace said they were made.
  const source = `const a = await tool\`ghost__read \${ { q: "v4lue" } }\`;
    const b = await tool\`ghost.read \${ { q: "v4lue" } }\`;
    const c = await tool\`ghost.read \${ "v4lue" }\`;
    output([a.error.code, b.error.code, c.error.code]);`;
  const { host, i } = await drive([runJs(0, source), say("done")]);
  must(i === 2, `the turn did not run its script: ${i} calls`);
  const all = pendingTrace(host.sql as any, 0).rows;
  const rows = all.filter((r) => r.kind === "tool.refused");
  const run = all.find((r) => r.kind === "js.run");
  must(run?.status === "completed" && run.attrs.hostCalls === 2, `js.run: ${show(run)}`);
  must(rows.length === 3, `tool.refused rows: ${show(rows)}`);
  const codes = rows.map((r) => r.attrs.code);
  must(show(rows.map((r) => [r.spanId, r.verdict, r.attrs.by, r.attrs.from, r.attrs.tool ?? null])) === show([
    ["call_0", "blocked", "run_js", "program", "ghost__read"],
    ["call_0", "blocked", "gateway", "program", "ghost.read"],
    ["call_0", "blocked", "executor", "program", "ghost.read"],
  ]), `rows: ${show(rows)}`);
  // The same task on all three, whoever wrote the row, so they read as one conversation's.
  must(rows.every((r) => r.status === r.attrs.code && typeof r.attrs.task === "string" && r.attrs.task === rows[0]!.attrs.task), show(rows));
  must(codes[2] === "bad_arguments", `the executor's code: ${show(codes)}`);
  must(!show(all).includes("v4lue"), `an argument reached the trace: ${show(all.filter((r) => show(r).includes("v4lue")))}`);
  must(!all.some((r) => r.kind === "tool.call"), "a refused call has a tool.call row");
  // A reading only: Raft is not sent these.
  must(!activityEvents("a", rows).length, "tool.refused rows became activity events");
});

await check("tool.refused keeps a name only when it is shaped like one and not like a credential", async () => {
  const at = 1;
  const row = (tool: string | null, code = "unknown_tool") =>
    toolRefusedRow({ tenantId: "t", agentId: "a", at, tool, code, callId: "c", by: "gateway", fromProgram: false });
  const mcp = "github_mcp__list_pull_request_review_comments_for_repo";
  must(row(mcp).attrs.tool === mcp, `a long MCP name was dropped: ${show(row(mcp))}`);
  must(row("ghp_" + "a".repeat(36)).attrs.tool === undefined, "a token-shaped name was kept");
  must(row('gh.get {"q":1}').attrs.tool === undefined, "a name carrying text was kept");
  must(row(null).attrs.tool === undefined && row(null).attrs.from === "model", show(row(null)));
  must(row("x", "not a code!").status === "refused", `an odd code was written: ${show(row("x", "not a code!"))}`);
  must(row("x").spanId === "c" && toolRefusedRow({ tenantId: "t", agentId: "a", at, tool: "x", code: "c", by: "executor", fromProgram: true }).spanId === "refused_1",
    "the span is the model's call, or a stand-in when there is none");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
