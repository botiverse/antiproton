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
import { ensureBackgroundTable } from "./background-jobs.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { LaneBusy } from "@earendil-works/pi-agent-core";
import type { AgentHarness as Harness, AgentLane, OpenOperation } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage, ensurePiTables, piTables, type SqlHost, MAIN_SESSION } from "../store/pi-storage.ts";
import { offloadedProvider, type OffloadPort, type Answered } from "../model/pi-offloaded.ts";
import { bridgeTools, type MountedTool, type ToolHost } from "./pi-tools.ts";

const JOBS = `CREATE TABLE IF NOT EXISTS pi_model_jobs (
  id TEXT PRIMARY KEY, request TEXT NOT NULL, answer TEXT,
  created_at INTEGER NOT NULL, answered_at INTEGER, dispatched_at INTEGER)`;

/**
 * How long a dispatched call may be silent before it is assumed lost.
 *
 * It is two things at once, and they have to be the same number. It is how
 * long the sweep waits before sending a job again, and it is how far out the
 * alarm sets itself while a call is in flight — because the only reason to
 * wake at all is that the answer never came.
 *
 * Chosen from both sides. It must be longer than any single completion, or a
 * slow call is reclaimed while it is still running and answered twice at full
 * price; and it must be short enough that a lost message still leaves time to
 * recover inside a caller's patience. The common loss — a row written by an
 * object that was evicted before it could send — does not wait at all: that job
 * has no dispatch recorded, so the next pass sends it.
 */
