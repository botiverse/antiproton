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
import { d1ConnectorGrants, d1Connections, d1Connectors, d1ProvisionedAgents, renewalAudience } from "../cf/src/control-plane.ts";
import { handleProvision, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import { githubExchangeCode, GITHUB_TOKEN } from "../cf/src/auth.ts";
import { OAUTH_PREFIX, RECONNECT_REASON, reasonCode } from "../cf/src/github-refresh.ts";
import { setLogSink } from "../src/core/log.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { forwardRow } from "../cf/src/trace-forward.ts";

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
  const s = { refreshes: 0, refused: 0, api: 0, unauthorized: 0, delayMs: 0, refuse: false, sent: [] as string[],
    /** Something other than GitHub's own answer at the token endpoint: an HTML error page, say. */
    tokenAnswer: null as null | (() => Response),
    /** Who the person signing in at GitHub is: the account the next code's tokens act as. A refresh keeps its pair's. */
    as: { login: "octocat", id: 1 } as { login: string; id: number },
    /** How many of the next `GET /user` calls answer 503, as an outage would. */
    failUser: 0 };
  const owner = new Map<string, { login: string; id: number }>(); // access token -> the account it acts as
  const pair = (expiring: boolean, who = s.as) => {
    n++;
    const access = `ghu_${String(n).padStart(4, "0")}${"a".repeat(36)}`;
    const refresh = `ghr_${String(n).padStart(4, "0")}${"r".repeat(72)}`;
    live.add(access); issued.push(access); owner.set(access, { ...who });
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
        if (s.tokenAnswer) return s.tokenAnswer();
        const was = refreshes.get(b.refresh_token);
        if (s.refuse || was === undefined) { s.refused++; return json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }); }
        refreshes.delete(b.refresh_token); live.delete(was);
        return json(pair(true, owner.get(was)));
      }
      return json(pair(opts.expiring !== false));
    }
    if (u.startsWith("https://api.github.com/")) {
      s.api++;
      const token = new Headers(init?.headers ?? {}).get("authorization")?.replace(/^Bearer /, "") ?? "";
      s.sent.push(token);
      // An endpoint that wants an App's JWT refuses any user token, live or not.
      if (u.startsWith("https://api.github.com/app")) { s.unauthorized++; return json({ message: "A JSON web token could not be decoded" }, 401); }
      if (!live.has(token)) { s.unauthorized++; return json({ message: "Bad credentials" }, 401); }
      if (u === "https://api.github.com/user" && s.failUser > 0) { s.failUser--; return json({ message: "Service Unavailable" }, 503); }
      return json(owner.get(token) ?? { login: "octocat", id: 1 });
    }
    return json({ message: "Not Found" }, 404);
  };
  globalThis.fetch = fetchImpl as any;
  return { s, issued, live, refreshes, code: () => githubExchangeCode({ clientId: "cid", clientSecret: "csecret", redirectUri: "https://ap.example/login/github/callback" }, "c0de", fetchImpl as any) };
}

/** One D1, an agent object per Raft agent, and the provider handlers over both. */
/**
 * run9, as far as a box's GitHub access goes: boxes, commands, the egress registrations on a box, and the box's
 * egress itself. run9 keeps a registration's value and, on a request leaving the box for one of its hosts, swaps the
 * placeholder in the named header for it (`egress`), with no call back to antiproton: so what a box can do with the
 * agent's token is decided by what is registered on it when it sends, and nothing else. `failDelete`: run9 refuses
 * to delete the box (an outage, a refusal); `failWithdraw`: it refuses to remove a registration.
 */
function run9Fake() {
  type Secret = { secret_id: string; name: string; value: string; placeholder: string; inject_header_name: string; allowed_hosts: string[] };
  const boxes = new Map<string, { state: string; secrets: Secret[] }>();
  const ws = "https://api.run.sys9.ai/projects/default/workspace";
  let n = 0;
  // `ignoreWithdraw`: it answers a removal 200 and keeps the registration (a removal taken but not applied).
  const f = { failDelete: false, failWithdraw: false, ignoreWithdraw: false };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const path = url.startsWith(ws) ? url.slice(ws.length).split("?")[0]! : url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/boxes") { boxes.set(body.box_id, { state: "running", secrets: [] }); return json({ box_id: body.box_id }); }
    if (method === "GET" && path === "/boxes") return json([...boxes].map(([box_id, b]) => ({ box_id, state: b.state })));
    if ((m = path.match(/^\/boxes\/([^/]+)\/background-execs$/)) && method === "POST") {
      if (!boxes.has(m[1]!)) return json({ message: "no such box" }, 404);
      return json({ exec_id: `e${++n}` });
    }
    if ((m = path.match(/^\/execs\/([^/]+)$/))) return json({ state: "succeeded", exit_code: 0, output_summary: "" });
    if ((m = path.match(/^\/execs\/([^/]+)\/kill$/))) return json({});
    if ((m = path.match(/^\/boxes\/([^/]+)\/secrets$/))) {
      const b = boxes.get(m[1]!);
      if (!b) return json({ message: "no such box" }, 404);
      if (method === "POST") {
        b.secrets.push({ secret_id: `s${++n}`, name: body.name, value: body.value, placeholder: body.placeholder, inject_header_name: body.inject_header_name, allowed_hosts: body.allowed_hosts });
        return json({});
      }
      return json(b.secrets.map((x) => ({ name: x.name, secret_id: x.secret_id })));
    }
    if ((m = path.match(/^\/boxes\/([^/]+)\/secrets\/([^/]+)$/)) && method === "DELETE") {
      const b = boxes.get(m[1]!);
      if (!b) return json({ message: "no such box" }, 404);
      if (f.failWithdraw) return json({ message: "run9 is unavailable" }, 503);
      if (!f.ignoreWithdraw) b.secrets = b.secrets.filter((x) => x.secret_id !== m![2]);
      return json({});
    }
    if ((m = path.match(/^\/boxes\/([^/]+)\/stop$/))) { const b = boxes.get(m[1]!); if (b) b.state = "stopped"; return json({}); }
    if ((m = path.match(/^\/boxes\/([^/]+)$/)) && method === "DELETE") {
      if (f.failDelete) return json({ message: "run9 is unavailable" }, 503);
      boxes.delete(m[1]!);
      return json({});
    }
    return json({});
  }
  /** A request leaving `boxId` for `url` with `headers`, as run9's egress forwards it. Null: there is no such box. */
  function egress(boxId: string, url: string, headers: Record<string, string>): Record<string, string> | null {
    const b = boxes.get(boxId);
    if (!b) return null;
    const host = new URL(url).hostname;
    const out = { ...headers };
    for (const s of b.secrets) {
      if (!s.allowed_hosts.includes(host)) continue;
      const k = Object.keys(out).find((h) => h.toLowerCase() === s.inject_header_name.toLowerCase());
      if (k && out[k]!.includes(s.placeholder)) out[k] = out[k]!.replaceAll(s.placeholder, s.value);
    }
    return out;
  }
  return { boxes, handle, egress, f };
}

