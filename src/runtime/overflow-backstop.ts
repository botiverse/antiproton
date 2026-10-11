/**
 * The context-overflow backstop for pi085's main conversation.
 *
 * pi085 never compacts (src/runtime/pi-agent.ts declines every compaction), and pi's own overflow recovery only reads
 * an answer that arrives at `assistant.effect_pending` (pi-agent-core dist/harness/runtime/drive/response.js
 * `publishResponse`). This provider answers deferred, so a refusal for a context that no longer fits arrives on the
 * poll and is recorded as an ordinary failed turn. Every later wake then sends the same oversized context and fails
 * the same way, for ever.
 *
 * The backstop (`AgentRuntime.step`, cf/src/runtime.ts) reads the answer that ended a main-conversation run. When it
 * is an overflow (`isContextOverflowAnswer`), the conversation is rebuilt instead of retried: a new main transcript
 * (cf/src/fresh-context.ts `startFreshMain`, cause `rebuild`; the old one stays readable under its archived name) whose
 * first message is a briefing assembled here from the old transcript (`buildBriefing`), with the wake that failed
 * last, so the agent answers it first. The new transcript takes a new system-prompt snapshot (src/runtime/prompt-context.ts
 * is keyed by conversation id), so the working set it carries is the current one.
 *
 * Bounded: a rebuilt conversation whose first answer is again an overflow, or `MAX_CONSECUTIVE_OVERFLOWS` overflows
 * with no run between them that ended well, stop the backstop: the session is marked `needs_reset`, pushes to it are
 * settled as failed without a model call, and an operator's fresh context clears it (`clearBackstop`).
 *
 * Recorded in the context-rebuild vocabulary: a `rebuild.decision` trace row with trigger `window` and strategy
 * `briefing` (acted, or declined by the guard), a `rebuild` log line, and `session.needs_reset` when the guard stops.
 */
