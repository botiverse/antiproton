/**
 * What an agent did on the run after a wake, as numbers and flags: for a wake rebuilt after a long idle
 * (src/runtime/rebuild.ts `idleRebuild`), whether the rebuild cost it a re-orientation the old context would not have;
 * for a comparison group of wakes that were not rebuilt, what the same run looks like without one (`BehaviourGroup`).
 *
 * At the wake (`#coldWake`, cf/src/runtime.ts) a watch is kept: the decision's id, the transcript the run is in, where
 * the wake starts in it (`startSeq`), the wake's time, the group, and the keys (`callKey`: tool name and a hash of its
 * arguments) of the calls that succeeded among the conversation's last `PRIOR_ACTIONS` before the wake. When that run
 * has ended (`#settleBehaviour`), one `rebuild.behaviour` row is written (`summariseBehaviour`, `recordBehaviour`) and
 * the watch dropped:
 *
 *   - `firstSendMs`: from the wake to the first message the agent sent (`isSendTool`), null when it sent none;
 *   - `toolCallsBeforeSend`, `recapCallsBeforeSend`: the calls before that send (all of them when none), and how many
 *     of those re-read what the old context held (`isRecapTool`: memory and state reads, message history reads);
 *   - `firstAction`: `recap`, `send` or `act`, the run's first tool call that is not an inbox read, or null;
 *   - `repeatedCalls`, `repeatedBeforeSend`: calls, inbox reads aside, whose key is one that already succeeded before.
 *
 * An inbox read (`isInboxRead`: Raft's `receive_events` and inbox pulls) is how every Raft wake starts, rebuilt or not,
 * and its arguments rarely change: counted apart (`inboxReads`), it says nothing about re-orientation.
 *
 * No text of the conversation and no argument is in a row or in the watch: the keys are hashes.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../core/canon-json.ts";
import { logEvent } from "../core/log.ts";
import { appendTrace } from "../trace/outbox.ts";
import { MAIN_SESSION, piTables, type SqlHost } from "../store/pi-storage.ts";
import { isProgramTool, isSendTool, sendsReported, type BriefingEntry } from "./overflow-backstop.ts";

type Sql = SqlHost["sql"];

/** How many of the replaced conversation's last tool calls a repeat is looked for in: as many as the briefing lists. */
export const PRIOR_ACTIONS = 12;

const toolPart = (name: string) => { const i = name.lastIndexOf("__"); return i < 0 ? name : name.slice(i + 2); };

/**
 * A call that re-reads what a context held rather than acting on what arrived: a memory or state read (the state
 * plugin's `get`, `list`, `secret_list`; an artifact `read`), or a read of message history (Raft's `messages_read`,
 * `messages_search`, `threads_list`, `tasks_history`, and the older `read_messages`, `search_messages`).
 */
const RECAP = /^(?:get|list|read|secret_list|recall|messages_(?:read|search)|read_messages|search_messages|threads_list|\w+_history)$/i;
export const isRecapTool = (name: string) => RECAP.test(toolPart(name));

/** Reading the wake's own messages: Raft's `receive_events`, its inbox pulls, and a personal assistant's owner inbox. */
const INBOX = /^(?:receive_events|inbox_(?:check|drain|list)|assistant_owner_inbox)$/i;
export const isInboxRead = (name: string) => INBOX.test(toolPart(name));

/** A tool call's key: its name and a hash of its arguments, canonical so key order does not matter. */
export const callKey = (name: string, args: unknown) =>
  `${name}#${createHash("sha256").update(canonJson(args ?? {})).digest("hex").slice(0, 16)}`;

interface Call {
  name: string; args: unknown; id: string; at: number; ok: boolean | null; endedAt: number | null;
  /** A message went out: a messaging tool, or a program (`run_js`) whose result reports a send (`sendsReported`). */
  sends: boolean;
}

