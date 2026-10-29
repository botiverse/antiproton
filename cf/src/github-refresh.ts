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
import { appendTrace, type TraceVerdict } from "../../src/trace/outbox.ts";
import { open, seal, type Sealed } from "../../src/runtime/secrets.ts";
import type { StorageAdapter } from "../../src/core/store.ts";
import type { ConnectorGrant, ConnectorGrants } from "./control-plane.ts";
import { githubUser, refreshGithubToken, REFRESH_SKEW_MS } from "./github-token.ts";

/** The row beside a mount's secret that renews it. ":" keeps it apart from every alias (MOUNT_ALIAS has none). */
export const OAUTH_PREFIX = "oauth:";
/** How long the right to trade a refresh token is held: longer than the token endpoint's timeout (TOKEN_TIMEOUT_MS). */
export const LEASE_MS = 30_000;
/**
 * A 401 this soon after the pair was renewed is not GitHub saying the authorization is gone: the renewal itself just
 * proved it alive. It is an endpoint that refuses this kind of token (`/app` wants an App's JWT), and renewing again
 * for it would let any call rotate the pair at will.
 */
export const RECENT_MS = 60_000;
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
  /** When this mount itself last traded for a new pair (a mount with no connector); a connector keeps its own. */
  rotatedAt?: number | null;
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
  /** Told every outcome as it is logged: an agent's object writes it to its trace (`GithubRefresher`). */
  note?(e: RefreshEvent): void;
}

/** What a renewal can end in: the `outcome` of its `github.refresh` line, and the `status` of its trace row. */
export type RenewalOutcome = "rotated" | "adopted" | "broken" | "unavailable" | "store-failed" | "kept-unstored" | "interrupted-before" | "propagate-failed";

/** One `github.refresh` line. `reason` is said in the log only; the trace row carries `code`, or a code read from it. */
export interface RefreshEvent {
  tenantId: string;
  agentId?: string;
  mount?: string;
  connectorId?: string | null;
  why?: Why;
  outcome: RenewalOutcome;
  attempt?: number;
  stored?: boolean;
  keys?: string;
  reason?: string;
  /** The fixed code for a reason that is not one of GitHub's or this module's own (a D1 error, say). */
  code?: string;
}

function report(e: RefreshEvent, note?: (e: RefreshEvent) => void): void {
  const { code: _code, ...line } = e;
  logEvent("github.refresh", line);
  try { note?.(e); } catch { /* a trace row is never worth a failed renewal */ }
}

/**
 * The OAuth error codes a trace row may name. Anything else GitHub says is `oauth:other`: the row is a fixed vocabulary,
 * so nothing GitHub or an error message put in a reason (its own words, a value echoed back) is carried into the export.
 */
const OAUTH_CODES = new Set(["bad_refresh_token", "invalid_grant", "unauthorized", "temporarily_unavailable", "slow_down",
  "incorrect_client_credentials", "invalid_client", "invalid_request", "unsupported_grant_type", "access_denied", "server_error"]);

/** This module's and cf/src/github-token.ts's own reasons, as codes. */
const REASON_CODES: Array<[RegExp, string]> = [
  [/^the token endpoint did not answer\b/, "no-answer"],
  [/^(no refresh token in the answer|GitHub answered without a refresh token)$/, "no-refresh-token"],
  [/^this deployment has no GitHub App credentials\b/, "no-app"],
  [/^another renewal of this connection did not finish$/, "lease-timeout"],
  [/^(the connector is gone|the connection was removed)$/, "connector-gone"],
  [/^this mount has nothing to renew with$/, "nothing-to-renew"],
  [/^refused$/, "refused"],
];

/** A reason as a code from a fixed set: never the reason's own text, which can carry what someone else wrote. */
export function reasonCode(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const http = /^the token endpoint answered (\d{3}) without an OAuth error$/.exec(reason);
  if (http) return `http-${http[1]}`;
  for (const [re, code] of REASON_CODES) if (re.test(reason)) return code;
  const oauth = /^([a-z_]{1,64})(?::|$)/.exec(reason)?.[1];
  if (oauth) return OAUTH_CODES.has(oauth) ? `oauth:${oauth}` : "oauth:other";
  return "other";
}

const VERDICTS: Record<RenewalOutcome, TraceVerdict> = {
  rotated: "ok", adopted: "ok", broken: "failed", unavailable: "failed", "store-failed": "failed", "kept-unstored": "failed",
  "interrupted-before": "cancelled", "propagate-failed": "failed",
};

