/**
 * Session events as SSE, held by the Worker (task #17, step 3).
 *
 * The stream is a diff: the Worker reads the session's items, turns and status
 * from the agent's object in short calls, and writes what changed since the
 * last read. It is never held inside the object — an open SSE cannot hibernate,
 * so a stream held there would bill the object for the whole turn and undo the
 * point of offloading the model wait (#16). What is already there when a client
 * connects is the baseline and is not replayed: the SDK's `sessions.stream`
 * subscribes to an idle session and then sends input, and follows the first
 * turn it sees created, so a replayed old turn followed by `idle` would end its
 * iteration before the new turn began.
 *
 * Depends on: openai 7.15.0 — resources/beta/agents/agents.d.ts (AgentSessionEvent and its members) and
 *   lib/agents/turn-state.js (when sessions.stream stops). When either changes, re-check the event shapes
 *   and order here, and sdkStopsAt in test/agents-api-events.ts.
 */
import type { ApiItem, ApiTurn } from "./transcript.ts";

export interface PendingCall { call_id: string; name: string; arguments: string; turn_id: string }
export interface Snapshot {
  items: ApiItem[]; turns: ApiTurn[]; status: "idle" | "in_progress" | "requires_action" | "failed"; pending?: PendingCall[];
}
export type SessionEvent = { type: string; event_id: string } & Record<string, unknown>;

const TERMINAL_TURN = new Set(["completed", "failed", "cancelled"]);
const SETTLED_ITEM = new Set(["completed", "incomplete", "failed"]);

/** An item the SDK treats as agent output, which gets an `item.done` once it has settled. */
const isOutput = (i: ApiItem) =>
  i.type === "reasoning" || i.type === "function_call" || (i.type === "message" && i.role === "assistant");

export function eventsBetween(
  prev: Snapshot, next: Snapshot, ids: { sessionId: string },
  sessionWith: (status: Snapshot["status"], pending?: PendingCall[]) => Record<string, unknown>, eventId: () => string,
): SessionEvent[] {
  const out: SessionEvent[] = [];
  const push = (e: Record<string, unknown> & { type: string }) => out.push({ ...e, event_id: eventId() });
  const session_id = ids.sessionId;
  const prevTurns = new Map(prev.turns.map((t) => [t.id, t]));
  const prevItems = new Map(prev.items.map((i) => [i.id, i]));

  if (next.status === "in_progress" && prev.status !== "in_progress") {
    push({ type: "agent.session.in_progress", session: sessionWith(next.status, next.pending) });
  }
  for (const t of next.turns) {
    const was = prevTurns.get(t.id);
    if (!was) push({ type: "agent.session.turn.created", session_id, turn_id: t.id, turn: t });
    if (t.status === "in_progress" && was?.status !== "in_progress") {
      push({ type: "agent.session.turn.in_progress", session_id, turn_id: t.id, turn: t });
    }
  }
  const indexInTurn = new Map<string, number>();
  for (const item of next.items) {
    const output_index = indexInTurn.get(item.turn_id) ?? 0;
    indexInTurn.set(item.turn_id, output_index + 1);
    const was = prevItems.get(item.id);
    const base = { session_id, turn_id: item.turn_id, output_index };
    if (!was) {
      push({ type: "agent.session.turn.item.added", ...base, item });
      if (item.type === "message" && item.role === "assistant") {
        const text = String((item.content as Array<{ text?: string }>)[0]?.text ?? "");
        const part = { ...base, item_id: item.id, content_index: 0 };
        push({ type: "agent.session.turn.output_text.delta", ...part, delta: text });
        push({ type: "agent.session.turn.output_text.done", ...part, text });
      }
    }
    if (isOutput(item) && SETTLED_ITEM.has(String(item.status)) && !(was && SETTLED_ITEM.has(String(was.status)))) {
      push({ type: "agent.session.turn.item.done", ...base, item });
    }
  }
  let ended = false;
  for (const t of next.turns) {
    const was = prevTurns.get(t.id);
    if (TERMINAL_TURN.has(t.status) && !(was && TERMINAL_TURN.has(was.status))) {
      push({ type: `agent.session.turn.${t.status}`, session_id, turn_id: t.id, turn: t, usage: t.usage });
      ended = true;
    }
  }
  // `idle` after a turn ends even if the last read already said idle: a turn can
  // be queued and finished between two reads, and the SDK only stops on a turn's
  // end followed by idle.
  if (next.status === "idle" && (prev.status !== "idle" || ended)) {
    push({ type: "agent.session.idle", session: sessionWith(next.status, next.pending) });
  }
  // After the items, so the function call the caller is asked to run has already been shown.
  const asked = (s: Snapshot) => (s.pending ?? []).map((p) => p.call_id).sort().join();
  if (next.status === "requires_action" && (prev.status !== "requires_action" || asked(prev) !== asked(next))) {
    push({ type: "agent.session.requires_action", session: sessionWith(next.status, next.pending) });
  }
  if (next.status === "failed" && prev.status !== "failed") {
    push({ type: "agent.session.failed", session: sessionWith(next.status, next.pending) });
  }
  return out;
}

