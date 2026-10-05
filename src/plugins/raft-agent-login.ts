/**
 * Raft Agent Login for a Raft agent running inside Antiproton: sign into a Connected App with the agent's own Raft
 * identity and run the actions its manifest offers. The same steps as Raft's CLI, `raft integration login` and
 * `raft integration invoke` (@botiverse/raft 0.0.33, botiverse/slock at 625a162:
 * packages/cli/src/commands/integration/login.ts, _session.ts, invoke.ts and manifest.ts), with two differences that
 * both come from where this runs:
 *
 * - The app's session cookie is the agent's credential for that app. The CLI keeps it in a 0600 file in the agent's
 *   home; here it is kept in the mount's database, sealed (AES-GCM) under a key derived from the mount's Raft
 *   credential (`sealingKey`). It never goes into a result, an error or a log line: results say only that a session is
 *   kept and until when, and everything an app sends back is walked for the cookie's value before it is returned
 *   (`withheld`).
 * - An app is reached only where its manifest lives. The manifest URL is the one Raft registered for the service; an
 *   action is sent only to that URL's own origin, over https, never to an internal host, and never by following a
 *   redirect (`actionUrl`, `appFetch`). The Raft credential goes to Raft alone: no request here carries it.
 *
 * What the CLI does and this does too: a login answered `approval_required` or `install_required` is handed back as
 * it came, with the card Raft posted when a `target` was given; any other answer is followed by the callback handoff
 * (`returnUrl?code=<requestId>`, redirects not followed) whose Set-Cookie headers are the session; the one-time
 * `requestId` is not shown once a login succeeded. An invoke with no live session signs in first.
 *
 * What it adds: a scoped login an app answers with `grant_recorded_no_session` (the grant is recorded but the app made
 * no session, as reminder-app does for `agent:notification:write`) is a success, followed by one unscoped login for the
 * session; and an action the app answers 401 drops the session, signs in again and is sent once more.
 */
import { clip, logEvent, routeOf } from "../core/log.ts";
import type { Json } from "../core/types.ts";
import type { Raft } from "@botiverse/raft-sdk";
import { internalHost } from "./http.ts";
import type { PluginContext, PluginErrorFields, ToolSchema } from "./types.ts";

/** Where a mount keeps its app sessions: one row per Raft service id, none of them listed. */
export const SESSION_STORE = "agentLogin";
/** The largest manifest read, as the CLI (`AGENT_MANIFEST_MAX_BYTES`). */
export const MANIFEST_MAX_BYTES = 64 * 1024;
/** How long a fetched manifest is used before it is fetched again. */
export const MANIFEST_TTL_MS = 5 * 60 * 1000;
/** The largest app answer read into a result. */
export const ACTION_MAX_BYTES = 256 * 1024;
/** A cookie this close to expiry is treated as expired, as the CLI's `freshCookies`. */
const EXPIRY_SKEW_MS = 30_000;
const MAX_ERROR_BODY = 2_000;

export const LOGIN_TOOL = "integrations_login";
export const ACTIONS_TOOL = "integrations_actions";
export const INVOKE_TOOL = "integrations_invoke";

export const AGENT_LOGIN_TOOLS: readonly ToolSchema[] = [
  {
    name: LOGIN_TOOL,
    summary: "Sign this agent into a Raft Connected App with its own Raft identity (Agent Login). " +
      "Raft records a grant for the app; the app's session is then kept by this mount and is never shown to you. " +
      "scopes asks for more than the app's default grant (for example agent:notification:write, which lets the app notify you); " +
      "when the app records a scoped grant without a session, an unscoped login follows to get one. " +
      "status approval_required or install_required means nothing was signed in: a person has to approve or install the app first. " +
      "Pass target (a channel such as #general) to have Raft post a card there for them, and call again once they have.",
    parameters: {
      type: "object", additionalProperties: false, required: ["service"],
      properties: {
        service: { type: "string", minLength: 1, maxLength: 200, description: "The app: its Raft service id, client id, or exact name." },
        scopes: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, description: "Optional: grants to request beyond the app's default." },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Optional: a conversation where Raft posts an approval or install card when one is needed." },
      },
    },
    // Raft records a grant or a request, and with a target posts a card; a repeat may post a second card.
    sideEffects: "write",
    idempotency: "none",
  },
  {
    name: ACTIONS_TOOL,
    summary: "List the actions a Raft Connected App offers agents, from the app's manifest: " +
      `each action's name, what it does and its parameters. Run one with ${INVOKE_TOOL}.`,
    parameters: {
      type: "object", additionalProperties: false, required: ["service"],
      properties: {
        service: { type: "string", minLength: 1, maxLength: 200, description: "The app: its Raft service id, client id, or exact name." },
      },
    },
    sideEffects: "read",
    idempotency: "native",
  },
  {
    name: INVOKE_TOOL,
    summary: "Run one action of a Raft Connected App as this agent: only an action the app's manifest names " +
      `(${ACTIONS_TOOL} lists them), sent to the app with this agent's session. params are the action's parameters as JSON. ` +
      "Signs in first when there is no session, and once more if the app says the session expired. Returns the app's answer. " +
      "An action may change things in the app (create, cancel); it runs once per call.",
    parameters: {
      type: "object", additionalProperties: false, required: ["service", "action"],
      properties: {
        service: { type: "string", minLength: 1, maxLength: 200, description: "The app: its Raft service id, client id, or exact name." },
        action: { type: "string", minLength: 1, maxLength: 80, description: "The action's name, as the manifest gives it." },
        params: { type: "object", description: "Optional: the action's parameters." },
        target: { type: "string", minLength: 1, maxLength: 200, description: "Optional: where Raft posts an approval card if signing in needs one." },
      },
    },
    // Whatever the app's action does; the manifest does not say, so it is a write and is never run again on its own.
    sideEffects: "write",
    idempotency: "none",
  },
];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function fail(message: string, marks: { transient?: boolean; mayHaveLanded?: boolean } = {}): Error {
  const e = new Error(message) as Error & PluginErrorFields;
  if (marks.transient !== undefined) e.transient = marks.transient;
  if (marks.mayHaveLanded) e.mayHaveLanded = true;
  e.retryable = marks.mayHaveLanded === true;
  return e;
}