import { isContextOverflow } from "@earendil-works/pi-ai";
import { logEvent } from "../core/log.ts";
import { appendTrace } from "../trace/outbox.ts";
import { MAIN_SESSION, piTables, type SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

/** What asked for a rebuild. The backstop's is always `window`: the model's window is what the request overflowed. */
export type RebuildTrigger = "window" | "cold-wake" | "operator";
/** How the rebuilt context is made. The backstop's is always `briefing`: assembled from local data, no model call. */
export type RebuildStrategy = "summary" | "briefing";

/** Overflows in a row, with no run between them that ended well, after which the backstop stops. */
export const MAX_CONSECUTIVE_OVERFLOWS = 3;
/** The briefing's size, in estimated tokens (`estimateTokens`). */
export const BRIEFING_BUDGET_TOKENS = 8_000;
/** How many of the most recent tool calls the briefing lists. */
export const BRIEFING_ACTIONS = 12;

/** Characters per token, the estimate pi's own compaction uses (pi-agent-core harness/compaction `estimateTokens`). */
const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

// ---- recognising an overflow ---------------------------------------------------------------------------------------

/**
 * Said by providers this deployment reaches, beyond pi-ai's own list (`isContextOverflow`, pi-ai
 * dist/utils/overflow.js), which already has DeepSeek's and OpenAI-compatible "maximum context length is N tokens",
 * OpenAI's "exceeds the context window", `context_length_exceeded` and "too many tokens".
 */
const MORE_OVERFLOW = [
  /maximum context length/i,
  /exceeds? (?:the )?(?:model'?s )?(?:context window|context length|maximum input length)/i,
  /\b(?:prompt|input|messages?) (?:is |are )?too long\b/i,
];
/** Never an overflow, whatever else the text says (pi-ai keeps the same exclusions). */
const NOT_OVERFLOW = [/rate limit/i, /too many requests/i, /tokens per min/i];

/**
 * Whether a model answer is a refusal because the request did not fit the model's window. Both texts are read: a
 * refused request's provider text travels in `providerError`, because `errorMessage` is fixed text the retry check
 * scans (src/model/openai-compatible.ts `ModelRequestRefused`, cf/src/model-request.ts `callQueuedModel`). Only a
 * failed answer counts; a successful one is never read as an overflow by its usage, since a window figure this
 * deployment assumes could be wrong and would then rebuild a conversation that was working.
 */
export function isContextOverflowAnswer(m: unknown): boolean {
  const a = m as { stopReason?: unknown; errorMessage?: unknown; providerError?: unknown } | null;
  if (a?.stopReason !== "error") return false;
  const texts = [a.providerError, a.errorMessage].filter((t): t is string => typeof t === "string" && t.length > 0);
  return texts.some((t) => !NOT_OVERFLOW.some((p) => p.test(t))
    && (isContextOverflow({ stopReason: "error", errorMessage: t } as never) || MORE_OVERFLOW.some((p) => p.test(t))));
}

// ---- the guard's state ---------------------------------------------------------------------------------------------

const TABLE = `CREATE TABLE IF NOT EXISTS overflow_backstop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive INTEGER NOT NULL DEFAULT 0,
  awaiting TEXT,
  rebuilds INTEGER NOT NULL DEFAULT 0,
  last_rebuild_at INTEGER,
  needs_reset_at INTEGER,
  needs_reset_reason TEXT)`;

const hasTable = (sql: Sql) =>
  sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'overflow_backstop'").toArray().length > 0;

export interface BackstopState {
  /** Overflows since the last run of the main conversation that ended well. */
  consecutive: number;
  /** The conversation the last rebuild started, until its first answer that is not an overflow. */
  awaiting: string | null;
  /** Rebuilds since the operator last started a fresh context. */
  rebuilds: number;
  lastRebuildAt: number | null;
  needsReset: { at: number; reason: string } | null;
}

/** The state, or the empty one; a read never creates the table. */
export function readBackstop(sql: Sql): BackstopState {
  const r = hasTable(sql) ? sql.exec("SELECT * FROM overflow_backstop WHERE id = 1").toArray()[0] as any : null;
  return {
    consecutive: Number(r?.consecutive ?? 0),
    awaiting: r?.awaiting == null ? null : String(r.awaiting),
    rebuilds: Number(r?.rebuilds ?? 0),
    lastRebuildAt: r?.last_rebuild_at == null ? null : Number(r.last_rebuild_at),
    needsReset: r?.needs_reset_at == null ? null : { at: Number(r.needs_reset_at), reason: String(r.needs_reset_reason ?? "") },
  };
}

function write(sql: Sql, s: BackstopState) {
  sql.exec(TABLE);
  sql.exec("INSERT INTO overflow_backstop(id, consecutive, awaiting, rebuilds, last_rebuild_at, needs_reset_at, needs_reset_reason)" +
    " VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET consecutive = excluded.consecutive," +
    " awaiting = excluded.awaiting, rebuilds = excluded.rebuilds, last_rebuild_at = excluded.last_rebuild_at," +
    " needs_reset_at = excluded.needs_reset_at, needs_reset_reason = excluded.needs_reset_reason",
    s.consecutive, s.awaiting, s.rebuilds, s.lastRebuildAt, s.needsReset?.at ?? null, s.needsReset?.reason ?? null);
}

/** The session's mark, or null: what refuses a post (`SessionNeedsReset`) and what /admin/diagnose shows. */
export function needsReset(sql: Sql): { at: number; reason: string } | null {
  return readBackstop(sql).needsReset;
}

/** A run of the main conversation ended well: the overflows before it were not in a row. Writes only when there is something to clear. */
export function noteRunEndedWell(sql: Sql) {
  const s = readBackstop(sql);
  if (s.consecutive === 0 && s.awaiting === null) return;
  write(sql, { ...s, consecutive: 0, awaiting: null });
}

/** An operator's fresh context starts over: the mark, the count and the rebuild tally are cleared. */
export function clearBackstop(sql: Sql) {
  if (hasTable(sql)) sql.exec("DELETE FROM overflow_backstop");
}

export type OverflowVerdict =
  | { act: "skip"; why: "needs-reset" }
  | { act: "rebuild"; consecutive: number }
  | { act: "stop"; consecutive: number; reason: "rebuilt-request-overflowed" | "consecutive-overflows" };

/**
 * What to do about an overflow that just ended a run of `conversation` (the main conversation's id now), with the
 * count moved. Called once per run: only a step that settled the run asks (`AgentRuntime.step`). `answered`: the
 * conversation has a model answer that is not a failure, so a rebuilt one's first request did fit.
 */
export function judgeOverflow(sql: Sql, conversation: string, answered: boolean, now: number): OverflowVerdict {
  const s = readBackstop(sql);
  if (s.needsReset) return { act: "skip", why: "needs-reset" };
  const consecutive = s.consecutive + 1;
  const reason = s.awaiting === conversation && !answered ? "rebuilt-request-overflowed" as const
    : consecutive >= MAX_CONSECUTIVE_OVERFLOWS ? "consecutive-overflows" as const : null;
  if (reason) {
    write(sql, { ...s, consecutive, needsReset: { at: now, reason } });
    return { act: "stop", consecutive, reason };
  }
  write(sql, { ...s, consecutive });
  return { act: "rebuild", consecutive };
}

/** A rebuild started `conversation`: its first answer decides whether the rebuilt request still overflows. */
export function noteRebuilt(sql: Sql, conversation: string, now: number): BackstopState {
  const s = readBackstop(sql);
  const next = { ...s, awaiting: conversation, rebuilds: s.rebuilds + 1, lastRebuildAt: now };
  write(sql, next);
  return next;
}

/** Thrown by a post to a main conversation marked `needs_reset`: nothing is written and no model is called. */
export class SessionNeedsReset extends Error {
  constructor(reason: string) {
    super(`this agent's conversation no longer fits its model's window and was not recovered (${reason}); ` +
      "nothing is posted until an operator starts a fresh context");
    this.name = "SessionNeedsReset";
  }
}

// ---- the briefing --------------------------------------------------------------------------------------------------

/** One transcript entry as the briefing reads it: pi's `message` entry, oldest first. */
export interface BriefingEntry { id: string; timestamp: number; message: any }

export interface Briefing {
  text: string;
  tokens: number;
  budgetTokens: number;
  messages: number;
  actions: number;
  wake: boolean;
}

/** A tool call's name says it sends something somewhere, so its text is one of the agent's own messages. */
const SENDS = /(?:^|_)(?:send|post|reply|comment|message|say|notify)(?:_|$)/i;
/** The longest single message the briefing quotes, in characters; a longer one is cut with a mark. */
const MESSAGE_CHARS = 4_000;
/** The longest tool line. */
const ACTION_CHARS = 240;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((p: any) => p?.type === "text" && typeof p.text === "string" ? p.text : "").join("") : "";
const when = (ms: number) => Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "unknown time";
const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}… (cut at ${n} characters)` : s;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** The text of a send-like tool call: its first string argument that reads as a message. */
function sentText(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  for (const k of ["text", "message", "body", "content"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/**
 * Remove harness notices the message carried at its head (cf/src/runtime.ts `postMessage` puts them there as
 * `<notices>\n\n<text>`), when the exact head was recorded (`recordNoticeHead`). They describe the old conversation's
 * system prompt; the new one's shows what is true now, so repeating them would tell a change twice.
 */
function withoutHead(text: string, heads: readonly string[]): string {
  for (const h of heads) if (h && text.startsWith(`${h}\n\n`)) return text.slice(h.length + 2);
  return text;
}

/**
 * The first message of the rebuilt conversation, from the transcript it replaces, within `budgetTokens`:
 *
 *   - the messages before the wake, newest first and verbatim (each cut at `MESSAGE_CHARS`): what the agent received,
 *     what it wrote, and what it sent through a tool, each labelled with its conversation, time and source;
 *   - the last `maxActions` tool calls, newest first, each ok, failed, or with no result;
 *   - the wake that failed (the last user message), last, so it is what the agent answers.
 *
 * Only labels are added, no account of how the message came to be: an agent told it was rebuilt spends its turn
 * re-orienting. The wake is always included (cut to half the budget if it alone is larger); the tool calls next;
 * the messages fill what is left, and the oldest that does not fit ends the list.
 */
export function buildBriefing(entries: readonly BriefingEntry[], o: {
  conversation: string; budgetTokens?: number; maxActions?: number; noticeHeads?: readonly string[];
}): Briefing {
  const budgetTokens = o.budgetTokens ?? BRIEFING_BUDGET_TOKENS;
  const heads = o.noticeHeads ?? [];
  const msgs = entries.filter((e) => e.message && typeof e.message === "object");
  let wakeAt = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.message.role === "user") { wakeAt = i; break; }
  const wake = wakeAt >= 0 ? withoutHead(textOf(msgs[wakeAt]!.message.content), heads) : "";
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const wakeText = cut(wake, Math.floor(budgetChars / 2));

  // Tool calls, paired with their results by id.
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const e of msgs) {
    const m = e.message;
    if (m.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, { isError: m.isError === true, text: textOf(m.content) });
  }
  const calls: Array<{ at: number; name: string; args: unknown; id: string }> = [];
  for (const e of msgs) {
    const m = e.message;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) if (p?.type === "toolCall") calls.push({ at: Number(m.timestamp ?? e.timestamp), name: String(p.name ?? ""), args: p.arguments, id: String(p.id ?? "") });
  }
  const actionLines = calls.slice(-(o.maxActions ?? BRIEFING_ACTIONS)).reverse().map((c) => {
    const r = results.get(c.id);
    const verdict = !r ? "no result" : r.isError ? `failed: ${oneLine(r.text).slice(0, 120)}` : "ok";
    const args = oneLine(JSON.stringify(c.args ?? {}) ?? "");
    return cut(`- ${when(c.at)} ${c.name} ${args.slice(0, 120)}${args.length > 120 ? "…" : ""} — ${verdict}`, ACTION_CHARS);
  });

  // Every message before the wake, newest first: received, written, or sent through a tool.
  const quoted: string[] = [];
  for (let i = (wakeAt >= 0 ? wakeAt : msgs.length) - 1; i >= 0; i--) {
    const e = msgs[i]!, m = e.message, at = Number(m.timestamp ?? e.timestamp);
    const said: Array<{ label: string; text: string }> = [];
    if (m.role === "user") said.push({ label: "received", text: withoutHead(textOf(m.content), heads) });
    else if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "deferred" && m.stopReason !== "aborted") {
      // Newest first within the message too: its sends come after its text.
      for (const p of [...(Array.isArray(m.content) ? m.content : [])].reverse()) {
        if (p?.type === "toolCall" && SENDS.test(String(p.name ?? ""))) {
          const t = sentText(p.arguments);
          if (t) said.push({ label: `you sent with ${p.name}`, text: t });
        }
      }
      const t = textOf(m.content);
      if (t.trim()) said.push({ label: "you wrote", text: t });
    }
    for (const s of said) if (s.text.trim()) quoted.push(`[${o.conversation} · ${when(at)} · ${s.label}]\n${cut(s.text, MESSAGE_CHARS)}`);
  }

  const parts = (msgsIn: string[]) => [
    ...(msgsIn.length ? [`Messages before this one in this conversation, newest first:\n\n${msgsIn.join("\n\n")}`] : []),
    ...(actionLines.length ? [`Your most recent tool calls, newest first:\n${actionLines.join("\n")}`] : []),
    ...(wakeText ? [wakeText] : []),
  ].join("\n\n---\n\n");
  const kept: string[] = [];
  for (const q of quoted) {
    if (parts([...kept, q]).length > budgetChars) break;
    kept.push(q);
  }
  const text = parts(kept);
  return { text, tokens: estimateTokens(text), budgetTokens, messages: kept.length, actions: actionLines.length, wake: wakeText.length > 0 };
}

// ---- notice heads ------------------------------------------------------------------------------------------------

const HEADS = "CREATE TABLE IF NOT EXISTS notice_heads (seq INTEGER PRIMARY KEY AUTOINCREMENT, head TEXT NOT NULL, at INTEGER NOT NULL)";
/** How many recorded heads are kept: the briefing reads only the latest messages. */
const HEADS_KEPT = 50;

/** The notices a main-conversation message carried at its head, exactly as written, for `buildBriefing` to strip. */
export function recordNoticeHead(sql: Sql, head: string, now: number) {
  sql.exec(HEADS);
  sql.exec("INSERT INTO notice_heads(head, at) VALUES (?, ?)", head, now);
  sql.exec("DELETE FROM notice_heads WHERE seq <= (SELECT MAX(seq) FROM notice_heads) - ?", HEADS_KEPT);
}

export function noticeHeads(sql: Sql): string[] {
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'notice_heads'").toArray().length > 0;
  return has ? (sql.exec("SELECT head FROM notice_heads ORDER BY seq DESC").toArray() as any[]).map((r) => String(r.head)) : [];
}

// ---- recording -----------------------------------------------------------------------------------------------------

export interface RebuildRecord {
  tenantId: string; agentId: string;
  /** The conversation as the agent and its readers know it: the first of the chain this rebuild continues. */
  conversation: string;
  from: string; to: string | null;
  acted: boolean;
  reason: string;
  consecutive: number;
  rebuilds: number;
  tokensBefore: number | null; tokensAfter: number | null;
  briefing: Briefing | null;
  /** The failed answer's model job. */
  jobId: string | null;
  at: number;
}

/**
 * The `rebuild.decision` row (trigger `window`, strategy `briefing`), its `rebuild` log line, and, when the guard
 * stopped, the `session.needs_reset` row and line. Numbers and ids only: no text of the conversation.
 */
export function recordBackstop(sql: Sql, transact: <T>(fn: () => T) => T, r: RebuildRecord): string {
  const id = `rb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const trigger: RebuildTrigger = "window", strategy: RebuildStrategy = "briefing";
  const attrs = {
    trigger, strategy, acted: r.acted, reason: r.reason, conversation: r.conversation, from: r.from, to: r.to,
    tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter, budgetTokens: r.briefing?.budgetTokens ?? BRIEFING_BUDGET_TOKENS,
    briefingTokens: r.briefing?.tokens ?? null, messages: r.briefing?.messages ?? null, actions: r.briefing?.actions ?? null,
    wake: r.briefing?.wake ?? null, consecutive: r.consecutive, rebuilds: r.rebuilds, job: r.jobId,
  };
  transact(() => {
    appendTrace(sql, [{
      at: r.at, tenantId: r.tenantId, agentId: r.agentId, kind: "rebuild.decision", spanId: id,
      ...(r.jobId ? { parentId: r.jobId } : {}), status: r.acted ? "ran" : "declined", verdict: r.acted ? "ok" : "blocked", attrs,
    }]);
    if (!r.acted) {
      appendTrace(sql, [{
        at: r.at, tenantId: r.tenantId, agentId: r.agentId, kind: "session.needs_reset", spanId: id,
        status: "set", verdict: "blocked", attrs: { reason: r.reason, conversation: r.conversation, consecutive: r.consecutive, rebuilds: r.rebuilds },
      }]);
    }
  });
  logEvent("rebuild", { tenantId: r.tenantId, agentId: r.agentId, decision: id, ...attrs });
  if (!r.acted) logEvent("session.needs_reset", { tenantId: r.tenantId, agentId: r.agentId, decision: id, reason: r.reason, conversation: r.conversation, consecutive: r.consecutive });
  return id;
}

