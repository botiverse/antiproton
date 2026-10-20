/**
 * Daily spend limits (credits phase 2; cf/src/spend-limit.ts, docs/metering.md "Daily limits").
 *
 * The real migrations on node:sqlite as D1 (as test/usage-costs.ts runs them), so the prices are the seeded ones;
 * the real queue consumer and both engines' real runtime over node:sqlite for what a refused call does to a turn
 * (as test/model-refusal.ts drives them), with only `fetch` replaced.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { consumeModelCalls, replyingUnknownJob, type ModelJobStub, type ModelQueueDeps, type ModelQueueMessage } from "../cf/src/model-queue.ts";
import { callQueuedModel, operatorModelOf } from "../cf/src/model-request.ts";
import { readEntries } from "../cf/src/transcript-read.ts";
import { sessionTranscript } from "../cf/src/agents-api/transcript.ts";
import { entriesToEvents } from "../cf/src/pi-view.ts";
import {
  adminSpendLimits, d1SpendLimits, DEFAULT_DAILY_LIMIT_USD, DEFAULT_ONBOARDING_DAILY_LIMIT_USD, DEFAULT_PLATFORM_DAILY_LIMIT_USD,
  DEFAULT_PRO_DAILY_LIMIT_USD, DEFAULT_FREE_DAILY_LIMIT_USD, DEFAULT_ONBOARDING_TENANT_DAILY_LIMIT_USD, limitsOf, PLATFORM_LIMIT_TEXT,
  readDaySpend, SPEND_CACHE_MS, SPEND_CACHE_NEAR_MS, SPEND_LIMIT_ERROR, SpendGate, spendAdmit, tenantLimitText, type DaySpend,
} from "../cf/src/spend-limit.ts";
import { overflowKind, readBackstop } from "../src/runtime/overflow-backstop.ts";
import { pendingUsage } from "../src/usage/outbox.ts";
import { pendingTrace } from "../src/trace/outbox.ts";
import { modelCallRow } from "../src/trace/seams.ts";
import { activityEvents, USAGE_LIMIT_ERROR_CLASS } from "../src/runtime/activity.ts";
import { statusEvents } from "../src/runtime/status.ts";
import { spendLimitRefusal } from "../src/model/pi-bridge.ts";
import { setLogSink } from "../src/core/log.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { isContextOverflow as overflow085, isRetryableAssistantError as retryable085 } from "@earendil-works/pi-ai";
import { isContextOverflow as overflow1, isRetryableAssistantError as retryable1 } from "pi-ai-1";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
/** Dollars to a thousandth of a cent: `tokensFor` rounds to whole tokens. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-5;

/** D1 as node:sqlite, with every migration in cf/migrations applied (test/usage-costs.ts's). */
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
    raw: db,
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  } as unknown as D1Database & { raw: DatabaseSync };
}

const H = 3_600_000;
const DAY = 24 * H;
const TODAY = Date.parse("2026-10-12T00:00:00Z");
const NOON = TODAY + 12 * H;
/** deepseek-flash output is $1.20 per 1M tokens (0016): this many tokens cost `usd`. */
const tokensFor = (usd: number) => Math.round(usd / 0.0000012);

function row(db: D1Database & { raw: DatabaseSync }, r: { tenant: string; hour: number; resource?: string; key?: string; unit?: string; quantity: number; agent?: string }) {
  db.raw.prepare("INSERT INTO usage_hourly(tenant_id, hour, agent_id, resource, key, unit, quantity) VALUES (?,?,?,?,?,?,?)")
    .run(r.tenant, r.hour, r.agent ?? "a", r.resource ?? "model.tokens", r.key ?? "deepseek-flash:output", r.unit ?? "tokens", r.quantity);
}
const spend = (db: D1Database & { raw: DatabaseSync }, tenant: string, usd: number, hour = TODAY + 3 * H) =>
  row(db, { tenant, hour, quantity: tokensFor(usd) });

/**
 * The figures these checks were written at ($5 a tenant, $30 the platform), named rather than taken from the defaults,
 * so a change of default is checked once, in its own check, and not by moving every figure below.
 */
