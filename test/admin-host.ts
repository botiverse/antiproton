/**
 * The admin host's handoff (cf/src/admin-host.ts): a ticket names its viewer once, for sixty seconds,
 * sealed with the session secret; sign-in returns only to this origin; the host answers its own paths.
 */
import { adminHostServes, handoffTicket, redeemTicket, safeReturnTo, HANDOFF_TTL_MS } from "../cf/src/admin-host.ts";
import { seal, type Viewer } from "../cf/src/auth.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const SECRET = "s".repeat(48);
const V: Viewer = { email: "a@b", name: null, username: "a", picture: null, source: "github", agentId: "u", tenantId: "t", sub: "github:1" };
const T = 1_790_000_000_000;
function spender() { const spent = new Set<string>(); return (n: string) => Promise.resolve(spent.has(n) ? false : (spent.add(n), true)); }

await check("a ticket names its viewer once", async () => {
  const spend = spender();
  const t = await handoffTicket(SECRET, V, T);
  const v = await redeemTicket(SECRET, t, T + 1_000, spend);
  must(v?.sub === "github:1" && v.agentId === "u", JSON.stringify(v));
  must((await redeemTicket(SECRET, t, T + 2_000, spend)) === null, "a ticket was used twice");
});

await check("an expired, forged or foreign-kind ticket names nobody", async () => {
  const t = await handoffTicket(SECRET, V, T);
  must((await redeemTicket(SECRET, t, T + HANDOFF_TTL_MS + 1, spender())) === null, "an expired ticket");
  must((await redeemTicket("x".repeat(48), t, T + 1, spender())) === null, "a ticket under another secret");
  must((await redeemTicket(SECRET, t.slice(0, -2) + "AA", T + 1, spender())) === null, "a tampered ticket");
  // A session cookie is sealed with the same secret: it must not pass for a ticket.
  const session = await seal(SECRET, { v: 1, who: "a@b", sub: "github:1", source: "github", exp: T + 60_000, nonce: "n" });
  must((await redeemTicket(SECRET, session, T + 1, spender())) === null, "another sealed kind passed for a ticket");
  must((await redeemTicket(SECRET, null, T, spender())) === null, "no ticket");
});

await check("sign-in returns only to a path on this origin", () => {
  must(safeReturnTo("/admin/handoff") === "/admin/handoff", "a path");
  for (const bad of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "admin", null]) {
    must(safeReturnTo(bad as any) === "/ui", `${bad} was allowed`);
  }
});

await check("the admin host answers its own paths and nothing of the console's", () => {
  for (const p of ["/", "/session", "/ui/admin", "/admin/models", "/logout"]) must(adminHostServes(p), p);
  for (const p of ["/ui", "/ui/transcript", "/provision/agents", "/hooks/x", "/admin/diagnose", "/v1/models", "/login/github"]) must(!adminHostServes(p), p);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
