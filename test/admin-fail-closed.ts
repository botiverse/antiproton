/**
 * Every operator route, through the Worker's own `fetch`: with AUTOMATION_TOKEN unset nobody is let in, a wrong
 * token is refused, and the right one gets past the gate. /admin/compact, /admin/rename-mount and
 * /admin/provision-push once checked `env.AUTOMATION_TOKEN && header !== token`, which opens when the secret is unset
 * (issue #814); every route now asks auth.ts `isOperator`.
 *
 * "Gets past the gate" is read from the route's own work where it is cheap to see (the object's method was called),
 * and otherwise as an answer that is neither the refusal nor a crash: a method the route does not serve (405) or a
 * query it rejects (400) is an answer only a caller past the gate receives.
 */
import { register } from "node:module";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");
const { sessionCookieFor } = await import("../cf/src/auth.ts");
const { setLogSink } = await import("../src/core/log.ts");
setLogSink(() => {});

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const TOKEN = "operator-token-814";
/** The session sealing key: a cookie minted with it is the same thing a browser presents. */
const SESSION = "s".repeat(32);

// No route here should fetch from the Worker; in a test any fetch is recorded and answered here, never sent. Whichever
// world is current records it, so a refused route shows an outbound fetch as plainly as an object call.
let outbound: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  outbound.push(`fetch.${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
  return new Response("{}");
}) as typeof fetch;

/** An env whose object and database record every call and answer harmlessly. */
function world(token: string | undefined) {
  const calls: string[] = [];
  const objectStub = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => { calls.push(`object.${String(prop)}`); return { ok: true, args }; };
    },
  });
  const stmt: any = {
    bind: () => stmt,
    first: async () => { calls.push("db.first"); return null; },
    all: async () => { calls.push("db.all"); return { results: [] }; },
    run: async () => { calls.push("db.run"); return { meta: { changes: 0 } }; },
  };
  const bucket = {
    put: async (key: string) => { calls.push(`r2.put ${key}`); return {}; },
    get: async (key: string) => { calls.push(`r2.get ${key}`); return { arrayBuffer: async () => new ArrayBuffer(0) }; },
  };
  outbound = calls;
  const env: Record<string, unknown> = {
    // Choosing an object is recorded too, not only calling it: `get` contacts nothing until a method is called, so a
    // path that is handed an object it never uses would otherwise leave no trace.
    AGENT: {
      idFromName: (n: string) => { calls.push(`agent.idFromName ${n}`); return n; },
      get: (id: string) => { calls.push(`agent.get ${id}`); return objectStub; },
    },
    CONTROL_DB: { prepare: () => stmt, batch: async () => [] },
    ARTIFACTS: bucket,
    // A viewer's own session is minted here (below): one route must refuse it whatever it owns.
    SESSION_SECRET: SESSION,
    ...(token === undefined ? {} : { AUTOMATION_TOKEN: token }),
  };
  return { env, calls };
}

type Route = { path: string; method: string; refused: number; passed: (status: number, calls: string[]) => boolean };
const ROUTES: Route[] = [
  // The three that opened (#814): their work is a call on the agent's object, so "passed" is that call.
  { path: "/admin/compact?tenantId=demo&agentId=u-a", method: "POST", refused: 401, passed: (_s, c) => c.includes("object.uiCompact") },
  { path: "/admin/rename-mount?tenantId=demo&agentId=u-a&from=x&to=y", method: "POST", refused: 401, passed: (s, c) => s === 200 && c.includes("object.uiRenameMount") },
  { path: "/admin/provision-push", method: "GET", refused: 401, passed: (s) => s === 405 },
  // The ones that were already closed, held to it.
  { path: "/admin/identity", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("db.all") },
  { path: "/admin/api-keys", method: "GET", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/hooks", method: "PUT", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/mounts", method: "GET", refused: 401, passed: (s) => s === 405 },
  // An in-place settings change; with no body its agent is not named, a 400 only a caller past the gate is given.
  { path: "/admin/mounts", method: "PATCH", refused: 401, passed: (s) => s === 400 },
  // An agent's settings (src/runtime/agent-settings.ts): the read is a call on the object; a PATCH with no body names no agent.
  { path: "/admin/agent-settings?tenantId=demo&agentId=u-a", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("object.adminAgentSettings") },
  { path: "/admin/agent-settings", method: "PATCH", refused: 401, passed: (s, c) => s === 400 && !c.some((x) => x.startsWith("object.")) },
  { path: "/admin/service-tokens", method: "PATCH", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/provider-tokens", method: "PATCH", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/usage-costs", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("db.all") },
  { path: "/admin/migrate-engine", method: "GET", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/diagnose", method: "GET", refused: 401, passed: (s) => s === 400 },
  { path: "/admin/transcript", method: "GET", refused: 401, passed: (s) => s === 400 },
  // The friction scan on demand (cf/src/friction-scan.ts): without a day it is a 400, before anything is read.
  { path: "/admin/friction-scan", method: "POST", refused: 401, passed: (s, c) => s === 400 && !c.some((x) => /^(object|r2)\./.test(x)) },
  // A signed-in admin or the operator's token (auth.ts isAdmin); its refusal is "no such route".
  { path: "/admin/models", method: "PATCH", refused: 404, passed: (s) => s === 405 },
  // The probe (PROBE_ROUTES): no identity of its own, and it starts Dynamic Workers on the deployment's account, so an
  // unauthenticated caller must not reach the object at all (the loop below checks that no object method was called).
  // It is routed by its prefix to its own object (conformance-v2); every method is held to the token, since the
  // switch answers it whatever the method.
  ...["GET", "HEAD", "OPTIONS", "POST"].map((method): Route => (
    { path: "/conformance/executor", method, refused: 401, passed: (s, c) => s === 200 && c.includes("object.runExecutorSpec") })),
];

async function hit(r: Route, token: string | undefined, presented: string | null) {
  const w = world(token);
  const headers: Record<string, string> = {};
  if (presented !== null) headers["x-harness-token"] = presented;
  const res = await worker.fetch(new Request(`https://x${r.path}`, { method: r.method, headers }), w.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: res.status, text: await res.text(), calls: w.calls };
}

