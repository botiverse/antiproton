/**
 * Trace outbox rows forwarded to Raft's trace-upload worker, on two lanes, each with its own route, allowlist, queue,
 * cursor, backoff and counts (`FORWARD_LANES`):
 * - `github.refresh` (`GITHUB_REFRESH_LANE`): a renewal's outcome, alerted on from the trace rather than from Workers
 *   Logs, which drops an object's lines (#980; docs/runbook.md, "Logs and what an object did"), to
 *   `/api/external/github-refresh`.
 * - `agent.trace` (`AGENT_TRACE_LANE`): the kinds that say how a turn went (model calls and failed attempts, tool calls
 *   and refusals, turn timing and stops, turn ends a pass could not record, a rebuild's measured outcome, the
 *   assistant's wakes, checks, notifies, rules, chat tellings and sends as its owner, Raft's answer to a turn's end), so
 *   they can be read next to Raft's own telemetry, to `/api/external/antiproton-trace`.
 * Off until the deployment names the endpoint and its token (`forwardConfigOf`); off, nothing here runs and no table is
 * made. One configuration turns on both lanes; a lane the receiver does not have yet answers 404 and pauses alone.
 *
 * The only reader of the outbox that leaves the account: so each lane reads through an allowlist of kinds and sends, per
 * kind, a fixed set of fields built one by one from the row (`forwardRow`, `AGENT_TRACE_FIELDS`), never the row as
 * stored. A kind added to the trace is not forwarded until it is added to a lane, and an attr added to a kind is not
 * forwarded until it is a field here. Only ids, fixed codes, enums, counts and booleans are fields, each checked against
 * the receiver's own shapes before it is sent: no message, prompt, argument, error text or rule leaves.
 *
 * Two steps, so that neither the R2 export nor this waits for the other:
 * - `stageForward`, local only: the allowlisted rows past a lane's own cursor (`<lane>_staged`) are mapped to their
 *   fields and copied into the lane's own queue (`<lane>_queue`), and the cursor moves. It runs before the export on
 *   every pass and the lowest lane cursor is the export's prune hold, so the export never prunes a row a lane has not
 *   copied; and since it touches nothing remote, that hold does not stall when the endpoint is down.
 * - `sendForward`, remote: a lane's queue, oldest first, at most FORWARD_BATCH_MAX rows and FORWARD_BATCH_BYTES a
 *   request. Its outcome is the lane's alone: it never throws, never fails the pass, and asks for no extra pass. A row
 *   waiting on a backoff is sent on the first alarm pass after the backoff, whenever the agent next has one. It runs
 *   after the pass has armed the agent's next alarm, and within a budget per pass (FORWARD_PASS_MS of wall time for
 *   every lane together, FORWARD_PASS_REQUESTS requests per lane): what the budget leaves stays queued for the next pass.
 *
 * What an answer does (agreed with the receiving side). Every outcome but a 2xx is counted in the lane's `<lane>_log`
 * with a fixed reason and the status, and logged as the lane's line (`github.refresh.forward`, `trace.forward`):
 * - 2xx: accepted, duplicates included; the rows leave the queue.
 * - 413: the batch is split in half and each half sent, down to one row; a single row still too large is dropped
 *   (`too-large`). Each half is a request of the pass's budget, so a receiver that answers 413 to everything costs a
 *   pass FORWARD_PASS_REQUESTS requests, and the rest of the split waits for the next.
 * - 400, 422: the receiver cannot take the batch's shape, which a resend will not mend: it is dropped (`schema`) and the
 *   queue moves on rather than wedging behind it.
 * - 401, 403, 404: the token is wrong or expired, or the receiver is switched off (it answers 404 while it has no token
 *   of its own, or has no such route yet), none of which says anything about the rows: the lane pauses (`auth_or_off`),
 *   the rows stay, and the backoff below applies, so the backlog drains once either side is mended.
 * - 408, 429, 5xx, or no answer: the rows stay (`unavailable`) and the backoff applies. No answer includes one that
 *   has not come within FORWARD_TIMEOUT_MS, or by the end of the pass's budget, whichever is first: every request,
 *   each half of a 413 split included, is aborted then, since the send runs inside the agent's alarm pass and a
 *   receiver that hangs would otherwise hold that pass open. A
 *   timeout ends the lane's sending for the pass like any other failure: no later batch is tried until the backoff is over.
 * - any other 4xx: dropped (`rejected`), as a resend of the same request gets the same.
 * The backoff: FORWARD_BACKOFF_BASE_MS, doubling to FORWARD_BACKOFF_MAX_MS, cleared by the next success.
 * A resent row is the same row: its identity is (tenant_id, agent_id, seq), the outbox's own, on both lanes, and the
 * receiver dedupes on it. The antiproton-trace route answers a 2xx with the rows it could not take
 * (`{accepted, rejected: [{index, reason}]}`): those are dropped, not retried (the same row gets the same answer), and
 * counted as `rejected` with the receiver's reason; the rest of the batch is accepted and the 2xx is a success. A row
 * this side already knows the receiver would reject (a tenant or agent that is not an id) is not sent but counted
 * (`unsendable`) at staging.
 *
 * What a pause costs, and why the queue rather than the outbox holds it: the export prunes the outbox through the lanes'
 * stage cursors, which always move, so a paused lane never holds the outbox (every kind's rows) or the export. What
 * waits is the lane's queue of mapped rows alone, at most FORWARD_QUEUE_MAX; past that the oldest are dropped and counted
 * (`lost`). Seven days of the counts are kept.
 */
import { logEvent } from "../../src/core/log.ts";
import { pendingTrace, type TraceKind, type TraceOutboxRow } from "../../src/trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const FORWARD_ENVS = ["production", "preview"] as const;
export type ForwardEnv = (typeof FORWARD_ENVS)[number];

/** The receiver's limit on rows per request (both routes). */
export const FORWARD_BATCH_MAX = 500;
/** The most bytes one request's body may have: the smaller of the receiver's two limits (256 KiB github-refresh, 512 KiB antiproton-trace). */
export const FORWARD_BATCH_BYTES = 256 * 1024;
/** What a lane's queue holds at most while the endpoint is down; the oldest rows past it are dropped and counted. */
export const FORWARD_QUEUE_MAX = 5_000;
/** How many outbox rows one pass stages at most; the rest are staged by the next pass (and held from pruning till then). */
const STAGE_READ_MAX = 2_000;
/** How long one request may take before it is aborted and counted as no answer (`unavailable`). */
export const FORWARD_TIMEOUT_MS = 10_000;
/**
 * What one alarm pass may spend sending, every lane together: FORWARD_PASS_MS of wall time from the start of the send,
 * shared by the lanes, and at most FORWARD_PASS_REQUESTS requests per lane, each half of a 413 split counted as one.
 * The send runs after the pass has armed its next alarm, but a Durable Object runs one alarm at a time, so whatever
 * the send spends is a delay to the agent's next step: this is that delay's ceiling. A request is not started with
 * less than FORWARD_REQUEST_MIN_MS of it left, and one that is started is cut at the pass's end (counted as no
 * answer, as a timeout is). What the budget leaves is still queued, for the next pass, with no backoff.
 */
