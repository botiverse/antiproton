/**
 * The catalogue reconcile (`AgentRuntime.reconcileSeeds`, cf/src/runtime.ts; the record in src/store/seed-record.ts)
 * through the agent's own object (cf/src/index.ts `AgentDO`), at each place a turn starts — a console steer and
 * follow-up (`uiSay`), `/agent/message` (`startTask`), a hook push the alarm posts, a background job's completion the
 * alarm posts — and at the console's open (`uiEnsure`). What it must never do: add a mount twice, touch an agent whose
 * mounts a caller chose (bench, demo) or the Agents API made, give an agent Raft hosts `reminder`, or run when an agent
 * is only read.
 *
 * "Existing agent" below is one made before agents carried a record: the seven revision-1 mounts and nothing else.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ensureInboundTable, acceptInbound } from "../src/runtime/inbound.ts";
import { recordBackgroundJob } from "../src/runtime/background-jobs.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");
const { AgentRuntime, seedInstallation } = await import("../cf/src/runtime.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

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

/**
 * A deployment: its env, and each agent's object on its own storage. `redeploy` builds every object again over the
 * same storage with a new env, as a deploy that changes the Worker's configuration does.
 */
function deployment(extra: Record<string, unknown>) {
  const objects = new Map<string, any>();
  const storages = new Map<string, ReturnType<typeof sqliteHost>>();
  let envExtra = extra;
  const envOf = (): Record<string, unknown> => ({
    MODEL_QUEUE: { send: async () => {} },
    // The τ² bench's base database is the one object read back: an empty shop is enough to mount `retail`.
    ARTIFACTS: { put: async () => ({}), head: async () => null, list: async () => ({ objects: [] }),
      get: async (k: string) => k === "bench/tau2-db.json" ? { text: async () => JSON.stringify({ users: {}, orders: {}, products: {} }) } : null },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } }],
    DEEPSEEK_API_KEY: "dk", SESSION_SECRET: "s".repeat(32), SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? fresh(n) },
    ...envExtra,
  });
  let env = envOf();
  function fresh(n: string) {
    let own = storages.get(n);
    if (!own) { own = sqliteHost(); hosts.push(own); storages.set(n, own); }
    let alarmAt: number | null = null;
    const o = new AgentDO({
      storage: { sql: own.sql, transactionSync: own.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
      blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => n }, getWebSockets: () => [], exports: {},
      waitUntil: () => {},
    } as never, env as never);
    objects.set(n, o);
    return o;
  }
  const obj = (t: string, a: string) => objects.get(agentObjectName(t, a)) ?? fresh(agentObjectName(t, a));
  const sql = (t: string, a: string) => { obj(t, a); return storages.get(agentObjectName(t, a))!.sql; };
  const mountsOf = async (t: string, a: string): Promise<Array<{ alias: string; plugin: string; installationId: string }>> =>
    obj(t, a).runtime().store.listMounts(t, a);
  const record = async (t: string, a: string) => obj(t, a).runtime().store.seedRecord(t, a);
  const outcome = async (t: string, a: string, alias: string) => (await record(t, a)).outcomes.find((o: any) => o.alias === alias);
  const seededRows = (t: string, a: string) => {
    try {
      return sql(t, a).exec("SELECT status, verdict, span_id, attrs FROM trace_outbox WHERE kind = 'mount.seeded' ORDER BY seq").toArray()
        .map((r: any) => ({ status: String(r.status), verdict: String(r.verdict), spanId: String(r.span_id), attrs: JSON.parse(String(r.attrs)) }));
    } catch { return []; }
  };
  /** Everything a reconcile writes, as text, to compare before and after a read. */
  const footprint = (t: string, a: string) => {
    const q = (s: string) => { try { return sql(t, a).exec(s).toArray(); } catch { return "absent"; } };
    return show({
      mounts: q("SELECT alias, plugin, installation_id FROM mounts ORDER BY alias"),
      state: q("SELECT * FROM seed_reconcile"), outcomes: q("SELECT * FROM seed_outcomes ORDER BY alias"),
      trace: q("SELECT seq FROM trace_outbox WHERE kind = 'mount.seeded'"),
    });
  };
  return {
    obj, sql, mountsOf, record, outcome, seededRows, footprint,
    open: (t: string, a: string) => obj(t, a).uiEnsure(t, a, `t_${a}`),
    say: (t: string, a: string, text: string, mode: "steer" | "followUp" = "steer") => obj(t, a).uiSay(t, a, `t_${a}`, text, mode),
    redeploy(next: Record<string, unknown>) { envExtra = next; env = envOf(); objects.clear(); },
  };
}
type Deployment = ReturnType<typeof deployment>;

