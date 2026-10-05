/**
 * Raft Agent Login (src/plugins/raft-agent-login.ts) against a fake Raft and a fake Connected App, in process: every
 * request either makes goes through `globalThis.fetch`, which `world()` answers by host. The app is modelled on
 * botiverse/reminder-app 0.1.0 at 59c7e4e (reminder-app/src/server/auth.ts and index.ts): a v0 manifest, a callback that turns the one-time
 * code into a `reminder_session` cookie (or answers `grant_recorded_no_session` for a scoped login), and actions under
 * /api/raft/actions/<name> that need the cookie.
 */
import { createRaftPlugin } from "../src/plugins/raft.ts";
import {
  ACTION_MAX_BYTES, AGENT_LOGIN_TOOLS, SESSION_STORE, actionUrl, followsTemplate, appUrlProblem, cookieHeaderFor, freshCookies, parseSetCookie, readManifest, withheld,
} from "../src/plugins/raft-agent-login.ts";
import { setLogSink } from "../src/core/log.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const CREDENTIAL = "sk_agent_logan_0123456789abcdef";
const OTHER = "sk_agent_someone_else_99999999";
const RAFT = "https://raft.example";
const APP = "https://reminder.example";
const MANIFEST_URL = `${APP}/.well-known/raft-app-manifest.json`;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
  finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
}
async function failure(fn: () => Promise<unknown>): Promise<Error> {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error("expected a failure");
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SERVICE = {
  id: "svc_reminder", clientId: "reminder-app", name: "Reminder", description: null,
  homepageUrl: APP, returnUrl: `${APP}/auth/raft/callback`, agentManifestUrl: MANIFEST_URL,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

function manifest(overrides: Record<string, unknown> = {}) {
  const action = (name: string, parameters: Record<string, unknown> = {}) =>
    ({ name, description: `${name} for you`, endpoint: { method: "POST", path: `/api/raft/actions/${name}` }, parameters });
  return {
    schema: "raft-agent-manifest.v0", service: "reminder-app",
    execution: { mode: "http_api", base_url: APP },
    auth: { type: "login_with_raft", login_url: `${APP}/auth/raft` },
    actions: [
      action("create-reminder", { reminder: { type: "object", required: true }, requestId: { type: "string", required: true } }),
      action("list-reminders", { status: { type: "string" } }),
      action("cancel-reminder", { id: { type: "string", required: true } }),
      { name: "view-item", description: "a path parameter", endpoint: { method: "POST", path: "/api/items/{id}/view" }, parameters: { id: { type: "string", required: true } } },
    ],
    ...overrides,
  };
}

type Options = {
  login?: "ok" | "approval" | "install";
  /** What the second and later logins answer, when it differs. */
  laterLogin?: "ok" | "approval";
  maxAge?: number;
  manifest?: Record<string, unknown>;
  /** The callback answers an unscoped login with grant_recorded_no_session too. */
  noSessionEver?: boolean;
  /** The app's action echoes the cookie it was sent, in a field named innocently. */
  echoCookie?: boolean;
  callbackRedirectsTo?: string;
  actionStatus?: number;
  actionHeaders?: Record<string, string>;
  actionBody?: string;
  /** The session cookie's value, when a fixed one is wanted (a short one, say). */
  cookieValue?: string;
  /** Raft answers every login with this HTTP status. */
  loginStatus?: number;
  /** The action's 2xx body is cut off after this text. */
  cutBodyAfter?: string;
  /** The service record Raft answers with, changed. */
  service?: Record<string, unknown>;
};

/** A fake Raft and a fake app; every request is recorded with the headers it carried. */
function world(o: Options = {}) {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = [];
  const logins: any[] = [];
  const codes = new Map<string, { scopes: string[] | null; used: boolean }>();
  const sessions = new Set<string>();
  let serial = 0;
  const accepted = new Set([CREDENTIAL]);
  const svc = { ...SERVICE, ...(o.service ?? {}) };
  const fetch = async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : null;
    seen.push({ method, url: url.href, headers, body });
    if (init.redirect !== "manual") throw new Error(`a request followed redirects: ${url.href}`);
    if (url.origin === RAFT) {
      if (![...accepted].some((c) => headers.authorization === `Bearer ${c}`)) return json(401, { error: "bad credential" });
      if (url.pathname === "/internal/agent-api/integrations" && method === "GET") return json(200, { services: [svc], activeLogins: [] });
      if (url.pathname === "/internal/agent-api/integrations/login" && method === "POST") {
        const req = JSON.parse(body ?? "{}");
        logins.push(req);
        if (o.loginStatus) return json(o.loginStatus, { error: "login store unavailable" });
        const mode = logins.length > 1 && o.laterLogin ? o.laterLogin : (o.login ?? "ok");
        if (mode === "approval") {
          return json(200, { status: "approval_required", service: svc, scopes: req.scopes ?? ["openid"], requestId: "req_pending_1",
            approval: { requestId: "req_pending_1", target: req.target ?? null, actionCardMessageId: req.target ? "msg_card_1" : null } });
        }
        if (mode === "install") {
          return json(200, { status: "install_required", nextAction: "install_from_marketplace", service: svc, scopes: ["openid"],
            installation: { serverSlug: "s", serverName: "Botiverse", marketplaceUrl: "https://raft.example/s/s/settings/applications", target: req.target ?? null, actionCardMessageId: req.target ? "msg_card_2" : null } });
        }
        const code = `code_${++serial}_handoff_secret`;
        codes.set(code, { scopes: req.scopes ?? null, used: false });
        return json(200, { status: logins.length > 1 ? "already_logged_in" : "logged_in", service: svc, scopes: req.scopes ?? ["openid", "profile"], requestId: code });
      }
      return json(404, { error: "no such route" });
    }
    if (url.origin === APP) {
      if (headers.authorization) return json(500, { error: "the Raft credential reached the app" });
      if (url.pathname === "/.well-known/raft-app-manifest.json") return json(200, o.manifest ?? manifest());
      if (url.pathname === "/auth/raft/callback") {
        const code = url.searchParams.get("code") ?? "";
        const issued = codes.get(code);
        if (!issued || issued.used) return json(409, { error: "code_used" });
        issued.used = true;
        if (issued.scopes || o.noSessionEver) {
          return json(400, { error: "grant_recorded_no_session", hint: "Raft recorded the requested agent scope for this app. No reminder-app session was created: for one, log in without a scope." });
        }
        const value = o.cookieValue ?? `sealed.session.${serial}.${crypto.randomUUID()}`;
        sessions.add(value);
        const h = new Headers({ location: o.callbackRedirectsTo ?? "/", "cache-control": "no-store" });
        h.append("set-cookie", `reminder_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${o.maxAge ?? 3600}; Secure`);
        h.append("set-cookie", "reminder_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
        return new Response(null, { status: 302, headers: h });
      }
      if (url.pathname.startsWith("/api/") && method === "POST") {
        const cookie = /(?:^|; )reminder_session=([^;]+)/.exec(headers.cookie ?? "")?.[1];
        if (!cookie || !sessions.has(cookie)) return json(401, { ok: false, error: { message: "Your session expired. Sign in again." } });
        if (headers["content-type"] !== "application/json" || headers.origin) return json(415, { ok: false, error: { message: "Use application/json." } });
        if (o.cutBodyAfter !== undefined) {
          const cut = o.cutBodyAfter;
          const stream = new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode(cut)); },
            pull(c) { c.error(new Error("connection reset mid-body")); },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
        }
        if (o.actionStatus || o.actionBody) {
          return new Response(o.actionBody ?? "{}", { status: o.actionStatus ?? 200, headers: { "content-type": "application/json", ...(o.actionHeaders ?? {}) } });
        }
        const name = url.pathname.split("/").at(-1);
        return json(200, { ok: true, result: { action: name, input: JSON.parse(body ?? "{}"), ...(o.echoCookie ? { debug: { seenHeader: `reminder_session=${cookie}` } } : {}) } });
      }
      return json(404, { ok: false, error: { message: "Not found." } });
    }
    return json(599, { error: `unexpected host ${url.host}` });
  };
  return {
    fetch, seen, logins, sessions,
    accept(credential: string) { accepted.add(credential); },
    install() { globalThis.fetch = fetch as any; },
    actions: () => seen.filter((r) => new URL(r.url).pathname.startsWith("/api/")),
    callbacks: () => seen.filter((r) => new URL(r.url).pathname === "/auth/raft/callback"),
    cookieValues: () => [...sessions],
    revokeAll() { sessions.clear(); },
  };
}

