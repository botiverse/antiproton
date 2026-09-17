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
import { html, conditional, holds, notModified } from "./version.ts";
import type { Json } from "../../src/core/types.ts";
import { bearerKey, hashApiKey, newApiKey } from "./agents-api/keys.ts";
import { handleAgentsApi, type AgentsApiDeps } from "./agents-api/handlers.ts";
import { apiAgentSeeds } from "./agents-api/provisioning.ts";
import { watchChanges } from "./agents-api/watch.ts";
import { openAIError, type StoredAgent, type StoredSession } from "./agents-api/shapes.ts";
import {
  apiAgentIds, deleteApiAgent, deleteApiSession, getApiAgent, getApiSession, listApiAgents, listApiSessions,
  mintAgentId, mintSessionId, putApiAgent, putApiSession,
} from "./agents-api/store.ts";
import { maskRawRefs } from "../../src/store/refs.ts";
import { chatPanel } from "./chat.ts";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { secretRefKind } from "../../src/runtime/secrets.ts";
import { DynamicWorkerExecutor, handleSandboxCall } from "../../src/runtime/dynamic-worker-executor.ts";
import { executorSpec } from "../../test/spec/executor-spec.ts";
import {
  AgentRuntime, OPERATOR_RUN9_REF, OPERATOR_SECRET_REF, parsePluginChoice,
} from "./runtime.ts";
import { readMeter } from "../../bench/meter.ts";
import { contextWindowFor } from "../../src/model/context-windows.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { toRequest, fromResponse, errorMessage } from "../../src/model/pi-bridge.ts";
import { entriesToEvents } from "./pi-view.ts";
import { recentBackgroundJobs } from "../../src/runtime/background-jobs.ts";
import { ensureAgentTables, failedRuns } from "../../src/runtime/pi-agent.ts";
import { MAIN_SESSION, piTables } from "../../src/store/pi-storage.ts";
import { validateMount } from "../../src/runtime/mount-config.ts";
import { pluginEnabled } from "../../src/plugins/types.ts";

/** What the plugins page is handed about each mount; declared and checked in cf/src/mount-reports.ts. */
import type { MountReports } from "./mount-reports.ts";
export type { MountReports };
import { qualifyMountedTools } from "../../src/runtime/pi-tools.ts";
import { BenchState } from "./bench.ts";
import {
  resolveViewer,
  programmaticAccess,
  seal, open, randomToken, readCookie, cookieHeader, clearCookieHeader, sessionCookieFor,
  constantTimeEqual, SESSION_COOKIE, LOGIN_COOKIE, LOGIN_TTL_MS, QA_VIEWER,
  type Viewer, type LoginState, type RefusalReason, type GithubConfig,
  githubAuthorizeUrl, githubExchangeCode, githubFetchProfile, githubIdentityKey, githubViewer, githubDefaultAgentId, githubDefaultTenantId,
} from "./auth.ts";
import { adminTranscript } from "./admin-transcript.ts";
import { refuseSecret } from "./secret-shape.ts";
import { adminDiagnose } from "./admin-diagnose.ts";
import { readDiagnosis } from "./diagnose-read.ts";
import { agentObjectName } from "./object-name.ts";
import { readTranscript, transcriptEvents, approvalsByOp, type TranscriptEvents } from "./transcript-read.ts";
import { loginPage, refusedPage, keyPage } from "./login.ts";
import { d1ApiKeys, admit, d1Identities, type IdentityDirectory } from "./control-plane.ts";
import { staticAsset } from "./static.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import {
  page, trajectory, approvals, conversation, eventList, storage, memoryPanel, sandboxPanel,
  runtimePanel, timeline, tokens, plugins, mountFragment, mountList, catalogue, agentList, apiKeysPanel } from "./ui.ts";

/** The inspector's runtime tab: the object, then its containers. Storage is a
 *  developer dump, not an answer the page owes by default (Nova's Inspector
 *  review, 2026-09-17): it stays one fold away. */
const runtimeStack = (d: any) =>
  `<h3>the object</h3>${runtimePanel(d)}<h3>containers</h3>${sandboxPanel(d)}` +
  `<details class="raw"><summary>storage — everything the object is holding</summary>${storage(d)}</details>`;

