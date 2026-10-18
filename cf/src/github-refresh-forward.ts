/**
 * The trace outbox's `github.refresh` rows, forwarded to Raft's trace-upload worker so a renewal's outcome can be
 * alerted on from the trace rather than from Workers Logs, which drops an object's lines (#980; docs/runbook.md,
 * "Logs and what an object did"). Off until the deployment names both the endpoint and its token
 * (`forwardConfigOf`); off, nothing here runs and no table is made.
 *
 * A third reader of the outbox, and the only one that leaves the account: so it reads through an allowlist
 * (`FORWARD_KINDS`, one kind) and sends a fixed set of columns (`FORWARD_COLUMNS`), never the row as stored. A kind
 * added to the trace is not forwarded until it is added here, and an attr added to `github.refresh` is not forwarded
 * until it is a column here.
 *
 * Two steps, so that neither the R2 export nor this waits for the other:
 * - `stageForward`, local only: the allowlisted rows past this reader's own cursor (`ghr_forward_staged`) are mapped to
 *   their columns and copied into this reader's own queue (`ghr_forward_queue`), and the cursor moves. It runs before
 *   the export on every pass and its cursor is the export's prune hold, so the export never prunes a row this has not
 *   copied; and since it touches nothing remote, that hold does not stall when the endpoint is down.
 * - `sendForward`, remote: the queue, oldest first, at most FORWARD_BATCH_MAX rows a request. Its outcome is this
 *   reader's alone: it never throws, never fails the pass, and asks for no extra pass. A row waiting on a backoff is
 *   sent on the first alarm pass after the backoff, whenever the agent next has one.
 *
 * What an answer does (agreed with the receiving side). Every outcome but a 2xx is counted in `ghr_forward_log` with a
 * fixed reason and the status, and logged as a `github.refresh.forward` line:
 * - 2xx: accepted, duplicates included; the rows leave the queue.
 * - 413: the batch is split in half and each half sent, down to one row; a single row still too large is dropped
 *   (`too-large`).
 * - 400, 422: the receiver cannot take the batch's shape, which a resend will not mend: it is dropped (`schema`) and the
 *   queue moves on rather than wedging behind it.
 * - 401, 403, 404: the token is wrong or expired, or the receiver is switched off (it answers 404 while it has no token
 *   of its own), none of which says anything about the rows: forwarding pauses (`auth_or_off`), the rows stay, and the
 *   backoff below applies, so the backlog drains once either side is mended.
 * - 408, 429, 5xx, or no answer: the rows stay (`unavailable`) and the backoff applies. No answer includes one that
 *   has not come within FORWARD_TIMEOUT_MS: every request, each half of a 413 split included, is aborted then, since
 *   the send runs inside the agent's alarm pass and a receiver that hangs would otherwise hold that pass open. A
 *   timeout ends the pass's sending like any other failure: no later batch is tried until the backoff is over.
 * - any other 4xx: dropped (`rejected`), as a resend of the same request gets the same.
 * The backoff: FORWARD_BACKOFF_BASE_MS, doubling to FORWARD_BACKOFF_MAX_MS, cleared by the next success.
 * A resent row is the same row: its identity is (tenant_id, agent_id, seq), the outbox's own, and the receiver dedupes
 * on it.
 *
 * What a pause costs, and why the queue rather than the outbox holds it: the export prunes the outbox through this
 * reader's stage cursor, which always moves, so a paused forward never holds the outbox (every kind's rows) or the
 * export. What waits is the queue of mapped `github.refresh` rows alone, a few per renewal, at most FORWARD_QUEUE_MAX;
 * past that the oldest are dropped and counted (`lost`). Seven days of the counts are kept, as `trace_drops`.
 */
import { logEvent } from "../../src/core/log.ts";
import { pendingTrace, type TraceKind, type TraceOutboxRow } from "../../src/trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The only kinds that leave the account. One entry, on purpose: widening it is a decision, not a side effect. */
export const FORWARD_KINDS: readonly TraceKind[] = ["github.refresh"];

