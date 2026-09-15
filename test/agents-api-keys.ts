/**
 * The key a program built for the OpenAI SDK authenticates with (task #17):
 * issued with our prefix, stored only as a hash, and read strictly from the
 * Bearer header.
 */
import { bearerKey, hashApiKey, KEY_PREFIX, newApiKey } from "../cf/src/agents-api/keys.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const req = (authorization?: string) =>
  new Request("https://antiproton.ai/v1/agents", authorization === undefined ? {} : { headers: { authorization } });

await check("a new key carries our prefix, 32 random bytes, and is different every time", async () => {
  const a = newApiKey(); const b = newApiKey();
  assert(a.startsWith(KEY_PREFIX) && a !== b, `keys: ${a} ${b}`);
  assert(/^ap-[A-Za-z0-9_-]{43}$/.test(a), `unexpected shape: ${a}`);
});

await check("the stored form is a stable hex SHA-256 that does not contain the key", async () => {
  const k = newApiKey();
  const h1 = await hashApiKey(k); const h2 = await hashApiKey(k);
  assert(h1 === h2 && /^[0-9a-f]{64}$/.test(h1), `hash: ${h1}`);
  assert(!h1.includes(k.slice(3, 12)), "the hash contains part of the key");
  assert(h1 !== await hashApiKey(newApiKey()), "two keys hashed the same");
});

await check("only a Bearer header with one of our keys is read; everything else is no key", async () => {
  const k = newApiKey();
  assert(bearerKey(req(`Bearer ${k}`)) === k, "a valid Bearer key was not read");
  assert(bearerKey(req(`bearer   ${k}`)) === k, "the scheme is case-insensitive in HTTP");
  for (const bad of [undefined, "", `Basic ${k}`, `Bearer`, `Bearer sk-proj-abcdefghijklmnopqrstuvwxyz`, `Bearer ap-short`, `Bearer ${k} extra`, `Bearer ap-${"x".repeat(20)}!`]) {
    assert(bearerKey(req(bad)) === null, `read a key from ${JSON.stringify(bad)}`);
  }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
