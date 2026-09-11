/**
 * P0-CF: does the Cloudflare substrate actually give us what the plan needs?
 *
 * Verifies, on real infrastructure and not from documentation:
 *   1. Worker Loader is available on this account at all.
 *   2. A dynamically loaded Worker is a fresh isolate — no state carries over.
 *   3. `globalOutbound: null` blocks the network at the platform level, so the
 *      tool binding really is the only way out (§4.4).
 *   4. `limits.cpuMs` kills a runaway loop without taking the host down (§6.3).
 *   5. A capability binding reaches the sandbox and nothing else does (§5.1).
 *   6. DO SQLite storage commits the three-gate advance atomically (§7.3).
 *   7. Alarm wakeup actually fires, and how late (§7.3 可靠唤醒).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor, handleSandboxCall } from "../../src/runtime/dynamic-worker-executor.ts";
import { executorSpec } from "../../test/spec/executor-spec.ts";
import {
  AgentRuntime, OPERATOR_RUN9_REF, OPERATOR_SECRET_REF,
} from "./runtime.ts";
import { readMeter } from "../../bench/meter.ts";
import { contextWindowFor } from "../../src/model/context-windows.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { toRequest, fromResponse, errorMessage } from "../../src/model/pi-bridge.ts";
import { entriesToEvents } from "./pi-view.ts";
import { ensureAgentTables } from "../../src/runtime/pi-agent.ts";
import { MAIN_SESSION, piTables } from "../../src/store/pi-storage.ts";
import { validateMount } from "../../src/runtime/mount-config.ts";
import { BenchState } from "./bench.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import {
  page, trajectory, approvals, conversation, eventList, storage, memoryPanel, sandboxPanel,
  runtimePanel, timeline, tokens, plugins, mountFragment, inbox, mountList, catalogue, agentList } from "./ui.ts";

export interface Env {
  AGENT: DurableObjectNamespace<AgentDO>;
  ARTIFACTS: R2Bucket;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  HARNESS_MODEL: string;
  ARTIFACT_BUCKET: string;
  /** JSON {"ak","sk"} for the operator's run9 account. Absent means the `node`
   *  mount exists but cannot start a container. */
  RUN9?: string;
  /** 32 bytes, base64: the key per-agent credentials are sealed under. */
  SECRET_KEK?: string;
  HARNESS_MODE?: string;
  /** Context window of HARNESS_MODEL, in tokens. Compaction is a share of it. */
  HARNESS_CONTEXT_WINDOW?: string;
  /** "1" opens the demo UI with no Access identity. Off by default. */
  UI_ALLOW_ANONYMOUS?: string;
  /** Lets automation reach the endpoints that spend money, since Access sits
   *  on the custom hostname and scripts cannot sign in through it. */
  AUTOMATION_TOKEN?: string;
  LOADER: {
    load(code: WorkerCode): WorkerStub;
    get(id: string, cb: () => Promise<WorkerCode> | WorkerCode): WorkerStub;
  };
  /** Where a model call goes to be waited on. A queue, because a queue is the
   *  only thing here that owns work across invocations: it redelivers until the
   *  consumer acks, and gives up into a dead letter queue rather than silently.
   *  The message carries ids only — the transcript stays in the object. */
  MODEL_QUEUE: { send(body: unknown): Promise<void> };
}
type WorkerCode = {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
  limits?: { cpuMs?: number; subRequests?: number };
};
type WorkerStub = { getEntrypoint(name?: string | null, opts?: unknown): { fetch(req: Request): Promise<Response> } };

/** The P0 probe binding (kept for the substrate checks). */
export class ToolBinding extends WorkerEntrypoint {
  async invoke(name: string, args: unknown) {
    const caller = (this.ctx as any).props ?? {};
    if (name === "echo") return { status: "succeeded", result: { args, tenant: caller.tenantId } };
    if (name === "slow") { await new Promise((r) => setTimeout(r, 20)); return { status: "succeeded", result: {} }; }
    return { status: "rejected", error: { code: "not_mounted", message: name } };
  }
}

/**
 * What the sandbox sees as `env.TOOLS`. It holds no authority of its own: the
 * execution id in ctx.props is the only thing it can say, and the supervisor
 * decides what that id is allowed to do.
 */
export class SandboxTools extends WorkerEntrypoint<Env> {
  async invoke(strings: string[], values: unknown[]) {
    const props = ((this.ctx as any).props ?? {}) as { execId?: string; doId?: string };
    // ctx.exports loopback entrypoints do NOT run in the Durable Object's
    // isolate, so the execution registry is not visible from here. Hop back into
    // the object that owns the execution.
    const stub = this.env.AGENT.get(this.env.AGENT.idFromString(String(props.doId)));
    return stub.sandboxCall(String(props.execId ?? ""), strings, values);
  }
}

/**
 * Runs `model.request` outside the Durable Object.
 *
 * The point is purely economic: a Durable Object is billed for wall-clock
 * duration while it is active, and a model completion is ~94% waiting. A Worker
 * is billed for CPU, and awaiting I/O costs no CPU. Same call, same result
 * event — it just stops the object from being billed for the wait.
 *
 * Returning before the model answers is the whole trick, so the work is handed
 * to waitUntil. If this runtime ever stops honouring waitUntil past the return,
 * the fallback is to await inline: slower and no cheaper, but never a lost task.
 */
/**
 * The model call, waited on where waiting is free.
 *
 * A Worker bills CPU, not wall clock, so a sixty-second provider call costs
 * almost nothing here; the same wait inside the Durable Object is billed by
 * duration, which is the entire reason the call leaves the object at all.
 *
 * What changed is who owns the work while it is out. This used to be
 * `ctx.waitUntil` in a fetch handler — a promise attached to an invocation that
 * had already returned 202, which the platform cancels once its budget is
 * spent. When that happened the provider call died, `deliverModel` was never
 * reached, and the task sat `waiting` on a reply that no longer existed. The
 * sweeper, the give-up timer and the requeue logic were all attempts to notice
 * that from the outside. A queue does not need noticing: the message is not
 * acked until this returns, so a cancelled invocation is simply redelivered.
 */
interface QueuedModelCall {
  doId: string;
  tenantId: string;
  agentId: string;
  jobId: string;
}

/**
 * The model call, waited on where waiting is free.
 *
 * A Worker bills CPU, not wall clock, so a sixty-second provider call costs
 * almost nothing here; the same wait inside the Durable Object is billed by
 * duration, which is the entire reason the call leaves the object at all.
 *
 * The request arrives in pi's shape and is converted here rather than by
 * importing pi's own provider implementations, which would drag four vendor
 * SDKs into a binary shipped to every tenant.
 */
async function runQueuedModelCall(m: QueuedModelCall, env: Env) {
  const stub = env.AGENT.get(env.AGENT.idFromString(m.doId));
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId) as any;
  // Already answered — a redelivery after success, which must not call the
  // provider again.
  if (!job) return;

  const model = new OpenAiCompatibleModel({
    baseUrl: env.DEEPSEEK_BASE_URL,
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.HARNESS_MODEL,
  });
  const { messages, tools } = toRequest(job.context);
  const t0 = Date.now();
  const res = await model.complete(messages, tools ? { tools } : {});
  const identity = {
    api: String(job.model?.api ?? "offloaded"),
    provider: String(job.model?.provider ?? "openai-compatible"),
    id: String(job.model?.id ?? env.HARNESS_MODEL),
  };
  await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, fromResponse(res, identity), Date.now() - t0);
}

/** Out of retries. The agent has to hear about it, or it waits for ever. */
async function failLoudly(m: QueuedModelCall, env: Env) {
  const stub = env.AGENT.get(env.AGENT.idFromString(m.doId));
  const job = await stub.takeJob(m.tenantId, m.agentId, m.jobId) as any;
  if (!job) return;
  await stub.deliverAnswer(m.tenantId, m.agentId, m.jobId, errorMessage(
    "the model call failed repeatedly and was given up on",
    { api: "offloaded", provider: "openai-compatible", id: env.HARNESS_MODEL }), 0);
}

/**
 * One Durable Object per (tenant, agent).
 *
 * §12.1 rule 1 asks for isolation that is structural rather than a predicate.
 * Sharing one object put every tenant's rows in one SQLite database, so the
 * only thing standing between two customers was a WHERE clause being correct
 * everywhere, forever. Addressing by identity means the other tenant's data is
 * not in the database being queried at all.
 *
 * The separator is not a legal character in either id (both are validated on
 * the way in), so no two distinct pairs can collide on one name.
 */
export function agentObjectName(tenantId: string, agentId: string): string {
  for (const [label, v] of [["tenant", tenantId], ["agent", agentId]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) {
      throw new Error(`invalid ${label} id: ${JSON.stringify(v).slice(0, 60)}`);
    }
  }
  return `a/${tenantId}/${agentId}`;
}

const RUNNER = (body: string) => `
export default {
  async fetch(request, env) {
    const out = [];
    const output = (v) => out.push(v);
    try {
      const result = await (async () => { ${body} })();
      return Response.json({ ok: true, out, result: result ?? null });
    } catch (e) {
      return Response.json({ ok: false, out, error: String(e && e.message || e) });
    }
  }
};`;

async function runSandbox(
  env: Env,
  body: string,
  opts: { limits?: { cpuMs?: number; subRequests?: number }; outbound?: unknown; tools?: unknown } = {},
) {
  const stub = env.LOADER.load({
    compatibilityDate: "2026-09-05",
    mainModule: "main.js",
    modules: { "main.js": RUNNER(body) },
    globalOutbound: opts.outbound === undefined ? null : opts.outbound,
    env: opts.tools ? { TOOLS: opts.tools } : {},
    limits: opts.limits,
  });
  // A CPU/subrequest kill is NOT catchable inside the sandbox: it surfaces as a
  // rejection here, in the caller. Every invocation must therefore be wrapped —
  // otherwise one runaway script takes down the supervisor's whole request.
  try {
    const res = await stub.getEntrypoint().fetch(new Request("https://sandbox/"));
    return await res.json();
  } catch (e: any) {
    return { ok: false, terminatedByHost: true, error: String(e?.message ?? e).slice(0, 120) };
  }
}

