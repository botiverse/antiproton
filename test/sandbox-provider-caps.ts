/**
 * Every member of `ProviderCaps` has a reader in the plugin (src/plugins/sandbox/provider.ts). A declared capability
 * nothing reads never goes red when it is wrong: a provider can say it restricts where a box connects to while no
 * code asks, and a setting that needed it would be accepted and then quietly do nothing. So a member is added with
 * the code that reads it, and this file says which members those are and that each is read.
 */
import { readFileSync } from "node:fs";
import { run9 } from "../src/plugins/sandbox/providers/run9.ts";
import { instabox } from "../src/plugins/sandbox/providers/instabox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const backends = [run9, instabox];
const keys = (o: object) => Object.keys(o).sort();

await check("every provider declares the same capabilities", () => {
  for (const b of backends) {
    assert(keys(b.caps).join() === keys(run9.caps).join(), `${b.id} declares ${keys(b.caps)}, run9 ${keys(run9.caps)}`);
  }
  // Control: the list is not empty, so the next case has something to look for.
  assert(keys(run9.caps).length > 0, "no capability is declared");
});

await check("every declared capability is read by the plugin, in code rather than in a comment", () => {
  // Comments dropped, whole-line and inline, so a sentence that names `caps.x` does not count as reading it. A `//`
  // inside a string (a URL) cuts the rest of its line too, which can only make this red, never green.
  const code = readFileSync(new URL("../src/plugins/sandbox.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const unread = keys(run9.caps).filter((k) => !new RegExp(`\\bcaps\\??\\.${k}\\b`).test(code));
  assert(unread.length === 0, `declared but read nowhere in src/plugins/sandbox.ts: ${unread.join(", ")}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
