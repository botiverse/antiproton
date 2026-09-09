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
import { kernelSpec } from "../../test/spec/kernel-spec.ts";
import { executorSpec } from "../../test/spec/executor-spec.ts";
import { AgentRuntime, OPERATOR_RUN9_REF, type ModelJob } from "./runtime.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { runModelCommand } from "../../src/runtime/commands.ts";
import { BenchState } from "./bench.ts";
import { page, trajectory, approvals } from "./ui.ts";

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
  taskId: string;
  commandId: string;
}

async function runQueuedModelCall(m: QueuedModelCall, env: Env) {
  const stub = env.AGENT.get(env.AGENT.idFromString(m.doId));
  const job = await stub.takeModelJob(m.commandId);
  // Already answered — a redelivery after success, which must not call the
  // provider again.
  if (!job) return;
  if (!Array.isArray((job.payload as any)?.messages)) {
    throw new Error(`not a model request: ${JSON.stringify(job.payload).slice(0, 80)}`);
  }
  const model = new OpenAiCompatibleModel({
    baseUrl: env.DEEPSEEK_BASE_URL,
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.HARNESS_MODEL,
  });
  const t0 = Date.now();
  const res = await runModelCommand(model, job.payload);
  await stub.deliverModel(job, { ok: true, res, modelMs: Date.now() - t0 });
}

