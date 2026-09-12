/**
 * The console's own static assets: htmx and the monospace face, served from
 * this Worker rather than a third party's domain.
 *
 * Both used to come from elsewhere — htmx from cdnjs, Geist Mono from Google
 * Fonts — and both sat in <head> where they block first paint. A page that
 * waits on fonts.googleapis.com waits until that connection fails where the
 * domain is unreachable, which for a viewer in China is the usual case, and
 * the console drew nothing until then. Now the two are string modules in the
 * bundle (cf/scripts/vendor.mjs writes them), answered here with a year of
 * immutable caching. The version is in the path, so a bump is a new URL.
 */
import { HTMX_JS, HTMX_VERSION } from "./vendor/htmx.ts";
import { GEIST_MONO_UNICODE_RANGE, GEIST_MONO_VERSION, GEIST_MONO_WOFF2_BASE64 } from "./vendor/geist-mono.ts";

export const HTMX_SRC = `/static/htmx-${HTMX_VERSION}.js`;
export const GEIST_MONO_SRC = `/static/geist-mono-${GEIST_MONO_VERSION}.woff2`;

/** The @font-face for the page's <style>; one variable-weight file for 400–600. */
export const FONT_CSS = `@font-face{font-family:"Geist Mono";font-style:normal;font-weight:400 600;font-display:swap;src:url(${GEIST_MONO_SRC}) format("woff2");unicode-range:${GEIST_MONO_UNICODE_RANGE}}`;

/** What every page puts in <head> for the two assets: the script, and a font preload so the face arrives with the stylesheet rather than after it. */
export const HEAD_ASSETS = `<link rel="preload" href="${GEIST_MONO_SRC}" as="font" type="font/woff2" crossorigin>
<script src="${HTMX_SRC}"></script>`;

const IMMUTABLE = "public, max-age=31536000, immutable";
let woff2: Uint8Array | null = null;

/** The response for a static path, or null when the path is not one of ours. Public: the sign-in page needs both before anyone is signed in. */
export function staticAsset(pathname: string): Response | null {
  if (pathname === HTMX_SRC) {
    return new Response(HTMX_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": IMMUTABLE } });
  }
  if (pathname === GEIST_MONO_SRC) {
    woff2 ??= Uint8Array.from(atob(GEIST_MONO_WOFF2_BASE64), (c) => c.charCodeAt(0));
    return new Response(woff2, { headers: { "content-type": "font/woff2", "cache-control": IMMUTABLE, "access-control-allow-origin": "*" } });
  }
  return null;
}
