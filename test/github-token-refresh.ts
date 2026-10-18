/**
 * Expiring GitHub user tokens (#935): the exchange keeps the refresh pair, a mount renews its token before it
 * expires and once after GitHub refuses it, concurrent callers share one renewal, a refused renewal marks the
 * connection as needing a reconnect (in D1, where `GET …/connections/github` reads it), a reconnect clears it, and
 * a token that does not expire is left exactly as it was.
 *
 * Real runtimes (one per agent object, each over its own SQLite), the real gateway and GitHub plugin, the real
 * migrations on node:sqlite for D1, and the real provider handlers. GitHub's token endpoint and API are a fake that
 * behaves as GitHub documents: a refresh token is single-use, and using it also ends the access token it came with.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent } from "../cf/src/provision/steps.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { d1ConnectorGrants, d1Connections, d1Connectors, d1ProvisionedAgents } from "../cf/src/control-plane.ts";
import { handleProvision, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import { githubExchangeCode, GITHUB_TOKEN } from "../cf/src/auth.ts";
import { OAUTH_PREFIX, RECONNECT_REASON } from "../cf/src/github-refresh.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 1500) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const TENANT = "t-raft";
const WHO = { label: "raft-prod", tenantId: TENANT, raftOrigin: "https://raft.example", scope: "tenant" as const };
const SPEC = { name: "Cody", instructions: "be brief", raftOrigin: WHO.raftOrigin, avatar: "0badcafe" };
const H = 3_600_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** Every line anything logged during the suite, to look for token values in. */
const logged: string[] = [];
setLogSink((line) => logged.push(line));
for (const k of ["log", "warn", "error", "info"] as const) {
  const was = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); if (k !== "log") return; was(...a); };
}

/** D1 as node:sqlite, with every migration in cf/migrations applied. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { raw: db, prepare: (q: string) => stmt(q) } as unknown as D1Database & { raw: DatabaseSync };
}

/**
 * GitHub as documented: a code or a refresh token buys a pair; a refresh token is single-use and spends the access
 * token issued with it. `expiring: false` is an App whose tokens do not expire. Every value it hands out is recorded,
 * so the suite can look for any of them in what was logged.
 */
function github(opts: { expiring?: boolean } = {}) {
  let n = 0;
  const live = new Set<string>();
  const refreshes = new Map<string, string>(); // refresh token -> the access token issued with it
  const issued: string[] = [];
  const s = { refreshes: 0, refused: 0, api: 0, unauthorized: 0, delayMs: 0, refuse: false, sent: [] as string[] };
  const pair = (expiring: boolean) => {
    n++;
    const access = `ghu_${String(n).padStart(4, "0")}${"a".repeat(36)}`;
    const refresh = `ghr_${String(n).padStart(4, "0")}${"r".repeat(72)}`;
    live.add(access); issued.push(access);
    if (!expiring) return { access_token: access, scope: "public_repo,read:org", token_type: "bearer" };
    refreshes.set(refresh, access); issued.push(refresh);
    return { access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, scope: "public_repo,read:org", token_type: "bearer" };
  };
  const fetchImpl = async (url: any, init?: any) => {
    const u = String(url);
    if (u === GITHUB_TOKEN) {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.grant_type === "refresh_token") {
        s.refreshes++;
        if (b.client_id !== "cid" || b.client_secret !== "csecret") return json({ error: "incorrect_client_credentials" });
        if (s.delayMs) await sleep(s.delayMs);
        const was = refreshes.get(b.refresh_token);
        if (s.refuse || was === undefined) { s.refused++; return json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }); }
        refreshes.delete(b.refresh_token); live.delete(was);
        return json(pair(true));
      }
      return json(pair(opts.expiring !== false));
    }
    if (u.startsWith("https://api.github.com/")) {
      s.api++;
      const token = new Headers(init?.headers ?? {}).get("authorization")?.replace(/^Bearer /, "") ?? "";
      s.sent.push(token);
      if (!live.has(token)) { s.unauthorized++; return json({ message: "Bad credentials" }, 401); }
      return json({ login: "octocat", id: 1 });
    }
    return json({ message: "Not Found" }, 404);
  };
  globalThis.fetch = fetchImpl as any;
  return { s, issued, live, refreshes, code: () => githubExchangeCode({ clientId: "cid", clientSecret: "csecret", redirectUri: "https://ap.example/login/github/callback" }, "c0de", fetchImpl as any) };
}

