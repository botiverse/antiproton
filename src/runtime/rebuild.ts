/**
 * Context rebuild, decided at wake time — in shadow: the decision is recorded and never acted on.
 *
 * A rebuild is a kind of compaction, not a new session: the conversation keeps its id, and what the model is sent
 * is rebuilt (a summary, or a briefing) instead of resuming a prefix the provider has most likely evicted. A wake
 * that resumes a large context whose cache has gone cold pays for the whole prompt again as uncached input; a
 * rebuild pays for a small one. Whether that trade is worth making depends on how well "cold" can be predicted
 * from what is known before the wake's first call, which is what this module measures.
 *
 * Two questions, kept apart because only one of them can be checked against the cache:
 *   - is the cache cold (`predictedCold`): the gap, or the previous wake measured cold — compared with the first
 *     call's measured hit rate, whatever the context's size;
 *   - would a rebuild be worth it (`wouldRebuild`): cold, and a context over the size threshold.
 * A wake that is cold by construction — the conversation's first call, or the first after a reset — is
 * `expectedCold`: recorded and measured, and left out of the disagreement rate.
 *
 * Rows, joined by the decision's id:
 *   - `rebuild.decision`, written just before the inbound post that starts the wake (`#deliverInbound` in
 *     cf/src/runtime.ts): what `shouldRebuild` said and the facts it said it from — a "no" with its reason as much
 *     as a "yes". When the context is close to the model's window, a second decision with trigger `window`.
 *   - `rebuild.outcome`, written when that wake's first model answer lands (`settleRebuildOutcome`, called from
 *     src/store/pi-storage.ts in the transaction that writes the answer): the measured first-call hit rate
 *     (cacheRead / input) and `agree`, `false-cold`, `false-warm`, `expected-cold` or `unmeasured`.
 *   - a `window` decision for an answer that is a context-overflow error (`recordOverflow`).
 * Numbers and ids only: no text of the conversation is ever in a row.
 *
 * The thresholds come from the wake analysis on production transcripts (2026-09-28 to 10-11, 6 agents): Luna's
 * cache expires by time, so its rule is the gap; DeepSeek is cold on a fifth of short-gap wakes, so its rule also
 * takes the previous wake's measured state. Either way only a context large enough to be worth rebuilding counts:
 * 128k tokens, the threshold RFC 070 swept on 1,564 cold wakes. The analysis also names a window-relative
 * threshold (a share of the model's window), which `RebuildRule.minContextShare` expresses.
 */
import { logEvent } from "../core/log.ts";
import { appendTrace } from "../trace/outbox.ts";
import type { SqlHost } from "../store/pi-storage.ts";

type Sql = SqlHost["sql"];

// ---- the interface the acting step will have (not called yet) ------------------------------------------------------

/** What asked for a rebuild: the window filling up, a wake after the cache went cold, or an operator. */
export type RebuildTrigger = "window" | "cold-wake" | "operator";
/** How the rebuilt context is made: a summary of the conversation, or a briefing assembled from state. */
export type RebuildStrategy = "summary" | "briefing";
/** `rebuildContext`'s argument once it exists; its event is `rebuild{trigger, strategy}`, apart from `compaction`. */
export interface RebuildRequest { trigger: RebuildTrigger; keepTail: number; strategy: RebuildStrategy }

// ---- the policy: data, one rule per provider family ---------------------------------------------------------------

export interface RebuildRule {
  /** Named in every row, so a decision says which rule made it. */
  name: string;
  /** Which bindings the rule covers. Each field present must hold; a rule with none covers every binding. */
  match: { provider?: string; modelIncludes?: string };
  /** A context of at most this many tokens is never worth rebuilding. */
  minContextTokens: number;
  /** When set, the threshold is this share of the model's window instead of `minContextTokens`. */
  minContextShare?: number;
  /** Predicted cold once the gap since the last model call exceeds this. */
  coldAfterGapMs: number;
  /** Also predicted cold when the previous measured wake was cold (its first-call hit rate below `coldHitRate`). */
  previousColdCounts: boolean;
  /** Below this first-call hit rate a wake is measured cold, in [0, 1]. The distribution is bimodal, so the value barely matters. */
  coldHitRate: number;
}

