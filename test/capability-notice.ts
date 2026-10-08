/**
 * Telling an agent what the catalogue reconcile added (`AgentRuntime.postMessage` / `#takeNotices` and
 * `capabilityNotice`, cf/src/runtime.ts; the pending rows in src/store/seed-record.ts `seed_notices`), through the
 * agent's own object (cf/src/index.ts `AgentDO`). What it must do: put one harness-notice line per capability the
 * agent gained after it was made at the head of the next message that reaches its model — the same turn when that
 * turn's reconcile added it, the next one when a console open did — once, even when messages race; leave a new
 * agent's first tools unannounced; wait while the harness taking a message does not offer the tools; name tools as
 * they were offered, and nothing of the deployment. What it must never do: start a turn to say it, or tell a bench or
 * Agents API agent anything.
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

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");
const { AgentRuntime, seedInstallation, capabilityNotice, HARNESS_NOTICE } = await import("../cf/src/runtime.ts");
const { PiAgent } = await import("../src/runtime/pi-agent.ts");

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
const transcriptHas = async (d: Deployment, t: string, a: string, needle: string) =>
  JSON.stringify(await d.obj(t, a).runtime().branchEntries(t, a, "main")).includes(needle);

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as any;


/**
 * Every text handed to an engine, in order: what the model is given as the message, whatever path it came by. The
 * engine is pi085's (`PiAgent`), which every agent here runs on. `fail` makes the next write throw, as a refused one does.
 */
const said: Array<{ agent: string; text: string; mode: string }> = [];
let failNext = false;
const realSay = PiAgent.prototype.say;
PiAgent.prototype.say = async function (this: any, text: string, mode: any) {
  said.push({ agent: "", text, mode: String(mode ?? "prompt") });
  if (failNext) { failNext = false; throw new Error("the engine refused the write"); }
  return realSay.call(this, text, mode);
};
const noticeLines = (text: string) => text.split("\n").filter((l) => l.startsWith(HARNESS_NOTICE));
const REMINDER_NOTICE = /You can now set reminders/;
/** The texts said from `from` on that carried the reminder notice. */
const reminderNotices = (from: number) => said.slice(from).filter((s) => noticeLines(s.text).some((l) => REMINDER_NOTICE.test(l)));
const pendingOf = async (d: Deployment, t: string, a: string) => (await d.record(t, a)).notices.filter((n: any) => n.deliveredAt === null);
/** End the turn in flight, so the next message starts one (the model never answers here). */
const endTurn = async (d: Deployment, t: string, a: string) => { await d.obj(t, a).runtime().cancelSession(t, a, "main"); };

// ---------------------------------------------------------------- told in the turn that adds it, once

await check("an existing agent that gains reminder at turn N is told in that turn's own message, at its head, and not at turn N+1", async () => {
  const d = deployment({});
  await existing(d, "t", "old");
  await d.say("t", "old", "turn one");
  must(!(await hasReminder(d, "t", "old")), "control: reminder was added on a deployment without reminder-app");
  await endTurn(d, "t", "old");
  d.redeploy(REMINDER_APP);
  const from = said.length;
  await d.say("t", "old", "turn two");
  must(await hasReminder(d, "t", "old"), "control: the second turn's reconcile did not add reminder");
  const two = said.slice(from).find((s) => s.text.endsWith("turn two"));
  must(two, `the second message: ${show(said.slice(from))}`);
  const lines = noticeLines(two.text);
  must(lines.length === 1 && REMINDER_NOTICE.test(lines[0]!), `notice lines in turn two: ${show(lines)}`);
  must(two.text.startsWith(HARNESS_NOTICE) && two.text.endsWith("\n\nturn two"), `the message: ${show(two.text)}`);
  must(await transcriptHas(d, "t", "old", "You can now set reminders"), "the notice is not in the transcript the model reads");
  const rec = await d.record("t", "old");
  must(rec.notices.length === 1 && rec.notices[0].alias === "reminder" && rec.notices[0].deliveredAt !== null, `record: ${show(rec.notices)}`);
  await endTurn(d, "t", "old");
  const later = said.length;
  await d.say("t", "old", "turn three");
  must(said.slice(later).some((s) => s.text === "turn three"), `turn three: ${show(said.slice(later))}`);
  must(reminderNotices(later).length === 0, `told again: ${show(reminderNotices(later))}`);
});

