/**
 * Usage asks every mount, and prunes a box's watermark only when every mount answered and called itself complete
 * (cf/src/mount-billing.ts).
 *
 * The bug this pins (Ward, 2026-11-06): a mount whose report threw was silently left out of the reports usage
 * read, so a live box it held was "not seen"; a week later its watermark was pruned, and the next answer billed
 * the box again from its start. Each case drives `runHeldPass` — the function the agent object's `#countHeldTime`
 * calls — through the real `ToolGateway` over a real store, with mount answers this file builds itself. One case
 * mounts a plugin that implements only `activity`, with a fixed value, to cover the step between a producer's
 * answer and the caller's reading of it.
 *
 * Run: node test/billing-every-mount.ts
 */
import { isDeepStrictEqual } from "node:util";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { pendingUsage } from "../src/usage/outbox.ts";
import { setLogSink } from "../src/core/log.ts";
import type { MountActivity, MountUsage, Plugin, PluginContext } from "../src/plugins/types.ts";
import { ESCALATE_AFTER_PASSES, billingMountReports, consoleMountReports, runHeldPass } from "../cf/src/mount-billing.ts";
import { asMountReports } from "../cf/src/mount-reports.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const near = (got: number, want: number, msg: string) => assert(Math.abs(got - want) < 1e-6, `${msg}: ${got}, expected ${want}`);

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-01T10:00:00Z");
const ctx = { tenantId: "t", agentId: "a", taskId: "k" };

const logs: Array<Record<string, any>> = [];
setLogSink((line) => logs.push(JSON.parse(line)));
const lastPassLog = () => logs.filter((l) => l.evt === "usage.held_pass").at(-1)!;

// ---------------------------------------------------------------------------------------------------------------
// The mounts' answers, built here (never another test's results). `fake` answers whatever `answers` holds for the
// alias; `plain` reports no holdings at all; `fixed` implements only `activity`, with one fixed value.
type Answer = { activity: unknown; activities?: unknown[]; usage?: unknown[]; throws?: Error };
const answers = new Map<string, Answer>();
const answerOf = (c: PluginContext) => {
  const a = answers.get(c.alias);
  if (!a) throw new Error(`no answer set for ${c.alias}`);
  if (a.throws) throw a.throws;
  return a;
};
const tools = [{ name: "run", summary: "", parameters: {}, sideEffects: "read" as const, idempotency: "native" as const }];
const fake: Plugin = {
  id: "fake", version: "1.0.0", tools, async invoke() { return { ok: true }; },
  holds: {
    tools: { release: "release" },
    async activity(c) { return answerOf(c).activity as MountActivity; },
    async activities(c) { const a = answerOf(c); return (a.activities ?? [a.activity]) as MountActivity[]; },
    async usage(c) { return (answerOf(c).usage ?? []) as MountUsage[]; },
    async release() { return false; },
  },
};
const plain: Plugin = { id: "plain", version: "1.0.0", tools, async invoke() { return { ok: true }; } };
/** The producer→caller test plugin: one fixed answer, `complete: true`, and nothing but `activity` to give it. */
const FIXED: MountActivity = {
  live: { id: "fixed-box", startedAt: T0, lastUsedAt: T0 + 5 * MIN },
  quietUntil: null, billing: "a fixed sentence", complete: true,
};
const fixed: Plugin = {
  id: "fixed", version: "1.0.0", tools, async invoke() { return { ok: true }; },
  // `release` is required by the Holding contract; it is never called here.
  holds: { tools: { release: "release" }, async activity() { return structuredClone(FIXED); }, async release() { return false; } },
};
const PLUGINS: Record<string, Plugin> = { fake, plain, fixed };

