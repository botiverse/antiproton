/**
 * Image evidence of a model call: for each queue delivery attempt of a recorded call (cf/src/fresh-context.ts
 * `recordModelInput`), which image references its request carried, which it left out and why, and how the provider
 * call ended. Read back through the evaluation route `model-input` as the call's `images` (docs/agent-surface.md,
 * "Model input").
 *
 * The images are decided in the queue consumer (`callQueuedModel`, cf/src/model-request.ts), a different invocation
 * from the agent's object that recorded the call, so the consumer writes each attempt back to that object over RPC
 * (`AgentDO.recordImageAttempt`), addressed by the queue message like its `takeJob`. Twice per attempt: once when
 * the provider request is built (`preparedAt`), concurrently with the call, and once when the call has ended, with
 * `provider`. The object keys an attempt by a name the consumer makes fresh for it, numbers attempts in the order it
 * first hears of them, and only ever adds to an attempt; a retry is a new attempt and never overwrites one.
 *
 * Names and sizes only: a hash, the sizes declared and read, the outcome. Never bytes, a URL or a storage key. Every
 * field is rebuilt from a fixed shape on the object's side (`cleanAttempt`), so nothing else a caller sends is kept.
 *
 * Evidence never fails or holds up the call it describes: a write that fails or is slow is logged and dropped
 * (`imageAttemptWriter`).
 */
import { logEvent } from "../../src/core/log.ts";
import { ModelCallTimedOut, ModelHttpError, ModelRequestRefused } from "../../src/model/openai-compatible.ts";
import type { ImageItem, ImageItemReason, ImageItemResult } from "../../src/model/images.ts";

export const IMAGE_EVIDENCE_POLICY = "image-window/v1";

/**
 * The most items one attempt keeps. Every reference in the conversation is an item, not only the window's, and a
 * long conversation can hold many; the newest are kept, since the window is at the end, and `truncated` counts the
 * oldest dropped. Their `index` stays their place in the whole conversation.
 */
export const MAX_EVIDENCE_ITEMS = 200;

/** The most attempts kept for one call; the queue's own retries are far fewer, and a sweep's re-sends are bounded. */
export const MAX_EVIDENCE_ATTEMPTS = 20;

/** How long the consumer waits on one evidence write before going on without it. */
export const EVIDENCE_WRITE_BOUND_MS = 2_000;

export type ProviderOutcome =
  | { outcome: "http"; status: number; at: string }
  | { outcome: "timeout"; at: string }
  | { outcome: "transport_error"; errorClass: string; at: string };

/** What the consumer sends for one attempt; the object adds who and which (`ImageAttempt`). */
export interface ImageAttemptReport {
  attemptId: string;
  budget: { maxImages: number; maxBytes: number; step: number };
  windowStart: number;
  model: string;
  vision: boolean;
  preparedAt: string;
  items: ImageItem[];
  truncated?: number;
  provider?: ProviderOutcome;
}

/** One attempt as recorded and read back. `provider` is absent until the call has ended, never null. */
export interface ImageAttempt {
  modelCallId: string;
  sessionId: string;
  call: number;
  attempt: number;
  policy: typeof IMAGE_EVIDENCE_POLICY;
  budget: { maxImages: number; maxBytes: number; step: number };
  windowStart: number;
  model: string;
  vision: boolean;
  preparedAt: string;
  items: ImageItem[];
  truncated?: number;
  provider?: ProviderOutcome;
}

/** `items` within MAX_EVIDENCE_ITEMS, newest kept, and how many older ones were dropped (on top of `already`). */
export function capItems(items: readonly ImageItem[], already = 0): { items: ImageItem[]; truncated?: number } {
  const dropped = Math.max(0, items.length - MAX_EVIDENCE_ITEMS) + already;
  return { items: items.slice(-MAX_EVIDENCE_ITEMS), ...(dropped > 0 ? { truncated: dropped } : {}) };
}

/**
 * How a provider call ended, from what it threw (`err`, undefined for an answer) and the status of its last HTTP
 * answer. A refusal and a status past its retries are HTTP answers; the deadline is a timeout; anything else (the
 * connection failed, the body would not parse) is a transport error named by its class.
 */
