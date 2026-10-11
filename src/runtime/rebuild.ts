/**
 * Context rebuild, decided at wake time — in shadow: the decision is recorded and never acted on, but for one rule.
 *
 * The exception is the idle rule (`IdleRule`, `idleRebuild`): a wake after a long idle on a context larger than a
 * briefing is rebuilt before it is answered (`#coldWake` in cf/src/runtime.ts, through `rebuildContext`). Its row is
 * the wake's one cold-wake decision, `status: ran` and `shadow: false` (`idleRebuildRecord`); a wake it does not
 * rebuild keeps its shadow row, which says why (`idleRebuild`).
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
 *   - a `window` decision for an answer that is a context-overflow error: the pi085 overflow backstop's, which acts
 *     on it (src/runtime/overflow-backstop.ts `recordBackstop`, status `ran` or `declined`, `shadow: false`).
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

// ---- the acting step's interface ----------------------------------------------------------------------------------

/** What asked for a rebuild: the window filling up, a wake after the cache went cold, or an operator. */
export type RebuildTrigger = "window" | "cold-wake" | "operator";
/** How the rebuilt context is made: a summary of the conversation, or a briefing assembled from state. */
export type RebuildStrategy = "summary" | "briefing";
/**
 * The argument of `rebuildContext` (`AgentRuntime.#rebuildContext`, cf/src/runtime.ts), the one entry every acting
 * rebuild goes through: the overflow backstop's (`window`), an operator's reset (`operator`) and a wake after a long
 * idle (`cold-wake`). Its event is `rebuild{trigger, strategy}`, apart from `compaction`.
 */
export interface RebuildRequest { trigger: RebuildTrigger; strategy: RebuildStrategy }

/**
 * The size a briefing is built to, in estimated tokens (src/runtime/overflow-backstop.ts `buildBriefing`), and the
 * default context an idle rebuild must exceed: a context no larger than the briefing that would replace it saves
 * nothing.
 */
export const BRIEFING_BUDGET_TOKENS = 8_000;

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

/**
 * The rule a wake after a long idle is rebuilt by, before it is answered: the gap since the conversation's last
 * answered call over `idleMinutes`, and that call's input over `minContextTokens`. Acted on, unlike the rules above.
 * `idleMinutes: null` turns it off for the models it covers.
 */
export interface IdleRule {
  idleMinutes: number | null;
  minContextTokens: number;
}

/**
 * The idle rule per model: `byModel`'s entry for the model id, else the longest key the id contains (`deepseek` covers
 * `deepseek-flash` and `deepseek-v4-pro`, `gpt-5.6-luna` covers `openai/gpt-5.6-luna`), else `default`. A decision
 * names the entry it applied (`idleRuleFor`).
 */
export interface IdlePolicy {
  default: IdleRule;
  byModel?: Record<string, IdleRule>;
}

/** First match wins; `fallback` covers a binding no rule names. */
export interface RebuildPolicy {
  rules: RebuildRule[];
  fallback: RebuildRule;
  /** A context at or over this share of the model's window is a `window` rebuild; 0.8 when absent. */
  windowShare?: number;
  /** The idle rebuild's rules: `DEFAULT_IDLE_POLICY` when absent, none at all when `false`. */
  idle?: IdlePolicy | false;
}

const HOUR_MS = 60 * 60_000;
export const DEFAULT_MIN_CONTEXT_TOKENS = 128_000;
export const DEFAULT_WINDOW_SHARE = 0.8;

/** Rebuild a wake after 50 minutes idle when the context is larger than a briefing (tygg, 2026-10-11). */
export const DEFAULT_IDLE_RULE: IdleRule = { idleMinutes: 50, minContextTokens: BRIEFING_BUDGET_TOKENS };
/** The two model families in production named on their own, so each can be tuned or turned off apart. */
export const DEFAULT_IDLE_POLICY: IdlePolicy = {
  default: DEFAULT_IDLE_RULE,
  byModel: { deepseek: DEFAULT_IDLE_RULE, "gpt-5.6-luna": DEFAULT_IDLE_RULE },
};

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
const isIdleRule = (r: any): boolean => !!r && typeof r === "object"
  && (r.idleMinutes === null || (Number.isFinite(r.idleMinutes) && r.idleMinutes > 0))
  && Number.isFinite(r.minContextTokens) && r.minContextTokens >= 0;