/** Out of retries. The task has to hear about it, or it waits for ever. */
async function failLoudly(m: QueuedModelCall, env: Env) {
  const stub = env.AGENT.get(env.AGENT.idFromString(m.doId));
  const job = await stub.takeModelJob(m.commandId);
  if (!job) return;
  await stub.deliverModel(job, {
    ok: false,
    error: "the model call failed repeatedly and was given up on",
  });
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_tasks(
      task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, generation INTEGER NOT NULL,
      checkpoint_version INTEGER NOT NULL, fencing_token INTEGER NOT NULL, checkpoint TEXT NOT NULL)`);
    // What Cloudflare bills this object for: wall clock while it is active.
    this.sql.exec("CREATE TABLE IF NOT EXISTS do_activity(at INTEGER, ms INTEGER, kind TEXT)");
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

  /** The kernel contract, unchanged, against Durable Object storage. */
  async runKernelSpec() {
    const t0 = Date.now();
    const results = await kernelSpec(async () => {
      const store = new DurableObjectStore(this.ctx as any);
      return store;
    });
    return { backend: "durable-object", ms: Date.now() - t0, results };
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

  /** Who this object serves, once claimed. */
  async owner() {
    const row = this.sql.exec("SELECT tenant_id, agent_id FROM owner WHERE k='self'").toArray()[0] as any;
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

  /** Called by the queue consumer once the completion lands. */
  async deliverModel(
    job: ModelJob,
    outcome: { ok: true; res: any; modelMs?: number } | { ok: false; error: string },
  ) {
    // How long the round trip out of this object actually took. If offloading
    // buys cheap duration but costs seconds per call, that is the trade being
    // made, and it should be visible rather than inferred from wall clock.
    try {
      const row = this.sql
        .exec("SELECT dispatched_at FROM outbox WHERE command_id=?", job.commandId).toArray()[0] as any;
      if (row?.dispatched_at) {
        this.sql.exec("INSERT INTO do_activity VALUES (?,?,?)",
          Number(row.dispatched_at), Date.now() - Number(row.dispatched_at), "offload_rtt");
        // Split the round trip: how much was the provider, how much was us.
        const mms = (outcome as any).modelMs;
        if (typeof mms === "number") {
          this.sql.exec("INSERT INTO do_activity VALUES (?,?,?)", Number(row.dispatched_at), mms, "offload_provider");
        }
      }
    } catch { /* measurement must never break delivery */ }
    return this.#busy("deliverModel", async () => {
      await this.#activeRuntime().deliverModel(job, outcome);
      await this.broadcast();
      await this.ctx.storage.setAlarm(Date.now());
      return { ok: true };
    });
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
  async #dispatch(job: ModelJob): Promise<void> {
    await this.env.MODEL_QUEUE.send({
      doId: this.ctx.id.toString(),
      tenantId: job.tenantId, agentId: job.agentId, taskId: job.taskId,
      commandId: job.commandId,
    });
  }

  /**
   * The payload behind a queued command, read back by the consumer.
   *
   * Returns null once the reply is in: a redelivery after a successful call
   * must not run the provider a second time. The dedup key on the result event
   * makes that safe rather than merely unlikely.
   */
  async takeModelJob(commandId: string): Promise<ModelJob | null> {
    const row = this.sql.exec(
      `SELECT o.tenant_id, o.task_id, o.payload, t.agent_id FROM outbox o
         JOIN tasks t ON t.tenant_id = o.tenant_id AND t.task_id = o.task_id
        WHERE o.command_id = ?
          AND NOT EXISTS (SELECT 1 FROM events e
                           WHERE e.tenant_id = o.tenant_id
                             AND e.dedup_key = 'cmd:' || o.command_id || ':response')`,
      commandId).toArray()[0] as any;
    if (!row) return null;
    return {
      tenantId: row.tenant_id, agentId: row.agent_id, taskId: row.task_id,
      commandId, payload: JSON.parse(row.payload),
    };
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
    const task = await rt.store.loadTask(tenantId, taskId);
    const events = await rt.store.taskEvents(tenantId, taskId);
    const kinds: Record<string, number> = {};
    for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    return {
      owner: await this.owner(),
      task: task && {
        status: task.status, generation: task.generation,
        checkpointVersion: task.checkpointVersion, stateVersion: task.stateVersion,
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
      pendingWork: (await rt.store.tasksWithPendingWork(5)).length,
      alarm: await this.ctx.storage.getAlarm(),
      alarmFailures: this.#alarmFailures(),
      // The table exists only once an alarm has failed; diagnose must not be
      // the thing that throws while explaining why something else did.
      alarmErrors: (this.sql.exec("CREATE TABLE IF NOT EXISTS alarm_errors(at INTEGER, message TEXT)"),
        [...this.sql.exec(
        "SELECT at, message FROM alarm_errors ORDER BY at DESC LIMIT 3")].map((r: any) => r.message)),
      // Which commands are still out, and in what state. A task that stops for
      // no visible reason is nearly always a row here that nothing is watching.
      outbox: [...this.sql.exec(
        `SELECT command_id, kind, state, created_at, dispatched_at FROM outbox
          WHERE tenant_id=? AND task_id=? AND state != 'done' ORDER BY created_at DESC LIMIT 10`,
        tenantId, taskId)].map((r: any) => ({
          kind: r.kind, state: r.state,
          ageMs: Date.now() - Number(r.dispatched_at ?? r.created_at),
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

  #benchRt(policy: string): AgentRuntime {
    const off = this.#offloadOn();
    if (this.#benchRuntime && this.#benchPolicy === policy && this.#benchOffload === off) {
      return this.#benchRuntime;
    }
    this.#benchPolicy = policy;
    this.#benchOffload = off;
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
      extraPlugins: [this.#benchState().plugin()],
      // Matches bench/tau2/compare.ts's hybrid arm, so CF numbers sit alongside
      // the Node ones instead of measuring a different harness.
      harnessMode: "hybrid",
      maxTurns: 40,
      policy,
      offloadModel: this.#offloadOn() ? (job) => this.#dispatch(job) : undefined,
    });
    return this.#benchRuntime;
  }

  async benchStart(taskId: string, policy: string, offload: boolean) {
    await this.setOffload(offload);
    return this.#busy("benchStart", async () => {
      this.sql.exec(
        "INSERT INTO bench_config(k,v) VALUES ('policy',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", policy);
      const rt = this.#benchRt(policy);
      const agentId = `b_${taskId}`;
      await this.#benchState().reset(taskId);
      // Only what the Node bench mounts: github/artifacts would change the tool
      // catalogue and make the two runners incomparable.
      await rt.bindOperatorModel("bench", agentId);
      await rt.provision("bench", agentId, [
        { alias: "tools", plugin: "tools", account: "builtin" },
        { alias: "retail", plugin: "retail", account: "benchmark" },
      ]);
      await rt.openTask("bench", agentId, taskId);
      return { taskId, agentId, offload: this.#offloadOn() };
    });
  }

  async benchSay(taskId: string, text: string) {
    return this.#busy("benchSay", async () => {
      const rt = this.#activeRuntime();
      const r = await rt.postMessage("bench", `b_${taskId}`, taskId, text);
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  /** Read-only, but it still wakes the object, so it is still billed. */
  async benchPoll(taskId: string) {
    return this.#busy("poll", () => this.#benchPollInner(taskId));
  }

  async #benchPollInner(taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const task = await rt.store.loadTask("bench", taskId);
    const done = task && ["completed", "failed", "blocked"].includes(task.status);
    return {
      status: task?.status ?? null,
      checkpointVersion: task?.checkpointVersion ?? 0,
      answer: done ? (task!.checkpoint as any).messages.at(-1).content : null,
    };
  }

  /** What the harness actually handed the provider. Guessing at this cost two
   *  bench runs; it is cheaper to be able to look. */
  async benchDebug(taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const task = await rt.store.loadTask("bench", taskId);
    const cp = (task?.checkpoint ?? {}) as any;
    return {
      status: task?.status ?? null,
      harness: this.#benchPolicy ? "hybrid" : "hybrid",
      toolCount: Array.isArray(cp.tools) ? cp.tools.length : null,
      toolNames: Array.isArray(cp.tools) ? cp.tools.map((t: any) => t.name) : null,
      addresses: cp.addresses ?? null,
      systemHead: String(cp.messages?.[0]?.content ?? "").slice(0, 400),
      lastMessages: (cp.messages ?? []).slice(-4).map((m: any) => ({
        role: m.role, content: String(m.content ?? "").slice(0, 300),
        toolCalls: m.tool_calls ? JSON.stringify(m.tool_calls).slice(0, 200) : undefined,
      })),
    };
  }

  /** Why is this object busy? Answers the only question that matters when an
   *  alarm loop will not settle: which tasks still claim to have work. */
  async benchDiag() {
    const rt = this.#activeRuntime();
    await rt.ready();
    const pending = await rt.store.tasksWithPendingWork(20);
    const rows: any[] = [];
    for (const { tenantId, taskId } of pending) {
      const t = await rt.store.loadTask(tenantId, taskId);
      const evs = this.sql
        .exec(`SELECT e.kind, e.sequence FROM events e WHERE e.tenant_id=? AND e.task_id=?
               ORDER BY e.sequence DESC LIMIT 5`, tenantId, taskId).toArray();
      const cur = this.sql
        .exec("SELECT consumer, consumed_through FROM cursors WHERE tenant_id=? AND task_id=?", tenantId, taskId)
        .toArray();
      rows.push({ taskId, status: t?.status, generation: t?.generation,
                  checkpointVersion: t?.checkpointVersion, cursors: cur,
                  lastEvents: evs.map((e: any) => `${e.sequence}:${e.kind}`) });
    }
    const ob = this.sql.exec("SELECT kind, state, COUNT(*) n FROM outbox GROUP BY kind, state").toArray();
    return { pendingCount: pending.length, pending: rows, outbox: ob,
             alarm: await this.ctx.storage.getAlarm() };
  }

  /** Bench state is disposable; contaminated state is worse than none. */
  async benchPurge() {
    await this.ctx.storage.deleteAlarm();
    for (const t of ["events", "cursors", "waits", "outbox", "operations", "leases", "tasks", "mounts", "agents"]) {
      try { this.sql.exec(`DELETE FROM ${t} WHERE tenant_id='bench'`); } catch { /* table may lack the column */ }
    }
    try { this.sql.exec("DELETE FROM leases"); } catch { /* no tenant column */ }
    this.sql.exec("DELETE FROM bench_tasks");
    this.sql.exec("DELETE FROM do_activity");
    this.#benchRuntime = null;
    return { purged: true };
  }

  async benchResult(taskId: string) {
    const rt = this.#activeRuntime();
    await rt.ready();
    const events = await rt.store.eventsSince("bench", `b_${taskId}`, 0, 500);
    const usage = events.reduce(
      (a: any, e: any) => {
        const u = e.payload?.usage;
        if (u) { a.prompt += u.promptTokens ?? 0; a.completion += u.completionTokens ?? 0; a.calls += 1; }
        return a;
      }, { prompt: 0, completion: 0, calls: 0 });
    const kinds = events.reduce((m: any, e: any) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
    const r = await this.#benchState().result(taskId);
    return { writes: r.writes, dbHash: await sha256(canonJson(r.db)), usage, kinds };
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
  async uiEnsure(tenantId: string, agentId: string, taskId: string) {
    this.#claim(tenantId, agentId);
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
      const desired = [
        { alias: "tools", plugin: "tools", config: { account: "builtin" },
          secretRef: null, policy: null },
        // Without this a parked result is a reference the agent cannot open.
        { alias: "artifacts", plugin: "artifacts", config: { account: "builtin" },
          secretRef: null, policy: null },
        // Writes that need a person: the policy is what the page exists to show.
        { alias: "ops", plugin: "demo", config: { account: "demo-fleet" },
          secretRef: null, policy: { write: "approval" as const } },
        // Open on purpose: the agent holds no credential and writes need a
        // human. maxBytes stays under the offload threshold so an ordinary page
        // reaches the model directly rather than via a round trip to storage.
        { alias: "web", plugin: "http", config: { account: "open web", maxBytes: 24_000 },
          secretRef: null, policy: null },
        // A real container, for tasks that need one. Its tools describe
        // themselves as a last resort so the agent reaches for free in-process
        // JS first, and the framework releases the box when the task ends.
        { alias: "node", plugin: "run9", config: { account: "sandbox" },
          secretRef: OPERATOR_RUN9_REF, policy: null },
      ];
      for (const d of desired) {
        const have = await rt.store.getMountByAlias(tenantId, agentId, d.alias);
        if (!have) {
          await rt.store.addMount({
            tenantId, agentId, alias: d.alias, plugin: d.plugin,
            installationId: `inst-${d.alias}`, connectionId: null, toolVersion: "1.0.0",
            publicConfig: d.config, secretRef: d.secretRef, policy: d.policy,
          });
          continue;
        }
        if (JSON.stringify(have.publicConfig) !== JSON.stringify(d.config)) {
          await rt.store.updateMountConfig(tenantId, agentId, d.alias, d.config);
        }
        if (JSON.stringify(have.policy ?? null) !== JSON.stringify(d.policy ?? null)) {
          await rt.store.updateMountPolicy(tenantId, agentId, d.alias, d.policy);
        }
      }
      // Tied to the binding's own absence, not to whether a mount happened to
      // be created in this pass: an agent that gains a new mount already has a
      // model, and one provisioned by a half-finished run may not.
      if (!(await rt.store.getModelBinding(tenantId, agentId))) {
        await rt.bindOperatorModel(tenantId, agentId);
      }
      if (!(await rt.store.loadTask(tenantId, taskId))) {
        await rt.openTask(tenantId, agentId, taskId);
      }
      return { ok: true };
    });
  }

  async uiSay(tenantId: string, agentId: string, taskId: string, text: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("uiSay", async () => {
      const rt = this.runtime();
      const r = await rt.postMessage(tenantId, agentId, taskId, text);
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  async uiTranscript(tenantId: string, agentId: string, taskId: string) {
    const rt = this.runtime();
    await rt.ready();
    const events = (await rt.store.taskEvents(tenantId, taskId)).map((e) => ({
      sequence: e.sequence, kind: e.kind, payload: e.payload, createdAt: e.createdAt,
    }));
    const task = await rt.store.loadTask(tenantId, taskId);
    const pendingApproval = (await rt.store.listApprovals(tenantId, "pending"))
      .some((a) => a.taskId === taskId);
    const busy: "thinking" | "waiting-for-approval" | null = pendingApproval
      ? "waiting-for-approval"
      : task && !["completed", "failed"].includes(task.status)
        ? "thinking"
        : null;
    // Approvals are keyed by operation so the trajectory can show a held call
    // where it happened, with who signed it, instead of in a separate panel.
    const byOp: Record<string, any> = {};
    for (const a of await rt.store.listApprovals(tenantId)) {
      if (a.taskId === taskId) {
        byOp[a.operationId] = { state: a.state, approver: a.approver, tool: `${a.mountAlias}.${a.tool}`, request: a.request };
      }
    }
    return { events, byOp, busy };
  }

  async uiApprovals(tenantId: string, taskId: string) {
    const rt = this.runtime();
    await rt.ready();
    return (await rt.store.listApprovals(tenantId)).filter((a) => a.taskId === taskId);
  }

  async uiDecide(tenantId: string, operationId: string, decision: "approved" | "denied", approver: string) {
    return this.#busy("uiDecide", async () => {
      const rt = this.runtime();
      await rt.ready();
      const out = await rt.gateway().applyApproval(tenantId, operationId, decision, approver);
      // The decision produced a completion event; let the agent pick it up.
      await this.ctx.storage.setAlarm(Date.now());
      return out;
    });
  }

  async startTask(tenantId: string, agentId: string, taskId: string, text: string) {
    this.#claim(tenantId, agentId);
    return this.#busy("startTask", async () => {
      const rt = this.runtime();
      await rt.provision(tenantId, agentId);
      await rt.bindOperatorModel(tenantId, agentId);
      const r = await rt.postMessage(tenantId, agentId, taskId, text);
      // Wakeup is an alarm, not a poll: nothing spins while the agent has no work.
      await this.ctx.storage.setAlarm(Date.now());
      return r;
    });
  }

  async taskState(tenantId: string, agentId: string, taskId: string) {
    this.#claim(tenantId, agentId);
    const rt = this.runtime();
    await rt.ready();
    const task = await rt.store.loadTask(tenantId, taskId);
    const events = await rt.store.eventsSince(tenantId, agentId, 0, 200);
    const answer = task && (task.checkpoint as any)?.done
      ? (task.checkpoint as any).messages.at(-1).content
      : null;
    return {
      status: task?.status ?? null,
      generation: task?.generation ?? null,
      checkpointVersion: task?.checkpointVersion ?? null,
      answer,
      events: events.map((e) => ({
        sequence: e.sequence, kind: e.kind,
        usage: (e.payload as any)?.usage ?? undefined,
        jsStatus: (e.payload as any)?.status ?? undefined,
        ops: (e.payload as any)?.acceptedOperationIds ?? undefined,
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
    const rt = this.runtime();
    await rt.ready();
    const events = await rt.store.eventsSince(cur.tenantId, cur.agentId, cur.after, 200);
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
        const resent = await rt.sweepStale();
        const { more } = await rt.drain(3);
        await this.broadcast();
        // Bounded work per invocation; if there is more, come back rather than
        // holding one alarm open until the platform ends it.
        if (more) await this.ctx.storage.setAlarm(Date.now() + 50);
        else if (resent > 0 || (await rt.hasOffloadInFlight())) {
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
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
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

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
    `<!doctype html><meta charset="utf-8"><title>agent-harness</title>` +
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
    await time("fetch api.github.com", () => fetch("https://api.github.com/repos/nodejs/node", { headers: { "user-agent": "agent-harness/0.1" } }).then((r) => r.text())),
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
    if (url.pathname.startsWith("/conformance")) name = "conformance-v2";
    else if (url.pathname.startsWith("/bench")) name = `bench-${url.searchParams.get("obj") ?? "v1"}`;
    else if (url.pathname.startsWith("/ui")) {
      // One demo agent per signed-in person, so two people trying it at once
      // do not share a conversation — and so the isolation is real, not a demo
      // shortcut.
      const gate = requireViewer(request, env);
      if (gate instanceof Response) return gate;
      const who = gate.who;
      try {
        name = agentObjectName("demo", `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`);
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
        case "/conformance/kernel": return Response.json(await stub.runKernelSpec());
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
        case "/bench/activity":
          return Response.json(await stub.activity(Number(url.searchParams.get("since") ?? 0)));
        case "/bench/activity/reset": return Response.json(await stub.resetActivity());
        case "/bench/diag":
          return Response.json(await stub.benchDiag());
        case "/bench/purge":
          return Response.json(await stub.benchPurge());
        case "/bench/debug":
          return Response.json(await stub.benchDebug(String(url.searchParams.get("taskId"))));
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
          const agentId = `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
          const taskId = url.searchParams.get("taskId") ?? `t_${agentId}`;
          await stub.uiEnsure("demo", agentId, taskId);
          return new Response(page(taskId, who), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        case "/ui/transcript": {
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
          const taskId = String(url.searchParams.get("taskId"));
          const t = await stub.uiTranscript("demo", agentId, taskId);
          return html(trajectory(t.events, t.byOp, t.busy));
        }
        case "/ui/approvals": {
          const taskId = String(url.searchParams.get("taskId"));
          return html(approvals(await stub.uiApprovals("demo", taskId)));
        }
        case "/ui/message": {
          const form = await request.formData();
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const agentId = `u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
          const taskId = String(form.get("taskId"));
          const text = String(form.get("text") ?? "").trim();
          if (text) await stub.uiSay("demo", agentId, taskId, text);
          const t = await stub.uiTranscript("demo", agentId, taskId);
          return html(trajectory(t.events, t.byOp, t.busy));
        }
        case "/ui/decide": {
          const form = await request.formData();
          const gate = requireViewer(request, env);
          if (gate instanceof Response) return gate;
          const who = gate.who;
          const decision = String(form.get("decision")) === "approved" ? "approved" : "denied";
          // The approver is whoever Access says is signed in — an audit record
          // with a name the caller chose would be worth nothing.
          await stub.uiDecide("demo", String(form.get("operationId")), decision, who);
          const taskId = `t_u-${who.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)}`;
          return html(approvals(await stub.uiApprovals("demo", taskId)));
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
      return Response.json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 600) }, { status: 500 });
    }
  },
};