const LIMITS = limitsOf({ DAILY_LIMIT_USD: "5", PLATFORM_DAILY_LIMIT_USD: "30" });
const reading = (tenantUsd: number, platformUsd = tenantUsd, override: DaySpend["override"] = null, day = TODAY): DaySpend =>
  ({ day, tenantUsd, platformUsd, override, onboardingUsd: 0, tenantOnboardingUsd: 0, plan: null, onboardingOverride: null, onboardingTenantOverride: null });
/** A gate over fixed readings, counting reads, on a clock the test moves. */
function gateOver(read: (tenantId: string, now: number) => Promise<DaySpend>, limits = LIMITS) {
  const clock = { now: NOON };
  const seen = { reads: 0 };
  const gate = new SpendGate(async (t, now) => { seen.reads++; return read(t, now); }, limits, () => clock.now);
  return { gate, clock, seen };
}
/** Log lines while `fn` runs. */
async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  try { await fn(); } finally { setLogSink(null); }
  return lines;
}

// ---- configuration ---------------------------------------------------------------------------------------------

await check("defaults: $5 a tenant with no plan, $3 a free one, $10 a pro one, $2000 for the platform, $30 for onboarding and $1 a tenant's share of it, bench exempt; `off` lifts a limit; a typo keeps the default", async () => {
  const d = limitsOf({});
  must(d.tenantUsd === 5 && DEFAULT_DAILY_LIMIT_USD === 5 && d.freeUsd === 3 && DEFAULT_FREE_DAILY_LIMIT_USD === 3 && d.proUsd === 10 && DEFAULT_PRO_DAILY_LIMIT_USD === 10
    && d.platformUsd === 2000 && DEFAULT_PLATFORM_DAILY_LIMIT_USD === 2000 && d.onboardingUsd === 30 && DEFAULT_ONBOARDING_DAILY_LIMIT_USD === 30
    && d.onboardingTenantUsd === 1 && DEFAULT_ONBOARDING_TENANT_DAILY_LIMIT_USD === 1,
  show({ ...d, exempt: [...d.exempt] }));
  must(show([...d.exempt]) === show(["bench"]), show([...d.exempt]));
  const more = limitsOf({ PRO_DAILY_LIMIT_USD: "off", ONBOARDING_DAILY_LIMIT_USD: "12.5" });
  must(more.proUsd === null && more.onboardingUsd === 12.5 && more.tenantUsd === 5, show({ ...more, exempt: [...more.exempt] }));
  const set = limitsOf({ DAILY_LIMIT_USD: "2.5", PLATFORM_DAILY_LIMIT_USD: "off", DAILY_LIMIT_EXEMPT_TENANTS: " bench, demo ,," });
  must(set.tenantUsd === 2.5 && set.platformUsd === null && show([...set.exempt]) === show(["bench", "demo"]), show({ ...set, exempt: [...set.exempt] }));
  let bad: ReturnType<typeof limitsOf> | null = null;
  const lines = await logged(async () => {
    bad = limitsOf({ DAILY_LIMIT_USD: "5 dollars", PLATFORM_DAILY_LIMIT_USD: "-1", PRO_DAILY_LIMIT_USD: "ten", ONBOARDING_DAILY_LIMIT_USD: "-3",
      FREE_DAILY_LIMIT_USD: "x", ONBOARDING_TENANT_DAILY_LIMIT_USD: "1$" });
  });
  must(bad!.tenantUsd === 5 && bad!.platformUsd === 2000 && bad!.proUsd === 10 && bad!.onboardingUsd === 30 && bad!.freeUsd === 3 && bad!.onboardingTenantUsd === 1, show(bad));
  must(lines.filter((l) => l.includes("spend_limit.bad_config")).length === 6, show(lines));
});

// ---- what is counted -------------------------------------------------------------------------------------------

await check("today's spend: priced rows of the tenant; the platform adds every tenant's, bench's included", async () => {
  const db = d1();
  spend(db, "t", 1.5);
  spend(db, "t", 0.5, TODAY + 9 * H);
  spend(db, "other", 2);
  spend(db, "bench", 4);
  const s = await readDaySpend(db, "t", NOON);
  must(near(s.tenantUsd, 2) && near(s.platformUsd, 8) && s.day === TODAY && s.override === null, show(s));
});