/** First match wins; `fallback` covers a binding no rule names. */
export interface RebuildPolicy {
  rules: RebuildRule[];
  fallback: RebuildRule;
  /** A context at or over this share of the model's window is a `window` rebuild; 0.8 when absent. */
  windowShare?: number;
}

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MIN_CONTEXT_TOKENS = 128_000;
export const DEFAULT_WINDOW_SHARE = 0.8;

export const DEFAULT_REBUILD_POLICY: RebuildPolicy = {
  rules: [
    { name: "deepseek", match: { modelIncludes: "deepseek" }, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
      coldAfterGapMs: HOUR_MS, previousColdCounts: true, coldHitRate: 0.5 },
    { name: "openai-ttl", match: { modelIncludes: "gpt-" }, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
      coldAfterGapMs: HOUR_MS, previousColdCounts: false, coldHitRate: 0.5 },
  ],
  fallback: { name: "gap", match: {}, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
    coldAfterGapMs: HOUR_MS, previousColdCounts: false, coldHitRate: 0.5 },
  windowShare: DEFAULT_WINDOW_SHARE,
};

const isShare = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
const isRule = (r: any): r is RebuildRule => !!r && typeof r === "object" && typeof r.name === "string"
  && !!r.match && typeof r.match === "object"
  && (r.match.provider === undefined || typeof r.match.provider === "string")
  && (r.match.modelIncludes === undefined || typeof r.match.modelIncludes === "string")
  && Number.isFinite(r.minContextTokens) && r.minContextTokens >= 0
  && (r.minContextShare === undefined || isShare(r.minContextShare))
  && Number.isFinite(r.coldAfterGapMs) && r.coldAfterGapMs >= 0
  && typeof r.previousColdCounts === "boolean"
  && Number.isFinite(r.coldHitRate) && r.coldHitRate >= 0 && r.coldHitRate <= 1;

/**
 * A deployment's policy from its `REBUILD_POLICY` variable: unset is the default, `off` (any case) is none (no
 * decision is recorded), and anything else must be a whole policy as JSON. One that does not parse is refused —
 * logged, and the default used — rather than half-applied: a shadow reading under rules nobody wrote is worse than
 * the default's.
 */
export function rebuildPolicyOf(raw: string | undefined): RebuildPolicy | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REBUILD_POLICY;
  if (raw.trim().toLowerCase() === "off") return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p?.rules) && p.rules.every(isRule) && isRule(p.fallback)
      && (p.windowShare === undefined || isShare(p.windowShare))) return p as RebuildPolicy;
  } catch { /* refused below */ }
  logEvent("rebuild.policy.refused", { why: "REBUILD_POLICY is not a policy; the default applies" });
  return DEFAULT_REBUILD_POLICY;
}

// ---- the decision: a pure function of facts known before the wake's first call -----------------------------------

export interface RebuildFacts {
  /** ms from the end of the conversation's last answered model call to now; null when there has been none. */
  gapMs: number | null;
  /** That call's input tokens (the whole prompt); null when unknown or reset since. */
  contextTokens: number | null;
  provider: string;
  model: string;
  /** The model's window, for a window-relative threshold. */
  contextWindow: number;
  /** Whether the turn of that call reasoned; recorded, and used by no default rule (it misjudged half of DeepSeek's wakes). */
  prevReasoning: boolean | null;
  /** The previous measured wake's first-call hit rate; null when none was measured. */
  prevWakeHitRate: number | null;
}

export type RebuildReason =
  | "no-previous-call" | "context-unknown" | "context-below-threshold"
  | "gap-over-limit" | "previous-wake-cold" | "warm";

export interface RebuildDecision {
  /** Cold and large enough: what an acting step would do. */
  rebuild: boolean;
  /** The cache is predicted cold, whatever the size: what the measurement is compared with. */
  predictedCold: boolean;
  /** Cold by construction (no call yet, or a reset since): measured, and left out of the disagreement rate. */
  expectedCold: boolean;
  reason: RebuildReason;
  rule: string;
  thresholdTokens: number;
  coldAfterGapMs: number;
}

