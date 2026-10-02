/**
 * The `pd` engine: one agent's conversation on pi-durable's harness, behind the
 * same `AgentEngine` interface as `PiAgent` (src/runtime/pi-agent.ts).
 *
 * The split of work is PiAgent's — the object owns state, the alarm owns time,
 * the queue owns the model call — but pi-durable carries it differently:
 *
 * - There is no `drive()` returning `waiting`. A generation that is handed a
 *   deferred answer commits a `poll` checkpoint and sleeps in-process until
 *   `pollAt`. `step()` resumes the harness and runs `settle()`
 *   (src/runtime/durable-drive.ts) until the harness is idle or only sleeping —
 *   which the vendored scheduler reports itself (src/vendor/pi/pi-durable/) —
 *   closes it, and returns the sleep's end as `wakeInMs`. A parked object has
 *   no harness open and no timer alive.
 * - The model call is the offloaded provider on pi-ai 1.0
 *   (src/model/durable-offloaded.ts). Its port writes `ap_model_jobs`
 *   (src/store/ap-store.ts) instead of `pi_model_jobs`, and the worker reads and
 *   answers that row through `takeJob` and `deliver` here. A job id with no row
 *   is the runtime's `UnknownJob` (cf/src/model-queue.ts), handed in as
 *   `unknownJob` because src/ does not import cf/.
 * - pi-durable keeps one session per storage, so one harness serves the whole
 *   object. `PdHost` is that harness and what it is opened with; the runtime
 *   keeps one per object, and a `DurableAgent` is one conversation's view of it.
 *   Two `DurableAgent`s — two sessions, or the same one rebuilt after the
 *   catalogue changed — share the harness, the step in flight and the job
 *   table. Two harnesses on one storage would run the same task twice.
 * - The usage and trace outbox rows that pi 0.85 writes inside its commit are
 *   derived here after each pi-durable commit and at the end of every step
 *   (`deriveOutbox`, src/runtime/pd-outbox.ts), rows and watermark in one unit.
 * - A function the Agents API caller runs itself is a tool that records its call
 *   in `ap_client_calls` and waits in-process for the answer (`clientTool`,
 *   src/runtime/durable-tools.ts). A harness whose only pending work is such a wait
 *   closes with no alarm; `answerClientCalls` hands the answer to the waiting tool
 *   when it is open in this isolate, and otherwise resumes the harness, whose replay
 *   of the tool finds it in the row.
 * - A cancel aborts the conversation (pi-durable cancels a polling generation's job
 *   through the provider's port, `#dropJob`) and appends the marker as an entry of
 *   its own kind whose model message is the note the runtime names for it
 *   (`markerNotes`): what pi085's entry projector shows the model for its marker.
 *
 * Our writes are plain statements: each pi-durable commit is one synchronous
 * transaction (src/store/pi-durable-sqlite.ts), so none of ours can land
 * inside one.
 *
 * Only pi-ai 1.0 (`pi-ai-1`) is imported here. What crosses to the 0.85 side —
 * a job's request, an answer, a projected entry — crosses as JSON.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import {
  AgentDoc, createRegistry, GenerationTask, LiveDoc, ROOT_CONVERSATION_ID, ToolTask,
  type Conversation, type ConversationId, type EntryRecord, type HarnessInspection,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
// The vendored Harness: pi-durable 1.0.0's with a scheduler that reports a sleeping task (`sleepingUntil`).
import { Harness } from "../vendor/pi/pi-durable/dist/harness/harness.js";
import { createModels } from "pi-ai-1/models";
import { durableOffloadedProvider, readAnswer, type Answered, type ModelJobRequest } from "../model/durable-offloaded.ts";
import type { AnsweredMessage } from "../model/pi-bridge.ts";
import { ApStore, type ApSqlHost } from "../store/ap-store.ts";
import { derivePdOutbox, type DerivePass } from "./pd-outbox.ts";
import { logEvent } from "../core/log.ts";
import { PiDurableSqlite, type DurableSqlHost } from "../store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../store/sql-namespace.ts";
import { settle, type ExternalWaits, type SettleResult } from "./durable-drive.ts";
import { toolsExtension, type ClientAnswer, type ClientToolDef } from "./durable-tools.ts";
import { bridgeTools, type InterruptKeeping, type MountedTool, type ToolHost } from "./pi-tools.ts";
import { projectEntries } from "./pd-transcript.ts";
import { CompactionUnavailable, type AgentEngine, type EngineEntry, type EngineEntryScan, type EngineStatus, type StepOutcome } from "./engine.ts";

const PD = prefixedNamespace("pd");
const AP = prefixedNamespace("ap");

/** Which session is the agent's first one; its conversation is pi-durable's root. Same string as pi-storage's MAIN_SESSION. */
const MAIN_SESSION = "main";

/**
 * How long a dispatched call may be silent before the sweep sends it again. PiAgent's
 * `REDELIVERY_MS`, for the same reasons: longer than any completion, shorter than a caller's patience.
 */
const REDELIVERY_MS = 120_000;

/**
 * The poll interval: 2 s for the first look, doubling to 30 s. pi-durable fixes `pollAt` in the
 * checkpoint when a poll comes back not ready, so a delivered answer cannot shorten a sleep already
 * committed; a short first interval keeps a quick answer quick, and the doubling keeps a slow call
 * from costing a wake every two seconds.
 */
export const DEFAULT_POLL = { firstMs: 2_000, maxMs: 30_000 } as const;

/** How long one `step()` keeps the harness open waiting for work that is neither idle nor sleeping. */
const STEP_DEADLINE_MS = 30_000;

/** The bound model, as the provider registers it. */
export type PdModel = { provider: string; id: string; contextWindow: number; maxTokens?: number };