// ---- reading the main transcript -----------------------------------------------------------------------------------

/** How many of the main transcript's latest messages a briefing is built from: more than its budget can ever quote. */
const BRIEFING_SCAN = 500;

const parsed = (r: any): BriefingEntry | null => {
  try { const e = JSON.parse(String(r.body)); return { id: String(r.id), timestamp: Number(r.timestamp), message: e?.message }; }
  catch { return null; }
};

/** The main transcript's last message entry: what the run that just settled ended with. */
export function mainTip(sql: Sql): BriefingEntry | null {
  const r = sql.exec(`SELECT id, timestamp, body FROM ${piTables(MAIN_SESSION).entries} WHERE type = 'message' ORDER BY seq DESC LIMIT 1`).toArray()[0];
  return r ? parsed(r) : null;
}

/** The main transcript's latest messages, oldest first. */
export function mainMessages(sql: Sql, limit = BRIEFING_SCAN): BriefingEntry[] {
  return (sql.exec(`SELECT id, timestamp, body FROM ${piTables(MAIN_SESSION).entries} WHERE type = 'message' ORDER BY seq DESC LIMIT ?`, limit)
    .toArray() as any[]).map(parsed).filter((e): e is BriefingEntry => e !== null).reverse();
}

/** A model job's request in estimated tokens, measured the same way for the request that overflowed and the rebuilt one. */
export function requestTokens(sql: Sql, jobId: string): number | null {
  const r = sql.exec("SELECT length(request) AS n FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
  return r ? Math.ceil(Number(r.n) / CHARS_PER_TOKEN) : null;
}

/** Whether any of `entries` is a model answer that is not a failure: what a request that fitted leaves. */
export function hasAnswer(entries: readonly BriefingEntry[]): boolean {
  return entries.some((e) => e.message?.role === "assistant" && ["stop", "toolUse", "length"].includes(e.message.stopReason));
}

/** The main conversation's newest model call still out, if any: its id. */
export function mainCallOut(sql: Sql): string | null {
  const r = sql.exec("SELECT id FROM pi_model_jobs WHERE session = ? AND answer IS NULL ORDER BY created_at DESC LIMIT 1", MAIN_SESSION).toArray()[0] as any;
  return r ? String(r.id) : null;
}