await check("at a hook push and /agent/message too: that message carries it, and only that one", async () => {
  for (const [entry, run] of [
    ["a hook push", (d: Deployment) => pushWake(d, "t", "old", "a push")],
    ["/agent/message", (d: Deployment) => d.obj("t", "old").startTask("t", "old", "t_old", "a task")],
  ] as const) {
    const d = deployment(REMINDER_APP);
    await existing(d, "t", "old");
    const from = said.length;
    await run(d);
    const told = reminderNotices(from);
    must(told.length === 1, `${entry}: told ${told.length} times: ${show(said.slice(from))}`);
    must((await pendingOf(d, "t", "old")).length === 0, `${entry}: still pending`);
  }
});

await check("a follow-up does not spend the notice: on an idle agent it is queued and reaches no model; the next steer carries it", async () => {
  const d = deployment(REMINDER_APP);
  await existing(d, "t", "old");
  const from = said.length;
  await d.say("t", "old", "a follow-up", "followUp");
  must(await hasReminder(d, "t", "old"), "control: the follow-up's reconcile did not add reminder");
  must(said.slice(from).some((s) => s.text === "a follow-up"), `the follow-up: ${show(said.slice(from))}`);
  // The reason it must not carry it: the queued text is not in what the model reads, even after an alarm.
  await d.obj("t", "old").alarm();
  must(!(await transcriptHas(d, "t", "old", "a follow-up")), "control: an idle follow-up reached the transcript; the rule may no longer be needed");
  must((await pendingOf(d, "t", "old")).length === 1, "the follow-up spent the notice");
  const next = said.length;
  await d.say("t", "old", "a steer");
  must(reminderNotices(next).length === 1, `the steer: ${show(said.slice(next))}`);
  must(await transcriptHas(d, "t", "old", "You can now set reminders"), "the steer's notice is not in the transcript");
});

// ---------------------------------------------------------------- a console open adds; no turn; the next message tells

await check("a console open that adds reminder starts no turn and leaves the notice pending; the next message carries it", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  const from = said.length;
  await d.open("t", "old");
  must(await hasReminder(d, "t", "old"), "control: the console open did not add reminder");
  must(said.length === from, `the open said something: ${show(said.slice(from))}`);
  must(!(await (await rt.agent("t", "old")).running()), "the open started a turn");
  must(!(await transcriptHas(d, "t", "old", "You can now set reminders")), "the notice reached the transcript without a message");
  const pending = await pendingOf(d, "t", "old");
  must(pending.length === 1 && pending[0].alias === "reminder" && pending[0].since === 2, `pending: ${show(pending)}`);
  await d.say("t", "old", "hello");
  const told = reminderNotices(from);
  must(told.length === 1 && told[0]!.text.endsWith("\n\nhello"), `told: ${show(told)}`);
  must((await pendingOf(d, "t", "old")).length === 0, "still pending after the message");
});

// ---------------------------------------------------------------- a new agent's first tools are not news

await check("a new console agent's first turn carries no notice: its first pass gives it its tools, reminder among them", async () => {
  const d = deployment(REMINDER_APP);
  const o = d.obj("t", "fresh");
  await o.uiAdoptAgent("t", "fresh", { name: "Fresh", description: "", avatar: "a" });
  const from = said.length;
  await d.open("t", "fresh");
  await d.say("t", "fresh", "first words");
  must(await hasReminder(d, "t", "fresh"), "control: the new agent did not get reminder");
  const first = said.slice(from).find((s) => s.text.endsWith("first words"));
  must(first && first.text === "first words", `the first message: ${show(said.slice(from))}`);
  const rec = await d.record("t", "fresh");
  must(rec.notices.length === 0, `notices: ${show(rec.notices)}`);
  const added = d.seededRows("t", "fresh").filter((r) => r.status === "added");
  must(added.length === 8 && added.every((r) => r.attrs.notice === "first tools"), `added rows: ${show(added.map((r) => [r.spanId, r.attrs.notice]))}`);
});