export const FORWARD_PASS_MS = 2_000;
export const FORWARD_PASS_REQUESTS = 8;
const FORWARD_REQUEST_MIN_MS = 250;
/** One lane's share of a pass: requests left, and the instant (Date.now) the pass's sending ends. */
export type ForwardBudget = { requests: number; until: number };
export const FORWARD_BACKOFF_BASE_MS = 60_000;
export const FORWARD_BACKOFF_MAX_MS = 60 * 60_000;
/** How long a drop stays on record. */
const DROPS_KEEP_MS = 7 * 24 * 60 * 60_000;

export type ForwardConfig = { url: string; token: string; env: ForwardEnv };

const setting = (env: Record<string, unknown>, name: string): string =>
  typeof env[name] === "string" ? (env[name] as string).trim() : "";

/** Why a deployment that names some forwarding setting does not forward: shown by diagnose, never with a value. */
export const FORWARD_CONFIG_PROBLEMS = ["url_missing", "token_missing", "deployment_env_invalid", "url_invalid", "url_not_https",
  "url_has_credentials"] as const;
export type ForwardConfigProblem = (typeof FORWARD_CONFIG_PROBLEMS)[number];

export type ForwardSettings =
  | { state: "off" }
  | { state: "misconfigured"; problem: ForwardConfigProblem; urlFrom: string | null; tokenFrom: string | null }
  | { state: "on"; config: ForwardConfig; urlFrom: string; tokenFrom: string };

/**
 * The deployment's forwarding settings, read once: `off` when neither a URL nor a token is set, `on` with its config,
 * else `misconfigured` with why, which sends nothing. TRACE_INGEST_URL and TRACE_INGEST_TOKEN (one token for both
 * routes); GITHUB_REFRESH_INGEST_URL and GITHUB_REFRESH_INGEST_TOKEN, their earlier names, are read when the new ones
 * are unset (an empty value is unset). DEPLOYMENT_ENV must name the deployment (cf/wrangler.jsonc,
 * cf/wrangler.preview.jsonc): a row that cannot say where it came from is not sent.
 *
 * The URL must be `https:`: the bearer token rides on every request, and over `http:` it would cross the network in
 * the clear (an ingest reachable only at a bare load balancer address over plain HTTP is exactly that). A URL that does
 * not parse, is not https, or carries a user or password in it is refused as a whole, with no fallback to the other
 * name: the setting someone wrote is the one that is wrong, and it is reported as such.
 */
export function forwardSettingsOf(env: Record<string, unknown>): ForwardSettings {
  const urlFrom = setting(env, "TRACE_INGEST_URL") ? "TRACE_INGEST_URL" : setting(env, "GITHUB_REFRESH_INGEST_URL") ? "GITHUB_REFRESH_INGEST_URL" : null;
  const tokenFrom = setting(env, "TRACE_INGEST_TOKEN") ? "TRACE_INGEST_TOKEN" : setting(env, "GITHUB_REFRESH_INGEST_TOKEN") ? "GITHUB_REFRESH_INGEST_TOKEN" : null;
  if (!urlFrom && !tokenFrom) return { state: "off" };
  const bad = (problem: ForwardConfigProblem): ForwardSettings => ({ state: "misconfigured", problem, urlFrom, tokenFrom });
  if (!urlFrom) return bad("url_missing");
  if (!tokenFrom) return bad("token_missing");
  const which = env.DEPLOYMENT_ENV;
  if (!(FORWARD_ENVS as readonly unknown[]).includes(which)) return bad("deployment_env_invalid");
  const raw = setting(env, urlFrom);
  let url: URL;
  try { url = new URL(raw); } catch { return bad("url_invalid"); }
  if (url.protocol !== "https:") return bad("url_not_https");
  if (url.username || url.password) return bad("url_has_credentials");
  if (!url.hostname) return bad("url_invalid");
  return { state: "on", config: { url: raw.replace(/\/+$/, ""), token: setting(env, tokenFrom), env: which as ForwardEnv }, urlFrom, tokenFrom };
}

/** The deployment's forwarding, or null when it is off or misconfigured (`forwardSettingsOf`): then nothing is sent. */
export function forwardConfigOf(env: Record<string, unknown>): ForwardConfig | null {
  const s = forwardSettingsOf(env);
  return s.state === "on" ? s.config : null;
}

/**
 * The agent's mounts as the forward may name them: by alias, the mount's plugin type (`raft`, `github`, `mcp`, …: a
 * plugin's id, from code) and its ordinal in the agent's mount list (by alias). An alias is a name someone typed, so it
 * is never sent; the type is, and the ordinal tells two mounts of one type apart within a run.
 */
export type MountsView = ReadonlyMap<string, { plugin: string; index: number }>;
const PLUGIN_TYPE = /^[a-z][a-z0-9_-]{0,31}$/;

/** The mounts as the `mounts` table holds them now (src/store/durable-object.ts), or none when it has no such table. */
export function mountsOf(sql: Sql, tenantId: string, agentId: string): MountsView {
  const out = new Map<string, { plugin: string; index: number }>();
  const has = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'mounts'").toArray().length > 0;
  if (!has) return out;
  const rows = sql.exec("SELECT alias, plugin FROM mounts WHERE tenant_id = ? AND agent_id = ? ORDER BY alias", tenantId, agentId).toArray();
  rows.forEach((r: any, index: number) => {
    if (typeof r.alias === "string" && typeof r.plugin === "string" && PLUGIN_TYPE.test(r.plugin)) out.set(r.alias, { plugin: r.plugin, index });
  });
  return out;
}
const NO_MOUNTS: MountsView = new Map();

/** A row as it goes on the wire: its outbox seq is always there, as the queue's key. */
export type WireRow = { seq: number } & Record<string, string | number | boolean | null>;

/** One lane: where it goes, which kinds, its own tables and log line, and how a row becomes its fields (null: unsendable). */
export type ForwardLane = {
  name: "github.refresh" | "agent.trace";
  path: string;
  kinds: readonly TraceKind[];
  /** Its tables' prefix: `<table>_staged`, `<table>_queue`, `<table>_state`, `<table>_log`. */
  table: string;
  log: string;
  map(r: TraceOutboxRow, env: ForwardEnv, mounts: MountsView): WireRow | null;
  /** The receiver answers a 2xx with `rejected: [{index, reason}]`, the rows of the batch it did not take. */
  rowRejections?: boolean;
};

// ---------------------------------------------------------------------------------------------------------------------
// The github.refresh lane: unchanged since #982.

