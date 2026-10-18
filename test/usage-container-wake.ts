/**
 * Container time across the idle lease: a box switched off and woken again is one box id with several compute
 * sessions, and each session is metered once.
 *
 * The idle lease switches a running box off (`parkBox`, which records the compute session that ended) and the next
 * command starts it again under the same id, from a new `createdAt` (the wake in `sandboxPlugin`'s invoke). So
 * the mount's report names one box id several times: the running session in `activity.live`, and every session it
 * finished in `usage`. These cases drive the real plugin through that cycle against a run9 answered here, hand
 * what it reports to the real meter (`countHeldTime`) the way the agent object does, and compare the seconds with
 * the sessions the plugin itself recorded.
 */
import { BOX_KEY, BOX_STORE, asBoxState, sandboxPlugin, usageOf } from "../src/plugins/sandbox.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { countHeldTime } from "../src/usage/container.ts";
import { pendingUsage } from "../src/usage/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const near = (got: number, want: number, msg: string) => must(Math.abs(got - want) < 1e-6, `${msg}: ${got}, expected ${want}`);

const SEC = 1000;
const MIN = 60 * SEC;
const H0 = Date.parse("2026-10-01T10:00:00Z");
const base = { tenantId: "t", agentId: "a" };

// The plugin reads the clock itself (the session's start at a wake, its end at a switch-off), so the clock is
// the test's: every instant below is one the plugin was told.
let clock = H0;
const realNow = Date.now;
Date.now = () => clock;

const leased = sandboxPlugin(null as any, "local", { warnMs: 5 * MIN, maxMs: 30 * MIN });

/** One mount with no box yet, on one shared plugin table, and a run9 that answers every request. */
function mount(tables: PluginDbTables, alias: string) {
  const scope = { tenantId: "t", agentId: "a", alias, plugin: "sandbox" };
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias,
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", project: "p", graceMs: 10_000 },
    db: openPluginDatabase(tables, scope, sandboxPlugin(null as any, "local").database),
    sibling: async () => null, sandboxForms: async () => [],
  };
  return {
    alias, ctx,
    record: () => asBoxState(tables.get(scope, BOX_STORE, BOX_KEY) as any),
    /** A command: creates the box the first time, wakes it when it was switched off. */
    shell: () => leased.invoke("shell", { command: "true" }, ctx),
    /** The idle lease's step for a running box: switch it off. */
    park: () => leased.holds!.release(ctx, { reason: "idle" }),
    /** The operator's or the agent's release: delete it. */
    release: () => leased.holds!.release(ctx),
    report: async () => ({ activity: await leased.holds!.activity!(ctx), usage: await leased.holds!.usage!(ctx) }),
  };
}

let n = 0;
globalThis.fetch = (async (url: string, init?: any) => {
  const method = String(init?.method ?? "GET");
  const path = String(url).replace("https://sandbox.example", "");
  if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
  if (/\/execs\/e\d+$/.test(path)) return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
  return new Response("{}", { status: 200 });
}) as any;

type Mount = ReturnType<typeof mount>;
function world() {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const ledger = sqliteHost();
  return {
    ledger,
    mount: (alias: string) => mount(tables, alias),
    /** One accounting pass, as the agent object makes it (cf/src/index.ts `#countHeldTime`). */
    pass: async (...mounts: Mount[]) => {
      const reports: Record<string, { plugin: string; report: unknown; own: boolean }> = {};
      for (const m of mounts) reports[m.alias] = { plugin: "sandbox", report: await m.report(), own: false };
      countHeldTime(ledger.sql as any, reports, base, clock);
    },
    total: (unit: "seconds" | "execs") =>
      pendingUsage(ledger.sql as any, 0).filter((r) => r.unit === unit).reduce((a, r) => a + r.quantity, 0),
  };
}
/** The compute the plugin itself recorded: every finished session, by its own start and end. */
const recorded = (m: Mount) => usageOf(m.record()).reduce((a, s) => a + (s.endedAt - s.startedAt), 0) / SEC;
const recordedExecs = (m: Mount) => usageOf(m.record()).reduce((a, s) => a + (s.uses ?? 0), 0);

/** Advance the clock to `to`, with a pass every minute on the way, as busy turns would make them. */
async function passesUntil(w: ReturnType<typeof world>, to: number, ...mounts: Mount[]) {
  while (clock + MIN <= to) { clock += MIN; await w.pass(...mounts); }
  clock = to;
}