function mount(credential: string | null = CREDENTIAL, tables = new PluginDbTables(sqliteHost()).ensure()) {
  const plugin = createRaftPlugin();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: plugin.id };
  const ctx = {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" },
    alias: "raft", credential, publicConfig: { serverUrl: RAFT },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null, sandboxForms: async () => [], agentSecret: async () => null,
  } as any;
  return { plugin, ctx, tables, scope, row: () => tables.get(scope, SESSION_STORE, SERVICE.id) as any };
}

async function behindGateway() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  const plugin = createRaftPlugin();
  await store.addMount({
    tenantId: "tenant", agentId: "agent", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: { serverUrl: RAFT }, secretRef: "secret:raft", policy: null,
  });
  const gateway = new ToolGateway(store, [plugin], new Set([plugin.id]), { async resolve() { return CREDENTIAL; } });
  return { store, gateway, caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" } as any };
}

// -------------------------------------------------------------------------------------------------------------
// Declarations.

await check("the three tools are declared: login and invoke are writes never replayed on their own, the action list a read", async () => {
  const plugin = createRaftPlugin();
  const byName = new Map(plugin.tools.map((t) => [t.name, t]));
  for (const t of AGENT_LOGIN_TOOLS) must(byName.get(t.name) === t, `${t.name} is not offered by the plugin`);
  const login = byName.get("integrations_login")!, actions = byName.get("integrations_actions")!, invoke = byName.get("integrations_invoke")!;
  must(login.sideEffects === "write" && login.idempotency === "none", `login: ${login.sideEffects}/${login.idempotency}`);
  must(invoke.sideEffects === "write" && invoke.idempotency === "none", `invoke: ${invoke.sideEffects}/${invoke.idempotency}`);
  must(actions.sideEffects === "read" && actions.idempotency === "native", `actions: ${actions.sideEffects}/${actions.idempotency}`);
  // A mount whose snapshot lists none of the generated tools still offers these, as it offers the inbox pull.
  const offered = plugin.mountTools!({ toolSnapshot: { tools: [], basis: "x", takenAt: 0 } } as any).map((t) => t.name);
  for (const n of ["integrations_login", "integrations_actions", "integrations_invoke"]) must(offered.includes(n), `${n} not offered with an empty snapshot`);
  // The sessions are in a store of their own, with no key listed: a diagnosis may say the store exists, never a row's name.
  const stores = plugin.database!.stores;
  must(SESSION_STORE in stores && !(stores[SESSION_STORE]!.listed?.length), `sessions store: ${JSON.stringify(stores[SESSION_STORE])}`);
});

