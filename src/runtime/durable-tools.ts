/**
 * The tools a `PiAgent` is offered, as pi-durable tools: the same objects, run by another harness.
 *
 * pi085 tools (`bridgeTools`, `runJsTools`, `resumeTool`, `jobsTool` — src/runtime/pi-tools.ts and
 * src/runtime/background-jobs.ts) are functions `execute(toolCallId, params)` that resolve to
 * `{ content, details }` or throw. Each is wrapped here rather than rebuilt, so the name, the
 * description, the schema, the gateway path behind it, and every text it hands the model — a held
 * call's refusal, a tool's question and its `resume` token, a run_js pause — come from one copy that
 * both engines call.
 *
 * What pi-durable itself says about a call is what the model reads: an unsafe call cut off by a close
 * gets pi-durable's interrupted result, a call cut off by a cancel its aborted result
 * (dist/harness/tool.js). Neither is rewritten into pi085's words. Where the wrapper does decide:
 *
 * - **A throw** is answered as an error result whose text is the error's message, rather than ending the
 *   tool task `failed` with a diagnostic block: a tool's refusal is an answer the model acts on.
 * - **Replay.** Our `"never"` is pi-durable's `"unsafe"`; `"safe"` is `"safe"`.
 * - **Output limits.** pi-durable bounds a result's text to 50 KB and 2000 lines by default; the bound
 *   is lifted, so the runtime's own decision of how much of a large result the model gets
 *   (`limitForCall`, cf/src/runtime.ts) stays the only one.
 * - **Close.** pi-durable's `close()` aborts each running invocation's context and waits for it to
 *   return. None of these tools can stop a gateway call half way, so on abort the wrapper stops
 *   waiting and throws; the call goes on detached and its outcome is not recorded — which is what
 *   "interrupted" says, and what an evicted isolate does to it anyway. A park never gets here: it
 *   waits for every tool slot to be done (src/runtime/durable-drive.ts).
 * - **Our writes.** A call through the gateway writes the object's SQL as it goes (operation,
 *   approval, usage rows) across awaits. Each pi-durable commit is one synchronous transaction (the
 *   vendored src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js), so no write of ours can land
 *   inside one.
 * - **Sequential.** `executionMode: "sequential"` (an exclusive mount) is passed through; pi-durable
 *   makes the whole round sequential (dist/harness/generation.js, `startToolRound`).
 * - **Functions the API caller runs** (`clientTool`). The call is pi-durable state: the tool records it
 *   in the conversation's `ap.clientCalls` document and waits on that document (`api.watchDoc`) for the
 *   caller's answer, which `DurableAgent.answerClientCalls` commits there. A harness whose only pending
 *   work is such a wait closes with no alarm (`externalWaits`, src/runtime/durable-drive.ts): the tool is
 *   replay-safe, so the close aborts it, nothing is recorded, and the reopened harness runs it again,
 *   which finds the answer in the document.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  defineDoc, defineExtension,
  type ConversationId, type Extension, type TaskId, type ToolExecutionApi, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ToolResultMessage } from "pi-ai-1";

/** No bound of pi-durable's own: see "Output limits" above. */
const UNBOUNDED = { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER } as const;

/** A pi085 tool, run by pi-durable. */
export function durableTool(t: AgentHarnessTool<undefined>): ToolRegistration {
  const tool = t as AgentHarnessTool<undefined> & { replay?: string; executionMode?: string };
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as ToolRegistration["parameters"],
    replay: tool.replay === "safe" ? "safe" : "unsafe",
    ...(tool.executionMode === "sequential" ? { executionMode: "sequential" as const } : {}),
    outputLimits: UNBOUNDED,
    async execute(args, api, context) {
      try {
        // The model's id for the call, which pi085 hands every tool first: the gateway records it, run_js
        // numbers its idempotency keys from it, and a question is held under it.
        const running = (tool.execute as (id: string, params: unknown) => Promise<{ content: ToolResultMessage["content"]; details?: unknown }>)(api.callId, args);
        const r = await untilAborted(running, context.abortSignal);
        return {
          content: r.content,
          // Stored as JSON: a field set to undefined is dropped, as pi085's storage drops it.
          ...(r.details === undefined ? {} : { details: JSON.parse(JSON.stringify(r.details)) }),
        };
      } catch (error) {
        // A close aborts the invocation; rethrown so pi-durable records nothing and recovery decides.
        if (context.abortSignal?.aborted) throw error;
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}

/** `running`, or a rejection as soon as `signal` aborts, leaving `running` to finish on its own. */
function untilAborted<T>(running: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return running;
  running.catch(() => { /* detached: nobody reads its outcome */ });
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    running.then(
      (v) => { signal.removeEventListener("abort", abort); resolve(v); },
      (e) => { signal.removeEventListener("abort", abort); reject(e); },
    );
  });
}

