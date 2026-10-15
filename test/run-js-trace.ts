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

await check("an unparsable program and a working one each leave a js.run row: how it ended, its code, the call it answers", async () => {
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
  const script = [runJs(0, BROKEN), runJs(1, BROKEN), runJs(2, "output(42);"), say("done")];
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

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
