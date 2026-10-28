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
import { stampPlugin, SESSION_STORE, parseSession, loadSession, queuedMounts, gatewayFetch } from "../src/plugins/stamp.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { keepRaftIdentity } from "../src/plugins/raft-identity.ts";
import { createRaftPlugin } from "../src/plugins/raft.ts";
import { sealText } from "./../src/plugins/raft-agent-login.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  // A case that never settles is a deadlock (a call waiting on the queue it holds): it fails here, by name, instead
  // of draining the event loop and ending the file with no result. Ten seconds is far past any case's real time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("did not finish in 10 s: a call is waiting on something that never comes (a queue it holds?)")), 10_000); });
  try { await Promise.race([Promise.resolve().then(fn), stuck]); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
  finally { clearTimeout(timer); }
}
function must(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// ---- the fake gateway, and the DB a mount would have -----------------------

type Seen = { method: string; path: string; auth: string | undefined; body: string };
let seen: Seen[] = [];
/** Grants the fake raft mount issued (challenge, used), and the Authorization of every exchange (none expected). */
const grants = new Map<string, { challenge: string; used: boolean }>();
let exchanges: Array<string | undefined> = [];
/** A stand-in for the gateway's `ctx.agentLogin`: a grant per call, bound to the challenge, as Stamp's agent/login does. */
const agentLoginGrants = async (service: string, challenge: string) => {
  if (service !== "stamp") throw new Error(`asked for ${service}`);
  const grant = `grant-${grants.size + 1}`;
  grants.set(grant, { challenge, used: false });
  return { status: "grant" as const, grant, expiresAt: null };
};
/** The Authorization of every owner check (`GET /v1/me?purpose=owner-check`) since `reset`. */
let ownerChecks: Array<string | undefined> = [];
let refreshes = 0;
/** Refresh tokens the fake gateway has rotated: presenting one again is `refresh_reused`, as on Stamp. */
let spentRefresh = new Set<string>();
let refreshAnswer: () => Response = () => new Response("{}", { status: 500 });
let failNextStore = false;
/** Fail the first session write after the gateway has been asked to rotate: the write that keeps the rotation. */
let failStoreAfterRefresh = false;
/** Keep the next session write and then report it failed: a write whose answer is lost after it landed. */
let failNextStoreLate = false;
/** Which Raft agent this antiproton agent is, as its Raft mount keeps it; Stamp's /v1/me answers the same by default. */
const RAFT_AGENT = "ra-1";
const RAFT_SERVER = "rs-1";
const RAFT_CREDENTIAL = "raft-mount-credential";
/** A Raft mount's database holding what `GET /context` said, written the way the raft plugin writes it. */
async function raftMountDb(agentId = RAFT_AGENT, serverId = RAFT_SERVER, credential = RAFT_CREDENTIAL) {
  const rows = new Map<string, any>();
  const db: any = {
    async get(store: string, key: string) { return rows.get(`${store}\u0000${key}`) ?? null; },
    async put(store: string, value: any, key: string) { rows.set(`${store}\u0000${key}`, value); return key; },
  };
  await keepRaftIdentity({ credential, alias: "raft", db } as any, agentId, serverId);
  return db;
}
const RAFT_DB = await raftMountDb();
const replies: Record<string, unknown> = {
  "GET /v1/me": { handle: "eleanor", name: "eleanor", agentId: RAFT_AGENT, serverId: RAFT_SERVER, principalType: "agent", serverName: "raft", commitEmail: "raft+eleanor@agents.stamp.build", gitHTTPSURLTemplate: "https://stamp.build/github/{owner}/{repo}.git" },
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
  // The owner check a first use makes is kept apart, so a test counts the calls it is about.
  if (url.searchParams.get("purpose") === "owner-check") ownerChecks.push(init?.headers?.authorization);
  else seen.push({ method, path, auth: init?.headers?.authorization, body: init?.body ?? "" });
  // Stamp's exchange (botiverse/stamp agentExchange): a grant this fake issued, once, for the verifier of its challenge.
  if (url.pathname === "/api/auth/agent/exchange") {
    exchanges.push(init?.headers?.authorization);
    const b = JSON.parse(init?.body ?? "{}");
    const g = grants.get(b.grant);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!g) return json(400, { code: "grant_invalid" });
    if (g.used) return json(409, { code: "grant_consumed" });
    g.used = true;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(b.code_verifier)));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (challenge !== g.challenge) return json(400, { code: "grant_proof_mismatch" });
    return json(200, JSON.parse(session({ access_token: "ACCESS-SELF", refresh_token: "REFRESH-SELF" })));
  }
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
    async delete(store: string, key: string) { rows.delete(`${store}\u0000${key}`); },
    async getAll(store: string) { return [...rows].filter(([k]) => k.startsWith(`${store}\u0000`)).map(([, v]) => v); },
    async getAllFromIndex() { return []; },
    async count() { return 0; }, async transaction(_s: any, _m: any, fn: any) { return fn(this); },
  };
}

/** A mount's database: one store, in memory, so a test can look at what was kept. */
function makeCtx(
  credential: string | null = session(), agentDb: ReturnType<typeof makeAgentDb> | null = makeAgentDb(), alias = "stamp",
  raft: { db: any; credential: string } | null = { db: RAFT_DB, credential: RAFT_CREDENTIAL },
) {
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
      async sibling(name: string) {
        if (name === alias) return { credential, db, plugin: "stamp", policy: null };
        return name === "raft" && raft ? { credential: raft.credential, db: raft.db, plugin: "raft", policy: null } : null;
      } } as any,
  };
}

const invoke = (tool: string, args: any, ctx: any) => stampPlugin.invoke(tool, args, ctx) as Promise<any>;
const reset = () => { seen = []; ownerChecks = []; refreshes = 0; spentRefresh = new Set(); };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
/** Due for a refresh (inside the 60 s skew) but not yet expired, so a first use can still ask whose it is. */
const expired = () => session({ access_expires_at: new Date(Date.now() + 30_000).toISOString() });
/** Past its expiry: a first use refuses it rather than refresh before knowing whose it is. */
const pastExpiry = () => session({ access_expires_at: new Date(Date.now() - 1000).toISOString() });
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
  const { ctx, rows } = makeCtx(expired());
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
  const { ctx } = makeCtx(expired());
  refreshAnswer = () => new Response(JSON.stringify({
    schema: "raft-cli-agent-session.v1", access_token: "ACCESS-3", refresh_token: "REFRESH-3",
    access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  }), { status: 200, headers: { "content-type": "application/json" } });
  await Promise.all([invoke("whoami", {}, ctx), invoke("whoami", {}, ctx), invoke("whoami", {}, ctx)]);
  must(refreshes === 1, `refreshes: ${refreshes} (three calls must share one)`);
});

await check("a rotation that cannot be stored fails the call and is not used", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired());
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
  const { ctx } = makeCtx(expired());
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
  // Whose it is cannot be asked without refreshing it, so it is refused, not refreshed.
  must(checked.ok === false && checked.kind === "rejected" && /already expired/.test(checked.reason), `expired candidate: ${JSON.stringify(checked)}`);
  must(refreshes === 1, `the check refreshed the candidate (${refreshes})`);
  must(JSON.stringify(rows.get("session")) === live, "the check overwrote the live session");
  seen = [];
  await invoke("whoami", {}, ctx);
  must(refreshes === 1 && seen.at(-1)?.auth === "Bearer ACCESS-24", `live mount after the check: refreshes=${refreshes}, sent ${seen.at(-1)?.auth}`);
  // A fresh candidate is checked with its own access token, once — the owner check is the whoami — and writes no
  // session row (only the agent-level record that the check passed).
  seen = [];
  ownerChecks = [];
  const fresh: any = await stampPlugin.checkCredential!({ ...ctx, credential: session({ access_token: "ACCESS-D", refresh_token: "REFRESH-D" }) });
  must(fresh.ok === true && fresh.account === "@eleanor", JSON.stringify(fresh));
  must(seen.length === 0 && ownerChecks.length === 1 && ownerChecks[0] === "Bearer ACCESS-D", `check sent: ${JSON.stringify(seen)}, owner checks ${JSON.stringify(ownerChecks)}`);
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

/** The raft plugin as a sibling sees it: its id, its version pin and its context store; nothing it calls. */
const RAFT_STUB = { id: "raft", version: "1.0.0", tools: [], async invoke() { return {}; },
  database: { version: 8, stores: { context: {} } } } as any;