/** Every field a forwarded row has, and nothing else ever: the receiving table's columns. */
export const FORWARD_COLUMNS = ["at", "tenant_id", "agent_id", "seq", "env", "outcome", "scope", "connector_id", "mount", "why",
  "attempt", "stored", "reason_code"] as const;
export type ForwardRow = {
  at: string; tenant_id: string; agent_id: string; seq: number; env: ForwardEnv; outcome: string;
  scope: string | null; connector_id: string | null; mount: string | null; why: string | null;
  attempt: number | null; stored: boolean | null; reason_code: string | null;
};

export const FORWARD_ENVS = ["production", "preview"] as const;
export type ForwardEnv = (typeof FORWARD_ENVS)[number];

/** The receiver's limit per request. */
export const FORWARD_BATCH_MAX = 500;
/** What the queue holds at most while the endpoint is down; the oldest rows past it are dropped and counted. */
export const FORWARD_QUEUE_MAX = 5_000;
/** How many outbox rows one pass stages at most; the rest are staged by the next pass (and held from pruning till then). */
const STAGE_READ_MAX = 2_000;
/** How long one request may take before it is aborted and counted as no answer (`unavailable`). */
export const FORWARD_TIMEOUT_MS = 10_000;
export const FORWARD_BACKOFF_BASE_MS = 60_000;
export const FORWARD_BACKOFF_MAX_MS = 60 * 60_000;
/** How long a drop stays on record, as `trace_drops` (cf/src/trace-r2.ts). */
const DROPS_KEEP_MS = 7 * 24 * 60 * 60_000;

export type ForwardConfig = { url: string; token: string; env: ForwardEnv };

/**
 * The deployment's forwarding, or null when it is off. Off unless BOTH GITHUB_REFRESH_INGEST_URL and
 * GITHUB_REFRESH_INGEST_TOKEN are set, and DEPLOYMENT_ENV names which deployment this is (cf/wrangler.jsonc,
 * cf/wrangler.preview.jsonc): a row that cannot say where it came from is not sent.
 */
export function forwardConfigOf(env: Record<string, unknown>): ForwardConfig | null {
  const url = typeof env.GITHUB_REFRESH_INGEST_URL === "string" ? env.GITHUB_REFRESH_INGEST_URL.trim() : "";
  const token = typeof env.GITHUB_REFRESH_INGEST_TOKEN === "string" ? env.GITHUB_REFRESH_INGEST_TOKEN.trim() : "";
  const which = env.DEPLOYMENT_ENV;
  if (!url || !token || !(FORWARD_ENVS as readonly unknown[]).includes(which)) return null;
  return { url: url.replace(/\/+$/, ""), token, env: which as ForwardEnv };
}

/**
 * THE REQUEST, in one place: `POST <base>/api/external/github-refresh`, `Authorization: Bearer <token>`, a JSON body
 * `{"rows":[...]}` fully buffered so its length is known before it is sent. This is the receiving side's contract
 * (Raft's trace-upload worker); a change to it is a change to this function and its test (test/github-refresh-forward.ts).
 */
export function ingestRequest(cfg: ForwardConfig, rows: readonly ForwardRow[]): { url: string; init: RequestInit & { body: Uint8Array } } {
  const body = new TextEncoder().encode(JSON.stringify({ rows }));
  return {
    url: `${cfg.url}/api/external/github-refresh`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.byteLength), authorization: `Bearer ${cfg.token}` },
      body,
    },
  };
}

const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const int = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

/** One outbox row as the receiver's columns, built field by field: nothing in the stored row rides along. */
export function forwardRow(r: TraceOutboxRow, env: ForwardEnv): ForwardRow {
  const a = r.attrs ?? {};
  return {
    at: new Date(r.at).toISOString(), tenant_id: r.tenantId, agent_id: r.agentId, seq: r.seq, env, outcome: r.status,
    scope: str(a.scope), connector_id: str(a.connectorId), mount: str(a.mount), why: str(a.why),
    attempt: int(a.attempt), stored: bool(a.stored), reason_code: str(a.reasonCode),
  };
}