/** Every tool call in `entries`, in order, with whether it succeeded and when its result came. */
function callsOf(entries: readonly BriefingEntry[]): Call[] {
  const results = new Map<string, { ok: boolean; at: number; text: string }>();
  for (const e of entries) {
    const m = e.message;
    if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    const text = Array.isArray(m.content) ? m.content.map((p: any) => p?.type === "text" && typeof p.text === "string" ? p.text : "").join("") : "";
    results.set(m.toolCallId, { ok: m.isError !== true, at: Number(m.timestamp ?? e.timestamp), text });
  }
  const out: Call[] = [];
  for (const e of entries) {
    const m = e.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type !== "toolCall") continue;
      const r = results.get(String(p.id ?? ""));
      const name = String(p.name ?? "");
      out.push({ name, args: p.arguments ?? {}, id: String(p.id ?? ""), at: Number(m.timestamp ?? e.timestamp),
        ok: r ? r.ok : null, endedAt: r ? r.at : null,
        sends: isSendTool(name) || (isProgramTool(name) && !!r && r.ok && sendsReported(r.text).length > 0) });
    }
  }
  return out;
}

/** The keys of the calls that succeeded among the last `n` of a conversation: what a repeat is a repeat of. */
export function priorCallKeys(entries: readonly BriefingEntry[], n = PRIOR_ACTIONS): string[] {
  return callsOf(entries).filter((c) => !isInboxRead(c.name)).slice(-n).filter((c) => c.ok === true).map((c) => callKey(c.name, c.args));
}

export interface Behaviour {
  firstSendMs: number | null;
  inboxReads: number;
  sent: boolean;
  toolCalls: number;
  failedToolCalls: number;
  toolCallsBeforeSend: number;
  recapCallsBeforeSend: number;
  firstAction: "recap" | "send" | "act" | null;
  repeatedCalls: number;
  repeatedBeforeSend: number;
  priorActions: number;
  modelCalls: number;
  runMs: number | null;
  endedWith: string | null;
}

/** The run's behaviour, from the rebuilt transcript's messages (oldest first), the wake's time and the prior keys. */
export function summariseBehaviour(entries: readonly BriefingEntry[], o: { wakeAt: number; prior: readonly string[] }): Behaviour {
  const calls = callsOf(entries);
  const prior = new Set(o.prior);
  const send = calls.findIndex((c) => c.sends);
  const before = send < 0 ? calls : calls.slice(0, send);
  // An inbox read is never among `prior` (`priorCallKeys`), so it never counts as a repeat.
  const repeated = (cs: readonly Call[]) => cs.filter((c) => prior.has(callKey(c.name, c.args))).length;
  const first = calls.find((c) => !isInboxRead(c.name));
  // An offloaded call is written as a placeholder (`deferred`, `pending`) while it is out, beside its answer.
  const answers = entries.filter((e) => e.message?.role === "assistant" && !["deferred", "pending"].includes(e.message.stopReason));
  const last = entries.at(-1);
  const sentAt = send < 0 ? null : calls[send]!.endedAt ?? calls[send]!.at;
  return {
    firstSendMs: sentAt === null ? null : Math.max(0, sentAt - o.wakeAt),
    inboxReads: calls.filter((c) => isInboxRead(c.name)).length,
    sent: send >= 0,
    toolCalls: calls.length,
    failedToolCalls: calls.filter((c) => c.ok === false).length,
    toolCallsBeforeSend: before.length,
    recapCallsBeforeSend: before.filter((c) => isRecapTool(c.name)).length,
    firstAction: !first ? null : first.sends ? "send" : isRecapTool(first.name) ? "recap" : "act",
    repeatedCalls: repeated(calls),
    repeatedBeforeSend: repeated(before),
    priorActions: prior.size,
    modelCalls: answers.length,
    runMs: last ? Math.max(0, Number(last.message?.timestamp ?? last.timestamp) - o.wakeAt) : null,
    endedWith: typeof last?.message?.stopReason === "string" ? last.message.stopReason : null,
  };
}

// ---- the watch ------------------------------------------------------------------------------------------------------

/**
 * Which wakes a row is written for: `rebuilt` (every idle rebuild), `idle-not-rebuilt` (a gap over the idle time with
 * no rebuild: the context too small, the model's rule off, or the rebuild failed) and `sample` (a share of the other
 * wakes, `BEHAVIOUR_SAMPLE`), so a rebuilt run has runs to be compared with.
 */
export type BehaviourGroup = "rebuilt" | "idle-not-rebuilt" | "sample";
/** The share of ordinary wakes watched for the comparison group. */
export const BEHAVIOUR_SAMPLE = 0.1;

const WATCH = `CREATE TABLE IF NOT EXISTS rebuild_watch (
  decision TEXT PRIMARY KEY, conversation TEXT NOT NULL, logical TEXT NOT NULL, wake_at INTEGER NOT NULL, prior TEXT NOT NULL,
  start_seq INTEGER NOT NULL, grp TEXT NOT NULL, reason TEXT)`;