/** A store with this agent's Raft mount, its identity kept as the raft plugin keeps it. */
async function gatewayStore() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i-raft", connectionId: null,
    toolVersion: RAFT_STUB.version, publicConfig: {}, secretRef: "agent:raft", policy: null,
  });
  const db = { async put(st: string, value: any, key: string) { store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" }, st, key, value, null); return key; } };
  await keepRaftIdentity({ credential: RAFT_CREDENTIAL, alias: "raft", db } as any, RAFT_AGENT, RAFT_SERVER);
  return store;
}
const gatewayOver = (store: SqliteStore, credential: string) => new ToolGateway(store, [stampPlugin, RAFT_STUB], new Set(["stamp", "raft"]),
  { async resolve(ref: string) { return ref === "agent:raft" ? RAFT_CREDENTIAL : credential; } });

/** A stamp mount behind a real gateway, under `policy`. */
async function gatewayMount(policy: unknown) {
  const store = await gatewayStore();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: policy as any,
  });
  const credential = session();
  const gw = gatewayOver(store, credential);
  const call = (tool: string, args: Json) => gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, `stamp.${tool}`, args) as Promise<any>;
  return Object.assign(call, { store, gw });
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
    access_expires_at: new Date(Date.now() + 30_000).toISOString() }) };
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
    must(/^stamp: api may not .*call pr_(approve|merge)/.test(threw), `${method} ${path}: ${threw}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
  // Leaving the merge queue is not a merge.
  const left = await refusal(invoke("api", { method: "DELETE", path: "/v1/repositories/o/r/pulls/7/queue/req_1" }, ctx));
  must(left === "" && seen.at(-1)?.method === "DELETE", `leaving the queue: ${left}`);
  // Not every write under a pull request is held: a comment review is not an approval.
  const ok = await refusal(invoke("api", { method: "POST", path: "/api/v3/repos/o/r/pulls/7/reviews", body: { event: "COMMENT" } }, ctx));
  must(!/api may not/.test(ok), `a comment review was refused: ${ok}`);
});

// botiverse/antiproton#1092: the bridge will route through this same table, so each
// spelling below is pinned on its own, as is the mount policy that names api. The table
// lists the routes known to approve or merge; a route not on it is not held.
await check("api: escaped slashes, a mixed-case event, a trailing slash and DELETE on /api/v3 are still held", async () => {
  reset();
  const { ctx } = makeCtx();
  const held: Array<[string, string, unknown?]> = [
    ["PUT", "/api/v3/repos/o/r/pulls/7%2Fmerge"],
    ["PUT", "/api/v3/repos/o/r/pulls/7%2fmerge"],
    ["PUT", "/api/v3/repos/o/r/pulls%2F7%2Fmerge"],
    ["PUT", "/api/v3/repos/o/r/pulls/7%252Fmerge"],
    ["PUT", "/api/v3/repos/o/r/pulls/7/merge?x=1"],
    // DELETE passes only on /v1/ auto-merge and queue; /api/v3 has no DELETE merge, so it stays held.
    ["DELETE", "/api/v3/repos/o/r/pulls/7/merge"],
    ["PATCH", "/v1/repositories/o/r/pulls/7/approve"],
    ["PUT", "/api/v3/repos/o/r/pulls/7/merge/"],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: "Approve" }],
    ["POST", "/api/v3/repos/o/r/pulls/7/REVIEWS", { event: "APPROVE" }],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews/", { event: "APPROVE" }],
  ];
  for (const [method, path, body] of held) {
    const threw = await refusal(invoke("api", { method, path, body }, ctx));
    must(/^stamp: api may not .*call pr_(approve|merge)/.test(threw), `${method} ${path}: ${threw}`);
  }
  // /v1/ takes no escapes at all, so an escaped slash there never reaches the table.
  for (const path of ["/v1/repositories/o/r/pulls/7%2Fmerge", "/v1/repositories/o/r/pulls/7%2Fapprove"]) {
    const threw = await refusal(invoke("api", { method: "PUT", path }, ctx));
    must(/carries no escapes/.test(threw), `${path}: ${threw}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
  // Cancelling auto-merge is not a merge.
  const cancelled = await refusal(invoke("api", { method: "DELETE", path: "/v1/repositories/o/r/pulls/7/auto-merge" }, ctx));
  must(!/api may not/.test(cancelled) && seen.at(-1)?.method === "DELETE" && seen.at(-1)?.path === "/v1/repositories/o/r/pulls/7/auto-merge",
    `cancelling auto-merge: ${cancelled}`);
});

await check("a mount that allows api still cannot approve or merge through it", async () => {
  const call = await gatewayMount({ tools: { api: "allow" } });
  for (const [method, path, body] of [
    ["POST", "/v1/repositories/o/r/pulls/7/approve", {}],
    ["PUT", "/v1/repositories/o/r/pulls/7/merge", {}],
    ["PUT", "/api/v3/repos/o/r/pulls/7%2Fmerge", {}],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: "APPROVE" }],
  ] as const) {
    reset();
    const r = await call("api", { method, path, body });
    must(r.status !== "succeeded" && /^stamp: api may not .*call pr_(approve|merge)/.test(String(r.error?.message)), `${method} ${path}: ${JSON.stringify(r)}`);
    must(seen.length === 0, `${path} reached the gateway`);
  }
  // The allow is real: a write the table does not hold goes straight through.
  reset();
  const ok = await call("api", { method: "POST", path: "/v1/repositories/o/r/pulls/7/comments", body: { body: "hi" } });
  must(ok.status === "succeeded" && seen.at(-1)?.path === "/v1/repositories/o/r/pulls/7/comments", `comment: ${JSON.stringify(ok)}`);
});

// botiverse/antiproton#1092 step 4: `api` is decided by the bridge's rows (`API_ROUTES`), each call under its row's
// key besides `api`'s own entry (`policyKey`), and a route the table refuses is refused by the handler.
replies["POST /api/v3/repos/o/r/labels"] = { name: "x" };
replies["POST /api/v3/repos/o/r/pulls/7/reviews"] = { id: 55 };
const LABELS = { method: "POST", path: "/api/v3/repos/o/r/labels", body: { name: "x" } };
const COMMENT = { method: "POST", path: "/v1/repositories/o/r/pulls/7/comments", body: { body: "hi" } };
const pendingKey = async (call: Awaited<ReturnType<typeof gatewayMount>>) =>
  ((await call.store.listApprovals("t", "pending")).at(-1)?.request as any)?.policyKey;

await check("api: an unlisted write, REQUEST_CHANGES and cancelling auto-merge wait under stamp.write even where api is allowed", async () => {
  for (const [what, args] of [
    ["a label", LABELS],
    ["REQUEST_CHANGES", { method: "POST", path: "/api/v3/repos/o/r/pulls/7/reviews", body: { event: "REQUEST_CHANGES" } }],
    ["cancelling auto-merge", { method: "DELETE", path: "/v1/repositories/o/r/pulls/7/auto-merge" }],
    ["a branch delete", { method: "DELETE", path: "/api/v3/repos/o/r/git/refs/heads/x" }],
  ] as const) {
    for (const policy of [null, { tools: { api: "allow" } }, { write: "allow", tools: { api: "allow" } }]) {
      reset();
      const call = await gatewayMount(policy);
      const r = await call("api", args);
      must(r.status === "pending" && await pendingKey(call) === "stamp.write", `${what} under ${JSON.stringify(policy)}: ${JSON.stringify(r)}`);
      must(seen.length === 0, `${what} reached the gateway`);
    }
  }
  // Only the mount's own entry for stamp.write lifts it.
  reset();
  const lifted = await gatewayMount({ tools: { api: "allow", "stamp.write": "allow" } });
  const ran = await lifted("api", LABELS);
  must(ran.status === "succeeded" && seen.at(-1)?.path === "/api/v3/repos/o/r/labels", `stamp.write: allow: ${JSON.stringify(ran)}`);
});