const isIdle = (i: any): boolean => i === undefined || i === false || (!!i && typeof i === "object" && isIdleRule(i.default)
  && (i.byModel === undefined || (!!i.byModel && typeof i.byModel === "object" && !Array.isArray(i.byModel)
    && Object.values(i.byModel).every(isIdleRule))));

/**
 * What a refused `REBUILD_POLICY` becomes: the default shadow rules, and no idle rebuild. A policy someone wrote and
 * got wrong is most likely an attempt to change what acts, so what acts is turned off rather than defaulted on.
 */
export const REFUSED_REBUILD_POLICY: RebuildPolicy = { ...DEFAULT_REBUILD_POLICY, idle: false };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The idle section as written, over the defaults: `false` stays off; an object's `default` is laid over
 * `DEFAULT_IDLE_RULE`, and each `byModel` entry, the default ones (`DEFAULT_IDLE_POLICY`) included, over that merged
 * default. So `{"byModel": {"deepseek": {"idleMinutes": null}}}` turns DeepSeek off and leaves the rest as they were,
 * and `{"default": {"idleMinutes": 90}}` moves every model the defaults name. Anything else is returned as it is, for
 * `isIdle` to refuse.
 */
function mergeIdle(idle: unknown): unknown {
  if (idle === undefined || idle === false || !plain(idle)) return idle;
  if (idle.default !== undefined && !plain(idle.default)) return idle;
  if (idle.byModel !== undefined && !plain(idle.byModel)) return idle;
  const def = { ...DEFAULT_IDLE_RULE, ...(idle.default as object | undefined) };
  const mine = (idle.byModel ?? {}) as Record<string, unknown>;
  const byModel: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(DEFAULT_IDLE_POLICY.byModel ?? {}), ...Object.keys(mine)])) {
    const entry = mine[k];
    byModel[k] = entry === undefined ? def : plain(entry) ? { ...def, ...entry } : entry;
  }
  return { default: def, byModel };
}

/**
 * A deployment's policy from its `REBUILD_POLICY` variable: unset is the default, `off` (any case) is none (nothing is
 * recorded or rebuilt), and anything else is JSON laid over the default: a field it leaves out is the default's, so
 * `{"idle": false}` alone turns idle rebuilds off and keeps the shadow rules (`mergeIdle` for the idle section). What
 * does not parse, or does not make a whole policy once merged, is refused, logged, and becomes
 * `REFUSED_REBUILD_POLICY`: the default's shadow rules, with nothing acted on.
 */
export function rebuildPolicyOf(raw: string | undefined): RebuildPolicy | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REBUILD_POLICY;
  if (raw.trim().toLowerCase() === "off") return null;
  try {
    const p = JSON.parse(raw);
    if (plain(p)) {
      const merged = {
        rules: p.rules ?? DEFAULT_REBUILD_POLICY.rules, fallback: p.fallback ?? DEFAULT_REBUILD_POLICY.fallback,
        windowShare: p.windowShare ?? DEFAULT_REBUILD_POLICY.windowShare,
        ...(p.idle !== undefined ? { idle: mergeIdle(p.idle) } : {}),
      } as any;
      if (Array.isArray(merged.rules) && merged.rules.every(isRule) && isRule(merged.fallback)
        && isShare(merged.windowShare) && isIdle(merged.idle)) return merged as RebuildPolicy;
    }
  } catch { /* refused below */ }
  logEvent("rebuild.policy.refused", { why: "REBUILD_POLICY is not a policy; the default shadow rules apply, and no idle rebuild" });
  return REFUSED_REBUILD_POLICY;
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
  /** That wake's gap, as its decision read it; null when none was measured or it predates the column. */
  prevWakeGapMs?: number | null;
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

export type IdleReason =
  | "idle-off" | "no-previous-call" | "context-unknown" | "gap-under-idle" | "context-below-briefing" | "idle-over-limit";

export interface IdleDecision {
  rebuild: boolean;
  reason: IdleReason;
  /** The config entry that applied: `default`, `byModel:<key>`, or `off` when the policy has no idle rules. */
  entry: string;
  idleMs: number | null;
  minContextTokens: number | null;
}

