/**
 * What the github plugin says when GitHub does not answer with JSON, and when
 * an answer depends on the account the mount does not have.
 *
 * From a real trajectory (cody read it, 2026-09-15). `api_get` on an Actions
 * log got plain text and failed to parse it, so the agent fetched the log with
 * curl and the token pasted into a command. And the seeded mount, with no token,
 * answered a private repository with a bare 404 and the shared egress with a
 * bare 403: the agent concluded the repository could not be reached, and the
 * person had to work out for themselves that an account was missing.
 */
import { githubPlugin } from "../src/plugins/github.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const ctx = (credential: string | null) => ({
  caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "gh", credential, publicConfig: {},
  connection: { get: async () => null, set: async () => {} }, sibling: async () => null,
}) as any;

/** GitHub answering every request with this one response. */
function answer(status: number, body: string | Uint8Array, headers: Record<string, string>) {
  globalThis.fetch = (async () => new Response(body as any, { status, headers })) as any;
}

async function failure(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e) { return String((e as Error)?.message ?? e); }
  throw new Error("expected the call to fail, and it succeeded");
}

const original = globalThis.fetch;

await check("api_get returns a text answer as text instead of failing to parse it", async () => {
  answer(200, "2026-09-15T10:00:00Z step 1\n2026-09-15T10:00:01Z step 2\n", { "content-type": "text/plain; charset=utf-8" });
  const r = await githubPlugin.invoke("api_get", { path: "/repos/o/r/actions/jobs/1/logs" }, ctx("tok")) as any;
  if (typeof r?.text !== "string" || !r.text.includes("step 2")) throw new Error(`got ${JSON.stringify(r)}`);
  if (!/text\/plain/.test(String(r.contentType))) throw new Error(`the content type is not reported: ${JSON.stringify(r)}`);
});

await check("api_get refuses a binary answer by name, rather than returning bytes as text", async () => {
  answer(200, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0]), { "content-type": "application/zip" });
  const why = await failure(() => githubPlugin.invoke("api_get", { path: "/repos/o/r/actions/runs/1/logs" }, ctx("tok")));
  if (!/binary|application\/zip/.test(why) || /JSON|Unexpected token/.test(why)) throw new Error(`refused with: ${why}`);
});

await check("an error page that is not JSON is still reported as GitHub's status", async () => {
  answer(502, "<html><body>Bad gateway</body></html>", { "content-type": "text/html" });
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok")));
  if (!/^github 502/.test(why)) throw new Error(`reported as: ${why}`);
});

await check("with no account, a 404 says a private repository looks the same, and who can attach one", async () => {
  answer(404, JSON.stringify({ message: "Not Found" }), { "content-type": "application/json" });
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/private" }, ctx(null)));
  if (!/github 404/.test(why) || !/private/.test(why) || !/person/.test(why)) throw new Error(`said: ${why}`);
});

await check("with no account, an exhausted rate limit says an account raises it", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), {
    "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789500000",
  });
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null)));
  if (!/rate limit/.test(why) || !/account|token/.test(why) || !/person/.test(why)) throw new Error(`said: ${why}`);
});

await check("with an account, the same answers carry no hint about attaching one", async () => {
  answer(404, JSON.stringify({ message: "Not Found" }), { "content-type": "application/json" });
  const notFound = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/private" }, ctx("tok")));
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), {
    "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789500000",
  });
  const limited = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok")));
  for (const why of [notFound, limited]) {
    if (/person|attach/.test(why)) throw new Error(`a mount that has an account was told to attach one: ${why}`);
  }
});

globalThis.fetch = original;
console.log(`\n  github: non-JSON answers and a missing account\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