async function world(opts: { expiring?: boolean; github?: boolean; run9?: ReturnType<typeof run9Fake> } = {}) {
  const db = d1();
  const gh = github(opts);
  if (opts.run9) {
    const inner = globalThis.fetch, run9 = opts.run9;
    globalThis.fetch = ((u: unknown, i?: RequestInit) => String(u).startsWith("https://api.run.sys9.ai") ? run9.handle(String(u), i) : inner(u as any, i)) as typeof fetch;
  }
  const objects = new Map<string, { rt: AgentRuntime; host: ReturnType<typeof sqliteHost> }>();
  const registry = d1ProvisionedAgents(db);
  const propagated: string[] = [];
  /** What an object handed to waitUntil: propagation, which the renewing call does not wait for. */
  const pending: Promise<unknown>[] = [];
  let propagateDelayMs = 0;
  const settle = async () => { while (pending.length) await pending.shift(); };
  const grants = d1ConnectorGrants(db);
  let ids = 0;
  const links: any[] = [];
  /**
   * How an agent's object answers the delete's mount clear, when not as itself: it does not answer, it refuses (a
   * background task holds the mount), or it holds no such agent (its storage wiped).
   */
  const clearMode = new Map<string, "unreachable" | "refused" | "gone">();
  /** Run after an agent's mount is given a connection, before its binding is written: a DELETE landing in between. */
  const hooks: { afterAttach?: (agentId: string) => Promise<void> } = {};
  const rtOf = (agentId: string) => objects.get(agentId)!.rt;
  async function agent(raftAgentId: string, twinOf?: { agentId: string }) {
    const agentId = twinOf?.agentId ?? `raft_${raftAgentId}`;
    const host = twinOf ? objects.get(twinOf.agentId)!.host : sqliteHost();
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as any,
      bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
      secretKek: KEK,
      ...(opts.run9 ? { operatorRun9: { ak: "ak", sk: "sk" } } : {}),
      operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash" } as any),
      ...(opts.github === false ? {} : {
        github: {
          app: { clientId: "cid", clientSecret: "csecret" }, grants,
          // As cf/src/index.ts does it: every other agent the renewal audience names, in its own object.
          async propagate(tenantId: string, connectorId: string, fromAgentId: string) {
            for (const agentId of (await renewalAudience(db, tenantId, connectorId)).to) {
              if (agentId === fromAgentId) continue;
              propagated.push(agentId);
              if (propagateDelayMs) await sleep(propagateDelayMs);
              await rtOf(agentId).adoptConnection(tenantId, agentId, "github", connectorId);
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
    now: () => Date.now(), registry,
    // An agent's DELETE only: its push and its Raft credential, which these tests do not hold.
    agent: {
      tool: async () => ({ ok: true, result: {} }), removeCredential: async () => true,
      stopTurn: (t: string, a: string, trigger: any) => rtOf(a).stopTurn(t, a, trigger),
      releaseForDelete: (t: string, a: string) => rtOf(a).releaseForDelete(t, a),
    } as any,
    connections: {
      registry: d1Connections(db), connectors: d1Connectors(db), newId: () => `con_${++ids}`,
      attach: async (t, a, _p, sealed, refresh) => {
        const r = await rtOf(a).attachSealedConnection(t, a, "github", sealed, refresh ?? null);
        await hooks.afterAttach?.(a);
        return r;
      },
      async link(spec) { links.push(spec); return { url: "https://ap.example/connect/start?t=x", expiresAt: new Date().toISOString() }; },
      reconnect: (t, a, _p, connectorId, was, sealed, refresh) => rtOf(a).reconnectConnection(t, a, "github", connectorId, was, sealed, refresh),
      detachIfFrom: async (t, a, _p, sealed, connectorId) => {
        const mode = clearMode.get(a);
        if (mode === "unreachable") throw new Error("the agent's object did not answer");
        if (mode === "refused") return { ok: false, error: "gh is held by a background task" };
        return rtOf(a).detachConnectionIfFrom(t, mode === "gone" ? `${a}_wiped` : a, "github", sealed, connectorId ?? null);
      },
      detach: (t, a) => rtOf(a).detachConnection(t, a, "github"),
      clear: async (t, a) => {
        const mode = clearMode.get(a);
        if (mode === "unreachable") throw new Error("the agent's object did not answer");
        if (mode === "refused") return { ok: false, error: "gh is held by a background task" };
        // Wiped: the object is asked for an agent it does not hold.
        return rtOf(a).clearConnection(t, mode === "gone" ? `${a}_wiped` : a, "github");
      },
      confirm: async (t, a, _p, pending, user, connectorId) => {
        const r = await rtOf(a).confirmConnection(t, a, "github", pending, user, connectorId ?? null);
        await hooks.afterAttach?.(a);
        return r;
      },
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
  /**
   * Reconnect in place from one agent's page: the link asked for with the connector (the handler's checks), the code
   * exchanged as whoever `gh.s.as` is, held with the link's own `reconnect` as connect.ts carries it, and confirmed.
   */
  async function reconnect(a: { rt: AgentRuntime; agentId: string; raftAgentId: string }, connectorId: string,
    by: { raftUserId?: string; actingRole?: "creator" | "admin" } = {}, pending = `pend_${a.raftAgentId}_re${links.length}`) {
    const raftUserId = by.raftUserId ?? "u_owner";
    const asked = await call("POST", `/agents/by-raft-agent/${a.raftAgentId}/connections/github`,
      { returnUrl: `${WHO.raftOrigin}/agents/${a.raftAgentId}`, initiatedBy: { raftUserId }, connectorId, actingRole: by.actingRole ?? "creator" });
    if (asked.status !== 200) return asked;
    const { grant } = await gh.code();
    await a.rt.holdConnection(TENANT, a.agentId, "github", grant, pending, Date.now() + 600_000, raftUserId, links.at(-1).reconnect ?? null);
    return call("POST", `/agents/by-raft-agent/${a.raftAgentId}/connections/github/confirm`, { pending, raftUserId });
  }
  const status = (raftAgentId: string) => call("GET", `/agents/by-raft-agent/${raftAgentId}/connections/github`);
  const tool = async (a: { rt: AgentRuntime; agentId: string }, name = "auth_status", args: Record<string, unknown> = {}) =>
    a.rt.gateway().invoke({ tenantId: TENANT, agentId: a.agentId, taskId: "t1" }, `gh.${name}`, args as any);
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
  /** As if the connector's pair (and a mount's own) were renewed long ago, not moments ago at the connect. */
  async function age(a: { rt: AgentRuntime; agentId: string }, connectorId?: string) {
    const { kek, rec } = await stored(a);
    const { seal } = await import("../src/runtime/secrets.ts");
    await a.rt.store.putSecret(TENANT, a.agentId, `${OAUTH_PREFIX}gh`, await seal(kek, JSON.stringify({ ...rec, rotatedAt: Date.now() - 2 * H })));
    if (connectorId) db.raw.prepare("UPDATE connectors SET refreshed_at = ? WHERE id = ?").run(Date.now() - 2 * H, connectorId);
  }
  /** The `github.refresh` rows in an agent's trace outbox, as the export will carry them (#980). */
  const traced = (a: { agentId: string }) => pendingTrace(objects.get(a.agentId)!.host.sql as any, 0).rows.filter((r) => r.kind === "github.refresh");
  const dispose = () => { for (const o of objects.values()) o.host.dispose(); };
  const sandbox = (a: { rt: AgentRuntime; agentId: string }, command = "true") =>
    a.rt.gateway().invoke({ tenantId: TENANT, agentId: a.agentId, taskId: "t1" }, "sandbox.shell", { command } as any);
  return { db, gh, agent, connect, sandbox, reconnect, links, status, tool, stored, expireAt, age, call, grants, propagated, settle, dispose, traced, clearMode, hooks,
    delayPropagation: (ms: number) => { propagateDelayMs = ms; } };
}

const succeeded = (r: any) => r.status === "succeeded";
const errorText = (r: any) => JSON.stringify(r.error ?? r);
/** The only attrs a `github.refresh` trace row may carry: ids and fixed codes. */
const TRACE_ATTRS = new Set(["scope", "connectorId", "mount", "why", "attempt", "stored", "reasonCode"]);
/** Rows that carry nothing but what TRACE_ATTRS allows, no token, and none of `words` (a reason's own text). */
function clean(rows: Array<{ attrs: Record<string, unknown> }>, words: string[] = []) {
  const text = JSON.stringify(rows);
  must(!/gh[ur]_/.test(text), `a token is in a trace row: ${text.replace(/gh[ur]_[A-Za-z0-9]+/g, "<token>")}`);
  for (const w of words) must(!text.includes(w), `a reason's text is in a trace row: ${w}`);
  for (const r of rows) for (const k of Object.keys(r.attrs)) must(TRACE_ATTRS.has(k), `a trace row carries ${k}`);
}

console.log(`\n  github token refresh (#935)\n  ${"─".repeat(56)}`);

await check("the exchange keeps the refresh pair and both lifetimes, and the connector and the mount keep them sealed", async () => {
  const w = await world();
  const { grant, keys } = await w.gh.code();
  must(grant.refreshToken?.startsWith("ghr_") && grant.expiresAt! > Date.now() + 7.9 * H && grant.refreshExpiresAt! > Date.now() + 180 * 24 * H, JSON.stringify({ ...grant, accessToken: "-", refreshToken: "-" }));
  must(keys.join(",") === "access_token,expires_in,refresh_token,refresh_token_expires_in,scope,token_type", `keys ${keys}`);
  const a = await w.agent("A1");
  const none = await w.status("A1");
  must(none.body.connected === false && none.body.oauthStatus === "disconnected" && none.body.lastCheckError === null && none.body.lastCheckedAt === null, none.text);
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
  // A renewal is a check: lastCheckedAt is its time, success or not.
  must(row.last_checked_at === row.refreshed_at && (await w.status("A2")).body.lastCheckedAt === new Date(row.refreshed_at).toISOString(), `last_checked_at ${row.last_checked_at}, refreshed_at ${row.refreshed_at}`);
  // The renewal is in the agent's trace as well as its log (#980): the connector's rotation and the mount's.
  const rows = w.traced(a);
  const seen = rows.map((r) => `${r.attrs.scope}:${r.status}:${r.verdict}`).sort().join(" ");
  must(seen === "connector:rotated:ok mount:rotated:ok", `trace: ${seen}`);
  must(rows.every((r) => r.attrs.connectorId === id && r.attrs.why === "expiring" && r.attrs.mount === "gh" && r.tenantId === TENANT && r.agentId === a.agentId), JSON.stringify(rows));
  must(rows.find((r) => r.attrs.scope === "connector")!.attrs.stored === true, "the rotation's row does not say the pair was stored");
  clean(rows);
  // The writer's attrs as the forwarder reads them (cf/src/trace-forward.ts): a renamed attr would arrive as null.
  // The mount goes as its type, never its alias (cf/src/trace-forward.ts `MountsView`).
  const MOUNTS = new Map([["gh", { plugin: "github", index: 0 }]]);
  const fwd = rows.map((r) => forwardRow(r, "preview", MOUNTS));
  must(fwd.every((f) => f.outcome === "rotated" && f.connector_id === id && f.why === "expiring" && f.mount === "github" && (f.scope === "connector" || f.scope === "mount")),
    `forwarded: ${JSON.stringify(fwd)}`);
  must(fwd.find((f) => f.scope === "connector")!.stored === true, `forwarded: ${JSON.stringify(fwd)}`);
  // Every attr the writer may set has a column, so nothing it records is silently left behind.
  const sample: Record<string, unknown> = { scope: "mount", connectorId: "c", mount: "gh", why: "w", attempt: 2, stored: false, reasonCode: "no-answer" };
  const filled = (attrs: Record<string, unknown>) => Object.values(forwardRow({ ...rows[0]!, attrs }, "preview", MOUNTS)).filter((v) => v !== null).length;
  for (const k of TRACE_ATTRS) must(k in sample && filled({ [k]: sample[k] }) === filled({}) + 1, `the trace attr ${k} has no column in a forwarded row`);
  w.dispose();
});

await check("a 401 for a token not yet expired by our clock renews once and retries once", async () => {
  const w = await world();
  const a = await w.agent("A3");
  await w.age(a, await w.connect(a));
  const before = (await w.stored(a)).token!;
  // Revoked behind our back, with the refresh token still good: what an outside renewal or a clock skew looks like.
  w.gh.live.delete(before);
  const api = w.gh.s.api;
  const r = await w.tool(a);
  must(succeeded(r), `the call failed: ${errorText(r)}`);
  // The call, GET /user confirming the token is dead, then the retry.
  must(w.gh.s.refreshes === 1 && w.gh.s.unauthorized === 2 && w.gh.s.api - api === 3, `refreshes ${w.gh.s.refreshes}, 401s ${w.gh.s.unauthorized}, calls ${w.gh.s.api - api}`);
  must(w.gh.s.sent.at(-3) === before && w.gh.s.sent.at(-2) === before && w.gh.s.sent.at(-1) === (await w.stored(a)).token, "the retry did not carry the renewed token");
  w.dispose();
});

await check("concurrent calls in one object, and an agent on the same connector in another, renew once and all use the rotated token", async () => {
  const w = await world();
  const a = await w.agent("A4");
  const b = await w.agent("B4");
  const id = await w.connect(a);
  w.db.raw.prepare("UPDATE connectors SET last_checked_at = 1 WHERE id = ?").run(id);
  const bound = await w.call("PUT", `/agents/by-raft-agent/B4/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  must(bound.status === 200, `bind: ${bound.text}`);
  const checked = (w.db.raw.prepare("SELECT created_at, last_checked_at FROM connectors WHERE id = ?").get(id) as any);
  must(checked.last_checked_at >= checked.created_at && checked.last_checked_at > 1 && Date.parse((await w.status("B4")).body.lastCheckedAt) === checked.last_checked_at, `pointing an agent at it is a check: ${JSON.stringify(checked)}`);
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
  await w.settle();
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
  const before = await w.status("A6");
  must(before.body.connected === true && before.body.oauthStatus === "connected" && before.body.lastCheckError === null && before.body.lastCheckedAt, `a working connection says otherwise: ${before.text}`);
  must(before.body.connectors[0].oauthStatus === "connected" && before.body.connectors[0].lastCheckError === null, before.text);
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
  must(got.body.connected === false && got.body.oauthStatus === "error" && got.body.lastCheckError === RECONNECT_REASON && got.body.account === "octocat" && got.body.connectorId === id, got.text);
  must(got.body.lastCheckedAt === new Date(row.broken_at).toISOString() && got.body.lastCheckedAt > before.body.lastCheckedAt, `lastCheckedAt ${got.body.lastCheckedAt}`);
  must(got.body.connectors[0].oauthStatus === "error" && got.body.connectors[0].lastCheckError === RECONNECT_REASON && !/gh[ur]_/.test(got.text), got.text);
  must(!("oauthError" in got.body) && !("oauthErrorAt" in got.body), "the old field names are still sent");
  // In the trace (#980): the refusal, as GitHub's code and never GitHub's words.
  const broken = w.traced(a).filter((r) => r.status === "broken");
  must(broken.length >= 1 && broken.every((r) => r.verdict === "failed" && r.attrs.reasonCode === "oauth:bad_refresh_token" && r.attrs.connectorId === id),
    `trace: ${JSON.stringify(broken)}`);
  must(broken.some((r) => r.attrs.scope === "connector"), "the connector's refusal is not in the trace");
  clean(broken, ["The refresh token passed is incorrect"]);
  // Asked again, it does not go back to GitHub: the mount knows.
  const refreshes = w.gh.s.refreshes;
  must(!succeeded(await w.tool(a)) && w.gh.s.refreshes === refreshes, "a broken connection asked GitHub again");
  // Connecting again is the mend.
  w.gh.s.refuse = false;
  const again = await w.connect(a, "pend_A6_again_01");
  const mended = await w.status("A6");
  must(mended.body.connected === true && mended.body.oauthStatus === "connected" && mended.body.lastCheckError === null && mended.body.connectorId === again, mended.text);
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
  must(got.body.connected === false && got.body.oauthStatus === "error" && got.body.lastCheckError === RECONNECT_REASON && got.body.connectorId === null, got.text);
  w.gh.s.refuse = false;
  await w.connect(a, "pend_A12_again_1");
  const mended = await w.status("A12");
  must(mended.body.connected === true && mended.body.oauthStatus === "connected", mended.text);
  must((w.db.raw.prepare("SELECT broken_at FROM provisioned_connections WHERE raft_agent_id = 'A12'").get() as any).broken_at === null, "the row still says broken");
  w.dispose();
});

await check("a 401 from an endpoint that refuses user tokens (/app), for a live token, never rotates: GET /user says it is alive", async () => {
  const w = await world();
  const a = await w.agent("A7");
  const id = await w.connect(a);
  await w.age(a, id);
  const before = (await w.stored(a)).token;
  for (let i = 0; i < 5; i++) {
    const api = w.gh.s.api;
    const r = await w.tool(a, "api_get", { path: "/app" });
    const text = errorText(r);
    must(!succeeded(r) && /github 401/.test(text) && !text.includes(RECONNECT_REASON), `the result: ${text}`);
    must(w.gh.s.api - api === 2 && w.gh.s.sent.at(-1) === before, `call ${i}: ${w.gh.s.api - api} requests, the last not GET /user with the same token`);
  }
  must(w.gh.s.refreshes === 0 && (await w.stored(a)).token === before, `rotated: ${w.gh.s.refreshes}`);
  const got = await w.status("A7");
  must(got.body.connected === true && got.body.oauthStatus === "connected" && got.body.lastCheckError === null, got.text);
  must((w.db.raw.prepare("SELECT count(*) AS n FROM connector_events WHERE connector_id = ? AND action = 'broken'").get(id) as any).n === 0, "a broken event was written");
  w.dispose();
});

await check("a 401 that persists after a renewal (a dead token on /app) is an ordinary error: the connection stays healthy and is not renewed again", async () => {
  const w = await world();
  const a = await w.agent("A7b");
  const id = await w.connect(a);
  await w.age(a, id);
  const before = (await w.stored(a)).token!;
  w.gh.live.delete(before);
  const r = await w.tool(a, "api_get", { path: "/app" });
  const text = errorText(r);
  must(!succeeded(r) && /github 401/.test(text) && !text.includes(RECONNECT_REASON), `the result: ${text}`);
  must(w.gh.s.refreshes === 1 && (await w.stored(a)).token !== before && !(await w.stored(a)).rec.brokenAt, "not renewed once, or marked");
  must((await w.status("A7b")).body.oauthStatus === "connected", "the connection was marked");
  must(!succeeded(await w.tool(a, "api_get", { path: "/app" })) && w.gh.s.refreshes === 1, `renewed again: ${w.gh.s.refreshes}`);
  must(succeeded(await w.tool(a)), "an ordinary call failed afterwards");
  w.dispose();
});

for (const [label, answer] of [
  ["a 403 HTML page", () => new Response("<html><body>Forbidden</body></html>", { status: 403, headers: { "content-type": "text/html" } })],
  ["a 200 HTML page", () => new Response("<html><body>Please wait</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
  ["a 400 JSON body with no error code", () => json({ message: "oops" }, 400)],
] as const) {
  await check(`a token endpoint answering ${label} is no verdict: nothing is marked, and the call reports its 401`, async () => {
    const w = await world();
    const a = await w.agent("A13");
    const id = await w.connect(a);
    await w.expireAt(a, Date.now() + 30_000, id);
    w.gh.live.delete((await w.stored(a)).token!);
    w.gh.s.tokenAnswer = answer;
    const r = await w.tool(a);
    must(!succeeded(r) && !errorText(r).includes(RECONNECT_REASON), errorText(r));
    const row = w.db.raw.prepare("SELECT broken_at, refreshing_until FROM connectors WHERE id = ?").get(id) as any;
    must(row.broken_at === null && row.refreshing_until === null, JSON.stringify(row));
    must(!(await w.stored(a)).rec.brokenAt && (await w.status("A13")).body.oauthStatus === "connected", "marked broken");
    // GitHub answering again is all it takes.
    w.gh.s.tokenAnswer = null;
    must(succeeded(await w.tool(a)), "the connection did not recover once GitHub answered");
    w.dispose();
  });
}

await check("a refusal that lost its lease to a renewal that landed does not mark the connector, and the mount takes the good pair", async () => {
  const w = await world();
  const a = await w.agent("A20");
  const id = await w.connect(a);
  // At the D1 level: once another renewal has stored a new pair, marking with the spent token changes nothing.
  const spent = (await w.grants.grant(TENANT, id, a.agentId))!.refresh!.sealed.ciphertext;
  const { seal } = await import("../src/runtime/secrets.ts");
  const { kek } = await w.stored(a);
  const landB = async () => {
    const { grant } = await w.gh.code();
    const k = (await w.grants.grant(TENANT, id, a.agentId))!;
    must(await w.grants.rotate(TENANT, id, { sealed: await seal(kek, grant.accessToken), refresh: { sealed: await seal(kek, grant.refreshToken!), expiresAt: grant.expiresAt, refreshExpiresAt: grant.refreshExpiresAt }, at: Date.now() }, k.refresh!.sealed.ciphertext, "B"), "B's rotation did not land");
    return grant.accessToken;
  };
  const bToken = await landB();
  must(!(await w.grants.markBroken(TENANT, id, "bad_refresh_token", Date.now(), "A", spent)), "a stale markBroken landed");
  must((await w.grants.grant(TENANT, id, a.agentId))!.brokenAt === null, "the connector was marked over a good pair");
  // Through the code: A's renewal is refused, and B's lands between A's last read and A's markBroken.
  must(await a.rt.adoptConnection(TENANT, a.agentId, "github", id) && (await w.stored(a)).token === bToken, "A did not take B's first pair");
  await w.age(a, id);
  w.gh.live.delete((await w.stored(a)).token!);
  w.gh.s.refuse = true;
  const markBroken = w.grants.markBroken.bind(w.grants);
  let raced = "";
  w.grants.markBroken = async (...x: Parameters<typeof markBroken>) => { if (!raced) { w.gh.s.refuse = false; raced = await landB(); } return markBroken(...x); };
  const r = await w.tool(a);
  must(raced && raced !== bToken, "the race did not happen");
  must(succeeded(r), `A's call failed: ${errorText(r)}`);
  must((await w.grants.grant(TENANT, id, a.agentId))!.brokenAt === null && (await w.status("A20")).body.oauthStatus === "connected", "the connector was marked broken");
  const s2 = await w.stored(a);
  must(s2.token === raced && !s2.rec.brokenAt, "A's mount did not take B's pair, or kept a broken flag");
  must((w.db.raw.prepare("SELECT count(*) AS n FROM connector_events WHERE connector_id = ? AND action = 'broken'").get(id) as any).n === 0, "a broken event was written");
  w.dispose();
});

await check("a new pair D1 will not take is retried, and when D1 still refuses the mount keeps the pair rather than lose it", async () => {
  const { ROTATE_ATTEMPTS } = await import("../cf/src/github-refresh.ts");
  must(ROTATE_ATTEMPTS >= 2 && ROTATE_ATTEMPTS <= 3, `attempts ${ROTATE_ATTEMPTS}`);
  for (const failures of [1, ROTATE_ATTEMPTS]) {
    const w = await world();
    const a = await w.agent(`A21_${failures}`);
    const id = await w.connect(a);
    await w.expireAt(a, Date.now() + 30_000, id);
    w.gh.live.delete((await w.stored(a)).token!);
    const rotate = w.grants.rotate.bind(w.grants);
    let tries = 0;
    w.grants.rotate = async (...x: Parameters<typeof rotate>) => { tries++; if (tries <= failures) throw new Error("D1_ERROR: network connection lost"); return rotate(...x); };
    const r = await w.tool(a);
    const issued = w.gh.issued.filter((t) => t.startsWith("ghu_")).at(-1);
    must(w.gh.s.refreshes === 1, `refreshes ${w.gh.s.refreshes}`);
    must(succeeded(r), `${failures} failure(s): the call failed: ${errorText(r)}`);
    const s = await w.stored(a);
    must(s.token === issued && s.rec.refreshToken && w.gh.refreshes.has(s.rec.refreshToken), `${failures} failure(s): the mount does not hold the live pair`);
    const row = w.db.raw.prepare("SELECT ciphertext, iv FROM connectors WHERE id = ?").get(id) as any;
    const inD1 = await s.open(s.kek, { ciphertext: row.ciphertext, iv: row.iv });
    // One failure is always retried and lands; the last allowed attempt failing leaves D1 without it.
    if (failures === 1) must(tries === 2 && inD1 === issued, `one failure: tried ${tries} times, D1 holds the new pair: ${inD1 === issued}`);
    else must(tries === ROTATE_ATTEMPTS && inD1 !== issued, `tries ${tries}`);
    // Each failed write is a trace row with its attempt and a fixed code, never D1's message (#980).
    const rows = w.traced(a);
    const failed = rows.filter((r) => r.status === "store-failed");
    must(failed.map((r) => r.attrs.attempt).join(",") === [...Array(failures).keys()].map((i) => i + 1).join(","), `store-failed attempts: ${JSON.stringify(failed)}`);
    must(failed.every((r) => r.verdict === "failed" && r.attrs.reasonCode === "d1-write-failed" && r.attrs.connectorId === id), JSON.stringify(failed));
    const kept = rows.filter((r) => r.status === "kept-unstored").length;
    must(failures === 1 ? kept === 0 : kept === 1, `${failures} failure(s): kept-unstored rows ${kept}`);
    clean(rows, ["D1_ERROR", "network connection lost"]);
    w.dispose();
  }
});

for (const [code, verdict] of [["bad_refresh_token", "broken"], ["invalid_grant", "broken"], ["unauthorized", "broken"],
  ["temporarily_unavailable", "unavailable"], ["slow_down", "unavailable"], ["something_github_adds_later", "unavailable"],
  ["incorrect_client_credentials", "unavailable"]] as const) {
  await check(`the token endpoint's OAuth error ${code} is ${verdict === "broken" ? "a verdict: reconnect" : "no verdict: try again later"}`, async () => {
    const w = await world();
    const a = await w.agent("A22");
    const id = await w.connect(a);
    await w.expireAt(a, Date.now() + 30_000, id);
    w.gh.live.delete((await w.stored(a)).token!);
    w.gh.s.tokenAnswer = () => json({ error: code, error_description: "as GitHub might say it" });
    const r = await w.tool(a);
    const row = w.db.raw.prepare("SELECT broken_at FROM connectors WHERE id = ?").get(id) as any;
    const status = (await w.status("A22")).body.oauthStatus;
    if (verdict === "broken") must(row.broken_at && status === "error" && errorText(r).includes(RECONNECT_REASON), `${code}: not marked (${status})`);
    else must(row.broken_at === null && status === "connected" && !errorText(r).includes(RECONNECT_REASON), `${code}: marked (${status})`);
    // The trace row names the code when it is one GitHub is known to send, and `oauth:other` otherwise (#980).
    const rows = w.traced(a).filter((x) => x.status === verdict);
    const want = code === "something_github_adds_later" ? "oauth:other" : `oauth:${code}`;
    must(rows.length >= 1 && rows.every((x) => x.attrs.reasonCode === want && x.verdict === "failed"), `${code}: trace ${JSON.stringify(rows)}`);
    clean(rows, ["as GitHub might say it", ...(code === "something_github_adds_later" ? [code] : [])]);
    w.dispose();
  });
}

await check("pointing an agent at a connector that needs reconnecting is refused, 422 connect_failed", async () => {
  const w = await world();
  const a = await w.agent("A14");
  const b = await w.agent("B14");
  const id = await w.connect(a);
  await w.grants.markBroken(TENANT, id, "bad_refresh_token", Date.now(), null, null);
  const r = await w.call("PUT", `/agents/by-raft-agent/B14/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  must(r.status === 422 && r.body.error.code === "connect_failed" && r.body.error.message.includes(RECONNECT_REASON), `${r.status} ${r.text}`);
  must((await w.stored(b)).token === null && (await w.status("B14")).body.oauthStatus === "disconnected", "the agent was pointed at it anyway");
  w.dispose();
});

await check("a renewal's pair is in D1 before anything else runs, and the token endpoint's timeout sits inside the lease", async () => {
  const { TOKEN_TIMEOUT_MS } = await import("../cf/src/github-token.ts");
  const { LEASE_MS } = await import("../cf/src/github-refresh.ts");
  must(TOKEN_TIMEOUT_MS >= 20_000 && TOKEN_TIMEOUT_MS < LEASE_MS, `timeout ${TOKEN_TIMEOUT_MS}, lease ${LEASE_MS}`);
  const w = await world();
  const a = await w.agent("A15");
  const b = await w.agent("B15");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/B15/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  await w.expireAt(a, Date.now() + 30_000, id);
  // The order things happen in once GitHub has answered: the D1 write, the call itself, and telling b.
  const order: string[] = [];
  const rotate = w.grants.rotate.bind(w.grants);
  w.grants.rotate = async (...x: Parameters<typeof rotate>) => { const r = await rotate(...x); order.push(r ? "d1" : "d1-lost"); return r; };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u === GITHUB_TOKEN) order.push("github-refresh");
    else if (u.startsWith("https://api.github.com/")) order.push("api");
    return real(url, init);
  }) as any;
  const was = w.propagated.length;
  must(succeeded(await w.tool(a)), "the call failed");
  await w.settle();
  globalThis.fetch = real;
  if (w.propagated.length > was) order.push("propagated");
  must(order.join(",") === "github-refresh,d1,api,propagated", `order: ${order.join(",")}`);
  w.dispose();
});

await check("the lease is its holder's: one that outlived it cannot free the renewal that took over", async () => {
  const w = await world();
  const a = await w.agent("A16");
  const id = await w.connect(a);
  const g = w.grants;
  must(await g.lease(TENANT, id, 1_000, 2_000, "h1"), "h1 did not get a free lease");
  must(!(await g.lease(TENANT, id, 1_500, 2_500, "h2")), "h2 took a lease h1 still held");
  must(await g.lease(TENANT, id, 2_500, Date.now() + 60_000, "h2"), "h2 could not take over an expired lease");
  await g.release(TENANT, id, "h1");
  must(!(await g.lease(TENANT, id, Date.now(), Date.now() + 1_000, "h3")), "h1's late release freed h2's lease");
  const k = (await g.grant(TENANT, id, a.agentId))!;
  must(!(await g.rotate(TENANT, id, { sealed: k.sealed, refresh: k.refresh!, at: Date.now() }, "not-the-ciphertext", "h1")), "a stale rotation landed");
  await g.markBroken(TENANT, id, "test", Date.now(), "h1", null);
  must((await g.grant(TENANT, id, a.agentId))!.refreshingUntil !== null, "h1 marking it broken released h2's lease");
  await g.release(TENANT, id, "h2");
  must((await g.grant(TENANT, id, a.agentId))!.refreshingUntil === null, "h2 could not release its own lease");
  w.dispose();
});

await check("a mount's own broken flag heals when the connector is healthy: by another agent's renewal, and by its own next 401", async () => {
  const w = await world();
  const a = await w.agent("A17");
  const b = await w.agent("B17");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/B17/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  const { seal } = await import("../src/runtime/secrets.ts");
  const markLocal = async (x: typeof b) => {
    const s = await w.stored(x);
    await x.rt.store.putSecret(TENANT, x.agentId, `${OAUTH_PREFIX}gh`, await seal(s.kek, JSON.stringify({ ...s.rec, brokenAt: Date.now(), brokenReason: "stale" })));
  };
  await markLocal(b);
  await w.expireAt(a, Date.now() + 30_000, id);
  must(succeeded(await w.tool(a)), "a's renewal failed");
  await w.settle();
  must(!(await w.stored(b)).rec.brokenAt && succeeded(await w.tool(b)), "propagation did not heal b");
  await markLocal(b);
  w.gh.live.delete((await w.stored(b)).token!);
  await w.age(a, id);
  const r = await w.tool(b);
  must(succeeded(r) && !(await w.stored(b)).rec.brokenAt, `b's 401 did not heal it: ${errorText(r)}`);
  // And when nothing needs renewing at all (the pair is fresh, the connector holds the mount's own token): a 401 from
  // an endpoint that refuses user tokens still clears the stale flag, so renewing before use works again.
  await markLocal(b);
  const refreshes = w.gh.s.refreshes;
  must(!succeeded(await w.tool(b, "api_get", { path: "/app" })) && w.gh.s.refreshes === refreshes, "the /app call renewed");
  must(!(await w.stored(b)).rec.brokenAt, "the stale flag stayed although the connector is healthy");
  w.dispose();
});

await check("a mount whose connector was deleted stops renewing: no refresh with its own copy, and it says to reconnect", async () => {
  const w = await world();
  const a = await w.agent("A18");
  const id = await w.connect(a);
  w.db.raw.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  await w.expireAt(a, Date.now() + 30_000);
  w.gh.live.delete((await w.stored(a)).token!);
  const r = await w.tool(a);
  must(!succeeded(r) && errorText(r).includes(RECONNECT_REASON), errorText(r));
  must(w.gh.s.refreshes === 0, `renewed with the mount's own copy: ${w.gh.s.refreshes}`);
  must((await w.stored(a)).rec.brokenAt, "the mount was not marked");
  w.dispose();
});

await check("propagation is not waited for: the renewing call answers first, and the other agent gets the pair after", async () => {
  const w = await world();
  const a = await w.agent("A19");
  const b = await w.agent("B19");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/B19/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  const old = (await w.stored(b)).token;
  await w.expireAt(a, Date.now() + 30_000, id);
  w.delayPropagation(300);
  const t0 = Date.now();
  must(succeeded(await w.tool(a)), "a's call failed");
  must(Date.now() - t0 < 300 && (await w.stored(b)).token === old, `the call waited for propagation (${Date.now() - t0} ms)`);
  await w.settle();
  must((await w.stored(b)).token === (await w.stored(a)).token, "b never got the pair");
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

/** Break a connector the way GitHub does: the token expired and its refresh token refused, found by a's next call. */
async function breakIt(w: Awaited<ReturnType<typeof world>>, a: { rt: AgentRuntime; agentId: string }, id: string) {
  await w.expireAt(a, Date.now() + 30_000, id);
  w.gh.live.delete((await w.stored(a)).token!);
  w.gh.s.refuse = true;
  must(!succeeded(await w.tool(a)), "the call succeeded on a dead connection");
  w.gh.s.refuse = false;
  must((w.db.raw.prepare("SELECT broken_at FROM connectors WHERE id = ?").get(id) as any).broken_at, "the connector was not marked broken");
}
const connectorRow = (w: Awaited<ReturnType<typeof world>>, id: string) => w.db.raw.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as any;
const connectorCount = (w: Awaited<ReturnType<typeof world>>) => (w.db.raw.prepare("SELECT COUNT(*) AS n FROM connectors").get() as any).n as number;

await check("a connect keeps GitHub's numeric user id on the connector beside the login (0024)", async () => {
  const w = await world();
  const a = await w.agent("R0");
  const id = await w.connect(a);
  const row = connectorRow(w, id);
  must(row.account === "octocat" && row.account_id === "1", `account ${row.account}, account_id ${row.account_id}`);
  w.dispose();
});

await check("reconnecting in place mends the connector itself: every agent on it gets the new pair, their broken flags clear, and an agent not on it is pointed at it", async () => {
  const w = await world();
  const a = await w.agent("R1");
  const b = await w.agent("S1");
  const c = await w.agent("T1");
  const id = await w.connect(a);
  must((await w.call("PUT", `/agents/by-raft-agent/S1/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "bind b");
  await breakIt(w, a, id);
  // b's mount learns it too, from its own call.
  w.gh.live.delete((await w.stored(b)).token!);
  must(!succeeded(await w.tool(b)) && (await w.stored(b)).rec?.brokenAt, "b's mount was not marked broken");
  must((await w.status("R1")).body.oauthStatus === "error" && (await w.status("S1")).body.oauthStatus === "error", "not reported broken");
  const before = connectorCount(w);
  // From an agent not on it, by an admin: Raft's word for the role.
  const r = await w.reconnect(c, id, { raftUserId: "u_admin", actingRole: "admin" });
  must(r.status === 200 && r.body.reconnected === true && r.body.connected === true && r.body.connectorId === id && r.body.account === "octocat", `${r.status} ${r.text}`);
  must(JSON.stringify(r.body.updated) === JSON.stringify(["R1", "S1", "T1"].sort()) && r.body.failed.length === 0, `updated ${JSON.stringify(r.body.updated)} failed ${JSON.stringify(r.body.failed)}`);
  must(connectorCount(w) === before, "a reconnect in place made a new connector");
  const row = connectorRow(w, id);
  must(row.broken_at === null && row.broken_reason === null && row.refreshing_until === null && row.refreshing_by === null && row.last_checked_at >= row.refreshed_at, JSON.stringify({ ...row, ciphertext: "-", refresh_ciphertext: "-" }));
  const k = await w.stored(a);
  const connectorToken = await k.open(k.kek, { ciphertext: row.ciphertext, iv: row.iv });
  must(w.gh.live.has(connectorToken), "the connector does not hold the new, live token");
  for (const x of [a, b, c]) {
    const s = await w.stored(x);
    must(s.token === connectorToken && s.rec?.connectorId === id && !s.rec.brokenAt, `${x.agentId}: token ${s.token === connectorToken}, rec ${JSON.stringify({ ...s.rec, refreshToken: "-" })}`);
    must(s.rec.refreshToken === await s.open(s.kek, { ciphertext: row.refresh_ciphertext, iv: row.refresh_iv }), `${x.agentId} holds another refresh token than the connector`);
  }
  for (const r of ["R1", "S1", "T1"]) {
    const st = await w.status(r);
    must(st.body.connected === true && st.body.oauthStatus === "connected" && st.body.lastCheckError === null && st.body.connectorId === id, `${r}: ${st.text}`);
  }
  const refreshes = w.gh.s.refreshes;
  for (const x of [a, b, c]) must(succeeded(await w.tool(x)), `${x.agentId}'s call failed after the reconnect`);
  must(w.gh.s.refreshes === refreshes, "a call after the reconnect needed a renewal");
  const ev = w.db.raw.prepare("SELECT action, raft_agent_id, acting_raft_user_id, acting_role FROM connector_events WHERE connector_id = ? AND action IN ('reconnect', 'bind') ORDER BY at").all(id) as any[];
  must(ev.some((e) => e.action === "reconnect" && e.raft_agent_id === "T1" && e.acting_raft_user_id === "u_admin" && e.acting_role === "admin"), `no reconnect event: ${JSON.stringify(ev)}`);
  must(ev.some((e) => e.action === "bind" && e.raft_agent_id === "T1"), `T1's pointing is not recorded: ${JSON.stringify(ev)}`);
  w.dispose();
});

await check("reconnecting in place a healthy connector re-authorizes it the same way, from an agent already on it, by its creator", async () => {
  const w = await world();
  const a = await w.agent("R2");
  const b = await w.agent("S2");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/S2/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  const was = (await w.stored(a)).token;
  const r = await w.reconnect(a, id);
  must(r.status === 200 && r.body.connected === true && JSON.stringify(r.body.updated) === '["R2","S2"]', `${r.status} ${r.text}`);
  must((await w.stored(a)).token !== was && (await w.stored(a)).token === (await w.stored(b)).token, "the agents did not both take the new token");
  must(succeeded(await w.tool(a)) && succeeded(await w.tool(b)), "a call failed");
  w.dispose();
});

await check("a reconnect authorized as another GitHub account is refused, 409 account_mismatch, and nothing changes: not the connector, a mount, or the agent's row", async () => {
  const w = await world();
  const a = await w.agent("R3");
  const b = await w.agent("S3");
  const id = await w.connect(a);
  await w.call("PUT", `/agents/by-raft-agent/S3/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  await breakIt(w, a, id);
  const row0 = connectorRow(w, id);
  const sa = await w.stored(a), sb = await w.stored(b);
  const conns0 = JSON.stringify(w.db.raw.prepare("SELECT * FROM provisioned_connections ORDER BY raft_agent_id").all());
  const n0 = connectorCount(w);
  for (const as of [
    { login: "mallory", id: 2 },
    // The connector's login, now someone else's: a rename freed it. The id is what counts.
    { login: "octocat", id: 3 },
  ]) {
    w.gh.s.as = as;
    const r = await w.reconnect(b, id);
    must(r.status === 409 && r.body.error.code === "account_mismatch" && /nothing was changed/.test(r.body.error.message), `${as.login}/${as.id}: ${r.status} ${r.text}`);
  }
  must(JSON.stringify(connectorRow(w, id)) === JSON.stringify(row0), "the connector changed");
  must(connectorCount(w) === n0, "a refused reconnect made a connector");
  must(JSON.stringify(await w.stored(a)) === JSON.stringify(sa) && JSON.stringify(await w.stored(b)) === JSON.stringify(sb), "a mount changed");
  must(JSON.stringify(w.db.raw.prepare("SELECT * FROM provisioned_connections ORDER BY raft_agent_id").all()) === conns0, "an agent's connection row changed");
  must((w.db.raw.prepare("SELECT COUNT(*) AS n FROM connector_events WHERE action = 'reconnect'").get() as any).n === 0, "a reconnect was recorded");
  must((await w.status("S3")).body.oauthStatus === "error", "the refused reconnect cleared the broken state");
  // The account itself, renamed: the same id under a new login is the same account, and the login follows it.
  w.gh.s.as = { login: "octocat-renamed", id: 1 };
  const ok = await w.reconnect(b, id);
  must(ok.status === 200 && ok.body.account === "octocat-renamed" && connectorRow(w, id).account === "octocat-renamed" && connectorRow(w, id).account_id === "1", `${ok.status} ${ok.text}`);
  w.dispose();
});

await check("the D1 write itself refuses another account's id, for an id that changed between the handler's read and its write", async () => {
  const w = await world();
  const a = await w.agent("R10");
  const id = await w.connect(a);
  const row0 = connectorRow(w, id);
  const next = { sealed: { ciphertext: "x", iv: "y" }, refresh: null, account: "mallory", accountId: "2", at: Date.now() };
  must(!(await d1Connectors(w.db).reconnect(TENANT, id, next)), "another account's pair was written");
  must(!(await d1Connectors(w.db).reconnect("t-other", id, { ...next, accountId: "1" })), "another tenant wrote over the connector");
  must(JSON.stringify(connectorRow(w, id)) === JSON.stringify(row0), "the connector changed");
  w.dispose();
});

await check("the D1 write refuses a connector with no id yet whose login is another's: a renamed login can be someone else's", async () => {
  const w = await world();
  const a = await w.agent("R11");
  const id = await w.connect(a);
  w.db.raw.prepare("UPDATE connectors SET account_id = NULL WHERE id = ?").run(id);
  const row0 = connectorRow(w, id);
  const next = { sealed: { ciphertext: "x", iv: "y" }, refresh: null, account: "mallory", accountId: "2", at: Date.now() };
  must(!(await d1Connectors(w.db).reconnect(TENANT, id, next)), "another login's pair was written over a connector with no id");
  must(JSON.stringify(connectorRow(w, id)) === JSON.stringify(row0), "the connector changed");
  must(await d1Connectors(w.db).reconnect(TENANT, id, { ...next, account: "OctoCat", accountId: "1" }), "its own login, in another case, was refused");
  must(connectorRow(w, id).account_id === "1", "the id was not stored");
  w.dispose();
});

await check("the D1 backfill writes an id only over none, and only for the connector's own login", async () => {
  const w = await world();
  const a = await w.agent("R13");
  const id = await w.connect(a);
  must(!(await w.grants.fillAccountId(TENANT, id, "9", "octocat")) && connectorRow(w, id).account_id === "1", "an id was written over one already kept");
  w.db.raw.prepare("UPDATE connectors SET account_id = NULL WHERE id = ?").run(id);
  must(!(await w.grants.fillAccountId(TENANT, id, "2", "mallory")) && connectorRow(w, id).account_id === null, "another login's id was written");
  must(!(await w.grants.fillAccountId("t-other", id, "1", "octocat")) && connectorRow(w, id).account_id === null, "another tenant wrote the id");
  must(await w.grants.fillAccountId(TENANT, id, "1", "OctoCat") && connectorRow(w, id).account_id === "1", "its own login's id was not written");
  w.dispose();
});

for (const [label, setup, expect, outcome] of [
  ["learns GitHub's id from the renewed token", (_w: any, _id: string) => {}, "1", "filled"],
  ["ignores GET /user failing: the renewal stands, the id stays unknown", (w: any) => { w.gh.s.failUser = 1; }, null, "unknown"],
  ["leaves the id unknown when GitHub names another login", (w: any, id: string) => { w.db.raw.prepare("UPDATE connectors SET account = 'someone-else' WHERE id = ?").run(id); }, null, "login-mismatch"],
] as const) {
  await check(`a connector from before the id was kept, renewing, ${label}`, async () => {
    const w = await world();
    const a = await w.agent(`R12${String(expect)}${label.length}`);
    const id = await w.connect(a);
    w.db.raw.prepare("UPDATE connectors SET account_id = NULL WHERE id = ?").run(id);
    (setup as (w: any, id: string) => void)(w, id);
    await w.expireAt(a, Date.now() + 30_000, id);
    const before = connectorRow(w, id).ciphertext;
    const from = logged.length;
    const r = await w.tool(a);
    must(succeeded(r) && w.gh.s.refreshes === 1, `the renewal or its call failed: ${errorText(r)}`);
    const row = connectorRow(w, id);
    must(row.ciphertext !== before && row.broken_at === null, "the renewal did not land");
    must(row.account_id === expect, `account_id ${row.account_id}, expected ${expect}`);
    const said = logged.slice(from).filter((l) => l.includes('"evt":"github.account_id"') && l.includes(`"connectorId":"${id}"`) && l.includes(`"tenantId":"${TENANT}"`));
    must(said.length > 0 && said.at(-1)!.includes(`"outcome":"${outcome}"`), `logged ${said.at(-1) ?? "nothing"}, expected ${outcome}`);
    w.dispose();
  });
}

await check("a connector from before the id was kept is matched by its login, and learns the id at the reconnect", async () => {
  const w = await world();
  const a = await w.agent("R4");
  const id = await w.connect(a);
  w.db.raw.prepare("UPDATE connectors SET account_id = NULL WHERE id = ?").run(id);
  w.gh.s.as = { login: "mallory", id: 2 };
  const wrong = await w.reconnect(a, id);
  must(wrong.status === 409 && wrong.body.error.code === "account_mismatch" && connectorRow(w, id).account_id === null, `${wrong.status} ${wrong.text}`);
  // Logins are case-insensitive at GitHub.
  w.gh.s.as = { login: "OctoCat", id: 1 };
  const r = await w.reconnect(a, id);
  must(r.status === 200 && connectorRow(w, id).account_id === "1", `${r.status} ${r.text}`);
  w.dispose();
});

await check("reconnecting in place is the creator's or an admin's: a stranger claiming to be the creator is refused at the link and at confirm", async () => {
  const w = await world();
  const a = await w.agent("R5");
  const id = await w.connect(a);
  const r = await w.reconnect(a, id, { raftUserId: "u_stranger", actingRole: "creator" });
  must(r.status === 403 && r.body.error.code === "not_creator" && w.links.length === 0, `at the link: ${r.status} ${r.text}`);
  must((await w.call("POST", `/agents/by-raft-agent/R5/connections/github`, { returnUrl: `${WHO.raftOrigin}/x`, initiatedBy: { raftUserId: "u_owner" }, connectorId: id })).body.error?.param === "actingRole", "a reconnect without a role was accepted");
  must((await w.call("POST", `/agents/by-raft-agent/R5/connections/github`, { returnUrl: `${WHO.raftOrigin}/x`, initiatedBy: { raftUserId: "u_owner" }, actingRole: "creator" })).body.error?.param === "actingRole", "a role without a connector was accepted");
  // A hold naming a role the link could not have carried: confirm checks again.
  const was = (await w.stored(a)).token;
  const { grant } = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", grant, "pend_R5_forged01", Date.now() + 600_000, "u_stranger", { connectorId: id, actingRole: "creator" });
  const c = await w.call("POST", `/agents/by-raft-agent/R5/connections/github/confirm`, { pending: "pend_R5_forged01", raftUserId: "u_stranger" });
  must(c.status === 403 && c.body.error.code === "not_creator" && (await w.stored(a)).token === was, `at confirm: ${c.status} ${c.text}`);
  w.dispose();
});

await check("another tenant's connector, and one deleted after the link was made, are refused 404 and change nothing", async () => {
  const w = await world();
  const a = await w.agent("R6");
  const id = await w.connect(a);
  const theirs = connectorRow(w, id);
  await d1Connectors(w.db).create({ id: "con_theirs", tenantId: "t-other", provider: "github", account: "octocat", accountId: "1", creatorRaftUserId: "u_owner", raftOrigin: WHO.raftOrigin,
    sealed: { ciphertext: theirs.ciphertext, iv: theirs.iv }, createdAt: Date.now() });
  const other = await w.reconnect(a, "con_theirs");
  must(other.status === 404 && other.body.error.code === "not_found" && w.links.length === 0, `another tenant's: ${other.status} ${other.text}`);
  // And at confirm, for a hold that names it.
  const { grant } = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", grant, "pend_R6_theirs01", Date.now() + 600_000, "u_owner", { connectorId: "con_theirs", actingRole: "admin" });
  const at = await w.call("POST", `/agents/by-raft-agent/R6/connections/github/confirm`, { pending: "pend_R6_theirs01", raftUserId: "u_owner" });
  must(at.status === 404 && JSON.stringify(connectorRow(w, "con_theirs")) !== undefined && connectorRow(w, "con_theirs").tenant_id === "t-other", `${at.status} ${at.text}`);
  // Deleted between the link and the confirm.
  const asked = await w.call("POST", `/agents/by-raft-agent/R6/connections/github`, { returnUrl: `${WHO.raftOrigin}/x`, initiatedBy: { raftUserId: "u_owner" }, connectorId: id, actingRole: "creator" });
  must(asked.status === 200 && asked.body.reconnect === id, asked.text);
  must((await w.call("DELETE", `/connectors/${id}`, { actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "disconnect");
  const n0 = connectorCount(w);
  const g2 = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", g2.grant, "pend_R6_gone0001", Date.now() + 600_000, "u_owner", w.links.at(-1).reconnect);
  const gone = await w.call("POST", `/agents/by-raft-agent/R6/connections/github/confirm`, { pending: "pend_R6_gone0001", raftUserId: "u_owner" });
  must(gone.status === 404 && gone.body.error.code === "not_found", `deleted: ${gone.status} ${gone.text}`);
  must(connectorCount(w) === n0 && (await w.stored(a)).token === null && (await w.status("R6")).body.connected === false, "a reconnect of a deleted connector made one, or attached the token");
  w.dispose();
});

await check("the connector a reconnect mends is the link's: confirm takes no connectorId, and one sent is refused 400", async () => {
  const w = await world();
  const a = await w.agent("R7");
  const mine = await w.connect(a);
  const b = await w.agent("S7");
  const other = await w.connect(b);
  const asked = await w.call("POST", `/agents/by-raft-agent/R7/connections/github`, { returnUrl: `${WHO.raftOrigin}/x`, initiatedBy: { raftUserId: "u_owner" }, connectorId: mine, actingRole: "creator" });
  must(asked.status === 200 && w.links.at(-1).reconnect?.connectorId === mine, `the link does not carry the connector: ${JSON.stringify(w.links.at(-1))}`);
  const { grant } = await w.gh.code();
  await a.rt.holdConnection(TENANT, a.agentId, "github", grant, "pend_R7_swap0001", Date.now() + 600_000, "u_owner", w.links.at(-1).reconnect);
  const swapped = await w.call("POST", `/agents/by-raft-agent/R7/connections/github/confirm`, { pending: "pend_R7_swap0001", raftUserId: "u_owner", connectorId: other });
  must(swapped.status === 400 && swapped.body.error.code === "unknown_field" && swapped.body.error.param === "connectorId", `${swapped.status} ${swapped.text}`);
  const otherRow = connectorRow(w, other);
  const r = await w.call("POST", `/agents/by-raft-agent/R7/connections/github/confirm`, { pending: "pend_R7_swap0001", raftUserId: "u_owner" });
  must(r.status === 200 && r.body.connectorId === mine && JSON.stringify(connectorRow(w, other)) === JSON.stringify(otherRow), `${r.status} ${r.text}`);
  w.dispose();
});

for (const refused of [false, true]) {
  await check(`a reconnect landing while another agent's renewal holds the lease${refused ? " and GitHub refuses that renewal" : ""}: the reconnect's pair stays, nothing is marked broken, and every agent ends up working`, async () => {
    const w = await world();
    const a = await w.agent(refused ? "R9" : "R8");
    const b = await w.agent(refused ? "S9" : "S8");
    const id = await w.connect(a);
    await w.call("PUT", `/agents/by-raft-agent/${b.raftAgentId}/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
    await w.expireAt(a, Date.now() + 30_000, id);
    w.gh.s.delayMs = 400;
    w.gh.s.refuse = refused;
    let answered = false;
    const renewing = w.tool(a).finally(() => { answered = true; });
    // The renewal is at GitHub, under the lease.
    for (let i = 0; i < 50 && !connectorRow(w, id).refreshing_until; i++) await sleep(5);
    must(connectorRow(w, id).refreshing_until, "the renewal never took the lease");
    // A reconnect trades a code, never a refresh token: GitHub refusing refreshes does not touch it.
    const r = await w.reconnect(b, id);
    must(r.status === 200 && r.body.reconnected === true, `${r.status} ${r.text}`);
    must(!answered, "the renewal finished before the reconnect: the race was not run");
    const mended = connectorRow(w, id);
    await renewing;
    w.gh.s.refuse = false;
    if (refused) must(w.gh.s.refused > 0, "GitHub never refused the renewal");
    await w.settle();
    w.gh.s.delayMs = 0;
    const row = connectorRow(w, id);
    must(row.ciphertext === mended.ciphertext && row.refresh_ciphertext === mended.refresh_ciphertext, "the renewal's write replaced the reconnect's pair");
    must(row.broken_at === null && row.refreshing_until === null, `left broken or leased: ${JSON.stringify({ broken_at: row.broken_at, refreshing_until: row.refreshing_until })}`);
    const s = await w.stored(b);
    const token = await s.open(s.kek, { ciphertext: row.ciphertext, iv: row.iv });
    must(w.gh.live.has(token), "the connector's pair is not live at GitHub");
    for (const x of [a, b]) {
      const st = await w.stored(x);
      // Whichever live pair a mount holds, it is not broken, and the connector's own is reachable from it.
      must(w.gh.live.has(st.token!) && !st.rec?.brokenAt && st.rec?.connectorId === id, `${x.agentId} holds a dead token or a broken flag`);
      must(succeeded(await w.tool(x)), `${x.agentId}'s call failed`);
    }
    must((await w.status(a.raftAgentId)).body.oauthStatus === "connected" && (await w.status(b.raftAgentId)).body.oauthStatus === "connected", "reported broken");
    w.dispose();
  });
}

await check("a trace row's reason is a code from a fixed set: never a reason's own text, whatever it carries (#980)", async () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined],
    ["bad_refresh_token: The refresh token passed is incorrect or expired.", "oauth:bad_refresh_token"],
    ["invalid_grant", "oauth:invalid_grant"],
    ["something_new: says ghr_SECRETVALUE1234", "oauth:other"],
    ["ghr_SECRETVALUE1234", "other"],
    ["ghrabcdefsecret", "oauth:other"],
    ["the token endpoint did not answer: TypeError: fetch failed ghu_SECRET", "no-answer"],
    ["the token endpoint answered 502 without an OAuth error", "http-502"],
    ["the token endpoint answered 502 without an OAuth error ghu_SECRET", "other"],
    ["GitHub answered without a refresh token", "no-refresh-token"],
    ["no refresh token in the answer", "no-refresh-token"],
    ["this deployment has no GitHub App credentials to renew with", "no-app"],
    ["another renewal of this connection did not finish", "lease-timeout"],
    ["the connection was removed", "connector-gone"],
    ["the connector is gone", "connector-gone"],
    ["refused", "refused"],
    ["D1_ERROR: UNIQUE constraint failed: ghu_SECRET", "other"],
  ];
  for (const [reason, want] of cases) must(reasonCode(reason) === want, `${reason}: ${reasonCode(reason)}, wanted ${want}`);
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

await check("deleting an agent bound to a connector: it leaves the renewal audience, its binding goes, and the credential copy on its mount goes", async () => {
  const w = await world();
  const a = await w.agent("X1");
  const b = await w.agent("X2");
  const id = await w.connect(a);
  must((await w.call("PUT", `/agents/by-raft-agent/X2/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "bind X2");
  const bindingOf = (raftAgentId: string) => w.db.raw.prepare("SELECT * FROM provisioned_connections WHERE raft_agent_id = ?").get(raftAgentId) as any;
  // Control: both are in the audience, X2 is bound, and its mount holds the connector's credential.
  must(JSON.stringify((await renewalAudience(w.db, TENANT, id)).to) === JSON.stringify([a.agentId, b.agentId]) && bindingOf("X2")?.connector_id === id
    && (await w.stored(b)).token !== null, "control");
  const del = await w.call("DELETE", "/agents/by-raft-agent/X2");
  must(del.status === 200 && del.body.status === "deleted", `delete: ${del.status} ${del.text}`);
  // Clean, and said so: the binding removed and the mount copy cleared, nothing to do next.
  must(del.body.connectionsClean === true && JSON.stringify(del.body.connections) === JSON.stringify([{ provider: "github", connectorId: id, binding: "removed", mount: "cleared" }]),
    `the answer: ${del.text}`);
  const after = await renewalAudience(w.db, TENANT, id);
  must(JSON.stringify(after) === JSON.stringify({ to: [a.agentId], filtered: 0, skipped: 0 }), `audience after the delete: ${JSON.stringify(after)}`);
  must(!bindingOf("X2") && bindingOf("X1")?.connector_id === id, "the deleted agent's binding is still there, or the other's went");
  must((await w.stored(b)).token === null && (await w.stored(b)).rec === null, "the credential copy is still on the deleted agent's mount");
  const ev = w.db.raw.prepare("SELECT * FROM connector_events WHERE action = 'deleted_agent_unbound'").all() as any[];
  must(ev.length === 1 && ev[0].connector_id === id && ev[0].raft_agent_id === "X2" && ev[0].acting_role === "system"
    && JSON.parse(ev[0].reason).mountCleared === true, `the record: ${JSON.stringify(ev)}`);
  // And a deleted agent whose object still runs finds no connector to renew through.
  must((await w.grants.grant(TENANT, id, b.agentId)) === null && (await w.grants.grant(TENANT, id, a.agentId)) !== null, "a deleted agent can still renew");
  w.dispose();
});

for (const mode of ["refused", "unreachable"] as const) {
  await check(`deleting an agent whose mount clear is ${mode}: the binding is kept, the answer says retry_delete, nothing renews it, and the repeated delete clears and unbinds`, async () => {
    const w = await world();
    const a = await w.agent(mode === "refused" ? "X3" : "X4");
    const id = await w.connect(a);
    const bindingOf = () => w.db.raw.prepare("SELECT * FROM provisioned_connections WHERE raft_agent_id = ?").get(a.raftAgentId) as any;
    w.clearMode.set(a.agentId, mode);
    const from = logged.length;
    const del = await w.call("DELETE", `/agents/by-raft-agent/${a.raftAgentId}`);
    const end = del.body?.connections?.[0];
    must(del.status === 200 && del.body.connectionsClean === false && end?.binding === "kept" && end.mount === "not_cleared" && end.action === "retry_delete"
      && end.connectorId === id && /DELETE this agent again/.test(end.message), `the answer: ${del.status} ${del.text}`);
    must(bindingOf()?.connector_id === id && (await w.stored(a)).token !== null, "control: the binding went, or the mount was cleared");
    must(logged.slice(from).some((l) => /"evt":"connect.agent_delete"/.test(l) && /"outcome":"mount-not-cleared"/.test(l) && /"action":"retry_delete"/.test(l)), "not logged");
    // Kept, but never renewed: not in the audience (skipped), and its object finds no connector.
    const aud = await renewalAudience(w.db, TENANT, id);
    must(aud.to.length === 0 && aud.skipped === 1 && (await w.grants.grant(TENANT, id, a.agentId)) === null, `renewal: ${JSON.stringify(aud)}`);
    must((w.db.raw.prepare("SELECT COUNT(*) AS n FROM connector_events WHERE action = 'deleted_agent_unbound'").get() as any).n === 0, "an unbinding was recorded for a kept binding");
    // The object answers again: the repeated delete clears the mount and unbinds, recorded as cleared.
    w.clearMode.clear();
    const again = await w.call("DELETE", `/agents/by-raft-agent/${a.raftAgentId}`);
    must(again.status === 200 && again.body.connectionsClean === true && again.body.connections?.[0]?.binding === "removed" && !bindingOf()
      && (await w.stored(a)).token === null, `repeat: ${again.status} ${again.text}`);
    const ev = w.db.raw.prepare("SELECT reason FROM connector_events WHERE action = 'deleted_agent_unbound'").get() as any;
    must(JSON.parse(ev?.reason ?? "{}").mountCleared === true, `the record: ${JSON.stringify(ev)}`);
    w.dispose();
  });
}

await check("deleting an agent whose object holds no such agent (wiped): the binding goes, recorded as not cleared, and the answer says revoke_on_github", async () => {
  const w = await world();
  const a = await w.agent("X5");
  const id = await w.connect(a);
  // The runtime's own answer for an agent it does not hold.
  const gone = await a.rt.clearConnection(TENANT, "raft_NOBODY", "github");
  must(!gone.ok && gone.gone === true, `the runtime: ${JSON.stringify(gone)}`);
  w.clearMode.set(a.agentId, "gone");
  const del = await w.call("DELETE", "/agents/by-raft-agent/X5");
  const end = del.body?.connections?.[0];
  must(del.status === 200 && del.body.connectionsClean === false && end?.binding === "removed" && end.mount === "not_cleared" && end.action === "revoke_on_github"
    && /re-authorise/.test(end.message) && /#1128/.test(end.message), `the answer: ${del.status} ${del.text}`);
  const ev = w.db.raw.prepare("SELECT reason FROM connector_events WHERE action = 'deleted_agent_unbound'").get() as any;
  must(!w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'X5'").get() && JSON.parse(ev?.reason ?? "{}").mountCleared === false
    && (await renewalAudience(w.db, TENANT, id)).to.length === 0, `the record: ${JSON.stringify(ev)}`);
  w.dispose();
});

await check("a reconnect in place hands no new credential to a deleted agent still bound (its delete's clear was refused)", async () => {
  const w = await world();
  const a = await w.agent("X6");
  const b = await w.agent("X7");
  const id = await w.connect(a);
  must((await w.call("PUT", `/agents/by-raft-agent/X7/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "bind X7");
  w.clearMode.set(b.agentId, "refused");
  must((await w.call("DELETE", "/agents/by-raft-agent/X7")).body.connections?.[0]?.binding === "kept", "control: the binding was not kept");
  const held = (await w.stored(b)).token;
  const r = await w.reconnect(a, id);
  must(r.status === 200 && r.body.reconnected === true && !r.body.updated.includes("X7") && r.body.updated.includes("X6"), `reconnect: ${r.status} ${r.text}`);
  must((await w.stored(b)).token === held && (await w.stored(a)).token !== held, "the deleted agent was handed the new credential");
  w.dispose();
});

await check("an agent deleted while it is being connected is left unbound, its mount cleared, and the route answers 404", async () => {
  const w = await world();
  const a = await w.agent("X8");
  const b = await w.agent("X9");
  const id = await w.connect(a);
  // PUT: the agent read live, the attach written, then the DELETE lands before the binding.
  w.hooks.afterAttach = async (agentId) => {
    if (agentId === b.agentId) w.db.raw.prepare("UPDATE provisioned_agents SET status = 'deleted', deleted_at = 1 WHERE agent_id = ?").run(agentId);
  };
  const put = await w.call("PUT", `/agents/by-raft-agent/X9/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" });
  must(put.status === 404 && put.body.error.code === "not_found", `put: ${put.status} ${put.text}`);
  must(!w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'X9'").get() && (await w.stored(b)).token === null, "bound, or the copy left");
  // Confirm of a new connector: the same, and the connector made for it alone goes too.
  const c = await w.agent("XA");
  w.hooks.afterAttach = async (agentId) => {
    if (agentId === c.agentId) w.db.raw.prepare("UPDATE provisioned_agents SET status = 'deleted', deleted_at = 1 WHERE agent_id = ?").run(agentId);
  };
  const before = (w.db.raw.prepare("SELECT COUNT(*) AS n FROM connectors").get() as any).n;
  const { grant } = await w.gh.code();
  await c.rt.holdConnection(TENANT, c.agentId, "github", grant, "pend_XA_0001", Date.now() + 600_000, "u_owner");
  const conf = await w.call("POST", "/agents/by-raft-agent/XA/connections/github/confirm", { pending: "pend_XA_0001", raftUserId: "u_owner" });
  must(conf.status === 404 && (w.db.raw.prepare("SELECT COUNT(*) AS n FROM connectors").get() as any).n === before
    && !w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'XA'").get() && (await w.stored(c)).token === null, `confirm: ${conf.status} ${conf.text}`);
  w.dispose();
});

await check("a renewal that finishes after its agent was deleted puts no pair back on its mount", async () => {
  const w = await world();
  const a = await w.agent("XB");
  const id = await w.connect(a);
  await w.expireAt(a, Date.now() + 60_000, id);
  const before = (await w.stored(a)).token;
  // The DELETE lands while the renewal is under way: just after the connector takes the new pair.
  const grants = w.grants as any, rotate = grants.rotate.bind(grants);
  grants.rotate = async (...args: unknown[]) => {
    const landed = await rotate(...args);
    w.db.raw.prepare("UPDATE provisioned_agents SET status = 'deleted', deleted_at = 1 WHERE agent_id = ?").run(a.agentId);
    return landed;
  };
  await w.tool(a);
  const after = await w.stored(a);
  must(w.gh.s.refreshes === 1, `control: no renewal ran (${w.gh.s.refreshes})`);
  // The mount keeps what it held (the call's 401 then finds no connector and marks it broken, as for a removed one).
  must(after.token === before, "the renewed pair was written back to a deleted agent's mount");
  w.dispose();
});

/** The `unbind` events of an agent's connection, as recorded, oldest first. */
const unbinds = (w: Awaited<ReturnType<typeof world>>, raftAgentId: string) =>
  (w.db.raw.prepare("SELECT * FROM connector_events WHERE action = 'unbind' AND raft_agent_id = ? ORDER BY rowid").all(raftAgentId) as any[])
    .map((e) => ({ actor: e.acting_raft_user_id, role: e.acting_role, ...JSON.parse(e.reason ?? "{}") }));

for (const mode of ["refused", "unreachable"] as const) {
  await check(`removing an agent's GitHub connection whose mount clear is ${mode}: 409, the binding kept, the credential still there, recorded not_cleared; the retry removes it`, async () => {
    const w = await world();
    const a = await w.agent(mode === "refused" ? "Z1" : "Z2");
    const id = await w.connect(a);
    const bindingOf = () => w.db.raw.prepare("SELECT connector_id FROM provisioned_connections WHERE raft_agent_id = ?").get(a.raftAgentId) as any;
    w.clearMode.set(a.agentId, mode);
    const r = await w.call("DELETE", `/agents/by-raft-agent/${a.raftAgentId}/connections/github`, { actingRaftUserId: "u_owner", actingRole: "creator" });
    must(r.status === 409 && r.body.outcome === "not_cleared" && r.body.retry === true && JSON.stringify(r.body.agents) === JSON.stringify([a.raftAgentId])
      && r.body.error.code === "mount_not_cleared" && /still holds the connection's credential/.test(r.body.error.message)
      && r.body.binding === "kept" && r.body.action === "retry_delete", `the answer: ${r.status} ${r.text}`);
    must(bindingOf()?.connector_id === id && (await w.stored(a)).token !== null, "the binding went, or the mount was cleared");
    const ev = unbinds(w, a.raftAgentId);
    must(ev.length === 1 && ev[0].outcome === "not_cleared" && ev[0].bindingKept === true && ev[0].actor === "u_owner", `the record: ${JSON.stringify(ev)}`);
    // The object answers again: the same request takes effect, 204, recorded cleared.
    w.clearMode.clear();
    const again = await w.call("DELETE", `/agents/by-raft-agent/${a.raftAgentId}/connections/github`, { actingRaftUserId: "u_owner", actingRole: "creator" });
    must(again.status === 204 && !bindingOf() && (await w.stored(a)).token === null, `retry: ${again.status} ${again.text}`);
    must(unbinds(w, a.raftAgentId).at(-1)?.outcome === "cleared", `the retry's record: ${JSON.stringify(unbinds(w, a.raftAgentId))}`);
    w.dispose();
  });
}

await check("removing an agent's GitHub connection with no actor named: 204, and the event is recorded all the same", async () => {
  const w = await world();
  const a = await w.agent("Z3");
  await w.connect(a);
  const r = await w.call("DELETE", "/agents/by-raft-agent/Z3/connections/github");
  must(r.status === 204 && (await w.stored(a)).token === null, `${r.status} ${r.text}`);
  const ev = unbinds(w, "Z3");
  must(ev.length === 1 && ev[0].outcome === "cleared" && ev[0].actorNamed === false && ev[0].role === "system", `the record: ${JSON.stringify(ev)}`);
  w.dispose();
});

await check("removing an agent's GitHub connection whose mount already holds nothing: 204, recorded none", async () => {
  const w = await world();
  const a = await w.agent("Z4");
  await w.connect(a);
  must((await a.rt.removeCredentialOrWhy(TENANT, a.agentId, "gh")).ok, "control: the key could not be taken off");
  const r = await w.call("DELETE", "/agents/by-raft-agent/Z4/connections/github", { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(r.status === 204 && !w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'Z4'").get(), `${r.status} ${r.text}`);
  must(unbinds(w, "Z4")[0]?.outcome === "none", `the record: ${JSON.stringify(unbinds(w, "Z4"))}`);
  w.dispose();
});

await check("removing an agent's GitHub connection whose object holds no such agent: the binding goes, recorded not_cleared, and the answer says revoke_on_github", async () => {
  const w = await world();
  const a = await w.agent("Z5");
  await w.connect(a);
  w.clearMode.set(a.agentId, "gone");
  const r = await w.call("DELETE", "/agents/by-raft-agent/Z5/connections/github", { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(r.status === 200 && r.body.binding === "removed" && r.body.action === "revoke_on_github" && /#1128/.test(r.body.message), `${r.status} ${r.text}`);
  must(!w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'Z5'").get() && unbinds(w, "Z5")[0]?.outcome === "not_cleared", "binding or record");
  w.dispose();
});

await check("removing an agent's GitHub connection that has no connector (from before connectors) is recorded too, keyed by agent and provider", async () => {
  const w = await world();
  const a = await w.agent("Z6");
  await w.connect(a);
  // As a connection made before connectors: its row names none.
  w.db.raw.prepare("UPDATE provisioned_connections SET connector_id = NULL WHERE raft_agent_id = 'Z6'").run();
  const r = await w.call("DELETE", "/agents/by-raft-agent/Z6/connections/github", { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(r.status === 204 && (await w.stored(a)).token === null, `${r.status} ${r.text}`);
  const ev = w.db.raw.prepare("SELECT * FROM connector_events WHERE action = 'unbind' AND raft_agent_id = 'Z6'").all() as any[];
  must(ev.length === 1 && ev[0].connector_id === null && ev[0].provider === "github" && JSON.parse(ev[0].reason).outcome === "cleared"
    && JSON.parse(ev[0].reason).bound === true, `the record: ${JSON.stringify(ev)}`);
  w.dispose();
});

await check("removing a connection with no binding: an object holding no such agent is a plain clean 204; a refused clear is 409 with no connection kept", async () => {
  const w = await world();
  const a = await w.agent("Z7");
  await w.connect(a);
  w.db.raw.prepare("DELETE FROM provisioned_connections WHERE raft_agent_id = 'Z7'").run();
  w.clearMode.set(a.agentId, "gone");
  const gone = await w.call("DELETE", "/agents/by-raft-agent/Z7/connections/github");
  must(gone.status === 204, `wiped, no binding: ${gone.status} ${gone.text}`);
  w.clearMode.set(a.agentId, "refused");
  const held = await w.call("DELETE", "/agents/by-raft-agent/Z7/connections/github");
  must(held.status === 409 && held.body.binding === "none" && !/was kept/.test(held.body.error.message), `refused, no binding: ${held.status} ${held.text}`);
  w.dispose();
});

await check("disconnecting a connector one of whose agents refuses the clear: 409, that binding and the connector kept, the others unbound; each recorded; the retry finishes", async () => {
  const w = await world();
  const a = await w.agent("Z8");
  const b = await w.agent("Z9");
  const id = await w.connect(a);
  must((await w.call("PUT", `/agents/by-raft-agent/Z9/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "bind Z9");
  w.clearMode.set(b.agentId, "refused");
  const r = await w.call("DELETE", `/connectors/${id}`, { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(r.status === 409 && r.body.outcome === "not_cleared" && r.body.retry === true && JSON.stringify(r.body.agents) === JSON.stringify(["Z9"])
    && r.body.error.code === "partially_disconnected" && JSON.stringify(r.body.detached) === JSON.stringify(["Z8"])
    && r.body.failed?.[0]?.raftAgentId === "Z9" && r.body.failed[0].action === "retry_delete", `the answer: ${r.status} ${r.text}`);
  const bound = (agent: string) => !!w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = ?").get(agent);
  must(!bound("Z8") && bound("Z9") && !!w.db.raw.prepare("SELECT 1 FROM connectors WHERE id = ?").get(id) && (await w.stored(b)).token !== null, "bindings, connector or mount");
  const outcomes = () => Object.fromEntries((w.db.raw.prepare("SELECT raft_agent_id, reason FROM connector_events WHERE action = 'unbind' AND connector_id = ? ORDER BY rowid").all(id) as any[])
    .map((e) => [e.raft_agent_id, JSON.parse(e.reason).outcome]));
  must(JSON.stringify(outcomes()) === JSON.stringify({ Z8: "cleared", Z9: "not_cleared" }), `the records: ${JSON.stringify(outcomes())}`);
  w.clearMode.clear();
  const again = await w.call("DELETE", `/connectors/${id}`, { actingRaftUserId: "u_owner", actingRole: "creator" });
  must(again.status === 200 && again.body.disconnected === true && !bound("Z9") && !w.db.raw.prepare("SELECT 1 FROM connectors WHERE id = ?").get(id)
    && (await w.stored(b)).token === null && outcomes().Z9 === "cleared", `retry: ${again.status} ${again.text}`);
  w.dispose();
});

await check("disconnecting a connector one of whose agents' objects holds no such agent: its binding goes, and the answer says what to do, the operator's cleanup before any revoke", async () => {
  const w = await world();
  const a = await w.agent("ZA");
  const b = await w.agent("ZB");
  const id = await w.connect(a);
  must((await w.call("PUT", `/agents/by-raft-agent/ZB/connections/github`, { connectorId: id, actingRaftUserId: "u_owner", actingRole: "creator" })).status === 200, "bind ZB");
  w.clearMode.set(b.agentId, "gone");
  const r = await w.call("DELETE", `/connectors/${id}`, { actingRaftUserId: "u_owner", actingRole: "creator" });
  const msg = r.body?.revokeOnGithub?.message ?? "";
  must(r.status === 200 && JSON.stringify(r.body.revokeOnGithub?.agents) === JSON.stringify(["ZB"]) && r.body.revokeOnGithub.action === "revoke_on_github"
    && msg.indexOf("#1128") < msg.indexOf("the last resort") && msg.includes("Until then") && msg.indexOf("Until then") < msg.indexOf("the last resort") && /ALL of this GitHub account's tokens/.test(msg), `the answer: ${r.status} ${r.text}`);
  must(!w.db.raw.prepare("SELECT 1 FROM provisioned_connections WHERE raft_agent_id = 'ZB'").get(), "the wiped agent's binding was kept");
  w.dispose();
});

/** A request from inside the box to GitHub's API, as `gh` sends it: the placeholder it was given, in the header. */
function fromBox(run9: ReturnType<typeof run9Fake>, boxId: string) {
  const placeholder = run9.boxes.get(boxId)?.secrets.find((x) => x.name === "GH_TOKEN")?.placeholder ?? "__AP_GH_unknown__";
  return { placeholder, send: () => run9.egress(boxId, "https://api.github.com/user", { authorization: `token ${placeholder}` }) };
}

await check("deleting an agent with a live sandbox: the box is deleted, and a request it makes carries no GitHub token", async () => {
  const run9 = run9Fake();
  const w = await world({ run9 });
  const a = await w.agent("Y1");
  await w.connect(a);
  must((await w.sandbox(a) as any).status === "succeeded", "control: the command did not run");
  const [boxId] = [...run9.boxes.keys()];
  const req = fromBox(run9, boxId!);
  const token = (await w.stored(a)).token!;
  // Control: before the delete, the box's request leaves with the agent's token in it.
  must(req.send()?.authorization === `token ${token}`, `control: the box's request did not carry the token: ${JSON.stringify(req.send())}`);
  const del = await w.call("DELETE", "/agents/by-raft-agent/Y1");
  must(del.status === 200 && del.body.clean === true && del.body.sandboxes?.released?.includes("sandbox") && (del.body.sandboxes.failed ?? []).length === 0,
    `the answer: ${del.status} ${del.text}`);
  // The box is gone: nothing it sends goes anywhere, with the token or without.
  must(req.send() === null && !run9.boxes.has(boxId!), `the box is still there: ${JSON.stringify(req.send())}`);
  w.dispose();
});

await check("deleting an agent whose box run9 will not delete: its registrations are withdrawn first, so the running box's request carries no token; the answer says retry_delete", async () => {
  const run9 = run9Fake();
  const w = await world({ run9 });
  const a = await w.agent("Y2");
  await w.connect(a);
  await w.sandbox(a);
  const [boxId] = [...run9.boxes.keys()];
  const req = fromBox(run9, boxId!);
  const token = (await w.stored(a)).token!;
  must(req.send()?.authorization === `token ${token}`, "control: the box's request did not carry the token");
  run9.f.failDelete = true;
  const del = await w.call("DELETE", "/agents/by-raft-agent/Y2");
  const failed = del.body?.sandboxes?.failed?.[0];
  must(del.status === 200 && del.body.clean === false && failed?.alias === "sandbox" && failed.action === "retry_delete" && failed.egress === "withdrawn",
    `the answer: ${del.status} ${del.text}`);
  // Still running, and still sending: the request leaves with the placeholder, not the token.
  const sent = req.send();
  must(sent !== null && sent.authorization === `token ${req.placeholder}` && !JSON.stringify(sent).includes(token), `the box's request after the delete: ${JSON.stringify(sent)}`);
  // run9 answers again: the repeated delete lets the box go.
  run9.f.failDelete = false;
  const again = await w.call("DELETE", "/agents/by-raft-agent/Y2");
  must(again.status === 200 && again.body.clean === true && !run9.boxes.has(boxId!), `repeat: ${again.status} ${again.text}`);
  w.dispose();
});

await check("deleting an agent whose box run9 will neither delete nor clear: the answer says the egress still holds the token, not clean", async () => {
  const run9 = run9Fake();
  const w = await world({ run9 });
  const a = await w.agent("Y3");
  await w.connect(a);
  await w.sandbox(a);
  const [boxId] = [...run9.boxes.keys()];
  const req = fromBox(run9, boxId!);
  const token = (await w.stored(a)).token!;
  run9.f.failDelete = true;
  // First a removal run9 answers but does not apply: checked, not believed.
  run9.f.ignoreWithdraw = true;
  const quiet = await w.call("DELETE", "/agents/by-raft-agent/Y3");
  must(quiet.body?.sandboxes?.failed?.[0]?.egress === "not_withdrawn" && req.send()?.authorization === `token ${token}`, `an unapplied removal: ${quiet.text}`);
  run9.f.ignoreWithdraw = false; run9.f.failWithdraw = true;
  const del = await w.call("DELETE", "/agents/by-raft-agent/Y3");
  const failed = del.body?.sandboxes?.failed?.[0];
  must(del.status === 200 && del.body.clean === false && failed?.egress === "not_withdrawn" && failed.action === "retry_delete"
    && (del.body.sandboxes.withdrawFailed ?? []).length === 1, `the answer: ${del.status} ${del.text}`);
  // Said as it is: this box still sends the token.
  must(req.send()?.authorization === `token ${token}`, "the fake did not keep the registration it refused to remove");
  run9.f.failDelete = false; run9.f.failWithdraw = false;
  const again = await w.call("DELETE", "/agents/by-raft-agent/Y3");
  must(again.status === 200 && again.body.clean === true && req.send() === null, `repeat: ${again.status} ${again.text}`);
  w.dispose();
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