export interface PdHostOptions {
  /** The object's storage: `ctx.storage` on a Durable Object, `sqliteHost()` under node. */
  storage: DurableSqlHost;
  now?: () => number;
  poll?: { firstMs: number; maxMs: number };
  /** A sleeper due sooner than this is waited for in-process instead of parked (settle's `minParkMs`). */
  minParkMs?: number;
  stepDeadlineMs?: number;
  /** Each provider poll of a job, and whether it found the answer. For tests and traces. */
  onPoll?: (jobId: string, ready: boolean) => void;
  /** A test seam into the outbox pass (src/runtime/pd-outbox.ts, `DeriveContext.fault`). */
  outboxFault?: (stage: "appended") => void;
  /** Each outbox pass that completed, with what it derived and how it compared with `pi.usage`. For tests. */
  onOutboxPass?: (pass: DerivePass) => void;
}

/** What binds a host to the one agent it serves. */
export interface PdBinding {
  tenantId: string;
  agentId: string;
  model: PdModel;
  /** Hand a written job to whatever performs it. Failure is not fatal: the row is durable and the sweep re-sends it. */
  dispatch(jobId: string): Promise<void>;
  /** The error for a job id with no row: the runtime's `UnknownJob`. */
  unknownJob(jobId: string): Error;
  /**
   * Build the agent for a session whose tools are not installed in this isolate yet: the runtime's
   * `agent()` for it, which opens a `DurableAgent` and so installs them. The one harness runs every
   * session's tasks, so before it is resumed every listed session must have its tools — a tool task of
   * a session nobody opened would otherwise resolve no tool and write "not available" as the result.
   * Absent (a test with one session): nothing is opened.
   */
  openSession?(session: string): Promise<unknown>;
}

/**
 * The object's one pi-durable harness, opened on demand and closed whenever it parks, and the
 * `ap_model_jobs` table its provider's port writes.
 */
export class PdHost {
  readonly #opts: PdHostOptions;
  readonly #now: () => number;
  readonly #models = createModels();
  readonly #registry = createRegistry();
  #binding: PdBinding | null = null;
  #harness: Promise<Harness> | null = null;
  #driving: Promise<SettleResult> | null = null;
  #conversations = new Map<string, Promise<ConversationId>>();
  /** Sessions whose tools are installed in the registry, this isolate. */
  readonly #installed = new Set<string>();
  /** The `ap` tables. */
  readonly #ap: ApStore;
  #ensured = false;
  /** The outbox pass in flight, and whether a commit landed after it read: then it runs once more. */
  #deriving: Promise<DerivePass | null> | null = null;
  #deriveAgain = false;
  /** Client tools waiting in this isolate, by `conversation:call`: each is told to read its row again. */
  readonly #clientWaiters = new Map<string, Set<() => void>>();
  /** Told when a client call's row moves: what `settle` reads as `externalWaits` changed without a pd commit. */
  readonly #clientListeners = new Set<() => void>();

  constructor(opts: PdHostOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#ap = new ApStore(opts.storage, AP);
  }