/** What the plugin hands this module: a Raft client for the mount, and the mount's request timeout. */
export interface AgentLoginDeps {
  raft: () => Raft;
  timeoutMs: number;
}

/** A Raft service record as the login and list routes answer it (the fields this module reads). */
export interface ServiceRecord {
  id: string;
  clientId: string;
  name: string;
  returnUrl: string | null;
  homepageUrl: string | null;
  agentManifestUrl: string | null;
}

function serviceOf(value: unknown): ServiceRecord | null {
  const s = obj(value);
  if (typeof s.id !== "string" || typeof s.clientId !== "string" || typeof s.name !== "string") return null;
  return {
    id: s.id, clientId: s.clientId, name: s.name,
    returnUrl: typeof s.returnUrl === "string" ? s.returnUrl : null,
    homepageUrl: typeof s.homepageUrl === "string" ? s.homepageUrl : null,
    agentManifestUrl: typeof s.agentManifestUrl === "string" ? s.agentManifestUrl : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cookies: the CLI's parsing and matching (_session.ts), unchanged in what they accept.

export interface SessionCookie { pair: string; host: string; path: string; secure: boolean; expiresAt?: string }

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookieExpiry(parts: string[]): string | undefined {
  const attrs = parts.map((part) => {
    const i = part.indexOf("=");
    return { name: (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase(), value: i >= 0 ? part.slice(i + 1).trim() : "" };
  });
  const maxAge = attrs.find((a) => a.name === "max-age");
  if (maxAge && /^-?\d+$/.test(maxAge.value)) {
    const seconds = Number(maxAge.value);
    if (Number.isSafeInteger(seconds)) return seconds <= 0 ? new Date(0).toISOString() : new Date(Date.now() + seconds * 1000).toISOString();
  }
  for (const a of attrs) {
    if (a.name === "expires") {
      const t = Date.parse(a.value);
      if (Number.isFinite(t)) return new Date(t).toISOString();
    }
  }
  return undefined;
}

export function parseSetCookie(value: string, source: URL): SessionCookie | null {
  const parts = value.split(";").map((p) => p.trim()).filter(Boolean);
  const pair = parts.shift();
  if (!pair || !pair.includes("=") || pair.startsWith("=")) return null;
  const sourceHost = source.hostname.toLowerCase();
  let host = sourceHost;
  let path = defaultCookiePath(source.pathname);
  let secure = false;
  for (const part of parts) {
    const i = part.indexOf("=");
    const name = (i >= 0 ? part.slice(0, i) : part).trim().toLowerCase();
    const raw = i >= 0 ? part.slice(i + 1).trim() : "";
    if (name === "secure") secure = true;
    else if (name === "path" && raw.startsWith("/")) path = raw;
    // A cookie for any host but the one that set it is dropped, as the CLI drops it.
    else if (name === "domain") {
      const domain = raw.replace(/^\./, "").toLowerCase();
      if (domain !== sourceHost) return null;
      host = domain;
    }
  }
  return { pair, host, path, secure, expiresAt: cookieExpiry(parts) };
}

function unexpired(c: SessionCookie, skew = 0): boolean {
  return !c.expiresAt || Date.parse(c.expiresAt) > Date.now() + skew;
}

export function freshCookies(cookies: SessionCookie[]): SessionCookie[] {
  return cookies.filter((c) => unexpired(c, EXPIRY_SKEW_MS));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (cookiePath.endsWith("/")) return requestPath.startsWith(cookiePath);
  return requestPath.startsWith(`${cookiePath}/`);
}

export function cookieHeaderFor(cookies: SessionCookie[], url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const pairs = cookies
    .filter((c) => unexpired(c) && c.host === host && (!c.secure || url.protocol === "https:") && pathMatches(url.pathname || "/", c.path))
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => c.pair);
  return pairs.length ? pairs.join("; ") : null;
}

function setCookies(headers: Headers): string[] {
  const all = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof all === "function" ? all.call(headers) : [headers.get("set-cookie")].filter((v): v is string => !!v);
}

// ---------------------------------------------------------------------------------------------------------------
// Keeping a session: sealed under a key only this mount's Raft credential yields.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * The key a mount's sessions are sealed under: HKDF-SHA-256 of the mount's Raft credential, salted with the mount's
 * place (tenant, agent, alias). Derived rather than taken from the Worker's SECRET_KEK because no plugin but `state` is
 * handed that key (src/plugins/types.ts `readsOwnerSecrets`, test/console-mounts.ts), and the credential is itself kept
 * sealed under it: reading a session needs what reading the credential needs. A credential replaced or removed opens
 * none of the sessions kept under the old one, and the next call signs in again as the new account, which is right:
 * those sessions belonged to the identity the old credential named.
 */
async function sealingKey(ctx: PluginContext): Promise<Awaited<ReturnType<typeof crypto.subtle.deriveKey>>> {
  if (!ctx.credential) throw fail("raft needs an account: a person must attach an agent credential to this mount");
  const material = await crypto.subtle.importKey("raw", enc.encode(ctx.credential), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(`${ctx.caller.tenantId}\u0000${ctx.caller.agentId}\u0000${ctx.alias}`), info: enc.encode("antiproton raft agent-login session v1") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

interface StoredSession {
  v: 1;
  serviceId: string;
  clientId: string;
  returnUrl: string;
  /** The scopes of the login that made it, null for an unscoped one: a re-login asks for the same. */
  scopes: string[] | null;
  /** The earliest expiry of its cookies, ms, or null when none says. Not secret: shown as "kept until". */
  expiresAt: number | null;
  createdAt: number;
  /** The cookies, sealed; bound to the service id as additional data, so a row moved under another id does not open. */
  iv: string;
  ciphertext: string;
}

async function storeSession(ctx: PluginContext, service: ServiceRecord, cookies: SessionCookie[], scopes: string[] | null): Promise<StoredSession> {
  const fresh = freshCookies(cookies);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(service.id) }, await sealingKey(ctx), enc.encode(JSON.stringify(fresh)));
  const expiries = fresh.map((c) => (c.expiresAt ? Date.parse(c.expiresAt) : NaN)).filter(Number.isFinite);
  const row: StoredSession = {
    v: 1, serviceId: service.id, clientId: service.clientId, returnUrl: service.returnUrl ?? "", scopes,
    expiresAt: expiries.length ? Math.min(...expiries) : null, createdAt: Date.now(),
    iv: b64(iv), ciphertext: b64(new Uint8Array(ct)),
  };
  await ctx.db.put(SESSION_STORE, row as unknown as Json, service.id);
  return row;
}

/**
 * The session kept for this service, if it is still for the same registration (service id, client id and return URL,
 * as the CLI's `loadStoredIntegrationSession`), opens under this mount's key, and has a cookie that has not expired.
 */
async function loadSession(ctx: PluginContext, service: ServiceRecord): Promise<{ cookies: SessionCookie[]; row: StoredSession } | null> {
  const row = obj(await ctx.db.get(SESSION_STORE, service.id)) as Partial<StoredSession>;
  if (row.v !== 1 || row.serviceId !== service.id || row.clientId !== service.clientId || row.returnUrl !== (service.returnUrl ?? "") ||
      typeof row.iv !== "string" || typeof row.ciphertext !== "string") return null;
  let cookies: unknown;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv), additionalData: enc.encode(service.id) }, await sealingKey(ctx), unb64(row.ciphertext));
    cookies = JSON.parse(dec.decode(pt));
  } catch { return null; }
  if (!Array.isArray(cookies)) return null;
  const fresh = freshCookies(cookies.filter((c): c is SessionCookie => typeof obj(c).pair === "string" && typeof obj(c).host === "string" && typeof obj(c).path === "string"));
  return fresh.length ? { cookies: fresh, row: row as StoredSession } : null;
}

