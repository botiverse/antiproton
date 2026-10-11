/**
 * Context rebuild decided at wake time, in shadow (src/runtime/rebuild.ts): `shouldRebuild` per provider rule, the
 * `rebuild.decision` row written just before an inbound post starts a pi085 wake (`#deliverInbound`, cf/src/runtime.ts),
 * the `rebuild.outcome` row its first answer settles (src/store/pi-storage.ts), the engine's own compactions recorded in
 * the same terms (pd: src/runtime/pd-outbox.ts `bookRebuilds`), and the one property shadow mode exists to keep: every
 * request the model is sent is the same with the decision recorded as without it.
 *
 * The runtime rows drive the real `AgentRuntime` over node:sqlite with the model scripted through the queue, as
 * test/stable-prompt.ts does. A long gap is made by moving the last answer's time back, which is the one fact the
 * decision reads it from.
 */
import { AgentRuntime, BENCH_TENANT } from "../cf/src/runtime.ts";
import { errorMessage, fromResponse, toRequest, type AnsweredMessage } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { acceptInbound, ensureInboundTable } from "../src/runtime/inbound.ts";
import {
  DEFAULT_REBUILD_POLICY, REFUSED_REBUILD_POLICY, agreementOf, rebuildPolicyOf, shouldRebuild, type RebuildFacts, type RebuildPolicy,
} from "../src/runtime/rebuild.ts";
import { DurableAgent, PdHost } from "../src/runtime/durable-agent.ts";
import { UnknownJob } from "../cf/src/model-queue.ts";
import type { DurableSqlHost } from "../src/store/pi-durable-sqlite.ts";
import { pendingTrace } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const MIN = 60_000;
const REFUSED = "the model provider refused this request (400)";

// ---- the decision, as a table -------------------------------------------------------------------------------------

const facts = (o: Partial<RebuildFacts>): RebuildFacts => ({
  gapMs: 2 * 60 * MIN, contextTokens: 200_000, provider: "deepseek", model: "deepseek-flash", contextWindow: 1_000_000,
  prevReasoning: false, prevWakeHitRate: 0.99, ...o,
});
const LUNA = { provider: "cloudflare", model: "openai/gpt-5.6-luna" };

// [case, facts, wouldRebuild, predictedCold, expectedCold, reason, rule]
const table: Array<[string, Partial<RebuildFacts>, boolean, boolean, boolean, string, string]> = [
  ["deepseek: long gap, large context", {}, true, true, false, "gap-over-limit", "deepseek"],
  ["deepseek: short gap, previous wake warm", { gapMs: 3 * MIN }, false, false, false, "warm", "deepseek"],
  ["deepseek: short gap, previous wake cold", { gapMs: 3 * MIN, prevWakeHitRate: 0.1 }, true, true, false, "previous-wake-cold", "deepseek"],
  ["deepseek: short gap, previous wake never measured", { gapMs: 3 * MIN, prevWakeHitRate: null }, false, false, false, "warm", "deepseek"],
  // The size gates the rebuild, never the coldness: the measurement is still compared with the prediction.
  ["deepseek: previous wake cold but a small context", { gapMs: 3 * MIN, prevWakeHitRate: 0.1, contextTokens: 50_000 }, false, true, false, "context-below-threshold", "deepseek"],
  ["deepseek: a small, warm context", { gapMs: 3 * MIN, contextTokens: 50_000 }, false, false, false, "context-below-threshold", "deepseek"],
  ["deepseek: the threshold itself is not over it", { contextTokens: 128_000 }, false, true, false, "context-below-threshold", "deepseek"],
  ["deepseek: reasoning alone decides nothing", { gapMs: 3 * MIN, prevReasoning: true }, false, false, false, "warm", "deepseek"],
  ["luna: long gap, large context", { ...LUNA }, true, true, false, "gap-over-limit", "openai-ttl"],
  ["luna: short gap, even after a cold wake (time is its only rule)", { ...LUNA, gapMs: 3 * MIN, prevWakeHitRate: 0.1 }, false, false, false, "warm", "openai-ttl"],
  ["luna: exactly 60 minutes is not over it", { ...LUNA, gapMs: 60 * MIN }, false, false, false, "warm", "openai-ttl"],
  ["luna: long gap, small context", { ...LUNA, contextTokens: 20_000 }, false, true, false, "context-below-threshold", "openai-ttl"],
  ["unknown model: the fallback is the gap rule", { provider: "x", model: "m1", gapMs: 3 * MIN, prevWakeHitRate: 0.1 }, false, false, false, "warm", "gap"],
  // Cold by construction: out of the disagreement rate.
  ["no call yet in the conversation", { gapMs: null, contextTokens: null }, false, true, true, "no-previous-call", "deepseek"],
  ["a reset since the last call", { contextTokens: null }, false, true, true, "context-unknown", "deepseek"],
];
for (const [name, f, rebuild, cold, expected, reason, rule] of table) {
  await check(`shouldRebuild — ${name}`, () => {
    const d = shouldRebuild(facts(f), DEFAULT_REBUILD_POLICY);
    must(d.rebuild === rebuild && d.predictedCold === cold && d.expectedCold === expected && d.reason === reason && d.rule === rule, `got ${show(d)}`);
  });
}