/** How many times a new pair's write to D1 is tried before the pair is handed back unstored (`UnstoredPair`). */
export const ROTATE_ATTEMPTS = 3;

/**
 * GitHub handed out a new pair and D1 would not take it. The pair is the only live one there is, so it travels with the
 * error: the mount that asked for it keeps it (`GithubRefresher.#renew`) rather than lose it with the call.
 */
export class UnstoredPair extends Error {
  readonly pair: Extract<Renewed, { ok: true }>;
  constructor(pair: Extract<Renewed, { ok: true }>, cause: unknown) {
    super(`the renewed pair could not be stored on the connector: ${String((cause as Error)?.message ?? cause).slice(0, 160)}`);
    this.pair = pair;
  }
}

/**
 * Whether GitHub itself says `token` is dead: GET /user, which any live user token may read, answers 401. A 401
 * from some other endpoint is not that (`/app` refuses every user token), and renewing for it would let one call
 * rotate a shared connector at will. Anything but a 401 here — 200, 5xx, no answer — is no proof, and nothing rotates.
 */
export async function tokenIsDead(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "antiproton/0.1" },
      signal: AbortSignal.timeout(10_000),
    });
    await r.body?.cancel().catch(() => {});
    return r.status === 401;
  } catch { return false; }
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
export async function renewConnector(d: ConnectorDeps, tenantId: string, id: string, why: Why, stale: string | null, agentId: string): Promise<Renewed> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Whose lease is whose: a renewal that outlived its lease must not release, or clear, the one that took over.
  const holder = crypto.randomUUID();
  let k = await d.grants.grant(tenantId, id, agentId);
  if (!k) return { ok: false, broken: false, reason: "the connector is gone", missing: true };
  if (k.brokenAt) return { ok: false, broken: true, reason: k.brokenReason ?? "refused" };
  let dead: boolean | undefined;
  const needs = async (g: ConnectorGrant) => {
    if (!g.refresh || why === "adopt") return false;
    if (!fresh(g.refresh.expiresAt, d.now())) return true;
    if (why !== "rejected" || stale === null) return false;
    if (g.refreshedAt !== null && d.now() - g.refreshedAt < RECENT_MS) return false;
    // Refused by GitHub while not yet expired by our clock: renew only if the connector still holds that same token,
    // and GitHub confirms it is dead. Asked once per renewal.
    if ((await open(d.kek, g.sealed)) !== stale) return false;
    dead ??= await tokenIsDead(stale, d.fetch);
    return dead;
  };
  if (!(await needs(k))) return pairOf(d.kek, k, false);
  if (!d.app) return { ok: false, broken: false, reason: "this deployment has no GitHub App credentials to renew with" };
  // The lease, or the result of whoever holds it.
  const was = k.refresh!.sealed.ciphertext;
  const deadline = d.now() + LEASE_MS + 5_000;
  while (!(await d.grants.lease(tenantId, id, d.now(), d.now() + LEASE_MS, holder))) {
    if (d.now() > deadline) return { ok: false, broken: false, reason: "another renewal of this connection did not finish" };
    await sleep(250);
    const again = await d.grants.grant(tenantId, id, agentId);
    if (!again) return { ok: false, broken: false, reason: "the connector is gone", missing: true };
    if (again.brokenAt) return { ok: false, broken: true, reason: again.brokenReason ?? "refused" };
    if (again.refresh?.sealed.ciphertext !== was) return pairOf(d.kek, again, false);
  }
  // Read again under the lease: a renewal that finished between the first read and the lease is taken, not repeated.
  k = (await d.grants.grant(tenantId, id, agentId))!;
  if (!k || !k.refresh) { await d.grants.release(tenantId, id, holder); return { ok: false, broken: false, reason: "the connector is gone", missing: true }; }
  if (k.refresh.sealed.ciphertext !== was || !(await needs(k))) { await d.grants.release(tenantId, id, holder); return pairOf(d.kek, k, false); }
  const r = await refreshGithubToken(d.app, await open(d.kek, k.refresh.sealed), d.now(), d.fetch);
  if (r.ok && r.grant.refreshToken) {
    // Stored first, before anything else is done with it: GitHub has already spent the old pair, and a pair that
    // only this call knows is lost with it (a deploy, a timeout), which only a reconnect mends.
    const sealed = await seal(d.kek, r.grant.accessToken);
    const refresh = { sealed: await seal(d.kek, r.grant.refreshToken), expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt };
    const pair = { ok: true as const, accessToken: r.grant.accessToken, refreshToken: r.grant.refreshToken, expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt, rotated: true };
    let landed = false;
    for (let attempt = 1; ; attempt++) {
      try { landed = await d.grants.rotate(tenantId, id, { sealed, refresh, at: d.now() }, k.refresh.sealed.ciphertext, holder); break; }
      catch (e) {
        report({ tenantId, connectorId: id, why, outcome: "store-failed", attempt, reason: String((e as Error)?.message ?? e).slice(0, 120), code: "d1-write-failed" }, d.note);
        // The lease is left held: a renewal behind it would trade the spent token and mark the connection broken.
        if (attempt >= ROTATE_ATTEMPTS) throw new UnstoredPair(pair, e);
      }
    }
    // Not landed means the connector moved past the lease's expiry; the pair just traded is still GitHub's newest.
    report({ tenantId, connectorId: id, why, outcome: "rotated", stored: landed, keys: r.keys.join(" ") }, d.note);
    if (landed && !k.accountId) await fillAccountId(d, tenantId, id, k.account, r.grant.accessToken);
    return pair;
  }
  if (r.ok) {
    // A refresh that answers a token without a refresh token beside it has nothing to renew it with next time.
    await d.grants.release(tenantId, id, holder);
    report({ tenantId, connectorId: id, why, outcome: "unavailable", reason: "no refresh token in the answer", keys: r.keys.join(" ") }, d.note);
    return { ok: false, broken: false, reason: "GitHub answered without a refresh token" };
  }
  if (r.kind === "refused") {
    // Someone else's renewal landing while ours was refused means ours spent nothing that mattered.
    const after = await d.grants.grant(tenantId, id, agentId);
    if (after?.refresh && after.refresh.sealed.ciphertext !== k.refresh.sealed.ciphertext) { await d.grants.release(tenantId, id, holder); return pairOf(d.kek, after, false); }
    // Only over the refresh token this renewal spent: one whose lease ran out while GitHub answered may find that
    // another renewal has stored a good pair since, and that pair is not broken.
    if (!(await d.grants.markBroken(tenantId, id, r.reason, d.now(), holder, k.refresh.sealed.ciphertext))) {
      const now = await d.grants.grant(tenantId, id, agentId);
      if (now && !now.brokenAt && now.refresh && now.refresh.sealed.ciphertext !== k.refresh.sealed.ciphertext) return pairOf(d.kek, now, false);
      if (!now) return { ok: false, broken: false, reason: "the connector is gone", missing: true };
      return { ok: false, broken: true, reason: now.brokenReason ?? r.reason };
    }
    report({ tenantId, connectorId: id, why, outcome: "broken", reason: r.reason }, d.note);
    return { ok: false, broken: true, reason: r.reason };
  }
  await d.grants.release(tenantId, id, holder);
  report({ tenantId, connectorId: id, why, outcome: "unavailable", reason: r.reason }, d.note);
  return { ok: false, broken: false, reason: r.reason };
}

