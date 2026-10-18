/**
 * The service agent's erase after a crash, through the whole `AgentDO` with nothing but its own alarm: the run ends,
 * the pass that would erase its conversation is cut off, no event of any kind arrives afterwards, and the object's
 * alarm alone erases it. What wakes it is the alarm handler's own fallback, armed before every pass and taken down
 * only by a pass that ends cleanly (`AgentDO.alarm`, cf/src/index.ts), together with the turn's end, which stays owed
 * until a pass marks it handled (src/runtime/plugin-wakes.ts). The harness is test/client-tool-alarms.ts's: a
 * `cloudflare:workers` stand-in, a virtual clock that jumps to the armed alarm, and D1 as node:sqlite with every
 * migration; Raft is a fake shaped like its contract, as in test/raftbench-service.ts.
 */
import { register } from "node:module";
import { createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

let clock = Date.now();
Date.now = () => ++clock;

function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => {
      const read = x.q.trim().toUpperCase().startsWith("SELECT");
      return { results: read ? db.prepare(x.q).all(...(x.b as any[])) : [], meta: { changes: read ? 0 : Number(db.prepare(x.q).run(...(x.b as any[])).changes) } };
    }),
  };
}

const ORIGIN = "https://raft.example";
const CRED = "sk_agent_" + "C".repeat(32);
const TENANT = "t-rb", AGENT = "raft_svc";
const RAFT_AGENT = "11111111-2222-4333-8444-555555555555";
const MATERIAL_MARK = "ZQ-ALARM-MATERIAL-5521", ANSWER_MARK = "ZQ-ALARM-ANSWER-5521";
const MSG = ["c0ffee00-0000-4000-8000-000000000021", "c0ffee00-0000-4000-8000-000000000022"];

