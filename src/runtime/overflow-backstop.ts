/**
 * The context-overflow backstop for pi085's main conversation.
 *
 * pi085 never compacts (src/runtime/pi-agent.ts declines every compaction), and pi's own overflow recovery only reads
 * an answer that arrives at `assistant.effect_pending` (pi-agent-core dist/harness/runtime/drive/response.js
 * `publishResponse`). This provider answers deferred, so a refusal for a context that no longer fits arrives on the
 * poll and is recorded as an ordinary failed turn. Every later wake then sends the same oversized context and fails
 * the same way, for ever.
 *
 * The backstop (`AgentRuntime.step`, cf/src/runtime.ts) reads the answer that ended a main-conversation run. When the
 * history no longer fits (`overflowKind` is `history`), the conversation is rebuilt instead of retried: a new main
 * transcript (cf/src/fresh-context.ts `startFreshMain`, cause `rebuild`; the old one stays readable under its archived
 * name) whose first message is a briefing assembled here from the old transcript (`buildBriefing`): the history, the
 * recent tool calls, the input the failed run was answering, and what that run had already sent for it. The new
 * transcript takes a new system-prompt snapshot (src/runtime/prompt-context.ts is keyed by conversation id), so the
 * working set it carries is the current one. For the agent and its readers it is the same conversation continuing
 * (`logicalMain`, cf/src/fresh-context.ts).
 *
 * Bounded: a rebuilt conversation whose first request again overflows, or `MAX_CONSECUTIVE_OVERFLOWS` overflows with no
 * run between them that ended well, stop the backstop: the session is marked `needs_reset`, pushes to it are settled
 * as failed without a model call, and the mark is cleared by an operator (/admin/reset-session, or a fresh context),
 * by the model binding changing, or by `NEEDS_RESET_TTL_MS` passing.
 *
 * Recorded in the context-rebuild vocabulary (src/runtime/rebuild.ts): a `rebuild.decision` row with trigger `window`,
 * strategy `briefing`, status `ran` (or `declined` when the guard stops), and `session.needs_reset` rows when the mark
 * is set and cleared.
 */
import { isContextOverflow } from "@earendil-works/pi-ai";
import { logEvent } from "../core/log.ts";
import { appendTrace } from "../trace/outbox.ts";
import { MAIN_SESSION, piTables, type SqlHost } from "../store/pi-storage.ts";
import { fenceFor } from "../plugins/state.ts";
import { keyedOperationId, programCallKey } from "./operation-id.ts";
import { BRIEFING_BUDGET_TOKENS, recordRebuildDecision, type RebuildTrigger } from "./rebuild.ts";

type Sql = SqlHost["sql"];

