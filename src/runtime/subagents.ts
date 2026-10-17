/**
 * Subagents: a piece of work an agent hands to a child conversation in its own object (issue #926).
 *
 * The shape is the asynchronous one: delegating is one tool call, `send_to_agent`, that starts the child and answers at
 * once, and the child's final answer comes back later as a message in the parent's conversation — the way a background
 * job's completion does (src/runtime/background-jobs.ts `completionMessage`). The parent's turn ends after the spawn, so
 * nothing in the object waits for a child, and the object parks while every conversation waits on the model.
 *
 * A child is a session of the same agent (`sub_<hex>`), on either engine: on pi085 a transcript of its own, on pd an
 * ownerless conversation. Not pi-durable's task-owned conversation: an owned child keeps its owner's task busy until
 * the child is idle (pi-durable README, "Abort and Subagents"), which is the blocking shape this avoids. So the link is
 * this module's table, and the runtime cascades a stop over it (cf/src/runtime.ts `stopTurn`).
 *
 * What a child shares and what it does not:
 * - it shares the agent's mounts, containers and files (they are the agent's, not a conversation's), its spend limits
 *   and its usage (the calls are made by the agent's object);
 * - it sees none of the parent's conversation: the task text is all it is told;
 * - it is never offered `send_to_agent` (depth 1), nor the Agents API caller's functions, which only the caller's own
 *   session can answer.
 *
 * Everything that has to be able to fail a test — the cap, the ceiling, the messages, how a turn's end is read — is a
 * function here, not inline at a call site in the runtime.
 */
import { isSubagentSession, SUBAGENT_SESSION_PREFIX } from "./subagent-session.ts";
import type { EngineEntry } from "./engine.ts";

export { isSubagentSession, SUBAGENT_SESSION_PREFIX };

/** The tool's name. Claude Managed Agents' own word for the same act (start a thread, or follow up on one). */
export const SUBAGENT_TOOL = "send_to_agent";

/** The agent setting that offers the tool (src/runtime/agent-settings.ts). */
export const SUBAGENTS_SETTING = "subagents";

/** Children of one agent with a turn running at once. Background jobs' cap, for the same reason: each is a slot that bills. */
export const SUBAGENT_CAP = 3;

/**
 * How long one child turn may run before it is cancelled and reported as cancelled. A child that loops never ends on
 * its own, and every step of it is a model call billed to the agent; the background ceiling's length, for the same reason.
 */
export const SUBAGENT_MAX_MS = 30 * 60_000;

/** The most of a child's answer a report carries; the rest is in the child's transcript. */
export const REPORT_MAX_CHARS = 20_000;

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };

export interface SubagentOwner { tenantId: string; agentId: string }

export type SubagentOutcome = "done" | "failed" | "cancelled" | "stopped";

export interface Subagent {
  /** The child's session id. */
  id: string;
  /** The session that started it, and that its reports go to. */
  parentSession: string;
  /** The parent's tool call that started the child's current turn: the trace's link from parent to child. */
  callId: string | null;
  /** The owner's model option the child runs on (USER_MODELS id), resolved to its provider and model; null: the agent's. */
  modelOption: string | null;
  provider: string | null;
  model: string | null;
  /** `running` while a turn is in flight; `idle` once its end was reported (or it was stopped with its parent). */
  state: "running" | "idle";
  /** The engine's id for the turn in flight: pi085's operation id, pd's submission id. What its end is read by. */
  turnOp: string | null;
  turns: number;
  createdAt: number;
  turnStartedAt: number;
  finishedAt: number | null;
  outcome: SubagentOutcome | null;
}