await check("api: a listed write is decided under its tool's key too — the card names it, its deny refuses, api's deny wins", async () => {
  reset();
  const held = await gatewayMount({ tools: { api: "allow", pr_comment: "approval" } });
  const r1 = await held("api", COMMENT);
  must(r1.status === "pending" && await pendingKey(held) === "pr_comment" && seen.length === 0, `pr_comment held: ${JSON.stringify(r1)}`);
  const denied = await gatewayMount({ tools: { api: "allow", pr_comment: "deny" } });
  const r2 = await denied("api", COMMENT);
  must(r2.status === "rejected" && r2.error?.code === "policy_denied" && seen.length === 0, `pr_comment deny: ${JSON.stringify(r2)}`);
  const apiDenied = await gatewayMount({ tools: { api: "deny", pr_comment: "allow" } });
  const r3 = await apiDenied("api", COMMENT);
  must(r3.status === "rejected" && r3.error?.code === "policy_denied" && seen.length === 0, `api deny + pr_comment allow: ${JSON.stringify(r3)}`);
  for (const [key, args] of [
    ["pr_create", { method: "POST", path: "/v1/pull-requests", body: { title: "t" } }],
    ["issue_create", { method: "POST", path: "/api/v3/repos/o/r/issues", body: { title: "t" } }],
    ["issue_comment", { method: "POST", path: "/api/v3/repos/o/r/issues/3/comments", body: { body: "x" } }],
    ["pr_unapprove", { method: "POST", path: "/v1/repositories/o/r/pulls/7/unapprove" }],
  ] as const) {
    const d = await (await gatewayMount({ tools: { api: "allow", [key]: "deny" } }))("api", args);
    must(d.status === "rejected" && d.error?.code === "policy_denied", `${key}: deny did not refuse api ${args.path}: ${JSON.stringify(d)}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
  // Allowed both ways, a COMMENT review runs: its body is judged as JSON, as `call` sends it.
  const open = await gatewayMount({ tools: { api: "allow" } });
  const r4 = await open("api", { method: "POST", path: "/api/v3/repos/o/r/pulls/7/reviews", body: { event: "COMMENT", body: "hi" } });
  must(r4.status === "succeeded" && seen.at(-1)?.path === "/api/v3/repos/o/r/pulls/7/reviews", `a COMMENT review: ${JSON.stringify(r4)}`);
});

await check("api: what the table refuses is refused where stamp.write and every tool are allowed, and on an approved replay", async () => {
  const open = await gatewayMount({ write: "allow", tools: { api: "allow", "stamp.write": "allow", pr_approve: "allow", pr_merge: "allow", pr_comment: "allow" } });
  for (const [method, path, body, said] of [
    ["POST", "/api/v3/graphql", { query: "mutation{x}" }, /GraphQL/],
    ["PUT", "/api/v3/repositories/123/pulls/7/merge", {}, /repositories\/<id>/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews?x=1", { event: "COMMENT" }, /query string/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews%3Fevent=APPROVE", { event: "COMMENT" }, /query string/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { Event: "APPROVE" }, /may not approve through a review/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: "COMMENT", Event: "APPROVE" }, /Name `event` once/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: ["APPROVE"] }, /Name `event` once/],
    ["POST", "/api/v3/repos/o/r/pulls/7/reviews", { event: 1 }, /Name `event` once/],
    ["PUT", "/v1/repositories/o/r/pulls/7/merge;x", {}, /; or a character outside ASCII/],
    ["PUT", "/api/v3/repos/o/r/pulls/7/merge%3Bx", {}, /; or a character outside ASCII/],
    ["PUT", "/api/v3/repos/o/r/pulls/7/ｍerge", {}, /; or a character outside ASCII/],
    ["PUT", "/api/v3/repos/o/r/pulls/7/%EF%BD%8Derge", {}, /; or a character outside ASCII/],
    // An escape that is not UTF-8 stops no decoding of the others: the path is refused whole.
    ["PUT", "/api/v3/repos/o%FF/r/pulls/7%2Fmerge", {}, /do not decode as UTF-8/],
    ["PUT", "/api/v3/repos/o/r/pulls/7%FF%2Fmerge", {}, /do not decode as UTF-8/],
    ["POST", "/api/v3/repos/o/r%FF/pulls/7%2Fapprove", {}, /do not decode as UTF-8/],
    ["POST", "/api/v3/repos/o/r/labels/x%25FF", { name: "x" }, /do not decode as UTF-8/],
  ] as const) {
    reset();
    const r = await open("api", { method, path, body });
    must(r.status === "failed" && /^stamp: (api may not |this review's body)/.test(r.error?.message) && said.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
    must(seen.length === 0, `${path} reached the gateway`);
  }
  // Held by default (api: approval) and approved by a person: the replay is refused, not run.
  reset();
  const held = await gatewayMount(null);
  const r = await held("api", { method: "PUT", path: "/v1/repositories/o/r/pulls/7/merge", body: {} });
  must(r.status === "pending", `held: ${JSON.stringify(r)}`);
  const a = (await held.store.listApprovals("t", "pending"))[0]!;
  const done: any = await held.gw.applyApproval("t", a.operationId, "approved", "owner");
  must(done.result?.status !== "succeeded" && /api may not merge/.test(JSON.stringify(done)), `the replay: ${JSON.stringify(done)}`);
  must(seen.length === 0, `the replay reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
});

await check("api: a key resolves through the mount's blanket write setting: write approval holds and write deny refuses what api: allow ran", async () => {
  reset();
  for (const [key, args] of [["pr_comment", COMMENT], ["pr_create", { method: "POST", path: "/v1/pull-requests", body: { title: "t" } }],
    ["stamp.write", LABELS]] as const) {
    const held = await gatewayMount({ write: "approval", tools: { api: "allow" } });
    const r = await held("api", args);
    must(r.status === "pending" && await pendingKey(held) === key, `write: approval, ${key}: ${JSON.stringify(r)}`);
  }
  const denied = await gatewayMount({ write: "deny", tools: { api: "allow" } });
  for (const args of [COMMENT, { method: "POST", path: "/v1/pull-requests", body: { title: "t" } }, LABELS]) {
    const r = await denied("api", args);
    must(r.status === "rejected" && r.error?.code === "policy_denied", `write: deny, ${args.path}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((x) => x.path))}`);
});

await check("api is not modelOnly: a program's api call is held as a card, not refused as not_from_a_program", async () => {
  must(stampPlugin.tools.find((t) => t.name === "api")?.modelOnly !== true, "api is modelOnly");
  reset();
  const call = await gatewayMount(null);
  const r = await call.gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "stamp.api", LABELS, { fromProgram: true }) as any;
  must(r.status === "pending" && await pendingKey(call) === "stamp.write", `from a program: ${JSON.stringify(r)}`);
});

await check("api's policyKey never throws: a key for a listed or unlisted write, undefined for a refusal, a bad path or bad args", () => {
  const key = (args: unknown, tool = "api") => stampPlugin.policyKey!(tool, args as any);
  const circular: any = { a: 1 }; circular.self = circular;
  for (const args of [null, undefined, 5, "x", [], {}, { path: 5 }, { method: "GET", path: "/v1/x" }, { method: "POST" },
    { method: "POST", path: "//evil.example/v1/x" }, { method: "POST", path: "/v1/../api/auth/agent/refresh" },
    { method: "POST", path: "/v1/repositories/o/r/pulls/7%2Fmerge" }, { method: "POST", path: "/api/v3/x", body: circular },
    { method: "POST", path: "/api/v3/x", body: { n: 1n } }, { method: "PUT", path: "/v1/repositories/o/r/pulls/7/merge" },
    { method: "POST", path: "/api/v3/graphql" }]) {
    let got: unknown;
    try { got = key(args); } catch (e) { throw new Error(`threw on ${String(args)}: ${(e as Error).message}`); }
    must(got === undefined, `${JSON.stringify(args, (_k, v) => typeof v === "bigint" ? `${v}n` : v === circular ? "[circular]" : v)}: ${got}`);
  }
  must(key(LABELS) === "stamp.write" && key(COMMENT) === "pr_comment", `keys: ${key(LABELS)} ${key(COMMENT)}`);
  // The body is judged as `call` sends it: a falsy one is no body at all, so a review without one is a comment.
  for (const body of [null, "", 0, false]) {
    const k = key({ method: "POST", path: "/api/v3/repos/o/r/pulls/7/reviews", body });
    must(k === "pr_comment", `a review with body ${JSON.stringify(body)}: ${k}`);
  }
  must(key(LABELS, "api_get") === undefined && key(MERGE, "pr_merge") === undefined, "a key for another tool");
});

// Through the real gateway and store: the agent-level record is handed to a
// call and to a credential check, and a removed mount does not take it along.
await check("through the gateway, a mount removed and added back with the same session is refused", async () => {
  reset();
  const store = await gatewayStore();
  const add = () => store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: null,
  });
  await add();
  const credential = session();
  const gw = gatewayOver(store, credential);
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
  must(seen.length === 1 && /needs a person's approval on this mount; call pr_comment/.test(JSON.stringify(h)), JSON.stringify(h));
  const open = await gatewayMount({ tools: { pr_approve: "allow" } });
  reset();
  await open("pr_approve", { ...MERGE, note: "why" });
  const paths = seen.map((x) => x.path);
  must(paths.length === 2 && paths[1].endsWith("/comments"), `allowed: ${JSON.stringify(paths)}`);
});

await check("an approval's note is not posted where a mount-wide write deny covers pr_comment, nor when the mount cannot be read", async () => {
  const denied = await gatewayMount({ write: "deny", tools: { pr_approve: "allow" } });
  reset();
  const r = await denied("pr_approve", { ...MERGE, note: "why" });
  must(r.status === "succeeded" && seen.length === 1 && /not posted: pr_comment is refused/.test(JSON.stringify(r)), JSON.stringify(r));
  reset();
  const { ctx } = makeCtx();
  // Its own mount cannot be read; its Raft mount can, so the session itself is kept.
  const blind = { ...ctx, async sibling(name: string) { return name === "stamp" ? null : ctx.sibling(name); } };
  const b: any = await invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE, note: "why" }, blind);
  must(seen.length === 1 && /policy could not be read/.test(b.commentSkipped ?? "") && !/refused/.test(b.commentSkipped ?? ""), JSON.stringify(b));
});

// A replayed call must not post its note twice: the harness replays only what is declared idempotent.
await check("pr_approve is not declared idempotent, since its note is a comment", async () => {
  const tool = stampPlugin.tools.find((t) => t.name === "pr_approve");
  must(tool?.idempotency === "none", `pr_approve idempotency: ${tool?.idempotency}`);
});

// ---- whose session it is (Ward, Piper, Rex): checked once, before it is kept ----

/** Run `fn` with Stamp's /v1/me answering `me` (or `status`), then put it back. */
async function withMe<T>(me: Record<string, unknown> | null, status: number, fn: () => Promise<T>): Promise<T> {
  const was = replies["GET /v1/me"];
  const st = statuses["GET /v1/me"];
  if (me) replies["GET /v1/me"] = { ...(was as object), ...me };
  statuses["GET /v1/me"] = status;
  try { return await fn(); } finally { replies["GET /v1/me"] = was; if (st === undefined) delete statuses["GET /v1/me"]; else statuses["GET /v1/me"] = st; }
}

await check("a session whose agent and server are this agent's is kept, with whose it is, and the queue is left empty", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired());
  refreshAnswer = rotatesTo(50);
  // Bounded only so a deadlock fails this case instead of hanging the file; the assertion is the queue.
  const done = await Promise.race([invoke("whoami", {}, ctx).then(() => "done"), new Promise((r) => setTimeout(() => r("stuck"), 2000))]);
  must(done === "done", "the first use did not finish: the owner check waited on the queue it runs in");
  must(ownerChecks.length === 1 && ownerChecks[0] === "Bearer ACCESS-1", `owner checks: ${JSON.stringify(ownerChecks)}`);
  must(rows.get("session")?.owner === `${RAFT_AGENT}@${RAFT_SERVER}`, `owner kept: ${rows.get("session")?.owner}`);
  must(queuedMounts() === 0, `queues left behind: ${queuedMounts()}`);
  // Never asked again, rotations included: a later whoami answers for a rotated token.
  await withMe({ agentId: "someone-else" }, 200, async () => {
    for (let i = 0; i < 3; i++) await invoke("whoami", {}, ctx);
  });
  must(ownerChecks.length === 1 && rows.get("session")?.owner === `${RAFT_AGENT}@${RAFT_SERVER}`, `asked again: ${ownerChecks.length}`);
});

