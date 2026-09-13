/**
 * `auth_status` when there is no account.
 *
 * Its subject is the identity itself, so having none is an answer, not a
 * failure — and its own summary names `gh auth status`, which prints "not
 * logged in" rather than refusing. Behind `requireAccount` an agent asking
 * "who am I here?" was told the question was invalid, and could not tell that
 * apart from a call it had got wrong (a fresh agent, via Vera, 2026-09-13).
 *
 * The mount that ships with every agent is seeded with no token, so this is
 * the state a new agent is actually in, not an edge case.
 */
import { githubPlugin } from "../src/plugins/github.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

/** A context with no credential, and a fetch that fails if anything calls out. */
function ctx(credential: string | null) {
  return {
    caller: { tenantId: "t", agentId: "a", taskId: "k" },
    alias: "gh",
    credential,
    publicConfig: {},
    fetch: () => { throw new Error("auth_status reached the network"); },
  } as any;
}

await check("no account is a state, not a refusal", async () => {
  const r = await githubPlugin.invoke("auth_status", {}, ctx(null)) as Record<string, unknown>;
  if (r.authenticated !== false) throw new Error(`did not report the unauthenticated state: ${JSON.stringify(r)}`);
  if (r.account !== null) throw new Error(`account should be null, got ${JSON.stringify(r.account)}`);
});

await check("it says who can change it, since the agent cannot", async () => {
  // The next move is a person's: an agent cannot attach a credential itself,
  // so a refusal it could act on does not exist — the truthful answer names
  // who can.
  const r = await githubPlugin.invoke("auth_status", {}, ctx(null)) as Record<string, unknown>;
  const note = String(r.note ?? "");
  if (!/person attaches/.test(note)) throw new Error(`the state does not say who attaches an account: ${note}`);
  if (!/public data/.test(note)) throw new Error(`the state does not say what it can still do: ${note}`);
});

await check("answering costs no request: nothing is asked of GitHub", async () => {
  // Whether an account exists is known locally. A call here would spend a
  // request, and fail, to learn something already in hand.
  await githubPlugin.invoke("auth_status", {}, ctx(null));
});

console.log(`\n  auth_status with no account\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
