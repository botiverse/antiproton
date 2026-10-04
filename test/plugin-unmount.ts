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
let mode: "ok" | "throw" | "hang" | "late" | "gate" = "ok";
/** "late": how long unmount sleeps before trying `ctx.db.put` and `ctx.inbound.create()`, and what each did. */
let lateMs = 0;
let late: { db: string; create: string } | null = null;
let lateDone: Promise<void> = Promise.resolve();
let lateFinished: () => void = () => {};
/** "gate": unmount waits until the case lets it go. */
let gate: Promise<void> = Promise.resolve();
/** A hook the plugin's unmount revokes itself, through `ctx.inbound`. */
let revokeOwn: string | null = null;
let seenByUnmount: { alias: string; inbound: boolean; db: boolean } | null = null;
const handed: Record<string, InboundHooks | undefined> = {};

/** Set by a case to make building the mount's context throw (`#contextFor` asks `mountTools`). */
let toolsThrow = false;
const SWEEP: Plugin = {
  id: "sweep", version: "1.0.0", consoleMount: true,
  mountTools() { if (toolsThrow) throw new Error("the tool list cannot be read"); return SWEEP.tools; },
  tools: [
    { name: "grab", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" },
    { name: "make", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" },
  ],
  async invoke(t, _a, ctx) {
    handed[ctx.alias] = ctx.inbound;
    // A tool call that makes a hook while it runs, as raft's enable_push does.
    if (t === "make") return { hookId: (await ctx.inbound!.create()).hookId };
    return { has: !!ctx.inbound };
  },
  // Signed requests are seen and ignored: nothing is delivered, so no turn runs.
  database: { version: 1, stores: { s: {} } },
  async receive(event, secret) {
    receives++;
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad", rejected: true };
    if (event.headers["x-deliver"]) return { deliver: true, text: "an event" };
    return { deliver: false, reason: "seen" };
  },
  async unmount(ctx) {
    unmountCalls++;
    seenByUnmount = { alias: ctx.alias, inbound: !!ctx.inbound, db: !!ctx.db };
    order.push("unmount:start");
    if (mode === "throw") throw new Error("the service said no");
    if (mode === "hang") await new Promise(() => {});
    if (mode === "gate") await gate;
    if (mode === "late") {
      await new Promise((r) => setTimeout(r, lateMs));
      const tried = async (f: () => Promise<unknown>) => { try { await f(); return "ok"; } catch (e) { return String((e as Error).message); } };
      late = {
        db: await tried(() => ctx.db.put("s", { stale: "from the removed mount" }, "k")),
        create: await tried(() => ctx.inbound!.create()),
      };
      lateFinished();
      return;
    }
    if (revokeOwn) await ctx.inbound!.revoke(revokeOwn);
    order.push("unmount:end");
  },
};
/** The same, without `unmount`: the runtime still has to close its hooks. */
const PLAIN: Plugin = { ...SWEEP, id: "plain", unmount: undefined };

function reset() {
  order.length = 0; unmountCalls = 0; receives = 0; mode = "ok"; revokeOwn = null; seenByUnmount = null;
  late = null; lateMs = 0; toolsThrow = false; lateDone = new Promise((r) => { lateFinished = r; });
  for (const k of Object.keys(handed)) delete handed[k];
}

/** A runtime over the real hook queries, whose index records each revoke in `order` by a label. */
async function runtime(opts: { unmountTimeoutMs?: number } = {}) {
  reset();
  const host = sqliteHost();
  const db1 = d1();
  const real = d1InboundHooks(db1);
  const labels = new Map<string, string>();
  /** Set by a case to hold `directory.create` — the row that makes a hook's URL live — until it settles. */
  const rowGate: { until: Promise<void> | null; reached: () => void; record: boolean } = { until: null, reached: () => {}, record: false };
  const directory = {
    ...real,
    // A hook this file did not make through `hook()` is the one made by a call in flight: "late".
    async revoke(id: string) { order.push(`revoke:${labels.get(id) ?? "late"}`); return real.revoke(id); },
    async create(r: { hookId: string; tenantId: string; agentId: string; alias: string }) {
      if (rowGate.until) { rowGate.reached(); await rowGate.until; }
      if (rowGate.record) order.push(`row:${labels.get(r.hookId) ?? "late"}`);
      return real.create(r);
    },
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
  /**
   * The index as handed to `removeMount` only, with its read after `unmount` held until `until` settles (the read
   * before it is not held). Not the runtime's own handle, which `ctx.inbound.create()` reads for its cap.
   */
  const holding = (until: Promise<void>) => ({
    ...directory,
    async list(t: string, a: string) { if (unmountCalls > 0) await until; return real.list(t, a); },
  });
  return { rt, host, db1, real, directory, holding, rowGate, mount, hook, alive };
}

/** The removal, or a named failure if it has not answered within `ms`: a hang is reported, not waited out. */
async function removeWithin(rt: any, alias: string, directory: unknown, ms: number) {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error(`the removal of ${alias} had not answered ${ms} ms after it began, so the unmount timeout did not end it`)), ms);
  });
  try { return await Promise.race([rt.removeMount("t", "a", alias, directory), late]); }
  finally { clearTimeout(guard); }
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
  const r = await removeWithin(rt, "svc", directory, 2_000);
  const took = Date.now() - started;
  must(r.ok && r.unmountError === "svc's plugin did not finish cleaning up within 40 ms", `remove: ${show(r)}`);
  must(took >= 35 && took < 2_000, `took ${took} ms`);
  must(show(order) === show(["unmount:start", "revoke:h"]), `order: ${show(order)}`);
  must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), `the hook survived: ${show(await alive(h.hookId))}`);
  must(!(await rt.store.getMountByAlias("t", "a", "svc")), "the mount is still there");
  host.dispose();
});

