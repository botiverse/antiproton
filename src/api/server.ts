import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../store/sqlite.ts";
import type { Json } from "../core/types.ts";

export interface ApiOptions {
  /** api key -> tenant. Auth is the only place tenant identity enters. */
  tokens: Map<string, string>;
  /** Events at or below this sequence are treated as aged out of the window. */
  retentionFloor?: number;
  sseIntervalMs?: number;
  onNewTask?: (tenantId: string, agentId: string, taskId: string) => Promise<void> | void;
}

type Ctx = { tenantId: string };
const json = (res: ServerResponse, status: number, body: Json) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid json body");
  }
}

export function createApi(store: SqliteStore, opts: ApiOptions) {
  const retentionFloor = opts.retentionFloor ?? 0;
  const sseIntervalMs = opts.sseIntervalMs ?? 120;

  /** Command idempotency: a retry returns the first response, it does not re-act.
   *  A retry that arrives while the original is still running is told so rather
   *  than being allowed to act a second time. */
  async function once(ctx: Ctx, requestId: string | undefined, kind: string, act: () => Promise<Json>) {
    if (!requestId) return { replayed: false, status: 0, body: await act() };
    const prior = await store.claimRequest(ctx.tenantId, requestId, kind);
    if (prior?.state === "done") return { replayed: true, status: 0, body: prior.response };
    if (prior?.state === "pending") {
      return { replayed: true, status: 409, body: { error: "request_in_progress", requestId } };
    }
    const body = await act();
    await store.finishRequest(ctx.tenantId, requestId, body);
    return { replayed: false, status: 0, body };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path === "/health") return json(res, 200, { ok: true });

      const auth = req.headers.authorization ?? "";
      const tenantId = opts.tokens.get(auth.replace(/^Bearer\s+/i, ""));
      if (!tenantId) return json(res, 401, { error: "unauthorized" });
      const ctx: Ctx = { tenantId };
      const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req) : {};

      let m: RegExpExecArray | null;

      if (method === "POST" && path === "/agents") {
        const agentId = body.agentId ?? `agent_${randomUUID().slice(0, 8)}`;
        await store.createAgent(ctx.tenantId, agentId, body.config ?? {});
        return json(res, 201, { agentId });
      }

      if ((m = /^\/agents\/([^/]+)\/threads$/.exec(path)) && method === "POST") {
        const agentId = m[1]!;
        const threadId = `thread_${randomUUID().slice(0, 8)}`;
        await store.createThread(ctx.tenantId, agentId, threadId, body.metadata ?? {});
        return json(res, 201, { threadId, agentId });
      }

      if ((m = /^\/threads\/([^/]+)\/messages$/.exec(path)) && method === "POST") {
        const thread = await store.getThread(ctx.tenantId, m[1]!);
        if (!thread) return json(res, 404, { error: "no such thread" });
        if (typeof body.text !== "string" || !body.text.trim()) {
          return json(res, 400, { error: "text is required" });
        }
        const out = await once(ctx, body.requestId, "message", async () => {
          let taskId: string = body.taskId;
          if (!taskId) {
            taskId = `task_${randomUUID().slice(0, 8)}`;
            await opts.onNewTask?.(ctx.tenantId, thread.agentId, taskId);
            await store.linkTaskThread(ctx.tenantId, taskId, thread.threadId);
          } else if (!(await store.loadTask(ctx.tenantId, taskId))) {
            return { error: "no such task" };
          }
          const ev = await store.appendEvent({
            tenantId: ctx.tenantId, agentId: thread.agentId, taskId, threadId: thread.threadId,
            kind: "message", payload: { text: body.text },
            dedupKey: body.requestId ? `req:${body.requestId}` : null,
          });
          return { taskId, eventId: ev.eventId, sequence: ev.sequence, accepted: ev.inserted };
        });
        if (out.status) return json(res, out.status, out.body);
        if ((out.body as any).error) return json(res, 404, out.body);
        return json(res, out.replayed ? 200 : 202, { ...(out.body as object), replayed: out.replayed });
      }

      if ((m = /^\/agents\/([^/]+)\/tasks$/.exec(path)) && method === "GET") {
        return json(res, 200, { tasks: await store.listTasks(ctx.tenantId, m[1]!) });
      }

      if ((m = /^\/tasks\/([^/]+)\/interrupt$/.exec(path)) && method === "POST") {
        const taskId = m[1]!;
        if (!(await store.loadTask(ctx.tenantId, taskId))) return json(res, 404, { error: "no such task" });
        const out = await once(ctx, body.requestId, "interrupt", async () => ({
          taskId, generation: await store.interrupt(ctx.tenantId, taskId),
        }));
        return json(res, out.status || 200, { ...(out.body as object), replayed: out.replayed });
      }

      if ((m = /^\/agents\/([^/]+)\/interrupt$/.exec(path)) && method === "POST") {
        const agentId = m[1]!;
        const out = await once(ctx, body.requestId, "interrupt_agent", async () => ({
          // Explicit scope: every unfinished task of this agent, listed back.
          interrupted: await store.interruptAgent(ctx.tenantId, agentId),
        }));
        return json(res, out.status || 200, { ...(out.body as object), replayed: out.replayed });
      }

      if ((m = /^\/operations\/([^/]+)$/.exec(path)) && method === "GET") {
        const op = await store.getOperation(ctx.tenantId, m[1]!);
        return op ? json(res, 200, op) : json(res, 404, { error: "no such operation" });
      }

      if ((m = /^\/operations\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
        const op = await store.getOperation(ctx.tenantId, m[1]!);
        if (!op) return json(res, 404, { error: "no such operation" });
        if (["succeeded", "failed", "cancelled"].includes(op.status)) {
          return json(res, 409, { error: "operation already finished", status: op.status });
        }
        await store.completeOperation(ctx.tenantId, op.operationId, "cancelled", null);
        return json(res, 200, { operationId: op.operationId, status: "cancelled" });
      }

      if ((m = /^\/agents\/([^/]+)\/snapshot$/.exec(path)) && method === "GET") {
        const agentId = m[1]!;
        const events = await store.eventsSince(ctx.tenantId, agentId, 0, 1);
        return json(res, 200, {
          tasks: await store.listTasks(ctx.tenantId, agentId),
          oldestSequence: await store.oldestEventSequence(ctx.tenantId, agentId),
          cursor: (await store.eventsSince(ctx.tenantId, agentId, 0, 100_000)).at(-1)?.sequence ?? 0,
          hasEvents: events.length > 0,
        });
      }

      if ((m = /^\/agents\/([^/]+)\/events$/.exec(path)) && method === "GET") {
        const agentId = m[1]!;
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isFinite(after) || after < 0) return json(res, 400, { error: "bad cursor" });
        if (after > 0 && after < retentionFloor) {
          // Never silently skip events: say the cursor aged out and where to recover.
          return json(res, 410, {
            error: "cursor_expired", oldestAvailable: retentionFloor,
            snapshot: `/agents/${agentId}/snapshot`,
          });
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let cursor = after;
        let closed = false;
        req.on("close", () => { closed = true; });
        const pump = async () => {
          while (!closed) {
            const batch = await store.eventsSince(ctx.tenantId, agentId, cursor, 100);
            for (const e of batch) {
              cursor = e.sequence;
              res.write(`id: ${e.sequence}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
            }
            if (url.searchParams.get("once") === "1" && batch.length === 0) break;
            await new Promise((r) => setTimeout(r, sseIntervalMs));
          }
          res.end();
        };
        void pump();
        return;
      }

      return json(res, 404, { error: "no such route", path });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  });

  return server;
}
