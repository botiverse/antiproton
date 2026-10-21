/**
 * Trace outbox rows forwarded to Raft's trace-upload worker, on two lanes, each with its own route, allowlist, queue,
 * cursor, backoff and counts (`FORWARD_LANES`):
 * - `github.refresh` (`GITHUB_REFRESH_LANE`): a renewal's outcome, alerted on from the trace rather than from Workers
 *   Logs, which drops an object's lines (#980; docs/runbook.md, "Logs and what an object did"), to
 *   `/api/external/github-refresh`.
 * - `agent.trace` (`AGENT_TRACE_LANE`): the kinds that say how a turn went (model calls and failed attempts, tool calls
 *   and refusals, turn timing and stops, the assistant's wakes and notifies, Raft's answer to a turn's end), so they can
 *   be read next to Raft's own telemetry, to `/api/external/antiproton-trace`.
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
 *   waiting on a backoff is sent on the first alarm pass after the backoff, whenever the agent next has one.
 *
 * What an answer does (agreed with the receiving side). Every outcome but a 2xx is counted in the lane's `<lane>_log`
 * with a fixed reason and the status, and logged as the lane's line (`github.refresh.forward`, `trace.forward`):
 * - 2xx: accepted, duplicates included; the rows leave the queue.
 * - 413: the batch is split in half and each half sent, down to one row; a single row still too large is dropped
 *   (`too-large`).
 * - 400, 422: the receiver cannot take the batch's shape, which a resend will not mend: it is dropped (`schema`) and the
 *   queue moves on rather than wedging behind it.
 * - 401, 403, 404: the token is wrong or expired, or the receiver is switched off (it answers 404 while it has no token
 *   of its own, or has no such route yet), none of which says anything about the rows: the lane pauses (`auth_or_off`),
 *   the rows stay, and the backoff below applies, so the backlog drains once either side is mended.
 * - 408, 429, 5xx, or no answer: the rows stay (`unavailable`) and the backoff applies. No answer includes one that
 *   has not come within FORWARD_TIMEOUT_MS: every request, each half of a 413 split included, is aborted then, since
 *   the send runs inside the agent's alarm pass and a receiver that hangs would otherwise hold that pass open. A
 *   timeout ends the lane's sending for the pass like any other failure: no later batch is tried until the backoff is over.
 * - any other 4xx: dropped (`rejected`), as a resend of the same request gets the same.
 * The backoff: FORWARD_BACKOFF_BASE_MS, doubling to FORWARD_BACKOFF_MAX_MS, cleared by the next success.
 * A resent row is the same row. A `github.refresh` row's identity is (tenant_id, agent_id, seq), the outbox's own; an
 * `agent.trace` row carries the same `seq`, and the receiver keys it by (tenant_id, agent_id, span_id, kind[, attempt]).
 * A row the receiver would refuse whole (an id not shaped like one) is not sent but counted (`unsendable`) at staging,
 * since one such row would make the receiver refuse its whole batch.
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
export const FORWARD_BACKOFF_BASE_MS = 60_000;
export const FORWARD_BACKOFF_MAX_MS = 60 * 60_000;
/** How long a drop stays on record. */
const DROPS_KEEP_MS = 7 * 24 * 60 * 60_000;

export type ForwardConfig = { url: string; token: string; env: ForwardEnv };

const setting = (env: Record<string, unknown>, name: string): string =>
  typeof env[name] === "string" ? (env[name] as string).trim() : "";

/**
 * The deployment's forwarding, or null when it is off. Off unless BOTH the URL and the token are set, and DEPLOYMENT_ENV
 * names which deployment this is (cf/wrangler.jsonc, cf/wrangler.preview.jsonc): a row that cannot say where it came
 * from is not sent. TRACE_INGEST_URL and TRACE_INGEST_TOKEN (one token for both routes); GITHUB_REFRESH_INGEST_URL and
 * GITHUB_REFRESH_INGEST_TOKEN, their earlier names, are read when the new ones are unset.
 */
