/**
 * What a plugin's credential looks like, declared by the plugin.
 *
 * A person pasted a GitHub token and a database connection string into chat
 * (task #19). The server is to refuse such a message before the agent reads it
 * and point to where the credential belongs. The patterns live with the plugin
 * that takes the credential, so "this looks like X" and "X is filled in on that
 * mount" come from one declaration instead of two lists that drift. Only shapes
 * that are recognisable belong here: run9's keys are bare uppercase alphanumerics
 * (measured, 2026-09-15), as common as any hash, so the sandbox declares none.
 */
import { githubPlugin } from "../src/plugins/github.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const types: any = await import("../src/plugins/types.ts");
const plugins = [githubPlugin, sandboxPlugin(null as any, "local")];
// Fake values of each shape: never real credentials.
const classic = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const fineGrained = "github_pat_" + "11ABCDEFG0123456789abc" + "_" + "x".repeat(59);

await check("every declared pattern is a string that compiles and survives the trip to the console", () => {
  for (const p of plugins) {
    for (const s of p.credential?.looksLike ?? []) {
      if (typeof s.pattern !== "string" || typeof s.kind !== "string") throw new Error(`${p.id} declares ${JSON.stringify(s)}`);
      new RegExp(s.pattern);
    }
    const sent = JSON.parse(JSON.stringify(p.credential ?? null));
    if (JSON.stringify(sent?.looksLike ?? null) !== JSON.stringify(p.credential?.looksLike ?? null)) {
      throw new Error(`${p.id}'s shapes do not survive JSON`);
    }
  }
});

await check("GitHub declares its token shapes, and the sandbox declares none", () => {
  const kinds = (githubPlugin.credential?.looksLike ?? []).map((s: any) => s.kind);
  if (!kinds.length) throw new Error("github declares no credential shape");
  if (sandboxPlugin(null as any, "local").credential?.looksLike?.length) {
    throw new Error("the sandbox declares a shape for run9 keys, which are bare uppercase alphanumerics and match any hash");
  }
});

await check("a pasted GitHub token is recognised as GitHub's, in either form", () => {
  if (typeof types.recogniseCredentials !== "function") throw new Error("recogniseCredentials is not exported");
  for (const token of [classic, fineGrained, "gho_" + "Z".repeat(36), "ghs_" + "9".repeat(40)]) {
    const found = types.recogniseCredentials(`here is my token: ${token} thanks`, plugins);
    if (!found.some((f: any) => f.plugin === "github")) throw new Error(`not recognised: ${token.slice(0, 11)}…`);
  }
});

await check("prose, short fragments and our own placeholders are not credentials", () => {
  for (const text of [
    "tokens start with ghp_ or github_pat_, see the docs",
    "ghp_short",
    "GH_TOKEN=__AP_GH_TOKEN_mu2zrsrv_765285__",
    "commit 4de4652a1b2c3d4e5f60718293a4b5c6d7e8f901",
    "ABCDEFGHIJKLMNOP0123456789ABCDEFGHIJKLMNOP",
  ]) {
    const found = types.recogniseCredentials(text, plugins);
    if (found.length) throw new Error(`${JSON.stringify(text)} was taken for ${JSON.stringify(found)}`);
  }
});

await check("what is recognised names the plugin and kind, never the text that matched", () => {
  const found = types.recogniseCredentials(`a ${classic} b ${fineGrained}`, plugins);
  const out = JSON.stringify(found);
  if (out.includes(classic) || out.includes(fineGrained) || /ghp_|github_pat_/.test(out)) {
    throw new Error(`the result carries the credential: ${out.slice(0, 120)}`);
  }
  if (new Set(found.map((f: any) => `${f.plugin}/${f.kind}`)).size !== found.length) throw new Error(`duplicates: ${out}`);
});

console.log(`\n  credential shapes\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