/** A function the Agents API caller runs itself, as declared on the agent (cf/src/runtime.ts `agent()`). */
export type ClientToolDef = { name: string; description: string; parameters: unknown };

/** The caller's result for a call. */
export type ClientAnswer = { output: string; isError: boolean };

/**
 * One call in `ap.clientCalls`. `name` is empty for an answer that came before its tool ran (the engine contract keeps
 * it); `taskId` is the tool task that recorded it, so a later record can tell when an answered call's tool is done.
 */
export type ClientCall = { name: string; arguments: string; at: number; taskId?: TaskId; answer?: ClientAnswer };

/**
 * A conversation's calls to functions the caller runs, by call id: recorded by the tool, answered by the caller, and
 * dropped once answered and returned (the next record prunes them) or when the turn is cancelled.
 */
export const ClientCallsDoc = defineDoc<{ calls: Record<string, ClientCall> }>({
  kind: "ap.clientCalls", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ calls: {} }),
});

/** The calls a tool recorded that the caller has not answered, oldest first. */
export function waitingCalls(doc: { readonly calls: Readonly<Record<string, ClientCall>> } | undefined | null): Array<{ callId: string } & ClientCall> {
  return Object.entries(doc?.calls ?? {})
    .filter(([, c]) => c.name !== "" && c.answer === undefined)
    .map(([callId, c]) => ({ callId, ...c }))
    .sort((a, b) => a.at - b.at || (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0));
}

/**
 * A function the caller runs, as a pi-durable tool: replay-safe (it records its call and waits), and its result the
 * caller's — the output as the text, a failure as an error result with the output as its text.
 */
export function clientTool(def: ClientToolDef): ToolRegistration {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as ToolRegistration["parameters"],
    replay: "safe",
    outputLimits: UNBOUNDED,
    async execute(args, api, context) {
      await recordCall(api, def.name, JSON.stringify(args ?? {}), context);
      const r = await answerOf(api, context);
      return { content: [{ type: "text", text: r.output }], ...(r.isError ? { isError: true } : {}) };
    },
  };
}

/**
 * Record this call as waiting unless it is (a replay, or an answer that came first), in one commit that also forgets
 * answered calls whose tool task has ended: their result is in the transcript, and nothing reads them again. An
 * answer is carried over only when it was kept for this call before any tool recorded it (no `taskId`): an entry
 * another task recorded is an earlier call that reused the id, and its answer is not this one's.
 */
async function recordCall(api: ToolExecutionApi, name: string, args: string, context: Context): Promise<void> {
  const known = (await api.snapshot(ClientCallsDoc, api.conversationId, context))?.calls[api.callId];
  if (known?.taskId === api.taskId) return;
  await api.commit(async (tx) => {
    const doc = await tx.doc(ClientCallsDoc, api.conversationId);
    for (const [id, c] of Object.entries(doc.calls)) {
      if (id === api.callId || c.answer === undefined || c.taskId === undefined) continue;
      const task = await tx.task(c.taskId);
      if (!task || task.state.status === "terminal") delete doc.calls[id];
    }
    const early = doc.calls[api.callId]?.taskId === undefined ? doc.calls[api.callId]?.answer : undefined;
    doc.calls[api.callId] = { name, arguments: args, at: Date.now(), taskId: api.taskId, ...(early ? { answer: { ...early } } : {}) };
  }, context);
}

/** The caller's answer to this call: read from the document, or waited for on it. Rejects when the invocation is aborted. */
async function answerOf(api: ToolExecutionApi, context: Context): Promise<ClientAnswer> {
  const of = (doc: { readonly calls: Readonly<Record<string, ClientCall>> } | null | undefined) => doc?.calls[api.callId]?.answer;
  const watch = await api.watchDoc(ClientCallsDoc, api.conversationId as ConversationId, context);
  if (!watch) throw new Error(`the ${ClientCallsDoc.definition.kind} document of conversation ${api.conversationId} is missing`);
  try {
    const now = of(watch.value);
    if (now) return { output: now.output, isError: now.isError };
    const signal = context.abortSignal;
    return await new Promise<ClientAnswer>((resolve, reject) => {
      const abort = () => { reject(signal!.reason); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const done = () => signal?.removeEventListener("abort", abort);
      watch.start(async (value) => {
        const a = of(value);
        if (a) { done(); resolve({ output: a.output, isError: a.isError }); }
      });
      void watch.closed.then((end) => { done(); reject(signal?.aborted ? signal.reason : new Error(`the wait for the caller ended: ${end.reason}`)); });
    });
  } finally {
    await watch.stop();
  }
}

/** The extension a session's conversation selects: its tools, the caller's functions last (cf/src/runtime.ts `agent()`). */
export function toolsExtension(name: string, tools: readonly AgentHarnessTool<undefined>[], clientTools: readonly ClientToolDef[] = []): Extension {
  return defineExtension({ name, tools: [...tools.map((t) => durableTool(t)), ...clientTools.map((d) => clientTool(d))] });
}
