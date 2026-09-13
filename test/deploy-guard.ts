/**
 * The production deploy check, without git or a network.
 *
 * `verify-and-deploy.sh` fetches origin and then asks `deploy_refusal` whether
 * this commit may ship. The question is answered by the function alone, so it
 * can be asked here with made-up commit ids: the gate runs every suite, and a
 * suite that needed a network would not belong in it.
 */
import { execFileSync } from "node:child_process";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const MASTER = "32ebe0f0000000000000000000000000000000aa";
const OLDER = "af5719e0000000000000000000000000000000bb";
const refusal = (head: string, master: string, ...args: string[]) =>
  execFileSync("bash", ["-c", '. cf/scripts/deploy-guard.sh; deploy_refusal "$@"', "guard", head, master, ...args],
    { encoding: "utf8" }).trim();

check("the current master may ship", () => {
  const r = refusal(MASTER, MASTER);
  if (r) throw new Error(`refused master itself: ${r}`);
});

check("an older commit is refused even though master contains it", () => {
  // The first version asked "is HEAD an ancestor of master", which every older
  // master commit is. Production state only moves forward, so merged-but-older
  // is not deployable: roll back by merging a revert.
  const r = refusal(OLDER, MASTER);
  if (!r.includes("refusing to deploy") || !r.includes("af5719e") || !r.includes("32ebe0f")) {
    throw new Error(`an older commit was let through, or the refusal does not name both: ${JSON.stringify(r)}`);
  }
});

check("a preview deploy may ship a branch", () => {
  const r = refusal(OLDER, MASTER, "--config", "wrangler.preview.jsonc");
  if (r) throw new Error(`refused a preview: ${r}`);
});

console.log(`\n  Deploy guard\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
