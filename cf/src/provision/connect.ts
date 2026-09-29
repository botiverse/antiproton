/**
 * Connect GitHub (and, later, other providers) for a provisioned agent: one flow, owned here, with
 * two ways in — Raft's agent page asks the provider API for a link (handlers.ts), and the console
 * can start the same flow. The credential is sealed on the agent's own mount, where a pasted token
 * would go; it never passes through Raft, which only ever learns the account name.
 *
 *   1. The provider API mints a one-time link: `/connect/start?t=<signed>` naming the agent, the
 *      provider, the scopes, where to send the browser back, and the Raft user who asked.
 *   2. `/connect/start` consumes the link's nonce (a forwarded or replayed link starts nothing), puts
 *      the flow in a cookie scoped to the callback path, and sends the browser to GitHub.
 *   3. GitHub returns to `/login/github/callback/connect` — a subdirectory of the OAuth App's
 *      registered callback, which GitHub accepts without a configuration change. The cookie and the
 *      state must agree; the code is exchanged; the token is HELD in the agent's own object, sealed,
 *      under a random id — not yet the mount's credential.
 *   4. The browser goes back to Raft with `status=pending&pending=<id>&by=<raftUserId>`, never a
 *      credential. Raft's landing page checks that its session is `by`, and only then calls
 *      `POST …/connections/github/confirm { pending, raftUserId }` server to server, with the session's
 *      user; the hold is released onto the mount only if that user is the one the flow was started for.
 *      Checking after attaching would only say "it is already wrong": a link sent to someone else — and
 *      GitHub skips its consent page for a user who has authorised the App before — would have put
 *      their account on this agent (account-linking CSRF).
 */
import { constantTimeEqual, cookieHeader, clearCookieHeader, GITHUB_AUTHORIZE, open, randomToken, readCookie, seal } from "../auth.ts";
import type { ConnectionRegistry } from "../control-plane.ts";

export const CONNECTION_PROVIDERS = ["github"] as const;
export type ConnectionProvider = typeof CONNECTION_PROVIDERS[number];
export const CONNECT_LINK_TTL_MS = 10 * 60_000;
export const CONNECT_START_PATH = "/connect/start";
// The sign-in's own callback, not a path under it. GitHub's docs accept a subdirectory of the registered
// callback, but the preview App refused `/login/github/callback/connect` while it took this one (read
// 2026-09-29); sharing the one registered URL does not depend on that rule. `isConnectCallback` tells
// the two flows apart by the flow cookie and its state.
export const CONNECT_CALLBACK_PATH = "/login/github/callback";
const FLOW_COOKIE = "ap_connect";
/** The plugin whose mount a provider's credential goes on; found by plugin, whatever the mount is called. */
export const CONNECTION_PLUGIN: Record<ConnectionProvider, string> = { github: "github" };
/** How long a finished flow waits for Raft to confirm its initiator. */
export const CONNECT_HOLD_TTL_MS = 10 * 60_000;

/** The smallest grant that does the job: public repositories unless private ones were asked for. */
export function scopesFor(access: "public" | "private"): string[] {
  // `gh` in the sandbox reads organisations and teams (read:org, read-only). Not `workflow`: a pushed
  // workflow runs with the repository's Actions secrets, and a connection is shared by every agent
  // pointed at it. Reading a public repository needs no connection at all.
  return [access === "private" ? "repo" : "public_repo", "read:org"];
}

/** Where the browser may be sent back: only under the Raft origin the agent was made from. */
export function returnUrlProblem(returnUrl: string, raftOrigin: string): string | null {
  let u: URL, o: URL;
  try { u = new URL(returnUrl); } catch { return "returnUrl is not a URL"; }
  try { o = new URL(raftOrigin); } catch { return "the agent's Raft origin is not a URL"; }
  if (u.origin !== o.origin) return `returnUrl must be on ${o.origin}, the Raft this agent was made from`;
  return null;
}

export interface ConnectLink {
  v: 1;
  tenantId: string;
  agentId: string;
  raftAgentId: string;
  provider: ConnectionProvider;
  returnUrl: string;
  raftUserId: string;
  scopes: string[];
  nonce: string;
  exp: number;
}

/** The link Raft hands the browser, signed with the deployment's session secret. */
export async function connectLink(
  origin: string, secret: string, spec: Omit<ConnectLink, "v" | "nonce" | "exp">, now: number,
): Promise<{ url: string; expiresAt: string }> {
  const link: ConnectLink = { v: 1, ...spec, nonce: randomToken(18), exp: now + CONNECT_LINK_TTL_MS };
  const url = new URL(CONNECT_START_PATH, origin);
  url.searchParams.set("t", await seal(secret, link));
  return { url: url.toString(), expiresAt: new Date(link.exp).toISOString() };
}

