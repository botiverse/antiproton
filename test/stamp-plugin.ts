/**
 * stamp.ts against a fake gateway: the plugin's own behaviour, no live Stamp.
 *
 * The cases a reviewer asks about: the session goes out as a Bearer header and
 * nowhere else; it is kept sealed and rotated before it expires; one rotation is
 * shared by concurrent calls, because a refresh token is single-use; a rotation
 * that cannot be stored fails the call rather than being used; `refresh_reused`
 * is reported as what it is and not retried; a path cannot reach another host;
 * and the container form offers only a placeholder.
 */
import { stampPlugin, SESSION_STORE, parseSession } from "../src/plugins/stamp.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// ---- the fake gateway, and the DB a mount would have -----------------------

type Seen = { method: string; path: string; auth: string | undefined; body: string };
let seen: Seen[] = [];
let refreshes = 0;
let refreshAnswer: () => Response = () => new Response("{}", { status: 500 });
let failNextStore = false;
const replies: Record<string, unknown> = {
  "GET /v1/me": { handle: "eleanor", principalType: "agent", serverName: "raft", commitEmail: "raft+eleanor@agents.stamp.build", gitHTTPSURLTemplate: "https://stamp.build/github/{owner}/{repo}.git" },
  "GET /v1/repositories/o/r/pulls": [{ number: 7, title: "T", state: "open", url: "https://github.com/o/r/pull/7", headSha: "abc" }],
  "GET /v1/repositories/o/r/pulls/7": { number: 7, title: "T", state: "open", body: "why", headSha: "abc", verdict: "NEEDS_REVIEW", stale_url: "x", receipts: [{ id: "z" }] },
  "GET /v1/repositories/o/r/pulls/7/diff": { files: [{ path: "a.ts", additions: 3, deletions: 1, status: "modified", patch: "@@ big @@" }] },
  "GET /v1/receipts/rec_1": { id: "rec_1", status: "published", repository: "o/r", branch: "agent/x", publishedSha: "abc" },
  "GET /v1/me/notifications": { items: [{ id: "n1", kind: "ci", unread: true, title: "CI green", extra: "dropped" }] },
  "GET /v1/inbox/pull-requests": [{ number: 9, title: "Mine" }],
  "POST /v1/pull-requests": { number: 11, url: "https://github.com/o/r/pull/11", state: "open" },
  "POST /v1/repositories/o/r/pulls/7/approve": { approved: true },
  "PUT /v1/repositories/o/r/pulls/7/auto-merge": { registered: true },
  "PUT /v1/repositories/o/r/pulls/7/merge": { merged: true },
  "GET /api/v3/repos/o/r/issues": [{ number: 1, title: "I" }],
};
const statuses: Record<string, number> = { "POST /v1/pull-requests": 201 };

const session = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: "raft-cli-agent-session.v1",
  access_token: "ACCESS-1",
  refresh_token: "REFRESH-1",
  access_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  ...over,
});