for (const r of ROUTES) {
  const name = `${r.method} ${r.path.split("?")[0]}`;
  await check(`${name}: AUTOMATION_TOKEN unset refuses every caller`, async () => {
    for (const presented of [null, "", "anything", "undefined"]) {
      const out = await hit(r, undefined, presented);
      must(out.status === r.refused, `header ${JSON.stringify(presented)}: ${out.status} ${out.text.slice(0, 200)}`);
      must(!out.calls.some((c) => /^(object|r2|fetch)\./.test(c)), `header ${JSON.stringify(presented)} reached the object, R2 or the network: ${out.calls}`);
    }
  });
  await check(`${name}: a wrong or missing token is refused`, async () => {
    for (const presented of [null, "", "operator-token-81", TOKEN + "x"]) {
      const out = await hit(r, TOKEN, presented);
      must(out.status === r.refused, `header ${JSON.stringify(presented)}: ${out.status} ${out.text.slice(0, 200)}`);
      must(!out.calls.some((c) => /^(object|r2|fetch)\./.test(c)), `header ${JSON.stringify(presented)} reached the object, R2 or the network: ${out.calls}`);
    }
  });
  await check(`${name}: the configured token gets past the gate`, async () => {
    const out = await hit(r, TOKEN, TOKEN);
    must(r.passed(out.status, out.calls), `${out.status} ${out.text.slice(0, 200)} calls=${out.calls}`);
  });
}

