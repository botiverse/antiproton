/**
 * Context rebuild, decided at wake time — in shadow: the decision is recorded and never acted on.
 *
 * A rebuild is a kind of compaction, not a new session: the conversation keeps its id, and what the model is sent
 * is rebuilt (a summary, or a briefing) instead of resuming a prefix the provider has most likely evicted. A wake
 * that resumes a large context whose cache has gone cold pays for the whole prompt again as uncached input; a
 * rebuild pays for a small one. Whether that trade is worth making depends on how well "cold" can be predicted
 * from what is known before the wake's first call, which is what this module measures.
 *
 * Two rows per measured wake, joined by the decision's id:
 *   - `rebuild.decision`, written just before the inbound post that starts the wake (`#deliverInbound` in
 *     cf/src/runtime.ts): what `shouldRebuild` said and the facts it said it from — a "no" with its reason as much
 *     as a "yes", since the disagreement rate needs both.
 *   - `rebuild.outcome`, written when that wake's first model answer lands (`settleRebuildOutcome`, called from
 *     src/store/pi-storage.ts in the transaction that writes the answer): the measured first-call hit rate
 *     (cacheRead / input) and whether the prediction was right, false-cold or false-warm.
 * Numbers and ids only: no text of the conversation is ever in either row.
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
  /** Below this first-call hit rate a wake is measured cold. The distribution is bimodal, so the value barely matters. */
  coldHitRate: number;
}

/** First match wins; `fallback` covers a binding no rule names. */
export interface RebuildPolicy { rules: RebuildRule[]; fallback: RebuildRule }

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MIN_CONTEXT_TOKENS = 128_000;

export const DEFAULT_REBUILD_POLICY: RebuildPolicy = {
  rules: [
    { name: "deepseek", match: { modelIncludes: "deepseek" }, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
      coldAfterGapMs: HOUR_MS, previousColdCounts: true, coldHitRate: 0.5 },
    { name: "openai-ttl", match: { modelIncludes: "gpt-" }, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
      coldAfterGapMs: HOUR_MS, previousColdCounts: false, coldHitRate: 0.5 },
  ],
  fallback: { name: "gap", match: {}, minContextTokens: DEFAULT_MIN_CONTEXT_TOKENS,
    coldAfterGapMs: HOUR_MS, previousColdCounts: false, coldHitRate: 0.5 },
};

const isRule = (r: any): r is RebuildRule => !!r && typeof r === "object" && typeof r.name === "string"
  && !!r.match && typeof r.match === "object"
  && (r.match.provider === undefined || typeof r.match.provider === "string")
  && (r.match.modelIncludes === undefined || typeof r.match.modelIncludes === "string")
  && Number.isFinite(r.minContextTokens) && r.minContextTokens >= 0
  && (r.minContextShare === undefined || (Number.isFinite(r.minContextShare) && r.minContextShare > 0))
  && Number.isFinite(r.coldAfterGapMs) && r.coldAfterGapMs >= 0
  && typeof r.previousColdCounts === "boolean"
  && Number.isFinite(r.coldHitRate);

/**
 * A deployment's policy from its `REBUILD_POLICY` variable: unset is the default, `off` is none (no decision is
 * recorded), and anything else must be a whole policy as JSON. One that does not parse is refused — logged, and the
 * default used — rather than half-applied: a shadow reading under rules nobody wrote is worse than the default's.
 */
export function rebuildPolicyOf(raw: string | undefined): RebuildPolicy | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REBUILD_POLICY;
  if (raw.trim() === "off") return null;
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p?.rules) && p.rules.every(isRule) && isRule(p.fallback)) return p as RebuildPolicy;
  } catch { /* refused below */ }
  logEvent("rebuild.policy.refused", { why: "REBUILD_POLICY is not a policy; the default applies" });
  return DEFAULT_REBUILD_POLICY;
}

// ---- the decision: a pure function of facts known before the wake's first call -----------------------------------

export interface RebuildFacts {
  /** ms from the end of the conversation's last model call to now; null when there has been none. */
  gapMs: number | null;
  /** The last request's input tokens (the whole prompt); null when unknown or reset since. */
  contextTokens: number | null;
  provider: string;
  model: string;
  /** The model's window, for a window-relative threshold. */
  contextWindow: number;
  /** Whether the previous turn reasoned; recorded, and used by no default rule (it misjudged half of DeepSeek's wakes). */
  prevReasoning: boolean | null;
  /** The previous measured wake's first-call hit rate; null when none was measured. */
  prevWakeHitRate: number | null;
}

export type RebuildReason =
  | "no-previous-call" | "context-unknown" | "context-below-threshold"
  | "gap-over-limit" | "previous-wake-cold" | "warm";

