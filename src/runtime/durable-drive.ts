/**
 * When a pi-durable harness may be closed and woken again by an alarm.
 *
 * pi-agent-core's `drive()` returned `waiting` when the provider answered
 * `deferred`, and the object went idle. pi-durable has no such return: its
 * generation task commits a `poll` checkpoint and then *sleeps in-process*
 * until `pollAt` (a retry or a compaction retry sleeps until `until` the same
 * way). A Durable Object that stayed open for that sleep would be billed for
 * it, which is the cost the offloaded provider (src/model/durable-offloaded.ts)
 * exists to avoid. What replaces `waiting` is this: look at the committed
 * state, and when the harness is doing nothing but sleeping until T, close it
 * and set an alarm for T. Closing is safe at any point — it aborts invocations
 * and writes no task outcome, so a reopened harness resumes each task from its
 * last checkpoint — and the alarm reopens it and calls `resume()`.
 *
 * The verdict must only ever say "park" while every sleeper's T is still
 * ahead. A task whose `pollAt` has passed is about to fetch, or fetching; its
 * checkpoint still says `poll`, because the fetch commits nothing until it
 * returns. Parking it closes the harness mid-fetch and sets an alarm in the
 * past, which fires at once, reopens, starts the fetch, parks again: the loop
 * a spike measured at 108 fetches for one answer. So the comparison is strict
 * and on the harness's own clock.
 *
 * `parkVerdict` is the pure part and takes a snapshot; `readSnapshot` and
 * `settle` are the harness glue. Nothing in the live runtime calls either yet.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  CompactionTask, GenerationTask, InboxDoc, LiveDoc, ToolTask,
  type ConversationId, type Harness, type HarnessInspection, type InboxState, type JsonObject,
  type LiveState, type TaskId,
} from "@earendil-works/pi-durable";

export type ConversationDocs = { readonly live: Readonly<LiveState> | undefined; readonly inbox: Readonly<InboxState> | undefined };

/** Everything the verdict reads, taken at one instant of the harness clock. */
export type DriveSnapshot = {
  readonly now: number;
  readonly inspection: HarnessInspection;
  /** `pi.live` and `pi.inbox` of every conversation a live task or an unsettled submission belongs to. */
  readonly docs: ReadonlyMap<ConversationId, ConversationDocs>;
};

/** A task that runs no code until `until`: a generation polling or backing off, a compaction backing off. */
export type Sleeper = { readonly taskId: TaskId; readonly phase: "poll" | "retry"; readonly until: number };

export type ParkVerdict =
  /** Nothing live and nothing queued: close, set no alarm. */
  | { readonly verdict: "idle" }
  /** Only sleeping: close, and set an alarm for `until`, the earliest sleeper's wake time. */
  | { readonly verdict: "park"; readonly until: number; readonly sleepers: readonly Sleeper[] }
  /** Work is running or about to: stay open. `reason` names the first thing that said so. */
  | { readonly verdict: "wait"; readonly reason: string };

const GENERATION = GenerationTask.definition.name;
const COMPACTION = CompactionTask.definition.name;

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL = ToolTask.definition.name;

/**
 * Every checkpoint phase pi-durable 1.0.0's built-in tasks write, and what a `running` task in it is
 * doing. Read from its `dist` (`phase: "…"` and `runtime.sleep(` in harness/generation.js,
 * compaction.js, tool.js); test/durable-drive.ts scans the installed `dist` and fails when either
 * set moves, so a new sleep cannot silently become a billed wait.
 * - sleeping: the phase handler's first act is `runtime.sleep(T)`; it runs no other code before T.
 * - working: the handler prepares, streams, polls, selects, summarizes or runs a tool, and commits
 *   when it is done — the harness progresses, so staying open is right.
 */
export const SLEEPING_PHASES: Readonly<Record<string, readonly string[]>> = {
  [GENERATION]: ["poll", "retry"],
  [COMPACTION]: ["retry"],
};
export const WORKING_PHASES: Readonly<Record<string, readonly string[]>> = {
  [GENERATION]: ["prepare", "request", "tools"],
  [COMPACTION]: ["select", "summarize"],
  [TOOL]: ["call", "execute"],
};

