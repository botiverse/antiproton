/**
 * Waiting for the object to finish a τ² turn, on its events socket (bench/tau2/cf.ts, WAIT=push).
 *
 * In its own module so that a test can drive it against a local server: the driver itself reads secrets
 * and the task data at import. What the driver keeps for itself — the cursor, the failures, the delivery
 * counts, the deliberate deafness — it passes in, so this module holds no state of its own.
 */
import { decideFromPoll } from "../poll-fallback.ts";
import { closableSocket } from "../ws.ts";
import { hearPollDecision, hearSocketEvent } from "./deafness.ts";

/**
 * Which path brought each turn's answer, and how often each path was given
 * the chance. `poll: 0` alone cannot tell "no push was lost" from "the
 * fallback never ran". `pollAnswered` and `pollFailed`
 * count the fallback's polls that came back and that failed, so both zero
 * means none was sent; `dropped` counts sockets that closed or failed before
 * an answer.
 */
export type Delivered = { push: number; poll: number; pollAnswered: number; pollFailed: number; dropped: number };

export interface PushWaitDeps {
  /** The events socket's URL for a task, resuming after `after`. */
  socketUrl: (taskId: string, after: number) => string;
  /** Sent on the upgrade. */
  headers: Record<string, string>;
  /** The object's `/bench/poll` for this task; rejects when the request fails. */
  poll: (taskId: string) => Promise<any>;
  /** How far each task's stream has been read, so a reconnect does not replay a previous turn's answer. */
  seen: Map<string, number>;
  /** Why a turn ended without an answer, when the object said why. */
  failed: Map<string, string>;
  /** Counts one delivery event for a task (`Delivered`). */
  count: (taskId: string, what: keyof Delivered) => void;
  /** Whether this turn is deliberately not hearing answers from that path (bench/tau2/deafness.ts). */
  deaf: (to: "socket" | "poll") => boolean;
  /** Where a deliberately ignored answer is mentioned; nothing when absent. */
  say?: (line: string) => void;
  /** How often the socket is pinged and the object polled. */
  lookEveryMs?: number;
  /** How long a closed socket is given to finish its closing handshake before it is torn down (bench/ws.ts). */
  closeGraceMs?: number;
}

/** The turn is over when the model replies with text and no tool call — which
 *  is the same rule the object applies, read from the same event stream the
 *  console reads.
 *
 *  Reconnects rather than gives up. A socket that drops mid-turn is not an
 *  agent that stalled, and scoring it as one would blame the harness for the
 *  network; the cursor means a reconnect resumes where it left off instead of
 *  replaying the previous turn's answer and ending the conversation early. */
export async function pushForAnswer(taskId: string, deadline: number, deps: PushWaitDeps): Promise<string | null> {
  while (Date.now() < deadline) {
    const answer = await oneSocket(taskId, deadline, deps);
    if (answer !== null) return answer;
  }
  return null;
}

function oneSocket(taskId: string, deadline: number, deps: PushWaitDeps): Promise<string | null> {
  const { seen, failed, count } = deps;
  // The token goes on the upgrade too: /bench/* is gated (task #15), and a
  // refused upgrade reaches a WebSocket client only as close 1006 with no body,
  // which this runner then scored as a stalled agent.
  const { ws, close } = closableSocket(deps.socketUrl(taskId, seen.get(taskId) ?? 0), deps.headers, deps.closeGraceMs ?? 5_000);
  return new Promise<string | null>((resolve) => {
    let done = false;
    const stop = (v: string | null) => {
      if (done) return;
      done = true;
      clearInterval(keepalive); clearTimeout(timer);
      close();
      resolve(v);
    };
    // The object answers a ping, which is the only thing keeping an idle
    // connection from being closed underneath a slow model call.
    const keepalive = setInterval(() => {
      try { ws.send("ping"); } catch { /* closing */ }
      // A lost push must not become a stall: the object may have answered already (bench/poll-fallback.ts).
      void deps.poll(taskId).then((poll: any) => {
        count(taskId, "pollAnswered");
        const d = decideFromPoll(poll, seen.get(taskId) ?? 0);
        if (!d) return;
        const heard = hearPollDecision(d, deps.deaf("poll"));
        if (heard.kind === "ignored") { deps.say?.("    (ignoring the poll's answer on purpose)"); return; }
        seen.set(taskId, heard.seen!);
        if (heard.kind === "failed") { failed.set(taskId, "the model call failed (seen by poll after a lost push)"); stop(null); }
        else { if (!done) count(taskId, "poll"); stop((heard as { text: string }).text); }
      }, () => {
        // Only the request failing counts here; the socket or the next tick will do.
        count(taskId, "pollFailed");
      }).catch(() => { /* a fault in handling an answer is not a failed poll */ });
    }, deps.lookEveryMs ?? 20_000);
    const timer = setTimeout(() => stop(null), Math.max(0, deadline - Date.now()));
    // A socket that ends before this turn's answer is a drop, whatever comes next.
    const drop = () => { if (!done) count(taskId, "dropped"); stop(null); };
    ws.onerror = drop;
    ws.onclose = drop;
    ws.onmessage = (ev) => {
      let e: any;
      try { e = JSON.parse(String(ev.data)); } catch { return; }
      if (e.kind === "pong") return;
      // A failed model call ends the turn as surely as an answer does, and
      // waiting out the timeout would report it as a stall — which blames the
      // wrong thing.
      if (e.kind === "model.failed") {
        failed.set(taskId, String(e.payload?.error ?? "the model call failed"));
        stop(null);
        return;
      }
      // What to do with it, including whether the cursor moves, lives in bench/tau2/deafness.ts so that
      // the ordering is a function a test can call rather than a shape only this closure knows.
      const heard = hearSocketEvent(e, deps.deaf("socket"));
      if (heard.kind === "ignored") {
        deps.say?.("    (ignoring the socket's answer on purpose)");
        return;
      }
      if (heard.seen !== null) seen.set(taskId, heard.seen);
      if (heard.kind === "answer") {
        if (!done) count(taskId, "push");
        stop(heard.text);
      }
    };
  });
}