async function dropSession(ctx: PluginContext, serviceId: string): Promise<void> {
  await ctx.db.delete(SESSION_STORE, serviceId);
}

/** What a result may say about a kept session: that it exists and until when, never what it is. */
function sessionView(row: StoredSession): Json {
  return { status: "kept", expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt).toISOString() };
}

// ---------------------------------------------------------------------------------------------------------------
// What goes back to the model: nothing that is a session or a credential.

function cookieValues(cookies: readonly SessionCookie[]): string[] {
  // Every value, however short: a short session is still the session. Only an empty one is skipped, which would match everywhere.
  return cookies.map((c) => c.pair.slice(c.pair.indexOf("=") + 1)).filter((v) => v.length > 0);
}

/**
 * The value with every string that carries one of `secrets` replaced, walked whole: an app that echoes its session (in
 * a field of any name, at any depth) or a Raft credential that comes back in an answer is not handed to the model.
 */
export function withheld(value: unknown, secrets: readonly string[], depth = 0): Json {
  if (typeof value === "string") {
    let out = value;
    for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join("[withheld]");
    return out;
  }
  if (depth > 40 || value === null || typeof value !== "object") return (value === undefined ? null : value) as Json;
  if (Array.isArray(value)) return value.map((v) => withheld(v, secrets, depth + 1));
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value)) out[withheld(k, secrets, depth + 1) as string] = withheld(v, secrets, depth + 1);
  return out;
}

const CREDENTIAL_FIELD = /(apikey|authorization|bearer|cookie|credential|password|secret|session|token)$/;

/** An app's error body as the CLI shows it (`redactActionErrorValue`): credential-named fields and token shapes left out. */
function redactedError(value: unknown, field?: string, depth = 0): unknown {
  if (field && CREDENTIAL_FIELD.test(field.replace(/[^a-z0-9]/gi, "").toLowerCase()) && value !== null && value !== undefined) return "<redacted>";
  if (typeof value === "string") {
    return value
      .replace(/\b(sk_(?:agent|machine|computer|daemon)_)[A-Za-z0-9._-]+/g, "$1<redacted>")
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>");
  }
  if (depth > 40) return null;
  if (Array.isArray(value)) return value.map((v) => redactedError(v, undefined, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactedError(v, k, depth + 1)]));
  return value;
}