/** The github.refresh lane's kinds. One entry, on purpose: widening it is a decision, not a side effect. */
export const FORWARD_KINDS: readonly TraceKind[] = ["github.refresh"];

/** Every field a forwarded github.refresh row has, and nothing else ever: the receiving table's columns. */
export const FORWARD_COLUMNS = ["at", "tenant_id", "agent_id", "seq", "env", "outcome", "scope", "connector_id", "mount", "why",
  "attempt", "stored", "reason_code"] as const;
export type ForwardRow = {
  at: string; tenant_id: string; agent_id: string; seq: number; env: ForwardEnv; outcome: string | null;
  scope: string | null; connector_id: string | null; mount: string | null; why: string | null;
  attempt: number | null; stored: boolean | null; reason_code: string | null;
};

/**
 * The receiver's shapes, mirrored so that what is sent is what it keeps. An id: letters, digits and `_ . : @ / | -`, at
 * most 128. A code: letters, digits and `_ . : -`, at most 64, case kept.
 */
const ID = /^[A-Za-z0-9_.:@/|-]{1,128}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const codeOf = (v: unknown): string | null => typeof v === "string" && CODE.test(v) ? v : null;
const idOf = (v: unknown): string | null => typeof v === "string" && ID.test(v) ? v : null;
const int = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

/**
 * One outbox row as the github-refresh receiver's columns, built field by field: nothing in the stored row rides along.
 * The same shapes as the agent.trace lane's (`codeOf`, `idOf`): `outcome`, `scope`, `why` and `reason_code` are codes,
 * `connector_id` an id, and a value that is not its shape is null, never sent as it was. A row whose `outcome` is not a
 * code is not sent at all (`GITHUB_REFRESH_LANE`), as the column is the row's point.
 */
export function forwardRow(r: TraceOutboxRow, env: ForwardEnv, mounts: MountsView = NO_MOUNTS): ForwardRow {
  const a = r.attrs ?? {};
  return {
    at: new Date(r.at).toISOString(), tenant_id: r.tenantId, agent_id: r.agentId, seq: r.seq, env, outcome: codeOf(r.status),
    // `mount`: the mount's type, never its alias (`MountsView`); null when the alias names no mount now.
    scope: codeOf(a.scope), connector_id: idOf(a.connectorId), mount: typeof a.mount === "string" ? mounts.get(a.mount)?.plugin ?? null : null,
    why: codeOf(a.why), attempt: int(a.attempt), stored: bool(a.stored), reason_code: codeOf(a.reasonCode),
  };
}

export const GITHUB_REFRESH_LANE: ForwardLane = {
  name: "github.refresh", path: "/api/external/github-refresh", kinds: FORWARD_KINDS, table: "ghr_forward",
  log: "github.refresh.forward", map: (r, env, mounts) => { const row = forwardRow(r, env, mounts); return row.outcome === null ? null : row; },
};

// ---------------------------------------------------------------------------------------------------------------------
// The agent.trace lane: Raft's `POST /api/external/antiproton-trace` (botiverse/slock#10530,
// the trace-upload worker's `antiprotonTrace.ts`, `ANTIPROTON_TRACE_KINDS`).

/*
 * The receiver's shapes: an id (`ID`) and a code (`CODE`), above, as both lanes check them; a count, a non-negative
 * safe integer; an int, a safe integer. A value that is not its field's shape is not sent; nothing is rewritten to fit.
 */

/**
 * A conversation id as this side mints one: `main` and a fresh context's `main.<n>` (cf/src/fresh-context.ts), a
 * subagent's `sub_<hex>`, an Agents API session's `sess_<hex>`, an isolated turn's `iso_<hex>`. None is ever made from
 * a channel, a person or a message; anything else is not sent.
 */
const SESSION = "(?:main(?:\\.[0-9]{1,6})?|(?:sub|sess|iso)_[0-9a-f]{8,40})";
const OPAQUE_SESSION = new RegExp(`^${SESSION}$`);
/** A turn's id (src/runtime/turn-timing.ts `turnIdFor`): `tt_<session>@<ms>`. */
const OPAQUE_TURN = new RegExp(`^tt_${SESSION}@[0-9]{1,16}$`);
/**
 * A span id, readable only in the shapes its writers mint: `<prefix>_<hex>` (a job `mj_`, an operation `op_`, a
 * session), a turn, `refused_<ms>` / `js_<ms>` / `turn_end:<ms>`, a provider's tool call id (`toolu_…`, `call_…`, `call_…|fc_…`: random
 * base62 the provider makes). A plugin row's `mount:<alias>` is sent as `mount` and `wake:<alias>:<ms>` as `wake:<ms>`:
 * the alias is a name someone typed, never sent (the row's `mount_index` says which mount). Any other span is left out:
 * `span_id` is optional to the receiver, which keys a row by its `seq`.
 */
const OPAQUE_SPAN = [
  /^[a-z]{1,8}_[0-9a-f]{8,64}$/, OPAQUE_TURN, /^(?:refused|js)_[0-9]{1,16}$/, /^turn_end:[0-9]{1,16}$/,
  /^(?:toolu|call|fc)_[A-Za-z0-9]{8,64}(?:\|fc_[A-Za-z0-9_-]{8,60})?$/,
];
function spanOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (/^mount:[^:]+$/.test(v)) return "mount";
  const wake = /^wake:[^:]+:([0-9]{1,16})$/.exec(v);
  if (wake) return `wake:${wake[1]}`;
  return OPAQUE_SPAN.some((re) => re.test(v)) ? v : null;
}

/**
 * `session`, `turn`, `task`: ids this side mints, accepted only in the shapes it mints them (`OPAQUE_SESSION`), so a
 * field the receiver types `id` can never carry a name: its id shape takes `alice` as readily as `sess_1f…`.
 */
type FieldType = "id" | "code" | "count" | "int" | "bool" | "flag" | "session" | "turn" | "task" | "mount" | "check" | "minted"
  | readonly string[];
/**
 * Where a field comes from: an attr by name, the row's own `status` or `ms`, or (`rest`) the sum of every count attr
 * named `<prefix><word>` but those `known` names: a notify's drops by a reason no field of its own carries.
 */
type Source = string | { row: "status" | "ms" } | { rest: string; known: readonly string[] };
/** wire name → [source, type]. */
type FieldSpec = Readonly<Record<string, readonly [Source, FieldType]>>;

const STATUS = { row: "status" } as const;
const MS = { row: "ms" } as const;

/** A check's id as Raft mints it and the plugin accepts it (src/plugins/raft-assistant-check.ts `CHECK_ID`). */
const CHECK_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
/** An id this side mints as `<prefix>_<hex>` (a rebuild decision's `rb_…`, src/runtime/rebuild.ts). */
const MINTED = /^[a-z]{1,8}_[0-9a-f]{8,64}$/;

