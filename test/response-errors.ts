/**
 * No response the Worker sends carries a stack trace. The catch-all in cf/src/index.ts sent the first 600
 * characters of one with every 500, and the console puts a failed request's body on the page (#334), so a
 * stack would have been drawn under a form. Stacks go to the Worker's log instead. Read as source text:
 * the Worker cannot be imported under node, and the property is about what the code writes into a body.
 */
import { readdirSync, readFileSync } from "node:fs";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const dir = new URL("../cf/src/", import.meta.url);
const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));

check("no response body is built with a stack", () => {
  const found: string[] = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    // A Response.json(...) or new Response(...) call whose arguments mention a stack, within one statement.
    for (const m of src.matchAll(/(Response\.json|new Response)\(([^;]*?)\)\s*;/gs)) {
      if (/\bstack\b\s*:|\.stack\b/.test(m[2]!)) found.push(`${f}: ${m[0].slice(0, 120).replace(/\s+/g, " ")}`);
    }
  }
  must(found.length === 0, `a response carries a stack:\n      ${found.join("\n      ")}`);
});

check("the check reads the Worker's source at all", () => {
  must(files.includes("index.ts") && files.length > 5, `read ${files.length} files`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