await check("shouldRebuild — a window-relative threshold reads the model's window", () => {
  const share: RebuildPolicy = { rules: [], fallback: { ...DEFAULT_REBUILD_POLICY.fallback, minContextShare: 0.5 } };
  const small = shouldRebuild(facts({ model: "m", contextTokens: 90_000, contextWindow: 200_000 }), share);
  const large = shouldRebuild(facts({ model: "m", contextTokens: 110_000, contextWindow: 200_000 }), share);
  must(!small.rebuild && small.thresholdTokens === 100_000 && large.rebuild, `${show(small)} ${show(large)}`);
});

await check("rebuildPolicyOf — unset is the default, `off` is none, a whole policy is taken, a broken one is refused for the default with no idle rebuild", () => {
  must(rebuildPolicyOf(undefined) === DEFAULT_REBUILD_POLICY && rebuildPolicyOf("") === DEFAULT_REBUILD_POLICY, "unset");
  must(rebuildPolicyOf("off") === null && rebuildPolicyOf(" OFF ") === null && rebuildPolicyOf("Off") === null, "off, any case");
  const mine = { rules: [{ ...DEFAULT_REBUILD_POLICY.rules[0]!, minContextTokens: 64_000 }], fallback: DEFAULT_REBUILD_POLICY.fallback };
  must(rebuildPolicyOf(JSON.stringify(mine))?.rules[0]?.minContextTokens === 64_000, "a policy");
  must(rebuildPolicyOf('{"rules":[{"name":"x"}]}') === REFUSED_REBUILD_POLICY, "half a policy");
  must(rebuildPolicyOf("{") === REFUSED_REBUILD_POLICY, "not json");
  const bad = (r: object) => JSON.stringify({ rules: [], fallback: { ...DEFAULT_REBUILD_POLICY.fallback, ...r } });
  must(rebuildPolicyOf(bad({ coldHitRate: 1.5 })) === REFUSED_REBUILD_POLICY && rebuildPolicyOf(bad({ coldHitRate: -0.1 })) === REFUSED_REBUILD_POLICY, "a hit rate outside [0, 1]");
  must(rebuildPolicyOf(bad({ coldHitRate: 1 }))?.fallback.coldHitRate === 1, "control: 1 is a hit rate");
  must(rebuildPolicyOf(JSON.stringify({ ...DEFAULT_REBUILD_POLICY, windowShare: 2 })) === REFUSED_REBUILD_POLICY, "a window share over 1");
});