/** The notify drop reasons that are fields of their own (`dropped_<reason>`); any other is summed into `dropped_other`. */
const NOTIFY_DROPS = ["already_told", "rule_mute", "decisions_in_brief", "not_confirmed", "not_in_check", "other"] as const;
/** Raft's counts on a check's wake (src/plugins/raft-assistant-check.ts `CHECK_COUNT_KEYS`), each a field by its own name. */
const CHECK_COUNTS = ["conversations", "items", "truncated", "told", "skipped", "muted", "digest", "always", "dm", "mention", "thread", "named",
  "default_out", "night_held"] as const;
/** A contact rule's `<effect>_<scope>` counts on a rules row (src/plugins/raft-assistant-rules.ts `rulesAttrs`). */
const RULE_COUNTS = ["mute", "always", "digest"].flatMap((effect) => ["channel", "thread", "person", "kind", "dms", "legacy"].map((scope) => `${effect}_${scope}`));
const counts = (names: readonly string[]): Record<string, readonly [Source, FieldType]> =>
  Object.fromEntries(names.map((n) => [n, [n, "count"] as const]));

/**
 * Per kind, every field an `agent.trace` row carries beyond its envelope, and where each comes from: the receiver's
 * names and types (`ANTIPROTON_TRACE_KINDS`), and nothing else. A field the receiver does not keep yet is listed in
 * test/trace-forward.ts `PROPOSED` (the table sent to the receiving side); until it lands there the receiver drops that
 * field and keeps the row. Deliberately absent: tool.call's `error`
 * (a tool's own sentence, redacted but free text), its `name` and `callId`; model.call's `limit` (a sentence) and
 * `prefix` (an object); every mount alias (tool.call's `mount` is the mount's type, `MountsView`); turn.stop's
 * `errorClass` (a sentence for people; `trigger` says the same); turn.timing's raw instants; rebuild.outcome's `rule` (a
 * name from the agent's rebuild policy, which an operator writes) and `hitRate` (a fraction: `cache_read` / `input` says
 * it). Attrs written that the receiver has no field for, so not sent: tool.refused's `task`, a wake's `inbox_lagging`,
 * `rules_total`, `person_rule_unenforced`, `quiet_custom` and the legacy check's other rule counts (`muted_<scope>`,
 * `own_dm`, `anytime_night`, `default_chatter`, `chatter_unfiltered`), turn_ended's `snapshotMismatches`.
 *
 * An id-typed field carries an opaque id or a name from code or configuration (a tool's, a model's, a mount's TYPE), never a
 * name a person or a conversation has: where the receiver takes `id` or `code` and this side knows the vocabulary, the
 * field is that list (`by`, `trigger`, `outcome`, `stop_reason`, `reason`, …); a session, turn or task must be in a shape this side
 * mints, a check's id in the shape Raft mints it (`CHECK_ID`). Some id and code fields carry a value chosen outside this
 * code, by Raft or an MCP server (a tool's name, tool.call's `error_code`, a `check_id`, a notify's or rules row's
 * `code`): those are only shape-checked. Two receiver fields are left unfilled because their value is whatever the model wrote, which can be any word:
 * model.call's `first_tool` (the first tool the answer asked for, as the model spelled it) and tool.refused's `tool`
 * (the name a refused call was made by, which by definition named no tool there is).
 */
