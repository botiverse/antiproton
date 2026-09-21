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
import type { PluginError } from "../src/plugins/types.ts";
import { RECOMMENDS_ATTACH, RECOMMENDS_DEPLOY_CONFIG, RECOMMENDS_REWRITE, rejectsItsOwnNegation } from "./identity-wording.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const ctx = (credential: string | null, credentialRefKind?: string) => ({
  caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "gh", credential, credentialRefKind, publicConfig: {},
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

/** The thrown error itself, for what it carries beside its message. */
async function thrown(fn: () => Promise<unknown>): Promise<PluginError> {
  try { await fn(); } catch (e) { return e as PluginError; }
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
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "agent")));
  if (!RECOMMENDS_REWRITE.test(why)) {
    throw new Error(`does not name the action that fixes it: ${why}`);
  }
  if (/attach one|has no account attached/.test(why)) throw new Error(`reported as a mount with no account: ${why}`);
});

await check("the two anonymous states do not produce one message", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const none = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "none")));
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const unreadable = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "agent")));
  if (none === unreadable) throw new Error(`one message for both states: ${none}`);
});

await check("a state the gateway did not report names both, rather than picking one", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null)));
  if (!/either/.test(why)) throw new Error(`picked one of the two states: ${why}`);
});

await check("with an account, a failure says that account was used", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", "agent")));
  if (!/account was used/.test(why)) throw new Error(`the identity behind the call is not in the failure: ${why}`);
  if (/anonymous/.test(why)) throw new Error(`a call that carried a credential was reported as anonymous: ${why}`);
});

await check("a credential GitHub refuses says replace it, not attach another", async () => {
  answer(401, JSON.stringify({ message: "Bad credentials" }), { "content-type": "application/json" });
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", "agent")));
  if (!/replaced/.test(why)) throw new Error(`does not say the credential has to be replaced: ${why}`);
    // Deliberately the WIDE pattern, unlike the positive check below: here the
    // wide end fails noisily (a sentence merely mentioning attaching reddens a
    // correct page, and someone fixes it), while narrowing it would let
    // "attach another account" through unseen.
  if (/attach/.test(why)) throw new Error(`a mount that has an account was told to attach one: ${why}`);
});

await check("a deployment-level credential this deployment lacks sends the deployer, not the mount's owner", async () => {
  // Every `operator:` mount on a preview Worker is in this state today: the
  // reference is right, the deployment does not hold the key. Telling its owner
  // to attach an account sends the wrong person, and there is nothing for them
  // to attach (cody's counter-example, verified by Vera in cf/src/runtime.ts).
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const why = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "operator")));
  if (!RECOMMENDS_DEPLOY_CONFIG.test(why)) {
    throw new Error(`does not say the deployer has to configure it: ${why}`);
  }
  if (!/attaching an account to the mount will not fix it/.test(why)) throw new Error(`does not rule out attaching one: ${why}`);
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const agentRef = await failure(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "agent")));
  if (why === agentRef) throw new Error(`one message for two different people to fix: ${why}`);
});

await check("a write with no account says which of the two states it is in", async () => {
  const named = await failure(() => githubPlugin.invoke("issue_create", { repo: "o/r", title: "t" }, ctx(null, "agent")));
  if (!RECOMMENDS_REWRITE.test(named)) {
    throw new Error(`a mount naming a credential was told to attach one: ${named}`);
  }
  const bare = await failure(() => githubPlugin.invoke("issue_create", { repo: "o/r", title: "t" }, ctx(null, "none")));
  // Matches the RECOMMENDATION, not the word: `/attach/` also accepts "should not
  // attach one", so this assertion used to pass a sentence giving the opposite
  // advice — checked by reversing it (@Rex found the shape, 2026-09-20). A
  // positive assertion has to narrow, because there the wide end fails silently.
  if (!RECOMMENDS_ATTACH.test(bare)) {
    throw new Error(`a mount with no account was not told it can have one: ${bare}`);
  }
  // Neither may claim the mount has no `secret_ref`: only the gateway knows,
  // and it says so through `credentialRefKind`.
  for (const why of [named, bare]) {
    if (/secret_ref/.test(why)) throw new Error(`states something the plugin cannot know: ${why}`);
  }
});

/**
 * The state as a field, not only inside the sentence.
 *
 * The console renders stored events, so badging a failed call from prose means
 * matching a remembered phrase — which is how a correct page got measured as
 * wrong the morning this was written. A reworded sentence must break nothing
 * that a page draws.
 */
