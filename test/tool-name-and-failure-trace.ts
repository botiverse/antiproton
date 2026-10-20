/**
 * Two things a turn's trace says, read on the real runtime over node:sqlite with run_js on the Worker Loader stand-in
 * (test/spec/worker-stand-in.ts) and the real raft plugin against a fake Raft:
 *
 * - The change to "working" when a model call ends asking for tools names the first tool it asked for
 *   (src/trace/seams.ts `firstToolCall`, src/runtime/status.ts). Raft takes a detail with a status change, and a
 *   run_js program's tools start after that instant, so without the name Raft kept the previous turn's "Using …"
 *   beside "working" for minutes (agent raft_6387df16, 2026-10-20).
 * - A failed tool call's `tool.call` row records why: the error code, the HTTP status, and a bounded message with
 *   credential shapes redacted (src/trace/seams.ts `failureAttrs`) — for a call the model made and for one a run_js
 *   program made, which both end in the gateway's `#run`.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { pendingTrace, type TraceOutboxRow } from "../src/trace/outbox.ts";
import { statusEvents } from "../src/runtime/status.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { TOOL_ERROR_MAX } from "../src/trace/seams.ts";
import type { Plugin } from "../src/plugins/types.ts";

const originalFetch = globalThis.fetch;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const call = (i: number, name: string, args: Record<string, unknown>): ModelResponse => ({
  text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id: `call_${i}`, name, arguments: args }],
} as ModelResponse);
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

/** A fake Raft: the credential context, and a 404 NOT_FOUND for everything else (what messages_resolve met). */
const asked: string[] = [];
globalThis.fetch = (async (url: any) => {
  const p = new URL(String(url)).pathname;
  asked.push(p);
  if (/context/.test(p)) {
    return json(200, {
      agent: { id: "agent-1", name: "raft-bot", displayName: null, description: null, runtime: "antiproton", external: true },
      server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "send"] }, prompt: null,
    });
  }
  return json(404, { code: "NOT_FOUND", error: "Message not found" });
}) as any;

/**
 * One turn on the real runtime with a raft mount, on `engine`: the model calls `script` in order. Returns the trace
 * rows. Both engines, because each writes the model.call row itself (src/store/pi-storage.ts, src/runtime/pd-outbox.ts).
 */
async function turn(engine: "pi085" | "pd", script: ModelResponse[]): Promise<TraceOutboxRow[]> {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const answered = new Set<string>();
  const standIn = standInLoader();
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null }, extraPlugins: [],
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
    autoRelease: false, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada", description: "d" } as never);
  await rt.store.setPluginChoice("t", "a", "raft", "enable");
  await rt.store.addMount({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: "x", publicConfig: { serverUrl: "https://raft.example" }, secretRef: null, policy: null });
  must((await rt.attachCredential("t", "a", "raft", { token: "sk_agent_first_1234567890" })).ok, "attaching the raft credential failed");
  await rt.bindOperatorModel("t", "a");
  await rt.postMessage("t", "a", "resolve that message", "prompt", "main");
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
  must(i === script.length, `the turn did not run its script: ${i} of ${script.length} calls`);
  return pendingTrace(host.sql as any, 0).rows;
}