/** An agent made before agents carried a record: the revision-1 mounts, a model, no `seed_reconcile` row. */
async function existing(d: Deployment, t: string, a: string, config: Record<string, unknown> = { name: "Old" }) {
  const rt = d.obj(t, a).runtime();
  await rt.ready();
  await rt.store.createAgent(t, a, config);
  for (const m of AgentRuntime.DEFAULT_MOUNTS.filter((x: any) => x.since === 1)) {
    await rt.store.addMount({
      tenantId: t, agentId: a, alias: m.alias, plugin: m.plugin, installationId: seedInstallation(m.alias), connectionId: null,
      toolVersion: rt.pluginVersion(m.plugin) ?? "1.0.0", publicConfig: (m.config ?? {}) as never, secretRef: m.secretRef ?? null, policy: null,
    });
  }
  await rt.bindOperatorModel(t, a);
  // The object serves this agent, as the first request to it would have recorded.
  d.obj(t, a).sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  d.obj(t, a).sql.exec("INSERT OR REPLACE INTO owner(k, tenant_id, agent_id) VALUES ('self',?,?)", t, a);
  return rt;
}
const hasReminder = async (d: Deployment, t: string, a: string) => (await d.mountsOf(t, a)).some((m) => m.plugin === "reminder" || m.alias === "reminder");

/** A push queued at one of the agent's hooks, then the alarm pass that posts it. */
async function pushWake(d: Deployment, t: string, a: string, text = "a push") {
  const sql = d.sql(t, a);
  ensureInboundTable(sql as never);
  acceptInbound(sql as never, { hookId: "h1", alias: "p", dedupeKey: `k-${Math.random()}`, message: text, now: Date.now() });
  await d.obj(t, a).alarm();
}
/** A background job long past its ceiling, which the alarm's step ends and delivers to the agent as a prompt. */
async function backgroundWake(d: Deployment, t: string, a: string) {
  recordBackgroundJob(d.sql(t, a) as never, { tenantId: t, agentId: a },
    { id: `op_${Math.random().toString(36).slice(2)}`, session: "main", mount: "sandbox", tool: "shell", handle: {} }, 1);
  await d.obj(t, a).alarm();
}
const transcriptHas = async (d: Deployment, t: string, a: string, needle: string) =>
  JSON.stringify(await d.obj(t, a).runtime().branchEntries(t, a, "main")).includes(needle);

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as any;

// ---------------------------------------------------------------- backfill at each turn start