export function providerOutcome(err: unknown, lastStatus: number | undefined, at: Date): ProviderOutcome {
  const iso = at.toISOString();
  if (err === undefined) return { outcome: "http", status: lastStatus ?? 200, at: iso };
  if (err instanceof ModelRequestRefused || err instanceof ModelHttpError) return { outcome: "http", status: err.status, at: iso };
  if (err instanceof ModelCallTimedOut) return { outcome: "timeout", at: iso };
  return { outcome: "transport_error", errorClass: errorClassOf(err), at: iso };
}

const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
function errorClassOf(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  return typeof name === "string" && ERROR_CLASS.test(name) ? name : "Error";
}

/** Where the consumer sends an attempt: the agent's object (`AgentDO.recordImageAttempt`). */
export type ImageEvidenceSink = (report: ImageAttemptReport) => Promise<unknown>;

/**
 * The consumer's two writes for one attempt. `prepared` starts the first and returns at once, so the provider call
 * goes out beside it; `ended` sends the whole attempt again with `provider` and waits for it, at most
 * EVIDENCE_WRITE_BOUND_MS. It does not wait for the first: the object takes the two in either order
 * (`recordImageAttempt` never lets a report without `provider` replace one with it), and a first write that failed
 * leaves the second complete on its own. Nothing thrown here reaches the call: a failed or slow write is logged.
 */
export function imageAttemptWriter(sink: ImageEvidenceSink, base: Omit<ImageAttemptReport, "preparedAt" | "provider">, jobId: string) {
  let preparedAt: string | null = null;
  const send = async (report: ImageAttemptReport, phase: "prepared" | "ended") => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"slow">((r) => { timer = setTimeout(() => r("slow"), EVIDENCE_WRITE_BOUND_MS); });
    try {
      const wrote = Promise.resolve().then(() => sink(report)).then(() => "done" as const);
      if (await Promise.race([wrote, bound]) === "slow") {
        logEvent("model_job.image_evidence_failed", { jobId, phase, error: `no answer within ${EVIDENCE_WRITE_BOUND_MS} ms` });
        wrote.catch(() => { /* already reported as slow */ });
      }
    } catch (e) {
      logEvent("model_job.image_evidence_failed", { jobId, phase, error: String((e as Error)?.message ?? e).slice(0, 200) });
    } finally { clearTimeout(timer); }
  };
  return {
    prepared(at: Date): void {
      preparedAt = at.toISOString();
      void send({ ...base, preparedAt }, "prepared");
    },
    async ended(provider: ProviderOutcome): Promise<void> {
      if (preparedAt === null) return;
      await send({ ...base, preparedAt, provider }, "ended");
    },
  };
}

// ---- the object's side

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

const IMAGES = `CREATE TABLE IF NOT EXISTS model_input_images (
  job_id TEXT NOT NULL, attempt_id TEXT NOT NULL, attempt INTEGER NOT NULL, record TEXT NOT NULL,
  PRIMARY KEY (job_id, attempt_id), UNIQUE (job_id, attempt))`;

function rows(sql: Sql, query: string, ...b: unknown[]): any[] {
  try { return sql.exec(query, ...b).toArray(); }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return []; throw e; }
}

const RESULTS: readonly ImageItemResult[] = ["included_in_request", "omitted", "load_failed"];
const REASONS: Record<ImageItemResult, readonly ImageItemReason[]> = {
  included_in_request: [],
  omitted: ["before_window", "over_budget", "non_vision_model"],
  load_failed: ["missing", "read_error", "size_mismatch"],
};
const SHA = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[A-Za-z0-9-]{1,64}$/;
const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const pos = (v: unknown): v is number => nat(v) && (v as number) > 0;
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function cleanItem(v: any): ImageItem | null {
  if (!v || !nat(v.index) || typeof v.sha256 !== "string" || !SHA.test(v.sha256) || !RESULTS.includes(v.result)) return null;
  if (!(v.declaredBytes === null || nat(v.declaredBytes)) || !(v.readBytes === null || nat(v.readBytes))) return null;
  const reasons = REASONS[v.result as ImageItemResult];
  if (reasons.length ? !reasons.includes(v.reason) : v.reason !== undefined) return null;
  return { index: v.index, sha256: v.sha256, declaredBytes: v.declaredBytes, readBytes: v.readBytes, result: v.result, ...(reasons.length ? { reason: v.reason } : {}) };
}

