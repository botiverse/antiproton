/**
 * Waiting for an agent's object to say something changed, instead of asking it on a timer (task #17).
 *
 * The event stream used to read the object every second while work ran and back off to five seconds
 * while idle, so a turn could sit unseen for seconds after input arrived (measured 2026-09-15: 1.0 s
 * straight after subscribing, 4.0 s after a 3-second idle), and every function the caller runs waited
 * for the next poll twice. The object already pushes to its sockets after every step; the Worker holds
 * one of those sockets (hibernatable on the object's side, so an idle object is still not billed) and
 * reads the moment it hears from it. A timeout remains as a fallback, never as the schedule.
 */

/** The part of a WebSocket this needs. */
export interface ChangeSource {
  addEventListener(type: "message" | "close" | "error", listener: () => void): void;
  close?(): void;
}

export interface Watch {
  /**
   * Resolves as soon as a change arrives, or after `fallbackMs`. A change that arrived since the last
   * call resolves at once, so nothing that happens during a read is lost.
   */
  next(fallbackMs: number): Promise<"changed" | "timeout" | "closed">;
  readonly closed: boolean;
  /** Hang up: the stream this served has ended. */
  close(): void;
}

export function watchChanges(source: ChangeSource, timer: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Watch {
  let pending = false;
  let closed = false;
  let wake: (() => void) | null = null;
  const ping = () => { pending = true; const w = wake; wake = null; w?.(); };
  source.addEventListener("message", ping);
  const end = () => { closed = true; const w = wake; wake = null; w?.(); };
  source.addEventListener("close", end);
  source.addEventListener("error", end);
  return {
    get closed() { return closed; },
    close() { if (!closed) { try { source.close?.(); } catch { /* already gone */ } end(); } },
    async next(fallbackMs) {
      if (pending) { pending = false; return "changed"; }
      if (closed) { await timer(fallbackMs); return "closed"; }
      const woken = new Promise<"changed">((resolve) => { wake = () => resolve("changed"); });
      const result = await Promise.race([woken, timer(fallbackMs).then(() => "timeout" as const)]);
      wake = null;
      if (result === "changed") { pending = false; return closed ? "closed" : "changed"; }
      return "timeout";
    },
  };
}
