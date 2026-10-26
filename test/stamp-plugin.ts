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
    const presented = String(JSON.parse(init?.body ?? "{}").refresh_token);
    if (spentRefresh.has(presented)) {
      return new Response(JSON.stringify({ error: "refresh_reused" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const answer = refreshAnswer();
    if (answer.ok) spentRefresh.add(presented);
    return answer;
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

await check("an approval names the exact head and base it is about", async () => {
  reset();
  await invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE, note: "looks right" }, makeCtx().ctx);
  must(seen[0].method === "POST" && seen[0].path === "/v1/repositories/o/r/pulls/7/approve", `${seen[0].method} ${seen[0].path}`);
  const sent = JSON.parse(seen[0].body);
  must(sent.expectedHead === HEAD && sent.expectedBase === BASE && sent.body === "looks right", JSON.stringify(sent));
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
  // Sealed first, so the write that fails is the rotation's and not the first-use seal.
  await loadSession(ctx);
  const before = JSON.stringify(rows.get("session"));
  failNextStore = true;
  let threw = "";
  try { await invoke("whoami", {}, ctx); } catch (e) { threw = String((e as Error).message); }
  must(refreshes === 1, `refreshes: ${refreshes}`);
  must(threw.includes("write refused by the test"), `message: ${threw}`);
  must(JSON.stringify(rows.get("session")) === before, "a rotated session was kept anyway");
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

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