for (const [entry, run] of [
  ["a console steer (uiSay)", (d: Deployment) => d.say("t", "old", "hello")],
  ["a console follow-up (uiSay)", (d: Deployment) => d.say("t", "old", "hello", "followUp")],
  ["/agent/message (startTask)", (d: Deployment) => d.obj("t", "old").startTask("t", "old", "t_old", "hello")],
  ["a hook push the alarm posts", (d: Deployment) => pushWake(d, "t", "old", "hello")],
  ["a background completion the alarm posts", (d: Deployment) => backgroundWake(d, "t", "old")],
  ["the console open (uiEnsure)", (d: Deployment) => d.open("t", "old")],
] as const) {
  await check(`an existing console agent gets reminder at ${entry}, recorded as added and the rest as present`, async () => {
    const d = deployment(REMINDER_APP);
    await existing(d, "t", "old");
    must(!(await hasReminder(d, "t", "old")), "control: the agent started with reminder");
    must((await d.record("t", "old")).key === null, "control: the agent started with a record");
    await run(d);
    const reminders = (await d.mountsOf("t", "old")).filter((m) => m.plugin === "reminder");
    must(reminders.length === 1 && reminders[0]!.alias === "reminder" && reminders[0]!.installationId === "inst-reminder", `reminder mounts: ${show(reminders)}`);
    const rec = await d.record("t", "old");
    must(rec.revision === 2 && rec.key !== null, `record: ${show({ revision: rec.revision, key: rec.key })}`);
    const by = Object.fromEntries(rec.outcomes.map((o: any) => [`${o.alias}@${o.since}`, o.outcome]));
    must(by["reminder@2"] === "added", `reminder outcome: ${show(by)}`);
    for (const alias of ["tools", "artifacts", "web", "search", "gh", "sandbox", "state"]) must(by[`${alias}@1`] === "present", `${alias}: ${show(by)}`);
  });
}

await check("what the turn start adds is offered in that same turn: the harness that took the message lists reminder's tools", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  const before = (await (await rt.agent("t", "old")).tools()).map((x: any) => x.name);
  must(!before.some((n: string) => n.startsWith("reminder__")), `control: reminder tools before: ${before.filter((n: string) => n.startsWith("reminder"))}`);
  await d.say("t", "old", "hello");
  must(await transcriptHas(d, "t", "old", "hello"), "control: the message did not land");
  const after = (await (await rt.agent("t", "old")).tools()).map((x: any) => x.name);
  must(after.some((n: string) => n.startsWith("reminder__")), `tools after the steer: ${after.join(",")}`);
});

// ---------------------------------------------------------------- the key

await check("an unchanged key is one read of the agent's row: no write, no outcome read, no mount read", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await d.say("t", "old", "first");
  const seen: string[] = [];
  const sql = d.sql("t", "old");
  const exec = sql.exec.bind(sql);
  (sql as any).exec = (q: string, ...b: unknown[]) => { seen.push(q.replace(/\s+/g, " ").trim()); return exec(q, ...b); };
  let out: any;
  try { out = await rt.reconcileSeeds("t", "old"); } finally { (sql as any).exec = exec; }
  must(out.ran === false && out.why === "unchanged", `the pass: ${show(out)}`);
  const writes = seen.filter((q) => /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(q));
  must(writes.length === 0, `writes: ${show(writes)}`);
  const own = seen.filter((q) => /seed_reconcile|seed_outcomes|FROM mounts/.test(q));
  must(own.length === 1 && /FROM seed_reconcile/.test(own[0]!), `reads of the record and the mounts: ${show(own)}`);
  // And through a turn start: the record and the trace do not move.
  const fp = d.footprint("t", "old");
  await d.say("t", "old", "second");
  must(d.footprint("t", "old") === fp, "a second steer changed the record");
});

await check("declined is not final: an owner who switches reminder back on gets it at the next turn start", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await rt.store.setPluginChoice("t", "old", "reminder", "disable");
  await d.say("t", "old", "while off");
  must(!(await hasReminder(d, "t", "old")), "a switched-off plugin was mounted");
  const off = await d.outcome("t", "old", "reminder");
  must(off?.outcome === "declined" && /switched off/.test(off.reason), `while off: ${show(off)}`);
  await rt.store.setPluginChoice("t", "old", "reminder", "inherit");
  await d.say("t", "old", "back on");
  must(await hasReminder(d, "t", "old"), "switched back on, and still no reminder");
  must((await d.outcome("t", "old", "reminder"))?.outcome === "added", `after: ${show(await d.outcome("t", "old", "reminder"))}`);
});