export function ruleFor(policy: RebuildPolicy, provider: string, model: string): RebuildRule {
  return policy.rules.find((r) =>
    (r.match.provider === undefined || r.match.provider === provider)
    && (r.match.modelIncludes === undefined || model.includes(r.match.modelIncludes))) ?? policy.fallback;
}

export function shouldRebuild(facts: RebuildFacts, policy: RebuildPolicy): RebuildDecision {
  const rule = ruleFor(policy, facts.provider, facts.model);
  const thresholdTokens = rule.minContextShare !== undefined
    ? Math.floor(rule.minContextShare * facts.contextWindow) : rule.minContextTokens;
  const out = (o: Pick<RebuildDecision, "rebuild" | "predictedCold" | "expectedCold" | "reason">): RebuildDecision =>
    ({ ...o, rule: rule.name, thresholdTokens, coldAfterGapMs: rule.coldAfterGapMs });
  if (facts.gapMs === null) return out({ rebuild: false, predictedCold: true, expectedCold: true, reason: "no-previous-call" });
  if (facts.contextTokens === null) return out({ rebuild: false, predictedCold: true, expectedCold: true, reason: "context-unknown" });
  const cold: RebuildReason | null = facts.gapMs > rule.coldAfterGapMs ? "gap-over-limit"
    : rule.previousColdCounts && facts.prevWakeHitRate !== null && facts.prevWakeHitRate < rule.coldHitRate ? "previous-wake-cold"
    : null;
  if (facts.contextTokens <= thresholdTokens) {
    return out({ rebuild: false, predictedCold: cold !== null, expectedCold: false, reason: "context-below-threshold" });
  }
  return out({ rebuild: cold !== null, predictedCold: cold !== null, expectedCold: false, reason: cold ?? "warm" });
}

/** Whether a context this size is a `window` rebuild: at or over the policy's share of the model's window. */
export function nearWindow(contextTokens: number | null, contextWindow: number, policy: RebuildPolicy): boolean {
  return contextTokens !== null && contextWindow > 0
    && contextTokens >= (policy.windowShare ?? DEFAULT_WINDOW_SHARE) * contextWindow;
}

// ---- reading the facts --------------------------------------------------------------------------------------------

/**
 * The decisions awaiting their outcome, and the newest measured one per transcript and trigger (the previous wake's
 * measured state is read from it). Never more than a few rows per transcript: each settle prunes.
 */
const SHADOW = `CREATE TABLE IF NOT EXISTS rebuild_shadow (
  id TEXT PRIMARY KEY, entries TEXT NOT NULL, trigger TEXT NOT NULL, strategy TEXT NOT NULL,
  decided_at INTEGER NOT NULL, would INTEGER NOT NULL, cold INTEGER NOT NULL, expected INTEGER NOT NULL,
  rule TEXT, cold_hit_rate REAL NOT NULL, settled_at INTEGER, hit_rate REAL)`;

const hasTable = (sql: Sql, name: string) =>
  sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** How far back the last answered call is looked for; a turn longer than this reads as "reasoning unknown". */
const TURN_SCAN = 400;

/**
 * An answer the provider gave: not an error, an abort, or the placeholder an offloaded call is written as while it is
 * out (`deferred`, `pending`). Only these measured anything about the cache.
 */
const answered = (stopReason: unknown) => stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";

/**
 * The transcript's side of the facts, read from the conversation's entries table (`piTables(session).entries`): when
 * its last answered model call ended, how large that request was, whether its turn reasoned, and the previous
 * measured wake's hit rate from this module's own table. Failed wakes since (a user message with only error answers
 * after it) are passed over: the cache is as warm as the last call that was answered. Only the fields read are
 * selected, never the bodies.
 */