/**
 * A connector from before 0024 keeps only its login, which a rename changes and someone else can then claim; a reconnect
 * in place compares the numeric id when there is one. Learned here from the pair just renewed, the first time the
 * connector renews: only when GitHub names the same login, so a connector never takes the id of another account. Best
 * effort: the renewal has already landed, and whatever goes wrong here is logged, never its failure.
 */
async function fillAccountId(d: ConnectorDeps, tenantId: string, id: string, login: string | null, token: string): Promise<void> {
  try {
    const who = await githubUser(token, d.fetch);
    if (!who) { logEvent("github.account_id", { tenantId, connectorId: id, outcome: "unknown" }); return; }
    if (!login || who.login.toLowerCase() !== login.toLowerCase()) {
      logEvent("github.account_id", { tenantId, connectorId: id, outcome: "login-mismatch" });
      return;
    }
    const filled = await d.grants.fillAccountId(tenantId, id, who.id, who.login);
    logEvent("github.account_id", { tenantId, connectorId: id, outcome: filled ? "filled" : "unchanged" });
  } catch (e) {
    logEvent("github.account_id", { tenantId, connectorId: id, outcome: "failed", reason: String((e as Error)?.message ?? e).slice(0, 120) });
  }
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
  /** Keep work alive past the call that started it (the object's `waitUntil`): propagation is not the caller's to wait for. */
  waitUntil?(p: Promise<unknown>): void;
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

  /** A connector's pair, renewed first if it is about to expire: for pointing an agent (`agentId`, this object's) at it. */
  async connectorPair(tenantId: string, connectorId: string, agentId: string): Promise<Renewed> {
    const kek = await this.#d.kek;
    if (!kek || !this.#d.grants) return { ok: false, broken: false, reason: "this deployment keeps no connectors" };
    return renewConnector({ grants: this.#d.grants, kek, app: this.#d.app, fetch: this.#d.fetch, now: () => this.#now(), sleep: (ms) => this.#sleep(ms),
      note: (e) => this.#trace({ ...e, agentId }, "connector") }, tenantId, connectorId, "expiring", null, agentId);
  }

  /** A mount's outcome: its line, and its row in this object's trace. */
  #report(e: RefreshEvent): void { report(e, (x) => this.#trace(x, "mount")); }

  /**
   * The outcome as a `github.refresh` trace row (src/trace/outbox.ts), which reaches the trace export in R2 even when
   * Workers Logs drops the object's line (docs/runbook.md). Ids and fixed codes only: no token, and no reason's text.
   */
  #trace(e: RefreshEvent, scope: "connector" | "mount"): void {
    if (!e.agentId) return;
    const at = this.#now();
    const attrs: Record<string, unknown> = { scope, connectorId: e.connectorId ?? undefined, mount: e.mount, why: e.why, attempt: e.attempt,
      stored: e.stored, reasonCode: e.code ?? reasonCode(e.reason) };
    for (const k of Object.keys(attrs)) if (attrs[k] === undefined || attrs[k] === null) delete attrs[k];
    appendTrace(this.#d.sql, [{ at, tenantId: e.tenantId, agentId: e.agentId, kind: "github.refresh",
      spanId: `refresh_${crypto.randomUUID()}`, status: e.outcome, verdict: VERDICTS[e.outcome], attrs }]);
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
   * GitHub answered 401 for `token`: renew once and hand back the token to retry with. A 401 is never itself taken
   * as the authorization being gone — an endpoint may refuse this kind of token whatever its state — only GitHub
   * refusing the refresh token is. Null: nothing to renew with, nobody answered, or the pair was renewed moments ago;
   * the caller reports the 401 as it always has.
   */
  async rejected(tenantId: string, agentId: string, name: string, token: string):
    Promise<{ credential: string } | { reconnect: string } | null> {
    const rec = await this.read(tenantId, agentId, name);
    if (!rec || (rec.refreshToken === null && rec.connectorId === null)) return null;
    // A mount on a connector asks the connector, which may have been mended since; one alone knows its own state.
    if (rec.brokenAt && !(rec.connectorId && this.#d.grants)) return { reconnect: reconnectSentence(rec.brokenReason ?? "refused") };
    let r: Renewed;
    try { r = await this.renew(tenantId, agentId, name, "rejected", token); }
    // The mount kept the pair D1 would not take: the retry goes out with it.
    catch (e) { if (e instanceof UnstoredPair) return { credential: e.pair.accessToken }; throw e; }
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
    if (held()) this.#report({ tenantId, agentId, mount: name, why, outcome: "interrupted-before" });
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
    const viaConnector = !!(rec.connectorId && this.#d.grants);
    if (rec.brokenAt && !viaConnector) return { ok: false, broken: true, reason: rec.brokenReason ?? "refused" };
    const now = this.#now();
    const mine: Renewed = { ok: true, accessToken: current, refreshToken: rec.refreshToken, expiresAt: rec.expiresAt, refreshExpiresAt: rec.refreshExpiresAt, rotated: false };
    // Whoever went before this call in the chain may already have done the work.
    if (why === "rejected" && stale !== null && current !== stale) return mine;
    if (why === "expiring" && fresh(rec.expiresAt, now) && !rec.brokenAt) return mine;
    if (why === "rejected" && !viaConnector && rec.rotatedAt && now - rec.rotatedAt < RECENT_MS) return mine;
    if (rec.connectorId && this.#d.grants) {
      let r: Renewed;
      try {
        r = await renewConnector({ grants: this.#d.grants, kek, app: this.#d.app, fetch: this.#d.fetch, now: () => this.#now(), sleep: (ms) => this.#sleep(ms),
          note: (e) => this.#trace({ ...e, agentId, mount: name }, "connector") }, tenantId, rec.connectorId, why, stale ?? current, agentId);
      } catch (e) {
        // D1 would not take the new pair. GitHub has spent the old one, so this mount keeps the new one before the
        // error goes on: its own calls keep working, and the pair is somewhere rather than nowhere.
        if (e instanceof UnstoredPair) {
          await this.#write(tenantId, agentId, name, current, { ...rec, refreshToken: e.pair.refreshToken, expiresAt: e.pair.expiresAt, refreshExpiresAt: e.pair.refreshExpiresAt }, e.pair.accessToken);
          this.#report({ tenantId, agentId, mount: name, connectorId: rec.connectorId, why, outcome: "kept-unstored" });
        }
        throw e;
      }
      if (r.ok) {
        // Also when only the mount's own broken flag is stale: the connector says it is healthy.
        if (r.accessToken !== current || r.expiresAt !== rec.expiresAt || rec.brokenAt) {
          await this.#write(tenantId, agentId, name, current, { ...rec, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshExpiresAt: r.refreshExpiresAt }, r.accessToken);
          this.#report({ tenantId, agentId, mount: name, connectorId: rec.connectorId, why, outcome: r.rotated ? "rotated" : "adopted" });
        }
        // Not waited for: the pair is in D1 already, and this call's caller is owed its answer. An agent it does not
        // reach takes the pair on its own next 401; its sandbox's egress has no 401 to learn from and keeps the spent
        // token until its own recorded expiry comes near.
        if (r.rotated && this.#d.propagate) {
          const connectorId = rec.connectorId;
          const p = this.#d.propagate(tenantId, connectorId, agentId).catch((e) =>
            this.#report({ tenantId, agentId, mount: name, connectorId, outcome: "propagate-failed", reason: String((e as Error)?.message ?? e).slice(0, 120), code: "propagate-error" }));
          this.#d.waitUntil?.(p);
        }
        return r;
      }
      if (r.broken) { await this.#broken(tenantId, agentId, name, rec, r.reason, false); return r; }
      if ("missing" in r) {
        // The connector was deleted (disconnected) and this mount was not told yet. Its own copy of the pair is the
        // connector's, and renewing it alone would keep alive an authorization its owner removed.
        const reason = "the connection was removed";
        await this.#broken(tenantId, agentId, name, rec, reason, false);
        return { ok: false, broken: true, reason };
      }
      return r;
    }
    if (why === "adopt") return mine;
    if (!rec.refreshToken) return { ok: false, broken: false, reason: "this mount has nothing to renew with" };
    if (!this.#d.app) return { ok: false, broken: false, reason: "this deployment has no GitHub App credentials to renew with" };
    // As for a connector: a 401 renews only once GitHub confirms the token is dead.
    if (why === "rejected" && stale !== null && fresh(rec.expiresAt, now) && !(await tokenIsDead(stale, this.#d.fetch))) return mine;
    const r = await refreshGithubToken(this.#d.app, rec.refreshToken, now, this.#d.fetch);
    if (r.ok && r.grant.refreshToken) {
      const next = { ...rec, refreshToken: r.grant.refreshToken, expiresAt: r.grant.expiresAt, refreshExpiresAt: r.grant.refreshExpiresAt, rotatedAt: now };
      await this.#write(tenantId, agentId, name, current, next, r.grant.accessToken);
      this.#report({ tenantId, agentId, mount: name, why, outcome: "rotated", keys: r.keys.join(" ") });
      return { ok: true, accessToken: r.grant.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt, refreshExpiresAt: next.refreshExpiresAt, rotated: true };
    }
    if (!r.ok && r.kind === "refused") {
      await this.#broken(tenantId, agentId, name, rec, r.reason, true);
      return { ok: false, broken: true, reason: r.reason };
    }
    const reason = r.ok ? "GitHub answered without a refresh token" : r.reason;
    this.#report({ tenantId, agentId, mount: name, why, outcome: "unavailable", reason });
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
    // Already said, on the mount and wherever the connector keeps it: said once.
    if (rec.brokenAt && !recordInD1) return;
    const kek = (await this.#d.kek)!;
    const at = this.#now();
    await this.#d.store.putSecret(tenantId, agentId, OAUTH_PREFIX + name, await seal(kek, JSON.stringify({ ...rec, v: 1, brokenAt: at, brokenReason: reason })));
    if (recordInD1 && this.#d.grants) {
      if (rec.connectorId) await this.#d.grants.markBroken(tenantId, rec.connectorId, reason, at, null, null);
      else await this.#d.grants.markAgentBroken(tenantId, agentId, "github", reason, at);
    }
    this.#report({ tenantId, agentId, mount: name, connectorId: rec.connectorId, outcome: "broken", reason });
  }
}
