/**
 * The trace rows the store writes at its own seams, built here so the two
 * store implementations (src/store/durable-object.ts, src/store/sqlite.ts)
 * write the same row from the same facts and neither carries its own copy of
 * the mapping.
 *
 * A row is written where the fact it joins back to is committed, inside the
 * same transaction, from the values that transaction read — never from a
 * later read of the record (a span whose numbers came from somewhere else
 * joins correctly and is still wrong; the recorder asserts the arithmetic).
 */
import type { OperationStatus } from "../core/types.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Released } from "../plugins/types.ts";
import type { TraceRow, TraceVerdict } from "./outbox.ts";
import type { ToolFailure } from "../core/store.ts";
import { redactCredentialShapes } from "./redact.ts";

/**
 * `completeOperation` is also how the gateway says "running" (a progress
 * update, not an end), so a tool.call span closes only on a terminal status.
 * `unknown` is terminal — the harness lost the outcome — and reads as failed:
 * the call did not deliver, and no later fact will say it did.
 */
export function operationEnded(status: OperationStatus): boolean {
  // A switch, not a boolean chain, so that adding a status is a compile error
  // here as well as in operationVerdict: "is this an end" is the judgement the
  // gateway's deny path (and any new status) has to answer, and a chain would
  // answer it silently with false.
  switch (status) {
    case "succeeded": case "failed": case "cancelled": case "unknown": case "rejected": return true;
    case "pending": case "running": return false;
  }
}

export function operationVerdict(status: OperationStatus): TraceVerdict {
  switch (status) {
    case "succeeded": return "ok";
    case "cancelled": return "cancelled";
    case "failed": case "unknown": return "failed";
    // Refused by policy before it ran: the road was closed, which is neither a
    // failure of the call nor a cancellation of it. The usage ledger does not
    // count rejections (src/usage/outbox.ts, tool.call rows are for calls that
    // ran); the trace does, because "why did it stop" is what it exists for.
    case "rejected": return "blocked";
    // Not an end; callers ask operationEnded first. Named so the switch stays
    // exhaustive when a status is added.
    case "pending": case "running": return "failed";
  }
}

/**
 * Whether a completion is the one that ends the operation: a terminal status reached from one that was not. An
 * operation can be completed again after it ended — `applyApproval` (src/runtime/gateway.ts) completes the approved
 * run that `#run` already completed, and a parked result (cf/src/runtime.ts `parkResult`) completes it again with its
 * reference — and each of those updates the record but is not a second end. A `tool.call` row is the span's one row
 * (src/runtime/activity.ts pairs a start and an end per row under the operation id), so only this transition writes it.
 * `prior` is null when the record was not found, which writes no row either way.
 */
export function operationEnds(prior: OperationStatus | null, status: OperationStatus): boolean {
  return operationEnded(status) && prior !== null && !operationEnded(prior);
}

/** The tool.call row for an operation that just ended. */
export function toolCallRow(op: {
  tenantId: string; agentId: string; taskId: string; operationId: string;
  mountAlias: string; tool: string; status: OperationStatus;
  /** The name the model called the tool by (`OperationRecord.modelName`); null when no model named it. */
  modelName?: string | null;
  createdAt: number; endedAt: number; callId?: string | null;
  /** The command's exit status, when the tool ran one (`CompletedFacts.exitCode`). */
  exitCode?: number | null;
  /** When the attempt began, after any approval wait (`CompletedFacts.startedAt`). */
  startedAt?: number | null;
  /** A person refused the held call (`CompletedFacts.denied`). */
  denied?: boolean;
  /** Why a call that failed failed (`CompletedFacts.failure`): written bounded and redacted (`failureAttrs`). */
  failure?: ToolFailure | null;
}): TraceRow {
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    at: op.endedAt, tenantId: op.tenantId, agentId: op.agentId,
    kind: "tool.call", spanId: op.operationId,
    status: op.status, verdict: operationVerdict(op.status),
    // The whole operation, from the request: a held call's wait for a person is inside it (and has its own
    // approval.wait row). `runMs` is the part after the attempt began, which is what the activity log reports.
    ms: Math.max(0, op.endedAt - op.createdAt),
    attrs: {
      tool: op.tool, mount: op.mountAlias, ...(op.modelName ? { name: op.modelName } : {}), task: op.taskId,
      ...(op.callId ? { callId: op.callId } : {}),
      ...(num(op.exitCode) ? { exitCode: op.exitCode } : {}),
      ...(num(op.startedAt) ? { runMs: Math.max(0, op.endedAt - Math.max(op.startedAt, op.createdAt)) } : {}),
      ...(op.denied === true ? { denied: true } : {}),
      ...(op.status === "succeeded" || !op.failure ? {} : failureAttrs(op.failure)),
    },
  };
}