export function forwardConfigOf(env: Record<string, unknown>): ForwardConfig | null {
  const url = setting(env, "TRACE_INGEST_URL") || setting(env, "GITHUB_REFRESH_INGEST_URL");
  const token = setting(env, "TRACE_INGEST_TOKEN") || setting(env, "GITHUB_REFRESH_INGEST_TOKEN");
  const which = env.DEPLOYMENT_ENV;
  if (!url || !token || !(FORWARD_ENVS as readonly unknown[]).includes(which)) return null;
  return { url: url.replace(/\/+$/, ""), token, env: which as ForwardEnv };
}

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
  map(r: TraceOutboxRow, env: ForwardEnv): WireRow | null;
};

// ---------------------------------------------------------------------------------------------------------------------
// The github.refresh lane: unchanged since #982.

/** The github.refresh lane's kinds. One entry, on purpose: widening it is a decision, not a side effect. */
export const FORWARD_KINDS: readonly TraceKind[] = ["github.refresh"];

/** Every field a forwarded github.refresh row has, and nothing else ever: the receiving table's columns. */
export const FORWARD_COLUMNS = ["at", "tenant_id", "agent_id", "seq", "env", "outcome", "scope", "connector_id", "mount", "why",
  "attempt", "stored", "reason_code"] as const;
export type ForwardRow = {
  at: string; tenant_id: string; agent_id: string; seq: number; env: ForwardEnv; outcome: string;
  scope: string | null; connector_id: string | null; mount: string | null; why: string | null;
  attempt: number | null; stored: boolean | null; reason_code: string | null;
};

const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const int = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

/** One outbox row as the github-refresh receiver's columns, built field by field: nothing in the stored row rides along. */
export function forwardRow(r: TraceOutboxRow, env: ForwardEnv): ForwardRow {
  const a = r.attrs ?? {};
  return {
    at: new Date(r.at).toISOString(), tenant_id: r.tenantId, agent_id: r.agentId, seq: r.seq, env, outcome: r.status,
    scope: str(a.scope), connector_id: str(a.connectorId), mount: str(a.mount), why: str(a.why),
    attempt: int(a.attempt), stored: bool(a.stored), reason_code: str(a.reasonCode),
  };
}

export const GITHUB_REFRESH_LANE: ForwardLane = {
  name: "github.refresh", path: "/api/external/github-refresh", kinds: FORWARD_KINDS, table: "ghr_forward",
  log: "github.refresh.forward", map: forwardRow,
};

// ---------------------------------------------------------------------------------------------------------------------
// The agent.trace lane: Raft's `POST /api/external/antiproton-trace` (botiverse/slock#10530,
// the trace-upload worker's `antiprotonTrace.ts`, `ANTIPROTON_TRACE_KINDS`).

/**
 * The receiver's shapes, mirrored so that what is sent is what it keeps. An id: letters, digits and `_ . : @ / -`, at
 * most 128. A code: lowercase, digits and `_ . : -`, at most 64. A count: a non-negative safe integer. An int: a safe
 * integer. Anything else is not sent.
 */
const ID = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const CODE = /^[a-z0-9_.:-]{1,64}$/;

type FieldType = "id" | "code" | "count" | "int" | "bool" | readonly string[];
/** Where a field comes from: an attr by name, or the row's own `status` or `ms`. */
type Source = string | { row: "status" | "ms" };
/** wire name → [source, type]. */
type FieldSpec = Readonly<Record<string, readonly [Source, FieldType]>>;

const STATUS = { row: "status" } as const;
const MS = { row: "ms" } as const;

/**
 * Per kind, every field an `agent.trace` row may carry beyond its envelope, and where each comes from. The receiver's
 * fields first; after them, under `// proposed`, ids and counts the receiver does not keep yet (it drops a field it does
 * not know), named so it can take them without a change here. Deliberately absent: tool.call's `error` (a tool's own
 * sentence, redacted but free text), its `name` and `callId`; model.call's `limit` (a sentence) and `prefix` (an
 * object); a wake's `error` (a message) and every plugin row's `mount`; turn.stop's `errorClass` (a sentence for
 * people, which the receiver's id shape refuses; `trigger` says the same); turn.timing's raw instants.
 */