// -------------------------------------------------------------------------------------------------------------
// Units.

await check("cookies: a Domain other than the host that set it is dropped; host, Path, Secure and expiry decide what is sent", async () => {
  const src = new URL(`${APP}/auth/raft/callback`);
  must(parseSetCookie("s=1; Domain=evil.example; Path=/", src) === null, "a cookie for another domain was kept");
  const c = parseSetCookie("s=abc; Path=/api; Secure; Max-Age=60", src)!;
  must(c.host === "reminder.example" && c.path === "/api" && c.secure, JSON.stringify(c));
  must(cookieHeaderFor([c], new URL(`${APP}/api/raft/actions/x`)) === "s=abc", "not sent on its path");
  must(cookieHeaderFor([c], new URL(`${APP}/other`)) === null, "sent outside its Path");
  must(cookieHeaderFor([c], new URL("https://other.example/api/x")) === null, "sent to another host");
  must(cookieHeaderFor([c], new URL("http://reminder.example/api/x")) === null, "a Secure cookie sent over http");
  const gone = parseSetCookie("s=; Path=/; Max-Age=0", src)!;
  must(freshCookies([gone]).length === 0 && cookieHeaderFor([gone], new URL(`${APP}/`)) === null, "an expired cookie is still used");
  // Within the 30-second margin counts as expired, so a session about to lapse is renewed before it is sent.
  must(freshCookies([parseSetCookie("s=1; Max-Age=20", src)!]).length === 0, "a cookie with 20 s left is treated as fresh");
});

await check("withheld walks the whole value: a secret in a nested field, an array, or a key is replaced", async () => {
  const out = JSON.stringify(withheld({ a: [{ deep: { x: "prefix SECRETVALUE suffix" } }], ["k-SECRETVALUE"]: 1, n: 3, b: null }, ["SECRETVALUE"]));
  must(!out.includes("SECRETVALUE") && out.includes("[withheld]") && out.includes('"n":3'), out);
});

await check("app URLs: https only, no user info, no internal host", async () => {
  must(appUrlProblem(`${APP}/x`) === null, "a public https URL was refused");
  for (const bad of ["http://reminder.example/x", "https://user:pw@reminder.example/", "https://10.0.0.7/x", "https://localhost/x", "https://127.0.0.1.nip.io/x", "https://[::1]/x", "not a url"]) {
    must(appUrlProblem(bad) !== null, `accepted ${bad}`);
  }
});

await check("the manifest: v0 is read; v1, a path that leaves the app, and duplicate names are refused", async () => {
  const m = readManifest(manifest(), new URL(MANIFEST_URL));
  must(m.actions.map((a) => a.name).join() === "create-reminder,list-reminders,cancel-reminder,view-item", m.actions.map((a) => a.name).join());
  must(m.actions[0]!.parameters!.requestId!.required === true, "required lost");
  const refused = (value: unknown, why: RegExp) => {
    try { readManifest(value, new URL(MANIFEST_URL)); } catch (e) { must(why.test(String((e as Error).message)), String((e as Error).message)); return; }
    throw new Error(`accepted: ${JSON.stringify(value).slice(0, 120)}`);
  };
  refused({ ...manifest(), schema: "slock-agent-manifest.v1" }, /not one this mount runs/);
  refused(manifest({ actions: [{ name: "x", endpoint: { method: "POST", path: "//evil.example/x" } }] }), /path on the app/);
  refused(manifest({ actions: [{ name: "x", endpoint: { method: "POST", path: "https://evil.example/x" } }] }), /path on the app/);
  refused(manifest({ actions: [{ name: "x", endpoint: { method: "POST", path: "/a" } }, { name: "x", endpoint: { method: "POST", path: "/b" } }] }), /duplicate/);
});

