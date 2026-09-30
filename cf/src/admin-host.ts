/**
 * The admin area on its own host (admin.antiproton.ai), the same Worker behind it.
 *
 * Sign-in stays where the OAuth App's callback is, on the console's origin; the admin host never runs a
 * sign-in of its own and the session cookie stays host-only (not widened to `.antiproton.ai`, where it
 * would reach preview and the report too). The admin host gets its session by a handoff:
 *
 *   admin host, no session      → 302 console `/admin/handoff`
 *   console `/admin/handoff`    → signed in? else 302 `/login/github?returnTo=/admin/handoff`;
 *                                 admin? else 404; → 302 admin `/session?t=<ticket>`
 *   admin `/session?t=`         → ticket sealed, unexpired (60 s), unspent → host-only session → 302 `/`
 *
 * The ticket carries the viewer the console resolved, sealed with the session secret, and is spent once
 * (its nonce, in the connect links' table). Every step asks isAdmin again; the admin host serves nothing
 * else to anyone else.
 */
import type { Viewer } from "./auth.ts";
import { open, randomToken, seal } from "./auth.ts";

export const HANDOFF_PATH = "/admin/handoff";
export const HANDOFF_TTL_MS = 60_000;

interface Ticket {
  v: 1; kind: "admin-handoff"; nonce: string; exp: number;
  viewer: Viewer;
}

export async function handoffTicket(secret: string, viewer: Viewer, now: number): Promise<string> {
  const t: Ticket = { v: 1, kind: "admin-handoff", nonce: randomToken(18), exp: now + HANDOFF_TTL_MS, viewer };
  return seal(secret, t);
}

/** The viewer a ticket was made for, once: null when it is forged, expired, of another kind, or spent. */
export async function redeemTicket(
  secret: string, ticket: string | null, now: number, spend: (nonce: string, at: number) => Promise<boolean>,
): Promise<Viewer | null> {
  const t = await open<Ticket>(secret, ticket, now);
  if (!t || t.v !== 1 || t.kind !== "admin-handoff" || typeof t.nonce !== "string") return null;
  if (!(await spend(t.nonce, now))) return null;
  return t.viewer;
}

/** The only paths the admin host answers; the rest of the console lives on its own origin. */
export function adminHostServes(path: string): boolean {
  return path === "/" || path === "/session" || path === "/ui/admin" || path === "/admin/models" || path === "/logout";
}

/**
 * A `returnTo` for sign-in: a path on this origin only, never another site. Judged by how it parses, not
 * by its characters: the URL parser drops tabs and newlines, so `/\t/evil.com` looks like a path and
 * resolves to `//evil.com`.
 */
export function safeReturnTo(value: string | null, origin: string): string {
  if (!value) return "/ui";
  let u: URL;
  try { u = new URL(value, origin); } catch { return "/ui"; }
  return u.origin === new URL(origin).origin ? u.pathname + u.search : "/ui";
}

/** The admin host's page until it has its own shell: the admin panel, loaded as the console loads it. */
export function adminShell(htmxSrc: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>antiproton admin</title><script src="${htmxSrc}"></script>
<style>body{font:14px system-ui;margin:2em auto;max-width:60em;padding:0 1em}</style></head>
<body><h1>antiproton admin</h1><div id="admin" hx-get="/ui/admin" hx-trigger="load">loading…</div></body></html>`;
}
