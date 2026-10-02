/**
 * Moving an agent from the `pi085` engine (src/runtime/pi-agent.ts) to `pd` (src/runtime/durable-agent.ts), and back.
 *
 * What a migration keeps and what it lets go:
 *
 * - **Kept**: each session's transcript — its active branch, as pi 0.85 builds the model's context from it — copied
 *   into the session's pi-durable conversation (`main` into the root, every other session into its own, listed in
 *   `ap_conversations` as `PdHost.conversation` lists one). The object's other durable data is not an engine's and is
 *   not touched: the state store, mounts, credentials, the usage and trace outboxes.
 * - **Let go**: what only a running engine holds — run_js programs and tool questions waiting for `resume`, and a turn
 *   waiting for the Agents API caller's functions, which is imported cancelled (`cancelMarker`; pi085's
 *   `api_client_calls` rows are left as they are, for the rollback) — and, from the transcript, what is not on the active
 *   branch (pi 0.85's abandoned branches), the "not ready yet" answers pi 0.85 records while a call is out
 *   (`deferred`, sent to no model), and custom entries no model reads. A cancel marker is kept: it carries the note
 *   the model is shown for it (`markerNotes`), as `DurableAgent` writes one.
 * - **Refused**: an agent that is not idle — a run in progress or queued input on any session, or a model call not
 *   answered yet. A call out is spend in flight; an answer that came after the move would land nowhere and go unbilled.
 *
 * Each session is imported in one pi-durable commit, through `tx.appendEntry` and nothing else: no generation runs, no
 * `pi.usage` document moves, so the commit hook (src/runtime/pd-outbox.ts `bookCommit`) bills nothing and writes no
 * trace row. The commit ends with an `ap.migrated` entry; a session whose conversation has one is not imported again,
 * so a migration that stopped part-way is finished by running it again. The engine moves last
 * (`ApStore.migrateEngine`), so until then the agent is pi085's, unchanged.
 *
 * pi 0.85's tables are only read, and stay as they are: the rollback (`revertToPi085`) drops what pi-durable and the
 * `ap` tables hold for the conversations and moves the engine back, and pi085 reopens on its own transcript exactly as
 * it was before the migration. What happened on `pd` in between is not carried back.
 *
 * How a pi 0.85 entry becomes a pi-durable one:
 *
 * | pi 0.85 (active branch)                 | pi-durable                                                            |
 * |-----------------------------------------|-----------------------------------------------------------------------|
 * | `message` user                          | `pi.user`                                                             |
 * | `message` assistant                     | `pi.assistant`; a `deferred` one is dropped                           |
 * | `message` toolResult                    | `pi.tool-result`, no diagnostics                                      |
 * | `message` of pi 0.85's own roles        | `pi.user`, the text pi 0.85 sends the model for it (`convertToLlm`)   |
 * | `compaction`                            | `pi.compaction`, the summary in pi-durable's wrapper (pi 0.85's text);|
 * |                                         | its `head` is its retained tail where that tail already stands, else  |
 * |                                         | itself, with the tail appended after it (`importDrafts`)              |
 * | `branch_summary`                        | `pi.user`, the text pi 0.85 sends for it                              |
 * | `custom` of a kind in `markerNotes`     | an entry of that kind whose model message is the note                 |
 * | any other `custom`                      | dropped                                                               |
 *
 * pi-durable starts a context at its newest head marker, so the newest compaction decides the context as pi 0.85's
 * newest one does; the entries before it are kept for the transcript, out of the model's context in both.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import type { ConversationId, EntryDraft, EntryId } from "@earendil-works/pi-durable";
import { ApStore } from "../store/ap-store.ts";
import { PI_DURABLE_TABLES, type DurableSqlHost } from "../store/pi-durable-sqlite.ts";
import { MAIN_SESSION, piTables } from "../store/pi-storage.ts";
import { prefixedNamespace } from "../store/sql-namespace.ts";
import { recordedEngine, type PdHost } from "./durable-agent.ts";
import { readPdRecords } from "./pd-transcript.ts";

/** The entry that ends a session's import: a conversation holding one is not imported again. */
export const MIGRATED = "ap.migrated";

/** pi-durable's compaction wrapper (vendored harness/compaction.js `SUMMARY_PREFIX`/`SUFFIX`), which is pi 0.85's too (harness/messages.js). */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

const PD = prefixedNamespace("pd");
const AP = prefixedNamespace("ap");

type Sql = DurableSqlHost["sql"];
type Json = any;