globalThis.fetch = (async (input: any, init: any) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname + (url.search || "");
  const key = `${method} ${url.pathname}`;
  seen.push({ method, path, auth: init?.headers?.authorization, body: init?.body ?? "" });
  if (url.pathname === "/api/auth/agent/refresh") {
    refreshes++;
    return refreshAnswer();
  }
  const status = statuses[key] ?? (key in replies ? 200 : 404);
  const body = key in replies ? replies[key] : { errorCode: "NOT_FOUND", message: "no such route" };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as any;

/** A mount's database: one store, in memory, so a test can look at what was kept. */
function makeCtx(credential: string | null = session()) {
  const rows = new Map<string, any>();
  const db = {
    async get(store: string, key: string) { return store === SESSION_STORE ? rows.get(key) ?? null : null; },
    async put(store: string, value: any, key: string) {
      if (failNextStore) { failNextStore = false; throw new Error("write refused by the test"); }
      if (store === SESSION_STORE) rows.set(key, value);
      return key;
    },
    async delete() {}, async getAll() { return []; }, async getAllFromIndex() { return []; },
    async count() { return 0; }, async transaction(_s: any, _m: any, fn: any) { return fn(db); },
  };
  return {
    rows,
    ctx: { credential, alias: "stamp", publicConfig: {}, caller: { tenantId: "t", agentId: "a" }, db } as any,
  };
}

const invoke = (tool: string, args: any, ctx: any) => stampPlugin.invoke(tool, args, ctx) as Promise<any>;
const reset = () => { seen = []; refreshes = 0; };

// ---- the cases --------------------------------------------------------------

await check("the session goes out as a Bearer header, and only there", async () => {
  reset();
  const { ctx } = makeCtx();
  await invoke("whoami", {}, ctx);
  must(seen.length === 1, `requests: ${seen.length}`);
  must(seen[0].path === "/v1/me", `path: ${seen[0].path}`);
  must(seen[0].auth === "Bearer ACCESS-1", `auth header: ${seen[0].auth}`);
  must(!JSON.stringify(seen[0].body).includes("REFRESH-1"), "the refresh token reached a request body");
});

await check("whoami reports the git template, so a caller can tell whether push is possible", async () => {
  const me = await invoke("whoami", {}, makeCtx().ctx);
  must(me.handle === "eleanor" && me.commitEmail === "raft+eleanor@agents.stamp.build", JSON.stringify(me));
  must(me.gitHTTPSURLTemplate === "https://stamp.build/github/{owner}/{repo}.git", "no template");
});

await check("a pull request is projected, not forwarded whole", async () => {
  const pr = await invoke("pr_view", { repo: "o/r", number: 7 }, makeCtx().ctx);
  must(pr.body === "why" && pr.verdict === "NEEDS_REVIEW" && pr.headSha === "abc", JSON.stringify(pr));
  must(pr.stale_url === undefined && pr.receipts === undefined, `unprojected fields survived: ${Object.keys(pr)}`);
});

await check("diff omits patch text unless asked", async () => {
  const thin = await invoke("pr_diff", { repo: "o/r", number: 7 }, makeCtx().ctx);
  must(thin[0].patch === undefined && thin[0].additions === 3, JSON.stringify(thin));
  const full = await invoke("pr_diff", { repo: "o/r", number: 7, patch: true }, makeCtx().ctx);
  must(full[0].patch === "@@ big @@", JSON.stringify(full));
});

await check("a repo that is not owner/name is refused before any request", async () => {
  reset();
  let threw = "";
  try { await invoke("pr_view", { repo: "../../user", number: 1 }, makeCtx().ctx); } catch (e) { threw = String((e as Error).message); }
  must(threw.includes('must be "owner/name"'), `message: ${threw}`);
  must(seen.length === 0, "a request was made anyway");
});

await check("api cannot be pointed at another host", async () => {
  const { ctx } = makeCtx();
  for (const path of ["https://evil.example/x", "//evil.example/x", "/v2/repositories", "repos/o/r"]) {
    let threw = "";
    try { await invoke("api_get", { path }, ctx); } catch (e) { threw = String((e as Error).message); }
    must(threw.includes("path must start with"), `${path} was not refused: ${threw}`);
  }
  reset();
  await invoke("api_get", { path: "/api/v3/repos/o/r/issues" }, ctx);
  must(seen[0].path === "/api/v3/repos/o/r/issues", `forwarded: ${seen[0].path}`);
});

await check("pr_create sends the receipt, base and title, and keeps the idempotency key", async () => {
  reset();
  const pr = await invoke("pr_create", { receipt: "rec_1", base: "main", title: "T", body: "why", idempotencyKey: "k1" }, makeCtx().ctx);
  const sent = JSON.parse(seen[0].body);
  must(seen[0].method === "POST" && seen[0].path === "/v1/pull-requests", `${seen[0].method} ${seen[0].path}`);
  must(sent.receiptId === "rec_1" && sent.baseRef === "main" && sent.title === "T" && sent.body === "why" && sent.idempotencyKey === "k1",
    `body: ${JSON.stringify(sent)}`);
  must(pr.number === 11 && pr.opened === true, JSON.stringify(pr));
});

await check("an approval names the exact head and base it is about", async () => {
  reset();
  await invoke("pr_approve", { repo: "o/r", number: 7, head: "H", base: "B", note: "looks right" }, makeCtx().ctx);
  must(seen[0].method === "POST" && seen[0].path === "/v1/repositories/o/r/pulls/7/approve", `${seen[0].method} ${seen[0].path}`);
  const sent = JSON.parse(seen[0].body);
  must(sent.expectedHead === "H" && sent.expectedBase === "B" && sent.body === "looks right", JSON.stringify(sent));
});

await check("merge defaults to auto-merge, which returns instead of waiting", async () => {
  reset();
  await invoke("pr_merge", { repo: "o/r", number: 7, head: "H", base: "B" }, makeCtx().ctx);
  must(seen[0].method === "PUT" && seen[0].path === "/v1/repositories/o/r/pulls/7/auto-merge", `${seen[0].method} ${seen[0].path}`);
  reset();
  await invoke("pr_merge", { repo: "o/r", number: 7, head: "H", base: "B", auto: false, method: "squash" }, makeCtx().ctx);
  const direct: string = seen[0].path;
  must(direct === "/v1/repositories/o/r/pulls/7/merge", direct);
  must(JSON.parse(seen[0].body).mergeMethod === "squash", seen[0].body);
});

await check("a refusal carries the gateway's own code", async () => {
  let threw = "";
  try { await invoke("receipt_get", { id: "nope" }, makeCtx().ctx); } catch (e) { threw = String((e as Error).message); }
  must(threw.includes("NOT_FOUND") && threw.includes("404"), `message: ${threw}`);
});

await check("no session is a sentence, not a crash", async () => {
  const { ctx } = makeCtx(null);
  let thrown: (Error & { identity?: string }) | null = null;
  try { await invoke("whoami", {}, ctx); } catch (e) { thrown = e as Error & { identity?: string }; }
  must(thrown !== null && thrown.identity === "unreported", `identity: ${thrown?.identity}`);
  must(thrown.message.includes("access_token and refresh_token"), `says what to attach: ${thrown.message}`);
  const checked = await stampPlugin.checkCredential!(ctx) as any;
  must(checked.ok === false && checked.kind === "rejected", JSON.stringify(checked));
});

await check("a credential that is not a session is refused by name", async () => {
  const checked = await stampPlugin.checkCredential!(makeCtx("ghp_notasession").ctx) as any;
  must(checked.ok === false && /refresh_token/.test(checked.reason), JSON.stringify(checked));
  must(parseSession("ghp_notasession") === null, "a bare string parsed as a session");
  must(parseSession(session())?.refresh_token === "REFRESH-1", "a real session did not parse");
});

await check("the container form offers the session as a placeholder, at index 0", async () => {
  const form = stampPlugin.sandboxForm!;
  must(form.egress.length === 1 && form.egress[0].name === "STAMP_SESSION", JSON.stringify(form.egress));
  const reg = form.egress[0];
  must(reg.header === "authorization", reg.header);
  must(reg.hosts.length === 1 && reg.hosts[0] === "stamp.build", JSON.stringify(reg.hosts));
  must(reg.value("REAL-SESSION") === "Bearer REAL-SESSION", reg.value("REAL-SESSION"));
  must(reg.placeholder("__AP__") === "Bearer __AP__", reg.placeholder("__AP__"));
  const env = form.env("__AP__");
  must(env.GIT_CONFIG_KEY_0 === "http.https://stamp.build/.extraHeader", env.GIT_CONFIG_KEY_0);
  must(env.GIT_CONFIG_VALUE_0 === "Authorization: Bearer __AP__", env.GIT_CONFIG_VALUE_0);
  must(!JSON.stringify(env).includes("REAL-SESSION"), "the real session reached the container's env");
});

await check("tools declare what the gateway needs to gate them", async () => {
  const byName = new Map(stampPlugin.tools.map((x) => [x.name, x]));
  for (const read of ["whoami", "receipt_get", "receipt_list", "pr_list", "pr_view", "pr_diff", "pr_checks", "issue_list", "inbox", "api_get"]) {
    must(byName.get(read)?.sideEffects === "read", `${read} is not a read`);
  }
  for (const write of ["pr_create", "pr_comment", "pr_approve", "pr_unapprove", "pr_merge", "issue_create", "issue_comment", "api"]) {
    must(byName.get(write)?.sideEffects === "write", `${write} is not a write`);
  }
  must(byName.get("pr_create")?.idempotency === "key", "pr_create lost its idempotency key");
  // A name the provider would reject breaks every tool in the request, not just this one.
  for (const x of stampPlugin.tools) must(/^[a-zA-Z0-9_-]+$/.test(x.name), `bad tool name: ${x.name}`);
});

// ---- the session: kept sealed, rotated, shared, never used unstored ---------

await check("the rotated session is kept sealed, not as plaintext", async () => {
  reset();
  const { ctx, rows } = makeCtx(session({ access_expires_at: new Date(Date.now() - 1000).toISOString() }));
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: "ACCESS-2", refresh_token: "REFRESH-2",
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  await invoke("whoami", {}, ctx);
  must(refreshes === 1, `refreshes: ${refreshes}`);
  must(seen.at(-1)?.auth === "Bearer ACCESS-2", `sent: ${seen.at(-1)?.auth}`);
  const row: any = [...rows.values()][0];
  must(row && typeof row.ciphertext === "string" && typeof row.iv === "string", `row: ${JSON.stringify(row)}`);
  must(!JSON.stringify(row).includes("ACCESS-2") && !JSON.stringify(row).includes("REFRESH-2"), "the session was stored in the clear");
});

await check("an access token that is still good is not refreshed", async () => {
  reset();
  const { ctx } = makeCtx();
  await invoke("whoami", {}, ctx);
  must(refreshes === 0, `refreshes: ${refreshes}`);
});

await check("concurrent calls share one rotation, because a refresh token is single-use", async () => {
  reset();
  const { ctx } = makeCtx(session({ access_expires_at: new Date(Date.now() - 1000).toISOString() }));
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: "ACCESS-3", refresh_token: "REFRESH-3",
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  await Promise.all([invoke("whoami", {}, ctx), invoke("whoami", {}, ctx), invoke("whoami", {}, ctx)]);
  must(refreshes === 1, `refreshes: ${refreshes} (three calls must share one)`);
});

await check("a rotation that cannot be stored fails the call and is not used", async () => {
  reset();
  const { ctx, rows } = makeCtx(session({ access_expires_at: new Date(Date.now() - 1000).toISOString() }));
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: "ACCESS-4", refresh_token: "REFRESH-4",
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  failNextStore = true;
  let threw = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { threw = String((e as Error).message); }
  must(threw.includes("write refused by the test"), `message: ${threw}`);
  must(rows.size === 0, "a session was kept anyway");
  must(!seen.some((s) => s.auth === "Bearer ACCESS-4"), "the unkeepable session was used");
});

await check("refresh_reused is reported as a person's job, and not retried", async () => {
  reset();
  const { ctx } = makeCtx(session({ access_expires_at: new Date(Date.now() - 1000).toISOString() }));
  refreshAnswer = () => new Response(JSON.stringify({ error: "refresh_reused" }), { status: 401, headers: { "content-type": "application/json" } });
  let threw = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { threw = String((e as Error).message); }
  must(/already used elsewhere|revoked/.test(threw) && threw.includes("refresh_reused"), `message: ${threw}`);
  must(threw.includes("do not retry"), `message: ${threw}`);
  must(refreshes === 1, `refreshes: ${refreshes} (must not retry)`);
});

await check("a 401 rotates once and retries once, with the new token", async () => {
  reset();
  const { ctx, rows } = makeCtx();
  // First call is refused with 401 although the access token was not due; the
  // rotation answers, and the retry carries the new token.
  let first = true;
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).endsWith("/v1/me") && first) {
      first = false;
      seen.push({ method: "GET", path: "/v1/me", auth: init?.headers?.authorization, body: "" });
      return new Response(JSON.stringify({ errorCode: "SESSION_REQUIRED" }), { status: 401 });
    }
    return inner(input, init);
  }) as any;
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: "ACCESS-5", refresh_token: "REFRESH-5",
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  const me = await invoke("whoami", {}, ctx);
  globalThis.fetch = inner;
  must(me.handle === "eleanor", JSON.stringify(me));
  must(refreshes === 1, `refreshes: ${refreshes}`);
  must(seen.at(-1)?.auth === "Bearer ACCESS-5", `retry sent: ${seen.at(-1)?.auth}`);
  must(rows.size === 1, "the rotated session was not kept");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
