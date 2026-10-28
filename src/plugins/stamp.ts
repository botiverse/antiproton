/**
 * Stamp, as a mount: the control plane of an agent's pull requests.
 *
 * Stamp is the Git gateway Raft agents push through: an agent pushes, gets a
 * receipt, opens the pull request from that receipt, and a person reviews and
 * merges in Stamp. `stamp` (the Go CLI) is the interface a Node agent uses;
 * this plugin is the same surface for an agent running in antiproton, whose
 * container may never exist.
 *
 * **The control plane needs no container.** Measured 2026-10-23 by pointing the
 * CLI at a local server and recording what it sent: every command below is
 * plain HTTPS + JSON, carrying the agent's session as `Authorization: Bearer …`.
 * So this is a `fetch` plugin like `github.ts`, not a sandbox tool like
 * `sandbox.ts`.
 *
 * **The session rotates, and that decides the shape of this file.** Stamp's
 * agent access token lives 15 minutes and every refresh rotates both tokens
 * (botiverse/stamp `internal/store/crypto.go`, `agentAccessTTL`, as of server-v0.1.191), so a mount that sends one fixed credential stops
 * working a quarter of an hour after it is supplied. The session is therefore
 * kept sealed in this mount's own database, refreshed here, and written back
 * before it is used — the same rule `@botiverse/stamp-sdk/client`'s
 * `injectedAgentAuth` enforces, done here because the sealing key is
 * `raft-agent-login.ts`'s and the rotation has to survive the mount.
 *
 * **A refresh token is single-use, and reusing a rotated one is destructive:**
 * the gateway answers `refresh_reused` and revokes *every* refresh token that
 * agent holds for that service, on every machine. So the session a person gives
 * this mount must be a dedicated login that no CLI keeps using, and those two
 * codes are reported as what they are rather than retried.
 *
 * **Push is not here, and neither is `git` in the container.** It needs a
 * working tree, and the container form that would give one is left out until it
 * can carry the session's *current access token*; see the note where
 * `sandboxForm` would be, in the plugin below.
 */
/// <reference path="./stamp-sdk.d.ts" />
import { ApiError, NetworkError, makeClient } from "@botiverse/stamp-sdk/client";
import type { Json, MountPolicy } from "../core/types.ts";
import { openText, sealText } from "./raft-agent-login.ts";
import { RAFT_MOUNT_ALIAS, raftIdentityOf } from "./raft-identity.ts";
import { FILES as SDK_FILES } from "./stamp-sdk-box.ts";
import type { BridgeDecl, BridgeIo, BridgeRequest, BridgeResponse, CredentialCheck, Plugin, PluginContext, RouteClass, RouteEntry, ToolSchema } from "./types.ts";
import { classifyRoute, credentialState, identityNote, markIdentity, policyFor } from "./types.ts";

/** The one host this plugin talks to. Not a setting: nothing here has been tried against a self-hosted Stamp. */
const ORIGIN = "https://stamp.build";
/** Stamp caps page size itself; clamping makes the limit visible in the schema. */
const MAX_LIMIT = 100;
/** Where a mount keeps its rotating session: one row, sealed, never listed. */
export const SESSION_STORE = "stampSession";
const SESSION_KEY = "session";
/** Separates this mount's seal from the Connected App sessions the same key seals. */
const SEAL_INFO = "antiproton stamp agent session v1";
/** A session this mount logged in for itself (`stamp_login`): the row's `source`, and the HKDF info it is sealed under. */
const SELF_LOGIN = "agent-login";
const SELF_LOGIN_SEAL_INFO = "antiproton stamp self-login session v1";
/** The tool that logs this mount in with the agent's own Raft identity (botiverse/antiproton#1084). */
const LOGIN_TOOL = "stamp_login";
/** The service `ctx.agentLogin` is asked for: Stamp's Raft app id (not Stamp's own service slug, which the client never sends). */
const STAMP_SERVICE = "stamp";
/** How long the grant's exchange may take, like any other request to the gateway. */
const EXCHANGE_TIMEOUT_MS = 30_000;
/** An access token this close to expiry is refreshed before it is sent, as the SDK does. */
export const REFRESH_SKEW_MS = 60_000;

/**
 * `raft-cli-agent-session.v1`: what `stamp login` keeps, and what a person hands
 * this mount. Only the fields this plugin reads are named; anything else the
 * gateway adds is carried through untouched, because a refresh replaces the
 * whole object.
 */
export interface AgentSession {
  schema?: string;
  access_token: string;
  refresh_token: string;
  token_type?: string;
  access_expires_at?: string;
  refresh_expires_at?: string;
  [k: string]: unknown;
}

/** The session in a value a person supplied, or null when it is not one. */
export function parseSession(value: unknown): AgentSession | null {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.access_token !== "string" || s.access_token === "") return null;
  if (typeof s.refresh_token !== "string" || s.refresh_token === "") return null;
  return s as AgentSession;
}

/** Whether a session's access token is close enough to expiry to refresh first. */
function needsRefresh(session: AgentSession, now: number, skewMs: number): boolean {
  const at = Date.parse(String(session.access_expires_at ?? ""));
  // No expiry named: use it. A wrong guess costs one refused call, and that call
  // already retries through a rotation.
  if (!Number.isFinite(at)) return false;
  return at - now <= skewMs;
}

/**
 * One queue for everything that writes a stamp mount's session: sealing the
 * credential on first use, and each rotation. A refresh token is single-use, so
 * two calls that both rotated would make one of them `refresh_reused` — which
 * revokes every token that agent holds — and sharing one rotation in flight is
 * not enough: a call that read the session before another rotated it and
 * finished still holds the spent token. So whoever is next in the queue reads
 * the session again before acting (`rotate`, `loadSession`). Keyed by the
 * mount's place rather than by the object, because the same plugin serves every
 * mount in the isolate; one isolate per agent is what makes it the only queue.
 * The place is the one the row is sealed under (`sealPlace`), not the alias: a
 * rename moves the row and changes the alias, and a queue keyed by the alias
 * would let a call under the new name rotate beside one still running under the
 * old. With the alias held fixed, an agent's stamp mounts share one queue, which
 * costs a wait on a rotation every quarter hour and nothing else: at most one
 * refresh timeout (30 s) when another mount's refresh hangs.
 */
const queues = new Map<string, Promise<unknown>>();
const inlineKey = (ctx: PluginContext) => {
  const place = sealPlace(ctx);
  return `${place.caller.tenantId}\u0000${place.caller.agentId}\u0000${place.alias}`;
};

/** How many mounts have a queue in this isolate: for a test that a path through the queue leaves none behind. */
export const queuedMounts = (): number => queues.size;

async function exclusive<T>(ctx: PluginContext, fn: () => Promise<T>): Promise<T> {
  const key = inlineKey(ctx);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  try { return await run; } finally { if (queues.get(key) === tail) queues.delete(key); }
}

/**
 * What this mount keeps, as far as `ctx` can tell:
 * - `none`: no row. The mount has never used its credential.
 * - `open`: the session, which this credential's key opens.
 * - `replaced`: a row that descends from some other session, so a person has
 *   supplied a new one since, and that one has never been used here.
 * - `spent`: a row that descends from this credential's session and no longer
 *   opens — it is damaged, or the key it was sealed under is gone. Its refresh
 *   token may have been used already, so nothing is sent with it.
 * - `unfinished`: the row opens, but to a session whose rotation was started and
 *   never finished (`rotating`, below). The gateway may have rotated it already
 *   and the answer never been kept, so its refresh token is treated as spent.
 *
 * A row that does not open is told apart by `from`, kept beside the ciphertext:
 * a digest of the refresh token of the credential it descends from. A row
 * without one reads as `spent`, since the safe guess is the one that sends
 * nothing — that includes every row #1045 wrote, renamed or not; removing the
 * mount deletes it, and a new mount with a fresh sign-in starts clean. A
 * credential is `replaced` only when no mount of this agent has been given it
 * before (`GIVEN_STORE`).
 */
type Kept = { kind: "none" } | { kind: "open"; session: AgentSession; owner?: string; source?: typeof SELF_LOGIN } |
  { kind: "relogin"; why: string } | { kind: "spent" } | { kind: "replaced" } | { kind: "unfinished"; refused?: string; source?: typeof SELF_LOGIN };

/**
 * Every session a person has given this agent's stamp mounts, by the digest of
 * its refresh token, in the agent-level database (`ctx.agentDb`): kept when a
 * mount is removed or renamed, and shared by every stamp mount of the agent.
 * Written before a credential is first sealed, so a session that has ever been
 * used here — by a removed mount, by another mount — is refused rather than
 * presented again. Grows only when a person signs in, and is never pruned:
 * Stamp checks reuse before expiry, and keeps spent token rows
 * (botiverse/stamp `internal/store/agent_cli_login_store.go` `RotateAgentRefreshToken`, as of server-v0.1.194),
 * so a used refresh token presented after it expired is still
 * `refresh_reused`, which revokes every token of that identity. Past a token's
 * expiry this record is what keeps it from being presented, not the gateway.
 */
const GIVEN_STORE = "stampGiven";

/**
 * Sessions whose owner a credential check has confirmed while their access token was fresh, by the digest of the
 * refresh token: `{ owner: "agentId@serverId", at }`. Whose a session is does not change with time, so a first use
 * that comes after the access token expired may refresh a session found here — the ordinary case of a person
 * attaching a session in the console and the agent first using it hours later. Written only after a check passed;
 * read only for the refresh token it names, and only while this agent's Raft identity is still that owner.
 */
const VERIFIED_STORE = "stampVerified";

/** A refresh token as a row may name it: a digest, never the token. */
async function digest(refreshToken: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SEAL_INFO}\u0000${refreshToken}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which session a kept row descends from, without keeping any of it. */
async function lineage(credential: string | null): Promise<string | null> {
  const s = parseSession(credential);
  return s ? digest(s.refresh_token) : null;
}

/**
 * The context the session is sealed under: this mount's, with the alias held
 * fixed. `sealingKeyFor` salts with tenant, agent and alias, and an alias can be
 * renamed (cf/src/runtime.ts `renameMount`, which moves this database with it):
 * under the real alias, a rename would leave a row no key opens beside a
 * credential whose refresh token is spent. The alias only separates mounts,
 * and each mount's row already lives in its own database; `SEAL_INFO` keeps
 * this seal apart from every other kind.
 */
const sealPlace = (ctx: PluginContext): PluginContext => ({ ...ctx, alias: "stamp-session" });

/**
 * The context a self-login session is sealed under (cody's option (a), botiverse/antiproton#1084): the raft mount's
 * credential as the key material, salted with tenant, agent and a nonce kept in the row (`sealingKeyFor`), under its
 * own HKDF info. The nonce stands in for the alias the mount's own seals use: a rename does not move it, and no two
 * seals share a key. The raft plugin can derive the same key — it holds the strictly stronger credential, and this
 * file already reads it through `sibling` (`raftIdentityOf`). Null when there is no raft mount of the raft plugin with
 * a credential, or no nonce.
 */
