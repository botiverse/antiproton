/**
 * Moving an agent from pi085 to pd and back: the cases of test/spec/pd-migrate-spec.ts over node:sqlite and, node's
 * only (the conformance worker does not carry the runtime), the same move through `AgentRuntime.migrateEngine` on an
 * Agents API agent, and the operator's route (cf/src/admin-migrate.ts). `npm run pd-migrate:do` runs the spec's cases
 * on a real Durable Object.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adminMigrateEngine, type EngineMigration } from "../cf/src/admin-migrate.ts";
import { CANCELLED_NOTE, sessionTranscript } from "../cf/src/agents-api/transcript.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { DurableAgent } from "../src/runtime/durable-agent.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { pdMigrateCases } from "./spec/pd-migrate-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const USAGE = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const WEATHER = { name: "get_weather", description: "weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } };
type Job = { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };

/** A pi085 Agents API agent on an AgentRuntime over node:sqlite; `settle()` is AgentDO's alarm plus the model's queue. */
async function apiAgent() {
  const raw = sqliteHost();
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: raw.sql, transactionSync: raw.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { openai: { tools: [WEATHER] } });
  await rt.bindOperatorModel("t", "a");
  const answered = new Set<string>();
  const requests: ReturnType<typeof toRequest>[] = [];
  const replies: Array<() => ModelResponse> = [];
  const settle = async () => {
    for (let guard = 0; guard < 60; guard++) {
      const out = await rt.step("t", "a");
      let delivered = false;
      for (const id of sent.filter((x) => !answered.has(x))) {
        answered.add(id);
        const job = await rt.takeJob("t", "a", id).catch(() => null) as Job | null;
        if (!job) continue;
        requests.push(toRequest(job.context));
        const reply = replies.shift();
        check(reply, `an unscripted model call: ${show(toRequest(job.context).messages.slice(-2))}`);
        await rt.deliverAnswer("t", "a", id, fromResponse(reply(), job.model, id));
        delivered = true;
      }
      if (delivered) continue;
      if (out.wakeInMs === null) return out;
      await sleep(Math.min(out.wakeInMs, 3_000));
    }
    throw new Error("did not settle");
  };
  const view = async () => {
    const agent = await rt.agent("t", "a");
    const running = await agent.running();
    const pending = running ? [] : await rt.waitingClientCalls("t", "a", "main");
    const { turns } = sessionTranscript({ entries: await rt.branchEntries("t", "a", "main"), running, pending }, { sessionId: "s", agentId: "a" });
    return { status: running ? "in_progress" : pending.length ? "requires_action" : "idle", turns: turns.map((t) => t.status) };
  };
  const rows = (table: string) => Number(raw.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]!.n);
  return { rt, raw, sent, requests, replies, settle, view, rows };
}

