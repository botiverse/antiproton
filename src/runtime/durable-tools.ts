/**
 * The tools a `PiAgent` is offered, as pi-durable tools: the same objects, run by another harness.
 *
 * pi085 tools (`bridgeTools`, `runJsTools`, `resumeTool`, `jobsTool` — src/runtime/pi-tools.ts and
 * src/runtime/background-jobs.ts) are functions `execute(toolCallId, params)` that resolve to
 * `{ content, details }` or throw. Each is wrapped here rather than rebuilt, so the name, the
 * description, the schema, the gateway path behind it, and every text it hands the model — a held
 * call's refusal, a tool's question and its `resume` token, a run_js pause — are the pi085 ones by
 * construction: there is one copy of each, and both engines call it.
 *
 * Where the two harnesses differ, this file closes the gap toward what pi085 tells the model:
 *
 * - **A throw.** pi085 turns a tool's throw into a result whose content is the error's message
 *   (pi-agent-core `executeToolCall`). pi-durable turns it into a `<harness>` diagnostic block. A
 *   throw is caught here and answered in pi085's shape.
 * - **Replay.** Our `"never"` is pi-durable's `"unsafe"`; `"safe"` is `"safe"`. An unsafe call cut
 *   off by a close (an eviction, a park) is not run again on reopen: pi-durable writes an error
 *   result, `Tool <name> was interrupted and may have partially run`, as a `<harness>` block
 *   (dist/harness/tool.js, the `execute` phase). pi085 writes `PI085_INTERRUPTED` instead
 *   (pi-agent-core dist/harness/runtime/drive/tools.js, `interruptedOutcome`). The stored entry keeps
 *   pi-durable's text, and `pi085Interrupted` rewrites it in every request the model is sent (a
 *   `beforeRequest` hook below), so the model reads pi085's words. A reader showing the transcript
 *   should apply the same function.
 * - **Output limits.** pi-durable bounds a result's text to 50 KB and 2000 lines by default and
 *   says so in a `<harness>` block; pi085 does not bound it in the harness — the runtime decides how
 *   much of a large result the model gets (`limitForCall`, cf/src/runtime.ts). The bound is lifted,
 *   so that decision stays the only one.
 * - **Close.** pi-durable's `close()` aborts each running invocation's context and waits for it to
 *   return (measured: a close during a call that does not listen waits as long as the call). None of
 *   these tools can stop a gateway call half way, so the wait is given up instead: on abort the
 *   wrapper stops waiting and throws, the call goes on detached, and its outcome is not recorded —
 *   which is what "interrupted" says, and what an evicted isolate does to it anyway. A park never
 *   gets here: it waits for every tool slot to be done (src/runtime/durable-drive.ts).
 * - **Sequential.** `executionMode: "sequential"` (an exclusive mount) is passed through. pi-durable
 *   honours it for the whole round: one sequential call makes every call of that round run in turn
 *   (dist/harness/generation.js, `startToolRound`). pi-agent-core 0.85's harness reads only its
 *   `toolExecution` setting (dist/harness/runtime/drive/tools.js, `runTools`), so on pi085 the
 *   gateway's mount lock (`#onMount`, src/runtime/gateway.ts) is what serialises such calls. Both
 *   keep the lock; pd is stricter about the round.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { defineExtension, GenerationTask, hook, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Message, ToolResultMessage } from "pi-ai-1";

/**
 * What pi085 tells the model about a call cut off with its outcome unknown and not run again.
 * Copied: pi-agent-core 0.85.1 keeps it in a module constant (`INTERRUPTION_MARKER`,
 * dist/harness/runtime/drive/tools.js), which test/pd-tools.ts reads from the installed file.
 */
export const PI085_INTERRUPTED =
  "[Tool execution was interrupted. The preceding output is the latest durable progress snapshot; newer live output may be missing, and the external outcome is unknown.]";

/**
 * The block pi-durable 1.0.0 ends an interrupted unsafe call's result with: `fromSlot(slot,
 * "interrupted", ...)` then `renderDiagnostics` (dist/harness/tool.js). test/pd-tools.ts produces
 * it by closing a harness mid-call, so a change upstream fails there rather than silently showing
 * the model pi-durable's words.
 */
export const pdInterruptedBlock = (toolName: string) =>
  `<harness>\n[error] Tool ${toolName} was interrupted and may have partially run\n</harness>`;

/** One tool result as pi085 would have shown it: pi-durable's interrupted block becomes pi085's line. Anything else is returned as is. */
export function pi085Interrupted<M extends Message>(m: M): M {
  if (m.role !== "toolResult") return m;
  const r = m as ToolResultMessage;
  const last = r.content.at(-1);
  if (!r.isError || last?.type !== "text" || last.text !== pdInterruptedBlock(r.toolName)) return m;
  return { ...r, content: [...r.content.slice(0, -1), { type: "text", text: PI085_INTERRUPTED }] } as M;
}

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
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    running.then(
      (v) => { signal.removeEventListener("abort", abort); resolve(v); },
      (e) => { signal.removeEventListener("abort", abort); reject(e); },
    );
  });
}

/** The extension a session's conversation selects: its tools, and the hook that shows the model pi085's interrupted line. */
export function toolsExtension(name: string, tools: readonly AgentHarnessTool<undefined>[]): Extension {
  return defineExtension({
    name,
    tools: tools.map(durableTool),
    hooks: [hook(GenerationTask, {
      beforeRequest: ({ messages }) => {
        const shown = messages.map(pi085Interrupted);
        return shown.some((m, i) => m !== messages[i]) ? { messages: shown } : undefined;
      },
    })],
  });
}