function errorBody(raw: string, secrets: readonly string[]): string {
  let text: string;
  try { text = JSON.stringify(redactedError(JSON.parse(raw))); }
  catch { text = String(redactedError(raw.trim())) || "<empty>"; }
  text = withheld(text, secrets) as string;
  return text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…[truncated]` : text;
}

/** A URL as an error may name it: where, never the query (the callback's carries the one-time code). */
function shown(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Reaching an app.

/** An app URL this mount will reach: https, no user info, not an internal host. */
export function appUrlProblem(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "is not a URL"; }
  if (url.protocol !== "https:") return "must be https";
  if (url.username || url.password) return "must not carry a user name or password";
  if (internalHost(url.hostname)) return `names an internal host (${url.hostname})`;
  return null;
}

async function appFetch(ctx: PluginContext, deps: AgentLoginDeps, url: URL, init: RequestInit, what: string): Promise<Response> {
  const started = Date.now();
  const line = { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, what, method: init.method ?? "GET", host: url.host, route: routeOf(url.pathname) };
  try {
    // Never followed: a redirect would carry the session (or the one-time code) to wherever it points.
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs) });
    logEvent("raft.app", { ...line, status: res.status, ms: Date.now() - started });
    return res;
  } catch (e) {
    logEvent("raft.app", { ...line, status: null, ms: Date.now() - started, error: clip(String((e as { name?: unknown })?.name ?? "error")) });
    throw e;
  }
}

async function boundedText(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel(); return null; }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return dec.decode(all);
}

// ---------------------------------------------------------------------------------------------------------------
// Login.

type LoginAnswer = Obj & { status: string; service: ServiceRecord; scopes: string[]; requestId?: string };

function normalizeScopes(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) throw fail("scopes must be a list of strings");
  const scopes = [...new Set((raw as string[]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))].sort();
  if (!scopes.length) throw fail("scopes must include at least one non-empty scope");
  if (scopes.length > 20) throw fail("scopes takes at most 20 scopes");
  return scopes;
}

async function raftLogin(deps: AgentLoginDeps, service: string, scopes: string[] | undefined, target: string | undefined): Promise<LoginAnswer> {
  const out = await deps.raft().routes.integrations.login({ body: { service, ...(scopes ? { scopes } : {}), ...(target ? { target } : {}) } } as never) as
    { ok: boolean; status?: number; data?: unknown; error?: { kind?: string; message?: string; errorCode?: string } };
  if (!out.ok) {
    const status = out.status;
    const code = out.error?.errorCode ? ` (${out.error.errorCode})` : "";
    const transient = out.error?.kind === "transport" || (status !== undefined && (status === 429 || status >= 500));
    // A login is a write (it records a grant or a request, and may post a card): one with no answer, or a 5xx, may have landed.
    const landed = out.error?.kind === "transport" || (status !== undefined && status >= 500);
    throw fail(`Agent Login failed${status ? ` with HTTP ${status}` : ""}${code}: ${out.error?.message ?? "no answer from Raft"}`, { transient, mayHaveLanded: landed });
  }
  const data = obj(out.data);
  const record = serviceOf(data.service);
  if (typeof data.status !== "string" || !record) throw fail("Raft answered the login with an unexpected shape");
  return { ...data, status: data.status, service: record, scopes: Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === "string") : [] } as LoginAnswer;
}

function serviceLine(s: ServiceRecord): Json {
  return { id: s.id, clientId: s.clientId, name: s.name };
}

/** `approval_required` or `install_required`, as the model reads it: nothing was signed in, and who acts next. */
function notSignedIn(answer: LoginAnswer, tool: string): Record<string, Json> {
  const service = answer.service;
  if (answer.status === "install_required") {
    const inst = obj(answer.installation);
    const card = str(inst.actionCardMessageId);
    return {
      status: "install_required", signedIn: false, service: serviceLine(service), scopes: answer.scopes,
      installation: { serverName: str(inst.serverName) ?? null, marketplaceUrl: str(inst.marketplaceUrl) ?? null, target: str(inst.target) ?? null, actionCardMessageId: card ?? null },
      next: card
        ? `The app is public in the Raft Marketplace but not installed on this Server; a card was posted for a Server owner or admin to install it. Call ${tool} again once they have.`
        : `The app is public in the Raft Marketplace but not installed on this Server, and nothing installed it. Ask a Server owner or admin to install it, or call ${tool} again with target (a channel) to post an install card for them.`,
    };
  }
  const approval = obj(answer.approval);
  const card = str(approval.actionCardMessageId);
  return {
    status: "approval_required", signedIn: false, service: serviceLine(service), scopes: answer.scopes,
    approval: { requestId: str(approval.requestId) ?? answer.requestId ?? null, target: str(approval.target) ?? null, actionCardMessageId: card ?? null },
    next: card
      ? `A card was posted for a Server owner or admin to approve this login. Call ${tool} again once they have.`
      : `A Server owner or admin has to approve this login. Call ${tool} again with target (a channel) to post an approval card for them, or ask them to approve the request.`,
  };
}

type Handoff = { kind: "session"; cookies: SessionCookie[] } | { kind: "grant_only"; hint: string | null };

/**
 * The callback handoff (`consumeAgentLoginHandoff`): `returnUrl?code=<requestId>`, read without following its
 * redirect, and its Set-Cookie headers kept as the session. An app that answers `grant_recorded_no_session` recorded
 * the grant and made no session; that is reported, and whether it is a failure is the caller's to decide.
 */
async function handoff(ctx: PluginContext, deps: AgentLoginDeps, answer: LoginAnswer): Promise<Handoff> {
  const code = answer.requestId;
  if (!code) throw fail("Raft answered the login without the one-time handoff code; nothing was signed in");
  const problem = appUrlProblem(answer.service.returnUrl ?? "");
  if (problem) throw fail(`the app's return URL ${problem}; this mount does not sign in there`);
  const url = new URL(answer.service.returnUrl!);
  url.searchParams.set("code", code);
  let res: Response;
  try {
    res = await appFetch(ctx, deps, url, { method: "GET", headers: { accept: "text/html,application/json" } }, "callback");
  } catch {
    throw fail(`The Raft grant is active, but the app's sign-in callback (${shown(url)}) did not answer, so no session was kept. Call ${LOGIN_TOOL} again.`, { transient: true });
  }
  if (res.status < 200 || res.status >= 400) {
    const raw = (await boundedText(res, 4096).catch(() => null)) ?? "";
    const body = obj((() => { try { return JSON.parse(raw); } catch { return null; } })());
    const appCode = str(body.error) ?? str(body.code);
    if (appCode === "grant_recorded_no_session") {
      const hint = str(body.hint) ?? str(body.message) ?? null;
      return { kind: "grant_only", hint: hint ? errorBody(JSON.stringify(hint), [code]).slice(0, 400) : null };
    }
    const said = raw ? ` The app said: ${errorBody(raw, [code])}` : "";
    throw fail(res.status === 409
      ? `The Raft grant is active, but the app's sign-in handoff had expired or was already used, so no session was kept.${said}`
      : `The Raft grant is active, but the app's sign-in callback answered HTTP ${res.status}, so no session was kept.${said}`,
    { transient: res.status === 409 || res.status === 429 || res.status >= 500 });
  }
  await res.body?.cancel().catch(() => {});
  const cookies = setCookies(res.headers).map((v) => parseSetCookie(v, url)).filter((c): c is SessionCookie => c !== null);
  if (!freshCookies(cookies).length) throw fail("The app's sign-in callback set no session cookie; it may not support Agent Login sessions");
  return { kind: "session", cookies };
}