const LEASE = "the unmount of svc has ended; its context cannot be used any more";

await check("past the deadline the context is closed before anything is deleted: a late ctx.db.put and ctx.inbound.create() throw", async () => {
  const { rt, host, holding, mount } = await runtime({ unmountTimeoutMs: 40 });
  await mount("sweep", "svc");
  mode = "late"; lateMs = 100;
  // The index read after unmount waits for the late attempts, so they happen after the deadline and before the
  // hooks are revoked and the mount deleted: the window a close placed after the delete would leave open.
  const r = await removeWithin(rt, "svc", holding(lateDone), 2_000);
  must(r.ok && /within 40 ms/.test(r.unmountError ?? ""), `remove: ${show(r)}`);
  must(late?.db === LEASE, `the late ctx.db.put: ${late?.db}`);
  must(late?.create === LEASE, `the late ctx.inbound.create(): ${late?.create}`);
  host.dispose();
});

await check("a late unmount writes nothing into a new mount that took the alias: its database is empty and it has no extra hook", async () => {
  const { rt, host, real, directory, mount } = await runtime({ unmountTimeoutMs: 40 });
  await mount("sweep", "svc");
  mode = "late"; lateMs = 300;
  const r = await removeWithin(rt, "svc", directory, 2_000);
  must(r.ok && /within 40 ms/.test(r.unmountError ?? ""), `remove: ${show(r)}`);
  await mount("sweep", "svc");
  await lateDone;
  // The state first, so a red names what reached the new mount rather than only that the calls were let through.
  const rows = host.sql.exec("SELECT store, key, value FROM plugin_db WHERE alias = 'svc'").toArray();
  const hooks = (await real.list("t", "a")).filter((h) => h.alias === "svc" && h.revokedAt === null);
  must(rows.length === 0 && hooks.length === 0, `the new mount's database: ${show(rows)}; live hooks it never made: ${hooks.length}`);
  must(late?.db === LEASE && late?.create === LEASE, `the late calls: ${show(late)}`);
  host.dispose();
});