export const AGENT_TRACE_FIELDS: Readonly<Partial<Record<TraceKind, FieldSpec>>> = {
  "model.call": {
    model: ["model", "id"], stop_reason: [STATUS, ["stop", "length", "toolUse", "error", "aborted"]], input: ["input", "count"], output: ["output", "count"],
    cache_read: ["cacheRead", "count"], cache_write: ["cacheWrite", "count"], reasoning: ["reasoning", "count"],
    turn: ["turn", "turn"], session: ["session", "session"],
  },
  "model.attempt": {
    attempt: ["attempt", "count"], phase: ["phase", ["take", "admit", "call", "deliver"]], outcome: ["outcome", ["http", "timeout", "transport_error"]],
    http_status: ["httpStatus", "count"], error_class: ["errorClass", "id"], total_ms: [MS, "count"],
    provider_ms: ["providerMs", "count"], model: ["model", "id"],
  },
  "tool.call": {
    tool: ["tool", "id"], mount: ["mount", "mount"], task: ["task", "task"], run_ms: ["runMs", "count"], exit_code: ["exitCode", "int"],
    denied: ["denied", "bool"], error_code: ["errorCode", "code"], http_status: ["httpStatus", "count"],
  },
  "tool.refused": {
    code: ["code", "code"], by: ["by", ["gateway", "run_js", "executor"]], from: ["from", ["model", "program"]],
  },
  "turn.timing": {
    inbound_to_start_ms: ["inboundToStartMs", "count"], start_to_first_job_ms: ["startToFirstJobMs", "count"],
    model_ms: ["modelMs", "count"], between_jobs_ms: ["betweenJobsMs", "count"], tool_ms: ["toolMs", "count"],
    last_answer_to_reply_ms: ["lastAnswerToReplyMs", "count"], model_jobs: ["modelJobs", "count"], tools: ["tools", "count"],
    messages: ["messages", "count"], first_call_prompt_tokens: ["firstCallPromptTokens", "count"],
    first_call_cached_tokens: ["firstCallCachedTokens", "count"], client_wait_ms: ["clientWaitMs", "count"],
    client_pauses: ["clientPauses", "count"], prep_ms: ["prepMs", "count"],
  },
  "turn.stop": {
    trigger: ["trigger", ["provider_stop", "admin_cancel", "delete"]], turn: ["turn", "turn"],
  },
  // cf/src/runtime.ts `#turnEndsUnrecorded`.
  "turn.end_unrecorded": {
    stage: ["stage", ["read", "record"]], error_class: ["error_class", "id"],
  },
  // src/runtime/rebuild.ts `settleRebuildOutcome`: the row's span is the answering job, its status the agreement.
  "rebuild.outcome": {
    decision: ["decision", "minted"], trigger: ["trigger", ["window", "cold-wake", "operator"]], strategy: ["strategy", ["summary", "briefing"]],
    agreement: ["agreement", ["agree", "false-cold", "false-warm", "expected-cold", "unmeasured"]],
    would_rebuild: ["wouldRebuild", "bool"], predicted_cold: ["predictedCold", "bool"], expected_cold: ["expectedCold", "bool"],
    measured_cold: ["measuredCold", "bool"], input: ["input", "count"], cache_read: ["cacheRead", "count"],
    since_decision_ms: ["sinceDecisionMs", "count"],
  },
  // src/plugins/raft-assistant.ts `record` (this file's own check, and Raft's: `raftCheckWake`, `raftIdleWake`),
  // `refusedCheck`; cf/src/runtime.ts's wake of a pd assistant (`reason: engine_pd_unsupported`).
  "raft.assistant_wake": {
    result: [STATUS, ["skipped_empty", "skipped_filtered", "invoked", "unreadable", "paused", "night_deferred", "failed", "inbox_lagging",
      "check_refused", "skipped_no_check"]],
    trigger: ["trigger", ["doorbell", "brief"]], candidates: ["candidates", "count"],
    seen: ["seen", "count"], unreadable: ["unreadable", "count"], lag_retry: ["lagRetry", "count"], caught_up: ["caught_up", "bool"],
    caught_up_via: ["caught_up_via", ["unread", "all", "mixed"]], caught_up_rule: ["caught_up_rule", ["seq", "time"]],
    held: ["held", "count"], said: ["said", "count"],
    // The receiver types it a count; the plugin writes `true` (src/plugins/raft-assistant.ts `lag`), so it is sent as 1.
    inbox_lagging_gave_up: ["inbox_lagging_gave_up", "flag"],
    // A failed wake's code (`wakeFailureAttrs`) and the HTTP status of the refused read.
    error_code: ["error", ["inbox_refused", "inbox_shape", "not_enabled", "unexpected"]], http_status: ["status", "count"],
    check_id: ["check_id", "check"], raft_check: ["raft_check", "bool"],
    reason: ["reason", ["malformed", "version", "instruction_too_large", "no_notify", "raft_check_off", "engine_pd_unsupported"]],
    instruction_bytes: ["instruction_bytes", "count"], tools_offered: ["tools_offered", "count"], tools_dropped: ["tools_dropped", "count"],
    placeholders_unknown: ["placeholders_unknown", "count"], placeholders_unoffered: ["placeholders_unoffered", "count"],
    // Raft's counts on a check's wake; `conversations`, `told`, `muted`, `digest`, `always`, `dm` and `night_held` are
    // the legacy check's counts by the same names too.
    ...counts(CHECK_COUNTS),
  },
  // src/plugins/raft-assistant.ts `notifyAttrs` (this file's own check) and `notifyRaft` (Raft's).
  "raft.assistant_notify": {
    state: ["notifyState", ["sent", "duplicate", "nothing_to_send", "kept_for_brief", "not_sent", "unknown"]],
    items_in: ["given", "count"], items_sent: ["sent", "count"], held_back: ["held_back", "count"], kept_for_brief: ["kept_for_brief", "count"],
    dropped: ["dropped", "count"], dropped_already_told: ["dropped_already_told", "count"],
    // The receiver's name for a drop by a mute rule (`dropCategory`'s `rule_mute`).
    dropped_rule: ["dropped_rule_mute", "count"],
    dropped_decisions_in_brief: ["dropped_decisions_in_brief", "count"], dropped_not_confirmed: ["dropped_not_confirmed", "count"],
    dropped_not_in_check: ["dropped_not_in_check", "count"],
    dropped_other: [{ rest: "dropped_", known: NOTIFY_DROPS.filter((r) => r !== "other").map((r) => `dropped_${r}`) }, "count"],
    check_id: ["check_id", "check"], trigger: ["trigger", ["doorbell", "brief"]], forwarded: ["forwarded", "count"],
    code: ["code", "code"], http_status: ["http_status", "count"],
  },
  // src/plugins/raft-assistant.ts `pushBriefImport` (`import_*`) and `checkEnded` (`turn_ended`).
  "raft.assistant_check": {
    check_id: ["check_id", "check"], trigger: ["trigger", ["doorbell", "brief"]], outcome: ["outcome", ["completed", "failed", "cancelled"]],
    error_code: ["error_code", "code"], attempts: ["attempts", "count"], http_status: ["http_status", "count"], code: ["code", "code"],
  },
  // src/plugins/raft-assistant.ts `noteToldInChat` / `toldToRaft` (`told`, `told_failed`) and `replyFallback`.
  "raft.assistant_chat_told": {
    refs: ["refs", "count"], told: ["told", "count"], skipped: ["skipped", "count"], forwarded: ["forwarded", "count"],
    http_status: ["http_status", "count"], code: ["code", "code"], reply_fallback: ["reply_fallback", "count"],
    result: ["result", ["sent", "held", "failed"]], failed_turn: ["failed_turn", "count"],
  },
  // src/plugins/raft-assistant.ts `traceRules` (with src/plugins/raft-assistant-rules.ts `rulesAttrs`) and `preferencesRaft`.
  "raft.assistant_rules": {
    action: ["action", ["add", "mute", "unmute", "remove", "list", "quiet", "timezone", "other"]],
    // `listed`, `added`, `removed_partial`, … or `refused:<code>`, every code from code or Raft's (`codeOf`).
    result: ["result", "code"], effect: ["effect", ["mute", "always", "digest"]], scope: ["scope", ["channel", "thread", "person", "kind", "dms"]],
    via: ["via", ["raft"]], removed: ["removed", "count"], left: ["left", "count"], code: ["code", "code"], rules_total: ["rules_total", "count"],
    ...counts(RULE_COUNTS),
  },
  // src/plugins/raft-assistant.ts `sendAsOwner`.
  "raft.assistant_send_as_owner": {
    // `sent`, `uncertain`, `failed` or `refused:<code>` (`SendResult`).
    result: ["result", "code"], target_kind: ["target_kind", ["message", "channel", "dm", "channel_id", "other"]],
    in_thread: ["in_thread", "bool"], chars: ["chars", "count"], http_status: ["http_status", "count"],
  },
  "raft.turn_ended": {
    result: [STATUS, ["settled", "skipped", "unreadable"]], reason: ["reason", "code"], conversations: ["targets", "count"],
    outcome: ["outcome", ["completed", "interrupted", "failed"]],
  },
};

/** The agent.trace lane's kinds: exactly those with fields above. */
export const AGENT_TRACE_KINDS = Object.keys(AGENT_TRACE_FIELDS) as TraceKind[];

const VERDICTS = ["ok", "failed", "blocked", "cancelled"] as const;

const countOf = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const n = Math.round(v);
  return Number.isSafeInteger(n) ? n : null;
};
const intOf = (v: unknown): number | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return Number.isSafeInteger(n) ? n : null;
};

function fieldOf(v: unknown, type: FieldType, mounts: MountsView): string | number | boolean | null {
  if (Array.isArray(type)) return typeof v === "string" && type.includes(v) ? v : null;
  switch (type) {
    case "id": return idOf(v);
    case "code": return codeOf(v);
    case "count": return countOf(v);
    case "int": return intOf(v);
    case "bool": return typeof v === "boolean" ? v : null;
    // A boolean the receiver counts: 1 or 0.
    case "flag": return typeof v === "boolean" ? (v ? 1 : 0) : null;
    case "session": return typeof v === "string" && OPAQUE_SESSION.test(v) ? v : null;
    case "turn": return typeof v === "string" && OPAQUE_TURN.test(v) ? v : null;
    case "task": return typeof v === "string" && OPAQUE_SESSION.test(v) ? v : null;
    // An alias in, the mount's type out (`MountsView`); nothing when the alias names no mount now.
    case "mount": return typeof v === "string" ? mounts.get(v)?.plugin ?? null : null;
    case "check": return typeof v === "string" && CHECK_ID.test(v) ? v : null;
    case "minted": return typeof v === "string" && MINTED.test(v) ? v : null;
  }
  return null;
}