for (const [what, me, why] of [
  ["another agent", { agentId: "ra-2" }, /belongs to the Stamp agent/],
  ["another server", { serverId: "rs-2" }, /belongs to the Stamp agent/],
  ["a CLI agent", { agentId: "cli_7", principalType: "agent" }, /belongs to the Stamp agent/],
  ["not an agent", { principalType: "human" }, /not an agent's session/],
] as const) {
  await check(`a session of ${what} is refused, and nothing is kept or refreshed`, async () => {
    reset();
    const { ctx, rows, agentDb } = makeCtx(expired());
    refreshAnswer = rotatesTo(51);
    const said = await withMe(me, 200, () => refusal(invoke("whoami", {}, ctx)));
    must(why.test(said) && /cannot be given to this agent/.test(said), said);
    must(refreshes === 0 && rows.size === 0 && agentDb!.rows.size === 0 && seen.length === 0, `kept or sent: refreshes=${refreshes}, rows=${rows.size}, given=${agentDb!.rows.size}, sent=${seen.length}`);
  });
}

await check("without this agent's Raft identity a session is refused: no Raft mount, or one whose credential changed", async () => {
  for (const [what, raft] of [
    ["no raft mount", null],
    ["a replaced raft credential", { db: RAFT_DB, credential: "another-raft-credential" }],
  ] as const) {
    reset();
    const { ctx, rows } = makeCtx(expired(), makeAgentDb(), "stamp", raft as any);
    const said = await refusal(invoke("whoami", {}, ctx));
    // No raft mount names the mount to add; a replaced credential is a listing to wait for.
    const why = raft === null ? /no mount named `raft`/ : /cannot be read from its Raft mount/;
    must(why.test(said) && refreshes === 0 && rows.size === 0, `${what}: ${said}`);
  }
});

await check("a session already past its expiry is refused without a refresh or an owner check", async () => {
  reset();
  const { ctx, rows } = makeCtx(pastExpiry());
  refreshAnswer = rotatesTo(52);
  const said = await refusal(invoke("whoami", {}, ctx));
  must(/already expired/.test(said) && refreshes === 0 && ownerChecks.length === 0 && rows.size === 0, `${said}; refreshes=${refreshes}, checks=${ownerChecks.length}`);
});

await check("a 401 or no answer from Stamp's whoami is refused, and nothing is kept", async () => {
  reset();
  const { ctx, rows, agentDb } = makeCtx(expired());
  const r401 = await withMe(null, 401, () => refusal(invoke("whoami", {}, ctx)));
  must(/HTTP 401/.test(r401) && rows.size === 0 && agentDb!.rows.size === 0 && refreshes === 0, r401);
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async (input: any, init: any) => String(input).includes("purpose=owner-check")
    ? Promise.reject(new TypeError("fetch failed: connection refused")) : inner(input, init)) as any;
  try {
    const down = await refusal(invoke("whoami", {}, ctx));
    must(/could not be asked/.test(down) && rows.size === 0 && agentDb!.rows.size === 0 && refreshes === 0, down);
  } finally { globalThis.fetch = inner; }
});

// ---- a check that passed lets a first use refresh (cody, Eleanor) ----

/** Run `fn` an hour later, as far as the plugin's clock is concerned. */
async function anHourLater<T>(fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + 3_600_000;
  try { return await fn(); } finally { Date.now = real; }
}
const verifiedRows = (agentDb: any) => [...agentDb.rows.keys()].filter((k: string) => k.startsWith("stampVerified\u0000"));

await check("a session checked while fresh is refreshed at its first use after its access token expired, once", async () => {
  reset();
  const { ctx, rows, agentDb } = makeCtx(session());
  const checked: any = await stampPlugin.checkCredential!(ctx);
  must(checked.ok === true && verifiedRows(agentDb).length === 1 && rows.size === 0, `check: ${JSON.stringify(checked)}; rows ${rows.size}`);
  const before = ownerChecks.length;
  refreshAnswer = rotatesTo(60);
  await anHourLater(async () => {
    await invoke("whoami", {}, ctx);
    await invoke("whoami", {}, ctx);
  });
  must(refreshes === 1 && seen.at(-1)?.auth === "Bearer ACCESS-60", `refreshes=${refreshes}, sent ${seen.at(-1)?.auth}`);
  must(rows.get("session")?.owner === `${RAFT_AGENT}@${RAFT_SERVER}` && ownerChecks.length === before, `owner ${rows.get("session")?.owner}; asked again: ${ownerChecks.length - before}`);
});

await check("a check's record does not outlive this agent's Raft identity: changed since, the first use refuses", async () => {
  reset();
  const { ctx, rows, agentDb } = makeCtx(session());
  must((await stampPlugin.checkCredential!(ctx) as any).ok === true, "not checked");
  const other = await raftMountDb("ra-9", RAFT_SERVER);
  const moved = { ...ctx, async sibling(name: string) {
    return name === "raft" ? { credential: RAFT_CREDENTIAL, db: other, plugin: "raft", policy: null } : ctx.sibling(name);
  } };
  const said = await anHourLater(() => refusal(invoke("whoami", {}, moved)));
  must(/a check found it belongs to ra-1@rs-1, and this agent is ra-9@rs-1/.test(said) && refreshes === 0 && rows.size === 0, `${said}; refreshes=${refreshes}`);
  must(verifiedRows(agentDb).length === 1, "the record went");
});

await check("a check of one session does not let another be refreshed", async () => {
  reset();
  const { ctx, rows } = makeCtx(session({ refresh_token: "REFRESH-S" }));
  must((await stampPlugin.checkCredential!(ctx) as any).ok === true, "S was not checked");
  const t = { ...ctx, credential: session({ access_token: "ACCESS-T", refresh_token: "REFRESH-T" }) };
  const said = await anHourLater(() => refusal(invoke("whoami", {}, t)));
  must(/already expired/.test(said) && refreshes === 0 && rows.size === 0, `${said}; refreshes=${refreshes}`);
});

await check("a check that fails writes nothing: another agent's session, a 401, no Raft identity", async () => {
  for (const [what, me, status, raft, kind] of [
    ["another agent", { agentId: "ra-2" }, 200, undefined, "rejected"],
    ["a 401", null, 401, undefined, "rejected"],
    ["no Raft identity", null, 200, null, "unreachable"],
  ] as const) {
    reset();
    const { ctx, rows, agentDb } = makeCtx(session(), makeAgentDb(), "stamp", raft === undefined ? { db: RAFT_DB, credential: RAFT_CREDENTIAL } : raft);
    const checked: any = await withMe(me, status, () => stampPlugin.checkCredential!(ctx));
    must(checked.ok === false && checked.kind === kind, `${what}: ${JSON.stringify(checked)}`);
    must(agentDb!.rows.size === 0 && rows.size === 0 && refreshes === 0, `${what} wrote: agentDb ${agentDb!.rows.size}, rows ${rows.size}`);
  }
});

await check("a call that cannot read this agent's Raft identity says to try again, not to sign in", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired(), makeAgentDb(), "stamp", null);
  const said = await refusal(invoke("whoami", {}, ctx));
  must(/try again shortly/.test(said) && /not a reason to sign in again/.test(said) && rows.size === 0 && refreshes === 0, said);
});

await check("Stamp's answer without whose it is is told as not knowing, not as another's session", async () => {
  reset();
  const { ctx, rows } = makeCtx(expired());
  const was = replies["GET /v1/me"];
  replies["GET /v1/me"] = { handle: "x" };
  try {
    const said = await refusal(invoke("whoami", {}, ctx));
    must(/did not say whose it is/.test(said) && !/cannot be given/.test(said) && rows.size === 0, said);
  } finally { replies["GET /v1/me"] = was; }
});

// The console's path end to end: this agent's own session passes a check through the gateway.
await check("through the gateway, a check of this agent's own session passes and is recorded", async () => {
  reset();
  const store = await gatewayStore();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: null,
  });
  const credential = session();
  const checked: any = await gatewayOver(store, credential).checkMount("t", "a", "stamp", credential);
  must(JSON.stringify(checked).includes('"ok":true'), `check: ${JSON.stringify(checked)}`);
  must(ownerChecks.length === 1, `owner checks: ${ownerChecks.length}`);
});

// The check's context reads siblings through the same lookup a call's does: this agent's mounts and no other's.
await check("a credential check's sibling sees this agent's mounts, and no other agent's", async () => {
  const store = await gatewayStore();
  await store.createAgent("t", "b");
  await store.addMount({
    tenantId: "t", agentId: "b", alias: "elsewhere", plugin: "raft", installationId: "i-b", connectionId: null,
    toolVersion: RAFT_STUB.version, publicConfig: {}, secretRef: "agent:raft", policy: null,
  });
  const seenBy: Record<string, boolean> = {};
  const probe = { id: "probe", version: "1.0.0", tools: [], async invoke() { return {}; },
    async checkCredential(ctx: any) {
      seenBy.raft = (await ctx.sibling("raft")) !== null;
      seenBy.elsewhere = (await ctx.sibling("elsewhere")) !== null;
      return { ok: true };
    } } as any;
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "probe", plugin: "probe", installationId: "i-p", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [stampPlugin, RAFT_STUB, probe], new Set(["stamp", "raft", "probe"]),
    { async resolve(ref: string) { return ref === "agent:raft" ? RAFT_CREDENTIAL : null; } });
  await gw.checkMount("t", "a", "probe", "candidate");
  must(seenBy.raft === true && seenBy.elsewhere === false, JSON.stringify(seenBy));
});

