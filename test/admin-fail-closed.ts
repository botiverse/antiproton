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
const { setLogSink } = await import("../src/core/log.ts");
setLogSink(() => {});

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-814";

// /latency fetches from the Worker; in a test those fetches are recorded and answered here, never sent. Whichever
// world is current records them, so a refused probe shows an outbound fetch as plainly as an object call.
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
    AGENT: { idFromName: (n: string) => n, get: () => objectStub },
    CONTROL_DB: { prepare: () => stmt, batch: async () => [] },
    ARTIFACTS: bucket,
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
  { path: "/admin/service-tokens", method: "PATCH", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/provider-tokens", method: "PATCH", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/usage-costs", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("db.all") },
  { path: "/admin/migrate-engine", method: "GET", refused: 401, passed: (s) => s === 405 },
  { path: "/admin/diagnose", method: "GET", refused: 401, passed: (s) => s === 400 },
  { path: "/admin/transcript", method: "GET", refused: 401, passed: (s) => s === 400 },
  // A signed-in admin or the operator's token (auth.ts isAdmin); its refusal is "no such route".
  { path: "/admin/models", method: "PATCH", refused: 404, passed: (s) => s === 405 },
  // The probes (PROBE_ROUTES): no identity of their own, and three of them start a real turn — a task, a wake, a
  // model call on the deployment's account — so an unauthenticated caller must not reach the object at all (the
  // loop below checks that no object method was called). "Passed" is the object answering: the stub turns every
  // method into { ok: true }.
  { path: "/isolation", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/eviction", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/model-binding", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/sandbox", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/sandbox/cpu?ms=50", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/alarm/arm?ms=1000", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/storage", method: "GET", refused: 401, passed: (s) => s === 200 },
  { path: "/alarm/status", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("object.alarmStatus") },
  // /latency touches no object: its work is a 1 MB put and get in R2 and two outbound fetches, so "passed" is that
  // work, and the refusals below hold that none of it starts without the token.
  { path: "/latency", method: "GET", refused: 401, passed: (s, c) => s === 200 && c.includes("r2.put bench/big.bin") && c.some((x) => x.startsWith("fetch.")) },
  // /conformance/executor is routed by its prefix to its own object (conformance-v2), not to p0, and starts
  // Dynamic Workers there; every method is held to the token, since the switch below answers it whatever the method.
  ...["GET", "HEAD", "OPTIONS", "POST"].map((method): Route => (
    { path: "/conformance/executor", method, refused: 401, passed: (s, c) => s === 200 && c.includes("object.runExecutorSpec") })),
  // A number a probe cannot use is refused, not handed to the object: an unbounded cpuMs and an alarm at an
  // arbitrary delay are the caller's to ask for only within the caps.
  { path: "/sandbox/cpu?ms=abc", method: "GET", refused: 401, passed: (s) => s === 400 },
  { path: "/sandbox/cpu?ms=999999", method: "GET", refused: 401, passed: (s) => s === 400 },
  { path: "/alarm/arm?ms=999999999", method: "GET", refused: 401, passed: (s) => s === 400 },
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

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