function cleanProvider(v: any): ProviderOutcome | null {
  const at = iso(v?.at);
  if (!at) return null;
  if (v.outcome === "http" && Number.isSafeInteger(v.status) && v.status >= 100 && v.status <= 599) return { outcome: "http", status: v.status, at };
  if (v.outcome === "timeout") return { outcome: "timeout", at };
  if (v.outcome === "transport_error") return { outcome: "transport_error", errorClass: typeof v.errorClass === "string" && ERROR_CLASS.test(v.errorClass) ? v.errorClass : "Error", at };
  return null;
}

/** A report rebuilt field by field from its fixed shape; null when it is not one. */
export function cleanAttempt(v: any): ImageAttemptReport | null {
  if (!v || typeof v !== "object") return null;
  if (typeof v.attemptId !== "string" || !ATTEMPT_ID.test(v.attemptId)) return null;
  const b = v.budget;
  if (!b || !pos(b.maxImages) || !pos(b.maxBytes) || !pos(b.step)) return null;
  const preparedAt = iso(v.preparedAt);
  if (!nat(v.windowStart) || typeof v.model !== "string" || typeof v.vision !== "boolean" || !preparedAt || !Array.isArray(v.items)) return null;
  const items: ImageItem[] = [];
  for (const raw of v.items) { const it = cleanItem(raw); if (!it) return null; items.push(it); }
  const capped = capItems(items, nat(v.truncated) ? v.truncated : 0);
  let provider: ProviderOutcome | undefined;
  if (v.provider !== undefined) { const p = cleanProvider(v.provider); if (!p) return null; provider = p; }
  return {
    attemptId: v.attemptId, budget: { maxImages: b.maxImages, maxBytes: b.maxBytes, step: b.step }, windowStart: v.windowStart,
    model: v.model.slice(0, 200), vision: v.vision, preparedAt, ...capped, ...(provider ? { provider } : {}),
  };
}

/**
 * Record one attempt of the call `jobId`, as the object's own evidence of it: only for a call whose input was
 * recorded (`model_input_digests`), whose conversation and number it takes. A new attempt name is the next attempt;
 * a known one is completed once, by the report that carries `provider`, and never changed after. False when nothing
 * was written.
 */
export function recordImageAttempt(sql: Sql, jobId: string, raw: unknown): boolean {
  const digest = rows(sql, "SELECT session_id, call FROM model_input_digests WHERE job_id = ?", jobId)[0];
  if (!digest) return false;
  const r = cleanAttempt(raw);
  if (!r) return false;
  sql.exec(IMAGES);
  const { attemptId, ...report } = r;
  const known = sql.exec("SELECT attempt, record FROM model_input_images WHERE job_id = ? AND attempt_id = ?", jobId, attemptId).toArray()[0];
  if (known) {
    if (JSON.parse(String(known.record)).provider !== undefined) return false;
    if (!report.provider) return false;
  } else if (Number(sql.exec("SELECT COUNT(*) AS n FROM model_input_images WHERE job_id = ?", jobId).toArray()[0]?.n ?? 0) >= MAX_EVIDENCE_ATTEMPTS) {
    return false;
  }
  const attempt = known ? Number(known.attempt)
    : Number(sql.exec("SELECT COALESCE(MAX(attempt), 0) AS n FROM model_input_images WHERE job_id = ?", jobId).toArray()[0]?.n ?? 0) + 1;
  const record: ImageAttempt = {
    modelCallId: jobId, sessionId: String(digest.session_id), call: Number(digest.call), attempt, policy: IMAGE_EVIDENCE_POLICY,
    ...report,
  };
  sql.exec("INSERT INTO model_input_images(job_id, attempt_id, attempt, record) VALUES (?,?,?,?) ON CONFLICT(job_id, attempt_id) DO UPDATE SET record = excluded.record",
    jobId, attemptId, attempt, JSON.stringify(record));
  return true;
}

/** The recorded attempts of the call `jobId`, first first; none when nothing was recorded. */
export function readImageAttempts(sql: Sql, jobId: string): ImageAttempt[] {
  return rows(sql, "SELECT record FROM model_input_images WHERE job_id = ? ORDER BY attempt", jobId).map((r) => JSON.parse(String(r.record)) as ImageAttempt);
}