// A record settles whose a session is, not whether Stamp still takes it (cody): a later check of a fresh session asks.
await check("a session checked once and revoked at Stamp since does not read as ok at the next check", async () => {
  reset();
  const { ctx } = makeCtx(session());
  must((await stampPlugin.checkCredential!(ctx) as any).ok === true, "the first check did not pass");
  const again: any = await withMe(null, 401, () => stampPlugin.checkCredential!(ctx));
  must(again.ok === false && again.kind === "rejected", `after revocation: ${JSON.stringify(again)}`);
  // And once its access token has expired, the record answers whose it is, and nothing is refreshed to ask.
  const later: any = await anHourLater(() => stampPlugin.checkCredential!(ctx));
  must(later.ok === false && later.kind === "unreachable" && refreshes === 0, `expired: ${JSON.stringify(later)}`);
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

// ---- the agent-level records a session leaves behind go when that session can no longer be refreshed ----

/** A row in the agent-level fake, as `getAll` returns it. */
const agentRows = (db: ReturnType<typeof makeAgentDb>, store: string) =>
  [...db.rows].filter(([k]) => k.startsWith(`${store}\u0000`)).map(([, v]) => v as any);
/** Put a row the way the plugin writes one, so a case can seed an older one. */
const seedRow = (db: ReturnType<typeof makeAgentDb>, store: string, key: string, row: Record<string, unknown>) =>
  db.rows.set(`${store}\u0000${key}`, { d: key, at: new Date().toISOString(), ...row });
const longAgo = () => new Date(Date.now() - 86_400_000).toISOString();
const soon = () => new Date(Date.now() + 86_400_000).toISOString();

// A check records whose the session is, and when that session can no longer be refreshed, so the record can go.
await check("a passed check records its session's refresh expiry, so the record has a life", async () => {
  reset();
  const until = soon();
  const { ctx, agentDb } = makeCtx(session({ refresh_expires_at: until }));
  const checked: any = await stampPlugin.checkCredential!(ctx);
  must(checked.ok === true, `check: ${JSON.stringify(checked)}`);
  const rows = agentRows(agentDb!, "stampVerified");
  must(rows.length === 1, `rows: ${JSON.stringify(rows)}`);
  must(rows[0].until === until && rows[0].owner === `${RAFT_AGENT}@${RAFT_SERVER}`, JSON.stringify(rows[0]));
});

// The row is dropped once its own session's refresh token has expired — and only then.
await check("an expired record goes at the next check, and one still refreshable stays", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(session({ refresh_expires_at: soon() }));
  seedRow(agentDb!, "stampVerified", "digest-of-a-session-gone", { owner: `${RAFT_AGENT}@${RAFT_SERVER}`, until: longAgo() });
  seedRow(agentDb!, "stampVerified", "digest-of-a-session-alive", { owner: `${RAFT_AGENT}@${RAFT_SERVER}`, until: soon() });
  seedRow(agentDb!, "stampVerified", "digest-with-no-expiry", { owner: `${RAFT_AGENT}@${RAFT_SERVER}` });
  await stampPlugin.checkCredential!(ctx);
  const left = agentRows(agentDb!, "stampVerified").map((r) => (r as any).d).sort();
  must(left.includes("digest-of-a-session-alive"), `an unexpired record was dropped: ${JSON.stringify(left)}`);
  must(left.includes("digest-with-no-expiry"), `a record with no expiry was dropped: ${JSON.stringify(left)}`);
  must(!left.includes("digest-of-a-session-gone"), `the expired record stayed: ${JSON.stringify(left)}`);
});

// The same rule on the other store: a session a person gave is recorded until it can no longer be refreshed.
// `stampGiven` is never pruned (cody, against Stamp main e3013451): Stamp checks reuse before expiry and keeps spent
// rows, so a used token presented after its expiry is still `refresh_reused`. Only `stampVerified` is pruned.
await check("a given session's record is never pruned, expired or not; only a check's record is", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(session({ refresh_expires_at: soon() }));
  seedRow(agentDb!, "stampGiven", "digest-of-a-session-gone", { until: longAgo() });
  seedRow(agentDb!, "stampGiven", "digest-of-a-session-alive", { until: soon() });
  await invoke("whoami", {}, ctx);
  const left = agentRows(agentDb!, "stampGiven").map((r) => (r as any).d);
  must(left.includes("digest-of-a-session-alive") && left.includes("digest-of-a-session-gone"), JSON.stringify(left));
  must(agentRows(agentDb!, "stampVerified").length === 0, "a first use wrote a stampVerified row");
});

// A check that fails writes nothing, so it must prune nothing either: the expired row is somebody's old check, and
// this call has no business tidying it.
await check("a check that fails prunes nothing", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(session({ refresh_expires_at: soon() }));
  seedRow(agentDb!, "stampVerified", "digest-of-a-session-gone", { owner: `${RAFT_AGENT}@${RAFT_SERVER}`, until: longAgo() });
  const checked: any = await withMe({ agentId: "someone-else" }, 200, () => stampPlugin.checkCredential!(ctx));
  must(checked.ok === false && checked.kind === "rejected", `check: ${JSON.stringify(checked)}`);
  const left = agentRows(agentDb!, "stampVerified").map((r) => (r as any).d);
  must(left.includes("digest-of-a-session-gone"), `a failed check pruned a row: ${JSON.stringify(left)}`);
  must(!left.some((d) => d !== "digest-of-a-session-gone"), `a failed check wrote a row: ${JSON.stringify(left)}`);
});