export interface RebuildDecision {
  rebuild: boolean;
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
  const out = (rebuild: boolean, reason: RebuildReason): RebuildDecision =>
    ({ rebuild, reason, rule: rule.name, thresholdTokens, coldAfterGapMs: rule.coldAfterGapMs });
  if (facts.gapMs === null) return out(false, "no-previous-call");
  if (facts.contextTokens === null) return out(false, "context-unknown");
  if (facts.contextTokens <= thresholdTokens) return out(false, "context-below-threshold");
  if (facts.gapMs > rule.coldAfterGapMs) return out(true, "gap-over-limit");
  if (rule.previousColdCounts && facts.prevWakeHitRate !== null && facts.prevWakeHitRate < rule.coldHitRate) {
    return out(true, "previous-wake-cold");
  }
  return out(false, "warm");
}

// ---- reading the facts --------------------------------------------------------------------------------------------

/**
 * The decisions awaiting their outcome, and the newest settled one per transcript and trigger (the previous wake's
 * measured state is read from it). Never more than a few rows per transcript: each settle prunes.
 */
const SHADOW = `CREATE TABLE IF NOT EXISTS rebuild_shadow (
  id TEXT PRIMARY KEY, entries TEXT NOT NULL, trigger TEXT NOT NULL, strategy TEXT NOT NULL,
  decided_at INTEGER NOT NULL, would INTEGER NOT NULL, rule TEXT, cold_hit_rate REAL NOT NULL,
  settled_at INTEGER, hit_rate REAL)`;

const hasTable = (sql: Sql, name: string) =>
  sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

/** How far back the previous turn is looked for; a turn with more entries than this reads as "reasoning unknown". */
const TURN_SCAN = 400;

/**
 * The transcript's side of the facts, read from the conversation's entries table (`piTables(session).entries`):
 * when its last model call ended, how large that request was, whether the turn it closed reasoned, and the
 * previous measured wake's hit rate from this module's own table.
 */
