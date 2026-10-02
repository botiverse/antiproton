/**
 * A compaction the engine refuses, carried from the agent's object to whoever
 * asked: the console's compact button (/ui/compact) and the operator's
 * /admin/compact, both in cf/src/index.ts.
 *
 * The refusal is an answer, not a fault. `CompactionUnavailable` does not keep
 * its class across a Durable Object RPC call (it would arrive as a bare Error
 * and the route would answer 500), so the object turns it into a value and the
 * route turns the value into a 409 carrying the reason.
 */
import { CompactionUnavailable } from "../../src/runtime/engine.ts";

export interface CompactionRefused { refused: string }

/** Run the compaction request; a `CompactionUnavailable` becomes `{ refused }`, anything else still throws. */
export async function refusingCompaction<T>(fn: () => Promise<T>): Promise<T | CompactionRefused> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof CompactionUnavailable) return { refused: e.message };
    throw e;
  }
}

/**
 * The route's answer for a refusal, or null when the compaction went ahead.
 * `json` for /admin/compact (`{ error }`, as every admin route answers);
 * `text` for /ui/compact, whose plain-text body the console shows under the
 * form that sent it (cf/src/ui.ts, the htmx:afterRequest listener).
 */
export function compactionRefusal(result: unknown, as: "json" | "text"): Response | null {
  if (!result || typeof result !== "object" || typeof (result as CompactionRefused).refused !== "string") return null;
  const reason = (result as CompactionRefused).refused;
  return as === "json"
    ? Response.json({ error: reason }, { status: 409 })
    : new Response(reason, { status: 409, headers: { "content-type": "text/plain; charset=utf-8" } });
}