/** One agent's mounts, from a fixture definition: alias → plugin. */
async function world(definition: Record<string, keyof typeof PLUGINS>) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin] of Object.entries(definition)) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    });
  }
  const plugins = Object.values(PLUGINS);
  const gw = new ToolGateway(store, plugins, new Set(plugins.map((p) => p.id)));
  const ledger = sqliteHost();
  return {
    gw, ledger, store,
    /** The mounts usage must hear from, derived from the definition: those whose plugin reports holdings. */
    expectedDeclared: Object.entries(definition).filter(([, p]) => !!PLUGINS[p]!.holds).map(([a]) => a).sort(),
    mounts: () => store.listMounts("t", "a"),
    pass: async (now: number, transaction = <T>(fn: () => T) => ledger.transactionSync(fn)) =>
      runHeldPass({ gw, sql: ledger.sql as any, transaction, ctx, mounts: await store.listMounts("t", "a"), now }),
    seconds: () => pendingUsage(ledger.sql as any, 0, 1e6).filter((r) => r.unit === "seconds").reduce((a, r) => a + r.quantity, 0),
    byHour: () => {
      const m = new Map<number, number>();
      for (const r of pendingUsage(ledger.sql as any, 0, 1e6)) if (r.unit === "seconds") m.set(r.at, (m.get(r.at) ?? 0) + r.quantity);
      return m;
    },
    marks: () => new Map((ledger.sql.exec("SELECT box_id, through FROM usage_held").toArray() as any[]).map((r) => [String(r.box_id), Number(r.through)])),
    /** A watermark nobody reports any more, older than the week the prune keeps. */
    seedStale: (now: number) => {
      ledger.sql.exec("CREATE TABLE IF NOT EXISTS usage_held(box_id TEXT PRIMARY KEY, through INTEGER NOT NULL, uses INTEGER NOT NULL)");
      ledger.sql.exec("INSERT INTO usage_held VALUES ('gone-box', ?, 0)", now - 8 * DAY);
    },
  };
}

/** The invariants every pass must hold, with the mount list and the declared set side by side on failure. */
async function invariants(w: Awaited<ReturnType<typeof world>>, pass: Awaited<ReturnType<typeof runHeldPass>>) {
  const listed = (await w.mounts()).map((m) => m.alias).sort();
  const declared = [...pass.billing.declared].sort();
  const side = `\n    listMounts: ${JSON.stringify(listed)}\n    declared:   ${JSON.stringify(declared)}\n    expected:   ${JSON.stringify(w.expectedDeclared)}`;
  // Always true by construction: billingMountReports only ever declares aliases it took from listMounts.
  // Expected value derived from the fixture definition (expectedDeclared), not a hand-written list.
  // Non-degenerate side as an inequality: declared.length > 0 below, so ⊆ is not passing on an empty set.
  assert(declared.every((a) => listed.includes(a)), `declared ⊄ listMounts${side}`);
  assert(isDeepStrictEqual(declared, w.expectedDeclared), `declared is not the fixture's holding mounts${side}`);
  assert(declared.length > 0, `declared is empty${side}`);
  const answered = Object.keys(pass.billing.reports).length;
  // Always true by construction: each declared alias lands in exactly one of reports / unanswered.
  // Expected value derived: declared.length from the pass itself, which the line above ties to the fixture.
  // Non-degenerate side as an inequality: declared.length > 0 above, so 0 + 0 == 0 cannot pass.
  assert(answered + pass.billing.unanswered.length === declared.length,
    `answered ${answered} + unanswered ${pass.billing.unanswered.length} != declared ${declared.length}${side}`);
}

const live = (id: string, startedAt: number, extra: Record<string, unknown> = {}) =>
  ({ live: { id, startedAt, lastUsedAt: startedAt }, quietUntil: null, ...extra });
const EMPTY_COMPLETE = { live: null, complete: true };

// ---------------------------------------------------------------------------------------------------------------
await check("an empty answer with complete:true is answered and lets the prune run", async () => {
  const w = await world({ box: "fake", notes: "plain" });
  answers.set("box", { activity: EMPTY_COMPLETE });
  w.seedStale(T0);
  const p = await w.pass(T0);
  await invariants(w, p);
  assert(Object.keys(p.billing.reports).includes("box") && p.billing.unanswered.length === 0, `box not answered: ${JSON.stringify(p.billing)}`);
  assert(p.prune && p.deleted === 1 && !w.marks().has("gone-box"), `prune did not run: ${JSON.stringify({ prune: p.prune, blocked: p.blocked, deleted: p.deleted })}`);
});

