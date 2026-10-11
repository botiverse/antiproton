/**
 * What an agent did on the turn after an idle rebuild (src/runtime/rebuild.ts `idleRebuild`), as numbers and flags:
 * whether the rebuild cost it a re-orientation the old context would not have.
 *
 * At the rebuild (`#coldWake`, cf/src/runtime.ts) a watch is kept: the decision's id, the transcript it started, the
 * wake's time, and the keys (`callKey`: tool name and a hash of its arguments) of the calls that succeeded among the
 * replaced conversation's last `PRIOR_ACTIONS`. When that transcript's first run has ended (`#settleBehaviour`), one
 * `rebuild.behaviour` row is written (`summariseBehaviour`, `recordBehaviour`) and the watch dropped:
 *
 *   - `firstSendMs`: from the wake to the first message the agent sent (`isSendTool`), null when it sent none;
 *   - `toolCallsBeforeSend`, `recapCallsBeforeSend`: the calls before that send (all of them when none), and how many
 *     of those re-read what the old context held (`isRecapTool`: memory and state reads, message history reads);
 *   - `firstAction`: `recap`, `send` or `act`, the run's first tool call, or null when it called none;
 *   - `repeatedCalls`, `repeatedBeforeSend`: calls whose key is one that already succeeded before the rebuild.
 *
 * No text of the conversation and no argument is in a row or in the watch: the keys are hashes.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../core/canon-json.ts";
import { logEvent } from "../core/log.ts";
import { appendTrace } from "../trace/outbox.ts";
import type { SqlHost } from "../store/pi-storage.ts";
import { isSendTool, type BriefingEntry } from "./overflow-backstop.ts";

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

/** A tool call's key: its name and a hash of its arguments, canonical so key order does not matter. */
export const callKey = (name: string, args: unknown) =>
  `${name}#${createHash("sha256").update(canonJson(args ?? {})).digest("hex").slice(0, 16)}`;

interface Call { name: string; args: unknown; id: string; at: number; ok: boolean | null; endedAt: number | null }

/** Every tool call in `entries`, in order, with whether it succeeded and when its result came. */
function callsOf(entries: readonly BriefingEntry[]): Call[] {
  const results = new Map<string, { ok: boolean; at: number }>();
  for (const e of entries) {
    const m = e.message;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, { ok: m.isError !== true, at: Number(m.timestamp ?? e.timestamp) });
  }
  const out: Call[] = [];
  for (const e of entries) {
    const m = e.message;
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type !== "toolCall") continue;
      const r = results.get(String(p.id ?? ""));
      out.push({ name: String(p.name ?? ""), args: p.arguments ?? {}, id: String(p.id ?? ""), at: Number(m.timestamp ?? e.timestamp),
        ok: r ? r.ok : null, endedAt: r ? r.at : null });
    }
  }
  return out;
}

/** The keys of the calls that succeeded among the last `n` of a conversation: what a repeat is a repeat of. */
export function priorCallKeys(entries: readonly BriefingEntry[], n = PRIOR_ACTIONS): string[] {
  return callsOf(entries).slice(-n).filter((c) => c.ok === true).map((c) => callKey(c.name, c.args));
}

export interface Behaviour {
  firstSendMs: number | null;
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
  const send = calls.findIndex((c) => isSendTool(c.name));
  const before = send < 0 ? calls : calls.slice(0, send);
  const repeated = (cs: readonly Call[]) => cs.filter((c) => prior.has(callKey(c.name, c.args))).length;
  const first = calls[0];
  // An offloaded call is written as a placeholder (`deferred`, `pending`) while it is out, beside its answer.
  const answers = entries.filter((e) => e.message?.role === "assistant" && !["deferred", "pending"].includes(e.message.stopReason));
  const last = entries.at(-1);
  const sentAt = send < 0 ? null : calls[send]!.endedAt ?? calls[send]!.at;
  return {
    firstSendMs: sentAt === null ? null : Math.max(0, sentAt - o.wakeAt),
    sent: send >= 0,
    toolCalls: calls.length,
    failedToolCalls: calls.filter((c) => c.ok === false).length,
    toolCallsBeforeSend: before.length,
    recapCallsBeforeSend: before.filter((c) => isRecapTool(c.name)).length,
    firstAction: !first ? null : isSendTool(first.name) ? "send" : isRecapTool(first.name) ? "recap" : "act",
    repeatedCalls: repeated(calls),
    repeatedBeforeSend: repeated(before),
    priorActions: prior.size,
    modelCalls: answers.length,
    runMs: last ? Math.max(0, Number(last.message?.timestamp ?? last.timestamp) - o.wakeAt) : null,
    endedWith: typeof last?.message?.stopReason === "string" ? last.message.stopReason : null,
  };
}

// ---- the watch ------------------------------------------------------------------------------------------------------

const WATCH = `CREATE TABLE IF NOT EXISTS rebuild_watch (
  decision TEXT PRIMARY KEY, conversation TEXT NOT NULL, logical TEXT NOT NULL, wake_at INTEGER NOT NULL, prior TEXT NOT NULL)`;

export interface Watch { decision: string; conversation: string; logical: string; wakeAt: number; prior: string[] }

/** Watch the first run of the transcript a rebuild started; one at a time, so a later rebuild's replaces it. */
export function watchRebuild(sql: Sql, w: Watch) {
  sql.exec(WATCH);
  sql.exec("DELETE FROM rebuild_watch");
  sql.exec("INSERT INTO rebuild_watch(decision, conversation, logical, wake_at, prior) VALUES (?,?,?,?,?)",
    w.decision, w.conversation, w.logical, w.wakeAt, JSON.stringify(w.prior));
}

/** The watch, or null; a read never creates the table. */
export function readWatch(sql: Sql): Watch | null {
  if (!sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'rebuild_watch'").toArray().length) return null;
  const r = sql.exec("SELECT decision, conversation, logical, wake_at, prior FROM rebuild_watch LIMIT 1").toArray()[0] as any;
  if (!r) return null;
  let prior: string[] = [];
  try { const p = JSON.parse(String(r.prior)); if (Array.isArray(p)) prior = p.map(String); } catch { /* none */ }
  return { decision: String(r.decision), conversation: String(r.conversation), logical: String(r.logical), wakeAt: Number(r.wake_at), prior };
}

export function dropWatch(sql: Sql) {
  sql.exec("DELETE FROM rebuild_watch");
}

/** The `rebuild.behaviour` row for a watched rebuild's first run, and its log line; the watch is dropped with it. */
export function recordBehaviour(sql: Sql, transact: <T>(fn: () => T) => T, o: {
  tenantId: string; agentId: string; watch: Watch; behaviour: Behaviour; at: number;
}) {
  const attrs = {
    decision: o.watch.decision, trigger: "cold-wake", strategy: "briefing",
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