export class AgentDO extends DurableObject<Env> {
  sql: SqlStorage;
  #store: DurableObjectStore | null = null;
  #runtime: AgentRuntime | null = null;
  alarmFiredAt: number | null = null;
  alarmSetAt: number | null = null;
  /** One variable, flipped at runtime, so the A/B is the same code path. */
  // NOT instance state. A Durable Object is evicted and rebuilt freely, and an
  // in-memory flag silently reverts to its default when that happens — which is
  // how the control arm of an A/B ended up half-offloaded. Persisted in SQLite,
  // read on every use.
  #offloadDefault = true;
  #identity: { tenantId: string; agentId: string } | null = null;
  #bench: BenchState | null = null;
  #benchRuntime: AgentRuntime | null = null;
  #benchPolicy = "";
  #benchOffload = true;
  #benchModeCached: "tau2" | "swe" = "tau2";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_tasks(
      task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, generation INTEGER NOT NULL,
      checkpoint_version INTEGER NOT NULL, fencing_token INTEGER NOT NULL, checkpoint TEXT NOT NULL)`);
    // What Cloudflare bills this object for: wall clock while it is active.
    this.sql.exec("CREATE TABLE IF NOT EXISTS do_activity(at INTEGER, ms INTEGER, kind TEXT)");
    // Created here rather than on first claim: the alarm reads it, and an alarm
    // can fire on an object nothing has claimed yet.
    this.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
    // Everything an agent keeps, from this object's first breath. The console
    // reads some of it directly for its change check, which happens long
    // before anyone opens an agent.
    ensureAgentTables(this.sql as any);
    // The bench runtime has to survive eviction: an alarm on a fresh instance
    // must rebuild the same harness, not fall back to the default one.
    this.sql.exec("CREATE TABLE IF NOT EXISTS bench_config(k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_outbox(
      command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL)`);
  }

  /** The three-gate advance from §7.3, on DO SQLite, timed. */
  async verifyStorage() {
    const t0 = Date.now();
    this.sql.exec("DELETE FROM probe_tasks");
    this.sql.exec("DELETE FROM probe_outbox");
    this.sql.exec(
      "INSERT INTO probe_tasks VALUES ('t1','tenant-a',0,0,0,?)", JSON.stringify({ log: [] }));

    const commit = (gen: number, token: number, version: number, cmd: string) =>
      this.ctx.storage.transactionSync(() => {
        const row = [...this.sql.exec("SELECT * FROM probe_tasks WHERE task_id='t1'")][0] as any;
        if (token < row.fencing_token) return "fenced";
        if (gen !== row.generation) return "stale_generation";
        if (version !== row.checkpoint_version) return "version_conflict";
        this.sql.exec(
          "UPDATE probe_tasks SET checkpoint_version=?, fencing_token=?, checkpoint=? WHERE task_id='t1'",
          row.checkpoint_version + 1, token, JSON.stringify({ log: [cmd] }));
        this.sql.exec("INSERT INTO probe_outbox VALUES (?, 't1', 'pending') ON CONFLICT DO NOTHING", cmd);
        return "ok";
      });

    const results = {
      happyPath: commit(0, 5, 0, "cmd-1"),
      staleVersion: commit(0, 5, 0, "cmd-dup"),
      fenced: commit(0, 1, 1, "cmd-zombie"),
      staleGeneration: commit(9, 6, 1, "cmd-oldgen"),
      replayIsIdempotent: (() => {
        commit(0, 6, 1, "cmd-1");
        return [...this.sql.exec("SELECT count(*) AS n FROM probe_outbox WHERE command_id='cmd-1'")][0];
      })(),
      rowsAfter: [...this.sql.exec("SELECT * FROM probe_tasks")][0],
      ms: Date.now() - t0,
    };
    return results;
  }

  runtime(): AgentRuntime {
    this.#runtime ??= new AgentRuntime({
      ctx: this.ctx,
      bucket: this.env.ARTIFACTS,
      bucketName: this.env.ARTIFACT_BUCKET,
      loader: this.env.LOADER,
      makeToolBinding: (execId) =>
        (this.ctx as any).exports.SandboxTools({ props: { execId, doId: this.ctx.id.toString() } }),
      operatorModel: {
        baseUrl: this.env.DEEPSEEK_BASE_URL,
        apiKey: this.env.DEEPSEEK_API_KEY,
        model: this.env.HARNESS_MODEL,
      },
      operatorRun9: this.env.RUN9 ? JSON.parse(this.env.RUN9) : undefined,
      secretKek: this.env.SECRET_KEK,
      // Native tool calling by default. The alternative asks the model to
      // reply in a convention invented here, and a model under any pressure
      // falls back to the one it was trained on — four different markups
      // turned up in two days, each of which the harness mistook for a final
      // answer. Providers have a channel for this; using it is not a
      // preference.
      // Looked up from the model's own name, so changing HARNESS_MODEL brings
      // the right window with it. The variable stays as an override for a model
      // the table does not know.
      contextWindow: Number(this.env.HARNESS_CONTEXT_WINDOW)
        || contextWindowFor(this.env.HARNESS_MODEL),
      offloadModel: this.#offloadOn() ? (job) => this.#dispatch(job) : undefined,
    });
    return this.#runtime;
  }

  /**
   * Addressing alone is a convention; this makes it an invariant. The object
   * records whose it is on first use and refuses anyone else afterwards, so a
   * routing mistake fails loudly instead of quietly mixing two tenants' data
   * into one database.
   */
  #claim(tenantId: string, agentId: string) {
    this.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
    const row = this.sql.exec("SELECT tenant_id, agent_id FROM owner WHERE k='self'").toArray()[0] as any;
    if (!row) {
      this.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self',?,?)", tenantId, agentId);
      this.#identity = { tenantId, agentId };
      return;
    }
    if (row.tenant_id !== tenantId || row.agent_id !== agentId) {
      throw new Error(
        `object belongs to ${row.tenant_id}/${row.agent_id}, refusing ${tenantId}/${agentId}`,
      );
    }
    this.#identity = { tenantId, agentId };
  }

  /**
   * Drop everything held only in memory, as an eviction does.
   *
   * A Durable Object is rebuilt freely, so an instance field is a cache and
   * never a decision. That rule has already been broken once: the offload flag
   * lived only in memory, silently reverted to its default after an eviction,
   * and turned the control arm of an A/B into a half-offloaded run that looked
   * completely plausible. Exercised by /eviction so the rule is checked rather
   * than remembered.
   */
  async simulateEviction() {
    this.#store = null;
    this.#runtime = null;
    this.#identity = null;
    this.#bench = null;
    this.#benchRuntime = null;
    this.#benchPolicy = "";
    this.#benchOffload = true;
    this.#offloadDefault = true;
    return { evicted: true };
  }

  /** Which tenants have rows in THIS object's database. Structural isolation
   *  means this can only ever be the one tenant the object belongs to. */
  async listTenants(): Promise<string[]> {
    try {
      return (this.sql.exec("SELECT DISTINCT tenant_id FROM tasks").toArray() as any[])
        .map((r) => String(r.tenant_id)).sort();
    } catch { return []; }
  }

  /** Who this object serves, once claimed. Absent until something claims it —
   *  and absent is an answer, not a failure: an object whose alarm fires before
   *  anything has claimed it has nothing to step. Reading it used to throw
   *  `no such table: owner`, which the alarm handler caught and counted as a
   *  failure, so the object rearmed every 30s and never advanced anything. */
  async owner() {
    const row = this.sql.exec(
      "SELECT tenant_id, agent_id FROM owner WHERE k='self'").toArray()[0] as any;
    return row ? { tenantId: row.tenant_id, agentId: row.agent_id } : null;
  }

  /** Wraps a billed entry point so we can measure what we are charged for. */
  async #busy<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.sql.exec("INSERT INTO do_activity VALUES (?,?,?)", t0, Date.now() - t0, kind);
    }
  }

  /**
   * Record a span this object did not spend being active.
   *
   * If offloading buys cheap duration but costs seconds per call, that is the
   * trade being made and it should be visible rather than inferred from wall
   * clock. Measurement must never break delivery, so it cannot throw.
   */
  #note(at: number, ms: number, kind: string) {
    try { this.sql.exec("INSERT INTO do_activity VALUES (?,?,?)", at, ms, kind); }
    catch { /* a missing measurement is not a failure */ }
  }

  /**
   * The transcript, as rows.
   *
   * pi has no task id — a run is an operation and the conversation is a lane —
   * so the `taskId` still threaded through the console's routes addresses
   * nothing here. It is kept on the signatures because the page's URLs carry
   * it, and ignored.
   */
  async #entries(tenantId: string, agentId: string, fromSeq?: number) {
    const agent = await this.#activeRuntime().agent(tenantId, agentId);
    return agent.storage.scanEntries(
      { order: "asc", ...(fromSeq === undefined ? {} : { fromSeq }) }, BACKGROUND_CONTEXT);
  }

  /**
   * Active wall clock this object has accumulated — the DO duration bill.
   *
   * Handlers overlap: a Durable Object is single-threaded but interleaves at
   * await points, so an alarm that is waiting on the model does not stop the
   * next alarm from starting. Summing handler durations therefore over-counts
   * (an early run reported 262s of "active" inside a 241s window). Cloudflare
   * bills the wall clock during which the object is active, so the honest
   * measure is the UNION of the busy intervals, not their sum.
   */
  async activity(sinceMs = 0) {
    const all = this.sql
      .exec("SELECT at, ms, kind FROM do_activity WHERE at >= ? ORDER BY at ASC", sinceMs)
      .toArray() as any[];
    // offload_rtt measures time spent OUTSIDE this object; counting it as busy
    // would report exactly the cost the change is meant to remove.
    const rows = all.filter((r: any) => !String(r.kind).startsWith("offload_"));
    let unionMs = 0, curStart = -1, curEnd = -1;
    for (const r of rows) {
      const a = Number(r.at), b = a + Number(r.ms);
      if (curStart < 0) { curStart = a; curEnd = b; continue; }
      if (a <= curEnd) curEnd = Math.max(curEnd, b);
      else { unionMs += curEnd - curStart; curStart = a; curEnd = b; }
    }
    if (curStart >= 0) unionMs += curEnd - curStart;

    const byKind = new Map<string, { n: number; ms: number }>();
    for (const r of all) {
      const e = byKind.get(r.kind) ?? { n: 0, ms: 0 };
      e.n++; e.ms += Number(r.ms);
      byKind.set(r.kind, e);
    }
    // Polling is an artefact of the benchmark driver, not of the design (the
    // production path pushes over a hibernatable WebSocket), so it is reported
    // separately rather than folded into the agent's own cost.
    const pollMs = byKind.get("poll")?.ms ?? 0;
    return {
      activeMs: unionMs,
      summedMs: rows.reduce((a, r) => a + Number(r.ms), 0),
      pollMs,
      invocations: rows.length,
      spanMs: rows.length ? Number(rows.at(-1).at) + Number(rows.at(-1).ms) - Number(rows[0].at) : 0,
      byKind: [...byKind].map(([kind, v]) => ({ kind, n: v.n, ms: v.ms })),
    };
  }

  /**
   * Hand the model call to the queue and forget it.
   *
   * Only the ids travel. The payload is a whole transcript — well past the
   * 128 KB message limit on a long task — and it is already durable in this
   * object, so sending it would be duplicating the log into a channel that
   * cannot hold it.
   */
  async #dispatch(job: { tenantId: string; agentId: string; commandId: string }): Promise<void> {
    await this.env.MODEL_QUEUE.send({
      doId: this.ctx.id.toString(),
      tenantId: job.tenantId, agentId: job.agentId, jobId: job.commandId,
    });
    this.#note(Date.now(), 0, "offload_dispatch");
  }

  /**
   * What the worker asks for, and what it hands back.
   *
   * Returns null once the reply is in: a redelivery after a successful call
   * must not run the provider a second time.
   */
  async takeJob(tenantId: string, agentId: string, jobId: string) {
    return this.#activeRuntime().takeJob(tenantId, agentId, jobId);
  }

  async deliverAnswer(
    tenantId: string, agentId: string, jobId: string, answer: unknown, modelMs = 0,
  ) {
    const rt = this.#activeRuntime();
    const wrote = await this.#busy("deliver", () =>
      rt.deliverAnswer(tenantId, agentId, jobId, answer));
    if (wrote && modelMs > 0) {
      this.#note(Date.now() - modelMs, modelMs, "offload_provider");
      this.#note(Date.now() - modelMs, modelMs, "offload_rtt");
    }
    if (wrote) {
      await this.broadcast();
      // The answer is what makes the next pass finish, so wake now rather than
      // waiting for the safety-net alarm.
      await this.ctx.storage.setAlarm(Date.now());
    }
    return wrote;
  }

  /**
   * Why is this agent not moving?
   *
   * The UI is addressed by identity, so an operator cannot look at someone
   * else's object through it — which is right, and also means a stuck agent is
   * invisible without a way in. Reachable only with the automation secret.
   */
  async diagnose(tenantId: string, agentId: string, taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const agent = await rt.agent(tenantId, agentId);
    const entries = await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
    const events = entriesToEvents(entries);
    const kinds: Record<string, number> = {};
    for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    const execution = await agent.lane.inspectExecution(BACKGROUND_CONTEXT);
    const compactions = entries.filter((e) => e.type === "compaction");
    return {
      owner: await this.owner(),
      // There is no checkpoint any more — the log is the state, so the size a
      // long conversation eventually runs into is the transcript itself.
      entries: entries.length,
      compaction: {
        compactions: compactions.length,
        messages: entries.filter((e) => e.type === "message").length,
        summary: (compactions.at(-1) as any)?.summary?.slice(0, 1200) ?? null,
      },
      // What the lane is doing right now, asked of the lane rather than
      // inferred from rows that might disagree with it.
      execution: {
        tip: execution.tipId, model: execution.configuredModel,
        current: execution.current, lastOperationId: execution.lastOperationId,
      },
      modelBinding: await rt.store.getModelBinding(tenantId, agentId),
      mounts: (await rt.store.listMounts(tenantId, agentId)).map((m) => ({
        alias: m.alias, plugin: m.plugin, policy: m.policy,
        // A mount created before a config field existed keeps the old config
        // for ever, and the symptom shows up somewhere else entirely.
        config: m.publicConfig,
      })),
      eventKinds: kinds,
      lastEvents: events.slice(-6).map((e) => ({
        seq: e.sequence, kind: e.kind,
        detail: JSON.stringify(e.payload).slice(0, 220),
      })),
      pendingWork: execution.current ? 1 : 0,
      alarm: await this.ctx.storage.getAlarm(),
      // What the agent believes, in the operator's own view. The tools tell the
      // agent this is readable by the person running it; that has to be true,
      // or a wrong memory is only discoverable by watching it act on one.
      state: await (async () => {
        const rt2 = this.#activeRuntime();
        const keys = await rt2.store.listState(tenantId, agentId, "", 20);
        const docs: Record<string, unknown> = {};
        for (const k of keys.slice(0, 5)) {
          const got = await rt2.store.getState(tenantId, agentId, k.key);
          docs[k.key] = got?.ref ?? (typeof got?.value === "string"
            ? got.value.slice(0, 600) : got?.value);
        }
        return { ...(await rt2.store.stateUsage(tenantId, agentId)), docs };
      })(),
      alarmFailures: this.#alarmFailures(),
      // What is still being billed because it could not be handed back.
      releaseErrors: (this.sql.exec(
        "CREATE TABLE IF NOT EXISTS release_errors(at INTEGER, alias TEXT, message TEXT)"),
        [...this.sql.exec("SELECT at, alias, message FROM release_errors ORDER BY at DESC LIMIT 5")]
          .map((r: any) => ({ at: r.at, alias: r.alias, message: r.message }))),
      // The table exists only once an alarm has failed; diagnose must not be
      // the thing that throws while explaining why something else did.
      alarmErrors: (this.sql.exec("CREATE TABLE IF NOT EXISTS alarm_errors(at INTEGER, message TEXT)"),
        [...this.sql.exec(
        "SELECT at, message FROM alarm_errors ORDER BY at DESC LIMIT 3")].map((r: any) => r.message)),
      // Which model calls are still out. An agent that stops for no visible
      // reason is nearly always a row here that nothing is watching.
      modelJobs: [...this.sql.exec(
        `SELECT id, created_at FROM pi_model_jobs
          WHERE answer IS NULL ORDER BY created_at DESC LIMIT 10`)].map((r: any) => ({
          id: r.id, ageMs: Date.now() - Number(r.created_at),
        })),
      // What the panel actually renders. "It is not replying" and "the reply is
      // not being drawn" look identical from outside, so show the rendering.
      rendered: await (async () => {
        try {
          const t = await this.uiTranscript(tenantId, agentId, taskId);
          const out = trajectory(t.events, t.byOp, t.busy);
          return { ok: true, bytes: out.length, steps: (out.match(/class="step /g) ?? []).length,
                   tail: out.slice(-400) };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
        }
      })(),
    };
  }

  /** The binding, credential-free, so an operator can see whose key is in use. */
  async modelBinding(tenantId: string, agentId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    return rt.store.getModelBinding(tenantId, agentId);
  }

  /** Exposed so the eviction check can read the persisted decision. */
  async readOffload(): Promise<boolean> {
    return this.#offloadOn();
  }

  #offloadOn(): boolean {
    const row = this.sql.exec("SELECT v FROM bench_config WHERE k='offload'").toArray()[0] as any;
    return row ? row.v === "1" : this.#offloadDefault;
  }

  async setOffload(on: boolean) {
    const before = this.#offloadOn();
    this.sql.exec(
      "INSERT INTO bench_config(k,v) VALUES ('offload',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      on ? "1" : "0");
    if (on !== before) {
      this.#runtime = null; // rebuilt with the new wiring on next use
      this.#benchRuntime = null;
    }
    return { offload: on };
  }

  // ---------------------------------------------------------------- benchmark
  //
  // τ²-bench retail, driven from outside but executed here, so a Cloudflare
  // change is judged on the same tasks and the same scoring as every other
  // harness ablation.

  #benchState(): BenchState {
    this.#bench ??= new BenchState(this.env.ARTIFACTS, this.sql);
    return this.#bench;
  }

  /**
   * The runtime an alarm should drive.
   *
   * This object serves either ordinary agent traffic or a benchmark run, never
   * both (they are addressed as different Durable Objects). Getting this wrong
   * is silent and expensive: the alarm drained with the default runtime, so
   * bench tasks were advanced by the codegen harness with no domain plugin
   * mounted, and every "hybrid" measurement was really measuring codegen.
   */
  #activeRuntime(): AgentRuntime {
    const row = this.sql.exec("SELECT v FROM bench_config WHERE k='policy'").toArray()[0] as any;
    return row ? this.#benchRt(String(row.v)) : this.runtime();
  }

  /** Which benchmark this object is hosting. Persisted, because the alarm
   *  that advances a run may be the first thing a rebuilt instance does. */
  #benchMode(): "tau2" | "swe" {
    const row = this.sql.exec("SELECT v FROM bench_config WHERE k='mode'").toArray()[0] as any;
    return row?.v === "swe" ? "swe" : "tau2";
  }

  #benchRt(policy: string): AgentRuntime {
    const off = this.#offloadOn();
    const mode = this.#benchMode();
    if (this.#benchRuntime && this.#benchPolicy === policy && this.#benchOffload === off
        && this.#benchModeCached === mode) {
      return this.#benchRuntime;
    }
    this.#benchPolicy = policy;
    this.#benchOffload = off;
    this.#benchModeCached = mode;
    const swe = mode === "swe";
    this.#benchRuntime = new AgentRuntime({
      ctx: this.ctx,
      bucket: this.env.ARTIFACTS,
      bucketName: this.env.ARTIFACT_BUCKET,
      loader: this.env.LOADER,
      makeToolBinding: (execId) =>
        (this.ctx as any).exports.SandboxTools({ props: { execId, doId: this.ctx.id.toString() } }),
      operatorModel: {
        baseUrl: this.env.DEEPSEEK_BASE_URL,
        apiKey: this.env.DEEPSEEK_API_KEY,
        model: this.env.HARNESS_MODEL,
      },
      operatorRun9: this.env.RUN9 ? JSON.parse(this.env.RUN9) : undefined,
      secretKek: this.env.SECRET_KEK,
      // τ² mounts its domain as a plugin; SWE-bench mounts a machine, which
      // the runtime already has.
      extraPlugins: swe ? [] : [this.#benchState().plugin()],
      maxTurns: swe ? 120 : 40,
      policy,
      // What the Node runner offers, and nothing else. The deployed console has
      // a sandbox; the Node τ² arm never did, and running the object arm with
      // one meant the two arms differed by a tool and a page of prompt while
      // being reported as the same measurement. The Node SWE-bench arm did
      // offer it, so the object arm does too — same rule, opposite answer.
      sandbox: swe,
      // The grader runs after the agent, in the agent's container. So the
      // agent is never offered the tool that destroys it, and a settled run
      // does not hand the machine back on its own: the runner does, after
      // grading, through benchSweRelease — and owns the bill if it forgets.
      withholdTools: swe ? ["node.release"] : undefined,
      autoRelease: !swe,
      offloadModel: this.#offloadOn() ? (job) => this.#dispatch(job) : undefined,
    });
    return this.#benchRuntime;
  }

  #setBenchConfig(k: string, v: string) {
    this.sql.exec(
      "INSERT INTO bench_config(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, v);
  }

  /** A bench task's transcript is cleared and its owner row rewritten; shared
   *  by both benchmarks. See benchStart for why each is needed. */
  #takeBenchAgent(agentId: string) {
    this.#clearTranscript();
    this.sql.exec(
      "INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self',?,?) " +
      "ON CONFLICT(k) DO UPDATE SET tenant_id=excluded.tenant_id, agent_id=excluded.agent_id",
      "bench", agentId);
  }

  // ------------------------------------------------------- SWE-bench, hosted

  /**
   * One SWE-bench instance, inside this object.
   *
   * The agent gets a real machine (the run9 mount, from the instance's own
   * published image) and the tools plugin, nothing else — what the Node runner
   * mounted. The container is held open past the agent's finish because the
   * grader has to run in it; `benchSweShell` is the runner's way in and
   * `benchSweRelease` is how the machine comes back. Nothing here polls.
   */
  async benchSweStart(taskId: string, o: {
    policy: string; image: string; workdir?: string; shape?: string; timeoutMs?: number;
    shell?: string; shellPrefix?: string; offload?: boolean; network?: "open" | "none";
  }) {
    await this.setOffload(o.offload !== false);
    return this.#busy("benchSweStart", async () => {
      const agentId = `b_${taskId}`;
      this.#setBenchConfig("mode", "swe");
      this.#setBenchConfig("policy", o.policy);
      this.#benchRuntime = null;
      this.#takeBenchAgent(agentId);
      const rt = this.#benchRt(o.policy);
      await rt.ready();
      await rt.bindOperatorModel("bench", agentId);
      await rt.provision("bench", agentId, [
        { alias: "tools", plugin: "tools", account: "builtin" },
      ]);
      // The machine, from the instance's own image. Config is per mount, so a
      // different repository is a different mount record, not different code.
      await rt.store.addMount({
        tenantId: "bench", agentId, alias: "node", plugin: "run9",
        installationId: "inst-node", connectionId: null,
        toolVersion: rt.pluginVersion("run9") ?? "1.0.0",
        publicConfig: {
          account: "container",
          image: o.image,
          workdir: o.workdir ?? "/testbed",
          shape: o.shape ?? "2c4g",
          timeoutMs: o.timeoutMs ?? 300_000,
          ...(o.shell ? { shell: o.shell } : {}),
          ...(o.shellPrefix ? { shellPrefix: o.shellPrefix } : {}),
          // No route out unless the runner says so. The answer to a SWE-bench
          // instance is a public commit; a box that can reach GitHub measures
          // retrieval, and in one run six of nine transcripts did exactly that.
          network: o.network ?? "none",
        },
        secretRef: OPERATOR_RUN9_REF, policy: null,
      });
      return { taskId, agentId, offload: this.#offloadOn(), mode: "swe", network: o.network ?? "none" };
    });
  }

  /** The runner's shell in the agent's container: applying the official test
   *  patch and running the tests. Metered as its own kind so the report can
   *  separate the loop's cost from the grader's. */
  async benchSweShell(taskId: string, command: string) {
    return this.#busy("benchSweShell", async () => {
      const rt = this.#activeRuntime();
      await rt.ready();
      return rt.gateway().invoke(
        { tenantId: "bench", agentId: `b_${taskId}`, taskId: "main" }, "node.shell", { command });
    });
  }

  async benchSweRelease(taskId: string) {
    return this.#busy("benchSweRelease", async () => {
      const rt = this.#activeRuntime();
      await rt.ready();
      return rt.gateway().releaseTask({ tenantId: "bench", agentId: `b_${taskId}`, taskId: "main" });
    });
  }

  /**
   * What the instance cost, read from the transcript and the mount.
   *
   * A suspended turn is an assistant message carrying the handle and no
   * content, so counting every message with a usage field counts a model call
   * once for the answer and once per poll that found it not ready; those are
   * skipped. The container meter is read after release, from the session the
   * run9 plugin writes into the mount's connection state when the box is
   * handed back — written there precisely so it outlives the box.
   */
  async benchSweStats(taskId: string, wallMs: number) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const agentId = `b_${taskId}`;
    const agent = await rt.agent("bench", agentId);
    const entries = await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT) as any[];
    const usage = entries.reduce((a: any, e: any) => {
      const m = e.message;
      if (m?.role !== "assistant" || m.stopReason === "deferred") return a;
      a.calls += 1;
      a.prompt += m.usage?.input ?? 0;
      a.out += m.usage?.output ?? 0;
      a.cached += m.usage?.cacheRead ?? 0;
      return a;
    }, { calls: 0, prompt: 0, out: 0, cached: 0 });
    const byTool: Record<string, number> = {};
    for (const e of entries) {
      const name = e.message?.role === "toolResult" ? e.message.toolName : null;
      if (name) byTool[name] = (byTool[name] ?? 0) + 1;
    }
    const modelTurns = usage.calls;
    const toolTurns = entries.filter((e: any) =>
      e.type === "message" && e.message?.role === "toolResult").length;
    const toolErrors = entries.filter((e: any) =>
      e.type === "message" && e.message?.role === "toolResult" && e.message.isError).length;
    const meter = await readMeter(rt.store as any, "bench", agentId, ["node"], wallMs, {
      promptTokens: usage.prompt, cachedTokens: usage.cached, outputTokens: usage.out,
    });
    return { taskId, usage, byTool, modelTurns, toolTurns, toolErrors, entries: entries.length, meter };
  }

  async benchStart(taskId: string, policy: string, offload: boolean) {
    await this.setOffload(offload);
    return this.#busy("benchStart", async () => {
      this.sql.exec(
        "INSERT INTO bench_config(k,v) VALUES ('policy',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", policy);
      const agentId = `b_${taskId}`;
      if (this.#benchMode() !== "tau2") { this.#setBenchConfig("mode", "tau2"); this.#benchRuntime = null; }
      await this.#benchState().reset(agentId);
      // A task starts on an empty transcript, because in production it would.
      //
      // pi's tables are object-local and carry no agent column, which is right
      // when one object is one agent — the invariant this whole design rests on.
      // A bench object breaks it deliberately: it hosts each task in turn so the
      // meter stays in one place. Without this, it also hosts each task's
      // conversation on top of the last one's. Task 7 of a run opened with 67
      // user messages already in context, the first of them task 0's, and the
      // agent was answering a customer from six conversations ago — 821k tokens
      // for an eight-turn task, and four failures scored against a harness that
      // was working exactly as designed.
      this.#clearTranscript();
      const rt = this.#benchRt(policy);
      // The alarm is what advances a run, and it asks the object who it serves.
      // Without this the bench agent existed, held a prompt and was never
      // stepped: 303s of the runner polling an object that had nothing to do.
      //
      // Retargeted rather than claimed. `#claim` refuses a second identity,
      // which is the right rule for a tenant's object and the wrong one here —
      // a bench object is deliberately reused, one task at a time, and each
      // task is its own agent.
      this.sql.exec(
        "INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self',?,?) " +
        "ON CONFLICT(k) DO UPDATE SET tenant_id=excluded.tenant_id, agent_id=excluded.agent_id",
        "bench", agentId);
      await rt.bindOperatorModel("bench", agentId);
      // Only what the Node bench mounts: github/artifacts would change the tool
      // catalogue and make the two runners incomparable.
      await rt.provision("bench", agentId, [
        { alias: "tools", plugin: "tools", account: "builtin" },
        { alias: "retail", plugin: "retail", account: "benchmark" },
      ]);
      return { taskId, agentId, offload: this.#offloadOn() };
    });
  }

  async benchSay(taskId: string, text: string) {
    return this.#busy("benchSay", async () => {
      const rt = this.#activeRuntime();
      const r = await rt.postMessage("bench", `b_${taskId}`, text);
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  /** Read-only, but it still wakes the object, so it is still billed. */
  async benchPoll(taskId: string) {
    return this.#busy("poll", () => this.#benchPollInner(taskId));
  }

  async #benchPollInner(taskId: string) {
    const agent = await this.#activeRuntime().agent("bench", `b_${taskId}`);
    const running = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
    const events = entriesToEvents(
      await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT));
    const last = [...events].reverse()
      .find((e) => e.kind === "model.response" && !(e.payload as any).toolCalls);
    return {
      status: running ? "running" : "idle",
      entries: events.length,
      answer: running ? null : ((last?.payload as any)?.text ?? null),
    };
  }

  /** What the harness actually handed the provider. Guessing at this cost two
   *  bench runs; it is cheaper to be able to look. */
  async benchDebug(taskId: string) {
    const agent = await this.#activeRuntime().agent("bench", this.#benchAgentId(taskId));
    const tools = await agent.harness.getTools(BACKGROUND_CONTEXT);
    const entries = await agent.storage.scanEntries({ order: "desc", limit: 4 }, BACKGROUND_CONTEXT);
    const execution = await agent.lane.inspectExecution(BACKGROUND_CONTEXT);
    return {
      status: execution.current ? "running" : "idle",
      model: execution.configuredModel,
      toolCount: tools.length,
      toolNames: tools.map((t: any) => t.name),
      lastMessages: entries.reverse().map((e: any) => ({
        type: e.type, role: e.message?.role,
        content: JSON.stringify(e.message?.content ?? e.summary ?? null).slice(0, 300),
      })),
    };
  }

  /** Why is this object busy? Answers the only question that matters when an
   *  alarm loop will not settle: what the lane still thinks it is doing. */
  async benchDiag() {
    const rt = this.#activeRuntime();
    await rt.ready();
    const who = await this.owner();
    const jobs = this.sql.exec(
      "SELECT id, created_at, answered_at FROM pi_model_jobs ORDER BY created_at DESC LIMIT 10")
      .toArray();
    let execution: unknown = null;
    if (who) {
      execution = await (await rt.agent(who.tenantId, who.agentId))
        .lane.inspectExecution(BACKGROUND_CONTEXT);
    }
    return { owner: who, execution, modelJobs: jobs, alarm: await this.ctx.storage.getAlarm() };
  }

  /** The agent tables, which a bench object reuses one task at a time. Kept
   *  apart from `benchPurge` because that also drops the meter, and the meter
   *  has to survive the task boundary to measure a run. */
  #clearTranscript() {
    // Kept before it is cleared. Running on the object rather than in memory is
    // supposed to leave a trace, and a task that wipes the previous task's
    // transcript leaves exactly as little as the in-process runner did — the
    // three failures in the last matrix were all in trial one, and by the time
    // they were worth reading, trials two and three had overwritten them.
    //
    // The owner row still names the task being replaced: it is rewritten after
    // this runs, not before.
    try {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS bench_archive(agent_id TEXT, seq INTEGER, body TEXT)");
      const prev = this.sql.exec(
        "SELECT agent_id FROM owner WHERE k='self'").toArray()[0] as any;
      if (prev?.agent_id) {
        this.sql.exec(
          "INSERT INTO bench_archive(agent_id, seq, body) SELECT ?, seq, body FROM pi_entries",
          prev.agent_id);
      }
    } catch { /* nothing to keep is not a failure */ }
    for (const t of ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta", "pi_model_jobs"]) {
      try { this.sql.exec(`DELETE FROM ${t}`); } catch { /* not created yet */ }
    }
    // The cached runtime holds a built session over the rows just deleted.
    this.#benchRuntime = null;
  }

  /** Bench state is disposable; contaminated state is worse than none. */
  async benchPurge() {
    await this.ctx.storage.deleteAlarm();
    for (const t of ["operations", "mounts", "agents", "agent_state", "approvals"]) {
      try { this.sql.exec(`DELETE FROM ${t} WHERE tenant_id='bench'`); } catch { /* table may lack the column */ }
    }
    // The transcript is object-local and has no tenant column: a bench object
    // holds nothing else, so clearing it is clearing the run.
    for (const t of ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta", "pi_model_jobs"]) {
      try { this.sql.exec(`DELETE FROM ${t}`); } catch { /* not created yet */ }
    }
    // Tolerant on purpose: purge is what you reach for when an object is in a
    // state you do not understand, and it failing because a table was never
    // created is the least useful moment for it to be strict.
    for (const t of ["bench_tasks", "do_activity", "bench_archive"]) {
      try { this.sql.exec(`DELETE FROM ${t}`); } catch { /* never created */ }
    }
    this.#benchRuntime = null;
    return { purged: true };
  }

  /**
   * A bench task's agent id from whatever the caller has. The listing prints
   * stored ids (`b_t_5_…`); the runners know bare task ids (`t_5_…`); the read
   * paths used to accept only the bare form, so the listing's own id read as
   * nothing. Both are accepted now, and nothing else changes.
   */
  #benchAgentId(taskId: string): string {
    return taskId.startsWith("b_") ? taskId : `b_${taskId}`;
  }

  /** A finished task's transcript, after the next one has taken the object.
   *  Without a task, what there is to ask for — an archive you cannot
   *  enumerate is one you have to already know the answer to use. */
  async benchTrajectory(taskId: string) {
    if (!taskId || taskId === "null") {
      try {
        return {
          archived: this.sql.exec(
            "SELECT agent_id, COUNT(*) AS entries FROM bench_archive" +
            " GROUP BY agent_id ORDER BY MIN(rowid) DESC").toArray(),
        };
      } catch { return { archived: [] }; }
    }
    try {
      const rows = this.sql.exec(
        "SELECT body FROM bench_archive WHERE agent_id=? ORDER BY seq ASC", this.#benchAgentId(taskId))
        .toArray() as any[];
      return { taskId, entries: entriesToEvents(rows.map((r) => JSON.parse(r.body))) };
    } catch { return { taskId, entries: [] }; }
  }

  async benchResult(taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const agentId = this.#benchAgentId(taskId);
    const agent = await rt.agent("bench", agentId);
    const events = entriesToEvents(
      await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT)) as any[];
    const usage = events.reduce(
      (a: any, e: any) => {
        const u = e.payload?.usage;
        if (u) { a.prompt += u.promptTokens ?? 0; a.completion += u.completionTokens ?? 0; a.calls += 1; }
        return a;
      }, { prompt: 0, completion: 0, calls: 0 });
    const kinds = events.reduce((m: any, e: any) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
    // Which tools, how often. The in-process runner reported this and the
    // object-side one did not, which left the one question the sandbox has
    // to answer — does anything reach for run_js — with no on-object evidence.
    const byTool: Record<string, number> = {};
    let toolErrors = 0;
    for (const e of await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT) as any[]) {
      const name = e.message?.role === "toolResult" ? e.message.toolName : null;
      if (name) byTool[name] = (byTool[name] ?? 0) + 1;
      if (name && e.message.isError) toolErrors += 1;
    }
    const r = await this.#benchState().result(agentId);
    // Errors are counted here so the run record carries them; a claim of
    // "zero tool errors" that rests on a transcript dump in someone's
    // workspace is not checkable once the workspace is gone.
    return { writes: r.writes, dbHash: await sha256(canonJson(r.db)), usage, kinds, byTool, toolErrors };
  }

  async resetActivity() {
    this.sql.exec("DELETE FROM do_activity");
    return { ok: true };
  }

  // -------------------------------------------------------------------- ui
  //
  // Everything the page needs, read straight from the store, so a panel can
  // never disagree with the runtime.

  /** Provisions the demo agent once: a read-only fleet tool plus writes that
   *  need a human. The policy is what the whole page exists to show. */
  /** The console's first conversation is the agent's first session, which
   *  keeps the transcript it always had; every other conversation is a
   *  session named by its task id. */
  #sessionOf(agentId: string, taskId: string): string {
    return taskId === `t_${agentId}` ? MAIN_SESSION : taskId;
  }

  /**
   * A conversation the caller may address: the default one, created on first
   * use, or one the create route minted for this agent. Anything else, an id
   * another agent owns or one nobody minted, is refused, for reads and writes
   * alike: a foreign id must neither disclose a transcript nor post into one.
   */
  async #conversation(tenantId: string, agentId: string, taskId: string): Promise<string> {
    const rt = this.runtime();
    await rt.ready();
    const t = String(taskId ?? "").trim();
    if (t === `t_${agentId}`) {
      if (!(await rt.store.loadTask(tenantId, t))) await rt.store.createTask(tenantId, agentId, t, {});
      return MAIN_SESSION;
    }
    const task = await rt.store.loadTask(tenantId, t);
    if (!task || task.agentId !== agentId) throw new Error(`no such conversation: ${t} (not this viewer's, or never created)`);
    return t;
  }

  /**
   * The person's agents, kept in their first agent's object: that object is
   * the one their identity names, so it is the one place a list of what they
   * own can live without a directory service. Each agent listed here is its
   * own object with its own mounts, credentials, memory and transcript; this
   * table only says whose it is, and what to call it.
   */
  #directory() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS owned_agents(
      agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      avatar TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  /** Records an agent the route has already had adopted by its own object. */
  async uiRecordAgent(tenantId: string, ownerAgentId: string, rec: { agentId: string; name: string; description: string; avatar: string; createdAt: number }) {
    this.#claim(tenantId, ownerAgentId);
    this.#directory();
    this.sql.exec("INSERT OR IGNORE INTO owned_agents(agent_id, name, description, avatar, created_at) VALUES (?,?,?,?,?)",
      rec.agentId, rec.name, rec.description, rec.avatar, rec.createdAt);
    return rec;
  }

  async uiListAgents(tenantId: string, ownerAgentId: string) {
    this.#claim(tenantId, ownerAgentId);
    this.#directory();
    const rows = this.sql.exec("SELECT * FROM owned_agents ORDER BY created_at DESC").toArray() as any[];
    const owned = rows.map((r) => ({
      agentId: String(r.agent_id), name: String(r.name), description: String(r.description),
      avatar: String(r.avatar), createdAt: Number(r.created_at),
    }));
    // The first agent is the person's own object, named before names existed;
    // it gets a name and a face the same way a new one would, drawn from its
    // id so they never change, rather than a label that says "default".
    return [...owned, { agentId: ownerAgentId, name: nameFor(ownerAgentId), description: "", avatar: avatarFor(ownerAgentId), createdAt: 0 }];
  }

  async uiOwnsAgent(tenantId: string, ownerAgentId: string, agentId: string): Promise<boolean> {
    if (agentId === ownerAgentId) return true;
    this.#claim(tenantId, ownerAgentId);
    this.#directory();
    return this.sql.exec("SELECT 1 FROM owned_agents WHERE agent_id=?", agentId).toArray().length > 0;
  }

  /**
   * Runs in the new agent's own object: the record that the harness reads
   * its persona from lives here, beside everything else that is this agent's.
   */
  async uiAdoptAgent(tenantId: string, agentId: string, spec: { name: string; description: string; avatar: string }) {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    if (!(await rt.store.loadAgent(tenantId, agentId))) {
      await rt.store.createAgent(tenantId, agentId, { name: spec.name, description: spec.description, avatar: spec.avatar });
    }
    return { ok: true };
  }

  async uiEnsure(tenantId: string, agentId: string, taskId: string) {
    this.#claim(tenantId, agentId);
    await this.#conversation(tenantId, agentId, taskId);
    return this.#busy("uiEnsure", async () => {
      const rt = this.runtime();
      await rt.ready();
      // Declared once, then reconciled. Creation-only provisioning cements
      // whatever the first deploy happened to write: `ops` was left without its
      // approval policy by a half-finished run, and `web` kept a 48 KB
      // `maxBytes` long after the code said 24 KB — above the offload
      // threshold, so every page the agent fetched came back as a reference to
      // storage instead of as text. Both were invisible until something else
      // broke. Config and policy are now compared, not merely defaulted.
      const desired = AgentRuntime.DEFAULT_MOUNTS;
      for (const d of desired) {
        // The pin is the registry's version, never a literal: the gateway
        // refuses a call whose pin disagrees with the registry, so a literal
        // is a mount that stops working the day its plugin moves.
        const toolVersion = rt.pluginVersion(d.plugin) ?? "1.0.0";
        const config = d.config ?? { account: d.account };
        const have = await rt.store.getMountByAlias(tenantId, agentId, d.alias);
        if (!have) {
          await rt.store.addMount({
            tenantId, agentId, alias: d.alias, plugin: d.plugin,
            installationId: `inst-${d.alias}`, connectionId: null, toolVersion,
            publicConfig: config, secretRef: d.secretRef ?? null, policy: d.policy ?? null,
          });
          continue;
        }
        if (JSON.stringify(have.publicConfig) !== JSON.stringify(config)) {
          await rt.store.updateMountConfig(tenantId, agentId, d.alias, config);
        }
        if (JSON.stringify(have.policy ?? null) !== JSON.stringify(d.policy ?? null)) {
          await rt.store.updateMountPolicy(tenantId, agentId, d.alias, d.policy);
        }
      }
      // Reconciled, not merely defaulted. The binding is written when an agent
      // is provisioned and was then never touched again, so changing the
      // deployment's model would silently apply to new agents only — the same
      // creation-only drift that left a mount on a stale config twice already.
      // An agent that brought its own credential is left alone; only the
      // operator's own binding follows the operator's choice.
      const binding = await rt.store.getModelBinding(tenantId, agentId);
      const stale = binding?.secretRef === OPERATOR_SECRET_REF &&
        (binding.model !== this.env.HARNESS_MODEL || binding.baseUrl !== this.env.DEEPSEEK_BASE_URL);
      if (!binding || stale) await rt.bindOperatorModel(tenantId, agentId);
      // The lane is the conversation, and this is where it comes into being:
      // opening the agent reads the transcript back and reports anything the
      // last eviction interrupted.
      await rt.agent(tenantId, agentId);
      return { ok: true };
    });
  }

  /**
   * Everything this object is holding, for the debugging console.
   *
   * Reads the tables directly rather than through the storage adapter. The
   * adapter is the seam two backends must both satisfy; a console that exists
   * to show what *this* object contains has no business widening it, and every
   * accessor added for the console alone would be one more thing to keep in
   * parity for no reason.
   */
  async uiStorage(tenantId: string, agentId: string, taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const rows = (q: string, ...b: unknown[]) => [...this.sql.exec(q, ...b)] as any[];
    const count = (t: string) => {
      try { return Number((rows(`SELECT COUNT(*) AS n FROM ${t}`)[0] ?? {}).n ?? 0); }
      catch { return 0; }
    };
    const tables = ["agents", "agent_state", "approvals", "connections", "counters",
      "model_bindings", "mounts", "operations", "quotas",
      "pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta", "pi_model_jobs"];
    return {
      tenantId, agentId, taskId,
      counts: Object.fromEntries(tables.map((t) => [t, count(t)])),
      // What the lane is doing, and what it is still owed. Leases, cursors and
      // an outbox are gone: the object is single-threaded and pi's mutation
      // line serialises, so there was never anything for them to protect here.
      lane: rows("SELECT namespace, key, seq FROM pi_values WHERE namespace LIKE 'pi.%' LIMIT 40"),
      modelJobs: rows(`SELECT id, created_at, answered_at, LENGTH(request) AS request_bytes
                         FROM pi_model_jobs ORDER BY created_at DESC LIMIT 20`),
      operations: rows(`SELECT operation_id, tool, status, result_ref, created_at FROM operations
                         WHERE tenant_id=? AND task_id=? ORDER BY created_at DESC LIMIT 40`,
        tenantId, taskId),
      approvals: rows("SELECT * FROM approvals WHERE tenant_id=? AND task_id=? ORDER BY created_at DESC LIMIT 20",
        tenantId, taskId),
      compactions: rows(`SELECT id, seq, timestamp, LENGTH(body) AS bytes FROM pi_entries
                          WHERE type='compaction' ORDER BY seq DESC LIMIT 20`),
      mounts: rows("SELECT alias, plugin, tool_version, public_config, secret_ref, policy FROM mounts WHERE tenant_id=? AND agent_id=?",
        tenantId, agentId),
      connections: rows("SELECT alias, state, expires_at, updated_at FROM connections WHERE tenant_id=? AND agent_id=?",
        tenantId, agentId),
      modelBinding: rows("SELECT * FROM model_bindings WHERE tenant_id=? AND agent_id=?", tenantId, agentId)[0] ?? null,
      quotas: rows("SELECT * FROM quotas WHERE tenant_id=?", tenantId),
      // The agent's own memory, whole rather than sampled: seeing what it
      // believes is most of what this console is for.
      state: (await rt.store.listState(tenantId, agentId, "", 50)).map((k) => ({ ...k })),
      stateDocs: rows("SELECT key, value, ref, bytes, updated_at FROM agent_state WHERE tenant_id=? AND agent_id=? ORDER BY key LIMIT 20",
        tenantId, agentId),
      runtime: {
        // Asked of the runtime, not re-derived from the rows. A console that
        // computes "is anything still out" its own way will disagree with the
        // thing it is meant to explain — and it did: it counted a `message.out`
        // that answers nothing as a command in flight.
        outstanding: Number((rows("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL")[0] ?? {}).n ?? 0),
        alarm: await this.ctx.storage.getAlarm(),
        alarmFailures: this.#alarmFailures(),
        activity: await this.activity(),
      },
    };
  }

  /**
   * What is installed, what this agent has mounted, and which of it is real.
   *
   * Two different questions that the console used to answer by mixing: a
   * plugin is code that is present, a mount is an authority this agent has
   * been given. The same plugin mounted twice against two accounts is two
   * mounts and one plugin, and a page that shows only one of the two cannot
   * explain why a tool call was refused.
   */
  async uiPlugins(tenantId: string, agentId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const installed = rt.plugins();
    const byId = new Map(installed.map((p) => [p.id, p]));
    const mounts = await rt.store.listMounts(tenantId, agentId);

    // Which tools this agent has actually reached for. A catalogue says what is
    // possible; this says what happened.
    const used: Record<string, number> = {};
    try {
      const agent = await rt.agent(tenantId, agentId);
      const entries = await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
      for (const e of entries as any[]) {
        const n = e.message?.role === "toolResult" ? e.message.toolName : null;
        if (n) used[n] = (used[n] ?? 0) + 1;
      }
    } catch { /* an agent with no transcript yet has used nothing */ }

    return {
      installed: installed.map((p) => ({
        id: p.id,
        version: p.version,
        credential: p.credential ?? null,
        config: p.config ?? [],
        tools: p.tools.map((t) => ({
          name: t.name, summary: t.summary,
          sideEffects: t.sideEffects, idempotency: t.idempotency,
        })),
      })),
      mounts: await Promise.all(mounts.map(async (m) => {
        const plugin = byId.get(m.plugin);
        const conn = await rt.store.getConnection(tenantId, agentId, m.alias).catch(() => null);
        return {
          alias: m.alias,
          plugin: m.plugin,
          version: m.toolVersion,
          account: (m.publicConfig as any)?.account ?? null,
          // Whether an account is attached, never which one and never its value.
          connected: !!m.secretRef,
          needsAccount: plugin?.credential?.required ?? false,
          optionalAccount: plugin?.credential ? !plugin.credential.required : false,
          policy: m.policy ?? null,
          config: m.publicConfig ?? {},
          session: conn ? { expiresAt: (conn as any).expiresAt ?? null } : null,
          // Attached, verified, account, last four, dates. Never a value.
          credential: await rt.credentialMeta(tenantId, agentId, m),
          problems: plugin
            ? validateMount(plugin, m.publicConfig as any, m.secretRef).map((x) => x.message)
            : [`no plugin named ${m.plugin} is installed`],
          tools: (plugin?.tools ?? []).map((t) => `${m.alias}.${t.name}`),
        };
      })),
      used,
    };
  }

  /** The console attaches a credential to one of this agent's mounts. The
   *  value arrives here once, is sealed, and is never read back by anything
   *  the console can call. */
  async uiAttachCredential(tenantId: string, agentId: string, alias: string, fields: Record<string, string>) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiAttachCredential", () => this.runtime().attachCredential(tenantId, agentId, alias, fields));
  }

  async uiRemoveCredential(tenantId: string, agentId: string, alias: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiRemoveCredential", () => this.runtime().removeCredential(tenantId, agentId, alias));
  }

  async uiCompact(tenantId: string, agentId: string, taskId: string) {
    this.#claim(tenantId, agentId);
    const session = await this.#conversation(tenantId, agentId, taskId);
    return this.#busy("uiCompact", async () => {
      const r = await this.runtime().requestCompaction(tenantId, agentId, session);
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  async uiSay(
    tenantId: string, agentId: string, taskId: string, text: string,
    mode: "steer" | "followUp" = "steer",
  ) {
    this.#claim(tenantId, agentId);
    const session = await this.#conversation(tenantId, agentId, taskId);
    return this.#busy("uiSay", async () => {
      const rt = this.runtime();
      const r = await rt.postMessage(tenantId, agentId, text, mode, session);
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  /**
   * @param tail how many of the most recent events to render, 0 for all.
   *
   * A long conversation is genuinely long: one here reached 2,362 events, which
   * rendered to 1.31 MB of HTML that the page re-fetched and re-parsed every
   * couple of seconds. Nobody reads the top of that, and the object pays to
   * produce it each time.
   */
  /**
   * Has anything changed?
   *
   * Cheap on purpose: the highest sequence plus whether the task is still
   * moving. The panels poll every couple of seconds, and re-rendering a long
   * conversation to discover that it is identical costs the object real time
   * and the browser a full re-parse of a megabyte.
   */
  async uiVersion(tenantId: string, agentId: string, taskId: string) {
    const session = await this.#conversation(tenantId, agentId, taskId);
    ensureAgentTables(this.sql, session);
    const t = piTables(session);
    const row = this.sql.exec(`SELECT MAX(seq) AS s, COUNT(*) AS n FROM ${t.entries}`)
      .toArray()[0] as any;
    const jobs = this.sql.exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL AND session = ?", session)
      .toArray()[0] as any;
    return `${row?.s ?? 0}.${row?.n ?? 0}.${jobs?.n ?? 0}`;
  }

  async uiTranscript(tenantId: string, agentId: string, taskId: string, tail = 0) {
    const session = await this.#conversation(tenantId, agentId, taskId);
    const rt = this.runtime();
    const agent = await rt.agent(tenantId, agentId, session);
    const all = entriesToEvents(await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT));
    const total = all.length;
    const events = (tail > 0 ? all.slice(-tail) : all).map((e) => ({
      sequence: e.sequence, kind: e.kind, payload: e.payload,
      createdAt: Number((e.payload as any)?.at ?? 0),
    }));
    const running = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
    const pendingApproval = (await rt.store.listApprovals(tenantId, "pending")).length > 0;
    const busy: "thinking" | "waiting-for-approval" | null = pendingApproval
      ? "waiting-for-approval"
      : running ? "thinking" : null;
    // Approvals are keyed by operation so the trajectory can show a held call
    // where it happened, with who signed it, instead of in a separate panel.
    const byOp: Record<string, any> = {};
    for (const a of await rt.store.listApprovals(tenantId)) {
      byOp[a.operationId] = {
        state: a.state, approver: a.approver, tool: `${a.mountAlias}.${a.tool}`, request: a.request,
      };
    }
    return {
      total, shown: events.length, events, byOp, busy };
  }

  /**
   * The inbox: every call held for a decision across this agent's tasks,
   * oldest first, plus how many tasks there are and how many are still open.
   * The same store method the per-task panel reads, without the task filter.
   */
  async uiInbox(tenantId: string, agentId: string) {
    const rt = this.runtime();
    await rt.ready();
    const pending = (await rt.store.listApprovals(tenantId, "pending"))
      .filter((a) => a.agentId === agentId)
      .sort((x, y) => x.createdAt - y.createdAt)
      .map((a) => ({
        operationId: a.operationId, taskId: a.taskId, agentId: a.agentId,
        tool: `${a.mountAlias}.${a.tool}`,
        // The gateway holds the request as { tool, args }; the tool is already
        // named above, so the card gets the arguments themselves.
        args: (a.request as any)?.args ?? a.request,
        requestedAt: new Date(a.createdAt).toISOString(),
        heldBy: `${a.mountAlias} policy`,
      }));
    const tasks = await rt.store.listTasks(tenantId, agentId);
    const running = tasks.filter((t) => t.status !== "completed" && t.status !== "failed").length;
    return { pending, tasks: { total: tasks.length, running } };
  }

  #ownerAgent(): string | null {
    const row = this.sql.exec("SELECT agent_id FROM owner WHERE k='self'").toArray()[0] as any;
    return row ? String(row.agent_id) : null;
  }

  /** The approvals panel. With a task, that task's approvals; without one,
   *  every approval the tenant has, which is what a cross-task view wants.
   *  The parameter was accepted and dropped before, so the per-task panel
   *  silently showed the tenant-wide set. */
  async uiApprovals(tenantId: string, agentId: string, taskId: string) {
    const rt = this.runtime();
    await rt.ready();
    const raw = String(taskId ?? "").trim();
    // No conversation named: everything the agent holds. One named: it must be
    // the agent's own (404 otherwise, like every other route), and held calls
    // carry the conversation as their task, the first one under the session
    // name the single-conversation object always used.
    const t = raw && raw !== "null" && raw !== "undefined" ? await this.#conversation(tenantId, agentId, raw) : "";
    const all = await rt.store.listApprovals(tenantId);
    return t ? all.filter((a) => a.taskId === t) : all;
  }

  async uiDecide(
    tenantId: string, agentId: string, taskId: string,
    operationId: string, decision: "approved" | "denied", approver: string,
  ) {
    const rt = this.runtime();
    await rt.ready();
    // The conversation is checked before anything is decided, so a foreign id
    // is refused rather than deciding first and refusing the redraw. A panel
    // that names no conversation is answered with the one the held call is in.
    let t = String(taskId ?? "").trim();
    if (!t) {
      const held = (await rt.store.listApprovals(tenantId)).find((a) => a.operationId === operationId);
      t = held?.taskId === LEGACY_TASK_ID ? `t_${agentId}` : (held?.taskId ?? `t_${agentId}`);
    }
    await this.#conversation(tenantId, agentId, t);
    taskId = t;
    await this.#busy("uiDecide", async () => {
      await rt.gateway().applyApproval(tenantId, operationId, decision, approver);
      // The decision produced a completion event; let the agent pick it up.
      await this.ctx.storage.setAlarm(Date.now());
    });
    return this.uiApprovals(tenantId, agentId, taskId);
  }

  async startTask(tenantId: string, agentId: string, taskId: string, text: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("startTask", async () => {
      const rt = this.runtime();
      await rt.provision(tenantId, agentId);
      await rt.bindOperatorModel(tenantId, agentId);
      const r = await rt.postMessage(tenantId, agentId, text);
      // Wakeup is an alarm, not a poll: nothing spins while the agent has no work.
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  async taskState(tenantId: string, agentId: string, _taskId: string) {
    this.#claim(tenantId, agentId);
    const agent = await this.runtime().agent(tenantId, agentId);
    const events = entriesToEvents(
      await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT));
    const running = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
    const last = [...events].reverse()
      .find((e) => e.kind === "model.response" && !(e.payload as any).toolCalls);
    return {
      status: running ? "running" : "idle",
      answer: running ? null : ((last?.payload as any)?.text ?? null),
      events: events.map((e) => ({
        sequence: e.sequence, kind: e.kind,
        usage: (e.payload as any)?.usage ?? undefined,
        jsStatus: (e.payload as any)?.status ?? undefined,
        ops: (e.payload as any)?.operations ?? undefined,
      })),
    };
  }

  /**
   * Client event stream. Hibernation is the point: a task that waits an hour for
   * a webhook should not hold a live object open just because a browser tab is
   * still attached.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const cursor = {
      after: Number(url.searchParams.get("after") ?? 0),
      tenantId: url.searchParams.get("tenantId") ?? "tenant-a",
      agentId: url.searchParams.get("agentId") ?? "agent-1",
    };
    (server as any).serializeAttachment(cursor);
    await this.pushTo(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    if (String(message) === "ping") ws.send(JSON.stringify({ kind: "pong" }));
  }

  /** Sends whatever a socket has not seen and advances its stored cursor. */
  async pushTo(ws: WebSocket) {
    const cur = (ws as any).deserializeAttachment() as
      | { after: number; tenantId: string; agentId: string }
      | null;
    if (!cur) return;
    // The bench object has its own runtime; readying the tenant one would build
    // a second harness over the same store and push from the wrong catalogue.
    const rt = this.#activeRuntime();
    await rt.ready();
    // Asked for by cursor rather than read whole and filtered: a projection
    // keeps the entry's own seq, so the database can do the skipping. On a long
    // conversation the old form read the entire transcript on every push, and
    // every push happens inside the object, which is billed for it.
    const events = entriesToEvents(
      await this.#entries(cur.tenantId, cur.agentId, cur.after + 1)).slice(0, 200);
    for (const e of events) {
      ws.send(JSON.stringify({ id: e.sequence, kind: e.kind, payload: e.payload }));
    }
    if (events.length) {
      (ws as any).serializeAttachment({ ...cur, after: events.at(-1)!.sequence });
    }
  }

  async broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { await this.pushTo(ws); } catch { /* a dead socket must not stall the run */ }
    }
  }

  /** Entered from SandboxTools; the sandbox can never reach this directly. */
  async sandboxCall(execId: string, strings: string[], values: unknown[]) {
    return handleSandboxCall(execId, strings, values);
  }

  /** The executor contract, unchanged, against Dynamic Workers. */
  async runExecutorSpec() {
    const t0 = Date.now();
    const exec = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      makeToolBinding: (execId) =>
        (this.ctx as any).exports.SandboxTools({
          props: { execId, doId: this.ctx.id.toString() },
        }),
    });
    const results = await executorSpec(exec);
    return { implementation: "cloudflare-dynamic-workers", ms: Date.now() - t0, results };
  }

  async armAlarm(delayMs: number) {
    this.alarmSetAt = Date.now();
    this.alarmFiredAt = null;
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    return { armedAt: this.alarmSetAt, delayMs };
  }
  /**
   * Arm the next alarm *before* doing the work, not after.
   *
   * Re-arming at the end assumes the handler reaches the end. It does not
   * always: an offloaded model call that outlives its `waitUntil` budget is
   * cancelled by the platform, and the invocation that was going to schedule
   * the next sweep dies with it. The task is then `waiting` with an unanswered
   * command, no alarm, and nothing in existence that could ever wake it — the
   * sweeper that was designed to rescue exactly this case never runs again.
   *
   * So the safety net goes up first and comes down only on a clean, idle pass.
   * A handler that keeps throwing is bounded by #alarmFailures rather than
   * retried for ever.
   */
  async alarm() {
    const failures = this.#alarmFailures();
    if (failures < 20) await this.ctx.storage.setAlarm(Date.now() + 30_000);
    try {
      await this.#busy("alarm", async () => {
        this.alarmFiredAt = Date.now();
        this.sql.exec("CREATE TABLE IF NOT EXISTS alarms(at INTEGER)");
        this.sql.exec("INSERT INTO alarms VALUES (?)", this.alarmFiredAt);
        // The object may have been evicted since the alarm was armed, so this
        // instance can be brand new: build the runtime rather than assuming it.
        const rt = this.#activeRuntime();
        // Only work that runs inside this object; the queue looks after the
        // model call, awake or not.
        // One object is one agent, so there is no sweep across tasks: the
        // object either has a run in flight or it does not.
        const who = await this.owner();
        if (!who) { await this.ctx.storage.deleteAlarm(); return; }
        const out = await rt.step(who.tenantId, who.agentId);
        // A container that could not be handed back is billed for merely
        // existing, so it is written down where diagnose can find it rather
        // than left to be noticed on an invoice.
        for (const f of out.releaseFailed ?? []) {
          this.sql.exec("CREATE TABLE IF NOT EXISTS release_errors(at INTEGER, alias TEXT, message TEXT)");
          this.sql.exec("INSERT INTO release_errors VALUES (?,?,?)", Date.now(), f.alias, f.error);
        }
        await this.broadcast();
        if (out.wakeInMs !== null) {
          // The pass said when to come back — a retry has a time, a model call
          // has a poll interval. Nothing here waits for either.
          await this.ctx.storage.setAlarm(Date.now() + Math.max(50, out.wakeInMs));
        } else {
          // Genuinely idle: stand down rather than wake every 30s for ever.
          await this.ctx.storage.deleteAlarm();
        }
      });
      this.#alarmFailures(0);
    } catch (e: any) {
      // Recorded, not swallowed: a handler failing silently is how the last
      // two stalls stayed invisible. The fallback alarm above means the next
      // pass still happens.
      this.#alarmFailures(failures + 1);
      this.sql.exec("CREATE TABLE IF NOT EXISTS alarm_errors(at INTEGER, message TEXT)");
      this.sql.exec("INSERT INTO alarm_errors VALUES (?,?)",
        Date.now(), String(e?.message ?? e).slice(0, 300));
      throw e;
    }
  }

  /** Consecutive alarm failures, so a permanently broken object stops retrying
   *  instead of waking every 30 seconds until someone notices the bill. */
  #alarmFailures(set?: number): number {
    this.sql.exec("CREATE TABLE IF NOT EXISTS counters2(k TEXT PRIMARY KEY, v INTEGER)");
    if (set !== undefined) {
      this.sql.exec("INSERT INTO counters2(k,v) VALUES ('alarmFailures',?) " +
        "ON CONFLICT(k) DO UPDATE SET v=excluded.v", set);
      return set;
    }
    const r = this.sql.exec("SELECT v FROM counters2 WHERE k='alarmFailures'").toArray()[0] as any;
    return Number(r?.v ?? 0);
  }
  async alarmStatus() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS alarms(at INTEGER)");
    const rows = [...this.sql.exec("SELECT at FROM alarms ORDER BY at DESC LIMIT 1")] as any[];
    return {
      armedAt: this.alarmSetAt, firedAt: rows[0]?.at ?? null,
      latencyMs: rows[0]?.at && this.alarmSetAt ? rows[0].at - this.alarmSetAt : null,
    };
  }

  /** Isolated: does a runaway child kill the supervisor, or only itself? */
  async verifyCpuLimit(cpuMs: number) {
    const t0 = Date.now();
    const killed = await runSandbox(this.env, `while (true) {}`, { limits: { cpuMs } });
    const afterMs = Date.now() - t0;
    // If the supervisor is still executing here, it survived the runaway child.
    const survivor = await runSandbox(this.env, `output("still alive"); return "alive";`);
    return { killed, killTookMs: afterMs, hostSurvived: survivor };
  }

  /** Dynamic Workers get a higher concurrency budget inside a DO (10 vs 4). */
  async verifySandbox() {
    const checks: Record<string, unknown> = {};
    const timed = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try { checks[name] = { ...(await fn() as object), ms: Date.now() - t }; }
      catch (e: any) { checks[name] = { threw: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t }; }
    };
    const t0 = Date.now();

    await timed("freshIsolateA", () => runSandbox(this.env, `globalThis.leaked = 42; output(typeof globalThis.leaked); return "a";`));
    await timed("freshIsolateB", () => runSandbox(this.env, `output(typeof globalThis.leaked); return "b";`));
    checks.twoLoadsMs = Date.now() - t0;

    await timed("networkBlocked", () => runSandbox(this.env, `
      const probe = {};
      try { await fetch("https://example.com"); probe.fetch = "ALLOWED"; }
      catch (e) { probe.fetch = "blocked"; }
      probe.hasConnect = typeof connect;
      output(probe); return probe;`));

    await timed("capabilityBinding", () => runSandbox(this.env, `
      const r = await env.TOOLS.invoke("echo", { repo: "example/project" });
      const bad = await env.TOOLS.invoke("slack.post", {});
      return { ok: r, rejected: bad };`,
      { tools: this.ctx.exports.ToolBinding({ props: { tenantId: "tenant-a" } }) }));

    await timed("subRequestLimit", () => runSandbox(this.env, `
      let n = 0;
      try { for (let i = 0; i < 10; i++) { await env.TOOLS.invoke("slow", {}); n++; } }
      catch (e) { return { completed: n, stopped: String(e.message || e).slice(0, 60) }; }
      return { completed: n, stopped: null };`,
      { tools: this.ctx.exports.ToolBinding({ props: {} }), limits: { subRequests: 3 } }));

    await timed("noBindingsMeansNoTools", () => runSandbox(this.env, `
      return { envKeys: Object.keys(env ?? {}), hasTools: typeof (env ?? {}).TOOLS };`));

    await timed("nodeCompatSurface", () => runSandbox(this.env, `
      const probe = { hasProcess: typeof process };
      try {
        const fs = await import("node:fs");
        probe.importedFs = Object.keys(fs).slice(0, 6);
        try { probe.readEtcPasswd = String(fs.readFileSync("/etc/passwd")).slice(0, 20); }
        catch (e) { probe.readEtcPasswd = "threw: " + String(e.message || e).slice(0, 60); }
        try { probe.readdirRoot = fs.readdirSync("/"); }
        catch (e) { probe.readdirRoot = "threw: " + String(e.message || e).slice(0, 60); }
      } catch (e) { probe.importedFs = "import refused: " + String(e.message || e).slice(0, 60); }
      try { const cp = await import("node:child_process"); probe.childProcess = Object.keys(cp).slice(0, 4); }
      catch (e) { probe.childProcess = "refused"; }
      try {
        const net = await import("node:net");
        probe.net = typeof net.Socket;
        // The real question: globalOutbound is documented to intercept connect()
        // as well as fetch(). Does the node:net path honour it?
        probe.socketConnect = await new Promise((resolve) => {
          try {
            const sock = net.connect({ host: "example.com", port: 443 });
            const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
            sock.on("connect", () => done("CONNECTED — ESCAPE"));
            sock.on("error", (e) => done("refused: " + String(e && e.message).slice(0, 50)));
            setTimeout(() => done("timeout (no connection)"), 3000);
          } catch (e) { resolve("threw: " + String(e.message || e).slice(0, 50)); }
        });
      } catch (e) { probe.net = "refused"; }
      try {
        const cp2 = await import("node:child_process");
        probe.execWorks = await new Promise((resolve) => {
          try { cp2.exec("id", (err, out) => resolve(err ? "threw: " + String(err.message).slice(0, 50) : "RAN: " + out)); }
          catch (e) { resolve("threw: " + String(e.message || e).slice(0, 50)); }
        });
      } catch (e) { probe.execWorks = "refused"; }
      try { const fs2 = await import("node:fs"); probe.bundleListing = fs2.readdirSync("/bundle").slice(0, 5); }
      catch (e) { probe.bundleListing = "refused"; }
      return probe;`));

    return checks;
  }
}