/** The sum of the count attrs `<prefix><word>` other than `known`, or undefined when there are none. */
function restOf(a: Record<string, unknown>, prefix: string, known: readonly string[]): number | undefined {
  let sum: number | undefined;
  for (const [k, v] of Object.entries(a)) {
    if (!k.startsWith(prefix) || known.includes(k) || !/^[a-z0-9_]+$/.test(k.slice(prefix.length))) continue;
    const n = countOf(v);
    if (n !== null) sum = (sum ?? 0) + n;
  }
  return sum;
}

/**
 * One outbox row as an `agent.trace` row: the envelope (`seq`, `at`, `kind`, `tenant_id`, `agent_id`, `env`, and when
 * they fit their shapes `span_id`, `status`, `verdict`, `ms`), then the kind's fields from AGENT_TRACE_FIELDS, each
 * checked; a value that does not pass is left out, never sent as it was. `seq` is the row's identity at the receiver
 * (tenant_id:agent_id:seq). Null, and nothing sent, when the row's kind is not this lane's or its tenant or agent is not
 * an id (the receiver would reject the row).
 */
export function agentTraceRow(r: TraceOutboxRow, env: ForwardEnv, mounts: MountsView = NO_MOUNTS): WireRow | null {
  const spec = Object.prototype.hasOwnProperty.call(AGENT_TRACE_FIELDS, r.kind) ? AGENT_TRACE_FIELDS[r.kind] ?? null : null;
  if (!spec) return null;
  const tenant = idOf(r.tenantId), agent = idOf(r.agentId);
  if (!tenant || !agent || !Number.isFinite(r.at) || !Number.isSafeInteger(r.seq) || r.seq < 0) return null;
  const a = r.attrs ?? {};
  const out: WireRow = { seq: r.seq, at: new Date(r.at).toISOString(), kind: r.kind, tenant_id: tenant, agent_id: agent, env };
  const span = spanOf(r.spanId);
  if (span) out.span_id = span;
  const status = codeOf(r.status);
  if (status) out.status = status;
  if ((VERDICTS as readonly string[]).includes(r.verdict)) out.verdict = r.verdict;
  const ms = countOf(r.ms);
  if (ms !== null) out.ms = ms;
  for (const [name, [source, type]] of Object.entries(spec)) {
    const raw = typeof source === "string" ? (Object.prototype.hasOwnProperty.call(a, source) ? a[source] : undefined)
      : "row" in source ? r[source.row] : restOf(a, source.rest, source.known);
    const v = fieldOf(raw, type, mounts);
    if (v !== null) out[name] = v;
  }
  // Which of the agent's mounts the row is about (a tool's, a plugin's own row), as its ordinal: never the alias.
  // Not a field the receiver keeps yet; it drops it until it does.
  const m = typeof a.mount === "string" ? mounts.get(a.mount) : undefined;
  if (m) out.mount_index = m.index;
  return out;
}

export const AGENT_TRACE_LANE: ForwardLane = {
  name: "agent.trace", path: "/api/external/antiproton-trace", kinds: AGENT_TRACE_KINDS, table: "atr_forward",
  log: "trace.forward", map: agentTraceRow, rowRejections: true,
};

/** Every lane, in the order a pass runs them. */
export const FORWARD_LANES: readonly ForwardLane[] = [GITHUB_REFRESH_LANE, AGENT_TRACE_LANE];

// ---------------------------------------------------------------------------------------------------------------------
// The engine, the same for every lane.

/**
 * THE REQUEST, in one place: `POST <base><lane path>`, `Authorization: Bearer <token>`, a JSON body `{"rows":[...]}`
 * fully buffered so its length is known before it is sent. This is the receiving side's contract (Raft's trace-upload
 * worker); a change to it is a change to this function and its test (test/trace-forward.ts).
 */