export const AGENT_TRACE_FIELDS: Readonly<Partial<Record<TraceKind, FieldSpec>>> = {
  "model.call": {
    model: ["model", "id"], stop_reason: [STATUS, "code"], input: ["input", "count"], output: ["output", "count"],
    cache_read: ["cacheRead", "count"], cache_write: ["cacheWrite", "count"], reasoning: ["reasoning", "count"],
    first_tool: ["firstTool", "id"], turn: ["turn", "id"], session: ["session", "id"],
  },
  "model.attempt": {
    attempt: ["attempt", "count"], phase: ["phase", ["take", "admit", "call", "deliver"]], outcome: ["outcome", "id"],
    total_ms: [MS, "count"], provider_ms: ["providerMs", "count"], model: ["model", "id"],
    // proposed
    http_status: ["httpStatus", "count"], error_class: ["errorClass", "id"],
  },
  "tool.call": {
    tool: ["tool", "id"], mount: ["mount", "id"], task: ["task", "id"], run_ms: ["runMs", "count"], exit_code: ["exitCode", "int"],
    denied: ["denied", "bool"], error_code: ["errorCode", "code"],
    // proposed
    http_status: ["httpStatus", "count"],
  },
  "tool.refused": {
    tool: ["tool", "id"], code: ["code", "code"], by: ["by", "id"], from: ["from", ["model", "program"]],
    // proposed
    task: ["task", "id"],
  },
  "turn.timing": {
    inbound_to_start_ms: ["inboundToStartMs", "count"], start_to_first_job_ms: ["startToFirstJobMs", "count"],
    model_ms: ["modelMs", "count"], between_jobs_ms: ["betweenJobsMs", "count"], tool_ms: ["toolMs", "count"],
    last_answer_to_reply_ms: ["lastAnswerToReplyMs", "count"], model_jobs: ["modelJobs", "count"], tools: ["tools", "count"],
    messages: ["messages", "count"], first_call_prompt_tokens: ["firstCallPromptTokens", "count"],
    first_call_cached_tokens: ["firstCallCachedTokens", "count"],
    // proposed
    client_wait_ms: ["clientWaitMs", "count"], client_pauses: ["clientPauses", "count"], prep_ms: ["prepMs", "count"],
  },
  "turn.stop": {
    trigger: ["trigger", "code"],
    // proposed
    turn: ["turn", "id"],
  },
  "raft.assistant_wake": {
    result: [STATUS, ["skipped_empty", "skipped_filtered", "invoked", "unreadable", "paused", "night_deferred", "failed"]],
    trigger: ["trigger", "code"], conversations: ["conversations", "count"], candidates: ["candidates", "count"],
    seen: ["seen", "count"], unreadable: ["unreadable", "count"], lag_retry: ["lagRetry", "count"], caught_up: ["caught_up", "bool"],
    caught_up_via: ["caught_up_via", ["unread", "all", "mixed"]], caught_up_rule: ["caught_up_rule", ["seq", "time"]],
    // proposed
    muted: ["muted", "count"], told: ["told", "count"], held: ["held", "count"], said: ["said", "count"],
    inbox_lagging: ["inbox_lagging", "bool"], inbox_lagging_gave_up: ["inbox_lagging_gave_up", "bool"], reason: ["reason", "code"],
  },
  "raft.assistant_notify": {
    state: [STATUS, ["sent", "nothing_to_send", "kept_for_brief", "not_sent"]],
    items_in: ["given", "count"], items_sent: ["sent", "count"], dropped: ["dropped", "count"],
    dropped_already_told: ["dropped_already_told", "count"], dropped_rule: ["dropped_rule", "count"],
    dropped_other: ["dropped_other", "count"],
    // proposed (the receiver's `dropped_unresolved` has no source here: which of these it meant is its to say)
    dropped_not_confirmed: ["dropped_not_confirmed", "count"], dropped_decisions_in_brief: ["dropped_decisions_in_brief", "count"],
  },
  "raft.turn_ended": {
    result: [STATUS, ["settled", "skipped", "unreadable"]], reason: ["reason", "code"], conversations: ["targets", "count"],
    // proposed
    outcome: ["outcome", ["completed", "interrupted", "failed"]], snapshot_mismatches: ["snapshotMismatches", "count"],
  },
};

/** The agent.trace lane's kinds: exactly those with fields above. */
export const AGENT_TRACE_KINDS = Object.keys(AGENT_TRACE_FIELDS) as TraceKind[];

const VERDICTS = ["ok", "failed", "blocked", "cancelled"] as const;

/**
 * A code as the receiver takes one: lowercase. A stop reason is pi's camelCase (`toolUse` → `tool_use`), a plugin's error
 * code is often upper case (`NOT_FOUND` → `not_found`); either is the same token in the receiver's shape. Null when it
 * still is not one.
 */