await check("the tenant's own keys cost nothing toward either limit; an unpriced key counts nothing", async () => {
  const db = d1();
  spend(db, "t", 1);
  // The tenant's own run9 account for a whole day, and an Exa search on its own key.
  row(db, { tenant: "t", hour: TODAY + H, resource: "sandbox.container", key: "own:sandbox", unit: "seconds", quantity: 86_400 });
  row(db, { tenant: "t", hour: TODAY + H, resource: "tool.call", key: "own:exa.search", unit: "calls", quantity: 1000 });
  row(db, { tenant: "t", hour: TODAY + H, resource: "tool.call", key: "js.unpriced", unit: "calls", quantity: 1e9 });
  const s = await readDaySpend(db, "t", NOON);
  must(near(s.tenantUsd, 1) && near(s.platformUsd, 1), show(s));
  // The control: the same container on the operator's account is counted.
  row(db, { tenant: "t", hour: TODAY + H, resource: "sandbox.container", key: "sandbox", unit: "seconds", quantity: 25_000 });
  const s2 = await readDaySpend(db, "t", NOON);
  must(near(s2.tenantUsd, 2) && near(s2.platformUsd, 2), `operator-paid sandbox not counted: ${show(s2)}`);
});

await check("an unaccepted answer is our cost: in the platform total, not in the tenant's", async () => {
  const db = d1();
  row(db, { tenant: "t", hour: TODAY + H, resource: "model.tokens.unaccepted", quantity: tokensFor(3) });
  const s = await readDaySpend(db, "t", NOON);
  must(near(s.tenantUsd, 0) && near(s.platformUsd, 3), show(s));
});

await check("day rollover in the ledger: yesterday's spend is not today's", async () => {
  const db = d1();
  spend(db, "t", 9, TODAY - H);
  const s = await readDaySpend(db, "t", NOON);
  must(near(s.tenantUsd, 0) && near(s.platformUsd, 0), show(s));
  const y = await readDaySpend(db, "t", TODAY - 2 * H);
  must(near(y.tenantUsd, 9) && y.day === TODAY - DAY, show(y));
});

await check("an unpriced key counts nothing and is logged once per key per isolate per UTC day", async () => {
  const db = d1();
  row(db, { tenant: "t", hour: TODAY + H, key: "mystery-model:output", quantity: 1e9 });
  row(db, { tenant: "t", hour: TODAY - H, key: "mystery-model:output", quantity: 1e9 });
  const lines = await logged(async () => {
    const s = await readDaySpend(db, "t", NOON);
    must(near(s.tenantUsd, 0) && near(s.platformUsd, 0), show(s));
    await readDaySpend(db, "t", NOON + H);
    await readDaySpend(db, "u", NOON + 2 * H);
  });
  const unpriced = lines.filter((l) => l.includes("spend_limit.unpriced") && l.includes("mystery-model:output"));
  must(unpriced.length === 1 && unpriced[0]!.includes('"tenantId":"t"') && unpriced[0]!.includes('"day":"2026-10-12"'), show(lines));
  // The day before is its own day: said again there.
  const yesterday = await logged(async () => { await readDaySpend(db, "t", TODAY - 30 * 60_000); });
  must(yesterday.filter((l) => l.includes("spend_limit.unpriced") && l.includes("mystery-model:output")).length === 1, show(yesterday));
});

// ---- the verdict -----------------------------------------------------------------------------------------------

await check("under, at and over the tenant limit: admitted, refused, refused, with the sentence", async () => {
  for (const [usd, admit] of [[4.99, true], [5, false], [5.37, false]] as const) {
    const { gate } = gateOver(async () => reading(usd));
    const v = await gate.admit("t");
    must(v.admit === admit, `$${usd}: ${show(v)}`);
    if (!v.admit) must(v.limit === "tenant" && v.text === tenantLimitText(usd, 5), show(v));
  }
  must(tenantLimitText(5.37, 5) === "Daily usage limit reached ($5.37 of $5.00); resets at 00:00 UTC.", tenantLimitText(5.37, 5));
});