/** What one session's import writes, by pi-durable kind, and what it leaves out, by pi 0.85 kind. */
export type ImportCounts = {
  user: number; assistant: number; toolResult: number; compaction: number;
  /** Markers kept with their model note (`markerNotes`), by kind. */
  notes: Record<string, number>;
  /** Entries pi 0.85 shows the model in a role of its own, imported as the user message it sends for them. */
  converted: number;
  /** Function calls the turn waited on the caller for: the turn is imported cancelled (`planMigration`). */
  cancelledCalls?: number;
  /** Left out: `deferred` answers, custom entries no model reads (by kind), entries off the active branch. */
  dropped: Record<string, number>;
};

export type SessionPlan = {
  session: string;
  /** The pi 0.85 branch's tip; null for a session that never wrote an entry. */
  tipId: string | null;
  /** Entries on the active branch. */
  branch: number;
  counts: ImportCounts;
  /** Already imported: its conversation holds the `ap.migrated` entry. */
  imported: boolean;
};

export type MigrationResult =
  | { ok: true; action: "dry-run" | "migrated" | "already"; engine: "pi085" | "pd"; sessions: SessionPlan[]; cancelled?: Record<string, number> }
  | { ok: false; refused: string; sessions?: SessionPlan[] };

export type RevertResult =
  | { ok: true; action: "dry-run" | "reverted" | "already"; engine: "pi085" | "pd"; dropped?: { conversations: number; entries: number; modelJobs: number; clientCalls: number } }
  | { ok: false; refused: string };

const tableExists = (sql: Sql, name: string) =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

/** The object's pi 0.85 sessions, `main` first. None when it never had one. */
function piSessions(sql: Sql): string[] {
  if (!tableExists(sql, "pi_sessions")) return [];
  const listed = sql.exec("SELECT session FROM pi_sessions ORDER BY created_at, session").toArray().map((r) => String(r.session));
  return [...listed.filter((s) => s === MAIN_SESSION), ...listed.filter((s) => s !== MAIN_SESSION)];
}

/** One of pi 0.85's lane values (`pi.branch.tip`, `pi.lane.state`) of the session's lane `main` (PiAgent's `LANE`). */
function laneValue(sql: Sql, session: string, namespace: string): Json {
  const t = piTables(session);
  if (!tableExists(sql, t.values)) return undefined;
  const row = sql.exec(`SELECT body FROM ${t.values} WHERE namespace = ? AND key = 'main'`, namespace).toArray()[0];
  return row ? JSON.parse(String(row.body)) : undefined;
}