type Activity =
  | { readonly kind: "sleeping"; readonly phase: "poll" | "retry"; readonly until: number }
  | { readonly kind: "working"; readonly phase: string }
  | { readonly kind: "unrecognised" };

/** What a running task's checkpoint says it is doing. Anything outside the tables above is "unrecognised". */
function activityOf(kind: string, checkpoint: JsonValue | undefined): Activity {
  if (!isObject(checkpoint)) return { kind: "unrecognised" };
  const { phase, pollAt, until } = checkpoint;
  if (kind === GENERATION && phase === "poll" && typeof pollAt === "number") return { kind: "sleeping", phase, until: pollAt };
  if ((kind === GENERATION || kind === COMPACTION) && phase === "retry" && typeof until === "number") return { kind: "sleeping", phase, until };
  if (typeof phase === "string" && (WORKING_PHASES[kind] ?? []).includes(phase)) return { kind: "working", phase };
  return { kind: "unrecognised" };
}

/**
 * The park predicate. "park" requires all of:
 * - at least one live task, and every live task either a sleeper or parked
 *   `waiting` on other tasks (which runs no code until they settle);
 * - every sleeper reserved (`running`, with a running invocation), not abort-marked,
 *   and its wake time at least `minParkMs` (default 1000, never below 1) after `now` — strictly in the future;
 * - in every conversation involved, no committed partial of a streaming response and
 *   no tool slot that is not done;
 * - queued input only where a run already holds the conversation: it waits for that
 *   run's next boundary. Queued input with no run would start one, so it is work.
 */
/**
 * A park shorter than this saves almost nothing and risks closing the harness mid-fetch (the alarm
 * fires as the sleep would have ended), so by default a sleeper due sooner is waited for in-process.
 */
export const DEFAULT_MIN_PARK_MS = 1_000;

export function parkVerdict(snapshot: DriveSnapshot, minParkMs = DEFAULT_MIN_PARK_MS): ParkVerdict {
  const { now, inspection, docs } = snapshot;
  const margin = Math.max(1, minParkMs);
  const wait = (reason: string): ParkVerdict => ({ verdict: "wait", reason });

  for (const [id, { live, inbox }] of docs) {
    if (live?.generation?.message !== undefined) return wait(`conversation ${id} is streaming a response`);
    const busySlot = live?.tools?.find((slot) => slot.status !== "done");
    if (busySlot !== undefined) return wait(`conversation ${id} has tool call ${busySlot.callId} ${busySlot.status}`);
    if ((inbox?.items.length ?? 0) > 0 && live?.run === undefined) return wait(`conversation ${id} has queued input and no run`);
  }
  for (const submission of inspection.submissions) {
    const d = docs.get(submission.conversationId);
    if (d === undefined) return wait(`submission ${submission.id} belongs to a conversation not read`);
    if (submission.status === "queued" && d.live?.run === undefined) return wait(`submission ${submission.id} is queued with no run`);
  }

  if (inspection.tasks.length === 0) {
    return inspection.submissions.length === 0 ? { verdict: "idle" } : wait("submissions are unsettled with no live task");
  }

  const sleepers: Sleeper[] = [];
  for (const { record, state } of inspection.tasks) {
    const label = `task ${record.id} (${record.kind})`;
    if (!docs.has(record.conversationId)) return wait(`${label} belongs to a conversation not read`);
    if (record.abortRequested) return wait(`${label} is marked for abort`);
    if (state.kind === "waiting" && record.state.status === "waiting") continue;
    if (state.kind !== "running" || record.state.status !== "running") return wait(`${label} is ${state.kind}`);
    const activity = activityOf(record.kind, record.state.checkpoint);
    // Not parked, and named apart from "working": a task this table does not know may be sleeping in a
    // way only it knows (a new pi-durable phase, an extension's task calling `runtime.sleep`), and then
    // staying open is a billed wait that a diagnostic should be able to point at.
    if (activity.kind === "unrecognised") {
      return wait(`${label} has an unrecognised checkpoint ${JSON.stringify(record.state.checkpoint)?.slice(0, 200)}`);
    }
    if (activity.kind === "working") return wait(`${label} is working (${activity.phase})`);
    if (activity.until - now < margin) return wait(`${label} is due: ${activity.phase} until ${activity.until}, now ${now}`);
    sleepers.push({ taskId: record.id, phase: activity.phase, until: activity.until });
  }
  if (sleepers.length === 0) return wait("every live task waits on another and none sleeps");
  return { verdict: "park", until: Math.min(...sleepers.map((s) => s.until)), sleepers };
}