export function readWakeFacts(sql: Sql, entries: string, now: number, boundaryWhere: string):
  Pick<RebuildFacts, "gapMs" | "contextTokens" | "prevReasoning" | "prevWakeHitRate"> {
  const rows = hasTable(sql, entries)
    ? sql.exec(`SELECT seq, timestamp, body FROM ${entries} WHERE type = 'message' ORDER BY seq DESC LIMIT ?`, TURN_SCAN).toArray()
    : [];
  let last: { seq: number; at: number; input: number | null } | null = null;
  let reasoned: boolean | null = null;
  for (const r of rows as any[]) {
    let m: any;
    try { m = JSON.parse(String(r.body))?.message; } catch { continue; }
    if (m?.role === "user") { if (last) reasoned ??= false; break; }
    if (m?.role !== "assistant") continue;
    if (!last) last = { seq: Number(r.seq), at: Number(r.timestamp), input: num(m.usage?.input) };
    if ((num(m.usage?.reasoning) ?? 0) > 0 || (Array.isArray(m.content) && m.content.some((c: any) => c?.type === "thinking"))) reasoned = true;
  }
  // A compaction or reset after the last call leaves a context whose size that call does not tell.
  const reset = last && sql.exec(`SELECT 1 AS x FROM ${entries} WHERE (${boundaryWhere}) AND seq > ? LIMIT 1`, last.seq).toArray().length > 0;
  let prevWakeHitRate: number | null = null;
  if (hasTable(sql, "rebuild_shadow")) {
    // A wake's, never a compaction's: the call after a compaction is cold by construction.
    const p = sql.exec("SELECT hit_rate FROM rebuild_shadow WHERE entries = ? AND trigger = 'cold-wake' AND settled_at IS NOT NULL " +
      "ORDER BY settled_at DESC LIMIT 1", entries).toArray()[0] as any;
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

/** What a decision row says happened: a shadow prediction, or the engine's own compaction that ran or was declined. */
export type DecisionStatus = "would-rebuild" | "would-keep" | "ran" | "declined";

export interface DecisionRecord {
  tenantId: string; agentId: string;
  /**
   * The conversation's transcript, as the answer that settles the outcome names it: a pi085 entries table
   * (`piTables(session).entries`), or `pd:<conversation id>`.
   */
  key: string;
  trigger: RebuildTrigger;
  strategy: RebuildStrategy;
  /** Whether the next call is predicted cold: a shadow rebuild would make it so, and a compaction that ran did. */
  predictedCold: boolean;
  status: DecisionStatus;
  reason: string;
  rule: string | null;
  /** Below this first-call hit rate the outcome reads as cold. */
  coldHitRate: number;
  /** Whether the next answer in `key` settles an outcome; a declined compaction changed nothing to measure. */
  awaitOutcome: boolean;
  /** The facts, numbers and ids only. */
  facts: Record<string, string | number | boolean | null>;
  at: number;
}

/**
 * The `rebuild.decision` row and its log line, and, when an outcome is awaited, the pending row it settles. A decision
 * still pending for the same transcript (a post that threw, so no answer came) is dropped: the call it predicted never
 * went out. Inside the caller's transaction when there is one (`transact` is then the identity).
 */
export function recordRebuildDecision(sql: Sql, transact: <T>(fn: () => T) => T, d: DecisionRecord): string {
  const id = `rb_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const attrs = {
    trigger: d.trigger, strategy: d.strategy, wouldRebuild: d.predictedCold, reason: d.reason, rule: d.rule,
    ...d.facts, shadow: true,
  };
  transact(() => {
    if (d.awaitOutcome) {
      sql.exec(SHADOW);
      sql.exec("DELETE FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND settled_at IS NULL", d.key, d.trigger);
      sql.exec("INSERT INTO rebuild_shadow(id, entries, trigger, strategy, decided_at, would, rule, cold_hit_rate) VALUES (?,?,?,?,?,?,?,?)",
        id, d.key, d.trigger, d.strategy, d.at, d.predictedCold ? 1 : 0, d.rule, d.coldHitRate);
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
  const f = o.facts;
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key, trigger: "cold-wake", strategy: "briefing",
    predictedCold: o.decision.rebuild, status: o.decision.rebuild ? "would-rebuild" : "would-keep",
    reason: o.decision.reason, rule: o.decision.rule, coldHitRate: o.coldHitRate, awaitOutcome: true,
    facts: {
      gapMs: f.gapMs, contextTokens: f.contextTokens, thresholdTokens: o.decision.thresholdTokens,
      coldAfterGapMs: o.decision.coldAfterGapMs, provider: f.provider, model: f.model,
      prevReasoning: f.prevReasoning, prevWakeHitRate: f.prevWakeHitRate, conversation: o.conversation,
    },
    at: o.at,
  };
}

/**
 * The engine's own compaction as a rebuild: trigger `window` (pi's `threshold` or `overflow`) or `operator`
 * (`manual`), strategy `summary`, which is what compaction is today. It is not routed through `rebuild` here; this
 * only records it in the same vocabulary, so the window and cold-wake rows can be read side by side.
 */
export function compactionRecord(o: {
  tenantId: string; agentId: string; key: string; reason: string; ran: boolean;
  contextTokens: number | null; at: number; coldHitRate?: number;
}): DecisionRecord {
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key,
    trigger: o.reason === "manual" ? "operator" : "window", strategy: "summary",
    predictedCold: true, status: o.ran ? "ran" : "declined", reason: o.reason, rule: null,
    coldHitRate: o.coldHitRate ?? 0.5, awaitOutcome: o.ran,
    facts: { contextTokens: o.contextTokens },
    at: o.at,
  };
}

/** How a measured first call judges the prediction. */
export type RebuildAgreement = "agree" | "false-cold" | "false-warm" | "unmeasured";

export function agreementOf(predictedCold: boolean, hitRate: number | null, coldHitRate: number): RebuildAgreement {
  if (hitRate === null) return "unmeasured";
  const cold = hitRate < coldHitRate;
  return predictedCold === cold ? "agree" : predictedCold ? "false-cold" : "false-warm";
}

/**
 * The first answer to land in a transcript after a pending decision is the call it predicted: a cold-wake decision is
 * made only before a post to an idle conversation, so no earlier call was in flight, and a compaction's next answer is
 * the first one sent the compacted context. Called in the transaction that writes the answer; one table read when no
 * decision is pending, and nothing at all when none was ever made.
 */
export function settleRebuildOutcome(sql: Sql, a: {
  tenantId: string; agentId: string; entries: string; jobId: string; at: number;
  usage?: { input?: unknown; cacheRead?: unknown } | null;
}) {
  if (!hasTable(sql, "rebuild_shadow")) return;
  const pending = sql.exec("SELECT id, trigger, strategy, would, rule, cold_hit_rate, decided_at FROM rebuild_shadow " +
    "WHERE entries = ? AND settled_at IS NULL", a.entries).toArray() as any[];
  if (!pending.length) return;
  const input = num(a.usage?.input), cacheRead = num(a.usage?.cacheRead);
  // A call with no input has no rate: excluded, never counted as 0.
  const hitRate = input !== null && input > 0 && cacheRead !== null ? cacheRead / input : null;
  for (const p of pending) {
    const agreement = agreementOf(Number(p.would) === 1, hitRate, Number(p.cold_hit_rate));
    sql.exec("UPDATE rebuild_shadow SET settled_at = ?, hit_rate = ? WHERE id = ?", a.at, hitRate, String(p.id));
    // Only the newest settled row per trigger is ever read again (`readWakeFacts`).
    sql.exec("DELETE FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND id != ? AND settled_at IS NOT NULL",
      a.entries, String(p.trigger), String(p.id));
    const attrs = {
      decision: String(p.id), trigger: String(p.trigger), strategy: String(p.strategy), wouldRebuild: Number(p.would) === 1,
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
