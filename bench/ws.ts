/**
 * The bench drivers' events socket, closed without depending on the far end.
 *
 * Shared by bench/swebench/wait.ts and bench/tau2/wait.ts, which both wait on the object's events socket and
 * both must exit once they have written their record.
 */
import type { Socket } from "node:net";
import { Agent, WebSocket, buildConnector } from "undici";

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
export function closableSocket(url: string, headers: Record<string, string>, graceMs: number) {
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
