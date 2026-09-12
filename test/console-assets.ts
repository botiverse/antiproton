/**
 * The console depends on no domain but its own.
 *
 * htmx and the monospace face used to be fetched from cdnjs and Google
 * Fonts, in <head>, blocking first paint on two third-party connections —
 * and where fonts.googleapis.com is unreachable, the page drew nothing until
 * the connection gave up. Both now ship inside the Worker and are served from
 * /static with a year of immutable caching. These checks hold that: no page
 * references an outside host, the two paths answer with the right bytes and
 * headers, and the htmx we serve is the release cdnjs publishes.
 */
import { page } from "../cf/src/ui.ts";
import { loginPage, refusedPage, keyPage } from "../cf/src/login.ts";
import { staticAsset, HTMX_SRC, GEIST_MONO_SRC, FONT_CSS } from "../cf/src/static.ts";
import { HTMX_JS, HTMX_SHA512, HTMX_VERSION } from "../cf/src/vendor/htmx.ts";
import { createHash } from "node:crypto";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { results.push({ name, ok: true }); }, (e) => { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); });
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

// What cdnjs publishes for htmx 1.9.12; the generator checks it when it
// fetches, this checks the module that was committed.
const CDNJS_SHA512 = "sha512-JvpjarJlOl4sW26MnEb3IdSAcGdeTeOaAlu2gUZtfFrRgnChdzELOZKl0mN6ZvI0X+xiX5UMvxjK2Rx2z/fliw==";

const pages: Record<string, string> = {
  console: page("t_demo", "someone@botiverse", "agent-1"),
  login: loginPage(),
  refused: refusedPage("not-human"),
  key: keyPage(),
  "key-error": keyPage("that key did not match"),
};

await check("no page references an outside host for script or style", async () => {
  for (const [name, html] of Object.entries(pages)) {
    const outside = [...html.matchAll(/<(?:script|link)[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    must(outside.length === 0, `${name} loads from outside: ${outside.join(", ")}`);
    must(!/googleapis|gstatic|cdnjs/.test(html), `${name} still names a third-party host`);
  }
});

await check("every page carries the face and the console carries the script", async () => {
  for (const [name, html] of Object.entries(pages)) {
    must(html.includes(FONT_CSS), `${name} lacks the @font-face`);
    must(html.includes(`<link rel="preload" href="${GEIST_MONO_SRC}" as="font" type="font/woff2" crossorigin>`), `${name} does not preload the face`);
  }
  must(pages.console.includes(`<script src="${HTMX_SRC}"></script>`), "the console must load htmx from /static");
  must(/font-weight:400 600/.test(FONT_CSS) && /font-display:swap/.test(FONT_CSS), "one variable-weight face, swapped in");
});

await check("the static paths answer with the right bytes and headers", async () => {
  const js = staticAsset(HTMX_SRC); must(js, "no response for the script path");
  must(js!.headers.get("content-type")?.startsWith("text/javascript"), "script content-type");
  must(js!.headers.get("cache-control") === "public, max-age=31536000, immutable", "script must be immutable");
  must((await js!.text()) === HTMX_JS, "script body");
  const font = staticAsset(GEIST_MONO_SRC); must(font, "no response for the font path");
  must(font!.headers.get("content-type") === "font/woff2", "font content-type");
  must(font!.headers.get("cache-control") === "public, max-age=31536000, immutable", "font must be immutable");
  const bytes = new Uint8Array(await font!.arrayBuffer());
  must(String.fromCharCode(...bytes.subarray(0, 4)) === "wOF2", "font must be a woff2");
  must(bytes.length > 10000 && bytes.length < 60000, `a latin subset, not the whole family: ${bytes.length} bytes`);
  must(staticAsset("/static/other.js") === null && staticAsset("/ui") === null, "anything else is not ours");
  must(HTMX_SRC.includes(HTMX_VERSION) && /geist-mono-v\d+/.test(GEIST_MONO_SRC), "the version must be in the path, since the cache is immutable");
});

await check("the htmx we serve is the release cdnjs publishes", async () => {
  const sha = "sha512-" + createHash("sha512").update(HTMX_JS).digest("base64");
  must(sha === CDNJS_SHA512, `committed htmx hashes to ${sha}`);
  must(HTMX_SHA512 === CDNJS_SHA512, "the module's recorded hash must match too");
  must(!/<\/script/i.test(HTMX_JS), "served as a file, but must still never close a script tag if inlined");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