export function ingestRequest(cfg: ForwardConfig, rows: readonly object[], lane: ForwardLane = GITHUB_REFRESH_LANE):
  { url: string; init: RequestInit & { body: Uint8Array } } {
  const body = new TextEncoder().encode(JSON.stringify({ rows }));
  return {
    url: `${cfg.url}${lane.path}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength), authorization: `Bearer ${cfg.token}` },
      body,
    },
  };
}

const tablesOf = (lane: ForwardLane) => ({
  staged: `${lane.table}_staged`, queue: `${lane.table}_queue`, state: `${lane.table}_state`, log: `${lane.table}_log`,
});
const ddl = (lane: ForwardLane) => {
  const t = tablesOf(lane);
  return {
    cursor: `CREATE TABLE IF NOT EXISTS ${t.staged} (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)`,
    queue: `CREATE TABLE IF NOT EXISTS ${t.queue} (seq INTEGER PRIMARY KEY, row TEXT NOT NULL)`,
    state: `CREATE TABLE IF NOT EXISTS ${t.state} (id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, next_at INTEGER NOT NULL)`,
    /** Every outcome but an accepted batch: `reason` one of FORWARD_REASONS, `status` the HTTP status when there was one,
     *  and on a lane with row rejections `detail`, the receiver's reason for a `rejected` row. */
    log: `CREATE TABLE IF NOT EXISTS ${t.log} (at INTEGER NOT NULL, reason TEXT NOT NULL, status INTEGER, rows INTEGER NOT NULL` +
      `${lane.rowRejections ? ", detail TEXT" : ""})`,
  };
};
/** Dropped: `too-large`, `schema`, `rejected`, `lost`, `unsendable`. Kept for a later pass: `auth_or_off`, `unavailable`. */
export const FORWARD_REASONS = ["too-large", "schema", "rejected", "lost", "unsendable", "auth_or_off", "unavailable"] as const;
export type ForwardReason = (typeof FORWARD_REASONS)[number];

/** A lane's cursor over the outbox: what it has staged. */
export function forwardCursor(sql: Sql, lane: ForwardLane = GITHUB_REFRESH_LANE): number {
  const t = tablesOf(lane);
  sql.exec(ddl(lane).cursor);
  const known = sql.exec(`SELECT through_seq FROM ${t.staged} WHERE id = 1`).toArray()[0];
  return known ? Number(known.through_seq) : 0;
}

function note(sql: Sql, lane: ForwardLane, at: number, reason: ForwardReason, status: number | null, rows: number, tenantId: string, agentId: string,
  detail: string | null = null) {
  const t = tablesOf(lane);
  sql.exec(ddl(lane).log);
  sql.exec(`DELETE FROM ${t.log} WHERE at < ?`, at - DROPS_KEEP_MS);
  if (lane.rowRejections) sql.exec(`INSERT INTO ${t.log}(at, reason, status, rows, detail) VALUES (?, ?, ?, ?, ?)`, at, reason, status, rows, detail);
  else sql.exec(`INSERT INTO ${t.log}(at, reason, status, rows) VALUES (?, ?, ?, ?)`, at, reason, status, rows);
  const kept = reason === "auth_or_off" || reason === "unavailable";
  logEvent(lane.log, { tenantId, agentId, result: kept ? "kept" : "dropped", reason, status: status ?? undefined, rows, ...(detail ? { detail } : {}) });
}

/** A receiver's reason for one rejected row, as it is counted: its own code when it is one, else `other`. */
const REJECT_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The rows of a batch a 2xx did not take, by the receiver's reason: `rejected: [{index, reason}]`, each index once and
 * inside the batch. An answer without the list, or not JSON, rejected nothing. Read within `ms` and at most 64 KiB, as
 * the request was: a body that does not come in time is read as rejecting nothing, since the status already said 2xx.
 */
async function rejectionsOf(res: Response, size: number, ms: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      res.text(),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), ms); }),
    ]);
    if (!text || text.length > 64 * 1024) return out;
    const list = (JSON.parse(text) as { rejected?: unknown })?.rejected;
    if (!Array.isArray(list)) return out;
    const seen = new Set<number>();
    for (const r of list) {
      const index = (r as { index?: unknown })?.index, reason = (r as { reason?: unknown })?.reason;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= size || seen.has(index)) continue;
      seen.add(index);
      const why = typeof reason === "string" && REJECT_REASON.test(reason) ? reason : "other";
      out.set(why, (out.get(why) ?? 0) + 1);
    }
  } catch { /* not the answer's shape: nothing rejected */ }
  finally { clearTimeout(timer); }
  return out;
}

/**
 * Copy a lane's allowlisted rows past its cursor into its queue and move the cursor. Local only. Returns the cursor,
 * which is a prune hold for the export.
 */
export function stageForward(sql: Sql, cfg: ForwardConfig, tenantId: string, agentId: string, now: () => number = Date.now,
  lane: ForwardLane = GITHUB_REFRESH_LANE): number {
  const t = tablesOf(lane), d = ddl(lane);
  const from = forwardCursor(sql, lane);
  const { rows, through } = pendingTrace(sql, from, STAGE_READ_MAX);
  const mounts = rows.length ? mountsOf(sql, tenantId, agentId) : NO_MOUNTS;
  sql.exec(d.queue);
  let unsendable = 0;
  for (const r of rows) {
    if (!lane.kinds.includes(r.kind)) continue;
    const wire = lane.map(r, cfg.env, mounts);
    if (!wire) { unsendable++; continue; }
    sql.exec(`INSERT OR IGNORE INTO ${t.queue}(seq, row) VALUES (?, ?)`, r.seq, JSON.stringify(wire));
  }
  if (through > from) {
    sql.exec(`INSERT INTO ${t.staged}(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq`, through);
  }
  if (unsendable) note(sql, lane, now(), "unsendable", null, unsendable, tenantId, agentId);
  const queued = Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t.queue}`).toArray()[0]?.n ?? 0);
  if (queued > FORWARD_QUEUE_MAX) {
    const over = queued - FORWARD_QUEUE_MAX;
    sql.exec(`DELETE FROM ${t.queue} WHERE seq IN (SELECT seq FROM ${t.queue} ORDER BY seq LIMIT ?)`, over);
    note(sql, lane, now(), "lost", null, over, tenantId, agentId);
  }
  return Math.max(from, through);
}

/** `stopped`: the pass's budget ended the lane's sending with rows still queued (`FORWARD_PASS_MS`); not a failure. */
export type ForwardResult = { sent: number; dropped: number; kept: number; error: string | null; skipped?: "backoff"; stopped?: "budget" };

/** What a status does to the batch that got it. */
export function answerOf(status: number): "accepted" | "split" | ForwardReason {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 413) return "split";
  if (status === 400 || status === 422) return "schema";
  if (status === 401 || status === 403 || status === 404) return "auth_or_off";
  if (status === 408 || status === 429 || status >= 500 || status < 200) return "unavailable";
  if (status >= 400) return "rejected";
  return "unavailable";
}

/**
 * One request, given at most `ms`: past that its signal aborts and the returned promise rejects with a `TimeoutError`,
 * whether or not `fetchFn` honours the signal, so a hung receiver costs the pass `ms` and no more.
 */
async function fetchWithin(fetchFn: Fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new DOMException(`no answer within ${ms} ms`, "TimeoutError");
      ctl.abort(e); reject(e);
    }, ms);
  });
  try { return await Promise.race([fetchFn(url, { ...init, signal: ctl.signal }), expired]); }
  finally { clearTimeout(timer); }
}

/** The oldest queued rows that fit one request: at most FORWARD_BATCH_MAX, and FORWARD_BATCH_BYTES of body (always one). */
function nextBatch(sql: Sql, lane: ForwardLane): WireRow[] {
  const raw = sql.exec(`SELECT row FROM ${tablesOf(lane).queue} ORDER BY seq LIMIT ?`, FORWARD_BATCH_MAX).toArray()
    .map((r: any) => String(r.row));
  const out: WireRow[] = [];
  let bytes = '{"rows":[]}'.length;
  for (const text of raw) {
    const size = new TextEncoder().encode(text).byteLength + (out.length ? 1 : 0);
    if (out.length && bytes + size > FORWARD_BATCH_BYTES) break;
    out.push(JSON.parse(text) as WireRow);
    bytes += size;
  }
  return out;
}

/**
 * Send a lane's queue, oldest first, until it is empty, the endpoint fails, or `budget` is spent (`FORWARD_PASS_MS`).
 * Never throws: a failure is the return value's `error`, and the rows it concerned are still queued; rows the budget
 * left are still queued too. `timeoutMs` bounds each request (FORWARD_TIMEOUT_MS; a test passes a short one), within
 * what the budget has left. `budget` is read on the real clock (Date.now), whatever `now` says: `now` dates the
 * backoff and the log, which a test moves.
 */
