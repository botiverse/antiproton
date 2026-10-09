/**
 * One agent's usage, as a caller outside this deployment may be shown it: the ledger's rows for one
 * agent and window (cf/src/usage-d1.ts), bucketed by hour or UTC day, with every kind of thing counted
 * once.
 *
 * The ledger keeps two relations as subsets rather than siblings (src/usage/outbox.ts
 * `modelTokenRows`, `toolCallRows`): `reasoning` is part of `output`, `cache_write_1h` is part of
 * `cache_write`, and a tool's `failed` is part of its `calls`. A reader that sums a resource's rows
 * would count each subset twice. So this is the one place that subtracts, per bucket and per model
 * or tool, and what leaves it can be summed by anyone: `output` without its reasoning, `reasoning`,
 * `cache_write_5m` (the total less the 1h part), `cache_write_1h`, and a tool's `succeeded` and
 * `failed` calls.
 *
 * Each row carries `cost` once the deployment prices anything (`UsageDeps.pricer`): estimated US dollars,
 * null for a row nobody priced. The ledger prices a subset key at its DIFFERENCE from the key that contains it
 * (cf/migrations/0005_usage.sql), so a row here is priced at its kind's whole rate — reasoning at output's rate
 * plus reasoning's difference, and so on — and the costs of a bucket's rows add up to what the ledger's
 * delta-priced rows add up to. `input` is the one quantity that still holds another (the whole prompt,
 * `cache_read` included); its cost is that of the uncached part, so the costs, unlike those two quantities,
 * can be summed.
 *
 * No caller's concepts here: the public API (cf/src/agents-api/handlers.ts) and the provider binding
 * (cf/src/provision/handlers.ts) both call `agentUsage` and add only how they named the agent.
 */
import { DAY_MS } from "../usage-windows.ts";

export const HOUR_MS = 3_600_000;
/** The widest window one read may ask for. */
export const USAGE_WINDOW_MAX_MS = 31 * DAY_MS;
/**
 * How far back hourly buckets are kept (cf/src/usage-d1.ts KEEP_HOURLY_DAYS): older days may have
 * been folded into one row at 00:00Z, which an hourly bucket would report as having happened at
 * midnight. Duplicated as a number rather than imported so this module needs no D1 code; the
 * suite pins the two together.
 */
export const HOURLY_KEPT_MS = 35 * DAY_MS;

export type UsageBucket = "1h" | "1d";

/** What the ledger holds for one agent: summed per bucket, resource, key and unit. */
export interface LedgerRow { bucket: number; resource: string; key: string; unit: string; quantity: number }

export interface UsageDeps {
  now(): number;
  /** The ledger's rows for one agent with `from <= hour < to`, summed into buckets of `bucketMs` (UTC). */
  ledger(tenantId: string, agentId: string, from: number, to: number, bucketMs: number): Promise<LedgerRow[]>;
  /**
   * When the oldest usage the agent has recorded but not yet sent to the ledger happened, or null
   * when it has sent everything. A read of the agent's own outbox; never a write.
   */
  backlogSince(tenantId: string, agentId: string): Promise<number | null>;
  /** Where a clamp is reported. */
  warn?(message: string): void;
  /**
   * The price of one ledger row, in dollars per unit, or null when nothing prices it (cf/src/usage-d1.ts
   * priceFor over the deployment's prices). Absent: rows carry no `cost` at all.
   */
  pricer?(): Promise<Pricer>;
}

/** Dollars per unit for a ledger row at its bucket's start; null: unpriced. */
export type Pricer = (row: { bucket: number; resource: string; key: string; unit: string }) => number | null;

export interface UsageQuery { from: number; to: number; bucket: UsageBucket }
export type UsageRefusal = { param: string; message: string };

