/**
 * A mount being removed (`AgentRuntime.removeMount`): the plugin's `unmount` is asked once, after every refusal
 * and before the runtime revokes the mount's hooks; a throw or a timeout does not block the removal and comes back
 * as the reason; and every hook the plugin left live is revoked, so its URL stops resolving.
 *
 * The hook index is the real `d1InboundHooks` over node:sqlite holding the real migrations, so the revoke the runtime
 * runs and the lookup the Worker's `/hooks/<id>` route runs are the shipped queries. The route cases go through the
 * Worker's own `fetch` and an `AgentDO` (the `cloudflare:workers` stand-in test/console-mounts.ts uses).
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { InboundHooks, Plugin } from "../src/plugins/types.ts";
import { hookSecretName } from "../src/runtime/inbound.ts";
import { agentObjectName } from "../cf/src/object-name.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { AgentRuntime, UNMOUNT_TIMEOUT_MS } = await import("../cf/src/runtime.ts");
const { d1InboundHooks } = await import("../cf/src/control-plane.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const KEK = Buffer.alloc(32, 5).toString("base64");

/** D1 as node:sqlite, with every migration in cf/migrations applied. Errors are thrown, never read as empty. */
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
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  } as unknown as D1Database;
}

// ---- the plugin under test ----------------------------------------------------

/** What happened, in order: the plugin's unmount and every revoke the hook index was asked for. */
const order: string[] = [];
let unmountCalls = 0;
let receives = 0;
let mode: "ok" | "throw" | "hang" = "ok";
/** A hook the plugin's unmount revokes itself, through `ctx.inbound`. */
let revokeOwn: string | null = null;
let seenByUnmount: { alias: string; inbound: boolean; db: boolean } | null = null;
const handed: Record<string, InboundHooks | undefined> = {};

const SWEEP: Plugin = {
  id: "sweep", version: "1.0.0", consoleMount: true,
  tools: [{ name: "grab", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(_t, _a, ctx) { handed[ctx.alias] = ctx.inbound; return { has: !!ctx.inbound }; },
  // Signed requests are seen and ignored: nothing is delivered, so no turn runs.
  async receive(event, secret) {
    receives++;
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad", rejected: true };
    return { deliver: false, reason: "seen" };
  },
  async unmount(ctx) {
    unmountCalls++;
    seenByUnmount = { alias: ctx.alias, inbound: !!ctx.inbound, db: !!ctx.db };
    order.push("unmount:start");
    if (mode === "throw") throw new Error("the service said no");
    if (mode === "hang") await new Promise(() => {});
    if (revokeOwn) await ctx.inbound!.revoke(revokeOwn);
    order.push("unmount:end");
  },
};
/** The same, without `unmount`: the runtime still has to close its hooks. */
const PLAIN: Plugin = { ...SWEEP, id: "plain", unmount: undefined };

function reset() {
  order.length = 0; unmountCalls = 0; receives = 0; mode = "ok"; revokeOwn = null; seenByUnmount = null;
  for (const k of Object.keys(handed)) delete handed[k];
}

/** A runtime over the real hook queries, whose index records each revoke in `order` by a label. */
async function runtime(opts: { unmountTimeoutMs?: number } = {}) {
  reset();
  const host = sqliteHost();
  const real = d1InboundHooks(d1());
  const labels = new Map<string, string>();
  const directory = {
    ...real,
    async revoke(id: string) { order.push(`revoke:${labels.get(id) ?? id}`); return real.revoke(id); },
  };
  const rt: any = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [SWEEP, PLAIN], secretKek: KEK,
    hooks: { origin: "https://hooks.test", directory },
    ...(opts.unmountTimeoutMs ? { unmountTimeoutMs: opts.unmountTimeoutMs } : {}),
  } as any);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  const mount = async (plugin: string, alias: string) => {
    const r = await rt.addConsoleMount("t", "a", plugin, alias, {});
    must(r.ok, `add ${alias}: ${show(r)}`);
  };
  const hook = async (alias: string, label: string) => {
    const r: any = await rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, `${alias}.grab`, {});
    must(r.ok !== false && handed[alias], `grab ${alias}: ${show(r)}`);
    const made = await handed[alias]!.create();
    labels.set(made.hookId, label);
    return made;
  };
  /** Whether the hook still resolves in the index, and whether its secret is still in the agent's store. */
  const alive = async (hookId: string) => ({
    resolves: !!(await real.lookup(hookId)),
    secret: !!(await rt.store.getSecret("t", "a", hookSecretName(hookId))),
  });
  return { rt, host, directory, mount, hook, alive };
}

