/**
 * What a run actually cost.
 *
 * Two meters run at once and they are not the same meter. Tokens are charged
 * per token and discounted heavily when the provider serves them from cache;
 * a container is charged for *existing*, by the second, whether the agent is
 * thinking or the model is. Reporting only tokens hides the second one
 * completely, and on a task with a real machine attached it can be the larger
 * of the two.
 *
 * No prices are hard-coded. A rate sheet changes without warning and a wrong
 * number in a benchmark report is worse than an absent one, so money appears
 * only when the rates are supplied — see `ratesFromEnv`.
 */
import type { StorageAdapter } from "../src/core/store.ts";

export interface Meter {
  /** Seconds a metered container existed, summed over every session. */
  containerSeconds: number;
  /** How many containers were started. */
  containers: number;
  /** Seconds the whole run took, wall clock. */
  wallSeconds: number;
  /** Container seconds as a share of wall clock, 0–1. */
  containerShare: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * Read the container meter off the mounts.
 *
 * The run9 plugin writes a session — box id, start, end, exec count — into its
 * mount's connection state when the box is handed back, precisely so the meter
 * outlives the box. Anything still running has no `endedAt` and is counted up
 * to now, because an unreleased container is the case worth seeing.
 */
export async function readMeter(
  store: StorageAdapter,
  tenantId: string,
  agentId: string,
  aliases: string[],
  wallMs: number,
  tokens: { promptTokens: number; cachedTokens: number; outputTokens: number },
  now = Date.now(),
): Promise<Meter> {
  let ms = 0, containers = 0;
  for (const alias of aliases) {
    const conn = (await store.getConnection(tenantId, agentId, alias)) as any;
    for (const s of conn?.state?.sessions ?? conn?.sessions ?? []) {
      const started = Number(s.startedAt ?? 0);
      if (!started) continue;
      containers += 1;
      ms += Math.max(0, Number(s.endedAt || now) - started);
    }
  }
  const containerSeconds = Math.round(ms / 1000);
  const wallSeconds = Math.round(wallMs / 1000);
  return {
    containerSeconds, containers, wallSeconds,
    containerShare: wallSeconds ? containerSeconds / wallSeconds : 0,
    ...tokens,
  };
}

export interface Rates {
  /** Per million tokens the provider actually re-read. */
  uncachedPerMTok?: number;
  /** Per million tokens served from cache. */
  cachedPerMTok?: number;
  /** Per million output tokens. */
  outputPerMTok?: number;
  /** Per container-second. */
  containerPerSecond?: number;
  currency?: string;
}

/**
 * Rates from the environment, or nothing.
 *
 * Absent means the report says "not priced" rather than guessing. Set them
 * explicitly when the rate sheet is at hand:
 *
 *   RATE_UNCACHED=0.28 RATE_CACHED=0.028 RATE_OUTPUT=0.42 RATE_CONTAINER=0.00004
 */
export function ratesFromEnv(env = process.env): Rates | null {
  const n = (k: string) => (env[k] === undefined ? undefined : Number(env[k]));
  const r: Rates = {
    uncachedPerMTok: n("RATE_UNCACHED"),
    cachedPerMTok: n("RATE_CACHED"),
    outputPerMTok: n("RATE_OUTPUT"),
    containerPerSecond: n("RATE_CONTAINER"),
    currency: env.RATE_CURRENCY ?? "USD",
  };
  return Object.values(r).some((v) => typeof v === "number" && !Number.isNaN(v)) ? r : null;
}

export function priced(m: Meter, r: Rates | null): { total: number; parts: Record<string, number> } | null {
  if (!r) return null;
  const uncached = Math.max(0, m.promptTokens - m.cachedTokens);
  const parts = {
    uncached: (uncached / 1e6) * (r.uncachedPerMTok ?? 0),
    cached: (m.cachedTokens / 1e6) * (r.cachedPerMTok ?? 0),
    output: (m.outputTokens / 1e6) * (r.outputPerMTok ?? 0),
    container: m.containerSeconds * (r.containerPerSecond ?? 0),
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/** One line, whatever is known. */
export function meterLine(m: Meter, r: Rates | null): string {
  const uncached = Math.max(0, m.promptTokens - m.cachedTokens);
  const pct = Math.round(m.containerShare * 100);
  const bits = [
    `${m.promptTokens} tok (${uncached} re-read)`,
    m.containers
      ? `container ${m.containerSeconds}s = ${pct}% of wall`
      : "no container",
  ];
  const p = priced(m, r);
  if (p) bits.push(`${(r!.currency ?? "USD")} ${p.total.toFixed(4)}`);
  return bits.join("  ·  ");
}