await check("agreementOf — false-cold, false-warm, expected-cold, and an unmeasured call never counted as 0", () => {
  must(agreementOf(false, 0.02, 0.5, true) === "expected-cold" && agreementOf(true, null, 0.5, true) === "unmeasured", "expected");
  must(agreementOf(true, 0.02, 0.5) === "agree" && agreementOf(false, 0.97, 0.5) === "agree", "agree");
  must(agreementOf(true, 0.97, 0.5) === "false-cold" && agreementOf(false, 0.02, 0.5) === "false-warm", "disagree");
  must(agreementOf(true, null, 0.5) === "unmeasured", "unmeasured");
});

// ---- the runtime, driven as the worker drives it ------------------------------------------------------------------

type Ctx = { systemPrompt: string; messages: any[]; tools: unknown[] };
type Usage = { promptTokens: number; cachedPromptTokens: number };
type World = {
  host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string>; calls: Ctx[];
  tenant: string; usage: Usage;
  /** The next answers are this error instead, one per job, while any are left. */
  fail: Array<{ errorMessage: string; providerError?: string; input?: number; cacheRead?: number }>;
};

/**
 * The default policy without its idle rule, which acts: a wake after an hour on a context over 8k is rebuilt before it
 * is answered (test/idle-rebuild.ts). The wakes here are the shadow's subject, so they are decided and not rebuilt.
 */
const SHADOW_ONLY: RebuildPolicy = { ...DEFAULT_REBUILD_POLICY, idle: false };

async function world(o: { policy?: RebuildPolicy | null; tenant?: string } = {}): Promise<World> {
  const host = sqliteHost();
  const w = { host, sent: [] as string[], answered: new Set<string>(), calls: [] as Ctx[], tenant: o.tenant ?? "t",
    usage: { promptTokens: 1, cachedPromptTokens: 0 }, fail: [] as World["fail"] } as World;
  const standIn = standInLoader();
  w.rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash" }),
    offloadModel: async (job: { commandId: string }) => { w.sent.push(job.commandId); },
    ...(o.policy === undefined ? { rebuildPolicy: SHADOW_ONLY } : { rebuildPolicy: o.policy }),
  } as never);
  await w.rt.ready();
  await w.rt.store.createAgent(w.tenant, "a");
  await w.rt.bindOperatorModel(w.tenant, "a");
  return w;
}