export function readWakeFacts(sql: Sql, entries: string, now: number, boundaryWhere: string):
  Pick<RebuildFacts, "gapMs" | "contextTokens" | "prevReasoning" | "prevWakeHitRate"> {
  const rows = hasTable(sql, entries) ? sql.exec(
    `SELECT seq, timestamp, json_extract(body, '$.message.role') AS role, json_extract(body, '$.message.stopReason') AS stop, ` +
    `json_extract(body, '$.message.usage.input') AS input, json_extract(body, '$.message.usage.reasoning') AS reasoning, ` +
    `EXISTS (SELECT 1 FROM json_each(body, '$.message.content') WHERE json_extract(value, '$.type') = 'thinking') AS thought ` +
    `FROM ${entries} WHERE type = 'message' ORDER BY seq DESC LIMIT ?`, TURN_SCAN).toArray() : [];
  let last: { seq: number; at: number; input: number | null } | null = null;
  let reasoned: boolean | null = null;
  for (const r of rows as any[]) {
    if (!last) {
      if (r.role === "assistant" && answered(r.stop)) last = { seq: Number(r.seq), at: Number(r.timestamp), input: num(r.input) };
      else continue;
    }
    if (r.role === "user") { reasoned ??= false; break; }
    if (r.role === "assistant" && ((num(r.reasoning) ?? 0) > 0 || Number(r.thought) === 1)) reasoned = true;
  }
  // A compaction or reset after the last call leaves a context whose size that call does not tell.
  const reset = last && sql.exec(`SELECT 1 AS x FROM ${entries} WHERE (${boundaryWhere}) AND seq > ? LIMIT 1`, last.seq).toArray().length > 0;
  let prevWakeHitRate: number | null = null;
  if (hasTable(sql, "rebuild_shadow")) {
    // A wake's, never a compaction's, and never one cold by construction.
    const p = sql.exec("SELECT hit_rate FROM rebuild_shadow WHERE entries = ? AND trigger = 'cold-wake' AND expected = 0 " +
      "AND hit_rate IS NOT NULL ORDER BY settled_at DESC LIMIT 1", entries).toArray()[0] as any;
    prevWakeHitRate = p ? num(p.hit_rate) : null;
  }
  return {
    gapMs: last ? Math.max(0, now - last.at) : null,
    contextTokens: last && !reset ? last.input : null,
    prevReasoning: last ? reasoned : null,
    prevWakeHitRate,
  };
}

// ---- recording ----------------------------------------------------------------------------------------------------

/** What a decision row says happened: a shadow prediction, or the engine's own compaction that ran. */
export type DecisionStatus = "would-rebuild" | "would-keep" | "ran";

export interface DecisionRecord {
  tenantId: string; agentId: string;
  /**
   * The conversation's transcript, as the answer that settles the outcome names it: a pi085 entries table
   * (`piTables(session).entries`), or `pd:<conversation id>`.
   */
  key: string;
  trigger: RebuildTrigger;
  strategy: RebuildStrategy;
  wouldRebuild: boolean;
  /** What the next call's measured hit rate is compared with. */
  predictedCold: boolean;
  /** Cold by construction: the outcome is `expected-cold`, out of the disagreement rate. */
  expectedCold: boolean;
  status: DecisionStatus;
  reason: string;
  rule: string | null;
  /** Below this first-call hit rate the outcome reads as cold. */
  coldHitRate: number;
  /** Whether the next answer in `key` settles an outcome. */
  awaitOutcome: boolean;
  /** The facts, numbers and ids only. */
  facts: Record<string, string | number | boolean | null>;
  at: number;
}

/**
 * The `rebuild.decision` row and its log line, and, when an outcome is awaited, the pending row it settles. A decision
 * still pending for the same transcript and trigger (a post that threw, so no answer came) is dropped: the call it
 * predicted never went out. Inside the caller's transaction when there is one (`transact` is then the identity).
 */