export interface UsageRow {
  at: string; resource: string; dimensions: Record<string, string>; unit: string; quantity: number;
  /** Estimated US dollars; null when unpriced. Present only where the deployment has prices (`UsageDeps.pricer`). */
  cost?: number | null;
}
export interface AgentUsage { bucket: UsageBucket; from: string; to: string; asOf: string; partial: boolean; rows: UsageRow[] }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The query from a URL's parameters; a refusal names the parameter that is wrong. */
export function parseUsageQuery(q: URLSearchParams, now: number): UsageQuery | UsageRefusal {
  const time = (name: "from" | "to"): number | UsageRefusal => {
    const v = q.get(name);
    if (v === null || v === "") return { param: name, message: `${name} is required: an ISO 8601 time with a zone, e.g. 2026-10-01T00:00:00Z` };
    // A `+` offset left unencoded in a query string arrives as a space; it can only have been the `+`.
    const given = v.replace(/ (\d{2}:\d{2})$/, "+$1");
    const t = ISO.test(given) ? Date.parse(given) : NaN;
    return Number.isFinite(t) ? t : { param: name, message: `${name} is not an ISO 8601 time with a zone: ${JSON.stringify(v.slice(0, 40))}` };
  };
  const from = time("from");
  if (typeof from !== "number") return from;
  const to = time("to");
  if (typeof to !== "number") return to;
  const bucket = q.get("bucket") ?? "1h";
  if (bucket !== "1h" && bucket !== "1d") return { param: "bucket", message: "bucket is 1h or 1d" };
  if (to <= from) return { param: "to", message: "to must be later than from" };
  // The limit is on the window the caller asked for, which is what a caller can check before
  // asking (Raft validates the same 31 days). Widening to whole buckets adds at most one bucket.
  if (to - from > USAGE_WINDOW_MAX_MS) {
    return { param: "to", message: "the window from..to is at most 31 days" };
  }
  if (bucket === "1h" && from < now - HOURLY_KEPT_MS) {
    return { param: "bucket", message: "hourly buckets cover the last 35 days; use bucket=1d for an older window" };
  }
  return { from, to, bucket };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `<model>:<kind>`, split on the LAST colon: a model's own name may contain one. */
export function splitModelKey(key: string): { model: string; kind: string } | null {
  const i = key.lastIndexOf(":");
  return i <= 0 || i === key.length - 1 ? null : { model: key.slice(0, i), kind: key.slice(i + 1) };
}

/** The kinds the ledger writes for model tokens (src/usage/outbox.ts modelTokenRows). */
const MODEL_KINDS = new Set(["input", "output", "reasoning", "cache_read", "cache_write", "cache_write_1h"]);

/**
 * The ledger's rows as non-overlapping ones. Pure: the window, the bucket and the clamp report are
 * the only inputs besides the rows.
 */
export function nonOverlapping(rows: readonly LedgerRow[], warn: (m: string) => void = () => {}, price?: Pricer): Array<Omit<UsageRow, "at"> & { bucket: number }> {
  const out: Array<Omit<UsageRow, "at"> & { bucket: number }> = [];
  /**
   * A row's whole rate: the price of its own ledger key and unit plus those of every key or unit containing it
   * (`parts`, as [key, unit]); null if any of them is unpriced.
   */
  const rate = (bucket: number, resource: string, parts: Array<[string, string]>): number | null => {
    let r = 0;
    for (const [key, unit] of parts) {
      const p = price!({ bucket, resource, key, unit });
      if (p === null) return null;
      r += p;
    }
    return r;
  };
  const times = (q: number, r: number | null) => (r === null ? null : q * r);
  const models = new Map<string, { bucket: number; model: string; q: Record<string, number> }>();
  const tools = new Map<string, { bucket: number; tool: string; calls: number; failed: number }>();
  for (const r of rows) {
    const split = r.resource === "model.tokens" && r.unit === "tokens" ? splitModelKey(r.key) : null;
    if (split && MODEL_KINDS.has(split.kind)) {
      const id = JSON.stringify([r.bucket, split.model]);
      const m = models.get(id) ?? { bucket: r.bucket, model: split.model, q: {} };
      m.q[split.kind] = (m.q[split.kind] ?? 0) + r.quantity;
      models.set(id, m);
      continue;
    }
    if (r.resource === "tool.call" && (r.unit === "calls" || r.unit === "failed")) {
      const id = JSON.stringify([r.bucket, r.key]);
      const t = tools.get(id) ?? { bucket: r.bucket, tool: r.key, calls: 0, failed: 0 };
      if (r.unit === "calls") t.calls += r.quantity; else t.failed += r.quantity;
      tools.set(id, t);
      continue;
    }
    const asIs = price ? { cost: times(r.quantity, rate(r.bucket, r.resource, [[r.key, r.unit]])) } : {};
    if (r.resource === "tool.call" && r.unit === "ms") {
      // A tool's time is its own resource, so every tool.call row counts calls and every
      // tool.duration row counts milliseconds: rows of one resource always share a unit.
      out.push({ bucket: r.bucket, resource: "tool.duration", dimensions: { tool: r.key }, unit: "ms", quantity: r.quantity, ...asIs });
      continue;
    }
    if (split && r.resource === "model.tokens") {
      // A kind this reader does not know overlaps nothing it knows of; passed on under its own name.
      out.push({ bucket: r.bucket, resource: r.resource, dimensions: { model: split.model, kind: split.kind }, unit: r.unit, quantity: r.quantity, ...asIs });
      continue;
    }
    out.push({ bucket: r.bucket, resource: r.resource, dimensions: { key: r.key }, unit: r.unit, quantity: r.quantity, ...asIs });
  }
  /** A difference that went below zero means the ledger disagrees with itself; said, and shown as none. */
  const part = (what: string, n: number) => {
    if (n >= 0) return n;
    warn(`usage: ${what} came out at ${n}; shown as 0`);
    return 0;
  };
  for (const m of models.values()) {
    const q = (k: string) => m.q[k] ?? 0;
    const at = `${iso(m.bucket)} ${m.model}`;
    const k = (kind: string) => `${m.model}:${kind}`;
    const r = (...kinds: string[]) => (price ? rate(m.bucket, "model.tokens", kinds.map((kind): [string, string] => [k(kind), "tokens"])) : null);
    // `input` is the whole prompt and `cache_read` the cached part of it: input's cost is the uncached part's,
    // so it is the one cost here that is not quantity × rate (the module's header says why).
    const kinds: Array<[string, number]> = [
      ["input", part(`input for ${at}`, q("input"))],
      ["output", part(`output less reasoning for ${at}`, q("output") - q("reasoning"))],
      ["reasoning", part(`reasoning for ${at}`, q("reasoning"))],
      ["cache_read", part(`cache_read for ${at}`, q("cache_read"))],
      ["cache_write_5m", part(`cache_write less cache_write_1h for ${at}`, q("cache_write") - q("cache_write_1h"))],
      ["cache_write_1h", part(`cache_write_1h for ${at}`, q("cache_write_1h"))],
    ];
    /** The ledger keys whose prices add up to each kind's whole rate. */
    const rates: Record<string, string[]> = {
      input: ["input"], output: ["output"], reasoning: ["output", "reasoning"], cache_read: ["input", "cache_read"],
      cache_write_5m: ["cache_write"], cache_write_1h: ["cache_write", "cache_write_1h"],
    };
    for (const [kind, n] of kinds) {
      if (n === 0) continue;
      const billed = kind === "input" ? Math.max(0, n - q("cache_read")) : n;
      const cost = price ? { cost: times(billed, r(...rates[kind]!)) } : {};
      out.push({ bucket: m.bucket, resource: "model.tokens", dimensions: { model: m.model, kind }, unit: "tokens", quantity: n, ...cost });
    }
  }
  for (const t of tools.values()) {
    const at = `${iso(t.bucket)} ${t.tool}`;
    const succeeded = part(`calls less failed for ${at}`, t.calls - t.failed);
    const failed = part(`failed calls for ${at}`, t.failed);
    // A failed call is priced as a call plus the `failed` unit's difference (`failed` ⊂ `calls`).
    const cost = (n: number, units: string[]) =>
      (price ? { cost: times(n, rate(t.bucket, "tool.call", units.map((u): [string, string] => [t.tool, u]))) } : {});
    if (succeeded) out.push({ bucket: t.bucket, resource: "tool.call", dimensions: { tool: t.tool, outcome: "succeeded" }, unit: "calls", quantity: succeeded, ...cost(succeeded, ["calls"]) });
    if (failed) out.push({ bucket: t.bucket, resource: "tool.call", dimensions: { tool: t.tool, outcome: "failed" }, unit: "calls", quantity: failed, ...cost(failed, ["calls", "failed"]) });
  }
  const order = (r: { bucket: number; resource: string; dimensions: Record<string, string>; unit: string }) =>
    JSON.stringify([r.resource, Object.entries(r.dimensions), r.unit]);
  // Every row, passed through or computed, is a quantity of something that happened: none is negative.
  const shown = out.filter((r) => {
    if (r.quantity > 0) return true;
    if (r.quantity < 0) warn(`usage: ${r.resource} ${JSON.stringify(r.dimensions)} ${r.unit} at ${iso(r.bucket)} came out at ${r.quantity}; left out`);
    return false;
  });
  return shown.sort((a, b) => a.bucket - b.bucket || (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/**
 * One agent's usage over the window, bucketed. The window is widened to whole buckets: `from` down
 * and `to` up to a boundary, and the answer says which window it covers. `asOf` is how far the ledger
 * can speak for this agent — now, unless the agent holds usage it has not sent yet, in which case the
 * time of the oldest such row — and `partial` is true when any bucket in the window ends after it, or
 * the ledger marks part of the window as unreadable.
 */
export async function agentUsage(deps: UsageDeps, tenantId: string, agentId: string, q: UsageQuery): Promise<AgentUsage> {
  const size = q.bucket === "1d" ? DAY_MS : HOUR_MS;
  const from = Math.floor(q.from / size) * size;
  const to = Math.ceil(q.to / size) * size;
  const now = deps.now();
  let asOf = now;
  let unknown = false;
  try {
    const since = await deps.backlogSince(tenantId, agentId);
    if (since !== null && since < asOf) asOf = since;
  } catch (e) {
    // Not knowing what is still in the agent is not the same as knowing nothing is: the window is
    // reported as possibly incomplete.
    unknown = true;
    deps.warn?.(`usage: could not read ${agentId}'s unsent usage: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  const ledger = await deps.ledger(tenantId, agentId, from, to, size);
  const damaged = ledger.some((r) => r.unit === "unreadable");
  const price = deps.pricer ? await deps.pricer() : undefined;
  const rows = nonOverlapping(ledger, deps.warn, price).map(({ bucket, ...r }) => ({ at: iso(bucket), ...r }));
  return { bucket: q.bucket, from: iso(from), to: iso(to), asOf: iso(asOf), partial: to > asOf || damaged || unknown, rows };
}