await check("unavailable is not final: a deployment that gains reminder-app's configuration adds it at the next turn start", async () => {
  const d = deployment({});
  await existing(d, "t", "old");
  await d.say("t", "old", "before");
  must(!(await hasReminder(d, "t", "old")), "mounted on a deployment without reminder-app");
  const un = await d.outcome("t", "old", "reminder");
  must(un?.outcome === "unavailable" && /reminder-app/.test(un.reason), `before: ${show(un)}`);
  d.redeploy(REMINDER_APP);
  await d.say("t", "old", "after");
  must(await hasReminder(d, "t", "old"), "the deployment gained the configuration, and still no reminder");
  must((await d.outcome("t", "old", "reminder"))?.outcome === "added", `after: ${show(await d.outcome("t", "old", "reminder"))}`);
});

await check("an entry added once is never added again: not after a rename, not after a removal, whatever moves the key", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await d.say("t", "old", "first");
  must(await hasReminder(d, "t", "old"), "control: reminder was not added");
  const renamed = await rt.renameMount("t", "old", "reminder", "rem");
  must(renamed.ok, `rename: ${show(renamed)}`);
  // Moves the key, so the next pass runs.
  const k1 = (await d.record("t", "old")).key;
  await rt.store.setPluginChoice("t", "old", "github", "disable");
  await d.say("t", "old", "after the rename");
  must((await d.record("t", "old")).key !== k1, "control: the key did not move, so no pass ran");
  const afterRename = (await d.mountsOf("t", "old")).filter((m) => m.plugin === "reminder").map((m) => m.alias);
  must(afterRename.join() === "rem", `after the rename: ${afterRename.join(",")}`);
  // Removed outright, as an operator would: the alias and the plugin are both free now.
  must(await rt.store.removeMount("t", "old", "rem", null), "control: the removal did nothing");
  const k2 = (await d.record("t", "old")).key;
  await rt.store.setPluginChoice("t", "old", "github", "inherit");
  await d.say("t", "old", "after the removal");
  must((await d.record("t", "old")).key !== k2, "control: the key did not move, so no pass ran");
  const afterRemoval = (await d.mountsOf("t", "old")).filter((m) => m.plugin === "reminder").map((m) => m.alias);
  must(afterRemoval.length === 0, `after the removal: ${afterRemoval.join(",")}`);
  must((await d.outcome("t", "old", "reminder"))?.outcome === "added", "the record forgot it was added");
});

await check("an entry found present is never added again: its mount removed, then the key moved by another plugin's choice", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await d.say("t", "old", "first");
  must((await d.outcome("t", "old", "state"))?.outcome === "present", `control: state was not present: ${show(await d.outcome("t", "old", "state"))}`);
  // Removed as an operator would: the alias and the plugin are both free.
  must(await rt.store.removeMount("t", "old", "state", null), "control: the removal did nothing");
  const k = (await d.record("t", "old")).key;
  await rt.store.setPluginChoice("t", "old", "github", "disable");
  await d.say("t", "old", "after the removal");
  must((await d.record("t", "old")).key !== k, "control: the key did not move, so no pass ran");
  const state = (await d.mountsOf("t", "old")).filter((m) => m.plugin === "state").map((m) => m.alias);
  must(state.length === 0, `state came back: ${state.join(",")}`);
  must((await d.outcome("t", "old", "state"))?.outcome === "present", `the record moved: ${show(await d.outcome("t", "old", "state"))}`);
});

// ---------------------------------------------------------------- concurrency