const html = (body: string) =>
  new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Set by notModified for this request, so the next poll can be answered
      // with a 304 instead of a re-render.
      // Not `etag`: Cloudflare strips that one on the way out, so a
      // conditional request could never match. Measured, not assumed — the
      // same value survives under a name the edge does not manage.
      ...(lastEtag ? { "x-ap-version": lastEtag } : {}),
    },
  });

/**
 * Who is signed in, according to Cloudflare Access.
 *
 * Access verifies the identity and passes it in a header; the app must not
 * accept an identity from anywhere the caller controls. If the header is
 * missing the deployment is unprotected, and that is worth showing on the page
 * rather than hiding behind a default.
 */
function viewer(request: Request): string | null {
  return request.headers.get("cf-access-authenticated-user-email");
}

/**
 * The demo drives a real agent against the operator's own model account, so an
 * open endpoint is an open cheque. It fails closed: without an Access identity
 * the UI refuses, unless the deployment has explicitly said otherwise. A demo
 * that quietly spends money is worse than no demo.
 */
/**
 * 304 for a panel whose task has not moved.
 *
 * htmx swaps only on a 2xx, so a 304 leaves the DOM alone: an unchanged panel
 * costs one small query instead of rendering a megabyte and re-parsing it in
 * the browser every couple of seconds.
 *
 * The version travels in a header of our own rather than `ETag` /
 * `If-None-Match`, because Cloudflare strips `ETag` on the way out and the
 * condition could then never match. That was found by sending both and seeing
 * which arrived.
 */
