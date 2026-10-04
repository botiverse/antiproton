/**
 * `PluginContext.caller.contextId`: which context window of a session the model is in.
 *
 * A plugin that scopes "what the model has already seen" (Raft's command endpoint does) needs a key that stays the
 * same for as long as earlier reads are still in the model's context, and changes once they may not be. So it is
 * derived from the things that bound that context, read from durable state on every call — never cached in memory, so
 * a restarted object computes the same value — and from nothing that moves per turn:
 *
 * - the agent and the session: a new session is a new context;
 * - the engine: `pd` and `pi085` keep separate transcripts (src/runtime/pd-migrate.ts imports one into the other and
 *   a revert drops it), so a move between them is treated as a new context;
 * - the transcript's own instance: pi085, the session's first entry id (a fresh id per entry, so a transcript that was
 *   dropped and remade does not take the old one's value); pd, the `ap_conversations` row's creation time, since a
 *   revert drops pi-durable's tables and entry ids start again;
 * - the newest context boundary: the entry from which the model's context is rebuilt. pd, the newest head marker
 *   (`entries.head IS NOT NULL`: a compaction or a reset), which is exactly what pi-durable's own context read starts
 *   from (dist/harness/context.js `captureContextBounds`, `findLatestHeadMarker`) and is found through its partial index
 *   `entry_heads_by_conversation`. pi085, the newest `compaction` entry (pi-agent-core
 *   dist/harness/session/context.js `buildContextEntries`), a `branch_summary` or a `pi.reset`, found through the partial
 *   index `<entries>_boundary` (src/store/pi-storage.ts).
 *
 * The value changing when nothing was lost costs a plugin a re-read; staying the same when something was lost would
 * let it believe the model holds what it no longer does. Every choice above errs toward the first.
 */
import { createHash } from "node:crypto";
import { piTables, MAIN_SESSION, CONTEXT_BOUNDARY_WHERE } from "../store/pi-storage.ts";
import { prefixedNamespace, SqlQualifier } from "../store/sql-namespace.ts";
import { PI_DURABLE_OBJECTS } from "../store/pi-durable-sqlite.ts";
import { AP_OBJECTS } from "../store/ap-store.ts";

type ReadSql = { exec(query: string, ...bindings: any[]): { toArray(): any[] } };

const PD = new SqlQualifier(PI_DURABLE_OBJECTS, prefixedNamespace("pd"));
const AP = new SqlQualifier(AP_OBJECTS, prefixedNamespace("ap"));

const tableExists = (sql: ReadSql, name: string) =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

function digest(parts: ReadonlyArray<string | number | null>): string {
  return `ctx_${createHash("sha256").update(JSON.stringify(["v1", ...parts])).digest("hex").slice(0, 32)}`;
}

/**
 * The context id of one session, or undefined when the session has no transcript yet (no plugin call can come from a
 * model turn before its first entry is written).
 */
export function contextIdOf(
  sql: ReadSql,
  scope: { tenantId: string; agentId: string; session?: string; engine: "pi085" | "pd" },
): string | undefined {
  const session = scope.session ?? MAIN_SESSION;
  if (scope.engine === "pd") {
    const conversations = prefixedNamespace("ap").qualify("conversations", "table");
    if (!tableExists(sql, conversations)) return undefined;
    const row = sql.exec(AP.rewrite("SELECT conversation_id, created_at FROM conversations WHERE task_id = ?"), session).toArray()[0];
    if (!row) return undefined;
    const conversation = Number(row.conversation_id);
    let head: number | null = null;
    if (tableExists(sql, prefixedNamespace("pd").qualify("entries", "table"))) {
      // `head IS NOT NULL` in the predicate is what lets the planner use the partial index.
      const h = sql.exec(PD.rewrite("SELECT MAX(id) AS h FROM entries WHERE conversation_id = ? AND head IS NOT NULL"), conversation).toArray()[0];
      head = h?.h === null || h?.h === undefined ? null : Number(h.h);
    }
    return digest([scope.tenantId, scope.agentId, "pd", session, conversation, Number(row.created_at), head]);
  }
  const t = piTables(session);
  if (!tableExists(sql, t.entries)) return undefined;
  const first = sql.exec(`SELECT id FROM ${t.entries} ORDER BY seq ASC LIMIT 1`).toArray()[0];
  if (!first) return undefined;
  const b = sql.exec(`SELECT MAX(seq) AS b FROM ${t.entries} WHERE ${CONTEXT_BOUNDARY_WHERE}`).toArray()[0];
  const boundary = b?.b === null || b?.b === undefined ? null : Number(b.b);
  return digest([scope.tenantId, scope.agentId, "pi085", session, String(first.id), boundary]);
}