await check("the platform limit refuses every tenant under its own limit, with its own sentence", async () => {
  const { gate } = gateOver(async () => reading(0.1, 30));
  const v = await gate.admit("t");
  must(!v.admit && v.limit === "platform" && v.text === PLATFORM_LIMIT_TEXT, show(v));
  must(PLATFORM_LIMIT_TEXT === "Platform daily usage limit reached; resets at 00:00 UTC.", PLATFORM_LIMIT_TEXT);
  const under = gateOver(async () => reading(0.1, 29.99));
  must((await under.gate.admit("t")).admit, "refused under the platform limit");
});

await check("an exempt tenant (bench) is refused by neither limit, and is not even read", async () => {
  const { gate, seen } = gateOver(async () => reading(1000, 1000));
  const v = await gate.admit("bench");
  must(v.admit && v.why === "exempt" && seen.reads === 0, `${show(v)} after ${seen.reads} reads`);
  must(!(await gate.admit("t")).admit, "the control tenant was admitted at $1000");
});

await check("a per-tenant override only lowers the default: a higher one or null changes nothing, and the platform limit still applies", async () => {
  // Above the $5 default: no raise, the tenant is refused at the default as with no override at all.
  const raised = gateOver(async () => reading(7, 7, { limitUsd: 10 }));
  const r = await raised.gate.admit("t");
  must(!r.admit && r.text === tenantLimitText(7, 5), `a $10 override raised the $5 default: ${show(r)}`);
  const lowered = gateOver(async () => reading(1, 1, { limitUsd: 0.5 }));
  const v = await lowered.gate.admit("t");
  must(!v.admit && v.text === tenantLimitText(1, 0.5), show(v));
  const stop = gateOver(async () => reading(0, 0, { limitUsd: 0 }));
  must(!(await stop.gate.admit("t")).admit, "a $0 override did not stop the tenant");
  // null ("no limit") lowers nothing: the default still refuses.
  const unlimited = gateOver(async () => reading(25, 25, { limitUsd: null }));
  must(!(await unlimited.gate.admit("t")).admit, "a null override lifted the default");
  must((await gateOver(async () => reading(4, 4, { limitUsd: null })).gate.admit("t")).admit, "refused under the default with a null override");
  const platform = gateOver(async () => reading(31, 31, { limitUsd: null }));
  const p = await platform.gate.admit("t");
  must(!p.admit && p.limit === "platform", show(p));
});

await check("a reading is kept for a while: 30 s far from a limit, 5 s within 80% of one", async () => {
  const far = gateOver(async () => reading(1));
  await far.gate.admit("t");
  far.clock.now += SPEND_CACHE_MS - 1;
  await far.gate.admit("t");
  must(far.seen.reads === 1, `far: ${far.seen.reads} reads inside the window`);
  far.clock.now += 1;
  await far.gate.admit("t");
  must(Number(far.seen.reads) === 2, `far: ${far.seen.reads} reads after the window`);
  const close = gateOver(async () => reading(4.2));
  await close.gate.admit("t");
  close.clock.now += SPEND_CACHE_NEAR_MS - 1;
  await close.gate.admit("t");
  must(close.seen.reads === 1, `near: ${close.seen.reads} reads inside its window`);
  close.clock.now += 1;
  await close.gate.admit("t");
  must(Number(close.seen.reads) === 2, `near: ${close.seen.reads} reads after its window`);
  // Kept per tenant: another tenant is its own reading.
  await close.gate.admit("u");
  must(Number(close.seen.reads) === 3, `a second tenant shared the first one's reading`);
});

await check("day rollover: refused at 23:59:58 UTC, admitted at 00:00:01 without anyone acting, though the reading is younger than its window", async () => {
  const db = d1();
  spend(db, "t", 6, TODAY + 23 * H);
  const { gate, clock, seen } = gateOver((t, now) => readDaySpend(db, t, now));
  clock.now = TODAY + DAY - 2_000;
  const before = await gate.admit("t");
  must(!before.admit && before.limit === "tenant", show(before));
  // 3 s later: inside even the near-limit window (SPEND_CACHE_NEAR_MS), so only the day can make it read again.
  clock.now = TODAY + DAY + 1_000;
  must(3_000 < SPEND_CACHE_NEAR_MS, "the window is shorter than the step");
  const after = await gate.admit("t");
  must(after.admit && seen.reads === 2, `${show(after)} after ${seen.reads} reads`);
});