await check("an empty answer with complete:false is answered, and blocks the prune as incomplete", async () => {
  const w = await world({ box: "fake", notes: "plain" });
  answers.set("box", { activity: { live: null, complete: false } });
  w.seedStale(T0);
  const p = await w.pass(T0);
  await invariants(w, p);
  assert(p.billing.unanswered.length === 0, `box counted unanswered: ${p.billing.unanswered}`);
  assert(!p.prune && p.blocked.box === "incomplete", `blocked: ${JSON.stringify(p.blocked)}`);
  assert(p.wouldDelete === 1 && p.deleted === 0 && w.marks().has("gone-box"), `a watermark was pruned: ${JSON.stringify(p)}`);
  assert(lastPassLog().reasons === "incomplete" && lastPassLog().incompleteAliases === "box", `log: ${JSON.stringify(lastPassLog())}`);
});

await check("complete missing blocks the prune as complete_missing, logged apart from false", async () => {
  const w = await world({ box: "fake", notes: "plain" });
  answers.set("box", { activity: { live: null } });
  w.seedStale(T0);
  const p = await w.pass(T0);
  await invariants(w, p);
  assert(!p.prune && p.blocked.box === "complete_missing", `missing read as ${JSON.stringify(p.blocked)} (prune ${p.prune})`);
  assert(w.marks().has("gone-box"), "a report that never claimed completeness pruned a watermark");
  const l = lastPassLog();
  assert(l.reasons === "complete_missing" && l.completeMissingAliases === "box" && l.incompleteAliases === "", `log: ${JSON.stringify(l)}`);
});

await check("complete that is not a boolean does not read: unanswered, not complete", async () => {
  const w = await world({ box: "fake" });
  answers.set("box", { activity: { live: null, complete: "yes" } });
  const p = await w.pass(T0);
  await invariants(w, p);
  assert(p.billing.unanswered.includes("box") && p.blocked.box === "unanswered", `blocked: ${JSON.stringify(p.blocked)}`);
});

await check("unreadable {unknown:false, machines:0, other:1} with complete:true: the prune still runs (other is not a gate)", async () => {
  const w = await world({ box: "fake" });
  answers.set("box", { activity: { live: null, complete: true, unreadable: { unknown: false, machines: 0, other: 1 } } });
  w.seedStale(T0);
  const p = await w.pass(T0);
  await invariants(w, p);
  assert(p.prune && p.deleted === 1, `other blocked the prune: ${JSON.stringify({ blocked: p.blocked, unanswered: p.billing.unanswered })}`);
  const l = lastPassLog();
  assert(l.otherUnreadable === 1 && l.unknownBlocking === 0 && l.machinesBlocking === 0, `breakdown not logged: ${JSON.stringify(l)}`);
});

await check("a mount that throws is unanswered, named in the log, blocks the prune, and the other mounts are still billed", async () => {
  const w = await world({ broken: "fake", good: "fake", notes: "plain" });
  answers.set("broken", { activity: null, throws: new TypeError("x".repeat(500)) });
  answers.set("good", { activity: live("good-box", T0, { complete: true }) });
  w.seedStale(T0);
  const p = await w.pass(T0 + HOUR);
  await invariants(w, p);
  assert(isDeepStrictEqual(p.billing.unanswered, ["broken"]) && p.blocked.broken === "unanswered", `unanswered: ${JSON.stringify(p.billing.unanswered)}`);
  assert(!p.prune && w.marks().has("gone-box"), "the prune ran past a mount that did not answer");
  near(w.seconds(), HOUR / SEC, "the answering mount's hour is billed");
  const caught = logs.filter((l) => l.evt === "usage.mount_unanswered").at(-1)!;
  assert(caught.alias === "broken" && caught.errorName === "TypeError" && caught.error.length === 200, `catch log: ${JSON.stringify(caught).slice(0, 300)}`);
  assert(lastPassLog().unansweredAliases === "broken" && lastPassLog().reasons === "unanswered", `log: ${JSON.stringify(lastPassLog())}`);
});