await check("an action URL is pinned to the manifest's own origin, whatever base the manifest names", async () => {
  const at = new URL(MANIFEST_URL);
  const action = readManifest(manifest(), at).actions[1]!;
  must(actionUrl(SERVICE, readManifest(manifest(), at), action, {}).href === `${APP}/api/raft/actions/list-reminders`, "the app's own base was refused");
  for (const base of ["https://evil.example", "https://reminder.example.evil.example", "http://reminder.example"]) {
    const m = readManifest(manifest({ execution: { mode: "http_api", base_url: base } }), at);
    const e = await failure(async () => actionUrl(SERVICE, m, m.actions[1]!, {}));
    must(/only to the manifest's own origin/.test(e.message), `${base}: ${e.message}`);
  }
});

// -------------------------------------------------------------------------------------------------------------
// Login.

await check("login: Raft grants, the callback's cookie is kept sealed, and the result says only that a session is kept", async () => {
  const w = world();
  w.install();
  const m = mount();
  const before = Date.now();
  const out = await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx) as any;
  must(out.status === "grant_active" && out.signedIn === true && out.session?.status === "kept", JSON.stringify(out));
  const expires = Date.parse(out.session.expiresAt);
  must(expires >= before + 3_590_000 && expires <= Date.now() + 3_600_000, `expiresAt ${out.session.expiresAt}`);
  must(w.logins.length === 1 && JSON.stringify(w.logins[0]) === '{"service":"reminder-app"}', JSON.stringify(w.logins));
  // The callback: the one-time code, no redirect followed (`world` throws on any non-manual fetch), no Raft credential.
  const cb = w.callbacks();
  must(cb.length === 1 && new URL(cb[0]!.url).searchParams.get("code") === "code_1_handoff_secret" && !cb[0]!.headers.authorization, JSON.stringify(cb));
  // Neither the cookie nor the one-time code is in the result.
  const text = JSON.stringify(out);
  must(!text.includes("code_1_handoff_secret") && !text.includes("requestId"), `the handoff code is in the result: ${text}`);
  for (const v of w.cookieValues()) must(!text.includes(v), "the session cookie is in the result");
  // Kept, and sealed: the stored row carries neither the cookie nor its name in clear.
  const row = m.row();
  must(row?.v === 1 && typeof row.ciphertext === "string", `row: ${JSON.stringify(row)}`);
  const stored = JSON.stringify(row);
  for (const v of w.cookieValues()) must(!stored.includes(v), "the cookie is stored in clear");
  must(!stored.includes("reminder_session"), "the cookie's name is stored in clear");
});

await check("approval_required is handed back as it came: nothing signed in, no callback, and how to get a card posted", async () => {
  const w = world({ login: "approval" });
  w.install();
  const m = mount();
  const out = await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx) as any;
  must(out.status === "approval_required" && out.signedIn === false && out.approval?.requestId === "req_pending_1" && out.approval.actionCardMessageId === null, JSON.stringify(out));
  must(/again with target/.test(out.next), out.next);
  must(w.callbacks().length === 0 && !m.row(), "a callback ran or a session was kept for an unapproved login");
  // With a target Raft posts the card, and the result names it.
  const carded = await m.plugin.invoke("integrations_login", { service: "reminder-app", target: "#general" }, m.ctx) as any;
  must(w.logins[1]?.target === "#general", `target not sent: ${JSON.stringify(w.logins[1])}`);
  must(carded.approval?.actionCardMessageId === "msg_card_1" && carded.approval.target === "#general" && /card was posted/.test(carded.next), JSON.stringify(carded));
  // An invoke that needs a login answered the same way stops there: the action is not sent.
  const inv = await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx) as any;
  must(inv.status === "approval_required" && inv.invoked === false && w.actions().length === 0, JSON.stringify(inv));
});

await check("install_required is handed back with the Marketplace link and the card when one was posted", async () => {
  const w = world({ login: "install" });
  w.install();
  const m = mount();
  const out = await m.plugin.invoke("integrations_login", { service: "reminder-app", target: "#ops" }, m.ctx) as any;
  must(out.status === "install_required" && out.signedIn === false && out.installation?.actionCardMessageId === "msg_card_2" && /^https:/.test(out.installation.marketplaceUrl), JSON.stringify(out));
  must(w.callbacks().length === 0 && !m.row(), "a callback ran for an app that is not installed");
});