const REDELIVERY_MS = 120_000;

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
export function ensureAgentTables(sql: SqlHost["sql"], session: string = MAIN_SESSION) {
  ensurePiTables(sql, session);
  sql.exec(JOBS);
  // Objects created before dispatch was written down already have the table.
  try { sql.exec("ALTER TABLE pi_model_jobs ADD COLUMN dispatched_at INTEGER"); }
  catch { /* already there */ }
  // A job belongs to the session that started it, so the answer comes back to
  // the transcript that asked. Rows from before sessions existed are the main
  // session's, which is what the default says.
  try { sql.exec(`ALTER TABLE pi_model_jobs ADD COLUMN session TEXT NOT NULL DEFAULT '${MAIN_SESSION}'`); }
  catch { /* already there */ }
  // Which sessions this object has, so a wake can step the ones with work
  // without opening every transcript. `active` is the last step's verdict.
  sql.exec(`CREATE TABLE IF NOT EXISTS pi_sessions (
    session TEXT PRIMARY KEY, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
  sql.exec("INSERT OR IGNORE INTO pi_sessions(session, created_at) VALUES (?, ?)", session, Date.now());
}

/** Which session a job belongs to, or null if the job is unknown. */
export function jobSession(sql: SqlHost["sql"], jobId: string): string | null {
  const row = sql.exec("SELECT session FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
  return row ? String(row.session) : null;
}

/** The sessions a wake should step: marked active by their last step, or
 *  holding a model call that has not been answered. */
/**
 * Runs that ended failed, with pi's own reason. pi records the outcome of
 * every operation in its values table and writes no transcript entry for a
 * run that failed before its first model call, so such a run is invisible in
 * the transcript unless it is read from here: the message is there, then
 * nothing. Today's example was a configuration failure; the page shows
 * these as "model failed" with the code and message.
 */
export function failedRuns(sql: SqlHost["sql"], session: string = MAIN_SESSION): Array<{ seq: number; operationId: string; code: string; message: string; at: number }> {
  const t = piTables(session);
  const out: Array<{ seq: number; operationId: string; code: string; message: string; at: number }> = [];
  let rows: any[] = [];
  try { rows = sql.exec(`SELECT seq, body FROM ${t.values} WHERE namespace = 'pi.result' ORDER BY seq ASC`).toArray() as any[]; }
  catch { return out; }
  for (const r of rows) {
    let b: any; try { b = JSON.parse(String(r.body)); } catch { continue; }
    if (b?.status !== "failed") continue;
    let at = 0;
    if (b.fromTipId) {
      const e = sql.exec(`SELECT timestamp FROM ${t.entries} WHERE id = ?`, b.fromTipId).toArray()[0] as any;
      at = Number(e?.timestamp ?? 0);
    }
    out.push({ seq: Number(r.seq), operationId: String(b.operationId ?? ""), code: String(b.error?.code ?? "failed"), message: String(b.error?.message ?? ""), at });
  }
  return out;
}

export function sessionsWithWork(sql: SqlHost["sql"]): string[] {
  // A background tool call is work too: its session has to be stepped so the
  // job is checked and its result delivered, even when the lane itself is idle.
  ensureBackgroundTable(sql as any);
  const rows = sql.exec(
    `SELECT session FROM pi_sessions WHERE active = 1
     UNION SELECT session FROM pi_model_jobs WHERE answer IS NULL
     UNION SELECT session FROM background_jobs WHERE state = 'running'`).toArray() as any[];
  return rows.map((r) => String(r.session));
}

export function markSession(sql: SqlHost["sql"], session: string, active: boolean) {
  sql.exec("INSERT INTO pi_sessions(session, created_at, active) VALUES (?, ?, ?)" +
    " ON CONFLICT(session) DO UPDATE SET active = excluded.active", session, Date.now(), active ? 1 : 0);
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
  /**
   * Custom entries to show the model, by customType: pi projects each one into the context it builds
   * (entryProjectors). Anything not named here stays out of the model's context.
   */
  entryProjectors?: Record<string, (entry: { timestamp: number; data?: unknown }) => unknown[] | undefined>;
  sessionId: string;
  /** Whose usage this agent's model replies count as (the usage outbox). Absent: not counted. */
  usageOwner?: { tenantId: string; agentId: string };
  /** Which of the agent's transcripts this is. Absent means the first one,
   *  which keeps the tables it has always had. */
  session?: string;
  systemPrompt: string;
  model: ModelChoice;
  tools: MountedTool[];
  toolHost: ToolHost;
  /** Tools that are not mounts — run_js, whose body is the object itself —
   *  offered beside the bridged ones. They must be here rather than added
   *  after open: open reconciles the names a session remembers against the
   *  list it is given, and a tool added later is a tool the reconcile
   *  removes on every reopen (2026-09-12: every agent lost run_js). */
  extraTools?: ReturnType<typeof bridgeTools>;
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
    const conversation = opts.session ?? MAIN_SESSION;
    ensureAgentTables(opts.host.sql, conversation);
    const storage = new PiSqliteStorage(opts.host, {
      session: conversation, ...(opts.now ? { now: opts.now } : {}), ...(opts.usageOwner ? { usageOwner: opts.usageOwner } : {}),
    });
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
      // What pi tells the caller to wait before asking again. The alarm does
      // not use it — nothing here polls for an answer that is delivered — but
      // it is part of the deferred handle pi hands back, so it is set honestly.
      pollAfterMs: opts.pollAfterMs ?? 1_000,
      id: opts.model.provider,
      models: [{
        id: opts.model.id,
        contextWindow: opts.model.contextWindow,
        ...(opts.model.maxTokens === undefined ? {} : { maxTokens: opts.model.maxTokens }),
      }],
    }));

    const bridged = [...bridgeTools(opts.tools, opts.toolHost), ...(opts.extraTools ?? [])];
    const { harness, open } = await AgentHarness.create({
      session: session as any,
      models,
      model: models.getModel(opts.model.provider, opts.model.id)!,
      systemPrompt: opts.systemPrompt,
      tools: bridged as any,
      // There is no non-deferred path; this makes the intent explicit to pi.
      streamOptions: { deferred: true },
      ...(opts.entryProjectors ? { entryProjectors: opts.entryProjectors as any } : {}),
    }, CTX);

    const lane = await harness.lane(LANE, CTX);
    // pi keeps the names of the tools a session was configured with, and
    // refuses every run whose configured names are not all offered by this
    // process (`configured_tools_unavailable`). The names are ours to choose
    // and they have changed once already (every tool became alias__tool), so a
    // session opened before that change failed silently on every message
    // after it: the message was written, the run was admitted, and it ended
    // failed before the first model call. The current tool list is the truth
    // here; what the session remembers follows it.
    const offered = bridged.map((t) => t.name);
    const remembered = await lane.getActiveTools(CTX);
    const same = remembered.length === offered.length && remembered.every((n) => offered.includes(n));
    if (remembered.length && !same) await lane.setActiveTools(offered, CTX);
    // The same hazard, one field over: pi also remembers which model the
    // session was configured with, and refuses every run whose remembered
    // model this process does not register (`model_unavailable`). One
    // process registers one model — the binding's — so a session opened
    // under an earlier binding (a dated id that has since expired, a model
    // the operator changed) failed on every message afterwards, silently and
    // for ever. The binding is the truth; what the session remembers follows.
    // `getModel` resolves what the session remembers through this process's
    // registry, so `undefined` IS the broken state — the remembered model is
    // one nothing here can run — and a different id is a binding that moved.
    const current = await lane.getModel(CTX);
    if ((current as any)?.id !== opts.model.id) {
      await lane.setModel({ provider: opts.model.provider, modelId: opts.model.id }, CTX);
    }
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
    this.#sql.exec("INSERT INTO pi_model_jobs(id, request, created_at, session) VALUES (?,?,?,?)",
      id, JSON.stringify(request), (this.#opts.now ?? Date.now)(), this.#opts.session ?? MAIN_SESSION);
    return id;
  }

  /**
   * Send the jobs nobody is carrying. Separated from #startJob because dispatch
   * is I/O and the port is not.
   *
   * "Nobody is carrying" is the whole point, and it used to mean "unanswered",
   * which is not the same thing. A call in flight is unanswered for as long as
   * the model takes, so every pass sent it again: fifty-one dispatches for
   * eleven calls in one τ² run. A duplicate is not free — `takeJob` refuses a
   * job only once it has an answer, so a second worker picks up a call still
   * running and asks the provider a second time, and the tokens that answer
   * loses are still billed.
   *
   * So a dispatch is written down, and the sweep only reclaims a job that has
   * been silent longer than a call could plausibly take. That still recovers
   * the case it exists for — a row written by an object that was evicted before
   * it could send, or a queue message that was dropped.
   */
  async dispatchPending(limit = 20): Promise<number> {
    const now = (this.#opts.now ?? Date.now)();
    const rows = this.#sql.exec(
      "SELECT id FROM pi_model_jobs WHERE answer IS NULL AND session = ?" +
      " AND (dispatched_at IS NULL OR dispatched_at < ?) ORDER BY created_at LIMIT ?",
      this.#opts.session ?? MAIN_SESSION, now - REDELIVERY_MS, limit).toArray() as Array<{ id: string }>;
    let sent = 0;
    for (const r of rows) {
      try {
        await this.#opts.dispatch(String(r.id));
        this.#sql.exec("UPDATE pi_model_jobs SET dispatched_at = ? WHERE id = ?", now, r.id);
        sent += 1;
      } catch { /* not marked, so the next pass tries again immediately */ }
    }
    return sent;
  }

  /** How many model calls are still out. At most one per lane, but counting
   *  is cheaper than asserting it. */
  #unanswered(): number {
    const row = this.#sql
      .exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL AND session = ?",
        this.#opts.session ?? MAIN_SESSION).toArray()[0] as any;
    return Number(row?.n ?? 0);
  }

  /**
   * The stored answer to one offloaded model call, or null while it is out.
   *
   * The row is JSON somebody else wrote, so the cast used to be the only thing
   * standing between storage and the harness. It now has to earn one claim:
   * that what comes back is a message that *finished*. `aborted` is a fact
   * about a live stream being cancelled, and nothing on this path can produce
   * it — an abandoned request has no answer to read at all.
   *
   * So a row that says otherwise is not a case to handle, it is an invariant
   * that broke, and it says so loudly rather than travelling on as a message
   * the harness will treat as ordinary. Silence here is how the last two
   * offload failures stayed invisible: written, admitted, and wrong before the
   * model call. The unreachability was established from the records; this is
   * where that claim is checked rather than trusted.
   */
  #pollJob(id: string): Answered | null {
    const row = this.#sql.exec("SELECT answer FROM pi_model_jobs WHERE id = ?", id).toArray()[0] as any;
    if (!row?.answer) return null;
    const message = JSON.parse(row.answer) as AssistantMessage;
    if (message.stopReason === "aborted") {
      throw new Error(
        `the stored answer for ${id} says "aborted", which nothing that writes this row can produce; ` +
        "something upstream is passing a cancelled stream through as an answer",
      );
    }
    return message as Answered;
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

  /**
   * Cancel the run in flight. pi's abort ends it and drops its outstanding
   * model call, so a late answer is never applied, but it appends nothing —
   * so a `marker` custom entry naming the run is written, for whoever needs to
   * tell a cancelled turn from one not yet started. The marker reaches the
   * model only if `entryProjectors` names it. Null when nothing was running.
   *
   * Depends on: @earendil-works/pi-agent-core 0.85.1 — lane.abort ends the run, drops the offloaded job
   *   and appends no entry (measured). When pi is upgraded, re-check with test/pi-agent.ts.
   */
  async cancel(marker: string): Promise<string | null> {
    const aborted: any = await this.#lane.abort(CTX);
    if (!aborted?.ok) return null;
    const operationId = String(aborted.value.operationId);
    await this.#lane.appendCustomEntry(marker, { operationId }, CTX);
    return operationId;
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
      // waiting: retry has a time, deferred has a poll interval — and the poll
      // interval is the wrong number here. It is meant for a provider batch API,
      // where asking is the only way to find out. Our answer is delivered: the
      // worker writes it and wakes the object in the same breath. Waking every
      // second to ask a question we will be told the answer to was 55 alarm
      // passes for 11 model calls, all of them billed. What is left is a safety
      // net for an answer that never arrives at all.
      const at = out.reason === "retry"
        ? Math.max(0, Number(out.notBefore ?? now) - now)
        : REDELIVERY_MS;
      wake = wake === null ? at : Math.min(wake, at);
    }

    // Jobs that were written but never handed over — a dispatch that failed, or
    // an object evicted between the write and the send.
    await this.dispatchPending();

    this.#open = [];
    const after = await this.#lane.inspectExecution(CTX);
    return {
      open: after.current ? 1 : 0,
      wakeInMs: after.current ? (wake ?? REDELIVERY_MS) : null,
      settled,
    };
  }

  async close() { await this.#harness.close(CTX); }
}