await check("a spend read that fails admits the call, says so in the log, and is read again next time", async () => {
  let fail = true;
  const { gate, seen } = gateOver(async () => { if (fail) throw new Error("D1_ERROR: storage unavailable"); return reading(6); });
  const got: { v?: Awaited<ReturnType<SpendGate["admit"]>> } = {};
  const lines = await logged(async () => { got.v = await gate.admit("t"); });
  must(got.v?.admit === true && got.v.why === "read_failed", show(got.v));
  must(lines.some((l) => l.includes("spend_limit.read_failed") && l.includes("storage unavailable")), show(lines));
  fail = false;
  const next = await gate.admit("t");
  must(!next.admit && seen.reads === 2, `${show(next)} after ${seen.reads} reads`);
});

// ---- the refused answer ----------------------------------------------------------------------------------------

const answerFor = async (text: string) => {
  const admit = spendAdmit({ admit: async () => ({ admit: false, limit: "tenant", text }) as const }, "deepseek-flash");
  return (await admit({ model: { api: "offloaded", provider: "openai-compatible" } }, { tenantId: "t", agentId: "a", jobId: "j1" }))!;
};

await check("the refusal is fixed text the harness does not retry and nobody reads as an overflow, at any figure", async () => {
  for (const text of [tenantLimitText(5.01, 5), tenantLimitText(500, 500), tenantLimitText(429.5, 413), PLATFORM_LIMIT_TEXT]) {
    const a = await answerFor(text);
    must(a.stopReason === "error" && a.errorMessage === SPEND_LIMIT_ERROR && a.providerError === text && a.jobId === "j1", show(a));
    must(a.model === "deepseek-flash" && a.usage.input === 0 && a.usage.output === 0, show(a));
    for (const [name, retryable] of [["pi-ai 0.85", retryable085], ["pi-ai 1.0", retryable1]] as const) {
      must(!retryable(a as never), `${name} would retry: ${show(a)}`);
    }
    for (const [name, isOverflow] of [["pi-ai 0.85", overflow085], ["pi-ai 1.0", overflow1]] as const) {
      must(!isOverflow(a as never) && !isOverflow({ ...a, errorMessage: text } as never), `${name} reads an overflow: ${text}`);
    }
    must(overflowKind(a) === null, `the backstop reads an overflow: ${text}`);
  }
});

await check("what Raft is told: a limit's refusal is BridgeFatal usage_limit_reached with its sentence, and error with it as detail; any other failure is as before", async () => {
  // The row each engine writes for a failed answer (pi-storage.ts, pd-outbox.ts), as the outbox gives it back.
  const row = (m: { errorMessage?: string; providerError?: string }, seq: number) => ({
    ...modelCallRow({ tenantId: "t", agentId: "a", jobId: `j${seq}`, stopReason: "error", model: "deepseek-flash", at: NOON + seq, limit: spendLimitRefusal(m) }),
    seq,
  });
  const limited = await answerFor(PLATFORM_LIMIT_TEXT);
  const rows = [row({ errorMessage: "model refused (HTTP 400, permanent): see the turn's error", providerError: "HTTP 400: bad" }, 1), row(limited, 2)];
  const fatal = activityEvents("a", rows as never).filter((e) => e.hookEventName === "BridgeFatal").map((e) => e.errorClass);
  must(show(fatal) === show(["model_call_failed", `usage_limit_reached: ${PLATFORM_LIMIT_TEXT}`]), show(fatal));
  const status = statusEvents("a", rows as never).map((e) => [e.status, e.detail ?? null]);
  must(show(status) === show([["error", null], ["error", PLATFORM_LIMIT_TEXT]]), show(status));
  // Raft refuses a detail over 200 characters and cuts an errorClass at 120: both are kept inside.
  const long = row({ errorMessage: SPEND_LIMIT_ERROR, providerError: "x".repeat(300) }, 3);
  must(activityEvents("a", [long] as never)[0]!.errorClass!.length === 120 && statusEvents("a", [long] as never)[0]!.detail!.length === 200, "not cut");
});

// ---- both engines, through the real consumer -------------------------------------------------------------------