await check("switched off, woken, switched off: every compute session is metered, once", async () => {
  clock = H0;
  const w = world();
  const m = w.mount("sandbox");
  await m.shell();
  await passesUntil(w, H0 + 10 * MIN, m);
  await m.park();
  await passesUntil(w, H0 + 20 * MIN, m);
  await m.shell(); await m.shell();
  await passesUntil(w, H0 + 30 * MIN, m);
  await m.park();
  await passesUntil(w, H0 + 40 * MIN, m);
  await m.shell();
  await passesUntil(w, H0 + 45 * MIN, m);
  await m.park();
  await passesUntil(w, H0 + 60 * MIN, m);
  must(usageOf(m.record()).length === 3, `the plugin recorded three sessions: ${JSON.stringify(usageOf(m.record()))}`);
  near(recorded(m), 25 * 60, "the sessions themselves");
  near(w.total("seconds"), recorded(m), "metered seconds are the sum of the sessions");
  near(w.total("execs"), recordedExecs(m), "and the commands of all three");
});

await check("one session, never switched off, is metered as before", async () => {
  clock = H0;
  const w = world();
  const m = w.mount("sandbox");
  await m.shell();
  await passesUntil(w, H0 + 10 * MIN + 30 * SEC, m);
  await m.release();
  await passesUntil(w, H0 + 20 * MIN, m);
  near(recorded(m), 10 * 60 + 30, "one session");
  near(w.total("seconds"), recorded(m), "metered to its end and not after");
  near(w.total("execs"), 1, "one command");
});

await check("two boxes, each switched off and woken: each box's sessions are its own", async () => {
  clock = H0;
  const w = world();
  const a = w.mount("a");
  const b = w.mount("b");
  await a.shell();
  await passesUntil(w, H0 + 5 * MIN, a, b);
  await b.shell();
  await passesUntil(w, H0 + 10 * MIN, a, b);
  await a.park();
  await passesUntil(w, H0 + 15 * MIN, a, b);
  await b.park(); await a.shell();
  await passesUntil(w, H0 + 25 * MIN, a, b);
  await b.shell();
  await passesUntil(w, H0 + 30 * MIN, a, b);
  await a.park(); await b.park();
  await passesUntil(w, H0 + 40 * MIN, a, b);
  near(recorded(a) + recorded(b), (10 + 15) * 60 + (10 + 5) * 60, "the sessions of both");
  near(w.total("seconds"), recorded(a) + recorded(b), "metered is both boxes' sessions");
  near(w.total("execs"), recordedExecs(a) + recordedExecs(b), "and both boxes' commands");
});

await check("woken within the same minute it was switched off, between two passes", async () => {
  clock = H0;
  const w = world();
  const m = w.mount("sandbox");
  await m.shell();
  await passesUntil(w, H0 + 2 * MIN, m);
  clock = H0 + 2 * MIN + 10 * SEC; await m.park();
  clock = H0 + 2 * MIN + 25 * SEC; await m.shell();
  clock = H0 + 2 * MIN + 50 * SEC; await m.park();
  clock = H0 + 2 * MIN + 55 * SEC; await m.shell();
  await passesUntil(w, H0 + 4 * MIN, m);
  await m.park();
  await passesUntil(w, H0 + 6 * MIN, m);
  near(recorded(m), 130 + 25 + 65, "three sessions, two of them inside one minute");
  near(w.total("seconds"), recorded(m), "each counted once, none of the gaps");
  near(w.total("execs"), recordedExecs(m), "and every command");
});

await check("the first pass after a wake sees the finished session and the running one together, and a repeated pass adds nothing", async () => {
  clock = H0;
  const w = world();
  const m = w.mount("sandbox");
  await m.shell();
  clock = H0 + 3 * MIN; await m.park();
  clock = H0 + 4 * MIN; await m.shell();
  clock = H0 + 6 * MIN;
  // The first pass after the box was created: the finished session and the running one in one report.
  await w.pass(m);
  await w.pass(m);
  near(w.total("seconds"), 3 * 60 + 2 * 60, "the finished session and the running one so far, once");
  await m.park();
  clock = H0 + 8 * MIN;
  await w.pass(m); await w.pass(m);
  near(w.total("seconds"), recorded(m), "and the rest once");
});

Date.now = realNow;
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
