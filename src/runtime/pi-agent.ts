/**
 * One agent, inside one Durable Object, driven by pi's harness.
 *
 * The ownership split is the same one the rest of this system runs on, and pi's
 * API happens to be cut along exactly those lines:
 *
 *   the object owns state and order   — Session over PiSqliteStorage, object-local
 *   the alarm owns time               — `step()` is what an alarm calls
 *   the queue owns work in flight     — `drive()` suspends instead of waiting
 *   the worker owns waiting           — it answers through `deliver()`
 *
 * `accept()` is a pure write and returns at once, so a person's message is
 * durable before the response is sent. `drive()` is the pass that does I/O, and
 * it returns rather than blocks whenever the model is out — which is why the
 * object is not billed for the provider's latency.
 *
 * A task is no longer a thing. pi calls one run an operation, the conversation
 * is a lane, and the lane is the agent: that is what a long-running agent with
 * memory actually is, and it removes a whole identifier from the system.
 */
import { createModels } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { LaneBusy } from "@earendil-works/pi-agent-core";
import type { AgentHarness as Harness, AgentLane, OpenOperation } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage, ensurePiTables, type SqlHost } from "../store/pi-storage.ts";
import { offloadedProvider, type OffloadPort } from "../model/pi-offloaded.ts";
import { bridgeTools, type MountedTool, type ToolHost } from "./pi-tools.ts";

const JOBS = `CREATE TABLE IF NOT EXISTS pi_model_jobs (
  id TEXT PRIMARY KEY, request TEXT NOT NULL, answer TEXT,
  created_at INTEGER NOT NULL, answered_at INTEGER)`;

/**
 * Every table an agent keeps, created together.
 *
 * The console reads some of them directly, because its change check should be
 * one cheap `MAX(seq)` and not a whole session build — and those reads happen
 * before anyone has opened an agent. Creating them lazily made the first page
 * load depend on the order two unrelated things happened in, and the page
 * simply spun: every panel answered 500. Fixing one table found the second, so
 * they are now one call with one home.
 */
export function ensureAgentTables(sql: SqlHost["sql"]) {
  ensurePiTables(sql);
  sql.exec(JOBS);
}

export const LANE = "main";

export interface ModelChoice {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens?: number;
}

export interface PiAgentOptions {
  host: SqlHost;
  sessionId: string;
  systemPrompt: string;
  model: ModelChoice;
  tools: MountedTool[];
  toolHost: ToolHost;
  /** Wake whatever does the waiting. Failure here is not fatal: the job row is
   *  already durable, so a later pass can re-send it. */
  dispatch(jobId: string): Promise<void>;
  /** How long the alarm should wait before looking for an answer again. */
  pollAfterMs?: number;
  now?: () => number;
}

export interface StepOutcome {
  /** Operations still open after this pass. */
  open: number;
  /** When to come back, in ms from now, or null if nothing is pending. */
  wakeInMs: number | null;
  settled: Array<{ operationId: string; status: string }>;
}

export class PiAgent {
  #opts: PiAgentOptions;
  #sql: SqlHost["sql"];
  #storage: PiSqliteStorage;
  #harness: Harness<undefined>;
  #lane: AgentLane;
  #open: OpenOperation[];

  private constructor(
    opts: PiAgentOptions, storage: PiSqliteStorage, harness: Harness<undefined>,
    lane: AgentLane, open: OpenOperation[],
  ) {
    this.#opts = opts;
    this.#sql = opts.host.sql;
    this.#storage = storage;
    this.#harness = harness;
    this.#lane = lane;
    this.#open = open;
  }

