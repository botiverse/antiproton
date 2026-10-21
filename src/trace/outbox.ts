/**
 * trace_outbox: what happened, in the shape an export can carry.
 *
 * One row per ended span, appended where the work commits, drained on the
 * alarm pass — the same transport the usage ledger uses
 * (src/usage/outbox.ts), because that shape has already answered "the object
 * was evicted mid-send" and "the same pass ran twice": a row's identity is
 * (tenant, agent, seq), seq is AUTOINCREMENT and never reused, so a retried
 * batch is recognizable downstream without anyone bookkeeping sends.
 *
 * What a row means, settled in the trace design (docs live with the plan;
 * #o11y 2026-09-22): only ENDED spans are written — an open call has no row
 * here, it has its live surface (unanswered pi_model_jobs, activity.live,
 * parked approvals). A row without its span id is an orphan by definition —
 * the seam that produced it has a bug — so append drops it rather than store
 * it; the drop is the visible half of that contract, the seams' join tests
 * are the other half.
 *
 * `status` is what the seam said, verbatim (an operation status, a
 * stopReason, an inbound outcome); `verdict` is the normalized reading of it,
 * decided HERE at append time, both written in the same row. The raw value
 * never changes; the normalizing rule will — that is why the normalized form
 * is stored, not recomputed by every reader (the rawStopReason/stopReason
 * precedent in src/model/pi-bridge.ts).
 *
 * Two kinds of silence are documented, not accidental: a live container has
 * no row (no observable close event exists to end its span), and a stall has
 * no row (no detector exists yet) — "no row" must not be read as "nothing
 * happened" for either.
 */
import { logEvent } from "../core/log.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

const TABLE = "CREATE TABLE IF NOT EXISTS trace_outbox(" +
  "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
  "at INTEGER NOT NULL, " +
  "tenant_id TEXT NOT NULL, " +
  "agent_id TEXT NOT NULL, " +
  "kind TEXT NOT NULL, " +
  "span_id TEXT NOT NULL, " +
  "parent_id TEXT, " +
  "status TEXT NOT NULL, " +
  "verdict TEXT NOT NULL, " +
  "ms INTEGER, " +
  "attrs TEXT NOT NULL)";