/** A tool error's message is cut to this many characters on the trace row: enough for a sentence, not a body. */
export const TOOL_ERROR_MAX = 200;
/** A code is a machine token (`NOT_FOUND`, `TRANSPORT_ERROR`); anything else is not written as one. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Why a failed `tool.call` failed, as the trace row records it: the plugin's error code (for Raft, the Server's own
 * code when it sent one, else the SDK's), the HTTP status, and the sentence, with credential shapes redacted
 * (`redactCredentialShapes`) and then cut to TOOL_ERROR_MAX. Redacted before it is cut, so a token cut in half is not
 * left as a prefix no pattern recognises. A code that is not code-shaped and a status that is not an HTTP status are
 * left out rather than written: the row is read by people looking for which rule refused the call.
 */
export function failureAttrs(f: ToolFailure): Record<string, unknown> {
  const code = typeof f.code === "string" && ERROR_CODE.test(f.code) ? f.code : null;
  const http = typeof f.httpStatus === "number" && Number.isInteger(f.httpStatus) && f.httpStatus >= 100 && f.httpStatus <= 599 ? f.httpStatus : null;
  const said = typeof f.message === "string" ? redactCredentialShapes(f.message.replace(/\s+/g, " ").trim()) : "";
  return {
    ...(code ? { errorCode: code } : {}),
    ...(http === null ? {} : { httpStatus: http }),
    ...(said ? { error: said.length > TOOL_ERROR_MAX ? `${said.slice(0, TOOL_ERROR_MAX - 1)}…` : said } : {}),
  };
}

/** The approval.wait row for a decision that just landed. */
export function approvalRow(a: {
  tenantId: string; agentId: string; taskId: string; operationId: string;
  mountAlias: string; tool: string; decision: "approved" | "denied"; approver: string;
  createdAt: number; decidedAt: number;
}): TraceRow {
  return {
    at: a.decidedAt, tenantId: a.tenantId, agentId: a.agentId,
    kind: "approval.wait", spanId: a.operationId,
    status: a.decision, verdict: a.decision === "approved" ? "ok" : "blocked",
    ms: Math.max(0, a.decidedAt - a.createdAt),
    attrs: { tool: a.tool, mount: a.mountAlias, task: a.taskId, approver: a.approver },
  };
}

/**
 * A model call's span closes when its answer is committed as an entry. The
 * answer carries the job id it came from (src/model/pi-bridge.ts, `jobId`),
 * so the row joins back to `pi_model_jobs` by that id; the placeholder and
 * any poll entries carry "deferred"/"pending" and are not ends.
 *
 * The stop reasons are pi-ai's union, not ours, so a switch here would still
 * compile when pi adds one. A record keyed by that union does not: a reason
 * pi adds is a missing key, one it removes is an excess key, and either is a
 * type error at this line. That is the test docs/pi-upstream.md promises for
 * the contract it records about this union (see "Behavioural contracts").
 */
const STOP_REASON_ENDS: Record<AssistantMessage["stopReason"], "end" | "not-end"> = {
  stop: "end", length: "end", toolUse: "end", error: "end", aborted: "end",
  pending: "not-end", deferred: "not-end",
};

export function answerEnded(stopReason: AssistantMessage["stopReason"]): boolean {
  return STOP_REASON_ENDS[stopReason] === "end";
}

/**
 * `length` is a reply that was cut off but said something — usable, and the
 * harness tells the model so — so it reads as ok with the raw reason kept in
 * `status`; a reply that was cut off and said nothing arrives as `error`.
 */
export function answerVerdict(stopReason: AssistantMessage["stopReason"]): TraceVerdict {
  switch (stopReason) {
    case "stop": case "length": case "toolUse": return "ok";
    case "error": return "failed";
    case "aborted": return "cancelled";
    // Not ends; callers ask answerEnded first. Named so the switch stays
    // exhaustive when pi adds a reason.
    case "pending": case "deferred": return "failed";
  }
}

