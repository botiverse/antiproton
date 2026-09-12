/**
 * Who is looking at the console, decided by the app itself.
 *
 * Identity used to arrive in a header that Cloudflare Access set and the app
 * trusted without checking, so the whole guarantee lived outside the code.
 * The app verifies: a person signs in with GitHub (the OAuth web flow), the
 * callback reads the profile under the token GitHub issued and looks the
 * account up in the identity table, and what the browser carries afterwards
 * is a session sealed under a secret only this Worker holds. Nothing a caller
 * can write on a request is an identity; only something this Worker signed is.
 *
 * Everything here runs on WebCrypto so the same code is exercised by
 * `node test/auth.ts` and by the deployed Worker.
 */

export type ViewerSource = "github" | "automation" | "qa" | "anonymous";

/** A resolved identity. `email` doubles as the stable key an agent hangs off. */
export interface Viewer {
  email: string;
  name: string | null;
  username: string | null;
  picture: string | null;
  source: ViewerSource;
  /** The agent this person owns, when the sign-in resolved one through the
   *  identity table (GitHub). Absent for identities keyed on their email. */
  agentId?: string;
}

/** What the session cookie carries. Sealed, never trusted unsealed. */
export interface SessionClaims {
  v: 1;
  who: string;
  name: string | null;
  username: string | null;
  picture: string | null;
  sub: string;
  source: "qa" | "github";
  /** Resolved at sign-in from the identity table; a session carries it so
   *  no request has to look it up again. */
  agentId?: string;
  iat: number;
  exp: number;
}