await check("a new agent made by /agent/message, or adopted by Raft, is told nothing at its first turn either", async () => {
  const d = deployment(REMINDER_APP);
  const from = said.length;
  await d.obj("t", "made").startTask("t", "made", "t_made", "via startTask");
  must(await hasReminder(d, "t", "made"), "control: no reminder");
  const adopted = await d.obj("t", "raft_new").provisionAdopt("t", "raft_new", JSON.stringify({ name: "R", instructions: "be brief", raftOrigin: "https://raft.example" }));
  must(adopted.ok, `adopt: ${show(adopted)}`);
  await pushWake(d, "t", "raft_new", "a raft push");
  must(await transcriptHas(d, "t", "raft_new", "a raft push"), "control: the push did not land");
  const noticed = said.slice(from).filter((s) => noticeLines(s.text).length > 0);
  must(noticed.length === 0, `notices: ${show(noticed)}`);
  must((await d.record("t", "made")).notices.length === 0 && (await d.record("t", "raft_new")).notices.length === 0, "a notice was recorded");
});

await check("a new agent that gains an entry later is told: the first-tools rule is about its first pass, not about being new", async () => {
  const d = deployment({});
  const o = d.obj("t", "fresh");
  await o.uiAdoptAgent("t", "fresh", { name: "Fresh", description: "", avatar: "a" });
  await d.open("t", "fresh");
  await d.say("t", "fresh", "first");
  must(!(await hasReminder(d, "t", "fresh")), "control: reminder on a deployment without reminder-app");
  await endTurn(d, "t", "fresh");
  d.redeploy(REMINDER_APP);
  const from = said.length;
  await d.say("t", "fresh", "second");
  must(reminderNotices(from).length === 1, `told: ${show(said.slice(from))}`);
});

// ---------------------------------------------------------------- races

await check("two messages racing after the add carry the notice once between them", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await d.open("t", "old");
  must((await pendingOf(d, "t", "old")).length === 1, "control: no pending notice before the race");
  const from = said.length;
  const settled = await Promise.allSettled([
    rt.postMessage("t", "old", "one", "prompt"),
    rt.postMessage("t", "old", "two", "steer"),
    d.say("t", "old", "three"),
  ]);
  must(settled.every((s) => s.status === "fulfilled"), `failed: ${show(settled.filter((s) => s.status === "rejected").map((s: any) => String(s.reason)))}`);
  must(said.slice(from).length === 3, `messages written: ${said.slice(from).length}`);
  const told = reminderNotices(from);
  must(told.length === 1, `told ${told.length} times`);
});

await check("two messages racing with the add itself (each turn start reconciles) carry it once", async () => {
  const d = deployment(REMINDER_APP);
  await existing(d, "t", "old");
  const from = said.length;
  await Promise.all([
    d.say("t", "old", "one"),
    d.obj("t", "old").startTask("t", "old", "t_old", "two"),
    pushWake(d, "t", "old", "three"),
  ]);
  must((await d.mountsOf("t", "old")).filter((m) => m.plugin === "reminder").length === 1, "control: reminder mounted twice");
  must(reminderNotices(from).length === 1, `told ${reminderNotices(from).length} times: ${show(said.slice(from))}`);
});

// ---------------------------------------------------------------- what waits

await check("a steer into a turn whose harness predates the mount does not name tools that harness lacks; the next turn does", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  // Switched off, so the first turn's harness is built without reminder; switched back on while that turn runs.
  await rt.store.setPluginChoice("t", "old", "reminder", "disable");
  await d.say("t", "old", "running");
  must(await (await rt.agent("t", "old")).running(), "control: the first turn is not running");
  await rt.store.setPluginChoice("t", "old", "reminder", "inherit");
  const from = said.length;
  await d.say("t", "old", "a steer");
  must(await hasReminder(d, "t", "old"), "control: the steer's reconcile did not add reminder");
  must(said.slice(from).some((s) => s.text.endsWith("a steer")), "control: the steer was not written");
  const tools = (await (await rt.agent("t", "old")).tools()).map((t: any) => t.name);
  must(!tools.some((n: string) => n.startsWith("reminder__")), `control: the running harness offers reminder: ${tools.join(",")}`);
  must(reminderNotices(from).length === 0, `told while the harness lacks the tools: ${show(said.slice(from))}`);
  must((await pendingOf(d, "t", "old")).length === 1, "the notice was spent on a message that could not use it");
  await endTurn(d, "t", "old");
  const next = said.length;
  await d.say("t", "old", "next turn");
  must(reminderNotices(next).length === 1, `the next turn: ${show(said.slice(next))}`);
});