/** One login and its handoff, kept: what both tools run. */
type Signed =
  | { kind: "not_signed_in"; result: Record<string, Json> }
  | { kind: "session"; service: ServiceRecord; scopes: string[]; row: StoredSession; cookies: SessionCookie[]; grantOnly?: { scopes: string[]; hint: string | null } }
  | { kind: "no_session"; service: ServiceRecord; scopes: string[]; reason: string; grantOnly?: { scopes: string[]; hint: string | null } };

async function signIn(ctx: PluginContext, deps: AgentLoginDeps, service: string, scopes: string[] | undefined, target: string | undefined, tool: string): Promise<Signed> {
  const first = await raftLogin(deps, service, scopes, target);
  if (first.status === "approval_required" || first.status === "install_required") return { kind: "not_signed_in", result: notSignedIn(first, tool) };
  if (!first.service.returnUrl) {
    return { kind: "no_session", service: first.service, scopes: first.scopes, reason: "the app registered no return URL, so Raft has no session to hand over; follow the app's own documentation" };
  }
  const got = await handoff(ctx, deps, first);
  if (got.kind === "session") {
    const row = await storeSession(ctx, first.service, got.cookies, scopes ?? null);
    return { kind: "session", service: first.service, scopes: first.scopes, row, cookies: freshCookies(got.cookies) };
  }
  // The app recorded the grant and made no session. For an unscoped login that is all it will do; for a scoped one
  // the grant is what was asked for, and an unscoped login asks the app for the session, as its hint says to.
  if (!scopes) throw fail(`The Raft grant is active, but the app made no session for an unscoped login${got.hint ? `: ${got.hint}` : ""}`);
  const grantOnly = { scopes: first.scopes, hint: got.hint };
  const second = await raftLogin(deps, first.service.id, undefined, target);
  if (second.status === "approval_required" || second.status === "install_required") {
    return { kind: "not_signed_in", result: { ...notSignedIn(second, tool), grantRecorded: { scopes: grantOnly.scopes } } };
  }
  if (!second.service.returnUrl) return { kind: "no_session", service: second.service, scopes: second.scopes, reason: "the app registered no return URL", grantOnly };
  const again = await handoff(ctx, deps, second);
  if (again.kind !== "session") return { kind: "no_session", service: second.service, scopes: second.scopes, reason: "the app made no session for the unscoped login either", grantOnly };
  const row = await storeSession(ctx, second.service, again.cookies, null);
  return { kind: "session", service: second.service, scopes: second.scopes, row, cookies: freshCookies(again.cookies), grantOnly };
}

export async function integrationsLogin(args: unknown, ctx: PluginContext, deps: AgentLoginDeps): Promise<Json> {
  const a = obj(args);
  const service = str(a.service);
  if (!service) throw fail("service is required: the app's Raft service id, client id, or exact name");
  const scopes = normalizeScopes(a.scopes);
  const target = str(a.target);
  const signed = await signIn(ctx, deps, service, scopes, target, LOGIN_TOOL);
  if (signed.kind === "not_signed_in") return signed.result;
  const grant = signed.grantOnly
    ? { grantRecorded: { scopes: signed.grantOnly.scopes, note: "the app recorded this grant without a session; the session below comes from an unscoped login" } }
    : {};
  return {
    status: "grant_active", signedIn: signed.kind === "session", service: serviceLine(signed.service), scopes: signed.scopes, ...grant,
    session: signed.kind === "session" ? sessionView(signed.row) : { status: "none", reason: signed.reason },
    note: "This agent is authorized in Raft. The app's session is kept by this mount and is not shown; whether the app accepts it shows on the first action.",
    next: signed.kind === "session"
      ? `${ACTIONS_TOOL} lists what the app offers; ${INVOKE_TOOL} runs one.`
      : "There is no app session to act with.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The manifest.

export interface ManifestAction {
  name: string;
  description?: string;
  endpoint: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };
  parameters?: Record<string, { type: string; description?: string; required: boolean }>;
  file: boolean;
}
export interface Manifest {
  /** Where it was read: its origin is the only one an action is sent to. */
  url: URL;
  mode: string;
  baseUrl?: string;
  appOrigin?: string;
  actions: ManifestAction[];
}

const NAME = /^[A-Za-z0-9._:-]{1,80}$/;

function endpointPath(value: unknown, at: string): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`${at} must be a path on the app, starting with one /`);
  const parsed = new URL(path, "https://manifest.local");
  if (parsed.origin !== "https://manifest.local" || parsed.hash) throw new Error(`${at} must be a path on the app`);
  return path;
}

