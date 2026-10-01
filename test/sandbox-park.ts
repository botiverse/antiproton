/**
 * An idle container is switched off, not destroyed; only one left switched off for days is deleted, and its
 * agent is told before that.
 *
 * run9 keeps a stopped box's disk and starts it again on the next exec on the same id (measured 2026-10-01:
 * about two seconds, files in /work intact, processes gone). So the idle lease's first step loses nothing and
 * is taken without a warning, and the step that does lose something — deleting the disk — waits days and is
 * announced. The plugin says which step applies by what `activity` reports and does it in `holds.release`;
 * the cases below hold both halves, against run9 answers given here rather than a live box.
 */
import { BOX_KEY, BOX_STORE, activityOf, asBoxState, sandboxPlugin, usageOf } from "../src/plugins/sandbox.ts";
import type { Released } from "../src/plugins/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { heldDecision, warningText } from "../src/runtime/idle-lease.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const LEASE = { warnMs: 5 * MIN, maxMs: 30 * MIN };
const STARTED = 1_700_000_000_000;
const RUNNING = {
  boxId: "b1", createdAt: STARTED, lastUsedAt: STARTED + 10 * MIN, execs: 3, saved: ["r2://x"], sessions: [], envs: [],
};
const PARKED = { ...RUNNING, parkedAt: STARTED + 40 * MIN };

/** A mount with one box record, and a run9 that records every request and answers from `answer`. */
function fixture(box: unknown, answer: (method: string, path: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} }),
  config: Record<string, unknown> = {}) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" };
  if (box) tables.put(scope, BOX_STORE, BOX_KEY, box as any, null);
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = String(url).replace("https://sandbox.example", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/\/execs\/e\d+$/.test(path)) return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    const r = answer(method, path);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as any;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", project: "p", graceMs: 10_000, ...config },
    db: openPluginDatabase(tables, scope, sandboxPlugin(null as any, "local").database),
    sibling: async () => null, sandboxForms: async () => [],
  };
  const record = () => asBoxState(tables.get(scope, BOX_STORE, BOX_KEY) as any);
  return { ctx, calls, record };
}

const leased = sandboxPlugin(null as any, "local", LEASE);
const stops = (calls: Array<{ method: string; path: string }>) => calls.filter((c) => c.method === "POST" && /\/boxes\/b1\/stop$/.test(c.path));
const deletes = (calls: Array<{ method: string; path: string }>) => calls.filter((c) => c.method === "DELETE" && /\/boxes\/b1$/.test(c.path));

await check("a running box reports a silent step at the deployment's limit", () => {
  const a = activityOf(asBoxState(RUNNING as any));
  must(a.live?.lease?.warnMs === 0, `a running box must be switched off without a warning: ${JSON.stringify(a.live?.lease)}`);
  must(a.live?.lease?.maxMs === undefined, "a running box keeps the deployment's idle limit");
  must(a.live?.lastUsedAt === RUNNING.lastUsedAt, "idle from its last use");
  must(/billed for every second/.test(String(a.billing)), `running billing: ${a.billing}`);
});

await check("a parked box reports the deletion schedule, its words, and the larger postponement", () => {
  const a = activityOf(asBoxState(PARKED as any));
  const l = a.live?.lease;
  must(l?.maxMs === 7 * DAY, `kept seven days by default: ${l?.maxMs}`);
  must(l?.warnMs === DAY, `told a day before: ${l?.warnMs}`);
  must(/stopped machine and everything on its disk will be deleted/.test(String(l?.consequence)), `consequence: ${l?.consequence}`);
  must(/`save`/.test(String(l?.advice)) && /`keep`/.test(String(l?.advice)), `advice names save and keep: ${l?.advice}`);
  must(l?.maxPostponeMinutes === 7 * 24 * 60, `postponement cap is the window: ${l?.maxPostponeMinutes}`);
  must(a.live?.lastUsedAt === PARKED.parkedAt, `idle from when it was switched off: ${a.live?.lastUsedAt}`);
  must(/no compute is billed/.test(String(a.billing)) && /disk/.test(String(a.billing)), `parked billing: ${a.billing}`);
  // A short window still leaves half of it before the warning.
  const short = activityOf(asBoxState(PARKED as any), 0, 1).live?.lease;
  must(short?.maxMs === DAY && short?.warnMs === DAY / 2, `one day: warned at half: ${JSON.stringify(short)}`);
  // A later touch while switched off (keep stamps one) moves the clock.
  const touched = activityOf(asBoxState({ ...PARKED, lastUsedAt: PARKED.parkedAt + DAY } as any));
  must(touched.live?.lastUsedAt === PARKED.parkedAt + DAY, "a later touch is the idle start");
});