/** Overflows in a row, with no run between them that ended well, after which the backstop stops. */
export const MAX_CONSECUTIVE_OVERFLOWS = 3;
/** How long a `needs_reset` mark holds before the next wake is tried again: a cause that has gone away does not need an operator. */
export const NEEDS_RESET_TTL_MS = 24 * 60 * 60_000;
/** The briefing's size, in estimated tokens (`estimateTokens`); kept in src/runtime/rebuild.ts, whose idle rule reads it too. */
export { BRIEFING_BUDGET_TOKENS };
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
 * The OpenAI-compatible refusal that splits the request: "maximum context length is N tokens. However, you requested T
 * tokens (M in the messages, C in the completion)" (DeepSeek, vLLM), or "(M in your prompt; C for the completion)"
 * (OpenAI's older text). It fails whenever M + C > N, so M under N does not mean the history fits: only the output
 * budget C says whether a rebuild can help. When C alone leaves no room for the smallest request a rebuild sends
 * (system prompt, tools and a briefing), no rebuild can, and it is the output budget that does not fit.
 */
const SPLIT = /maximum context length is ([\d,]+) tokens[\s\S]*?\(([\d,]+) in (?:the messages|your prompt)[,;] ([\d,]+) (?:in|for) the completion\)/i;

/** Why a request did not fit: the history itself, or only the output budget asked for on top of it. */
export type OverflowKind = "history" | "output-budget";

/**
 * Whether a model answer is a refusal because the request did not fit the model's window, and which part did not.
 * Both texts are read: a refused request's provider text travels in `providerError`, because `errorMessage` is fixed
 * text the retry check scans (src/model/openai-compatible.ts `ModelRequestRefused`, cf/src/model-request.ts
 * `callQueuedModel`). Only a failed answer counts; a successful one is never read as an overflow by its usage, since a
 * window figure this deployment assumes could be wrong and would then rebuild a conversation that was working.
 */
export function overflowKind(m: unknown, o: { fixedTokens?: number; budgetTokens?: number } = {}): OverflowKind | null {
  const a = m as { stopReason?: unknown; errorMessage?: unknown; providerError?: unknown } | null;
  if (a?.stopReason !== "error") return null;
  const texts = [a.providerError, a.errorMessage].filter((t): t is string => typeof t === "string" && t.length > 0);
  const over = texts.filter((t) => !NOT_OVERFLOW.some((p) => p.test(t))
    && (isContextOverflow({ stopReason: "error", errorMessage: t } as never) || MORE_OVERFLOW.some((p) => p.test(t))));
  if (!over.length) return null;
  const n = (s: string) => Number(s.replace(/,/g, ""));
  for (const t of over) {
    const split = SPLIT.exec(t);
    if (split && n(split[3]!) >= n(split[1]!) - (o.fixedTokens ?? 0) - (o.budgetTokens ?? BRIEFING_BUDGET_TOKENS)) return "output-budget";
  }
  return "history";
}

/** The history no longer fits the window: what the backstop rebuilds for. */
export const isContextOverflowAnswer = (m: unknown): boolean => overflowKind(m) === "history";

// ---- the guard's state ---------------------------------------------------------------------------------------------

const TABLE = `CREATE TABLE IF NOT EXISTS overflow_backstop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consecutive INTEGER NOT NULL DEFAULT 0,
  awaiting TEXT,
  rebuilds INTEGER NOT NULL DEFAULT 0,
  last_rebuild_at INTEGER,
  needs_reset_at INTEGER,
  needs_reset_reason TEXT,
  needs_reset_binding TEXT,
  pending TEXT)`;

const hasTable = (sql: Sql) =>
  sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'overflow_backstop'").toArray().length > 0;

export interface NeedsReset { at: number; reason: string; binding: string | null }

export interface BackstopState {
  /** Overflows since the last run of the main conversation that ended well. */
  consecutive: number;
  /** The conversation the last rebuild started, until a run of it ends well. */
  awaiting: string | null;
  /** Rebuilds since the operator last started over. */
  rebuilds: number;
  lastRebuildAt: number | null;
  needsReset: NeedsReset | null;
  /** A briefing written for a rebuilt transcript and not yet posted to it (`takePendingBriefing`). */
  pending: string | null;
}

/** The state, or the empty one; a read never creates the table. */
export function readBackstop(sql: Sql): BackstopState {
  const r = hasTable(sql) ? sql.exec("SELECT * FROM overflow_backstop WHERE id = 1").toArray()[0] as any : null;
  return {
    consecutive: Number(r?.consecutive ?? 0),
    awaiting: r?.awaiting == null ? null : String(r.awaiting),
    rebuilds: Number(r?.rebuilds ?? 0),
    lastRebuildAt: r?.last_rebuild_at == null ? null : Number(r.last_rebuild_at),
    needsReset: r?.needs_reset_at == null ? null : {
      at: Number(r.needs_reset_at), reason: String(r.needs_reset_reason ?? ""),
      binding: r.needs_reset_binding == null ? null : String(r.needs_reset_binding),
    },
    pending: r?.pending == null ? null : String(r.pending),
  };
}

function write(sql: Sql, s: BackstopState) {
  sql.exec(TABLE);
  sql.exec("INSERT INTO overflow_backstop(id, consecutive, awaiting, rebuilds, last_rebuild_at, needs_reset_at, needs_reset_reason," +
    " needs_reset_binding, pending) VALUES (1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET consecutive = excluded.consecutive," +
    " awaiting = excluded.awaiting, rebuilds = excluded.rebuilds, last_rebuild_at = excluded.last_rebuild_at," +
    " needs_reset_at = excluded.needs_reset_at, needs_reset_reason = excluded.needs_reset_reason," +
    " needs_reset_binding = excluded.needs_reset_binding, pending = excluded.pending",
    s.consecutive, s.awaiting, s.rebuilds, s.lastRebuildAt, s.needsReset?.at ?? null, s.needsReset?.reason ?? null,
    s.needsReset?.binding ?? null, s.pending);
}

/** Who and what a mark is judged against: the agent, its model binding as it is now (`bindingKey`), and the time. */
export interface Judge { tenantId: string; agentId: string; binding: string; now: number }

/** The model binding as the backstop compares it: provider, model and window. A mark set under another is stale. */
export const bindingKey = (b: { provider: string; model: string }, contextWindow: number) => `${b.provider}/${b.model}@${contextWindow}`;

/** Why a mark is cleared, as its `session.needs_reset` row says. */
export type ClearReason = "operator" | "fresh-context" | "binding-changed" | "expired";

function clearedRow(sql: Sql, o: { tenantId: string; agentId: string }, why: ClearReason, mark: NeedsReset, now: number) {
  appendTrace(sql, [{
    at: now, tenantId: o.tenantId, agentId: o.agentId, kind: "session.needs_reset", spanId: `nr_${mark.at}`,
    status: "cleared", verdict: "ok", attrs: { why, reason: mark.reason, setAt: mark.at },
  }]);
  logEvent("session.needs_reset.cleared", { tenantId: o.tenantId, agentId: o.agentId, why, reason: mark.reason });
}

/**
 * The session's mark, or null. With `judge`, a mark set under another model binding, or older than
 * `NEEDS_RESET_TTL_MS`, is cleared here (and the count with it) rather than refusing: what overflowed was a request
 * to another window, or a cause that may have gone. The next overflow marks it again, after one rebuild.
 */
export function needsReset(sql: Sql, judge?: Judge): NeedsReset | null {
  const s = readBackstop(sql);
  if (!s.needsReset || !judge) return s.needsReset;
  const why: ClearReason | null = s.needsReset.binding !== null && s.needsReset.binding !== judge.binding ? "binding-changed"
    : judge.now - s.needsReset.at >= NEEDS_RESET_TTL_MS ? "expired" : null;
  if (!why) return s.needsReset;
  write(sql, { ...s, consecutive: 0, awaiting: null, needsReset: null });
  clearedRow(sql, judge, why, s.needsReset, judge.now);
  return null;
}

/** A run of the main conversation ended well: the overflows before it were not in a row. Writes only when there is something to clear. */
export function noteRunEndedWell(sql: Sql) {
  const s = readBackstop(sql);
  if (s.consecutive === 0 && s.awaiting === null) return;
  write(sql, { ...s, consecutive: 0, awaiting: null });
}

/**
 * Start over: the mark, the count, the rebuild tally and any briefing not yet posted are cleared (a fresh context, or
 * an operator's reset). With `who`, a mark that was set says it was cleared.
 */
export function clearBackstop(sql: Sql, who?: { tenantId: string; agentId: string; why: ClearReason; now: number }) {
  if (!hasTable(sql)) return;
  const mark = readBackstop(sql).needsReset;
  sql.exec("DELETE FROM overflow_backstop");
  if (who && mark) clearedRow(sql, who, who.why, mark, who.now);
}

export type OverflowVerdict =
  | { act: "skip"; why: "needs-reset" }
  | { act: "rebuild"; consecutive: number }
  | { act: "stop"; consecutive: number; reason: "rebuilt-request-overflowed" | "consecutive-overflows" };

/**
 * What to do about an overflow that just ended a run of `conversation` (the main conversation's id now), with the
 * count moved. Called once per run: only a step that settled the run asks (`AgentRuntime.step`). `answered`: the
 * conversation has a model answer that is not a failure, so a rebuilt one's first request did fit. `binding` is
 * kept with a mark, so a later binding can tell the mark is not its own.
 */
export function judgeOverflow(sql: Sql, conversation: string, answered: boolean, binding: string, now: number): OverflowVerdict {
  const s = readBackstop(sql);
  if (s.needsReset) return { act: "skip", why: "needs-reset" };
  const consecutive = s.consecutive + 1;
  const reason = s.awaiting === conversation && !answered ? "rebuilt-request-overflowed" as const
    : consecutive >= MAX_CONSECUTIVE_OVERFLOWS ? "consecutive-overflows" as const : null;
  if (reason) {
    write(sql, { ...s, consecutive, needsReset: { at: now, reason, binding } });
    return { act: "stop", consecutive, reason };
  }
  write(sql, { ...s, consecutive });
  return { act: "rebuild", consecutive };
}

/**
 * A rebuild started `conversation`, whose first message is `briefing`: kept as pending until a post takes it
 * (`takePendingBriefing`), so it is the first thing the new transcript holds whoever posts first, and survives a post
 * that fails.
 */
export function noteRebuilt(sql: Sql, conversation: string, briefing: string, now: number): BackstopState {
  sql.exec(BRIEFS);
  sql.exec("INSERT OR REPLACE INTO rebuild_briefings(session_id, text) VALUES (?, ?)", conversation, briefing);
  const s = readBackstop(sql);
  const next = { ...s, awaiting: conversation, rebuilds: s.rebuilds + 1, lastRebuildAt: now, pending: briefing };
  write(sql, next);
  return next;
}

/** The briefing a rebuilt transcript is still owed, taken: the caller writes it, or gives it back (`returnPendingBriefing`). */
export function takePendingBriefing(sql: Sql): string | null {
  const s = readBackstop(sql);
  if (s.pending === null) return null;
  write(sql, { ...s, pending: null });
  return s.pending;
}

export function returnPendingBriefing(sql: Sql, briefing: string) {
  write(sql, { ...readBackstop(sql), pending: briefing });
}

/** Thrown by a post to a main conversation marked `needs_reset`: nothing is written and no model is called. */
export class SessionNeedsReset extends Error {
  constructor(reason: string) {
    super(`this agent's conversation no longer fits its model's window and was not recovered (${reason}); ` +
      "nothing is posted until an operator resets the session (/admin/reset-session)");
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
  /** History messages quoted. */
  messages: number;
  actions: number;
  /** Inputs the failed run was answering, quoted verbatim. */
  inputs: number;
  /** What the failed run had already sent or written for them. */
  done: number;
}

/**
 * A tool whose call is a message the agent sent someone: its own name, after the mount's alias, says so — verb first
 * (`send_message`) or, as the Raft SDK names its operations, noun first (`messages_send`, `messages_reply`). A raw
 * transport (`http__send`, `sandbox__post`) is not one: its arguments are a request, not something a person read.
 */
const SENDS = /^(?:(?:send|post|create)_(?:message|reply|comment|chat_message)s?|(?:message|comment)s?_(?:send|reply|post|create)|actions_prepare|reply(?:_\w+)?|comment(?:_\w+)?|say|notify(?:_\w+)?)$/i;
const toolPart = (name: string) => { const i = name.lastIndexOf("__"); return i < 0 ? name : name.slice(i + 2); };
export const isSendTool = (name: string) => SENDS.test(toolPart(name));
/** The longest single message the briefing quotes, in characters; a longer one is cut with a mark. */
const MESSAGE_CHARS = 4_000;
/** The longest single thing already sent for the input that the briefing quotes, in characters. */
const DONE_CHARS = 1_000;
/** The longest tool line. */
const ACTION_CHARS = 240;

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((p: any) => p?.type === "text" && typeof p.text === "string" ? p.text : "").join("") : "";
const when = (ms: number) => Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "unknown time";
const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}… (cut at ${n} characters)` : s;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/**
 * The text of a send-like tool call: its first string argument that reads as a message. `content` before `message`:
 * Raft's `messages_reply` names the message it answers `message` and its own text `content`.
 */
function sentText(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  for (const k of ["text", "content", "body", "message"]) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  // Raft's `actions_prepare` posts an action card: what it asks the person to confirm.
  const action = (args as Record<string, unknown>).action as Record<string, unknown> | undefined;
  if (action && typeof action === "object") {
    const hint = typeof action.draftHint === "string" ? action.draftHint : "";
    return `(an action card${typeof action.type === "string" ? `: ${action.type}` : ""})${hint ? ` ${hint}` : ""}`;
  }
  return null;
}
/** A quoted text under its label, in a fence the text cannot close (`fenceFor`), so nothing in it reads as a label. */
const quote = (label: string, text: string) => { const t = cut(text, MESSAGE_CHARS), f = fenceFor(t); return `${label}\n${f}\n${t}\n${f}`; };

/**
 * Remove harness notices the message carried at its head (cf/src/runtime.ts `postMessage` puts them there as
 * `<notices>\n\n<text>`), when the exact head was recorded (`recordNoticeHead`). They describe the old conversation's
 * system prompt; the new one's shows what is true now, so repeating them would tell a change twice.
 */
function withoutHead(text: string, heads: readonly string[]): string {
  for (const h of heads) if (h && text.startsWith(`${h}\n\n`)) return text.slice(h.length + 2);
  return text;
}

// ---- Raft, read for the briefing --------------------------------------------------------------------------------------

/**
 * The text a Raft push wakes the agent with (src/plugins/raft.ts `receiveNotice`, inside src/runtime/inbound.ts
 * `inboundMessage`): an instruction to read the inbox and Raft's own notice, never the messages. In the history it says
 * nothing the messages read after it do not, so it is left out there.
 */
const RAFT_NOTICE = /^\[incoming event from the `[^`\n]+` mount\.[^\n]*\]\nRead your Raft inbox with the `receive_events` tool/;
export const isRaftNotice = (text: string) => RAFT_NOTICE.test(text);

/** A Raft message as its read tools show it: one line `[target=… msg=… time=… type=…] @sender: content` (the SDK's). */
export interface RaftLine { target: string; msg: string | null; type: string | null; text: string }
const RAFT_HEAD = /^\[target=([^\s\]]+)([^\]\n]*)\]/;

