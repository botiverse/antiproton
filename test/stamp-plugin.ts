/**
 * stamp.ts against a fake gateway: the plugin's own behaviour, no live Stamp.
 *
 * The cases a reviewer asks about: the session goes out as a Bearer header and
 * nowhere else; it is kept sealed and rotated before it expires; one rotation is
 * shared by concurrent calls, because a refresh token is single-use; a rotation
 * that cannot be stored fails the call rather than being used; `refresh_reused`
 * is reported as what it is and not retried; a path cannot reach another host
 * or climb out of the API; there is no container form; a kept session is never
 * replaced by the spent credential; and approving, merging and `api` wait for a
 * person on a mount that sets no policy (#1051).
 */
import { stampPlugin, SESSION_STORE, parseSession, loadSession } from "../src/plugins/stamp.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";

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
/** Refresh tokens the fake gateway has rotated: presenting one again is `refresh_reused`, as on Stamp. */
let spentRefresh = new Set<string>();
let refreshAnswer: () => Response = () => new Response("{}", { status: 500 });
let failNextStore = false;
/** Fail the first session write after the gateway has been asked to rotate: the write that keeps the rotation. */
let failStoreAfterRefresh = false;
/** Keep the next session write and then report it failed: a write whose answer is lost after it landed. */
let failNextStoreLate = false;
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
  "POST /v1/repositories/o/r/pulls/7/comments": { id: "c1" },
  "DELETE /v1/repositories/o/r/pulls/7/queue/req_1": { left: true },
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
    const presented = String(JSON.parse(init?.body ?? "{}").refresh_token);
    if (spentRefresh.has(presented)) {
      return new Response(JSON.stringify({ error: "refresh_reused" }), { status: 409, headers: { "content-type": "application/json" } });
    }
    const answer = refreshAnswer();
    if (answer.ok) spentRefresh.add(presented);
    return answer;
  }
  // As Stamp answers an agent: an approval carries no body.
  if (key.endsWith("/approve") && method === "POST" && JSON.parse(init?.body ?? "{}").body !== undefined) {
    return new Response(JSON.stringify({ errorCode: "PR_APPROVE_BODY_NOT_SUPPORTED", message: "use stamp pr comment" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const status = statuses[key] ?? (key in replies ? 200 : 404);
  const body = key in replies ? replies[key] : { errorCode: "NOT_FOUND", message: "no such route" };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as any;

/** An agent-level database (`ctx.agentDb`): what every mount of one agent shares, and what outlives a mount. */
function makeAgentDb() {
  const rows = new Map<string, any>();
  return {
    rows,
    async get(store: string, key: string) { return rows.get(`${store}\u0000${key}`) ?? null; },
    async put(store: string, value: any, key: string) { rows.set(`${store}\u0000${key}`, value); return key; },
    async delete(store: string, key: string) { rows.delete(`${store}\u0000${key}`); }, async getAll() { return []; }, async getAllFromIndex() { return []; },
    async count() { return 0; }, async transaction(_s: any, _m: any, fn: any) { return fn(this); },
  };
}

/** A mount's database: one store, in memory, so a test can look at what was kept. */
function makeCtx(credential: string | null = session(), agentDb: ReturnType<typeof makeAgentDb> | null = makeAgentDb(), alias = "stamp") {
  const rows = new Map<string, any>();
  const db = {
    async get(store: string, key: string) { return store === SESSION_STORE ? rows.get(key) ?? null : null; },
    async put(store: string, value: any, key: string) {
      if (failNextStore) { failNextStore = false; throw new Error("write refused by the test"); }
      if (failStoreAfterRefresh && refreshes > 0) { failStoreAfterRefresh = false; throw new Error("write refused by the test"); }
      if (store === SESSION_STORE) rows.set(key, value);
      if (failNextStoreLate) { failNextStoreLate = false; throw new Error("write reported failed after it landed"); }
      return key;
    },
    async delete() {}, async getAll() { return []; }, async getAllFromIndex() { return []; },
    async count() { return 0; }, async transaction(_s: any, _m: any, fn: any) { return fn(db); },
  };
  return {
    rows,
    agentDb,
    ctx: { credential, alias, publicConfig: {}, caller: { tenantId: "t", agentId: "a" }, db, ...(agentDb ? { agentDb } : {}),
      // This mount as `sibling` reports it, with no policy of its own.
      async sibling(name: string) { return name === alias ? { credential, db, plugin: "stamp", policy: null } : null; } } as any,
  };
}

const invoke = (tool: string, args: any, ctx: any) => stampPlugin.invoke(tool, args, ctx) as Promise<any>;
const reset = () => { seen = []; refreshes = 0; spentRefresh = new Set(); };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const expired = () => session({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
const rotatesTo = (n: number) => () => new Response(JSON.stringify({
  schema: "raft-cli-agent-session.v1", access_token: `ACCESS-${n}`, refresh_token: `REFRESH-${n}`,
  access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
}), { status: 200, headers: { "content-type": "application/json" } });
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as Error).message); }
  return "";
}

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

await check("an approval names the exact head and base it is about, and its note follows as a comment", async () => {
  reset();
  const r: any = await invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE, note: "looks right" }, makeCtx().ctx);
  must(seen[0].method === "POST" && seen[0].path === "/v1/repositories/o/r/pulls/7/approve", `${seen[0].method} ${seen[0].path}`);
  const sent = JSON.parse(seen[0].body);
  must(sent.expectedHead === HEAD && sent.expectedBase === BASE && sent.body === undefined, JSON.stringify(sent));
  must(seen[1]?.path === "/v1/repositories/o/r/pulls/7/comments" && JSON.parse(seen[1].body).body === "looks right", JSON.stringify(seen[1]));
  must(r.approval?.approved === true && r.comment?.id === "c1", JSON.stringify(r));
});

