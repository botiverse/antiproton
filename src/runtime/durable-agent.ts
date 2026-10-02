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
 *   (src/runtime/durable-drive.ts) until the harness is idle or only sleeping,
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
 *
 * Every write of ours runs through `PiDurableSqlite.exclusive`, so none of
 * it joins a pi-durable transaction that is open on the object's one
 * connection (src/store/pi-durable-sqlite.ts says why that matters).
 *
 * Only pi-ai 1.0 (`pi-ai-1`) is imported here. What crosses to the 0.85 side —
 * a job's request, an answer, a projected entry — crosses as JSON.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import {
  createRegistry, Harness, ROOT_CONVERSATION_ID,
  type Conversation, type ConversationId, type EntryRecord,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createModels } from "pi-ai-1/models";
import { durableOffloadedProvider, readAnswer, type Answered, type ModelJobRequest } from "../model/durable-offloaded.ts";
import type { AnsweredMessage } from "../model/pi-bridge.ts";
import { ApStore } from "../store/ap-store.ts";
import { PiDurableSqlite, type DurableSqlHost } from "../store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../store/sql-namespace.ts";
import { settle, type SettleResult } from "./durable-drive.ts";
import { projectEntries } from "./pd-transcript.ts";
import type { AgentEngine, EngineEntry, EngineEntryScan, EngineStatus, StepOutcome } from "./engine.ts";

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
  /** The facade the open harness runs on. `exclusive` must go through the one in use, whose queue it joins. */
  #db: PiDurableSqlite | null = null;
  #harness: Promise<Harness> | null = null;
  #driving: Promise<SettleResult> | null = null;
  #conversations = new Map<string, Promise<ConversationId>>();
  /** The `ap` tables, written through whichever facade is in use (`#writer`). */
  readonly #ap: ApStore;
  #ensured: Promise<ApStore> | null = null;

  constructor(opts: PdHostOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#ap = new ApStore(opts.storage.sql, { exclusive: (fn) => this.exclusive(fn) }, AP);
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

  // ---- our own SQL, kept out of pi-durable's transactions --------------------

  /**
   * A synchronous unit of our SQL, after any pi-durable transaction open or queued on the facade in use:
   * the open harness's, whose queue it must join. With no harness open nothing of pi-durable's can be in
   * flight, and a facade of its own has an empty queue.
   */
  exclusive<T>(fn: () => T): Promise<T> {
    return (this.#db ?? new PiDurableSqlite(this.#opts.storage, PD)).exclusive(fn);
  }

  /** The `ap` store, its tables made on first use. */
  #store(): Promise<ApStore> {
    if (!this.#ensured) {
      const ensuring = this.#ap.ensure().then(() => this.#ap);
      this.#ensured = ensuring;
      ensuring.catch(() => { if (this.#ensured === ensuring) this.#ensured = null; });
    }
    return this.#ensured;
  }

  // ---- the harness ------------------------------------------------------------

  /** The open harness, opening one if none is. Opening runs no task: only `resume()` (or a submit) starts the scheduler. */
  harness(): Promise<Harness> {
    if (this.#harness) return this.#harness;
    const opening = (async () => {
      const db = new PiDurableSqlite(this.#opts.storage, PD);
      this.#db = db;
      const h = await Harness.open(await SqliteStorage.open(db), {
        models: this.#models,
        registry: this.#registry,
        settings: {
          stream: { deferred: true },
          // pi-durable's compaction calls the model without `deferred` (harness/compaction.js strips it), and
          // this provider answers nothing else, so a compaction could only fail. Off until a step makes it work.
          compaction: { enabled: false },
        },
        now: this.#now,
      }, bg);
      // Settle closes the harness when it parks; whoever asks next opens a fresh one.
      h.subscribeClose(() => {
        if (this.#harness === opening) { this.#harness = null; this.#db = null; }
      });
      return h;
    })();
    this.#harness = opening;
    opening.catch(() => { if (this.#harness === opening) { this.#harness = null; this.#db = null; } });
    return opening;
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
    if (this.#harness === open) { this.#harness = null; this.#db = null; }
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
      const row = await ap.openConversation({ taskId: session, tenantId, agentId, conversationId: id, createdAt: this.#now() });
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
      const h = await this.harness();
      h.resume();
      return settle(h, {
        context: bg, now: this.#now,
        ...(this.#opts.minParkMs === undefined ? {} : { minParkMs: this.#opts.minParkMs }),
        deadlineMs: this.#opts.stepDeadlineMs ?? STEP_DEADLINE_MS,
      });
    })();
    this.#driving = driving;
    const clear = () => { if (this.#driving === driving) this.#driving = null; };
    driving.then(clear, clear);
    return driving;
  }

  // ---- ap_model_jobs: the provider's port, and the worker's side -----------------

  async #startJob(request: ModelJobRequest): Promise<string> {
    const id = `mj_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // Durable before it is dispatched, as in PiAgent: a dispatch can be retried from the row.
    await (await this.#store()).query(
      "INSERT INTO model_jobs (id, conversation_id, request, created_at) VALUES (?, NULL, ?, ?)",
      id, JSON.stringify(request), this.#now());
    await this.#dispatch(id);
    return id;
  }

  async #dispatch(id: string): Promise<boolean> {
    try { await this.#bound().dispatch(id); }
    catch { return false; /* not marked, so the next sweep sends it */ }
    await (await this.#store()).query("UPDATE model_jobs SET dispatched_at = ? WHERE id = ?", this.#now(), id);
    return true;
  }

  /** Jobs nobody is carrying: never dispatched, or silent longer than a call could take. */
  async #sweep(limit = 20): Promise<number> {
    if (!this.#binding) return 0;
    const now = this.#now();
    const ids = (await (await this.#store()).query(
      "SELECT id FROM model_jobs WHERE answer IS NULL AND (dispatched_at IS NULL OR dispatched_at < ?) ORDER BY created_at LIMIT ?",
      now - REDELIVERY_MS, limit)).map((r) => String(r.id));
    let sent = 0;
    for (const id of ids) if (await this.#dispatch(id)) sent++;
    return sent;
  }

  async #pollJob(id: string): Promise<Answered | null> {
    const [row] = await (await this.#store()).query("SELECT answer FROM model_jobs WHERE id = ?", id);
    const answer = row?.answer;
    this.#opts.onPoll?.(id, typeof answer === "string");
    // `readAnswer` refuses what nothing that writes this row can produce (a stored `aborted`, a non-assistant).
    return typeof answer === "string" ? readAnswer(answer) : null;
  }

  /** pi-durable cancels a polling generation's job when the generation is aborted; a late answer then has no row. */
  async #dropJob(id: string): Promise<void> {
    await (await this.#store()).query("DELETE FROM model_jobs WHERE id = ?", id);
  }

  /** The worker's question: the request, or null once answered so a redelivered message does not call twice. */
  async takeJob(id: string): Promise<unknown> {
    const [row] = await (await this.#store()).query("SELECT request, answer FROM model_jobs WHERE id = ?", id);
    if (!row) throw this.#bound().unknownJob(id);
    return row.answer === null ? JSON.parse(String(row.request)) : null;
  }

  /** The worker's answer. False when one is already in. Writing it is what the next poll reads. */
  async deliver(id: string, answer: AnsweredMessage): Promise<boolean> {
    const json = JSON.stringify(answer);
    const now = this.#now();
    const ap = await this.#store();
    // One statement decides it, so two deliveries cannot both see the row unanswered.
    const won = await ap.query("UPDATE model_jobs SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL RETURNING id", json, now, id);
    if (won.length > 0) return true;
    if ((await ap.query("SELECT 1 AS found FROM model_jobs WHERE id = ?", id)).length === 0) throw this.#bound().unknownJob(id);
    return false;
  }
}

export interface DurableAgentOptions extends PdBinding {
  host: PdHost;
  /** Which of the agent's transcripts this is. Absent: the first. */
  session?: string;
  systemPrompt: string;
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
    return new DurableAgent(opts);
  }

  get host(): PdHost { return this.#host; }

  /** This session's conversation, configured with the current model and prompt (each written only when it moved). */
  async #conversation(h: Harness): Promise<Conversation> {
    const c = await this.#host.handle(h, await this.#host.conversation(this.#session));
    const agent = await c.agent(bg);
    const model = { provider: this.#opts.model.provider, modelId: this.#opts.model.id };
    const moved = agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId;
    const prompt = agent.instructions !== this.#opts.systemPrompt;
    if (moved || prompt) {
      await c.configure({ ...(moved ? { model } : {}), ...(prompt ? { instructions: this.#opts.systemPrompt } : {}) }, bg);
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
    return this.#host.withHarness(async (h) => {
      const c = await this.#conversation(h);
      const submission = await c.submit({ type: "input", content: text, whenBusy: mode === "followUp" ? "followUp" : "steer" }, bg);
      const record = await submission.status(bg);
      // `messageLanded` (cf/src/runtime.ts) reads an operation id as "a run started".
      return record.status === "placed"
        ? { ok: true, value: { operationId: String(submission.id) } }
        : { ok: true, value: { entryId: null, submissionId: String(submission.id) } };
    });
  }

  cancel(_marker: string): Promise<string | null> {
    return Promise.reject(new Error("cancel is not supported on the pd engine yet (step 8)"));
  }

  markCancelled(_marker: string): Promise<void> {
    return Promise.reject(new Error("markCancelled is not supported on the pd engine yet (step 8)"));
  }

  compact(): Promise<unknown> {
    // No step owns this yet: see `compaction: { enabled: false }` in PdHost.harness for why it cannot work today.
    return Promise.reject(new Error("compact is not supported on the pd engine yet: pi-durable's compaction calls the model without deferral, which the offloaded provider cannot answer"));
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
      return { open: result.sleepers.length, wakeInMs: Math.max(0, result.parkedUntil - this.#host.now), settled: [] };
    }
    return { open: 1, wakeInMs: 1_000, settled: [] };
  }

  /** A turn paused for an API caller's function results: there are none on pd until client calls arrive (step 8). */
  async resumeClientCalls(): Promise<boolean> { return false; }

  async running(): Promise<boolean> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => (await h.inspect(bg)).tasks.some((t) => t.record.conversationId === id));
  }

  async status(): Promise<EngineStatus> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => {
      const inspection = await h.inspect(bg);
      const c = await this.#host.handle(h, id);
      const agent = await c.agent(bg);
      return {
        running: inspection.tasks.some((t) => t.record.conversationId === id),
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

  /** The tools the model is offered: none until mounts are bridged (step 7). */
  async tools(): Promise<Array<{ name: string }>> {
    const id = await this.#host.conversation(this.#session);
    return this.#host.withHarness(async (h) => (await (await this.#host.handle(h, id)).agent(bg)).tools.map((t) => ({ name: t.name })));
  }

  takeJob(id: string): Promise<unknown> { return this.#host.takeJob(id); }

  deliver(id: string, answer: AnsweredMessage): Promise<boolean> { return this.#host.deliver(id, answer); }

  /** Closes the object's harness, which every session shares. Safe at any point: a reopened one resumes each task from its checkpoint. */
  close(): Promise<void> { return this.#host.close(); }
}

/**
 * The engine recorded for this object, read without creating anything: an object with no `ap_meta`
 * table (every object made before the choice existed) is `pi085`'s and is left exactly as it was.
 * A plain read, not through `exclusive`: it writes nothing, so joining an open transaction cannot
 * lose anything, and it is asked before any harness of this object exists.
 */
export function recordedEngine(sql: DurableSqlHost["sql"]): "pi085" | "pd" | null {
  const meta = AP.qualify("meta", "table");
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", meta).toArray().length === 0) return null;
  const readOnly = { exclusive: () => Promise.reject(new Error("recordedEngine only reads")) };
  return new ApStore(sql as ConstructorParameters<typeof ApStore>[0], readOnly, AP).engine();
}