export interface Env {
  AGENT: DurableObjectNamespace<AgentDO>;
  /** The control plane (cf/src/control-plane.ts): who may sign in, and as which
   *  tenant and agent. Never agent data, which stays in each agent's object. */
  CONTROL_DB: D1Database;
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
  /** "1" opens the demo UI with no identity at all. Off by default. */
  UI_ALLOW_ANONYMOUS?: string;
  /** The canonical origin, so the registered callback URL is built from a
   *  constant and never from an inbound Host header. */
  /** Login with GitHub: the OAuth App tygg owns, callback /login/github/callback. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** "1" lets a GitHub account not on the identity table register itself
   *  on first sign-in (tygg, 2026-09-12: 可以放开了). Absent: refused. */
  GITHUB_OPEN_SIGNUP?: string;
  /** The container lease (src/runtime/idle-lease.ts): idle minutes before a box
   *  is released unless its agent postpones it, and how many minutes before
   *  that the agent is told. Both set, the warning shorter than the idle time:
   *  leased. Otherwise containers are handed back after every pass. */
  RUN9_WARN_MINUTES?: string;
  RUN9_MAX_IDLE_MINUTES?: string;
  UI_ORIGIN?: string;
  /** The commit this Worker was built from, set per deploy by
   *  cf/scripts/deploy.sh (`--var GIT_COMMIT:<sha>`); whoami shows it, and
   *  the bench drivers write it into every record. A record that names its
   *  object and time but not its code cannot be compared with another. */
  GIT_COMMIT?: string;
  /** Seals the session cookie. Without it nobody can be signed in. */
  SESSION_SECRET?: string;
  /** A long key that mints a QA session for a browser. Not shown to anyone;
   *  a distinct identity from AUTOMATION_TOKEN, and must differ from it. */
  QA_ACCESS_KEY?: string;
  /** Lets automation reach the endpoints that spend money, since a script
   *  cannot sign in through a browser. */
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

export { agentObjectName };

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
  /** Seed changes the reconcile declined, by alias, for the plugins page.
   *  Derived state, not stored: every page open re-runs the reconcile, so an
   *  evicted object rebuilds it on the next visit, and a later success clears it. */
  #reconcileRefused = new Map<string, { at: string; reason: string }>();
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
      // Both numbers or neither: without them a container is handed back after
      // the pass that stops using it. With them it is leased — kept, its agent
      // told shortly before the release and free to postpone it, and taken at
      // the release time. They are prices, not preferences (a reminder costs a model
      // turn, a box costs seconds), so the operator sets them.
      idle: Number(this.env.RUN9_WARN_MINUTES) > 0
          && Number(this.env.RUN9_MAX_IDLE_MINUTES) > Number(this.env.RUN9_WARN_MINUTES)
        ? {
            warnMs: Number(this.env.RUN9_WARN_MINUTES) * 60_000,
            maxMs: Number(this.env.RUN9_MAX_IDLE_MINUTES) * 60_000,
          }
        : undefined,
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
  /**
   * /admin/diagnose's report, read from this object's SQL and the store's plain readers only
   * (cf/src/diagnose-read.ts). It used to open the agent and render through uiTranscript, which ran the
   * store's migrations, re-pinned mounts, created the default conversation and tables (Ada and Vera, #336).
   * The runtime is constructed only to name its plugins: its constructor builds objects in memory and runs no
   * SQL; it is never readied here (Ada, #347). Null for an agent or conversation this object does not hold.
   */
  async diagnose(tenantId: string, agentId: string, taskId: string) {
    return readDiagnosis(this.sql, tenantId, agentId, taskId, {
      store: new DurableObjectStore(this.ctx as any),
      plugins: this.#activeRuntime().plugins(),
      alarm: () => this.ctx.storage.getAlarm(),
    });
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
        // Production seeds this, and without it a result over the offload
        // threshold is truncated rather than parked: the benchmark would be
        // measuring an agent that loses large tool output, which production
        // agents do not (2026-09-12).
        { alias: "artifacts", plugin: "artifacts", account: "builtin" },
      ]);
      // The machine, from the instance's own image. Config is per mount, so a
      // different repository is a different mount record, not different code.
      await rt.store.addMount({
        tenantId: "bench", agentId, alias: "sandbox", plugin: "sandbox",
        installationId: "inst-node", connectionId: null,
        toolVersion: rt.pluginVersion("sandbox") ?? "1.0.0",
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
    const meter = await readMeter(rt.store as any, "bench", agentId, ["sandbox"], wallMs, {
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

  // ---- OpenAI-compatible agents API (task #17) -------------------------------
  // Keys are control-plane data and live in D1 (cf/src/control-plane.ts d1ApiKeys).

  // The owner's object indexes the agents and sessions its key created.
  // An agent's tools carry JSON Schema (recursive Json), which the RPC stub types
  // expand without bound; agents therefore cross the object boundary as JSON text.
  async apiPutAgent(tenantId: string, ownerAgentId: string, id: string, agentJson: string) { this.#claim(tenantId, ownerAgentId); putApiAgent(this.sql, id, JSON.parse(agentJson) as StoredAgent); }
  async apiGetAgent(tenantId: string, ownerAgentId: string, id: string): Promise<string | null> { this.#claim(tenantId, ownerAgentId); const a = getApiAgent(this.sql, id); return a ? JSON.stringify(a) : null; }
  async apiListAgents(tenantId: string, ownerAgentId: string): Promise<string> { this.#claim(tenantId, ownerAgentId); return JSON.stringify(listApiAgents(this.sql)); }
  async apiDeleteAgent(tenantId: string, ownerAgentId: string, id: string) { this.#claim(tenantId, ownerAgentId); return deleteApiAgent(this.sql, id); }
  async apiPutSession(tenantId: string, ownerAgentId: string, sess: StoredSession) { this.#claim(tenantId, ownerAgentId); putApiSession(this.sql, sess); }
  async apiGetSession(tenantId: string, ownerAgentId: string, id: string) { this.#claim(tenantId, ownerAgentId); return getApiSession(this.sql, id); }
  async apiListSessions(tenantId: string, ownerAgentId: string, agentId: string | null) { this.#claim(tenantId, ownerAgentId); return listApiSessions(this.sql, agentId); }
  async apiDeleteSession(tenantId: string, ownerAgentId: string, id: string) { this.#claim(tenantId, ownerAgentId); return deleteApiSession(this.sql, id); }

  /** The persona the harness reads: the API's name and instructions, with the full config kept beside them. */
  #apiPersona(agentId: string, a: StoredAgent, avatar: string) {
    return { name: a.name ?? nameFor(agentId), description: a.instructions ?? "", avatar, openai: a } as unknown as Json;
  }

  /**
   * Run in the agent's own object: make it match the API's record of the agent (the owner's index,
   * which is written first). Created when absent; the persona rewritten only when it differs, so the
   * calls that repeat this on every use write nothing once it matches. Returns what the console lists.
   */
  async apiAdopt(tenantId: string, agentId: string, agentJson: string) {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    return this.#adopt(rt, tenantId, agentId, JSON.parse(agentJson) as StoredAgent);
  }

  async #adopt(rt: AgentRuntime, tenantId: string, agentId: string, a: StoredAgent) {
    const existing = await rt.store.loadAgent(tenantId, agentId);
    const config = existing?.config as any;
    const avatar = String(config?.avatar ?? mintAvatar());
    if (!existing) await rt.store.createAgent(tenantId, agentId, this.#apiPersona(agentId, a, avatar));
    else if (JSON.stringify(config?.openai) !== JSON.stringify(a)) await rt.store.updateAgentConfig(tenantId, agentId, this.#apiPersona(agentId, a, avatar));
    return { name: a.name ?? nameFor(agentId), description: a.instructions ?? "", avatar };
  }

  /** A session is a conversation in this agent's object; the task row is what #conversation accepts. Adopts first. */
  async apiOpenSession(tenantId: string, agentId: string, agentJson: string, sessionId: string) {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    const made = await this.#adopt(rt, tenantId, agentId, JSON.parse(agentJson) as StoredAgent);
    await this.#openTask(rt, tenantId, agentId, sessionId);
    return made;
  }

  async #openTask(rt: AgentRuntime, tenantId: string, agentId: string, sessionId: string) {
    if (!(await rt.store.loadTask(tenantId, sessionId))) await rt.store.createTask(tenantId, agentId, sessionId, {});
  }

  /**
   * Text into the session, the way startTask does it for the main conversation. The agent and the
   * session are opened first, so input repairs an object a failed create or update left behind.
   */
  async apiPostInput(tenantId: string, agentId: string, agentJson: string, sessionId: string, text: string, environment: "none" | "container" = "none") {
    this.#claim(tenantId, agentId);
    return this.#busy("apiPostInput", async () => {
      const rt = this.runtime();
      await rt.ready();
      const made = await this.#adopt(rt, tenantId, agentId, JSON.parse(agentJson) as StoredAgent);
      await this.#openTask(rt, tenantId, agentId, sessionId);
      // Not the console's default mounts: an API agent has what its caller declared (agents-api/provisioning.ts).
      await rt.provision(tenantId, agentId, apiAgentSeeds(AgentRuntime.DEFAULT_MOUNTS, environment));
      await rt.bindOperatorModel(tenantId, agentId);
      await rt.postMessage(tenantId, agentId, text, "prompt", sessionId);
      await this.ctx.storage.setAlarm(Date.now());
      // The turn is on record now: say so, rather than leaving it for the step that follows.
      await this.broadcast();
      return { ok: true as const, made };
    });
  }

  /** Cancel a session's running turn and its background work (Agents API input.cancel). */
  async apiCancelSession(tenantId: string, agentId: string, sessionId: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("apiCancelSession", async () => {
      const rt = this.runtime();
      await rt.ready();
      // Never bound means never run: there is nothing to cancel (see apiSessionStatus).
      if (!(await rt.store.getModelBinding(tenantId, agentId))) {
        return { cancelledTurn: null as string | null, stoppedJobs: [] as string[], stillRunning: [] as string[] };
      }
      const out = await rt.cancelSession(tenantId, agentId, sessionId);
      await this.ctx.storage.setAlarm(Date.now());
      await this.broadcast();
      return out;
    });
  }

  /** The session's entries and whether its lane runs now, as JSON text (see apiGetAgent on RPC types). */
  async apiTranscript(tenantId: string, agentId: string, sessionId: string): Promise<string> {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    if (!(await rt.store.getModelBinding(tenantId, agentId))) return JSON.stringify({ entries: [], running: false, pending: [] });
    const agent = await rt.agent(tenantId, agentId, sessionId);
    // The branch, not every entry: resuming a paused call leaves its placeholder result on the branch it left.
    const entries = await rt.branchEntries(tenantId, agentId, sessionId);
    const running = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
    const pending = running ? [] : await rt.waitingClientCalls(tenantId, agentId, sessionId);
    return JSON.stringify({ entries, running, pending });
  }

  async apiSessionStatus(tenantId: string, agentId: string, sessionId: string): Promise<{
    status: "idle" | "in_progress" | "requires_action";
    pending: Array<{ call_id: string; name: string; arguments: string; turn_id: string }>;
  }> {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    // An agent is bound to a model when its first turn starts (apiPostInput), and
    // the harness cannot be built without one — so an agent that has never run is
    // idle by construction, and asking the harness would only throw (preview probe,
    // 2026-09-14: "no model binding" on a fresh session).
    if (!(await rt.store.getModelBinding(tenantId, agentId))) return { status: "idle", pending: [] };
    const agent = await rt.agent(tenantId, agentId, sessionId);
    if ((await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null) return { status: "in_progress", pending: [] };
    const pending = await rt.waitingClientCalls(tenantId, agentId, sessionId);
    return { status: pending.length ? "requires_action" : "idle", pending };
  }

  /** An API caller's function results; the turn continues on the alarm this sets (runtime.submitToolResults). */
  async apiToolResults(
    tenantId: string, agentId: string, sessionId: string,
    results: Array<{ turnId: string; callId: string; output: string; isError: boolean }>,
  ): Promise<{ unknown: string[] }> {
    this.#claim(tenantId, agentId);
    return this.#busy("apiToolResults", async () => {
      const rt = this.runtime();
      await rt.ready();
      if (!(await rt.store.getModelBinding(tenantId, agentId))) return { unknown: results.map((r) => r.callId) };
      const out = await rt.submitToolResults(tenantId, agentId, sessionId, results);
      if (!out.unknown.length) { await this.ctx.storage.setAlarm(Date.now()); await this.broadcast(); }
      return out;
    });
  }

  async uiListAgents(tenantId: string, ownerAgentId: string) {
    this.#claim(tenantId, ownerAgentId);
    this.#directory();
    // An agent deleted through the API is gone here too (its object is kept, as for every agent);
    // one the API made, with a key of this person's, is marked so the list can say so.
    const api = apiAgentIds(this.sql);
    const rows = (this.sql.exec("SELECT * FROM owned_agents ORDER BY created_at DESC").toArray() as any[])
      .filter((r) => !api.deleted.has(String(r.agent_id)));
    const owned = rows.map((r) => ({
      agentId: String(r.agent_id), name: String(r.name), description: String(r.description),
      avatar: String(r.avatar), createdAt: Number(r.created_at), api: api.live.has(String(r.agent_id)),
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
    if (apiAgentIds(this.sql).deleted.has(agentId)) return false;
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
      // One add path for both routes in: provision adds what is missing and
      // validates each seed as it goes. What the console adds on top is the
      // reconcile below, for a mount that exists but no longer matches.
      await rt.provision(tenantId, agentId, desired);
      const byId = new Map(rt.plugins().map((p) => [p.id, p]));
      for (const d of desired) {
        const config = d.config ?? { account: d.account };
        const have = await rt.store.getMountByAlias(tenantId, agentId, d.alias);
        if (!have) continue;
        if (JSON.stringify(have.publicConfig) !== JSON.stringify(config)) {
          // The third write path, checked like the other two. Provision
          // validates a seed as it adds it; attaching a credential re-validates
          // with the ref about to be set (#140); this is the config changing
          // under a credential that is already there, so the check runs with
          // the ref that stayed. A seed that would leave the mount in a state
          // the runtime forbids — a credential and no host allowlist — is not
          // applied: the mount keeps the config it had, which the page shows
          // as fine because it is. So the refusal itself is logged; otherwise
          // "refused" and "nothing to do" would be the same observable, and
          // the only way to learn the seed and the mount disagree would be to
          // notice the config never changed.
          const plugin = byId.get(d.plugin);
          const problems = plugin ? validateMount(plugin, config as any, have.secretRef) : [];
          if (problems.length) {
            const reason = problems.map((x) => x.message).join("; ");
            console.warn(`reconcile refused for ${agentId}/${d.alias}: ${reason}`);
            this.#reconcileRefused.set(d.alias, { at: new Date().toISOString(), reason });
          } else {
            await rt.store.updateMountConfig(tenantId, agentId, d.alias, config);
            this.#reconcileRefused.delete(d.alias);
          }
        } else {
          this.#reconcileRefused.delete(d.alias);
        }
        if (JSON.stringify(have.policy ?? null) !== JSON.stringify(d.policy ?? null)) {
          await rt.store.updateMountPolicy(tenantId, agentId, d.alias, d.policy ?? null);
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
      // What each mount says about itself, rather than what the page can infer
      // from the JSON in `connections`. The sandbox panel used to read a run9
      // box id, its exec count and its saved refs straight out of that blob,
      // which is one plugin's private shape sitting in a page — the last of the
      // reach-ins Piper's audit found. Asked of every mount that answers, so
      // the page never learns which plugins have containers.
      //
      // `billing` is a sentence and not a number on purpose: "billed for every
      // second it exists" is true of a container and false of an API key, and
      // only the plugin knows which it is. A console composing that line would
      // have to know too.
      // A sandbox mount lists the files its boxes kept, and entries saved
      // before references changed shape still name the bucket, tenant and agent
      // (6 objects across 4 agents). This panel is shown to a person; the
      // operator's diagnose keeps raw references on purpose.
      mountReports: JSON.parse(maskRawRefs(
        JSON.stringify(await this.#mountReports(rt, tenantId, agentId, taskId)), { tenantId, agentId })),
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
    // The tools column means "what the agent can call", so the names come from
    // the same function that names them for the model, over the whole catalogue
    // at once: the tie-break at the length cap is a property of the set, and a
    // per-mount join would print a name that exists nowhere.
    const named = qualifyMountedTools(mounts.flatMap((m) =>
      (byId.get(m.plugin)?.tools ?? []).map((t) => ({ name: t.name, address: `${m.alias}.${t.name}` })),
    ));

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

    // What this agent has said, and only that: a plugin it never spoke about
    // has no entry, which is `inherit`. The page needs both halves — the
    // answer and the default it would fall back to — because "inherit" and
    // "off" look identical on a control unless the page can say which way the
    // inheritance currently goes.
    const choices = await rt.store.pluginChoices(tenantId, agentId);
    return {
      installed: installed.map((p) => ({
        id: p.id,
        version: p.version,
        defaultForAllAgents: p.defaultForAllAgents === true,
        choice: choices[p.id] ?? "inherit",
        // Resolved here rather than in the page, so the rule stays in the one
        // function that states it. A page that recomputes it is a second copy
        // that can disagree with what the gateway does.
        enabled: pluginEnabled(p, choices[p.id]),
        credential: p.credential ?? null,
        config: p.config ?? [],
        tools: p.tools.map((t) => ({
          name: t.name, summary: t.summary,
          sideEffects: t.sideEffects, idempotency: t.idempotency,
        })),
      })),
      // The column means "what the agent can call", so the names come from the
      // same function that names them for the model, over the whole catalogue
      // at once: the tie-break at the length cap is a property of the set, and
      // a per-mount join would print a name that exists nowhere.
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
          // A switched-off mount is still here, with its account and its
          // session: the tools are withheld and the gateway refuses, and
          // switching back on returns everything. So the page marks it rather
          // than dropping it — a row that vanishes reads as a bug, and this
          // one is deliberately not a deletion.
          enabled: plugin ? pluginEnabled(plugin, choices[m.plugin]) : true,
          config: m.publicConfig ?? {},
          session: conn ? { expiresAt: (conn as any).expiresAt ?? null } : null,
          // Attached, verified, account, last four, dates. Never a value.
          credential: await rt.credentialMeta(tenantId, agentId, m),
          // Why a seed change did not reach this mount, when it did not. The
          // mount itself is fine, which is exactly why nothing else shows it.
          reconcileRefused: this.#reconcileRefused.get(m.alias) ?? null,
          problems: plugin
            ? validateMount(plugin, m.publicConfig as any, m.secretRef).map((x) => x.message)
            : [`no plugin named ${m.plugin} is installed`],
          tools: named.filter((n) => n.address.startsWith(`${m.alias}.`)).map((n) => n.name),
        };
      })),
      used,
    };
  }

  /**
   * Every mount's own answer about what it is running and what it has finished.
   *
   * One pass over the mounts, asked through the gateway — the only place that
   * builds a plugin context. A mount whose plugin answers neither question
   * simply is not in the map, so a page iterating it gets exactly the mounts
   * that have something to say.
   *
   * `usage` is deliberately included here and not on the alarm's path: history
   * is read when a person opens a page, and the sweep that runs on a timer must
   * not pay for it.
   */
  async #mountReports(
    rt: AgentRuntime, tenantId: string, agentId: string, taskId: string,
  ): Promise<MountReports> {
    const gw = rt.gateway();
    const out: MountReports = {};
    for (const m of await rt.store.listMounts(tenantId, agentId)) {
      try {
        const [activity, usage] = await Promise.all([
          gw.mountActivity({ tenantId, agentId, taskId }, m.alias),
          gw.mountUsage({ tenantId, agentId, taskId }, m.alias),
        ]);
        // Nothing running and nothing finished is not a report; leaving it out
        // keeps the page's own emptiness check honest.
        if (activity?.live || (usage as unknown[]).length) out[m.alias] = { activity, usage };
      } catch {
        // One mount that cannot answer must not blank the panel for the rest.
      }
    }
    return out;
  }

  /** The console attaches a credential to one of this agent's mounts. The
   *  value arrives here once, is sealed, and is never read back by anything
   *  the console can call. */
  async uiAttachCredential(tenantId: string, agentId: string, alias: string, fields: Record<string, string>) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiAttachCredential", () => this.runtime().attachCredential(tenantId, agentId, alias, fields));
  }

  /**
   * One agent's answer about one plugin, from the console.
   *
   * `"inherit"` is passed through rather than filtered out here: the store
   * turns it into the absence of a row, which is what inheriting means, and a
   * caller that had to know that would be the second place the rule lives.
   */
  async uiSetPluginChoice(tenantId: string, agentId: string, plugin: string, choice: string) {
    this.#claim(tenantId, agentId);
    const parsed = parsePluginChoice(choice);
    if (!parsed) return { ok: false as const, error: `not a choice: ${choice}` };
    const rt = this.runtime();
    await rt.ready();
    if (!rt.plugins().some((p) => p.id === plugin)) {
      return { ok: false as const, error: `no plugin named ${plugin} is installed` };
    }
    await this.#busy("uiSetPluginChoice", () => rt.store.setPluginChoice(tenantId, agentId, plugin, parsed));
    return { ok: true as const };
  }

  /** Rename one mount. Refused while it is holding something; see the runtime. */
  async uiRenameMount(tenantId: string, agentId: string, from: string, to: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiRenameMount", () => this.runtime().renameMount(tenantId, agentId, from, to));
  }

  async uiRemoveCredential(tenantId: string, agentId: string, alias: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiRemoveCredential", () => this.runtime().removeCredential(tenantId, agentId, alias));
  }

  /** Hand a container back now. Refused while a job is running on that mount;
   *  the runtime says why, and the page shows it. */
  async uiReleaseSandbox(tenantId: string, agentId: string, alias: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiReleaseSandbox", () => this.runtime().releaseMount(tenantId, agentId, alias));
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
    // Held calls and their decisions move the conversation too: the chat is
    // about to carry the held cards beside the turns, and a decision is
    // otherwise invisible to a version built from entries alone. Before the
    // store has made its tables there are no approvals to count.
    let held = "0";
    try {
      const a = this.sql.exec(
        "SELECT COUNT(*) AS n, MAX(created_at) AS c, MAX(decided_at) AS d FROM approvals WHERE tenant_id = ? AND agent_id = ?",
        tenantId, agentId).toArray()[0] as any;
      held = `${a?.n ?? 0}.${a?.c ?? 0}.${a?.d ?? 0}`;
    } catch { /* no approvals table yet */ }
    return `${row?.s ?? 0}.${row?.n ?? 0}.${jobs?.n ?? 0}.${held}`;
  }

  async uiTranscript(tenantId: string, agentId: string, taskId: string, tail = 0): Promise<UiTranscript> {
    const session = await this.#conversation(tenantId, agentId, taskId);
    const rt = this.runtime();
    const agent = await rt.agent(tenantId, agentId, session);
    const shown = transcriptEvents(
      await agent.storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT), this.sql, session, { tenantId, agentId }, tail);
    const running = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
    const pendingApproval = (await rt.store.listApprovals(tenantId, "pending")).length > 0;
    const busy: UiTranscript["busy"] = pendingApproval ? "waiting-for-approval" : running ? "thinking" : null;
    return { ...shown, byOp: approvalsByOp(await rt.store.listApprovals(tenantId)), busy };
  }

  /**
   * uiTranscript for an operator (/admin/transcript), read straight from this object's SQLite and nothing
   * else (cf/src/transcript-read.ts). Opening the agent re-pins its mounts and reconciles its session, and the
   * store's init runs migrations; a GET that can name anyone must do neither (Ada, #336). Null for an agent or
   * conversation this object does not hold.
   */
  async adminTranscript(tenantId: string, agentId: string, taskId: string): Promise<TranscriptEvents | null> {
    return readTranscript(this.sql, tenantId, agentId, taskId);
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
      // An answer can quote a reference it was given before they changed shape.
      answer: running ? null : (((last?.payload as any)?.text ?? null) === null
        ? null : maskRawRefs(String((last!.payload as any).text), { tenantId, agentId })),
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
    // A change notice socket for the agents API's event stream (agents-api/watch.ts): told only that something
    // changed, never sent the transcript, so a push costs this object one small send.
    if (url.searchParams.get("kind") === "notify") {
      (server as any).serializeAttachment({ notify: true });
      return new Response(null, { status: 101, webSocket: client });
    }
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
    if ((cur as any).notify) { ws.send('{"kind":"changed"}'); return; }
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
      ws.send(maskRawRefs(JSON.stringify({ id: e.sequence, kind: e.kind, payload: e.payload }),
        { tenantId: cur.tenantId, agentId: cur.agentId }));
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


/**
 * Who is signed in. The one place identity is decided; see auth.ts.
 *
 * A session this Worker sealed, or the automation token. The app must not
 * accept an identity from anywhere the caller controls, and nothing else on a
 * request is one: only something this Worker signed.
 */
const viewerMemo = new WeakMap<Request, Promise<Viewer | null>>();
async function viewer(request: Request, env: Env, allowAnonymous = false): Promise<Viewer | null> {
  let p = viewerMemo.get(request);
  if (!p) { p = resolveViewer(request, env); viewerMemo.set(request, p); }
  const v = await p;
  if (v || !allowAnonymous) return v;
  return resolveViewer(request, env, { allowAnonymous: true });
}

function githubConfig(env: Env): GithubConfig | null {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.UI_ORIGIN || !env.SESSION_SECRET) return null;
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET, redirectUri: `${env.UI_ORIGIN}/login/github/callback` };
}

/** The identity table, in the control plane (cf/src/control-plane.ts). */
function identities(env: Env): IdentityDirectory {
  return d1Identities(env.CONTROL_DB);
}

/** A refusal the browser sees as a page and a CLI sees as typed JSON. */
function refuse(request: Request, reason: RefusalReason, hint: string, status = 403): Response {
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
    return new Response(null, { status: 302, headers: { location: `/login/refused?reason=${encodeURIComponent(reason)}` } });
  }
  return Response.json({ error: reason.toUpperCase().replace(/-/g, "_"), hint }, { status });
}

const REFUSALS: Record<string, string> = {
  "not-invited": "This GitHub account is not on this deployment's list. Ask the operator to add it.",
  state: "The sign-in did not start here, or took longer than ten minutes. Start again.",
  exchange: "The sign-in provider did not accept the code. Start again.",
  unconfigured: "This sign-in is not configured on this deployment.",
  unavailable: "The list of who may sign in did not answer. Try again shortly; signed-in sessions are not affected.",
};

/**
 * The sign-in routes. None of them touches an agent object, so they run
 * before one is chosen. Returns null for any other path.
 */
async function handleLogin(request: Request, env: Env, url: URL): Promise<Response | null> {
  const method = request.method;
  switch (url.pathname) {
    case "/login": {
      if (await viewer(request, env)) return Response.redirect(new URL("/ui", url).toString(), 302);
      return html(loginPage({ open: env.GITHUB_OPEN_SIGNUP === "1" }));
    }
    case "/login/refused": {
      const reason = url.searchParams.get("reason") ?? "";
      return new Response(refusedPage(reason), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    case "/login/github": {
      const cfg = githubConfig(env);
      if (!cfg) return refuse(request, "unconfigured", REFUSALS.unconfigured, 503);
      const now = Date.now();
      // The state alone binds the callback to this browser (GitHub's flow has
      // no nonce or PKCE verifier).
      const st: LoginState = { state: randomToken(), returnTo: "/ui", iat: now, exp: now + LOGIN_TTL_MS };
      return new Response(null, {
        status: 302,
        headers: {
          location: githubAuthorizeUrl(cfg, st.state),
          "set-cookie": cookieHeader(LOGIN_COOKIE, await seal(env.SESSION_SECRET!, st), LOGIN_TTL_MS / 1000, "/login/github"),
        },
      });
    }
    case "/login/github/callback": {
      const cfg = githubConfig(env);
      if (!cfg) return refuse(request, "unconfigured", REFUSALS.unconfigured, 503);
      const st = await open<LoginState>(env.SESSION_SECRET!, readCookie(request, LOGIN_COOKIE));
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!st || !state || !code || !constantTimeEqual(state, st.state)) {
        return refuse(request, "state", REFUSALS.state, 400);
      }
      let profile, emails;
      try {
        const token = await githubExchangeCode(cfg, code);
        ({ profile, emails } = await githubFetchProfile(token));
      } catch (e: any) {
        console.error("login: github exchange failed", String(e?.message ?? e));
        return refuse(request, "exchange", REFUSALS.exchange, 502);
      }
      // The id is the identity; the control plane says whether it owns an agent
      // here. No row, no entry: the console is one operator's, and a GitHub
      // account is not an invitation. Open sign-up writes the first row itself:
      // the agent is a new one (default mounts, empty memory) in a tenant of its
      // own (quota and data per person), never an existing person's, and an
      // operator's row always wins (control-plane.ts admit).
      const key = githubIdentityKey(profile);
      const admission = await admit(identities(env), key, {
        openSignup: env.GITHUB_OPEN_SIGNUP === "1",
        derive: () => ({ agentId: githubDefaultAgentId(profile), tenantId: githubDefaultTenantId(profile) }),
      });
      if (!admission.ok && admission.reason === "unavailable") {
        console.error(`login: ${key} (${profile.login}) could not be checked against the control plane: ${admission.error}`);
        return refuse(request, "unavailable", REFUSALS.unavailable, 503);
      }
      if (!admission.ok) {
        console.warn(`login: ${key} (${profile.login}) is not on the identity table`);
        return refuse(request, "not-invited", REFUSALS["not-invited"]);
      }
      const row = admission.row;
      if (admission.registered) console.log(`login: ${key} (${profile.login}) registered as ${row.tenantId}/${row.agentId}`);
      const headers = new Headers({ location: new URL(st.returnTo, url).toString() });
      headers.append("set-cookie", await sessionCookieFor(env.SESSION_SECRET!, githubViewer(profile, emails, row.agentId, row.tenantId), key));
      headers.append("set-cookie", clearCookieHeader(LOGIN_COOKIE, "/login/github"));
      return new Response(null, { status: 302, headers });
    }
    case "/login/key": {
      // The QA identity: a browser session minted from a long key that is
      // shown to nobody. Its own identity, so audit tells it apart from
      // automation, and it never reaches /admin, which stays header-only.
      // No link leads here; the page itself wears the door's clothes (login.ts).
      if (method !== "POST") return html(keyPage());
      if (!env.SESSION_SECRET || !env.QA_ACCESS_KEY) return refuse(request, "unconfigured", REFUSALS.unconfigured, 503);
      // Two secrets that happen to be equal would let this key reach the
      // admin routes through the other door; refuse rather than assume.
      if (env.AUTOMATION_TOKEN && constantTimeEqual(env.QA_ACCESS_KEY, env.AUTOMATION_TOKEN)) {
        return Response.json({ error: "MISCONFIGURED", hint: "QA_ACCESS_KEY must differ from AUTOMATION_TOKEN" }, { status: 500 });
      }
      const form = await formOf(request);
      const key = String(form?.get("key") ?? "");
      if (!key || !constantTimeEqual(key, env.QA_ACCESS_KEY)) {
        // A browser gets the form back with the reason; a script gets JSON.
        if ((request.headers.get("accept") ?? "").includes("text/html")) {
          return new Response(keyPage("the key does not match"), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return Response.json({ error: "BAD_KEY", hint: "the key does not match" }, { status: 401 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/ui", url).toString(), "set-cookie": await sessionCookieFor(env.SESSION_SECRET, QA_VIEWER, "qa") },
      });
    }
    case "/ui/whoami": {
      // The probe: what identity this request actually resolves to, and the
      // configuration facts no branch would otherwise show. It answers anyone,
      // ahead of the gate, because "nobody" is the reading a forged session
      // must produce, and a refusal would hide it.
      const v = await viewer(request, env);
      return Response.json({
        viewer: v ? { email: v.email, name: v.name, source: v.source, agentId: agentOf(v), tenantId: tenantOf(v) } : null,
        build: env.GIT_COMMIT ?? null,
        anonymousAllowed: env.UI_ALLOW_ANONYMOUS === "1",
        loginConfigured: githubConfig(env) !== null,
        qaKeyDistinct: !(env.QA_ACCESS_KEY && env.AUTOMATION_TOKEN && env.QA_ACCESS_KEY === env.AUTOMATION_TOKEN),
      });
    }
    case "/logout": {
      if (method !== "POST") return Response.json({ error: "METHOD", hint: "POST to sign out" }, { status: 405 });
      return new Response(null, { status: 302, headers: { location: new URL("/login", url).toString(), "set-cookie": clearCookieHeader(SESSION_COOKIE) } });
    }
    default:
      return null;
  }
}

/**
 * The demo drives a real agent against the operator's own model account, so an
 * open endpoint is an open cheque. It fails closed: without a signed-in identity
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
async function versionOf(
  request: Request,
  stub: { uiVersion(t: string, a: string, k: string): Promise<string> },
  tenantId: string,
  agentId: string,
  taskId: string,
): Promise<{ unchanged: Response | null; etag: string | null }> {
  if (!taskId || taskId === "null" || taskId === "undefined") return { unchanged: null, etag: null };
  const etag = await stub.uiVersion(tenantId, agentId, taskId);
  // The version rides with the route's own response, passed explicitly: a
  // module-level stash was written after an await, so under two overlapping
  // requests one route's response could carry the other's version. Never a
  // wrong 304 (the comparison is always against a fresh value), just a
  // meaningless header and an extra 200.
  return { unchanged: holds(request, etag) ? notModified(etag) : null, etag };
}

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
const UI_WRITE_ROUTES = new Set(["/ui/message", "/ui/decide", "/ui/compact", "/ui/credential", "/ui/credential/remove", "/ui/agent", "/ui/api-keys/new", "/ui/api-keys/revoke", "/ui/sandbox/release"]);

/**
 * What a person may name an agent. Checked in the route before any object is
 * touched, so a refusal costs nothing and leaves nothing behind.
 */
/**
 * `/admin/api-keys` (automation token only): issue a key for an owner. The key
 * is in this one response and nowhere else; the table keeps its hash.
 */
async function adminApiKeys(request: Request, env: Env): Promise<Response> {
  if (!env.AUTOMATION_TOKEN || request.headers.get("x-harness-token") !== env.AUTOMATION_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") return Response.json({ error: "POST" }, { status: 405 });
  const b = (await request.json().catch(() => null)) as any;
  const tenantId = String(b?.tenantId ?? ""), ownerAgentId = String(b?.ownerAgentId ?? ""), label = String(b?.label ?? "");
  try { agentObjectName(tenantId, ownerAgentId); } catch (e: any) { return Response.json({ error: String(e?.message ?? e) }, { status: 400 }); }
  const key = newApiKey();
  await d1ApiKeys(env.CONTROL_DB).issue({ hash: await hashApiKey(key), tenantId, ownerAgentId, label });
  return Response.json({ key, tenantId, ownerAgentId, label });
}

/** `/v1/...`: the OpenAI-compatible agents API (task #17), authenticated by a Bearer key. */
async function v1(request: Request, env: Env, url: URL): Promise<Response> {
  const key = bearerKey(request);
  if (!key) return openAIError(401, "Missing or malformed API key. Send Authorization: Bearer <key>.", { code: "invalid_api_key" });
  const row = await d1ApiKeys(env.CONTROL_DB).lookup(await hashApiKey(key));
  if (!row) return openAIError(401, "Incorrect API key provided.", { code: "invalid_api_key" });
  const { tenantId, ownerAgentId } = row;
  const owner = env.AGENT.get(env.AGENT.idFromName(agentObjectName(tenantId, ownerAgentId)));
  const agentStub = (agentId: string) => env.AGENT.get(env.AGENT.idFromName(agentObjectName(tenantId, agentId)));
  let body: unknown = undefined;
  if (request.method === "POST") {
    const text = await request.text();
    if (text) {
      try { body = JSON.parse(text); }
      catch { return openAIError(400, "We could not parse the JSON body of your request.", { code: "invalid_json" }); }
    } else body = {};
  }
  // Listed in the owner's directory too, so the console shows what the API made. Idempotent.
  const listInConsole = async (agentId: string, a: StoredAgent, made: { name: string; description: string; avatar: string }) => {
    await owner.uiRecordAgent(tenantId, ownerAgentId, { agentId, ...made, createdAt: a.createdAt });
  };
  const deps: AgentsApiDeps = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // The agent's object pushes after every change; the stream reads when it hears (agents-api/watch.ts).
    watch: async (agentId) => {
      try { agentObjectName(tenantId, agentId); } catch { return null; }
      const res = await agentStub(agentId).fetch("https://agent.internal/events?kind=notify", { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) return null;
      ws.accept();
      return watchChanges(ws as any);
    },
    mintAgentId: () => mintAgentId(ownerAgentId),
    mintSessionId,
    index: {
      putAgent: async (id, a) => { await owner.apiPutAgent(tenantId, ownerAgentId, id, JSON.stringify(a)); },
      getAgent: async (id) => {
        try { agentObjectName(tenantId, id); } catch { return null; }
        const text = await owner.apiGetAgent(tenantId, ownerAgentId, id);
        return text ? (JSON.parse(text) as StoredAgent) : null;
      },
      listAgents: async () => JSON.parse(await owner.apiListAgents(tenantId, ownerAgentId)) as Array<{ id: string; agent: StoredAgent }>,
      deleteAgent: (id) => owner.apiDeleteAgent(tenantId, ownerAgentId, id),
      putSession: async (sess) => { await owner.apiPutSession(tenantId, ownerAgentId, sess); },
      getSession: (id) => owner.apiGetSession(tenantId, ownerAgentId, id),
      listSessions: (agentId) => owner.apiListSessions(tenantId, ownerAgentId, agentId ?? null),
      deleteSession: (id) => owner.apiDeleteSession(tenantId, ownerAgentId, id),
    },
    agents: {
      adopt: async (agentId, a) => {
        await listInConsole(agentId, a, await agentStub(agentId).apiAdopt(tenantId, agentId, JSON.stringify(a)));
      },
      openSession: async (agentId, a, sessionId) => {
        await listInConsole(agentId, a, await agentStub(agentId).apiOpenSession(tenantId, agentId, JSON.stringify(a), sessionId));
      },
      postInput: async (agentId, a, sessionId, text, environment) => {
        const posted = await agentStub(agentId).apiPostInput(tenantId, agentId, JSON.stringify(a), sessionId, text, environment);
        // The input is delivered: a failure to list it now must not read as undelivered, and invite a resend.
        await listInConsole(agentId, a, posted.made).catch(() => undefined);
      },
      status: (agentId, sessionId) => agentStub(agentId).apiSessionStatus(tenantId, agentId, sessionId),
      cancel: async (agentId, sessionId) => { await agentStub(agentId).apiCancelSession(tenantId, agentId, sessionId); },
      toolResults: (agentId, sessionId, results) => agentStub(agentId).apiToolResults(tenantId, agentId, sessionId, results),
      transcript: async (agentId, sessionId) =>
        JSON.parse(await agentStub(agentId).apiTranscript(tenantId, agentId, sessionId)) as {
          entries: unknown[]; running: boolean; pending: Array<{ call_id: string; name: string; arguments: string; turn_id: string }>;
        },
    },
  };
  try {
    const res = await handleAgentsApi(request.method, url.pathname.slice("/v1".length), url.searchParams, body, deps);
    return res ?? openAIError(404, `${request.method} ${url.pathname} is not supported by this deployment`, { code: "not_found" });
  } catch (e: any) {
    return openAIError(500, String(e?.message ?? e).slice(0, 300), { type: "server_error" });
  }
}

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

/**
 * What the transcript route answers, said concretely. The shape used to be
 * inferred, and it carried \`Json\` (declared as \`unknown\`), which the Workers
 * RPC types cannot classify as serialisable; across the object boundary the
 * whole result collapsed to \`never\` and four call sites lost their checking.
 * The object's own call was never affected, which is how it stayed hidden.
 */
export interface UiTranscript {
  total: number;
  shown: number;
  // The two opaque fields are `any` on purpose. `unknown` is what the RPC
  // rule cannot place. A recursive JSON type is not blocked by the compiler:
  // Piper measured it on 8d83185 and it raises 20 signatures, one "too deep"
  // here and nineteen ordinary assignability errors in plugin and API return
  // types that are structurally JSON but declared loosely (`unknown[]`,
  // `Fleet`, http responses). So `any` is the honest type until those
  // declarations are tightened, which is plugin work, not a limit. Both
  // fields were already read through `as any` by every consumer.
  events: Array<{ sequence: number; kind: string; payload: any; createdAt: number }>;
  byOp: Record<string, { state: string; approver: string | null; tool: string; request: any }>;
  busy: "thinking" | "waiting-for-approval" | null;
}

function uiAgent(who: string): string {
  return `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
}

/** The agent a viewer owns: the one the identity table resolved at sign-in
 *  (GitHub), else the one derived from the email (everything older). */
function agentOf(v: Viewer): string {
  return v.agentId ?? uiAgent(v.email);
}

/** The tenant a viewer's agents live in: their own when the identity table
 *  says so (self-registered GitHub accounts), else the original "demo". */
function tenantOf(v: Viewer): string {
  return v.tenantId ?? "demo";
}

async function requireViewer(request: Request, env: Env): Promise<{ who: string; agentId: string; tenantId: string; viewer: Viewer } | Response> {
  // The anonymous switch opens the page to look at; the write routes refuse
  // that identity by name further down.
  const v = await viewer(request, env, true);
  if (v) return { who: v.email, agentId: agentOf(v), tenantId: tenantOf(v), viewer: v };
  // A page navigation goes to the sign-in page; a fragment request tells htmx
  // to take the whole window there; anything else gets the plain refusal.
  if (request.headers.get("hx-request")) {
    return Response.json({ error: "NOT_SIGNED_IN", hint: "sign in at /login" }, { status: 401, headers: { "hx-redirect": "/login" } });
  }
  if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }
  return Response.json({ error: "NOT_SIGNED_IN", hint: "sign in at /login, or present x-harness-token" }, { status: 401 });
}

/**
 * Guards the endpoints that spend the operator's model account.
 *
 * Every hostname reaches this Worker, and several routes start a real agent.
 * A signed-in identity or the automation secret is required; anything else is
 * refused, and the anonymous switch does not open this door. The
 * diagnostics (conformance, isolation, eviction) stay open because they call no
 * provider and cost nothing.
 */
async function guardSpending(request: Request, env: Env): Promise<Response | null> {
  // Never anonymous here, whatever the deployment says: this path spends.
  if (await viewer(request, env)) return null;
  return Response.json(
    { error: "this endpoint starts a real agent; sign in at /login or present x-harness-token" },
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
    // The page's own script and font, public and immutable; the sign-in
    // page needs them before anyone is signed in.
    const asset = staticAsset(url.pathname);
    if (asset) return asset;
    const login = await handleLogin(request, env, url);
    if (login) return login;
    // The OpenAI-compatible agents API and its key issuance answer before any
    // object is chosen: they authenticate differently and address by key.
    if (url.pathname === "/admin/api-keys") return adminApiKeys(request, env);
    if (url.pathname.startsWith("/v1/")) return v1(request, env, url);
    // Conformance gets its own object: the P0 probe created an incompatible
    // `tasks` table in "p0", and CREATE TABLE IF NOT EXISTS silently accepted it.
    // Each benchmark arm gets its own object. Sharing one meant asynchronous
    // stragglers from an earlier run — dispatcher callbacks, re-armed alarms —
    // landed in the next arm's measurement window. A fresh object per arm makes
    // cross-talk impossible instead of merely unlikely.
    // Agent traffic is addressed by identity; probes and the benchmark keep
    // their own fixed objects.
    let name: string;
    let uiSelected: { who: string; home: string; agentId: string; tenantId: string } | null = null;
    if (url.pathname.startsWith("/conformance")) name = "conformance-v2";
    else if (url.pathname.startsWith("/bench")) {
      // The benchmark runners' door, and only theirs (see programmaticAccess).
      if (programmaticAccess(await viewer(request, env), "bench", { tenantId: "bench", agentId: "" }) !== "allow") {
        return Response.json({ error: "NOT_AUTHORIZED", hint: "the benchmark routes need x-harness-token" }, { status: 401 });
      }
      name = `bench-${url.searchParams.get("obj") ?? "v1"}`;
    }
    else if (url.pathname.startsWith("/ui")) {
      // One demo agent per signed-in person, so two people trying it at once
      // do not share a conversation — and so the isolation is real, not a demo
      // shortcut.
      const gate = await requireViewer(request, env);
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
      const home = gate.agentId;
      const peek = request.method === "POST" ? await formOf(request.clone()) : null;
      const asked = String(url.searchParams.get("agentId") ?? peek?.get("agentId") ?? "").trim();
      const agentId = asked || home;
      if (agentId !== home) {
        const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName(gate.tenantId, home)));
        if (!(await homeStub.uiOwnsAgent(gate.tenantId, home, agentId))) {
          return Response.json({ error: `no such agent: ${agentId} (not this viewer's, or never created)` }, { status: 404 });
        }
      }
      uiSelected = { who, home, agentId, tenantId: gate.tenantId };
      try {
        name = agentObjectName(gate.tenantId, agentId);
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
      // Addressed by identity from the query, so the caller must be allowed to
      // reach that identity: automation, or a signed-in owner (task #15).
      const v = await viewer(request, env);
      let access = programmaticAccess(v, "agent", { tenantId, agentId });
      if (access === "not-found" && v && tenantOf(v) === tenantId) {
        const home = agentOf(v);
        const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName(tenantId, home)));
        access = programmaticAccess(v, "agent", { tenantId, agentId },
          await homeStub.uiOwnsAgent(tenantId, home, agentId));
      }
      if (access === "unauthorized") {
        return Response.json({ error: "NOT_SIGNED_IN", hint: "sign in at /login, or present x-harness-token" }, { status: 401 });
      }
      if (access === "not-found") {
        return Response.json({ error: `no such agent: ${agentId} (not this viewer's, or never created)` }, { status: 404 });
      }
    } else name = "p0";
    const stub = env.AGENT.get(env.AGENT.idFromName(name));
    try {
      switch (url.pathname) {
        case "/storage": return Response.json(await stub.verifyStorage());
        case "/conformance/executor": return Response.json(await stub.runExecutorSpec());
        case "/agent/message": {
          const g = await guardSpending(request, env);
          if (g) return g;
          const body = (await request.json()) as any;
          // The same check as the console's form (#350): a signed-in person can reach their own agents here too,
          // so credential-shaped text is refused before it starts a task; `allowSecret: true` is the deliberate
          // resend (Vera, task #19).
          const refused = refuseSecret(String(body.text ?? ""), body.allowSecret === true);
          if (refused) return refused;
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
          const g = await guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchStart(String(b.taskId), String(b.policy ?? ""), b.offload !== false));
        }
        case "/bench/say": {
          const g = await guardSpending(request, env);
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
          const g = await guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSweStart(String(b.taskId), b));
        }
        case "/bench/swe/shell": {
          const g = await guardSpending(request, env);
          if (g) return g;
          const b = (await request.json()) as any;
          return Response.json(await stub.benchSweShell(String(b.taskId), String(b.command)));
        }
        case "/bench/swe/release": {
          const g = await guardSpending(request, env);
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
        // What identity a request actually resolves to is /ui/whoami's
        // business; here only the automation token opens the door, and a
        // client-supplied header never does.
        case "/admin/identity": {
          // Who may sign in with GitHub, and as which agent. Header-only like
          // the other /admin routes, and closed when no token is configured:
          // the operator adds a row before a person's first sign-in.
          if (!env.AUTOMATION_TOKEN || request.headers.get("x-harness-token") !== env.AUTOMATION_TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          const dir = identities(env);
          try {
            if (request.method === "POST") {
              const body: any = await request.json().catch(() => null);
              const key = String(body?.key ?? "").trim();
              const agentId = String(body?.agentId ?? "").trim();
              const tenantId = String(body?.tenantId ?? "demo").trim();
              // Admission equals the naming rule: a row the object name would
              // refuse must not be written, or it fails at sign-in instead
              // (Piper, 2026-09-12).
              let named = "";
              try { named = agentObjectName(tenantId, agentId); } catch (e: any) { named = ""; }
              if (!/^github:\d+$/.test(key) || !agentId.startsWith("u-") || !named) {
                return Response.json({ error: "BAD_ROW", hint: "key is github:<numeric id>; agentId is u-<…>; tenantId (optional, default demo); both must be valid object-name parts" }, { status: 400 });
              }
              await dir.upsert(key, { agentId, tenantId }, "automation");
              return Response.json({ ok: true, key, agentId, tenantId });
            }
            if (request.method === "DELETE") {
              // Removes the invitation, not the agent: the object and its data
              // stay where they are; the person just cannot sign in to it.
              const key = String(url.searchParams.get("key") ?? "").trim();
              if (!/^github:\d+$/.test(key)) return Response.json({ error: "BAD_KEY", hint: "?key=github:<numeric id>" }, { status: 400 });
              // The same button is two operations. A self-registered row is
              // rebuilt by the next sign-in as the same tenant/agent pair (the
              // derivations are pure in the id), so deleting it is an un-invite
              // the person undoes themselves. A row that lives elsewhere (the
              // pre-tenant rows in "demo") is rebuilt as a FRESH pair: the old
              // object keeps the data and nothing reads it. Say so in the reply
              // (Piper, Vera, Dora, 2026-09-12).
              const row = await dir.lookup(key);
              const rebuiltAs = githubDefaultTenantId({ id: Number(key.slice("github:".length)) });
              const warning = row && row.tenantId !== rebuiltAs
                ? `this row lives in tenant ${row.tenantId}; a re-registration under open sign-up lands in ${rebuiltAs}, a fresh object, and the data in ${row.tenantId}/${row.agentId} stays there unread. To restore access to the old object, POST the same row back with tenantId ${row.tenantId}.`
                : null;
              await dir.remove(key);
              return Response.json({ ok: true, key, removed: row, ...(warning ? { warning } : {}) });
            }
            return Response.json({ identities: await dir.list() });
          } catch (e: any) {
            // D1 did not answer. Say that, rather than a bare 500 that reads as a bug in the route.
            console.error("admin/identity: control plane unavailable", String(e?.message ?? e));
            return Response.json({ error: "CONTROL_PLANE_UNAVAILABLE", hint: String(e?.message ?? e) }, { status: 503 });
          }
        }
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
        case "/admin/rename-mount": {
          // Renaming a mount is an operator act, not something an agent or a
          // page does: it moves the mount row, the connection state and the
          // credential together, and it is refused while the mount is holding
          // a container. There is no button for it on purpose — the one
          // occasion it exists for is a deployment-wide rename someone decided
          // to apply, and that decision does not belong to whoever has the
          // page open.
          if (env.AUTOMATION_TOKEN && request.headers.get("x-harness-token") !== env.AUTOMATION_TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          if (request.method !== "POST") return Response.json({ error: "POST" }, { status: 405 });
          const t = url.searchParams.get("tenantId") ?? "demo";
          const a = String(url.searchParams.get("agentId"));
          const from = String(url.searchParams.get("from") ?? "");
          const to = String(url.searchParams.get("to") ?? "");
          if (!a || !from || !to) {
            return Response.json({ error: "agentId, from and to are required" }, { status: 400 });
          }
          const s3 = env.AGENT.get(env.AGENT.idFromName(agentObjectName(t, a)));
          return Response.json(await s3.uiRenameMount(t, a, from, to));
        }
        case "/admin/diagnose":
          return await adminDiagnose(request, env.AUTOMATION_TOKEN,
            (t, a) => env.AGENT.get(env.AGENT.idFromName(agentObjectName(t, a))));
        case "/admin/transcript":
          // Awaited, so a failure reaches this route's catch and its log instead of the platform's 1101.
          return await adminTranscript(request, env.AUTOMATION_TOKEN,
            (t, a) => env.AGENT.get(env.AGENT.idFromName(agentObjectName(t, a))));
        case "/ui": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = url.searchParams.get("taskId") ?? `t_${agentId}`;
          await stub.uiEnsure(gate.tenantId, agentId, taskId);
          return new Response(page(taskId, who, agentId, gate.viewer), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        case "/ui/transcript": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const v = await versionOf(request, stub, gate.tenantId, agentId, taskId);
          if (v.unchanged) return v.unchanged;
          const tail = url.searchParams.get("all") === "1" ? 0 : 120;
          const t = await stub.uiTranscript(gate.tenantId, agentId, taskId, tail);
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
            `<h3>trajectory</h3>${trajectory(t.events, t.byOp, t.busy)}`, v.etag);
        }
        case "/ui/chat":
        case "/ui/events": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const v = await versionOf(request, stub, gate.tenantId, agentId, taskId);
          if (v.unchanged) return v.unchanged;
          const tail = url.searchParams.get("all") === "1" ? 0 : 120;
          const t = await stub.uiTranscript(gate.tenantId, agentId, taskId, tail);
          // With `held=1` the held calls ride along, in one fragment under one
          // version (uiVersion counts them), instead of a second poll that
          // never answered 304.
          const held = url.searchParams.get("held") === "1" ? await stub.uiApprovals(gate.tenantId, agentId, taskId) : null;
          return html(url.pathname === "/ui/chat"
            // The conversation alone; everything else about the run is in the
            // panels on the right.
            ? chatPanel(trajectory(conversation(t.events), t.byOp, t.busy), held)
            : eventList(t.events), v.etag);
        }
        case "/ui/plugins": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          // One read, dispatched to the part the shell asked for: the mount
          // list, one mount's block, the catalogue, or the whole page.
          const d = await stub.uiPlugins(gate.tenantId, agentId);
          switch (url.searchParams.get("part")) {
            case "mounts": return conditional(request, mountList(d));
            case "mount": return conditional(request, mountFragment(d, String(url.searchParams.get("alias") ?? "").trim()));
            case "catalogue": return conditional(request, catalogue(d));
            default: return conditional(request, plugins(d));
          }
        }
        case "/ui/credential": {
          // A value comes in; a re-rendered mount block goes out, and nothing
          // else does: not the value, not on success, not on failure.
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const alias = String(form.get("alias") ?? "").trim();
          const fields: Record<string, string> = {};
          for (const [k, v] of form.entries()) if (k !== "alias" && typeof v === "string") fields[k] = v;
          const r = alias ? await stub.uiAttachCredential(gate.tenantId, agentId, alias, fields) : { ok: false as const, error: "no mount named" };
          const d: any = await stub.uiPlugins(gate.tenantId, agentId);
          if (!r.ok) for (const m of d.mounts ?? []) if (m.alias === alias && m.credential) m.credential.error = r.error;
          return html(mountFragment(d, alias));
        }
        case "/ui/plugin/choice": {
          // enable / disable / inherit for one plugin, then the page again.
          // Which fragment to send back is @Nova's call; the whole panel is
          // the safe default because turning a plugin off changes several
          // mounts' rows at once, not just one.
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const r = await stub.uiSetPluginChoice(
            gate.tenantId, agentId,
            String(form.get("plugin") ?? "").trim(),
            String(form.get("choice") ?? "").trim(),
          );
          if (!r.ok) return new Response(r.error, { status: 400 });
          return html(plugins(await stub.uiPlugins(gate.tenantId, agentId)));
        }
        case "/ui/credential/remove": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const alias = String(form.get("alias") ?? "").trim();
          if (alias) await stub.uiRemoveCredential(gate.tenantId, agentId, alias);
          return html(mountFragment(await stub.uiPlugins(gate.tenantId, agentId), alias));
        }
        // An operator handing a container back, from the panel that shows it
        // billing (Nova, 2026-09-16). The alias travels in the form body like
        // every other console write: a query string reaches logs and referrers,
        // and this one names a machine someone is being charged for.
        case "/ui/sandbox/release": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const alias = String(form.get("alias") ?? "").trim();
          if (!alias) return new Response("expected an alias", { status: 400 });
          const r = await stub.uiReleaseSandbox(gate.tenantId, agentId, alias);
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          // The button lives in the inspector's runtime tab, which shows the
          // panels stacked, so the answer is that same stack: a lone container
          // panel would replace the others until the next poll.
          const panel = runtimeStack(await stub.uiStorage(gate.tenantId, agentId, taskId));
          // A refusal is the answer, not an error page: the panel is still the
          // truth, and the reason belongs above it where the button was. The
          // reason names a mount and a plugin's error, so it is escaped here —
          // `esc` is ui.ts's, and this file does not import a renderer.
          const reason = r.ok ? "" : String(r.error).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
          return html(r.ok ? panel : `<div class="err">${reason}</div>${panel}`);
        }
        case "/ui/memory":
        case "/ui/runtime": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          const v = await versionOf(request, stub, gate.tenantId, agentId, taskId);
          if (v.unchanged) return v.unchanged;
          const d = await stub.uiStorage(gate.tenantId, agentId, taskId);
          return html(url.pathname === "/ui/memory" ? memoryPanel(d)
            // The inspector's runtime tab asks with stack=1: the three cost
            // panels stacked into one fragment, object first, then the
            // container, then everything the object is holding.
            : url.searchParams.get("stack") === "1"
              ? runtimeStack(d)
            : runtimePanel(d), v.etag);
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
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          if (request.method !== "POST") return new Response("POST", { status: 405 });
          if (gate.who.startsWith("anonymous")) return new Response("read-only", { status: 403 });
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const home = gate.agentId;
          const made = agentSpec(form, home);
          if (typeof made === "string") return new Response(made, { status: 400 });
          const own = env.AGENT.get(env.AGENT.idFromName(agentObjectName(gate.tenantId, made.agentId)));
          await own.uiAdoptAgent(gate.tenantId, made.agentId, made);
          const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName(gate.tenantId, home)));
          await homeStub.uiRecordAgent(gate.tenantId, home, made);
          return Response.json(made);
        }
        case "/ui/api-keys":
        case "/ui/api-keys/new":
        case "/ui/api-keys/revoke": {
          // A person's own Agents API keys. The owner is whoever signed in (their first agent, their
          // tenant), never a value from the request: a key speaks only for the person who made it, and
          // the agents it makes are listed as theirs. /admin/api-keys stays for automation.
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const owner = { tenantId: gate.tenantId, ownerAgentId: gate.agentId };
          const keys = d1ApiKeys(env.CONTROL_DB);
          const max = 10;
          let issued: { key: string; label: string } | null = null, error: string | null = null;
          if (url.pathname !== "/ui/api-keys") {
            if (request.method !== "POST") return new Response("POST", { status: 405 });
            if (gate.who.startsWith("anonymous")) return new Response("read-only", { status: 403 });
            const form = await formOf(request);
            if (!form) return new Response("expected a form body", { status: 400 });
            if (url.pathname === "/ui/api-keys/new") {
              const label = String(form.get("label") ?? "").trim().slice(0, 60);
              const key = newApiKey();
              if (!label) error = "a key needs a name";
              else if (await keys.issueWithin({ hash: await hashApiKey(key), ...owner, label }, max)) issued = { key, label };
              else error = `${max} live keys is the most one person may hold; revoke one first`;
            } else if (!(await keys.revokeOwned(String(form.get("hash") ?? ""), owner))) {
              error = "that key is not one of yours, or it is already revoked";
            }
          }
          const res = html(apiKeysPanel({ keys: await keys.list(owner), issued, error, baseUrl: `${url.origin}/v1`, max }));
          // A new key is in this one response and nowhere else, so nothing on the way may keep a copy.
          res.headers.set("cache-control", "no-store");
          return res;
        }
        case "/ui/agents": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const home = gate.agentId;
          const homeStub = env.AGENT.get(env.AGENT.idFromName(agentObjectName(gate.tenantId, home)));
          const agents = (await homeStub.uiListAgents(gate.tenantId, home))
            .map((a) => ({ ...a, current: a.agentId === (uiSelected?.agentId ?? home) }));
          // The page swaps the rendered list in; anything else gets the data.
          return request.headers.get("hx-request") ? conditional(request, agentList({ agents })) : Response.json({ agents });
        }
        case "/ui/approvals": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = url.searchParams.get("taskId") || `t_${agentId}`;
          return conditional(request, approvals(await stub.uiApprovals(gate.tenantId, agentId, taskId)));
        }
        case "/ui/message": {
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const taskId = String(form.get("taskId") ?? "") || `t_${agentId}`;
          const text = String(form.get("text") ?? "").trim();
          const mode = String(form.get("mode")) === "followUp" ? "followUp" as const : "steer" as const;
          // Credential-shaped text is refused before it reaches the agent; the page offers a deliberate resend
          // with allowSecret=1 (Nova, task #19).
          const refused = text ? refuseSecret(text, form.get("allowSecret") === "1") : null;
          if (refused) return refused;
          if (text) {
            // A refusal returned as a value is still a refusal: the page shows
            // it only if the status says so (Vera, after the day the lane
            // refused every message and the route answered 200 each time).
            const r: any = await stub.uiSay(gate.tenantId, agentId, taskId, text, mode);
            if (r?.result?.ok === false) {
              const err = r.result.error;
              return new Response(`refused: ${err?.code ?? ""} ${err?.message ?? JSON.stringify(err)}`.trim(), { status: 409 });
            }
          }
          const t = await stub.uiTranscript(gate.tenantId, agentId, taskId);
          // The same shape the chat poll returns, so a page that asked for the
          // held cards there keeps them here (`held=1` in the form).
          const held = form.get("held") === "1" ? await stub.uiApprovals(gate.tenantId, agentId, taskId) : null;
          return html(chatPanel(trajectory(t.events, t.byOp, t.busy), held));
        }
        case "/ui/compact": {
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const taskId = String(form.get("taskId") ?? "") || `t_${agentId}`;
          await stub.uiCompact(gate.tenantId, agentId, taskId);
          const t = await stub.uiTranscript(gate.tenantId, agentId, taskId);
          return html(trajectory(conversation(t.events), t.byOp, t.busy));
        }
        case "/ui/decide": {
          const form = await formOf(request);
          if (!form) return new Response("expected a form body", { status: 400 });
          const gate = await requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = uiSelected?.agentId ?? gate.agentId;
          const decision = String(form.get("decision")) === "approved" ? "approved" : "denied";
          // The panel that posted names its conversation; an older page that
          // does not is the first one. Either way it is the viewer's own or 404.
          const taskId = String(form.get("taskId") ?? "").trim();
          // The approver is whoever is signed in — an audit record
          // with a name the caller chose would be worth nothing.
          return html(approvals(await stub.uiDecide(gate.tenantId, agentId, taskId, String(form.get("operationId")), decision, who)));
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
            diagnostics: ["/conformance/executor", "/isolation",
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
      // The stack goes to the Worker's log, not to whoever made the request: it names our files and call
      // paths, and the console now puts the response body on the page under a failed form (#334).
      console.error("request failed:", url.pathname, e?.stack ?? e);
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  },
};