await check("an approval answers in one shape, with or without a note", async () => {
  reset();
  const bare: any = await invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE }, makeCtx().ctx);
  must(bare.approval?.approved === true && Object.keys(bare).join() === "approval", JSON.stringify(bare));
  must(seen.length === 1, `a bare approval sent ${seen.length} requests`);
});

await check("an approval whose note cannot be posted still stands, and says so", async () => {
  reset();
  const { ctx } = makeCtx();
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async (input: any, init: any) => String(input).endsWith("/comments")
    ? new Response(JSON.stringify({ errorCode: "INTERNAL" }), { status: 500, headers: { "content-type": "application/json" } })
    : inner(input, init)) as any;
  try {
    const r: any = await invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE, note: "why" }, ctx);
    must(r.approval?.approved === true && /approval stands/.test(r.commentError ?? ""), JSON.stringify(r));
  } finally { globalThis.fetch = inner; }
});

await check("merge defaults to auto-merge, which returns instead of waiting", async () => {
  reset();
  await invoke("pr_merge", { repo: "o/r", number: 7, head: HEAD, base: BASE }, makeCtx().ctx);
  must(seen[0].method === "PUT" && seen[0].path === "/v1/repositories/o/r/pulls/7/auto-merge", `${seen[0].method} ${seen[0].path}`);
  reset();
  await invoke("pr_merge", { repo: "o/r", number: 7, head: HEAD, base: BASE, auto: false, method: "squash" }, makeCtx().ctx);
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

// #1051 finding 1. The form handed the egress proxy the mount's credential, which
// is the whole session JSON: `Bearer {"access_token":…,"refresh_token":…}`.
// The old case only checked `value("REAL-SESSION")`, so it passed on that.
await check("there is no container form: it would carry the refresh token, and a credential that never rotates", async () => {
  must(stampPlugin.sandboxForm === undefined, "stamp declares a sandboxForm again");
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
  // Sealed first, and the write refused is the one that keeps the rotation.
  await loadSession(ctx);
  failStoreAfterRefresh = true;
  let threw = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { threw = String((e as Error).message); }
  must(refreshes === 1, `refreshes: ${refreshes}`);
  must(threw.includes("write refused by the test") && /sign in again/.test(threw), `message: ${threw}`);
  // The row is still the one marked before the refresh went out: not the rotation, and not usable.
  must(rows.get("session")?.rotating !== undefined, "the row was not left marked");
  must(/sign in again/.test(await refusal(loadSession(ctx))), "the marked row opened as usable");
  must(!seen.some((s) => s.auth === "Bearer ACCESS-4"), "the unkeepable session was used");
});

await check("refresh_reused is reported as a person's job, and not retried", async () => {
  reset();
  const { ctx } = makeCtx(session({ access_expires_at: new Date(Date.now() - 1000).toISOString() }));
  refreshAnswer = () => new Response(JSON.stringify({ error: "refresh_reused" }), { status: 409, headers: { "content-type": "application/json" } });
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

// ---- #1051: the spent credential is never sent again --------------------------

// Finding 2. After the first rotation the credential's refresh token is spent,
// and sending it again is `refresh_reused`: every token the agent holds, revoked.

await check("the credential is sealed on first use, and read from the row after that", async () => {
  reset();
  const { ctx, rows } = makeCtx();
  await invoke("whoami", {}, ctx);
  must(rows.size === 1, `rows after first use: ${rows.size}`);
  const row: any = rows.get("session");
  must(typeof row?.ciphertext === "string" && !JSON.stringify(row).includes("REFRESH-1"), `row: ${JSON.stringify(row)}`);
  // The mount still holds the original credential; what is sent comes from the row.
  const rotated = makeCtx(expired());
  refreshAnswer = rotatesTo(20);
  await invoke("whoami", {}, rotated.ctx);
  reset();
  await invoke("whoami", {}, rotated.ctx);
  must(refreshes === 0 && seen[0].auth === "Bearer ACCESS-20", `after rotation: refreshes=${refreshes}, sent ${seen[0]?.auth}`);
});

await check("a renamed mount still opens its session, rather than refreshing with the spent credential", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(21);
  await invoke("whoami", {}, ctx);
  must(refreshes === 1, `refreshes: ${refreshes}`);
  // `renameMount` moves the database with the alias; the credential is the same.
  const renamed = { ...ctx, alias: "stamp-renamed" };
  seen = [];
  const threw = await refusal(invoke("whoami", {}, renamed));
  must(threw === "", `the renamed mount failed: ${threw}`);
  must(refreshes === 1, `the renamed mount refreshed again (${refreshes}), with a spent token`);
  must(seen.at(-1)?.auth === "Bearer ACCESS-21", `sent: ${seen.at(-1)?.auth}`);
});

await check("a kept session that does not open is a sign-in, never the spent credential", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired());
  refreshAnswer = rotatesTo(22);
  await invoke("whoami", {}, ctx);
  const row: any = rows.get("session");
  rows.set("session", { ...row, ciphertext: row.ciphertext.slice(4) + "AAAA" });
  seen = [];
  // The same session with an access token not yet due, so a fallback would send it at once rather than refresh first.
  const threw = await refusal(invoke("whoami", {}, { ...ctx, credential: session() }));
  must(threw.includes("sign-in again"), `message: ${threw}`);
  must(refreshes === 1 && seen.length === 0, `sent anyway: refreshes=${refreshes}, requests=${seen.length}`);
});

await check("a database read that fails is an error, never the spent credential", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(23);
  await invoke("whoami", {}, ctx);
  const broken = { ...ctx, db: { ...ctx.db, async get() { throw new Error("storage hiccup"); } } };
  seen = [];
  const threw = await refusal(invoke("whoami", {}, broken));
  must(threw.includes("could not read this mount's session") && threw.includes("storage hiccup"), `message: ${threw}`);
  must(refreshes === 1 && seen.length === 0, `sent anyway: refreshes=${refreshes}, requests=${seen.length}`);
});