/** A v0 manifest (`raft-agent-manifest.v0` / `slock-agent-manifest.v0`), checked as the CLI's `validateAgentManifestV0` checks the parts used here. */
export function readManifest(value: unknown, url: URL): Manifest {
  const m = obj(value);
  if (/\.v1$/.test(String(m.schema))) throw new Error(`manifest schema ${String(m.schema)} is not one this mount runs yet (it runs v0 manifests)`);
  if (m.schema !== "raft-agent-manifest.v0" && m.schema !== "slock-agent-manifest.v0" && m.schema !== "https://app.slock.ai/schemas/agent-manifest.v0.json") {
    throw new Error("manifest schema must be raft-agent-manifest.v0");
  }
  const execution = obj(m.execution);
  if (execution.mode !== "http_api" && execution.mode !== "local_cli") throw new Error("execution.mode must be http_api or local_cli");
  if (m.actions !== undefined && !Array.isArray(m.actions)) throw new Error("actions must be a list");
  const seen = new Set<string>();
  const actions = ((m.actions ?? []) as unknown[]).map((raw, i): ManifestAction => {
    const r = obj(raw);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!NAME.test(name)) throw new Error(`actions[${i}].name must be letters, digits, dot, underscore, colon or dash`);
    if (seen.has(name)) throw new Error(`duplicate action name: ${name}`);
    seen.add(name);
    const ep = obj(r.endpoint);
    const method = typeof ep.method === "string" ? ep.method.trim().toUpperCase() : "";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`actions[${i}].endpoint.method must be GET, POST, PUT, PATCH or DELETE`);
    let parameters: ManifestAction["parameters"];
    if (r.parameters !== undefined) {
      parameters = {};
      for (const [key, p] of Object.entries(obj(r.parameters))) {
        const spec = obj(p);
        if (!NAME.test(key) || typeof spec.type !== "string") throw new Error(`actions[${i}].parameters.${key} must have a type`);
        parameters[key] = { type: spec.type.trim(), ...(str(spec.description) ? { description: str(spec.description) } : {}), required: spec.required === true };
      }
    }
    return {
      name, ...(str(r.description) ? { description: str(r.description) } : {}),
      endpoint: { method: method as ManifestAction["endpoint"]["method"], path: endpointPath(ep.path, `actions[${i}].endpoint.path`) },
      ...(parameters ? { parameters } : {}),
      file: obj(r.response).type === "file",
    };
  });
  return { url, mode: execution.mode as string, baseUrl: str(execution.base_url), appOrigin: str(m.app_origin), actions };
}

const WELL_KNOWN = ["/.well-known/raft-agent-manifest.json", "/.well-known/slock-agent-manifest.json"];

export type ManifestCache = Map<string, { at: number; manifest: Manifest }>;

async function fetchManifest(ctx: PluginContext, deps: AgentLoginDeps, service: ServiceRecord, cache: ManifestCache): Promise<Manifest> {
  const raw = service.agentManifestUrl;
  if (!raw) throw fail(`${service.name} registered no agent manifest with Raft, so it offers no actions to run here`);
  const problem = appUrlProblem(raw);
  if (problem) throw fail(`${service.name}'s manifest URL ${problem}; this mount does not read it`);
  const hit = cache.get(raw);
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.manifest;
  const first = new URL(raw);
  // The CLI's alias: a well-known manifest missing under one of its two names is asked for under the other.
  const alias = WELL_KNOWN.includes(first.pathname) ? new URL(WELL_KNOWN.find((p) => p !== first.pathname)!, first) : null;
  let manifest: Manifest | null = null;
  let lastError = "";
  for (const url of alias ? [first, alias] : [first]) {
    let res: Response;
    try { res = await appFetch(ctx, deps, url, { method: "GET", headers: { accept: "application/json" } }, "manifest"); }
    catch { throw fail(`${service.name}'s manifest (${shown(url)}) did not answer`, { transient: true }); }
    if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw fail(`${service.name}'s manifest (${shown(url)}) answered with a redirect, which this mount does not follow`); }
    if (!res.ok) {
      await res.body?.cancel();
      lastError = `${service.name}'s manifest (${shown(url)}) answered HTTP ${res.status}`;
      if (res.status === 404 || res.status === 410) continue;
      throw fail(lastError, { transient: res.status === 429 || res.status >= 500 });
    }
    const text = await boundedText(res, MANIFEST_MAX_BYTES);
    if (text === null) throw fail(`${service.name}'s manifest is larger than ${MANIFEST_MAX_BYTES} bytes`);
    try { manifest = readManifest(JSON.parse(text), url); }
    catch (e) { throw fail(`${service.name}'s manifest cannot be used: ${clip(String((e as Error)?.message ?? e), 300)}`); }
    break;
  }
  if (!manifest) throw fail(lastError);
  cache.set(raw, { at: Date.now(), manifest });
  return manifest;
}

/**
 * Where an action is sent: its path on the manifest's base (as the CLI's `resolveActionUrl`), and only if that is the
 * manifest's own origin. The base may be named by the manifest, so a manifest could otherwise send this agent's session
 * (and its parameters) to any host; pinned to the origin the manifest was read from, it reaches only the app that
 * served it, which is the app Raft registered.
 */
const PATH_PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function traverses(value: string): boolean {
  let decoded = value;
  // Twice, so a value encoded once more than expected (`%252e%252e`) is judged by what a server decoding twice sees.
  for (let i = 0; i < 2; i++) { try { decoded = decodeURIComponent(decoded); } catch { break; } }
  return [value, decoded].some((v) => v.split(/[/\\]/).some((seg) => seg === "." || seg === ".."));
}

/**
 * Whether a resolved pathname is still the manifest's template, compared segment by segment. Which segments hold a
 * parameter is read from the `{name}` matches in the template itself, by position, never from a marker put into the
 * text (a marker could also be written in a fixed segment and turn it into a wildcard). A fixed segment must equal the
 * pathname's as URL writes it (so a template URL re-encodes still matches); a segment holding a parameter must be its
 * fixed text around each parameter, with each parameter non-empty and inside that one segment.
 */