export interface ConnectDeps {
  /** The deployment's own origin, where the callback lives. */
  origin: string;
  secret: string;
  github: { clientId: string; clientSecret: string };
  registry: Pick<ConnectionRegistry, "consumeLink">;
  /** Keep the token sealed in the agent's own object until Raft confirms who finished the flow. */
  hold(tenantId: string, agentId: string, plugin: string, token: string, id: string, exp: number, raftUserId: string):
    Promise<{ ok: true } | { ok: false; error: string }>;
  exchange(code: string, redirectUri: string): Promise<string>;
  now(): number;
}

/** A page for the cases where there is nowhere trustworthy to send the browser back to. */
function page(status: number, text: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>Connect</title><p style="font:16px system-ui;margin:3em auto;max-width:36em">${text}</p>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function back(link: ConnectLink, status: "pending" | "denied" | "failed", extra: Record<string, string> = {}): string {
  const u = new URL(link.returnUrl);
  u.searchParams.set("connection", link.provider);
  u.searchParams.set("status", status);
  u.searchParams.set("by", link.raftUserId);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

/** `GET /connect/start?t=…`: spend the link, remember the flow, go to the provider. */
export async function connectStart(url: URL, deps: ConnectDeps): Promise<Response> {
  const link = await open<ConnectLink>(deps.secret, url.searchParams.get("t"), deps.now());
  if (!link || link.v !== 1) return page(400, "This link is not valid or has expired. Start again from where you clicked Connect.");
  if (!(await deps.registry.consumeLink(link.nonce, deps.now()))) {
    return page(409, "This link was already used. Start again from where you clicked Connect.");
  }
  const oauthState = randomToken();
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set("client_id", deps.github.clientId);
  authorize.searchParams.set("redirect_uri", new URL(CONNECT_CALLBACK_PATH, deps.origin).toString());
  authorize.searchParams.set("scope", link.scopes.join(" "));
  authorize.searchParams.set("state", oauthState);
  authorize.searchParams.set("allow_signup", "false");
  const flow = await seal(deps.secret, { link, oauthState, exp: link.exp });
  return new Response(null, {
    status: 302,
    headers: { location: authorize.toString(), "set-cookie": cookieHeader(FLOW_COOKIE, flow, CONNECT_LINK_TTL_MS / 1000, CONNECT_CALLBACK_PATH), "cache-control": "no-store" },
  });
}

/** Whether a callback on the shared path belongs to a connect flow: its cookie opens and its state matches. */
export async function isConnectCallback(request: Request, url: URL, deps: Pick<ConnectDeps, "secret" | "now">): Promise<boolean> {
  const flow = await open<{ oauthState: string; exp: number }>(deps.secret, readCookie(request, FLOW_COOKIE), deps.now());
  const state = url.searchParams.get("state");
  return !!flow && !!state && constantTimeEqual(state, flow.oauthState);
}

/** `GET /login/github/callback` for a connect flow: exchange, hold, and send the browser back to be confirmed. */
export async function connectCallback(request: Request, url: URL, deps: ConnectDeps): Promise<Response> {
  const flow = await open<{ link: ConnectLink; oauthState: string; exp: number }>(deps.secret, readCookie(request, FLOW_COOKIE), deps.now());
  const state = url.searchParams.get("state");
  if (!flow || !state || !constantTimeEqual(state, flow.oauthState)) {
    return page(400, "This connection did not start here, or took longer than ten minutes. Start again from where you clicked Connect.");
  }
  const { link } = flow;
  const done = (location: string) => new Response(null, {
    status: 302, headers: { location, "set-cookie": clearCookieHeader(FLOW_COOKIE, CONNECT_CALLBACK_PATH), "cache-control": "no-store" },
  });
  if (url.searchParams.get("error")) return done(back(link, "denied"));
  const code = url.searchParams.get("code");
  if (!code) return done(back(link, "failed", { reason: "no_code" }));
  let token: string;
  try {
    token = await deps.exchange(code, new URL(CONNECT_CALLBACK_PATH, deps.origin).toString());
  } catch (e) {
    console.error(`connect: ${link.provider} exchange failed for ${link.tenantId}/${link.agentId}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return done(back(link, "failed", { reason: "exchange" }));
  }
  const id = randomToken(18);
  const held = await deps.hold(link.tenantId, link.agentId, CONNECTION_PLUGIN[link.provider], token, id, deps.now() + CONNECT_HOLD_TTL_MS, link.raftUserId);
  if (!held.ok) {
    console.error(`connect: holding ${link.provider} for ${link.tenantId}/${link.agentId} failed: ${held.error}`);
    return done(back(link, "failed", { reason: "hold" }));
  }
  return done(back(link, "pending", { pending: id }));
}
