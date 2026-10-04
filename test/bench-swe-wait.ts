/**
 * The SWE-bench driver's wait leaves nothing open once it returns, whatever the far end does with the close.
 *
 * The driver wrote its record and did not exit, with one ESTABLISHED TLS socket to Cloudflare left: the
 * events socket. `close()` only starts the closing handshake, and the WebSocket client waits for the server
 * to finish it with no timeout of its own. So these run the wait (bench/swebench/wait.ts) against a local
 * server that answers the close frame but keeps the TCP connection, and one that never answers it, and
 * count the client's sockets before and after: the wait must return the count to where it started.
 * The last case runs the wait in a child process and requires the process to exit, which is the symptom.
 */
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { benchPollBody, type PollEvent } from "../src/bench/poll-body.ts";
import { waitForAnswer, type WaitDeps } from "../bench/swebench/wait.ts";

/** How the fake object treats a close frame from the client. */
type CloseMode = "keeps-tcp" | "never-answers" | "proper";

/** A local stand-in for the object's events socket: on upgrade it pushes `events`, one text frame each. */
async function fakeObject(mode: CloseMode, events: object[]) {
  const accepted = new Set<Socket>();
  const server = http.createServer((_q, r) => { r.statusCode = 404; r.end(); });
  server.on("upgrade", (req, sock: Socket) => {
    accepted.add(sock);
    sock.on("error", () => {});
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    for (const e of events) {
      const p = Buffer.from(JSON.stringify(e));
      if (p.length > 125) throw new Error("fixture frame too long for the short form");
      sock.write(Buffer.concat([Buffer.from([0x81, p.length]), p]));
    }
    sock.on("data", (d) => {
      if ((d[0]! & 0x0f) !== 0x8) return;          // only the close frame matters here
      if (mode === "never-answers") return;
      sock.write(Buffer.from([0x88, 0x00]));        // the close reply
      if (mode === "proper") sock.end();            // "keeps-tcp" stops here: the connection stays up
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port, accepted,
    stop: () => { for (const s of accepted) s.destroy(); server.close(); },
  };
}

/**
 * The client's sockets to this fake object: open socket handles whose far end is its port. Per object, so a
 * socket a previous case left closing cannot leave the count and make a leak in this one read as a return
 * to baseline.
 */
function clientSockets(obj: { port: number; accepted: Set<Socket> }): number {
  return (process as any)._getActiveHandles()
    .filter((h: any) => h?.constructor?.name === "Socket" && h.remotePort === obj.port && !obj.accepted.has(h) && !h.destroyed).length;
}

const said = (text: string) => ({ text });
/** The object idle with its answer after the message, as `/bench/poll` would report it. */
const settled: PollEvent[] = [{ sequence: 1, kind: "message" }, { sequence: 5, kind: "model.response", payload: said("Fixed.") }];
const pushed = [{ id: 5, kind: "model.response", payload: { text: "Fixed." } }];

function deps(port: number, poll: WaitDeps["poll"], extra: Partial<WaitDeps> = {}): WaitDeps {
  return {
    socketUrl: (taskId, after) => `ws://127.0.0.1:${port}/bench/events?agentId=b_${taskId}&after=${after}`,
    headers: { "x-harness-token": "t" },
    poll, seen: new Map(), failed: new Map(), closeGraceMs: 200, ...extra,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits up to `ms` for the client's sockets to come back to `base`; returns what it last counted. */
async function settlesTo(base: number, obj: { port: number; accepted: Set<Socket> }, ms = 2_000): Promise<number> {
  const until = Date.now() + ms;
  let n = clientSockets(obj);
  while (n !== base && Date.now() < until) { await sleep(25); n = clientSockets(obj); }
  return n;
}

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

// The child: run one wait against the parent's fake object and print what it got. The parent requires it to exit.
if (process.env.SWE_WAIT_CHILD_PORT) {
  const port = Number(process.env.SWE_WAIT_CHILD_PORT);
  const got = await waitForAnswer("t1", Date.now() + 10_000, deps(port, async () => benchPollBody(settled, false, 0)));
  console.log(`answer: ${got}`);
} else {
  for (const mode of ["keeps-tcp", "never-answers"] as const) {
    await check(`an answer taken from poll leaves no socket open when the server ${mode === "keeps-tcp" ? "answers the close but keeps the connection" : "never answers the close"}`, async () => {
      const obj = await fakeObject(mode, pushed);
      try {
        const base = clientSockets(obj);
        const got = await waitForAnswer("t1", Date.now() + 10_000, deps(obj.port, async () => benchPollBody(settled, false, 0)));
        assert(got === "Fixed.", `the wait returned ${JSON.stringify(got)}, not the polled answer`);
        const n = await settlesTo(base, obj);
        assert(n === base, `${n - base} client socket(s) still open after the wait returned (baseline ${base})`);
      } finally { obj.stop(); }
    });
  }

  await check("a wait that runs out of time leaves no socket open either", async () => {
    // Running throughout, so nothing settles and the deadline is what ends the wait.
    const obj = await fakeObject("keeps-tcp", pushed);
    try {
      const base = clientSockets(obj);
      const got = await waitForAnswer("t1", Date.now() + 300, deps(obj.port, async () => benchPollBody(settled, true, 0)));
      assert(got === null, `a running agent produced an answer: ${JSON.stringify(got)}`);
      const n = await settlesTo(base, obj);
      assert(n === base, `${n - base} client socket(s) still open after the deadline (baseline ${base})`);
    } finally { obj.stop(); }
  });

  await check("a model failure pushed on the socket ends the wait and leaves no socket open", async () => {
    const obj = await fakeObject("keeps-tcp", [{ id: 3, kind: "model.failed", payload: { error: "boom" } }]);
    try {
      const base = clientSockets(obj);
      const d = deps(obj.port, async () => benchPollBody(settled, true, 0));
      const got = await waitForAnswer("t1", Date.now() + 10_000, d);
      assert(got === null && d.failed.get("t1") === "boom", `answer ${JSON.stringify(got)}, failed ${JSON.stringify(d.failed.get("t1"))}`);
      const n = await settlesTo(base, obj);
      assert(n === base, `${n - base} client socket(s) still open after the failure (baseline ${base})`);
    } finally { obj.stop(); }
  });

  await check("control: a server that completes the close brings the count back by itself, long before the grace", async () => {
    const obj = await fakeObject("proper", pushed);
    try {
      const base = clientSockets(obj);
      const got = await waitForAnswer("t1", Date.now() + 10_000, deps(obj.port, async () => benchPollBody(settled, false, 0), { closeGraceMs: 60_000 }));
      assert(got === "Fixed.", `the wait returned ${JSON.stringify(got)}`);
      // With a grace far longer than the check, only the server's own close can bring the count back.
      const n = await settlesTo(base, obj);
      assert(n === base, `${n - base} client socket(s) still open after a proper close (baseline ${base})`);
    } finally { obj.stop(); }
  });

  await check("the process that ran the wait exits once it returns, against a server that keeps the connection", async () => {
    const obj = await fakeObject("keeps-tcp", pushed);
    try {
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
        env: { ...process.env, SWE_WAIT_CHILD_PORT: String(obj.port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const code = await new Promise<number | string>((resolve) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); resolve("still alive 8 s after starting"); }, 8_000);
        child.on("exit", (c) => { clearTimeout(t); resolve(c ?? -1); });
      });
      assert(out.includes("answer: Fixed."), `the child did not report the answer: ${out.trim().slice(0, 300)}`);
      assert(code === 0, `the child did not exit by itself: ${code}`);
    } finally { obj.stop(); }
  });

  for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failedCount}/${results.length} passed`);
  process.exit(failedCount ? 1 : 0);
}