  get now(): number { return this.#now(); }

  /**
   * One agent per object, the invariant AgentDO rests on (cf/src/index.ts, `benchStart`): the
   * provider's port is not told which conversation a job belongs to, so a job's dispatch can name
   * only the one agent the object serves. A bench object that hosts each task's agent in turn is
   * the one exception, and making pd serve it is the bench wiring's.
   */
  bind(binding: PdBinding): void {
    const was = this.#binding;
    if (was && (was.tenantId !== binding.tenantId || was.agentId !== binding.agentId)) {
      throw new Error(`the pd engine serves one agent per object: this one is ${was.tenantId}/${was.agentId}, ` +
        `not ${binding.tenantId}/${binding.agentId} (an object reused across agents is not supported yet, step 10)`);
    }
    this.#binding = binding;
    const poll = this.#opts.poll ?? DEFAULT_POLL;
    // Registered again on every bind: the binding's model is the truth, as PiAgent's `open` treats it.
    this.#models.setProvider(durableOffloadedProvider({
      port: {
        start: (request) => this.#startJob(request),
        poll: (id) => this.#pollJob(id),
        cancel: (id) => this.#dropJob(id),
      },
      id: binding.model.provider,
      pollAfterMs: poll.firstMs,
      maxPollAfterMs: poll.maxMs,
      models: [{
        id: binding.model.id, contextWindow: binding.model.contextWindow,
        ...(binding.model.maxTokens === undefined ? {} : { maxTokens: binding.model.maxTokens }),
      }],
    }));
  }

  #bound(): PdBinding {
    if (!this.#binding) throw new Error("the pd host is not bound to an agent");
    return this.#binding;
  }

  // ---- tools ----------------------------------------------------------------

  /**
   * A session's tools, installed under its own extension name, which its conversation selects
   * (`DurableAgent.#conversation`). Installing again replaces the extension in place: the catalogue
   * moved, or the runtime rebuilt the agent.
   */
  installTools(session: string, tools: Parameters<typeof toolsExtension>[1], clientTools: readonly ClientToolDef[] = []): string {
    const name = toolsExtensionName(session);
    this.#registry.install(toolsExtension(name, tools,
      clientTools.length ? { defs: clientTools, port: { answer: (call, signal) => this.#clientAnswer(call, signal) } } : undefined));
    this.#installed.add(session);
    return name;
  }

  extension(session: string) { return this.#registry.snapshot().extension(toolsExtensionName(session)); }

  /** Every listed session has its tools before anything runs their tasks (`PdBinding.openSession`). */
  async ensureSessions(): Promise<void> {
    const open = this.#binding?.openSession;
    if (!open) return;
    const listed = (await this.#store()).query("SELECT task_id FROM conversations ORDER BY created_at")
      .map((r) => String(r.task_id));
    for (const session of listed) if (!this.#installed.has(session)) await open(session);
  }

  /** The `ap` store, its tables made on first use. */
  async #store(): Promise<ApStore> {
    if (!this.#ensured) { this.#ap.ensure(); this.#ensured = true; }
    return this.#ap;
  }

  // ---- the harness ------------------------------------------------------------

  /** The open harness, opening one if none is. Opening runs no task: only `resume()` (or a submit) starts the scheduler. */
  harness(): Promise<Harness> {
    if (this.#harness) return this.#harness;
    const opening = (async () => {
      const db = new PiDurableSqlite(this.#opts.storage, PD);
      const h = await Harness.open(this.#noticingCommits(await SqliteStorage.open(db)), {
        models: this.#models,
        registry: this.#registry,
        settings: {
          stream: { deferred: true },
          // pi-durable's compaction calls the model without `deferred` (harness/compaction.js strips it), and
          // this provider answers nothing else, so a compaction could only fail. Off until a step makes it work.
          compaction: { enabled: false },
        },
        now: this.#now,
        // No `onSleep`: every sleep this harness runs (pi-durable's generation poll and retry; the registry holds
        // only tool extensions, and a tool cannot sleep) starts right after the commit of its checkpoint, and the
        // read that commit brings already sees it. settle's 1 s recheck is the backstop if that ever changes.
      }, bg);
      // Settle closes the harness when it parks; whoever asks next opens a fresh one.
      h.subscribeClose(() => {
        if (this.#harness === opening) this.#harness = null;
      });
      return h;
    })();
    this.#harness = opening;
    opening.catch(() => { if (this.#harness === opening) this.#harness = null; });
    return opening;
  }

  /**
   * The storage the harness commits through, telling the outbox about each commit once it has resolved.
   * The Harness does not expose its Session's `subscribeCommits`, and pi-durable's every commit goes
   * through `Storage.commit`, so this is the same notice one layer down. The pass it starts is not awaited
   * here.
   */
  #noticingCommits(storage: SqliteStorage): SqliteStorage {
    return new Proxy(storage, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (key !== "commit") return value.bind(target);
        return async (...args: unknown[]) => {
          const seq = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          void this.deriveOutbox();
          return seq;
        };
      },
    });
  }

  // ---- the usage and trace outboxes --------------------------------------------

  /**
   * Derive the usage and trace rows for everything pi-durable has committed since the last pass
   * (src/runtime/pd-outbox.ts): one `ApStore.unit`, rows and watermark together. Calls that arrive
   * while a pass runs share one further pass, which starts after it, so a commit that landed during a
   * pass is never left for the next wake. Resolves to the last pass; null when the host is not bound
   * to an agent yet (whose rows these would be is not known, so nothing is derived and the mark stays).
   *
   * A failure is logged and resolves to null rather than failing the step that asked: the mark did not
   * move, so the next pass derives the same rows.
   */
  deriveOutbox(): Promise<DerivePass | null> {
    if (this.#deriving) { this.#deriveAgain = true; return this.#deriving; }
    this.#deriving = (async () => {
      for (;;) {
        this.#deriveAgain = false;
        const last = await this.#derivePass();
        // Released in the same turn as the check, so a call arriving after it starts a pass of its own
        // instead of joining one that has already decided to end. Only one loop runs at a time, so the
        // promise being released is this one.
        if (!this.#deriveAgain) { this.#deriving = null; return last; }
      }
    })();
    return this.#deriving;
  }

  async #derivePass(): Promise<DerivePass | null> {
    const binding = this.#binding;
    if (!binding) return null;
    const owner = { tenantId: binding.tenantId, agentId: binding.agentId };
    try {
      const ap = await this.#store();
      const pass = ap.unit((tables) => derivePdOutbox(this.#opts.storage.sql, tables, {
        owner, pd: PD, ap: AP, now: this.#now(),
        ...(this.#opts.outboxFault ? { fault: this.#opts.outboxFault } : {}),
      }));
      this.#opts.onOutboxPass?.(pass);
      return pass;
    } catch (error) {
      logEvent("pd.outbox.error", { ...owner, error: String((error as Error)?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  /** Run `fn` on the open harness; if that harness closed under it (a park), once more on a fresh one. */
  async withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
    const first = this.harness();
    const h = await first;
    try { return await fn(h); }
    catch (error) {
      if (this.#harness === first) throw error;
      return fn(await this.harness());
    }
  }

  async close(): Promise<void> {
    const open = this.#harness;
    if (!open) return;
    const h = await open.catch(() => null);
    if (h) await h.close(bg);
    if (this.#harness === open) this.#harness = null;
  }

  /** Whether a harness is open in this isolate: what "no live timers" asks of a parked object. */
  get open(): boolean { return this.#harness !== null; }

  /**
   * The conversation a session is held in, made on first use. `main` is pi-durable's root
   * conversation; any other session is an ownerless conversation of its own. The ap `conversations`
   * row is the directory. Made one at a time, so two first uses of a session make one conversation.
   */
  conversation(session: string): Promise<ConversationId> {
    const known = this.#conversations.get(session);
    if (known) return known;
    const made = (async () => {
      const ap = await this.#store();
      const listed = ap.conversation(session);
      if (listed) return listed.conversationId as ConversationId;
      const { tenantId, agentId } = this.#bound();
      // Not atomic with the row below: a crash between them leaves a conversation nothing lists, and the
      // next first use makes another. It holds no input yet, so nothing is lost.
      const id = await this.withHarness(async (h) =>
        session === MAIN_SESSION
          ? (await h.root(bg)).id
          : (await h.createConversation({ ownership: { kind: "ownerless" } }, bg)).id);
      const row = ap.openConversation({ taskId: session, tenantId, agentId, conversationId: id, createdAt: this.#now() });
      return row.conversationId as ConversationId;
    })();
    this.#conversations.set(session, made);
    made.catch(() => this.#conversations.delete(session));
    return made;
  }

  async handle(h: Harness, id: ConversationId): Promise<Conversation> {
    const c = id === ROOT_CONVERSATION_ID ? await h.root(bg) : await h.conversation(id, bg);
    if (!c) throw new Error(`pi-durable conversation ${id} is listed in ap_conversations but does not exist`);
    return c;
  }

  /**
   * Resume and settle the harness: one pass for every conversation, since they share it. A second
   * call while one is in flight joins it rather than starting another, which would be a second
   * settle reading and closing the same harness.
   */
  drive(): Promise<SettleResult> {
    if (this.#driving) return this.#driving;
    const driving = (async () => {
      await this.#sweep();
      await this.ensureSessions();
      const ap = await this.#store();
      const h = await this.harness();
      h.resume();
      return settle(h, {
        context: bg, now: this.#now,
        externalWaits: () => externalWaitsOf(ap),
        subscribe: (wake) => { this.#clientListeners.add(wake); return () => this.#clientListeners.delete(wake); },
        ...(this.#opts.minParkMs === undefined ? {} : { minParkMs: this.#opts.minParkMs }),
        deadlineMs: this.#opts.stepDeadlineMs ?? STEP_DEADLINE_MS,
      });
    })();
    this.#driving = driving;
    // Cleared on failure too: a pass that rejected and stayed here would be handed to every later step,
    // and the object would never move again. The identity check is defensive — no newer pass can start
    // while this one is set, since `drive()` returns it — so it guards a future refactor, not a live race.
    const clear = () => { if (this.#driving === driving) this.#driving = null; };
    driving.then(clear, clear);
    return driving;
  }

  // ---- ap_client_calls: functions the API caller runs ---------------------------

  /** The `ap` store, for the client-call reads and writes `DurableAgent` makes. */
  store(): Promise<ApStore> { return this.#store(); }

  /**
   * A client tool's call (`ClientCallPort.answer`): record it as waiting unless answered already, then wait in-process
   * until a row read says answered. The waiter is registered before each read, so an answer written between the read
   * and the wait is not missed. An abort (a close, a cancel) rejects and records nothing: the row stays `pending`, and a
   * replay of the call waits on it again.
   */
  async #clientAnswer(call: { conversationId: number; callId: string; name: string; arguments: string }, signal: AbortSignal | undefined): Promise<ClientAnswer> {
    const ap = await this.#store();
    const key = `${call.conversationId}:${call.callId}`;
    // `told` covers an answer that lands between a read and the wait: the wait is then skipped and the row read again.
    let told = false;
    let poke: () => void = () => {};
    const waiters = this.#clientWaiters.get(key) ?? new Set();
    this.#clientWaiters.set(key, waiters);
    const listener = () => { told = true; poke(); };
    waiters.add(listener);
    try {
      let row = ap.recordClientCall({ ...call, at: this.#now() });
      this.#notifyClientCalls();
      for (;;) {
        signal?.throwIfAborted();
        if (row.state !== "pending") {
          if (row.state === "answered") ap.useClientCall(call.conversationId, call.callId);
          return { output: row.output ?? "", isError: row.isError };
        }
        if (!told) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { poke = () => {}; reject(signal!.reason); };
            poke = () => { poke = () => {}; signal?.removeEventListener("abort", abort); resolve(); };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        told = false;
        row = ap.clientCall(call.conversationId, call.callId) ?? row;
        // A row dropped under the wait (a cancel) leaves the last one read, still pending: the abort that follows ends it.
      }
    } finally {
      waiters.delete(listener);
      if (waiters.size === 0) this.#clientWaiters.delete(key);
    }
  }

  #notifyClientCalls(): void { for (const l of [...this.#clientListeners]) l(); }

  /**
   * The caller's results for a conversation's calls. Each is written to its row; a tool waiting for it in this isolate
   * is told, and returns it at once. Returns the call ids nobody here was waiting on: their tools are parked or have not
   * run yet, and a resumed harness finds the answer in the row.
   */
  async answerClientCalls(conversationId: number, results: ReadonlyArray<{ callId: string; output: string; isError: boolean }>): Promise<{ accepted: string[]; notWaiting: string[] }> {
    const ap = await this.#store();
    const accepted: string[] = [];
    const notWaiting: string[] = [];
    for (const r of results) {
      if (!ap.answerClientCall(conversationId, r.callId, { output: r.output, isError: r.isError }, this.#now())) continue;
      accepted.push(r.callId);
      const waiters = this.#clientWaiters.get(`${conversationId}:${r.callId}`);
      if (waiters?.size) for (const w of [...waiters]) w();
      else notWaiting.push(r.callId);
    }
    this.#notifyClientCalls();
    return { accepted, notWaiting };
  }

  // ---- ap_model_jobs: the provider's port, and the worker's side -----------------

  async #startJob(request: ModelJobRequest): Promise<string> {
    const id = `mj_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // Durable before it is dispatched, as in PiAgent: a dispatch can be retried from the row.
    (await this.#store()).query(
      "INSERT INTO model_jobs (id, conversation_id, request, created_at) VALUES (?, NULL, ?, ?)",
      id, JSON.stringify(request), this.#now());
    await this.#dispatch(id);
    return id;
  }

  async #dispatch(id: string): Promise<boolean> {
    try { await this.#bound().dispatch(id); }
    catch { return false; /* not marked, so the next sweep sends it */ }
    (await this.#store()).query("UPDATE model_jobs SET dispatched_at = ? WHERE id = ?", this.#now(), id);
    return true;
  }

  /** Jobs nobody is carrying: never dispatched, or silent longer than a call could take. */
  async #sweep(limit = 20): Promise<number> {
    if (!this.#binding) return 0;
    const now = this.#now();
    const ids = (await this.#store()).query(
      "SELECT id FROM model_jobs WHERE answer IS NULL AND (dispatched_at IS NULL OR dispatched_at < ?) ORDER BY created_at LIMIT ?",
      now - REDELIVERY_MS, limit).map((r) => String(r.id));
    let sent = 0;
    for (const id of ids) if (await this.#dispatch(id)) sent++;
    return sent;
  }

  async #pollJob(id: string): Promise<Answered | null> {
    const [row] = (await this.#store()).query("SELECT answer FROM model_jobs WHERE id = ?", id);
    const answer = row?.answer;
    this.#opts.onPoll?.(id, typeof answer === "string");
    // `readAnswer` refuses what nothing that writes this row can produce (a stored `aborted`, a non-assistant).
    return typeof answer === "string" ? readAnswer(answer) : null;
  }

  /** pi-durable cancels a polling generation's job when the generation is aborted; a late answer then has no row. */
  async #dropJob(id: string): Promise<void> {
    (await this.#store()).query("DELETE FROM model_jobs WHERE id = ?", id);
  }

  /** The worker's question: the request, or null once answered so a redelivered message does not call twice. */
  async takeJob(id: string): Promise<unknown> {
    const [row] = (await this.#store()).query("SELECT request, answer FROM model_jobs WHERE id = ?", id);
    if (!row) throw this.#bound().unknownJob(id);
    return row.answer === null ? JSON.parse(String(row.request)) : null;
  }

  /** The worker's answer. False when one is already in. Writing it is what the next poll reads. */
  async deliver(id: string, answer: AnsweredMessage): Promise<boolean> {
    const json = JSON.stringify(answer);
    const now = this.#now();
    const ap = await this.#store();
    // One statement decides it, so two deliveries cannot both see the row unanswered.
    const won = ap.query("UPDATE model_jobs SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL RETURNING id", json, now, id);
    if (won.length > 0) return true;
    if (ap.query("SELECT 1 AS found FROM model_jobs WHERE id = ?", id).length === 0) throw this.#bound().unknownJob(id);
    return false;
  }
}

export interface DurableAgentOptions extends PdBinding {
  host: PdHost;
  /** Which of the agent's transcripts this is. Absent: the first. */
  session?: string;
  systemPrompt: string;
  /** PiAgent's four tool options, meaning the same: the runtime hands both engines one catalogue (cf/src/runtime.ts `agent()`). */
  tools?: MountedTool[];
  toolHost?: ToolHost;
  interrupts?: InterruptKeeping;
  extraTools?: ReturnType<typeof bridgeTools>;
  /** Functions the Agents API caller runs itself, offered after every other tool (pi085's `clientTools`). */
  clientTools?: ClientToolDef[];
  /**
   * What the model is shown where a marker entry of a kind is written (`cancel`, `markCancelled`): pi085's
   * `entryProjectors` for the same kinds, as text. A kind not named carries no model message.
   */
  markerNotes?: Record<string, string>;
}

/** The extension holding a session's tools. */
export const toolsExtensionName = (session: string) => `ap.tools:${session}`;

/** Every call a client tool recorded and the caller has not answered, by conversation (`DriveSnapshot.externalWaits`). */
function externalWaitsOf(ap: ApStore): ExternalWaits {
  const out = new Map<ConversationId, Set<string>>();
  for (const c of ap.pendingClientCalls()) {
    if (c.name === "") continue;
    const id = c.conversationId as ConversationId;
    const set = out.get(id) ?? new Set<string>();
    set.add(c.callId);
    out.set(id, set);
  }
  return out;
}

/**
 * The active entries with their context edits applied, as pi-durable derives the model's context from them
 * (harness/context.js `deriveContext`, @earendil-works/pi-durable 1.0.0: the newest edit of a target wins): an omitted
 * entry is left out, a replaced one carries its replacement. What `branch()` shows is then what the model is sent.
 */
function withEdits(entries: readonly EntryRecord[]): EntryRecord[] {
  const edits = new Map<string, NonNullable<EntryRecord["edits"]>[number]>();
  for (const e of entries) for (const edit of e.edits ?? []) edits.set(String(edit.target), edit);
  if (edits.size === 0) return [...entries];
  return entries.flatMap((e) => {
    const edit = edits.get(String(e.id));
    if (edit?.action === "omit") return [];
    return edit?.action === "replace" ? [{ ...e, model: edit.messages }] : [e];
  });
}

const GENERATION_KIND = GenerationTask.definition.name;
const TOOL_KIND = ToolTask.definition.name;

/**
 * Whether a conversation has work under way: a live task of it that is neither waiting on other tasks nor a tool
 * waiting for the API caller. A turn whose only pending work is the caller's functions is not running — pi085's run
 * ended at that pause too — so the Agents API reports it as requiring action (cf/src/index.ts `apiSessionStatus`).
 */
function runningIn(inspection: HarnessInspection, id: ConversationId, external: ExternalWaits): boolean {
  const waits = external.get(id);
  return inspection.tasks.some((t) => {
    if (t.record.conversationId !== id) return false;
    if (t.state.kind === "waiting" && t.record.kind === GENERATION_KIND) return false;
    const callId = (t.record.input as { callId?: unknown } | null)?.callId;
    if (t.record.kind === TOOL_KIND && typeof callId === "string" && waits?.has(callId) && !t.record.abortRequested) return false;
    return true;
  });
}

/** The `pd` engine for one session. */
export class DurableAgent implements AgentEngine {
  readonly #opts: DurableAgentOptions;
  readonly #host: PdHost;
  readonly #session: string;

  private constructor(opts: DurableAgentOptions) {
    this.#opts = opts;
    this.#host = opts.host;
    this.#session = opts.session ?? MAIN_SESSION;
  }

  /** Binds the host to this agent and its model. Opens nothing: the harness opens on first use. */
  static open(opts: DurableAgentOptions): DurableAgent {
    opts.host.bind(opts);
    // pi085's list, in pi085's order: the bridged mounts, then run_js, resume, jobs (PiAgent.open).
    const bridged = [
      ...(opts.tools && opts.toolHost ? bridgeTools(opts.tools, opts.toolHost, opts.interrupts) : []),
      ...(opts.extraTools ?? []),
    ];
    opts.host.installTools(opts.session ?? MAIN_SESSION, bridged, opts.clientTools ?? []);
    return new DurableAgent(opts);
  }

  get host(): PdHost { return this.#host; }

  /**
   * This session's conversation, configured with the current model, prompt and tools (each written
   * only when it moved). The tools are selected by extension: exactly this session's, so another
   * session's — installed in the same registry — are never offered here.
   */
  async #conversation(h: Harness): Promise<Conversation> {
    const c = await this.#host.handle(h, await this.#host.conversation(this.#session));
    const agent = await c.agent(bg);
    const model = { provider: this.#opts.model.provider, modelId: this.#opts.model.id };
    const moved = agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId;
    const prompt = agent.instructions !== this.#opts.systemPrompt;
    const own = this.#host.extension(this.#session);
    // The stored choice, not the resolved one: an unset choice resolves to every installed extension,
    // which is this session's alone only while nothing else is installed — and then reads as chosen.
    const stored = (await h.snapshot(AgentDoc, c.id, bg))?.extensions;
    const tools = own !== undefined && !(Array.isArray(stored) && stored.length === 1 && stored[0] === own.name);
    if (moved || prompt || tools) {
      await c.configure({
        ...(moved ? { model } : {}),
        ...(prompt ? { instructions: this.#opts.systemPrompt } : {}),
        ...(tools ? { extensions: [own] } : {}),
      }, bg);
    }
    return c;
  }

  /**
   * Durable before it returns. pi-durable decides as PiAgent's `say` does: an idle conversation starts
   * a run, a busy one keeps the input for the run's next boundary — `steer` for a prompt or a steer,
   * `followUp` for a follow-up. Submitting starts the scheduler, so the run is under way in this
   * isolate; the wake the caller sets runs `step()`, which settles and parks it.
   */
  async say(text: string, mode: "prompt" | "steer" | "followUp" = "prompt") {
    // One id for this message, kept across `withHarness`'s retry. A harness that closes while the input
    // is being admitted still completes the admitted commit, so the input can be durable when the call
    // fails ("Session is closed" from `status`); the retry then finds it by this id (pi-durable dedupes
    // a submission per conversation and request id) instead of submitting it a second time.
    const requestId = `say:${crypto.randomUUID()}`;
    // Submitting starts the scheduler, which runs every session's tasks.
    await this.#host.ensureSessions();
    const ap = await this.#host.store();
    return this.#host.withHarness(async (h) => {
      const c = await this.#conversation(h);
      await this.#leaveCallerWait(h, c, ap);
      const submission = await c.submit({ type: "input", content: text, whenBusy: mode === "followUp" ? "followUp" : "steer", requestId }, bg);
      const record = await submission.status(bg);
      // `messageLanded` (cf/src/runtime.ts) reads an operation id as "a run started".
      return record.status === "placed"
        ? { ok: true, value: { operationId: String(submission.id) } }
        : { ok: true, value: { entryId: null, submissionId: String(submission.id) } };
    });
  }

  /**
   * Input while the turn waits only on the API caller. pi085's run had ended at that pause, its calls holding the
   * placeholder result, so the input starts a new turn at once and the calls stay waiting; an answer that comes later
   * goes back to the call (`resumeClientCalls`). Here the waiting tools are the run, and input would queue behind
   * them until the caller answered. So the run is aborted first — the tools' results become "aborted", which
   * `pi085ClientAborted` shows as pi085's placeholder — and the rows stay `pending`: the same state pi085 is in.
   */
  async #leaveCallerWait(h: Harness, c: Conversation, ap: ApStore): Promise<void> {
    if (ap.pendingClientCalls(c.id).every((r) => r.name === "")) return;
    const inspection = await h.inspect(bg);
    const live = inspection.tasks.some((t) => t.record.conversationId === c.id && !t.record.background);
    if (!live || runningIn(inspection, c.id, externalWaitsOf(ap))) return;
    await c.abort(bg);
  }

  /**
   * Cancel this conversation's run: pi-durable's abort withdraws queued input, aborts every live task of it and waits
   * until it is idle — a polling generation cancels its job through the provider's port (`#dropJob`), a running tool
   * is signalled and its result is "aborted", a client tool's wait ends — and then the `marker` entry is appended,
   * naming the run's task. Null, and nothing written, when nothing was running. pi085's `cancel` does the same with
   * `lane.abort` and a custom entry; the difference is that pi085's marker reaches the model through an entry
   * projector, and this one carries its model message in the entry (`markerNotes`).
   */
  async cancel(marker: string): Promise<string | null> {
    const id = await this.#host.conversation(this.#session);
    // Aborting runs the abort handlers, so it starts the scheduler, which runs every session's tasks.
    await this.#host.ensureSessions();
    return this.#host.withHarness(async (h) => {
      const live = await h.snapshot(LiveDoc, id, bg);
      const tasks = (await h.inspect(bg)).tasks.filter((t) => t.record.conversationId === id && !t.record.background);
      if (live?.run === undefined && tasks.length === 0) return null;
      const operationId = String(live?.run?.taskId ?? tasks[0]!.record.id);
      const c = await this.#host.handle(h, id);
      await c.abort(bg);
      await this.#appendMarker(c, marker, operationId);
      return operationId;
    });
  }

  /** The marker for a turn that ended with no run to abort. pi085's `markCancelled`. */
  async markCancelled(marker: string): Promise<void> {
    const id = await this.#host.conversation(this.#session);
    await this.#host.withHarness(async (h) => this.#appendMarker(await this.#host.handle(h, id), marker, null));
  }

  async #appendMarker(c: Conversation, marker: string, operationId: string | null): Promise<void> {
    const note = this.#opts.markerNotes?.[marker];
    const at = this.#host.now;
    await c.commit(async (tx) => {
      await tx.appendEntry(c.id, {
        kind: marker,
        ...(note === undefined ? {} : { model: [{ role: "user", content: [{ type: "text", text: note }], timestamp: at }] }),
        data: { operationId, at },
      });
    }, bg);
  }

  compact(): Promise<unknown> {
    // No step owns this yet: see `compaction: { enabled: false }` in PdHost.harness for why it cannot work today.
    return Promise.reject(new CompactionUnavailable("compact is not supported on the pd engine yet: pi-durable's compaction calls the model without deferral, which the offloaded provider cannot answer"));
  }

  /**
   * One pass over the harness. Parked: the harness is closed and `wakeInMs` is the earliest sleeper's
   * end. Idle: closed, nothing to wake for. Timed out with work still running: left open, and asked
   * again in a second.
   */
  async step(): Promise<StepOutcome> {
    await this.#host.conversation(this.#session);
    const result = await this.#host.drive();
    // Each commit already started a pass; this one is what the step waits for, so that the rows of
    // everything the step committed are in the outboxes before the alarm flushes them.
    await this.#host.deriveOutbox();
    if (result.state === "idle") return { open: 0, wakeInMs: null, settled: [] };
    if (result.state === "parked") {
      return { open: result.sleepers.length, wakeInMs: Math.max(0, result.parkedUntil - this.#host.now), settled: [] };
    }
    // Closed, waiting on the API caller: nothing is open in the object, and nothing to wake for. pi085's run ended at
    // the same pause, so `open` is 0 as there; the caller's results wake it (`answerClientCalls`, `resumeClientCalls`).
    if (result.state === "external") return { open: 0, wakeInMs: null, settled: [] };
    return { open: 1, wakeInMs: 1_000, settled: [] };
  }

  /**
   * Whether a turn waiting on the caller can continue now: a call it recorded has the caller's answer and its tool has
   * not returned it, so a step must resume the harness (the tool's replay reads the answer). True starts nothing by
   * itself — the runtime steps again at once (cf/src/runtime.ts `step`) — which is pi085's meaning: a run is due.
   */
  async resumeClientCalls(): Promise<boolean> {
    const id = await this.#host.conversation(this.#session);
    const ap = await this.#host.store();
    const answered = ap.answeredClientCalls(id);
    if (answered.length === 0) return false;
    return this.#host.withHarness(async (h) => {
      const inspection = await h.inspect(bg);
      const liveCalls = new Set(inspection.tasks
        .filter((t) => t.record.conversationId === id && t.record.kind === TOOL_KIND)
        .map((t) => (t.record.input as { callId?: unknown } | null)?.callId));
      // A tool still waits for one of them: the next pass's replay reads it.
      if (answered.some((r) => liveCalls.has(r.callId))) return true;
      // Their run was left for new input (`#leaveCallerWait`): continue it as pi085 does, once every call is
      // answered and the conversation is idle.
      if (ap.pendingClientCalls(id).some((r) => r.name !== "")) return false;
      if (inspection.tasks.some((t) => t.record.conversationId === id && !t.record.background)) return false;
      const resumed = await this.#resumeLeftCalls(await this.#host.handle(h, id), answered);
      if (resumed) ap.query("DELETE FROM client_calls WHERE conversation_id = ? AND (name != '' OR state = 'used')", id);
      return resumed;
    });
  }

  /**
   * pi085's resume of calls answered after their turn moved on (client-calls.ts `resumeClientCalls`): it moves the lane
   * back to the assistant message that made them, so what came after leaves the model's context, and starts a run whose
   * first messages are the real results. pi-durable has no tree to move in; the same context is written as edits on
   * one entry — each call's placeholder result replaced by the caller's, every later entry other than that message's
   * results omitted — and a run is started on it in the same commit, as pi-durable starts one (harness/generation.js
   * `startRun`, @earendil-works/pi-durable 1.0.0). `branch()` applies the same edits, so readers see pi085's branch.
   */
  async #resumeLeftCalls(c: Conversation, answered: ReadonlyArray<{ callId: string; output: string | null; isError: boolean }>): Promise<boolean> {
    const answers = new Map(answered.map((r) => [r.callId, r]));
    const view = await c.context(bg);
    const at = [...view.entries].reverse().find((e) => e.kind === "pi.assistant"
      && ((e.model?.[0] as { content?: Array<{ type: string; id?: string }> } | undefined)?.content ?? []).some((p) => p.type === "toolCall" && answers.has(String(p.id))));
    if (!at) return false;
    const message = at.model![0] as { content: Array<{ type: string; id?: string; name?: string }> };
    const ofMessage = new Set(message.content.filter((p) => p.type === "toolCall").map((p) => String(p.id)));
    const now = this.#host.now;
    const edits: Array<{ target: EntryRecord["id"]; action: "omit" } | { target: EntryRecord["id"]; action: "replace"; messages: never[] }> = [];
    for (const e of view.entries.slice(view.entries.indexOf(at) + 1)) {
      const first = e.model?.[0] as { role?: string; toolCallId?: string; toolName?: string } | undefined;
      const callId = e.kind === "pi.tool-result" ? String(first?.toolCallId) : undefined;
      const answer = callId === undefined ? undefined : answers.get(callId);
      if (answer) {
        edits.push({ target: e.id, action: "replace", messages: [{
          role: "toolResult", toolCallId: callId, toolName: String(first?.toolName), timestamp: now,
          content: [{ type: "text", text: answer.output ?? "" }], isError: answer.isError,
        }] as never[] });
      } else if (!(callId !== undefined && ofMessage.has(callId))) {
        edits.push({ target: e.id, action: "omit" });
      }
    }
    await c.commit(async (tx) => {
      await tx.appendEntry(c.id, { kind: "ap.client_resume", edits, data: { calls: [...answers.keys()], at: now } });
      const live = await tx.doc(LiveDoc, c.id);
      if (live.run === undefined) {
        live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId: c.id }), inputs: [] };
      }
    }, bg);
    return true;
  }

  /** Calls of this session the API caller has not answered, oldest first: pi085's `pendingClientCalls`. */
  async waitingClientCalls(): Promise<Array<{ call_id: string; name: string; arguments: string }>> {
    const id = await this.#host.conversation(this.#session);
    return (await this.#host.store()).pendingClientCalls(id).filter((c) => c.name !== "")
      .map((c) => ({ call_id: c.callId, name: c.name, arguments: c.arguments }));
  }

  /**
   * The caller's results. A tool waiting for one in this isolate takes it at once; for any other, the harness is resumed
   * (opening it if parked), so the tool's replay finds the answer, and the wake the caller sets settles it.
   */
  async answerClientCalls(results: ReadonlyArray<{ callId: string; output: string; isError: boolean }>): Promise<void> {
    const id = await this.#host.conversation(this.#session);
    const { notWaiting } = await this.#host.answerClientCalls(id, results);
    if (notWaiting.length === 0) return;
    await this.#host.ensureSessions();
    await this.#host.withHarness(async (h) => { h.resume(); });
  }

  /** Forget this session's calls, when its turn is cancelled. How many were still waiting. */
  async dropClientCalls(): Promise<number> {
    const id = await this.#host.conversation(this.#session);
    return (await this.#host.store()).dropClientCalls(id);
  }

  async running(): Promise<boolean> {
    const id = await this.#host.conversation(this.#session);
    const ap = await this.#host.store();
    return this.#host.withHarness(async (h) => runningIn(await h.inspect(bg), id, externalWaitsOf(ap)));
  }

  async status(): Promise<EngineStatus> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => {
      const inspection = await h.inspect(bg);
      const c = await this.#host.handle(h, id);
      const agent = await c.agent(bg);
      return {
        running: runningIn(inspection, id, externalWaitsOf(await this.#host.store())),
        model: agent.model ?? null,
        detail: JSON.parse(JSON.stringify({ engine: "pd", conversationId: id, inspection })),
      };
    });
  }

  /** This session's transcript, oldest first, as 0.85 entries (src/runtime/pd-transcript.ts). `seq` is pi-durable's entry id, which only grows. */
  async entries(query: EngineEntryScan): Promise<EngineEntry[]> {
    const id = await this.#host.conversation(this.#session);
    const records = await this.#host.withHarness(async (h) => {
      const c = await this.#host.handle(h, id);
      const all: EntryRecord[] = [];
      let cursor;
      do {
        const page = await c.entries({}, 200, cursor, bg);
        all.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return all.reverse();
    });
    let out = projectEntries(records);
    if (query.type !== undefined) out = out.filter((e) => e.type === query.type);
    if (query.customType !== undefined) out = out.filter((e) => e.customType === query.customType);
    if (query.fromSeq !== undefined) out = out.filter((e) => e.seq >= query.fromSeq!);
    if (query.toSeq !== undefined) out = out.filter((e) => e.seq <= query.toSeq!);
    if (query.order === "desc") out.reverse();
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  /** The active context's entries, oldest first: what the next request is built from. */
  async branch(): Promise<EngineEntry[]> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => projectEntries(withEdits((await (await this.#host.handle(h, id)).context(bg)).entries)));
  }

  /** The tools the model is offered, as this conversation's agent resolves them. */
  async tools(): Promise<Array<{ name: string }>> {
    return this.#host.withHarness(async (h) => (await (await this.#conversation(h)).agent(bg)).tools.map((t) => ({ name: t.name })));
  }

  takeJob(id: string): Promise<unknown> { return this.#host.takeJob(id); }

  deliver(id: string, answer: AnsweredMessage): Promise<boolean> { return this.#host.deliver(id, answer); }

  /** Closes the object's harness, which every session shares. Safe at any point: a reopened one resumes each task from its checkpoint. */
  close(): Promise<void> { return this.#host.close(); }
}

/**
 * The engine recorded for this object, read without creating anything: an object with no `ap_meta`
 * table (every object made before the choice existed) is `pi085`'s and is left exactly as it was.
 */
export function recordedEngine(sql: DurableSqlHost["sql"]): "pi085" | "pd" | null {
  const meta = AP.qualify("meta", "table");
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", meta).toArray().length === 0) return null;
  const readOnly = { sql: sql as ApSqlHost["sql"], transactionSync: (): never => { throw new Error("recordedEngine only reads"); } };
  return new ApStore(readOnly, AP).engine();
}