/** The idle rule for a model, and the entry it came from (`IdlePolicy`). */
export function idleRuleFor(policy: RebuildPolicy, model: string): { entry: string; rule: IdleRule | null } {
  const idle = policy.idle === undefined ? DEFAULT_IDLE_POLICY : policy.idle;
  if (idle === false) return { entry: "off", rule: null };
  const by = idle.byModel ?? {};
  const key = Object.hasOwn(by, model) ? model
    : Object.keys(by).filter((k) => k !== "" && model.includes(k)).sort((a, b) => b.length - a.length)[0];
  return key === undefined ? { entry: "default", rule: idle.default } : { entry: `byModel:${key}`, rule: by[key]! };
}

/**
 * Whether a wake is rebuilt before it is answered (`IdleRule`, the model's own by `idleRuleFor`): the gap strictly
 * over the rule's idle time, and the last answered call's input strictly over its context floor. A conversation with
 * no answered call, or reset since it, has nothing to rebuild from.
 */
export function idleRebuild(facts: Pick<RebuildFacts, "gapMs" | "contextTokens" | "model">, policy: RebuildPolicy): IdleDecision {
  const { entry, rule } = idleRuleFor(policy, facts.model);
  if (rule === null || rule.idleMinutes === null) {
    return { rebuild: false, reason: "idle-off", entry, idleMs: null, minContextTokens: rule?.minContextTokens ?? null };
  }
  const idleMs = rule.idleMinutes * 60_000;
  const out = (rebuild: boolean, reason: IdleReason): IdleDecision => ({ rebuild, reason, entry, idleMs, minContextTokens: rule.minContextTokens });
  if (facts.gapMs === null) return out(false, "no-previous-call");
  if (facts.contextTokens === null) return out(false, "context-unknown");
  if (facts.gapMs <= idleMs) return out(false, "gap-under-idle");
  if (facts.contextTokens <= rule.minContextTokens) return out(false, "context-below-briefing");
  return out(true, "idle-over-limit");
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
  rule TEXT, cold_hit_rate REAL NOT NULL, settled_at INTEGER, hit_rate REAL, gap_ms INTEGER)`;

/**
 * A table written before `gap_ms` was gets it, probed once per storage handle as src/runtime/inbound.ts probes its
 * added columns: a read of the previous wake's gap needs it. A row written before it reads null.
 */
const withGap = new WeakSet<object>();
function ensureGapColumn(sql: Sql) {
  if (withGap.has(sql)) return;
  try { sql.exec("SELECT gap_ms FROM rebuild_shadow WHERE 0"); } catch { sql.exec("ALTER TABLE rebuild_shadow ADD COLUMN gap_ms INTEGER"); }
  withGap.add(sql);
}

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
  Pick<RebuildFacts, "gapMs" | "contextTokens" | "prevReasoning" | "prevWakeHitRate" | "prevWakeGapMs"> {
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
  let prevWakeHitRate: number | null = null, prevWakeGapMs: number | null = null;
  if (hasTable(sql, "rebuild_shadow")) {
    ensureGapColumn(sql);
    // A wake's, never a compaction's, and never one cold by construction.
    const p = sql.exec("SELECT hit_rate, gap_ms FROM rebuild_shadow WHERE entries = ? AND trigger = 'cold-wake' AND expected = 0 " +
      "AND hit_rate IS NOT NULL ORDER BY settled_at DESC LIMIT 1", entries).toArray()[0] as any;
    prevWakeHitRate = p ? num(p.hit_rate) : null;
    prevWakeGapMs = p ? num(p.gap_ms) : null;
  }
  return {
    gapMs: last ? Math.max(0, now - last.at) : null,
    contextTokens: last && !reset ? last.input : null,
    prevReasoning: last ? reasoned : null,
    prevWakeHitRate,
    prevWakeGapMs,
  };
}

// ---- recording ----------------------------------------------------------------------------------------------------

/**
 * What a decision row says happened: a shadow prediction, a rebuild that ran (pd's own compaction, or the pi085
 * overflow backstop's, src/runtime/overflow-backstop.ts), or one the backstop's guard declined.
 */
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
  /** A prediction (the default) or a decision that was acted on: the overflow backstop's is not a shadow. */
  shadow?: boolean;
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
    expectedCold: d.expectedCold, reason: d.reason, rule: d.rule, ...d.facts, shadow: d.shadow ?? true,
  };
  transact(() => {
    if (d.awaitOutcome) {
      sql.exec(SHADOW);
      ensureGapColumn(sql);
      sql.exec("DELETE FROM rebuild_shadow WHERE entries = ? AND trigger = ? AND settled_at IS NULL", d.key, d.trigger);
      sql.exec("INSERT INTO rebuild_shadow(id, entries, trigger, strategy, decided_at, would, cold, expected, rule, cold_hit_rate, gap_ms) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, d.key, d.trigger, d.strategy, d.at, d.wouldRebuild ? 1 : 0, d.predictedCold ? 1 : 0,
        d.expectedCold ? 1 : 0, d.rule, d.coldHitRate, num(d.facts.gapMs));
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
  /** The conversation as its readers know it across overflow rebuilds (cf/src/fresh-context.ts `logicalMain`). */
  logicalConversation?: string;
  facts: RebuildFacts; decision: RebuildDecision; coldHitRate: number; at: number;
  /** Why the idle rule did not rebuild this wake (`idleRebuild`, or the runtime's own reason), and the entry it applied. */
  idle?: { reason: string; entry: string };
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
      logicalConversation: o.logicalConversation ?? o.conversation,
      ...(f.prevWakeGapMs !== undefined ? { prevWakeGapMs: f.prevWakeGapMs } : {}),
      ...(o.idle !== undefined ? { idleRebuild: o.idle.reason, idleEntry: o.idle.entry } : {}),
    },
    at: o.at,
  };
}

/**
 * A wake rebuilt before it was answered (`idleRebuild`): the one cold-wake decision for it, acted on, so not a shadow.
 * The facts are the shadow row's, and what the rebuild made: the transcript it ended and the one it started, the
 * briefing's size and blocks. Its first call is cold by construction (a new transcript), so its outcome is
 * `expected-cold`, with the context it was sent and its hit rate; `predictedCold` is still the prediction about the
 * context it replaced.
 */
export function idleRebuildRecord(o: {
  tenantId: string; agentId: string; key: string;
  from: string; to: string; logicalConversation: string;
  facts: RebuildFacts; decision: RebuildDecision; idle: IdleDecision; coldHitRate: number;
  briefing: { tokens: number; budgetTokens: number; messages: number; actions: number; inputs: number; done: number };
  rebuilds: number; at: number;
}): DecisionRecord {
  const f = o.facts, d = o.decision, b = o.briefing;
  return {
    tenantId: o.tenantId, agentId: o.agentId, key: o.key, trigger: "cold-wake", strategy: "briefing",
    wouldRebuild: true, predictedCold: d.predictedCold, expectedCold: true, status: "ran",
    reason: o.idle.reason, rule: "idle", coldHitRate: o.coldHitRate, awaitOutcome: true, shadow: false,
    facts: {
      acted: true, gapMs: f.gapMs, contextTokens: f.contextTokens,
      idleEntry: o.idle.entry, idleMs: o.idle.idleMs, minContextTokens: o.idle.minContextTokens,
      provider: f.provider, model: f.model, prevReasoning: f.prevReasoning,
      // What the wake's own first call can no longer measure (it is sent a new transcript): the prediction, and the
      // previous measured wake's hit rate and gap, so whether a warm cache was thrown away can be judged per model.
      // (`predictedCold` is the row's own field.)
      prevWakeHitRate: f.prevWakeHitRate, prevWakeGapMs: f.prevWakeGapMs ?? null,
      shadowReason: d.reason, shadowRule: d.rule, thresholdTokens: d.thresholdTokens,
      conversation: o.from, to: o.to, logicalConversation: o.logicalConversation,
      budgetTokens: b.budgetTokens, briefingTokens: b.tokens, messages: b.messages, actions: b.actions, inputs: b.inputs, done: b.done,
      rebuilds: o.rebuilds,
    },
    at: o.at,
  };
}

/**
 * A `window` rebuild in shadow on pi085, which never compacts (src/runtime/pi-agent.ts): `context-near-window` when a
 * wake's context reaches the policy's share of the window. An overflow itself is the backstop's own decision
 * (src/runtime/overflow-backstop.ts).
 */
export function windowRecord(o: {
  tenantId: string; agentId: string; key: string; reason: "context-near-window";
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