await check("a scoped login the app answers grant_recorded_no_session is a success, and one unscoped login follows for the session", async () => {
  const w = world();
  w.install();
  const m = mount();
  const out = await m.plugin.invoke("integrations_login", { service: "reminder-app", scopes: ["agent:notification:write"] }, m.ctx) as any;
  must(w.logins.length === 2, `logins: ${JSON.stringify(w.logins)}`);
  must(JSON.stringify(w.logins[0].scopes) === '["agent:notification:write"]' && w.logins[1].scopes === undefined, JSON.stringify(w.logins));
  must(w.callbacks().length === 2, `callbacks: ${w.callbacks().length}`);
  must(out.status === "grant_active" && out.signedIn === true && JSON.stringify(out.grantRecorded?.scopes) === '["agent:notification:write"]' && out.session?.status === "kept", JSON.stringify(out));
  // The session is the unscoped login's, so a re-login asks for no scope.
  must(m.row()?.scopes === null, `stored scopes: ${JSON.stringify(m.row()?.scopes)}`);
  // Control: an unscoped login the app answers the same way made no session, and that is a failure.
  const w2 = world({ noSessionEver: true });
  w2.install();
  const m2 = mount();
  const e = await failure(() => m2.plugin.invoke("integrations_login", { service: "reminder-app" }, m2.ctx));
  must(/made no session for an unscoped login/.test(e.message) && w2.logins.length === 1 && !m2.row(), e.message);
});

// -------------------------------------------------------------------------------------------------------------
// Actions and invoke.

await check("the action list is the manifest's, with the session's state and nothing secret", async () => {
  const w = world();
  w.install();
  const m = mount();
  const before = await m.plugin.invoke("integrations_actions", { service: "Reminder" }, m.ctx) as any;
  must(before.actions?.map((a: any) => a.name).join() === "create-reminder,list-reminders,cancel-reminder,view-item" && before.session.status === "none", JSON.stringify(before));
  must(before.actions[0].parameters.requestId.required === true && before.actions[0].method === "POST", JSON.stringify(before.actions[0]));
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const after = await m.plugin.invoke("integrations_actions", { service: "svc_reminder" }, m.ctx) as any;
  must(after.session.status === "kept", JSON.stringify(after.session));
  // One manifest fetch: the second list read the cache.
  must(w.seen.filter((r) => r.url === MANIFEST_URL).length === 1, "the manifest was fetched again within its cache time");
});

await check("invoke runs a manifest action with the session (signing in first when there is none) and returns the app's JSON", async () => {
  const w = world();
  w.install();
  const m = mount();
  const out = await m.plugin.invoke("integrations_invoke", {
    service: "reminder-app", action: "create-reminder",
    params: { requestId: "req-0123456789abcdef", reminder: { title: "stand-up", schedule: { delaySeconds: 600, timezone: "UTC" } } },
  }, m.ctx) as any;
  must(out.action === "create-reminder" && out.result?.ok === true && out.result.result.input.reminder.title === "stand-up", JSON.stringify(out));
  must(w.logins.length === 1 && w.actions().length === 1, `logins ${w.logins.length}, actions ${w.actions().length}`);
  const sent = w.actions()[0]!;
  must(sent.url === `${APP}/api/raft/actions/create-reminder` && sent.headers["content-type"] === "application/json" && /^reminder_session=/.test(sent.headers.cookie ?? ""), JSON.stringify(sent));
  // The expired login-state cookie the callback cleared is not sent.
  must(!/reminder_login/.test(sent.headers.cookie!), `a cleared cookie was sent: ${sent.headers.cookie}`);
  // A second call uses the kept session: no new login.
  await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx);
  must(w.logins.length === 1 && w.actions().length === 2, `second call: logins ${w.logins.length}, actions ${w.actions().length}`);
  // A required parameter left out is refused before anything is sent.
  const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "cancel-reminder", params: {} }, m.ctx));
  must(/missing required parameter id/.test(e.message) && w.actions().length === 2, e.message);
});

await check("only a manifest action is run: any other name is refused before a login or a request to the app", async () => {
  const w = world();
  w.install();
  const m = mount();
  for (const action of ["delete-everything", "../auth/logout", "admin/agent-reminders"]) {
    const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action }, m.ctx));
    must(/manifest has no action/.test(e.message) && /create-reminder, list-reminders, cancel-reminder, view-item/.test(e.message), e.message);
  }
  must(w.logins.length === 0 && w.actions().length === 0 && w.seen.every((r) => r.url === MANIFEST_URL || new URL(r.url).origin === RAFT), JSON.stringify(w.seen.map((r) => r.url)));
});

await check("origin pinning: a manifest whose base is another host sends nothing there, and no session goes anywhere", async () => {
  const w = world({ manifest: manifest({ execution: { mode: "http_api", base_url: "https://collector.example" } }) });
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx));
  must(/only to the manifest's own origin/.test(e.message), e.message);
  must(!w.seen.some((r) => new URL(r.url).host === "collector.example"), "a request reached the other host");
  must(!w.seen.some((r) => r.headers.cookie), "a cookie was sent while the action was refused");
});