async function selfLoginPlace(ctx: PluginContext, nonce: unknown): Promise<PluginContext | null> {
  if (typeof nonce !== "string" || !nonce) return null;
  const raft = typeof ctx.sibling === "function" ? await ctx.sibling(RAFT_MOUNT_ALIAS).catch(() => null) : null;
  if (!raft || raft.plugin !== "raft" || !raft.credential) return null;
  return { ...ctx, credential: raft.credential, alias: `stamp-self-login\u0000${nonce}` };
}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function readKept(ctx: PluginContext): Promise<Kept> {
  let row: unknown;
  // Not swallowed: an unread row and an absent one look the same from here, and
  // reading it as absent is what sends the spent refresh token.
  try { row = await ctx.db.get(SESSION_STORE, SESSION_KEY); } catch (e) {
    throw new Error(`stamp: could not read this mount's session (${String((e as Error)?.message ?? e).slice(0, 200)}). ` +
      "It is not replaced by the one the mount was given, whose refresh token may already be spent; try again.");
  }
  if (row === null || row === undefined) return { kind: "none" };
  const sealed = typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
  // A row this mount sealed from its own login (`stamp_login`) is opened only with the key it was sealed under, from
  // the raft mount's credential, never with this mount's: `source` is plain beside the ciphertext, so which key to use
  // is read, not guessed. A credential a person gave since takes over (`replaced`).
  if (sealed.source === SELF_LOGIN) {
    if (parseSession(ctx.credential)) return { kind: "replaced" };
    const place = await selfLoginPlace(ctx, sealed.nonce);
    if (!place) return { kind: "relogin", why: "this agent's raft mount, whose credential the session was sealed with, cannot be read" };
    if (typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") return { kind: "relogin", why: "the kept session is damaged" };
    const plain = await openText(place, SELF_LOGIN_SEAL_INFO, { iv: sealed.iv, ciphertext: sealed.ciphertext }, SESSION_KEY);
    const s = plain === null ? null : parseSession(plain);
    if (!s) return { kind: "relogin", why: "the raft mount's credential has changed since this mount logged in" };
    if (typeof sealed.rotating === "string" && sealed.rotating === await digest(s.refresh_token)) {
      return { kind: "unfinished", source: SELF_LOGIN, ...(typeof sealed.refused === "string" ? { refused: sealed.refused } : {}) };
    }
    return { kind: "open", session: s, source: SELF_LOGIN, ...(typeof sealed.owner === "string" ? { owner: sealed.owner } : {}) };
  }
  if (typeof sealed.iv === "string" && typeof sealed.ciphertext === "string") {
    const plain = await openText(sealPlace(ctx), SEAL_INFO, { iv: sealed.iv, ciphertext: sealed.ciphertext }, SESSION_KEY);
    const s = plain === null ? null : parseSession(plain);
    if (s && typeof sealed.rotating === "string" && sealed.rotating === await digest(s.refresh_token)) {
      return { kind: "unfinished", ...(typeof sealed.refused === "string" ? { refused: sealed.refused } : {}) };
    }
    if (s) return { kind: "open", session: s, ...(typeof sealed.owner === "string" ? { owner: sealed.owner } : {}) };
  }
  const from = await lineage(ctx.credential);
  const fresh = typeof sealed.from === "string" && from !== null && sealed.from !== from && !(await wasGiven(ctx, from));
  return { kind: fresh ? "replaced" : "spent" };
}

/** The agent-level record, or a refusal: without it a removed mount's session would look new. */
function givenDb(ctx: PluginContext) {
  if (!ctx.agentDb) {
    throw new Error("stamp: this context keeps no agent-level record of the sessions this agent was given, so a new one " +
      "cannot be told from one already used; nothing was sent");
  }
  return ctx.agentDb;
}
async function wasGiven(ctx: PluginContext, d: string): Promise<boolean> {
  const row = await givenDb(ctx).get(GIVEN_STORE, d);
  return row !== null && row !== undefined;
}

/** A mount whose kept session is lost: what it was given may be spent, so only a person can go on. */
class SpentSession extends Error {}
const spentSession = () => new SpentSession(
  "stamp: this mount's session is kept but cannot be opened, and the session it was given may have been refreshed " +
  "already — sending a spent refresh token makes Stamp revoke every token this agent holds, on every machine. " +
  "It needs sign-in again: a person signs in for this mount alone and gives it that session.",
);
/** A mount whose last rotation was started and never kept: the gateway may have spent its refresh token. */
const unfinishedRotation = (refused?: string, source?: unknown) => new SpentSession(source === SELF_LOGIN
  ? (refused
    ? `stamp: this mount's own login cannot be refreshed: the gateway refused its refresh token (${refused}) and will not refresh it again. Nothing was sent. ${signInAgain(source, true)}.`
    : "stamp: this mount's own login cannot be used: its last refresh did not finish, so the gateway may have rotated the session " +
      "without this side keeping the new one. Nothing was sent — presenting that refresh token again makes Stamp revoke every " +
      `token this agent holds. ${signInAgain(source, true)}.`)
  : refused
    ? `stamp: a person needs to sign in again for this mount: the gateway refused its refresh token (${refused}) and will ` +
      "not refresh it again. Nothing was sent. A person signs in for this mount alone and gives it that session."
    : "stamp: a person needs to sign in again for this mount: its last refresh did not finish, so the gateway may have " +
      "rotated the session without this side keeping the new one. Nothing was sent — presenting that refresh token again " +
      "makes Stamp revoke every token this agent holds, on every machine. A person signs in for this mount alone and gives it that session.",
);
/** A credential some mount of this agent was already given: it may have been rotated, so it is never sealed again. */
const givenBefore = () => new SpentSession(
  "stamp: this session was already given to this agent — to a mount since removed, or to another stamp mount — and may " +
  "have been refreshed there, which spends it; presenting it would make Stamp revoke every token this agent holds. " +
  "It needs sign-in again: a person signs in for this mount alone and gives it that new session.",
);
const refuseUnusable = (kept: Kept) => {
  if (kept.kind === "relogin") throw reloginNeeded(kept.why);
  if (kept.kind === "spent") throw spentSession();
  if (kept.kind === "unfinished") throw unfinishedRotation(kept.refused, kept.source);
};

/**
 * Who makes this mount usable again, in the words its kept session calls for: a session a person gave needs a person
 * to sign in again; one this mount logged in for itself (`source`) needs only `stamp_login` (cody, #1086).
 */
const signInAgain = (source: unknown, capital = false): string => source === SELF_LOGIN
  ? `${capital ? "Log" : "log"} in again with ${LOGIN_TOOL} (a person approves it unless this mount's policy allows it)`
  : `${capital ? "A" : "a"} person needs to sign in again for this mount alone and give it that session`;

/** A session this mount logged in for itself that cannot be opened now: the agent logs in again, no person needed. */
const reloginNeeded = (why: string) => new SpentSession(
  `stamp: this mount's own login cannot be used — ${why}. Nothing was sent. Log in again with ${LOGIN_TOOL}, which ` +
  "replaces it; a person approves that call unless this mount's policy allows it.",
);

/** A session refused at the door: it is not this agent's. Nothing was kept or sent with it. */
class NotThisAgent extends SpentSession {}
const notThisAgent = (why: string) => new NotThisAgent(
  `stamp: this session cannot be given to this agent — ${why}. Nothing was kept, and its refresh token was not used. ` +
  "A session belongs to one agent only: given to two, both refresh it and Stamp revokes every token of that identity, " +
  "on every machine. A person signs in to Stamp as this agent, for this mount alone, and gives it that session at once.",
);
/**
 * Whose a session is could not be told just now: not a refusal of the session, which may be this agent's. Nothing was
 * kept or sent; the same session works once the cause clears, so the advice is to try again, never to sign in.
 * A credential check reports it as `unreachable` (kept unverified), a call as an error.
 */
class OwnerUnknown extends Error {}
const ownerUnknown = (why: string) => new OwnerUnknown(
  `stamp: whose this session is cannot be checked right now — ${why}. Nothing was kept, and its refresh token was not ` +
  "used. This is not a reason to sign in again: the same session works once this is cleared; try again shortly.",
);

/** This agent's Raft identity as `agentId@serverId`, or an `OwnerUnknown` naming why it cannot be read. */
async function thisAgent(ctx: PluginContext): Promise<string> {
  const me = await raftIdentityOf(ctx);
  if (!me) {
    // Told apart, because the two are fixed by different people: a mount to add or rename, or a moment to wait.
    const raft = typeof ctx.sibling === "function" ? await ctx.sibling(RAFT_MOUNT_ALIAS).catch(() => null) : null;
    if (!raft || raft.plugin !== "raft") {
      throw ownerUnknown(`this agent has no mount named \`${RAFT_MOUNT_ALIAS}\` of the raft plugin, which is where stamp reads ` +
        "which Raft agent this is; give it one under that name (or rename its Raft mount to it)");
    }
    throw ownerUnknown("which Raft agent this agent is cannot be read from its Raft mount yet (it has not listed its tools " +
      "since its credential was set); that happens at the start of the agent's next turn");
  }
  return `${me.agentId}@${me.serverId}`;
}

/**
 * Whose session this is, checked against which Raft agent this antiproton agent is, before the session is kept:
 * `GET /v1/me` (botiverse/stamp `http_login.go` `me`: top-level `agentId`, `serverId`, `principalType`) asked with
 * the session's own access token, and the Raft mount's kept identity (src/plugins/raft-identity.ts). Both ids must
 * match and the principal must be an agent (a `stamp agent login` CLI agent's `cli_…` id never matches a Raft one).
 *
 * Read-only, and never a refresh: an access token already expired is refused rather than refreshed, because the
 * refresh itself would spend the token another holder has (a check that passed earlier is the exception: see
 * `VERIFIED_STORE`). Sent with `send`, not `call`: `call` goes back through `loadSession` and its queue, which this
 * runs inside. Not this agent's is `NotThisAgent`; cannot tell is `OwnerUnknown`.
 */
async function ownerOf(ctx: PluginContext, given: AgentSession): Promise<string> {
  return (await askOwner(ctx, given)).owner;
}
/** `ownerOf`, with the handle Stamp named, for a credential check to report without asking twice. */
async function askOwner(ctx: PluginContext, given: AgentSession): Promise<{ owner: string; handle: string | null }> {
  if (needsRefresh(given, Date.now(), 0)) {
    throw notThisAgent("its access token has already expired, and checking whose it is would mean refreshing it first");
  }
  const mine = await thisAgent(ctx);
  let res: Response;
  let body: Record<string, unknown> = {};
  try {
    // The query says why it was asked, to Stamp's access log and to whoever reads one: Stamp ignores it.
    res = await send("GET", "/v1/me?purpose=owner-check", given.access_token);
    body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (e) {
    throw ownerUnknown(`Stamp could not be asked (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
  if (res.status === 401) throw notThisAgent("Stamp does not accept this session (HTTP 401)");
  if (!res.ok) throw ownerUnknown(`Stamp answered HTTP ${res.status}`);
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  const serverId = typeof body.serverId === "string" ? body.serverId : "";
  const name = typeof body.name === "string" && body.name ? body.name : agentId;
  if (body.principalType === undefined || !agentId || !serverId) {
    throw ownerUnknown("Stamp's answer did not say whose it is (no principalType, agentId or serverId)");
  }
  if (body.principalType !== "agent") {
    throw notThisAgent(`it is not an agent's session (Stamp says ${JSON.stringify(String(body.principalType)).slice(0, 40)})`);
  }
  if (`${agentId}@${serverId}` !== mine) {
    throw notThisAgent(`it belongs to the Stamp agent ${JSON.stringify(name).slice(0, 60)} (${agentId}@${serverId}), and this agent is ${mine}`);
  }
  const handle = typeof body.handle === "string" && body.handle ? body.handle : typeof body.name === "string" && body.name ? body.name : null;
  return { owner: mine, handle };
}

/**
 * The owner a passed check recorded for this refresh token, if it is still this agent: only the digest of the
 * refresh token being kept, and only while the Raft mount still says this agent is that owner. Null: no record.
 */
async function verifiedOwner(ctx: PluginContext, d: string): Promise<string | null> {
  const row = await givenDb(ctx).get(VERIFIED_STORE, d) as Record<string, unknown> | null | undefined;
  if (!row || typeof row.owner !== "string") return null;
  // Past its refresh token's expiry a record permits nothing, pruned yet or not: the session must prove itself again,
  // and an expired access token or a 401 refuses it.
  if (typeof row.until === "string" && Number.isFinite(Date.parse(row.until)) && Date.parse(row.until) < Date.now()) return null;
  const mine = await thisAgent(ctx);
  if (row.owner !== mine) throw notThisAgent(`a check found it belongs to ${row.owner}, and this agent is ${mine}`);
  return row.owner;
}

/**
 * Write one agent-level record for a session, carrying its digest (`d`, the key, so a pruned read can name it) and its
 * refresh token's expiry (`until`, from `refresh_expires_at`). With `prune`, then drop that store's records whose
 * `until` is present and past — only for `VERIFIED_STORE`, whose record is a permission to refresh and is ignored past
 * `until` anyway (`verifiedOwner`); never for `GIVEN_STORE`, see there. A session that names no expiry keeps its record
 * for good. Called only after a write the caller decided to make — a failed check writes nothing, so it prunes nothing
 * either. A failed prune is left for the next write.
 */
async function keepRecord(
  ctx: PluginContext, store: string, d: string, session: AgentSession, extra: Record<string, unknown>, prune: boolean,
): Promise<void> {
  const until = typeof session.refresh_expires_at === "string" && Number.isFinite(Date.parse(session.refresh_expires_at))
    ? session.refresh_expires_at : undefined;
  const db = givenDb(ctx);
  await db.put(store, { ...extra, d, at: new Date().toISOString(), ...(until ? { until } : {}) } as unknown as Json, d);
  if (!prune) return;
  try {
    const now = Date.now();
    for (const row of await db.getAll(store) as Array<Record<string, unknown>>) {
      if (typeof row?.d !== "string" || typeof row.until !== "string") continue;
      const at = Date.parse(row.until);
      if (Number.isFinite(at) && at < now) await db.delete(store, row.d);
    }
  } catch (e) {
    console.warn(`stamp: old ${store} records were not pruned for this agent (agent-level, every stamp mount): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

/** Whose this session is: a passed check's record for its refresh token, else asked now (fresh access token only). */
async function ownerFor(ctx: PluginContext, given: AgentSession, d: string): Promise<string> {
  return (await verifiedOwner(ctx, d)) ?? await ownerOf(ctx, given);
}

/**
 * The session this mount acts with, and only ever the kept one.
 *
 * The credential is used once: the first time the mount has no row, or the
 * first time after a person replaced it, it is sealed into the row before
 * anything is sent, and every read after that is the row's. **Never the
 * credential once the row exists**, because the credential's refresh token is
 * spent by the first rotation and the gateway answers a spent one by revoking
 * every token the agent holds; so a row that cannot be read or opened is an
 * error a person resolves, not a reason to fall back.
 *
 * `keep: false` reads without sealing, for a credential check: the value checked
 * there may be a candidate the mount does not hold yet (`checkMount`), and
 * sealing it would put a row the live credential cannot open over the one it
 * can.
 */
export async function loadSession(ctx: PluginContext, keep = true): Promise<AgentSession | null> {
  const given = parseSession(ctx.credential);
  if (!given) {
    // No credential: the only session this mount may act with is one it logged in for itself. Any other row — one a
    // credential since removed left behind, #1045's — is not this mount's to use, and reads as no session.
    let own = await readKept(ctx);
    if (own.kind === "unfinished") own = await exclusive(ctx, () => readKept(ctx));
    if (own.kind === "open" && own.source === SELF_LOGIN) return own.session;
    if (own.kind === "relogin" || own.kind === "unfinished") refuseUnusable(own);
    return null;
  }
  let kept = await readKept(ctx);
  // A mark read outside the queue may be a rotation still running here: wait
  // for it, then read again. A mark still there inside the queue is one nobody
  // here is finishing.
  if (kept.kind === "unfinished") kept = await exclusive(ctx, () => readKept(ctx));
  if (kept.kind === "open") return kept.session;
  refuseUnusable(kept);
  const d = await digest(given.refresh_token);
  // Asked here only for a check; a call asks in the queue, after the read that
  // sees a seal another call made since the read above.
  if (!keep) {
    if (await wasGiven(ctx, d)) throw givenBefore();
    // A check that passes records it, so a first use after the access token expired may refresh (`VERIFIED_STORE`);
    // a check that fails writes nothing.
    if (!(await verifiedOwner(ctx, d))) {
      const { owner, handle } = await askOwner(ctx, given);
      await keepRecord(ctx, VERIFIED_STORE, d, given, { owner, ...(handle ? { handle } : {}) }, true);
    }
    return given;
  }
  // Read again in the queue: another call may have sealed it, and rotated it,
  // since the read above, and sealing `given` over that would bring the spent
  // token back.
  return exclusive(ctx, async () => {
    const again = await readKept(ctx);
    if (again.kind === "open") return again.session;
    refuseUnusable(again);
    if (await wasGiven(ctx, d)) throw givenBefore();
    // Whose session this is, asked once, before anything is kept or refreshed:
    // the conclusion is sealed with it (`owner`) and never asked again, since a
    // later whoami answers with a rotated token.
    const owner = await ownerFor(ctx, given, d);
    // Recorded before it is sealed: a record that never happened would let a
    // removed mount's session back in. If the seal then fails, the record is
    // taken back — it is this call's own (`wasGiven` was false a moment ago)
    // and nothing has been sent — unless the row turns out to hold the session
    // after all (a write that failed late), or cannot be read to say: then it
    // stays, and the cost is a sign-in.
    await keepRecord(ctx, GIVEN_STORE, d, given, {}, false);
    try { await storeSession(ctx, given, { owner }); } catch (e) {
      let kept: Kept | null = null;
      try { kept = await readKept(ctx); } catch { /* unread: keep the record */ }
      if (kept !== null && kept.kind !== "open") {
        try { await givenDb(ctx).delete(GIVEN_STORE, d); } catch { /* kept: the safe side */ }
      }
      throw e;
    }
    return given;
  });
}

/**
 * Keep a session, or refuse to go on: it is never used unstored. `rotating` is
 * the digest of the refresh token about to be presented, written before it is:
 * a row that still carries it afterwards reads as `unfinished`.
 */
async function storeSession(
  ctx: PluginContext, session: AgentSession, opts: { owner?: string; rotating?: string; refused?: string; source?: typeof SELF_LOGIN } = {},
): Promise<void> {
  const { owner, rotating, refused, source } = opts;
  let sealed: { iv: string; ciphertext: string };
  let keyed: Record<string, unknown>;
  if (source === SELF_LOGIN) {
    // A fresh nonce at every seal: two mounts on one raft credential, and two seals of one mount, never share a key.
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const place = await selfLoginPlace(ctx, nonce);
    if (!place) throw new Error("stamp: this agent's raft mount cannot be read, so this mount's own login has no key to be kept under; nothing was kept");
    sealed = await sealText(place, SELF_LOGIN_SEAL_INFO, JSON.stringify(session), SESSION_KEY);
    keyed = { source: SELF_LOGIN, nonce };
  } else {
    sealed = await sealText(sealPlace(ctx), SEAL_INFO, JSON.stringify(session), SESSION_KEY);
    keyed = { from: await lineage(ctx.credential) };
  }
  const row = { ...sealed, ...keyed, ...(owner ? { owner } : {}),
    ...(rotating ? { rotating } : {}), ...(rotating && refused ? { refused } : {}) };
  await ctx.db.put(SESSION_STORE, row as unknown as Json, SESSION_KEY);
}

/**
 * One rotation at a time per mount (`exclusive`), and none when another call has rotated already.
 *
 * `POST /api/auth/agent/refresh` is a closed body — no session header, no Raft
 * credential (`agentRefresh` in botiverse/stamp `internal/gateway/agent_cli_login.go`, as of server-v0.1.191) — so a
 * mount that holds a refresh token can rotate without a person present.
 */
async function rotate(ctx: PluginContext, used: AgentSession): Promise<AgentSession> {
  return exclusive(ctx, async () => {
    // Read again here, in the queue: a call that read the session before
    // another call rotated it holds a spent refresh token, and sending it is
    // the `refresh_reused` this file opens with. A newer session is used as it is.
    const kept = await readKept(ctx);
    refuseUnusable(kept);
    if (kept.kind !== "open") throw new Error("stamp: this mount's session changed while it was being refreshed; nothing was sent — try again");
    if (kept.session.refresh_token !== used.refresh_token) return kept.session;

    // Marked before it is sent. From the moment the POST leaves, the gateway may
    // rotate and the answer may never be kept — a timeout, a dropped connection,
    // a proxy that fails after the commit, a write that fails — and the row would
    // still open to the token just spent. The mark makes that row `unfinished`,
    // so nothing sends it again. Only an answer that shows the gateway did not
    // rotate clears it; every other end leaves it for a person, the side that
    // sends nothing. If the mark cannot be written, nothing is sent at all.
    const marking = await digest(used.refresh_token);
    const owner = kept.owner;
    const source = kept.source;
    await storeSession(ctx, used, { owner, source, rotating: marking });

    let res: Response;
    let text: string;
    try {
      res = await fetch(new URL("/api/auth/agent/refresh", ORIGIN), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "antiproton/0.1" },
        body: JSON.stringify({ schema: "raft-cli-agent-refresh.v1", refresh_token: used.refresh_token }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      text = await res.text();
    } catch (e) {
      throw new Error(`stamp: the refresh got no answer (${String((e as Error)?.message ?? e).slice(0, 200)}). ` +
        "The gateway may have rotated the session, so this mount will not present that refresh token again: " +
        `${signInAgain(source)}.`);
    }
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { text: text.slice(0, 500) }; }

    if (!res.ok) {
      const code = String(body.error ?? body.code ?? body.errorCode ?? "");
      // Not retried, and said in the only terms that help: somebody has to act.
      // The mark stays: the gateway has said this token is spent, or will never
      // rotate again (botiverse/stamp `agentRefresh`: 409 for the first three,
      // 400 `refresh_invalid` for a token it does not know). `refresh_reused`
      // also ends every live session the agent holds for the service, so the
      // agent's other stamp mounts answer `refresh_revoked` next.
      if (code === "refresh_reused" || code === "refresh_revoked" || code === "refresh_expired" || code === "refresh_invalid") {
        // The code goes beside the mark, so the calls after this one say what the
        // gateway said rather than "did not finish". If that write fails, the
        // mark is still there and only the wording is lost.
        try { await storeSession(ctx, used, { owner, source, rotating: marking, refused: code }); } catch { /* the mark stands */ }
        throw new Error(code === "refresh_expired" || code === "refresh_invalid"
          ? `stamp: the gateway will never refresh this session's refresh token (${code}). ` +
            `${signInAgain(source, true)}; do not retry.`
          : `stamp: this session's refresh token was already used elsewhere or has been revoked (${code}), and the gateway ` +
            "revokes every token that agent holds for the service when that happens — including other machines. " +
            `${signInAgain(source, true)}; do not retry.`,
        );
      }
      const detail = String(body.message ?? body.text ?? "").slice(0, 300).trim();
      const said = `stamp: could not refresh the session (${res.status}${code ? ` ${code}` : ""})${detail ? ` — ${detail}` : ""}`;
      // A 5xx may come after the gateway committed the rotation — its own 503
      // when the commit fails or a concurrent refresh won, a proxy's 502/504 —
      // so the mark stays. Any other 4xx (`invalid_schema`: this plugin's
      // request is wrong) is refused before anything rotates, so the token is
      // as it was and the mark comes off; if that write fails the mark stays,
      // which only costs a sign-in.
      if (res.status >= 500) {
        throw new Error(`${said}. The gateway may have rotated the session before failing, so this mount will not ` +
          `present that refresh token again: ${signInAgain(source)}.`);
      }
      await storeSession(ctx, used, { owner, source });
      if (code === "invalid_schema") {
        throw new Error(`${said}. This is a bug in the stamp plugin's refresh request, not a problem with the session: ` +
          "the session is unchanged and nothing was spent. Report it to whoever maintains this plugin; retrying will not help.");
      }
      throw new Error(said);
    }

    const next = parseSession({ ...body, access_token: body.access_token ?? (body as any).accessToken,
      refresh_token: body.refresh_token ?? (body as any).refreshToken });
    if (!next) {
      throw new Error("stamp: the refresh answered something that is not a session; nothing was stored. The gateway may " +
        `have rotated the session, so ${signInAgain(source)}.`);
    }

    // Before it is used, always: a rotation that cannot be kept would leave the
    // caller holding a token the next call cannot rotate again.
    try { await storeSession(ctx, next, { owner, source }); } catch (e) {
      throw new Error(`stamp: the gateway rotated this mount's session, but the new one could not be kept ` +
        `(${String((e as Error)?.message ?? e).slice(0, 200)}). The refresh token this mount holds is now spent, so it ` +
        `will not be sent again: ${signInAgain(source)}.`);
    }
    return next;
  });
}