/** One D1, an agent object per Raft agent, and the provider handlers over both. */
async function world(opts: { expiring?: boolean; github?: boolean } = {}) {
  const db = d1();
  const gh = github(opts);
  const objects = new Map<string, { rt: AgentRuntime; host: ReturnType<typeof sqliteHost> }>();
  const registry = d1ProvisionedAgents(db);
  const propagated: string[] = [];
  const grants = d1ConnectorGrants(db);
  let ids = 0;
  const rtOf = (agentId: string) => objects.get(agentId)!.rt;
  async function agent(raftAgentId: string, twinOf?: { agentId: string }) {
    const agentId = twinOf?.agentId ?? `raft_${raftAgentId}`;
    const host = twinOf ? objects.get(twinOf.agentId)!.host : sqliteHost();
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
      bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
      secretKek: KEK,
      operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash" } as any),
      ...(opts.github === false ? {} : {
        github: {
          app: { clientId: "cid", clientSecret: "csecret" }, grants,
          // As cf/src/index.ts does it: every other agent pointed at the connector, in its own object.
          async propagate(tenantId: string, connectorId: string, fromAgentId: string) {
            for (const r of await d1Connections(db).boundTo(tenantId, connectorId)) {
              const row = await registry.get(tenantId, r);
              if (!row || row.agentId === fromAgentId) continue;
              propagated.push(row.agentId);
              await rtOf(row.agentId).adoptConnection(tenantId, row.agentId, "github", connectorId);
            }
          },
        },
      }),
    } as any);
    await rt.ready();
    // A second runtime over the same object's storage (the bench runtime is one): shared rows, separate memory.
    if (twinOf) return { rt, agentId, raftAgentId };
    must((await adoptProvisionedAgent(rt, TENANT, agentId, SPEC)).ok, "adopt");
    await registry.create({ tenantId: TENANT, raftAgentId, agentId, raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "Cody", instructions: "be brief", credentialHash: null, status: "active", pushRegistered: false, pushError: null } as any);
    objects.set(agentId, { rt, host });
    return { rt, agentId, raftAgentId };
  }
  const deps: ProvisionDeps = {
    now: () => Date.now(), registry, agent: {} as any,
    connections: {
      registry: d1Connections(db), connectors: d1Connectors(db), newId: () => `con_${++ids}`,
      attach: (t, a, _p, sealed, refresh) => rtOf(a).attachSealedConnection(t, a, "github", sealed, refresh ?? null),
      async link() { return { url: "https://ap.example/connect/start?t=x", expiresAt: new Date().toISOString() }; },
      detachIfFrom: (t, a, _p, sealed, connectorId) => rtOf(a).detachConnectionIfFrom(t, a, "github", sealed, connectorId ?? null),
      detach: (t, a) => rtOf(a).detachConnection(t, a, "github"),
      confirm: (t, a, _p, pending, user, connectorId) => rtOf(a).confirmConnection(t, a, "github", pending, user, connectorId ?? null),
    },
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: null }, body, WHO, deps);
    const text = r ? await r.text() : "";
    return { status: r?.status ?? 0, body: text ? JSON.parse(text) : null, text };
  };
  /** The whole Connect GitHub flow for one agent: the code exchanged, held in its object, confirmed by Raft. */
  async function connect(a: { rt: AgentRuntime; agentId: string; raftAgentId: string }, pending = `pend_${a.raftAgentId}_0001`) {
    const { grant } = await gh.code();
    await a.rt.holdConnection(TENANT, a.agentId, "github", grant, pending, Date.now() + 600_000, "u_owner");
    const r = await call("POST", `/agents/by-raft-agent/${a.raftAgentId}/connections/github/confirm`, { pending, raftUserId: "u_owner" });
    must(r.status === 200 && r.body.connected === true, `confirm: ${r.status} ${r.text}`);
    return r.body.connectorId as string;
  }
  const status = (raftAgentId: string) => call("GET", `/agents/by-raft-agent/${raftAgentId}/connections/github`);
  const tool = async (a: { rt: AgentRuntime; agentId: string }, name = "auth_status") =>
    a.rt.gateway().invoke({ tenantId: TENANT, agentId: a.agentId, taskId: "t1" }, `gh.${name}`, {});
  /** The mount's token as stored, and what renews it. */
  async function stored(a: { rt: AgentRuntime; agentId: string }) {
    const { importKek, open } = await import("../src/runtime/secrets.ts");
    const kek = await importKek(KEK);
    const tok = await a.rt.store.getSecret(TENANT, a.agentId, "gh");
    const rec = await a.rt.store.getSecret(TENANT, a.agentId, `${OAUTH_PREFIX}gh`);
    return { token: tok ? await open(kek, tok) : null, rec: rec ? JSON.parse(await open(kek, rec)) : null, kek, open };
  }
  /** Put a mount's recorded expiry (and its connector's) at `at`, as if that much time had passed. */
  async function expireAt(a: { rt: AgentRuntime; agentId: string }, at: number, connectorId?: string) {
    const { kek, rec } = await stored(a);
    const { seal } = await import("../src/runtime/secrets.ts");
    await a.rt.store.putSecret(TENANT, a.agentId, `${OAUTH_PREFIX}gh`, await seal(kek, JSON.stringify({ ...rec, expiresAt: at })));
    if (connectorId) db.raw.prepare("UPDATE connectors SET expires_at = ? WHERE id = ?").run(at, connectorId);
  }
  const dispose = () => { for (const o of objects.values()) o.host.dispose(); };
  return { db, gh, agent, connect, status, tool, stored, expireAt, call, grants, propagated, dispose };
}

