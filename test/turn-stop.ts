/**
 * Ending a turn from outside (src/runtime/turn-stop.ts, cf/src/runtime.ts `stopTurn`): the provider's stop route and a
 * delete, over fake deps for the route's contract (raft-agent-provider.v1, docs/agent-surface.md), and over the real
 * runtime for what the stop does to a turn that is looping: preview's deleted agents kept calling their model every
 * 2–3 s for five minutes after their delete (2026-10-15).
 */
import { handleProvision, type ProvisionDeps, type StopTurnResult } from "../cf/src/provision/handlers.ts";
import type { ProvisionedAgent, ProvisionRegistry } from "../cf/src/control-plane.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { activityEvents, turnEnds } from "../src/runtime/activity.ts";
import { statusEvents } from "../src/runtime/status.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const logs: any[] = [];
setLogSink((line) => logs.push(JSON.parse(line)));

// ---- the route, over fake deps ----------------------------------------------------------------------------

const WHO = { label: "raft-prod", tenantId: "t-raft", raftOrigin: "https://api.raft.build", scope: "tenant" as const };

function fakeDeps(stop: (agentId: string, trigger: string) => Promise<StopTurnResult>) {
  const rows = new Map<string, ProvisionedAgent>();
  const calls: string[] = [];
  const row = (raftAgentId: string, status: ProvisionedAgent["status"]): ProvisionedAgent => ({
    tenantId: "t-raft", raftAgentId, agentId: `raft_${raftAgentId}`, raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "Cody",
    instructions: "be brief", status, pushRegistered: status === "active", pushError: null, createdAt: 1, updatedAt: 1,
    deletedAt: status === "deleted" ? 2 : null,
  } as ProvisionedAgent);
  rows.set("LIVE", row("LIVE", "active"));
  rows.set("GONE", row("GONE", "deleted"));
  const registry: ProvisionRegistry = {
    async create() { throw new Error("not in this test"); },
    async get(_t, id) { return rows.get(id) ?? null; },
    async getByAgentId(_t, agentId) { return [...rows.values()].find((r) => r.agentId === agentId) ?? null; },
    async update(_t, id, patch) { const r = rows.get(id); if (!r) return false; rows.set(id, { ...r, ...patch } as ProvisionedAgent); return true; },
  } as ProvisionRegistry;
  const deps: ProvisionDeps = {
    now: () => 10,
    registry,
    agent: {
      adopt: async () => {}, attachCredential: async () => ({ ok: true, account: null }),
      removeCredential: async (_t, a) => { calls.push(`remove ${a}`); return true; },
      tool: async (_t, a, name) => { calls.push(`${name} ${a}`); return { ok: true, result: {} }; },
      pushStatus: async () => null,
      stopTurn: async (_t, a, trigger) => { calls.push(`stop ${a} ${trigger}`); return stop(a, trigger); },
    },
  } as ProvisionDeps;
  return { deps, calls, rows };
}

async function call(deps: ProvisionDeps, method: string, path: string) {
  const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: "srv-1" }, method === "POST" ? {} : undefined, WHO, deps);
  if (!r) return { status: 0, body: null as any };
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