export function codeOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return CODE.test(c) ? c : null;
}
const idOf = (v: unknown): string | null => typeof v === "string" && ID.test(v) ? v : null;
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

function fieldOf(v: unknown, type: FieldType): string | number | boolean | null {
  if (Array.isArray(type)) return typeof v === "string" && type.includes(v) ? v : null;
  switch (type) {
    case "id": return idOf(v);
    case "code": return codeOf(v);
    case "count": return countOf(v);
    case "int": return intOf(v);
    case "bool": return typeof v === "boolean" ? v : null;
  }
  return null;
}

/**
 * A span id in the receiver's id shape. Most are already (`mj_…`, `op_…`, `tt_<session>@<ms>`, `wake:<alias>:<ms>`);
 * an OpenAI Responses tool call id is `call_…|fc_…`, whose `|` the receiver refuses, so any character outside the shape
 * becomes `_`, and a span longer than 128 is cut. Null when nothing is left.
 */
export function spanOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[^A-Za-z0-9_.:@/-]/g, "_").slice(0, 128);
  return s ? s : null;
}

/**
 * One outbox row as an `agent.trace` row: the envelope (`at`, `kind`, `tenant_id`, `agent_id`, `span_id`, `env`, `seq`,
 * `status`, `verdict`, `ms`), then the kind's fields from AGENT_TRACE_FIELDS, each checked; a field that does not pass
 * is left out, never sent as it was. Null, and nothing sent, when the row's kind is not this lane's or its tenant, agent
 * or span cannot be written in the receiver's id shape (it would refuse the whole batch for it).
 */
export function agentTraceRow(r: TraceOutboxRow, env: ForwardEnv): WireRow | null {
  const spec = Object.prototype.hasOwnProperty.call(AGENT_TRACE_FIELDS, r.kind) ? AGENT_TRACE_FIELDS[r.kind] ?? null : null;
  if (!spec) return null;
  const tenant = idOf(r.tenantId), agent = idOf(r.agentId), span = spanOf(r.spanId);
  if (!tenant || !agent || !span || !Number.isFinite(r.at)) return null;
  const a = r.attrs ?? {};
  const out: WireRow = {
    seq: r.seq, at: new Date(r.at).toISOString(), kind: r.kind, tenant_id: tenant, agent_id: agent, span_id: span, env,
  };
  const status = codeOf(r.status);
  if (status) out.status = status;
  if ((VERDICTS as readonly string[]).includes(r.verdict)) out.verdict = r.verdict;
  const ms = countOf(r.ms);
  if (ms !== null) out.ms = ms;
  for (const [name, [source, type]] of Object.entries(spec)) {
    const raw = typeof source === "string" ? (Object.prototype.hasOwnProperty.call(a, source) ? a[source] : undefined) : r[source.row];
    const v = fieldOf(raw, type);
    if (v !== null) out[name] = v;
  }
  return out;
}

