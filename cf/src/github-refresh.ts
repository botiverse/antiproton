/**
 * Keeping an expiring GitHub connection alive (#935): the access token on a mount is renewed before it
 * expires and once after GitHub refuses it, and a renewal GitHub refuses marks the connection as needing
 * its person to connect again.
 *
 * Where things live. The mount's own secret (named after the alias) stays the bare access token, so
 * everything that reads a mount's credential — the plugin, the sandbox's egress, a program's calls —
 * reads it exactly as before. Beside it, `oauth:<name>` holds the refresh token, both expiries and the
 * connector the pair came from, sealed with the same key. A connector (D1 `connectors`, 0023) holds the
 * pair too, and for a connector-backed mount it is the authority: several agents share it, and GitHub's
 * refresh token is single-use and spends the old access token with it, so a renewal happens there,
 * under a lease, and every bound mount copies the result.
 *
 * Serialised three ways, for three kinds of racer:
 *  - calls inside this object (the agent, its subagents, a program's calls) chain on an in-memory
 *    promise per mount, and each one re-reads what the one before it wrote;
 *  - a second runtime in the same object, which shares the storage but not the memory, sees the stored
 *    guard (`oauth_refreshing`) and waits for it;
 *  - another agent's object meets the connector's lease in D1.
 */
import { logEvent } from "../../src/core/log.ts";
import { open, seal, type Sealed } from "../../src/runtime/secrets.ts";
import type { StorageAdapter } from "../../src/core/store.ts";
import type { ConnectorGrant, ConnectorGrants } from "./control-plane.ts";
import { refreshGithubToken, REFRESH_SKEW_MS } from "./github-token.ts";

/** The row beside a mount's secret that renews it. ":" keeps it apart from every alias (MOUNT_ALIAS has none). */
export const OAUTH_PREFIX = "oauth:";
/** How long the right to trade a refresh token is held; GitHub answers well within it. */
export const LEASE_MS = 30_000;
/**
 * How a dead connection is said to Raft: the words Raft's own managed-MCP OAuth connectors use for the same
 * state, so it can render both alike. What GitHub actually said is kept beside it (`broken_reason`), not here.
 */
export type OAuthStatus = "connected" | "disconnected" | "error";
export const RECONNECT_REASON = "OAuth authorization expired; reconnect required";

/** What renews one mount's access token. Sealed as JSON under `oauth:<name>`. */
export interface MountGrant {
  v: 1;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  connectorId: string | null;
  brokenAt?: number | null;
  brokenReason?: string | null;
}

export interface GithubApp { clientId: string; clientSecret: string }

/** Why a renewal was asked for. `adopt` never trades: it takes the pair another agent's renewal stored. */
export type Why = "expiring" | "rejected" | "adopt";

export type Renewed =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresAt: number | null; refreshExpiresAt: number | null;
      /** A new pair was traded for here; false when one already stored was taken. */
      rotated: boolean }
  | { ok: false; broken: true; reason: string }
  | { ok: false; broken: false; reason: string; missing?: true };

/** The sentence an agent's tool result carries when only the person can mend it. */
export function reconnectSentence(reason: string): string {
  return `${RECONNECT_REASON}: the GitHub connection could not be renewed (${reason}), so the user must reconnect GitHub ` +
    "(Connect GitHub on the agent's page); retrying will not help";
}

interface ConnectorDeps {
  grants: ConnectorGrants;
  kek: CryptoKey;
  app: GithubApp | null;
  fetch?: typeof fetch;
  now(): number;
  sleep?(ms: number): Promise<void>;
}

const fresh = (expiresAt: number | null, now: number) => expiresAt === null || expiresAt - now > REFRESH_SKEW_MS;

async function pairOf(kek: CryptoKey, k: ConnectorGrant, rotated: boolean): Promise<Renewed> {
  return {
    ok: true, accessToken: await open(kek, k.sealed), refreshToken: k.refresh ? await open(kek, k.refresh.sealed) : null,
    expiresAt: k.refresh?.expiresAt ?? null, refreshExpiresAt: k.refresh?.refreshExpiresAt ?? null, rotated,
  };
}

/**
 * A connector's current pair, renewed first when `why` says it has to be. Usable from an agent's object and from
 * another: what keeps two agents' objects from both trading the refresh token is the lease in D1, not memory.
 * `stale` is the access token the caller holds (the one GitHub refused, for `rejected`): a connector already
 * holding a different, fresh one answers with that instead of renewing.
 */
