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
 *   no harness open and no timer alive. A delivered answer ends the sleep
 *   early (`#wakeAnswered`): `pollAt` is only the backstop for a lost wake.
 * - The model call is the offloaded provider on pi-ai 1.0
 *   (src/model/durable-offloaded.ts). Its port stages the job in memory; the
 *   `ap_model_jobs` row (src/store/ap-store.ts, instead of `pi_model_jobs`) is
 *   written by the pi-durable commit that records the job's poll checkpoint, and
 *   the job is dispatched once that commit has landed. The worker reads and
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
 *   written inside pi-durable's commit too, by the vendored storage's commit hook
 *   (`bookCommit`, src/runtime/pd-outbox.ts).
 * - A function the Agents API caller runs itself is a tool that records its call
 *   in the conversation's `ap.clientCalls` document and waits on that document
 *   (`clientTool`, src/runtime/durable-tools.ts). A harness whose only pending work
 *   is such a wait closes with no alarm; `answerClientCalls` commits the answer to the
 *   document and resumes the harness, so a waiting tool sees it at once and a parked
 *   one's replay reads it.
 * - A cancel aborts the conversation (pi-durable cancels a polling generation's job
 *   through the provider's port, `#dropJob`, which marks its row cancelled) and then,
 *   in one commit, forgets its client calls and appends a note entry: kind the
 *   runtime's marker, model message the runtime's note (`cancelNote`).
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
  AgentDoc, GenerationTask, LiveDoc, ROOT_CONVERSATION_ID, ToolTask,
  type Conversation, type ConversationId, type EntryRecord, type HarnessInspection, type TaskId,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
// The vendored Harness: pi-durable 1.0.0's with a scheduler that reports a sleeping task (`sleepingUntil`).
import { Harness } from "../vendor/pi/pi-durable/dist/harness/harness.js";
// The vendored registry: its built-in compaction polls a deferred summary (the vendored compaction.js).
import { createRegistry } from "../vendor/pi/pi-durable/dist/harness/registry.js";
import { createModels } from "pi-ai-1/models";
import { durableOffloadedProvider, readAnswer, type Answered, type ModelJobRequest } from "../model/durable-offloaded.ts";
import type { AnsweredMessage } from "../model/pi-bridge.ts";
import { MODEL_CALL_DEADLINE_MS } from "../model/openai-compatible.ts";
import { logEvent } from "../core/log.ts";
import { ApStore, type ApSqlHost } from "../store/ap-store.ts";
import { bookCommit, cancelJob, strandedAnswerRows } from "./pd-outbox.ts";
import { appendUsage } from "../usage/outbox.ts";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { SqliteSyncExecutor } from "../vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { PI_DURABLE_OBJECTS, PiDurableSqlite, type DurableSqlHost } from "../store/pi-durable-sqlite.ts";
import { prefixedNamespace, SqlQualifier } from "../store/sql-namespace.ts";
import { settle, type ExternalWaits, type SettleResult } from "./durable-drive.ts";
import { ClientCallsDoc, toolsExtension, waitingCalls, type ClientToolDef } from "./durable-tools.ts";
import { bridgeTools, type InterruptKeeping, type MountedTool, type ToolHost } from "./pi-tools.ts";
import { projectEntries } from "./pd-transcript.ts";
import { type AgentEngine, type EngineEntry, type EngineEntryScan, type EngineStatus, type StepOutcome } from "./engine.ts";

const PD = prefixedNamespace("pd");
const PD_NAMES = new SqlQualifier(PI_DURABLE_OBJECTS, PD);
const AP = prefixedNamespace("ap");

/** Which session is the agent's first one; its conversation is pi-durable's root. Same string as pi-storage's MAIN_SESSION. */
const MAIN_SESSION = "main";

/**
 * How long a dispatched job may wait for a queue message to take it before the sweep sends it again: the
 * dispatch, or its message, presumed lost. PiAgent's `REDELIVERY_MS`. It is shorter than a model call may
 * take, so it is not what covers a job that was taken: `TAKE_HOLD_MS` is.
 * The sweep runs at the start of each `drive`, so a parked object comes back for it: `step` parks no
 * later than the earliest job's redelivery (`PdHost.redeliveryDue`), not only at the poll backstop.
 */
const REDELIVERY_MS = 120_000;

/**
 * How long a take holds the job: while it is under this old, no other message takes the job and the sweep does
 * not send it again (`PdHost.takeJob`, `#sweep`). The taker's model call is abandoned at `MODEL_CALL_DEADLINE_MS`,
 * and a call that fails releases the take at once (`PdHost.releaseJob`); the minute more covers the taker's own
 * take and delivery around the call. A take this old is a taker that died without releasing it, and the job is
 * then sent again and taken by the next message.
 */
const TAKE_HOLD_MS = MODEL_CALL_DEADLINE_MS + 60_000;

/**
 * How long a generation sleeps before it polls its job again, every time. It is not what makes a turn
 * go on: `deliver` wakes the task that waits for the answer (`#wakeAnswered`), and so do every `drive`
 * and the start of the poll's sleep, so the answer is read as soon as it is written. This is the backstop
 * for a wake that was lost (an isolate gone between the answer and the wake). While a job is out the park
 * comes back at its redelivery instead when that is sooner (`PdHost.redeliveryDue`).
 */
export const POLL_BACKSTOP_MS = 300_000;

/** How long a staged job waits for the commit that records it before it is forgotten (`PdHost.#staged`). */
const STAGED_MS = 10 * 60_000;

/** How long one `step()` keeps the harness open waiting for work that is neither idle nor sleeping. */
const STEP_DEADLINE_MS = 30_000;

/** The bound model, as the provider registers it. */
export type PdModel = { provider: string; id: string; contextWindow: number; maxTokens?: number };

export interface PdHostOptions {
  /** The object's storage: `ctx.storage` on a Durable Object, `sqliteHost()` under node. */
  storage: DurableSqlHost;
  now?: () => number;
  /** The poll interval; `POLL_BACKSTOP_MS` when absent. */
  pollAfterMs?: number;
  /** A sleeper due sooner than this is waited for in-process instead of parked (settle's `minParkMs`). */
  minParkMs?: number;
  stepDeadlineMs?: number;
  /** `REDELIVERY_MS` when absent. For tests. */
  redeliveryMs?: number;
  /** `TAKE_HOLD_MS` when absent. For tests. */
  takeHoldMs?: number;
  /** Never wake a task for a delivered answer: a lost wake, which the poll interval must cover. For tests. */
  noWake?: boolean;
  /** Each provider poll of a job, and whether it found the answer. For tests and traces. */
  onPoll?: (jobId: string, ready: boolean) => void;
  /** A test seam into the commit hook (src/runtime/pd-outbox.ts, `BookContext.fault`): a throw rolls the commit back. */
  commitFault?: (writes: readonly StorageWrite[]) => void;
  /** pi-durable's compaction thresholds, over its defaults (harness/agent.js `DEFAULT_COMPACTION_POLICY`). For tests. */
  compaction?: { reserveTokens?: number; keepRecentTokens?: number; backgroundTokens?: number };
  /** Extensions installed beside the sessions' tools. For tests: a task of their own, such as one that sleeps after work it did not commit. */
  extensions?: ReadonlyArray<Parameters<ReturnType<typeof createRegistry>["install"]>[0]>;
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
  /**
   * Jobs the provider's port started that no commit has recorded yet: id to request JSON, and when. The commit
   * that records the job's poll checkpoint inserts its row (`bookCommit`). Not cleared when a harness closes: a
   * commit admitted before the close can still land after it, and without its entry it would record a checkpoint
   * with no row, a poll nobody answers. One that will never land (its generation aborted or failed first) is
   * forgotten after `STAGED_MS`; its commit follows the provider's return at once, so that is far past it.
   */
  readonly #staged = new Map<string, { request: string; at: number }>();
  /** What a `settle` in flight is told when a task starts to sleep (`drive`, settle's `subscribe`). */
  readonly #onSleep = new Set<() => void>();

  constructor(opts: PdHostOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#ap = new ApStore(opts.storage, AP);
    for (const extension of opts.extensions ?? []) this.#registry.install(extension);
  }

  get now(): number { return this.#now(); }

  /**
   * One agent per object, the invariant AgentDO rests on (cf/src/index.ts, `benchStart`): the
   * provider's port is not told which conversation a job belongs to, so a job's dispatch can name
   * only the one agent the object serves. The bench keeps it too: a pd bench task runs in an object
   * of its own (cf/src/bench.ts `chooseBenchEngine`, bench/objects.ts), never in one a task used before.
   */
  bind(binding: PdBinding): void {
    const was = this.#binding;
    if (was && (was.tenantId !== binding.tenantId || was.agentId !== binding.agentId)) {
      throw new Error(`the pd engine serves one agent per object: this one is ${was.tenantId}/${was.agentId}, ` +
        `not ${binding.tenantId}/${binding.agentId} (a pd object never changes agent)`);
    }
    this.#binding = binding;
    // Registered again on every bind: the binding's model is the truth, as PiAgent's `open` treats it.
    this.#models.setProvider(durableOffloadedProvider({
      port: {
        start: (request) => this.#startJob(request),
        poll: (id) => this.#pollJob(id),
        cancel: (id) => this.#dropJob(id),
      },
      id: binding.model.provider,
      pollAfterMs: this.#opts.pollAfterMs ?? POLL_BACKSTOP_MS,
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
    this.#registry.install(toolsExtension(name, tools, clientTools));
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
      // The commit hook writes the `ap` tables, so they exist before anything commits.
      await this.#store();
      const db = new PiDurableSqlite(this.#opts.storage, PD);
      const storage = await SqliteStorage.open(db, { onCommit: (exec, writes, seq) => this.#book(exec, writes, seq, opening) });
      const h = await Harness.open(storage, {
        models: this.#models,
        registry: this.#registry,
        settings: {
          stream: { deferred: true },
          // pi-durable's thresholds (harness/agent.js `DEFAULT_COMPACTION_POLICY`) over the bound model's window:
          // a background compaction past window - reserve - background tokens, a blocking one past window -
          // reserve, and one on a context overflow. The summary is a deferred model call like a generation's: the
          // vendored harness/compaction.js polls it (src/vendor/pi/pi-durable/), and the registry holds that one.
          compaction: { ...this.#opts.compaction, enabled: true },
        },
        now: this.#now,
        // For settle: a sleep commits nothing, so a settle in flight is told (`drive`) and reads again at once,
        // rather than at its recheck, whether or not a commit came just before the sleep.
        // For the wake: an answer delivered while its poll was fetching (not sleeping, so `Harness.wake` passes it
        // by) is found when the poll's next sleep starts.
        onSleep: ({ taskId }) => {
          for (const notify of this.#onSleep) notify();
          void this.#wakeOnSleep(taskId);
        },
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

  // ---- inside pi-durable's commit ------------------------------------------------

  /**
   * The commit hook: inside the transaction of every pi-durable commit, before its batch is applied
   * (src/runtime/pd-outbox.ts says what it writes). Jobs the batch recorded are dispatched once the
   * transaction is over — it is synchronous, so a microtask queued here runs after it — and only if
   * the commit landed rather than rolled back: pi-durable's sequence moved past `seq`.
   *
   * A commit that rolled back for any reason but `StorageRejected` — a throw here, a failed statement after
   * it — poisons pi-durable's Session: every later commit on it rejects until it is reopened. So the harness
   * it ran on is dropped and closed, and whoever asks next opens a fresh one, which resumes each task from its
   * last landed checkpoint. (A `StorageRejected` rollback does not poison; reopening then costs one open.)
   */
  #book(exec: SqliteSyncExecutor, writes: readonly StorageWrite[], seq: number, harness: Promise<Harness>): void {
    const binding = this.#binding;
    let jobs: string[] = [];
    try {
      jobs = bookCommit(exec, writes, {
        owner: binding ? { tenantId: binding.tenantId, agentId: binding.agentId } : null,
        now: this.#now(), raw: this.#opts.storage.sql, ap: this.#ap, staged: this.#staged,
        ...(this.#opts.commitFault ? { fault: this.#opts.commitFault } : {}),
      });
    } finally {
      queueMicrotask(() => void this.#afterCommit(jobs, seq, harness));
    }
  }

  async #afterCommit(jobs: readonly string[], seq: number, harness: Promise<Harness>): Promise<void> {
    const next = this.#opts.storage.sql.exec(PD_NAMES.rewrite("SELECT next_seq FROM durable_metadata WHERE singleton = 1")).toArray()[0]?.next_seq;
    if (!(Number(next) > seq)) {
      if (this.#harness === harness) this.#harness = null;
      logEvent("pd.commit.rolled_back", { ...(this.#binding ? { tenantId: this.#binding.tenantId, agentId: this.#binding.agentId } : {}), seq });
      await (await harness).close(bg).catch(() => {});
      return;
    }
    for (const id of jobs) {
      // The row is the proof: a commit that rolled back, whatever moved the sequence since, left none.
      if (this.#ap.query("SELECT 1 AS x FROM model_jobs WHERE id = ?", id).length === 0) continue;
      this.#staged.delete(id);
      await this.#dispatch(id);
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

  /**
   * Forget the conversation ids this host has looked up: their tables were dropped under it (src/runtime/pd-migrate.ts),
   * and the next use of a session makes or finds its conversation again. Only while no harness is open.
   */
  forgetConversations(): void {
    if (this.#harness) throw new Error("forgetConversations: a harness is open");
    this.#conversations.clear();
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
      const h = await this.harness();
      // Before the resume, so a task whose answer came while the object was parked skips its sleep (a wake asked
      // for a task with no invocation yet is kept for its first sleep).
      await this.#wakeAnswered(h);
      h.resume();
      return settle(h, {
        context: bg, now: this.#now,
        externalWaits: (ids) => externalWaitsOf(h, ids),
        subscribe: (notify) => { this.#onSleep.add(notify); return () => { this.#onSleep.delete(notify); }; },
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

  // ---- ap_model_jobs: the provider's port, and the worker's side -----------------

  /**
   * The provider's port: the job is only staged here. The commit that records the generation's poll checkpoint,
   * whose handle names it, inserts the row (`bookCommit`), and the job is dispatched once that commit has landed
   * (`#afterCommit`). A generation that dies before that commit leaves no row and sends nothing.
   */
  async #startJob(request: ModelJobRequest): Promise<string> {
    const id = `mj_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const now = this.#now();
    for (const [old, staged] of this.#staged) if (staged.at < now - STAGED_MS) this.#staged.delete(old);
    this.#staged.set(id, { request: JSON.stringify(request), at: now });
    return id;
  }

  async #dispatch(id: string): Promise<boolean> {
    try { await this.#bound().dispatch(id); }
    // Not marked again: the row is marked from its insert (`bookCommit`), so the sweep sends it once that is a redelivery interval old.
    catch { return false; }
    (await this.#store()).query("UPDATE model_jobs SET dispatched_at = ? WHERE id = ?", this.#now(), id);
    return true;
  }

  get #redeliveryMs(): number { return this.#opts.redeliveryMs ?? REDELIVERY_MS; }
  get #takeHoldMs(): number { return this.#opts.takeHoldMs ?? TAKE_HOLD_MS; }

  /**
   * When the sweep must run again for the jobs still out: for each, its dispatch plus the redelivery interval, or
   * the end of its take's hold if that is later (the sweep skips a job under a live take); the earliest of those.
   * One already due, or never dispatched, was just tried by this step's sweep and failed, so it is due one interval
   * from now rather than at once. Null with no job out.
   */
  async redeliveryDue(): Promise<number | null> {
    if (!this.#binding) return null;
    const now = this.#now();
    const rows = (await this.#store()).query("SELECT dispatched_at, taken_at FROM model_jobs WHERE answer IS NULL AND state IS NULL");
    let due: number | null = null;
    for (const r of rows) {
      let at = r.dispatched_at === null ? now : Number(r.dispatched_at) + this.#redeliveryMs;
      if (r.taken_at !== null) at = Math.max(at, Number(r.taken_at) + this.#takeHoldMs);
      const next = at > now ? at : now + this.#redeliveryMs;
      due = due === null ? next : Math.min(due, next);
    }
    return due;
  }

  /**
   * Jobs nobody is carrying: never dispatched, or dispatched a redelivery interval ago and not under a live take
   * (`takeJob`). Due at exactly the instant `redeliveryDue` parks for: a strict comparison would find nothing then
   * and park one interval more.
   */
  async #sweep(limit = 20): Promise<number> {
    if (!this.#binding) return 0;
    const now = this.#now();
    const ids = (await this.#store()).query(
      "SELECT id FROM model_jobs WHERE answer IS NULL AND state IS NULL AND (dispatched_at IS NULL OR dispatched_at <= ?)" +
      " AND (taken_at IS NULL OR taken_at <= ?) ORDER BY created_at LIMIT ?",
      now - this.#redeliveryMs, now - this.#takeHoldMs, limit).map((r) => String(r.id));
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

  /**
   * pi-durable cancels a polling generation's job when the generation is aborted. The row is marked, not deleted:
   * the worker may already be carrying it, and its answer is spend. An answer already delivered, which no commit
   * will now append, is billed here, in the same transaction as the mark; one delivered later is billed by `deliver`.
   */
  async #dropJob(id: string): Promise<void> {
    this.#staged.delete(id);
    const owner = this.#bound();
    const ap = await this.#store();
    this.#opts.storage.transactionSync(() => {
      appendUsage(this.#opts.storage.sql as never, cancelJob(ap, id, { tenantId: owner.tenantId, agentId: owner.agentId }, this.#now()));
    });
  }

  /**
   * Wake every task whose `poll` checkpoint waits for a job that has its answer, not yet consumed or cancelled (only `jobId`'s, when given) —
   * a generation's, or a compaction's summary (the vendored harness/compaction.js writes the same `poll` and `handle`): its
   * sleep ends now, or its next one does not wait (`Harness.wake`). Read from storage rather than remembered, so a
   * reopened harness finds what was delivered while it was closed. A wake too early costs one poll, which comes
   * back not ready and commits a new `pollAt`.
   */
  async #wakeAnswered(h: Harness, jobId?: string, taskId?: TaskId): Promise<void> {
    if (this.#opts.noWake) return;
    const polling = new Map<string, TaskId[]>();
    for (const t of (await h.inspect(bg)).tasks) {
      if (taskId !== undefined && t.record.id !== taskId) continue;
      const checkpoint = (t.record.state as { checkpoint?: { phase?: unknown; handle?: { id?: unknown } } }).checkpoint;
      const job = checkpoint?.phase === "poll" ? checkpoint.handle?.id : undefined;
      if (typeof job !== "string" || (jobId !== undefined && job !== jobId)) continue;
      polling.set(job, [...(polling.get(job) ?? []), t.record.id]);
    }
    if (polling.size === 0) return;
    const ids = [...polling.keys()];
    const answered = (await this.#store()).query(
      `SELECT id FROM model_jobs WHERE answer IS NOT NULL AND state IS NULL AND id IN (${ids.map(() => "?").join(", ")})`, ...ids);
    const tasks = answered.flatMap((r) => polling.get(String(r.id)) ?? []);
    if (tasks.length > 0) h.wake(tasks);
  }

  /** A task started sleeping: if it is a poll whose answer is in, end the sleep. Failure leaves it to the next step. */
  async #wakeOnSleep(taskId: TaskId): Promise<void> {
    const open = this.#harness;
    if (!open || this.#opts.noWake) return;
    try { await this.#wakeAnswered(await open, undefined, taskId); }
    catch (error) { logEvent("pd.wake.error", { taskId, error: String((error as Error)?.message ?? error).slice(0, 200) }); }
  }

  /**
   * The worker's question: the request, or null once answered or cancelled so a redelivered message does not call twice.
   *
   * `taker` names one attempt to call the model with it (the consumer makes a fresh one each time, cf/src/model-queue.ts).
   * Two messages for one job — the sweep resent a dispatch that was not lost, or the queue delivered one twice — would
   * otherwise both call the model while neither has answered, and the answer `deliver` refuses is paid for and recorded
   * nowhere. So a job under a live take (taken less than `TAKE_HOLD_MS` ago, not released) is refused to every other
   * taker. A failed call releases its take (`releaseJob`), so the queue's retry takes it at once; one taken longer ago
   * is a taker that died, and is taken again, as the sweep sends it again. Without a taker the request is only read:
   * nothing is refused or recorded. One statement decides it, so two takers cannot both win.
   */
  async takeJob(id: string, taker?: string): Promise<unknown> {
    const ap = await this.#store();
    if (taker !== undefined) {
      const now = this.#now();
      const [won] = ap.query(
        "UPDATE model_jobs SET taken_at = ?, taken_by = ? WHERE id = ? AND answer IS NULL AND state IS NULL" +
        " AND (taken_at IS NULL OR taken_at <= ?) RETURNING request",
        now, taker, id, now - this.#takeHoldMs);
      if (won) return JSON.parse(String(won.request));
    }
    const [row] = ap.query("SELECT request, answer, state FROM model_jobs WHERE id = ?", id);
    if (!row) throw this.#bound().unknownJob(id);
    if (taker !== undefined) {
      if (row.answer === null && row.state === null) logEvent("pd.jobs.take_refused", { tenantId: this.#bound().tenantId, agentId: this.#bound().agentId, jobId: id });
      return null;
    }
    return row.answer === null && row.state === null ? JSON.parse(String(row.request)) : null;
  }

  /**
   * A taker's call failed and will be retried: its take ends now, so the retry, or the sweep's resend, takes the job
   * whatever its message's id. Only the taker's own take is cleared; false when it no longer holds one.
   */
  async releaseJob(id: string, taker: string): Promise<boolean> {
    const ap = await this.#store();
    return ap.query("UPDATE model_jobs SET taken_at = NULL, taken_by = NULL WHERE id = ? AND taken_by = ? RETURNING id", id, taker).length > 0;
  }

  /**
   * The worker's answer. False when one is already in. Writing it is what the next poll reads, and when the
   * harness is open the task waiting for it is woken now. When it is not, the caller wakes the object
   * (cf/src/index.ts `deliverAnswer`), and that step's `drive` wakes the task. An answer to a job
   * that was cancelled is read by no poll, so its usage is billed here, in the transaction that stores it.
   */
  async deliver(id: string, answer: AnsweredMessage): Promise<boolean> {
    const json = JSON.stringify(answer);
    const now = this.#now();
    const owner = this.#bound();
    const ap = await this.#store();
    // One statement decides it, so two deliveries cannot both see the row unanswered.
    const won = this.#opts.storage.transactionSync(() => {
      const [row] = ap.query("UPDATE model_jobs SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL RETURNING state", json, now, id);
      if (row?.state === "cancelled") appendUsage(this.#opts.storage.sql as never, strandedAnswerRows(owner, now, json));
      return row !== undefined;
    });
    if (won) {
      const open = this.#harness;
      if (open) {
        // The answer is durable: a wake that fails (the harness closed under it) leaves it to the next step's.
        try { await this.#wakeAnswered(await open, id); }
        catch (error) { logEvent("pd.wake.error", { jobId: id, error: String((error as Error)?.message ?? error).slice(0, 200) }); }
      }
      return true;
    }
    if (ap.query("SELECT 1 AS found FROM model_jobs WHERE id = ?", id).length === 0) throw owner.unknownJob(id);
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
  /** What the model is shown where a turn was cancelled: the model message of the marker entry `cancel` writes. */
  cancelNote?: string;
}

/** The extension holding a session's tools. */
export const toolsExtensionName = (session: string) => `ap.tools:${session}`;

/** Every call a client tool recorded and the caller has not answered, in the conversations named (`DriveSnapshot.externalWaits`). */
async function externalWaitsOf(h: Harness, ids: Iterable<ConversationId>): Promise<ExternalWaits> {
  const out = new Map<ConversationId, Set<string>>();
  for (const id of ids) {
    const waiting = waitingCalls(await h.snapshot(ClientCallsDoc, id, bg));
    if (waiting.length) out.set(id, new Set(waiting.map((c) => c.callId)));
  }
  return out;
}

const GENERATION_KIND = GenerationTask.definition.name;
const TOOL_KIND = ToolTask.definition.name;

/**
 * Whether a conversation has work under way: a live task of it that is neither waiting on other tasks nor a tool
 * waiting for the API caller. A turn whose only pending work is the caller's functions is not running, so the Agents
 * API reports it as requiring action (cf/src/index.ts `apiSessionStatus`), queued input or not.
 */
async function runningIn(h: Harness, id: ConversationId): Promise<boolean> {
  const inspection: HarnessInspection = await h.inspect(bg);
  const waits = (await externalWaitsOf(h, [id])).get(id);
  return inspection.tasks.some((t) => {
    if (t.record.conversationId !== id) return false;
    // A background compaction (past pi-durable's threshold) is not the turn: the run it was started in ended without
    // waiting for it, and pi085 has nothing running then either. A manual one is not background, and is running.
    if (t.record.background) return false;
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
   *
   * A run waiting on the API caller's functions is busy too: the input waits behind the caller's results
   * and is placed after them, so the session keeps reading `requires_action` with the same turn waiting
   * until the caller answers, and a cancel withdraws the input with the run.
   */
  async say(text: string, mode: "prompt" | "steer" | "followUp" = "prompt") {
    // One id for this message, kept across `withHarness`'s retry. A harness that closes while the input
    // is being admitted still completes the admitted commit, so the input can be durable when the call
    // fails ("Session is closed" from `status`); the retry then finds it by this id (pi-durable dedupes
    // a submission per conversation and request id) instead of submitting it a second time.
    const requestId = `say:${crypto.randomUUID()}`;
    // Submitting starts the scheduler, which runs every session's tasks.
    await this.#host.ensureSessions();
    return this.#host.withHarness(async (h) => {
      const c = await this.#conversation(h);
      const submission = await c.submit({ type: "input", content: text, whenBusy: mode === "followUp" ? "followUp" : "steer", requestId }, bg);
      const record = await submission.status(bg);
      // `messageLanded` (cf/src/runtime.ts) reads an operation id as "a run started".
      return record.status === "placed"
        ? { ok: true, value: { operationId: String(submission.id) } }
        : { ok: true, value: { entryId: null, submissionId: String(submission.id) } };
    });
  }

  /**
   * Cancel this conversation's run: pi-durable's abort withdraws queued input, aborts every live task of it and waits
   * until it is idle — a polling generation cancels its job through the provider's port (`#dropJob`), a running tool
   * is signalled and its result is "aborted", a client tool's wait ends — and then one commit forgets the client calls
   * and appends the `marker` entry, naming the run's task, with the note as its model message. Null, and nothing
   * written, when nothing was running.
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
      await this.#appendNote(c, marker, operationId);
      return operationId;
    });
  }

  /** The marker for a turn that ended with no run to abort. */
  async markCancelled(marker: string): Promise<void> {
    const id = await this.#host.conversation(this.#session);
    await this.#host.withHarness(async (h) => this.#appendNote(await this.#host.handle(h, id), marker, null));
  }

  /** The cancel's note entry, and the conversation's client calls forgotten, in one commit. */
  async #appendNote(c: Conversation, marker: string, operationId: string | null): Promise<void> {
    const note = this.#opts.cancelNote;
    const at = this.#host.now;
    await c.commit(async (tx) => {
      (await tx.doc(ClientCallsDoc, c.id)).calls = {};
      await tx.appendEntry(c.id, {
        kind: marker,
        ...(note === undefined ? {} : { model: [{ role: "user", content: [{ type: "text", text: note }], timestamp: at }] }),
        data: { operationId, at },
      });
    }, bg);
  }

  /**
   * Start a manual compaction of this session's conversation: pi-durable's `Conversation.compact`, whose summary is a
   * deferred model call the vendored compaction polls (src/vendor/pi/pi-durable/dist/harness/compaction.js). Durable
   * before it returns; the wake the caller sets runs `step()`, which parks while the summary is out. The summary is
   * placed through a write submission: at once when the conversation is idle, else at the run's next boundary. One
   * already under way that is not a run's own (a manual or background one) is returned instead of a second.
   */
  async compact(): Promise<{ operationId: string }> {
    await this.#host.conversation(this.#session);
    // Compacting starts the scheduler, which runs every session's tasks.
    await this.#host.ensureSessions();
    return this.#host.withHarness(async (h) => {
      const c = await this.#conversation(h);
      const under = (await h.snapshot(LiveDoc, c.id, bg))?.compactions?.find((s) => !s.blocking);
      return { operationId: String(under?.taskId ?? await c.compact(undefined, bg)) };
    });
  }

  /**
   * One pass over the harness. Parked: the harness is closed and `wakeInMs` is the earliest sleeper's
   * end. Idle: closed, nothing to wake for. Timed out with work still running: left open, and asked
   * again in a second.
   */
  async step(): Promise<StepOutcome> {
    await this.#host.conversation(this.#session);
    const result = await this.#host.drive();
    if (result.state === "idle") return { open: 0, wakeInMs: null, settled: [] };
    if (result.state === "parked") {
      // Back for the sweep too: a lost dispatch is resent within the redelivery interval, not at the poll backstop.
      const redeliver = await this.#host.redeliveryDue();
      const at = redeliver === null ? result.parkedUntil : Math.min(result.parkedUntil, redeliver);
      return { open: result.sleepers.length, wakeInMs: Math.max(0, at - this.#host.now), settled: [] };
    }
    // Closed, waiting on the API caller: nothing is open in the object, and nothing to wake for. The caller's results
    // wake it (`answerClientCalls`).
    if (result.state === "external") return { open: 0, wakeInMs: null, settled: [] };
    return { open: 1, wakeInMs: 1_000, settled: [] };
  }

  /** Never: a caller's answer is committed where its waiting tool reads it (`answerClientCalls`), so no run is left to start. */
  async resumeClientCalls(): Promise<boolean> { return false; }

  /** Calls of this session the API caller has not answered, oldest first. */
  async waitingClientCalls(): Promise<Array<{ call_id: string; name: string; arguments: string }>> {
    const id = await this.#host.conversation(this.#session);
    const doc = await this.#host.withHarness((h) => h.snapshot(ClientCallsDoc, id, bg));
    return waitingCalls(doc).map((c) => ({ call_id: c.callId, name: c.name, arguments: c.arguments }));
  }

  /**
   * The caller's results, committed to the conversation's `ap.clientCalls` in one commit (a call that has a result
   * keeps it), and the harness resumed: a tool waiting in this isolate sees the commit at once, and a parked one is run
   * again and reads it. A result for a call whose tool has not run yet is kept for it; one for a call that already
   * has its result in the context (a late answer after a cancel, a repeat for a call already returned) is dropped, so
   * nothing is kept that no tool will read. A call id unknown to the session is refused before this
   * (cf/src/runtime.ts `submitToolResults`).
   */
  async answerClientCalls(results: ReadonlyArray<{ callId: string; output: string; isError: boolean }>): Promise<void> {
    const id = await this.#host.conversation(this.#session);
    // Resuming starts the scheduler, which runs every session's tasks.
    await this.#host.ensureSessions();
    const at = this.#host.now;
    await this.#host.withHarness(async (h) => {
      const c = await this.#host.handle(h, id);
      const returned = new Set((await c.context(bg)).entries.filter((e) => e.kind === "pi.tool-result")
        .map((e) => String((e.model?.[0] as { toolCallId?: unknown } | undefined)?.toolCallId)));
      await c.commit(async (tx) => {
        const doc = await tx.doc(ClientCallsDoc, c.id);
        for (const r of results) {
          const call = doc.calls[r.callId];
          if (call?.answer || (!call && returned.has(r.callId))) continue;
          doc.calls[r.callId] = { ...(call ? { ...call } : { name: "", arguments: "", at }), answer: { output: r.output, isError: r.isError } };
        }
      }, bg);
      h.resume();
    });
  }

  /** Forget this session's calls; how many were still waiting. A cancel has already (`#appendNote`), so this finds none then. */
  async dropClientCalls(): Promise<number> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => {
      const doc = await h.snapshot(ClientCallsDoc, id, bg);
      if (!doc || Object.keys(doc.calls).length === 0) return 0;
      const waiting = waitingCalls(doc).length;
      await (await this.#host.handle(h, id)).commit(async (tx) => { (await tx.doc(ClientCallsDoc, id)).calls = {}; }, bg);
      return waiting;
    });
  }

  async running(): Promise<boolean> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness((h) => runningIn(h, id));
  }

  async status(): Promise<EngineStatus> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => {
      const inspection = await h.inspect(bg);
      const c = await this.#host.handle(h, id);
      const agent = await c.agent(bg);
      return {
        running: await runningIn(h, id),
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
    return this.#host.withHarness(async (h) => projectEntries((await (await this.#host.handle(h, id)).context(bg)).entries));
  }

  /** The tools the model is offered, as this conversation's agent resolves them. */
  async tools(): Promise<Array<{ name: string }>> {
    return this.#host.withHarness(async (h) => (await (await this.#conversation(h)).agent(bg)).tools.map((t) => ({ name: t.name })));
  }

  takeJob(id: string, taker?: string): Promise<unknown> { return this.#host.takeJob(id, taker); }

  releaseJob(id: string, taker: string): Promise<boolean> { return this.#host.releaseJob(id, taker); }

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