await check("through the idle schedule: a running box is taken silently, a parked one is warned about first", () => {
  const deploy = LEASE;
  const run = activityOf(asBoxState(RUNNING as any)).live!;
  const d1 = heldDecision(run, { warnedFor: 0, now: run.lastUsedAt + deploy.maxMs - MIN }, deploy);
  must(d1.do === "wait", `a running box was warned about a step that loses nothing: ${JSON.stringify(d1)}`);
  must(heldDecision(run, { warnedFor: 0, now: run.lastUsedAt + deploy.maxMs }, deploy).do === "release",
    "a running box is switched off at the deployment's limit");

  const park = activityOf(asBoxState(PARKED as any)).live!;
  must(heldDecision(park, { warnedFor: 0, now: park.lastUsedAt + deploy.maxMs }, deploy).do === "wait",
    "a parked box was taken at the running limit");
  const d2 = heldDecision(park, { warnedFor: 0, now: park.lastUsedAt + 6 * DAY + MIN }, deploy);
  must(d2.do === "warn", `a parked box a day from deletion must be warned about: ${JSON.stringify(d2)}`);
  const text = warningText("sandbox", { release: "sandbox__release", postpone: "sandbox__quiet" }, "stopped",
    d2.do === "warn" ? d2.idleMs : 0, d2.do === "warn" ? d2.untilReleaseMs : 0, park.lease!.maxPostponeMinutes!,
    { consequence: park.lease!.consequence, advice: park.lease!.advice });
  must(/idle for 6 days/.test(text) && /will be deleted in 24 hours/.test(text), `durations in days and hours: ${text}`);
  must(/at most 10080/.test(text), `the parked cap is offered: ${text}`);
  must(heldDecision(park, { warnedFor: 0, now: park.lastUsedAt + 7 * DAY }, deploy).do === "release",
    "a parked box is deleted at the end of its window");
});

await check("holds.release switches a running box off, keeps it, and records the compute session", async () => {
  const f = fixture({ ...RUNNING, quietUntil: STARTED + 20 * MIN });
  const out = await leased.holds!.release(f.ctx, { reason: "idle" });
  must(stops(f.calls).length === 1, `one stop: ${JSON.stringify(f.calls)}`);
  must(deletes(f.calls).length === 0, `a running box was deleted: ${JSON.stringify(f.calls)}`);
  const r = f.record();
  must(r?.boxId === "b1", "the record no longer names the box");
  must(typeof (r as any).parkedAt === "number" && (r as any).parkedAt >= STARTED, `not marked switched off: ${JSON.stringify(r)}`);
  must((r as any).quietUntil === undefined, "a spent postponement was carried into the deletion schedule");
  const sessions = usageOf(r);
  must(sessions.length === 1 && sessions[0]!.startedAt === STARTED && sessions[0]!.uses === 3, `session: ${JSON.stringify(sessions)}`);
  const fact = out as Released;
  must(fact && fact.id === "b1" && fact.status === "freed" && fact.startedAt === STARTED && fact.endedAt >= fact.startedAt,
    `the compute lease that ended: ${JSON.stringify(out)}`);
});

await check("a stop run9 refuses is thrown with its fact, and the box is not marked switched off", async () => {
  const f = fixture({ ...RUNNING }, (m, p) => m === "POST" && /\/stop$/.test(p) ? { status: 500, body: { error: "busy" } } : { status: 200, body: {} });
  let thrown: any = null;
  try { await leased.holds!.release(f.ctx, { reason: "idle" }); } catch (e) { thrown = e; }
  must(thrown && /not switched off/.test(String(thrown.message)), `a refused stop read as success: ${thrown}`);
  must(thrown.released?.status === "error" && thrown.released.id === "b1", `the fact rides on the error: ${JSON.stringify(thrown?.released)}`);
  must((f.record() as any)?.parkedAt === undefined, "a box still running was recorded as switched off");
});

