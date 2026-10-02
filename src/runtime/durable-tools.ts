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
 * - **Our writes.** A call through the gateway writes the object's SQL as it goes (operation,
 *   approval, usage rows) across awaits, as on pi085. Each pi-durable commit is one synchronous
 *   transaction (the vendored src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js), so no write
 *   of ours can land inside one, and a call runs alongside its round's commits with nothing held off.
 * - **Sequential.** `executionMode: "sequential"` (an exclusive mount) is passed through. pi-durable
 *   honours it for the whole round: one sequential call makes every call of that round run in turn
 *   (dist/harness/generation.js, `startToolRound`). pi-agent-core 0.85's harness reads only its
 *   `toolExecution` setting (dist/harness/runtime/drive/tools.js, `runTools`), so on pi085 the
 *   gateway's mount lock (`#onMount`, src/runtime/gateway.ts) is what serialises such calls. Both
 *   keep the lock; pd is stricter about the round.
 * - **Functions the API caller runs** (`clientTool`). pi085 cannot suspend a tool, so a call to one
 *   records itself, aborts the run, and resumes it on a new branch once every result is in
 *   (src/runtime/client-calls.ts). pi-durable can leave a tool waiting: the call is recorded in
 *   `ap_client_calls` and the tool waits in-process for the caller's result. A harness whose only
 *   pending work is such a wait closes with no alarm (`externalWaits`, src/runtime/durable-drive.ts),
 *   which is safe because the tool is replay-safe: the close aborts it, nothing is recorded, and the
 *   reopened harness runs it again, which finds the answer in the row. What the model reads is
 *   pi085's: the call, then the caller's result as its result, with no placeholder in between.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  defineExtension, GenerationTask, hook, type Extension, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Message, ToolResultMessage } from "pi-ai-1";
import { CLIENT_PENDING } from "./client-calls.ts";

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

/**
 * The block pi-durable 1.0.0 ends a call's result with when its turn's abort cut it off: `fromSlot(slot, "aborted",
 * ...)` then `renderDiagnostics` (dist/harness/tool.js, the task's `abort`).
 */
export const pdAbortedBlock = (toolName: string) => `<harness>\n[error] Tool ${toolName} was aborted\n</harness>`;

/**
 * A caller's function cut off by a cancel, as pi085 shows it. pi085's call had already ended its run with
 * `CLIENT_PENDING` as its (failed) result when the caller was asked (src/runtime/client-calls.ts), so that is what a
 * cancelled wait leaves there; pd's tool was still waiting, and pi-durable's abort writes its "aborted" block. The
 * call is known as the caller's by the `details` the tool publishes before it waits (`clientTool`), which pi-durable
 * keeps in the aborted result. Anything else is returned as is.
 */
export function pi085ClientAborted<M extends Message>(m: M): M {
  if (m.role !== "toolResult") return m;
  const r = m as ToolResultMessage;
  const last = r.content.at(-1);
  if (!r.isError || (r.details as { client?: unknown } | undefined)?.client !== true) return m;
  if (last?.type !== "text" || last.text !== pdAbortedBlock(r.toolName)) return m;
  return { ...r, content: [{ type: "text", text: CLIENT_PENDING }] } as M;
}

/** One stored message as pi085 would have shown it, the model and the transcript's readers alike. */
export const pi085View = <M extends Message>(m: M): M => pi085ClientAborted(pi085Interrupted(m));

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

/** Where a client tool records its call and waits for the answer: `PdHost` (src/runtime/durable-agent.ts). */
export interface ClientCallPort {
  /**
   * The caller's result for this call: recorded as waiting unless already answered, then waited for. Rejects with
   * the signal's reason when it aborts (a close, or a cancel of the turn), having recorded nothing more.
   */
  answer(call: { conversationId: number; callId: string; name: string; arguments: string }, signal: AbortSignal | undefined): Promise<ClientAnswer>;
}

/**
 * A function the caller runs, as a pi-durable tool: replay-safe (it does nothing but read a row and wait), and its
 * result the caller's, in pi085's shape — the output as the text, a failure as an error result with the output as
 * its text (pi085 throws it, and pi-agent-core makes the message the result).
 */
export function clientTool(def: ClientToolDef, port: ClientCallPort): ToolRegistration {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as ToolRegistration["parameters"],
    replay: "safe",
    outputLimits: UNBOUNDED,
    async execute(args, api, context) {
      // Published before the wait, so that a cancel's "aborted" result keeps it and reads as pi085's (`pi085ClientAborted`).
      await api.details({ client: true }, context);
      const r = await port.answer(
        { conversationId: Number(api.conversationId), callId: api.callId, name: def.name, arguments: JSON.stringify(args ?? {}) },
        context.abortSignal);
      return r.isError
        ? { content: [{ type: "text", text: r.output }], isError: true }
        : { content: [{ type: "text", text: r.output }], details: { client: true } };
    },
  };
}

/** The extension a session's conversation selects: its tools, and the hook that shows the model pi085's texts (`pi085View`). */
export function toolsExtension(
  name: string, tools: readonly AgentHarnessTool<undefined>[],
  client?: { defs: readonly ClientToolDef[]; port: ClientCallPort },
): Extension {
  return defineExtension({
    name,
    // The caller's functions last, as pi085 lists them (cf/src/runtime.ts `agent()`).
    tools: [...tools.map((t) => durableTool(t)), ...(client?.defs ?? []).map((d) => clientTool(d, client!.port))],
    hooks: [hook(GenerationTask, {
      beforeRequest: ({ messages }) => {
        const shown = messages.map(pi085View);
        return shown.some((m, i) => m !== messages[i]) ? { messages: shown } : undefined;
      },
    })],
  });
}