await check("redirects are never followed: not the callback's, and an action answered with one is a failure, not a hop", async () => {
  const w = world({ callbackRedirectsTo: "https://collector.example/steal" });
  w.install();
  const m = mount();
  const out = await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx) as any;
  must(out.signedIn === true && !w.seen.some((r) => new URL(r.url).host === "collector.example"), "the callback's redirect was followed");
  const w2 = world({ actionStatus: 302, actionHeaders: { location: "https://collector.example/x" } });
  w2.install();
  const m2 = mount();
  const e = await failure(() => m2.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m2.ctx));
  must(/redirect/.test(e.message) && !w2.seen.some((r) => new URL(r.url).host === "collector.example"), e.message);
});

await check("a return URL or manifest URL Raft names on an internal host, or over http, is never reached", async () => {
  for (const returnUrl of ["https://169.254.169.254/latest/meta-data", "http://reminder.example/auth/raft/callback"]) {
    const w = world({ service: { returnUrl } });
    w.install();
    const m = mount();
    const e = await failure(() => m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx));
    must(/return URL/.test(e.message) && w.callbacks().length === 0 && w.seen.every((r) => new URL(r.url).origin === RAFT), `${returnUrl}: ${e.message}`);
    must(!m.row(), "a session was kept");
  }
  for (const agentManifestUrl of ["https://10.1.2.3/.well-known/raft-app-manifest.json", "http://reminder.example/.well-known/raft-app-manifest.json"]) {
    const w = world({ service: { agentManifestUrl } });
    w.install();
    const m = mount();
    const e = await failure(() => m.plugin.invoke("integrations_actions", { service: "reminder-app" }, m.ctx));
    must(/manifest URL/.test(e.message) && w.seen.every((r) => new URL(r.url).origin === RAFT), `${agentManifestUrl}: ${e.message}`);
  }
});

await check("a path parameter of . or .. is refused with that reason and nothing is sent; an ordinary value goes out on the template", async () => {
  const w = world();
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  for (const id of ["..", "."]) {
    const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "view-item", params: { id } }, m.ctx));
    must(/^a parameter cannot be \. or \.\. \(path parameter id\)/.test(e.message), `${id}: ${e.message}`);
    must(w.actions().length === 0, `${id}: ${w.actions().length} request(s) reached the app: ${w.actions().map((r) => r.url).join()}`);
  }
  // Dot segments inside a value, or ones a server would decode, are refused too.
  for (const id of ["a/../b", "%2e%2e", "..\\x"]) {
    const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "view-item", params: { id } }, m.ctx));
    must(/^a parameter cannot be \. or \.\./.test(e.message) && w.actions().length === 0, `${id}: ${e.message}`);
  }
  // Control: an ordinary value (with characters that need encoding) is sent, as one segment of the template.
  const out = await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "view-item", params: { id: "item 42/x" } }, m.ctx) as any;
  must(out.result?.ok === true && w.actions().length === 1 && new URL(w.actions()[0]!.url).pathname === "/api/items/item%2042%2Fx/view",
    `${JSON.stringify(out)} ${w.actions().map((r) => r.url)}`);
});

await check("the resolved path is compared with the template segment by segment: a collapsed or grown path is refused, a matching one accepted", async () => {
  const t = "/api/items/{id}/view";
  must(followsTemplate(t, "/api/items/item-42/view"), "a matching path was refused");
  must(followsTemplate(t, "/api/items/item%2042%2Fx/view"), "an encoded one-segment value was refused");
  for (const p of ["/api/view", "/api/items/view", "/api/items//view", "/api/items/a/b/view", "/api/items/a/view/x", "/api/things/a/view"]) {
    must(!followsTemplate(t, p), `accepted ${p}`);
  }
  must(followsTemplate("/a/x-{id}.json", "/a/x-7.json") && !followsTemplate("/a/x-{id}.json", "/a/y-7.json"), "a parameter inside a fixed segment");
  must(followsTemplate("/api/raft/actions/list-reminders", "/api/raft/actions/list-reminders") && !followsTemplate("/api/raft/actions/list-reminders", "/api/raft/actions"), "a template with no parameter");
});

await check("a 2xx whose body breaks off mid-read may have landed: marked so, and the gateway records it unknown, not failed", async () => {
  const w = world({ cutBodyAfter: '{"ok":' });
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx)) as any;
  must(e.mayHaveLanded === true && e.transient === true && e.retryable === true && /broke off/.test(e.message), `${e.message} landed=${e.mayHaveLanded} transient=${e.transient}`);
  must(w.actions().length === 1, `actions: ${w.actions().length}`);
  const g = await behindGateway();
  const res: any = await g.gateway.invoke(g.caller, "raft.integrations_invoke", { service: "reminder-app", action: "list-reminders" });
  must(res.status === "unknown", `gateway status: ${res.status} ${JSON.stringify(res).slice(0, 300)}`);
});

