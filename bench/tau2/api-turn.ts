/**
 * Waiting for an Agents API turn (bench/tau2/api.ts): the session's event stream, with a status read as the
 * fallback, and the stall evidence read at the deadline.
 *
 * The same contract as the `/bench` runner's wait (bench/tau2/wait.ts), over the public surface instead of the
 * object's socket:
 *   - the stream is `GET /v1/agents/sessions/:id/events` (SSE, cf/src/agents-api/events.ts). It is opened
 *     BEFORE the input that starts the work is sent, because it never replays what was there when it
 *     connected: an answer that lands in between would otherwise reach only the fallback;
 *   - every `lookEveryMs`, and right after a stream that closed early is reopened, the session and its turns
 *     and items are read (`snapshot`). An answer found that way counts as `poll`;
 *   - `seen` is the sequence of the last answer taken, and a turn counts only if it began after it, so a
 *     reconnect or a read between the input and the turn starting cannot hand back the previous answer.
 *
 * A turn can also stop to ask for the caller's functions (`requires_action`). That is not an answer: the
 * runner runs them and sends the results, and the same turn goes on.
 *
 * Everything the runner keeps across turns — the cursor, the delivery counts, the deliberate deafness — is
 * passed in, so this module holds no state of its own and a test can drive it with fixtures.
 */
import type { Delivered } from "./wait.ts";
import { stallEvidence, causeFromEvidence, type Poll, type StallCause, type StallEvidence } from "../poll-fallback.ts";

export type { Delivered };