await check("two turn starts racing add each mount once, write one added trace row, and neither fails", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  // A turn start logs a failed pass rather than failing the message, so the log is where a lost race would show.
  const logged: string[] = [];
  const error = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  let settled: PromiseSettledResult<any>[];
  try {
    settled = await Promise.allSettled([
      d.open("t", "old"),
      d.obj("t", "old").startTask("t", "old", "t_old", "one"),
      d.say("t", "old", "two"),
      rt.reconcileSeeds("t", "old"),
      rt.reconcileSeeds("t", "old"),
    ]);
  } finally { console.error = error; }
  const failed = settled.filter((s) => s.status === "rejected").map((s: any) => String(s.reason?.message ?? s.reason));
  must(failed.length === 0, `failed: ${show(failed)}`);
  const lost = logged.filter((l) => /with the catalogue failed/.test(l));
  must(lost.length === 0, `a pass failed: ${show(lost)}`);
  const reminders = (await d.mountsOf("t", "old")).filter((m) => m.plugin === "reminder");
  must(reminders.length === 1, `reminder mounts: ${show(reminders)}`);
  const added = d.seededRows("t", "old").filter((r) => r.status === "added");
  must(added.length === 1 && added[0]!.attrs.alias === "reminder", `added rows: ${show(added)}`);
  const ran = settled.filter((s: any) => s.status === "fulfilled" && s.value?.ran === true).length;
  must(ran <= 1, `passes that ran: ${ran}`);
});

// ---------------------------------------------------------------- never these agents

await check("a bench agent (an explicit list) is never reconciled: not by a message, a push, a background completion, a console open or startTask", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("bench", "b_1");
  const rt = o.runtime();
  await rt.ready();
  await rt.provision("bench", "b_1", [
    { alias: "tools", plugin: "tools", account: "builtin" },
    { alias: "retail", plugin: "retail", account: "benchmark" },
  ], { chosen: true });
  await rt.bindOperatorModel("bench", "b_1");
  o.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  o.sql.exec("INSERT OR REPLACE INTO owner(k, tenant_id, agent_id) VALUES ('self','bench','b_1')");
  const want = (await d.mountsOf("bench", "b_1")).map((m) => m.alias).sort().join();
  await rt.postMessage("bench", "b_1", "a bench turn");
  must(await transcriptHas(d, "bench", "b_1", "a bench turn"), "control: the bench message did not land");
  await pushWake(d, "bench", "b_1", "a bench push");
  must(await transcriptHas(d, "bench", "b_1", "a bench push"), "control: the push did not land");
  await backgroundWake(d, "bench", "b_1");
  await o.startTask("bench", "b_1", "t_b_1", "via startTask");
  await d.open("bench", "b_1");
  await d.say("bench", "b_1", "via the console");
  const got = (await d.mountsOf("bench", "b_1")).map((m) => m.alias).sort().join();
  must(got === want, `mounts: ${got}, wanted ${want}`);
  const rec = await d.record("bench", "b_1");
  must(rec.chosen && rec.key === null && rec.outcomes.length === 0 && d.seededRows("bench", "b_1").length === 0, `record: ${show(rec)}`);
});

await check("a bench agent made before the chosen mark existed (bench tenant, no mark) is never reconciled, by any entry", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("bench", "b_old");
  const rt = o.runtime();
  await rt.ready();
  // What a bench task left behind before this change: the record `provision` wrote ({}), its own list, no mark.
  await rt.store.createAgent("bench", "b_old", {});
  for (const [alias, plugin] of [["tools", "tools"], ["retail", "retail"]]) {
    await rt.store.addMount({ tenantId: "bench", agentId: "b_old", alias, plugin, installationId: seedInstallation(alias), connectionId: null,
      toolVersion: "1.0.0", publicConfig: { account: "x" }, secretRef: null, policy: null });
  }
  await rt.bindOperatorModel("bench", "b_old");
  o.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  o.sql.exec("INSERT OR REPLACE INTO owner(k, tenant_id, agent_id) VALUES ('self','bench','b_old')");
  must(!(await d.record("bench", "b_old")).chosen, "control: the agent was marked");
  await rt.postMessage("bench", "b_old", "a bench turn");
  must(await transcriptHas(d, "bench", "b_old", "a bench turn"), "control: the bench message did not land");
  await pushWake(d, "bench", "b_old");
  await backgroundWake(d, "bench", "b_old");
  await d.say("bench", "b_old", "via the console");
  await o.startTask("bench", "b_old", "t_b_old", "via startTask");
  await d.open("bench", "b_old");
  const got = (await d.mountsOf("bench", "b_old")).map((m) => m.alias).sort().join();
  must(got === "retail,tools", `mounts: ${got}`);
  const rec = await d.record("bench", "b_old");
  must(rec.key === null && rec.outcomes.length === 0 && d.seededRows("bench", "b_old").length === 0, `record: ${show(rec)}`);
  // Control: the same agent under a console tenant is reconciled, so it is the tenant that keeps it out.
  const c = deployment(REMINDER_APP);
  const crt = c.obj("t", "b_old").runtime();
  await crt.ready();
  await crt.store.createAgent("t", "b_old", {});
  await crt.bindOperatorModel("t", "b_old");
  await crt.postMessage("t", "b_old", "a turn");
  must(await hasReminder(c, "t", "b_old"), "control: an unmarked console-tenant agent was not reconciled");
});

