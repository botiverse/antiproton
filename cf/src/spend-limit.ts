/**
 * Daily spend limits (credits phase 2; docs/metering.md, "Daily limits").
 *
 * Two limits per UTC day, both in US dollars at the ledger's prices (cf/src/usage-d1.ts `priceFor`):
 *
 * - **per tenant**: DAILY_LIMIT_USD (default $5), or an admin's override for that tenant (`spend_limits`,
 *   cf/migrations/0018_spend_limits.sql; NULL there is "no per-tenant limit");
 * - **platform**: PLATFORM_DAILY_LIMIT_USD (default $30) over every tenant's spend, `bench` included.
 *
 * A tenant in DAILY_LIMIT_EXEMPT_TENANTS (default `bench`) is refused by neither: it still counts toward the
 * platform total, which is what lets the platform limit see a benchmark's spend.
 *
 * What is counted is what the ledger prices, so what costs us money and nothing else: a key paid with the
 * tenant's own credential (`own:`) is priced 0 by `priceFor`, and an unpriced key counts nothing, as in every
 * view. `model.tokens.unaccepted` is our cost and is in the platform total, but not in a tenant's.
 *
 * The check is made once per model call, in the queue consumer, after the job is taken and before the provider
 * is called (`admit` in cf/src/model-queue.ts): the one place every model call of both engines goes through.
 * A refused call is answered, not thrown, so the queue acks it and nothing retries it (`refusalAnswer`).
 */
import { UNACCEPTED_TOKENS } from "../../src/usage/outbox.ts";
import { errorMessage, type AnsweredMessage } from "../../src/model/pi-bridge.ts";
import { logEvent } from "../../src/core/log.ts";
import { DAY_MS, priceFor, usagePrices } from "./usage-d1.ts";

export const DEFAULT_DAILY_LIMIT_USD = 5;
export const DEFAULT_PLATFORM_DAILY_LIMIT_USD = 30;
export const DEFAULT_EXEMPT_TENANTS: readonly string[] = ["bench"];

/**
 * How long one isolate trusts a reading of today's spend. Far from both limits a reading is kept for
 * `SPEND_CACHE_MS`; within `NEAR_FRACTION` of either it is kept for `SPEND_CACHE_NEAR_MS`, so the calls that can
 * cross a limit are the ones read most often. Together with the ledger's own lag (an object sends its usage at
 * the end of an alarm pass, cf/src/usage-flush.ts) this is what bounds the overshoot (docs/metering.md).
 */
export const SPEND_CACHE_MS = 30_000;
export const SPEND_CACHE_NEAR_MS = 5_000;
export const NEAR_FRACTION = 0.8;

/**
 * The refused answer's `errorMessage`: fixed text, because both engines' harnesses decide whether to retry a
 * failed turn by scanning that string (pi-ai `isRetryableAssistantError`), and both read it for an overflow
 * (src/runtime/overflow-backstop.ts `overflowKind`, pi-ai `isContextOverflow`). It matches none of their retryable
 * or overflow patterns, and "out of budget" is in pi-ai's non-retryable list. The sentence an owner reads, with
 * the figures, travels in `providerError`, which `failureText` (src/model/pi-bridge.ts) shows.
 */
export const SPEND_LIMIT_ERROR = "usage limit reached (out of budget); see the turn's error";
export const PLATFORM_LIMIT_TEXT = "Platform daily usage limit reached; resets at 00:00 UTC.";
export const tenantLimitText = (spentUsd: number, limitUsd: number) =>
  `Daily usage limit reached ($${spentUsd.toFixed(2)} of $${limitUsd.toFixed(2)}); resets at 00:00 UTC.`;

export interface SpendLimitEnv { DAILY_LIMIT_USD?: string; PLATFORM_DAILY_LIMIT_USD?: string; DAILY_LIMIT_EXEMPT_TENANTS?: string }
export interface SpendLimits { tenantUsd: number | null; platformUsd: number | null; exempt: ReadonlySet<string> }

/**
 * A dollar var: unset or empty is the default, `off` is no limit, a number at or above 0 is that. Anything else
 * is logged and read as the default: a typo must not lift a cap on money.
 */
function usdVar(name: string, v: unknown, fallback: number): number | null {
  const s = v === undefined || v === null ? "" : String(v).trim().toLowerCase();
  if (s === "") return fallback;
  if (s === "off") return null;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return n;
  logEvent("spend_limit.bad_config", { name, value: s.slice(0, 40) });
  return fallback;
}