await check("a message the engine refuses to write gives the notice back, and the next one carries it", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  await d.open("t", "old");
  failNext = true;
  let threw = "";
  try { await rt.postMessage("t", "old", "lost", "prompt"); } catch (e) { threw = String((e as Error).message); }
  must(/refused the write/.test(threw), `control: the write did not fail: ${threw || "no throw"}`);
  must((await pendingOf(d, "t", "old")).length === 1, "the notice was spent on a message that was not written");
  const from = said.length;
  await d.say("t", "old", "kept");
  must(reminderNotices(from).length === 1, `the next message: ${show(said.slice(from))}`);
});

// ---------------------------------------------------------------- the words

await check("the notice names the tools as offered and says nothing of the deployment: no origin, no credential, no URL", async () => {
  const d = deployment(REMINDER_APP);
  const rt = await existing(d, "t", "old");
  const from = said.length;
  await d.say("t", "old", "hello");
  const line = noticeLines(reminderNotices(from)[0]?.text ?? "")[0] ?? "";
  must(REMINDER_NOTICE.test(line), `control: no notice: ${show(said.slice(from))}`);
  const offered = (await (await rt.agent("t", "old")).tools()).map((t: any) => t.name).filter((n: string) => n.startsWith("reminder"));
  must(offered.length === 3 && offered.every((n: string) => line.includes(`\`${n}\``)), `offered ${show(offered)}; line ${show(line)}`);
  for (const secret of [...Object.values(REMINDER_APP), "reminders.example", "reminder-app", "credential", "http"]) {
    must(!line.toLowerCase().includes(secret.toLowerCase()), `the notice says ${JSON.stringify(secret)}: ${line}`);
  }
  must(!line.includes("\n"), "the notice is more than one line");
});

await check("a tool name comes from the offered list, not from alias and tool: a renamed offer is the name said", async () => {
  const entry = AgentRuntime.DEFAULT_MOUNTS.find((m: any) => m.alias === "reminder")!;
  const tool = (name: string, as: string) => ({ name: as, description: `${name}. More.`, parameters: {}, address: `reminder.${name}`, sideEffects: "read" });
  const offered = [tool("create", "reminder__create_2"), tool("list", "reminder__list_2"), tool("delete", "reminder__delete_2")] as never;
  const line = capabilityNotice(entry, offered)!;
  must(line.includes("`reminder__create_2`") && line.includes("`reminder__list_2`") && line.includes("`reminder__delete_2`"), `line: ${line}`);
  must(!/reminder__create`|reminder__list`|reminder__delete`/.test(line), `a name rebuilt from alias and tool: ${line}`);
  // Only what is offered is named, and nothing at all when `create` is not.
  const partial = capabilityNotice(entry, [tool("create", "reminder__create")] as never)!;
  must(partial.includes("`reminder__create`") && !/list|cancels/.test(partial), `partial: ${partial}`);
  must(capabilityNotice(entry, [tool("list", "reminder__list")] as never) === null, "a notice with create withheld");
  // Without a row's own notice: the plugin's own descriptions, first sentence, under the offered names.
  const plain = capabilityNotice({ alias: "x" }, [{ name: "x__go", description: "Goes somewhere. Then more.", parameters: {}, address: "x.go", sideEffects: "read" }] as never);
  must(plain === `${HARNESS_NOTICE}You now have a \`x\` mount: \`x__go\` (Goes somewhere).`, `fallback: ${plain}`);
});

// ---------------------------------------------------------------- never these agents