// ---- the runtime ------------------------------------------------------------

await check("unmount is called exactly once, with the mount's context, before the runtime revokes what it left live", async () => {
  const { rt, host, directory, mount, hook, alive } = await runtime();
  await mount("sweep", "svc");
  const h1 = await hook("svc", "h1");
  const h2 = await hook("svc", "h2");
  revokeOwn = h1.hookId;
  order.length = 0;
  const r = await rt.removeMount("t", "a", "svc", directory);
  must(show(r) === show({ ok: true }), `remove: ${show(r)}`);
  must(unmountCalls === 1, `unmount was called ${unmountCalls} times`);
  // The plugin revokes h1 itself, inside its unmount; the runtime revokes h2, which the plugin left live, after it.
  must(show(order) === show(["unmount:start", "revoke:h1", "unmount:end", "revoke:h2"]), `order: ${show(order)}`);
  must(show(seenByUnmount) === show({ alias: "svc", inbound: true, db: true }), `context: ${show(seenByUnmount)}`);
  for (const h of [h1, h2]) must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), `a hook survived: ${show(await alive(h.hookId))}`);
  must(!(await rt.store.getMountByAlias("t", "a", "svc")), "the mount is still there");
  host.dispose();
});

await check("unmount throws: the mount is still removed, the reason is in the result, and the hooks are revoked", async () => {
  const { rt, host, directory, mount, hook, alive } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  mode = "throw";
  const r = await rt.removeMount("t", "a", "svc", directory);
  must(r.ok && r.unmountError === "svc's plugin could not clean up: the service said no", `remove: ${show(r)}`);
  must(unmountCalls === 1, `unmount was called ${unmountCalls} times`);
  must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), `the hook survived: ${show(await alive(h.hookId))}`);
  must(!(await rt.store.getMountByAlias("t", "a", "svc")), "the mount is still there");
  host.dispose();
});

await check(`unmount hangs: the removal completes after the timeout (${UNMOUNT_TIMEOUT_MS} ms in production, 40 here), says so, and revokes the hooks`, async () => {
  must(UNMOUNT_TIMEOUT_MS === 10_000, `UNMOUNT_TIMEOUT_MS is ${UNMOUNT_TIMEOUT_MS}`);
  const { rt, host, directory, mount, hook, alive } = await runtime({ unmountTimeoutMs: 40 });
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  mode = "hang";
  const started = Date.now();
  const r = await rt.removeMount("t", "a", "svc", directory);
  const took = Date.now() - started;
  must(r.ok && r.unmountError === "svc's plugin did not finish cleaning up within 40 ms", `remove: ${show(r)}`);
  must(took >= 35 && took < 2_000, `took ${took} ms`);
  must(show(order) === show(["unmount:start", "revoke:h"]), `order: ${show(order)}`);
  must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), `the hook survived: ${show(await alive(h.hookId))}`);
  must(!(await rt.store.getMountByAlias("t", "a", "svc")), "the mount is still there");
  host.dispose();
});

await check("a plugin without unmount, with a live hook: removed, not refused with \"revoke first\", and the hook is revoked", async () => {
  const { rt, host, directory, mount, hook, alive } = await runtime();
  await mount("plain", "p");
  const h = await hook("p", "h");
  must(show(await alive(h.hookId)) === show({ resolves: true, secret: true }), "control: the hook was not live before the remove");
  const r = await rt.removeMount("t", "a", "p", directory);
  must(show(r) === show({ ok: true }), `remove: ${show(r)}`);
  must(unmountCalls === 0 && show(order) === show(["revoke:h"]), `order: ${show(order)}, unmount ${unmountCalls}`);
  must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), `the hook survived: ${show(await alive(h.hookId))}`);
  must(!(await rt.store.getMountByAlias("t", "a", "p")), "the mount is still there");
  host.dispose();
});