export function recordRebuildDecision(sql: Sql, transact: <T>(fn: () => T) => T, d: DecisionRecord): string {
  const id = `rb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const attrs = {
    trigger: d.trigger, strategy: d.strategy, wouldRebuild: d.wouldRebuild, predictedCold: d.predictedCold,
    expectedCold: d.expectedCold, reason: d.reason, rule: d.rule, ...d.facts, shadow: true,
  };
  transact(() => {
    if (d.awaitOutcome) {
      sql.exec(SHADOW);
      sql.exec("DELETE FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND settled_at IS NULL", d.key, d.trigger);
      sql.exec("INSERT INTO rebuild_shadow(id, entries, trigger, strategy, decided_at, would, cold, expected, rule, cold_hit_rate) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)", id, d.key, d.trigger, d.strategy, d.at, d.wouldRebuild ? 1 : 0, d.predictedCold ? 1 : 0,
        d.expectedCold ? 1 : 0, d.rule, d.coldHitRate);
    }
    appendTrace(sql, [{
      at: d.at, tenantId: d.tenantId, agentId: d.agentId, kind: "rebuild.decision", spanId: id,
      status: d.status, verdict: "ok", attrs,
    }]);
  });
  logEvent("rebuild.decision", { tenantId: d.tenantId, agentId: d.agentId, decision: id, ...attrs });
  return id;
}

/** A cold-wake decision as a row: what `shouldRebuild` said and the facts it said it from. */
export function coldWakeRecord(o: {
  tenantId: string; agentId: string; key: string; conversation: string;
  facts: RebuildFacts; decision: RebuildDecision; coldHitRate: number; at: number;
}): DecisionRecord {
  const f = o.facts, d = o.decision;
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key, trigger: "cold-wake", strategy: "briefing",
    wouldRebuild: d.rebuild, predictedCold: d.predictedCold, expectedCold: d.expectedCold,
    status: d.rebuild ? "would-rebuild" : "would-keep",
    reason: d.reason, rule: d.rule, coldHitRate: o.coldHitRate, awaitOutcome: true,
    facts: {
      gapMs: f.gapMs, contextTokens: f.contextTokens, thresholdTokens: d.thresholdTokens,
      coldAfterGapMs: d.coldAfterGapMs, provider: f.provider, model: f.model,
      prevReasoning: f.prevReasoning, prevWakeHitRate: f.prevWakeHitRate, conversation: o.conversation,
    },
    at: o.at,
  };
}

/**
 * A `window` rebuild in shadow on pi085, which never compacts (src/runtime/pi-agent.ts): `context-near-window` when a
 * wake's context reaches the policy's share of the window, `overflow` when an answer is a context-overflow error. An
 * agent there fails every wake until something rebuilds its context; this is the row that says how often.
 */
export function windowRecord(o: {
  tenantId: string; agentId: string; key: string; reason: "context-near-window" | "overflow";
  contextTokens: number | null; contextWindow: number | null; at: number;
}): DecisionRecord {
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key, trigger: "window", strategy: "summary",
    wouldRebuild: true, predictedCold: true, expectedCold: true, status: "would-rebuild", reason: o.reason, rule: null,
    coldHitRate: 0.5, awaitOutcome: false,
    facts: { contextTokens: o.contextTokens, contextWindow: o.contextWindow },
    at: o.at,
  };
}

/**
 * pd's own compaction as a rebuild that ran: trigger `window` (pi's `threshold` or `overflow`) or `operator`
 * (`manual`), strategy `summary`, which is what compaction is today. It is not routed through `rebuild` here; this
 * only records it in the same vocabulary. The call after it is cold by construction, so its outcome is
 * `expected-cold`, with the context it left (that call's input) and its hit rate.
 */
export function compactionRecord(o: {
  tenantId: string; agentId: string; key: string; reason: string; contextTokens: number | null; at: number;
}): DecisionRecord {
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key,
    trigger: o.reason === "manual" ? "operator" : "window", strategy: "summary",
    wouldRebuild: true, predictedCold: true, expectedCold: true, status: "ran", reason: o.reason, rule: null,
    coldHitRate: 0.5, awaitOutcome: true,
    facts: { contextTokens: o.contextTokens },
    at: o.at,
  };
}

/** How a measured first call judges the prediction. */
export type RebuildAgreement = "agree" | "false-cold" | "false-warm" | "expected-cold" | "unmeasured";

export function agreementOf(predictedCold: boolean, hitRate: number | null, coldHitRate: number, expectedCold = false): RebuildAgreement {
  if (hitRate === null) return "unmeasured";
  if (expectedCold) return "expected-cold";
  const cold = hitRate < coldHitRate;
  return predictedCold === cold ? "agree" : predictedCold ? "false-cold" : "false-warm";
}

/**
 * The first answer to land in a transcript after a pending decision is the call it predicted: a cold-wake decision is
 * made only before a post to an idle conversation, so no earlier call was in flight, and a compaction's next answer is
 * the first one sent the compacted context. Called in the transaction that writes the answer; one table read when no
 * decision is pending, and nothing at all when none was ever made. An error answer is `unmeasured`: it says nothing
 * about the cache, and is never read as the previous wake's state.
 */
export function settleRebuildOutcome(sql: Sql, a: {
  tenantId: string; agentId: string; entries: string; jobId: string; at: number; stopReason?: unknown;
  usage?: { input?: unknown; cacheRead?: unknown } | null;
}) {
  if (!hasTable(sql, "rebuild_shadow")) return;
  const pending = sql.exec("SELECT id, trigger, strategy, would, cold, expected, rule, cold_hit_rate, decided_at FROM rebuild_shadow " +
    "WHERE entries = ? AND settled_at IS NULL", a.entries).toArray() as any[];
  if (!pending.length) return;
  const input = num(a.usage?.input), cacheRead = num(a.usage?.cacheRead);
  // A call with no input has no rate: excluded, never counted as 0.
  const hitRate = answered(a.stopReason) && input !== null && input > 0 && cacheRead !== null ? cacheRead / input : null;
  for (const p of pending) {
    const expected = Number(p.expected) === 1;
    const agreement = agreementOf(Number(p.cold) === 1, hitRate, Number(p.cold_hit_rate), expected);
    sql.exec("UPDATE rebuild_shadow SET settled_at = ?, hit_rate = ? WHERE id = ?", a.at, hitRate, String(p.id));
    // Only the newest measured row per trigger is ever read again (`readWakeFacts`).
    sql.exec("DELETE FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND settled_at IS NOT NULL AND id NOT IN " +
      "(SELECT id FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND settled_at IS NOT NULL AND expected = 0 " +
      "AND hit_rate IS NOT NULL ORDER BY settled_at DESC LIMIT 1)", a.entries, String(p.trigger), a.entries, String(p.trigger));
    const attrs = {
      decision: String(p.id), trigger: String(p.trigger), strategy: String(p.strategy),
      wouldRebuild: Number(p.would) === 1, predictedCold: Number(p.cold) === 1, expectedCold: expected,
      rule: p.rule === null ? null : String(p.rule),
      // `input` is the whole prompt: after a compaction, the context it left.
      input, cacheRead, hitRate, measuredCold: hitRate === null ? null : hitRate < Number(p.cold_hit_rate),
      agreement, sinceDecisionMs: Math.max(0, a.at - Number(p.decided_at)),
    };
    appendTrace(sql, [{
      at: a.at, tenantId: a.tenantId, agentId: a.agentId, kind: "rebuild.outcome", spanId: a.jobId, parentId: String(p.id),
      status: agreement, verdict: "ok", attrs,
    }]);
    logEvent("rebuild.outcome", { tenantId: a.tenantId, agentId: a.agentId, job: a.jobId, ...attrs });
  }
}

/**
 * An answer that is a context-overflow error, as a `window` rebuild in shadow (`windowRecord`). `overflowed` is the
 * caller's reading of the answer (pi-ai's `isContextOverflow`); the context's size is the last answered call's.
 */
export function recordOverflow(sql: Sql, a: {
  tenantId: string; agentId: string; entries: string; at: number; contextWindow: number | null; boundaryWhere: string;
}) {
  const { contextTokens } = readWakeFacts(sql, a.entries, a.at, a.boundaryWhere);
  recordRebuildDecision(sql, (fn) => fn(), windowRecord({
    tenantId: a.tenantId, agentId: a.agentId, key: a.entries, reason: "overflow", contextTokens, contextWindow: a.contextWindow, at: a.at,
  }));
}