await check("POST …/stop: 200 interrupted with the turn, then 200 not_running on a repeat", async () => {
  let running = true;
  const f = fakeDeps(async () => {
    if (!running) return { result: "not_running" };
    running = false;
    return { result: "interrupted", cancelledTurn: "op_123" };
  });
  const first = await call(f.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  must(first.status === 200 && show(first.body) === show({ result: "interrupted", cancelledTurn: "op_123" }), `${first.status} ${show(first.body)}`);
  const again = await call(f.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  must(again.status === 200 && show(again.body) === show({ result: "not_running" }), `${again.status} ${show(again.body)}`);
  must(show(f.calls) === show(["stop raft_LIVE provider_stop", "stop raft_LIVE provider_stop"]), show(f.calls));
  // By its providerAgentId too, as every other agent route.
  const byId = await call(f.deps, "POST", "/agents/raft_LIVE/stop");
  must(byId.status === 200 && byId.body.result === "not_running", show(byId));
});

await check("POST …/stop: a deleted agent can still be stopped; an unknown one is 404 not_found", async () => {
  const f = fakeDeps(async () => ({ result: "interrupted", cancelledTurn: "op_9" }));
  const gone = await call(f.deps, "POST", "/agents/by-raft-agent/GONE/stop");
  must(gone.status === 200 && show(gone.body) === show({ result: "interrupted", cancelledTurn: "op_9" }), `${gone.status} ${show(gone.body)}`);
  const unknown = await call(f.deps, "POST", "/agents/by-raft-agent/NOPE/stop");
  must(unknown.status === 404 && unknown.body.error.code === "not_found", `${unknown.status} ${show(unknown.body)}`);
  must(!f.calls.includes("stop raft_NOPE provider_stop"), "an unknown agent's object was asked");
});

await check("POST …/stop: a turn that could not be ended is 503 stop_failed, retryable, and logged", async () => {
  const failed = fakeDeps(async () => ({ result: "failed", error: "the harness did not open" }));
  const r = await call(failed.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  must(r.status === 503 && r.body.error.code === "stop_failed" && /try again/.test(r.body.error.message), `${r.status} ${show(r.body)}`);
  logs.length = 0;
  const threw = fakeDeps(async () => { throw new Error("Durable Object reset"); });
  const t = await call(threw.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  must(t.status === 503 && t.body.error.code === "stop_failed", `${t.status} ${show(t.body)}`);
  const line = logs.find((l) => l.evt === "turn.stop");
  must(line && line.trigger === "provider_stop" && line.result === "failed" && line.agentId === "raft_LIVE" && /reset/.test(line.error) && line.side === "worker", `log: ${show(logs)}`);
});

await check("the Worker logs its own turn.stop line, side worker, for interrupted, not_running and failed", async () => {
  // The object's own line can be lost with the rest of its invocation's logs; this one is written where the stop is answered.
  const answers: StopTurnResult[] = [
    { result: "interrupted", cancelledTurn: "op_7" }, { result: "not_running" }, { result: "failed", error: "the harness did not open" },
  ];
  const f = fakeDeps(async () => answers.shift()!);
  logs.length = 0;
  for (let i = 0; i < 3; i++) await call(f.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  const threw = fakeDeps(async () => { throw new Error("Durable Object reset"); });
  await call(threw.deps, "POST", "/agents/by-raft-agent/LIVE/stop");
  const d = fakeDeps(async () => ({ result: "interrupted", cancelledTurn: "op_8" }));
  await call(d.deps, "DELETE", "/agents/by-raft-agent/LIVE");
  const lines = logs.filter((l) => l.evt === "turn.stop").map((l) => [l.side, l.trigger, l.result, l.turn ?? null, l.error ?? null, l.agentId]);
  must(show(lines) === show([
    ["worker", "provider_stop", "aborted", "op_7", null, "raft_LIVE"],
    ["worker", "provider_stop", "nothing_running", null, null, "raft_LIVE"],
    ["worker", "provider_stop", "failed", null, "the harness did not open", "raft_LIVE"],
    ["worker", "provider_stop", "failed", null, "Durable Object reset", "raft_LIVE"],
    ["worker", "delete", "aborted", "op_8", null, "raft_LIVE"],
  ]), `turn.stop lines: ${show(lines)}`);
});

await check("DELETE ends the running turn first, and again on a repeated delete; a failed stop does not fail the delete", async () => {
  const f = fakeDeps(async () => ({ result: "interrupted", cancelledTurn: "op_1" }));
  const r = await call(f.deps, "DELETE", "/agents/by-raft-agent/LIVE");
  must(r.status === 200 && r.body.status === "deleted", `${r.status} ${show(r.body)}`);
  must(f.calls[0] === "stop raft_LIVE delete", `the stop was not first: ${show(f.calls)}`);
  f.calls.length = 0;
  const again = await call(f.deps, "DELETE", "/agents/by-raft-agent/LIVE");
  must(again.status === 200 && show(f.calls) === show(["stop raft_LIVE delete"]), `${again.status} ${show(f.calls)}`);
  const broken = fakeDeps(async () => { throw new Error("unreachable"); });
  const d = await call(broken.deps, "DELETE", "/agents/by-raft-agent/LIVE");
  must(d.status === 200 && d.body.status === "deleted" && broken.rows.get("LIVE")!.status === "deleted", `${d.status} ${show(d.body)}`);
});

// ---- the stop, on the real runtime ----------------------------------------------------------------------

type World = { host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string> };

async function world(): Promise<World> {
  const base = { host: sqliteHost(), sent: [] as string[], answered: new Set<string>() };
  const standIn = standInLoader();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: base.host.sql, transactionSync: base.host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { base.sent.push(job.commandId); },
  } as never);
  const w = { ...base, rt } as World;
  await w.rt.ready();
  await w.rt.store.createAgent("t", "a", { name: "Ada", description: "d" } as never);
  await w.rt.bindOperatorModel("t", "a");
  return w;
}

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const loopCall = (i: number): ModelResponse => ({
  text: "", finishReason: "tool_calls", truncated: false, usage,
  toolCalls: [{ id: `call_${i}`, name: "run_js", arguments: { source: `output(${i});` } }],
} as ModelResponse);

/** Steps the runtime and answers every call with another program, `calls` times; leaves the next call out. */
async function loopFor(w: World, calls: number) {
  let answered = 0;
  for (let guard = 0; guard < 200 && answered < calls; guard++) {
    await w.rt.step("t", "a");
    for (const id of w.sent.filter((x) => !w.answered.has(x))) {
      if (answered >= calls) break;
      w.answered.add(id);
      const job = await w.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string } } | null;
      if (!job) continue;
      await w.rt.deliverAnswer("t", "a", id, fromResponse(loopCall(answered++), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
  }
  await w.rt.step("t", "a");
}
const outstanding = (w: World) => w.host.sql.exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL").toArray().map((r: any) => String(r.id));
const rows = (w: World) => pendingTrace(w.host.sql as any, 0).rows;

await check("a looping turn stopped by its owner: aborted with its call out, no call after it, Raft told `stopped: by owner`", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "keep going", "prompt", "main");
  await loopFor(w, 4);
  must(outstanding(w).length === 1, `the loop has no call out: ${show(outstanding(w))}`);
  const jobsBefore = w.sent.length;
  logs.length = 0;
  const r = await w.rt.stopTurn("t", "a", "provider_stop");
  must(r.result === "interrupted" && typeof (r as any).cancelledTurn === "string" && (r as any).cancelledTurn.length > 0, show(r));
  // The answer to the call that was out arrives and starts nothing; the next passes make no call.
  for (let i = 0; i < 3; i++) await w.rt.step("t", "a");
  must(w.sent.length === jobsBefore && outstanding(w).length === 0, `calls after the stop: ${w.sent.length - jobsBefore}, out: ${show(outstanding(w))}`);
  const fatal = activityEvents("a", rows(w)).filter((e) => e.hookEventName === "BridgeFatal");
  must(show(fatal.map((e) => e.errorClass)) === show(["stopped: by owner"]), `BridgeFatal: ${show(fatal)}`);
  // The stop's end names the turn it stopped: the one the loop's model calls were made in.
  const ends = turnEnds("a", rows(w));
  const stopEnd = ends.find((e) => e.eventId === fatal[0]!.eventId);
  const callTurns = new Set(rows(w).filter((x: any) => x.kind === "model.call").map((x: any) => x.attrs.turn));
  must(stopEnd?.outcome === "interrupted" && typeof stopEnd.turn === "string" && callTurns.size === 1 && callTurns.has(stopEnd.turn), `stop end: ${show(stopEnd)}, call turns ${show([...callTurns])}`);
  const st = statusEvents("a", rows(w));
  must(st[st.length - 1]!.status === "error" && st[st.length - 1]!.detail === "stopped: by owner", `status: ${show(st[st.length - 1])}`);
  const again = await w.rt.stopTurn("t", "a", "provider_stop");
  must(show(again) === show({ result: "not_running" }), show(again));
  const lines = logs.filter((l) => l.evt === "turn.stop").map((l) => [l.tenantId, l.agentId, l.trigger, l.result, l.side]);
  must(show(lines) === show([["t", "a", "provider_stop", "aborted", "do"], ["t", "a", "provider_stop", "nothing_running", "do"]]), `turn.stop lines: ${show(lines)}`);
  // Stopped, not deleted: the next message is a turn.
  await w.rt.postMessage("t", "a", "now this", "prompt", "main");
  await w.rt.step("t", "a");
  must(w.sent.length === jobsBefore + 1, `the next message made no call: ${w.sent.length - jobsBefore}`);
});

await check("a delete stops the looping turn and the agent takes no step after it, whatever arrives", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "keep going", "prompt", "main");
  await loopFor(w, 3);
  const jobsBefore = w.sent.length;
  const r = await w.rt.stopTurn("t", "a", "delete");
  must(r.result === "interrupted", show(r));
  await w.rt.postMessage("t", "a", "are you there?", "prompt", "main").catch(() => {});
  for (let i = 0; i < 3; i++) {
    const out = await w.rt.step("t", "a") as { wakeInMs: number | null; open: number };
    must(out.open === 0 && out.wakeInMs === null, `a deleted agent's pass asked to come back: ${show(out)}`);
  }
  must(w.sent.length === jobsBefore, `a deleted agent called its model ${w.sent.length - jobsBefore} more time(s)`);
  const fatal = activityEvents("a", rows(w)).filter((e) => e.hookEventName === "BridgeFatal").map((e) => e.errorClass);
  must(fatal[0] === "stopped: agent deleted", `BridgeFatal: ${show(fatal)}`);
  // A repeated delete: nothing running, still deleted.
  must(show(await w.rt.stopTurn("t", "a", "delete")) === show({ result: "not_running" }), "repeat");
});

await check("an agent that never ran is not_running, and the operator's cancel says so too", async () => {
  const w = await world();
  must(show(await w.rt.stopTurn("t", "a", "admin_cancel")) === show({ result: "not_running" }), "idle agent");
  must(show(await w.rt.stopTurn("t", "nobody", "admin_cancel")) === show({ result: "not_running" }), "unknown agent");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