const digestOf = async (t: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`antiproton stamp agent session v1\u0000${t}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
};

// cody's P2: a session given here and used, whose refresh token has expired, pasted back while its access token is
// still fresh. Stamp would answer the refresh `refresh_reused`; the kept given record refuses it before anything goes.
await check("a used session pasted back after its refresh expiry is refused by its record, with nothing sent", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(session({ access_token: "ACCESS-NEW", refresh_token: "REFRESH-NEW" }));
  seedRow(agentDb!, "stampGiven", await digestOf("REFRESH-OLD"), { until: longAgo() });
  await invoke("whoami", {}, ctx);
  // Into a new mount of the same agent, as it would be pasted: the mount has no row, so only the given record speaks.
  const { ctx: back } = makeCtx(session({ access_token: "ACCESS-OLD", refresh_token: "REFRESH-OLD",
    refresh_expires_at: new Date(Date.now() - 60_000).toISOString() }), agentDb, "stamp-new");
  const said = await refusal(invoke("whoami", {}, back));
  must(/already given/.test(said) && refreshes === 0 && ownerChecks.length === 1, `${said}; refreshes=${refreshes}, owner checks=${ownerChecks.length}`);
});

// cody's P1: a check's record that outlived its refresh token permits nothing. Built without the given record (as a
// store pruned by an older build would leave it), so only the `until` read in verifiedOwner stands between the
// pasted-back session and a refresh.
await check("a check's record past its refresh expiry does not let an expired session refresh", async () => {
  reset();
  const { ctx, rows } = makeCtx(session({ access_token: "ACCESS-S", refresh_token: "REFRESH-S",
    access_expires_at: new Date(Date.now() - 3_600_000).toISOString(), refresh_expires_at: new Date(Date.now() - 60_000).toISOString() }));
  seedRow((ctx as any).agentDb, "stampVerified", await digestOf("REFRESH-S"), { owner: `${RAFT_AGENT}@${RAFT_SERVER}`, until: longAgo() });
  refreshAnswer = rotatesTo(70);
  const said = await refusal(invoke("whoami", {}, ctx));
  must(/already expired/.test(said) && refreshes === 0 && rows.size === 0, `${said}; refreshes=${refreshes}`);
});

// The pruning of `stampVerified` covers the row just written too: a session checked with an expired refresh token
// leaves no record, and permits nothing either way.
await check("a check of a session whose refresh token has already expired leaves no record behind", async () => {
  reset();
  const { ctx, agentDb } = makeCtx(session({ refresh_expires_at: longAgo() }));
  await stampPlugin.checkCredential!(ctx);
  must(agentRows(agentDb!, "stampVerified").length === 0, JSON.stringify(agentRows(agentDb!, "stampVerified")));
});

// ---- the SDK swap, pinned: what it sends, how often, and the words it keeps ----

// The SDK retries a read twice by default when the transport fails. This
// plugin's tools declare their own idempotency, so a read that cannot reach the
// gateway is one attempt here: the caller decides, and knows what happened.
await check("a read whose transport fails is one attempt, not the SDK's retries", async () => {
  reset();
  const { ctx } = makeCtx();
  const inner = globalThis.fetch as any;
  let attempts = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const u = new URL(String(input));
    // The owner check a first use makes is not the call under test.
    if (u.pathname === "/v1/me" && !u.searchParams.has("purpose")) {
      attempts++;
      const e = new TypeError("fetch failed");
      (e as any).cause = { code: "ECONNRESET" };
      throw e;
    }
    return inner(input, init);
  }) as any;
  let said = "";
  try { said = await refusal(invoke("whoami", {}, ctx)); } finally { globalThis.fetch = inner; }
  must(attempts === 1, `attempts: ${attempts} (the SDK would make three)`);
  must(said !== "" && !/refused \d/.test(said), `reads as a refusal: ${said}`);
});

// A write is never retried either, and this one is not idempotent: an unclear
// answer means read the pull request, never resend. A 5xx is one request, and
// a transport failure on a write is one attempt too — the outcome is unknown.
await check("a refused write is one request", async () => {
  reset();
  const { ctx } = makeCtx();
  statuses["POST /v1/pull-requests"] = 500;
  try {
    const said = await refusal(invoke("pr_create", { receipt: "rec_1" }, ctx));
    must(seen.filter((r) => r.method === "POST" && r.path === "/v1/pull-requests").length === 1, `posts: ${seen.length}`);
    must(said.includes("500"), `said: ${said}`);
  } finally { delete statuses["POST /v1/pull-requests"]; }
  const inner = globalThis.fetch as any;
  let attempts = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (new URL(String(input)).pathname === "/v1/pull-requests") {
      attempts++;
      const e = new TypeError("fetch failed");
      (e as any).cause = { code: "ECONNRESET" };
      throw e;
    }
    return inner(input, init);
  }) as any;
  try { await refusal(invoke("pr_create", { receipt: "rec_1" }, ctx)); } finally { globalThis.fetch = inner; }
  must(attempts === 1, `write attempts: ${attempts} (an unknown outcome is never resent)`);
});

// One 401: rotate once, retry once, and the retry carries the token just issued
// — the transport swap must not turn this into two refusals.
await check("a 401 rotates once and the retry carries the new token", async () => {
  reset();
  const { ctx } = makeCtx(session({ access_expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }));
  refreshAnswer = rotatesTo(60);
  const inner = globalThis.fetch as any;
  // The gateway's own rule: the token it has not issued yet is the only one it refuses.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me" && !url.searchParams.has("purpose") && init?.headers?.authorization === "Bearer ACCESS-1") {
      seen.push({ method: "GET", path: "/v1/me", auth: init?.headers?.authorization, body: "" });
      return new Response(JSON.stringify({ errorCode: "SESSION_REQUIRED" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as any;
  try {
    await invoke("whoami", {}, ctx);
  } finally { globalThis.fetch = inner; }
  const me = seen.filter((r) => r.path === "/v1/me");
  must(refreshes === 1, `refreshes: ${refreshes}`);
  must(me.length === 2, `requests: ${me.length}`);
  must(me[0].auth === "Bearer ACCESS-1" && me[1].auth === "Bearer ACCESS-60", `sent: ${me.map((r) => r.auth).join(" then ")}`);
});

// The gateway's own code is what a caller branches on: it has to survive the
// SDK's ApiError, with the method and path that were refused.
await check("a refusal keeps the gateway's code and the request that was refused", async () => {
  reset();
  const { ctx } = makeCtx();
  statuses["POST /v1/repositories/o/r/pulls/7/approve"] = 403;
  replies["POST /v1/repositories/o/r/pulls/7/approve"] = { errorCode: "SELF_APPROVAL_NOT_ALLOWED", message: "an author cannot approve" };
  try {
    const said = await refusal(invoke("pr_approve", { repo: "o/r", number: 7, head: HEAD, base: BASE }, ctx));
    must(said.includes("SELF_APPROVAL_NOT_ALLOWED"), `code lost: ${said}`);
    must(said.includes("POST /v1/repositories/o/r/pulls/7/approve"), `path lost: ${said}`);
    must(said.includes("403"), `status lost: ${said}`);
  } finally {
    delete statuses["POST /v1/repositories/o/r/pulls/7/approve"];
    replies["POST /v1/repositories/o/r/pulls/7/approve"] = { approved: true };
  }
});

// A transport that cannot be reached is not a refusal by the gateway: nothing
// here may read like "the gateway said no".
await check("an unreachable gateway is not reported as a refusal", async () => {
  reset();
  const { ctx } = makeCtx();
  // Kept first, so the failure below is the call's and not the first use's owner check.
  await invoke("whoami", {}, ctx);
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as any;
  try {
    const said = await refusal(invoke("whoami", {}, ctx));
    must(said !== "", "the call succeeded with no gateway");
    must(!/refused \d/.test(said), `reads as a refusal: ${said}`);
  } finally { globalThis.fetch = inner; }
});

// The path check is this plugin's, and it runs before the SDK builds the URL:
// an escape must be no request at all, not one the transport then explains.
await check("a path that escapes is refused before the SDK sends it", async () => {
  reset();
  const { ctx } = makeCtx();
  for (const path of ["/v1/../api/auth/agent/refresh", "/v1/x/../../api/auth/agent/refresh", "/api/v3/../api/auth/session"]) {
    const said = await refusal(invoke("api", { method: "POST", path, body: {} }, ctx));
    must(/must not climb out|must start with/.test(said), `${path}: ${said}`);
  }
  must(seen.length === 0, `reached the gateway: ${JSON.stringify(seen.map((r) => r.path))}`);
});

// ---- gatewayFetch, the fetch the SDK's client sends with (cody, #1053 follow-ups) ----

await check("the client's fetch never follows a redirect", async () => {
  reset();
  const { ctx } = makeCtx();
  await invoke("whoami", {}, ctx);
  const inner = globalThis.fetch as any;
  const asked: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    asked.push(String(init?.redirect));
    // What a real fetch does with redirect "error" on a 3xx; with anything else it would follow.
    if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return new Response("{}", { status: 200 });
  }) as any;
  try {
    const said = await refusal(invoke("pr_view", { repo: "o/r", number: 7 }, ctx));
    must(asked.length === 1 && asked[0] === "error", `redirect modes: ${JSON.stringify(asked)}`);
    must(/did not reach Stamp/.test(said), said);
  } finally { globalThis.fetch = inner; }
});

await check("the client's fetch refuses any host but the gateway, before sending", async () => {
  reset();
  let sent = 0;
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async () => { sent++; return new Response("{}"); }) as any;
  try {
    for (const url of ["https://evil.example/v1/me", "http://stamp.build/v1/me", "https://stamp.build.evil.example/v1/me"]) {
      const said = await refusal(gatewayFetch(url, { method: "GET" }));
      must(/talks only to https:\/\/stamp\.build/.test(said), `${url}: ${said}`);
    }
    must(sent === 0, `sent ${sent}`);
  } finally { globalThis.fetch = inner; }
});

await check("a request that outlives its 30 s bound is said as a timeout, not as a code", async () => {
  reset();
  const { ctx } = makeCtx();
  await invoke("whoami", {}, ctx);
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as any;
  try {
    const read = await refusal(invoke("pr_view", { repo: "o/r", number: 7 }, ctx));
    must(/no answer from Stamp within 30 s/.test(read) && !/\(23\)/.test(read) && /safe to try again/.test(read), read);
    const write = await refusal(invoke("pr_comment", { repo: "o/r", number: 7, body: "x" }, ctx));
    must(/no answer from Stamp within 30 s/.test(write) && /unknown/.test(write), write);
  } finally { globalThis.fetch = inner; }
});

// ---- stamp_login: the mount logs in with the agent's own Raft identity (botiverse/antiproton#1084) ----

await check("stamp_login seals a session of this agent under the raft key, and the mount then acts with it", async () => {
  reset(); exchanges = [];
  const { ctx, rows, agentDb } = makeCtx(null);
  const logged = { ...ctx, agentLogin: agentLoginGrants };
  const out: any = await invoke("stamp_login", {}, logged);
  must(out.status === "signed_in" && out.owner === `${RAFT_AGENT}@${RAFT_SERVER}`, JSON.stringify(out));
  const row = rows.get("session");
  must(row?.source === "agent-login" && typeof row?.nonce === "string" && row?.from === undefined, JSON.stringify(row));
  must(!JSON.stringify(row).includes("REFRESH-SELF"), "the session is kept in the clear");
  must(agentDb!.rows.size === 0, `self-login wrote agent-level records: ${agentDb!.rows.size}`);
  must(exchanges.length === 1 && exchanges[0] === undefined, `the exchange carried a session: ${JSON.stringify(exchanges)}`);
  seen = [];
  await invoke("whoami", {}, logged);
  must(seen.at(-1)?.auth === "Bearer ACCESS-SELF", `acted with ${seen.at(-1)?.auth}`);
});

await check("stamp_login refuses a mount that already works, or holds a person's session, and sends nothing", async () => {
  reset(); exchanges = [];
  const { ctx } = makeCtx(null);
  const logged = { ...ctx, agentLogin: agentLoginGrants };
  await invoke("stamp_login", {}, logged);
  const again = await refusal(invoke("stamp_login", {}, logged));
  must(/already has a working session/.test(again) && exchanges.length === 1, `${again}; exchanges ${exchanges.length}`);
  const pasted = { ...makeCtx(session()).ctx, agentLogin: agentLoginGrants };
  const said = await refusal(invoke("stamp_login", {}, pasted));
  must(/given a session by a person/.test(said) && exchanges.length === 1, said);
});

await check("a self-login row whose raft credential changed reads as log in again, with nothing sent", async () => {
  reset(); exchanges = [];
  const { ctx, rows } = makeCtx(null);
  await invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants });
  const otherRaft = await raftMountDb(RAFT_AGENT, RAFT_SERVER, "another-raft-credential");
  const moved = { ...ctx, agentLogin: agentLoginGrants, async sibling(name: string) {
    return name === "raft" ? { credential: "another-raft-credential", db: otherRaft, plugin: "raft", policy: null } : ctx.sibling(name);
  } };
  seen = [];
  const said = await refusal(invoke("whoami", {}, moved));
  must(/Log in again with stamp_login/.test(said) && !/a person signs in/.test(said) && seen.length === 0 && refreshes === 0, said);
  // And stamp_login may replace it: the row is not working.
  const out: any = await invoke("stamp_login", {}, moved);
  must(out.status === "signed_in" && rows.get("session")?.source === "agent-login", JSON.stringify(out));
});

await check("with no credential, a row that is not this mount's own login is not used", async () => {
  reset();
  const { ctx, rows } = makeCtx(session());
  await invoke("whoami", {}, ctx);
  must(rows.get("session") && rows.get("session").source === undefined, "no pasted row to test with");
  const bare = { ...ctx, credential: null };
  seen = [];
  const said = await refusal(invoke("whoami", {}, bare));
  must(/nothing to act as/.test(said) && seen.length === 0, said);
});

await check("a person's session pasted onto a self-login mount takes over", async () => {
  reset();
  const { ctx } = makeCtx(null);
  await invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants });
  const pasted = { ...ctx, credential: session({ access_token: "ACCESS-P", refresh_token: "REFRESH-P" }) };
  seen = [];
  await invoke("whoami", {}, pasted);
  must(seen.at(-1)?.auth === "Bearer ACCESS-P", `acted with ${seen.at(-1)?.auth}`);
});

await check("Raft's approval or install answer comes back as it is, with nothing kept", async () => {
  reset(); exchanges = [];
  const { ctx, rows } = makeCtx(null);
  for (const status of ["approval_required", "install_required"] as const) {
    const out: any = await invoke("stamp_login", {}, { ...ctx, async agentLogin() { return { status, detail: { card: "c1" } }; } });
    must(out.status === status && out.detail?.card === "c1" && rows.size === 0 && exchanges.length === 0, JSON.stringify(out));
  }
});

// Through the gateway (cody): who gets the method, which services, and the default hold.
await check("through the gateway: only a declaring plugin gets agentLogin, for its declared service, and stamp_login waits for a person", async () => {
  const store = await gatewayStore();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: stampPlugin.version, publicConfig: {}, secretRef: null, policy: null,
  });
  const seenBy: Record<string, unknown> = {};
  const probe = { id: "probe", version: "1.0.0", agentLogin: { services: ["stamp"] },
    tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_n: string, _a: unknown, c: any) {
      seenBy.has = typeof c.agentLogin;
      try { await c.agentLogin("github", "x"); seenBy.other = "allowed"; } catch (e) { seenBy.other = String((e as Error).message); }
      return {};
    } } as any;
  const silent = { id: "silent", version: "1.0.0", tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_n: string, _a: unknown, c: any) { seenBy.silent = typeof c.agentLogin; return {}; } } as any;
  for (const [alias, plugin] of [["probe", "probe"], ["silent", "silent"]]) {
    await store.addMount({ tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  }
  const gw = new ToolGateway(store, [stampPlugin, RAFT_STUB, probe, silent], new Set(["stamp", "raft", "probe", "silent"]),
    { async resolve(ref: string) { return ref === "agent:raft" ? RAFT_CREDENTIAL : null; } });
  const caller = { tenantId: "t", agentId: "a", taskId: "k" };
  await gw.invoke(caller, "probe.go", {});
  await gw.invoke(caller, "silent.go", {});
  must(seenBy.has === "function" && /may not log in to "github"/.test(String(seenBy.other)) && seenBy.silent === "undefined", JSON.stringify(seenBy));
  reset(); exchanges = [];
  const held: any = await gw.invoke(caller, "stamp.stamp_login", {});
  must(held.status === "pending" && held.error?.code === "awaiting_approval" && exchanges.length === 0, JSON.stringify(held));
});

await check("a mount can turn stamp_login off", async () => {
  const call = await gatewayMount({ tools: { stamp_login: "deny" } });
  reset(); exchanges = [];
  const r = await call("stamp_login", {});
  must(r.status === "rejected" && r.error?.code === "policy_denied" && exchanges.length === 0, JSON.stringify(r));
});

// cody: a call that needs a session and has none never logs in by itself.
await check("a tool call with no session does not log in by itself", async () => {
  reset(); exchanges = [];
  let asked = 0;
  const { ctx } = makeCtx(null);
  const said = await refusal(invoke("whoami", {}, { ...ctx, async agentLogin(...a: any[]) { asked++; return agentLoginGrants(a[0], a[1]); } }));
  must(asked === 0 && exchanges.length === 0 && /stamp_login/.test(said), `${said}; asked ${asked}`);
});

// ---- cody's review of #1086: the request the raft side makes, the listing context, and what a trace row holds ----

await check("the raft side asks for exactly the agent-login action with the three closed fields, and nothing else", async () => {
  const calls: any[] = [];
  const raft = createRaftPlugin({ agentLoginCalls: {
    async invoke(args: any) { calls.push(args); return { service: {}, action: "agent-login", result: { schema: "raft-cli-agent-login-grant.v1", grant: "g-1", expires_at: "2026-10-27T10:00:00Z" } } as any; },
    async login() { throw new Error("not called"); },
  } });
  const ctx = { credential: "sk", alias: "raft", caller: { tenantId: "t", agentId: "a" }, publicConfig: { serverUrl: "https://raft.example" } } as any;
  const out = await raft.grantAgentLogin!(ctx, "stamp", "CHALLENGE", "#general");
  must(out.status === "grant" && (out as any).grant === "g-1", JSON.stringify(out));
  must(JSON.stringify(calls) === JSON.stringify([{ service: "stamp", action: "agent-login", target: "#general",
    params: { schema: "raft-cli-agent-login-request.v1", code_challenge: "CHALLENGE", code_challenge_method: "S256" } }]), JSON.stringify(calls));
  // Not installed: Agent Login's own install_required, with who acts next and no tool name of the raft plugin's.
  const uninstalled = createRaftPlugin({ agentLoginCalls: {
    async invoke() { throw Object.assign(new Error("No app installed on this Server matched \"stamp\""), { notInstalled: true }); },
    async login() { return { status: "install_required", installation: { serverName: "S", marketplaceUrl: "https://m", target: "#c", actionCardMessageId: "m1" }, next: "call integrations_login again" } as any; },
  } });
  const inst: any = await uninstalled.grantAgentLogin!(ctx, "stamp", "CHALLENGE");
  must(inst.status === "install_required" && inst.detail?.actionCardMessageId === "m1" && !JSON.stringify(inst).includes("integrations_"), JSON.stringify(inst));
  const approval = createRaftPlugin({ agentLoginCalls: {
    async invoke() { return { status: "approval_required", approval: { requestId: "r1", target: "#c", actionCardMessageId: "m2" }, next: "call integrations_invoke again" } as any; },
    async login() { throw new Error("not called"); },
  } });
  const appr: any = await approval.grantAgentLogin!(ctx, "stamp", "CHALLENGE");
  must(appr.status === "approval_required" && appr.detail?.requestId === "r1" && !JSON.stringify(appr).includes("integrations_"), JSON.stringify(appr));
});

await check("a listing context has no agentLogin, even for a plugin that declares it", async () => {
  const store = await gatewayStore();
  let listed: string | undefined;
  const probe = { id: "probe", version: "1.0.0", agentLogin: { services: ["stamp"] }, tools: [],
    async invoke() { return {}; },
    async snapshotTools(c: any) { listed = typeof c.agentLogin; return { tools: [] }; } } as any;
  await store.addMount({ tenantId: "t", agentId: "a", alias: "probe", plugin: "probe", installationId: "i-p", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const gw = new ToolGateway(store, [RAFT_STUB, probe], new Set(["raft", "probe"]), { async resolve() { return null; } });
  await gw.refreshMountTools("t", "a", "probe");
  must(listed === "undefined", `listing context agentLogin: ${listed}`);
});

await check("a stamp_login trace row holds only mount, service, owner and whether a session was issued", async () => {
  const rows: any[] = [];
  const allowed = new Set(["mount", "service", "owner", "issued"]);
  reset(); exchanges = [];
  const { ctx } = makeCtx(null);
  await invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants, trace: (r: any) => rows.push(r) });
  // A failure after Stamp issued a session: the owner check refuses it (another agent's), and it is still traced.
  const other = makeCtx(null).ctx;
  await withMe({ agentId: "ra-2" }, 200, () => refusal(invoke("stamp_login", {}, { ...other, agentLogin: agentLoginGrants, trace: (r: any) => rows.push(r) })));
  must(rows.length === 2 && rows[0].status === "sealed" && rows[1].status === "failed_after_issue" && rows[1].attrs.issued === true, JSON.stringify(rows));
  for (const r of rows) {
    const extra = Object.keys(r.attrs).filter((k) => !allowed.has(k));
    must(extra.length === 0 && !/REFRESH|ACCESS|grant-|verifier/.test(JSON.stringify(r)), `trace row: ${JSON.stringify(r)}`);
  }
});

await check("a self-login session whose refresh is refused points at stamp_login, not at a person", async () => {
  reset(); exchanges = [];
  const { ctx } = makeCtx(null);
  const logged = { ...ctx, agentLogin: agentLoginGrants };
  await invoke("stamp_login", {}, logged);
  refreshAnswer = () => new Response(JSON.stringify({ error: "refresh_reused" }), { status: 409, headers: { "content-type": "application/json" } });
  const first = await anHourLater(() => refusal(invoke("whoami", {}, logged)));
  const later = await anHourLater(() => refusal(invoke("whoami", {}, logged)));
  for (const said of [first, later]) must(/stamp_login/.test(said) && !/person needs to sign in/.test(said), said);
  must(refreshes === 1, `refreshes: ${refreshes}`);
});


// ---- the edges of stamp_login that its nine cases do not reach (Eleanor, botiverse/antiproton#1084) ----

/** What the raft mount was asked for, per call: the service and the challenge. */
let loginAsk: Array<{ service: string; challenge: string }> = [];
const askLogin = async (service: string, challenge: string) => { loginAsk.push({ service, challenge }); return agentLoginGrants(service, challenge); };
/** Trace rows this plugin wrote (the fake context hands over a collector). */
const traces: any[] = [];
const withTrace = (ctx: any) => ({ ...ctx, trace: (row: any) => traces.push(row) });
/** A session of this mount's own login that is already due, so the next call rotates it. */
const expiringExchange = (rt: string) => session({ access_token: `ACCESS-${rt}`, refresh_token: rt, access_expires_at: new Date(Date.now() + 30_000).toISOString() });

// The pair has to be the shape Stamp accepts, not merely random-looking: `isValidS256Challenge` decodes with
// RawURLEncoding and requires exactly 32 bytes, so a padded or short challenge is answered `invalid_challenge` — which
// reads like a Stamp bug. The verifier is 32 bytes too (43 characters), which is what `codeVerifierRe` takes.
await check("stamp_login's PKCE pair is the shape Stamp accepts, and a second attempt makes a new one", async () => {
  reset(); loginAsk = [];
  const { ctx } = makeCtx(null);
  await invoke("stamp_login", {}, { ...ctx, agentLogin: askLogin });
  must(loginAsk.length === 1 && loginAsk[0].service === "stamp", JSON.stringify(loginAsk));
  const challenge = loginAsk[0].challenge;
  must(/^[A-Za-z0-9_-]{43}$/.test(challenge), `challenge is not 43 characters of raw base64url: ${challenge}`);
  const raw = Uint8Array.from(atob(challenge.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  must(raw.length === 32, `the challenge decoded to ${raw.length} bytes, and Stamp wants 32`);
  // A fresh mount, so the first attempt's session is not in the way: this is about the pair, not the refusal.
  const gone = { ...makeCtx(null).ctx, async agentLogin(service: string, ch: string) { loginAsk.push({ service, challenge: ch }); return { status: "unavailable" as const, reason: "no raft mount" }; } };
  await invoke("stamp_login", {}, gone);
  const asked = (): number => loginAsk.length;
  must(asked() === 2 && loginAsk[1].challenge !== challenge, `the second attempt reused the challenge: ${JSON.stringify(loginAsk)}`);
});

// A 5xx at the exchange may have minted a session, so it is never retried with the same grant: the next call asks the
// raft mount for a fresh one. One exchange per attempt, always.
await check("a failed exchange is not retried with the same grant; the next call starts over", async () => {
  reset(); exchanges = []; loginAsk = [];
  const { ctx } = makeCtx(null);
  const inner = globalThis.fetch as any;
  let fail = 1;
  // Every exchange the plugin makes is counted here, whether it is the one that fails or a retry of it. Read through
  // a function so a comparison earlier in the case cannot narrow the count to a literal.
  let tries = 0;
  const exchangesMade = (): number => tries;
  globalThis.fetch = (async (input: any, init: any) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/auth/agent/exchange") tries++;
    if (u.pathname === "/api/auth/agent/exchange" && fail > 0) {
      fail--;
      return new Response(JSON.stringify({ code: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as any;
  try {
    const first = await refusal(invoke("stamp_login", {}, { ...ctx, agentLogin: askLogin }));
    must(/may have been issued/.test(first) && /starts over/.test(first), first);
    must(exchangesMade() === 1, `one attempt made ${exchangesMade()} exchanges, and a grant is presented once`);
    const out: any = await invoke("stamp_login", {}, { ...ctx, agentLogin: askLogin });
    must(out.status === "signed_in", JSON.stringify(out));
    must(exchangesMade() === 2, `two attempts made ${exchangesMade()} exchanges (the failed one must not be resent)`);
    must(loginAsk.length === 2, `the raft mount was asked ${loginAsk.length} times`);
    // A transport failure - no answer at all - follows the same rule, said as the unknown outcome it is.
    const { ctx: lost, rows: lostRows } = makeCtx(null);
    let thrown = 0;
    globalThis.fetch = (async (input: any, init: any) => {
      if (new URL(String(input)).pathname === "/api/auth/agent/exchange") {
        tries++;
        thrown++;
        const e = new TypeError("fetch failed");
        (e as any).cause = { code: "ECONNRESET" };
        throw e;
      }
      return inner(input, init);
    }) as any;
    const before = exchangesMade();
    const cut = await refusal(invoke("stamp_login", {}, { ...lost, agentLogin: agentLoginGrants }));
    must(/no answer came back/.test(cut) && /starts over/.test(cut), cut);
    must(exchangesMade() - before === 1 && thrown === 1, `a lost answer was sent ${exchangesMade() - before} times`);
    must(lostRows.size === 0, "a session was kept after a lost answer");
  } finally { globalThis.fetch = inner; }
});

// A grant the gateway has already spent is the agent's cue to start over, not a bug in the plugin: the two are said
// differently, and only the second tells someone to stop trying.
await check("a spent grant is answered as start over, not as this plugin's bug", async () => {
  reset(); exchanges = [];
  const { ctx, rows } = makeCtx(null);
  const inner = globalThis.fetch as any;
  let n = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const u = new URL(String(input));
    if (u.pathname !== "/api/auth/agent/exchange") return inner(input, init);
    exchanges.push(init?.headers?.authorization);
    n++;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // The first answer is not a session but the grant is spent all the same; the second presents it again.
    return n === 1 ? json(200, { schema: "not-a-session" }) : json(409, { code: "grant_consumed" });
  }) as any;
  try {
    const first = await refusal(invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants }));
    must(/not a session/.test(first), first);
    const second = await refusal(invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants }));
    must(/grant_consumed/.test(second) && /starts over/.test(second) && !/bug in this plugin/.test(second), second);
    must(rows.size === 0, `a session was kept: ${JSON.stringify([...rows.keys()])}`);
  } finally { globalThis.fetch = inner; }
});

// Two seals never share a key: every seal of a self-login session takes a fresh nonce, so a rotation rewrites the row
// under a new one and carries `source`, `owner` and the raft seal with it.
await check("a self-login session rotates under a fresh nonce, still as this agent's own login", async () => {
  reset();
  const inner = globalThis.fetch as any;
  globalThis.fetch = (async (input: any, init: any) => new URL(String(input)).pathname === "/api/auth/agent/exchange"
    ? new Response(expiringExchange("REFRESH-SELF"), { status: 200, headers: { "content-type": "application/json" } })
    : inner(input, init)) as any;
  try {
    const { ctx, rows } = makeCtx(null);
    await invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants });
    const first = rows.get("session");
    must(first?.source === "agent-login" && typeof first?.nonce === "string", JSON.stringify(first));
    refreshAnswer = rotatesTo(90);
    seen = [];
    await invoke("whoami", {}, ctx);
    must(refreshes === 1 && seen.at(-1)?.auth === "Bearer ACCESS-90", `refreshes ${refreshes}, sent ${seen.at(-1)?.auth}`);
    const rotated = rows.get("session");
    must(rotated?.source === "agent-login", `the rotation lost the source: ${JSON.stringify(rotated)}`);
    must(rotated?.owner === `${RAFT_AGENT}@${RAFT_SERVER}`, JSON.stringify(rotated));
    must(rotated?.from === undefined, `a self-login row grew a from: ${JSON.stringify(rotated)}`);
    must(typeof rotated?.nonce === "string" && rotated.nonce !== first.nonce, "two seals shared a nonce");
    // And it still opens: the key follows the nonce, not the seal it replaced.
    seen = [];
    await invoke("whoami", {}, ctx);
    must(seen.at(-1)?.auth === "Bearer ACCESS-90", `after the rotation it acted with ${seen.at(-1)?.auth}`);
  } finally { globalThis.fetch = inner; }
});

// The one dangerous branch of a self-login mount: with no usable credential, `loadSession` reads the row before it
// concludes there is no session. Only a row this mount logged in for itself may come back — a row sealed under a
// credential that is not a session (a cookie, a GitHub token) must not, or a mount given a wrong value would act with
// whatever session was left behind.
await check("with a credential that is not a session, only this mount's own login is actable", async () => {
  reset();
  const { ctx, rows } = makeCtx("ghp_not_a_session");
  const sealed = await sealText({ ...ctx, alias: "stamp-session" } as any, "antiproton stamp agent session v1",
    session({ access_token: "ACCESS-LEFT", refresh_token: "REFRESH-LEFT" }), "session");
  rows.set("session", { ...sealed, from: "some-digest" });
  seen = [];
  const said = await refusal(invoke("whoami", {}, ctx));
  must(/nothing to act as|not a Stamp agent session/.test(said), said);
  must(seen.length === 0, `a request went out: ${JSON.stringify(seen)}`);
});

// A self-login row that cannot be opened for its own reasons — no nonce, a damaged seal, no raft mount — asks for a
// login and sends nothing on the way. The difference between "log in again" and "a person signs in" is the point.
await check("a self-login row that cannot be opened asks for a login and sends nothing", async () => {
  for (const row of [{ source: "agent-login", owner: `${RAFT_AGENT}@${RAFT_SERVER}` },
    { source: "agent-login", nonce: "n1", iv: "AAAA", ciphertext: "BBBB" }]) {
    reset();
    const { ctx, rows } = makeCtx(null);
    rows.set("session", row);
    seen = [];
    const said = await refusal(invoke("whoami", {}, ctx));
    must(/stamp_login/.test(said) && !/a person signs in/.test(said), `${JSON.stringify(row)}: ${said}`);
    must(seen.length === 0 && refreshes === 0, `a request went out: ${JSON.stringify(seen)}`);
  }
  // And with no raft mount at all, the same answer: it cannot read its own key, so it logs in again once there is one.
  reset();
  const { ctx } = makeCtx(null);
  await invoke("stamp_login", {}, { ...ctx, agentLogin: agentLoginGrants });
  const orphan = { ...ctx, async sibling() { return null; } };
  seen = [];
  const said = await refusal(invoke("whoami", {}, orphan));
  must(/stamp_login/.test(said) && seen.length === 0 && refreshes === 0, said);
});

// Trace: one row per attempt, and no token, grant or verifier in it — the attributes are what an operator reads.
await check("every stamp_login attempt writes one trace row, and it carries no secret", async () => {
  reset(); loginAsk = []; traces.length = 0;
  const { ctx } = makeCtx(null);
  await invoke("stamp_login", {}, { ...withTrace(ctx), agentLogin: askLogin });
  must(traces.length === 1 && traces[0].kind === "stamp.agent_login", JSON.stringify(traces));
  must(traces[0].status === "sealed" && traces[0].verdict === "ok", JSON.stringify(traces[0]));
  const text = JSON.stringify(traces[0]);
  // Not the session, not the challenge, and not the grant: a trace is read by people who are not the agent.
  for (const word of ["REFRESH-SELF", "ACCESS-SELF", loginAsk[0].challenge, ...[...grants.keys()]]) must(!text.includes(word), `the trace carries ${word}`);
  traces.length = 0;
  const { ctx: busy } = makeCtx(session());
  await refusal(invoke("stamp_login", {}, { ...withTrace(busy), agentLogin: askLogin }));
  must(traces.length === 1 && traces[0].status === "refused_credential" && traces[0].verdict === "blocked", JSON.stringify(traces));
});


for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