const ENV = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash" };
const OK_BODY = JSON.stringify({ choices: [{ message: { content: "Sunny." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });

function answering(status: number, body: string) {
  const real = globalThis.fetch;
  const seen = { calls: 0 };
  globalThis.fetch = (async () => { seen.calls++; return new Response(body, { status }); }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

/** An agent on `engine` with the operator's default model, a turn dispatched, and the consumer with `admit` from `gate`. */
async function turnOn(engine: "pi085" | "pd", gate: Pick<SpendGate, "admit">) {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: operatorModelOf(ENV),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.bindOperatorModel("t", "a");
  const stub: ModelJobStub = {
    takeJob: (t, a, j, taker) => replyingUnknownJob(() => rt.takeJob(t, a, j, taker)),
    releaseJob: (t, a, j, taker) => replyingUnknownJob(() => rt.releaseJob(t, a, j, taker)),
    deliverAnswer: (t, a, j, answer, _ms, taker) => replyingUnknownJob(() => rt.deliverAnswer(t, a, j, answer, taker)),
  };
  const deps: ModelQueueDeps = {
    stub: () => stub,
    call: (taken, m) => callQueuedModel(ENV, taken, m.jobId),
    givenUp: (m) => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "given up", jobId: m.jobId }),
    admit: spendAdmit(gate, ENV.HARNESS_MODEL),
  };
  const q = { acked: 0, retried: 0 };
  const message = (jobId: string): ModelQueueMessage => ({ body: { doId: "do-1", tenantId: "t", agentId: "a", jobId }, ack() { q.acked++; }, retry() { q.retried++; } });
  /** Post, step, and the queue message for the job that step dispatched. */
  const ask = async (text: string) => {
    const n = sent.length;
    await rt.postMessage("t", "a", text);
    await rt.step("t", "a");
    must(sent.length === n + 1, `${engine}: dispatched ${show(sent)}`);
    return message(sent.at(-1)!);
  };
  /** Let the engine do what it means to with an answer, a harness retry or a compaction's second call included. */
  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) {
      const r = await rt.step("t", "a");
      if (r.wakeInMs === null || r.wakeInMs > 10_000) break;
      await new Promise((res) => setTimeout(res, r.wakeInMs! + 50));
    }
  };
  return { host, rt, deps, q, sent, ask, settle };
}

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: over the limit the provider is never called, the run ends once with the sentence, nothing retries or rebuilds, nothing is metered; the next UTC day it works again`, async () => {
    const db = d1();
    spend(db, "t", 5.25, TODAY + 2 * H);
    const { gate, clock } = gateOver((t, now) => readDaySpend(db, t, now));
    const { host, rt, deps, q, sent, ask, settle } = await turnOn(engine, gate);
    try {
      const msg = await ask("What's the weather in Oslo?");
      const f = answering(200, OK_BODY);
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); await settle(); } finally { f.restore(); }
      must(f.seen.calls === 0, `${engine}: the provider was called ${f.seen.calls} times over the limit`);
      must(q.acked === 1 && q.retried === 0, `${engine}: queue ${show(q)}`);
      must(sent.length === 1, `${engine}: the model job was sent ${sent.length} times: ${show(sent)}`);
      const sentence = tenantLimitText(5.25, 5);
      const entries = readEntries(host.sql as never, "main");
      const last = (entries.at(-1) as { message?: { stopReason?: string; errorMessage?: string; providerError?: string } } | undefined)?.message;
      must(last?.stopReason === "error" && last.providerError === sentence && last.errorMessage === SPEND_LIMIT_ERROR, `${engine}: last entry ${show(entries.at(-1))}`);
      const { turns } = sessionTranscript({ entries, running: false, pending: [] } as never, { sessionId: "s", agentId: "a" });
      must(turns.at(-1)?.status === "failed" && turns.at(-1)?.error?.message === sentence, `${engine}: turn ${show(turns.at(-1))}`);
      const failed = entriesToEvents(entries as never).filter((e) => e.kind === "model.failed");
      must(failed.length === 1 && (failed[0]!.payload as { error?: string }).error === sentence, `${engine}: console events ${show(failed)}`);
      const backstop = readBackstop(host.sql as never);
      must(backstop.needsReset === null && backstop.consecutive === 0 && backstop.rebuilds === 0, `${engine}: backstop ${show(backstop)}`);
      // What Raft is told: the turn's BridgeFatal names the limit and carries the sentence, and the agent's error
      // status carries it as the detail Raft's dot shows.
      const trace = pendingTrace(host.sql as never, 0).rows.filter((r) => r.kind === "model.call" && r.status === "error");
      must(trace.length === 1 && trace[0]!.attrs.limit === sentence, `${engine}: model.call rows ${show(trace)}`);
      const events = activityEvents("a", pendingTrace(host.sql as never, 0).rows);
      const fatal = events.filter((e) => e.hookEventName === "BridgeFatal");
      must(fatal.length === 1 && fatal[0]!.errorClass === `${USAGE_LIMIT_ERROR_CLASS}: ${sentence}`, `${engine}: BridgeFatal ${show(fatal)}`);
      const errored = events.filter((e) => e.status === "error");
      must(errored.length === 1 && errored[0]!.detail === sentence, `${engine}: error status ${show(errored)}`);
      const metered = pendingUsage(host.sql as never, 0).filter((r) => r.resource.startsWith("model.tokens"));
      must(metered.length === 0, `${engine}: the refusal was metered: ${show(metered)}`);
      // A redelivery of the same message takes nothing and calls nothing.
      const again = answering(200, OK_BODY);
      try { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); } finally { again.restore(); }
      must(again.seen.calls === 0, `${engine}: a redelivery called the provider ${again.seen.calls} times`);

      // 00:00 UTC: nobody resets anything; the next message is answered.
      clock.now = TODAY + DAY + 60_000;
      const next = await ask("And tomorrow?");
      const ok = answering(200, OK_BODY);
      try { await consumeModelCalls({ queue: "model-calls", messages: [next] }, deps); await rt.step("t", "a"); } finally { ok.restore(); }
      must(ok.seen.calls === 1, `${engine}: next day the provider was called ${ok.seen.calls} times`);
      const after = sessionTranscript({ entries: readEntries(host.sql as never, "main"), running: false, pending: [] } as never, { sessionId: "s", agentId: "a" }).turns;
      must(after.at(-1)?.status === "completed", `${engine}: next day's turn ${show(after.at(-1))}`);
    } finally { host.dispose(); }
  });

  await check(`${engine}: under the limit, and when the spend read fails, the call is made`, async () => {
    for (const read of [async () => reading(4.99), async (): Promise<DaySpend> => { throw new Error("D1 down"); }]) {
      const { gate } = gateOver(read);
      const { host, rt, deps, q, ask } = await turnOn(engine, gate);
      try {
        const msg = await ask("hi");
        const ok = answering(200, OK_BODY);
        try { await logged(async () => { await consumeModelCalls({ queue: "model-calls", messages: [msg] }, deps); }); await rt.step("t", "a"); } finally { ok.restore(); }
        must(ok.seen.calls === 1 && q.acked === 1, `${engine}: provider calls ${ok.seen.calls}, queue ${show(q)}`);
        const { turns } = sessionTranscript({ entries: readEntries(host.sql as never, "main"), running: false, pending: [] } as never, { sessionId: "s", agentId: "a" });
        must(turns.at(-1)?.status === "completed", `${engine}: turn ${show(turns.at(-1))}`);
      } finally { host.dispose(); }
    }
  });
}