/**
 * Why there is nothing to act as, in the terms the mount's own state calls for: the state goes in
 * the fields and the sentence together (markIdentity, identityNote), as every plugin with a
 * credential reports it. An attached credential that is not a session is told what it is not; a
 * missing one is told what to attach; an unreadable one gets no advice, since identityNote already
 * says who has to act.
 */
function noSession(ctx: PluginContext): Error {
  const state = credentialState(ctx);
  const what = state === "attached"
    ? "What it holds is not a Stamp agent session: this needs the JSON `stamp login` keeps " +
      "(access_token and refresh_token), not a cookie or a GitHub token"
    : state === "none" || state === "unreported"
      ? (typeof ctx.agentLogin === "function"
        ? `Log it in with ${LOGIN_TOOL}, which signs in with this agent's own Raft identity (a person approves it unless ` +
          "this mount's policy allows it); or give it the JSON `stamp login` keeps, signed in for this mount alone"
        : "Give it the JSON `stamp login` keeps (access_token and refresh_token), signed in for this mount alone — " +
          "a session shared with a CLI is revoked the first time both refresh")
      : "";
  return markIdentity(new Error(`stamp: nothing to act as — ${identityNote(ctx)}${what ? `. ${what}` : ""}`), ctx);
}

/**
 * `stamp_login` (botiverse/antiproton#1084): this mount logs in with the agent's own Raft identity.
 *
 * 1. Refused while the mount holds a credential (a person's session takes over) or already has a working session.
 * 2. A PKCE pair made here: 32 random bytes base64url (43 characters) as the verifier, base64url SHA-256 of it, no
 *    padding, as the challenge (Stamp's `isValidS256Challenge`). The verifier never leaves this call.
 * 3. `ctx.agentLogin("stamp", challenge)`: the raft mount gets the grant (Raft's approval or install answers come back
 *    as they are, with nothing kept).
 * 4. The grant is exchanged with a bare POST (no session header) — once: a failure starts over from 2, never resends it.
 * 5. Whose it is, through `ownerOf` like any session; then sealed under the raft mount's credential (`source`).
 *    Not recorded in `stampGiven` or `stampVerified`: it was minted here, given by no one, and exists nowhere else.
 * In the queue, so two calls cannot both log in. One trace row per attempt, never a token.
 */
