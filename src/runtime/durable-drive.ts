/**
 * When a pi-durable harness may be closed and woken again by an alarm.
 *
 * pi-agent-core's `drive()` returned `waiting` when the provider answered
 * `deferred`, and the object went idle. pi-durable has no such return: its
 * generation task commits a `poll` checkpoint and then *sleeps in-process*
 * until `pollAt` (a retry or a compaction retry sleeps until `until` the same
 * way). A Durable Object that stayed open for that sleep would be billed for
 * it, which is the cost the offloaded provider (src/model/durable-offloaded.ts)
 * exists to avoid. What replaces `waiting` is this: when the harness is doing
 * nothing but sleeping until T, close it and set an alarm for T. Closing is
 * safe at any point — it aborts invocations and writes no task outcome, so a
 * reopened harness resumes each task from its last checkpoint — and the alarm
 * reopens it and calls `resume()`.
 *
 * Who says "sleeping until T" is the scheduler itself: pi-durable 1.0.0 reports a
 * sleeping task as plain `running`, so we run a vendored scheduler
 * (src/vendor/pi/pi-durable/dist/harness/scheduler.js, upstream issue
 * earendil-works/pi#10325) whose `inspect()` adds `sleepingUntil` while a task's
 * invocation is inside `runtime.sleep`, and whose `onSleep` option says when one
 * starts. Before it, this file inferred the sleep from checkpoint phases (a
 * `poll` checkpoint's `pollAt`, a `retry` checkpoint's `until`) and kept a table
 * of every phase pi-durable writes; any sleep, built-in or an extension's, is now
 * reported the same way, and a running task not inside a sleep is working.
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
 * `settle` are the harness glue; `DurableAgent` (src/runtime/durable-agent.ts) calls `settle`.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  InboxDoc, LiveDoc, ToolTask,
  type ConversationId, type Harness, type HarnessInspection, type InboxState, type JsonObject,
  type LiveState, type TaskId, type TaskInspection,
} from "@earendil-works/pi-durable";
import type { RunningSleep } from "../vendor/pi/pi-durable/dist/harness/harness.js";

export type ConversationDocs = { readonly live: Readonly<LiveState> | undefined; readonly inbox: Readonly<InboxState> | undefined };

/** Everything the verdict reads, taken at one instant of the harness clock. */
export type DriveSnapshot = {
  readonly now: number;
  readonly inspection: HarnessInspection;
  /** `pi.live` and `pi.inbox` of every conversation a live task or an unsettled submission belongs to. */
  readonly docs: ReadonlyMap<ConversationId, ConversationDocs>;
  /**
   * Tool calls that wait on someone outside the object, by conversation: an Agents API caller running a function
   * itself (`ap_client_calls`, src/runtime/durable-agent.ts). Absent: none.
   */
  readonly externalWaits?: ExternalWaits;
};

/** Call ids, by conversation, whose tool waits on someone outside the object to answer it. */
export type ExternalWaits = ReadonlyMap<ConversationId, ReadonlySet<string>>;

/** A tool task running no code of its own until someone outside the object answers its call. */
export type ExternalWait = { readonly taskId: TaskId; readonly conversationId: ConversationId; readonly callId: string };

/**
 * A task whose invocation is inside `runtime.sleep(until)` and runs no code before it: a generation polling or
 * backing off, a compaction backing off, an extension's task waiting. `phase` is its checkpoint's, for diagnostics.
 */
export type Sleeper = { readonly taskId: TaskId; readonly phase: string | undefined; readonly until: number };

export type ParkVerdict =
  /** Nothing live and nothing queued: close, set no alarm. */
  | { readonly verdict: "idle" }
  /**
   * Only sleeping: close, and set an alarm for `until`, the earliest sleeper's wake time. `external` are tool calls
   * waiting on someone outside the object as well; their answer, not the alarm, wakes them.
   */
  | { readonly verdict: "park"; readonly until: number; readonly sleepers: readonly Sleeper[]; readonly external: readonly ExternalWait[] }
  /**
   * Nothing runs and nothing sleeps: every live task waits, at the end of the chain, on someone outside the object.
   * Close, and set no alarm: the answer is what wakes it (`DurableAgent.answerClientCalls`).
   */
  | { readonly verdict: "external"; readonly external: readonly ExternalWait[] }
  /** Work is running or about to: stay open. `reason` names the first thing that said so. */
  | { readonly verdict: "wait"; readonly reason: string };

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL = ToolTask.definition.name;