/** The parts of the API's objects this runner reads (cf/src/agents-api/shapes.ts, transcript.ts). */
export interface RequiredAction { type: "function_call"; call_id: string; name: string; arguments: string; turn_id: string }
export interface ApiSession { id: string; status: string; required_actions?: RequiredAction[] }
export interface ApiTurn {
  id: string; status: string; error?: { message?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}
export interface ApiItem {
  id: string; type: string; turn_id: string; role?: string; phase?: string | null; status?: string;
  content?: Array<{ type?: string; text?: string }>; call_id?: string; name?: string; arguments?: string;
}
export interface Snapshot { session: ApiSession; turns: ApiTurn[]; items: ApiItem[] }
export interface SessionEvent { type: string; [k: string]: unknown }

/** `turn_<seq>` and `item_<seq>[_suffix]` carry the transcript entry's sequence (cf/src/agents-api/transcript.ts). */
export function seqOf(id: string): number {
  const m = /^(?:turn|item)_(\d+)/.exec(id);
  return m ? Number(m[1]) : -1;
}

const textOf = (i: ApiItem) => (i.content ?? []).map((c) => String(c?.text ?? "")).join("");
const isFinal = (i: ApiItem) => i.type === "message" && i.role === "assistant" && i.phase === "final_answer";

export type Decision =
  | { kind: "answer"; text: string; seen: number }
  | { kind: "actions"; calls: RequiredAction[] }
  | { kind: "failed"; message: string; seen: number }
  | null;

/**
 * What the session's state says, read whole — the fallback's reading.
 *
 * Calls the runner has already answered are left out (`answered`): between its results landing and the
 * status changing, a read can still show them, and running them twice would write twice.
 */
export function decideFromSnapshot(s: Snapshot, seen: number, answered: ReadonlySet<string> = new Set()): Decision {
  const asked = (s.session.required_actions ?? []).filter((a) => !answered.has(a.call_id));
  if (s.session.status === "requires_action" && asked.length) return { kind: "actions", calls: asked };
  const turn = s.turns.reduce<ApiTurn | null>((m, t) => (!m || seqOf(t.id) > seqOf(m.id) ? t : m), null);
  if (!turn || seqOf(turn.id) <= seen) return null;
  if (turn.status === "failed") {
    return { kind: "failed", message: String(turn.error?.message ?? "the model call failed"), seen: failedSeq(s.items, turn.id) };
  }
  if (turn.status !== "completed") return null;
  const final = s.items.filter((i) => i.turn_id === turn.id && isFinal(i)).at(-1);
  const text = final ? textOf(final) : "";
  // A completed turn with no text is not an answer, as on the `/bench` socket (deafness.ts `hearSocketEvent`).
  return text ? { kind: "answer", text, seen: seqOf(final!.id) } : null;
}

/**
 * The event stream's reading. `finals` collects the final answers the stream has shown, by turn, because the
 * item arrives in an `item.added` before the `turn.completed` that ends its turn.
 */
export function decideFromEvent(
  e: SessionEvent, seen: number, finals: Map<string, { text: string; seq: number }>, answered: ReadonlySet<string> = new Set(),
): Decision {
  if (e.type === "agent.session.turn.item.added") {
    const item = e.item as ApiItem | undefined;
    if (item && isFinal(item) && textOf(item)) finals.set(item.turn_id, { text: textOf(item), seq: seqOf(item.id) });
    return null;
  }
  if (e.type === "agent.session.requires_action") {
    const asked = ((e.session as ApiSession | undefined)?.required_actions ?? []).filter((a) => !answered.has(a.call_id));
    return asked.length ? { kind: "actions", calls: asked } : null;
  }
  const turnId = String(e.turn_id ?? "");
  if (seqOf(turnId) <= seen) return null;
  if (e.type === "agent.session.turn.failed") {
    const turn = e.turn as ApiTurn | undefined;
    return { kind: "failed", message: String(turn?.error?.message ?? "the model call failed"), seen: seqOf(turnId) + 1 };
  }
  if (e.type === "agent.session.turn.completed") {
    const f = finals.get(turnId);
    return f ? { kind: "answer", text: f.text, seen: f.seq } : null;
  }
  return null;
}

/**
 * Where a failed turn's failure sits in the transcript, as far as the items can say. The failed model call
 * leaves an entry the items do not show (transcript.ts skips `stopReason: "error"`), and it came after
 * everything else in its turn, so one past the turn's last item is a lower bound — enough for the only
 * comparisons made with it, "after the latest message" and "after what was already delivered".
 */
export function failedSeq(items: readonly ApiItem[], turnId: string): number {
  return Math.max(seqOf(turnId), ...items.filter((i) => i.turn_id === turnId).map((i) => seqOf(i.id))) + 1;
}

/** One SSE body as events: `event:`/`data:` blocks separated by a blank line; comments (`: keepalive`) skipped. */
export async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SessionEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        try { yield JSON.parse(data) as SessionEvent; } catch { /* a block that is not JSON is not an event */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export interface TurnWaitDeps {
  /** Opens the session's event stream; resolves once the server has answered, i.e. after its baseline read. */
  open(): Promise<{ events: AsyncIterable<SessionEvent>; close(): void }>;
  /** The session, its turns and its items, read whole; rejects when a request fails. */
  snapshot(): Promise<Snapshot>;
  /** Counts one delivery event (`Delivered`). */
  count(what: keyof Delivered): void;
  /** Whether this turn is deliberately not hearing answers from that path (bench/tau2/deafness.ts). */
  deaf(to: "socket" | "poll"): boolean;
  /** Where a deliberately ignored answer is mentioned. */
  say?(line: string): void;
  /** How often the fallback reads the session while the stream is open. */
  lookEveryMs?: number;
}

/**
 * Wait for the next thing the runner must act on: an answer, calls to run, or a failed turn. Null at the
 * deadline. `start` sends what begins the work (the input, or the function results), after the stream is open.
 *
 * An answer heard deliberately deaf is dropped without moving the cursor, so the fallback can still find it
 * (the ordering bench/tau2/deafness.ts pins for the socket). Calls and failures are never ignored: deafness
 * is about losing an answer, and the turn could not go on without the calls.
 */
export async function waitForTurn(
  seen: number, deadline: number, start: (() => Promise<void>) | null, deps: TurnWaitDeps,
  answered: ReadonlySet<string> = new Set(),
): Promise<Decision> {
  let first = true;
  while (Date.now() < deadline) {
    let stream: Awaited<ReturnType<TurnWaitDeps["open"]>>;
    try { stream = await deps.open(); }
    catch { deps.count("dropped"); await sleepUntil(Math.min(deadline, Date.now() + 1_000)); continue; }
    const reconnect = !first;
    if (first && start) {
      try { await start(); } catch (e) { stream.close(); throw e; }
    }
    first = false;
    const d = await oneStream(stream, seen, deadline, deps, answered, reconnect);
    if (d !== "dropped") return d;
  }
  return null;
}

async function oneStream(
  stream: { events: AsyncIterable<SessionEvent>; close(): void }, seen: number, deadline: number,
  deps: TurnWaitDeps, answered: ReadonlySet<string>, lookNow: boolean,
): Promise<Decision | "dropped"> {
  let done = false;
  let settle!: (d: Decision | "dropped") => void;
  const result = new Promise<Decision | "dropped">((r) => { settle = r; });
  const stop = (d: Decision | "dropped") => {
    if (done) return;
    done = true;
    clearInterval(look); clearTimeout(timer);
    stream.close();
    settle(d);
  };
  const finals = new Map<string, { text: string; seq: number }>();

  // The fallback: a lost or late event must not become a stall (bench/poll-fallback.ts).
  const poll = () => void deps.snapshot().then((s) => {
    if (done) return;
    deps.count("pollAnswered");
    const d = decideFromSnapshot(s, seen, answered);
    if (!d) return;
    if (d.kind === "answer" && deps.deaf("poll")) { deps.say?.("    (ignoring the status read's answer on purpose)"); return; }
    if (d.kind === "answer") deps.count("poll");
    stop(d);
  }, () => { if (!done) deps.count("pollFailed"); });
  const look = setInterval(poll, deps.lookEveryMs ?? 20_000);
  const timer = setTimeout(() => stop(null), Math.max(0, deadline - Date.now()));
  // A reopened stream starts from what is there now, so whatever changed while it was down is read at once.
  if (lookNow) poll();

  void (async () => {
    try {
      for await (const e of stream.events) {
        if (done) return;
        const d = decideFromEvent(e, seen, finals, answered);
        if (!d) continue;
        if (d.kind === "answer" && deps.deaf("socket")) { deps.say?.("    (ignoring the stream's answer on purpose)"); continue; }
        if (d.kind === "answer") deps.count("push");
        stop(d);
        return;
      }
    } catch { /* a stream that errors has ended, as below */ }
    // A stream that ends before this wait has its answer is a drop, whatever comes next.
    if (!done) { deps.count("dropped"); stop("dropped"); }
  })();
  return result;
}

const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now())));