await check("checking a candidate credential neither refreshes it nor overwrites the live session", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired());
  refreshAnswer = rotatesTo(24);
  await invoke("whoami", {}, ctx);
  const live = JSON.stringify(rows.get("session"));
  // What `checkMount` does with a value a person is pasting: the mount's context, another credential.
  refreshAnswer = rotatesTo(25);
  const candidate = { ...ctx, credential: session({ access_token: "ACCESS-C", refresh_token: "REFRESH-C",
    access_expires_at: new Date(Date.now() - 1000).toISOString() }) };
  const checked: any = await stampPlugin.checkCredential!(candidate);
  must(checked.ok === false && checked.kind === "unreachable", `expired candidate: ${JSON.stringify(checked)}`);
  must(refreshes === 1, `the check refreshed the candidate (${refreshes})`);
  must(JSON.stringify(rows.get("session")) === live, "the check overwrote the live session");
  seen = [];
  await invoke("whoami", {}, ctx);
  must(refreshes === 1 && seen.at(-1)?.auth === "Bearer ACCESS-24", `live mount after the check: refreshes=${refreshes}, sent ${seen.at(-1)?.auth}`);
  // A fresh candidate is checked with its own access token, and still writes nothing.
  seen = [];
  const fresh: any = await stampPlugin.checkCredential!({ ...ctx, credential: session({ access_token: "ACCESS-D", refresh_token: "REFRESH-D" }) });
  must(fresh.ok === true && fresh.account === "@eleanor", JSON.stringify(fresh));
  must(seen.length === 1 && seen[0].auth === "Bearer ACCESS-D", `check sent: ${JSON.stringify(seen)}`);
  must(JSON.stringify(rows.get("session")) === live, "a passing check overwrote the live session");
});

await check("a credential a person replaced is used, and the spent one is refused by name", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(26);
  await invoke("whoami", {}, ctx);
  // The positive control for the refusals above: a new session is not a lost one.
  seen = [];
  const replaced = { ...ctx, credential: session({ access_token: "ACCESS-N", refresh_token: "REFRESH-N" }) };
  await invoke("whoami", {}, replaced);
  must(seen.at(-1)?.auth === "Bearer ACCESS-N", `sent: ${seen.at(-1)?.auth}`);
  // And the spent one pasted back is not new: same refresh token, so the row it cannot open is its own.
  const back = await stampPlugin.checkCredential!({ ...ctx, credential: expired() }) as any;
  must(back.ok === false && back.kind === "rejected" && /sign-in again/.test(back.reason), JSON.stringify(back));
});

// Finding 3. B reads S1; A rotates S1 to S2 and finishes; B then rotates S1.

await check("a call that read the session before another rotated it uses the newer one, not the spent token", async () => {
  reset();
  const { ctx: a } = makeCtx(expired());
  refreshAnswer = rotatesTo(27);
  await loadSession(a);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let held = true;
  const b = { ...a, db: { ...a.db, async get(store: string, key: string) {
    const v = await a.db.get(store, key);
    if (held) { held = false; await gate; }
    return v;
  } } };
  const late = invoke("whoami", {}, b);
  await invoke("whoami", {}, a);
  must(refreshes === 1, `refreshes after A: ${refreshes}`);
  open();
  const threw = await refusal(late);
  must(threw === "", `B failed: ${threw}`);
  must(refreshes === 1, `B rotated again (${refreshes}): a spent refresh token was sent`);
  must(seen.at(-1)?.auth === "Bearer ACCESS-27", `B sent: ${seen.at(-1)?.auth}`);
});