export async function renewConnector(d: ConnectorDeps, tenantId: string, id: string, why: Why, stale: string | null): Promise<Renewed> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let k = await d.grants.grant(tenantId, id);
  if (!k) return { ok: false, broken: false, reason: "the connector is gone", missing: true };
  if (k.brokenAt) return { ok: false, broken: true, reason: k.brokenReason ?? "refused" };
  const needs = async (g: ConnectorGrant) => {
    if (!g.refresh || why === "adopt") return false;
    if (!fresh(g.refresh.expiresAt, d.now())) return true;
    // Refused by GitHub while not yet expired by our clock: renew only if the connector still holds that same token.
    return why === "rejected" && stale !== null && (await open(d.kek, g.sealed)) === stale;
  };
  if (!(await needs(k))) return pairOf(d.kek, k, false);
  if (!d.app) return { ok: false, broken: false, reason: "this deployment has no GitHub App credentials to renew with" };
  // The lease, or the result of whoever holds it.
  const was = k.refresh!.sealed.ciphertext;
  const deadline = d.now() + LEASE_MS + 5_000;
  while (!(await d.grants.lease(tenantId, id, d.now(), d.now() + LEASE_MS))) {
    if (d.now() > deadline) return { ok: false, broken: false, reason: "another renewal of this connection did not finish" };
    await sleep(250);
    const again = await d.grants.grant(tenantId, id);
    if (!again) return { ok: false, broken: false, reason: "the connector is gone", missing: true };
    if (again.brokenAt) return { ok: false, broken: true, reason: again.brokenReason ?? "refused" };
    if (again.refresh?.sealed.ciphertext !== was) return pairOf(d.kek, again, false);
  }
  // Read again under the lease: a renewal that finished between the first read and the lease is taken, not repeated.
  k = (await d.grants.grant(tenantId, id))!;
  if (!k || !k.refresh) { await d.grants.release(tenantId, id); return { ok: false, broken: false, reason: "the connector is gone", missing: true }; }
  if (k.refresh.sealed.ciphertext !== was || !(await needs(k))) { await d.grants.release(tenantId, id); return pairOf(d.kek, k, false); }
  const r = await refreshGithubToken(d.app, await open(d.kek, k.refresh.sealed), d.now(), d.fetch);
  if (r.ok && r.grant.refreshToken) {
    const sealed = await seal(d.kek, r.grant.accessToken);
    const refresh = { sealed: await seal(d.kek, r.grant.refreshToken), expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt };
    const landed = await d.grants.rotate(tenantId, id, { sealed, refresh, at: d.now() }, k.refresh.sealed.ciphertext);
    // Not landed means the connector moved past the lease's expiry; the pair just traded is still GitHub's newest.
    logEvent("github.refresh", { tenantId, connectorId: id, why, outcome: "rotated", stored: landed, keys: r.keys.join(" ") });
    return { ok: true, accessToken: r.grant.accessToken, refreshToken: r.grant.refreshToken, expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt, rotated: true };
  }
  if (r.ok) {
    // A refresh that answers a token without a refresh token beside it has nothing to renew it with next time.
    await d.grants.release(tenantId, id);
    logEvent("github.refresh", { tenantId, connectorId: id, why, outcome: "unavailable", reason: "no refresh token in the answer", keys: r.keys.join(" ") });
    return { ok: false, broken: false, reason: "GitHub answered without a refresh token" };
  }
  if (r.kind === "refused") {
    // Someone else's renewal landing while ours was refused means ours spent nothing that mattered.
    const after = await d.grants.grant(tenantId, id);
    if (after?.refresh && after.refresh.sealed.ciphertext !== k.refresh.sealed.ciphertext) { await d.grants.release(tenantId, id); return pairOf(d.kek, after, false); }
    await d.grants.markBroken(tenantId, id, r.reason, d.now());
    logEvent("github.refresh", { tenantId, connectorId: id, why, outcome: "broken", reason: r.reason });
    return { ok: false, broken: true, reason: r.reason };
  }
  await d.grants.release(tenantId, id);
  logEvent("github.refresh", { tenantId, connectorId: id, why, outcome: "unavailable", reason: r.reason });
  return { ok: false, broken: false, reason: r.reason };
}

