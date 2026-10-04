/**
 * Which agent a hook URL belongs to, without a control-plane read on every push.
 *
 * The index (`inbound_hooks`, D1) is in one region with read replication off, and most pushes enter
 * Cloudflare somewhere else: the lookup was a cross-region round trip, about 220 ms of a warm push
 * (measured on production, 2026-10-04). A hook's route never changes — a hook id is made once for one
 * (tenant, agent, alias) and only ever revoked — so the route is kept for `HOOK_ROUTE_TTL_MS`, in this
 * isolate's memory and in the colo's Cache API, and the index is read on a miss.
 *
 * Revocation does not wait for the TTL. Every revoke path drops the hook's secret from the agent's object
 * right after the index (cf/src/index.ts `adminHooks`, cf/src/runtime.ts `#inboundFor`), and an object asked
 * through a cached route about a hook with no secret answers `unrouted` (`AgentRuntime.receiveHook`): the
 * worker then forgets the route and asks the index, so a revoked hook answers 404 at once, as before. The
 * TTL bounds only the case where the index was revoked and the secret drop failed: such a hook is routed,
 * and delivers, for at most `HOOK_ROUTE_TTL_MS` after the last index read that cached it.
 *
 * Only a hook the index found is cached; an unknown id is asked about every time.
 */
import type { HookDirectory } from "./control-plane.ts";

export const HOOK_ROUTE_TTL_MS = 5 * 60_000;

export interface HookRoute { hookId: string; tenantId: string; agentId: string; alias: string }

/** Where a route came from: this isolate, the colo's cache, or the index. */
export type RouteSource = "memory" | "cache" | "index";

const memory = new Map<string, { route: HookRoute; until: number }>();

/** The Cache API's key for a hook's route: a URL nothing serves, on the request's own origin (the cache is per zone). */
const cacheKey = (origin: string, hookId: string) => new Request(`${origin}/__hook-route/${hookId}`);

function colo(): Cache | null {
  try { return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null; } catch { return null; }
}

function valid(v: unknown, hookId: string): v is { route: HookRoute; until: number } {
  const x = v as { route?: Partial<HookRoute>; until?: unknown } | null;
  return !!x && typeof x.until === "number" && !!x.route && x.route.hookId === hookId
    && typeof x.route.tenantId === "string" && typeof x.route.agentId === "string" && typeof x.route.alias === "string";
}

/**
 * The route for `hookId`, and where it came from; null when the index has no live hook by that id. The
 * expiry is carried inside the entry and checked here, so the bound does not rest on the cache honouring
 * its own max-age.
 */
export async function routeHook(dir: HookDirectory, origin: string, hookId: string, now: () => number = Date.now):
  Promise<{ route: HookRoute; from: RouteSource } | null> {
  const held = memory.get(hookId);
  if (held && held.until > now() && held.route.hookId === hookId) return { route: held.route, from: "memory" };
  memory.delete(hookId);
  const cache = colo();
  if (cache) {
    try {
      const hit = await cache.match(cacheKey(origin, hookId));
      const v = hit ? await hit.json().catch(() => null) : null;
      if (valid(v, hookId) && v.until > now()) {
        memory.set(hookId, v);
        return { route: v.route, from: "cache" };
      }
    } catch { /* a cache that cannot answer is a miss */ }
  }
  const row = await dir.lookup(hookId);
  if (!row) return null;
  const entry = { route: { hookId: row.hookId, tenantId: row.tenantId, agentId: row.agentId, alias: row.alias }, until: now() + HOOK_ROUTE_TTL_MS };
  memory.set(hookId, entry);
  if (cache) {
    const seconds = Math.ceil(HOOK_ROUTE_TTL_MS / 1000);
    try {
      await cache.put(cacheKey(origin, hookId), new Response(JSON.stringify(entry), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${seconds}` },
      }));
    } catch { /* not cached: the next push reads the index again */ }
  }
  return { route: entry.route, from: "index" };
}

/** Forget a hook's route here and in this colo's cache: its object said it has no secret for it. */
export async function forgetHookRoute(origin: string, hookId: string): Promise<void> {
  memory.delete(hookId);
  const cache = colo();
  if (cache) { try { await cache.delete(cacheKey(origin, hookId)); } catch { /* the expiry still bounds it */ } }
}

/** For tests: start from an empty isolate. */
export function clearHookRoutes() { memory.clear(); }