export interface Watch {
  decision: string; conversation: string; logical: string; wakeAt: number; prior: string[];
  /** The transcript's last entry before the wake: the run is what comes after it (0 for a rebuilt transcript). */
  startSeq: number;
  group: BehaviourGroup;
  /** Why the idle rule did or did not rebuild this wake (`IdleReason`, or the runtime's own). */
  reason: string;
}

/** Watch the run a wake starts; one at a time, so a later wake's replaces it. */
export function watchRun(sql: Sql, w: Watch) {
  sql.exec(WATCH);
  sql.exec("DELETE FROM rebuild_watch");
  sql.exec("INSERT INTO rebuild_watch(decision, conversation, logical, wake_at, prior, start_seq, grp, reason) VALUES (?,?,?,?,?,?,?,?)",
    w.decision, w.conversation, w.logical, w.wakeAt, JSON.stringify(w.prior), w.startSeq, w.group, w.reason);
}

/** The watch, or null; a read never creates the table. */
export function readWatch(sql: Sql): Watch | null {
  if (!sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'rebuild_watch'").toArray().length) return null;
  const r = sql.exec("SELECT decision, conversation, logical, wake_at, prior, start_seq, grp, reason FROM rebuild_watch LIMIT 1").toArray()[0] as any;
  if (!r) return null;
  let prior: string[] = [];
  try { const p = JSON.parse(String(r.prior)); if (Array.isArray(p)) prior = p.map(String); } catch { /* none */ }
  return {
    decision: String(r.decision), conversation: String(r.conversation), logical: String(r.logical), wakeAt: Number(r.wake_at), prior,
    startSeq: Number(r.start_seq), group: String(r.grp) as BehaviourGroup, reason: r.reason === null ? "" : String(r.reason),
  };
}

const hasEntries = (sql: Sql, t: string) => sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray().length > 0;

/** The main transcript's last entry, where a wake's run will start after: 0 when it has none. */
export function mainLastSeq(sql: Sql): number {
  const t = piTables(MAIN_SESSION).entries;
  if (!hasEntries(sql, t)) return 0;
  return Number(sql.exec(`SELECT COALESCE(MAX(seq), 0) AS s FROM ${t}`).toArray()[0]?.s ?? 0);
}

/** The main transcript's messages after `seq`, oldest first, at most `limit`: one run's, the wake first. */
export function mainMessagesAfter(sql: Sql, seq: number, limit = 500): BriefingEntry[] {
  const t = piTables(MAIN_SESSION).entries;
  if (!hasEntries(sql, t)) return [];
  const out: BriefingEntry[] = [];
  for (const r of sql.exec(`SELECT id, timestamp, body FROM ${t} WHERE type = 'message' AND seq > ? ORDER BY seq LIMIT ?`, seq, limit).toArray() as any[]) {
    try { out.push({ id: String(r.id), timestamp: Number(r.timestamp), message: JSON.parse(String(r.body))?.message }); } catch { /* skipped */ }
  }
  return out;
}

export function dropWatch(sql: Sql) {
  sql.exec("DELETE FROM rebuild_watch");
}

/** The `rebuild.behaviour` row for a watched wake's run, and its log line; the watch is dropped with it. */
export function recordBehaviour(sql: Sql, transact: <T>(fn: () => T) => T, o: {
  tenantId: string; agentId: string; watch: Watch; behaviour: Behaviour; at: number;
}) {
  const attrs = {
    decision: o.watch.decision, trigger: "cold-wake", strategy: "briefing", rebuilt: o.watch.group === "rebuilt",
    group: o.watch.group, idleReason: o.watch.reason,
    conversation: o.watch.conversation, logicalConversation: o.watch.logical, ...o.behaviour,
  };
  transact(() => {
    appendTrace(sql, [{
      at: o.at, tenantId: o.tenantId, agentId: o.agentId, kind: "rebuild.behaviour", spanId: `${o.watch.decision}:behaviour`,
      parentId: o.watch.decision, status: o.behaviour.sent ? "sent" : "no-send", verdict: "ok", attrs,
    }]);
    dropWatch(sql);
  });
  logEvent("rebuild.behaviour", { tenantId: o.tenantId, agentId: o.agentId, ...attrs });
}