async function selfLogin(ctx: PluginContext, target?: string): Promise<Record<string, Json>> {
  // One row per attempt, whatever ends it: a throw nothing below traced writes a `failed` row before it is rethrown,
  // which matters most after Stamp has issued a session (the owner check, the seal). Only these keys, never a token.
  let traced = false;
  let issued = false;
  const trace = (status: string, verdict: "ok" | "failed" | "blocked", attrs: { owner?: string } = {}) => {
    traced = true;
    ctx.trace?.({ kind: "stamp.agent_login", status, verdict,
      attrs: { mount: ctx.alias, service: STAMP_SERVICE, ...(attrs.owner ? { owner: attrs.owner } : {}), issued } });
  };
  try {
    return await selfLoginAttempt(ctx, target, trace, () => { issued = true; });
  } catch (e) {
    if (!traced) trace(issued ? "failed_after_issue" : "failed", "failed");
    throw e;
  }
}

async function selfLoginAttempt(
  ctx: PluginContext, target: string | undefined,
  trace: (status: string, verdict: "ok" | "failed" | "blocked", attrs?: { owner?: string }) => void, markIssued: () => void,
): Promise<Record<string, Json>> {
  if (typeof ctx.agentLogin !== "function") {
    trace("unavailable", "blocked");
    return { status: "unavailable", reason: "this context cannot log in for the agent; give the mount a session `stamp login` made instead" };
  }
  if (parseSession(ctx.credential)) {
    trace("refused_credential", "blocked");
    throw new Error(`stamp: this mount was given a session by a person, which it acts with; ${LOGIN_TOOL} does not replace it. Remove that credential first to have it log in by itself.`);
  }
  return exclusive(ctx, async () => {
    const kept = await readKept(ctx);
    if (kept.kind === "open") {
      trace("refused_open", "blocked");
      throw new Error(`stamp: this mount already has a working session; ${LOGIN_TOOL} does not replace it. Nothing was sent.`);
    }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const answer = await ctx.agentLogin!(STAMP_SERVICE, challenge, target);
    if (answer.status !== "grant") {
      trace(answer.status, "blocked");
      return answer.status === "unavailable"
        ? { status: "unavailable", reason: answer.reason, next: "give the mount a session `stamp login` made instead" }
        : { status: answer.status, detail: answer.detail, next: `call ${LOGIN_TOOL} again once a person has done what Raft asks` };
    }
    let res: Response;
    try {
      res = await fetch(new URL("/api/auth/agent/exchange", ORIGIN), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "antiproton/0.1" },
        body: JSON.stringify({ schema: "raft-cli-agent-login-exchange.v1", grant: answer.grant, code_verifier: verifier }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS), redirect: "error",
      });
    } catch (e) {
      trace("exchange_unknown", "failed");
      throw new Error(`stamp: the grant was sent to Stamp and no answer came back (${String((e as Error)?.message ?? e).slice(0, 120)}); ` +
        `a session may have been issued and is lost. Nothing was kept. Call ${LOGIN_TOOL} again: a grant is never sent twice, so it starts over.`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = String(body.code ?? body.error ?? "");
      trace(`exchange_failed:${code || res.status}`, "failed");
      const ours = code === "grant_proof_mismatch" || code === "grant_binding_mismatch" || code === "invalid_schema";
      throw new Error(ours
        ? `stamp: Stamp refused the exchange (${code}): a bug in this plugin's login, not something to retry. Nothing was kept.`
        : res.status >= 500
          ? `stamp: Stamp failed the exchange (HTTP ${res.status}${code ? ` ${code}` : ""}); a session may have been issued and is lost. Nothing was kept. Call ${LOGIN_TOOL} again; it starts over with a new grant.`
          : `stamp: Stamp refused the exchange (${code || `HTTP ${res.status}`}). Nothing was kept. Call ${LOGIN_TOOL} again; it starts over with a new grant.`);
    }
    markIssued();
    const session = parseSession(body);
    if (!session) {
      trace("exchange_failed:not_a_session", "failed");
      throw new Error("stamp: Stamp answered the exchange with something that is not a session; nothing was kept");
    }
    const owner = await ownerOf(ctx, session);
    await storeSession(ctx, session, { owner, source: SELF_LOGIN });
    trace("sealed", "ok", { owner });
    return {
      status: "signed_in", owner, accessExpiresAt: session.access_expires_at ?? null,
      note: "This mount now acts as this agent on Stamp. The session is kept sealed and refreshed by the mount; it is not shown.",
    };
  });
}

/** The access token to send now, rotating first when it is due. */
async function accessToken(ctx: PluginContext, fresh: boolean): Promise<{ token: string; session: AgentSession }> {
  const session = await loadSession(ctx);
  if (!session) {
    throw noSession(ctx);
  }
  if (!fresh && !needsRefresh(session, Date.now(), REFRESH_SKEW_MS)) {
    return { token: session.access_token, session };
  }
  const next = await rotate(ctx, session);
  return { token: next.access_token, session: next };
}

/**
 * Tools whose answer is a list of pull requests or receipts: the fields an
 * agent asks the next question with, and not the whole gateway object.
 *
 * The same reasoning as `github.ts`'s projections: a Stamp pull request carries
 * receipts, checks, verdicts and review state, most of which is not what a
 * caller needs to decide its next call, and returning it whole is how a context
 * fills up with fields nobody reads.
 */
function prOut(p: any): Record<string, Json> {
  return {
    number: p?.number,
    title: p?.title,
    state: p?.state,
    repository: p?.repository,
    headRef: p?.headRef ?? p?.head_ref,
    baseRef: p?.baseRef ?? p?.base_ref,
    headSha: p?.headSha ?? p?.head_sha,
    url: p?.url ?? p?.htmlUrl ?? p?.html_url,
    // Stamp's own page, which shows review state and receipts that github.com does not.
    stampUrl: p?.stampUrl ?? p?.stamp_url,
    verdict: p?.verdict ?? undefined,
    merged: p?.merged ?? undefined,
    author: p?.author ?? undefined,
  };
}

function receiptOut(r: any): Record<string, Json> {
  return {
    id: r?.id,
    status: r?.status,
    repository: r?.repository,
    branch: r?.branch,
    sha: r?.sha ?? r?.headSha,
    publishedSha: r?.publishedSha ?? r?.published_sha,
    createdAt: r?.createdAt ?? r?.created_at,
  };
}

/** Where a request may go: the gateway's own API, and GitHub's through it. Never `/api/auth/*`. */
const API_PREFIXES = ["/v1/", "/api/v3/"] as const;

/**
 * A path in this gateway, never a URL: the host is ours to decide, so no
 * argument can reach another origin. `stamp api` is the one tool that forwards
 * to GitHub's own API, and it is held to the same rule.
 *
 * **The prefix is checked on what is sent, not on what was typed.** `new URL`
 * resolves dot segments, `%2e` included, so `/v1/../api/auth/…` passes a check
 * on the string and reaches the session endpoints with the Bearer token. So the
 * path is resolved first and its `pathname` is what must start with a prefix;
 * and a segment that is a dot segment once percent-decoded, however many times
 * (`%252e%252e`), is refused outright, because a server or proxy that decodes
 * once more than `URL` does would resolve it after this check.
 *
 * Under /v1/ no `%` at all: every /v1/ route Stamp serves takes ids, numbers,
 * owner and repository names in its path, never free text (the route table in
 * botiverse/stamp `internal/gateway`, read at 6526607d), so an escape there is
 * only ever a way to say something else. Under /api/v3/ an escape is how a
 * label or file name with a space is named, and Stamp's proxy decodes the path
 * once and refuses dot segments and a `%` left after that (`apiSafeSegment`),
 * so there only what decodes to a dot segment is refused here.
 */