await check("a bench agent and an Agents API agent are never told anything, by any entry", async () => {
  const d = deployment(REMINDER_APP);
  const from = said.length;
  // A bench agent made before the chosen mark: the bench tenant is what keeps it out (`reconcileSeeds`).
  const o = d.obj("bench", "b_old");
  const rt = o.runtime();
  await rt.ready();
  await rt.store.createAgent("bench", "b_old", {});
  for (const [alias, plugin] of [["tools", "tools"], ["retail", "retail"]]) {
    await rt.store.addMount({ tenantId: "bench", agentId: "b_old", alias, plugin, installationId: seedInstallation(alias), connectionId: null,
      toolVersion: "1.0.0", publicConfig: { account: "x" }, secretRef: null, policy: null });
  }
  await rt.bindOperatorModel("bench", "b_old");
  o.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  o.sql.exec("INSERT OR REPLACE INTO owner(k, tenant_id, agent_id) VALUES ('self','bench','b_old')");
  await rt.postMessage("bench", "b_old", "a bench turn");
  await d.open("bench", "b_old");
  await d.say("bench", "b_old", "via the console");
  await pushWake(d, "bench", "b_old");
  // A tau² task through its own entries.
  const b = d.obj("bench", "bench-object");
  await b.benchStart("task1", "be helpful", false);
  await b.benchSay("task1", "hello");
  // An Agents API agent, made through the API and an existing one, at each entry.
  const agentJson = JSON.stringify({ name: "Api", instructions: "be brief" });
  const api = d.obj("t", "api_1");
  await api.apiPostInput("t", "api_1", agentJson, "s1", "hello", "none");
  await d.open("t", "api_1");
  await d.say("t", "api_1", "from the console");
  await api.startTask("t", "api_1", "t_api_1", "via startTask");
  await existing(d, "t", "api_old", { name: "Api", openai: { name: "Api" } });
  await d.say("t", "api_old", "hello");
  await d.open("t", "api_old");
  await d.say("t", "api_old", "again");
  must(said.slice(from).length >= 8, `control: the messages did not reach an engine: ${said.slice(from).length}`);
  const noticed = said.slice(from).filter((s) => noticeLines(s.text).length > 0);
  must(noticed.length === 0, `told: ${show(noticed)}`);
  for (const [t, a] of [["bench", "b_old"], ["t", "api_1"], ["t", "api_old"]]) {
    must((await d.record(t!, a!)).notices.length === 0, `${t}/${a} has a notice recorded`);
  }
  must((await b.runtime().store.seedRecord("bench", "b_task1")).notices.length === 0, "the tau² agent has a notice recorded");
});

// ---------------------------------------------------------------- the node store keeps the same record

await check("the node sqlite store records, takes once and gives back notices by the same rule", async () => {
  const s = new SqliteStore();
  await s.init();
  await s.createAgent("t", "n", {});
  const mount = (alias: string, plugin: string) => ({ tenantId: "t", agentId: "n", alias, plugin, installationId: `inst-${alias}`, connectionId: null,
    toolVersion: "1", publicConfig: {}, secretRef: null, policy: null });
  const first = await s.reconcileSeeds("t", "n", { key: "k1", revision: 1, plan: [{ alias: "state", plugin: "state", since: 1, mount: mount("state", "state") }] });
  must(first.ran && first.added.length === 1 && first.noticed.length === 0, `first tools: ${show(first)}`);
  const later = await s.reconcileSeeds("t", "n", { key: "k2", revision: 2, plan: [
    { alias: "state", plugin: "state", since: 1, mount: mount("state", "state") },
    { alias: "reminder", plugin: "reminder", since: 2, mount: mount("reminder", "reminder") },
  ] });
  must(later.ran && later.noticed.map((r) => r.alias).join() === "reminder", `later: ${show(later)}`);
  const which = new Set(["reminder@2"]);
  const a = await s.takeSeedNotices("t", "n", which);
  const b = await s.takeSeedNotices("t", "n", which);
  must(a.length === 1 && b.length === 0, `takes: ${show([a, b])}`);
  await s.returnSeedNotices("t", "n", a);
  must((await s.pendingSeedNotices("t", "n")).length === 1, "not given back");
  await s.close();
});

PiAgent.prototype.say = realSay;
globalThis.fetch = originalFetch;
for (const h of hosts) h.dispose();
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