/** The active branch from `tip`, oldest first: PiSqliteStorage's walk, read with SELECTs only. */
function piBranch(sql: Sql, session: string, tip: string): Json[] {
  const t = piTables(session);
  const rows = sql.exec(
    `WITH RECURSIVE ancestry(id, parent_id, body) AS (
       SELECT id, parent_id, body FROM ${t.entries} WHERE id = ?
       UNION ALL
       SELECT e.id, e.parent_id, e.body FROM ${t.entries} e JOIN ancestry a ON e.id = a.parent_id)
     SELECT body FROM ancestry`, tip).toArray();
  const byId = new Map<string, Json>();
  for (const r of rows) { const e = JSON.parse(String(r.body)); byId.set(e.id, e); }
  const path: Json[] = [];
  for (let e = byId.get(tip); e; e = e.parentId === null ? undefined : byId.get(e.parentId)) {
    path.push(e);
    if (e.parentId !== null && !byId.has(e.parentId)) throw new Error(`session ${session}: the branch from ${tip} is missing entry ${e.parentId}`);
  }
  if (path.length === 0) throw new Error(`session ${session}: the branch tip ${tip} is not in its entries`);
  return path.reverse();
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const show = (v: unknown) => JSON.stringify(v);
const bump = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

type Counted = { draft: EntryDraft; count: "user" | "assistant" | "toolResult" | "converted" } | { dropped: string };

/** One pi 0.85 message as the entry an import appends, or why it appends none. */
function messageDraft(m: Json): Counted {
  if (m?.role === "user") return { draft: { kind: "pi.user", model: [plain(m)] }, count: "user" };
  if (m?.role === "assistant") {
    return m.stopReason === "deferred" ? { dropped: "deferred" } : { draft: { kind: "pi.assistant", model: [plain(m)] }, count: "assistant" };
  }
  if (m?.role === "toolResult") return { draft: { kind: "pi.tool-result", model: [plain(m)], data: { diagnostics: [] } }, count: "toolResult" };
  // pi 0.85's own roles (custom, bashExecution, the summaries): what it sends the model for them, or nothing.
  const sent = convertToLlm([m]);
  return sent.length === 0 ? { dropped: `message:${String(m?.role)}` } : { draft: { kind: "pi.user", model: plain(sent) as never }, count: "converted" };
}

/**
 * A branch, oldest first, as the entries an import appends (the table in the header). `markerNotes` names the custom
 * kinds that are kept and the note each carries to the model.
 *
 * `heads` maps a compaction's index in `drafts` to the index of the entry its context starts at. pi 0.85 keeps a
 * compaction's tail as copies inside its entry; when those copies are the entries right before it, as pi 0.85 cuts
 * them, the import points the compaction's `head` at them where they are (pi-durable's own way of keeping a tail)
 * instead of appending them twice. Any other tail is appended after the compaction, which then starts at itself.
 */
export function importDrafts(branch: readonly Json[], markerNotes: Readonly<Record<string, string>> = {}): {
  drafts: EntryDraft[]; heads: Map<number, number>; counts: ImportCounts;
} {
  const counts: ImportCounts = { user: 0, assistant: 0, toolResult: 0, compaction: 0, notes: {}, converted: 0, dropped: {} };
  const drafts: EntryDraft[] = [];
  const heads = new Map<number, number>();
  const append = (c: Counted) => {
    if ("dropped" in c) { bump(counts.dropped, c.dropped); return; }
    drafts.push(c.draft);
    counts[c.count]++;
  };
  for (const e of branch) {
    if (e.type === "message") { append(messageDraft(e.message)); continue; }
    if (e.type === "compaction") {
      const tail = ((e.retainedTail ?? []) as Json[]).map(messageDraft);
      const kept = tail.flatMap((c) => ("draft" in c ? [c.draft] : []));
      const inPlace = kept.length > 0 && kept.length <= drafts.length && show(drafts.slice(-kept.length)) === show(kept);
      const at = drafts.length;
      drafts.push({
        kind: "pi.compaction", head: "self",
        model: [{ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}${String(e.summary ?? "")}${SUMMARY_SUFFIX}` }], timestamp: e.timestamp }],
        data: { reason: "manual", importedFrom: String(e.id), tokensBefore: Number(e.tokensBefore ?? 0) },
      });
      counts.compaction++;
      if (inPlace) heads.set(at, at - kept.length);
      else tail.forEach(append);
      continue;
    }
    if (e.type === "branch_summary") {
      if (!e.summary) { bump(counts.dropped, "branch_summary"); continue; }
      drafts.push({ kind: "pi.user", model: plain(convertToLlm([{ role: "branchSummary", summary: e.summary, fromId: e.fromId, timestamp: e.timestamp } as never])) as never });
      counts.converted++;
      continue;
    }
    if (e.type === "custom" && typeof e.customType === "string" && markerNotes[e.customType] !== undefined) {
      drafts.push({
        kind: e.customType,
        model: [{ role: "user", content: [{ type: "text", text: markerNotes[e.customType]! }], timestamp: e.timestamp }],
        data: { ...(e.data && typeof e.data === "object" ? plain(e.data) : {}), at: e.timestamp },
      });
      bump(counts.notes, e.customType);
      continue;
    }
    bump(counts.dropped, e.type === "custom" ? `custom:${String(e.customType)}` : String(e.type));
  }
  return { drafts, heads, counts };
}

/** Why the agent cannot be moved now, or null when it is idle. Read from pi 0.85's tables only. */
export function busyReason(sql: Sql): string | null {
  const reasons: string[] = [];
  for (const session of piSessions(sql)) {
    const state = laneValue(sql, session, "pi.lane.state");
    if (state?.currentOperationId) reasons.push(`session ${session} has a run in progress (${String(state.currentOperationId)})`);
    else if (Array.isArray(state?.inbox) && state.inbox.length > 0) reasons.push(`session ${session} has ${state.inbox.length} queued input(s)`);
  }
  if (tableExists(sql, "pi_model_jobs")) {
    const n = Number(sql.exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL").toArray()[0]?.n ?? 0);
    if (n > 0) reasons.push(`${n} model call(s) not answered yet`);
  }
  return reasons.length ? `the agent is not idle: ${reasons.join("; ")}` : null;
}

/** Function calls of a session that wait for the Agents API caller (src/runtime/client-calls.ts `api_client_calls`). */
function waitingCalls(sql: Sql, session: string): number {
  if (!tableExists(sql, "api_client_calls")) return 0;
  return Number(sql.exec("SELECT COUNT(*) AS n FROM api_client_calls WHERE session = ? AND state = 'pending' AND name != ''", session).toArray()[0]?.n ?? 0);
}

/**
 * Every session's import, as it would be written, and whether it already was. Writes nothing. A session whose turn
 * waits for the caller's functions ends with a `cancelMarker` entry, when one is named: the turn is cancelled, as
 * `AgentRuntime.cancelSession` cancels one that waits.
 */
export function planMigration(sql: Sql, opts: { markerNotes?: Readonly<Record<string, string>>; cancelMarker?: string; now?: () => number } = {}):
  Array<SessionPlan & { drafts: EntryDraft[]; heads: Map<number, number> }> {
  const notes = opts.markerNotes ?? {};
  return piSessions(sql).map((session) => {
    const tip = laneValue(sql, session, "pi.branch.tip");
    const tipId = typeof tip === "string" ? tip : null;
    const branch = tipId === null ? [] : piBranch(sql, session, tipId);
    const { drafts, heads, counts } = importDrafts(branch, notes);
    const waiting = waitingCalls(sql, session);
    if (waiting > 0 && opts.cancelMarker !== undefined) {
      const at = (opts.now ?? Date.now)();
      const note = notes[opts.cancelMarker];
      drafts.push({
        kind: opts.cancelMarker, data: { operationId: null, at, waitingCalls: waiting },
        ...(note === undefined ? {} : { model: [{ role: "user", content: [{ type: "text", text: note }], timestamp: at }] }),
      });
      counts.cancelledCalls = waiting;
    }
    const t = piTables(session);
    const all = tableExists(sql, t.entries) ? Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t.entries}`).toArray()[0]?.n ?? 0) : 0;
    if (all > branch.length) counts.dropped["off-branch"] = all - branch.length;
    const records = readPdRecords(sql, session);
    const imported = records.some((r) => r.kind === MIGRATED);
    if (!imported && records.some((r) => r.kind !== "pi.system")) {
      throw new Error(`session ${session}'s pi-durable conversation already holds ${records.length} entries that no migration wrote`);
    }
    return { session, tipId, branch: branch.length, counts, imported, drafts, heads };
  });
}

const report = (plans: ReadonlyArray<SessionPlan & { drafts?: unknown; heads?: unknown }>): SessionPlan[] =>
  plans.map(({ drafts: _d, heads: _h, ...p }) => p);

export interface MigrateOptions {
  /** The object's storage: `ctx.storage`, or `sqliteHost()` under node. */
  storage: DurableSqlHost;
  /** The object's pi-durable host, bound to the agent (`PdHost.bind`); its harness is closed when this returns. */
  host: PdHost;
  /** The custom kinds kept, and the model note each carries: what the runtime hands `DurableAgent` as `markerNotes`. */
  markerNotes?: Readonly<Record<string, string>>;
  /** The kind of entry that ends a session whose turn waits on the caller's functions; none when absent. */
  cancelMarker?: string;
  /** Report what would be imported, and write nothing. */
  dryRun?: boolean;
  /** Drop what the runtime holds in memory for the old engine; returns how many of each it dropped. */
  cancelTransient?: () => Promise<Record<string, number>>;
  now?: () => number;
}

/**
 * Move an idle `pi085` agent to `pd` (the header says what moves). An agent already on `pd` is left alone; one that is
 * busy is refused with the reason. A session already imported is not imported again, so a second run only finishes
 * what a first one left, and moves the engine.
 */
export async function migrateToPd(o: MigrateOptions): Promise<MigrationResult> {
  const sql = o.storage.sql;
  const engine = recordedEngine(sql);
  if (engine === "pd") return { ok: true, action: "already", engine: "pd", sessions: [] };
  const busy = busyReason(sql);
  let plans: ReturnType<typeof planMigration>;
  try {
    plans = planMigration(sql, {
      ...(o.markerNotes ? { markerNotes: o.markerNotes } : {}), ...(o.cancelMarker ? { cancelMarker: o.cancelMarker } : {}), ...(o.now ? { now: o.now } : {}),
    });
  }
  catch (error) { return { ok: false, refused: String((error as Error)?.message ?? error) }; }
  if (busy) return { ok: false, refused: busy, sessions: report(plans) };
  if (o.dryRun) return { ok: true, action: "dry-run", engine: "pi085", sessions: report(plans) };

  const cancelled: Record<string, number> = {
    clientCalls: plans.reduce((n, p) => n + (p.imported ? 0 : p.counts.cancelledCalls ?? 0), 0), ...(await o.cancelTransient?.() ?? {}),
  };
  const now = o.now ?? Date.now;
  try {
    for (const plan of plans) {
      if (plan.imported) continue;
      const id = await o.host.conversation(plan.session);
      // Not `withHarness`: its retry on a fresh harness would append a second copy if the first commit had landed.
      const h = await o.host.harness();
      const c = await o.host.handle(h, id);
      plan.imported = await c.commit(async (tx) => {
        // Checked again inside the commit, so two imports of one session cannot both land.
        const latest = await tx.scanEntries({ conversationId: c.id as ConversationId }, 256);
        if (latest.items.some((e) => e.kind === MIGRATED)) return true;
        const ids: EntryId[] = [];
        for (const [i, d] of plan.drafts.entries()) {
          const head = plan.heads.get(i);
          ids.push((await tx.appendEntry(c.id, head === undefined ? d : { ...d, head: ids[head]! })).id);
        }
        await tx.appendEntry(c.id, {
          kind: MIGRATED,
          data: { from: "pi085", session: plan.session, tipId: plan.tipId, branch: plan.branch, counts: plan.counts as Json, at: now() },
        });
        return true;
      }, bg);
    }
  } finally {
    await o.host.close();
  }
  const ap = new ApStore(o.storage, AP);
  ap.ensure();
  const moved = ap.migrateEngine("pi085", "pd");
  return { ok: true, action: "migrated", engine: moved, sessions: report(plans), cancelled };
}

/**
 * Move a migrated agent back to `pi085`: pi-durable's tables are dropped and the `ap` tables' conversations, model
 * jobs and client calls deleted, then the engine moves. pi 0.85's tables were never written, so its next turn is the
 * one it would have taken had the migration not happened. Refused while the `pd` agent has work under way or a model
 * call out, and for an agent created on `pd`, which has no pi 0.85 transcript to return to.
 */
export async function revertToPi085(o: { storage: DurableSqlHost; host: PdHost; dryRun?: boolean }): Promise<RevertResult> {
  const sql = o.storage.sql;
  const engine = recordedEngine(sql);
  if (engine !== "pd") return { ok: true, action: "already", engine: "pi085" };
  const ap = new ApStore(o.storage, AP);
  ap.ensure();
  if (ap.migratedFrom() !== "pi085") return { ok: false, refused: "this agent was created on pd, not migrated to it: there is no pi085 transcript to return to" };
  const out = Number(ap.query("SELECT COUNT(*) AS n FROM model_jobs WHERE answer IS NULL AND state IS NULL")[0]?.n ?? 0);
  if (out > 0) return { ok: false, refused: `the agent is not idle: ${out} model call(s) not answered yet` };
  const live = await o.host.withHarness(async (h) => (await h.inspect(bg)).tasks.length);
  await o.host.close();
  if (live > 0) return { ok: false, refused: `the agent is not idle: ${live} pi-durable task(s) under way` };
  const entries = tableExists(sql, PD.qualify("entries", "table"))
    ? Number(sql.exec(`SELECT COUNT(*) AS n FROM ${PD.qualify("entries", "table")}`).toArray()[0]?.n ?? 0) : 0;
  const dropped = {
    conversations: Number(ap.query("SELECT COUNT(*) AS n FROM conversations")[0]?.n ?? 0),
    entries,
    modelJobs: Number(ap.query("SELECT COUNT(*) AS n FROM model_jobs")[0]?.n ?? 0),
    clientCalls: Number(ap.query("SELECT COUNT(*) AS n FROM client_calls")[0]?.n ?? 0),
  };
  if (o.dryRun) return { ok: true, action: "dry-run", engine: "pd", dropped };
  // Dropped before the engine moves: an agent left on pi085 with pd's tables still holding the import would, migrated
  // again, find its sessions imported and keep a stale copy.
  o.storage.transactionSync(() => {
    for (const t of PI_DURABLE_TABLES) sql.exec(`DROP TABLE IF EXISTS ${PD.qualify(t, "table")}`);
    ap.query("DELETE FROM conversations");
    ap.query("DELETE FROM model_jobs");
    ap.query("DELETE FROM client_calls");
  });
  return { ok: true, action: "reverted", engine: ap.migrateEngine("pd", "pi085"), dropped };
}