const runtimeCases: DriveCase[] = [{
  group: "runtime", name: "through AgentRuntime: refused while a call is out; a caller's waiting function and a held run_js program are dropped; pd continues the Agents API session; the rollback returns pi085",
  run: async () => {
    const a = await apiAgent();
    try {
      check(await a.rt.agent("t", "a") instanceof PiAgent, "control: the agent is not pi085");
      a.replies.push(() => ({ text: "hello", finishReason: "stop", truncated: false, usage: USAGE }));
      await a.rt.postMessage("t", "a", "hi");
      await a.rt.step("t", "a");
      const busy = await a.rt.migrateEngine("t", "a", "migrate");
      check(busy && !busy.ok && /model call/.test(busy.refused), `migrating with a call out: ${show(busy)}`);
      check(await a.rt.agent("t", "a") instanceof PiAgent, "a refused migration moved the agent");
      await a.settle();
      // A function the caller has not answered: the turn requires action.
      a.replies.push(() => ({ text: "", finishReason: "tool_calls", truncated: false, usage: USAGE, toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }] }));
      await a.rt.postMessage("t", "a", "weather in Paris?");
      await a.settle();
      check(show(await a.view()) === show({ status: "requires_action", turns: ["completed", "waiting"] }), `before: ${show(await a.view())}`);
      let discarded = 0 as number;
      a.rt.runJsContinuations.hold({ kind: "program", scope: "main", callId: "c", hostCalls: 0, operations: 0,
        continuation: { cancel: async () => { discarded++; } } } as never);
      const dry = await a.rt.migrateEngine("t", "a", "migrate", { dryRun: true });
      check(dry?.ok && dry.action === "dry-run" && a.rt.runJsContinuations.size === 1, `dry-run: ${show(dry)}`);
      const usage = a.rows("usage_outbox");
      const out = await a.rt.migrateEngine("t", "a", "migrate");
      check(out?.ok && out.action === "migrated" && show((out as { cancelled?: unknown }).cancelled) === show({ clientCalls: 1, heldForResume: 1 }), `migrated: ${show(out)}`);
      check(discarded === 1 && (a.rt.runJsContinuations.size as number) === 0, "the held program was not discarded");
      check(a.rows("usage_outbox") === usage, "the migration wrote usage rows");
      check(await a.rt.agent("t", "a") instanceof DurableAgent, "the agent was not reopened on pd");
      // The turn that waited for the caller is cancelled, as `cancelSession` cancels one.
      check(show(await a.view()) === show({ status: "idle", turns: ["completed", "cancelled"] }), `after: ${show(await a.view())}`);
      a.replies.push(() => ({ text: "it was sunny", finishReason: "stop", truncated: false, usage: USAGE }));
      await a.rt.postMessage("t", "a", "and yesterday?");
      await a.settle();
      const last = a.requests.at(-1)!.messages.filter((m) => m.role !== "system").map((m) => m.content);
      check(show(last).includes("hello") && show(last).includes("weather in Paris?") && show(last).includes("and yesterday?"), `pd's request lacks the history: ${show(last)}`);
      check(show(await a.view()) === show({ status: "idle", turns: ["completed", "cancelled", "completed"] }), `pd's turn: ${show(await a.view())}`);
      check(show(last).includes(CANCELLED_NOTE.slice(0, 30)), `pd's request lacks the cancel's note: ${show(last)}`);
      check(a.rows("usage_outbox") > usage, "pd's turn was not billed");
      check(show(await a.rt.migrateEngine("t", "a", "migrate")) === show({ ok: true, action: "already", engine: "pd", sessions: [] }), "a second migration");
      const back = await a.rt.migrateEngine("t", "a", "revert");
      check(back?.ok && back.action === "reverted", `reverted: ${show(back)}`);
      check(await a.rt.agent("t", "a") instanceof PiAgent, "the agent was not reopened on pi085");
      // pi085's own transcript and calls, as they were: the turn waits for the caller's function again.
      check(show(await a.view()) === show({ status: "requires_action", turns: ["completed", "waiting"] }), `after the rollback: ${show(await a.view())}`);
      check(await a.rt.migrateEngine("t", "nobody", "migrate") === null, "an agent the object does not hold");
    } finally { a.raw.dispose(); }
  },
}, {
  group: "runtime", name: "the rollback forgets pd's unreported run ends: pi-durable's ids restart after it, so a stale one would hide the next pd run's end",
  run: async () => {
    const a = await apiAgent();
    try {
      a.replies.push(() => ({ text: "hello", finishReason: "stop", truncated: false, usage: USAGE }));
      await a.rt.postMessage("t", "a", "hi");
      await a.settle();
      const migrated = await a.rt.migrateEngine("t", "a", "migrate");
      check(migrated?.ok && migrated.action === "migrated", `migrated: ${show(migrated)}`);
      // A pd run that ends with no step after it (the harness `say` opened answers it in this isolate): its end is
      // recorded and nothing has reported it when the operator rolls back.
      const before = a.sent.length;
      await a.rt.postMessage("t", "a", "one");
      for (let i = 0; i < 200 && a.sent.length === before; i++) await sleep(5);
      const id = a.sent.at(-1)!;
      const job = await a.rt.takeJob("t", "a", id) as Job;
      await a.rt.deliverAnswer("t", "a", id, fromResponse({ text: "first", finishReason: "stop", truncated: false, usage: USAGE }, job.model, id));
      for (let i = 0; i < 200 && a.rows("ap_settled_runs") === 0; i++) await sleep(5);
      const stale = a.raw.sql.exec("SELECT operation_id FROM ap_settled_runs").toArray().map((r) => String(r.operation_id));
      check(stale.length === 1, `control: no unreported run end before the rollback: ${show(stale)}`);
      await (await a.rt.agent("t", "a")).close();
      const back = await a.rt.migrateEngine("t", "a", "revert");
      check(back?.ok && back.action === "reverted", `reverted: ${show(back)}`);
      check(a.rows("ap_settled_runs") === 0, "the rollback kept pd's unreported run ends");
      // On pd again, the next run's end is reported, under an id pi-durable hands out afresh.
      const again = await a.rt.migrateEngine("t", "a", "migrate");
      check(again?.ok && again.action === "migrated", `migrated again: ${show(again)}`);
      await a.rt.postMessage("t", "a", "two");
      a.replies.push(() => ({ text: "second", finishReason: "stop", truncated: false, usage: USAGE }));
      let reported: Array<{ operationId: string }> = [];
      for (let guard = 0; guard < 60 && reported.length === 0; guard++) {
        const out = await a.rt.step("t", "a");
        reported = out.settled;
        for (const j of a.sent.filter((x) => x !== id)) {
          const next = await a.rt.takeJob("t", "a", j).catch(() => null) as Job | null;
          if (next) await a.rt.deliverAnswer("t", "a", j, fromResponse(a.replies.shift()!(), next.model, j));
        }
        if (reported.length === 0 && out.wakeInMs !== null) await sleep(Math.min(out.wakeInMs, 50));
      }
      // The control for why the rows must go: the new run's end carries the stale row's id.
      check(reported.some((r) => stale.includes(r.operationId)), `control: pi-durable did not hand out the stale id again: ${show(reported)} vs ${show(stale)}`);
    } finally { a.raw.dispose(); }
  },
}, {
  group: "route", name: "POST /admin/migrate-engine: the operator's token, POST, both ids, op and dryRun checked before the object is asked; 404, 409 and 200 from its answer",
  run: async () => {
    const asked: unknown[] = [];
    let answer: { ok: boolean } | null = { ok: true };
    const open = (t: string, a: string): EngineMigration => ({
      async migrateEngine(...args) { asked.push([t, a, ...args]); return answer; },
    });
    const call = (query: string, init: RequestInit = {}) =>
      adminMigrateEngine(new Request(`https://x/admin/migrate-engine${query}`, { method: "POST", headers: { "x-harness-token": "tok" }, ...init }), "tok", open);
    check((await call("?tenantId=t&agentId=a", { headers: { "x-harness-token": "wrong" } })).status === 401, "a wrong token");
    check((await adminMigrateEngine(new Request("https://x/admin/migrate-engine?tenantId=t&agentId=a", { method: "POST" }), undefined, open)).status === 401, "no token configured");
    check((await call("?tenantId=t&agentId=a", { method: "GET" })).status === 405, "GET");
    check((await call("?agentId=a")).status === 400 && (await call("?tenantId=t")).status === 400, "a missing id");
    check((await call("?tenantId=t&agentId=a&op=delete")).status === 400 && (await call("?tenantId=t&agentId=a&dryRun=maybe")).status === 400, "a bad op or dryRun");
    check(asked.length === 0, `the object was asked before the request was checked: ${show(asked)}`);
    const ok = await call("?tenantId=t&agentId=a&dryRun=1");
    check(ok.status === 200 && ok.headers.get("cache-control") === "no-store", `200: ${ok.status}`);
    check(show(asked) === show([["t", "a", "t", "a", "migrate", true]]), `asked: ${show(asked)}`);
    await call("?tenantId=t&agentId=a&op=revert");
    check(show(asked[1]) === show(["t", "a", "t", "a", "revert", false]), `revert: ${show(asked[1])}`);
    answer = { ok: false };
    check((await call("?tenantId=t&agentId=a")).status === 409, "a refusal");
    answer = null;
    check((await call("?tenantId=t&agentId=a")).status === 404, "no such agent");
  },
}];

const only = process.argv[2];
const results = await runDriveCases([
  ...pdMigrateCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }),
  ...runtimeCases,
].filter((c) => !only || c.name.includes(only)));

console.log(`\n  pd migration: pi085 to pd and back — node:sqlite\n  ${"─".repeat(56)}`);
let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`  ${group}`); }
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name} \x1b[2m(${r.ms} ms)\x1b[0m`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