await check("a refused removal does not call unmount and leaves the hook live: an account, a held call, an unreadable index", async () => {
  const { rt, host, directory, mount, hook, alive } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  await rt.store.setMountSecretRef("t", "a", "svc", "agent:svc");
  const cred = await rt.removeMount("t", "a", "svc", directory);
  must(!cred.ok && cred.conflict && /account attached/.test(cred.error), `credential: ${show(cred)}`);
  await rt.store.setMountSecretRef("t", "a", "svc", null);
  await rt.store.requireApproval({ tenantId: "t", operationId: "op1", agentId: "a", taskId: "main", mountAlias: "svc", tool: "grab", request: {} });
  const held = await rt.removeMount("t", "a", "svc", directory);
  must(!held.ok && held.conflict && /waiting for a decision/.test(held.error), `held: ${show(held)}`);
  await rt.store.decideApproval("t", "op1", "denied", "me");
  const broken = { ...directory, list: async () => { throw new Error("D1 is away"); } };
  const unread = await rt.removeMount("t", "a", "svc", broken);
  must(!unread.ok && unread.conflict && /could not check svc's inbound hooks/.test(unread.error), `unreadable index: ${show(unread)}`);
  must(unmountCalls === 0, `unmount was called ${unmountCalls} times for a removal that was refused`);
  must(show(await alive(h.hookId)) === show({ resolves: true, secret: true }), `a refused removal touched the hook: ${show(await alive(h.hookId))}`);
  must(await rt.store.getMountByAlias("t", "a", "svc"), "a refused removal deleted the mount");
  // Control: with nothing in the way, the same mount goes.
  must((await rt.removeMount("t", "a", "svc", directory)).ok && (unmountCalls as number) === 1, "the control removal failed");
  host.dispose();
});

await check("a hook the runtime cannot revoke refuses the removal with the reason, and the mount stays", async () => {
  const { rt, host, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  await hook("svc", "h");
  const failing = { ...directory, revoke: async () => { throw new Error("D1 write failed"); } };
  const r = await rt.removeMount("t", "a", "svc", failing);
  must(!r.ok && r.conflict && r.error === "could not revoke svc's inbound hook, so it was not removed: D1 write failed", `remove: ${show(r)}`);
  must(await rt.store.getMountByAlias("t", "a", "svc"), "the mount was removed past a live hook");
  host.dispose();
});

// ---- the Worker's /hooks/<id> route and the agent's object ----------------------

const T = "t1", A = "a1";
const CONTROL_DB = d1();
const hosts: Array<{ dispose(): void }> = [];
const objects = new Map<string, any>();
let objectsReached = 0;
class TestDO extends AgentDO {
  protected override extraPlugins() { return [SWEEP]; }
}
const env: Record<string, unknown> = {
  MODEL_QUEUE: { send: async () => {} },
  ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
  ARTIFACT_BUCKET: "b", CONTROL_DB, HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1",
  AUTOMATION_TOKEN: "operator-token", SECRET_KEK: KEK, HOOK_ORIGIN: "https://hooks.test",
  AGENT: { idFromName: (n: string) => n, get: (n: string) => { objectsReached++; return objects.get(n) ?? fresh(n); } },
};
function fresh(n: string) {
  const own = sqliteHost();
  hosts.push(own);
  let alarmAt: number | null = null;
  const o = new TestDO({
    storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
  } as never, env as never);
  objects.set(n, o);
  return o;
}
const object = () => objects.get(agentObjectName(T, A)) ?? fresh(agentObjectName(T, A));
const push = async (hookId: string, secret: string) => {
  const r = await worker.fetch(new Request(`https://hooks.test/hooks/${hookId}`, {
    method: "POST", headers: { "x-signed-with": secret }, body: "{}",
  }), env as never);
  return { status: r.status, text: await r.text() };
};
/** A console mount of `sweep` on the object's runtime, and one hook on it made by the plugin. */
async function mountWithHook(alias: string) {
  reset();
  const rt = object().runtime();
  await rt.store.createAgent(T, A).catch(() => {});
  const added = await rt.addConsoleMount(T, A, "sweep", alias, {});
  must(added.ok, `add ${alias}: ${show(added)}`);
  const r: any = await rt.gateway().invoke({ tenantId: T, agentId: A, taskId: "k" }, `${alias}.grab`, {});
  must(r.ok !== false && handed[alias], `grab ${alias}: ${show(r)}`);
  return { rt, made: await handed[alias]!.create() };
}

// Two different "gone" hooks, answered by two different layers:
//  (a) the Worker: the index row is revoked, which is what a removal (and `ctx.inbound.revoke`) does first. The
//      route's lookup reads only live rows, so the push is a 404 before any object is chosen — the agent's object
//      is never reached, and neither is the plugin. This is what a service sees after a removal.
//  (b) the agent's object: the row is still live but the secret is gone. A revoke cannot leave this state — it
//      marks the row first and drops the secret second — so it is made here by deleting the secret alone. The
//      Worker resolves the hook and hands it to the object, which finds no secret and records `failed` (503)
//      without asking the plugin, since there is nothing to check a signature against.
await check("(a) after the removal a push to the hook's URL is 404 at the Worker: no object and no plugin is reached", async () => {
  const { made } = await mountWithHook("svc");
  objectsReached = 0;
  const before = await push(made.hookId, made.secret);
  must(before.status === 202 && JSON.parse(before.text).outcome === "ignored" && receives === 1 && objectsReached === 1,
    `control: a push before the removal did not reach the plugin: ${before.status} ${before.text}, receives ${receives}, objects ${objectsReached}`);
  const removed = await object().uiRemoveMount(T, A, "svc");
  must(removed.ok && unmountCalls === 1, `remove: ${show(removed)}, unmount ${unmountCalls}`);
  objectsReached = 0;
  const after = await push(made.hookId, made.secret);
  must(after.status === 404 && after.text === "", `after the removal: ${after.status} ${after.text}`);
  must(objectsReached === 0, `the agent's object was reached ${objectsReached} times`);
  must(receives === 1, `the plugin's receive ran ${receives - 1} more times`);
});

await check("(b) a live row whose secret is gone: the object answers 503, records \"this hook has no secret in the agent's store\", and the plugin is not asked", async () => {
  const { rt, made } = await mountWithHook("gh2");
  must(await d1InboundHooks(CONTROL_DB).lookup(made.hookId), "control: the row is not live");
  must(await rt.store.removeSecret(T, A, hookSecretName(made.hookId)), "control: there was no secret to remove");
  objectsReached = 0;
  const r = await push(made.hookId, made.secret);
  must(r.status === 503 && JSON.parse(r.text).outcome === "failed", `push: ${r.status} ${r.text}`);
  must(objectsReached === 1, `the object was reached ${objectsReached} times, so this is not the object's answer`);
  const log = await rt.inboundLog(1);
  must(log[0]?.outcome === "failed" && log[0]?.reason === "this hook has no secret in the agent's store", `record: ${show(log[0])}`);
  must(receives === 0, `the plugin's receive ran ${receives} times`);
});

await check("route: /ui/mount/remove answers 200 with the plugin's reason when unmount fails, above the panel and as unmountError", async () => {
  const { made } = await mountWithHook("gh3");
  mode = "throw";
  const SESSION = "s".repeat(32);
  const { sessionCookieFor } = await import("../cf/src/auth.ts");
  env.SESSION_SECRET = SESSION;
  const cookie = (await sessionCookieFor(SESSION, { email: "a@x.test", name: null, username: null, picture: null, source: "github", agentId: A, tenantId: T }, "gh-a")).split(";")[0]!;
  const post = (accept: string) => worker.fetch(new Request("https://console.test/ui/mount/remove", {
    method: "POST", body: new URLSearchParams({ alias: "gh3" }),
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie, accept },
  }), env as never);
  const r = await post("application/json");
  const text = await r.text();
  const j = JSON.parse(text);
  must(r.status === 200 && j.removed === true && j.unmountError === "gh3's plugin could not clean up: the service said no", `json: ${r.status} ${text.slice(0, 300)}`);
  must(String(j.html).startsWith(`<div class="err">removed, but gh3&#39;s plugin could not clean up: the service said no</div>`), `html: ${String(j.html).slice(0, 200)}`);
  must(!(await d1InboundHooks(CONTROL_DB).lookup(made.hookId)), "the hook still resolves");
});

for (const h of hosts) h.dispose();

const lines = [`\n  Plugin unmount on removal\n  ${"─".repeat(56)}`];
for (const r of results) {
  lines.push(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${String(r.error).slice(0, 1_500)}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
lines.push(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.stdout.write(lines.join("\n") + "\n", () => process.exit(pass === results.length ? 0 : 1));