function gatewayPath(raw: unknown, allowed: readonly string[]): string {
  const path = String(raw ?? "");
  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z]+:/i.test(path)) {
    throw new Error(`path must start with ${allowed.join(" or ")} and carry no host, got ${JSON.stringify(path).slice(0, 60)}`);
  }
  const bare = path.split(/[?#]/, 1)[0];
  if (bare.startsWith("/v1/") && bare.includes("%")) {
    throw new Error(`a /v1/ path carries no escapes, got ${JSON.stringify(path).slice(0, 60)}`);
  }
  for (const segment of bare.split("/")) {
    let s = segment;
    for (let i = 0; i < 4 && s.includes("%"); i++) {
      try { s = decodeURIComponent(s); } catch { break; }
    }
    // Split again on what decoding produced: `..%2f..` is one segment as sent and two after one more decode.
    if (s.split(/[\\/]/).some((piece) => piece === "." || piece === "..")) {
      throw new Error(`path must not climb out of ${allowed.join(" or ")}, got ${JSON.stringify(path).slice(0, 60)}`);
    }
  }
  const url = new URL(ORIGIN + path);
  if (url.origin !== ORIGIN || !allowed.some((p) => url.pathname.startsWith(p))) {
    throw new Error(`path must start with ${allowed.join(" or ")}, got ${JSON.stringify(path).slice(0, 60)}`);
  }
  return url.pathname + url.search;
}

/** What a person signs for unless the mount names the tool: see `defaultPolicy` below. */
const DEFAULT_POLICY: MountPolicy = {
  // stamp_login (cody, botiverse/antiproton#1084): Raft's Agent Login is granted with no one asked, so the moment a
  // mount first gains a Stamp identity that can write to GitHub is where a person is put. A mount's own policy may
  // allow it; nothing after the login (rotation, use) asks again.
  // `stamp.write` (`UNLISTED_WRITE_KEY`): a write the route table does not name, a program's (`STAMP_ROUTES`) or
  // `api`'s (`API_ROUTES`, through `policyKey`), and the writes no tool makes (requesting changes, cancelling
  // auto-merge, leaving the queue). For a program the core holds it at `approval` whatever this says; for `api` this
  // entry does. Either way only a mount's own entry lifts it, so `api: allow` alone runs only the listed writes whose
  // tools the mount allows. `request` has no entry, on purpose: an unlisted read is decided under it, and an entry
  // here would put every off-table GET in front of a person.
  tools: { pr_approve: "approval", pr_merge: "approval", api: "approval", [LOGIN_TOOL]: "approval", "stamp.write": "approval" },
};

/**
 * Whether this mount lets `tool` run without a person — asked by a tool that
 * makes that write by another route (`pr_approve`'s note is a `pr_comment`), so
 * the route does not skip the mount's own policy. Anything but a plain "allow"
 * is "no"; a mount that cannot be read is "unread", told apart because the
 * caller's next step differs (try again, not ask a person).
 */
async function mountAllows(ctx: PluginContext, tool: string): Promise<"allow" | "approval" | "deny" | "unread"> {
  const mine = typeof ctx.sibling === "function" ? await ctx.sibling(ctx.alias).catch(() => null) : null;
  if (!mine) return "unread";
  return policyFor(mine.policy, tool, "write", DEFAULT_POLICY);
}

/** A path segment from an argument: a name, never `.` or `..`, which `URL` would resolve. */
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;

function repoOf(args: Record<string, any>): { owner: string; repo: string } {
  const full = String(args.repo ?? "");
  const [owner, repo, ...rest] = full.split("/");
  if (rest.length || !NAME.test(owner ?? "") || !NAME.test(repo ?? "")) {
    throw new Error(`repo must be "owner/name", got ${JSON.stringify(full).slice(0, 40)}`);
  }
  return { owner, repo };
}

/** A commit an approval or merge is about: the full SHA, so a missing one is refused rather than sent as "undefined". */
function sha(args: Record<string, any>, key: "head" | "base"): string {
  const v = args[key];
  if (typeof v !== "string" || !/^[0-9a-f]{40}$/i.test(v)) {
    throw new Error(`${key} must be the full 40-character commit SHA, got ${JSON.stringify(v ?? null).slice(0, 50)}`);
  }
  return v.toLowerCase();
}

/** An issue or pull request number, refused before any request when it is not one. */
function numberOf(args: Record<string, any>, what: string): number {
  const n = Number(args.number);
  if (typeof args.number === "boolean" || !Number.isInteger(n) || n <= 0) {
    throw new Error(`number must be ${what} number, got ${JSON.stringify(args.number ?? null)}`);
  }
  return n;
}

const prBase = (a: Record<string, any>) => {
  const { owner, repo } = repoOf(a);
  return `/v1/repositories/${owner}/${repo}/pulls/${numberOf(a, "a pull request")}`;
};

/** One request with one access token, nothing rotated: what `call` sends, and all a credential check sends. */
function send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "antiproton/0.1" };
  headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  // Every path again, whoever built it: an argument reaches most of them (a receipt id, a repo).
  return fetch(new URL(ORIGIN + gatewayPath(path, API_PREFIXES)), {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
}

/**
 * The fetch the SDK's client sends with: the same checks `send` makes, applied to the URL the client built — this
 * host and a gateway path only (`gatewayPath`), a 30 s bound (the client sets none), no redirects, this plugin's
 * user agent. The SDK builds `${apiBase}${path}`, so a path that escapes is refused here as well as before the call.
 */
export async function gatewayFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(url));
  if (u.origin !== ORIGIN) throw new Error(`stamp: the client asked for ${u.origin}, and this plugin talks only to ${ORIGIN}`);
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined), "user-agent": "antiproton/0.1" };
  if (init?.body === undefined) delete headers["content-type"];
  try {
    return await fetch(new URL(ORIGIN + gatewayPath(u.pathname + u.search, API_PREFIXES)), {
      ...init, headers, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS), redirect: "error",
    });
  } catch (e) {
    // The bound is ours, so it is said as ours: the SDK would report the abort by its DOMException number ("23").
    if ((e as Error)?.name === "TimeoutError") {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: GATEWAY_TIMEOUT_CODE } });
    }
    throw e;
  }
}

/** How long one request to the gateway may take, and the code its expiry is reported under. */
const GATEWAY_TIMEOUT_MS = 30_000;
const GATEWAY_TIMEOUT_CODE = "TIMEOUT_30S";

/**
 * The SDK's client for one call, over this mount's session. The SDK sends, retries a 401 once and shapes its
 * errors; the session stays this file's: `token()` is `accessToken`, so sealing, the rotation mark, `unfinished`,
 * the given and verified records and the queue all apply exactly as they did, and nothing of the SDK's own session
 * handling (`injectedAgentAuth`) is used. `retryToken(used)` rotates through `accessToken(ctx, true)` and answers
 * null — no retry — when that gives the same token back. Another call having rotated in the meantime is not this
 * function's to handle: `rotate` re-reads the session inside the queue (`exclusive`) and returns the newer one
 * without sending anything. Reads are not retried by the client (`retryReads: false`): every tool declares its own
 * idempotency, and a write is never resent.
 */
function clientFor(ctx: PluginContext) {
  return makeClient({
    mode: "agent",
    apiBase: ORIGIN,
    async token() { return (await accessToken(ctx, false)).token; },
    async retryToken(used: string) {
      const next = (await accessToken(ctx, true)).token;
      return next === used ? null : next;
    },
  }, gatewayFetch, { retryReads: false });
}

/**
 * One request to the gateway through the SDK's client, with the mount's session attached here and never in the JS
 * sandbox. A refusal keeps the gateway's own stable code (SESSION_REQUIRED, SELF_APPROVAL_NOT_ALLOWED …) with the
 * method and path, since that is what a caller branches on; a transport failure is said as one, never as a refusal,
 * and a write's outcome is then unknown.
 */
async function call(method: string, path: string, ctx: PluginContext, body?: unknown): Promise<any> {
  const checked = gatewayPath(path, API_PREFIXES);
  try {
    return await clientFor(ctx)(method, checked, body);
  } catch (e) {
    if (e instanceof ApiError) {
      const parsed = (e.body ?? null) as any;
      const code = parsed?.errorCode ?? parsed?.error ?? parsed?.code;
      const detail = typeof code === "string" ? `${code}: ` : "";
      const message = parsed?.message ?? parsed?.error_description ?? parsed?.text ?? "";
      throw new Error(`${method} ${checked} refused ${e.status}: ${detail}${String(message).slice(0, 300)}`);
    }
    if (e instanceof NetworkError) {
      const cause = String(e.details?.cause ?? e.message);
      const what = cause === GATEWAY_TIMEOUT_CODE
        ? `got no answer from Stamp within ${GATEWAY_TIMEOUT_MS / 1000} s`
        : `did not reach Stamp (${cause.slice(0, 120)})`;
      throw new Error(`stamp: ${method} ${checked} ${what}. ` +
        (method === "GET" ? "Nothing was changed; it is safe to try again." :
          "Whether it took effect is unknown: read the resource before doing it again."));
    }
    throw e;
  }
}

// ---- the SDK bridge (botiverse/antiproton#1092) ------------------------------------------------------------------

/** The policy key of a write no row of `STAMP_ROUTES` names: held for a person unless the mount itself allows it. */
export const UNLISTED_WRITE_KEY = "stamp.write";

/**
 * The box's entry: the published client over the gateway-backed `fetch`, with an auth that holds nothing. `mode` is
 * not `"agent"`, so a 401 never makes the box ask for another token: refreshing is `bridgeSend`'s, at the gateway.
 * The token is a placeholder the gateway drops (only `content-type` and `accept` leave the box). Reads are not retried
 * (`retryReads: false`), so one SDK call is one bridged request against the run's host-call budget.
 *
 * The one thing it adds to the client: a refusal's 403 carries the gateway's `error` as an object, and the client
 * builds `ApiError.message` from `body.error`, which would read `403: [object Object]`; there the message is the
 * sentence the gateway gave (`body.message`). The error is the client's own `ApiError`, status and body unchanged.
 */
const BOX_ENTRY = `import { makeClient, ApiError, NetworkError } from "./lib/client.mjs";
export default function make(fetch) {
  const client = makeClient({
    mode: "bridge",
    apiBase: ${JSON.stringify(ORIGIN)},
    token: async () => "bridge",
    retryToken: async () => null,
  }, fetch, { retryReads: false });
  async function stamp(method, path, body) {
    try {
      return await client(method, path, body);
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body.error === "object" && e.body.error !== null && typeof e.body.message === "string") {
        e.message = e.status + ": " + e.body.message;
      }
      throw e;
    }
  }
  return { stamp, ApiError, NetworkError };
}
`;

const SEG = "[^/]+";
const V1_REPO = `^/v1/repositories/${SEG}/${SEG}`;
const V3_REPO = `^/api/v3/repos/${SEG}/${SEG}`;
const re = (s: string) => new RegExp(s);
/** Every method a row that refuses a whole path means: the six the core lets a bridged request use (`bridgeArgs`). */
const ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * The keys of a JSON object's top level as the text spells them, repeats kept, which `JSON.parse` drops (the last one
 * wins). Asked only of text `JSON.parse` has already read as an object, so it only has to find where each key and
 * value ends, not check them.
 */
export function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let i = 0;
  const skipSpace = () => { while (i < text.length && " \t\n\r".includes(text[i]!)) i++; };
  const readString = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  skipSpace();
  if (text[i] !== "{") throw new Error("not a JSON object");
  i++;
  skipSpace();
  if (text[i] === "}") return keys;
  for (;;) {
    skipSpace();
    keys.push(readString());
    skipSpace();
    i++; // the colon
    // The value: to the comma or brace that closes it at this depth, strings skipped whole.
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') { readString(); continue; }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
      i++;
    }
    if (i >= text.length || text[i] === "}") return keys;
    i++; // the comma
  }
}

/**
 * A review's `event`, as GitHub reads it: the key in any case, the value in any case and around whitespace. A value
 * that is not a string throws, so the APPROVE row refuses rather than reading it as "not an approval" — what upstream
 * makes of `["APPROVE"]` or `{"APPROVE":1}` is not something this table can know. So does `event` given twice, in any
 * case, which parsers settle differently (`JSON.parse` keeps the last): Stamp's own proxy refuses it as unreadable too.
 */
