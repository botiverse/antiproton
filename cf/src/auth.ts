/**
 * Who is looking at the console, decided by the app itself.
 *
 * Identity used to arrive in a header that Cloudflare Access set and the app
 * trusted without checking, so the whole guarantee lived outside the code.
 * The app verifies: a person signs in through Raft (standard OpenID
 * Connect, authorization code + PKCE), the callback checks the signed id_token
 * against Raft's published keys, and what the browser carries afterwards is a
 * session sealed under a secret only this Worker holds. Nothing a caller can
 * write on a request is an identity; only something this Worker signed is.
 *
 * Everything here runs on WebCrypto so the same code is exercised by
 * `node test/auth.ts` and by the deployed Worker.
 */

export type ViewerSource = "raft" | "automation" | "qa" | "anonymous";

/** A resolved identity. `email` doubles as the stable key an agent hangs off. */
export interface Viewer {
  email: string;
  name: string | null;
  username: string | null;
  picture: string | null;
  source: ViewerSource;
}

/** What the session cookie carries. Sealed, never trusted unsealed. */
export interface SessionClaims {
  v: 1;
  who: string;
  name: string | null;
  username: string | null;
  picture: string | null;
  sub: string;
  source: "raft" | "qa";
  iat: number;
  exp: number;
}

/** Remembered between the redirect out and the callback in. */
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = "ap_session";
export const LOGIN_COOKIE = "ap_login";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const LOGIN_TTL_MS = 10 * 60_000;

export const RAFT_ISSUER = "https://api.raft.build";

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

// ---- OpenID Connect against Raft --------------------------------------------

export interface RaftConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  serverId: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 3600_000;

async function cached<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: now, value });
  return value;
}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  return cached(`disco:${issuer}`, async () => {
    const r = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`discovery failed: ${r.status}`);
    const d = (await r.json()) as Discovery;
    if (d.issuer !== issuer) throw new Error(`discovery issuer mismatch: ${d.issuer}`);
    return d;
  });
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

export async function authorizeUrl(
  cfg: RaftConfig, st: Pick<LoginState, "state" | "nonce" | "verifier">, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const d = await discover(cfg.issuer, fetchImpl);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", st.state);
  u.searchParams.set("nonce", st.nonce);
  u.searchParams.set("code_challenge", await pkceChallenge(st.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  // Narrows the consent picker to our server; the client registration is what
  // actually binds the token, so this is convenience, not a boundary.
  u.searchParams.set("server", cfg.serverId);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export async function exchangeCode(
  cfg: RaftConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const d = await discover(cfg.issuer, fetchImpl);
  const r = await fetchImpl(d.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    throw new Error(`token exchange failed: ${r.status} ${text}`);
  }
  return (await r.json()) as TokenResponse;
}

/** What Raft says about the principal. Fields beyond `type` may be absent. */
export interface RaftIdentity {
  sub: string;
  type: "human" | "agent" | string;
  server_id?: string;
  server_slug?: string;
  server_role?: string;
  name?: string | null;
  preferred_username?: string | null;
  picture?: string | null;
  email?: string | null;
  email_verified?: boolean;
}

export async function fetchUserinfo(cfg: RaftConfig, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<RaftIdentity> {
  const d = await discover(cfg.issuer, fetchImpl);
  const r = await fetchImpl(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`userinfo failed: ${r.status}`);
  return (await r.json()) as RaftIdentity;
}

export interface Jwks { keys: Array<JsonWebKey & { kid?: string; alg?: string }> }

/**
 * Verifies an ES256 id_token: signature against the given keys, issuer,
 * audience, expiry, and nonce. Returns the claims or throws with the reason.
 */
export async function verifyIdToken(
  idToken: string,
  expect: { issuer: string; clientId: string; nonce: string; jwks: Jwks; now?: number },
): Promise<RaftIdentity & { iss: string; aud: string | string[]; exp: number; nonce?: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token: not a JWS");
  const header = JSON.parse(dec.decode(unb64url(parts[0]))) as { alg?: string; kid?: string };
  if (header.alg !== "ES256") throw new Error(`id_token: alg ${header.alg}`);
  const candidates = expect.jwks.keys.filter((k) => (header.kid ? k.kid === header.kid : true) && (k.kty === "EC"));
  if (candidates.length === 0) throw new Error("id_token: no matching key");
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const sig = unb64url(parts[2]);
  let verified = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data)) { verified = true; break; }
  }
  if (!verified) throw new Error("id_token: bad signature");
  const claims = JSON.parse(dec.decode(unb64url(parts[1])));
  const now = (expect.now ?? Date.now()) / 1000;
  if (claims.iss !== expect.issuer) throw new Error("id_token: issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new Error("id_token: audience");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("id_token: expired");
  if (claims.nonce !== expect.nonce) throw new Error("id_token: nonce");
  return claims;
}

export async function fetchJwks(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  const d = await discover(issuer, fetchImpl);
  return cached(`jwks:${issuer}`, async () => {
    const r = await fetchImpl(d.jwks_uri);
    if (!r.ok) throw new Error(`jwks failed: ${r.status}`);
    return (await r.json()) as Jwks;
  });
}

export type RefusalReason = "not-human" | "no-email" | "wrong-server";

/**
 * The rules a signed-in principal must meet. Humans only (the owner's
 * decision); a verified email, because that is the key an agent hangs off;
 * and our own server, because the console is one tenant's.
 */
export function admit(id: RaftIdentity, expectedServerId: string): { ok: true; viewer: Viewer } | { ok: false; reason: RefusalReason } {
  if (id.type !== "human") return { ok: false, reason: "not-human" };
  if (!id.email || id.email_verified !== true) return { ok: false, reason: "no-email" };
  if (!id.server_id || id.server_id !== expectedServerId) return { ok: false, reason: "wrong-server" };
  return {
    ok: true,
    viewer: {
      email: id.email,
      name: id.name ?? null,
      username: id.preferred_username ?? null,
      picture: id.picture ?? null,
      source: "raft",
    },
  };
}

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
      return s.source === "qa"
        ? QA_VIEWER
        : { email: s.who, name: s.name ?? null, username: s.username ?? null, picture: s.picture ?? null, source: "raft" };
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
    source: v.source === "qa" ? "qa" : "raft",
    iat: now, exp: now + SESSION_TTL_MS,
  };
  return cookieHeader(SESSION_COOKIE, await seal(secret, claims), SESSION_TTL_MS / 1000);
}