export const sse = (e: SessionEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

// A session waiting on its caller is read quickly too: the SDK answers as soon as it sees the call.
const isActive = (s: Snapshot) => s.status === "in_progress" || s.status === "requires_action"
  || s.turns.some((t) => t.status === "queued" || t.status === "in_progress");

/** How long the Worker waits before reading again: quickly while work runs, backing off while idle. */
export function nextReadDelay(next: Snapshot, idleReads: number): number {
  return isActive(next) ? 1000 : Math.min(5000, 1000 * 2 ** idleReads);
}

export const STREAM_MAX_MS = 30 * 60_000;
/** With change notices, how long to wait before reading anyway: a fallback for a lost notice, not a schedule. */
export const NOTICE_FALLBACK_ACTIVE_MS = 5_000;
export const NOTICE_FALLBACK_IDLE_MS = 15_000;
export const KEEPALIVE_MS = 15_000;

/**
 * Write events until the client goes away or the stream reaches its ceiling.
 * `baseline` is the state the client already has (see the header): nothing in it
 * is sent again.
 */
export async function pumpSessionEvents(o: {
  baseline: Snapshot;
  read(): Promise<Snapshot>;
  write(text: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Resolves when the agent's object says something changed, or after the fallback (watch.ts). Absent: poll. */
  wait?(fallbackMs: number): Promise<unknown>;
  now(): number;
  sessionId: string;
  sessionWith(status: Snapshot["status"], pending?: PendingCall[]): Record<string, unknown>;
  eventId(): string;
  maxMs?: number;
}): Promise<"closed" | "ceiling"> {
  const start = o.now();
  const maxMs = o.maxMs ?? STREAM_MAX_MS;
  let prev = o.baseline;
  let idleReads = 0;
  let lastWrite = start;
  try {
    while (o.now() - start < maxMs) {
      if (o.wait) await o.wait(isActive(prev) ? NOTICE_FALLBACK_ACTIVE_MS : NOTICE_FALLBACK_IDLE_MS);
      else await o.sleep(nextReadDelay(prev, idleReads));
      const next = await o.read();
      const events = eventsBetween(prev, next, { sessionId: o.sessionId }, o.sessionWith, o.eventId);
      if (events.length) {
        await o.write(events.map(sse).join(""));
        lastWrite = o.now();
      } else if (o.now() - lastWrite >= KEEPALIVE_MS) {
        await o.write(": keepalive\n\n");
        lastWrite = o.now();
      }
      idleReads = events.length || isActive(next) ? 0 : idleReads + 1;
      prev = next;
    }
    return "ceiling";
  } catch {
    return "closed";
  }
}