const CURSOR = "CREATE TABLE IF NOT EXISTS ghr_forward_staged (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)";
const QUEUE = "CREATE TABLE IF NOT EXISTS ghr_forward_queue (seq INTEGER PRIMARY KEY, row TEXT NOT NULL)";
const STATE = "CREATE TABLE IF NOT EXISTS ghr_forward_state (id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, next_at INTEGER NOT NULL)";
/** Every outcome but an accepted batch: `reason` one of FORWARD_REASONS, `status` the HTTP status when there was one. */
const COUNTS = "CREATE TABLE IF NOT EXISTS ghr_forward_log (at INTEGER NOT NULL, reason TEXT NOT NULL, status INTEGER, rows INTEGER NOT NULL)";
/** Dropped: `too-large`, `schema`, `rejected`, `lost`. Kept for a later pass: `auth_or_off`, `unavailable`. */
export const FORWARD_REASONS = ["too-large", "schema", "rejected", "lost", "auth_or_off", "unavailable"] as const;
export type ForwardReason = (typeof FORWARD_REASONS)[number];

/** This reader's cursor over the outbox: what it has staged. */
export function forwardCursor(sql: Sql): number {
  sql.exec(CURSOR);
  const known = sql.exec("SELECT through_seq FROM ghr_forward_staged WHERE id = 1").toArray()[0];
  return known ? Number(known.through_seq) : 0;
}

function note(sql: Sql, at: number, reason: ForwardReason, status: number | null, rows: number, tenantId: string, agentId: string) {
  sql.exec(COUNTS);
  sql.exec("DELETE FROM ghr_forward_log WHERE at < ?", at - DROPS_KEEP_MS);
  sql.exec("INSERT INTO ghr_forward_log(at, reason, status, rows) VALUES (?, ?, ?, ?)", at, reason, status, rows);
  const kept = reason === "auth_or_off" || reason === "unavailable";
  logEvent("github.refresh.forward", { tenantId, agentId, result: kept ? "kept" : "dropped", reason, status: status ?? undefined, rows });
}

/**
 * Copy the allowlisted rows past this reader's cursor into its queue and move the cursor. Local only. Returns the
 * cursor, which is the export's prune hold.
 */