await check("holds.release deletes a parked box, clears the record, and adds no second compute session", async () => {
  const f = fixture({ ...PARKED, sessions: [{ boxId: "b1", startedAt: STARTED, endedAt: PARKED.parkedAt, lastUsedAt: RUNNING.lastUsedAt, execs: 3, saved: [] }] });
  const out = await leased.holds!.release(f.ctx, { reason: "idle" }) as Released;
  must(deletes(f.calls).length === 1, `a parked box was not deleted: ${JSON.stringify(f.calls)}`);
  const r = f.record();
  must(!r?.boxId, `the record still names the box: ${JSON.stringify(r)}`);
  must(usageOf(r).length === 1, `deleting a parked box added a session: ${JSON.stringify(usageOf(r))}`);
  must(out.status === "freed" && out.startedAt === PARKED.parkedAt, `the span is the time it sat stopped: ${JSON.stringify(out)}`);
});

await check("a release that is not the idle pass (an operator, a benchmark) deletes a running box at once", async () => {
  const f = fixture({ ...RUNNING });
  await leased.holds!.release(f.ctx);
  must(deletes(f.calls).length === 1 && !f.record()?.boxId, `an explicit release only switched it off: ${JSON.stringify(f.calls)}`);
});

await check("without a lease, holds.release still deletes a running box", async () => {
  const f = fixture({ ...RUNNING });
  await sandboxPlugin(null as any, "local", null).holds!.release(f.ctx);
  must(deletes(f.calls).length === 1 && !f.record()?.boxId, "with no lease nothing would come back to delete it");
});

await check("the release tool deletes even a running box at once", async () => {
  const f = fixture({ ...RUNNING });
  const r: any = await leased.invoke("release", {}, f.ctx);
  must(r.released === true && deletes(f.calls).length === 1 && !f.record()?.boxId, `release: ${JSON.stringify(r)}`);
});

for (const tool of ["shell", "run"] as const) {
  await check(`${tool} on a parked box reuses it, and it is running again from now`, async () => {
    const f = fixture({ ...PARKED, quietUntil: PARKED.parkedAt + 3 * DAY });
    const before = Date.now();
    await leased.invoke(tool, tool === "shell" ? { command: "ls" } : { code: "1" }, f.ctx);
    must(!f.calls.some((c) => c.method === "POST" && /\/boxes$/.test(c.path)), "a new box was created");
    must(f.calls.some((c) => /\/boxes\/b1\/background-execs$/.test(c.path)), "the command did not go to the same box");
    const r = f.record() as any;
    must(r.parkedAt === undefined, `still marked switched off: ${JSON.stringify(r)}`);
    must(r.createdAt >= before && r.lastUsedAt >= before, `the compute lease did not restart: ${JSON.stringify(r)}`);
    must(r.quietUntil === undefined, "a postponed deletion would hold off switching a running box off");
    must(r.execs === 1, `this session's count starts again: ${r.execs}`);
  });
}

await check("quiet on a parked box postpones the deletion up to its window; on a running box the mount's cap holds", async () => {
  const p = fixture({ ...PARKED });
  const r: any = await leased.invoke("quiet", { minutes: 3 * 24 * 60 }, p.ctx);
  must(r.quiet === true && typeof (p.record() as any).quietUntil === "number", `parked quiet: ${JSON.stringify(r)}`);
  let refused: any = null;
  try { await leased.invoke("quiet", { minutes: 8 * 24 * 60 }, fixture({ ...PARKED }).ctx); } catch (e) { refused = e; }
  must(refused && /at most 10080 minutes/.test(String(refused.message)), `over the window must be refused: ${refused}`);
  let capped: any = null;
  try { await leased.invoke("quiet", { minutes: 120 }, fixture({ ...RUNNING }).ctx); } catch (e) { capped = e; }
  must(capped && /at most 60 minutes/.test(String(capped.message)), `a running box keeps maxQuietMinutes: ${capped}`);
});

await check("keepStoppedDays is a setting with a default, and activity reads it", async () => {
  const cfg = leased.config!.find((c) => c.name === "keepStoppedDays");
  must(cfg && cfg.type === "number" && cfg.default === 7, `setting: ${JSON.stringify(cfg)}`);
  const a = await leased.holds!.activity(fixture({ ...PARKED }, undefined, { keepStoppedDays: 2 }).ctx);
  must(a.live?.lease?.maxMs === 2 * DAY, `the mount's setting is the window: ${a.live?.lease?.maxMs}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