export function ensureSubagentTable(sql: Sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS subagents (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    parent_session TEXT NOT NULL, call_id TEXT, model_option TEXT, provider TEXT, model TEXT,
    state TEXT NOT NULL, turn_op TEXT, turns INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, turn_started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT)`);
}

/** Whether the object has the table at all, asked without making it: most objects never had a child. */
export function hasSubagentTable(sql: Sql): boolean {
  return sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'subagents'").toArray().length > 0;
}

const rowTo = (r: any): Subagent => ({
  id: String(r.id), parentSession: String(r.parent_session), callId: r.call_id === null ? null : String(r.call_id),
  modelOption: r.model_option === null ? null : String(r.model_option),
  provider: r.provider === null ? null : String(r.provider), model: r.model === null ? null : String(r.model),
  state: r.state === "running" ? "running" : "idle", turnOp: r.turn_op === null ? null : String(r.turn_op),
  turns: Number(r.turns), createdAt: Number(r.created_at), turnStartedAt: Number(r.turn_started_at),
  finishedAt: r.finished_at === null || r.finished_at === undefined ? null : Number(r.finished_at),
  outcome: (r.outcome ?? null) as SubagentOutcome | null,
});

/** A fresh child session id. Minted here only, so the prefix names a subagent and nothing else (src/runtime/subagent-session.ts). */
export function newSubagentId(): string {
  return `${SUBAGENT_SESSION_PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function subagentOf(sql: Sql, owner: SubagentOwner, id: string): Subagent | null {
  if (!hasSubagentTable(sql)) return null;
  const r = sql.exec("SELECT * FROM subagents WHERE id = ? AND tenant_id = ? AND agent_id = ?", id, owner.tenantId, owner.agentId).toArray()[0];
  return r ? rowTo(r) : null;
}

export function runningSubagents(sql: Sql, owner: SubagentOwner): Subagent[] {
  if (!hasSubagentTable(sql)) return [];
  return sql.exec("SELECT * FROM subagents WHERE tenant_id = ? AND agent_id = ? AND state = 'running' ORDER BY turn_started_at ASC",
    owner.tenantId, owner.agentId).toArray().map(rowTo);
}

/** Every child the agent has, newest first, as an operator reads them. */
export function listSubagents(sql: Sql, owner: SubagentOwner, limit = 20): Subagent[] {
  if (!hasSubagentTable(sql)) return [];
  return sql.exec("SELECT * FROM subagents WHERE tenant_id = ? AND agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    owner.tenantId, owner.agentId, limit).toArray().map(rowTo);
}

/**
 * Whether one more child turn may start. The refusal names the running ones, because the useful next step is to wait
 * for one, and their reports arrive by themselves.
 */
export function admitSubagent(running: ReadonlyArray<Pick<Subagent, "id" | "turnStartedAt">>, cap = SUBAGENT_CAP, now = Date.now()):
  { ok: true } | { ok: false; message: string } {
  if (running.length < cap) return { ok: true };
  const list = running.map((s) => `${s.id} (running ${Math.round((now - s.turnStartedAt) / 1000)}s)`).join(", ");
  return {
    ok: false,
    message: `${SUBAGENT_TOOL}: ${running.length} subagents are already running, the most this agent may have at once: ${list}. ` +
      "Nothing was started. Each one's report arrives as a message when it finishes; do the work yourself, or end your turn and delegate after a report arrives.",
  };
}

/** A new child, with its first turn in flight. */
export function recordSubagent(sql: Sql, owner: SubagentOwner, s: {
  id: string; parentSession: string; callId: string | null; modelOption: string | null; provider: string | null; model: string | null;
  turnOp: string | null; now: number;
}) {
  ensureSubagentTable(sql);
  sql.exec(
    "INSERT INTO subagents(id, tenant_id, agent_id, parent_session, call_id, model_option, provider, model, state, turn_op, turns, created_at, turn_started_at) " +
    "VALUES (?,?,?,?,?,?,?,?, 'running', ?, 1, ?, ?)",
    s.id, owner.tenantId, owner.agentId, s.parentSession, s.callId, s.modelOption, s.provider, s.model, s.turnOp, s.now, s.now);
}

/** A follow-up's turn: running again, with its own operation and the call that sent it. */
export function startSubagentTurn(sql: Sql, owner: SubagentOwner, id: string, t: {
  callId: string | null; turnOp: string | null; now: number; model?: { option: string; provider: string; model: string } | null;
}) {
  sql.exec(
    "UPDATE subagents SET state = 'running', turn_op = ?, call_id = ?, turns = turns + 1, turn_started_at = ?, finished_at = NULL, outcome = NULL" +
    (t.model ? ", model_option = ?, provider = ?, model = ?" : "") +
    " WHERE id = ? AND tenant_id = ? AND agent_id = ?",
    t.turnOp, t.callId, t.now, ...(t.model ? [t.model.option, t.model.provider, t.model.model] : []), id, owner.tenantId, owner.agentId);
}

/** The engine's id for the turn just started, once `say` has answered with it. */
export function setSubagentTurnOp(sql: Sql, owner: SubagentOwner, id: string, turnOp: string | null) {
  sql.exec("UPDATE subagents SET turn_op = ? WHERE id = ? AND tenant_id = ? AND agent_id = ?", turnOp, id, owner.tenantId, owner.agentId);
}

/** Only a running turn finishes, so two passes that both read its end report it once. Returns whether this one did. */
export function finishSubagentTurn(sql: Sql, owner: SubagentOwner, id: string, outcome: SubagentOutcome, now = Date.now()): boolean {
  const before = sql.exec("SELECT state FROM subagents WHERE id = ? AND tenant_id = ? AND agent_id = ?", id, owner.tenantId, owner.agentId).toArray()[0] as any;
  if (!before || before.state !== "running") return false;
  sql.exec("UPDATE subagents SET state = 'idle', finished_at = ?, outcome = ? WHERE id = ? AND tenant_id = ? AND agent_id = ? AND state = 'running'",
    now, outcome, id, owner.tenantId, owner.agentId);
  return true;
}

/**
 * Every running child marked stopped, before its turn is cancelled (cf/src/runtime.ts `stopTurn`). First, so no pass
 * that reads the cancelled turn's end reports it: a report would wake the parent whose turn the stop just ended.
 */
export function stopRunningSubagents(sql: Sql, owner: SubagentOwner, now = Date.now()): string[] {
  const ids = runningSubagents(sql, owner).map((s) => s.id);
  for (const id of ids) finishSubagentTurn(sql, owner, id, "stopped", now);
  return ids;
}

/** How many children of this object have a turn running; none when it never had one. One object is one agent. */
export function runningSubagentCount(sql: Sql): number {
  if (!hasSubagentTable(sql)) return 0;
  return Number((sql.exec("SELECT COUNT(*) AS n FROM subagents WHERE state = 'running'").toArray()[0] as any)?.n ?? 0);
}

/** Milliseconds until the soonest running child reaches its ceiling, or null when none runs: what a pass wakes for. */
export function subagentCeilingMs(sql: Sql, owner: SubagentOwner, now = Date.now(), maxMs = SUBAGENT_MAX_MS): number | null {
  const running = runningSubagents(sql, owner);
  if (!running.length) return null;
  return Math.max(0, Math.min(...running.map((s) => s.turnStartedAt + maxMs + 1 - now)));
}

/** Past the ceiling: the pass cancels the child's turn and reports it cancelled. */
export function overdueSubagent(s: Pick<Subagent, "turnStartedAt">, now = Date.now(), maxMs = SUBAGENT_MAX_MS): boolean {
  return now - s.turnStartedAt > maxMs;
}

/** What the parent's model is told the moment a child starts (or a follow-up is sent). */
export function startedResult(s: { id: string; followUp: boolean; model: string | null }) {
  return {
    agent: s.id,
    status: "started",
    ...(s.model ? { model: s.model } : {}),
    note: `${s.followUp ? "Sent; the subagent keeps its history." : "Started."} Its report arrives as a message in this conversation when it ` +
      "finishes, and wakes you. Do not wait or check on it: keep working on something else, or end your turn.",
  };
}

/**
 * The first line of every message a child is sent: whose message it is and where its answer goes. The child's system
 * prompt is the agent's own, so without this it would take the task for a person's and answer them.
 */
export function taskMessage(id: string, task: string, followUp: boolean): string {
  return `[${followUp ? "a follow-up" : "a task"} from the agent that started you, sent with ${SUBAGENT_TOOL}; you are its subagent ${id}. ` +
    "Your final message is your report: it is all the agent receives, so make it complete. Nobody else reads this conversation, " +
    "so do not message people or channels unless the task says to.]\n\n" + task;
}

/** How a child turn ended, as the report says it. */
export interface TurnEnd { outcome: "done" | "failed" | "cancelled"; text: string }

/**
 * The child turn's end, from the engine's record of it and the child's transcript: the last assistant message written
 * since the turn started, its text when it answered, the provider's error when the call failed. A turn the engine
 * ended without an answer (pi085's `failed` before any model call, pd's `unanswered`) is failed, with what is known.
 *
 * `result` is the engine's word for how the run ended (pi085 `completed`/`failed`/`aborted`, pd `done`/`unanswered`)
 * and its error message if it has one.
 */
export function turnEnd(entries: readonly EngineEntry[], since: number, result: { status: string; error?: string | null }): TurnEnd {
  let last: any = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as any;
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    if (typeof e.timestamp === "number" && e.timestamp < since) break;
    last = e.message;
    break;
  }
  if (result.status === "aborted") return { outcome: "cancelled", text: "" };
  if (last?.stopReason === "error") {
    return { outcome: "failed", text: String(last.providerError ?? last.errorMessage ?? "the model call failed") };
  }
  if (last?.stopReason === "aborted") return { outcome: "cancelled", text: "" };
  const text = last ? textOf(last) : "";
  if (result.status === "failed" || result.status === "unanswered") {
    return { outcome: "failed", text: result.error || text || "the turn ended without an answer" };
  }
  if (!last) return { outcome: "failed", text: result.error || "the turn ended without an answer" };
  return { outcome: "done", text: text || "(the subagent's final message had no text)" };
}

function textOf(message: { content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n").trim();
}

/**
 * The message that wakes the parent when a child's turn ends. Plain text, so every lane mode accepts it; the head says
 * whose it is, as a background completion's does, so a report is not taken for the person asking for something.
 */
export function reportMessage(s: Pick<Subagent, "id" | "turnStartedAt">, end: TurnEnd, now = Date.now()): string {
  const secs = Math.round((now - s.turnStartedAt) / 1000);
  const head = `[subagent ${s.id} — ${end.outcome} after ${secs}s; its report, a notice from the harness, not a message from the user. ` +
    `${SUBAGENT_TOOL} with agent "${s.id}" sends it a follow-up.]`;
  if (end.outcome === "done") {
    const text = end.text.length > REPORT_MAX_CHARS
      ? `${end.text.slice(0, REPORT_MAX_CHARS)}\n[cut at ${REPORT_MAX_CHARS} of ${end.text.length} characters]` : end.text;
    return `${head}\n${text}`;
  }
  if (end.outcome === "failed") return `${head}\nIt failed: ${end.text}`;
  return `${head}\nIt was cancelled${end.text ? `: ${end.text}` : ""}. Nothing it said after that was kept as a report.`;
}

/** The parameters the model sends. */
export interface SendParams { task?: unknown; agent?: unknown; model?: unknown }

/**
 * The tool. Its body is the object's (`send` in cf/src/runtime.ts), like `jobs`; this is the name, the words the model
 * reads, and the checks that need nothing but the parameters.
 *
 * `models`: the owner's model options a child may run on (USER_MODELS ids); none, and `model` is not offered.
 */
export function subagentTool(d: {
  models: ReadonlyArray<{ id: string; label: string }>;
  send(p: { task: string; agent: string | null; model: string | null }, callId: string): Promise<unknown>;
}) {
  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
  const modelLine = d.models.length
    ? ` model picks what the subagent runs on, from: ${d.models.map((m) => `${m.id} (${m.label})`).join(", ")}; leave it out for your own model.`
    : "";
  return {
    name: SUBAGENT_TOOL,
    label: SUBAGENT_TOOL,
    description:
      "Delegate a self-contained piece of work to a subagent: a fresh copy of you with its own context, the same tools, files " +
      "and containers, and no view of this conversation. Returns at once with the subagent's id; its final answer arrives later " +
      "as a message in this conversation and wakes you. Do not wait or poll for it.\n" +
      "Delegate only (a) independent pieces that can run in parallel, or (b) work too big for one context — reading many " +
      "files or pages — where only a summary matters to you. Do not delegate a simple question, anything a few tool calls " +
      "finish, or steps that depend tightly on each other: each subagent costs a whole conversation of model calls.\n" +
      "task is all the subagent sees, so write a complete instruction: the goal, the exact paths, URLs and ids, the " +
      "constraints, and the format of the report you want back. agent: a subagent's id, to send it a follow-up; it keeps " +
      `its history. At most ${SUBAGENT_CAP} run at once.${modelLine}`,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "the complete instruction: goal, paths, constraints, and the report format you want" },
        agent: { type: "string", description: "a subagent's id, to send a follow-up; leave out to start a new one" },
        ...(d.models.length ? { model: { type: "string", enum: d.models.map((m) => m.id), description: "the model option the subagent runs on" } } : {}),
      },
      required: ["task"],
    },
    async execute(toolCallId: string, params: SendParams) {
      const task = typeof params?.task === "string" ? params.task.trim() : "";
      if (!task) throw new Error(`${SUBAGENT_TOOL}: task is required, and is the whole instruction the subagent gets`);
      const agent = params?.agent === undefined || params.agent === null || params.agent === "" ? null : String(params.agent);
      const model = params?.model === undefined || params.model === null || params.model === "" ? null : String(params.model);
      return text(await d.send({ task, agent, model }, toolCallId));
    },
  };
}