await check("silent eight days, back on day nine: the box is not billed again from its start", async () => {
  const w = await world({ box: "fake", other: "fake" });
  answers.set("other", { activity: EMPTY_COMPLETE });
  answers.set("box", { activity: live("long-box", T0, { complete: true }) });
  await w.pass(T0 + HOUR);
  for (let d = 1; d <= 8; d++) {
    answers.set("box", { activity: null, throws: new Error("storage hiccup") });
    const p = await w.pass(T0 + d * DAY);
    await invariants(w, p);
    assert(!p.prune && w.marks().has("long-box"), `day ${d}: the live box's watermark was pruned`);
  }
  answers.set("box", { activity: live("long-box", T0, { complete: true }) });
  const p9 = await w.pass(T0 + 9 * DAY);
  assert(p9.prune, `day 9: ${JSON.stringify(p9.blocked)}`);
  near(w.seconds(), (9 * DAY) / SEC, "nine days held, nine days billed (not nine plus a re-bill from the start)");
  for (const [hour, s] of w.byHour()) assert(s <= 3600 + 1e-6, `hour ${new Date(hour).toISOString()} billed ${s}s`);
});

await check("stop, wake, stop: the sessions sum to the time held, and no hour is counted twice", async () => {
  const w = await world({ box: "fake" });
  const id = "wake-box";
  const s1 = { id, startedAt: T0, endedAt: T0 + 50 * MIN, lastUsedAt: T0 + 50 * MIN, uses: 2 };
  const s2 = { id, startedAt: T0 + 80 * MIN, endedAt: T0 + 150 * MIN, lastUsedAt: T0 + 150 * MIN, uses: 1 };
  answers.set("box", { activity: live(id, T0, { complete: true }) });
  await w.pass(T0 + 20 * MIN);
  await w.pass(T0 + 40 * MIN);
  answers.set("box", { activity: { live: null, complete: true }, usage: [s1] }); // stopped
  await w.pass(T0 + 60 * MIN);
  answers.set("box", { activity: live(id, s2.startedAt, { complete: true }), usage: [s1] }); // woken
  await w.pass(T0 + 100 * MIN);
  await w.pass(T0 + 100 * MIN);
  answers.set("box", { activity: { live: null, complete: true }, usage: [s2, s1] }); // stopped again
  await w.pass(T0 + 160 * MIN);
  await w.pass(T0 + 170 * MIN);
  near(w.seconds(), (50 + 70) * 60, "seconds are the two sessions");
  for (const [hour, s] of w.byHour()) assert(s <= 3600 + 1e-6, `hour ${new Date(hour).toISOString()} billed ${s}s`);
});

await check("two live machines in one mount are both billed on every pass, not only the one the summary names", async () => {
  const w = await world({ box: "fake" });
  const main = live("main-box", T0, { complete: true });
  const second = live("second-box", T0, { complete: true });
  answers.set("box", { activity: main, activities: [main, second] });
  for (let i = 1; i <= 3; i++) {
    const p = await w.pass(T0 + i * HOUR);
    await invariants(w, p);
    const marks = w.marks();
    assert(marks.get("main-box") === T0 + i * HOUR && marks.get("second-box") === T0 + i * HOUR,
      `pass ${i}: watermarks ${JSON.stringify([...marks])}`);
    near(w.seconds(), 2 * i * HOUR / SEC, `pass ${i}: both machines' time`);
  }
});

await check("the fixed-value plugin (activity only, complete:true) arrives in the reports unchanged, is billed, and lets the prune run", async () => {
  const w = await world({ fixed: "fixed", notes: "plain" });
  w.seedStale(T0 + HOUR);
  const p = await w.pass(T0 + HOUR);
  await invariants(w, p);
  assert(isDeepStrictEqual(p.billing.reports.fixed, { activity: FIXED, usage: [] }), `changed on the way: ${JSON.stringify(p.billing.reports.fixed)}`);
  assert(isDeepStrictEqual(p.billing.machines.fixed, [FIXED]), `machines: ${JSON.stringify(p.billing.machines.fixed)}`);
  assert(p.prune && p.deleted === 1, `blocked: ${JSON.stringify(p.blocked)}`);
  near(w.seconds(), HOUR / SEC, "its box's hour");
});