/** Step until settled, answering every job with the world's current usage. */
async function settle(w: World) {
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step(w.tenant, "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !w.answered.has(id));
    for (const id of pending) {
      w.answered.add(id);
      const job = await w.rt.takeJob(w.tenant, "a", id) as { model: { api: string; provider: string; id: string }; context: Ctx } | null;
      if (!job) continue;
      w.calls.push(JSON.parse(JSON.stringify(job.context)));
      const failure = w.fail.shift();
      if (failure) {
        const identity = { api: job.model.api, provider: job.model.provider, id: job.model.id };
        await w.rt.deliverAnswer(w.tenant, "a", id, { ...errorMessage(failure.errorMessage, identity),
          ...(failure.providerError ? { providerError: failure.providerError } : {}),
          ...(failure.input ? { usage: { ...errorMessage("", identity).usage, input: failure.input, cacheRead: failure.cacheRead ?? 0 } } : {}),
          jobId: id }, undefined);
        continue;
      }
      const res: ModelResponse = { text: "noted", finishReason: "stop", truncated: false,
        usage: { promptTokens: w.usage.promptTokens, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: w.usage.cachedPromptTokens } };
      await w.rt.deliverAnswer(w.tenant, "a", id, fromResponse(res, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error("the turn did not settle");
}

/** A push queued at a hook and handed to the agent: the wake this decision is for. */
async function push(w: World, text: string) {
  ensureInboundTable(w.host.sql as never);
  acceptInbound(w.host.sql as never, { hookId: "h1", alias: "raft", dedupeKey: null, message: text, now: Date.now() });
  const pass = await w.rt.deliverPendingInbound(w.tenant, "a");
  must(pass.posted === 1, `the push was not posted: ${show(pass)}`);
}

/** The time since the conversation's last answer, as the transcript records it. */
function age(w: World, ms: number) {
  w.host.sql.exec("UPDATE pi_entries SET timestamp = timestamp - ? WHERE type = 'message'", ms);
}

type Row = { kind: string; spanId: string; parentId?: string; status: string; attrs: Record<string, any> };
const rows = (w: World, kind: string): Row[] => pendingTrace(w.host.sql as never, 0).rows.filter((r) => r.kind === kind) as Row[];
const jobIds = (w: World) => w.sent;

await check("a wake after a long gap on a large context: wouldRebuild with its facts, then an outcome with the first call's measured hit rate, linked by id", async () => {
  const w = await world();
  w.usage = { promptTokens: 200_000, cachedPromptTokens: 199_000 };
  await push(w, "first");
  await settle(w);
  must(rows(w, "rebuild.decision").length === 1, "control: the first wake has a decision too");
  must(rows(w, "rebuild.decision")[0]!.attrs.reason === "no-previous-call", `first: ${show(rows(w, "rebuild.decision"))}`);
  age(w, 2 * 60 * MIN);
  w.usage = { promptTokens: 200_100, cachedPromptTokens: 0 };
  await push(w, "second");
  const [, d] = rows(w, "rebuild.decision");
  must(d, "no decision row for the second wake");
  must(d.status === "would-rebuild" && d.attrs.wouldRebuild === true && d.attrs.reason === "gap-over-limit"
    && d.attrs.trigger === "cold-wake" && d.attrs.strategy === "briefing" && d.attrs.rule === "deepseek", `decision: ${show(d)}`);
  must(d.attrs.contextTokens === 200_000 && d.attrs.gapMs >= 2 * 60 * MIN && d.attrs.provider === (await w.rt.store.getModelBinding(w.tenant, "a"))?.provider
    && d.attrs.model === "deepseek-flash" && d.attrs.prevReasoning === false && d.attrs.thresholdTokens === 128_000, `facts: ${show(d.attrs)}`);
  must(rows(w, "rebuild.outcome").length === 1, "the second wake's outcome is written before its call is answered");
  await settle(w);
  const outs = rows(w, "rebuild.outcome");
  const o = outs.find((r) => r.parentId === d.spanId);
  must(o, `no outcome linked to ${d.spanId}: ${show(outs)}`);
  must(o.spanId === jobIds(w).at(-1) && o.attrs.decision === d.spanId, `the outcome names the wake's first call: ${show(o)}`);
  must(o.attrs.hitRate === 0 && o.attrs.measuredCold === true && o.status === "agree" && o.attrs.input === 200_100, `outcome: ${show(o)}`);
  // The first wake is cold by construction: measured (199k of 200k), and out of the disagreement rate.
  must(outs[0]!.status === "expected-cold" && outs[0]!.attrs.expectedCold === true && Math.abs(outs[0]!.attrs.hitRate - 0.995) < 1e-9,
    `the first outcome: ${show(outs[0])}`);
  w.host.dispose();
});

await check("the previous wake's measured state is the next decision's fact: deepseek predicts cold after a cold wake, and a warm first call reads as false-cold", async () => {
  const w = await world();
  w.usage = { promptTokens: 200_000, cachedPromptTokens: 0 };
  await push(w, "first");
  await settle(w);
  // The first wake is cold by construction and is not "the previous wake's state": the second one is measured cold.
  age(w, 2 * MIN);
  await push(w, "second");
  await settle(w);
  must(rows(w, "rebuild.decision")[1]!.attrs.prevWakeHitRate === null, `an expected-cold wake was read as the previous state: ${show(rows(w, "rebuild.decision")[1])}`);
  age(w, 2 * MIN);
  w.usage = { promptTokens: 200_100, cachedPromptTokens: 200_000 };
  await push(w, "third");
  await settle(w);
  const d = rows(w, "rebuild.decision")[2]!;
  must(d.attrs.prevWakeHitRate === 0 && d.attrs.reason === "previous-wake-cold" && d.attrs.wouldRebuild === true, `decision: ${show(d)}`);
  const o = rows(w, "rebuild.outcome").find((r) => r.parentId === d.spanId);
  must(o?.status === "false-cold" && o.attrs.measuredCold === false, `outcome: ${show(o)}`);
  w.host.dispose();
});

await check("a small context: wouldRebuild false with its reason, and still measured", async () => {
  const w = await world();
  w.usage = { promptTokens: 20_000, cachedPromptTokens: 19_000 };
  await push(w, "first");
  await settle(w);
  age(w, 3 * 60 * MIN);
  w.usage = { promptTokens: 20_100, cachedPromptTokens: 0 };
  await push(w, "second");
  await settle(w);
  const d = rows(w, "rebuild.decision")[1]!;
  must(d.status === "would-keep" && d.attrs.wouldRebuild === false && d.attrs.predictedCold === true
    && d.attrs.reason === "context-below-threshold" && d.attrs.contextTokens === 20_000, `decision: ${show(d)}`);
  const o = rows(w, "rebuild.outcome").find((r) => r.parentId === d.spanId);
  // Predicted cold by the gap and measured cold: agreement, whatever the size gate said about rebuilding.
  must(o?.status === "agree" && o.attrs.measuredCold === true, `outcome: ${show(o)}`);
  w.host.dispose();
});

await check("rows carry numbers and ids only: no text of the conversation", async () => {
  const w = await world();
  w.usage = { promptTokens: 200_000, cachedPromptTokens: 0 };
  await push(w, "SECRET-WAKE-TEXT");
  await settle(w);
  const all = [...rows(w, "rebuild.decision"), ...rows(w, "rebuild.outcome")];
  must(all.length === 2, `rows: ${show(all)}`);
  must(!show(all).includes("SECRET") && !show(all).includes("noted"), `text in a row: ${show(all)}`);
  w.host.dispose();
});

await check("a benchmark agent records nothing, and neither does a runtime with no policy", async () => {
  for (const o of [{ tenant: BENCH_TENANT }, { policy: null }]) {
    const w = await world(o);
    w.usage = { promptTokens: 200_000, cachedPromptTokens: 0 };
    await push(w, "first");
    await settle(w);
    age(w, 2 * 60 * MIN);
    await push(w, "second");
    await settle(w);
    must(w.calls.length === 2, `control: both wakes ran (${w.calls.length} calls)`);
    must(rows(w, "rebuild.decision").length === 0 && rows(w, "rebuild.outcome").length === 0, `${show(o)}: ${show(pendingTrace(w.host.sql as never, 0).rows.map((r) => r.kind))}`);
    w.host.dispose();
  }
});

await check("a push into a running turn is not a wake: no decision", async () => {
  const w = await world();
  await w.rt.postMessage(w.tenant, "a", "busy", "prompt", "main");
  await w.rt.step(w.tenant, "a");
  must(w.sent.length === 1 && !w.answered.has(w.sent[0]!), "control: a call is out");
  await push(w, "during");
  must(rows(w, "rebuild.decision").length === 0, `decided mid-turn: ${show(rows(w, "rebuild.decision"))}`);
  await settle(w);
  w.host.dispose();
});

/** A request with what differs between two runs by construction (clock, ids) folded: the clock in an overflow
 *  briefing's labels too (src/runtime/overflow-backstop.ts `buildBriefing`), `[conversation · time · source]` and a
 *  tool line's `- time name`, and nowhere else. */
const BRIEFING_TIME = /(\[[^\]\n]* · )\d{4}-\d\d-\d\d \d\d:\d\dZ( · [^\]\n]*\])|(^- )\d{4}-\d\d-\d\d \d\d:\d\dZ( )/gm;
const normal = (c: Ctx) => JSON.stringify(c, (k, v) => (k === "timestamp" ? 0 : k === "jobId" || k === "responseId" ? "id"
  : typeof v === "string" ? v.replace(BRIEFING_TIME, (_m, a, b, c2, d) => a !== undefined ? `${a}T${b}` : `${c2}T${d}`) : v));

await check("shadow mode alters no model input: every request is byte-identical with the decision recorded and without it", async () => {
  const run = async (policy: RebuildPolicy | null) => {
    const w = await world({ policy });
    // Large enough that every later wake is also a window decision, and the second answer an overflow.
    w.usage = { promptTokens: 850_000, cachedPromptTokens: 0 };
    await push(w, "first");
    await settle(w);
    age(w, 2 * 60 * MIN);
    w.fail = [{ errorMessage: REFUSED, providerError: "400 maximum context length is 1000000 tokens" }];
    await push(w, "second");
    await settle(w);
    age(w, 2 * MIN);
    await push(w, "third");
    await settle(w);
    // Shadow rows only: the overflow below is acted on by the backstop in both runs, which is its own decision.
    const decided = rows(w, "rebuild.decision").filter((r) => r.attrs.shadow === true).length;
    w.host.dispose();
    return { calls: w.calls.map(normal), decided };
  };
  const on = await run(SHADOW_ONLY);
  const off = await run(null);
  // Each wake's cold-wake decision, and a window one for the second and third (every answer says 850k); the overflow
  // is the backstop's own decision (`shadow: false`), not one of these.
  must(on.decided === 5 && off.decided === 0, `control: decisions ${on.decided} / ${off.decided}`);
  // The overflow's run, the backstop's rebuilt call, and the third wake.
  must(on.calls.length === 4 && off.calls.length === 4, `calls: ${on.calls.length} / ${off.calls.length}`);
  for (let i = 0; i < on.calls.length; i++) must(on.calls[i] === off.calls[i], `request ${i} differs:\n${on.calls[i]!.slice(0, 600)}\n${off.calls[i]!.slice(0, 600)}`);
});

await check("an error answer is unmeasured, and a failed wake is passed over: the next decision reads the last answered call", async () => {
  const w = await world();
  w.usage = { promptTokens: 200_000, cachedPromptTokens: 0 };
  await push(w, "first");
  await settle(w);
  age(w, 2 * MIN);
  w.usage = { promptTokens: 200_100, cachedPromptTokens: 199_000 };
  await push(w, "second");
  await settle(w);
  age(w, 90 * MIN);
  // Counts on an error answer say nothing about the cache: it is unmeasured whatever they are.
  w.fail = [{ errorMessage: REFUSED, providerError: "400 upstream rejected the request", input: 200_200, cacheRead: 200_000 }];
  await push(w, "third");
  await settle(w);
  must(w.fail.length === 0 && w.calls.length === 3, `control: the failed wake made one call and it failed (${w.calls.length} calls)`);
  const [, warm, failed] = rows(w, "rebuild.decision");
  const o = rows(w, "rebuild.outcome").find((r) => r.parentId === failed?.spanId);
  must(o?.status === "unmeasured" && o.attrs.hitRate === null && o.attrs.input === 200_200, `the failed wake's outcome: ${show(o)}`);
  // The wake after: its facts are the second wake's answer, not the failure's, and the unmeasured wake is not "the
  // previous wake's state".
  w.usage = { promptTokens: 200_300, cachedPromptTokens: 0 };
  await push(w, "fourth");
  await settle(w);
  const next = rows(w, "rebuild.decision").at(-1)!;
  must(next.attrs.contextTokens === 200_100 && next.attrs.gapMs >= 90 * MIN, `facts read past the failed wake: ${show(next.attrs)}`);
  const second = rows(w, "rebuild.outcome").find((r) => r.parentId === warm?.spanId)!;
  must(Math.abs(next.attrs.prevWakeHitRate - second.attrs.hitRate) < 1e-9, `prevWakeHitRate: ${show(next.attrs)} vs ${show(second.attrs)}`);
  w.host.dispose();
});

await check("pi085 window: a wake whose context reaches 80% of the window is a `window` rebuild in shadow; below it, none", async () => {
  for (const [tokens, expect] of [[850_000, true], [700_000, false]] as const) {
    const w = await world();
    w.usage = { promptTokens: tokens, cachedPromptTokens: 0 };
    await push(w, "first");
    await settle(w);
    age(w, 2 * MIN);
    await push(w, "second");
    await settle(w);
    const win = rows(w, "rebuild.decision").filter((r) => r.attrs.trigger === "window");
    must(rows(w, "rebuild.decision").filter((r) => r.attrs.trigger === "cold-wake").length === 2, "control: two wakes decided");
    if (!expect) { must(win.length === 0, `${tokens}: ${show(win)}`); w.host.dispose(); continue; }
    must(win.length === 1 && win[0]!.status === "would-rebuild" && win[0]!.attrs.wouldRebuild === true && win[0]!.attrs.strategy === "summary"
      && win[0]!.attrs.reason === "context-near-window" && win[0]!.attrs.contextTokens === 850_000 && win[0]!.attrs.contextWindow === 1_000_000,
      `${tokens}: ${show(win)}`);
    w.host.dispose();
  }
});

await check("pi085 window: an answer that is a context-overflow error is a `window` rebuild in shadow, with the last answered context", async () => {
  const w = await world();
  w.usage = { promptTokens: 990_000, cachedPromptTokens: 0 };
  await push(w, "first");
  await settle(w);
  must(!rows(w, "rebuild.decision").some((r) => r.attrs.reason === "overflow"), "control: no overflow before one");
  age(w, 2 * MIN);
  w.fail = [{ errorMessage: REFUSED, providerError: "400 This model's maximum context length is 1000000 tokens. However, your messages resulted in 1000400 tokens." }];
  await push(w, "second");
  await settle(w);
  const ov = rows(w, "rebuild.decision").filter((r) => r.attrs.reason === "overflow");
  must(ov.length === 1 && ov[0]!.attrs.trigger === "window" && ov[0]!.attrs.wouldRebuild === true && ov[0]!.attrs.contextTokens === 990_000,
    `overflow: ${show(ov)}`);
  // An error that is not an overflow is not one.
  age(w, 2 * MIN);
  w.fail = [{ errorMessage: REFUSED, providerError: "400 upstream rejected the request" }];
  await push(w, "third");
  await settle(w);
  must(rows(w, "rebuild.decision").filter((r) => r.attrs.reason === "overflow").length === 1, "a plain refusal read as an overflow");
  w.host.dispose();
});

// ---- pd: the engine's own compaction, recorded ---------------------------------------------------------------------

const SUMMARIZER = "You are a context summarization assistant.";
type Job = { id: string; answer: string | null; state: string | null; request: string };
const pdJobs = (s: DurableSqlHost): Job[] => s.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'ap_model_jobs'").toArray().length === 0 ? []
  : s.sql.exec("SELECT id, answer, state, request FROM ap_model_jobs ORDER BY created_at, rowid").toArray() as unknown as Job[];

async function pdRun(storage: DurableSqlHost, agent: DurableAgent, usage: (summary: boolean) => Usage) {
  let out = await agent.step();
  for (let guard = 0; out.wakeInMs !== null; guard++) {
    must(guard < 80, `never settled: ${show(out)}`);
    for (const j of pdJobs(storage).filter((j) => j.answer === null && j.state === null)) {
      const job = await agent.takeJob(j.id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
      toRequest(job.context);
      const u = usage(j.request.includes(SUMMARIZER));
      const res: ModelResponse = { text: "ok", finishReason: "stop", truncated: false,
        usage: { promptTokens: u.promptTokens, completionTokens: 5, reasoningTokens: 0, cachedPromptTokens: u.cachedPromptTokens } };
      const message: AnsweredMessage = fromResponse(res, { api: job.model.api, provider: job.model.provider, id: job.model.id }, j.id);
      must(await agent.deliver(j.id, message) === true, `deliver ${j.id}`);
    }
    await sleep(out.wakeInMs);
    out = await agent.step();
  }
}

await check("pd: a background compaction past the window threshold is a `window` rebuild that ran, and the next answer measures the context it left", async () => {
  const storage = sqliteHost() as unknown as DurableSqlHost;
  const host = new PdHost({ storage, pollAfterMs: 200, minParkMs: 1, rebuilds: true,
    compaction: { keepRecentTokens: 10, reserveTokens: 1000, backgroundTokens: 98_000 } });
  const agent = DurableAgent.open({ host, tenantId: "t", agentId: "a", model: { provider: "queue", id: "m1", contextWindow: 100_000 },
    systemPrompt: "terse", dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
  const LONG = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(200)}`;
  const turn = { promptTokens: 1_500, cachedPromptTokens: 1_400 };
  await agent.say(LONG("first"));
  await pdRun(storage, agent, (s) => (s ? { promptTokens: 300, cachedPromptTokens: 0 } : turn));
  await agent.say(LONG("second"));
  await pdRun(storage, agent, (s) => (s ? { promptTokens: 300, cachedPromptTokens: 0 } : turn));
  const all = pendingTrace(storage.sql as never, 0).rows;
  const d = all.find((r) => r.kind === "rebuild.decision") as Row | undefined;
  must(d, `no compaction recorded; kinds: ${show(all.map((r) => r.kind))}`);
  must(d.status === "ran" && d.attrs.trigger === "window" && d.attrs.reason === "threshold" && d.attrs.strategy === "summary"
    && d.attrs.contextTokens === 1_500, `decision: ${show(d)}`);
  await agent.say("third");
  await pdRun(storage, agent, () => ({ promptTokens: 400, cachedPromptTokens: 0 }));
  const o = pendingTrace(storage.sql as never, 0).rows.find((r) => r.kind === "rebuild.outcome" && r.parentId === d.spanId) as Row | undefined;
  must(o && o.attrs.input === 400 && o.attrs.hitRate === 0 && o.status === "expected-cold" && o.attrs.trigger === "window", `outcome: ${show(o)}`);
  await agent.close();
});

await check("pd: without `rebuilds` a compaction writes no rebuild row", async () => {
  const storage = sqliteHost() as unknown as DurableSqlHost;
  const host = new PdHost({ storage, pollAfterMs: 200, minParkMs: 1,
    compaction: { keepRecentTokens: 10, reserveTokens: 1000, backgroundTokens: 98_000 } });
  const agent = DurableAgent.open({ host, tenantId: "t", agentId: "a", model: { provider: "queue", id: "m1", contextWindow: 100_000 },
    systemPrompt: "terse", dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
  const LONG = (tag: string) => `${tag} ${"lorem ipsum dolor sit amet ".repeat(200)}`;
  for (const t of ["first", "second", "third"]) {
    await agent.say(LONG(t));
    await pdRun(storage, agent, () => ({ promptTokens: 1_500, cachedPromptTokens: 0 }));
  }
  const kinds = pendingTrace(storage.sql as never, 0).rows.map((r) => r.kind);
  must(pdJobs(storage).some((j) => j.request.includes(SUMMARIZER)), "control: a compaction ran");
  must(!kinds.some((k) => k.startsWith("rebuild.")), `kinds: ${show(kinds)}`);
  await agent.close();
});

console.log(`\n  rebuild, decided at wake time (shadow)\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
