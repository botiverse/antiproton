/**
 * Waiting for a SWE-bench agent to settle, on the object's event socket (bench/swebench/cf.ts).
 *
 * The agent phase is over when the agent has settled: it replied with text and
 * no tool call, it is not running, and no background job of its is still out.
 * A text reply alone is not enough — with a job out the agent says "waiting for
 * the queued commands to finish" and the job's result wakes it again — and
 * grading at that reply scored a tree the agent was still editing.
 *
 * The socket (the hibernation-API one the console uses) says when to look; the
 * object's own `/bench/poll` decides (`decideFromPoll`), because only the object
 * knows whether a job is out. A text reply on the socket triggers that look at
 * once, and a slow look every 20 s covers a push that never came. Polling alone
 * would measure the poller: every poll wakes the object and is billed.
 *
 * Reconnects rather than gives up: a socket dropped mid-turn is not an agent
 * that stalled, and the cursor means a reconnect resumes rather than replays.
 *
 * In its own module so that a test can drive it against a local server: the
 * driver itself reads secrets and fetches the dataset at import.
 */
import type { Socket } from "node:net";
import { Agent, WebSocket, buildConnector } from "undici";
import { decideFromPoll, type Poll } from "../poll-fallback.ts";

export interface WaitDeps {
  /** The events socket's URL for a task, resuming after `after`. */
  socketUrl: (taskId: string, after: number) => string;
  /** Sent on the upgrade: /bench/* is gated, and a refused upgrade reaches a client only as close 1006. */
  headers: Record<string, string>;
  /** The object's `/bench/poll` for this task. */
  poll: (taskId: string) => Promise<Poll>;
  /** The highest event id each task's socket delivered, so a reconnect resumes. */
  seen: Map<string, number>;
  /** Why a task's model call failed, once one did. */
  failed: Map<string, string>;
  /** How often the socket is pinged and the object polled. */
  lookEveryMs?: number;
  /** How long a closed socket is given to finish its closing handshake before it is torn down. */
  closeGraceMs?: number;
}

export async function waitForAnswer(taskId: string, deadline: number, deps: WaitDeps): Promise<string | null> {
  while (Date.now() < deadline) {
    const answer = await oneSocket(taskId, deadline, deps);
    if (answer !== null) return answer;
    if (deps.failed.has(taskId)) return null;
  }
  return null;
}

/**
 * A WebSocket whose closing does not depend on the far end.
 *
 * `close()` on a WebSocket only starts the closing handshake: undici then waits for the server's close
 * frame and for the server to drop the TCP connection, with no timeout of its own. A peer that answers
 * the close frame but keeps the connection open, or never answers, leaves an established socket that
 * holds the event loop for good — the driver wrote its record and never exited, with one ESTABLISHED
 * TLS socket to Cloudflare left (3 of 3 runs, measured 2026-10-03 on build a1283d2). So the socket is
 * created through a connector that keeps hold of it, and a close the server has not completed within
 * the grace is finished here by destroying it.
 */
function closableSocket(url: string, headers: Record<string, string>, graceMs: number) {
  let raw: Socket | null = null;
  const connect = buildConnector({});
  const agent = new Agent({
    connect: (opts, cb) => connect(opts, (err, s) => { if (s) raw = s as Socket; (cb as any)(err, s); }),
  });
  const ws = new WebSocket(url, { headers, dispatcher: agent });
  let closed = false;
  ws.addEventListener("close", () => { closed = true; });
  const close = () => {
    try { ws.close(); } catch { /* already gone */ }
    const finish = () => { raw?.destroy(); void agent.destroy().catch(() => {}); };
    if (closed) { finish(); return; }
    // Unref'd: it must not be what keeps a finished driver alive, and the socket it is waiting on will.
    const t = setTimeout(finish, graceMs);
    t.unref();
    ws.addEventListener("close", () => { clearTimeout(t); finish(); });
  };
  return { ws, close };
}

function oneSocket(taskId: string, deadline: number, deps: WaitDeps): Promise<string | null> {
  const { ws, close } = closableSocket(deps.socketUrl(taskId, deps.seen.get(taskId) ?? 0), deps.headers, deps.closeGraceMs ?? 5_000);
  return new Promise<string | null>((resolve) => {
    let done = false;
    // Every way out of this socket goes through here, so every one of them closes it.
    const stop = (v: string | null) => {
      if (done) return;
      done = true;
      clearInterval(keepalive); clearTimeout(timer);
      close();
      resolve(v);
    };
    // One task is one message, so no answer has been taken before this one: the floor is 0, not the socket's
    // cursor, which has already passed the reply that triggered the look.
    const look = () => {
      void deps.poll(taskId).then((poll) => {
        const d = decideFromPoll(poll, 0);
        if (!d) return;
        if (d.kind === "failed") { deps.failed.set(taskId, "the model call failed (seen by poll)"); stop(null); }
        else stop(d.text);
      }).catch(() => { /* the socket or the next tick will do */ });
    };
    const keepalive = setInterval(() => {
      try { ws.send("ping"); } catch { /* closing */ }
      // A lost push must not become a stall: the object may have answered already (bench/poll-fallback.ts).
      look();
    }, deps.lookEveryMs ?? 20_000);
    const timer = setTimeout(() => stop(null), Math.max(0, deadline - Date.now()));
    ws.onerror = () => stop(null);
    ws.onclose = () => stop(null);
    ws.onmessage = (ev) => {
      let e: any;
      try { e = JSON.parse(String(ev.data)); } catch { return; }
      if (e.kind === "pong") return;
      if (e.kind === "model.failed") {
        deps.failed.set(taskId, String(e.payload?.error ?? "the model call failed"));
        stop(null);
        return;
      }
      if (typeof e.id === "number") deps.seen.set(taskId, e.id);
      // A text reply may be a pause while a job runs: ask the object whether the agent has settled.
      if (e.kind === "model.response" && !e.payload?.toolCalls && e.payload?.text) look();
    };
  });
}
