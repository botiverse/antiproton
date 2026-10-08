/**
 * The `reminder` seed through the agent's own object (cf/src/index.ts `AgentDO`), on the two paths that run
 * `provision` there: the console's open (`uiEnsure`, which also reconciles the seeds) and Raft's adopt
 * (`provisionAdopt`). Who gets the seed is decided by its `when` (cf/src/runtime.ts `SeedMount`): every agent
 * on a deployment with reminder-app configured, except one Raft made. test/provision-runtime.ts holds the same
 * rule at the runtime; this file holds it where a person opening an agent actually reaches it.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

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
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  };
}

const REMINDER_APP = { REMINDER_APP_ORIGIN: "https://reminders.example", REMINDER_APP_CREDENTIAL: "rmc.client.secret" };
const hosts: Array<{ dispose(): void }> = [];

/** A deployment: its env, and the agents' objects made on demand, as the Worker's namespace would. */
function deployment(extra: Record<string, unknown>) {
  const objects = new Map<string, any>();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async () => {} },
    ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } }],
    DEEPSEEK_API_KEY: "dk", SESSION_SECRET: "s".repeat(32), SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? fresh(n) },
    ...extra,
  };
  function fresh(n: string) {
    const own = sqliteHost();
    hosts.push(own);
    let alarmAt: number | null = null;
    const o = new AgentDO({
      storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
      blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
    } as never, env as never);
    objects.set(n, o);
    return o;
  }
  const obj = (t: string, a: string) => objects.get(agentObjectName(t, a)) ?? fresh(agentObjectName(t, a));
  /** The console opening the agent's page. */
  const open = (t: string, a: string) => obj(t, a).uiEnsure(t, a, `t_${a}`);
  const mountsOf = async (t: string, a: string): Promise<Array<{ alias: string; plugin: string; publicConfig: unknown }>> =>
    obj(t, a).runtime().store.listMounts(t, a);
  return { obj, open, mountsOf };
}

const originalFetch = globalThis.fetch;
/** Raft and anything else, answered 404, recorded: adopt does not need Raft to answer. */
const sent: string[] = [];
globalThis.fetch = (async (url: any) => { sent.push(String(url)); return new Response("{}", { status: 404 }); }) as any;

await check("console open, reminder-app configured: a new agent gets a reminder mount, and a second open adds no other", async () => {
  const d = deployment(REMINDER_APP);
  await d.open("t", "a1");
  const reminders = (await d.mountsOf("t", "a1")).filter((m) => m.plugin === "reminder");
  must(reminders.length === 1 && reminders[0]!.alias === "reminder", `reminder mounts: ${JSON.stringify(reminders)}`);
  await d.open("t", "a1");
  must((await d.mountsOf("t", "a1")).filter((m) => m.plugin === "reminder").length === 1, "a second open added another");
});

await check("console open, reminder-app not configured: no reminder mount, the rest of the defaults as before", async () => {
  for (const [why, extra] of [
    ["neither", {}],
    ["no credential", { REMINDER_APP_ORIGIN: REMINDER_APP.REMINDER_APP_ORIGIN }],
    ["no origin", { REMINDER_APP_CREDENTIAL: REMINDER_APP.REMINDER_APP_CREDENTIAL }],
  ] as const) {
    const d = deployment(extra);
    await d.open("t", "a2");
    const aliases = (await d.mountsOf("t", "a2")).map((m) => m.alias);
    must(!aliases.includes("reminder"), `${why}: reminder was mounted: ${aliases.join(",")}`);
    must(aliases.includes("state") && aliases.includes("tools"), `${why}: control, the defaults did not arrive: ${aliases.join(",")}`);
  }
});

await check("console open of an agent Raft made, reminder-app configured: no reminder mount, and a mount under the alias is not reconciled", async () => {
  const d = deployment(REMINDER_APP);
  const adopted = await d.obj("t", "raft_1").provisionAdopt("t", "raft_1", JSON.stringify({ name: "Cody", instructions: "be brief", raftOrigin: "https://raft.example" }));
  must(adopted.ok, `adopt failed: ${JSON.stringify(adopted)}`);
  must(!(await d.mountsOf("t", "raft_1")).some((m) => m.plugin === "reminder"), "adopt seeded reminder");
  await d.open("t", "raft_1");
  await d.open("t", "raft_1");
  const after = await d.mountsOf("t", "raft_1");
  must(!after.some((m) => m.plugin === "reminder" || m.alias === "reminder"), `the console open seeded reminder: ${after.map((m) => m.alias).join(",")}`);
  must(after.some((m) => m.alias === "raft") && after.some((m) => m.alias === "state"), `control: ${after.map((m) => m.alias).join(",")}`);
  // One an operator put there by hand keeps its own settings: the seed is not this agent's to reconcile.
  const rt = d.obj("t", "raft_1").runtime();
  must((await rt.addMount("t", "raft_1", { alias: "reminder", plugin: "reminder", config: { timeoutMs: 5_000 } })).ok, "the hand-made mount was refused");
  await d.open("t", "raft_1");
  const kept = (await d.mountsOf("t", "raft_1")).find((m) => m.alias === "reminder");
  must(JSON.stringify(kept?.publicConfig) === JSON.stringify({ timeoutMs: 5_000 }), `the open rewrote its settings: ${JSON.stringify(kept?.publicConfig)}`);
});

await check("console open, reminder-app configured: a reminder mount the owner added from the console keeps its settings and policy", async () => {
  const d = deployment(REMINDER_APP);
  const rt = d.obj("t", "a3").runtime();
  await rt.ready();
  await rt.store.createAgent("t", "a3", { name: "Mine" });
  const added = await rt.addMount("t", "a3", { alias: "reminder", plugin: "reminder", config: { timeoutMs: 5_000 } }, { console: true });
  must(added.ok, `the console add was refused: ${JSON.stringify(added)}`);
  const policy = { write: "approval" };
  await rt.store.updateMountPolicy("t", "a3", "reminder", policy as never);
  const before = await rt.store.getMountByAlias("t", "a3", "reminder");
  must(before && before.installationId.startsWith("console:"), `control: not a console mount: ${JSON.stringify(before)}`);
  await d.open("t", "a3");
  // Control: a seed's own mount, drifted, is put back by the next open, so the reconcile did run.
  await rt.store.updateMountConfig("t", "a3", "web", { account: "open web", maxBytes: 48_000 });
  await d.open("t", "a3");
  const after = await rt.store.getMountByAlias("t", "a3", "reminder");
  must(after?.installationId === before.installationId, `the mount was replaced: ${JSON.stringify(after)}`);
  must(JSON.stringify(after?.publicConfig) === JSON.stringify({ timeoutMs: 5_000 }), `the open rewrote its settings: ${JSON.stringify(after?.publicConfig)}`);
  must(JSON.stringify(after?.policy) === JSON.stringify(policy), `the open rewrote its policy: ${JSON.stringify(after?.policy)}`);
  const web = await rt.store.getMountByAlias("t", "a3", "web");
  must((web?.publicConfig as { maxBytes?: number } | undefined)?.maxBytes === 24_000, `control: the seed's own mount was not reconciled: ${JSON.stringify(web?.publicConfig)}`);
});

globalThis.fetch = originalFetch;
for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