// Finding 4. `new URL` resolves dot segments, `%2e` included.

await check("api cannot climb out of /v1/ or /api/v3/ to /api/auth", async () => {
  const { ctx } = makeCtx();
  const climbs = [
    "/v1/../api/auth/agent/refresh",
    "/v1/%2e%2e/api/auth/agent/refresh",
    "/v1/%2E%2E/api/auth/agent/refresh",
    "/v1/.%2e/api/auth/agent/refresh",
    "/v1/%252e%252e/api/auth/agent/refresh",
    "/v1/..\\api\\auth\\agent\\refresh",
    "/api/v3/../../api/auth/agent/refresh",
    "/api/v3/%2e%2e/%2E%2E/api/auth/agent/refresh",
    "/api/v3/repos/..%2f..%2f..%2fapi/auth/agent/refresh",
    "/api/v3/%25252e%25252e/api/auth/agent/refresh",
    // `URL` drops tabs and newlines before it resolves, so these are dot segments only once parsed.
    "/v1/\t../api/auth/agent/refresh",
    "/v1/.\n./api/auth/agent/refresh",
  ];
  for (const path of climbs) {
    reset();
    for (const [tool, args] of [["api_get", { path }], ["api", { path, method: "POST", body: {} }]] as const) {
      const threw = await refusal(invoke(tool, args, ctx));
      must(/path must|carries no escapes/.test(threw), `${tool} ${path} was not refused: ${threw}`);
    }
    must(seen.length === 0, `${path} reached ${seen.map((x) => x.path).join(", ")}`);
  }
  reset();
  await invoke("api_get", { path: "/v1/repositories/o/r/pulls" }, ctx);
  await invoke("api_get", { path: "/api/v3/repos/o/r/issues" }, ctx).catch(() => {});
  must(seen[0]?.path === "/v1/repositories/o/r/pulls" && seen[1]?.path === "/api/v3/repos/o/r/issues", `forwarded: ${seen.map((x) => x.path)}`);
  reset();
  await invoke("api_get", { path: "/api/v3/repos/o/r/labels/good%20first%20issue" }, ctx).catch(() => {});
  const label: string | undefined = seen[0]?.path;
  must(label === "/api/v3/repos/o/r/labels/good%20first%20issue", `an escaped label: ${label}`);
});

await check("a repo of dot segments is refused before any request", async () => {
  for (const repo of ["../..", "o/..", "./r", "../r", "o/."]) {
    reset();
    const threw = await refusal(invoke("pr_view", { repo, number: 1 }, makeCtx().ctx));
    must(threw.includes('must be "owner/name"'), `${repo}: ${threw}`);
    must(seen.length === 0, `${repo} reached ${seen.map((x) => x.path)}`);
  }
});

// Finding 5. A missing head was sent as "undefined"; an issue number was not checked.

await check("approve, unapprove and merge need both full SHAs, and never send \"undefined\"", async () => {
  const cases: Array<Record<string, unknown>> = [
    { base: BASE }, { head: HEAD }, { head: "H", base: BASE }, { head: HEAD, base: "main" }, { head: HEAD.slice(1), base: BASE },
  ];
  for (const tool of ["pr_approve", "pr_unapprove", "pr_merge"]) {
    for (const c of cases) {
      reset();
      const threw = await refusal(invoke(tool, { repo: "o/r", number: 7, ...c }, makeCtx().ctx));
      must(/(head|base) must be the full 40-character commit SHA/.test(threw), `${tool} ${JSON.stringify(c)}: ${threw}`);
      must(seen.length === 0, `${tool} ${JSON.stringify(c)} sent ${seen.map((x) => x.body)}`);
    }
  }
});

await check("issue_comment needs an issue number", async () => {
  for (const number of [undefined, "abc", 0, -1, 1.5, true]) {
    reset();
    const threw = await refusal(invoke("issue_comment", { repo: "o/r", number, body: "hi" }, makeCtx().ctx));
    must(threw.includes("number must be an issue number"), `${JSON.stringify(number)}: ${threw}`);
    must(seen.length === 0, `${JSON.stringify(number)} sent ${seen.map((x) => x.path)}`);
  }
});

// Finding 5. Through the gateway, the way a call actually arrives: a mount with no
// policy allowed everything, so approve, merge and `api` ran with nobody there.

/** A stamp mount behind a real gateway, under `policy`. */
async function gatewayMount(policy: unknown) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: policy as any,
  });
  const credential = session();
  const gw = new ToolGateway(store, [stampPlugin], new Set(["stamp"]), { async resolve() { return credential; } });
  return (tool: string, args: Json) => gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, `stamp.${tool}`, args) as Promise<any>;
}
type Json = any;
const MERGE = { repo: "o/r", number: 7, head: HEAD, base: BASE };

