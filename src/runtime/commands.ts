import type { StorageAdapter } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { ModelAdapter, ModelResponse } from "../model/types.ts";
import { asModelSource, type ModelSource } from "./model-resolver.ts";
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
 * The result of a `model.request`, written back as an event. Both the inline
 * path and the offloaded path go through here: if they drifted, an offloaded
 * task would see a differently-shaped history than an inline one.
 *
 * The dedup key is derived from the command id, so re-dispatching a command
 * whose worker died is safe — the second response collapses into the first.
 */
export async function appendModelResponse(
  store: StorageAdapter,
  ctx: CommandContext,
  commandId: string,
  res: ModelResponse,
  /** What the request was for, when it was not an ordinary turn. */
  about?: { purpose?: string; keptFrom?: number; summarised?: number },
): Promise<void> {
  await store.appendEvent({
    tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
    kind: "model.response",
    payload: {
      text: res.text, truncated: res.truncated, usage: res.usage,
      ...(about?.purpose ? { purpose: about.purpose, keptFrom: about.keptFrom,
                             summarised: about.summarised } : {}),
      ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
      // Kept in the log, deliberately not in the harness's messages: the next
      // prompt carries the reply, not the thinking behind it.
      ...(res.reasoning ? { reasoning: res.reasoning } : {}),
    },
    dedupKey: `cmd:${commandId}:response`,
  });
}

/** A model call that never produced a response still has to wake the task;
 *  otherwise an offloaded request that fails parks the agent forever. */
export async function appendModelFailure(
  store: StorageAdapter,
  ctx: CommandContext,
  commandId: string,
  message: string,
): Promise<void> {
  await store.appendEvent({
    tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
    kind: "model.failed",
    payload: { error: message.slice(0, 500) },
    dedupKey: `cmd:${commandId}:response`,
  });
}

/** The one place a `model.request` payload is turned into a provider call.
 *  Inline and offloaded dispatch must not diverge on maxTokens or tools. */
export async function runModelCommand(model: ModelAdapter, payload: Json): Promise<ModelResponse> {
  const p = payload as any;
  return model.complete(p.messages, { maxTokens: 8192, tools: p.tools });
}

/** Hands a command to something outside this execution context. Returns true if
 *  it took ownership; false means run it inline after all. */
export type CommandOffload = (
  ctx: CommandContext,
  cmd: { commandId: string; kind: string; payload: Json },
) => Promise<boolean>;

/**
 * Executes the commands a harness emitted. Nothing here decides what to do next
 * — results go back in as events, and the harness sees them on the next advance.
 */
/** Charged after the fact with the real number, so accounting matches the bill.
 *  Overshoot is bounded by one call, which is the price of not pre-reserving. */
async function charge(store: StorageAdapter, tenantId: string, resource: string, amount: number) {
  if (amount <= 0) return;
  try { await store.consumeQuota(tenantId, resource, amount); }
  catch { /* accounting must never break the run; the gate still stops it next step */ }
}

export class CommandExecutor {
  #store: StorageAdapter;
  #model: (caller: { tenantId: string; agentId: string }) => Promise<ModelAdapter>;
  #host: ExecutorHost;
  #executor: JsExecutor;
  #limits: ExecutionLimits;
  #offload: CommandOffload | null;
  trace: CommandTrace[] = [];

  constructor(
    store: StorageAdapter,
    model: ModelSource,
    host: ExecutorHost,
    /** Injected, not constructed: QuickJS in Node, Dynamic Workers at the edge. */
    executor: JsExecutor,
    limits = DEFAULT_LIMITS,
    /** Durable Objects bill wall-clock duration, so a command that only waits on
     *  the network is cheaper handed to a Worker (§17.9). Undefined = all inline. */
    offload: CommandOffload | null = null,
  ) {
    this.#store = store;
    this.#model = asModelSource(model);
    this.#host = host;
    this.#executor = executor;
    this.#limits = limits;
    this.#offload = offload;
  }

  async dispatch(ctx: CommandContext, cmd: { commandId: string; kind: string; payload: Json }) {
    const p = cmd.payload as any;
    if (this.#offload && (await this.#offload(ctx, cmd))) {
      this.trace.push({ kind: "offload", detail: { kind: cmd.kind, commandId: cmd.commandId } });
      return;
    }
    switch (cmd.kind) {
      case "model.request": {
        // Resolved per call, so a re-bound key takes effect immediately and a
        // tenant without a binding is refused rather than billed to us.
        const model = await this.#model({ tenantId: ctx.tenantId, agentId: ctx.agentId });
        const res = await runModelCommand(model, cmd.payload);
        await charge(this.#store, ctx.tenantId, "model_tokens",
          (res.usage.promptTokens ?? 0) + (res.usage.completionTokens ?? 0));
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
        await appendModelResponse(this.#store, ctx, cmd.commandId, res, {
          purpose: (p as any).purpose, keptFrom: (p as any).keptFrom,
          summarised: (p as any).summarised,
        });
        break;
      }
      case "tool.call": {
        // A native tool call is dispatched through the very same host the sandbox
        // uses, so permission, budget and the operation record are identical.
        const res = await this.#host.invoke({
          tool: String(p.tool), args: p.args,
          // A native tool call is one command, so the command id is the key.
          opts: { idempotencyKey: cmd.commandId },
        });
        const heldOp = res.status === "pending" && "operationId" in res ? res.operationId : null;
        await charge(this.#store, ctx.tenantId, "tool_calls", 1);
        this.trace.push({ kind: "tool", detail: { tool: p.tool, status: (res as any).status } });
        await this.#store.appendEvent({
          tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId,
          kind: "tool.result",
          payload: {
            callId: p.callId, tool: p.tool, content: JSON.stringify(res).slice(0, 12_000),
            ...(heldOp ? { heldOperationIds: [heldOp] } : {}),
          },
          dedupKey: `cmd:${cmd.commandId}:result`,
        });
        break;
      }
      case "js.execute": {
        // Each tool call inside one execution gets a stable key, so re-running
        // this command after a crash reaches the same operation ids instead of
        // minting new ones and repeating whatever they did.
        let n = 0;
        // Calls the policy held, so the harness can park on them instead of
        // asking the model what to do about a status code.
        const heldOps: string[] = [];
        const host: ExecutorHost = {
          invoke: async (call) => {
            const res = await this.#host.invoke({
              ...call,
              opts: { ...call.opts, idempotencyKey: `${cmd.commandId}:${n++}` },
            });
            if (res.status === "pending" && "operationId" in res) heldOps.push(res.operationId);
            return res;
          },
        };
        const r = await this.#executor.execute(String(p.source), host, this.#limits);
        await charge(this.#store, ctx.tenantId, "tool_calls", r.hostCalls);
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
            // What actually ran, not what was asked for. Commands live in the
            // outbox rather than the log — they are derived from state, so
            // replay does not need them — but that left one question the log
            // could not answer: when the harness translates a reply written in
            // another calling syntax, the code it synthesised appeared nowhere.
            // The trajectory showed the markup the model wrote and nothing
            // showed what was executed. Bounded, because this log is never
            // trimmed.
            source: String(p.source).slice(0, 4000),
            ...(heldOps.length ? { heldOperationIds: heldOps } : {}),
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