const GUARD_TABLE = "CREATE TABLE IF NOT EXISTS oauth_refreshing(name TEXT PRIMARY KEY, until INTEGER NOT NULL, owner TEXT NOT NULL)";

export interface RefresherDeps {
  store: Pick<StorageAdapter, "getSecret" | "putSecret" | "removeSecret" | "secretMeta" | "touchSecret">;
  kek: Promise<CryptoKey | null>;
  sql: { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };
  app: GithubApp | null;
  grants?: ConnectorGrants;
  /** Hand a connector's new pair to the other agents pointed at it, so their mounts (and their sandboxes' egress) stop holding the spent one. */
  propagate?(tenantId: string, connectorId: string, fromAgentId: string): Promise<void>;
  fetch?: typeof fetch;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/** One object's renewals: see the module comment for what is serialised against what. */
export class GithubRefresher {
  #d: RefresherDeps;
  #chains = new Map<string, Promise<unknown>>();
  /** Whose stored guard is whose: this runtime's own calls are ordered by the chain, and wait only on another's. */
  #owner = crypto.randomUUID();
  constructor(d: RefresherDeps) { this.#d = d; }
  #now() { return this.#d.now?.() ?? Date.now(); }
  #sleep(ms: number) { return this.#d.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms)); }

  async read(tenantId: string, agentId: string, name: string): Promise<MountGrant | null> {
    const kek = await this.#d.kek;
    const row = kek ? await this.#d.store.getSecret(tenantId, agentId, OAUTH_PREFIX + name) : null;
    if (!kek || !row) return null;
    try { return JSON.parse(await open(kek, row)) as MountGrant; } catch { return null; }
  }

  /** After a connection's token is put on a mount: what renews it, or nothing for one that does not expire. */
  async remember(tenantId: string, agentId: string, name: string, rec: Omit<MountGrant, "v"> | null): Promise<void> {
    const kek = await this.#d.kek;
    if (!kek || !rec || (rec.refreshToken === null && rec.connectorId === null) || rec.expiresAt === null) {
      await this.#d.store.removeSecret(tenantId, agentId, OAUTH_PREFIX + name);
      return;
    }
    const s = await seal(kek, JSON.stringify({ v: 1, ...rec }));
    await this.#d.store.putSecret(tenantId, agentId, OAUTH_PREFIX + name, s);
  }

  /** A connector's pair, renewed first if it is about to expire: for pointing another agent at it. */
  async connectorPair(tenantId: string, connectorId: string): Promise<Renewed> {
    const kek = await this.#d.kek;
    if (!kek || !this.#d.grants) return { ok: false, broken: false, reason: "this deployment keeps no connectors" };
    return renewConnector({ grants: this.#d.grants, kek, app: this.#d.app, fetch: this.#d.fetch, now: () => this.#now(), sleep: (ms) => this.#sleep(ms) },
      tenantId, connectorId, "expiring", null);
  }

  /** Move what renews a mount's secret with it, when the mount is renamed. */
  async move(tenantId: string, agentId: string, from: string, to: string): Promise<void> {
    const row = await this.#d.store.getSecret(tenantId, agentId, OAUTH_PREFIX + from);
    if (!row) return;
    await this.#d.store.putSecret(tenantId, agentId, OAUTH_PREFIX + to, row);
    await this.#d.store.removeSecret(tenantId, agentId, OAUTH_PREFIX + from);
  }

  async forget(tenantId: string, agentId: string, name: string): Promise<void> {
    await this.#d.store.removeSecret(tenantId, agentId, OAUTH_PREFIX + name);
  }

  /** Before the mount's token is read for use: renewed first when it expires within REFRESH_SKEW_MS. */
  async beforeUse(tenantId: string, agentId: string, name: string): Promise<void> {
    const rec = await this.read(tenantId, agentId, name);
    if (!rec || rec.brokenAt || rec.expiresAt === null || fresh(rec.expiresAt, this.#now())) return;
    await this.renew(tenantId, agentId, name, "expiring", null);
  }

  /**
   * GitHub answered 401 for `token`. The first time: renew once and hand back the token to retry with. After that
   * retry (`retried`), a 401 for the renewed token is GitHub's verdict on the connection itself. Null: this mount
   * has nothing to renew with, or nobody could answer; the caller reports the 401 as it always has.
   */
  async rejected(tenantId: string, agentId: string, name: string, token: string, retried: boolean):
    Promise<{ credential: string } | { reconnect: string } | null> {
    const rec = await this.read(tenantId, agentId, name);
    if (!rec || (rec.refreshToken === null && rec.connectorId === null)) return null;
    if (rec.brokenAt) return { reconnect: reconnectSentence(rec.brokenReason ?? "refused") };
    if (retried) {
      const current = await this.#access(tenantId, agentId, name);
      if (current !== token) return null;
      const reason = "GitHub refused the renewed token (401 Bad credentials)";
      await this.#broken(tenantId, agentId, name, rec, reason, true);
      return { reconnect: reconnectSentence(reason) };
    }
    const r = await this.renew(tenantId, agentId, name, "rejected", token);
    if (r.ok) return r.accessToken === token ? null : { credential: r.accessToken };
    return r.broken ? { reconnect: reconnectSentence(r.reason) } : null;
  }

  /** The mount's pair, renewed when `why` says so, behind this mount's chain and its stored guard. */
  renew(tenantId: string, agentId: string, name: string, why: Why, stale: string | null): Promise<Renewed> {
    const key = `${tenantId}/${agentId}/${name}`;
    const tail = this.#chains.get(key) ?? Promise.resolve();
    const run = tail.then(() => this.#guarded(tenantId, agentId, name, why, stale), () => this.#guarded(tenantId, agentId, name, why, stale));
    const settled = run.then(() => {}, () => {});
    this.#chains.set(key, settled);
    void settled.then(() => { if (this.#chains.get(key) === settled) this.#chains.delete(key); });
    return run;
  }

  async #guarded(tenantId: string, agentId: string, name: string, why: Why, stale: string | null): Promise<Renewed> {
    const sql = this.#d.sql;
    sql.exec(GUARD_TABLE);
    const gname = `${tenantId}/${agentId}/${name}`;
    const held = () => sql.exec("SELECT until, owner FROM oauth_refreshing WHERE name = ?", gname).toArray()[0] as { until: number; owner: string } | undefined;
    // Held by another runtime in this object: wait for it, then read what it wrote. Past its time, it died mid-way.
    // Read and taken with no await in between, so two runtimes cannot both find it free.
    for (let g = held(); g && g.owner !== this.#owner && Number(g.until) > this.#now(); g = held()) await this.#sleep(250);
    if (held()) logEvent("github.refresh", { tenantId, agentId, mount: name, why, outcome: "interrupted-before" });
    sql.exec("INSERT OR REPLACE INTO oauth_refreshing(name, until, owner) VALUES (?, ?, ?)", gname, this.#now() + LEASE_MS, this.#owner);
    try {
      return await this.#renew(tenantId, agentId, name, why, stale);
    } finally {
      sql.exec("DELETE FROM oauth_refreshing WHERE name = ?", gname);
    }
  }

  async #access(tenantId: string, agentId: string, name: string): Promise<string | null> {
    const kek = await this.#d.kek;
    const row = kek ? await this.#d.store.getSecret(tenantId, agentId, name) : null;
    return kek && row ? open(kek, row) : null;
  }

  async #renew(tenantId: string, agentId: string, name: string, why: Why, stale: string | null): Promise<Renewed> {
    const kek = await this.#d.kek;
    const rec = await this.read(tenantId, agentId, name);
    const current = await this.#access(tenantId, agentId, name);
    if (!kek || !rec || current === null) return { ok: false, broken: false, reason: "this mount has nothing to renew with" };
    if (rec.brokenAt) return { ok: false, broken: true, reason: rec.brokenReason ?? "refused" };
    const now = this.#now();
    const mine: Renewed = { ok: true, accessToken: current, refreshToken: rec.refreshToken, expiresAt: rec.expiresAt, refreshExpiresAt: rec.refreshExpiresAt, rotated: false };
    // Whoever went before this call in the chain may already have done the work.
    if (why === "rejected" && stale !== null && current !== stale) return mine;
    if (why === "expiring" && fresh(rec.expiresAt, now)) return mine;
    if (rec.connectorId && this.#d.grants) {
      const r = await renewConnector({ grants: this.#d.grants, kek, app: this.#d.app, fetch: this.#d.fetch, now: () => this.#now(), sleep: (ms) => this.#sleep(ms) },
        tenantId, rec.connectorId, why, stale ?? current);
      if (r.ok) {
        if (r.accessToken !== current || r.expiresAt !== rec.expiresAt) {
          await this.#write(tenantId, agentId, name, current, { ...rec, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshExpiresAt: r.refreshExpiresAt }, r.accessToken);
          logEvent("github.refresh", { tenantId, agentId, mount: name, connectorId: rec.connectorId, why, outcome: r.rotated ? "rotated" : "adopted" });
        }
        if (r.rotated && this.#d.propagate) {
          try { await this.#d.propagate(tenantId, rec.connectorId, agentId); }
          catch (e) { logEvent("github.refresh", { tenantId, agentId, connectorId: rec.connectorId, outcome: "propagate-failed", reason: String((e as Error)?.message ?? e).slice(0, 120) }); }
        }
        return r;
      }
      if (r.broken) { await this.#broken(tenantId, agentId, name, rec, r.reason, false); return r; }
      if (!("missing" in r)) return r;
      // The connector is gone but the mount still holds its pair (a disconnect that has not reached this agent yet):
      // renewed on its own below.
    }
    if (why === "adopt") return mine;
    if (!rec.refreshToken) return { ok: false, broken: false, reason: "this mount has nothing to renew with" };
    if (!this.#d.app) return { ok: false, broken: false, reason: "this deployment has no GitHub App credentials to renew with" };
    const r = await refreshGithubToken(this.#d.app, rec.refreshToken, now, this.#d.fetch);
    if (r.ok && r.grant.refreshToken) {
      const next = { ...rec, refreshToken: r.grant.refreshToken, expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt };
      await this.#write(tenantId, agentId, name, current, next, r.grant.accessToken);
      logEvent("github.refresh", { tenantId, agentId, mount: name, why, outcome: "rotated", keys: r.keys.join(" ") });
      return { ok: true, accessToken: r.grant.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt, refreshExpiresAt: next.refreshExpiresAt, rotated: true };
    }
    if (!r.ok && r.kind === "refused") {
      await this.#broken(tenantId, agentId, name, rec, r.reason, true);
      return { ok: false, broken: true, reason: r.reason };
    }
    const reason = r.ok ? "GitHub answered without a refresh token" : r.reason;
    logEvent("github.refresh", { tenantId, agentId, mount: name, why, outcome: "unavailable", reason });
    return { ok: false, broken: false, reason };
  }

  /**
   * The access token and what renews it, together. Both rows are written with no await between them, so nothing
   * else in this object runs in between and the object commits them as one write.
   */
  async #write(tenantId: string, agentId: string, name: string, was: string, rec: MountGrant, access: string): Promise<void> {
    const kek = (await this.#d.kek)!;
    const meta = await this.#d.store.secretMeta(tenantId, agentId, name);
    const a: Sealed | null = access === was ? null : await seal(kek, access);
    const g = await seal(kek, JSON.stringify({ ...rec, v: 1, brokenAt: null, brokenReason: null }));
    const writes = [
      ...(a ? [this.#d.store.putSecret(tenantId, agentId, name, { ...a, account: meta?.account ?? null, verified: meta?.verified ?? false })] : []),
      this.#d.store.putSecret(tenantId, agentId, OAUTH_PREFIX + name, g),
    ];
    await Promise.all(writes);
    // A renewal is not a use: "last used" keeps the time the credential was last put to work.
    if (a && meta?.lastUsedAt) await this.#d.store.touchSecret(tenantId, agentId, name, meta.lastUsedAt);
  }

  /** Only a reconnect mends it: said on the mount, so later calls do not ask GitHub again, and in D1, where Raft reads it. */
  async #broken(tenantId: string, agentId: string, name: string, rec: MountGrant, reason: string, recordInD1: boolean): Promise<void> {
    const kek = (await this.#d.kek)!;
    const at = this.#now();
    await this.#d.store.putSecret(tenantId, agentId, OAUTH_PREFIX + name, await seal(kek, JSON.stringify({ ...rec, v: 1, brokenAt: at, brokenReason: reason })));
    if (recordInD1 && this.#d.grants) {
      if (rec.connectorId) await this.#d.grants.markBroken(tenantId, rec.connectorId, reason, at);
      else await this.#d.grants.markAgentBroken(tenantId, agentId, "github", reason, at);
    }
    logEvent("github.refresh", { tenantId, agentId, mount: name, connectorId: rec.connectorId, outcome: "broken", reason });
  }
}