await check("console: #mountReports' map still reads on the page, and equals the billing reports for the same mounts", async () => {
  const w = await world({ busy: "fake", idle: "fake", fixed: "fixed", notes: "plain" });
  answers.set("busy", { activity: live("busy-box", T0, { complete: true }), usage: [{ id: "old", startedAt: T0 - HOUR, endedAt: T0 - MIN, lastUsedAt: T0 - MIN }] });
  answers.set("idle", { activity: EMPTY_COMPLETE });
  const mounts = await w.mounts();
  const page = await consoleMountReports(w.gw, ctx, mounts);
  const parsed = asMountReports(JSON.parse(JSON.stringify(page)));
  assert(parsed && Object.keys(parsed).length > 0 && parsed.busy?.activity.live?.id === "busy-box", `the page would draw nothing: ${JSON.stringify(parsed)}`);
  const billing = await billingMountReports(w.gw, ctx, mounts);
  const shared = Object.keys(page);
  assert(shared.length > 0, "nothing to compare");
  for (const alias of shared) {
    assert(isDeepStrictEqual(page[alias], billing.reports[alias]), `${alias}: console ${JSON.stringify(page[alias])} vs billing ${JSON.stringify(billing.reports[alias])}`);
  }
  assert("idle" in billing.reports && !("idle" in page), "billing must hear from the idle mount the console leaves out");
});

await check(`a mount that blocks for want of the field (complete_missing) or an answer is stalled at ${ESCALATE_AFTER_PASSES}, never escalated to the menu`, async () => {
  const w = await world({ missing: "fake", broken: "fake", ok: "fake" });
  answers.set("ok", { activity: EMPTY_COMPLETE });
  answers.set("missing", { activity: { live: null } });
  answers.set("broken", { activity: null, throws: new Error("down") });
  for (let i = 1; i <= ESCALATE_AFTER_PASSES; i++) await w.pass(T0 + i * MIN);
  const l = lastPassLog();
  // The menu's last step gives up pruning; for a rollout gap or a failing call it would destroy for nothing.
  assert(l.escalate === false && l.escalateAliases === "", `escalated to the menu: ${JSON.stringify(l)}`);
  assert(l.stalled === true && String(l.stalledAliases).split(",").sort().join(",") === "broken,missing", `not stalled: ${JSON.stringify(l)}`);
});

await check(`consecutive blocked passes count up per mount, escalate at ${ESCALATE_AFTER_PASSES}, and reset on a complete answer`, async () => {
  const w = await world({ box: "fake", ok: "fake" });
  answers.set("ok", { activity: EMPTY_COMPLETE });
  answers.set("box", { activity: { live: null, complete: false } });
  for (let i = 1; i <= ESCALATE_AFTER_PASSES; i++) {
    const p = await w.pass(T0 + i * MIN);
    const l = lastPassLog();
    assert(p.passes.box === i && !("ok" in p.passes), `pass ${i}: ${JSON.stringify(p.passes)}`);
    assert(l.escalate === (i >= ESCALATE_AFTER_PASSES), `pass ${i}: escalate ${l.escalate}`);
    assert(i < ESCALATE_AFTER_PASSES || l.escalateAliases === "box", `escalateAliases ${l.escalateAliases}`);
  }
  answers.set("box", { activity: EMPTY_COMPLETE });
  const reset = await w.pass(T0 + 10 * MIN);
  assert(reset.prune && Object.keys(reset.passes).length === 0, `not reset: ${JSON.stringify(reset.passes)}`);
  answers.set("box", { activity: { live: null, complete: false } });
  const again = await w.pass(T0 + 11 * MIN);
  assert(again.passes.box === 1, `counting resumed from ${again.passes.box}, not 1`);
});

await check("a ledger write that fails takes its watermark with it: the next pass bills the hour once (transaction)", async () => {
  const w = await world({ box: "fake" });
  answers.set("box", { activity: live("tx-box", T0, { complete: true }) });
  let failMark = true;
  const exec = w.ledger.sql.exec.bind(w.ledger.sql);
  w.ledger.sql.exec = ((q: string, ...b: unknown[]) => {
    if (failMark && q.startsWith("INSERT INTO usage_held")) throw new Error("disk full");
    return exec(q, ...b);
  }) as any;
  let threw = false;
  try { await w.pass(T0 + HOUR); } catch { threw = true; }
  assert(threw, "the failing write did not surface");
  failMark = false;
  await w.pass(T0 + HOUR);
  near(w.seconds(), HOUR / SEC, "one hour held, one hour billed");
});

setLogSink(null);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