await check("with no mount policy, approve, merge and api wait for a person; reads and comments do not", async () => {
  const call = await gatewayMount(null);
  for (const [tool, args] of [["pr_approve", MERGE], ["pr_merge", MERGE], ["api", { path: "/v1/repositories/o/r/pulls/7/approve", method: "POST", body: {} }]] as const) {
    reset();
    const r = await call(tool, args);
    must(r.status === "pending" && r.error?.code === "awaiting_approval", `${tool}: ${JSON.stringify(r)}`);
    must(seen.length === 0, `${tool} reached the gateway: ${seen.map((x) => x.path)}`);
  }
  reset();
  const read = await call("pr_view", { repo: "o/r", number: 7 });
  must(read.status === "succeeded", `pr_view: ${JSON.stringify(read)}`);
});

await check("only the mount naming the tool lifts the hold: a mount-wide write allow does not", async () => {
  const wide = await gatewayMount({ write: "allow" });
  reset();
  const held = await wide("pr_merge", MERGE);
  must(held.status === "pending" && seen.length === 0, `write:allow merged: ${JSON.stringify(held)}`);
  const named = await gatewayMount({ tools: { pr_merge: "allow" } });
  reset();
  const ran = await named("pr_merge", MERGE);
  must(ran.status === "succeeded" && seen.at(-1)?.path === "/v1/repositories/o/r/pulls/7/auto-merge", `named: ${JSON.stringify(ran)}`);
});

// ---- the reverse cases for the fix that follows: each one fails at 3f660140 ----

// Stamp rotated and this side never kept it: the row still opens to the session
// whose refresh token the gateway has just spent. Presenting it again is
// `refresh_reused`, which revokes every token the agent holds.
await check("a rotation the gateway completed but this side could not store is not sent again", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(30);
  // Sealed first, and the write refused is the one after the gateway answered:
  // the one that keeps the rotation.
  await loadSession(ctx);
  failStoreAfterRefresh = true;
  let first = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { first = String((e as Error).message); }
  must(first.includes("write refused by the test"), `first call: ${first}`);
  const after = refreshes;
  let second = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { second = String((e as Error).message); }
  must(refreshes === after, `the spent refresh token was presented again: ${refreshes} refresh requests`);
  must(/sign in again|already used|revoked/.test(second), `second call: ${second}`);
});

// The same case as it actually happens over a network: the gateway completed the
// rotation and the answer never arrived.
await check("a refresh whose answer was lost after the gateway rotated is not retried", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(31);
  await loadSession(ctx);
  const inner = globalThis.fetch as any;
  let drop = true;
  globalThis.fetch = (async (input: any, init: any) => {
    const res = await inner(input, init);
    if (drop && String(input).includes("/api/auth/agent/refresh") && res.ok) { drop = false; throw new TypeError("fetch failed: socket hang up"); }
    return res;
  }) as any;
  let first = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { first = String((e as Error).message); }
  let second = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { second = String((e as Error).message); }
  globalThis.fetch = inner;
  must(first.includes("socket hang up"), `first call: ${first}`);
  must(refreshes === 1, `the spent refresh token was presented again: ${refreshes} refresh requests`);
  must(/sign in again|already used|revoked/.test(second), `second call: ${second}`);
});

// Once the gateway has said a token is spent, no later call may send it again:
// the message already tells the reader not to retry, and every retry is another
// chance to hit the gateway's revoke-everything path.
await check("a token the gateway called spent is not presented by the calls after it", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({ error: "refresh_reused" }), { status: 409, headers: { "content-type": "application/json" } });
  const said: string[] = [];
  for (let i = 0; i < 3; i++) {
    try { await invoke("whoami", {}, ctx); said.push("ok"); } catch (e) { said.push(String((e as Error).message).slice(0, 60)); }
  }
  must(refreshes === 1, `three calls made ${refreshes} refresh requests, all of a token the gateway had already refused`);
  must(said.every((x) => /already used|revoked|sign in again/.test(x)), `said: ${JSON.stringify(said)}`);
});

/** The refresh count, read through a call so a comparison earlier in a case does not narrow it. */
const sent = () => refreshes;

// The other side of the mark: if it cannot be written, nothing is sent, so the
// token is not spent and the next call rotates it as usual.
await check("a rotation whose mark cannot be written sends nothing, and the next call rotates once", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = rotatesTo(32);
  await loadSession(ctx);
  failNextStore = true;
  const first = await refusal(invoke("whoami", {}, ctx));
  must(first.includes("write refused by the test") && refreshes === 0, `first: ${first}, refreshes=${refreshes}`);
  seen = [];
  await invoke("whoami", {}, ctx);
  must(sent() === 1 && seen.at(-1)?.auth === "Bearer ACCESS-32", `second: refreshes=${refreshes}, sent ${seen.at(-1)?.auth}`);
});

