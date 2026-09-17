/**
 * The operator's release button, on the router side.
 *
 * Reading the source rather than running a Durable Object: the route's shape
 * is what this guards, and the four things below are the ones that rot without
 * anyone noticing — an anonymous viewer gaining a write, the alias moving into
 * a query string, the busy refusal disappearing, and a failed release being
 * reported as a success while the box keeps billing.
 */
import { readFileSync } from "node:fs";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const index = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../cf/src/runtime.ts", import.meta.url), "utf8");

/** The body of one `case "<path>": {` arm, up to the next case label. */
function routeBody(src: string, path: string): string {
  const start = src.indexOf(`case "${path}": {`);
  must(start >= 0, `the route ${path} was not found, so this file checks nothing`);
  const next = src.indexOf("\n        case ", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

check("an anonymous viewer cannot reach the release route", () => {
  const line = index.split("\n").find((l) => l.includes("const UI_WRITE_ROUTES"));
  must(line, "UI_WRITE_ROUTES is gone, so nothing decides which routes anonymous viewers are refused");
  must(line!.includes('"/ui/sandbox/release"'),
    "/ui/sandbox/release is not a write route, so an anonymous viewer on a preview can destroy a container");
});

check("the alias is read from the form body, not the query string", () => {
  const body = routeBody(index, "/ui/sandbox/release");
  must(/const form = await formOf\(request\)/.test(body), "the route stopped reading a form body");
  must(/form\.get\("alias"\)/.test(body), "the alias no longer comes from the body");
  must(!/searchParams\.get\("alias"\)/.test(body),
    "the alias moved into the query string, where it reaches logs and referrers");
});

check("the route asks the runtime, and refuses a body without an alias", () => {
  const body = routeBody(index, "/ui/sandbox/release");
  must(/stub\.uiReleaseSandbox\(/.test(body), "the route no longer calls uiReleaseSandbox");
  must(/expected an alias/.test(body), "an empty alias is no longer refused");
});

check("the release answers with the whole runtime tab, not the container panel alone", () => {
  // The button sits in the inspector's runtime tab (hx-target="closest .body"), whose body holds all three
  // panels; answering with one of them blanks the other two until the next poll (2026-09-17, #core).
  const body = routeBody(index, "/ui/sandbox/release");
  must(/runtimeStack\(await stub\.uiStorage\(/.test(body), "the release no longer answers with the stacked runtime tab");
  must(!/sandboxPanel\(/.test(body), "the release answers with the container panel alone");
});

check("releasing is refused while a background job runs on that mount", () => {
  const start = runtime.indexOf("async releaseMount(");
  must(start >= 0, "releaseMount is gone, so this checks nothing");
  const body = runtime.slice(start, runtime.indexOf("\n  async ", start + 1));
  must(/mountsWithRunningJobs\(sql, \{ tenantId, agentId \}\)\.has\(alias\)/.test(body),
    "the busy check is gone: an operator click would take the machine out from under a running command");
  const refusal = body.indexOf("running a background job");
  const release = body.indexOf("this.#gateway.releaseTask(");
  must(refusal >= 0 && release >= 0 && refusal < release,
    "the busy check no longer runs before the release");
});

check("a release the plugin could not do is not reported as done", () => {
  const start = runtime.indexOf("async releaseMount(");
  const body = runtime.slice(start, runtime.indexOf("\n  async ", start + 1));
  must(/r\.failed\.find\(/.test(body), "the failed list is ignored, so a box that stayed up reads as released");
  must(/ok: false, error: `\$\{alias\} was not released/.test(body),
    "a failed release no longer answers with ok:false");
});

console.log(`\n  Console sandbox release\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