await check("while unmount runs, a tool call on the mount is refused and a push does not reach the plugin or wake the agent", async () => {
  const { rt, host, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  const ev = { headers: { "x-signed-with": h.secret, "x-deliver": "1" }, body: new Uint8Array([1]) };
  // Control: before the removal the same push is accepted, and the pass that follows hands it to the agent.
  must((await rt.receiveHook("t", "a", "svc", h.hookId, ev)).outcome === "delivered", "control: not accepted");
  await rt.deliverPendingInbound("t", "a");
  must(posted.length === 1, `control: ${show(posted)}`);
  posted.length = 0; receives = 0;
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  mode = "gate";
  const removal = rt.removeMount("t", "a", "svc", directory);
  for (let i = 0; i < 50 && unmountCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
  must(unmountCalls === 1, "unmount did not start");
  const call: any = await rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "svc.grab", {});
  must(call.status === "rejected" && call.error?.message === "the `svc` mount is being removed", `the tool call during unmount: ${show(call)}`);
  const pushed = await rt.receiveHook("t", "a", "svc", h.hookId, ev);
  must(pushed.outcome === "ignored" && receives === 0 && posted.length === 0, `the push during unmount: ${show(pushed)}, receives ${receives}, posted ${posted.length}`);
  const log = await rt.inboundLog(1);
  must(log[0]?.reason === "svc is being removed", `record: ${show(log[0])}`);
  // Nothing was queued for the agent either: the pass that would post it finds nothing.
  const pass = await rt.deliverPendingInbound("t", "a");
  must(pass.posted === 0 && posted.length === 0, `the pass during unmount: ${show(pass)}`);
  open();
  must((await removal).ok, "the removal failed");
  host.dispose();
});

await check("a removal called off after unmount (a revoke failed) lets calls reach the mount again", async () => {
  const { rt, host, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  await hook("svc", "h");
  const r = await rt.removeMount("t", "a", "svc", { ...directory, revoke: async () => { throw new Error("D1 write failed"); } });
  must(!r.ok, `remove: ${show(r)}`);
  const call: any = await rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "svc.grab", {});
  must(call.status !== "rejected", `a call after the refusal: ${show(call)}`);
  host.dispose();
});

// ---- two removals, and a mount that changes under one -----------------------------

/** Start a removal whose unmount waits on a gate; resolves once unmount has begun. */
async function heldRemoval(rt: any, alias: string, directory: unknown) {
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  mode = "gate";
  const removal = rt.removeMount("t", "a", alias, directory);
  for (let i = 0; i < 50 && unmountCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
  must(unmountCalls === 1, "unmount did not start");
  return { removal, open };
}

const CHANGED = "svc was removed or added again while this removal was running; it stopped, and the mount now named svc was not touched";

await check("a second removal of the same mount while one runs (a double click) is refused, and does not call unmount", async () => {
  const { rt, host, directory, mount } = await runtime();
  await mount("sweep", "svc");
  const { removal, open } = await heldRemoval(rt, "svc", directory);
  const second = await rt.removeMount("t", "a", "svc", directory);
  must(!second.ok && second.conflict && second.error === "svc is already being removed", `the second removal: ${show(second)}`);
  must(unmountCalls === 1, `unmount was called ${unmountCalls} times`);
  open();
  must((await removal).ok, "the first removal failed");
  host.dispose();
});

await check("a mount removed and added again while the removal's unmount runs: the removal stops, and the new mount and its hook are untouched", async () => {
  const { rt, host, real, directory, mount } = await runtime();
  await mount("sweep", "svc");
  const { removal, open } = await heldRemoval(rt, "svc", directory);
  // Another path deletes the row, and the alias is taken again; the new mount's hook is written straight into the
  // index (its own tools are refused while the alias is marked).
  must(await rt.store.removeMount("t", "a", "svc", null), "control: the row was not there to delete");
  must((await rt.addConsoleMount("t", "a", "sweep", "svc", {})).ok, "the re-add failed");
  const fresh = await rt.store.getMountByAlias("t", "a", "svc");
  await real.create({ hookId: "new-hook", tenantId: "t", agentId: "a", alias: "svc" });
  open();
  const r = await removal;
  must(!r.ok && r.error === CHANGED, `the removal: ${show(r)}`);
  const now = await rt.store.getMountByAlias("t", "a", "svc");
  must(now && now.installationId === fresh.installationId, `the new mount: ${show(now?.installationId)}`);
  must(await real.lookup("new-hook"), "the new mount's hook was revoked");
  host.dispose();
});

await check("a mount added again between the removal's last check and its delete is not deleted: the delete names the installation", async () => {
  const { rt, host, real, directory, mount } = await runtime();
  await mount("sweep", "svc");
  let fresh: any = null;
  let lists = 0;
  // The second revoke pass's read is past every check the runtime makes before the delete.
  const swapping = {
    ...directory,
    async list(t: string, a: string) {
      lists++;
      if (lists === 3) {
        await rt.store.removeMount("t", "a", "svc", null);
        await rt.addConsoleMount("t", "a", "sweep", "svc", {});
        fresh = await rt.store.getMountByAlias("t", "a", "svc");
      }
      return real.list(t, a);
    },
  };
  const r = await rt.removeMount("t", "a", "svc", swapping);
  must(fresh, "control: the swap did not happen");
  must(!r.ok && r.error === CHANGED, `the removal: ${show(r)}`);
  const now = await rt.store.getMountByAlias("t", "a", "svc");
  must(now && now.installationId === fresh.installationId, `the mount now named svc: ${show(now?.installationId ?? null)}`);
  host.dispose();
});

await check("both stores delete only the named installation, and leave another mount under the alias with its databases", async () => {
  const { DurableObjectStore } = await import("../src/store/durable-object.ts");
  const { SqliteStore } = await import("../src/store/sqlite.ts");
  const h = sqliteHost();
  for (const [name, store] of [["durable-object", new DurableObjectStore({ storage: { sql: h.sql, transactionSync: h.transactionSync } } as any)], ["sqlite", new SqliteStore(":memory:")]] as const) {
    await store.init();
    await store.addMount({ tenantId: "t", agentId: "a", alias: "svc", plugin: "sweep", installationId: "console:svc:new", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
    store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "svc", plugin: "sweep" }, "s", "k", "v", null);
    must(!(await store.removeMount("t", "a", "svc", null, "console:svc:old")), `${name}: deleted another installation`);
    must(await store.getMountByAlias("t", "a", "svc"), `${name}: the row went`);
    must(store.pluginDb.summary("t", "a").some((r: any) => r.alias === "svc"), `${name}: its database went`);
    must(await store.removeMount("t", "a", "svc", null, "console:svc:new"), `${name}: the named installation was not deleted`);
  }
  h.dispose();
});

await check("building unmount's context throws: recorded as the reason, and the removal goes on", async () => {
  const { rt, host, directory, mount, hook, alive } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  toolsThrow = true;
  const r = await rt.removeMount("t", "a", "svc", directory);
  must(r.ok && r.unmountError === "svc's plugin could not clean up: the tool list cannot be read", `remove: ${show(r)}`);
  must(unmountCalls === 0, "unmount ran although its context could not be built");
  must(show(await alive(h.hookId)) === show({ resolves: false, secret: false }), "the hook survived");
  must(!(await rt.store.getMountByAlias("t", "a", "svc")), "the mount is still there");
  host.dispose();
});

// ---- pushes accepted before the removal, posted after it -----------------------------

/** A push the mount accepts (202), queued for the agent; the pass that posts it has not run yet. */
async function acceptedPush(rt: any, alias: string, h: { hookId: string; secret: string }) {
  const r = await rt.receiveHook("t", "a", alias, h.hookId, { headers: { "x-signed-with": h.secret, "x-deliver": "1" }, body: new Uint8Array([1]) });
  must(r.outcome === "delivered", `control: the push was not accepted: ${show(r)}`);
}
const GONE = "the mount that received it was removed";

await check("a push accepted before the removal is not handed to the agent after it: settled as ignored, with the reason", async () => {
  const { rt, host, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  await acceptedPush(rt, "svc", h);
  must((await rt.removeMount("t", "a", "svc", directory)).ok, "remove");
  const pass = await rt.deliverPendingInbound("t", "a");
  must(posted.length === 0, `the agent was given: ${show(posted)}`);
  const rec = (await rt.inboundLog(5)).find((e: any) => e.hookId === h.hookId);
  must(rec?.outcome === "ignored" && rec?.reason === GONE, `record: ${show(rec)}`);
  must(pass.left === 0, `still queued: ${show(pass)}`);
  host.dispose();
});

await check("the same, with the alias added again before the pass: a different installation, still ignored", async () => {
  const { rt, host, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  await acceptedPush(rt, "svc", h);
  must((await rt.removeMount("t", "a", "svc", directory)).ok, "remove");
  await mount("sweep", "svc");
  await rt.deliverPendingInbound("t", "a");
  must(posted.length === 0, `the agent was given: ${show(posted)}`);
  const rec = (await rt.inboundLog(5)).find((e: any) => e.hookId === h.hookId);
  must(rec?.outcome === "ignored" && rec?.reason === GONE, `record: ${show(rec)}`);
  // Control: a push the new mount accepts is posted.
  const h2 = await hook("svc", "h2");
  await acceptedPush(rt, "svc", h2);
  await rt.deliverPendingInbound("t", "a");
  must((posted.length as number) === 1, `the new mount's own push: ${show(posted)}`);
  host.dispose();
});

await check("a freshly accepted push carries the current mount's installation, read from the row itself", async () => {
  const { nextPendingInbound } = await import("../src/runtime/inbound.ts");
  const { rt, host, mount, hook } = await runtime();
  await mount("sweep", "svc");
  const h = await hook("svc", "h");
  await acceptedPush(rt, "svc", h);
  const current = (await rt.store.getMountByAlias("t", "a", "svc")).installationId;
  must(typeof current === "string" && current.startsWith("console:svc:"), `control: ${current}`);
  const row = nextPendingInbound(host.sql);
  must(row?.hookId === h.hookId && row.installationId === current, `the queued row stamps ${show(row?.installationId)}, the mount is ${current}`);
  host.dispose();
});

await check("an old inbound_pending table gains the column, nullable, and its rows read null", async () => {
  const { ensureInboundTable, nextPendingInbound } = await import("../src/runtime/inbound.ts");
  // The table in the shape #752 created, with a row in it, then the current code's ensure.
  const old = sqliteHost();
  old.sql.exec(`CREATE TABLE inbound_pending (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, hook_id TEXT NOT NULL, alias TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    message TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    UNIQUE(hook_id, dedupe_key))`);
  old.sql.exec("INSERT INTO inbound_pending(hook_id, alias, dedupe_key, message, received_at) VALUES ('h', 'svc', 'k', 'm', 1)");
  ensureInboundTable(old.sql);
  const row = nextPendingInbound(old.sql);
  must(row?.installationId === null && row.message === "m", `the old row: ${show(row)}`);
  old.dispose();
});

await check("a hand-inserted row with no installation (queued before the deploy) is posted normally, even with its mount gone", async () => {
  const { ensureInboundTable } = await import("../src/runtime/inbound.ts");
  const { rt, host } = await runtime();
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  ensureInboundTable(host.sql);
  host.sql.exec("INSERT INTO inbound_pending(hook_id, alias, dedupe_key, message, received_at, installation_id) VALUES ('old-hook', 'gone', 'k1', 'from before the deploy', ?, NULL)", Date.now());
  await rt.deliverPendingInbound("t", "a");
  must(show(posted) === show(["from before the deploy"]), `posted: ${show(posted)}`);
  const rec = (await rt.inboundLog(5)).find((e: any) => e.hookId === "old-hook");
  must(rec?.outcome === "delivered", `record: ${show(rec)}`);
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
const push = async (hookId: string, secret: string, extra: Record<string, string> = {}) => {
  const r = await worker.fetch(new Request(`https://hooks.test/hooks/${hookId}`, {
    method: "POST", headers: { "x-signed-with": secret, ...extra }, body: "{}",
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
//  (a) the Worker: the index row is revoked and the secret dropped, which is what a removal (and
//      `ctx.inbound.revoke`) does. A route the Worker still holds in its cache (cf/src/hook-route.ts) takes the
//      push to the object once, which finds no secret and answers `unrouted` without asking the plugin; the
//      Worker forgets the route and asks the index, which has no live row: 404. A push after that is a 404
//      before any object is chosen. This is what a service sees after a removal.
//  (b) the agent's object: the row is still live but the secret is gone. A revoke cannot leave this state — it
//      marks the row first and drops the secret second — so it is made here by deleting the secret alone. The
//      Worker resolves the hook and hands it to the object, which finds no secret and records `failed` (503)
//      without asking the plugin, since there is nothing to check a signature against.
await check("(a) after the removal a push to the hook's URL is 404: a cached route reaches the object once, which refuses without the plugin or a wake; then the front door answers alone", async () => {
  const { rt, made } = await mountWithHook("svc");
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  objectsReached = 0;
  const before = await push(made.hookId, made.secret);
  must(before.status === 202 && JSON.parse(before.text).outcome === "ignored" && receives === 1 && objectsReached === 1,
    `control: a push before the removal did not reach the plugin: ${before.status} ${before.text}, receives ${receives}, objects ${objectsReached}`);
  const removed = await object().uiRemoveMount(T, A, "svc");
  must(removed.ok && unmountCalls === 1, `remove: ${show(removed)}, unmount ${unmountCalls}`);
  objectsReached = 0;
  // The control push cached the route, so this one reaches the object, which has no secret for it.
  const after = await push(made.hookId, made.secret, { "x-deliver": "1" });
  must(after.status === 404 && after.text === "", `after the removal: ${after.status} ${after.text}`);
  must(objectsReached === 1, `a cache-routed push reached the agent's object ${objectsReached} times, not once`);
  must(receives === 1, `the plugin's receive ran ${receives - 1} more times`);
  await rt.deliverPendingInbound(T, A);
  must(posted.length === 0, `the agent was given: ${show(posted)}`);
  // The route is forgotten now: the next push is answered at the front door.
  objectsReached = 0;
  const again = await push(made.hookId, made.secret, { "x-deliver": "1" });
  must(again.status === 404 && objectsReached === 0, `the push after: ${again.status}, objects ${objectsReached}`);
});

await check("a push accepted with 202 through the Worker while unmount runs is ignored: the plugin is not asked and the agent is not woken", async () => {
  const { rt, made } = await mountWithHook("svc4");
  const posted: string[] = [];
  rt.postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  mode = "gate";
  const removal = object().uiRemoveMount(T, A, "svc4");
  for (let i = 0; i < 50 && unmountCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
  must(unmountCalls === 1, "unmount did not start");
  const r = await push(made.hookId, made.secret, { "x-deliver": "1" });
  must(r.status === 202 && JSON.parse(r.text).outcome === "ignored", `the push during unmount: ${r.status} ${r.text}`);
  must(receives === 0, `the plugin's receive ran ${receives} times`);
  must((await rt.inboundLog(1))[0]?.reason === "svc4 is being removed", `record: ${show((await rt.inboundLog(1))[0])}`);
  open();
  must((await removal).ok, "the removal failed");
  await rt.deliverPendingInbound(T, A);
  must(posted.length === 0, `the agent was given: ${show(posted)}`);
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

// ---- a hook made by a call already in flight when the removal is decided ------------
//
// Two layers close it. The mark check inside `ctx.inbound.create()`, right before the row is written, refuses a
// create that was still before that point when the removal was decided. The removal's second revoke pass, just
// before the delete, revokes a row written by a create that was already past it. The race is staged with an index
// whose first list after `unmount` returns what it read, then lets the held create finish, then hands the stale
// list to the first revoke pass — the window a real D1 round trip leaves open.

/** A removal whose index lets `creating` finish between reading the first post-unmount list and returning it. */
function racingIndex(directory: any, real: any, release: () => void, creating: () => Promise<unknown>) {
  let lists = 0;
  return {
    ...directory,
    async list(t: string, a: string) {
      lists++;
      const rows = await real.list(t, a);
      order.push(`list:${lists}`);
      if (lists === 2) { release(); await creating(); }
      return rows;
    },
  };
}

/** Patch the store's delete into `order`, so a pass can be shown to run before it. */
function recordDelete(rt: any) {
  const del = rt.store.removeMount.bind(rt.store);
  rt.store.removeMount = async (...a: unknown[]) => { order.push("delete"); return del(...a); };
}

/** The real `/hooks/<id>` route over the same D1 index, and whether it reached any agent's object. */
async function routeAnswer(db1: D1Database, hookId: string) {
  let reached = 0;
  const r = await worker.fetch(new Request(`https://hooks.test/hooks/${hookId}`, { method: "POST", body: "{}" }),
    { ...env, CONTROL_DB: db1, AGENT: { idFromName: (n: string) => n, get: () => { reached++; throw new Error("reached an object"); } } } as never);
  return { status: r.status, reached };
}

await check("(a) a tool call that began before the removal and was held before the row: no live hook remains, and its URL is 404", async () => {
  const { rt, host, db1, real, directory, mount, hook } = await runtime();
  await mount("sweep", "svc");
  await hook("svc", "h0");
  recordDelete(rt);
  // Held while sealing its secret — before the mark check that guards the row.
  let release!: () => void;
  const until = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const atSeal = new Promise<void>((r) => { reached = r; });
  let lateId = "";
  const put = rt.store.putSecret.bind(rt.store);
  rt.store.putSecret = async (t: string, a: string, name: string, v: unknown) => {
    if (name.startsWith("hook:")) { lateId = name.slice("hook:".length); reached(); await until; }
    return put(t, a, name, v);
  };
  const call = rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "svc.make", {});
  await atSeal;
  order.length = 0;
  const r = await rt.removeMount("t", "a", "svc", racingIndex(directory, real, release, () => call));
  must(r.ok, `remove: ${show(r)}`);
  const live = (await real.list("t", "a")).filter((h: any) => h.alias === "svc" && h.revokedAt === null);
  must(live.length === 0, `live hooks left for the removed alias: ${live.length}; order ${show(order)}`);
  const route = await routeAnswer(db1, lateId);
  must(route.status === 404 && route.reached === 0, `the in-flight hook's URL: ${show(route)}`);
  host.dispose();
});

await check("(b) a tool call already past the mark check, held at the row write: the second pass revokes it, after the first pass and before the delete", async () => {
  const { rt, host, db1, real, directory, rowGate, mount, hook } = await runtime();
  await mount("sweep", "svc");
  await hook("svc", "h0");
  recordDelete(rt);
  let release!: () => void;
  rowGate.until = new Promise<void>((r) => { release = r; });
  const atRow = new Promise<void>((r) => { rowGate.reached = r; });
  rowGate.record = true;
  const call = rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "svc.make", {});
  await atRow;
  order.length = 0;
  const r = await rt.removeMount("t", "a", "svc", racingIndex(directory, real, release, () => call));
  must(r.ok, `remove: ${show(r)}`);
  const made: any = await call;
  const live = (await real.list("t", "a")).filter((h: any) => h.alias === "svc" && h.revokedAt === null);
  must(live.length === 0, `live hooks left for the removed alias: ${live.length}; order ${show(order)}`);
  // The pre-unmount read, unmount, the first pass's read (while the held row is written) and revoke, then the
  // re-scan finding the late row, then the delete.
  must(show(order) === show(["list:1", "unmount:start", "unmount:end", "list:2", "row:late", "revoke:h0", "list:3", "revoke:late", "delete"]),
    `order: ${show(order)}`);
  must(made.status === "succeeded", `control: the call did not make its hook, so nothing was left for the second pass: ${show(made)}`);
  must((await routeAnswer(db1, made.result.hookId)).status === 404, "the late hook's URL still resolves");
  host.dispose();
});

await check("the mark check alone: a create still before the row when the removal is decided is refused, and its secret dropped", async () => {
  const { rt, host, real, directory, mount } = await runtime();
  await mount("sweep", "svc");
  let release!: () => void;
  const until = new Promise<void>((r) => { release = r; });
  let reached!: () => void;
  const atSeal = new Promise<void>((r) => { reached = r; });
  let lateId = "";
  const put = rt.store.putSecret.bind(rt.store);
  rt.store.putSecret = async (t: string, a: string, name: string, v: unknown) => {
    if (name.startsWith("hook:")) { lateId = name.slice("hook:".length); reached(); await until; }
    return put(t, a, name, v);
  };
  const call = rt.gateway().invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "svc.make", {});
  await atSeal;
  const r = await rt.removeMount("t", "a", "svc", racingIndex(directory, real, release, () => call));
  must(r.ok, `remove: ${show(r)}`);
  const made: any = await call;
  must(made.status !== "succeeded" && /svc is being removed; no hook was made/.test(show(made)), `the in-flight create: ${show(made)}`);
  must(!(await rt.store.getSecret("t", "a", hookSecretName(lateId))), "its secret was kept");
  host.dispose();
});

for (const h of hosts) h.dispose();

const lines = [`\n  Plugin unmount on removal\n  ${"─".repeat(56)}`];
for (const r of results) {
  lines.push(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${String(r.error).slice(0, 1_500)}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
lines.push(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.stdout.write(lines.join("\n") + "\n", () => process.exit(pass === results.length ? 0 : 1));