/** The wake time the vendored scheduler reports for a task inside `runtime.sleep`; undefined for anything else. */
export function sleepingUntil(state: TaskInspection["state"]): number | undefined {
  const until = state.kind === "running" ? (state as RunningSleep).sleepingUntil : undefined;
  return typeof until === "number" ? until : undefined;
}

/**
 * The park predicate. "park" requires all of:
 * - at least one live task, and every live task either a sleeper or parked
 *   `waiting` on other tasks (which runs no code until they settle);
 * - every sleeper reported by the scheduler as inside `runtime.sleep` (`sleepingUntil`), not abort-marked,
 *   and its wake time at least `minParkMs` (default 1000, never below 1) after `now` — strictly in the future.
 *   A running task without `sleepingUntil` is working, whatever its checkpoint says;
 * - in every conversation involved, no committed partial of a streaming response and
 *   no tool slot that is not done, except a running one whose call is an external wait;
 * - queued input only where a run already holds the conversation: it waits for that
 *   run's next boundary. Queued input with no run would start one, so it is work.
 *
 * The scheduler's report replaces only the checkpoint reading: it says what each
 * task's invocation is doing now. The document and submission checks stay because
 * they read what it does not cover — committed conversation state (a partial, an
 * unfinished tool slot, queued input) that work no live invocation holds yet would
 * act on — and they read only pi-durable's public document types.
 *
 * A tool task running its call (`execute`) whose call id is in `externalWaits` counts as
 * neither working nor sleeping: it waits for someone outside the object, whose answer
 * reopens the harness. Closing it is safe only because such a tool is replay-safe: the
 * close aborts it, nothing is recorded, and the reopened harness runs it again, which
 * then finds the answer. With sleepers as well, the verdict is "park" with their wake
 * time; with none, "external", which sets no alarm.
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
  const external = (id: ConversationId, callId: unknown) =>
    typeof callId === "string" && (snapshot.externalWaits?.get(id)?.has(callId) ?? false);

  for (const [id, { live, inbox }] of docs) {
    if (live?.generation?.message !== undefined) return wait(`conversation ${id} is streaming a response`);
    const busySlot = live?.tools?.find((slot) => slot.status !== "done" && !(slot.status === "running" && external(id, slot.callId)));
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
  const outside: ExternalWait[] = [];
  for (const { record, state } of inspection.tasks) {
    const label = `task ${record.id} (${record.kind})`;
    if (!docs.has(record.conversationId)) return wait(`${label} belongs to a conversation not read`);
    if (record.abortRequested) return wait(`${label} is marked for abort`);
    if (state.kind === "waiting" && record.state.status === "waiting") continue;
    const callId = isObject(record.input as JsonValue) ? (record.input as JsonObject).callId : undefined;
    const checkpoint = record.state.status === "running" ? record.state.checkpoint : undefined;
    if (record.kind === TOOL && state.kind === "running" && record.state.status === "running"
      && isObject(checkpoint) && checkpoint.phase === "execute" && external(record.conversationId, callId)) {
      outside.push({ taskId: record.id, conversationId: record.conversationId, callId: callId as string });
      continue;
    }
    if (state.kind !== "running" || record.state.status !== "running") return wait(`${label} is ${state.kind}`);
    const phase = isObject(checkpoint) && typeof checkpoint.phase === "string" ? checkpoint.phase : undefined;
    const until = sleepingUntil(state);
    if (until === undefined) return wait(`${label} is working (${phase ?? "no phase"})`);
    if (until - now < margin) return wait(`${label} is due: sleeping until ${until}, now ${now}`);
    sleepers.push({ taskId: record.id, phase, until });
  }
  if (sleepers.length === 0) {
    return outside.length === 0 ? wait("every live task waits on another and none sleeps") : { verdict: "external", external: outside };
  }
  return { verdict: "park", until: Math.min(...sleepers.map((s) => s.until)), sleepers, external: outside };
}

/**
 * Read a snapshot whose task and submission records did not move while the
 * documents were read: inspect, read the documents, inspect again, and retry
 * if the second inspection differs. The documents and the tasks are committed
 * together, so equal inspections either side of the reads bracket one state.
 */