  /**
   * Build everything from storage. Called on every wake, because the object may
   * have been evicted since the last one — `create` starts no timers and no
   * provider work, and hands back the operations that were left open, which is
   * the whole recovery mechanism.
   */
  static async open(opts: PiAgentOptions): Promise<PiAgent> {
    ensureAgentTables(opts.host.sql);
    const storage = new PiSqliteStorage(opts.host, opts.now ? { now: opts.now } : {});
    const session = new StorageBackedSession(
      { id: opts.sessionId, createdAt: (opts.now ?? Date.now)(), storageVersion: 1 },
      storage as any,
    );

    const models = createModels();
    const agent = { current: null as PiAgent | null };
    const port: OffloadPort = {
      async start({ model, context, options }) {
        return agent.current!.#startJob({ model, context, options });
      },
      async poll(id) { return agent.current!.#pollJob(id); },
      async cancel(id) { agent.current!.#dropJob(id); },
    };
    models.setProvider(offloadedProvider({
      port,
      // What the caller should wait before asking again. The alarm uses it as
      // its own delay, so it is the agent's polling cadence.
      pollAfterMs: opts.pollAfterMs ?? 1_000,
      id: opts.model.provider,
      models: [{
        id: opts.model.id,
        contextWindow: opts.model.contextWindow,
        ...(opts.model.maxTokens === undefined ? {} : { maxTokens: opts.model.maxTokens }),
      }],
    }));

    const { harness, open } = await AgentHarness.create({
      session: session as any,
      models,
      model: models.getModel(opts.model.provider, opts.model.id)!,
      systemPrompt: opts.systemPrompt,
      tools: bridgeTools(opts.tools, opts.toolHost) as any,
      // There is no non-deferred path; this makes the intent explicit to pi.
      streamOptions: { deferred: true },
    }, CTX);

    const lane = await harness.lane(LANE, CTX);
    const self = new PiAgent(opts, storage, harness, lane, open);
    agent.current = self;
    return self;
  }

  get lane(): AgentLane { return this.#lane; }
  get harness(): Harness<undefined> { return this.#harness; }
  get storage(): PiSqliteStorage { return this.#storage; }
  /** Operations that were mid-flight when the object was last evicted. */
  get openOnWake(): OpenOperation[] { return this.#open; }

  // ---- the model jobs table, which is all the offload port needs -----------

  #startJob(request: unknown): string {
    const id = `mj_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // Durable before it is dispatched: a dispatch that never happens can be
    // retried from the row, but a row that was never written cannot.
    this.#sql.exec("INSERT INTO pi_model_jobs(id, request, created_at) VALUES (?,?,?)",
      id, JSON.stringify(request), (this.#opts.now ?? Date.now)());
    return id;
  }

  /** Separated from #startJob because dispatch is I/O and the port is not. */
  async dispatchPending(limit = 20): Promise<number> {
    const rows = this.#sql
      .exec("SELECT id FROM pi_model_jobs WHERE answer IS NULL ORDER BY created_at LIMIT ?", limit)
      .toArray() as Array<{ id: string }>;
    let sent = 0;
    for (const r of rows) {
      try { await this.#opts.dispatch(String(r.id)); sent += 1; }
      catch { /* the row stays; the next pass tries again */ }
    }
    return sent;
  }

  /** How many model calls are still out. At most one per lane, but counting
   *  is cheaper than asserting it. */
  #unanswered(): number {
    const row = this.#sql
      .exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL").toArray()[0] as any;
    return Number(row?.n ?? 0);
  }

  #pollJob(id: string): AssistantMessage | null {
    const row = this.#sql.exec("SELECT answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as any;
    if (!row?.answer) return null;
    return JSON.parse(row.answer) as AssistantMessage;
  }

  #dropJob(id: string) {
    this.#sql.exec("DELETE FROM pi_model_jobs WHERE id = ?", id);
  }

  /** What the worker asks for. Null once answered, so a redelivered message
   *  does not call the provider twice. */
  takeJob(id: string): unknown | null {
    const row = this.#sql
      .exec("SELECT request, answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as any;
    if (!row || row.answer) return null;
    return JSON.parse(row.request);
  }

  /** The worker's answer. Writing it is what makes the next drive finish. */
  deliver(id: string, answer: AssistantMessage): boolean {
    const row = this.#sql.exec("SELECT answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as any;
    if (!row || row.answer) return false;
    this.#sql.exec("UPDATE pi_model_jobs SET answer = ?, answered_at = ? WHERE id = ?",
      JSON.stringify(answer), (this.#opts.now ?? Date.now)(), id);
    return true;
  }

  // ---- the two things a request handler and an alarm actually do -----------

  /**
   * A person's message. A pure write: durable before anything is answered.
   *
   * Steering means "reach the model before its next call", which is only a
   * thing to do while there is a next call. On an idle lane a steer is a
   * message queued against a run that will never start, and from the page —
   * where every message is sent as a steer, because usually the agent is
   * working — that made the first thing anyone typed vanish silently.
   *
   * So the lane decides, not the caller: join the run in flight if there is
   * one, start a run if there is not. `followUp` is the one mode that means
   * something on an idle lane and is left alone.
   */
  async say(text: string, mode: "prompt" | "steer" | "followUp" = "prompt") {
    if (mode === "followUp") return this.#lane.followUp(text, undefined, CTX);
    // Try to start a run and steer only if the lane says it is already busy,
    // rather than asking first and then acting on the answer. Two requests can
    // arrive at once here — the page has no lock on the agent — and a run
    // beginning between the question and the act would lose the message the
    // same way it was being lost before.
    const started: any = await this.#lane.accept({ kind: "prompt", prompt: text }, CTX);
    if (started?.ok !== false) return started;
    if (LaneBusy.is(started.error)) return this.#lane.steer(text, undefined, CTX);
    return started;
  }

  async compact() {
    return this.#lane.accept({ kind: "compaction" }, CTX);
  }

  /**
   * One pass. Drives every open operation until each either finishes or says it
   * is waiting, then reports when to come back.
   *
   * Nothing loops here waiting for a model: `drive` returns `waiting` and this
   * returns with it, which is exactly the moment the object should stop being
   * active.
   */
  async step(): Promise<StepOutcome> {
    const info = await this.#lane.inspectExecution(CTX);
    const ids = new Set<string>(this.#open.map((o) => o.operationId));
    if (info.current) ids.add(info.current.id);

    const settled: StepOutcome["settled"] = [];
    let wake: number | null = null;
    const now = (this.#opts.now ?? Date.now)();

    // Ask the provider only when there is something to collect.
    //
    // pi records the provider's answer, and "not ready yet" is an answer: ten
    // polls of a call still in flight appended ten messages. That is right for
    // a real batch API, where a poll is the only way to find out. Here the
    // provider is a table in this object, so the question can be settled for
    // free — and a long run stops paying for its own waiting, once in rows and
    // again in every prompt built from them.
    const collect = this.#unanswered() === 0;

    for (const operationId of ids) {
      const res: any = await this.#lane.drive({ operationId, pollDeferred: collect }, CTX);
      const out = res?.value ?? res;
      if (!out || out.kind === undefined) continue;
      if (out.kind === "settled") {
        settled.push({ operationId, status: out.outcome?.status ?? "unknown" });
        continue;
      }
      // waiting: retry has a time, deferred has a poll interval.
      const at = out.reason === "retry"
        ? Math.max(0, Number(out.notBefore ?? now) - now)
        : Number(out.deferred?.pollAfterMs ?? 1_000);
      wake = wake === null ? at : Math.min(wake, at);
    }

    // Jobs that were written but never handed over — a dispatch that failed, or
    // an object evicted between the write and the send.
    await this.dispatchPending();

    this.#open = [];
    const after = await this.#lane.inspectExecution(CTX);
    return {
      open: after.current ? 1 : 0,
      wakeInMs: after.current ? (wake ?? 1_000) : null,
      settled,
    };
  }

  async close() { await this.#harness.close(CTX); }
}