export function limitsOf(env: SpendLimitEnv): SpendLimits {
  const exempt = env.DAILY_LIMIT_EXEMPT_TENANTS === undefined
    ? DEFAULT_EXEMPT_TENANTS
    : String(env.DAILY_LIMIT_EXEMPT_TENANTS).split(",").map((t) => t.trim()).filter(Boolean);
  return {
    tenantUsd: usdVar("DAILY_LIMIT_USD", env.DAILY_LIMIT_USD, DEFAULT_DAILY_LIMIT_USD),
    platformUsd: usdVar("PLATFORM_DAILY_LIMIT_USD", env.PLATFORM_DAILY_LIMIT_USD, DEFAULT_PLATFORM_DAILY_LIMIT_USD),
    exempt: new Set(exempt),
  };
}

export const dayOf = (t: number) => Math.floor(t / DAY_MS) * DAY_MS;

/** Today's spend so far, as one read of the ledger sees it. `override` null: no row; `{ limitUsd: null }`: unlimited. */
export interface DaySpend { day: number; tenantUsd: number; platformUsd: number; override: { limitUsd: number | null } | null }

/**
 * Today's (UTC) priced spend for `tenantId` and for every tenant, from `usage_hourly` (today is never folded:
 * KEEP_HOURLY_DAYS), and the tenant's override. Three reads in parallel, one round trip's wait.
 */
export async function readDaySpend(db: D1Database, tenantId: string, now: number): Promise<DaySpend> {
  const day = dayOf(now);
  const [rows, prices, override] = await Promise.all([
    db.prepare(
      `SELECT tenant_id = ? AS mine, hour, resource, key, unit, SUM(quantity) AS quantity FROM usage_hourly
       WHERE hour >= ? AND hour < ? GROUP BY mine, hour, resource, key, unit`,
    ).bind(tenantId, day, day + DAY_MS).all(),
    usagePrices(db),
    db.prepare("SELECT limit_usd FROM spend_limits WHERE tenant_id = ?").bind(tenantId).first() as Promise<any>,
  ]);
  let tenantUsd = 0;
  let platformUsd = 0;
  for (const r of (rows.results ?? []) as any[]) {
    const row = { bucket: Number(r.hour), resource: String(r.resource), key: String(r.key), unit: String(r.unit) };
    const p = priceFor(prices, row);
    if (p === null) continue;
    const cost = p * Number(r.quantity);
    platformUsd += cost;
    if (Number(r.mine) === 1 && row.resource !== UNACCEPTED_TOKENS) tenantUsd += cost;
  }
  return {
    day, tenantUsd, platformUsd,
    override: override ? { limitUsd: override.limit_usd === null || override.limit_usd === undefined ? null : Number(override.limit_usd) } : null,
  };
}

export type Admission =
  | { admit: true; why: "exempt" | "under" | "read_failed" }
  | { admit: false; limit: "platform" | "tenant"; text: string };

/** What today's spend says for a tenant that is not exempt. The platform limit is asked first: when it is reached nobody works. */
export function judge(spend: DaySpend, limits: SpendLimits): Admission {
  if (limits.platformUsd !== null && spend.platformUsd >= limits.platformUsd) return { admit: false, limit: "platform", text: PLATFORM_LIMIT_TEXT };
  const tenantLimit = spend.override ? spend.override.limitUsd : limits.tenantUsd;
  if (tenantLimit !== null && spend.tenantUsd >= tenantLimit) return { admit: false, limit: "tenant", text: tenantLimitText(spend.tenantUsd, tenantLimit) };
  return { admit: true, why: "under" };
}

function near(spend: DaySpend, limits: SpendLimits): boolean {
  const tenantLimit = spend.override ? spend.override.limitUsd : limits.tenantUsd;
  return (limits.platformUsd !== null && spend.platformUsd >= limits.platformUsd * NEAR_FRACTION)
    || (tenantLimit !== null && spend.tenantUsd >= tenantLimit * NEAR_FRACTION);
}

/**
 * The check, with each tenant's last reading kept in this isolate's memory for `SPEND_CACHE_MS` (or
 * `SPEND_CACHE_NEAR_MS` near a limit), so a busy agent costs one D1 read per window rather than one per call.
 * A reading from an earlier UTC day is never used: at 00:00 UTC every tenant is read afresh, which is the reset.
 *
 * A read that fails admits the call and logs `spend_limit.read_failed`: availability is worth more than a cap of a
 * few dollars, and the ledger is unchanged, so the next read that works refuses as it should. A failure is not
 * kept, so the next call reads again.
 */
export class SpendGate {
  readonly #cache = new Map<string, { at: number; spend: DaySpend }>();
  readonly #read: (tenantId: string, now: number) => Promise<DaySpend>;
  readonly #limits: SpendLimits;
  readonly #now: () => number;

  constructor(read: (tenantId: string, now: number) => Promise<DaySpend>, limits: SpendLimits, now: () => number = Date.now) {
    this.#read = read;
    this.#limits = limits;
    this.#now = now;
  }

