/**
 * `PluginContext.caller.contextId`: which context window of a session the model is in.
 *
 * A plugin that scopes "what the model has already seen" (Raft's command endpoint does) needs a key that stays the
 * same across the turns of one context and changes when the context is rebuilt. It is derived from durable state on
 * every call — never cached in memory, so a restarted object computes the same value — and from nothing that moves per
 * turn:
 *
 * - the agent and the session: a new session is a new context;
 * - the engine: `pd` and `pi085` keep separate transcripts (src/runtime/pd-migrate.ts imports one into the other and
 *   a revert drops it), so a move between them is a new context;
 * - the transcript's own instance: pi085, the session's first entry id (a fresh id per entry, so a transcript that was
 *   dropped and remade does not take the old one's value); pd, the `ap_conversations` row's id and creation time,
 *   since a revert drops pi-durable's tables and its conversation and entry ids start again;
 * - the newest context boundary. pd, the newest head marker (`entries.head IS NOT NULL`: a compaction or a reset),
 *   which is what pi-durable's own context read starts from (dist/harness/context.js `captureContextBounds`,
 *   `findLatestHeadMarker`). pi085, the newest `compaction` (pi-agent-core dist/harness/session/context.js
 *   `buildContextEntries` starts there), `branch_summary` or `pi.reset` entry.
 *
 * So the id changes on exactly these: a new session, a compaction, a reset, a move between engines, a transcript
 * remade. Two ways a read can leave the model's context are NOT among them, and each is safe today only because of
 * what the code around it does (docs/pi-upstream.md, "What `caller.contextId` rests on"):
 *
 * - pi085's tip moved back with `navigateTree`. The one caller, `resumeClientCalls` (src/runtime/client-calls.ts),
 *   carries every result of the paused message onto the new branch, so nothing read is dropped.
 * - pi-durable's context edits (`EntryRecord.edits`, `omit`/`replace`), which `deriveContext` applies with no head
 *   marker. Nothing here writes one; test/caller-context.ts fails if src/ or cf/src starts to.
 *
 * Within those, a change when nothing was lost costs a plugin a re-read, and every choice above errs that way.
 */
import { createHash } from "node:crypto";
import { piTables, MAIN_SESSION, CONTEXT_BOUNDARY_WHERE } from "../store/pi-storage.ts";
import { prefixedNamespace } from "../store/sql-namespace.ts";

type ReadSql = { exec(query: string, ...bindings: any[]): { toArray(): any[] } };

const AP_CONVERSATIONS = prefixedNamespace("ap").qualify("conversations", "table");
const PD_ENTRIES = prefixedNamespace("pd").qualify("entries", "table");

/**
 * One statement's rows, or null when a table it names does not exist yet (an object that has not spoken on this
 * engine). Asked of the statement itself rather than of `sqlite_master` first: this runs on every plugin call, every
 * call of a run_js program included, and a Durable Object bills the rows a read touches. Not remembered once seen:
 * a revert drops pd's tables under a live object (src/runtime/pd-migrate.ts).
 */
function rowsOrNone(sql: ReadSql, query: string, ...bindings: unknown[]): any[] | null {
  try { return sql.exec(query, ...bindings).toArray(); }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return null; throw e; }
}

function digest(parts: ReadonlyArray<string | number | null>): string {
  return `ctx_${createHash("sha256").update(JSON.stringify(["v1", ...parts])).digest("hex").slice(0, 32)}`;
}

/** The one statement `contextIdOf` runs for a session; pd's takes the session as its one binding. Exported so a test reads its plan. */
export function contextIdQuery(engine: "pi085" | "pd", session: string = MAIN_SESSION): string {
  if (engine === "pd") {
    return `SELECT c.conversation_id AS conversation, c.created_at AS created,
         (SELECT MAX(e.id) FROM ${PD_ENTRIES} e WHERE e.conversation_id = c.conversation_id AND e.head IS NOT NULL) AS head
       FROM ${AP_CONVERSATIONS} c WHERE c.task_id = ?`;
  }
  const t = piTables(session);
  return `SELECT (SELECT id FROM ${t.entries} ORDER BY seq ASC LIMIT 1) AS first,
       (SELECT MAX(seq) FROM ${t.entries} WHERE ${CONTEXT_BOUNDARY_WHERE}) AS boundary`;
}

const numberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * The context id of one session, or undefined when the session has no transcript yet (no plugin call can come from a
 * model turn before its first entry is written). One statement per call on either engine, each through an index.
 */
export function contextIdOf(
  sql: ReadSql,
  scope: { tenantId: string; agentId: string; session?: string; engine: "pi085" | "pd" },
): string | undefined {
  const session = scope.session ?? MAIN_SESSION;
  if (scope.engine === "pd") {
    // pi-durable makes its tables before the conversation row can name one of its conversations, so a row with no
    // entries table is not a state this reads as anything but "no transcript". `head IS NOT NULL` in the predicate is
    // what lets the planner use the partial index `entry_heads_by_conversation`.
    const row = rowsOrNone(sql, contextIdQuery("pd", session), session)?.[0];
    if (!row) return undefined;
    return digest([scope.tenantId, scope.agentId, "pd", session, Number(row.conversation), Number(row.created), numberOrNull(row.head)]);
  }
  const row = rowsOrNone(sql, contextIdQuery("pi085", session))?.[0];
  if (!row || row.first === null || row.first === undefined) return undefined;
  return digest([scope.tenantId, scope.agentId, "pi085", session, String(row.first), numberOrNull(row.boundary)]);
}