export function stageForward(sql: Sql, cfg: ForwardConfig, tenantId: string, agentId: string, now: () => number = Date.now): number {
  const from = forwardCursor(sql);
  const { rows, through } = pendingTrace(sql, from, STAGE_READ_MAX);
  sql.exec(QUEUE);
  for (const r of rows) {
    if (!FORWARD_KINDS.includes(r.kind)) continue;
    sql.exec("INSERT OR IGNORE INTO ghr_forward_queue(seq, row) VALUES (?, ?)", r.seq, JSON.stringify(forwardRow(r, cfg.env)));
  }
  if (through > from) {
    sql.exec("INSERT INTO ghr_forward_staged(id, through_seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET through_seq = excluded.through_seq", through);
  }
  const queued = Number(sql.exec("SELECT COUNT(*) AS n FROM ghr_forward_queue").toArray()[0]?.n ?? 0);
  if (queued > FORWARD_QUEUE_MAX) {
    const over = queued - FORWARD_QUEUE_MAX;
    sql.exec("DELETE FROM ghr_forward_queue WHERE seq IN (SELECT seq FROM ghr_forward_queue ORDER BY seq LIMIT ?)", over);
    note(sql, now(), "lost", null, over, tenantId, agentId);
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

/**
 * Send the queue, oldest first, until it is empty or the endpoint fails. Never throws: a failure is the return
 * value's `error`, and the rows it concerned are still queued. `timeoutMs` bounds each request (FORWARD_TIMEOUT_MS;
 * a test passes a short one).
 */
export async function sendForward(
  sql: Sql, cfg: ForwardConfig, tenantId: string, agentId: string, fetchFn: Fetch = fetch, now: () => number = Date.now,
  timeoutMs: number = FORWARD_TIMEOUT_MS,
): Promise<ForwardResult> {
  const out: ForwardResult = { sent: 0, dropped: 0, kept: 0, error: null };
  try {
    sql.exec(QUEUE); sql.exec(STATE);
    const state = sql.exec("SELECT failures, next_at FROM ghr_forward_state WHERE id = 1").toArray()[0];
    const failures = state ? Number(state.failures) : 0;
    const queued = () => Number(sql.exec("SELECT COUNT(*) AS n FROM ghr_forward_queue").toArray()[0]?.n ?? 0);
    if (state && Number(state.next_at) > now()) return { ...out, kept: queued(), skipped: "backoff" };
    const forget = (rows: readonly ForwardRow[]) => { for (const r of rows) sql.exec("DELETE FROM ghr_forward_queue WHERE seq = ?", r.seq); };

    /** One batch, split on 413. False: the endpoint failed, and this pass stops. */
    const post = async (rows: readonly ForwardRow[]): Promise<boolean> => {
      const { url, init } = ingestRequest(cfg, rows);
      let status: number;
      try {
        const res = await fetchWithin(fetchFn, url, init, timeoutMs);
        status = res.status;
        try { await res.body?.cancel(); } catch { /* nothing to read */ }
      } catch (e) {
        // A timeout lands here too (`network: TimeoutError`): no answer, the rows kept, the backoff applies.
        // The error's name, not its message: a message can carry the request, and neither the URL nor the token is logged.
        out.error = `network: ${String((e as { name?: unknown })?.name ?? "error").slice(0, 40)}`;
        note(sql, now(), "unavailable", null, rows.length, tenantId, agentId);
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
        note(sql, now(), answer, status, rows.length, tenantId, agentId);
        return false;
      }
      const reason: ForwardReason = answer === "split" ? "too-large" : answer;
      forget(rows); out.dropped += rows.length;
      note(sql, now(), reason, status, rows.length, tenantId, agentId);
      return true;
    };

    let ok = true;
    while (ok) {
      const batch = sql.exec("SELECT row FROM ghr_forward_queue ORDER BY seq LIMIT ?", FORWARD_BATCH_MAX).toArray()
        .map((r: any) => JSON.parse(String(r.row)) as ForwardRow);
      if (!batch.length) break;
      ok = await post(batch);
    }
    out.kept = queued();
    if (ok) {
      if (failures) sql.exec("DELETE FROM ghr_forward_state WHERE id = 1");
    } else {
      const n = failures + 1;
      const wait = Math.min(FORWARD_BACKOFF_MAX_MS, FORWARD_BACKOFF_BASE_MS * 2 ** (n - 1));
      sql.exec("INSERT INTO ghr_forward_state(id, failures, next_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET failures = excluded.failures, next_at = excluded.next_at",
        n, now() + wait);
      logEvent("github.refresh.forward", { tenantId, agentId, result: "retry", reason: out.error, failures: n, waitMs: wait, kept: out.kept });
    }
    if (out.sent) logEvent("github.refresh.forward", { tenantId, agentId, result: "sent", rows: out.sent });
  } catch (e) {
    out.error = `local: ${String((e as { message?: unknown })?.message ?? e).slice(0, 120)}`;
  }
  return out;
}

/**
 * The alarm pass's two halves of this reader, around the R2 export: `before` stages and returns the export's prune
 * hold (null when forwarding is off), `after` sends. Neither throws. A stage that fails holds the export at this
 * reader's unmoved cursor, so the next pass stages the same rows.
 */
export function forwardPass(env: Record<string, unknown>, sql: Sql, tenantId: string, agentId: string, fetchFn: Fetch = fetch) {
  const cfg = forwardConfigOf(env);
  return {
    before(): number | null {
      if (!cfg) return null;
      try { return stageForward(sql, cfg, tenantId, agentId); }
      catch (e) {
        console.warn(`github.refresh forward stage failed for ${agentId}: ${String((e as { message?: unknown })?.message ?? e).slice(0, 200)}`);
        try { return forwardCursor(sql); } catch { return 0; }
      }
    },
    async after(): Promise<ForwardResult | null> {
      return cfg ? sendForward(sql, cfg, tenantId, agentId, fetchFn) : null;
    },
  };
}