  async admit(tenantId: string): Promise<Admission> {
    if (this.#limits.exempt.has(tenantId)) return { admit: true, why: "exempt" };
    const now = this.#now();
    let hit = this.#cache.get(tenantId);
    const fresh = hit && hit.spend.day === dayOf(now)
      && now - hit.at < (near(hit.spend, this.#limits) ? SPEND_CACHE_NEAR_MS : SPEND_CACHE_MS);
    if (!fresh) {
      try {
        hit = { at: now, spend: await this.#read(tenantId, now) };
      } catch (e) {
        logEvent("spend_limit.read_failed", { tenantId, error: String((e as Error)?.message ?? e).slice(0, 200) });
        return { admit: true, why: "read_failed" };
      }
      // Tenants come and go; an isolate that has seen many starts over rather than keeping them all.
      if (this.#cache.size >= 10_000) this.#cache.clear();
      this.#cache.set(tenantId, hit);
    }
    const verdict = judge(hit!.spend, this.#limits);
    if (!verdict.admit) {
      logEvent("spend_limit.refused", {
        tenantId, limit: verdict.limit, tenantUsd: round(hit!.spend.tenantUsd), platformUsd: round(hit!.spend.platformUsd),
      });
    }
    return verdict;
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The answer a refused call is delivered: a failed turn, with no usage (so the ledger writes nothing for it,
 * docs/metering.md "Verdicts"), the fixed `SPEND_LIMIT_ERROR`, and the sentence for the owner and the agent's
 * transcript in `providerError`. Named for the model the job would have called, like any answer to it.
 */
export function refusalAnswer(text: string, jobId: string, model: { api: string; provider: string; id: string }): AnsweredMessage {
  return { ...errorMessage(SPEND_LIMIT_ERROR, model), providerError: text, jobId };
}

// ---- the admin's per-tenant overrides ---------------------------------------------------------------------------

export interface SpendLimitRow { tenantId: string; limitUsd: number | null; setBy: string; setAt: number }
export interface SpendLimitEvent { tenantId: string; action: "set" | "clear"; limitUsd: number | null; previous: { limitUsd?: number | null }; by: string; at: number }

export interface SpendLimitStore {
  list(): Promise<SpendLimitRow[]>;
  events(limit: number): Promise<SpendLimitEvent[]>;
  /** Writes the row and its audit event in one batch. */
  set(tenantId: string, limitUsd: number | null, by: string, at: number): Promise<void>;
  /** Removes the row and records it; false when there was none (nothing is recorded then). */
  clear(tenantId: string, by: string, at: number): Promise<boolean>;
}

export function d1SpendLimits(db: D1Database): SpendLimitStore {
  const current = async (tenantId: string) => {
    const r: any = await db.prepare("SELECT limit_usd FROM spend_limits WHERE tenant_id = ?").bind(tenantId).first();
    return r ? { limitUsd: r.limit_usd === null ? null : Number(r.limit_usd) } : null;
  };
  const event = (tenantId: string, action: "set" | "clear", limitUsd: number | null, previous: object, by: string, at: number) =>
    db.prepare("INSERT INTO spend_limit_events (tenant_id, action, limit_usd, previous, by, at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(tenantId, action, limitUsd, JSON.stringify(previous), by, at);
  return {
    async list() {
      const { results } = await db.prepare("SELECT tenant_id, limit_usd, set_by, set_at FROM spend_limits ORDER BY tenant_id").all();
      return ((results ?? []) as any[]).map((r) => ({
        tenantId: String(r.tenant_id), limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), setBy: String(r.set_by), setAt: Number(r.set_at),
      }));
    },
    async events(limit) {
      const { results } = await db.prepare(
        "SELECT tenant_id, action, limit_usd, previous, by, at FROM spend_limit_events ORDER BY id DESC LIMIT ?").bind(limit).all();
      return ((results ?? []) as any[]).map((r) => ({
        tenantId: String(r.tenant_id), action: r.action === "clear" ? "clear" as const : "set" as const,
        limitUsd: r.limit_usd === null ? null : Number(r.limit_usd), previous: JSON.parse(String(r.previous || "{}")), by: String(r.by), at: Number(r.at),
      }));
    },
    async set(tenantId, limitUsd, by, at) {
      const previous = await current(tenantId);
      await db.batch([
        db.prepare(
          `INSERT INTO spend_limits (tenant_id, limit_usd, set_by, set_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET limit_usd = excluded.limit_usd, set_by = excluded.set_by, set_at = excluded.set_at`,
        ).bind(tenantId, limitUsd, by, at),
        event(tenantId, "set", limitUsd, previous ?? {}, by, at),
      ]);
    },
    async clear(tenantId, by, at) {
      const previous = await current(tenantId);
      if (!previous) return false;
      await db.batch([
        db.prepare("DELETE FROM spend_limits WHERE tenant_id = ?").bind(tenantId),
        event(tenantId, "clear", null, previous, by, at),
      ]);
      return true;
    },
  };
}

const TENANT = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * `/admin/spend-limits`, for an admin (auth.ts isAdmin, checked by the caller, as for /admin/models):
 *
 *   GET                                        → { defaults: { tenantUsd, platformUsd, exempt }, overrides, events }
 *   PUT    { tenantId, limitUsd: number|null } → the row as kept; null is "no per-tenant limit"
 *   DELETE { tenantId }                        → 204, or 404 when the tenant had no override
 *
 * Every PUT and DELETE writes an audit row (`spend_limit_events`). A change reaches a running isolate within
 * `SPEND_CACHE_MS`, the life of its last reading.
 */
export async function adminSpendLimits(
  method: string, body: unknown, actor: string, deps: { store: SpendLimitStore; limits: SpendLimits; now(): number },
): Promise<Response> {
  if (method === "GET") {
    return json({
      currency: "USD",
      defaults: { tenantUsd: deps.limits.tenantUsd, platformUsd: deps.limits.platformUsd, exempt: [...deps.limits.exempt].sort() },
      overrides: await deps.store.list(),
      events: await deps.store.events(50),
    });
  }
  if (method !== "PUT" && method !== "DELETE") return refuse(405, "method", "GET, PUT or DELETE");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const allowed = method === "PUT" ? ["tenantId", "limitUsd"] : ["tenantId"];
  const unknown = Object.keys(b).find((k) => !allowed.includes(k));
  if (unknown) return refuse(400, "unknown_field", `unknown field ${unknown}`);
  if (typeof b.tenantId !== "string" || !TENANT.test(b.tenantId)) return refuse(422, "invalid", "tenantId is a tenant's id");
  const at = deps.now();
  if (method === "DELETE") {
    return (await deps.store.clear(b.tenantId, actor, at))
      ? new Response(null, { status: 204 })
      : refuse(404, "not_found", "that tenant has no override");
  }
  if (!("limitUsd" in b)) return refuse(422, "invalid", "limitUsd is a number of dollars at or above 0, or null for no per-tenant limit");
  const limitUsd = b.limitUsd;
  if (limitUsd !== null && !(typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd >= 0)) {
    return refuse(422, "invalid", "limitUsd is a number of dollars at or above 0, or null for no per-tenant limit");
  }
  await deps.store.set(b.tenantId, limitUsd as number | null, actor, at);
  return json({ tenantId: b.tenantId, limitUsd, setBy: actor, setAt: at });
}

const json = (v: unknown) => Response.json(v, { headers: { "cache-control": "no-store" } });
function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The queue consumer's `admit` (cf/src/model-queue.ts): null to call the provider, or the refusal to deliver. The
 * refusal names the model the call would have reached, as `callQueuedModel` (cf/src/model-request.ts) would.
 */
export function spendAdmit(gate: Pick<SpendGate, "admit">, defaultModel: string) {
  return async (job: unknown, m: { tenantId: string; jobId: string }): Promise<AnsweredMessage | null> => {
    const verdict = await gate.admit(m.tenantId);
    if (verdict.admit) return null;
    const j = job as { model?: { api?: unknown; provider?: unknown }; operatorModel?: unknown } | null;
    return refusalAnswer(verdict.text, m.jobId, {
      api: String(j?.model?.api ?? "offloaded"), provider: String(j?.model?.provider ?? "openai-compatible"), id: String(j?.operatorModel ?? defaultModel),
    });
  };
}

/**
 * One gate per isolate, so its readings outlive a single queue batch. Rebuilt when the limits' vars differ (a new
 * deployment's isolate has new ones anyway); the D1 binding is taken from the latest environment on every read.
 */
let shared: { key: string; gate: SpendGate; db: { current: D1Database | undefined } } | null = null;
export function sharedSpendGate(env: SpendLimitEnv & { CONTROL_DB?: D1Database }): SpendGate {
  const key = JSON.stringify([env.DAILY_LIMIT_USD, env.PLATFORM_DAILY_LIMIT_USD, env.DAILY_LIMIT_EXEMPT_TENANTS]);
  if (!shared || shared.key !== key) {
    const db = { current: env.CONTROL_DB };
    shared = {
      key, db,
      gate: new SpendGate((tenantId, now) => {
        if (!db.current) throw new Error("no CONTROL_DB binding");
        return readDaySpend(db.current, tenantId, now);
      }, limitsOf(env)),
    };
  }
  shared.db.current = env.CONTROL_DB;
  return shared.gate;
}
