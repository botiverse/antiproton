/**
 * The one fact about a subagent that readers far from the runtime need: which session ids are subagents'. Kept apart
 * from src/runtime/subagents.ts so the activity mapping (src/runtime/status.ts), which the Worker's flush imports,
 * reads it without the table and the tool.
 *
 * Subagent session ids are minted by the runtime alone (`newSubagentId`), never taken from a caller: an Agents API
 * session is `sess_…` (cf/src/agents-api/store.ts) and the first conversation is `main`, so the prefix cannot be
 * claimed by anything else.
 */
export const SUBAGENT_SESSION_PREFIX = "sub_";

export function isSubagentSession(session: unknown): session is string {
  return typeof session === "string" && session.startsWith(SUBAGENT_SESSION_PREFIX);
}