async function notModified(
  request: Request,
  stub: { uiVersion(t: string, a: string, k: string): Promise<string> },
  agentId: string,
  taskId: string,
): Promise<Response | null> {
  if (!taskId || taskId === "null" || taskId === "undefined") return null;
  const etag = await stub.uiVersion("demo", agentId, taskId);
  if (request.headers.get("x-ap-version") === etag) {
    return new Response(null, { status: 304, headers: { "x-ap-version": etag } });
  }
  // Stashed for the response below; the routes set it via the html() helper.
  lastEtag = etag;
  return null;
}

/** Set by notModified for the response that follows it. Single-threaded per
 *  request in a Worker, so this cannot interleave. */
let lastEtag: string | null = null;

/** One identity, one agent. Was repeated at every route that needed it. */
/** A form body, or null: a POST with no body or the wrong content type is a
 *  bad request, not a crash. `formData()` throws on both. */
async function formOf(request: Request): Promise<FormData | null> {
  try { return await request.formData(); } catch { return null; }
}

/** Console routes that write. Add a route here when it writes, whether it
 *  arms the object (message, decide, compact) or changes what the agent is
 *  authorised as (credential, credential/remove). */
// What a held call in the first conversation is recorded under (runtime.ts LEGACY_TASK).
const LEGACY_TASK_ID = MAIN_SESSION;
const UI_WRITE_ROUTES = new Set(["/ui/message", "/ui/decide", "/ui/compact", "/ui/credential", "/ui/credential/remove", "/ui/agent"]);