function reviewEvent(body: { [k: string]: Json } | null, raw: string | null): string[] {
  if (raw !== null && topLevelKeys(raw).filter((k) => k.toLowerCase() === "event").length > 1) {
    throw new Error("a review event given more than once");
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k.toLowerCase() !== "event") continue;
    if (typeof v !== "string") throw new Error("a review event that is not a string");
    out.push(v.trim().toUpperCase());
  }
  return out;
}

const NOT_ON_BRIDGE = "a program's request through sdk:stamp may not";
/** How `api`'s refusals begin: the same rows as the bridge's, said of the tool (`API_ROUTES`). */
const NOT_ON_API = "api may not";

// The patterns, methods and body checks both tables share (`stampRoutes`): one copy, so the two cannot drift apart.
const AUTH_PATH = /^\/api\/auth(\/|$)/;
const OFF_PREFIX = /^(?!\/v1\/|\/api\/v3\/)/;
const V1_APPROVE = re(`${V1_REPO}/pulls/${SEG}/approve$`);
const V1_MERGE = re(`${V1_REPO}/pulls/${SEG}/(merge|auto-merge|queue(/${SEG})?)$`);
const V1_UNMERGE = re(`${V1_REPO}/pulls/${SEG}/(auto-merge|queue(/${SEG})?)$`);
const V3_MERGE = re(`${V3_REPO}/(pulls/${SEG}/merge|merges)$`);
const GRAPHQL = /^\/api\/v3\/graphql$/;
const REPOSITORY_ID = /^\/api\/v3\/repositories(\/|$)/;
const REVIEW = re(`${V3_REPO}/pulls/${SEG}/reviews(/${SEG}(/events)?)?$`);
const V3_PR_COMMENT = re(`${V3_REPO}/pulls/(${SEG}/comments(/${SEG}/replies)?)$`);
const V1_PR_COMMENT = re(`${V1_REPO}/pulls/${SEG}/comments$`);
const V1_UNAPPROVE = re(`${V1_REPO}/pulls/${SEG}/unapprove$`);
const V1_PR_CREATE = /^\/v1\/pull-requests$/;
const V3_PR_CREATE = re(`${V3_REPO}/pulls$`);
const ISSUE_CREATE = re(`(${V1_REPO}|${V3_REPO})/issues$`);
const ISSUE_COMMENT = re(`(${V1_REPO}|${V3_REPO})/issues/${SEG}/comments$`);
const MERGE_METHODS = ["POST", "PUT", "PATCH"] as const;
const COMMENT_METHODS = ["POST", "PUT", "PATCH"] as const;
const POST = ["POST"] as const;
const approves = (b: { [k: string]: Json } | null, raw: string | null) => reviewEvent(b, raw).includes("APPROVE");
const requestsChanges = (b: { [k: string]: Json } | null, raw: string | null) => reviewEvent(b, raw).includes("REQUEST_CHANGES");

/**
 * The route table, said of `subject` ("… may not"): the bridge's (`STAMP_ROUTES`) and `api`'s (`API_ROUTES`) are these
 * rows, so a spelling one of them refuses or decides under a key, the other does too. `unsure` is the APPROVE row's
 * answer to a review body it cannot judge, which names a remedy each caller can follow.
 */
function stampRoutes(subject: string, unsure: string): readonly RouteEntry[] {
  return [
    // The session endpoints are this plugin's own (`rotate`, `selfLogin`): a program never signs in or refreshes.
    { methods: ANY, path: AUTH_PATH, refuse: `${subject} reach /api/auth: the mount keeps and refreshes its own session` },
    // The same prefixes `api` keeps to (`API_PREFIXES`); `send` checks them again.
    { methods: ANY, path: OFF_PREFIX, refuse: `${subject} leave /v1/ and /api/v3/` },
    { methods: ANY, path: V1_APPROVE,
      refuse: `${subject} approve: call pr_approve, which names the exact head a person signs for` },
    { methods: MERGE_METHODS, path: V1_MERGE,
      refuse: `${subject} merge, enable auto-merge or join the queue: call pr_merge, which names the exact head a person signs for` },
    // Cancelling auto-merge or leaving the queue is not merging, but it is a write someone should see until it is known
    // to be harmless.
    { methods: ["DELETE"], path: V1_UNMERGE, key: UNLISTED_WRITE_KEY },
    { methods: WRITES, path: V3_MERGE,
      refuse: `${subject} merge through GitHub's API: call pr_merge, which names the exact head a person signs for` },
    // A GraphQL mutation can approve or merge, and its body is not something a row can judge.
    { methods: ANY, path: GRAPHQL, refuse: `${subject} use GitHub's GraphQL API, which can approve or merge: use the REST paths, or the stamp tools` },
    // GitHub's repository-id alias reaches every route below under another spelling; the table is written for owner/repo.
    { methods: ANY, path: REPOSITORY_ID,
      refuse: `${subject} use GitHub's /repositories/<id> paths: name the repository as /api/v3/repos/<owner>/<repo>, or use the pr_* tools` },
    // A review write with a query: the table matches the path without it, so whatever upstream reads there (an `event`)
    // is something no row can judge.
    { methods: WRITES, path: REVIEW, withQuery: true,
      refuse: `${subject} write a review with a query string, which this table cannot judge: put every field in the JSON body` },
    // Every write to a review, not only POST: which methods upstream reads an `event` on is not this table's to guess.
    { methods: WRITES, path: REVIEW, body: approves,
      refuse: `${subject} approve through a review: call pr_approve, which names the exact head a person signs for`,
      unsure },
    // Requesting changes blocks a merge and no tool does it, so it is held under the write key, not run as a comment.
    { methods: WRITES, path: REVIEW, body: requestsChanges, key: UNLISTED_WRITE_KEY },
    // Any other review (COMMENT, a pending one), and editing one: a comment.
    { methods: COMMENT_METHODS, path: REVIEW, key: "pr_comment" },
    { methods: POST, path: V3_PR_COMMENT, key: "pr_comment" },
    { methods: POST, path: V1_PR_COMMENT, key: "pr_comment" },
    { methods: POST, path: V1_UNAPPROVE, key: "pr_unapprove" },
    { methods: POST, path: V1_PR_CREATE, key: "pr_create" },
    { methods: POST, path: V3_PR_CREATE, key: "pr_create" },
    { methods: POST, path: ISSUE_CREATE, key: "issue_create" },
    { methods: POST, path: ISSUE_COMMENT, key: "issue_comment" },
  ];
}

/**
 * Which tool's policy decides each request a program makes through `sdk:stamp`, or that it never runs there. The first
 * row that matches decides (`classifyRoute`), on the path as sent (the core refuses `%`, `//`, `.` and `..` before
 * this), without its query or a trailing slash, in any case. A row's key is the tool with the same effect, so a mount
 * that holds or refuses that tool holds or refuses the request too; where no tool has the effect, `stamp.write`.
 *
 * It lists the routes known to approve or merge, and a few by name for their key: it is not a list of every spelling
 * upstream accepts. A write it does not name is held under `stamp.write` (`unlistedWriteKey`); a read passes. That
 * includes writes Stamp's own proxy refuses for an agent — updating a branch, branch protection, `git/refs`,
 * `contents` — so on a mount that sets `stamp.write: allow` those rest on Stamp's proxy alone. A query's content is
 * never judged; a review write that carries one at all is refused, so `?event=APPROVE` cannot ride beside a body that
 * says nothing. GitHub's `/repositories/<id>` alias is refused whole, since every row here is written for owner/repo.
 */
export const STAMP_ROUTES: readonly RouteEntry[] = stampRoutes(NOT_ON_BRIDGE,
  "this review's body could not be read as a JSON object with a string `event` (sent with content-type: " +
  "application/json), so it may be an approval and is refused. Send it as JSON, or use the tools: pr_comment to " +
  "comment, pr_approve to approve");

/**
 * The same rows for the `api` tool (botiverse/antiproton#1092 step 4), its refusals said of `api`. Its body is always
 * sent as JSON, so the APPROVE row's `unsure` is about the body's shape alone: an `event` that is not a string, or one
 * named twice in any case.
 */
export const API_ROUTES: readonly RouteEntry[] = stampRoutes(NOT_ON_API,
  "this review's body does not name one string `event`, so it may be an approval and is refused. Name `event` once, " +
  "as a string, or use the tools: pr_comment to comment, pr_approve to approve");

/** The methods `api` writes with; a read is `api_get`'s. */
const API_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;

/**
 * How `api` decides one call: by `API_ROUTES`, on the path `call` will send (`gatewayPath`, which throws on one that
 * climbs out or leaves the prefixes), spelled as Stamp will route it. That is decoded as many times as anything upstream
 * would (four, as `gatewayPath`'s own dot-segment check, so `%252F` cannot slip past as a slash decoded twice), with
 * empty segments collapsed (`pulls/7//merge` meets the merge row, not a redirect further on) and a trailing slash
 * dropped; matched in any case (`classifyRoute`). An escaped `?` or `#` ends the path there and counts as a query.
 *
 * Refused before the table, as the bridge refuses them (`bridgePath` in the gateway): a `;` (a matrix parameter, so
 * `merge;x`) and anything outside ASCII (a full-width `ｍerge`), as sent or once decoded — spellings a server may route
 * as a listed path while a pattern does not see it. The body is judged as `call` sends it: JSON, or none when falsy.
 */