export function followsTemplate(template: string, pathname: string): boolean {
  const want = template.split("/");
  const got = pathname.split("/");
  if (want.length !== got.length) return false;
  // A literal as URL writes it in a path; the leading "x" keeps a literal "." or ".." from being folded away.
  const written = (lit: string) => new URL(`/x${lit}`, "https://manifest.local").pathname.slice(2);
  const escape = (lit: string) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return want.every((seg, i) => {
    const params = [...seg.matchAll(/\{[A-Za-z][A-Za-z0-9_]*\}/g)];
    if (!params.length) return written(seg) === got[i];
    let pattern = "";
    let at = 0;
    for (const m of params) {
      pattern += `${escape(written(seg.slice(at, m.index)))}[^/]+`;
      at = m.index! + m[0].length;
    }
    pattern += escape(written(seg.slice(at)));
    return new RegExp(`^${pattern}$`).test(got[i]!);
  });
}

export function actionUrl(service: ServiceRecord, manifest: Manifest, action: ManifestAction, payload: Record<string, unknown>): URL {
  const base = manifest.baseUrl ?? manifest.appOrigin ?? service.homepageUrl ?? (service.returnUrl ? new URL(service.returnUrl).origin : null);
  if (!base) throw fail("the manifest names no base URL for its actions");
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { throw fail("the manifest's base URL is not a URL"); }
  const path = action.endpoint.path.replace(PATH_PARAM, (_m, name: string) => {
    const v = payload[name];
    if (v === undefined || v === null || v === "") throw fail(`missing path parameter ${name}`);
    const text = typeof v === "string" ? v : JSON.stringify(v);
    // encodeURIComponent leaves `.` alone and URL folds `.` and `..` segments, so `{id}` = ".." would climb out of the
    // action's path to another route of the app; a value that is, or decodes to, a dot segment is refused.
    if (text === "." || text === "..") throw fail(`a parameter cannot be . or .. (path parameter ${name}); nothing was sent`);
    if (traverses(text)) throw fail(`a parameter cannot be . or .., nor contain one as a path segment once decoded (path parameter ${name}); nothing was sent`);
    return encodeURIComponent(text);
  });
  const url = new URL(path, baseUrl);
  // Whatever the values were, the URL must still be the manifest's template, each parameter one whole segment.
  if (!followsTemplate(action.endpoint.path, url.pathname)) {
    throw fail(`${action.name}'s parameters change its path (${url.pathname} does not match ${action.endpoint.path}); nothing was sent`);
  }
  if (url.origin !== manifest.url.origin) {
    throw fail(`${service.name}'s manifest sends ${action.name} to ${url.origin}, not to ${manifest.url.origin} where the manifest is served; this mount sends an action only to the manifest's own origin`);
  }
  const problem = appUrlProblem(url.href);
  if (problem) throw fail(`${action.name}'s URL ${problem}`);
  return url;
}

async function findService(deps: AgentLoginDeps, query: string): Promise<ServiceRecord> {
  const out = await deps.raft().routes.integrations.list() as { ok: boolean; status?: number; data?: unknown; error?: { kind?: string; message?: string } };
  if (!out.ok) {
    const transient = out.error?.kind === "transport" || (out.status !== undefined && (out.status === 429 || out.status >= 500));
    throw fail(`Raft did not list this agent's apps${out.status ? ` (HTTP ${out.status})` : ""}: ${out.error?.message ?? "no answer"}`, { transient });
  }
  const services = (Array.isArray(obj(out.data).services) ? obj(out.data).services as unknown[] : []).map(serviceOf).filter((s): s is ServiceRecord => s !== null);
  const q = query.trim().toLowerCase();
  const found = services.find((s) => s.id === query || s.clientId.toLowerCase() === q || s.name.toLowerCase() === q);
  if (!found) throw fail(`No app installed on this Server matched ${JSON.stringify(query)}. ${LOGIN_TOOL} says whether it needs installing.`);
  return found;
}

function actionView(a: ManifestAction): Json {
  return {
    name: a.name, ...(a.description ? { description: a.description } : {}),
    method: a.endpoint.method,
    parameters: (a.parameters ?? {}) as unknown as Json,
    ...(a.file ? { note: "answers with a file, which this mount cannot run yet" } : {}),
  };
}