/** The model.call row for an answer that just landed as an entry. */
export function modelCallRow(m: {
  tenantId: string; agentId: string; jobId: string; stopReason: AssistantMessage["stopReason"];
  model: string; at: number; createdAt?: number | null; answeredAt?: number | null;
  /** What the request shared with the previous one (src/runtime/request-prefix.ts), as the job row kept it. */
  prefix?: Record<string, unknown> | null;
  /**
   * The answer's own token counts, so a cache miss can be read against the prefix on the same row, and a session's total read off its rows.
   * `reasoning` is the part of `output` the model spent reasoning, as the usage ledger counts it (src/usage/outbox.ts
   * `modelTokenRows`); absent when the provider reported none (src/model/pi-bridge.ts `usageOf`), never a 0 written for unknown.
   */
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; reasoning?: unknown } | null;
  /** The sentence of a call refused for a daily spend limit (`spendLimitRefusal`, src/model/pi-bridge.ts), for Raft. */
  limit?: string;
  /**
   * The conversation that made the call: `main`, an Agents API session, or a subagent (src/runtime/subagents.ts). A
   * subagent's calls are the agent's spend but not its turn, so activity and status skip them by this (src/runtime/status.ts
   * `subagentRow`), and a child's share of the cost is read by it. Absent where the writer could not tell.
   */
  session?: string | null;
  /**
   * The first tool an answer that ended `toolUse` asked for (`firstToolCall`): the status that answer means names it
   * (src/runtime/status.ts), so "working" never goes out without saying on what.
   */
  firstTool?: string | null;
  /** The turn the call was made in (`turnIdOf`, src/runtime/turn-timing.ts), when one was open: what a turn's end is reported under. */
  turn?: string | null;
}): TraceRow {
  const ms = typeof m.createdAt === "number" && typeof m.answeredAt === "number"
    ? Math.max(0, m.answeredAt - m.createdAt) : undefined;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const tokens = m.usage ? Object.fromEntries(
    ([["input", m.usage.input], ["output", m.usage.output], ["cacheRead", m.usage.cacheRead], ["cacheWrite", m.usage.cacheWrite],
      ["reasoning", m.usage.reasoning]] as const)
      .flatMap(([k, v]) => num(v) === undefined ? [] : [[k, num(v)]])) : {};
  return {
    at: m.at, tenantId: m.tenantId, agentId: m.agentId,
    kind: "model.call", spanId: m.jobId,
    status: m.stopReason, verdict: answerVerdict(m.stopReason),
    ...(ms === undefined ? {} : { ms }),
    // The model first: keys drop from the end when attrs are too long (src/trace/outbox.ts `attrsOf`).
    // The limit's sentence next: what the owner is shown (src/runtime/activity.ts), the last thing to be dropped.
    // The session right after it: activity reads it to tell a subagent's call from the agent's own, so it is kept over the readings.
    // The first tool right after: the status reads it, and it is one short name. The turn after that: a turn's end is
    // reported under it (src/runtime/activity.ts `turnEnds`), so it is kept over the readings too.
    attrs: {
      model: m.model, ...(m.session ? { session: m.session } : {}), ...(m.limit ? { limit: m.limit } : {}),
      ...(m.stopReason === "toolUse" && m.firstTool ? { firstTool: m.firstTool.slice(0, 120) } : {}),
      ...(m.turn ? { turn: m.turn.slice(0, 200) } : {}),
      ...tokens, ...(m.prefix ? { prefix: m.prefix } : {}),
    },
  };
}

/**
 * The model.attempt row for one provider attempt that failed and is retried by the queue (cf/src/model-queue.ts
 * `FailedAttempt`). Its span is the job, so it joins `pi_model_jobs` and sits beside the `model.call` row the job's
 * final answer writes; a job retried twice has two of these and one `model.call`. Built from what came over the RPC,
 * so each field is checked rather than trusted: a phase or outcome outside the vocabulary, a status that is not an
 * HTTP status, a class that is not an identifier, is left out. No message, ever: a provider's error message carries
 * its response body.
 */