function raftLineOf(s: string): RaftLine | null {
  const h = RAFT_HEAD.exec(s);
  if (!h) return null;
  const field = (k: string) => new RegExp(`(?:^|\\s)${k}=([^\\s\\]]+)`).exec(h[2]!)?.[1] ?? null;
  return { target: h[1]!, msg: field("msg"), type: field("type"), text: s };
}

/**
 * The Raft message lines in a tool result's text (`receive_events`, `messages_read`, an inbox pull, a search): every
 * string in its JSON that is one, or that holds several on lines of their own; a text that is not JSON is read the
 * same way. In the order the result gives them.
 */
export function raftLines(text: string): RaftLine[] {
  const out: RaftLine[] = [];
  const take = (s: string) => { for (const part of s.split(/\n(?=\[target=)/)) { const l = raftLineOf(part); if (l) out.push(l); } };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    // A program's outputs (`run_js`) are strings that are themselves JSON: read inside them too.
    if (typeof v === "string" && /^\s*[[{]/.test(v)) {
      let inner: unknown;
      try { inner = JSON.parse(v); } catch { inner = undefined; }
      if (inner !== undefined) { walk(inner, depth + 1); return; }
    }
    if (typeof v === "string") take(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed === undefined) take(text); else walk(parsed, 0);
  return out;
}

/** Where a send went, as its arguments name it: a target (`messages_send`), or the message it answers (`messages_reply`). */
function sendPlace(args: unknown): { target: string | null; replyTo: string | null } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (...ks: string[]) => { for (const k of ks) if (typeof a[k] === "string" && (a[k] as string).trim()) return a[k] as string; return null; };
  return { target: str("target", "channel", "thread", "to"), replyTo: str("replyTo", "messageId", "message_id") ?? (typeof a.content === "string" ? str("message") : null) };
}

/**
 * What Raft says a send did, in its result's text: `Message sent to <target>. Message ID: <id>` (`messages_send`,
 * `messages_reply`) or `Action card posted to <target> as message <id>` (`actions_prepare`).
 */
const SENT_SAYS = /(?:Message sent to|posted to) (\S+?)\.? (?:Message ID: |as message )([0-9A-Za-z-]{6,64})/g;

/**
 * A program: its result holds what the tools it called answered, so a send it made is known only by what that answer
 * says (`sendsReported`). No other tool's result is read for sends: what a read tool returns is other people's text,
 * which can say anything, "Message sent to …" included.
 */
export const isProgramTool = (name: string) => toolPart(name) === "run_js";

/** The states Raft's own result has for a send that went out: a message (`messages_send`, `messages_reply`) or an action card (`actions_prepare`). */
const SENT_STATES = new Set(["sent", "prepared"]);

/**
 * The sends a program's result reports (`SENT_SAYS`), in any string at any depth, its JSON-in-string outputs included,
 * at most `made` of them: the sends the program is recorded to have made (`programSendCounter`). The words alone prove
 * nothing, since a stored note (`state__get`), a page of history or a fetched page can quote them; a program that made
 * no send reports none, whatever its output says. A program's own output names its send in whatever shape it chose
 * (`sent: s.result.text`, a bare string, is what a real one returned), so the shape is not required, only ranked: the
 * text of an object shaped like Raft's send result (`{ state: "sent" | "prepared", text }`) first, then the shallowest,
 * then in order. A Raft message line inside it (a read the program made) is someone's text, not a report, and is never
 * scanned.
 */
export function sendsReported(resultText: string, made: number): Array<{ target: string; id: string }> {
  if (!(made > 0)) return [];
  const found: Array<{ target: string; id: string; rank: number; order: number }> = [];
  const scan = (t: string, rank: number) => {
    if (RAFT_HEAD.test(t)) return;
    for (const m of t.matchAll(SENT_SAYS)) found.push({ target: m[1]!, id: m[2]!, rank, order: found.length });
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof v === "string") {
      if (/^\s*[[{]/.test(v)) { try { walk(JSON.parse(v), depth + 1); return; } catch { /* text */ } }
      scan(v, depth + 1);
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") {
      const o = v as { state?: unknown; text?: unknown };
      if (typeof o.state === "string" && SENT_STATES.has(o.state) && typeof o.text === "string") { scan(o.text, 0); return; }
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(resultText, 0);
  found.sort((x, y) => x.rank - y.rank || x.order - y.order);
  return found.slice(0, made).sort((x, y) => x.order - y.order).map(({ target, id }) => ({ target, id }));
}

/** How many sends a program made, given its `run_js` call's id; the transcript does not say (`programSendCounter`). */
export type ProgramSends = (toolCallId: string) => number;

/** How many host calls of one program are looked for: three statements of `IDS_PER_QUERY`. A program past it is undercounted. */
export const PROGRAM_CALLS_LOOKED_AT = 270;
const IDS_PER_QUERY = 90;

/**
 * The sends each program of a conversation made, from the operations its calls started: the transcript keeps only a
 * program's output, never its calls. A program's `n`th host call is keyed `programCallKey(toolCallId, n)`, so its
 * operation id is recomputed (`keyedOperationId`, src/runtime/operation-id.ts) and looked up; a call refused before
 * an operation existed (an unknown tool) leaves a gap, so a fixed range is read rather than stopping at the first
 * miss. A send is an operation of a messaging tool (`isSendTool`) that succeeded. `taskId`: the main conversation's
 * calls are made under task `main` (cf/src/runtime.ts `LEGACY_TASK`), the same in every transcript it has had.
 */
export function programSendCounter(sql: Sql, tenantId: string, taskId: string = MAIN_SESSION): ProgramSends {
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'operations'").toArray().length > 0;
  return (toolCallId) => {
    if (!has) return 0;
    let sends = 0;
    for (let from = 0; from < PROGRAM_CALLS_LOOKED_AT; from += IDS_PER_QUERY) {
      const ids = Array.from({ length: IDS_PER_QUERY }, (_, k) => keyedOperationId(tenantId, taskId, programCallKey(toolCallId, from + k)));
      const rows = sql.exec(`SELECT mount_alias, tool FROM operations WHERE tenant_id = ? AND status = 'succeeded' AND operation_id IN (${ids.map(() => "?").join(", ")})`,
        tenantId, ...ids).toArray() as Array<{ mount_alias: unknown; tool: unknown }>;
      sends += rows.filter((r) => isSendTool(`${String(r.mount_alias)}__${String(r.tool)}`)).length;
    }
    return sends;
  };
}

/** The id of the message a send made, when its result names one: Raft's words (`sendsReported`), or a JSON field. */
function sentId(resultText: string): string | null {
  // A messaging tool's own result: its one send is the one it reports.
  const said = sendsReported(resultText, 1)[0];
  if (said) return said.id;
  let v: unknown;
  try { v = JSON.parse(resultText); } catch { return null; }
  for (const o of [v, (v as any)?.data, (v as any)?.message]) {
    if (!o || typeof o !== "object") continue;
    for (const k of ["msg", "messageId", "id"]) { const x = (o as any)[k]; if (typeof x === "string" && /^[\w.:-]{3,64}$/.test(x)) return x; }
  }
  return null;
}

/** Two Raft message ids for one message: a short id (`msg=c986f2d4`) is the head of the full one. */
const sameMsg = (a: string, b: string) => a === b || (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a)));

/** A value from outside put in a label: only the characters a target or an id is made of, so it cannot end the label. */
const tag = (s: string) => s.replace(/[^\w#:@.\/-]/g, "_").slice(0, 80);

const endedWell = (m: any) => m?.role === "assistant" && (m.stopReason === "stop" || m.stopReason === "length");
const answeredOk = (m: any) => m?.role === "assistant" && ["stop", "toolUse", "length"].includes(m.stopReason);

/**
 * The first message of the rebuilt conversation, from the transcript it replaces, within `budgetTokens`. The input
 * the failed run was answering is every user message since the last answer that ended a run (one push, or a push and
 * the steers that joined it). In order:
 *
 *   - the messages before that input, newest first, each cut at `MESSAGE_CHARS`: what the agent received, what it
 *     wrote, and what it sent through a messaging tool (`isSendTool`), each labelled outside a fence with its
 *     conversation, time and source. On Raft what was received is the messages its read tools showed (`raftLines`),
 *     each with its target and id and whether the agent answered there after it, not the push notice that woke it
 *     (`isRaftNotice`, left out); a send says where it went (`target`, or the message it replied to) and the id Raft
 *     gave it (`sendsReported`), a send a `run_js` program made included (as many as it is recorded to have made);
 *   - the last `maxActions` tool calls, newest first, each ok, failed, or with no result;
 *   - the input itself, verbatim, last but for:
 *   - what the failed run had already sent or written for that input, so it is not sent twice.
 *
 * Every tool call's arguments and result pass through `redact` as structured values, before anything is flattened or
 * cut, so a key named like a credential or a kept-secret tool's arguments are masked whole (cf/src/eval-read.ts
 * `redactCredentials`). Only labels are added, no account of how the message came to be: an agent told it was rebuilt
 * spends its turn re-orienting. The input and what was done for it are always included (cut to half the budget if
 * larger); the tool calls next; the history fills what is left, and the oldest that does not fit ends the list.
 */
export function buildBriefing(entries: readonly BriefingEntry[], o: {
  conversation: string; redact: (v: unknown) => unknown; budgetTokens?: number; maxActions?: number; noticeHeads?: readonly string[];
  /** The sends each program made (`programSendCounter`): a program's output is believed for no more than these. */
  programSends: ProgramSends;
}): Briefing {
  const budgetTokens = o.budgetTokens ?? BRIEFING_BUDGET_TOKENS;
  const heads = o.noticeHeads ?? [];
  const msgs = entries.filter((e) => e.message && typeof e.message === "object");
  const redactText = (s: string): string => { const r = o.redact(s); return typeof r === "string" ? r : ""; };

  // Where the input of the failed run begins: the first user message after the last answer that ended a run.
  let lastEnd = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (endedWell(msgs[i]!.message)) { lastEnd = i; break; }
  let from = msgs.findIndex((e, i) => i > lastEnd && e.message.role === "user");
  if (from < 0) from = msgs.length;

  // Tool calls, paired with their results by id, every argument and result redacted as a structure first.
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const e of msgs) {
    const m = e.message;
    if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    const safe = o.redact({ toolName: m.toolName, toolCallId: m.toolCallId, text: textOf(m.content) }) as { text?: unknown } | null;
    results.set(m.toolCallId, { isError: m.isError === true, text: typeof safe?.text === "string" ? safe.text : "" });
  }
  type Call = { at: number; name: string; args: unknown; id: string; index: number };
  const calls: Call[] = [];
  msgs.forEach((e, index) => {
    const m = e.message;
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const p of m.content) {
      if (p?.type !== "toolCall") continue;
      const safe = o.redact({ name: String(p.name ?? ""), id: String(p.id ?? ""), arguments: p.arguments ?? {} }) as { arguments?: unknown } | null;
      calls.push({ at: Number(m.timestamp ?? e.timestamp), name: String(p.name ?? ""), args: safe?.arguments ?? null, id: String(p.id ?? ""), index });
    }
  });
  const actionLines = calls.slice(-(o.maxActions ?? BRIEFING_ACTIONS)).reverse().map((c) => {
    const r = results.get(c.id);
    const verdict = !r ? "no result" : r.isError ? `failed: ${oneLine(r.text).slice(0, 120)}` : "ok";
    const args = oneLine(JSON.stringify(c.args ?? {}) ?? "");
    return cut(`- ${when(c.at)} ${c.name} ${args.slice(0, 120)}${args.length > 120 ? "…" : ""} — ${verdict}`, ACTION_CHARS);
  });

  // Raft: the messages the agent read (from its read tools' results, already redacted), where each was, and where
  // each of its own sends went, so a message answered since can be told from one that was not.
  const read = new Map<number, RaftLine[]>();
  const placeOf = new Map<string, string>();
  for (const c of calls) {
    const r = results.get(c.id);
    if (!r || r.isError || isSendTool(c.name)) continue;
    const at = msgs.findIndex((e, k) => k > c.index && e.message.role === "toolResult" && e.message.toolCallId === c.id);
    const lines = raftLines(r.text);
    if (at < 0 || !lines.length) continue;
    read.set(at, lines);
    for (const l of lines) if (l.msg) placeOf.set(l.msg, l.target);
  }
  // A send is a messaging tool's call, or one a program made (`run_js`), known by what its result reports.
  const nested = new Map<string, Array<{ target: string; id: string }>>();
  for (const c of calls) {
    if (!isProgramTool(c.name)) continue;
    const r = results.get(c.id);
    const said = r && !r.isError ? sendsReported(r.text, o.programSends(c.id)) : [];
    if (said.length) nested.set(c.id, said);
  }
  const sends = [
    ...calls.filter((c) => isSendTool(c.name)).map((c) => ({ index: c.index, ...sendPlace(c.args) })),
    ...calls.flatMap((c) => (nested.get(c.id) ?? []).map((n) => ({ index: c.index, target: n.target as string | null, replyTo: null as string | null }))),
  ];
  // A reply names the message it answers, and answers that one alone; any other send answers its whole target.
  const answered = (l: RaftLine, i: number) => sends.some((s) => s.index > i
    && (s.replyTo !== null ? l.msg !== null && sameMsg(s.replyTo, l.msg) : s.target !== null && s.target === l.target));

  type Said = { label: string; text: string; msg?: string; kind: "received" | "wrote" | "sent" };
  /**
   * What one message said, as labelled quotes: received (a message, or the Raft messages a read tool showed, each with
   * where it was and whether the agent answered there after it), written, or sent through a messaging tool (with where
   * it went, and the id it was given). A Raft push's own notice is left out of the history (`isRaftNotice`).
   */
  const said = (i: number, history: boolean): Said[] => {
    const e = msgs[i]!, m = e.message, at = when(Number(m.timestamp ?? e.timestamp));
    if (m.role === "user") {
      const t = withoutHead(textOf(m.content), heads);
      return history && isRaftNotice(t) ? [] : [{ label: `[${o.conversation} · ${at} · received]`, text: t, kind: "received" }];
    }
    if (m.role === "toolResult") {
      return (read.get(i) ?? []).map((l) => ({
        label: `[${o.conversation} · ${at} · received in ${tag(l.target)}${l.msg ? ` msg=${tag(l.msg)}` : ""}, read with ${tag(String(m.toolName ?? ""))} · `
          + `${answered(l, i) ? "you answered there after it" : "not answered by you since"}]`,
        text: l.text, kind: "received" as const, ...(l.msg ? { msg: l.msg } : {}),
      }));
    }
    if (!answeredOk(m)) return [];
    const out: Said[] = [];
    const t = textOf(m.content);
    if (t.trim()) out.push({ label: `[${o.conversation} · ${at} · you wrote]`, text: t, kind: "wrote" });
    for (const c of calls.filter((c) => c.index === i && isSendTool(c.name))) {
      const sent = sentText(c.args);
      if (!sent) continue;
      const { target, replyTo } = sendPlace(c.args);
      const id = sentId(results.get(c.id)?.text ?? "");
      const place = replyTo === null ? undefined : placeOf.get(replyTo) ?? [...placeOf].find(([m]) => sameMsg(m, replyTo))?.[1];
      const where = replyTo !== null ? ` replied to msg=${tag(replyTo)}${place !== undefined ? ` in ${tag(place)}` : ""}`
        : target !== null ? ` sent to ${tag(target)}` : " sent";
      out.push({ label: `[${o.conversation} · ${at} · you${where}${id ? ` as msg=${tag(id)}` : ""} with ${c.name}]`, text: sent, kind: "sent" });
    }
    for (const c of calls.filter((c) => c.index === i && nested.has(c.id))) {
      for (const n of nested.get(c.id)!) {
        out.push({ label: `[${o.conversation} · ${at} · you sent to ${tag(n.target)} as msg=${tag(n.id)} from a ${tag(c.name)} program]`,
          text: "(its text was put together inside the program)", kind: "sent" });
      }
    }
    return out;
  };

  // The history, newest first (and newest first within a message); a Raft message read twice is quoted once, newest.
  const quoted: string[] = [];
  const seen = new Set<string>();
  for (let i = from - 1; i >= 0; i--) {
    for (const q of said(i, true).reverse()) {
      if (!q.text.trim() || (q.msg !== undefined && seen.has(q.msg))) continue;
      if (q.msg !== undefined) seen.add(q.msg);
      quoted.push(quote(q.label, redactText(q.text)));
    }
  }
  // The input, oldest first and verbatim, with the Raft messages the failed run read for it; then what that run had
  // already sent or written, in order.
  const inputs: string[] = [];
  const done: Array<{ label: string; text: string }> = [];
  for (let i = from; i < msgs.length; i++) {
    for (const q of said(i, false)) {
      if (!q.text.trim()) continue;
      if (msgs[i]!.message.role === "user") inputs.push(redactText(q.text));
      else if (q.kind === "received") inputs.push(quote(q.label, redactText(q.text)));
      else done.push({ label: q.label, text: redactText(q.text) });
    }
  }

  // The input and what was done for it take up to half the budget. What was already sent goes first, since leaving
  // it out is what would have the agent send it again: up to half of that half, newest first, each cut at
  // `DONE_CHARS`, and the oldest that do not fit counted. Then the inputs, newest first, the oldest that do not fit
  // counted; the newest is always there, whole unless it alone is longer than what is left.
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const doneQuotes: string[] = [];
  let doneRoom = Math.floor(budgetChars / 4) - 120;
  for (let i = done.length - 1; i >= 0; i--) {
    const q = quote(done[i]!.label, cut(done[i]!.text, DONE_CHARS));
    if (q.length + 2 > doneRoom) break;
    doneQuotes.unshift(q);
    doneRoom -= q.length + 2;
  }
  const doneOmitted = done.length - doneQuotes.length;
  const doneBlock = done.length ? `Already sent or written for the message${inputs.length > 1 ? "s" : ""} above, in order:\n\n` +
    [...(doneOmitted ? [`(${doneOmitted} earlier send${doneOmitted > 1 ? "s" : ""} omitted)`] : []), ...doneQuotes].join("\n\n") : "";
  let room = Math.floor(budgetChars / 2) - doneBlock.length - (doneBlock ? 7 : 0) - 60;
  const keptInputs: string[] = [];
  for (let i = inputs.length - 1; i >= 0; i--) {
    const t = inputs[i]!;
    if (!keptInputs.length) { const c = cut(t, Math.max(200, room - 40)); keptInputs.unshift(c); room -= c.length + 2; continue; }
    if (t.length + 2 > room) break;
    keptInputs.unshift(t);
    room -= t.length + 2;
  }
  const omitted = inputs.length - keptInputs.length;
  const tail = [
    [...(omitted ? [`(${omitted} earlier message${omitted > 1 ? "s" : ""} omitted)`] : []), ...keptInputs].join("\n\n"),
    doneBlock,
  ].filter(Boolean).join("\n\n---\n\n");
  const parts = (history: string[]) => [
    ...(history.length ? [`Messages before ${inputs.length > 1 ? "the ones" : "the one"} below in this conversation, newest first:\n\n${history.join("\n\n")}`] : []),
    ...(actionLines.length ? [`Your most recent tool calls, newest first:\n${actionLines.join("\n")}`] : []),
    ...(tail ? [tail] : []),
  ].join("\n\n---\n\n");
  const kept: string[] = [];
  for (const q of quoted) {
    if (parts([...kept, q]).length > budgetChars) break;
    kept.push(q);
  }
  const text = parts(kept);
  return {
    text, tokens: estimateTokens(text), budgetTokens, messages: kept.length, actions: actionLines.length,
    inputs: inputs.length, done: done.length,
  };
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

export interface BackstopRecord {
  tenantId: string; agentId: string;
  /** `window` for the backstop's own rebuild, `operator` for /admin/reset-session's. */
  trigger: Extract<RebuildTrigger, "window" | "operator">;
  /** The transcript the overflow ended (as #847's rows name a conversation: the physical id), and the one it started. */
  from: string; to: string | null;
  /** The conversation as the agent and its readers know it (`logicalMain`): the first of the chain this continues. */
  logicalConversation: string;
  acted: boolean;
  reason: string;
  consecutive: number;
  rebuilds: number;
  /** The last answered call's input (src/runtime/rebuild.ts `readWakeFacts`), as #847's overflow row had it. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** The request that overflowed and the rebuilt one, in estimated tokens (`requestTokens`). */
  tokensBefore: number | null; tokensAfter: number | null;
  briefing: Briefing | null;
  /** The failed answer's model job. */
  jobId: string | null;
  /** The rebuilt transcript's first answer settles a `rebuild.outcome` (only where shadow outcomes are read). */
  awaitOutcome: boolean;
  at: number;
}

/**
 * One `rebuild.decision` per overflow, in #847's shape (`recordRebuildDecision`): trigger `window`, strategy
 * `briefing`, reason `overflow`, status `ran` or `declined`, `shadow: false` because it was acted on (or refused by
 * the guard). When the guard stops, the `session.needs_reset` row too. Numbers and ids only.
 */
export function recordBackstop(sql: Sql, transact: <T>(fn: () => T) => T, r: BackstopRecord): string {
  const id = recordRebuildDecision(sql, transact, {
    tenantId: r.tenantId, agentId: r.agentId, key: piTables(MAIN_SESSION).entries,
    trigger: r.trigger, strategy: "briefing", wouldRebuild: true, predictedCold: true, expectedCold: true,
    status: r.acted ? "ran" : "declined", reason: r.trigger === "window" ? "overflow" : "operator", rule: null, coldHitRate: 0.5,
    awaitOutcome: r.acted && r.awaitOutcome, shadow: false,
    facts: {
      acted: r.acted, ...(r.acted ? {} : { stopped: r.reason }),
      conversation: r.from, to: r.to, logicalConversation: r.logicalConversation,
      contextTokens: r.contextTokens, contextWindow: r.contextWindow, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter,
      budgetTokens: r.briefing?.budgetTokens ?? BRIEFING_BUDGET_TOKENS, briefingTokens: r.briefing?.tokens ?? null,
      messages: r.briefing?.messages ?? null, actions: r.briefing?.actions ?? null, inputs: r.briefing?.inputs ?? null,
      done: r.briefing?.done ?? null, consecutive: r.consecutive, rebuilds: r.rebuilds, job: r.jobId,
    },
    at: r.at,
  });
  if (!r.acted) {
    transact(() => appendTrace(sql, [{
      at: r.at, tenantId: r.tenantId, agentId: r.agentId, kind: "session.needs_reset", spanId: `nr_${r.at}`, parentId: id,
      status: "set", verdict: "blocked",
      attrs: { reason: r.reason, conversation: r.from, logicalConversation: r.logicalConversation, consecutive: r.consecutive, rebuilds: r.rebuilds },
    }]));
    logEvent("session.needs_reset", { tenantId: r.tenantId, agentId: r.agentId, decision: id, reason: r.reason, conversation: r.from, consecutive: r.consecutive });
  }
  return id;
}

// ---- reading the main transcript -----------------------------------------------------------------------------------

/** Each rebuilt transcript's briefing, by its conversation id: what its first message carries (`spliceBriefing`). */
const BRIEFS = "CREATE TABLE IF NOT EXISTS rebuild_briefings (session_id TEXT PRIMARY KEY, text TEXT NOT NULL)";

export function briefingOf(sql: Sql, sessionId: string): string | null {
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'rebuild_briefings'").toArray().length > 0;
  const r = has ? sql.exec("SELECT text FROM rebuild_briefings WHERE session_id = ?", sessionId).toArray()[0] as any : null;
  return r ? String(r.text) : null;
}

/**
 * A rebuilt transcript's messages read as the conversation they continue: its first user message, which carries the
 * briefing (with a post's own text after it, when one carried it), is replaced by the transcript it was built from,
 * then what that post added. A rebuild of a rebuilt transcript then briefs from the conversation's own history, not
 * from a briefing quoted inside another. Null when the first user message does not carry `briefing`.
 */
export function spliceBriefing(entries: readonly BriefingEntry[], briefing: string, prior: readonly BriefingEntry[]): BriefingEntry[] | null {
  const i = entries.findIndex((e) => e.message?.role === "user");
  if (i < 0) return null;
  const text = textOf(entries[i]!.message.content);
  const at = text.indexOf(briefing);
  if (at < 0) return null;
  const rest = text.slice(at + briefing.length).replace(/^\n\n---\n\n/, "");
  const e = entries[i]!;
  return [
    ...prior, ...entries.slice(0, i),
    ...(rest.trim() ? [{ ...e, message: { ...e.message, content: [{ type: "text", text: rest }] } }] : []),
    ...entries.slice(i + 1),
  ];
}

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

/** A transcript's latest messages, oldest first: the main one's, or an archived one's by its session (`physicalSession`). */
export function mainMessages(sql: Sql, limit = BRIEFING_SCAN, session: string = MAIN_SESSION): BriefingEntry[] {
  const t = piTables(session).entries;
  if (!sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray().length) return [];
  return (sql.exec(`SELECT id, timestamp, body FROM ${t} WHERE type = 'message' ORDER BY seq DESC LIMIT ?`, limit)
    .toArray() as any[]).map(parsed).filter((e): e is BriefingEntry => e !== null).reverse();
}

/**
 * The main conversation's messages across the transcripts the backstop chained (`transcripts`, oldest first, the
 * current one last, with each one's archived session), each rebuilt transcript's briefing spliced back into the
 * history it was built from (`spliceBriefing`); the latest `limit`.
 */
export function conversationMessages(sql: Sql, transcripts: ReadonlyArray<{ id: string; session: string | null }>, limit = BRIEFING_SCAN): BriefingEntry[] {
  let entries = mainMessages(sql, limit);
  for (let i = transcripts.length - 1; i > 0 && entries.length < limit * 4; i--) {
    const briefing = briefingOf(sql, transcripts[i]!.id);
    const prior = transcripts[i - 1]!.session;
    if (briefing === null || prior === null) break;
    const spliced = spliceBriefing(entries, briefing, mainMessages(sql, limit, prior));
    if (!spliced) break;
    entries = spliced;
  }
  return entries.slice(-limit);
}

/** Whether any of `entries` is a model answer that is not a failure: what a request that fitted leaves. */
export function hasAnswer(entries: readonly BriefingEntry[]): boolean {
  return entries.some((e) => answeredOk(e.message));
}

/** A model job's request in estimated tokens, measured the same way for the request that overflowed and the rebuilt one. */
export function requestTokens(sql: Sql, jobId: string): number | null {
  const r = sql.exec("SELECT length(request) AS n FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
  return r ? Math.ceil(Number(r.n) / CHARS_PER_TOKEN) : null;
}

/**
 * What every request of a conversation carries before its messages, in estimated tokens: the failed job's system
 * prompt and tool list, which a rebuilt request carries too. Zero when the job is not found.
 */
export function requestFixedTokens(sql: Sql, jobId: string): number {
  const r = sql.exec("SELECT request FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
  if (!r) return 0;
  try {
    const c = JSON.parse(String(r.request))?.context ?? {};
    return estimateTokens(String(c.systemPrompt ?? "") + JSON.stringify(c.tools ?? []));
  } catch { return 0; }
}

/** The main conversation's newest model call still out, if any: its id. */
export function mainCallOut(sql: Sql): string | null {
  const r = sql.exec("SELECT id FROM pi_model_jobs WHERE session = ? AND answer IS NULL ORDER BY created_at DESC LIMIT 1", MAIN_SESSION).toArray()[0] as any;
  return r ? String(r.id) : null;
}