const succeeded = (r: any) => r.status === "succeeded";
const errorText = (r: any) => JSON.stringify(r.error ?? r);

console.log(`\n  github token refresh (#935)\n  ${"─".repeat(56)}`);

await check("the exchange keeps the refresh pair and both lifetimes, and the connector and the mount keep them sealed", async () => {
  const w = await world();
  const { grant, keys } = await w.gh.code();
  must(grant.refreshToken?.startsWith("ghr_") && grant.expiresAt! > Date.now() + 7.9 * H && grant.refreshExpiresAt! > Date.now() + 180 * 24 * H, JSON.stringify({ ...grant, accessToken: "-", refreshToken: "-" }));
  must(keys.join(",") === "access_token,expires_in,refresh_token,refresh_token_expires_in,scope,token_type", `keys ${keys}`);
  const a = await w.agent("A1");
  const id = await w.connect(a);
  const row = w.db.raw.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as any;
  must(row.refresh_ciphertext && row.refresh_iv && row.expires_at > Date.now() + 7.9 * H && row.refresh_expires_at > Date.now() + 180 * 24 * H && row.broken_at === null, JSON.stringify(row));
  must(!JSON.stringify(row).includes("ghr_") && !JSON.stringify(row).includes("ghu_"), "a token is in the D1 row in the clear");
  const s = await w.stored(a);
  must(s.token?.startsWith("ghu_") && s.rec?.refreshToken?.startsWith("ghr_") && s.rec.connectorId === id && s.rec.expiresAt === row.expires_at, JSON.stringify({ ...s.rec, refreshToken: "-" }));
  must(await s.open(s.kek, { ciphertext: row.refresh_ciphertext, iv: row.refresh_iv }) === s.rec.refreshToken, "the connector and the mount hold different refresh tokens");
  must(succeeded(await w.tool(a)) && w.gh.s.refreshes === 0, "a fresh token was renewed, or did not work");
  w.dispose();
});

await check("a token within five minutes of its expiry is renewed before the call, and the call goes out with the new one", async () => {
  const w = await world();
  const a = await w.agent("A2");
  const id = await w.connect(a);
  const before = (await w.stored(a)).token;
  await w.expireAt(a, Date.now() + 60_000, id);
  const r = await w.tool(a);
  const after = await w.stored(a);
  must(succeeded(r), `the call failed: ${errorText(r)}`);
  must(w.gh.s.refreshes === 1 && w.gh.s.unauthorized === 0, `refreshes ${w.gh.s.refreshes}, 401s ${w.gh.s.unauthorized}`);
  must(after.token !== before && w.gh.s.sent.at(-1) === after.token, "the call did not use the renewed token");
  must(after.rec.expiresAt > Date.now() + 7.9 * H, "the new expiry was not stored");
  const row = w.db.raw.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as any;
  must(await after.open(after.kek, { ciphertext: row.ciphertext, iv: row.iv }) === after.token && row.refreshed_at, "the connector was not given the new pair");
  must(await after.open(after.kek, { ciphertext: row.refresh_ciphertext, iv: row.refresh_iv }) === after.rec.refreshToken, "the connector and the mount disagree on the refresh token");
  w.dispose();
});