// A 5xx may come after the gateway committed, so it is kept as unfinished; a 4xx
// is a refusal before any rotation, so the token is still good to present.
await check("a 5xx refresh is not retried, a 4xx one is", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({ error: "upstream" }), { status: 502, headers: { "content-type": "application/json" } });
  const a = await refusal(invoke("whoami", {}, ctx));
  const b = await refusal(invoke("whoami", {}, ctx));
  must(refreshes === 1 && /sign in again/.test(a) && /sign in again/.test(b), `5xx: refreshes=${refreshes}; ${a} / ${b}`);

  reset();
  const { ctx: c } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({ error: "invalid_schema" }), { status: 400, headers: { "content-type": "application/json" } });
  await refusal(invoke("whoami", {}, c));
  refreshAnswer = rotatesTo(33);
  seen = [];
  await invoke("whoami", {}, c);
  must(sent() === 2 && seen.at(-1)?.auth === "Bearer ACCESS-33", `4xx: refreshes=${refreshes}, sent ${seen.at(-1)?.auth}`);
});

// A credential a person gave can be pasted back however many rotations later;
// the capped list of rotated-away tokens is not what recognises it.
await check("a credential a person gave is still refused after more rotations than the spent list keeps", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  let n = 100;
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: `ACCESS-${n}`, refresh_token: `REFRESH-${n++}`,
    access_expires_at: new Date(Date.now() - 1000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  await invoke("whoami", {}, ctx);
  const replaced = { ...ctx, credential: session({ access_token: "ACCESS-N", refresh_token: "REFRESH-N",
    access_expires_at: new Date(Date.now() - 1000).toISOString() }) };
  for (let i = 0; i < 40; i++) await invoke("whoami", {}, replaced);
  const before = refreshes;
  const back = await refusal(invoke("whoami", {}, { ...ctx, credential: expired() }));
  must(refreshes === before && /sign-in again/.test(back), `pasted back after 40 rotations: refreshes ${before}→${refreshes}; ${back}`);
});

// ---- round 3 (cody's review of a9068c8a) ----

// The row goes with its mount (`removeMount`), so a mount removed and added back
// with the same session JSON finds no row; the agent-level record still knows it.
await check("a session given to a removed mount is not sealed again by a new one", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(expired());
  refreshAnswer = rotatesTo(40);
  await invoke("whoami", {}, ctx);
  must(refreshes === 1, `first mount: ${refreshes}`);
  const { ctx: again, rows } = makeCtx(expired(), agentDb);
  const threw = await refusal(invoke("whoami", {}, again));
  must(sent() === 1, `re-added mount sent a refresh: ${sent()}`);
  must(/sign-in again/.test(threw) && /already given/.test(threw), `re-added: ${threw}`);
  must(rows.size === 0, "the re-added mount sealed the old session");
  // And a credential check of it says so before it is saved.
  const checked: any = await stampPlugin.checkCredential!(again);
  must(checked.ok === false && checked.kind === "rejected", `check: ${JSON.stringify(checked)}`);
});

await check("two stamp mounts of one agent cannot share one session", async () => {
  reset();
  const { ctx: one, agentDb } = makeCtx(expired());
  refreshAnswer = rotatesTo(41);
  await invoke("whoami", {}, one);
  const { ctx: two } = makeCtx(expired(), agentDb, "stamp-two");
  const threw = await refusal(invoke("whoami", {}, two));
  must(sent() === 1 && /already given/.test(threw), `second mount: refreshes=${sent()}; ${threw}`);
});

await check("without an agent-level record a credential is not sealed and nothing is sent", async () => {
  reset();
  const { ctx, rows } = makeCtx(session(), null);
  const threw = await refusal(invoke("whoami", {}, ctx));
  must(/no agent-level record/.test(threw) && seen.length === 0 && rows.size === 0, `${threw}; sent ${seen.length}, rows ${rows.size}`);
});

// `refresh_expired` will never rotate again: terminal, like `refresh_reused`.
for (const [code, status] of [["refresh_expired", 409], ["refresh_invalid", 400]] as const) {
  await check(`${code} is reported once and not presented again`, async () => {
    reset();
    const { ctx } = makeCtx(expired());
    refreshAnswer = () => new Response(JSON.stringify({ error: code }), { status, headers: { "content-type": "application/json" } });
    const said: string[] = [];
    for (let i = 0; i < 3; i++) said.push(await refusal(invoke("whoami", {}, ctx)));
    must(refreshes === 1, `three calls made ${refreshes} refresh requests`);
    must(said.every((x) => /sign in again/.test(x)), `said: ${JSON.stringify(said)}`);
  });
}

// `loadSession`'s second read, in the queue: B read "no row" before A sealed and
// rotated; B must then use A's session, not seal the original over it.
await check("a first use that read no row before another call sealed and rotated uses the newer session", async () => {
  reset();
  const { ctx: a } = makeCtx(expired());
  refreshAnswer = rotatesTo(42);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let held = true;
  const b = { ...a, db: { ...a.db, async get(store: string, key: string) {
    const v = await a.db.get(store, key);
    if (held) { held = false; await gate; }
    return v;
  } } };
  const late = invoke("whoami", {}, b);
  await invoke("whoami", {}, a);
  must(sent() === 1, `after A: ${sent()}`);
  open();
  const threw = await refusal(late);
  must(threw === "" && sent() === 1 && seen.at(-1)?.auth === "Bearer ACCESS-42", `B: ${threw}; refreshes=${sent()}; sent ${seen.at(-1)?.auth}`);
});