export const AGENT_TRACE_LANE: ForwardLane = {
  name: "agent.trace", path: "/api/external/antiproton-trace", kinds: AGENT_TRACE_KINDS, table: "atr_forward",
  log: "trace.forward", map: agentTraceRow,
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
    /** Every outcome but an accepted batch: `reason` one of FORWARD_REASONS, `status` the HTTP status when there was one. */
    log: `CREATE TABLE IF NOT EXISTS ${t.log} (at INTEGER NOT NULL, reason TEXT NOT NULL, status INTEGER, rows INTEGER NOT NULL)`,
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

function note(sql: Sql, lane: ForwardLane, at: number, reason: ForwardReason, status: number | null, rows: number, tenantId: string, agentId: string) {
  const t = tablesOf(lane);
  sql.exec(ddl(lane).log);
  sql.exec(`DELETE FROM ${t.log} WHERE at < ?`, at - DROPS_KEEP_MS);
  sql.exec(`INSERT INTO ${t.log}(at, reason, status, rows) VALUES (?, ?, ?, ?)`, at, reason, status, rows);
  const kept = reason === "auth_or_off" || reason === "unavailable";
  logEvent(lane.log, { tenantId, agentId, result: kept ? "kept" : "dropped", reason, status: status ?? undefined, rows });
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
  sql.exec(d.queue);
  let unsendable = 0;
  for (const r of rows) {
    if (!lane.kinds.includes(r.kind)) continue;
    const wire = lane.map(r, cfg.env);
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

export type ForwardResult = { sent: number; dropped: number; kept: number; error: string | null; skipped?: "backoff" };

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
 * Send a lane's queue, oldest first, until it is empty or the endpoint fails. Never throws: a failure is the return
 * value's `error`, and the rows it concerned are still queued. `timeoutMs` bounds each request (FORWARD_TIMEOUT_MS;
 * a test passes a short one).
 */
export async function sendForward(
  sql: Sql, cfg: ForwardConfig, tenantId: string, agentId: string, fetchFn: Fetch = fetch, now: () => number = Date.now,
  timeoutMs: number = FORWARD_TIMEOUT_MS, lane: ForwardLane = GITHUB_REFRESH_LANE,
): Promise<ForwardResult> {
  const out: ForwardResult = { sent: 0, dropped: 0, kept: 0, error: null };
  const t = tablesOf(lane), d = ddl(lane);
  try {
    sql.exec(d.queue); sql.exec(d.state);
    const state = sql.exec(`SELECT failures, next_at FROM ${t.state} WHERE id = 1`).toArray()[0];
    const failures = state ? Number(state.failures) : 0;
    const queued = () => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${t.queue}`).toArray()[0]?.n ?? 0);
    if (state && Number(state.next_at) > now()) return { ...out, kept: queued(), skipped: "backoff" };
    const forget = (rows: readonly WireRow[]) => { for (const r of rows) sql.exec(`DELETE FROM ${t.queue} WHERE seq = ?`, r.seq); };

    /** One batch, split on 413. False: the endpoint failed, and this pass stops. */
    const post = async (rows: readonly WireRow[]): Promise<boolean> => {
      const { url, init } = ingestRequest(cfg, rows, lane);
      let status: number;
      try {
        const res = await fetchWithin(fetchFn, url, init, timeoutMs);
        status = res.status;
        try { await res.body?.cancel(); } catch { /* nothing to read */ }
      } catch (e) {
        // A timeout lands here too (`network: TimeoutError`): no answer, the rows kept, the backoff applies.
        // The error's name, not its message: a message can carry the request, and neither the URL nor the token is logged.
        out.error = `network: ${String((e as { name?: unknown })?.name ?? "error").slice(0, 40)}`;
        note(sql, lane, now(), "unavailable", null, rows.length, tenantId, agentId);
        return false;
      }
      const answer = answerOf(status);
      if (answer === "accepted") { forget(rows); out.sent += rows.length; return true; }
      if (answer === "split" && rows.length > 1) {
        const half = Math.ceil(rows.length / 2);
        return await post(rows.slice(0, half)) && await post(rows.slice(half));
      }
      if (answer === "auth_or_off" || answer === "unavailable") {
        out.error = `${answer}: http-${status}`;
        note(sql, lane, now(), answer, status, rows.length, tenantId, agentId);
        return false;
      }
      const reason: ForwardReason = answer === "split" ? "too-large" : answer;
      forget(rows); out.dropped += rows.length;
      note(sql, lane, now(), reason, status, rows.length, tenantId, agentId);
      return true;
    };

    let ok = true;
    while (ok) {
      const batch = nextBatch(sql, lane);
      if (!batch.length) break;
      ok = await post(batch);
    }
    out.kept = queued();
    if (ok) {
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
 * The alarm pass's two halves of the forward, around the R2 export: `before` stages every lane and returns the export's
 * prune hold, the lowest lane cursor (null when forwarding is off), `after` sends each lane and returns each lane's
 * outcome. Neither throws. A lane whose stage fails holds the export at its unmoved cursor, so the next pass stages the
 * same rows. `lanes`: which lanes run (all of them; a test narrows it).
 */
export function forwardPass(env: Record<string, unknown>, sql: Sql, tenantId: string, agentId: string, fetchFn: Fetch = fetch,
  lanes: readonly ForwardLane[] = FORWARD_LANES) {
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
      for (const lane of lanes) out[lane.name] = await sendForward(sql, cfg, tenantId, agentId, fetchFn, Date.now, FORWARD_TIMEOUT_MS, lane);
      return out;
    },
  };
}
