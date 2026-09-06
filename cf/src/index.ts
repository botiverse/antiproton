/**
 * P0-CF: does the Cloudflare substrate actually give us what the plan needs?
 *
 * Verifies, on real infrastructure and not from documentation:
 *   1. Worker Loader is available on this account at all.
 *   2. A dynamically loaded Worker is a fresh isolate — no state carries over.
 *   3. `globalOutbound: null` blocks the network at the platform level, so the
 *      tool binding really is the only way out (§4.4).
 *   4. `limits.cpuMs` kills a runaway loop without taking the host down (§6.3).
 *   5. A capability binding reaches the sandbox and nothing else does (§5.1).
 *   6. DO SQLite storage commits the three-gate advance atomically (§7.3).
 *   7. Alarm wakeup actually fires, and how late (§7.3 可靠唤醒).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor, handleSandboxCall } from "../../src/runtime/dynamic-worker-executor.ts";
import { kernelSpec } from "../../test/spec/kernel-spec.ts";
import { executorSpec } from "../../test/spec/executor-spec.ts";
import { AgentRuntime } from "./runtime.ts";

export interface Env {
  AGENT: DurableObjectNamespace<AgentDO>;
  ARTIFACTS: R2Bucket;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  HARNESS_MODEL: string;
  ARTIFACT_BUCKET: string;
  LOADER: {
    load(code: WorkerCode): WorkerStub;
    get(id: string, cb: () => Promise<WorkerCode> | WorkerCode): WorkerStub;
  };
}
type WorkerCode = {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string>;
  env?: Record<string, unknown>;
  globalOutbound?: unknown;
  limits?: { cpuMs?: number; subRequests?: number };
};
type WorkerStub = { getEntrypoint(name?: string | null, opts?: unknown): { fetch(req: Request): Promise<Response> } };

/** The P0 probe binding (kept for the substrate checks). */
export class ToolBinding extends WorkerEntrypoint {
  async invoke(name: string, args: unknown) {
    const caller = (this.ctx as any).props ?? {};
    if (name === "echo") return { status: "succeeded", result: { args, tenant: caller.tenantId } };
    if (name === "slow") { await new Promise((r) => setTimeout(r, 20)); return { status: "succeeded", result: {} }; }
    return { status: "rejected", error: { code: "not_mounted", message: name } };
  }
}

/**
 * What the sandbox sees as `env.TOOLS`. It holds no authority of its own: the
 * execution id in ctx.props is the only thing it can say, and the supervisor
 * decides what that id is allowed to do.
 */
export class SandboxTools extends WorkerEntrypoint<Env> {
  async invoke(strings: string[], values: unknown[]) {
    const props = ((this.ctx as any).props ?? {}) as { execId?: string; doId?: string };
    // ctx.exports loopback entrypoints do NOT run in the Durable Object's
    // isolate, so the execution registry is not visible from here. Hop back into
    // the object that owns the execution.
    const stub = this.env.AGENT.get(this.env.AGENT.idFromString(String(props.doId)));
    return stub.sandboxCall(String(props.execId ?? ""), strings, values);
  }
}

const RUNNER = (body: string) => `
export default {
  async fetch(request, env) {
    const out = [];
    const output = (v) => out.push(v);
    try {
      const result = await (async () => { ${body} })();
      return Response.json({ ok: true, out, result: result ?? null });
    } catch (e) {
      return Response.json({ ok: false, out, error: String(e && e.message || e) });
    }
  }
};`;

async function runSandbox(
  env: Env,
  body: string,
  opts: { limits?: { cpuMs?: number; subRequests?: number }; outbound?: unknown; tools?: unknown } = {},
) {
  const stub = env.LOADER.load({
    compatibilityDate: "2026-09-05",
    mainModule: "main.js",
    modules: { "main.js": RUNNER(body) },
    globalOutbound: opts.outbound === undefined ? null : opts.outbound,
    env: opts.tools ? { TOOLS: opts.tools } : {},
    limits: opts.limits,
  });
  // A CPU/subrequest kill is NOT catchable inside the sandbox: it surfaces as a
  // rejection here, in the caller. Every invocation must therefore be wrapped —
  // otherwise one runaway script takes down the supervisor's whole request.
  try {
    const res = await stub.getEntrypoint().fetch(new Request("https://sandbox/"));
    return await res.json();
  } catch (e: any) {
    return { ok: false, terminatedByHost: true, error: String(e?.message ?? e).slice(0, 120) };
  }
}

