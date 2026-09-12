/**
 * The console polls every couple of seconds. Each panel remembers the version
 * it last drew and sends it back; the server answers 304 when nothing has
 * moved, and the page leaves the DOM alone (the beforeSwap guard in ui.ts).
 *
 * Two kinds of version travel in the same header:
 *
 * - A conversation version, computed cheaply in the object before anything
 *   is rendered (`uiVersion`): the transcript, chat, and runtime panels use
 *   it, and skip the render entirely when it matches.
 * - A body version: a digest of the rendered fragment. The inbox, approvals,
 *   plugins, and agent panels read several tables and a directory in another
 *   object, and the set of what they depend on has grown three times today.
 *   A hand-built key would have to name every source and be wrong the day
 *   one is added; the digest is exact by construction. It saves the bytes and
 *   the browser's re-parse, not the object's render, which is the smaller of
 *   the two costs for these four (measured: 488 KB/min for the plugins panel
 *   alone, every response a 200).
 *
 * Not `ETag` / `If-None-Match`: Cloudflare strips `ETag` on the way out, so a
 * conditional request could never match. Found by sending both and seeing
 * which arrived.
 */
export const VERSION_HEADER = "x-ap-version";

/** The version a rendered body has: the first 16 hex of its SHA-256. */
export async function bodyVersion(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Does the request already hold this version? */
export function holds(request: Request, version: string): boolean {
  return request.headers.get(VERSION_HEADER) === version;
}

/** The 304 for a request that holds the current version. */
export function notModified(version: string): Response {
  return new Response(null, { status: 304, headers: { [VERSION_HEADER]: version } });
}

/** An HTML fragment, carrying its version when it has one. */
export function html(body: string, version: string | null = null): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(version ? { [VERSION_HEADER]: version } : {}),
    },
  });
}

/**
 * Answer a poll with the fragment, or with 304 when the caller already has
 * this exact fragment. The version is the body's own digest.
 */
export async function conditional(request: Request, body: string): Promise<Response> {
  const version = await bodyVersion(body);
  return holds(request, version) ? notModified(version) : html(body, version);
}
