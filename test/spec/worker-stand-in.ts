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
import { registerHooks } from "node:module";
import { posix } from "node:path";
import { handleSandboxCall, handleSandboxSuspend } from "../../src/runtime/dynamic-worker-executor.ts";
import type { WorkerLoader } from "../../src/runtime/dynamic-worker-executor.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A load with more than `main.js` (the SDK bridge's modules) is evaluated from a module map, as the platform's loader
 * resolves it: a bare name is looked up as it is (`bridge.js`, `sdk:svc`), a relative one against the importer's
 * directory (an SDK file importing its sibling), and a name the map lacks fails, as there is nothing else to load.
 */
const loads = new Map<string, Record<string, string | { js: string }>>();
let hooked = false;
function hookModuleMaps(): void {
  if (hooked) return;
  hooked = true;
  const parse = (url: string) => {
    const m = /^standin:\/\/([^/]+)\/(.*)$/.exec(url);
    return m ? { id: m[1]!, name: decodeURIComponent(m[2]!) } : null;
  };
  registerHooks({
    resolve(specifier, context, next) {
      const from = context.parentURL ? parse(context.parentURL) : null;
      if (!from) return next(specifier, context);
      const name = specifier.startsWith("./") || specifier.startsWith("../")
        ? posix.normalize(posix.join(posix.dirname(from.name), specifier)) : specifier;
      if (!(name in (loads.get(from.id) ?? {}))) throw new Error(`No such module "${name}" (imported from "${from.name}")`);
      return { url: `standin://${from.id}/${encodeURIComponent(name)}`, shortCircuit: true };
    },
    load(url, context, next) {
      const at = parse(url);
      if (!at) return next(url, context);
      const src = loads.get(at.id)?.[at.name];
      return { format: "module", source: typeof src === "string" ? src : src!.js, shortCircuit: true };
    },
  });
}

/**
 * What workerd refuses at load: a module given as a bare string whose name does not end in `.js` (it reads a bare
 * string as an ES module only by that suffix). Refused here too, at the same moment, so that a module map the platform
 * would not load — an SDK's `client.mjs` handed over as a string — fails in node instead of passing.
 */
function rejectBareNonJs(modules: Record<string, unknown>): void {
  for (const [name, src] of Object.entries(modules ?? {})) {
    if (typeof src === "string" && !name.endsWith(".js")) {
      throw new TypeError(`module "${name}" is a bare string, which the loader takes only for a name ending in .js; give it as { js: source }`);
    }
  }
}

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
      load: (code: any) => {
        rejectBareNonJs(code.modules);
        return {
          getEntrypoint: () => ({
            fetch: async (req: Request) => {
              const execId = String(code.env?.TOOLS?.execId ?? "");
              live.set(execId, true);
              try {
                const src = code.modules[code.mainModule] as string;
                let mod;
                if (Object.keys(code.modules).length > 1) {
                  hookModuleMaps();
                  const id = crypto.randomUUID();
                  loads.set(id, code.modules);
                  mod = await import(`standin://${id}/${encodeURIComponent(code.mainModule)}`);
                } else {
                  mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
                }
                return await mod.default.fetch(req, code.env);
              } finally {
                live.set(execId, false);
              }
            },
          }),
        };
      },
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