await check("a session cookie value of any length is withheld, a short one included", async () => {
  const w = world({ cookieValue: "q7Z", echoCookie: true });
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const out = JSON.stringify(await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx));
  must(out.includes("reminder_session=[withheld]") && !out.includes("q7Z"), out);
});

await check("a login Raft does not answer, or answers 5xx, may have landed (it records a grant and may post a card)", async () => {
  const w = world({ loginStatus: 503 });
  w.install();
  const m = mount();
  const e = await failure(() => m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx)) as any;
  must(e.mayHaveLanded === true && e.transient === true && /HTTP 503/.test(e.message), `${e.message} landed=${e.mayHaveLanded}`);
  globalThis.fetch = (async () => { throw new Error("socket closed"); }) as any;
  const t = await failure(() => m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx)) as any;
  must(t.mayHaveLanded === true && t.transient === true, `transport: ${t.message} landed=${t.mayHaveLanded}`);
  // Control: a 4xx is Raft refusing, which did nothing.
  world({ loginStatus: 404 }).install();
  const f = await failure(() => m.plugin.invoke("integrations_login", { service: "nope" }, m.ctx)) as any;
  must(f.mayHaveLanded !== true && /HTTP 404/.test(f.message), `404: landed=${f.mayHaveLanded}`);
});

await check("an action carries the gateway's operation id as Idempotency-Key, the same on the 401 retry", async () => {
  const w = world();
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  w.revokeAll();
  await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, { ...m.ctx, operationId: "op_abc123" });
  const keys = w.actions().map((r) => r.headers["idempotency-key"]);
  must(keys.length === 2 && keys.every((k) => k === "op_abc123"), `keys: ${JSON.stringify(keys)}`);
  // No operation id, no header.
  await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx);
  must(w.actions().at(-1)!.headers["idempotency-key"] === undefined, "a header was sent with no operation id");
});

await check("an action the app answers 401 drops the session, signs in again and is sent once more — once", async () => {
  const w = world();
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  w.revokeAll();
  const out = await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx) as any;
  must(out.result?.ok === true, JSON.stringify(out));
  must(w.logins.length === 2 && w.actions().length === 2, `logins ${w.logins.length}, actions ${w.actions().length}`);
  must(w.actions()[0]!.headers.cookie !== w.actions()[1]!.headers.cookie, "the retry carried the refused cookie");
  // An app that refuses the new session too is not asked a third time.
  const w2 = world();
  w2.install();
  const m2 = mount();
  await m2.plugin.invoke("integrations_login", { service: "reminder-app" }, m2.ctx);
  const realAdd = w2.sessions.add.bind(w2.sessions);
  w2.revokeAll();
  w2.sessions.add = (() => w2.sessions) as any;
  const e = await failure(() => m2.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m2.ctx));
  w2.sessions.add = realAdd;
  must(/even after signing in again/.test(e.message) && w2.actions().length === 2 && w2.logins.length === 2, `${e.message}; actions ${w2.actions().length}`);
  must(!m2.row(), "a refused session is still kept");
});

await check("an expired session is renewed before the action is sent, not after a refusal", async () => {
  const w = world({ maxAge: 3600 });
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const t0 = originalNow();
  Date.now = () => t0 + 2 * 3600_000;
  const out = await m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx) as any;
  must(out.result?.ok === true, JSON.stringify(out));
  // Two logins (the first and the renewal) and one action, which carried the new session: no 401 round trip.
  must(w.logins.length === 2 && w.actions().length === 1, `logins ${w.logins.length}, actions ${w.actions().length}`);
  Date.now = originalNow;
  // A session with less than the 30-second margin left is renewed the same way.
  const w2 = world({ maxAge: 3600 });
  w2.install();
  const m2 = mount();
  await m2.plugin.invoke("integrations_login", { service: "reminder-app" }, m2.ctx);
  const t1 = originalNow();
  Date.now = () => t1 + 3600_000 - 10_000;
  await m2.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m2.ctx);
  must(w2.logins.length === 2 && w2.actions().length === 1, `short session: logins ${w2.logins.length}, actions ${w2.actions().length}`);
  // Control: well inside its time the kept session is used, with no login.
  Date.now = () => t1 + 60_000;
  await m2.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m2.ctx);
  must(w2.logins.length === 2 && w2.actions().length === 2, `fresh session: logins ${w2.logins.length}, actions ${w2.actions().length}`);
});

