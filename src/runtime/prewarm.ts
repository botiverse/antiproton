/**
 * A prompt-cache prewarm: one cheap model call, made once after an agent's workspace import is whole, carrying the
 * system prompt and tools the agent's first turn will send, so the provider has that prefix cached before the first
 * message arrives (docs/agent-surface.md "Workspace import"). The call is no turn: it writes no transcript entry, no
 * message and no job row, and nothing an agent or a person reads. Its tokens are metered like any call's (the usage
 * outbox), and a `model.prewarm` trace row says what it cost and how it ended.
 *
 * Why a prewarm is the same request as the first turn's, reasoning setting included: both providers key their
 * prompt cache on it. Measured 2026-10-14 (deepseek-flash at api.deepseek.com, gpt-5.6-luna through Cloudflare AI
 * Gateway's /compat, a ~9k-token system prompt and 24 tools): a call with thinking on then a first turn with thinking
 * on read 9088 of 9340 prompt tokens from cache; the same call with thinking off read 0. DeepSeek's `reasoning_effort:
 * "low"` missed against the default as well, and `"high"` hit (the default is high). Luna: a prewarm at effort `none`
 * read 0 for a turn at `medium`, 7954 of 7977 for a turn at `none`.
 *
 * What the call looks like per path (cf/src/model-request.ts `callPrewarm`):
 * - chat/completions (DeepSeek, and OpenAI models without reasoning): the system prompt, one user message ".", the
 *   tools, a one-token cap. DeepSeek keeps the common prefix of two requests as a cache unit
 *   (https://api-docs.deepseek.com/guides/kv_cache, "common prefix detection"), so the first turn's request, which
 *   shares everything up to the user message, reads it.
 * - Responses (OpenAI reasoning models): the developer message and the tools with `prompt_cache_options.prewarm`,
 *   which writes the cache and generates nothing (https://developers.openai.com/api/docs/guides/prompt-caching); the
 *   developer message's end is a lookup boundary of the first turn's request. Its cache lives 30 minutes after the
 *   last write or read, so a first message later than that finds it cold again.
 *
 * At most once per import: the row below is made in the import's own transaction, and taken once; a queue redelivery
 * of the same message finds it taken and calls nothing. Skipped, with the reason recorded, when it cannot help: the
 * agent has already started a turn (its own call warms the cache), runs on its own credential or the pd engine, or
 * its model is not one whose provider caches prefixes for us (`prewarmable`). Never retried and never a reason for the
 * import to fail: every step here is a reading made after the import has answered.
 */

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const TABLE = `CREATE TABLE IF NOT EXISTS model_prewarm (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, migration_id TEXT NOT NULL, state TEXT NOT NULL,
  queued_at INTEGER NOT NULL, taken_at INTEGER, done_at INTEGER, outcome TEXT,
  PRIMARY KEY (tenant_id, agent_id))`;

/** The job id a prewarm's queue message carries: never a `pi_model_jobs` id (those start `mj_`). */
export const prewarmJobId = (migrationId: string) => `prewarm_${migrationId}`;
export const isPrewarmJob = (jobId: string) => jobId.startsWith("prewarm_");

export interface PrewarmRow { migrationId: string; state: "queued" | "taken" | "done"; queuedAt: number; outcome: string | null }

export function readPrewarm(sql: Sql, tenantId: string, agentId: string): PrewarmRow | null {
  let r: any;
  try { r = sql.exec("SELECT migration_id, state, queued_at, outcome FROM model_prewarm WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()[0]; }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return null; throw e; }
  return r ? { migrationId: String(r.migration_id), state: String(r.state) as PrewarmRow["state"], queuedAt: Number(r.queued_at), outcome: r.outcome === null ? null : String(r.outcome) } : null;
}

/** The import is whole: a prewarm is owed, once per agent. False when one was queued already. */
export function queuePrewarm(sql: Sql, tenantId: string, agentId: string, migrationId: string, now: number): boolean {
  sql.exec(TABLE);
  if (readPrewarm(sql, tenantId, agentId)) return false;
  sql.exec("INSERT INTO model_prewarm(tenant_id, agent_id, migration_id, state, queued_at) VALUES (?,?,?,'queued',?)", tenantId, agentId, migrationId, now);
  return true;
}

/** Take the queued prewarm for `migrationId`: true once, false for any later take or another id. */
export function takePrewarm(sql: Sql, tenantId: string, agentId: string, migrationId: string, now: number): boolean {
  const r = readPrewarm(sql, tenantId, agentId);
  if (!r || r.migrationId !== migrationId || r.state !== "queued") return false;
  sql.exec("UPDATE model_prewarm SET state='taken', taken_at=? WHERE tenant_id=? AND agent_id=? AND state='queued'", now, tenantId, agentId);
  return true;
}

/** How it ended: `warmed`, `failed: …`, or `skipped: …`. Written once; a later call changes nothing. */
export function finishPrewarm(sql: Sql, tenantId: string, agentId: string, migrationId: string, outcome: string, now: number): boolean {
  const r = readPrewarm(sql, tenantId, agentId);
  if (!r || r.migrationId !== migrationId || r.state === "done") return false;
  sql.exec("UPDATE model_prewarm SET state='done', done_at=?, outcome=? WHERE tenant_id=? AND agent_id=?", now, outcome.slice(0, 200), tenantId, agentId);
  return true;
}

/**
 * Whether a call to `model` can be warmed: a provider whose cache we measured a prewarm filling (above). DeepSeek's
 * own names are bare (`deepseek-flash`) at its API and `deepseek/…` through a gateway; OpenAI's are `openai/…`. Any
 * other vendor is skipped rather than paid for on a guess.
 */
export function prewarmable(model: string): boolean {
  if (model.startsWith("openai/") || model.startsWith("deepseek/")) return true;
  return !model.includes("/") && model.startsWith("deepseek");
}

/** The user message a chat/completions prewarm ends with: one character, so the shared prefix is all but the whole request. */
export const PREWARM_USER_TEXT = ".";

// ---- the first turn's reasoning (`firstTurn` on POST /provision/agents) ----------------------------------------

/** What the agent's record may say about its first turn. Only `reasoning: "off"` exists. */
export type FirstTurn = { reasoning: "off" };

/** The agent record's `firstTurn`, or null when it has none or holds something this code does not know. */
export function firstTurnOf(config: unknown): FirstTurn | null {
  const v = (config as Record<string, unknown> | null | undefined)?.firstTurn as Record<string, unknown> | undefined;
  return v && typeof v === "object" && v.reasoning === "off" ? { reasoning: "off" } : null;
}

/**
 * Whether a model call's conversation is still in the agent's first turn: no assistant message in it ended other than
 * by calling tools. The first reply that ends without a tool call (or fails, or is cut off) ends the turn, and every
 * call after it is a later turn's. Read from the call's own context, so it needs no state of its own and a redelivered
 * call is decided as the first delivery was. A turn cancelled before the model answered leaves no such message, so the
 * next turn is still the first; that turn's reply is then the first one the user sees.
 */
export function inFirstTurn(context: unknown): boolean {
  const messages = (context as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.every((m) => (m as { role?: unknown })?.role !== "assistant" || (m as { stopReason?: unknown }).stopReason === "toolUse");
}
