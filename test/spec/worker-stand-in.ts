/**
 * A Worker Loader for node, close enough to the platform's that what the
 * platform does to an outstanding call shows up here too.
 *
 * The module the executor generates is evaluated for real, as an ES module,
 * and its tool binding reaches the supervisor's own handlers. What the first
 * stand-in got wrong was the binding: it called the supervisor synchronously,
 * so a call was registered as outstanding the instant the program made it,
 * and the supervisor could always wait for it. On Cloudflare the binding is a
 * service RPC — sandbox to the SandboxTools entrypoint, then on to the agent's
 * object — and neither of two things holds:
 *
 * - **Arrival is not immediate, and not in order.** A call can reach the
 *   supervisor after the program's answer, or after a later `suspend`, sent
 *   on its own hop. The contract rows ran green in node and red on Cloudflare
 *   (2026-10-01): a call the program did not await reported "completed", and a
 *   pause awaited while a call was out was handed a continuation, because the
 *   call that came back held arrived after the decision.
 * - **A call outstanding when the fetch handler returns is not owed an
 *   answer.** The request context it belonged to is over.
 *
 * So here: `invoke` reaches the supervisor `callHopMs` later, and `suspend`
 * at once — the adversarial order, which the platform does not rule out —
 * and a call still in transit, or whose result is still coming back, when
 * the handler returns is dropped, as if the context had been torn down.
 */
import { handleSandboxCall, handleSandboxSuspend } from "../../src/runtime/dynamic-worker-executor.ts";
import type { WorkerLoader } from "../../src/runtime/dynamic-worker-executor.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function standInLoader(opts: {
  callHopMs?: number;
  /** Calls that are lost on the way: never delivered, never answered. */
  lose?: (tool: string) => boolean;
} = {}): {
  loader: WorkerLoader;
  makeToolBinding: (execId: string) => unknown;
  /** Calls that were dropped because their request had ended, by execution. */
  dropped: string[];
} {
  const hop = opts.callHopMs ?? 15;
  const dropped: string[] = [];
  // Whether each execution's fetch handler is still running.
  const live = new Map<string, boolean>();
  const never = () => new Promise<never>(() => {});
  return {
    dropped,
    loader: {
      load: (code: any) => ({
        getEntrypoint: () => ({
          fetch: async (req: Request) => {
            const execId = String(code.env?.TOOLS?.execId ?? "");
            live.set(execId, true);
            try {
              const src = code.modules[code.mainModule] as string;
              const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
              return await mod.default.fetch(req, code.env);
            } finally {
              live.set(execId, false);
            }
          },
        }),
      }),
    },
    makeToolBinding: (execId: string) => ({
      execId,
      async invoke(strings: string[], values: unknown[]) {
        if (opts.lose?.(String(strings[0] ?? "").trim())) return never();
        await sleep(hop);
        if (live.get(execId) === false) { dropped.push(execId); return never(); }
        const res = await handleSandboxCall(execId, strings, values);
        if (live.get(execId) === false) { dropped.push(execId); return never(); }
        return res;
      },
      suspend: (req: any) => handleSandboxSuspend(execId, req),
    }),
  };
}