await check("a tau² bench task through its own entry points (benchStart, benchSay) is never reconciled", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("bench", "bench-object");
  await o.benchStart("task1", "be helpful", false);
  await o.benchSay("task1", "hello");
  const got = (await o.runtime().store.listMounts("bench", "b_task1")).map((m: any) => m.alias).sort().join();
  must(got === "retail,tools", `mounts: ${got}`);
  must((await o.runtime().store.seedRecord("bench", "b_task1")).chosen, "the bench agent was not marked");
});

await check("an agent provisioned with an explicit list outside the bench tenant is never reconciled, by any entry", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("t", "demo");
  const rt = o.runtime();
  await rt.ready();
  await rt.provision("t", "demo", [{ alias: "ops", plugin: "demo", account: "fleet" }], { chosen: true });
  await rt.bindOperatorModel("t", "demo");
  await o.startTask("t", "demo", "t_demo", "hello");
  await d.say("t", "demo", "hello again");
  await d.open("t", "demo");
  await pushWake(d, "t", "demo");
  const got = (await d.mountsOf("t", "demo")).map((m) => m.alias).join();
  must(got === "ops", `mounts: ${got}`);
  must(d.seededRows("t", "demo").length === 0, "a demo agent has mount.seeded rows");
});

await check("an ordinary console agent under the console's default tenant `demo` is reconciled: that tenant names no demo", async () => {
  const d = deployment(REMINDER_APP);
  // An agent made before #213 still carries the `ops` mount the seed list gave everyone: no mark of a demo either.
  const rt = await existing(d, "demo", "u-qa_console");
  await rt.store.addMount({ tenantId: "demo", agentId: "u-qa_console", alias: "ops", plugin: "demo", installationId: seedInstallation("ops"),
    connectionId: null, toolVersion: "1.0.0", publicConfig: { account: "demo-fleet" }, secretRef: null, policy: null });
  await d.say("demo", "u-qa_console", "hello");
  must(await hasReminder(d, "demo", "u-qa_console"), `mounts: ${(await d.mountsOf("demo", "u-qa_console")).map((m) => m.alias)}`);
  must((await d.outcome("demo", "u-qa_console", "reminder"))?.outcome === "added", "not recorded as added");
});

await check("an Agents API agent is never reconciled: not by apiPostInput, a console open, a steer, startTask or a push", async () => {
  const d = deployment(REMINDER_APP);
  const agentJson = JSON.stringify({ name: "Api", instructions: "be brief" });
  const o = d.obj("t", "api_1");
  await o.apiPostInput("t", "api_1", agentJson, "s1", "hello", "none");
  await d.open("t", "api_1");
  await d.say("t", "api_1", "from the console");
  await o.startTask("t", "api_1", "t_api_1", "via startTask");
  await pushWake(d, "t", "api_1");
  const mounts = (await d.mountsOf("t", "api_1")).map((m) => m.alias);
  must(mounts.length === 0, `mounts: ${mounts.join(",")}`);
  const rec = await d.record("t", "api_1");
  must(rec.key === null && rec.outcomes.length === 0 && d.seededRows("t", "api_1").length === 0, `record: ${show(rec)}`);
  // An existing API agent made before agents carried a record: same answer at a turn start.
  const old = deployment(REMINDER_APP);
  await existing(old, "t", "api_old", { name: "Api", openai: { name: "Api" } });
  await old.say("t", "api_old", "hello");
  must(!(await hasReminder(old, "t", "api_old")) && (await old.record("t", "api_old")).key === null, "an existing API agent was reconciled");
});

