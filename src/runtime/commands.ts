import type { StorageAdapter } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { ModelAdapter } from "../model/types.ts";
import { DEFAULT_LIMITS } from "../core/execution.ts";
import type { ExecutionLimits, ExecutorHost, JsExecutor } from "../core/execution.ts";

export interface CommandContext {
  tenantId: string;
  agentId: string;
  taskId: string;
}

export interface CommandTrace {
  kind: string;
  detail: Json;
}

/**
 * Executes the commands a harness emitted. Nothing here decides what to do next
 * — results go back in as events, and the harness sees them on the next advance.
 */
export class CommandExecutor {
  #store: StorageAdapter;
  #model: ModelAdapter;
  #host: ExecutorHost;
  #executor: JsExecutor;
  #limits: ExecutionLimits;
  trace: CommandTrace[] = [];

  constructor(
    store: StorageAdapter,
    model: ModelAdapter,
    host: ExecutorHost,
    /** Injected, not constructed: QuickJS in Node, Dynamic Workers at the edge. */
    executor: JsExecutor,
    limits = DEFAULT_LIMITS,
  ) {
    this.#store = store;
    this.#model = model;
    this.#host = host;
    this.#executor = executor;
    this.#limits = limits;
  }

  async dispatch(ctx: CommandContext, cmd: { commandId: string; kind: string; payload: Json }) {
    const p = cmd.payload as any;
    switch (cmd.kind) {
      case "model.request": {
        const res = await this.#model.complete(p.messages, { maxTokens: 8192, tools: p.tools });
        this.trace.push({
          kind: "model",
          detail: {
            finish: res.finishReason,
            truncated: res.truncated,
            prompt: res.usage.promptTokens,
            cached: res.usage.cachedPromptTokens,
            completion: res.usage.completionTokens,
            reasoning: res.usage.reasoningTokens,
          },
        });
        await this.#store.appendEvent({
          tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
          kind: "model.response",
          payload: {
            text: res.text, truncated: res.truncated, usage: res.usage,
            ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
          },
          dedupKey: `cmd:${cmd.commandId}:response`,
        });
        break;
      }
      case "tool.call": {
        // A native tool call is dispatched through the very same host the sandbox
        // uses, so permission, budget and the operation record are identical.
        const res = await this.#host.invoke({ tool: String(p.tool), args: p.args, opts: {} });
        this.trace.push({ kind: "tool", detail: { tool: p.tool, status: (res as any).status } });
        await this.#store.appendEvent({
          tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
          kind: "tool.result",
          payload: { callId: p.callId, tool: p.tool, content: JSON.stringify(res).slice(0, 12_000) },
          dedupKey: `cmd:${cmd.commandId}:result`,
        });
        break;
      }
      case "js.execute": {
        const r = await this.#executor.execute(String(p.source), this.#host, this.#limits);
        this.trace.push({
          kind: "js",
          detail: {
            status: r.status, hostCalls: r.hostCalls, operations: r.acceptedOperationIds,
            source: String(p.source), outputs: r.outputs, error: r.error,
          },
        });
        await this.#store.appendEvent({
          tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
          kind: "js.result",
          payload: {
            callId: p.callId, status: r.status, outputs: r.outputs, error: r.error,
            acceptedOperationIds: r.acceptedOperationIds,
          },
          dedupKey: `cmd:${cmd.commandId}:result`,
        });
        break;
      }
      case "message.out":
        this.trace.push({ kind: "answer", detail: p.text });
        break;
      default:
        throw new Error(`unknown command kind: ${cmd.kind}`);
    }
  }
}