export async function readSnapshot(
  harness: Harness, context: Context, now: () => number, attempts = 5, externalWaits?: () => ExternalWaits,
): Promise<DriveSnapshot | undefined> {
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
    // Read between the two inspections: an answer that lands after it is seen by the next read, which its
    // notice (`SettleOptions.subscribe`) asks for.
    const waits = externalWaits?.();
    const again = await harness.inspect(context);
    if (JSON.stringify(again) === JSON.stringify(inspection)) return { now: at, inspection, docs, ...(waits ? { externalWaits: waits } : {}) };
  }
  return undefined;
}

export type SettleResult =
  | { readonly state: "idle" }
  | { readonly state: "parked"; readonly parkedUntil: number; readonly sleepers: readonly Sleeper[] }
  /** Closed, with tool calls waiting on someone outside the object and nothing to set an alarm for. */
  | { readonly state: "external"; readonly external: readonly ExternalWait[] }
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
  /**
   * Re-read after this long without a commit or a notice. Every transition the verdict reads commits or is noticed
   * through `subscribe`; this is a backstop.
   */
  readonly recheckMs?: number;
  /** Called with each verdict, for tests and traces. */
  readonly onVerdict?: (verdict: ParkVerdict) => void;
  /** Read with each snapshot: calls whose tool waits on someone outside the object (`DriveSnapshot.externalWaits`). */
  readonly externalWaits?: () => ExternalWaits;
  /**
   * Other sources of "read again", for what moves without a pi-durable commit: `externalWaits` (a tool records its
   * call in our own table), and a task starting to sleep after work it did not commit, which the harness tells its
   * `onSleep` option (`HarnessOptions.onSleep`, the vendored scheduler). Returns the unsubscribe.
   */
  readonly subscribe?: (wake: () => void) => () => void;
};

/**
 * Keep the harness open until it is idle or only sleeping, then close it.
 * Re-reads on every commit rather than on a timer, so a long tool call or a
 * fetch in flight costs no reads while it runs. On `idle` and `parked` the
 * harness is closed when this returns, and the caller sets the alarm.
 *
 * On "wait" it re-reads at once only if a commit landed during the read;
 * otherwise it blocks until the next commit, the next `subscribe` notice, or
 * `recheckMs` (default 1 s) — never a tight loop. A sleep commits nothing: one
 * that starts right after its checkpoint's commit is seen by the read that
 * commit brings (pi-durable's own sleeps), and one that starts later is seen at
 * the next recheck unless `onSleep` is passed in through `subscribe`. A working task keeps the object open until it
 * commits or `deadlineMs` passes.
 */
export async function settle(harness: Harness, options: SettleOptions): Promise<SettleResult> {
  const now = options.now ?? Date.now;
  const started = now();
  let commits = 0;
  let wake: (() => void) | undefined;
  let subscribed = true;
  const stop = harness.subscribeCommits(() => { commits++; wake?.(); });
  const stopOther = options.subscribe?.(() => { commits++; wake?.(); });
  const unsubscribe = () => { if (subscribed) { subscribed = false; stop(); stopOther?.(); } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (;;) {
      const seen = commits;
      const snapshot = await readSnapshot(harness, options.context, now, 5, options.externalWaits);
      const verdict: ParkVerdict = snapshot === undefined
        ? { verdict: "wait", reason: "the state moved under every read" }
        : parkVerdict(snapshot, options.minParkMs);
      options.onVerdict?.(verdict);
      if (verdict.verdict !== "wait") {
        unsubscribe();
        await harness.close(options.context);
        return verdict.verdict === "idle" ? { state: "idle" }
          : verdict.verdict === "external" ? { state: "external", external: verdict.external }
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