export async function integrationsActions(args: unknown, ctx: PluginContext, deps: AgentLoginDeps, cache: ManifestCache): Promise<Json> {
  const query = str(obj(args).service);
  if (!query) throw fail("service is required: the app's Raft service id, client id, or exact name");
  const service = await findService(deps, query);
  const manifest = await fetchManifest(ctx, deps, service, cache);
  const session = await loadSession(ctx, service);
  return {
    service: serviceLine(service),
    mode: manifest.mode,
    actions: manifest.actions.map(actionView),
    session: session ? sessionView(session.row) : { status: "none" },
    next: manifest.mode !== "http_api"
      ? "This app's actions run as a local command line, which this mount cannot run."
      : manifest.actions.length ? `${INVOKE_TOOL} with service ${JSON.stringify(service.clientId)} and one of these action names.` : "The app's manifest lists no actions.",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Invoke.

type Sent = { kind: "unauthorized" } | { kind: "done"; result: Json };

async function send(ctx: PluginContext, deps: AgentLoginDeps, service: ServiceRecord, action: ManifestAction, url0: URL, payload: Record<string, unknown>, cookies: SessionCookie[]): Promise<Sent> {
  const url = new URL(url0);
  const cookie = cookieHeaderFor(cookies, url);
  if (!cookie) throw fail(`the app's session cookie does not cover ${shown(url)} (its host or Path); this app's sign-in and its actions do not match`);
  const pathParams = new Set(Array.from(action.endpoint.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (m) => m[1]));
  const body = Object.fromEntries(Object.entries(payload).filter(([k]) => !pathParams.has(k)));
  const headers: Record<string, string> = { accept: "application/json,text/plain,*/*", cookie };
  // The gateway's id for this call: the same on the 401 retry below, so an app that honours the header acts once.
  if (ctx.operationId) headers["idempotency-key"] = ctx.operationId;
  const init: RequestInit = { method: action.endpoint.method, headers };
  if (action.endpoint.method === "GET") {
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  } else {
    // The CLI's resource locator: an id the path does not carry also goes as ?id=.
    if (!/\{id\}/.test(action.endpoint.path) && body.id !== undefined && body.id !== null && body.id !== "" && !url.searchParams.has("id")) {
      url.searchParams.set("id", typeof body.id === "string" ? body.id : JSON.stringify(body.id));
    }
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const secrets = [...cookieValues(cookies), ...(ctx.credential ? [ctx.credential] : [])];
  let res: Response;
  try { res = await appFetch(ctx, deps, url, init, "action"); }
  catch {
    throw fail(`${service.name} did not answer ${action.name}, so whether it ran is not known; check before running it again`, { mayHaveLanded: true, transient: true });
  }
  if (res.status === 401) { await res.body?.cancel().catch(() => {}); return { kind: "unauthorized" }; }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw fail(`${service.name} answered ${action.name} with a redirect (HTTP ${res.status}), which this mount does not follow`);
  }
  let raw: string | null;
  try { raw = await boundedText(res, ACTION_MAX_BYTES); }
  catch {
    // The status arrived, the body did not (a cut stream, a timeout mid-read). A 2xx means the app acted.
    throw fail(`${service.name}'s answer to ${action.name} (HTTP ${res.status}) broke off before it was read whole, so what it did is not known; check before running it again`,
      { mayHaveLanded: res.ok || res.status >= 500, transient: true });
  }
  if (raw === null) throw fail(`${service.name}'s answer to ${action.name} is larger than ${ACTION_MAX_BYTES} bytes`, { mayHaveLanded: res.ok });
  if (!res.ok) {
    const landed = res.status >= 500;
    throw fail(res.status === 403
      ? `${service.name} refused ${action.name} (HTTP 403): ${errorBody(raw, secrets)}`
      : `${service.name} answered ${action.name} with HTTP ${res.status}: ${errorBody(raw, secrets)}`,
    { mayHaveLanded: landed, transient: res.status === 429 || res.status >= 500 });
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let value: unknown = raw;
  if (type === "application/json" || type.endsWith("+json")) {
    try { value = JSON.parse(raw); }
    catch { throw fail(`${service.name} answered ${action.name} with JSON that does not parse (HTTP ${res.status})`, { mayHaveLanded: true }); }
  }
  return { kind: "done", result: withheld(value, secrets) };
}

export async function integrationsInvoke(args: unknown, ctx: PluginContext, deps: AgentLoginDeps, cache: ManifestCache): Promise<Json> {
  const a = obj(args);
  const query = str(a.service);
  const name = str(a.action);
  if (!query) throw fail("service is required: the app's Raft service id, client id, or exact name");
  if (!name) throw fail(`action is required: ${ACTIONS_TOOL} lists the app's actions`);
  if (a.params !== undefined && (a.params === null || typeof a.params !== "object" || Array.isArray(a.params))) throw fail("params must be an object");
  const payload = (a.params ?? {}) as Record<string, unknown>;
  const target = str(a.target);
  const service = await findService(deps, query);
  const manifest = await fetchManifest(ctx, deps, service, cache);
  if (manifest.mode !== "http_api") throw fail(`${service.name}'s actions run as a local command line, which this mount cannot run`);
  const action = manifest.actions.find((x) => x.name === name);
  if (!action) {
    throw fail(`${service.name}'s manifest has no action ${JSON.stringify(name)}; it has ${manifest.actions.map((x) => x.name).join(", ") || "none"}. Nothing was sent.`);
  }
  if (action.file) throw fail(`${action.name} answers with a file, which this mount cannot run yet`);
  for (const [p, spec] of Object.entries(action.parameters ?? {})) {
    if (spec.required && (payload[p] === undefined || payload[p] === null || payload[p] === "")) throw fail(`missing required parameter ${p}`);
  }
  const url = actionUrl(service, manifest, action, payload);

  let kept = await loadSession(ctx, service);
  let signedNow = false;
  const login = async (scopes: string[] | undefined): Promise<Record<string, Json> | null> => {
    const signed = await signIn(ctx, deps, service.clientId, scopes, target, INVOKE_TOOL);
    if (signed.kind === "not_signed_in") return { ...signed.result, invoked: false, action: action.name };
    if (signed.kind === "no_session") throw fail(`Signed in to Raft, but ${service.name} gave no session to act with: ${signed.reason}`);
    kept = { cookies: signed.cookies, row: signed.row };
    signedNow = true;
    return null;
  };
  if (!kept) {
    const stop = await login(undefined);
    if (stop) return stop;
  }
  let sent = await send(ctx, deps, service, action, url, payload, kept!.cookies);
  if (sent.kind === "unauthorized") {
    // A 401 is the app refusing the session before acting on the request. The session is dropped, and unless it was
    // made by this very call, signed in again (with the scopes it was made under) and the action sent once more.
    await dropSession(ctx, service.id);
    if (!signedNow) {
      const stop = await login(kept!.row.scopes ?? undefined);
      if (stop) return stop;
      sent = await send(ctx, deps, service, action, url, payload, kept!.cookies);
    }
    if (sent.kind === "unauthorized") {
      await dropSession(ctx, service.id);
      throw fail(`${service.name} refused this agent's session for ${action.name} (HTTP 401) even after signing in again; nothing was done`);
    }
  }
  return { service: serviceLine(service), action: action.name, result: sent.result };
}