export async function sendForward(
  sql: Sql, cfg: ForwardConfig, tenantId: string, agentId: string, fetchFn: Fetch = fetch, now: () => number = Date.now,
  timeoutMs: number = FORWARD_TIMEOUT_MS, lane: ForwardLane = GITHUB_REFRESH_LANE,
  budget: ForwardBudget = { requests: FORWARD_PASS_REQUESTS, until: Date.now() + FORWARD_PASS_MS },
): Promise<ForwardResult> {
  const out: ForwardResult = { sent: 0, dropped: 0, kept: 0, error: null };
  const t = tablesOf(lane), d = ddl(lane);
  // The token never goes over anything but https, whoever built the config (`forwardSettingsOf` refuses it first).
  if (!/^https:\/\//i.test(cfg.url)) return { ...out, error: "config: url_not_https" };
  try {
    sql.exec(d.queue); sql.exec(d.state);
    const state = sql.exec(`SELECT failures, next_at FROM ${t.state} WHERE id = 1`).toArray()[0];
    const failures = state ? Number(state.failures) : 0;
    const queued = () => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t.queue}`).toArray()[0]?.n ?? 0);
    if (state && Number(state.next_at) > now()) return { ...out, kept: queued(), skipped: "backoff" };
    const forget = (rows: readonly WireRow[]) => { for (const r of rows) sql.exec(`DELETE FROM ${t.queue} WHERE seq = ?`, r.seq); };

    let requests = 0;
    /**
     * One batch, split on 413. `failed`: the endpoint failed, and this pass stops with the backoff. `budget`: the pass
     * may send no more (`ForwardBudget`), and this pass stops without one. Each request, a split's included, counts.
     */
    const post = async (rows: readonly WireRow[]): Promise<"ok" | "failed" | "budget"> => {
      const left = budget.until - Date.now();
      if (requests >= budget.requests || left < FORWARD_REQUEST_MIN_MS) return "budget";
      requests++;
      const ms = Math.min(timeoutMs, left);
      const { url, init } = ingestRequest(cfg, rows, lane);
      let status: number;
      let rejections = new Map<string, number>();
      try {
        const res = await fetchWithin(fetchFn, url, init, ms);
        status = res.status;
        if (lane.rowRejections && status >= 200 && status < 300) {
          rejections = await rejectionsOf(res, rows.length, Math.min(timeoutMs, Math.max(FORWARD_REQUEST_MIN_MS, budget.until - Date.now())));
        }
        else try { await res.body?.cancel(); } catch { /* nothing to read */ }
      } catch (e) {
        // A timeout lands here too (`network: TimeoutError`): no answer, the rows kept, the backoff applies.
        // The error's name, not its message: a message can carry the request, and neither the URL nor the token is logged.
        out.error = `network: ${String((e as { name?: unknown })?.name ?? "error").slice(0, 40)}`;
        note(sql, lane, now(), "unavailable", null, rows.length, tenantId, agentId);
        return "failed";
      }
      const answer = answerOf(status);
      if (answer === "accepted") {
        // The whole batch leaves the queue: the rows the receiver took, and the ones it said it never will.
        forget(rows);
        let refused = 0;
        for (const [why, n] of rejections) { refused += n; note(sql, lane, now(), "rejected", status, n, tenantId, agentId, why); }
        out.sent += rows.length - refused; out.dropped += refused;
        return "ok";
      }
      if (answer === "split" && rows.length > 1) {
        const half = Math.ceil(rows.length / 2);
        const first = await post(rows.slice(0, half));
        return first === "ok" ? await post(rows.slice(half)) : first;
      }
      if (answer === "auth_or_off" || answer === "unavailable") {
        out.error = `${answer}: http-${status}`;
        note(sql, lane, now(), answer, status, rows.length, tenantId, agentId);
        return "failed";
      }
      const reason: ForwardReason = answer === "split" ? "too-large" : answer;
      forget(rows); out.dropped += rows.length;
      note(sql, lane, now(), reason, status, rows.length, tenantId, agentId);
      return "ok";
    };

    let step: "ok" | "failed" | "budget" = "ok";
    while (step === "ok") {
      const batch = nextBatch(sql, lane);
      if (!batch.length) break;
      step = await post(batch);
    }
    out.kept = queued();
    if (step === "budget" && out.kept) out.stopped = "budget";
    if (step !== "failed") {
      if (failures) sql.exec(`DELETE FROM ${t.state} WHERE id = 1`);
    } else {
      const n = failures + 1;
      const wait = Math.min(FORWARD_BACKOFF_MAX_MS, FORWARD_BACKOFF_BASE_MS * 2 ** (n - 1));
      sql.exec(`INSERT INTO ${t.state}(id, failures, next_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET failures = excluded.failures, next_at = excluded.next_at`,
        n, now() + wait);
      logEvent(lane.log, { tenantId, agentId, result: "retry", reason: out.error, failures: n, waitMs: wait, kept: out.kept });
    }
    if (out.sent) logEvent(lane.log, { tenantId, agentId, result: "sent", rows: out.sent });
  } catch (e) {
    out.error = `local: ${String((e as { message?: unknown })?.message ?? e).slice(0, 120)}`;
  }
  return out;
}

/**
 * The alarm pass's two halves of the forward: `before`, around the R2 export, stages every lane and returns the export's
 * prune hold, the lowest lane cursor (null when forwarding is off); `after` sends each lane and returns each lane's
 * outcome, within one FORWARD_PASS_MS for all the lanes together (`ForwardBudget`). The pass runs `after` once it has
 * armed its next alarm (cf/src/index.ts `alarm`), so a slow receiver never decides when the agent next runs and costs
 * its next step at most the budget. Neither throws. A lane whose stage fails holds the export at its unmoved cursor, so
 * the next pass stages the same rows. `lanes`: which lanes run (all of them; a test narrows it); `passMs`: the budget
 * (FORWARD_PASS_MS; a test passes its own).
 */
export function forwardPass(env: Record<string, unknown>, sql: Sql, tenantId: string, agentId: string, fetchFn: Fetch = fetch,
  lanes: readonly ForwardLane[] = FORWARD_LANES, passMs: number = FORWARD_PASS_MS) {
  const cfg = forwardConfigOf(env);
  return {
    before(): number | null {
      if (!cfg || !lanes.length) return null;
      let hold = Infinity;
      for (const lane of lanes) {
        let through: number;
        try { through = stageForward(sql, cfg, tenantId, agentId, Date.now, lane); }
        catch (e) {
          console.warn(`${lane.name} forward stage failed for ${agentId}: ${String((e as { message?: unknown })?.message ?? e).slice(0, 200)}`);
          try { through = forwardCursor(sql, lane); } catch { through = 0; }
        }
        hold = Math.min(hold, through);
      }
      return hold;
    },
    async after(): Promise<Partial<Record<ForwardLane["name"], ForwardResult>> | null> {
      if (!cfg) return null;
      const out: Partial<Record<ForwardLane["name"], ForwardResult>> = {};
      const until = Date.now() + passMs;
      for (const lane of lanes) {
        out[lane.name] = await sendForward(sql, cfg, tenantId, agentId, fetchFn, Date.now, FORWARD_TIMEOUT_MS, lane,
          { requests: FORWARD_PASS_REQUESTS, until });
      }
      return out;
    },
  };
}