await check("the consumer asks before every call: a given-up job (the dead letter queue) is answered without asking", async () => {
  let asked = 0;
  const gate = { admit: async () => { asked++; return { admit: true, why: "under" } as const; } };
  const { host, deps, ask } = await turnOn("pd", gate);
  try {
    const msg = await ask("hi");
    await consumeModelCalls({ queue: "model-calls-dlq", messages: [msg] }, deps);
    must(asked === 0, `asked ${asked} times for a given-up job`);
  } finally { host.dispose(); }
});

// ---- the admin's overrides -------------------------------------------------------------------------------------

await check("/admin/spend-limits: set, set to unlimited, clear; each audited; the reading picks it up; bad input refused", async () => {
  const db = d1();
  const store = d1SpendLimits(db);
  let now = NOON;
  const call = (method: string, body?: unknown) => adminSpendLimits(method, body, "github:1", { store, limits: LIMITS, now: () => now });
  let r = await call("PUT", { tenantId: "t", limitUsd: 12.5 });
  must(r.status === 200 && (await r.json() as { limitUsd?: unknown }).limitUsd === 12.5, `set: ${r.status}`);
  must((await readDaySpend(db, "t", NOON)).override?.limitUsd === 12.5, "the override was not read");
  now += 1;
  r = await call("PUT", { tenantId: "t", limitUsd: null });
  must(r.status === 200, `unlimited: ${r.status}`);
  const s = await readDaySpend(db, "t", NOON);
  must(s.override !== null && s.override.limitUsd === null, show(s));
  now += 1;
  must((await call("DELETE", { tenantId: "t" })).status === 204, "clear");
  must((await readDaySpend(db, "t", NOON)).override === null, "the cleared override is still read");
  must((await call("DELETE", { tenantId: "t" })).status === 404, "a second clear");
  for (const bad of [{ tenantId: "t", limitUsd: -1 }, { tenantId: "t", limitUsd: "5" }, { tenantId: "t" }, { tenantId: "", limitUsd: 1 }, { tenantId: "t", limitUsd: 1, extra: 1 }]) {
    const b = await call("PUT", bad);
    must(b.status === 422 || b.status === 400, `${show(bad)}: ${b.status}`);
  }
  const listed = await (await call("GET")).json() as any;
  must(listed.defaults.tenantUsd === 5 && listed.defaults.platformUsd === 30 && show(listed.defaults.exempt) === show(["bench"]) && listed.overrides.length === 0, show(listed));
  const events = listed.events.map((e: any) => [e.action, e.limitUsd, e.previous, e.by, e.at]);
  must(show(events) === show([
    ["clear", null, { limitUsd: null }, "github:1", NOON + 2],
    ["set", null, { limitUsd: 12.5 }, "github:1", NOON + 1],
    ["set", 12.5, {}, "github:1", NOON],
  ]), show(events));
});