// A rename while a call is running: the old name's call and the new name's call
// share one row, so they must share one queue.
await check("a call under a mount's new name waits for the rotation still running under its old name", async () => {
  reset();
  const { ctx: before, rows } = makeCtx(expired());
  await loadSession(before);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const atRefresh = new Promise<void>((r) => { reached = r; });
  refreshAnswer = rotatesTo(43);
  const inner = globalThis.fetch as any;
  let first = true;
  globalThis.fetch = (async (input: any, init: any) => {
    if (first && String(input).includes("/api/auth/agent/refresh")) { first = false; reached(); await held; }
    return inner(input, init);
  }) as any;
  try {
    const old = refusal(invoke("whoami", {}, before));
    // The old name's refresh is in flight, so its mark is on the row.
    await atRefresh;
    let reads = 0;
    let settled = false;
    const renamed = { ...before, alias: "stamp-renamed", db: { ...before.db, rows,
      async get(store: string, key: string) { reads++; return before.db.get(store, key); } } };
    const now = refusal(invoke("whoami", {}, renamed)).then((v) => { settled = true; return v; });
    // Until the new name's call decides — a second read, or an answer — or plainly
    // waits. A fixed 10 ms let a wrong answer through about 1 run in 12.
    for (const until = Date.now() + 500; !settled && reads < 2 && Date.now() < until;) await new Promise((r) => setTimeout(r, 5));
    release();
    const [x, y] = [await old, await now];
    must(x === "" && y === "", `old: ${x}; new: ${y}`);
    must(sent() === 1 && seen.at(-1)?.auth === "Bearer ACCESS-43", `refreshes=${sent()}, sent ${seen.at(-1)?.auth}`);
  } finally { globalThis.fetch = inner; }
});