export function apiRoute(method: unknown, rawPath: unknown, body: unknown): { method: string; path: string; route: RouteClass } {
  const m = String(method ?? "");
  if (!(API_METHODS as readonly string[]).includes(m)) {
    throw new Error(`method must be one of ${API_METHODS.join(", ")}, got ${JSON.stringify(m).slice(0, 20)}`);
  }
  const path = gatewayPath(rawPath, API_PREFIXES);
  let hasQuery = path.includes("?") || String(rawPath ?? "").split("#", 1)[0]!.includes("?");
  let p = path.split("?", 1)[0]!;
  for (let i = 0; i < 4 && p.includes("%"); i++) {
    try { p = decodeURIComponent(p); } catch { break; /* gatewayPath already refused what would matter */ }
  }
  const cut = p.search(/[?#]/);
  if (cut >= 0) { p = p.slice(0, cut); hasQuery = true; }
  if (/[;]|[^\x00-\x7e]/.test(p)) {
    return { method: m, path, route: { kind: "refused", message: `${NOT_ON_API} name a path with ; or a character outside ASCII, which may route as another path: spell it in plain ASCII` } };
  }
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  const text = body ? JSON.stringify(body) : null;
  return { method: m, path, route: classifyRoute(API_TABLE, m, p, text, "application/json", hasQuery) };
}
const API_TABLE = { routes: API_ROUTES, unlistedWriteKey: UNLISTED_WRITE_KEY };

/** What the approval card names for a bridged request: the repository, and the pull request or issue number. */
function describeRoute(path: string): { repo?: string; pr?: number } {
  const p = path.split(/[?#]/, 1)[0]!;
  const m = /^\/(?:v1\/repositories|api\/v3\/repos)\/([^/]+)\/([^/]+)(?:\/(?:pulls|issues)\/(\d+)(?:\/|$))?/i.exec(p);
  if (!m) return {};
  return { repo: `${m[1]}/${m[2]}`, ...(m[3] ? { pr: Number(m[3]) } : {}) };
}

/** One attempt of a bridged request with one access token, through `gatewayFetch`; a transport failure said as one. */
async function bridgeAttempt(req: BridgeRequest, token: string): Promise<Response> {
  try {
    return await gatewayFetch(ORIGIN + req.path, {
      method: req.method,
      headers: { ...req.headers, authorization: `Bearer ${token}` },
      body: req.body ?? undefined,
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: unknown }; code?: unknown };
    const code = err?.cause?.code ?? err?.code;
    // The path and origin refusals `gatewayFetch` makes are not transport failures, and keep their own words.
    if (!(e instanceof TypeError) && code === undefined) throw e;
    // What the SDK in the box reads as a network error (`networkFailureOf` matches "fetch failed").
    throw new Error(`fetch failed (${typeof code === "string" && code ? code : (err?.name ?? "Error")})`);
  }
}

/**
 * Make one bridged request with this mount's session: the token the stamp tools send (`accessToken`, rotating first
 * when it is due), registered with the core (`io.used`) before it is sent, with the session's refresh token, so that an
 * upstream that echoes either has it replaced, in an answer or in the message of a throw. A 401 rotates and resends
 * once, as the SDK's agent auth does, and only when the rotation gave another token; the box never refreshes.
 */
async function bridgeSend(ctx: PluginContext, req: BridgeRequest, io: BridgeIo): Promise<BridgeResponse> {
  const first = await accessToken(ctx, false);
  io.used(first.token);
  io.used(first.session.refresh_token);
  let res = await bridgeAttempt(req, first.token);
  if (res.status === 401) {
    const next = await accessToken(ctx, true);
    io.used(next.token);
    io.used(next.session.refresh_token);
    if (next.token !== first.token) res = await bridgeAttempt(req, next.token);
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, headers, text: await res.text() };
}

/** `sdk:stamp` in a run_js program: the published client, every request decided by `STAMP_ROUTES` at the gateway. */
const STAMP_BRIDGE: BridgeDecl = {
  box: { files: { ...SDK_FILES, "entry.mjs": BOX_ENTRY }, entry: "entry.mjs", exports: ["stamp", "ApiError", "NetworkError"] },
  routes: STAMP_ROUTES,
  unlistedWriteKey: UNLISTED_WRITE_KEY,
  send: bridgeSend,
  describe: describeRoute,
  // The CLI's version notices; harmless to the box, and what the client's `onVersions` reads.
  responseHeaders: ["stamp-cli-latest", "stamp-cli-minimum"],
};

const t = (
  name: string, summary: string, properties: Record<string, unknown>,
  required: string[], sideEffects: "read" | "write",
  idempotency: "native" | "key" | "none" = sideEffects === "read" ? "native" : "none",
): ToolSchema => ({
  name, summary, parameters: { type: "object", properties, required } as Json,
  sideEffects, idempotency,
});

const REPO_ARG = { repo: { type: "string", description: 'owner/name, e.g. "botiverse/antiproton"' } };
const PR_NUMBER = { number: { type: "integer", description: "the pull request number in that repository" } };
const LIMIT_ARG = { limit: { type: "integer", description: `max ${MAX_LIMIT}` } };
const HEAD_ARG = {
  head: { type: "string", description: "the exact head SHA this answer is about; an approval counts for one commit" },
  base: { type: "string", description: "the exact base SHA" },
};

export const stampPlugin: Plugin = {
  id: "stamp",
  version: "1.0.0",
  /**
   * The rotating session. Not `listed`: it exists, and that it exists is
   * listable, never what is in it.
   */
  // Version 3 added `VERIFIED_STORE` (agent-level); nothing to carry over.
  database: { version: 3, stores: { [SESSION_STORE]: {}, [GIVEN_STORE]: {}, [VERIFIED_STORE]: {} } },
  credential: {
    required: true,
    summary: "A Stamp agent session: the JSON `stamp login` keeps (access_token, refresh_token, access_expires_at), signed in for this mount alone.",
    shape: "token",
    grants:
      "acting on the pull requests of this server under the agent's own Stamp identity: reading them, opening one from a " +
      "receipt, commenting. Merging and approving need a person, or an approval at the exact head.",
    docs: "https://docs.stamp.build/agents/setup.md",
  },
  config: [],
  /*
   * No `sandboxForm`, so no `git` over Stamp's HTTPS endpoint in the container.
   *
   * A form hands the egress proxy the mount's *credential* (gateway
   * `sandboxForms`), and here that is the whole session JSON: the header went out
   * as `Bearer {"access_token":…,"refresh_token":…}` (#1051), which git cannot
   * authenticate with and which registered the refresh token as a container
   * egress secret. Sending only `access_token` would not fix it: the credential
   * never changes while the session this mount rotates lives in its database, so
   * the container would hold the first access token and get 401 fifteen minutes
   * later.
   *
   * What would bring it back: a form whose egress value is read when each request
   * leaves — this mount's current access token, rotated here first when due, and
   * never the refresh token — rather than derived once from the credential. The
   * measured part still holds (stamp.build 2026-10-23: `git ls-remote` with only
   * `http.https://stamp.build/.extraHeader=Authorization: Bearer <access token>`
   * succeeds; `info/refs?service=git-receive-pack` answers 200 with it, 401
   * without).
   */
  /**
   * The tools a person signs unless the mount names them otherwise. Approving
   * and merging cannot be undone by trying again, and `api` writes to anything
   * under /v1/ or GitHub's API. `api` never approves or merges (`API_ROUTES`
   * refuses those), but it is held as a whole too, and each call is also decided
   * under its row's key (`policyKey`). An absent mount policy allows everything
   * (`policyFor`), so without this they would run unattended on every mount that
   * did not think to say.
   */
  defaultPolicy: DEFAULT_POLICY,
  // `await import("sdk:stamp")` in run_js: the SDK's client, each request a call of `stamp.request` (`STAMP_ROUTES`).
  bridge: STAMP_BRIDGE,
  /**
   * `api` is decided by the bridge's rows (`API_ROUTES`): a listed write under its row's key, the tool of the same
   * effect, so a mount's entry for `pr_comment` or `pr_create` covers `api` too; an unlisted one under `stamp.write`.
   * The gateway takes the stricter of `api`'s own entry and the key's. Never throws: a call the table refuses, or whose
   * path or method is not one `api` takes, has no key and is refused by the handler (`apiRoute`).
   */
  policyKey(tool: string, args: Json): string | undefined {
    if (tool !== "api" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
    try {
      const a = args as Record<string, unknown>;
      const { route } = apiRoute(a.method, a.path, a.body);
      return route.kind === "listed" || route.kind === "unlisted-write" ? route.key : undefined;
    } catch {
      return undefined;
    }
  },
  // The one service this plugin may log in to through the agent's raft mount (`ctx.agentLogin`).
  agentLogin: { services: [STAMP_SERVICE] },
  tools: [
    t(LOGIN_TOOL, "Log this mount in to Stamp with this agent's own Raft identity, so no person has to paste a session: Raft " +
      "signs the agent in to Stamp, Stamp issues a one-time grant, and the session it is exchanged for is kept by this " +
      "mount like a pasted one. Refused while the mount already has a working session. Needs the agent's raft mount. " +
      "A person approves it unless this mount's policy allows it; Raft may first ask a Server owner to approve or install Stamp.",
      { target: { type: "string", description: "where Raft posts an approval or install card if one is needed (a channel or thread)" } },
      [], "write", "none"),
    t("whoami", "Which agent this mount acts as on Stamp: handle, server, the commit email a push must be committed by, and whether this instance serves git over HTTPS.",
      {}, [], "read"),

    t("receipt_get", "One push receipt: whether the gateway accepted it and whether GitHub has published it. A pull request is opened from a published receipt.",
      { id: { type: "string" } }, ["id"], "read"),
    t("receipt_list", "This agent's own push receipts, newest first.",
      { ...REPO_ARG, ...LIMIT_ARG }, [], "read"),

    t("pr_list", "Pull requests in a repository, or with no repo the ones this agent has open, grouped by what each needs next.",
      { ...REPO_ARG, state: { type: "string", enum: ["open", "closed", "all"] }, ...LIMIT_ARG }, [], "read"),
    t("pr_view", "One pull request: body, state, verdict, and the exact head commit an approval would count for.",
      { ...REPO_ARG, ...PR_NUMBER }, ["repo", "number"], "read"),
    t("pr_diff", "The files a pull request touches, with per-file line counts. Patch text is omitted unless asked for, because it is large.",
      { ...REPO_ARG, ...PR_NUMBER, patch: { type: "boolean", description: "include the diff text for each file" } }, ["repo", "number"], "read"),
    t("pr_checks", "CI status for a pull request's head commit.",
      { ...REPO_ARG, ...PR_NUMBER }, ["repo", "number"], "read"),

    t("pr_create", "Open a pull request from one of this agent's published receipts. Stamp reads the repository, branch and exact SHA from the receipt, so the receipt is the only handle a caller needs. Not idempotent: an unclear answer means read the pull request, never resend.",
      {
        receipt: { type: "string", description: "the receipt id from a push" },
        base: { type: "string", description: "the branch to merge into, e.g. main" },
        title: { type: "string" },
        body: { type: "string" },
        idempotencyKey: { type: "string", description: "a name for this request; an identical retry returns the same pull request" },
      }, ["receipt", "base", "title"], "write", "key"),
    t("pr_comment", "Comment on a pull request. An agent comments as Stamp's App, signed with its name. Not idempotent.",
      { ...REPO_ARG, ...PR_NUMBER, body: { type: "string" } }, ["repo", "number", "body"], "write"),

    // The two tools whose misuse cannot be undone by trying again. Both name the
    // exact head and base they are about, so an approval cannot silently attach
    // to a commit that arrived after the review, and both are held for a person
    // by `defaultPolicy` above unless the mount's own policy names them.
    t("pr_approve", "Approve the exact head of a pull request, which is what lets it merge. An approval counts for one commit. Approving a pull request this agent opened is refused unless evidence is supplied, which this tool does not do — the refusal names why.",
      { ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG, note: { type: "string", description: "why, for the record: posted as a comment after the approval (Stamp does not take a body on an agent's approval)" } },
      // Not "native": a replayed call would post its note a second time; an approval alone is idempotent, its comment is not.
      ["repo", "number", "head", "base"], "write", "none"),
    t("pr_unapprove", "Withdraw this agent's approval at the exact head.",
      { ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG }, ["repo", "number", "head", "base"], "write", "native"),
    t("pr_merge", "Merge a pull request that is approved at this exact head. `auto` (the default) registers auto-merge and returns at once, which is the usual path: Stamp merges when the head is approved and checks pass, so nothing polls. Otherwise the merge is attempted now.",
      {
        ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG,
        auto: { type: "boolean", description: "register auto-merge instead of merging now; default true" },
        method: { type: "string", enum: ["merge", "squash", "rebase"] },
      }, ["repo", "number", "head", "base"], "write", "none"),

    t("issue_list", "A repository's issues, most recently updated first. Pull requests are not among them.",
      { ...REPO_ARG, state: { type: "string", enum: ["open", "closed", "all"] }, ...LIMIT_ARG }, ["repo"], "read"),
    t("issue_create", "Open an issue. Not idempotent — calling twice opens two.",
      { ...REPO_ARG, title: { type: "string" }, body: { type: "string" } }, ["repo", "title"], "write"),
    t("issue_comment", "Comment on an issue. Not idempotent.",
      { ...REPO_ARG, number: { type: "integer" }, body: { type: "string" } }, ["repo", "number", "body"], "write"),

    t("inbox", "What Stamp wants to tell this agent, one item per subject: CI on its pull requests, reviews and comments, merge-queue state, failed pushes, workflow runs. Newest first.",
      { unread: { type: "boolean", description: "only items not yet read" }, ...LIMIT_ARG }, [], "read"),

    // Two tools rather than one, because the gateway reads `sideEffects` to
    // decide whether a call waits for a person; a single `api` would declare the
    // wider of the two and every read through it would be held.
    t("api_get", "Read any gateway endpoint under /v1/ or GitHub's API under /api/v3/ that the tools above do not cover. Path only, no host.",
      { path: { type: "string", description: '"/v1/repositories/owner/name/pulls"' } }, ["path"], "read"),
    t("api", "Write to any gateway or GitHub API endpoint the tools above do not cover: POST, PATCH, PUT or DELETE, under /v1/ or /api/v3/. Path only, no host, and not idempotent.",
      {
        path: { type: "string", description: '"/v1/repositories/owner/name/pulls/12/comments"' },
        method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
        body: { type: "object", description: "JSON body" },
      }, ["path", "method"], "write"),
  ],

  /**
   * The question a console asks while a person is supplying the session: does it
   * work, and whose is it. A session that has expired or been revoked is
   * indistinguishable from a working one until something is called with it, and
   * here that costs one request while the person still has the terminal open.
   */
  async checkCredential(ctx): Promise<CredentialCheck> {
    if (!parseSession(ctx.credential)) {
      return {
        ok: false, kind: "rejected",
        reason: "not a Stamp agent session — this mount needs the JSON `stamp login` keeps, with access_token and refresh_token (a cookie or a GitHub token is not one)",
      };
    }
    // Never rotates, and never touches the session row. The value checked is
    // often a candidate the mount does not hold yet (`checkMount`), sharing the
    // mount's one session row: storing its rotation would put a session the live
    // credential cannot open over the one it can, and the next call would be
    // `spent`; rotating without storing would spend the candidate's refresh token
    // before it is kept. So the check asks with the access token it has. Its one
    // write is the agent-level record that whose it is was checked and passed
    // (`VERIFIED_STORE`), and only when it passed.
    // Whether a record of whose it is existed before this check: one this check writes was settled by asking Stamp
    // just now; one found already settles ownership only, and says nothing about whether Stamp still takes it.
    const candidate = parseSession(ctx.credential);
    const recordOf = async () => candidate && ctx.agentDb
      ? await ctx.agentDb.get(VERIFIED_STORE, await digest(candidate.refresh_token)).catch(() => null) as Record<string, unknown> | null
      : null;
    const before = await recordOf();
    let session: AgentSession | null;
    try { session = await loadSession(ctx, false); } catch (e) {
      if (e instanceof SpentSession) return { ok: false, kind: "rejected", reason: e.message.slice(0, 400) };
      if (e instanceof OwnerUnknown) return { ok: false, kind: "unreachable", reason: e.message.slice(0, 400) };
      throw e;
    }
    if (!session) throw noSession(ctx);
    // A record this check just wrote came from asking Stamp with this session's own access token a moment ago:
    // answered from it, without asking twice. An older one settles only whose the session is, so a fresh access token
    // is still put to Stamp below (a session revoked there since must not read as "ok").
    if (candidate?.refresh_token === session.refresh_token && !before) {
      const rec = await recordOf();
      if (rec && typeof rec.owner === "string") return { ok: true, account: typeof rec.handle === "string" ? `@${rec.handle}` : undefined };
    }
    if (needsRefresh(session, Date.now(), 0)) {
      return {
        ok: false, kind: "unreachable",
        reason: "not checked: this session's access token has expired, and checking it would spend its refresh token. The first call refreshes it",
      };
    }
    // With the candidate's own access token and `send`, never the mount's client: the value checked may not be the
    // mount's credential yet.
    let res: Response;
    try { res = await send("GET", "/v1/me", session.access_token); } catch (e) {
      return { ok: false, kind: "unreachable", reason: `not checked: Stamp could not be asked (${String((e as Error)?.message ?? e).slice(0, 200)})` };
    }
    const me = await res.json().catch(() => null) as any;
    if (!res.ok) {
      const code = me?.errorCode ?? me?.error ?? me?.code;
      return { ok: false, kind: "rejected", reason: `GET /v1/me refused ${res.status}${typeof code === "string" ? `: ${code}` : ""}`.slice(0, 300) };
    }
    const handle = me?.handle ?? me?.principal?.handle;
    return { ok: true, account: typeof handle === "string" ? `@${handle}` : undefined };
  },

  async invoke(name, args, ctx): Promise<Json> {
    const a = (args ?? {}) as Record<string, any>;
    switch (name) {
      case LOGIN_TOOL:
        return selfLogin(ctx, typeof a.target === "string" && a.target ? a.target : undefined) as Promise<Json>;
      case "whoami": {
        const me = await call("GET", "/v1/me", ctx);
        return {
          handle: me?.handle ?? null,
          principalType: me?.principalType ?? me?.principal_type ?? null,
          server: me?.serverName ?? me?.server ?? null,
          commitEmail: me?.commitEmail ?? me?.commit_email ?? null,
          // Whether this instance serves git over HTTPS at all: a self-hosted
          // Stamp may not, and assuming it does is how a push fails one step
          // after the clone worked.
          gitHTTPSURLTemplate: me?.gitHTTPSURLTemplate ?? null,
        } as Json;
      }

      case "receipt_get":
        return receiptOut(await call("GET", `/v1/receipts/${encodeURIComponent(String(a.id))}`, ctx));

      case "receipt_list": {
        const q = new URLSearchParams();
        if (a.repo) q.set("repo", String(a.repo));
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/receipts?${q}`, ctx);
        return ((r?.receipts ?? r) ?? []).map(receiptOut) as Json;
      }

      case "pr_list": {
        const q = new URLSearchParams();
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        if (a.state) q.set("state", String(a.state));
        if (a.repo) {
          const { owner, repo } = repoOf(a);
          return ((await call("GET", `/v1/repositories/${owner}/${repo}/pulls?${q}`, ctx)) ?? []).map(prOut) as Json;
        }
        return ((await call("GET", `/v1/inbox/pull-requests?${q}`, ctx)) ?? []).map(prOut) as Json;
      }

      case "pr_view": {
        const p = await call("GET", prBase(a), ctx);
        return { ...prOut(p), body: p?.body ?? null, approvals: p?.approvals ?? p?.approvalRule ?? null } as Json;
      }
      case "pr_diff": {
        const d = await call("GET", `${prBase(a)}/diff`, ctx);
        const files = (d?.files ?? d) ?? [];
        return (a.patch ? files : files.map((f: any) => ({
          path: f?.path, additions: f?.additions, deletions: f?.deletions, status: f?.status,
        }))) as Json;
      }
      case "pr_checks": {
        const p = await call("GET", prBase(a), ctx);
        return { headSha: p?.headSha ?? p?.head_sha ?? null, checks: p?.checks ?? null, verdict: p?.verdict ?? null } as Json;
      }

      case "pr_create": {
        const body: Record<string, unknown> = {
          receiptId: String(a.receipt),
          baseRef: String(a.base),
          title: String(a.title),
        };
        if (a.body !== undefined) body.body = String(a.body);
        // Stamp reuses the pull request an identical request already opened, so
        // a retry after an unclear answer is safe only with this key.
        if (a.idempotencyKey !== undefined) body.idempotencyKey = String(a.idempotencyKey);
        const p = await call("POST", "/v1/pull-requests", ctx, body);
        return { ...prOut(p), opened: true } as Json;
      }
      case "pr_comment":
        return (await call("POST", `${prBase(a)}/comments`, ctx, { body: String(a.body) })) as Json;

      case "pr_approve": {
        // Stamp refuses an agent's approval that carries a body
        // (`PR_APPROVE_BODY_NOT_SUPPORTED`): the reason goes in a comment after
        // the approval, never with it. The approval stands if the comment fails.
        const approved = (await call("POST", `${prBase(a)}/approve`, ctx,
          { expectedHead: sha(a, "head"), expectedBase: sha(a, "base") })) as Json;
        // One shape whether or not a note was given: `approval`, then what became of the note.
        if (a.note === undefined || String(a.note).trim() === "") return { approval: approved };
        // The comment is a write of its own: `pr_comment`'s policy decides it,
        // whatever lifted `pr_approve`. Held or refused, the note comes back
        // unposted and the approval stands.
        const comment = await mountAllows(ctx, "pr_comment");
        if (comment !== "allow") {
          return { approval: approved, note: String(a.note),
            commentSkipped: comment === "deny"
              ? "the note was not posted: pr_comment is refused on this mount"
              : comment === "approval"
                ? "the note was not posted: pr_comment needs a person's approval on this mount; call pr_comment with it, and a person is asked"
                : "the note was not posted: this mount's policy could not be read just now; call pr_comment with it to try again" };
        }
        try {
          const comment = (await call("POST", `${prBase(a)}/comments`, ctx, { body: String(a.note) })) as Json;
          return { approval: approved, comment };
        } catch (e) {
          return { approval: approved, commentError: `the approval stands; the note was not posted: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
        }
      }
      case "pr_unapprove":
        return (await call("POST", `${prBase(a)}/unapprove`, ctx,
          { expectedHead: sha(a, "head"), expectedBase: sha(a, "base") })) as Json;
      case "pr_merge": {
        const body: Record<string, unknown> = { expectedHead: sha(a, "head"), expectedBase: sha(a, "base") };
        if (a.method !== undefined) body.mergeMethod = String(a.method);
        // Auto-merge is the default because the alternative is polling: Stamp
        // merges when the head is approved and checks pass, whoever asks.
        const auto = a.auto !== false;
        return (await call("PUT", `${prBase(a)}${auto ? "/auto-merge" : "/merge"}`, ctx, body)) as Json;
      }

      case "issue_list": {
        const { owner, repo } = repoOf(a);
        const q = new URLSearchParams();
        q.set("state", String(a.state ?? "open"));
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/repositories/${owner}/${repo}/issues?${q}`, ctx);
        return ((r ?? []) as any[]).map((i) => ({
          number: i?.number, title: i?.title, state: i?.state, url: i?.url ?? i?.htmlUrl,
        })) as Json;
      }
      case "issue_create": {
        const { owner, repo } = repoOf(a);
        const i = await call("POST", `/v1/repositories/${owner}/${repo}/issues`, ctx, {
          title: String(a.title), body: a.body === undefined ? undefined : String(a.body),
        });
        return { number: i?.number ?? null, url: i?.url ?? i?.htmlUrl ?? null } as Json;
      }
      case "issue_comment": {
        const { owner, repo } = repoOf(a);
        const c = await call("POST", `/v1/repositories/${owner}/${repo}/issues/${numberOf(a, "an issue")}/comments`, ctx,
          { body: String(a.body) });
        return { id: c?.id ?? null, url: c?.url ?? c?.htmlUrl ?? null } as Json;
      }

      case "inbox": {
        const q = new URLSearchParams();
        if (a.unread === true) q.set("unread", "true");
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/me/notifications?${q}`, ctx);
        return ((r?.items ?? r?.notifications ?? r) ?? []).map((n: any) => ({
          id: n?.id, kind: n?.kind, unread: n?.unread ?? null, title: n?.title ?? null, url: n?.url ?? null,
          at: n?.at ?? n?.createdAt ?? null,
        })) as Json;
      }

      case "api_get":
        return (await call("GET", gatewayPath(a.path, API_PREFIXES), ctx)) as Json;

      case "api": {
        // Decided at the gateway by `policyKey` on the same table; refused here, so neither an approved replay nor a
        // mount that sets `stamp.write: allow` runs what the table refuses.
        const { method, path, route } = apiRoute(a.method, a.path, a.body);
        if (route.kind === "refused") throw new Error(`stamp: ${route.message}`);
        return (await call(method, path, ctx, a.body)) as Json;
      }

      default:
        throw new Error(`stamp has no tool named ${JSON.stringify(String(name)).slice(0, 40)}`);
    }
  },
};