/**
 * Read a snapshot whose task and submission records did not move while the
 * documents were read: inspect, read the documents, inspect again, and retry
 * if the second inspection differs. The documents and the tasks are committed
 * together, so equal inspections either side of the reads bracket one state.
 */
export async function readSnapshot(harness: Harness, context: Context, now: () => number, attempts = 5): Promise<DriveSnapshot | undefined> {
  for (let i = 0; i < attempts; i++) {
    const at = now();
    const inspection = await harness.inspect(context);
    const ids = new Set<ConversationId>([
      ...inspection.tasks.map((t) => t.record.conversationId),
      ...inspection.submissions.map((s) => s.conversationId),
    ]);
    const docs = new Map<ConversationId, ConversationDocs>();
    for (const id of ids) {
      docs.set(id, {
        live: await harness.snapshot(LiveDoc, id, context),
        inbox: await harness.snapshot(InboxDoc, id, context),
      });
    }
    const again = await harness.inspect(context);
    if (JSON.stringify(again) === JSON.stringify(inspection)) return { now: at, inspection, docs };
  }
  return undefined;
}

export type SettleResult =
  | { readonly state: "idle" }
  | { readonly state: "parked"; readonly parkedUntil: number; readonly sleepers: readonly Sleeper[] }
  /** The deadline passed with work still running; the harness is left open. */
  | { readonly state: "timeout"; readonly last: ParkVerdict };

export type SettleOptions = {
  readonly context: Context;
  /** The harness's clock (`HarnessOptions.now`); the verdict must read the clock the sleeps use. */
  readonly now?: () => number;
  /** A sleeper due sooner than this is waited for in-process instead of parked. Default `DEFAULT_MIN_PARK_MS`. */
  readonly minParkMs?: number;
  /** Give up after this long and return `timeout` without closing. */
  readonly deadlineMs?: number;
  /** Re-read after this long without a commit. Every transition the verdict reads commits; this is a backstop. */
  readonly recheckMs?: number;
  /** Called with each verdict, for tests and traces. */
  readonly onVerdict?: (verdict: ParkVerdict) => void;
};

/**
 * Keep the harness open until it is idle or only sleeping, then close it.
 * Re-reads on every commit rather than on a timer, so a long tool call or a
 * fetch in flight costs no reads while it runs. On `idle` and `parked` the
 * harness is closed when this returns, and the caller sets the alarm.
 *
 * On "wait" it re-reads at once only if a commit landed during the read;
 * otherwise it blocks until the next commit or `recheckMs` (default 1 s). So a
 * task the table cannot classify (an "unrecognised checkpoint") costs one read
 * per second while it runs no code — never a tight loop — and keeps the object
 * open until that task commits or `deadlineMs` passes: a billed wait, which is
 * why test/durable-drive.ts fails when pi-durable's sleep sites move.
 */
export async function settle(harness: Harness, options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? Date.now;
  const started = now();
  let commits = 0;
  let wake: (() => void) | undefined;
  let subscribed = true;
  const stop = harness.subscribeCommits(() => { commits++; wake?.(); });
  const unsubscribe = () => { if (subscribed) { subscribed = false; stop(); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const seen = commits;
      const snapshot = await readSnapshot(harness, options.context, now);
      const verdict: ParkVerdict = snapshot === undefined
        ? { verdict: "wait", reason: "the state moved under every read" }
        : parkVerdict(snapshot, options.minParkMs);
      options.onVerdict?.(verdict);
      if (verdict.verdict === "idle" || verdict.verdict === "park") {
        unsubscribe();
        await harness.close(options.context);
        return verdict.verdict === "idle"
          ? { state: "idle" }
          : { state: "parked", parkedUntil: verdict.until, sleepers: verdict.sleepers };
      }
      if (options.deadlineMs !== undefined && now() - started >= options.deadlineMs) return { state: "timeout", last: verdict };
      if (commits !== seen) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, options.recheckMs ?? 1_000);
      });
      wake = undefined;
      clearTimeout(timer);
      timer = undefined;
    }
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