// The provider routes that name no agent (cf/src/provision/handlers.ts): behind the provider token, not the operator's.
// No token, one that is not a provider token, one this deployment never issued (the database knows none), and the
// operator's own token in either header are all 401, before any object, R2 or network call.
for (const [method, path] of [["POST", "/provision/import-check"], ["GET", "/provision/import-limits"]] as const) {
  await check(`${method} ${path}: refused without a provider token this deployment issued`, async () => {
    for (const headers of [{}, { authorization: "Bearer anything" }, { authorization: "Bearer pt-" + "0".repeat(40) },
      { authorization: `Bearer ${TOKEN}` }, { "x-harness-token": TOKEN }] as Array<Record<string, string>>) {
      const w = world(TOKEN);
      const res = await worker.fetch(new Request(`https://x${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }),
        w.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
      const text = await res.text();
      must(res.status === 401 && JSON.parse(text).error?.code === "unauthorized", `${show(headers)}: ${res.status} ${text.slice(0, 200)}`);
      must(!w.calls.some((c) => /^(object|r2|fetch)\./.test(c)), `${show(headers)} reached the object, R2 or the network: ${w.calls}`);
    }
  });
}

// The diagnostic routes that had no caller are gone. Each is now an unknown path: the 404 index, whoever asks and
// whatever the method, and nothing behind it runs — no object, no R2, no outbound fetch.
const DELETED = [
  "/isolation", "/eviction", "/model-binding", "/sandbox", "/sandbox/cpu?ms=50", "/alarm/arm?ms=1000",
  "/alarm/status", "/storage", "/latency",
];
for (const path of DELETED) {
  await check(`${path.split("?")[0]}: deleted, so the 404 index with no object, R2 or network touched`, async () => {
    for (const method of ["GET", "POST"]) {
      for (const [token, presented] of [[undefined, null], [TOKEN, null], [TOKEN, TOKEN]] as const) {
        const out = await hit({ path, method, refused: 0, passed: () => false }, token, presented);
        must(out.status === 404, `${method} token=${token ?? "unset"} presented=${presented ?? "none"}: ${out.status} ${out.text.slice(0, 200)}`);
        const index = JSON.parse(out.text) as { demo?: string; diagnostics?: string[] };
        must(index.demo === "/ui" && Array.isArray(index.diagnostics), `not the index: ${out.text.slice(0, 200)}`);
        must(!index.diagnostics.includes(path.split("?")[0]), `the index still offers ${path}: ${out.text}`);
        must(!out.calls.some((c) => /^(object|r2|fetch)\./.test(c)), `${method} ${path} reached the object, R2 or the network: ${out.calls}`);
      }
    }
  });
}

// `/agent/activity/reset` empties the object's `do_activity` — the rows its billed time is counted from, with an
// hourly watermark that never runs backwards (src/usage/active.ts) — so it is a write that loses the part of an hour
// not yet charged. It answers a GET, and the session cookie is SameSite=Lax, so a viewer who owns the agent would
// reach it from another site's plain link. It is the operator's: the same door `/bench/activity/reset` uses.
const RESET = "/agent/activity/reset?tenantId=demo&agentId=u-a";
const cookie = (await sessionCookieFor(SESSION,
  { email: "owner@x.test", name: null, username: null, picture: null, source: "github", agentId: "u-a", tenantId: "demo" },
  "gh-u-a")).split(";")[0]!;

await check("GET /agent/activity/reset: the agent's own signed-in owner cannot clear it", async () => {
  for (const [label, presented] of [["a session cookie", null], ["a session cookie and a wrong token", "nope"]] as const) {
    const w = world(TOKEN);
    const headers: Record<string, string> = { cookie };
    if (presented !== null) headers["x-harness-token"] = presented;
    const res = await worker.fetch(new Request(`https://x${RESET}`, { method: "GET", headers }), w.env as never,
      { waitUntil() {}, passThroughOnException() {} } as never);
    must(res.status === 401, `${label}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    must(!w.calls.some((c) => /^(object|r2|fetch)\./.test(c)), `${label} reached the object: ${w.calls}`);
  }
});

await check("GET /agent/activity/reset: the operator's token clears it", async () => {
  const w = world(TOKEN);
  const res = await worker.fetch(new Request(`https://x${RESET}`, { method: "GET", headers: { "x-harness-token": TOKEN } }),
    w.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  must(res.status === 200, `${res.status} ${(await res.text()).slice(0, 200)}`);
  must(w.calls.includes("object.resetActivity"), `the object was not asked: ${w.calls}`);
});

// The mechanism behind #924: the object is chosen from the path's prefix, and a path under none used to land on one
// shared object with no identity. Now such a path is answered before any object is chosen, so the only way an
// unprefixed path reaches an object is to name one itself. Read from the env: no object is chosen, let alone called,
// whoever asks and however. `/agent-other` and the case variants hold the prefix to a whole segment, matched exactly.
const UNPREFIXED = ["/probe/next", "/x", "/agent-other", "/agentx/activity", "/Agent/activity", "/AGENT/activity/reset",
  "/UI", "/Bench/start", "/conformanceX/executor", "/p0", "//agent/activity"];
for (const path of UNPREFIXED) {
  await check(`${path}: under no prefix, so the 404 index and no object chosen`, async () => {
    for (const method of ["GET", "POST"]) {
      for (const [label, token, headers] of [
        ["no credential", undefined, {}], ["a wrong token", TOKEN, { "x-harness-token": "nope" }],
        ["the operator's token", TOKEN, { "x-harness-token": TOKEN }], ["an owner's session", TOKEN, { cookie }],
      ] as Array<[string, string | undefined, Record<string, string>]>) {
        const w = world(token);
        const res = await worker.fetch(new Request(`https://x${path}?tenantId=demo&agentId=u-a`, { method, headers }), w.env as never,
          { waitUntil() {}, passThroughOnException() {} } as never);
        const text = await res.text();
        must(res.status === 404, `${method} with ${label}: ${res.status} ${text.slice(0, 200)}`);
        must((JSON.parse(text) as { demo?: string }).demo === "/ui", `${method} with ${label}: not the index: ${text.slice(0, 200)}`);
        must(!w.calls.some((c) => /^(agent|object|r2|fetch)[. ]/.test(c)), `${method} with ${label} chose or reached an object: ${w.calls}`);
      }
    }
  });
}

// `/` is unprefixed too, and is the redirect to the console: still no object.
await check("/: the redirect to /ui, with no object chosen", async () => {
  const w = world(TOKEN);
  const res = await worker.fetch(new Request("https://x/", { method: "GET", headers: { cookie } }), w.env as never,
    { waitUntil() {}, passThroughOnException() {} } as never);
  must(res.status === 302 && new URL(res.headers.get("location") ?? "").pathname === "/ui", `${res.status} ${res.headers.get("location")}`);
  must(!w.calls.some((c) => /^(agent|object|r2|fetch)[. ]/.test(c)), `chose or reached an object: ${w.calls}`);
});

// The control for the rows above: the recorder sees an object being chosen when a prefix does choose one.
await check("/agent/activity: a prefixed path does choose its object by identity, and the recorder sees it", async () => {
  const w = world(TOKEN);
  const res = await worker.fetch(new Request("https://x/agent/activity?tenantId=demo&agentId=u-a", { headers: { "x-harness-token": TOKEN } }),
    w.env as never, { waitUntil() {}, passThroughOnException() {} } as never);
  must(res.status === 200, `${res.status} ${(await res.text()).slice(0, 200)}`);
  must(w.calls.some((c) => c.startsWith("agent.idFromName ") && c.includes("u-a")) && w.calls.includes("object.activity"), `calls=${w.calls}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