await check("an agent Raft hosts never gets reminder: not at adopt, a push, a background completion, a steer, startTask or a console open; recorded as not-for", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("t", "raft_1");
  const adopted = await o.provisionAdopt("t", "raft_1", JSON.stringify({ name: "Cody", instructions: "be brief", raftOrigin: "https://raft.example" }));
  must(adopted.ok, `adopt: ${show(adopted)}`);
  await pushWake(d, "t", "raft_1", "a raft push");
  must(await transcriptHas(d, "t", "raft_1", "a raft push"), "control: the push did not land");
  await backgroundWake(d, "t", "raft_1");
  await d.say("t", "raft_1", "hello");
  await o.startTask("t", "raft_1", "t_raft_1", "hello");
  await d.open("t", "raft_1");
  must(!(await hasReminder(d, "t", "raft_1")), `mounts: ${(await d.mountsOf("t", "raft_1")).map((m) => m.alias)}`);
  const r = await d.outcome("t", "raft_1", "reminder");
  must(r?.outcome === "not-for" && /raft/.test(r.reason), `reminder outcome: ${show(r)}`);
  must((await d.mountsOf("t", "raft_1")).some((m) => m.alias === "state"), "control: the defaults did not arrive");
  // An existing Raft agent, made before agents carried a record, woken by a push.
  const old = deployment(REMINDER_APP);
  await existing(old, "t", "raft_old", { name: "Old", provisionedBy: "raft" });
  await pushWake(old, "t", "raft_old");
  must(!(await hasReminder(old, "t", "raft_old")), "an existing Raft agent got reminder at a push");
  must((await old.outcome("t", "raft_old", "reminder"))?.outcome === "not-for", "control: the push did not reconcile");
});

// ---------------------------------------------------------------- reads change nothing

await check("reading an agent changes nothing: status, transcript, version, diagnose, API session status, agent()", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  const o = d.obj("t", "old");
  const fp = d.footprint("t", "old");
  await o.taskState("t", "old", "t_old");
  await o.uiTranscript("t", "old", "t_old");
  await o.uiVersion("t", "old", "t_old");
  await o.diagnose("t", "old", "t_old");
  await o.apiSessionStatus("t", "old", "main");
  await rt.agent("t", "old");
  must(d.footprint("t", "old") === fp, `a read changed the record or the mounts: ${d.footprint("t", "old")}`);
  must(!(await hasReminder(d, "t", "old")), "a read added reminder");
  // Control: the same agent at a turn start is reconciled, so the reads above had something to do.
  await d.say("t", "old", "hello");
  must(await hasReminder(d, "t", "old"), "control: a turn start did not reconcile");
});

// ---------------------------------------------------------------- the audit