/**
 * The deadline reading, over the API's objects: the same evidence and the same criterion as the `/bench`
 * runner (bench/poll-fallback.ts `stallAtDeadline`), so a stall in either record is named by one rule.
 *
 * The evidence is built the way `/bench/poll` built it (src/bench/poll-body.ts), from the items instead of the
 * object's events:
 *   status    `idle` only when the session is idle and its latest turn has ended — the session reads idle
 *             between an input landing and the lane picking it up, while the turn already says it has not
 *             ended. Anything else is `running`, the old body's only other word, `requires_action` included:
 *             a turn waiting on the caller's functions has not finished either.
 *   last      `message` the latest user message, `response` the latest assistant entry of any kind (as
 *             `model.response` was), `failed` the latest failed turn's lower bound (`failedSeq`); -1 for none.
 *   answer    the latest final answer's text, as the old body's was the latest reply without calls.
 *   tail      the last items, by sequence and the event kind they stand for.
 */
export function apiPollBody(s: Snapshot): Poll {
  const latest = s.turns.reduce<ApiTurn | null>((m, t) => (!m || seqOf(t.id) > seqOf(m.id) ? t : m), null);
  const ended = !latest || ["completed", "failed", "cancelled"].includes(latest.status);
  const status = s.session.status === "idle" && ended ? "idle" : "running";
  const kindOf = (i: ApiItem) => i.type === "function_call_output" ? "tool.result"
    : i.type === "message" && i.role === "user" ? "message" : "model.response";
  const max = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), -1);
  const failedTurns = s.turns.filter((t) => t.status === "failed");
  return {
    status,
    answer: ((f) => (f ? textOf(f) : null))(s.items.filter(isFinal).at(-1)),
    last: {
      message: max(s.items.filter((i) => kindOf(i) === "message").map((i) => seqOf(i.id))),
      response: max(s.items.filter((i) => kindOf(i) === "model.response").map((i) => seqOf(i.id))),
      failed: max(failedTurns.map((t) => failedSeq(s.items, t.id))),
    },
    // One entry per transcript entry, as the old tail was one per event: an assistant entry is several items.
    tail: [...new Map(s.items.map((i) => [seqOf(i.id), { seq: seqOf(i.id), kind: kindOf(i) }])).values()].slice(-5),
  };
}

export async function apiStallAtDeadline(
  snapshot: () => Promise<Snapshot>, seen: number,
): Promise<{ stall: StallCause; stallWhy: StallEvidence }> {
  const s = await snapshot().catch(() => null);
  const stallWhy = stallEvidence(s ? apiPollBody(s) : null, seen);
  return { stall: causeFromEvidence(stallWhy), stallWhy };
}
