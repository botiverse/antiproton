/**
 * The object's half of the daily friction scan (cf/src/friction-scan.ts): one agent's conversations that were live in
 * a time window, as the events the classifier reads (cf/src/friction.ts), read with SELECTs only, the way
 * /admin/transcript reads them (cf/src/transcript-read.ts).
 *
 * What leaves the object is less than the transcript, on purpose:
 * - user messages and compaction summaries are not carried at all. The classifier never reads them, and what is not
 *   sent cannot reach a report.
 * - the model's reasoning is not carried; its text and tool calls are, because inability text and commands are read.
 * - every string is capped (`maxString`), so a 200 KB tool result is its first few KB. The detectors look at the head
 *   of a result (binary magic, U+FFFD density) and at error text, which is short.
 * - at most `maxConversations` conversations and `maxEvents` events each, with `truncated` saying when either cut.
 */
import { sessionFor, readEntries, transcriptEvents, hasTable } from "./transcript-read.ts";
import { mainSessions } from "./fresh-context.ts";
import { MAIN_SESSION, type SqlHost } from "../../src/store/pi-storage.ts";
import type { FrictionEvent } from "./friction.ts";

type Sql = SqlHost["sql"];

export interface FrictionLimits { maxConversations: number; maxEvents: number; maxString: number }
export interface FrictionConversation { id: string; events: FrictionEvent[]; truncated: boolean }
export interface FrictionWindow { conversations: FrictionConversation[]; truncated: boolean }

export const FRICTION_LIMITS: FrictionLimits = { maxConversations: 12, maxEvents: 4000, maxString: 4096 };

const cap = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) : t; };

/** Every string in a value capped at `n`, arrays at 50 items: a tool's result or a call's arguments, shrunk. */
function shrink(v: unknown, n: number, depth = 0): unknown {
  if (typeof v === "string") return cap(v, n);
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "<deep>";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => shrink(x, n, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 50).map(([k, x]) => [k, shrink(x, n, depth + 1)]));
}

/** One transcript event as the classifier needs it, or null for one it never reads. */
function carried(e: { sequence: number; kind: string; payload: any; createdAt: number }, n: number): FrictionEvent | null {
  const p = e.payload ?? {};
  if (e.kind === "model.response") {
    return { sequence: e.sequence, kind: e.kind, createdAt: e.createdAt, payload: {
      text: cap(p.text, n),
      ...(Array.isArray(p.toolCalls) ? { toolCalls: p.toolCalls.slice(0, 50).map((c: any) => ({ id: c?.id, name: c?.name, arguments: shrink(c?.arguments, n) })) } : {}),
      ...(p.finishReason ? { finishReason: p.finishReason } : {}),
    } };
  }
  if (e.kind === "tool.result") {
    return { sequence: e.sequence, kind: e.kind, createdAt: e.createdAt, payload: {
      tool: p.tool, callId: p.callId, isError: !!p.isError, status: p.status, result: shrink(p.result, n),
    } };
  }
  if (e.kind === "model.failed") return { sequence: e.sequence, kind: e.kind, createdAt: e.createdAt, payload: { error: cap(p.error, n) } };
  return null;
}

/** The conversations of this object's agent live in [from, to): main ones first, then subagents, oldest first. */
export function windowConversations(sql: Sql, tenantId: string, agentId: string, from: number, to: number): string[] {
  const mains = mainSessions(sql)
    .filter((m) => (m.startedAt ?? 0) < to && (m.endedAt ?? Infinity) >= from)
    .map((m) => m.sessionId);
  const subs = hasTable(sql, "subagents")
    ? (sql.exec(
      "SELECT id FROM subagents WHERE tenant_id = ? AND agent_id = ? AND created_at < ? AND (finished_at IS NULL OR finished_at >= ?) ORDER BY created_at",
      tenantId, agentId, to, from,
    ).toArray() as any[]).map((r) => String(r.id))
    : [];
  return [...mains, ...subs];
}

/** Null when the object holds no such agent; never creates anything. */
export function readFrictionWindow(
  sql: Sql, tenantId: string, agentId: string, from: number, to: number, limits: FrictionLimits = FRICTION_LIMITS,
): FrictionWindow | null {
  if (sessionFor(sql, tenantId, agentId, `t_${agentId}`) === null) return null;
  const ids = windowConversations(sql, tenantId, agentId, from, to);
  const conversations: FrictionConversation[] = [];
  for (const id of ids.slice(0, limits.maxConversations)) {
    // The current first main conversation is named by the agent's own task id, as the console names it.
    const session = sessionFor(sql, tenantId, agentId, id === MAIN_SESSION ? `t_${agentId}` : id);
    if (session === null) continue;
    const all = transcriptEvents(readEntries(sql, session), sql, session, { tenantId, agentId }, 0).events
      .filter((e) => e.createdAt >= from && e.createdAt < to);
    const events = all.flatMap((e) => { const c = carried(e, limits.maxString); return c ? [c] : []; });
    conversations.push({ id, events: events.slice(0, limits.maxEvents), truncated: events.length > limits.maxEvents });
  }
  return { conversations, truncated: ids.length > limits.maxConversations };
}