await check("a session kept under one credential does not open under another: the new account signs in for itself", async () => {
  const w = world();
  w.install();
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const m = mount(CREDENTIAL, tables);
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  must(m.row(), "nothing kept");
  const same = mount(CREDENTIAL, tables);
  const control = await same.plugin.invoke("integrations_actions", { service: "reminder-app" }, same.ctx) as any;
  must(control.session?.status === "kept", `control: the same credential does not open its own session: ${JSON.stringify(control.session)}`);
  // The same database, another credential (the fake Raft answers it too).
  w.accept(OTHER);
  const other = mount(OTHER, tables);
  const listed = await other.plugin.invoke("integrations_actions", { service: "reminder-app" }, other.ctx) as any;
  must(listed.session?.status === "none", `the old session opened under another credential: ${JSON.stringify(listed.session)}`);
  await other.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, other.ctx);
  must(w.logins.length === 2 && w.actions().length === 1, `the other credential did not sign in for itself: logins ${w.logins.length}`);
});

await check("an app's error body is shown with credential fields and the session withheld; a 5xx says it may have run", async () => {
  const w = world();
  w.install();
  const m = mount();
  await m.plugin.invoke("integrations_login", { service: "reminder-app" }, m.ctx);
  const cookie = w.cookieValues()[0]!;
  const w2 = { ...w };
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/raft/actions/")) {
      return json(409, { ok: false, error: { message: `revision changed for ${cookie}`, token: "eyJabc.def.ghi", sessionId: "x" } });
    }
    return w2.fetch(input, init);
  }) as any;
  const e = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx));
  must(/HTTP 409/.test(e.message) && /revision changed/.test(e.message) && !e.message.includes(cookie) && !e.message.includes("eyJabc"), e.message);
  globalThis.fetch = (async (input: any, init: any) => new URL(String(input)).pathname.startsWith("/api/raft/actions/") ? json(503, { error: "busy" }) : w2.fetch(input, init)) as any;
  const e5 = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx)) as any;
  must(e5.mayHaveLanded === true && /HTTP 503/.test(e5.message), `${e5.message} mayHaveLanded=${e5.mayHaveLanded}`);
  globalThis.fetch = (async (input: any, init: any) => new URL(String(input)).pathname.startsWith("/api/raft/actions/")
    ? new Response("x".repeat(ACTION_MAX_BYTES + 1), { status: 200, headers: { "content-type": "text/plain" } }) : w2.fetch(input, init)) as any;
  const big = await failure(() => m.plugin.invoke("integrations_invoke", { service: "reminder-app", action: "list-reminders" }, m.ctx));
  must(/larger than/.test(big.message), big.message);
});

// -------------------------------------------------------------------------------------------------------------
// The whole path through the gateway: what the model is handed, what is recorded, what is logged.

await check("through the gateway, the session cookie appears in no tool result, no stored row and no log line, even when the app echoes it", async () => {
  const w = world({ echoCookie: true });
  w.install();
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  const plugin = createRaftPlugin();
  await store.addMount({
    tenantId: "tenant", agentId: "agent", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: { serverUrl: RAFT }, secretRef: "secret:raft", policy: null,
  });
  const gateway = new ToolGateway(store, [plugin], new Set([plugin.id]), { async resolve() { return CREDENTIAL; } });
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  const caller = { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" } as any;
  let outputs: unknown[];
  try {
    outputs = [
      await gateway.invoke(caller, "raft.integrations_login", { service: "reminder-app", scopes: ["agent:notification:write"] }),
      await gateway.invoke(caller, "raft.integrations_actions", { service: "reminder-app" }),
      await gateway.invoke(caller, "raft.integrations_invoke", { service: "reminder-app", action: "list-reminders", params: { status: "all" } }),
    ];
  } finally { setLogSink(null); }
  const invoked = outputs[2] as any;
  must(JSON.stringify(invoked).includes("[withheld]"), `the echoed cookie was not replaced: ${JSON.stringify(invoked).slice(0, 400)}`);
  must(outputs.every((o: any) => o.status !== "rejected" && !o.error), `a call failed: ${JSON.stringify(outputs).slice(0, 600)}`);
  const secrets = [...w.cookieValues(), CREDENTIAL, ...w.callbacks().map((r) => new URL(r.url).searchParams.get("code")!)];
  must(w.cookieValues().length >= 1 && w.callbacks().length === 2, "the scenario did not make a session");
  const everywhere = { outputs: JSON.stringify(outputs), stored: JSON.stringify(store.dumpTables()), logs: lines.join("\n") };
  for (const [where, text] of Object.entries(everywhere)) {
    for (const s of secrets) must(!text.includes(s), `${where} carries a secret (${s.slice(0, 12)}…)`);
  }
  // Control: the stored rows do hold the sealed session (so "absent" above is about its form, not its existence), and
  // the logs did record the app calls (so "absent" there is not an empty log).
  must(everywhere.stored.includes("ciphertext"), "no sealed session row was stored");
  must(lines.some((l) => /"evt":"raft\.app"/.test(l) && /"what":"action"/.test(l)), "no app call was logged");
  // The Raft credential went to Raft and nowhere else.
  must(w.seen.every((r) => !r.headers.authorization || new URL(r.url).origin === RAFT), "the Raft credential left for another host");
});

globalThis.fetch = originalFetch;
console.log(`\n  raft agent login\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