await check("a 401 for a token not yet expired by our clock renews once and retries once", async () => {
  const w = await world();
  const a = await w.agent("A3");
  await w.connect(a);
  const before = (await w.stored(a)).token!;
  // Revoked behind our back, with the refresh token still good: what an outside renewal or a clock skew looks like.
  w.gh.live.delete(before);
  const api = w.gh.s.api;
  const r = await w.tool(a);
  must(succeeded(r), `the call failed: ${errorText(r)}`);
  must(w.gh.s.refreshes === 1 && w.gh.s.unauthorized === 1 && w.gh.s.api - api === 2, `refreshes ${w.gh.s.refreshes}, 401s ${w.gh.s.unauthorized}, calls ${w.gh.s.api - api}`);
  must(w.gh.s.sent.at(-2) === before && w.gh.s.sent.at(-1) === (await w.stored(a)).token, "the retry did not carry the renewed token");
  w.dispose();
});

await check("concurrent calls in one object, and an agent on the same connector in another, renew once and all use the rotated token", async () => {
  const w = await world();
  const a = await w.agent("A4");
  const b = await w.agent("B4");
  const id = await w.connect(a);
  const bound = await w.call("PUT", `/agents/by-raft-agent/B4/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  must(bound.status === 200, `bind: ${bound.text}`);
  await w.expireAt(a, Date.now() + 30_000, id);
  await w.expireAt(b, Date.now() + 30_000);
  w.gh.s.delayMs = 50;
  const calls = await Promise.all([w.tool(a), w.tool(a), w.tool(a, "auth_status"), w.tool(b), w.tool(b)]);
  must(calls.every(succeeded), `a call failed: ${calls.filter((c) => !succeeded(c)).map(errorText).join(" | ")}`);
  must(w.gh.s.refreshes === 1 && w.gh.s.refused === 0, `refreshes ${w.gh.s.refreshes}, refused ${w.gh.s.refused}`);
  const ta = (await w.stored(a)).token, tb = (await w.stored(b)).token;
  must(ta === tb && w.gh.live.has(ta!), "the agents hold different tokens, or a spent one");
  must(w.gh.s.sent.slice(-5).every((t) => t === ta), `a call went out with another token: ${w.gh.s.sent.slice(-5).map((t) => t.slice(0, 8))}`);
  w.dispose();
});

await check("two runtimes over one object's storage, renewing a mount with no connector, trade its refresh token once", async () => {
  const w = await world();
  const a = await w.agent("A11");
  const twin = await w.agent("A11", a);
  // Confirmed without a connector id: a connection whose pair lives on the mount alone, so no D1 lease is involved
  // and only the stored guard keeps the two runtimes from both spending the refresh token.
  const { grant } = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", grant, "pend_A11_00001", Date.now() + 600_000, "u_owner");
  must((await a.rt.confirmConnection(TENANT, a.agentId, "github", "pend_A11_00001", "u_owner")).ok, "confirm");
  must((await w.stored(a)).rec?.connectorId === null && (await w.stored(a)).rec?.refreshToken, "the mount does not hold its own pair");
  await w.expireAt(a, Date.now() + 30_000);
  w.gh.s.delayMs = 80;
  const calls = await Promise.all([w.tool(a), w.tool(twin), w.tool(a), w.tool(twin)]);
  must(calls.every(succeeded), `a call failed: ${calls.filter((c) => !succeeded(c)).map(errorText).join(" | ")}`);
  must(w.gh.s.refreshes === 1 && w.gh.s.refused === 0, `refreshes ${w.gh.s.refreshes}, refused ${w.gh.s.refused}`);
  w.dispose();
});

await check("a renewal by one agent reaches the other agents on the connector, so none of them is left holding the spent token", async () => {
  const w = await world();
  const a = await w.agent("A5");
  const b = await w.agent("B5");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/B5/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  await w.expireAt(a, Date.now() + 30_000, id);
  must(succeeded(await w.tool(a)) && w.gh.s.refreshes === 1, "a did not renew");
  must(w.propagated.join() === b.agentId, `propagated to ${w.propagated.join()}`);
  // b's sandbox would read the mount directly, with no 401 to learn from: the mount itself must hold the new token.
  must((await w.stored(b)).token === (await w.stored(a)).token, "b still holds the spent token");
  const unauthorized = w.gh.s.unauthorized;
  must(succeeded(await w.tool(b)) && w.gh.s.unauthorized === unauthorized && w.gh.s.refreshes === 1, "b's call needed a 401 or a renewal of its own");
  // A disconnect still takes the connector's renewed copy off b.
  const gone = await w.call("DELETE", `/connectors/${id}`, { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(gone.status === 200 && (await w.stored(b)).token === null && (await w.stored(b)).rec === null, `disconnect: ${gone.text}`);
  w.dispose();
});

await check("a refused renewal marks the connection as needing a reconnect: in D1 with an event, in GET, and in the tool result; a reconnect clears it", async () => {
  const w = await world();
  const a = await w.agent("A6");
  const id = await w.connect(a);
  must((await w.status("A6")).body.connected === true && (await w.status("A6")).body.oauthStatus === undefined, "a working connection says otherwise");
  await w.expireAt(a, Date.now() + 30_000, id);
  // Expired at GitHub as well, and its refresh token no longer taken.
  w.gh.live.delete((await w.stored(a)).token!);
  w.gh.s.refuse = true;
  const r = await w.tool(a);
  must(!succeeded(r), "the call succeeded on a dead connection");
  const text = errorText(r);
  must(text.includes(RECONNECT_REASON) && /must reconnect GitHub/.test(text) && /retrying will not help/.test(text), `the tool result does not say to reconnect: ${text}`);
  const row = w.db.raw.prepare("SELECT broken_at, broken_reason FROM connectors WHERE id = ?").get(id) as any;
  must(row.broken_at && /bad_refresh_token/.test(row.broken_reason), JSON.stringify(row));
  const ev = w.db.raw.prepare("SELECT * FROM connector_events WHERE connector_id = ? AND action = 'broken'").all(id) as any[];
  must(ev.length === 1 && ev[0].acting_role === "system" && /bad_refresh_token/.test(ev[0].reason) && !/gh[ur]_/.test(JSON.stringify(ev)), JSON.stringify(ev));
  const got = await w.status("A6");
  must(got.body.connected === false && got.body.oauthStatus === "error" && got.body.oauthError === RECONNECT_REASON && got.body.account === "octocat" && got.body.connectorId === id, got.text);
  must(got.body.connectors[0].oauthStatus === "error" && !/gh[ur]_/.test(got.text), got.text);
  // Asked again, it does not go back to GitHub: the mount knows.
  const refreshes = w.gh.s.refreshes;
  must(!succeeded(await w.tool(a)) && w.gh.s.refreshes === refreshes, "a broken connection asked GitHub again");
  // Connecting again is the mend.
  w.gh.s.refuse = false;
  const again = await w.connect(a, "pend_A6_again_01");
  const mended = await w.status("A6");
  must(mended.body.connected === true && mended.body.oauthStatus === undefined && mended.body.connectorId === again, mended.text);
  must(succeeded(await w.tool(a)), "the reconnected agent's call failed");
  w.dispose();
});

await check("a connection with no connector (made before connectors) is marked on its own row, GET reports it, and a reconnect clears it", async () => {
  const w = await world();
  const a = await w.agent("A12");
  const { grant } = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", grant, "pend_A12_00001", Date.now() + 600_000, "u_owner");
  must((await a.rt.confirmConnection(TENANT, a.agentId, "github", "pend_A12_00001", "u_owner")).ok, "confirm");
  await d1Connections(w.db).put({ tenantId: TENANT, raftAgentId: "A12", provider: "github", account: "octocat", connectedBy: "u_owner", connectedAt: Date.now(), connectorId: null });
  must((await w.status("A12")).body.connected === true, "not connected to begin with");
  await w.expireAt(a, Date.now() + 30_000);
  w.gh.live.delete((await w.stored(a)).token!);
  w.gh.s.refuse = true;
  must(!succeeded(await w.tool(a)), "the call succeeded on a dead connection");
  const row = w.db.raw.prepare("SELECT broken_at, broken_reason FROM provisioned_connections WHERE raft_agent_id = 'A12'").get() as any;
  must(row.broken_at && /bad_refresh_token/.test(row.broken_reason), JSON.stringify(row));
  const got = await w.status("A12");
  must(got.body.connected === false && got.body.oauthStatus === "error" && got.body.oauthError === RECONNECT_REASON && got.body.connectorId === null, got.text);
  w.gh.s.refuse = false;
  await w.connect(a, "pend_A12_again_1");
  const mended = await w.status("A12");
  must(mended.body.connected === true && mended.body.oauthStatus === undefined, mended.text);
  must((w.db.raw.prepare("SELECT broken_at FROM provisioned_connections WHERE raft_agent_id = 'A12'").get() as any).broken_at === null, "the row still says broken");
  w.dispose();
});

await check("a 401 that persists after a renewal is GitHub's verdict: the connection is marked, once", async () => {
  const w = await world();
  const a = await w.agent("A7");
  const id = await w.connect(a);
  // Every token refused, renewed or not: an App authorisation the person revoked.
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).startsWith("https://api.github.com/")) { w.gh.s.api++; w.gh.s.unauthorized++; return json({ message: "Bad credentials" }, 401); }
    return real(url, init);
  }) as any;
  const api = w.gh.s.api;
  const r = await w.tool(a);
  must(!succeeded(r) && errorText(r).includes(RECONNECT_REASON), `the result: ${errorText(r)}`);
  must(w.gh.s.refreshes === 1 && w.gh.s.api - api === 2, `refreshes ${w.gh.s.refreshes}, calls ${w.gh.s.api - api}`);
  const got = await w.status("A7");
  must(got.body.connected === false && got.body.oauthStatus === "error", got.text);
  must((w.db.raw.prepare("SELECT count(*) AS n FROM connector_events WHERE connector_id = ? AND action = 'broken'").get(id) as any).n === 1, "not one event");
  globalThis.fetch = real;
  w.dispose();
});

await check("a token that does not expire is kept as it came: nothing renews it, and a 401 reads as it always has", async () => {
  const w = await world({ expiring: false });
  const a = await w.agent("A8");
  const id = await w.connect(a);
  const row = w.db.raw.prepare("SELECT refresh_ciphertext, expires_at FROM connectors WHERE id = ?").get(id) as any;
  must(row.refresh_ciphertext === null && row.expires_at === null, JSON.stringify(row));
  must((await w.stored(a)).rec === null, "a non-expiring token got a renewal record");
  must(succeeded(await w.tool(a)), "the call failed");
  w.gh.live.clear();
  const api = w.gh.s.api;
  const r = await w.tool(a);
  const text = errorText(r);
  must(!succeeded(r) && /refused that credential itself/.test(text) && !text.includes(RECONNECT_REASON), text);
  must(w.gh.s.refreshes === 0 && w.gh.s.api - api === 1, `refreshes ${w.gh.s.refreshes}, calls ${w.gh.s.api - api}`);
  must((await w.status("A8")).body.connected === true, "a non-expiring connection was marked");
  w.dispose();
});

await check("a deployment that cannot renew (no GitHub App wired into the object) keeps today's behaviour", async () => {
  const w = await world({ github: false });
  const a = await w.agent("A9");
  await w.connect(a);
  w.gh.live.clear();
  const r = await w.tool(a);
  must(!succeeded(r) && /refused that credential itself/.test(errorText(r)) && w.gh.s.refreshes === 0, errorText(r));
  w.dispose();
});

await check("a key pasted over a connection is renewed by nothing: what renewed the connection's token goes", async () => {
  const w = await world();
  const a = await w.agent("A10");
  await w.connect(a);
  const { grant } = await w.gh.code();
  must((await a.rt.attachCredential(TENANT, a.agentId, "gh", { token: grant.accessToken })).ok, "the pasted key was refused");
  must((await w.stored(a)).rec === null, "the connection's renewal record outlived the key it renewed");
  w.dispose();
});

await check("nothing logged carries a token value: not the exchange's, a renewal's, or a refusal's", async () => {
  // Every scenario above has run with every log line and console line captured.
  const values = new Set<string>();
  for (const line of logged) for (const m of line.matchAll(/gh[ur]_[A-Za-z0-9]{8,}/g)) values.add(m[0]);
  must(values.size === 0, `logged: ${[...values].map((v) => v.slice(0, 10)).join(", ")}`);
  // And the lines that should be there are: the exchange's keys and the renewals' outcomes.
  must(logged.some((l) => /"evt":"github.refresh"/.test(l) && /"outcome":"rotated"/.test(l)), "no renewal was logged");
  must(logged.some((l) => /"evt":"github.refresh"/.test(l) && /"outcome":"broken"/.test(l)), "no broken connection was logged");
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