export function modelAttemptRow(o: { tenantId: string; agentId: string; jobId: string; at: number }, a: Record<string, unknown>): TraceRow {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const oneOf = <T extends string>(v: unknown, set: readonly T[]) => set.find((x) => x === v);
  const phase = oneOf(a.phase, ["take", "admit", "call", "deliver"] as const);
  const outcome = oneOf(a.outcome, ["http", "timeout", "transport_error"] as const);
  const attempt = typeof a.attempt === "number" && Number.isInteger(a.attempt) && a.attempt > 0 ? a.attempt : undefined;
  const http = typeof a.httpStatus === "number" && Number.isInteger(a.httpStatus) && a.httpStatus >= 100 && a.httpStatus <= 599 ? a.httpStatus : undefined;
  const errorClass = typeof a.errorClass === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(a.errorClass) ? a.errorClass : undefined;
  const model = typeof a.model === "string" && /^[A-Za-z0-9._:/@-]{1,120}$/.test(a.model) ? a.model : undefined;
  const ms = num(a.ms), providerMs = num(a.providerMs);
  return {
    at: o.at, tenantId: o.tenantId, agentId: o.agentId,
    kind: "model.attempt", spanId: o.jobId,
    // The queue's decision, verbatim: this attempt is over and the message goes back for another.
    status: "retried", verdict: "failed",
    ...(ms === undefined ? {} : { ms }),
    attrs: {
      ...(attempt === undefined ? {} : { attempt }), ...(phase ? { phase } : {}), ...(outcome ? { outcome } : {}),
      ...(http === undefined ? {} : { httpStatus: http }), ...(errorClass ? { errorClass } : {}),
      ...(providerMs === undefined ? {} : { providerMs }), ...(model ? { model } : {}),
    },
  };
}

/**
 * The name of the first tool call in an answer's content, as the model called it (`raft__messages_resolve`, `run_js`),
 * or null when it asked for none. A `run_js` call is named as itself: which host tools its program will call is in the
 * program, and reading it out of the source would be a guess.
 */
export function firstToolCall(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "toolCall") {
      const name = (c as { name?: unknown }).name;
      if (typeof name === "string" && name) return name;
    }
  }
  return null;
}

/**
 * A `Released` as the plugin reported it, or not one. The gateway finds these
 * by a declared key on a result and on a thrown error, so the shape is checked
 * rather than trusted: a plugin that put something else under the key has
 * reported nothing, and the key is then left where it was for the reader to see.
 */
export function isReleased(x: unknown): x is Released {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0
    && typeof r.startedAt === "number" && typeof r.endedAt === "number"
    // An end before its start is not a fact but a damaged record read as one
    // (a createdAt written wrong is enough); clamped to 0 ms it would join
    // back and look like a box released the instant it was made. Refused, it
    // stays visible where it was reported.
    && r.endedAt >= r.startedAt
    && (r.status === "freed" || r.status === "error");
}

/**
 * The container.lease row for a release the plugin just reported. Every
 * number comes from the fact itself — the release's own read — never from a
 * later look at the mount, which can land on a different box (the contract
 * on `Released` says why).
 */
export function leaseRow(o: { tenantId: string; agentId: string; alias: string }, fact: Released): TraceRow {
  return {
    at: fact.endedAt, tenantId: o.tenantId, agentId: o.agentId,
    kind: "container.lease", spanId: fact.id,
    status: fact.status, verdict: fact.status === "freed" ? "ok" : "failed",
    ms: fact.endedAt - fact.startedAt,
    attrs: { mount: o.alias, ...(fact.error ? { error: fact.error } : {}) },
  };
}

/**
 * Every `Released` in what a release handed back or threw: one fact, a list of them (a mount letting go
 * of several things at once), or nothing. Each is checked as `isReleased` checks one; what is not a fact
 * is dropped rather than recorded.
 */
export function releasedFacts(x: unknown): Released[] {
  return Array.isArray(x) ? x.filter(isReleased) : isReleased(x) ? [x] : [];
}

/**
 * The mount.seeded row for one catalogue entry whose outcome on this agent just changed
 * (src/store/seed-record.ts). Its span is the entry, `<alias>@<since>`, which is the outcome row's key, so the
 * row joins back to the record that says the same thing. `added` and `present` are the entry reaching the agent;
 * `not-for` is the catalogue saying it should not; the two an owner or operator can lift are `blocked`, and a
 * refusal (the alias taken by another plugin, a seed whose settings do not validate) is `failed`.
 */