// ---- the Worker's own consumer ---------------------------------------------------------------------------------

await check("the Worker's queue handler asks the limit: over it the job is answered with the refusal and the provider is not called; bench is", async () => {
  const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
    " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
    " export class RpcTarget {} export const env = {};";
  register("data:text/javascript," + encodeURIComponent(
    `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
  const { default: worker } = await import("../cf/src/index.ts");
  const db = d1();
  spend(db, "t", 6, Math.floor(Date.now() / H) * H);
  const delivered: Array<{ tenantId: string; answer: any }> = [];
  const stub = {
    takeJob: async () => ({ context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, model: { api: "offloaded", provider: "openai-compatible" } }),
    releaseJob: async () => true,
    deliverAnswer: async (tenantId: string, _a: string, _j: string, answer: unknown) => { delivered.push({ tenantId, answer }); return true; },
    recordImageAttempt: async () => true,
  };
  const env = {
    AGENT: { idFromString: (s: string) => s, get: () => stub }, CONTROL_DB: db, ARTIFACTS: {},
    HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key",
  };
  const q = { acked: 0, retried: 0 };
  const batch = (tenantId: string) => ({
    queue: "model-calls",
    messages: [{ body: { doId: "do-1", tenantId, agentId: "a", jobId: `j-${tenantId}` }, ack() { q.acked++; }, retry() { q.retried++; } }],
  });
  const f = answering(200, OK_BODY);
  try {
    await worker.queue(batch("t") as never, env as never);
    must(f.seen.calls === 0 && q.acked === 1 && q.retried === 0, `over: provider ${f.seen.calls}, queue ${show(q)}`);
    must(delivered.length === 1 && delivered[0]!.answer.errorMessage === SPEND_LIMIT_ERROR
      && /^Daily usage limit reached \(\$6\.00 of \$5\.00\); resets at 00:00 UTC\.$/.test(delivered[0]!.answer.providerError), show(delivered));
    // The control: an exempt tenant on the same deployment is called.
    await worker.queue(batch("bench") as never, env as never);
    must(Number(f.seen.calls) === 1 && Number(delivered.length) === 2 && delivered[1]!.answer.stopReason === "stop", `bench: provider ${f.seen.calls}, ${show(delivered[1])}`);
  } finally { f.restore(); }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
