/**
 * A fresh context for an agent's main conversation, and the evidence of what its model was sent.
 *
 * **Fresh context.** The main conversation is the one every route that names no other posts to: an inbound push
 * (`AgentRuntime.#deliverInbound`), the console's `t_<agentId>`, a message with no session. Every one of those
 * reaches it as `MAIN_SESSION`, whose transcript is pi's unprefixed tables (src/store/pi-storage.ts `piTables`), and
 * pi 0.85 builds the model's context from the whole transcript (it has no reset entry; pi-agent-core
 * dist/harness/session/context.js). So a new main conversation is new tables under the same name: the old ones are
 * renamed to an archived session's, where they stay readable (`physicalSession`, cf/src/transcript-read.ts
 * `sessionFor`), and the main session starts empty. Nothing that says `MAIN_SESSION` has to learn a pointer, which
 * is the point: there are dozens of them, and one that was missed would read the old transcript.
 *
 * What names a conversation from outside is its *id*: `main` for the first one an agent had, `main.<n>` for the n-th
 * fresh one. `main_sessions` keeps one row per id, with the archived name of each one that has ended.
 *
 * **Model input evidence.** One row per model call, written when the call is handed to the queue
 * (`AgentRuntime.#dispatchFor`): for each message its role, a hash of the message as sent, its length, and which
 * conversation's transcript holds that exact message, if any; whether a summary block (compaction or branch) is in
 * it; which working-set documents and seeded paths the system prompt carries. Hashes, ids and roles only: no text
 * is kept here, so the record can be read by the setup's credential without handing it the conversation.
 */
import { BRANCH_SUMMARY_PREFIX, COMPACTION_SUMMARY_PREFIX } from "@earendil-works/pi-agent-core";
import { canonJson } from "../../src/core/canon-json.ts";
import { WORKING_SET } from "../../src/plugins/state.ts";
import { ensurePiTables, MAIN_SESSION, piTables } from "../../src/store/pi-storage.ts";
import { sha256Hex } from "../../src/store/seed-files.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
type Host = { sql: Sql; transactionSync?<T>(fn: () => T): T };

/** The id of an agent's first main conversation, the one it had before any fresh context. */
export const FIRST_MAIN_ID = MAIN_SESSION;

const MAIN_SESSIONS = `CREATE TABLE IF NOT EXISTS main_sessions (
  generation INTEGER PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, archived_as TEXT,
  started_at INTEGER, ended_at INTEGER)`;

const DIGESTS = `CREATE TABLE IF NOT EXISTS model_input_digests (
  session_id TEXT NOT NULL, call INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY (session_id, call))`;

/** Rows of a read, or none when its table was never made: a read does not create tables. */
function rows(sql: Sql, query: string, ...b: unknown[]): any[] {
  try { return sql.exec(query, ...b).toArray(); }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return []; throw e; }
}

/** The id of the main conversation now. */
export function currentMainId(sql: Sql): string {
  const r = rows(sql, "SELECT session_id FROM main_sessions WHERE ended_at IS NULL ORDER BY generation DESC LIMIT 1")[0];
  return r ? String(r.session_id) : FIRST_MAIN_ID;
}

export interface MainSessionRow { sessionId: string; generation: number; current: boolean; startedAt: number | null; endedAt: number | null }

/** Every main conversation the agent has had, oldest first; the first one, before any fresh context, included. */
export function mainSessions(sql: Sql): MainSessionRow[] {
  const got = rows(sql, "SELECT generation, session_id, started_at, ended_at FROM main_sessions ORDER BY generation").map((r) => ({
    sessionId: String(r.session_id), generation: Number(r.generation), current: r.ended_at === null || r.ended_at === undefined,
    startedAt: r.started_at === null || r.started_at === undefined ? null : Number(r.started_at),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
  }));
  return got.length ? got : [{ sessionId: FIRST_MAIN_ID, generation: 0, current: true, startedAt: null, endedAt: null }];
}

/**
 * The session whose tables hold the conversation `id`: `MAIN_SESSION` for the current main one, the archived name
 * for one that has ended, null for an id that is no main conversation of this agent (another session is its own name).
 */