// `turn.stop` is a turn ended from outside (an operator, the provider, a delete: cf/src/runtime.ts `stopTurn`); activity
// reads it as the turn's BridgeFatal, with who stopped it in its errorClass, and status as `error`. `js.run` is one
// run_js program's stretch, how it ended and its error code (cf/src/runtime.ts `#turnTools`); activity and status skip
// it, as a mount call inside it has its own row.
// `mount.seeded` is one catalogue entry's outcome on one agent (src/store/seed-record.ts): written when the outcome
// changes, in the transaction that adds the mount when there is one. Activity and status skip it (their `default`).
// `harness.open` is one harness built for one conversation, with why (src/runtime/harness-open.ts); a reuse has none.
// `rebuild.decision` is a context rebuild decided (a wake's shadow prediction, the engine's own compaction, or the
// overflow backstop's rebuild) and `rebuild.outcome` the first call after it, measured (src/runtime/rebuild.ts);
// `rebuild.behaviour` what the agent did on the run after an idle rebuild (src/runtime/rebuild-behaviour.ts);
// `session.needs_reset` a conversation the overflow backstop gave up on (src/runtime/overflow-backstop.ts). Activity
// and status skip all four.
// `turn.timing` is one turn of a pi085 conversation, its wall time split into points (src/runtime/turn-timing.ts),
// written when the turn ends. Activity and status skip it.
// `import.hold` is an agent's wait for its workspace import ending (src/store/workspace-import.ts): `import` when the
// import lifted it, `valve` when no import came in time and it lifted on its own. Activity and status skip it.
// `model.prewarm` is the prompt-cache prewarm after an import (src/runtime/prewarm.ts): `warmed`, `skipped` or
// `failed`, with its tokens. Activity and status skip it.
// `agent.ready` is a provisioned agent ready before its first turn, once per agent (src/runtime/ready.ts): its status
// is `online`, a status-only activity event.
// `mount.settings` is an operator's in-place change of a mount's settings (`PATCH /admin/mounts`, cf/src/runtime.ts
// `updateMountSettings`): `attrs` the alias, the plugin and the keys that changed. Activity and status skip it.
// `subagent.turn` is one turn of a subagent ending (src/runtime/subagents.ts, cf/src/runtime.ts `#reportSubagents`): its
// span the child's session, its parent the tool call that sent the turn, `status` done, failed, cancelled; `attrs` the
// session that started it. The child's own `model.call` and `tool.call` rows name its session. Activity and status skip it.
// `subagent.start` is a child's turn beginning (cf/src/runtime.ts `#sendToAgent`, a background wake): span the child,
// parent the tool call that sent it (none for a wake), `attrs` the session that started it, the turn, and `how` (`spawn`,
// `follow_up`, `wake`). Ids and counts only, never the task. Activity and status skip it unless SUBAGENT_ACTIVITY is on.
// `subagent.model_changed` is a child's calls moving to another model since its spawn (a pin or a picker switch set
// since, cf/src/runtime.ts `takeJob`): span the child, `attrs` from, to and why. Activity and status skip it.
// `github.refresh` is one outcome of renewing an expiring GitHub token (cf/src/github-refresh.ts), the same outcomes
// as its `github.refresh` log line: `status` the outcome (`rotated`, `adopted`, `broken`, `unavailable`, `store-failed`,
// `kept-unstored`, `interrupted-before`, `propagate-failed`), `attrs` only ids and fixed codes (`scope`, `connectorId`,
// `mount`, `why`, `attempt`, `stored`, `reasonCode`), never a token or GitHub's own words. It is here because an object's
// log lines can be dropped from Workers Logs (docs/runbook.md) and this export is what is left. Activity and status skip it.
// It is the one kind forwarded outside the account, as fixed columns, once configured (cf/src/github-refresh-forward.ts).
// The rest are the kinds a plugin may write itself, through `PluginContext.trace` (`PLUGIN_TRACE_KINDS`). Activity and
// status skip them. `raft.state_save_failed` is no longer written (it is `raft.state_failed` now) and stays here only so
// a row of that kind still in an outbox is drained and read as a row, not dropped as damage.
export const TRACE_KINDS = ["model.call", "tool.call", "approval.wait", "container.lease", "inbound", "mount.seeded", "harness.open",
  "turn.stop", "js.run",
  "rebuild.decision", "rebuild.outcome", "rebuild.behaviour", "session.needs_reset", "turn.timing", "import.hold", "model.prewarm",
  "agent.ready", "mount.settings", "subagent.start", "subagent.turn", "subagent.model_changed", "github.refresh", "raft.held", "raft.held_answer", "raft.state_failed", "raft.state_save_failed", "raft.mcp_call",
  "raft.assistant_wake", "raft.assistant_notify", "raft.assistant_rules", "raft.assistant_chat_told", "raft.assistant_send_as_owner", "raft.turn_ended"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/**
 * The kinds a plugin may write (`PluginContext.trace`): its own facts, never a kind a seam of the kernel writes, so a
 * plugin cannot add a `tool.call` or a `model.call` the drain would count. The gateway refuses any other kind.
 * `raft.held` is a Raft call held for the model's decision, `raft.held_answer` the model's answer to one, and
 * `raft.state_failed` the Raft SDK's state that did not load or save (src/plugins/raft.ts says what each holds).
 * `raft.mcp_call` is one managed MCP call's end, on the call's span: the connector's server name and the remote tool's
 * name, and how it ended (`result`, `tool_error`, or the SDK's failure kind); never its arguments or its result
 * (src/plugins/raft-mcp.ts). `raft.assistant_wake` is one wake of a personal assistant's proactive check (a doorbell or
 * the morning brief) and what came of it — `skipped_empty`, `skipped_filtered`, `invoked`, `unreadable`, `paused`,
 * `night_deferred` or `failed` — with counts (`unreadable`: conversations no read of which succeeded), never content
 * (src/plugins/raft-assistant.ts). `raft.assistant_notify` is one notify call's end, on the call's span: its state
 * (`sent`, `nothing_to_send`, `kept_for_brief`, `not_sent`) and counts of the items given, sent and dropped by
 * category, never an item, a reference or a rule (src/plugins/raft-assistant.ts `notifyAttrs`). `raft.assistant_rules` is one
 * call of the assistant's preferences tool: its action, effect, subject kind and result (`added`, `exists`, `removed`,
 * `refused:<code>`…) and the rules' counts per effect and subject kind, never a name, an id or a note
 * (src/plugins/raft-assistant-rules.ts `rulesAttrs`). `raft.assistant_chat_told` counts the references an assistant's
 * chat reply to its owner recorded as told (`noteToldInChat`), never which; with status `reply_fallback`, it is a chat turn's
 * closing text sent to the owner's DM because the turn sent nothing there (`replyFallback`): `reply_fallback` 1 when sent,
 * else 0, `result` (`sent`, `held`, `failed`) and a failure's `code`, and `failed_turn` 1 when the turn itself failed
 * and what was sent is the code's fixed line, never the text. `raft.assistant_send_as_owner` is one call of the
 * assistant's send-as-owner tool: its `result` (`sent`, `uncertain`, `failed`, `refused:<code>`), the target's form
 * (`target_kind`), `in_thread`, the message's length (`chars`) and Raft's HTTP `status`, never the message, a name or an
 * id (src/plugins/raft-assistant.ts `sendAsOwner`). `raft.turn_ended` is
 * Raft's answer to one turn's `turnEnded` report: `settled`, `skipped` (with Raft's reason) or `unreadable`, and how many
 * conversations the report named, never which (src/plugins/raft.ts `reportTurnEnd`).
 */
export const PLUGIN_TRACE_KINDS = ["raft.held", "raft.held_answer", "raft.state_failed", "raft.mcp_call", "raft.assistant_wake", "raft.assistant_notify",
  "raft.assistant_rules", "raft.assistant_chat_told", "raft.assistant_send_as_owner", "raft.turn_ended"] as const satisfies readonly TraceKind[];
export type PluginTraceKind = (typeof PLUGIN_TRACE_KINDS)[number];

export const TRACE_VERDICTS = ["ok", "failed", "blocked", "cancelled"] as const;
export type TraceVerdict = (typeof TRACE_VERDICTS)[number];

/** The longest a single field may be; anything longer is cut, like USAGE_KEY_MAX. */
export const TRACE_FIELD_MAX = 200;
/** The longest serialized `attrs` may be; whole keys are dropped to fit. */
export const TRACE_ATTRS_MAX = 4_000;

export interface TraceRow {
  /** ms since the epoch: when the span closed. */
  at: number;
  tenantId: string;
  agentId: string;
  kind: TraceKind;
  /** The durable id the row joins back to: mj_…, op_…, a hookId, a boxId. */
  spanId: string;
  /** The enclosing span's id, on the rare write site that genuinely knows it. */
  parentId?: string;
  /** What the seam said, verbatim. */
  status: string;
  /** The normalized reading of `status`, decided at append. */
  verdict: TraceVerdict;
  /** What the span measured, when the seam knows it. */
  ms?: number;
  /** Small JSON-able facts; whole keys drop to fit TRACE_ATTRS_MAX. */
  attrs: Record<string, unknown>;
}

export interface TraceOutboxRow extends Omit<TraceRow, "attrs"> {
  seq: number;
  attrs: Record<string, unknown>;
}

export function ensureTraceOutbox(sql: Sql) {
  sql.exec(TABLE);
}

const cut = (s: string) => s.slice(0, TRACE_FIELD_MAX);

/**
 * What one row becomes on the wire. Keys drop whole, last-written first, so
 * what survives is predictable and a seam writes the facts it cares about
 * first; a dropped key is announced rather than discovered.
 */
function attrsOf(attrs: Record<string, unknown>): string {
  const body: Record<string, unknown> = { ...attrs };
  let text = JSON.stringify(body);
  const keys = Object.keys(body);
  while (text.length > TRACE_ATTRS_MAX && keys.length) {
    delete body[keys.pop()!];
    body.truncated = true;
    text = JSON.stringify(body);
  }
  return text;
}

export function appendTrace(sql: Sql, rows: readonly TraceRow[]) {
  ensureTraceOutbox(sql);
  for (const row of rows) {
    // A row without its join key or its time is an orphan by definition; so
    // is a row whose vocabulary is not the contract's — the drain dispatches
    // on kind and verdict, and a wrong value would not redden there, it
    // would just take the wrong branch. The seam has a bug and the test at
    // that seam is the place it shows.
    if (!Number.isFinite(row.at) || !row.kind || !row.spanId) continue;
    if (!isKind(row.kind) || !isVerdict(row.verdict)) continue;
    // The same row, as a log line as it is written: the per-agent timeline, readable before the export
    // batches it to R2. Written inside the caller's transaction, so a rolled-back one leaves a line whose
    // row never landed; `spanId` is what checks a line against the export.
    logEvent("trace", {
      tenantId: row.tenantId, agentId: row.agentId, spanId: row.spanId, kind: row.kind, status: row.status, verdict: row.verdict,
      ms: row.ms === undefined ? null : Math.round(row.ms), at: new Date(Math.floor(row.at)).toISOString(),
      mount: typeof row.attrs?.mount === "string" ? row.attrs.mount : undefined,
      tool: typeof row.attrs?.tool === "string" ? row.attrs.tool : undefined,
    });
    sql.exec(
      "INSERT INTO trace_outbox(at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)",
      Math.floor(row.at), row.tenantId, row.agentId, cut(row.kind), cut(row.spanId),
      row.parentId === undefined ? null : cut(row.parentId), cut(row.status), cut(row.verdict),
      row.ms === undefined ? null : Math.round(row.ms), attrsOf(row.attrs ?? {}),
    );
  }
}

export interface PendingTrace {
  rows: TraceOutboxRow[];
  /** Rows read but left out because kind or verdict was not the contract's vocabulary. */
  dropped: number;
  /**
   * The last seq this read examined (`afterSeq` when it examined none), so a
   * drain can move its cursor past rows that were dropped: a batch made only
   * of damaged rows would otherwise be read, dropped and warned about on every
   * pass for ever.
   */
  through: number;
}

const isMember = <T extends string>(table: readonly T[], s: string): s is T =>
  (table as readonly string[]).includes(s);
const isKind = (s: string): s is TraceKind => isMember(TRACE_KINDS, s);
const isVerdict = (s: string): s is TraceVerdict => isMember(TRACE_VERDICTS, s);

/** Rows after `afterSeq`, oldest first, at most `limit`. */
export function pendingTrace(sql: Sql, afterSeq: number, limit = 1000): PendingTrace {
  ensureTraceOutbox(sql);
  let dropped = 0;
  let through = afterSeq;
  const rows = sql.exec(
    "SELECT seq, at, tenant_id, agent_id, kind, span_id, parent_id, status, verdict, ms, attrs " +
    "FROM trace_outbox WHERE seq > ? ORDER BY seq LIMIT ?",
    afterSeq, limit,
  ).toArray().flatMap((r: any) => {
    // No `as` on the way back: the type is the contract, and the contract is
    // checked against the stored string, or a wrong value rides into the
    // drain's dispatch as a "valid" one.
    through = Math.max(through, Number(r.seq));
    const kind = String(r.kind);
    const verdict = String(r.verdict);
    if (!isKind(kind) || !isVerdict(verdict)) { dropped++; return []; }
    const parsed = (() => { try { return JSON.parse(String(r.attrs)); } catch { return undefined; } })();
    return [{
      seq: Number(r.seq),
      at: Number(r.at),
      tenantId: String(r.tenant_id),
      agentId: String(r.agent_id),
      kind,
      spanId: String(r.span_id),
      parentId: r.parent_id === null ? undefined : String(r.parent_id),
      status: String(r.status),
      verdict,
      ms: r.ms === null ? undefined : Number(r.ms),
      // Written only by appendTrace, so a wrong shape means storage damage.
      // One shape catches the class — unparsable or not-an-object — so a
      // damaged row is visible without inventing a second taxonomy for it.
      attrs: (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : { unparseable: true },
    }];
  });
  return { rows, dropped, through };
}

/** Forget rows the drain already took. */
export function pruneTrace(sql: Sql, throughSeq: number) {
  ensureTraceOutbox(sql);
  sql.exec("DELETE FROM trace_outbox WHERE seq <= ?", throughSeq);
}