export function seededRow(s: {
  tenantId: string; agentId: string; alias: string; plugin: string; since: number;
  outcome: "added" | "present" | "declined" | "not-for" | "unavailable" | "refused"; reason: string | null; at: number;
  /** On an `added` row only: whether the agent is to be told (`pending`) or the pass gave it its first tools, so there
   *  was nothing for this to be news against (src/store/seed-record.ts). When it was told is the record's `seed_notices`. */
  notice?: "pending" | "first tools";
}): TraceRow {
  const verdict: TraceVerdict = s.outcome === "refused" ? "failed"
    : s.outcome === "declined" || s.outcome === "unavailable" ? "blocked" : "ok";
  return {
    at: s.at, tenantId: s.tenantId, agentId: s.agentId,
    kind: "mount.seeded", spanId: `${s.alias}@${s.since}`,
    status: s.outcome, verdict,
    attrs: { alias: s.alias, plugin: s.plugin, since: s.since, outcome: s.outcome, reason: s.reason, ...(s.notice ? { notice: s.notice } : {}) },
  };
}

/**
 * The js.run row for one stretch of a run_js program (src/runtime/pi-tools.ts `RunEnd`): how it ended and its error's
 * code. Its span is the model's call, which a stretch after a `resume` shares with the run it continues.
 */
export function jsRunRow(o: {
  tenantId: string; agentId: string; session: string; at: number;
  run: { ok: boolean; ms: number; hostCalls: number; resumed?: boolean; callId?: string; status?: string; code?: string };
}): TraceRow {
  const status = o.run.status ?? (o.run.ok ? "completed" : "failed");
  return {
    at: o.at, tenantId: o.tenantId, agentId: o.agentId, kind: "js.run",
    spanId: o.run.callId || `js_${o.at}`,
    status, verdict: o.run.code === "cancelled" ? "cancelled" : o.run.ok ? "ok" : "failed",
    ms: Math.max(0, o.run.ms),
    attrs: { ...(o.run.code ? { code: o.run.code } : {}), hostCalls: o.run.hostCalls, session: o.session, ...(o.run.resumed ? { resumed: true } : {}) },
  };
}

/** A tool name as a caller may write one: an address (`gh.api_get`) or the model's form (`gh__api_get`). */
const REFUSED_TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The tool.refused row for a host call refused before an operation existed: by the gateway (a name that resolves to no
 * mount, a mount switched off, a tool the mount does not have, a model-only tool from a program: src/runtime/gateway.ts
 * `#refused`), by run_js on the model's behalf (src/runtime/pi-tools.ts `runJsTool`), or by the executor itself (a
 * template that does not parse, the host-call budget: `ExecutorHost.refused`, src/core/execution.ts). A refused call
 * that had an operation already has its `tool.call` row, ended `rejected`; these had none, so before this nothing in the
 * trace said they were made (three in an onboarding agent's turn, 2026-10-20, whose reason no record kept).
 *
 * The name the caller wrote and the refusal's code, and nothing the caller passed: no arguments, no values, not the
 * refusal's sentence, which can quote the name back inside other words. A name or code that is not shaped like one is
 * left out, and so is a name shaped like a credential, so a program cannot write a value into the row by calling a
 * tool named after it. Its span is the model's
 * call, as `js.run`'s is, so a program's refusals sit under its run.
 */
export function toolRefusedRow(o: {
  tenantId: string; agentId: string; at: number;
  tool: string | null; code: string;
  /** The model's call this one serves: the run_js call for a program's, the call itself for the model's own. */
  callId?: string | null;
  /** Who refused it: the gateway, run_js, or the executor running the program. */
  by: "gateway" | "run_js" | "executor";
  /** The call came from a run_js program rather than from the model directly. */
  fromProgram: boolean;
  /** The task the call was made under, as a `tool.call` row names it (`task`), when the writer knows it. */
  task?: string | null;
}): TraceRow {
  const code = ERROR_CODE.test(o.code) ? o.code : "refused";
  // A long name is a blob to `redactCredentialShapes` (an MCP tool's often is), so only its credential shapes count here.
  const tool = typeof o.tool === "string" && REFUSED_TOOL.test(o.tool)
    && !/<(secret|redacted|placeholder)>/.test(redactCredentialShapes(o.tool)) ? o.tool : null;
  return {
    at: o.at, tenantId: o.tenantId, agentId: o.agentId, kind: "tool.refused",
    spanId: o.callId || `refused_${o.at}`,
    status: code, verdict: "blocked",
    attrs: {
      ...(tool ? { tool } : {}), code, by: o.by, from: o.fromProgram ? "program" : "model",
      ...(o.callId ? { callId: o.callId } : {}), ...(o.task ? { task: o.task } : {}),
    },
  };
}