await check("each changed outcome is a mount.seeded trace row, and the added one is written with the mount or not at all", async () => {
  const d = deployment(REMINDER_APP);
  await existing(d, "t", "old");
  await d.say("t", "old", "hello");
  const rows = d.seededRows("t", "old");
  const reminder = rows.filter((r) => r.attrs.alias === "reminder");
  must(reminder.length === 1, `reminder rows: ${show(reminder)}`);
  must(show(reminder[0]) === show({ status: "added", verdict: "ok", spanId: "reminder@2",
    attrs: { alias: "reminder", plugin: "reminder", since: 2, outcome: "added", reason: null } }), `the row: ${show(reminder[0])}`);
  must(rows.length === 8 && rows.filter((r) => r.status === "present").length === 7, `rows: ${show(rows.map((r) => r.spanId + ":" + r.status))}`);
  // A trace row that cannot be written takes the mount and the record with it.
  const e = deployment(REMINDER_APP);
  await existing(e, "t", "old");
  const sql = e.sql("t", "old");
  sql.exec("CREATE TABLE IF NOT EXISTS trace_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, span_id TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL, verdict TEXT NOT NULL, ms INTEGER, attrs TEXT NOT NULL)");
  sql.exec("CREATE TRIGGER refuse_seeded BEFORE INSERT ON trace_outbox WHEN NEW.kind = 'mount.seeded' AND NEW.status = 'added' BEGIN SELECT RAISE(ABORT, 'trace refused'); END");
  let threw = "";
  try { await e.obj("t", "old").runtime().reconcileSeeds("t", "old"); } catch (x) { threw = String((x as Error).message); }
  must(/trace refused/.test(threw), `control: the trace write did not fail: ${threw || "no throw"}`);
  must(!(await hasReminder(e, "t", "old")), "the mount landed without its trace row");
  const rec = await e.record("t", "old");
  must(rec.key === null && rec.outcomes.length === 0, `the record landed without its trace row: ${show(rec)}`);
  sql.exec("DROP TRIGGER refuse_seeded");
  await e.say("t", "old", "hello");
  must(await hasReminder(e, "t", "old") && e.seededRows("t", "old").some((r) => r.status === "added"), "after the trigger went, the next turn did not add it");
});

// ---------------------------------------------------------------- the node store keeps the same record

await check("the node sqlite store keeps the same record by the same rule", async () => {
  const s = new SqliteStore();
  await s.init();
  await s.createAgent("t", "n", {});
  const mount = (alias: string, plugin: string) => ({ tenantId: "t", agentId: "n", alias, plugin, installationId: `inst-${alias}`, connectionId: null,
    toolVersion: "1", publicConfig: {}, secretRef: null, policy: null });
  const plan = [
    { alias: "state", plugin: "state", since: 1, mount: mount("state", "state") },
    { alias: "reminder", plugin: "reminder", since: 2, withheld: "unavailable" as const, reason: "no origin" },
  ];
  const first = await s.reconcileSeeds("t", "n", { key: "k1", revision: 2, plan });
  must(first.ran && first.added.map((r) => r.alias).join() === "state", `first: ${show(first)}`);
  const again = await s.reconcileSeeds("t", "n", { key: "k1", revision: 2, plan });
  must(!again.ran && again.why === "unchanged", `again: ${show(again)}`);
  await s.removeMount("t", "n", "state", null);
  const plan2 = [plan[0]!, { alias: "reminder", plugin: "reminder", since: 2, mount: mount("reminder", "reminder") }];
  const third = await s.reconcileSeeds("t", "n", { key: "k2", revision: 2, plan: plan2 });
  must(third.ran && third.added.map((r) => r.alias).join() === "reminder", `third: ${show(third)}`);
  must((await s.listMounts("t", "n")).map((m) => m.alias).join() === "reminder", "state was added a second time");
  await s.markSeedsChosen("t", "n");
  const chosen = await s.reconcileSeeds("t", "n", { key: "k3", revision: 2, plan: plan2 });
  must(!chosen.ran && chosen.why === "chosen", `chosen: ${show(chosen)}`);
  const rec = await s.seedRecord("t", "n");
  must(rec.chosen && rec.key === "k2" && rec.outcomes.length === 2, `record: ${show(rec)}`);
  const trace = (s.dumpTables().trace_outbox ?? []) as any[];
  must(trace.filter((r) => r.kind === "mount.seeded").length === 3, `trace rows: ${show(trace)}`);
  await s.close();
});

globalThis.fetch = originalFetch;
for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