// `api` is not a way around the hold on pr_approve and pr_merge.
await check("api refuses the approve and merge routes, however they are spelled", async () => {
  reset();
  const { ctx } = makeCtx();
  const held: Array<[string, string, unknown?]> = [
    ["POST", "/v1/repositories/o/r/pulls/7/approve"],
    ["PUT", "/v1/repositories/o/r/pulls/7/merge"],
    ["PUT", "/v1/repositories/o/r/pulls/7/auto-merge/"],
    ["PUT", "/v1/repositories/o/r/pulls/7/MERGE"],
    ["PUT", "/api/v3/repos/o/r/pulls/7/merge"],
    ["PUT", "/api/v3/repos/o/r/pulls/7/%6derge"],
    ["POST", "/api/v3/repos/o/r/merges"],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: "APPROVE" }],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews/9/events", { event: "approve" }],
    ["PUT", "/v1/repositories/o/r/pulls/7//merge"],
    // Joining the merge queue is Stamp's PUT .../queue/{requestID}.
    ["PUT", "/v1/repositories/o/r/pulls/7/queue/req_1"],
    ["PUT", "/v1/repositories/o/r/pulls/7/queue/req_1/"],
    ["POST", "/v1/repositories/o/r/pulls/7///approve"],
    ["PUT", "/api/v3/repos/o//r/pulls/7//merge"],
  ];
  for (const [method, path, body] of held) {
    const threw = await refusal(invoke("api", { method, path, body }, ctx));
    must(/goes through pr_(approve|merge), not api/.test(threw), `${method} ${path}: ${threw}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
  // Leaving the merge queue is not a merge.
  const left = await refusal(invoke("api", { method: "DELETE", path: "/v1/repositories/o/r/pulls/7/queue/req_1" }, ctx));
  must(left === "" && seen.at(-1)?.method === "DELETE", `leaving the queue: ${left}`);
  // Not every write under a pull request is held: a comment review is not an approval.
  const ok = await refusal(invoke("api", { method: "POST", path: "/api/v3/repos/o/r/pulls/7/reviews", body: { event: "COMMENT" } }, ctx));
  must(!/not api/.test(ok), `a comment review was refused: ${ok}`);
});

// Through the real gateway and store: the agent-level record is handed to a
// call and to a credential check, and a removed mount does not take it along.
await check("through the gateway, a mount removed and added back with the same session is refused", async () => {
  reset();
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const add = () => store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: null,
  });
  await add();
  const credential = session();
  const gw = new ToolGateway(store, [stampPlugin], new Set(["stamp"]), { async resolve() { return credential; } });
  const caller = { tenantId: "t", agentId: "a", taskId: "k" };
  const first: any = await gw.invoke(caller, "stamp.whoami", {});
  must(first.status === "succeeded", `first: ${JSON.stringify(first)}`);
  must(await store.removeMount("t", "a", "stamp", null), "the mount was not removed");
  await add();
  seen = [];
  const again: any = await gw.invoke(caller, "stamp.whoami", {});
  must(again.status !== "succeeded" && /already given/.test(JSON.stringify(again)) && seen.length === 0, `re-added: ${JSON.stringify(again)}`);
  const checked: any = await gw.checkMount("t", "a", "stamp", credential);
  must(JSON.stringify(checked).includes("already given"), `check: ${JSON.stringify(checked)}`);
});

// A first seal that fails is not a session used: the record it wrote first is
// taken back, so the same session can be given again. Unless the write landed.
await check("a first seal that fails takes back its record, so the same session works next time", async () => {
  reset();
  const { ctx, agentDb } = makeCtx();
  failNextStore = true;
  const first = await refusal(invoke("whoami", {}, ctx));
  must(first.includes("write refused by the test"), `first: ${first}`);
  must(agentDb!.rows.size === 0, "the record of a session never sealed stayed");
  const checked: any = await stampPlugin.checkCredential!(ctx);
  must(checked.ok === true, `check after the failed seal: ${JSON.stringify(checked)}`);
  must((await refusal(invoke("whoami", {}, ctx))) === "", "the same session was refused after a failed first seal");
});

await check("a first seal reported failed after it landed keeps its record", async () => {
  reset();
  const { ctx, agentDb } = makeCtx();
  failNextStoreLate = true;
  await refusal(invoke("whoami", {}, ctx));
  must(agentDb!.rows.size === 1, "the record was taken back although the row holds the session");
  const { ctx: readded } = makeCtx(session(), agentDb);
  must(/already given/.test(await refusal(invoke("whoami", {}, readded))), "a removed mount's session was accepted again");
});

await check("a first seal that fails and then cannot be read back keeps its record", async () => {
  reset();
  const { ctx, agentDb } = makeCtx();
  failNextStoreLate = true;
  let reads = 0;
  const blind = { ...ctx, db: { ...ctx.db, async get(store: string, key: string) {
    // The read before the seal answers; the one after the failed seal does not.
    if (++reads > 2) throw new Error("read refused by the test");
    return ctx.db.get(store, key);
  } } };
  await refusal(invoke("whoami", {}, blind));
  must(agentDb!.rows.size === 1, "the record was taken back although the row could not be read to say");
  const { ctx: readded } = makeCtx(session(), agentDb);
  must(/already given/.test(await refusal(invoke("whoami", {}, readded))), "a removed mount's session was accepted again");
});

// What later calls say once the gateway refused the token: its code, not "did not finish".
await check("calls after a refused refresh name the gateway's code", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({ error: "refresh_reused" }), { status: 409, headers: { "content-type": "application/json" } });
  await refusal(invoke("whoami", {}, ctx));
  const later = await refusal(invoke("whoami", {}, ctx));
  must(refreshes === 1 && later.includes("refresh_reused") && !later.includes("did not finish"), `later: ${later}`);
});

await check("invalid_schema is reported as this plugin's bug, with the session unchanged", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({ error: "invalid_schema" }), { status: 400, headers: { "content-type": "application/json" } });
  const said = await refusal(invoke("whoami", {}, ctx));
  must(/bug in the stamp plugin/.test(said) && /unchanged/.test(said), said);
});

await check("a refusal with no message has no dangling dash", async () => {
  reset();
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response("", { status: 503 });
  const said = await refusal(invoke("whoami", {}, ctx));
  must(said.startsWith("stamp: could not refresh the session (503). ") && !said.includes("— ."), said);
});

// The note's comment is a write of its own: `pr_comment`'s policy decides it,
// not whatever lifted `pr_approve`.
await check("an approval the mount lets run does not post its note where pr_comment is refused", async () => {
  const call = await gatewayMount({ tools: { pr_approve: "allow", pr_comment: "deny" } });
  reset();
  const r = await call("pr_approve", { ...MERGE, note: "why" });
  must(r.status === "succeeded", `approve: ${JSON.stringify(r)}`);
  const out = r.result ?? r.output ?? r;
  must(seen.length === 1 && seen[0].path.endsWith("/approve"), `sent: ${JSON.stringify(seen.map((x) => x.path))}`);
  must(/not posted: pr_comment is refused/.test(JSON.stringify(out)) && JSON.stringify(out).includes('"note":"why"'), JSON.stringify(r));
  const held = await gatewayMount({ tools: { pr_approve: "allow", pr_comment: "approval" } });
  reset();
  const h = await held("pr_approve", { ...MERGE, note: "why" });
  must(seen.length === 1 && /needs a person's approval/.test(JSON.stringify(h)), JSON.stringify(h));
  const open = await gatewayMount({ tools: { pr_approve: "allow" } });
  reset();
  await open("pr_approve", { ...MERGE, note: "why" });
  const paths = seen.map((x) => x.path);
  must(paths.length === 2 && paths[1].endsWith("/comments"), `allowed: ${JSON.stringify(paths)}`);
});

// A plugin default may tighten a mount's policy, never loosen it: an operator who
// denied writes did not ask for a card whose one click merges.
await check("a mount-wide write deny stays a refusal, not an approval", async () => {
  const denied = await gatewayMount({ write: "deny" });
  reset();
  const r = await denied("pr_merge", MERGE);
  must(r.status === "rejected" && r.error?.code === "policy_denied", `pr_merge on write:deny: ${JSON.stringify(r)}`);
  must(seen.length === 0, "it reached the gateway");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
