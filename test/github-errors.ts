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

const ctx = (credential: string | null, credentialNamed?: boolean) => ({
  caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "gh", credential, credentialNamed, publicConfig: {},
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

/**
 * Which identity a failure was made with, said on the failure itself.
 *
 * Two mounts answer a 403 identically — one with no account, one naming an
 * account whose credential cannot be read — and the actions they want are
 * opposite: attach an account, versus write the credential of the account
 * already attached. The plugin used to state the first as a fact ("this mount
 * has no secret_ref"), which is false for the second and sends the person to
 * attach a token to a mount that already has one.
 *
 * The other half is a credential that did arrive: without it a failure carries
 * no record of the identity behind it, and reconstructing that later meant
 * reading the source of the build that produced the message — three builds, in
 * the reading that prompted this (Vera and cody, 2026-09-20).
 */
const limited = { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1789500000" };

await check("a credential that cannot be read is not reported as a missing account", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, true)));
  if (!/written again/.test(why)) throw new Error(`does not name the action that fixes it: ${why}`);
  if (/attach one|has no account attached/.test(why)) throw new Error(`reported as a mount with no account: ${why}`);
});

await check("the two anonymous states do not produce one message", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const none = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, false)));
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const unreadable = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, true)));
  if (none === unreadable) throw new Error(`one message for both states: ${none}`);
});

await check("a state the gateway did not report names both, rather than picking one", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null)));
  if (!/either/.test(why)) throw new Error(`picked one of the two states: ${why}`);
});

await check("with an account, a failure says that account was used", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", true)));
  if (!/account was used/.test(why)) throw new Error(`the identity behind the call is not in the failure: ${why}`);
  if (/anonymous/.test(why)) throw new Error(`a call that carried a credential was reported as anonymous: ${why}`);
});

await check("a credential GitHub refuses says replace it, not attach another", async () => {
  answer(401, JSON.stringify({ message: "Bad credentials" }), { "content-type": "application/json" });
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", true)));
  if (!/replaced/.test(why)) throw new Error(`does not say the credential has to be replaced: ${why}`);
  if (/attach/.test(why)) throw new Error(`a mount that has an account was told to attach one: ${why}`);
});

await check("a write with no account says which of the two states it is in", async () => {
  const named = await failure(() => githubPlugin.invoke("issue_create", { repo: "o/r", title: "t" }, ctx(null, true)));
  if (!/written again/.test(named)) throw new Error(`a mount naming a credential was told to attach one: ${named}`);
  const bare = await failure(() => githubPlugin.invoke("issue_create", { repo: "o/r", title: "t" }, ctx(null, false)));
  if (!/attach/.test(bare)) throw new Error(`a mount with no account was not told to attach one: ${bare}`);
  // Neither may claim the mount has no `secret_ref`: only the gateway knows,
  // and it says so through `credentialNamed`.
  for (const why of [named, bare]) {
    if (/secret_ref/.test(why)) throw new Error(`states something the plugin cannot know: ${why}`);
  }
});

/**
 * A job's logs are a redirect to signed storage, and storage refuses our token.
 *
 * Measured on real GitHub (2026-09-15): /actions/jobs/{id}/logs answers 302 to
 * *.blob.core.windows.net, which returns the log with no headers and 401
 * InvalidAuthenticationInfo when GitHub's Authorization is sent along. Node's
 * fetch drops that header on a cross-origin redirect; whether a Worker's does
 * was not measured, so the plugin follows the redirect itself instead of
 * relying on either.
 */
function hops(...answers: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  const seen: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
  let i = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    const h = new Headers(init?.headers ?? {});
    seen.push({ url: String(url), auth: h.get("authorization"), redirect: init?.redirect });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return new Response(a.body ?? "", { status: a.status, headers: a.headers ?? {} });
  }) as any;
  return seen;
}

await check("a redirect to storage is followed without our token, and the log comes back", async () => {
  const seen = hops(
    { status: 302, headers: { location: "https://results.blob.example/logs/1.txt?sig=abc" } },
    { status: 200, body: "step 1\nstep 2\n", headers: { "content-type": "text/plain" } },
  );
  const r = await githubPlugin.invoke("api_get", { path: "/repos/o/r/actions/jobs/1/logs" }, ctx("tok")) as any;
  if (seen.length !== 2) throw new Error(`the redirect was not followed by the plugin: ${JSON.stringify(seen)}`);
  // Every request says manual: a fetch left to follow redirects itself is the
  // runtime dependency this removes, and the fake would not notice (cody).
  if (seen.some((x) => x.redirect !== "manual")) throw new Error(`a request left redirects to fetch: ${JSON.stringify(seen)}`);
  if (seen[1]!.auth !== null) throw new Error("the token was sent to the storage host");
  if (!String(r?.text).includes("step 2")) throw new Error(`got ${JSON.stringify(r)}`);
});

await check("a redirect within GitHub's API keeps the token", async () => {
  const seen = hops(
    { status: 301, headers: { location: "https://api.github.com/repositories/42" } },
    { status: 200, body: JSON.stringify({ full_name: "o/renamed" }), headers: { "content-type": "application/json" } },
  );
  await githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok"));
  if (seen.length !== 2 || seen[1]!.auth !== "Bearer tok") throw new Error(`same-origin hop: ${JSON.stringify(seen)}`);
  if (seen.some((x) => x.redirect !== "manual")) throw new Error(`a request left redirects to fetch: ${JSON.stringify(seen)}`);
});

await check("a 303 within the API is followed as a GET without the body", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  let i = 0;
  globalThis.fetch = (async (_url: any, init?: any) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body });
    return i++ === 0
      ? new Response("", { status: 303, headers: { location: "https://api.github.com/repos/o/r/issues/7" } })
      : new Response(JSON.stringify({ number: 7 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  await githubPlugin.invoke("api", { method: "POST", path: "/repos/o/r/issues", body: { title: "t" } }, ctx("tok"));
  if (calls.length !== 2 || calls[1]!.method !== "GET" || calls[1]!.body !== undefined) {
    throw new Error(`the 303 hop was ${JSON.stringify(calls[1])}`);
  }
});

await check("an error from the storage host names that host, not GitHub", async () => {
  hops(
    { status: 302, headers: { location: "https://results.blob.example/logs/1.txt?sig=abc" } },
    { status: 404, body: "<Error><Message>The specified blob does not exist.</Message></Error>", headers: { "content-type": "application/xml" } },
  );
  const why = await failure(() => githubPlugin.invoke("api_get", { path: "/repos/o/r/actions/jobs/1/logs" }, ctx("tok")));
  if (!/results\.blob\.example/.test(why) || /sig=/.test(why)) throw new Error(`said: ${why}`);
});

globalThis.fetch = original;
console.log(`\n  github: non-JSON answers and a missing account\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