/** Raft, as the contract shapes it, for one run. */
function fakeRaft() {
  const f = { run: { runId: randomUUID(), revision: 2 }, events: [] as unknown[], push: null as null | { url: string; secret: string }, accepted: 0 };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const coverage = { from: "2026-10-17T08:00:00.000Z", to: "2026-10-18T08:00:00.000Z", fetchedMessages: 2, exhausted: true, stopReason: "window_end", notRead: ["Tool execution outcomes and threads are not included."] };
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = String(init?.method ?? "GET");
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    switch (`${method} ${u.pathname}`) {
      case "GET /internal/agent-api": return json(200, { agentId: RAFT_AGENT, agentName: "raftbench-service", agentDisplayName: null, serverId: "srv-1" });
      case "GET /internal/agent-api/context":
        return json(200, { agent: { id: RAFT_AGENT, name: "raftbench-service", displayName: null, description: null, runtime: "external", external: true },
          server: { id: "srv-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "raftbench"] }, prompt: null });
      case "POST /internal/agent-api/activity": return json(200, { ok: true });
      case "PUT /internal/agent-api/push-webhook": f.push = { url: body.url, secret: body.secret }; return json(200, { ok: true });
      case "GET /internal/agent-api/events": return json(200, { events: f.events.splice(0), last_seen_msgId: null, last_seen_seq: null, reply_target: null, has_more: false, ack_mode: "cursor" });
      case "GET /internal/agent-api/raftbench/context":
        return json(200, { runId: f.run.runId, revision: f.run.revision, nextCursor: null, coverage,
          sourceText: `[target=#ops msg=${MSG[0]} time=2026-10-18 10:00:00Z type=human] @lee: rollback finished? ${MATERIAL_MARK}\n\n[target=#ops msg=${MSG[1]} time=2026-10-18 10:02:00Z type=agent] @bot: yes`,
          sources: MSG.map((messageId) => ({ target: "#ops", messageId })) });
      case "POST /internal/agent-api/raftbench/submit":
        f.accepted++;
        return json(200, { runId: body.runId, revision: body.revision, status: body.status, receiptId: randomUUID(), coverage });
    }
    return json(404, { error: "not found" });
  }) as typeof fetch;
  return f;
}

/** The agent's object, its storage and alarm; `crash` arms its next storage transaction to throw, as an eviction. */
function object() {
  const raw = sqliteHost();
  const jobs: string[] = [];
  const state = { alarmAt: null as number | null };
  const crash = { armed: false, when: (): boolean => true };
  const ctx = {
    storage: {
      sql: raw.sql,
      transactionSync: <T>(fn: () => T): T => {
        if (crash.armed && crash.when()) { crash.armed = false; throw new Error("evicted"); }
        return raw.transactionSync(fn);
      },
      getAlarm: async () => state.alarmAt,
      setAlarm: async (at: number) => { state.alarmAt = at; },
      deleteAlarm: async () => { state.alarmAt = null; },
    },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
    waitUntil: () => {},
    id: { toString: () => `${TENANT}/${AGENT}` }, getWebSockets: () => [], exports: {},
  };
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async () => ({}), head: async () => null, list: async () => ({ objects: [] }), get: async () => null, delete: async () => {} },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "deepseek-flash",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com", DEEPSEEK_API_KEY: "dk-test",
    SECRET_KEK: Buffer.alloc(32, 7).toString("base64"), HOOK_ORIGIN: "https://hooks.test",
  };
  const D: any = new AgentDO(ctx as never, env as never);
  /** Fire the alarm while one is armed, up to `max` times; a pass that throws is what the platform would see. */
  const alarms = async (max: number) => {
    let fired = 0;
    while (state.alarmAt !== null && fired < max) {
      clock = Math.max(clock, state.alarmAt);
      state.alarmAt = null;
      fired++;
      try { await D.alarm(); } catch { /* recorded by the handler, as the platform would see it */ }
      clock += 5;
    }
    return fired;
  };
  const whereIs = (marker: string) => {
    const hits = new Set<string>();
    for (const t of raw.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()) {
      const name = String(t.name);
      for (const r of raw.sql.exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`).toArray()) if (JSON.stringify(r).includes(marker)) hits.add(name);
    }
    return [...hits];
  };
  return { D, raw, state, jobs, crash, alarms, whereIs };
}

const answerOf = (text: string) => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "deepseek", model: "deepseek-flash",
  usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 0,
});

await check("a crash at a run's end is erased by the object's own alarm, with no event after it", async () => {
  const raft = fakeRaft();
  const o = object();
  const adopted = await o.D.provisionAdopt(TENANT, AGENT, JSON.stringify({ name: "raftbench-service", instructions: "x", raftOrigin: ORIGIN, toolConfig: null, profile: "raftbench_service" }));
  must(adopted.ok, show(adopted));
  must((await o.D.uiAttachCredential(TENANT, AGENT, "raft", { token: CRED })).ok, "the credential was refused");
  must((await o.D.provisionTool(TENANT, AGENT, "enable_push")).ok && raft.push, "push was not registered");
  // The assignment, and Raft's notice of it.
  raft.events.push({ channel_type: "dm", channel_name: "third-party-agent-events:x", sender_type: "third_party_app", message_id: randomUUID(),
    third_party_event: { id: randomUUID(), client_id: "system.raftbench", payload: { kind: "raftbench_run_assigned", runId: raft.run.runId, revision: raft.run.revision,
      text: "This run is handled automatically by the system. You do not need to take any action or reply." } } });
  const noticeId = `ntc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const body = new TextEncoder().encode(JSON.stringify({ schema: "raft-agent-inbox-notice.v1", noticeId, recipientAgentId: RAFT_AGENT,
    occurredAt: "2026-10-18T08:00:00.000Z", text: "Inbox update", targets: [] }));
  const signature = createHmac("sha256", raft.push.secret).update(body).digest("hex");
  const hookId = raft.push.url.split("/").pop()!;
  const r = await o.D.hookReceive(TENANT, AGENT, "raft", hookId, { headers: { "x-raft-signature-256": `sha256=${signature}`, "x-raft-delivery-id": noticeId }, body });
  must(r.outcome === "delivered", show(r));
  await o.alarms(5);
  // One call, which the queue may be handed again while it waits (the redelivery net).
  must(new Set(o.jobs).size === 1 && o.whereIs(MATERIAL_MARK).length > 0, `the run did not reach the model: jobs ${show(o.jobs)}`);
  // The model answers; the pass that would keep the plugin's erase is cut off once the run is saved done.
  const id = o.jobs[0]!;
  await o.D.takeJob(TENANT, AGENT, id);
  o.crash.when = () => o.raw.sql.exec(`SELECT 1 AS x FROM plugin_db WHERE value LIKE '%"forgetPending":true%'`).toArray().length > 0;
  o.crash.armed = true;
  const result = { runId: raft.run.runId, revision: raft.run.revision, status: "complete", patterns: [{ kind: "successful_practice", explanation: ANSWER_MARK,
    evidence: [{ target: "#ops", messageId: MSG[1] }], counterevidence: [], evidenceLevel: "conversation_only", intent: "active", suggestion: "" }] };
  await o.D.deliverAnswer(TENANT, AGENT, id, answerOf(JSON.stringify(result)), 5);
  await o.alarms(1);
  must(!o.crash.armed && raft.accepted === 1, `the crash was not where it was meant to be: armed ${o.crash.armed}, accepted ${raft.accepted}`);
  must(o.whereIs(MATERIAL_MARK).length > 0, "the material was gone before any later pass, so the case proves nothing");
  // No push, no answer, no RPC: only what the object armed for itself.
  must(o.state.alarmAt !== null, "nothing is armed to wake the object after the crash");
  await o.alarms(5);
  const left = { material: o.whereIs(MATERIAL_MARK), answer: o.whereIs(ANSWER_MARK) };
  must(left.material.length === 0 && left.answer.length === 0, `after the alarm alone: ${show(left)}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