export function physicalSession(sql: Sql, id: string): string | null {
  if (id === currentMainId(sql)) return MAIN_SESSION;
  const r = rows(sql, "SELECT archived_as FROM main_sessions WHERE session_id = ? AND archived_as IS NOT NULL", id)[0];
  return r ? String(r.archived_as) : null;
}

/** The archived name of an ended main conversation: its own session, so its tables are `piTables` of this. */
const archivedName = (id: string) => `archived:${id}`;

/**
 * End the main conversation and start an empty one under the same name, in one transaction: the transcript's tables
 * renamed to the archived session's (with their indexes made again under its names, since a rename keeps an index's
 * name and the new main tables' `CREATE INDEX IF NOT EXISTS` would otherwise find it taken), and the row of each id
 * written. The caller has made sure nothing is running (`AgentRuntime.freshContext`).
 */
export function startFreshMain(host: Host, now: number): { oldSessionId: string; newSessionId: string } {
  const sql = host.sql;
  const run = () => {
    sql.exec(MAIN_SESSIONS);
    ensurePiTables(sql, MAIN_SESSION);
    const oldSessionId = currentMainId(sql);
    const last = Number(sql.exec("SELECT COALESCE(MAX(generation), 0) AS g FROM main_sessions").toArray()[0]?.g ?? 0);
    const generation = last + 1;
    const newSessionId = `${FIRST_MAIN_ID}.${generation}`;
    const archive = archivedName(oldSessionId);
    const from = piTables(MAIN_SESSION), to = piTables(archive);
    const tables = Object.keys(from) as Array<keyof typeof from>;
    for (const ix of sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${tables.map(() => "?").join(",")})`,
      ...tables.map((k) => from[k])).toArray()) {
      sql.exec(`DROP INDEX "${String(ix.name).replace(/"/g, "")}"`);
    }
    for (const k of tables) sql.exec(`ALTER TABLE ${from[k]} RENAME TO ${to[k]}`);
    ensurePiTables(sql, archive);
    ensurePiTables(sql, MAIN_SESSION);
    sql.exec("INSERT OR IGNORE INTO main_sessions(generation, session_id, started_at) VALUES (0, ?, NULL)", FIRST_MAIN_ID);
    sql.exec("UPDATE main_sessions SET ended_at = ?, archived_as = ? WHERE session_id = ?", now, archive, oldSessionId);
    sql.exec("INSERT INTO main_sessions(generation, session_id, started_at) VALUES (?, ?, ?)", generation, newSessionId, now);
    return { oldSessionId, newSessionId };
  };
  return host.transactionSync ? host.transactionSync(run) : run();
}

// ---- model input evidence

export interface MessageEvidence {
  role: string;
  /** sha256 of the message's canonical JSON, as it was sent. */
  sha256: string;
  /** Characters of its text, tool calls' arguments included. */
  length: number;
  /** The conversation whose transcript holds exactly this message, and the entry; null when none does. */
  sourceSessionId: string | null;
  messageId: string | null;
}

export interface ModelInputEvidence {
  sessionId: string;
  call: number;
  jobId: string;
  at: number;
  systemPromptSha256: string;
  messages: MessageEvidence[];
  /** A compaction or branch summary is in the input. */
  summaryBlock: boolean;
  /** The working-set documents (src/plugins/state.ts WORKING_SET) whose heading the system prompt carries. */
  workingSetKeys: string[];
  /** The seeded paths the system prompt lists as seeded files (`seededPathsListed`). */
  seedPathsInSystemPrompt: string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: any) => typeof p?.text === "string" ? p.text
    : typeof p?.thinking === "string" ? p.thinking
    : p?.type === "toolCall" ? `${p.name ?? ""}${JSON.stringify(p.arguments ?? null)}` : "").join("");
}

/**
 * The seeded paths the system prompt carries as seeded files: a line the state plugin's setup block writes for one
 * (src/plugins/state.ts `seededFiles`), the `MEMORY.md` heading "## `path` (<size>, <mode>)" or a list line
 * "- `path` (<size>, <mode>): …", where size is "<n> bytes" or "removed". A path that is merely mentioned, or that
 * is part of a longer word or path, is not listed.
 */
