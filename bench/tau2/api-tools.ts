/**
 * The retail tools as the Agents API runner declares and runs them (bench/tau2/api.ts).
 *
 * An API agent is described entirely by its caller, so the domain reaches it as function tools: declared on
 * the agent, called by the model, and run here on the runner's own copy of the database. The implementation
 * is the one the `/bench` object mounts (`retailPlugin`, bench/tau2/retail.ts), so the database a task leaves
 * is computed by the same code either way.
 *
 * What the model is shown has to be what the `/bench` object showed it, or the comparison between the two
 * runners measures a different catalogue. So the names are the mount-qualified ones the gateway built for the
 * `retail` mount, `retail__<tool>`, the descriptions are the tools' summaries, and the parameters are the
 * same objects; test/bench-tau2-api.ts holds this list byte-equal to the gateway's own construction
 * (cf/src/runtime.ts `mountedToolEntries`, src/runtime/pi-tools.ts `qualifyMountedTools`).
 */
import { retailPlugin, type RetailDB } from "./retail.ts";

/** The alias the `/bench` object mounted the domain under, and so the prefix of every name the model saw. */
export const RETAIL_PREFIX = "retail__";

export interface FunctionTool { type: "function"; name: string; description: string; parameters: unknown }

/** The function tools an agent is created with. */
export function retailFunctions(): FunctionTool[] {
  return retailPlugin({ products: {}, users: {}, orders: {} } as RetailDB, []).tools.map((t) => ({
    type: "function", name: `${RETAIL_PREFIX}${t.name}`, description: t.summary, parameters: t.parameters,
  }));
}

/** One answer to a `required_actions[]` call, as the `agent.session.input.tool_result` event carries it. */
export type CallOutcome = { success: true; output: string } | { success: false; error: string };

/**
 * Run one call the agent made, on `db`, logging it to `performed` as the plugin does (before it runs, so a
 * refused write is still a write the agent attempted).
 *
 * The text is the text the model read from the mounted tool, because a different wording is a different
 * prompt. A result is the plugin's return value as JSON (src/runtime/pi-tools.ts `deliverToolResult`); a
 * thrown error reached the model as `<name>: <message>` (the same function's throw, which pi records as the
 * error's message, harness/execution/tools.js `createErrorToolResult`).
 */
export async function runRetailCall(
  call: { name: string; arguments: string }, db: RetailDB, performed: Array<{ name: string; args: any }>,
): Promise<CallOutcome> {
  if (!call.name.startsWith(RETAIL_PREFIX)) return { success: false, error: `Tool ${JSON.stringify(call.name)} is unavailable` };
  const tool = call.name.slice(RETAIL_PREFIX.length);
  let args: unknown;
  try { args = JSON.parse(call.arguments || "{}"); }
  catch { return { success: false, error: `${call.name}: the arguments are not JSON` }; }
  try {
    const result = await retailPlugin(db, performed).invoke(tool, args as never, undefined as never);
    return { success: true, output: JSON.stringify(result ?? null) };
  } catch (e) {
    return { success: false, error: `${call.name}: ${(e as Error)?.message ?? String(e)}` };
  }
}