const RESOLVE = "raft__messages_resolve";
const PROGRAM = `try { await tool\`${RESOLVE} ${"${"}{ messageId: "m2" }}\`; } catch (e) { output(String(e)); }`;
for (const engine of ["pi085", "pd"] as const) {
  const rows = await turn(engine, [call(0, RESOLVE, { messageId: "m1" }), call(1, "run_js", { source: PROGRAM }), say("done")]);
  /** The "working" each model call that asked for tools means: the status event dated at that call's end. */
  const workingAtToolUse = (evs: ReturnType<typeof statusEvents>) => rows
    .filter((r) => r.kind === "model.call" && r.status === "toolUse")
    .map((r) => evs.find((e) => Date.parse(e.occurredAt) === r.at && e.status === "working") ?? null);

  await check(`${engine}: the model call that asks for tools says which: firstTool on the row, by the name the model used`, () => {
    const calls = rows.filter((r) => r.kind === "model.call");
    must(show(calls.map((r) => [r.status, r.attrs.firstTool ?? null])) === show([["toolUse", RESOLVE], ["toolUse", "run_js"], ["stop", null]]),
      `model.call rows: ${show(calls.map((r) => [r.status, r.attrs]))}`);
  });

  await check(`${engine}: (a) a direct tool call and (b) a run_js call each carry a tool name on the change to working itself`, () => {
    const evs = statusEvents("a", rows);
    const working = workingAtToolUse(evs);
    must(show(working.map((e) => e?.detail ?? null)) === show([`Using ${RESOLVE}`, "Using run_js"]),
      `the working at each toolUse end: ${show(working)}; all: ${show(evs.map((e) => [e.status, e.detail ?? null, e.occurredAt]))}`);
    // And on what Raft is sent: the status-only event, or the activity event it folds onto, carries the detail too.
    const sent = activityEvents("a", rows).filter((e) => e.status === "working");
    for (const w of working) {
      const at = sent.find((e) => e.occurredAt === w!.occurredAt);
      must(at?.detail === w!.detail, `sent at ${w!.occurredAt}: ${show(at)}`);
    }
    // The per-tool updates are kept: each raft call's own start still says its name.
    for (const t of rows.filter((r) => r.kind === "tool.call")) {
      const start = t.at - (t.ms ?? 0);
      must(evs.some((e) => e.status === "working" && e.detail === `Using ${RESOLVE}` && Date.parse(e.occurredAt) === start)
        || evs.filter((e) => Date.parse(e.occurredAt) <= start).at(-1)?.detail === `Using ${RESOLVE}`,
      `the tool's own start at ${start} is not "Using ${RESOLVE}": ${show(evs.map((e) => [e.status, e.detail ?? null, e.occurredAt]))}`);
    }
    if (process.env.SHOW) console.log(show(evs.map((e) => [e.status, e.detail ?? null, Date.parse(e.occurredAt) - rows[0]!.at])));
  });

  await check(`${engine}: a failed raft call's tool.call row records errorCode and httpStatus, from the model and from a run_js program`, () => {
    const tools = rows.filter((r) => r.kind === "tool.call");
    must(tools.length === 2, `two raft calls, one direct and one in run_js: ${show(tools)}`);
    for (const r of tools) {
      must(r.verdict === "failed" && r.attrs.errorCode === "NOT_FOUND" && r.attrs.httpStatus === 404,
        `tool.call row: ${show([r.status, r.verdict, r.attrs])}`);
      must(typeof r.attrs.error === "string" && r.attrs.error.length > 0 && r.attrs.error.length <= TOOL_ERROR_MAX, `error: ${show(r.attrs.error)}`);
    }
    if (process.env.SHOW) console.log(show(tools.map((r) => r.attrs)));
    // Control: the 404 was Raft's answer to the resolve, so the fields came from that answer.
    must(asked.filter((p) => !/context/.test(p)).length >= 2, `paths asked: ${show(asked)}`);
  });
}

await check("a failure's message on the row is redacted of credential shapes and cut to TOOL_ERROR_MAX; a success records none", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "tool-fail-")), "store.sqlite");
  const store = new SqliteStore(path); await store.init();
  const db = new DatabaseSync(path);
  const sql = { exec: (q: string, ...b: unknown[]) => {
    const st = db.prepare(q);
    const out = st.columns().length ? st.all(...(b as any[])) : (st.run(...(b as any[])), []);
    return { toArray: () => out };
  } } as any;
  await store.createAgent("t", "a");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null } as any);
  const TOKEN = "sk_agent_live_ABCDEFGHIJKLMNOPQRSTUVWX";
  const plugin: Plugin = {
    id: "svc", version: "1.0.0",
    tools: [
      { name: "fail", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" },
      { name: "ok", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" },
    ],
    async invoke(tool) {
      if (tool === "ok") return { fine: true };
      throw Object.assign(new Error(`upstream said 401 for Authorization: Bearer ${TOKEN} and key ${TOKEN}; ${"x ".repeat(300)}`), { code: "UNAUTHORIZED", httpStatus: 401 });
    },
  };
  const gw = new ToolGateway(store as any, [plugin], new Set(["svc"]), { async resolve() { return null; } } as any);
  const failed: any = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" } as any, "svc.fail", {});
  const ok: any = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" } as any, "svc.ok", {});
  must(failed.status === "failed" && failed.error.message.includes(TOKEN) && ok.status === "succeeded",
    `control: the plugin's own sentence carries the token: ${show([failed, ok])}`);
  const tools = pendingTrace(sql, 0).rows.filter((r) => r.kind === "tool.call");
  must(tools.length === 2, `two tool.call rows: ${show(tools.map((r) => r.attrs))}`);
  const f = tools.find((r) => r.verdict === "failed")!, s = tools.find((r) => r.verdict === "ok")!;
  must(f.attrs.errorCode === "UNAUTHORIZED" && f.attrs.httpStatus === 401, `failed row: ${show(f.attrs)}`);
  const said = String(f.attrs.error ?? "");
  must(said.startsWith("upstream said 401 for") && !said.includes("sk_agent_") && !said.includes("ABCDEFGHIJ"), `not redacted: ${said}`);
  must(said.length <= TOOL_ERROR_MAX, `not bounded: ${said.length}`);
  if (process.env.SHOW) console.log(show(f.attrs).slice(0, 400));
  must(!("error" in s.attrs) && !("errorCode" in s.attrs) && !("httpStatus" in s.attrs), `a success recorded a failure: ${show(s.attrs)}`);
});

globalThis.fetch = originalFetch;
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(passed === results.length ? 0 : 1);