/** Remembered between the redirect out and the callback in. */
export interface LoginState {
  state: string;
  returnTo: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = "ap_session";
export const LOGIN_COOKIE = "ap_login";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const LOGIN_TTL_MS = 10 * 60_000;


const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  const u8 = new Uint8Array(bytes);
  crypto.getRandomValues(u8);
  return b64url(u8);
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** payload.signature, both base64url. The payload is JSON with an `exp`. */
export async function seal(secret: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

/** The payload if the signature holds and it has not expired, else null. */
export async function open<T extends { exp: number }>(secret: string, token: string | null | undefined, now = Date.now()): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let sigBytes: Uint8Array;
  try { sigBytes = unb64url(sig); } catch { return null; }
  const key = await hmacKey(secret, "verify");
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  if (!ok) return null;
  let claims: T;
  try { claims = JSON.parse(dec.decode(unb64url(body))); } catch { return null; }
  if (typeof claims?.exp !== "number" || claims.exp <= now) return null;
  return claims;
}

/** Same length and bytes, in time that does not depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---- cookies ---------------------------------------------------------------

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function cookieHeader(name: string, value: string, maxAgeSec: number, path = "/"): string {
  return `${name}=${value}; Max-Age=${maxAgeSec}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookieHeader(name: string, path = "/"): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

/** Why a sign-in was turned away; the page names each. */
export type RefusalReason = "not-invited" | "state" | "exchange" | "unconfigured";

// ---- resolving the viewer of a request ---------------------------------------

export interface ViewerEnv {
  SESSION_SECRET?: string;
  AUTOMATION_TOKEN?: string;
  UI_ALLOW_ANONYMOUS?: string;
}

/** The QA identity: a session minted from a key, never from an email. */
export const QA_VIEWER: Viewer = { email: "qa", name: "QA", username: null, picture: null, source: "qa" };

/**
 * The single place identity is decided. In order: a session this Worker
 * sealed; the automation token; and, only where the deployment says so,
 * anonymous. Nothing else on a request is an identity: the Cloudflare Access
 * header that once was is no longer read.
 */
export async function resolveViewer(request: Request, env: ViewerEnv, opts: { allowAnonymous?: boolean; now?: number } = {}): Promise<Viewer | null> {
  if (env.SESSION_SECRET) {
    const s = await open<SessionClaims>(env.SESSION_SECRET, readCookie(request, SESSION_COOKIE), opts.now);
    if (s && s.v === 1 && typeof s.who === "string" && s.who) {
      if (s.source === "qa") return QA_VIEWER;
      if (s.source === "github") {
        // A GitHub session without its agent is not an identity: the key is
        // the mapping, and a cookie that lost it names nobody.
        if (typeof s.agentId !== "string" || !s.agentId) return null;
        return { email: s.who, name: s.name ?? null, username: s.username ?? null, picture: s.picture ?? null, source: "github", agentId: s.agentId };
      }
      // Any other source (the Raft sessions that once existed) names nobody:
      // the holder signs in again.
      return null;
    }
  }
  const token = request.headers.get("x-harness-token");
  if (env.AUTOMATION_TOKEN && token && constantTimeEqual(token, env.AUTOMATION_TOKEN)) {
    return { email: "automation", name: "automation", username: null, picture: null, source: "automation" };
  }
  if (opts.allowAnonymous && env.UI_ALLOW_ANONYMOUS === "1") {
    return { email: "anonymous (UNPROTECTED)", name: null, username: null, picture: null, source: "anonymous" };
  }
  return null;
}

export async function sessionCookieFor(secret: string, v: Viewer, sub: string, now = Date.now()): Promise<string> {
  const claims: SessionClaims = {
    v: 1, who: v.email, name: v.name, username: v.username, picture: v.picture, sub,
    source: v.source === "qa" ? "qa" : "github",
    ...(v.agentId ? { agentId: v.agentId } : {}),
    iat: now, exp: now + SESSION_TTL_MS,
  };
  return cookieHeader(SESSION_COOKIE, await seal(secret, claims), SESSION_TTL_MS / 1000);
}

// ---- Login with GitHub ---------------------------------------------------------
//
// The OAuth web flow, no OpenID: GitHub hands back an access token, and the
// profile comes from its API under that token. The identity is GitHub's
// numeric user id, never the login (a login can be renamed) and never the
// email (GitHub need not expose one), and the console keys nothing off it
// directly: the id is looked up in the identity table, and only an id that
// maps to an agent is admitted. Everyone else is refused by default, because
// an open door here would let any GitHub account start an agent on the
// operator's model account.

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
export const GITHUB_API = "https://api.github.com";
/** GitHub refuses API calls without a User-Agent; this names the caller. */
const GITHUB_UA = "antiproton-console";

export function githubAuthorizeUrl(cfg: GithubConfig, state: string): string {
  const u = new URL(GITHUB_AUTHORIZE);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return u.toString();
}

export async function githubExchangeCode(cfg: GithubConfig, code: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const r = await fetchImpl(GITHUB_TOKEN, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": GITHUB_UA },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri }),
  });
  if (!r.ok) throw new Error(`github token exchange failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { access_token?: string; error?: string; error_description?: string };
  // GitHub answers 200 with an error body for a bad code.
  if (!j.access_token) throw new Error(`github token exchange refused: ${j.error ?? "no token"} ${j.error_description ?? ""}`.trim());
  return j.access_token;
}

export interface GithubProfile {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
}

export interface GithubEmail { email: string; primary: boolean; verified: boolean }

export async function githubFetchProfile(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ profile: GithubProfile; emails: GithubEmail[] }> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": GITHUB_UA };
  const u = await fetchImpl(`${GITHUB_API}/user`, { headers });
  if (!u.ok) throw new Error(`github user failed: ${u.status}`);
  const profile = (await u.json()) as GithubProfile;
  if (typeof profile.id !== "number" || !profile.login) throw new Error("github user: no id");
  // The emails endpoint needs user:email; a token without it answers 404,
  // and a profile without an email is still an identity here.
  let emails: GithubEmail[] = [];
  const e = await fetchImpl(`${GITHUB_API}/user/emails`, { headers });
  if (e.ok) emails = (await e.json()) as GithubEmail[];
  return { profile, emails };
}

/**
 * The agent a first-time GitHub sign-in registers for itself when the
 * deployment allows open sign-up. Written into the identity table by the
 * sign-in, so from then on it is a row like any other and never derived.
 */
export function githubDefaultAgentId(profile: Pick<GithubProfile, "id">): string {
  return `u-github_${profile.id}`;
}

/** The key the identity table is looked up by: the numeric id, never the login. */
export function githubIdentityKey(profile: Pick<GithubProfile, "id">): string {
  return `github:${profile.id}`;
}

/**
 * The viewer for an admitted GitHub sign-in. `email` is display and audit
 * only: the verified primary address when GitHub exposes one, otherwise a
 * name that can never be mistaken for one. The agent comes from the table.
 */
export function githubViewer(profile: GithubProfile, emails: GithubEmail[], agentId: string): Viewer {
  const primary = emails.find((m) => m.primary && m.verified)?.email
    ?? emails.find((m) => m.verified)?.email
    ?? null;
  return {
    email: primary ?? `github:${profile.login}`,
    name: profile.name ?? null,
    username: profile.login,
    picture: profile.avatar_url ?? null,
    source: "github",
    agentId,
  };
}