export function seededPathsListed(system: string, seedPaths: readonly string[]): string[] {
  const listed = new Set<string>();
  for (const m of system.matchAll(/^(?:## |- )`([^`\n]+)` \((?:\d+ bytes|removed), (?:writable|readonly)\)/gm)) listed.add(m[1]!);
  return seedPaths.filter((p) => listed.has(p));
}

const messageHash = (m: unknown) => sha256Hex(canonJson(m));

/** Every message entry of the main conversations, current and archived, by its message's hash. */
function messageIndex(sql: Sql): Map<string, { sessionId: string; messageId: string }> {
  const out = new Map<string, { sessionId: string; messageId: string }>();
  for (const s of mainSessions(sql)) {
    const physical = s.current ? MAIN_SESSION : physicalSession(sql, s.sessionId);
    if (!physical) continue;
    for (const r of rows(sql, `SELECT body FROM ${piTables(physical).entries} WHERE type = 'message' ORDER BY seq`)) {
      const e = JSON.parse(String(r.body));
      const h = messageHash(e.message);
      if (!out.has(h)) out.set(h, { sessionId: s.sessionId, messageId: String(e.id) });
    }
  }
  return out;
}

/**
 * Record the input of one model call, once per job: read from the job's own row (`pi_model_jobs`, written by pi085
 * before dispatch), so what is described is what the queue sends. Null when the job is not pi085's (pd keeps its
 * own) or was recorded already.
 */
export function recordModelInput(sql: Sql, jobId: string, seedPaths: readonly string[], now: number): ModelInputEvidence | null {
  const job = rows(sql, "SELECT request, session FROM pi_model_jobs WHERE id = ?", jobId)[0];
  if (!job) return null;
  sql.exec(DIGESTS);
  if (sql.exec("SELECT 1 FROM model_input_digests WHERE job_id = ?", jobId).toArray().length) return null;
  const physical = String(job.session);
  const sessionId = physical === MAIN_SESSION ? currentMainId(sql) : physical;
  const context = (JSON.parse(String(job.request))?.context ?? {}) as { systemPrompt?: string; messages?: unknown[] };
  const system = String(context.systemPrompt ?? "");
  const index = messageIndex(sql);
  const messages: MessageEvidence[] = (context.messages ?? []).map((m: any) => {
    const sha256 = messageHash(m);
    const source = index.get(sha256);
    return { role: String(m?.role), sha256, length: textOf(m?.content).length, sourceSessionId: source?.sessionId ?? null, messageId: source?.messageId ?? null };
  });
  const summaryBlock = (context.messages ?? []).some((m: any) => m?.role === "compactionSummary" || m?.role === "branchSummary"
    || [COMPACTION_SUMMARY_PREFIX, BRANCH_SUMMARY_PREFIX].some((p) => textOf(m?.content).includes(p.trim())));
  const call = Number(sql.exec("SELECT COALESCE(MAX(call), 0) AS n FROM model_input_digests WHERE session_id = ?", sessionId).toArray()[0]?.n ?? 0) + 1;
  const evidence: ModelInputEvidence = {
    sessionId, call, jobId, at: now, systemPromptSha256: sha256Hex(system), messages, summaryBlock,
    workingSetKeys: WORKING_SET.filter((d) => system.includes(`## ${d.key} (`)).map((d) => d.key),
    seedPathsInSystemPrompt: seededPathsListed(system, seedPaths),
  };
  sql.exec("INSERT INTO model_input_digests(session_id, call, job_id, at, digest) VALUES (?,?,?,?,?)",
    sessionId, call, jobId, now, JSON.stringify(evidence));
  return evidence;
}

/** The recorded input of call `call` (1-based) of conversation `sessionId`; null when there is none. */
export function readModelInput(sql: Sql, sessionId: string, call: number): ModelInputEvidence | null {
  const r = rows(sql, "SELECT digest FROM model_input_digests WHERE session_id = ? AND call = ?", sessionId, call)[0];
  return r ? JSON.parse(String(r.digest)) as ModelInputEvidence : null;
}

/** How many calls of `sessionId` are recorded. */
export function modelInputCalls(sql: Sql, sessionId: string): number {
  return Number(rows(sql, "SELECT COUNT(*) AS n FROM model_input_digests WHERE session_id = ?", sessionId)[0]?.n ?? 0);
}
