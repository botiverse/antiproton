/**
 * The 304 path for the panels whose version is their own body.
 *
 * A poll that already holds the fragment gets 304 and the same version back;
 * a poll that holds something else, or nothing, gets the fragment with its
 * version; the version is a property of the body alone, so two renders of the
 * same data agree and one changed byte does not.
 */
import { bodyVersion, conditional, html, holds, notModified, VERSION_HEADER } from "../cf/src/version.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const req = (version?: string) =>
  new Request("https://example.test/ui/inbox", { headers: version ? { [VERSION_HEADER]: version } : {} });

await check("a first poll gets the fragment and its version", async () => {
  const r = await conditional(req(), "<p>one</p>");
  must(r.status === 200, `expected 200, got ${r.status}`);
  must(r.headers.get("content-type")?.startsWith("text/html"), "not html");
  must(await r.text() === "<p>one</p>", "body must be the fragment");
  must(r.headers.get(VERSION_HEADER) === await bodyVersion("<p>one</p>"), "version must be the body's digest");
});

await check("a poll holding the current version gets 304 with an empty body and the version", async () => {
  const v = await bodyVersion("<p>one</p>");
  const r = await conditional(req(v), "<p>one</p>");
  must(r.status === 304, `expected 304, got ${r.status}`);
  must(await r.text() === "", "a 304 carries no body");
  must(r.headers.get(VERSION_HEADER) === v, "the 304 must name the version it confirms");
});

await check("a poll holding a stale version gets the new fragment", async () => {
  const stale = await bodyVersion("<p>one</p>");
  const r = await conditional(req(stale), "<p>one </p>");
  must(r.status === 200, `expected 200, got ${r.status}`);
  must(r.headers.get(VERSION_HEADER) !== stale, "the version must move with the body");
});

await check("the version is the body's alone: equal bodies agree, one byte apart do not", async () => {
  must(await bodyVersion("abc") === await bodyVersion("abc"), "same body, same version");
  must(await bodyVersion("abc") !== await bodyVersion("abd"), "different body, different version");
  must(/^[0-9a-f]{16}$/.test(await bodyVersion("")), "sixteen hex digits, even for an empty body");
});

await check("the explicit version rides on html() and nothing rides when there is none", () => {
  must(html("x", "v1").headers.get(VERSION_HEADER) === "v1", "explicit version missing");
  must(html("x").headers.get(VERSION_HEADER) === null, "no version must mean no header");
  must(html("x", null).headers.get(VERSION_HEADER) === null, "null version must mean no header");
  must(holds(req("v1"), "v1") && !holds(req("v1"), "v2") && !holds(req(), "v1"), "holds() must compare the header exactly");
  must(notModified("v1").status === 304 && notModified("v1").headers.get(VERSION_HEADER) === "v1", "notModified shape");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