/**
 * What a person may name an agent. Checked in the route before any object is
 * touched, so a refusal costs nothing and leaves nothing behind.
 */
function agentSpec(form: FormData, ownerAgentId: string): { agentId: string; name: string; description: string; avatar: string; createdAt: number } | string {
  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (!name) return "an agent needs a name";
  if (name.length > 60) return "a name is at most 60 characters";
  if (description.length > 2000) return "a description is at most 2000 characters";
  const given = String(form.get("avatar") ?? "");
  const avatar = /^[0-9a-f]{8}$/i.test(given) ? given.toLowerCase() : mintAvatar();
  return { agentId: `${ownerAgentId}_${Date.now().toString(36)}`, name, description, avatar, createdAt: Date.now() };
}

/** Eight hex characters, enough for a page to draw a stable face from. */
function mintAvatar(): string {
  const b = new Uint8Array(4); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * A name for an agent nobody named: two words, chosen by the id's hash, so
 * the same object is called the same thing on every visit. The lists are
 * small on purpose; a name is a handle, not a personality.
 */
const NAME_FIRST = ["Quiet", "Amber", "Brisk", "Cedar", "Dusky", "Early", "Frank", "Gentle", "Hollow", "Ivory", "Jolly", "Keen", "Lunar", "Mossy", "Noble", "Olive", "Plain", "Rustic", "Silver", "Tidy", "Umber", "Vivid", "Windy", "Young"];
const NAME_SECOND = ["Heron", "Otter", "Falcon", "Badger", "Cricket", "Dolphin", "Elk", "Finch", "Gecko", "Hare", "Ibis", "Jay", "Koala", "Lark", "Marten", "Newt", "Osprey", "Puffin", "Quail", "Raven", "Seal", "Tern", "Vole", "Wren"];
function nameFor(agentId: string): string {
  const h = parseInt(avatarFor(agentId), 16);
  return `${NAME_FIRST[h % NAME_FIRST.length]} ${NAME_SECOND[(h >>> 8) % NAME_SECOND.length]}`;
}

/** The first agent had no seed minted for it; derive one from its id so it draws the same every time. */
function avatarFor(agentId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) { h ^= agentId.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function uiAgent(who: string): string {
  return `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
}

function requireViewer(request: Request, env: Env): { who: string } | Response {
  const who = viewer(request);
  if (who) return { who };
  // A named automation identity, so the page stays testable after it has been
  // closed to anonymous traffic. It is still an identity: it signs approvals
  // under its own name, and it is not something a visitor can present.
  if (env.AUTOMATION_TOKEN && request.headers.get("x-harness-token") === env.AUTOMATION_TOKEN) {
    return { who: "automation" };
  }
  if (env.UI_ALLOW_ANONYMOUS === "1") return { who: "anonymous (UNPROTECTED)" };
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>antiproton</title>` +
    `<body style="font:14px ui-monospace,monospace;background:#0f1115;color:#d8dee9;padding:40px;max-width:44em">` +
    `<h1 style="font-size:16px">not signed in</h1>` +
    `<p>This page drives a real agent against the operator's model account, so it will not` +
    ` run without an identity. Reach it through the Cloudflare Access–protected hostname,` +
    ` or set <code>UI_ALLOW_ANONYMOUS=1</code> on the Worker to open it deliberately.</p>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Guards the endpoints that spend the operator's model account.
 *
 * Access protects the custom hostname, but the workers.dev address bypasses it
 * entirely, and several routes there start a real agent. Either a Cloudflare
 * identity or the automation secret is required; anything else is refused. The
 * diagnostics (conformance, isolation, eviction) stay open because they call no
 * provider and cost nothing.
 */
function guardSpending(request: Request, env: Env): Response | null {
  if (viewer(request)) return null;
  const supplied = request.headers.get("x-harness-token");
  if (env.AUTOMATION_TOKEN && supplied === env.AUTOMATION_TOKEN) return null;
  return Response.json(
    { error: "this endpoint starts a real agent; sign in through Access or present x-harness-token" },
    { status: 401 },
  );
}

/** Stable serialisation so two databases compare by value, not key order.
 *  Must match bench/tau2/run.ts's `canon`, or the two runners disagree. */
function canonJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonJson((v as any)[k])}`).join(",")}}`;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where does the wall clock actually go, measured from the edge? */
async function latency(env: Env) {
  const time = async (label: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    try { await fn(); return [label, Date.now() - t] as const; }
    catch (e: any) { return [label, `error: ${String(e?.message ?? e).slice(0, 60)}`] as const; }
  };
  const small = new Uint8Array(200).fill(65);
  const big = new Uint8Array(1024 * 1024).fill(66);
  const results = await Promise.all([]);
  void results;
  const out: Record<string, unknown> = {};
  for (const r of [
    await time("r2.put 200B", () => env.ARTIFACTS.put("bench/small.bin", small)),
    await time("r2.get 200B", () => env.ARTIFACTS.get("bench/small.bin").then((o) => o?.arrayBuffer())),
    await time("r2.put 1MB", () => env.ARTIFACTS.put("bench/big.bin", big)),
    await time("r2.get 1MB", () => env.ARTIFACTS.get("bench/big.bin").then((o) => o?.arrayBuffer())),
    await time("fetch api.github.com", () => fetch("https://api.github.com/repos/nodejs/node", { headers: { "user-agent": "antiproton/0.1" } }).then((r) => r.text())),
    await time("fetch api.deepseek.com (unauth RTT)", () => fetch("https://api.deepseek.com/models").then((r) => r.text())),
  ]) out[r[0]] = r[1];
  return out;
}

export default {
  /** Where a model call is actually waited on; see runQueuedModelCall. */
  async queue(batch: MessageBatch<QueuedModelCall>, env: Env) {
    for (const message of batch.messages) {
      if (batch.queue.endsWith("-dlq")) {
        await failLoudly(message.body, env);
        message.ack();
        continue;
      }
      try {
        await runQueuedModelCall(message.body, env);
        message.ack();
      } catch (e) {
        // Deliberately not acked: the queue redelivers, and after max_retries
        // the message lands in the dead letter queue, where it becomes a
        // visible failure on the task rather than a silence.
        console.error("model call failed", String((e as Error)?.message ?? e));
        message.retry();
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Conformance gets its own object: the P0 probe created an incompatible
    // `tasks` table in "p0", and CREATE TABLE IF NOT EXISTS silently accepted it.
    // Each benchmark arm gets its own object. Sharing one meant asynchronous
    // stragglers from an earlier run — dispatcher callbacks, re-armed alarms —
    // landed in the next arm's measurement window. A fresh object per arm makes
    // cross-talk impossible instead of merely unlikely.
    // Agent traffic is addressed by identity; probes and the benchmark keep
    // their own fixed objects.
    let name: string;
    let uiSelected: { who: string; home: string; agentId: string } | null = null;
    if (url.pathname.startsWith("/conformance")) name = "conformance-v2";
    else if (url.pathname.startsWith("/bench")) name = `bench-${url.searchParams.get("obj") ?? "v1"}`;
    else if (url.pathname.startsWith("/ui")) {
      // One demo agent per signed-in person, so two people trying it at once
      // do not share a conversation — and so the isolation is real, not a demo
      // shortcut.
      const gate = requireViewer(request, env);
      if (gate instanceof Response) return gate;
      const who = gate.who;
      // The anonymous switch opens the page to look at, not to act on. Every
      // route in the set writes. Three of them, message, decide and compact,
      // also arm the object's alarm and would run a turn that fails without a
      // key; the two credential routes arm nothing and succeed regardless,
      // because they only touch the store, and they change what the agent is
      // authorised as. The second pair is the one the refusal exists for.
      if (who.startsWith("anonymous") && UI_WRITE_ROUTES.has(url.pathname)) {
        return new Response("read-only: the console is open to anonymous viewers, but not for writes", { status: 403 });
      }
      // Which of the person's agents. The identity names their first one;
      // any other must be in that first object's directory, or it is 404,
      // reads and writes alike, so "not yours" and "does not exist" look the
      // same from outside.
      const home = uiAgent(who);
      const peek = request.method === "POST" ? await formOf(request.clone()) : null;
      const asked = String(url.searchParams.get("agentId") ?? peek?.get("agentId") ?? "").trim();
      const agentId = asked || home;
      if (agentId !== home) {
        const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName("demo", home)));
        if (!(await homeStub.uiOwnsAgent("demo", home, agentId))) {
          return Response.json({ error: `no such agent: ${agentId} (not this viewer's, or never created)` }, { status: 404 });
        }
      }
      uiSelected = { who, home, agentId };
      try {
        name = agentObjectName("demo", agentId);
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
      }
    } else if (url.pathname.startsWith("/agent")) {
      const body = request.method === "POST" ? await request.clone().json().catch(() => ({})) : {};
      const tenantId = String((body as any).tenantId ?? url.searchParams.get("tenantId") ?? "tenant-a");
      const agentId = String((body as any).agentId ?? url.searchParams.get("agentId") ?? "agent-1");
      try {
        name = agentObjectName(tenantId, agentId);
      } catch (e: any) {
        return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
      }
    } else name = "p0";
    const stub = env.AGENT.get(env.AGENT.idFromName(name));
    try {
      switch (url.pathname) {
        case "/storage": return Response.json(await stub.verifyStorage());
        case "/conformance/executor": return Response.json(await stub.runExecutorSpec());
        case "/agent/message": {
          const g = guardSpending(request, env);
          if (g) return g;
          const body = (await request.json()) as any;
          await stub.setOffload(String(body.offload ?? "1") !== "0");
          return Response.json(await stub.startTask(
            body.tenantId ?? "tenant-a", body.agentId ?? "agent-1",
            body.taskId ?? `task_${crypto.randomUUID().slice(0, 8)}`, String(body.text),
          ));
        }
        case "/agent/events":
        // The same stream, addressed to the benchmark's object. A benchmark
        // that polls measures the poller: every poll is a request that wakes
        // the object, and the deployed console does not poll — it is pushed to
        // over a hibernatable socket, which costs the object nothing while it
        // waits. Measuring the shipped path means using the shipped path.
        case "/bench/events":
          return stub.fetch(request);
        case "/agent/state":
          return Response.json(await stub.taskState(
            url.searchParams.get("tenantId") ?? "tenant-a",
            url.searchParams.get("agentId") ?? "agent-1",
            String(url.searchParams.get("taskId")),
          ));
        case "/bench/basedb": {
          await env.ARTIFACTS.put("bench/tau2-db.json", request.body!);
          return Response.json({ ok: true });
        }
        case "/bench/start": {
          const g = guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchStart(String(b.taskId), String(b.policy ?? ""), b.offload !== false));
        }
        case "/bench/say": {
          const g = guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSay(String(b.taskId), String(b.text)));
        }
        case "/bench/poll":
          return Response.json(await stub.benchPoll(String(url.searchParams.get("taskId"))));
        // SWE-bench inside the object. Start and shell spend money (a model
        // account, a metered machine), so they sit behind the same guard as
        // the τ² endpoints; stats only reads.
        case "/bench/swe/start": {
          const g = guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSweStart(String(b.taskId), b));
        }
        case "/bench/swe/shell": {
          const g = guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSweShell(String(b.taskId), String(b.command)));
        }
        case "/bench/swe/release": {
          const g = guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSweRelease(String(b.taskId)));
        }
        case "/bench/swe/stats":
          return Response.json(await stub.benchSweStats(
            String(url.searchParams.get("taskId")), Number(url.searchParams.get("wallMs") ?? 0)));
        case "/bench/activity":
          return Response.json(await stub.activity(Number(url.searchParams.get("since") ?? 0)));
        case "/bench/activity/reset": return Response.json(await stub.resetActivity());
        case "/bench/diag":
          return Response.json(await stub.benchDiag());
        case "/bench/purge":
          return Response.json(await stub.benchPurge());
        case "/bench/debug":
          return Response.json(await stub.benchDebug(String(url.searchParams.get("taskId"))));
        case "/bench/trajectory":
          return Response.json(await stub.benchTrajectory(String(url.searchParams.get("taskId"))));
        case "/bench/result":
          return Response.json(await stub.benchResult(String(url.searchParams.get("taskId"))));
        case "/agent/activity":
          return Response.json(await stub.activity(Number(url.searchParams.get("since") ?? 0)));
        case "/agent/activity/reset": return Response.json(await stub.resetActivity());
        case "/model-binding": {
          // Whether an agent can run at all now depends on a binding existing.
          const stub3 = env.AGENT.get(env.AGENT.idFromName(agentObjectName("tenant-nokey", "agent-1")));
          const out: Record<string, unknown> = {};
          try {
            await stub3.startTask("tenant-nokey", "agent-1", `nk_${Date.now()}`, "hello");
            // startTask binds explicitly, so clear it and try to advance.
            out.provisionedWithBinding = true;
          } catch (e: any) {
            out.provisionedWithBinding = false;
            out.error = String(e?.message ?? e).slice(0, 160);
          }
          out.binding = await stub3.modelBinding("tenant-nokey", "agent-1");
          out.unboundTenant = await stub3.modelBinding("tenant-never-configured", "agent-1");
          return Response.json(out);
        }
        case "/eviction": {
          // Configuration set before an eviction must still be in force after
          // it, without the caller restating anything.
          const stub2 = env.AGENT.get(env.AGENT.idFromName(agentObjectName("tenant-evict", "agent-1")));
          const out: Record<string, unknown> = {};
          await stub2.startTask("tenant-evict", "agent-1", `ev_${Date.now()}`, "hello");
          await stub2.setOffload(false);
          out.before = { offload: (await stub2.setOffload(false)).offload, owner: await stub2.owner() };

          await stub2.simulateEviction();

          out.after = { offload: (await stub2.readOffload()), owner: await stub2.owner() };
          out.offloadSurvived = (out.after as any).offload === false;
          out.ownerSurvived =
            JSON.stringify((out.before as any).owner) === JSON.stringify((out.after as any).owner);
          // And the object still refuses a foreign identity after being rebuilt.
          try {
            await stub2.startTask("tenant-other", "agent-1", "ev_x", "wrong tenant");
            out.guardSurvived = false;
          } catch { out.guardSurvived = true; }
          return Response.json(out);
        }
        // Confirms what Access actually injects, rather than trusting the
        // header name. Also demonstrates that a client-supplied identity does
        // not survive: Cloudflare strips cf-access-* from inbound requests.
        case "/admin/compact": {
          // The operator's way in, alongside /admin/diagnose. The UI button
          // derives the agent from whoever is signed in, which is right for a
          // person and useless for unsticking someone else's task.
          if (env.AUTOMATION_TOKEN && request.headers.get("x-harness-token") !== env.AUTOMATION_TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          const t = url.searchParams.get("tenantId") ?? "demo";
          const a = String(url.searchParams.get("agentId"));
          const k = url.searchParams.get("taskId") ?? `t_${a}`;
          const s2 = env.AGENT.get(env.AGENT.idFromName(agentObjectName(t, a)));
          return Response.json(await s2.uiCompact(t, a, k));
        }
        case "/admin/diagnose": {
          if (env.AUTOMATION_TOKEN && request.headers.get("x-harness-token") !== env.AUTOMATION_TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          const t = url.searchParams.get("tenantId") ?? "demo";
          const a = String(url.searchParams.get("agentId"));
          const k = url.searchParams.get("taskId") ?? `t_${a}`;
          const s2 = env.AGENT.get(env.AGENT.idFromName(agentObjectName(t, a)));
          return Response.json(await s2.diagnose(t, a, k));
        }
        case "/ui/whoami":
          return Response.json({
            viewer: viewer(request),
            anonymousAllowed: env.UI_ALLOW_ANONYMOUS === "1",
            cfHeaders: Object.fromEntries(
              [...request.headers].filter(([k]) => k.startsWith("cf-")),
            ),
          });
        case "/ui": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? uiAgent(who);
          const taskId = url.searchParams.get("taskId") ?? `t_${agentId}`;
          await stub.uiEnsure("demo", agentId, taskId);
          return new Response(page(taskId, who, agentId), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        case "/ui/transcript": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? uiAgent(who);
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const unchanged = await notModified(request, stub, agentId, taskId);
          if (unchanged) return unchanged;
          const tail = url.searchParams.get("all") === "1" ? 0 : 120;
          const t = await stub.uiTranscript("demo", agentId, taskId, tail);
          return html(
            (t.total > t.shown
              ? `<div class="hint" style="padding:0 0 8px">Showing the last ${t.shown} of
                 ${t.total} events. <a href="?taskId=${encodeURIComponent(taskId)}&all=1"
                 hx-get="/ui/transcript?taskId=${encodeURIComponent(taskId)}&all=1" hx-target="#panel"
                 hx-swap="innerHTML" style="color:var(--accent);cursor:pointer">show all</a>
                 — a long conversation renders to megabytes, and the page re-reads it
                 every few seconds.</div>`
              : "") +
            `<h3>where the time went</h3>${timeline(t.events)}` +
            `<h3>prompt cache, per model call</h3>${tokens(t.events)}` +
            `<h3>trajectory</h3>${trajectory(t.events, t.byOp, t.busy)}`);
        }
        case "/ui/chat":
        case "/ui/events": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const unchanged = await notModified(request, stub, agentId, taskId);
          if (unchanged) return unchanged;
          const tail = url.searchParams.get("all") === "1" ? 0 : 120;
          const t = await stub.uiTranscript("demo", agentId, taskId, tail);
          return html(url.pathname === "/ui/chat"
            // The conversation alone; everything else about the run is in the
            // panels on the right.
            ? trajectory(conversation(t.events), t.byOp, t.busy)
            : eventList(t.events));
        }
        case "/ui/plugins": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          // One read, dispatched to the part the shell asked for: the mount
          // list, one mount's block, the catalogue, or the whole page.
          const d = await stub.uiPlugins("demo", agentId);
          switch (url.searchParams.get("part")) {
            case "mounts": return html(mountList(d));
            case "mount": return html(mountFragment(d, String(url.searchParams.get("alias") ?? "").trim()));
            case "catalogue": return html(catalogue(d));
            default: return html(plugins(d));
          }
        }
        case "/ui/credential": {
          // A value comes in; a re-rendered mount block goes out, and nothing
          // else does: not the value, not on success, not on failure.
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const alias = String(form.get("alias") ?? "").trim();
          const fields: Record<string, string> = {};
          for (const [k, v] of form.entries()) if (k !== "alias" && typeof v === "string") fields[k] = v;
          const r = alias ? await stub.uiAttachCredential("demo", agentId, alias, fields) : { ok: false as const, error: "no mount named" };
          const d: any = await stub.uiPlugins("demo", agentId);
          if (!r.ok) for (const m of d.mounts ?? []) if (m.alias === alias && m.credential) m.credential.error = r.error;
          return html(mountFragment(d, alias));
        }
        case "/ui/credential/remove": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const alias = String(form.get("alias") ?? "").trim();
          if (alias) await stub.uiRemoveCredential("demo", agentId, alias);
          return html(mountFragment(await stub.uiPlugins("demo", agentId), alias));
        }
        case "/ui/storage":
        case "/ui/memory":
        case "/ui/sandbox":
        case "/ui/runtime": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const unchanged = await notModified(request, stub, agentId, taskId);
          if (unchanged) return unchanged;
          const d = await stub.uiStorage("demo", agentId, taskId);
          return html(url.pathname === "/ui/storage" ? storage(d)
            : url.pathname === "/ui/memory" ? memoryPanel(d)
            : url.pathname === "/ui/sandbox" ? sandboxPanel(d)
            : runtimePanel(d));
        }
        // Data routes for the console shell, rendered by the shell's own
        // renderers with `d`, the way /ui/plugins does. `viewer` is the
        // identity the gate resolved.
        case "/ui/agent": {
          // The only way an agent id comes to exist for a person. Order
          // matters: the new object adopts the record first, since that is
          // where its harness reads the persona from; the directory in the
          // person's first object records it last, so a failure between the
          // two leaves an unlisted object rather than a listed one with no
          // persona. Both calls are idempotent.
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          if (request.method !== "POST") return new Response("POST", { status: 405 });
          if (gate.who.startsWith("anonymous")) return new Response("read-only", { status: 403 });
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const home = uiAgent(gate.who);
          const made = agentSpec(form, home);
          if (typeof made === "string") return new Response(made, { status: 400 });
          const own = env.AGENT.get(env.AGENT.idFromName(agentObjectName("demo", made.agentId)));
          await own.uiAdoptAgent("demo", made.agentId, made);
          const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName("demo", home)));
          await homeStub.uiRecordAgent("demo", home, made);
          return Response.json(made);
        }
        case "/ui/agents": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const home = uiAgent(gate.who);
          const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName("demo", home)));
          const agents = (await homeStub.uiListAgents("demo", home))
            .map((a) => ({ ...a, current: a.agentId === (uiSelected?.agentId ?? home) }));
          // The page swaps the rendered list in; anything else gets the data.
          return request.headers.get("hx-request") ? html(agentList({ agents })) : Response.json({ agents });
        }
        case "/ui/inbox": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const d = await stub.uiInbox("demo", uiSelected?.agentId ?? uiAgent(gate.who));
          return html(inbox({ viewer: gate.who, ...d }));
        }
        case "/ui/approvals": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          return html(approvals(await stub.uiApprovals("demo", uiSelected?.agentId ?? uiAgent(gate.who), taskId)));
        }
        case "/ui/message": {
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? uiAgent(who);
          const taskId = String(form.get("taskId") ?? "") || `t_${agentId}`;
          const text = String(form.get("text") ?? "").trim();
          const mode = String(form.get("mode")) === "followUp" ? "followUp" as const : "steer" as const;
          if (text) await stub.uiSay("demo", agentId, taskId, text, mode);
          const t = await stub.uiTranscript("demo", agentId, taskId);
          return html(trajectory(t.events, t.byOp, t.busy));
        }
        case "/ui/compact": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? uiAgent(gate.who);
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const taskId = String(form.get("taskId") ?? "") || `t_${agentId}`;
          await stub.uiCompact("demo", agentId, taskId);
          const t = await stub.uiTranscript("demo", agentId, taskId);
          return html(trajectory(conversation(t.events), t.byOp, t.busy));
        }
        case "/ui/decide": {
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? uiAgent(who);
          const decision = String(form.get("decision")) === "approved" ? "approved" : "denied";
          // The panel that posted names its conversation; an older page that
          // does not is the first one. Either way it is the viewer's own or 404.
          const taskId = String(form.get("taskId") ?? "").trim();
          // The approver is whoever Access says is signed in — an audit record
          // with a name the caller chose would be worth nothing.
          return html(approvals(await stub.uiDecide("demo", agentId, taskId, String(form.get("operationId")), decision, who)));
        }
        case "/isolation": {
          // Proves the property rather than asserting it: two tenants, two
          // objects, and an object that refuses an identity that is not its own.
          const out: Record<string, unknown> = {};
          const nameA = agentObjectName("tenant-a", "agent-1");
          const nameB = agentObjectName("tenant-b", "agent-1");
          out.distinctNames = nameA !== nameB;
          const idA = env.AGENT.idFromName(nameA);
          const idB = env.AGENT.idFromName(nameB);
          out.distinctObjects = idA.toString() !== idB.toString();

          const a = env.AGENT.get(idA);
          const b = env.AGENT.get(idB);
          await a.startTask("tenant-a", "agent-1", `iso_a_${Date.now()}`, "hello from a");
          await b.startTask("tenant-b", "agent-1", `iso_b_${Date.now()}`, "hello from b");
          out.ownerA = await a.owner();
          out.ownerB = await b.owner();

          // Same agent id, different tenant: the object must refuse.
          try {
            await a.startTask("tenant-b", "agent-1", "iso_x", "wrong tenant");
            out.crossTenantRefused = false;
          } catch (e: any) {
            out.crossTenantRefused = true;
            out.refusal = String(e?.message ?? e).slice(0, 160);
          }
          // Each object's storage holds only its own tenant's rows.
          out.tasksA = (await a.listTenants());
          out.tasksB = (await b.listTenants());
          return Response.json(out);
        }
        case "/latency": return Response.json({ colo: request.cf?.colo ?? null, ...(await latency(env)) });
        case "/sandbox": return Response.json(await stub.verifySandbox());
        case "/sandbox/cpu": return Response.json(await stub.verifyCpuLimit(Number(url.searchParams.get("ms") ?? 50)));
        case "/alarm/arm": return Response.json(await stub.armAlarm(Number(url.searchParams.get("ms") ?? 2000)));
        case "/alarm/status": return Response.json(await stub.alarmStatus());
        case "/":
          // The demo is the point of this deployment; making people know to
          // type /ui is a papercut with no upside.
          return Response.redirect(new URL("/ui", url).toString(), 302);
        default:
          return Response.json({
            demo: "/ui",
            diagnostics: ["/conformance/kernel", "/conformance/executor", "/isolation",
                          "/eviction", "/model-binding", "/ui/whoami"],
            probes: ["/storage", "/sandbox", "/latency", "/alarm/status"],
          }, { status: 404 });
      }
    } catch (e: any) {
      // A conversation the viewer may not address is a 404 for reads and
      // writes alike, not a fault.
      if (/^no such conversation:/.test(String(e?.message ?? ""))) {
        return Response.json({ error: String(e.message) }, { status: 404 });
      }
      return Response.json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 600) }, { status: 500 });
    }
  },
};