await check("a failure carries the identity as a field, for a reader that does not parse prose", async () => {
  for (const [kind, identity] of [["none", "none"], ["agent", "unreadable"], ["operator", "unreadable"]] as Array<[string, string]>) {
    answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
    const e = await thrown(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, kind)));
    if (e.identity !== identity) throw new Error(`${kind} reported identity ${JSON.stringify(e.identity)}`);
    if (e.credentialRef !== kind) throw new Error(`${kind} reported credentialRef ${JSON.stringify(e.credentialRef)}`);
  }
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const used = await thrown(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", "agent")));
  if (used.identity !== "attached") throw new Error(`a call that carried a credential reported ${JSON.stringify(used.identity)}`);
});

await check("a state the gateway did not report is absent as a kind, not guessed", async () => {
  answer(404, JSON.stringify({ message: "Not Found" }), { "content-type": "application/json" });
  const e = await thrown(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null)));
  if (e.identity !== "unreported") throw new Error(`reported identity ${JSON.stringify(e.identity)}`);
  if ("credentialRef" in e) throw new Error(`invented a kind nobody reported: ${JSON.stringify(e.credentialRef)}`);
});

await check("the field and the sentence cannot disagree, because one call sets both", async () => {
  // Both are set at the throw site from the same context. The check that would
  // catch a drift is this: the sentence for the state the field names.
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const e = await thrown(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx(null, "operator")));
  if (e.identity !== "unreadable" || !RECOMMENDS_DEPLOY_CONFIG.test(e.message)) {
    throw new Error(`field says ${e.identity} and the sentence says: ${e.message}`);
  }
});

await check("a write refused for want of an account carries the state too", async () => {
  const e = await thrown(() => githubPlugin.invoke("issue_create", { repo: "o/r", title: "t" }, ctx(null, "none")));
  if (e.identity !== "none") throw new Error(`reported identity ${JSON.stringify(e.identity)}`);
});

/**
 * Which of the two questions a failure answers.
 *
 * One flag was answering both and the consumer read only one of them: this file
 * set `retryable` for a refused quota (nothing happened) and for a 5xx (which
 * may have happened), `appworld.ts` set it for a 5xx with the comment "5xx may
 * have landed", and `raft.ts` set it for an uncertain delivery whose own comment
 * says callers must not retry. A 5xx answers yes to both questions, which is
 * exactly what one boolean could not say (@Vera's count, 2026-09-20).
 */
await check("an exhausted quota says a retry may work, and does not claim anything landed", async () => {
  answer(403, JSON.stringify({ message: "API rate limit exceeded" }), limited);
  const e = await thrown(() => githubPlugin.invoke("repo_view", { repo: "o/r" }, ctx("tok", "agent")));
  if (e.transient !== true) throw new Error(`a resetting quota was not called transient: ${e.transient}`);
  // Absent, not false: false is a claim, and a consumer reading
  // `mayHaveLanded ?? retryable` would read a false as "nothing landed".
  if ("mayHaveLanded" in e) throw new Error(`a refused call claims something about landing: ${e.mayHaveLanded}`);
  if (e.retryable !== true) throw new Error(`the transitional flag moved: ${e.retryable}`);
});

await check("a 5xx answers both questions, because it may have done the thing and may clear", async () => {
  answer(503, JSON.stringify({ message: "Service unavailable" }), { "content-type": "application/json" });
  const e = await thrown(() => githubPlugin.invoke("api", { method: "POST", path: "/repos/o/r/issues", body: {} }, ctx("tok", "agent")));
  if (e.transient !== true || e.mayHaveLanded !== true) {
    throw new Error(`a 5xx answered ${JSON.stringify({ transient: e.transient, mayHaveLanded: e.mayHaveLanded })}`);
  }
  if (e.retryable !== true) throw new Error(`the transitional flag moved: ${e.retryable}`);
});

await check("a plain refusal answers neither, and still records no claim", async () => {
  answer(422, JSON.stringify({ message: "Validation Failed" }), { "content-type": "application/json" });
  const e = await thrown(() => githubPlugin.invoke("api", { method: "POST", path: "/repos/o/r/issues", body: {} }, ctx("tok", "agent")));
  if (e.transient !== false) throw new Error(`a validation failure was called transient: ${e.transient}`);
  if ("mayHaveLanded" in e) throw new Error(`claims something about landing: ${e.mayHaveLanded}`);
  if (e.retryable !== false) throw new Error(`the transitional flag moved: ${e.retryable}`);
});

await check("the patterns that say which advice was given reject the opposite advice", async () => {
  // The mechanical form of the rule, rather than a comment asking the next
  // editor to remember it: widening an alternation for rewording tolerance is
  // the reasonable next edit, and it is what lets a negated modal through.
  const wrong = rejectsItsOwnNegation();
  if (wrong) throw new Error(wrong);
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