export class AgentDO extends DurableObject<Env> {
  sql: SqlStorage;
  #store: DurableObjectStore | null = null;
  #runtime: AgentRuntime | null = null;
  alarmFiredAt: number | null = null;
  alarmSetAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_tasks(
      task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, generation INTEGER NOT NULL,
      checkpoint_version INTEGER NOT NULL, fencing_token INTEGER NOT NULL, checkpoint TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS probe_outbox(
      command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL)`);
  }

  /** The three-gate advance from §7.3, on DO SQLite, timed. */
  async verifyStorage() {
    const t0 = Date.now();
    this.sql.exec("DELETE FROM probe_tasks");
    this.sql.exec("DELETE FROM probe_outbox");
    this.sql.exec(
      "INSERT INTO probe_tasks VALUES ('t1','tenant-a',0,0,0,?)", JSON.stringify({ log: [] }));

    const commit = (gen: number, token: number, version: number, cmd: string) =>
      this.ctx.storage.transactionSync(() => {
        const row = [...this.sql.exec("SELECT * FROM probe_tasks WHERE task_id='t1'")][0] as any;
        if (token < row.fencing_token) return "fenced";
        if (gen !== row.generation) return "stale_generation";
        if (version !== row.checkpoint_version) return "version_conflict";
        this.sql.exec(
          "UPDATE probe_tasks SET checkpoint_version=?, fencing_token=?, checkpoint=? WHERE task_id='t1'",
          row.checkpoint_version + 1, token, JSON.stringify({ log: [cmd] }));
        this.sql.exec("INSERT INTO probe_outbox VALUES (?, 't1', 'pending') ON CONFLICT DO NOTHING", cmd);
        return "ok";
      });

    const results = {
      happyPath: commit(0, 5, 0, "cmd-1"),
      staleVersion: commit(0, 5, 0, "cmd-dup"),
      fenced: commit(0, 1, 1, "cmd-zombie"),
      staleGeneration: commit(9, 6, 1, "cmd-oldgen"),
      replayIsIdempotent: (() => {
        commit(0, 6, 1, "cmd-1");
        return [...this.sql.exec("SELECT count(*) AS n FROM probe_outbox WHERE command_id='cmd-1'")][0];
      })(),
      rowsAfter: [...this.sql.exec("SELECT * FROM probe_tasks")][0],
      ms: Date.now() - t0,
    };
    return results;
  }

  /** The kernel contract, unchanged, against Durable Object storage. */
  async runKernelSpec() {
    const t0 = Date.now();
    const results = await kernelSpec(async () => {
      const store = new DurableObjectStore(this.ctx as any);
      return store;
    });
    return { backend: "durable-object", ms: Date.now() - t0, results };
  }

  runtime(): AgentRuntime {
    this.#runtime ??= new AgentRuntime({
      ctx: this.ctx,
      bucket: this.env.ARTIFACTS,
      bucketName: this.env.ARTIFACT_BUCKET,
      loader: this.env.LOADER,
      makeToolBinding: (execId) =>
        (this.ctx as any).exports.SandboxTools({ props: { execId, doId: this.ctx.id.toString() } }),
      modelBaseUrl: this.env.DEEPSEEK_BASE_URL,
      modelApiKey: this.env.DEEPSEEK_API_KEY,
      modelName: this.env.HARNESS_MODEL,
    });
    return this.#runtime;
  }

  async startTask(tenantId: string, agentId: string, taskId: string, text: string) {
    const rt = this.runtime();
    await rt.provision(tenantId, agentId);
    const r = await rt.postMessage(tenantId, agentId, taskId, text);
    // Wakeup is an alarm, not a poll: nothing spins while the agent has no work.
    await this.ctx.storage.setAlarm(Date.now());
    return r;
  }

  async taskState(tenantId: string, agentId: string, taskId: string) {
    const rt = this.runtime();
    await rt.ready();
    const task = await rt.store.loadTask(tenantId, taskId);
    const events = await rt.store.eventsSince(tenantId, agentId, 0, 200);
    const answer = task && (task.checkpoint as any)?.done
      ? (task.checkpoint as any).messages.at(-1).content
      : null;
    return {
      status: task?.status ?? null,
      generation: task?.generation ?? null,
      checkpointVersion: task?.checkpointVersion ?? null,
      answer,
      events: events.map((e) => ({
        sequence: e.sequence, kind: e.kind,
        usage: (e.payload as any)?.usage ?? undefined,
        jsStatus: (e.payload as any)?.status ?? undefined,
        ops: (e.payload as any)?.acceptedOperationIds ?? undefined,
      })),
    };
  }

  /**
   * Client event stream. Hibernation is the point: a task that waits an hour for
   * a webhook should not hold a live object open just because a browser tab is
   * still attached.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const cursor = {
      after: Number(url.searchParams.get("after") ?? 0),
      tenantId: url.searchParams.get("tenantId") ?? "tenant-a",
      agentId: url.searchParams.get("agentId") ?? "agent-1",
    };
    (server as any).serializeAttachment(cursor);
    await this.pushTo(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    if (String(message) === "ping") ws.send(JSON.stringify({ kind: "pong" }));
  }

  /** Sends whatever a socket has not seen and advances its stored cursor. */
  async pushTo(ws: WebSocket) {
    const cur = (ws as any).deserializeAttachment() as
      | { after: number; tenantId: string; agentId: string }
      | null;
    if (!cur) return;
    const rt = this.runtime();
    await rt.ready();
    const events = await rt.store.eventsSince(cur.tenantId, cur.agentId, cur.after, 200);
    for (const e of events) {
      ws.send(JSON.stringify({ id: e.sequence, kind: e.kind, payload: e.payload }));
    }
    if (events.length) {
      (ws as any).serializeAttachment({ ...cur, after: events.at(-1)!.sequence });
    }
  }

  async broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { await this.pushTo(ws); } catch { /* a dead socket must not stall the run */ }
    }
  }

  /** Entered from SandboxTools; the sandbox can never reach this directly. */
  async sandboxCall(execId: string, strings: string[], values: unknown[]) {
    return handleSandboxCall(execId, strings, values);
  }

  /** The executor contract, unchanged, against Dynamic Workers. */
  async runExecutorSpec() {
    const t0 = Date.now();
    const exec = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      makeToolBinding: (execId) =>
        (this.ctx as any).exports.SandboxTools({
          props: { execId, doId: this.ctx.id.toString() },
        }),
    });
    const results = await executorSpec(exec);
    return { implementation: "cloudflare-dynamic-workers", ms: Date.now() - t0, results };
  }

  async armAlarm(delayMs: number) {
    this.alarmSetAt = Date.now();
    this.alarmFiredAt = null;
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    return { armedAt: this.alarmSetAt, delayMs };
  }
  async alarm() {
    this.alarmFiredAt = Date.now();
    this.sql.exec("CREATE TABLE IF NOT EXISTS alarms(at INTEGER)");
    this.sql.exec("INSERT INTO alarms VALUES (?)", this.alarmFiredAt);
    // The object may have been evicted since the alarm was armed, so this
    // instance can be brand new: build the runtime rather than assuming it.
    const { more } = await this.runtime().drain(3);
    await this.broadcast();
    // Bounded work per invocation; if there is more, come back rather than
    // holding one alarm open until the platform ends it.
    if (more) await this.ctx.storage.setAlarm(Date.now() + 50);
  }
  async alarmStatus() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS alarms(at INTEGER)");
    const rows = [...this.sql.exec("SELECT at FROM alarms ORDER BY at DESC LIMIT 1")] as any[];
    return {
      armedAt: this.alarmSetAt, firedAt: rows[0]?.at ?? null,
      latencyMs: rows[0]?.at && this.alarmSetAt ? rows[0].at - this.alarmSetAt : null,
    };
  }

  /** Isolated: does a runaway child kill the supervisor, or only itself? */
  async verifyCpuLimit(cpuMs: number) {
    const t0 = Date.now();
    const killed = await runSandbox(this.env, `while (true) {}`, { limits: { cpuMs } });
    const afterMs = Date.now() - t0;
    // If the supervisor is still executing here, it survived the runaway child.
    const survivor = await runSandbox(this.env, `output("still alive"); return "alive";`);
    return { killed, killTookMs: afterMs, hostSurvived: survivor };
  }

  /** Dynamic Workers get a higher concurrency budget inside a DO (10 vs 4). */
  async verifySandbox() {
    const checks: Record<string, unknown> = {};
    const timed = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try { checks[name] = { ...(await fn() as object), ms: Date.now() - t }; }
      catch (e: any) { checks[name] = { threw: String(e?.message ?? e).slice(0, 120), ms: Date.now() - t }; }
    };
    const t0 = Date.now();

    await timed("freshIsolateA", () => runSandbox(this.env, `globalThis.leaked = 42; output(typeof globalThis.leaked); return "a";`));
    await timed("freshIsolateB", () => runSandbox(this.env, `output(typeof globalThis.leaked); return "b";`));
    checks.twoLoadsMs = Date.now() - t0;

    await timed("networkBlocked", () => runSandbox(this.env, `
      const probe = {};
      try { await fetch("https://example.com"); probe.fetch = "ALLOWED"; }
      catch (e) { probe.fetch = "blocked"; }
      probe.hasConnect = typeof connect;
      output(probe); return probe;`));

    await timed("capabilityBinding", () => runSandbox(this.env, `
      const r = await env.TOOLS.invoke("echo", { repo: "example/project" });
      const bad = await env.TOOLS.invoke("slack.post", {});
      return { ok: r, rejected: bad };`,
      { tools: this.ctx.exports.ToolBinding({ props: { tenantId: "tenant-a" } }) }));

    await timed("subRequestLimit", () => runSandbox(this.env, `
      let n = 0;
      try { for (let i = 0; i < 10; i++) { await env.TOOLS.invoke("slow", {}); n++; } }
      catch (e) { return { completed: n, stopped: String(e.message || e).slice(0, 60) }; }
      return { completed: n, stopped: null };`,
      { tools: this.ctx.exports.ToolBinding({ props: {} }), limits: { subRequests: 3 } }));

    await timed("noBindingsMeansNoTools", () => runSandbox(this.env, `
      return { envKeys: Object.keys(env ?? {}), hasTools: typeof (env ?? {}).TOOLS };`));

    await timed("nodeCompatSurface", () => runSandbox(this.env, `
      const probe = { hasProcess: typeof process };
      try {
        const fs = await import("node:fs");
        probe.importedFs = Object.keys(fs).slice(0, 6);
        try { probe.readEtcPasswd = String(fs.readFileSync("/etc/passwd")).slice(0, 20); }
        catch (e) { probe.readEtcPasswd = "threw: " + String(e.message || e).slice(0, 60); }
        try { probe.readdirRoot = fs.readdirSync("/"); }
        catch (e) { probe.readdirRoot = "threw: " + String(e.message || e).slice(0, 60); }
      } catch (e) { probe.importedFs = "import refused: " + String(e.message || e).slice(0, 60); }
      try { const cp = await import("node:child_process"); probe.childProcess = Object.keys(cp).slice(0, 4); }
      catch (e) { probe.childProcess = "refused"; }
      try {
        const net = await import("node:net");
        probe.net = typeof net.Socket;
        // The real question: globalOutbound is documented to intercept connect()
        // as well as fetch(). Does the node:net path honour it?
        probe.socketConnect = await new Promise((resolve) => {
          try {
            const sock = net.connect({ host: "example.com", port: 443 });
            const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
            sock.on("connect", () => done("CONNECTED — ESCAPE"));
            sock.on("error", (e) => done("refused: " + String(e && e.message).slice(0, 50)));
            setTimeout(() => done("timeout (no connection)"), 3000);
          } catch (e) { resolve("threw: " + String(e.message || e).slice(0, 50)); }
        });
      } catch (e) { probe.net = "refused"; }
      try {
        const cp2 = await import("node:child_process");
        probe.execWorks = await new Promise((resolve) => {
          try { cp2.exec("id", (err, out) => resolve(err ? "threw: " + String(err.message).slice(0, 50) : "RAN: " + out)); }
          catch (e) { resolve("threw: " + String(e.message || e).slice(0, 50)); }
        });
      } catch (e) { probe.execWorks = "refused"; }
      try { const fs2 = await import("node:fs"); probe.bundleListing = fs2.readdirSync("/bundle").slice(0, 5); }
      catch (e) { probe.bundleListing = "refused"; }
      return probe;`));

    return checks;
  }
}

/** Where does the wall clock actually go, measured from the edge? */
async function latency(env: Env) {
  const time = async (label: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    try { await fn(); return [label, Date.now() - t] as const; }
    catch (e: any) { return [label, `error: ${String(e?.message ?? e).slice(0, 60)}`] as const; }
  };
  const small = new Uint8Array(200).fill(65);
  const big = new Uint8Array(1024 * 1024).fill(66);
  const results = await Promise.all([]);
  void results;
  const out: Record<string, unknown> = {};
  for (const r of [
    await time("r2.put 200B", () => env.ARTIFACTS.put("bench/small.bin", small)),
    await time("r2.get 200B", () => env.ARTIFACTS.get("bench/small.bin").then((o) => o?.arrayBuffer())),
    await time("r2.put 1MB", () => env.ARTIFACTS.put("bench/big.bin", big)),
    await time("r2.get 1MB", () => env.ARTIFACTS.get("bench/big.bin").then((o) => o?.arrayBuffer())),
    await time("fetch api.github.com", () => fetch("https://api.github.com/repos/nodejs/node", { headers: { "user-agent": "agent-harness/0.1" } }).then((r) => r.text())),
    await time("fetch api.deepseek.com (unauth RTT)", () => fetch("https://api.deepseek.com/models").then((r) => r.text())),
  ]) out[r[0]] = r[1];
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Conformance gets its own object: the P0 probe created an incompatible
    // `tasks` table in "p0", and CREATE TABLE IF NOT EXISTS silently accepted it.
    const name = url.pathname.startsWith("/conformance")
      ? "conformance-v2"
      : url.pathname.startsWith("/agent")
        ? "runtime-v1"
        : "p0";
    const stub = env.AGENT.get(env.AGENT.idFromName(name));
    try {
      switch (url.pathname) {
        case "/storage": return Response.json(await stub.verifyStorage());
        case "/conformance/kernel": return Response.json(await stub.runKernelSpec());
        case "/conformance/executor": return Response.json(await stub.runExecutorSpec());
        case "/agent/message": {
          const body = (await request.json()) as any;
          return Response.json(await stub.startTask(
            body.tenantId ?? "tenant-a", body.agentId ?? "agent-1",
            body.taskId ?? `task_${crypto.randomUUID().slice(0, 8)}`, String(body.text),
          ));
        }
        case "/agent/events":
          return stub.fetch(request);
        case "/agent/state":
          return Response.json(await stub.taskState(
            url.searchParams.get("tenantId") ?? "tenant-a",
            url.searchParams.get("agentId") ?? "agent-1",
            String(url.searchParams.get("taskId")),
          ));
        case "/latency": return Response.json({ colo: request.cf?.colo ?? null, ...(await latency(env)) });
        case "/sandbox": return Response.json(await stub.verifySandbox());
        case "/sandbox/cpu": return Response.json(await stub.verifyCpuLimit(Number(url.searchParams.get("ms") ?? 50)));
        case "/alarm/arm": return Response.json(await stub.armAlarm(Number(url.searchParams.get("ms") ?? 2000)));
        case "/alarm/status": return Response.json(await stub.alarmStatus());
        default:
          return Response.json({ routes: ["/storage", "/sandbox", "/alarm/arm?ms=", "/alarm/status"] });
      }
    } catch (e: any) {
      return Response.json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 600) }, { status: 500 });
    }
  },
};
