/**
 * A wake after a long idle, rebuilt before it is answered (src/runtime/rebuild.ts `idleRebuild`, `#coldWake` and
 * `#rebuildContext` in cf/src/runtime.ts), and what the agent did on the run after it (src/runtime/rebuild-behaviour.ts).
 *
 * The runtime rows drive the real `AgentRuntime` over node:sqlite with the model scripted through the queue, as
 * test/rebuild-shadow.ts and test/overflow-backstop.ts do. A long gap is made by moving the transcript's times back,
 * which is the one fact the decision reads it from; a large context by the answer's usage.
 */
import { AgentRuntime, BENCH_TENANT } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { acceptInbound, ensureInboundTable } from "../src/runtime/inbound.ts";
import { currentMainId, mainSessions } from "../cf/src/fresh-context.ts";
import {
  DEFAULT_IDLE_POLICY, DEFAULT_IDLE_RULE, DEFAULT_REBUILD_POLICY, idleRebuild, readWakeFacts, rebuildPolicyOf, recordRebuildDecision,
  settleRebuildOutcome, type RebuildPolicy,
} from "../src/runtime/rebuild.ts";
import { briefingOf, buildBriefing, isSendTool, judgeOverflow, readBackstop, type BriefingEntry } from "../src/runtime/overflow-backstop.ts";
import { callKey, isRecapTool, priorCallKeys, summariseBehaviour } from "../src/runtime/rebuild-behaviour.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const MIN = 60_000;

// ---- the rule, as a table -----------------------------------------------------------------------------------------

const DS = "deepseek-flash", LUNA = "openai/gpt-5.6-luna";
const off = (model: string): RebuildPolicy => ({ ...DEFAULT_REBUILD_POLICY, idle: { ...DEFAULT_IDLE_POLICY, byModel: { ...DEFAULT_IDLE_POLICY.byModel, [model]: { idleMinutes: null, minContextTokens: 8_000 } } } });
const table: Array<[string, { gapMs: number | null; contextTokens: number | null; model?: string }, RebuildPolicy, boolean, string, string]> = [
  ["deepseek: 61 minutes on a large context", { gapMs: 61 * MIN, contextTokens: 200_000 }, DEFAULT_REBUILD_POLICY, true, "idle-over-limit", "byModel:deepseek"],
  ["luna: 61 minutes on a large context", { gapMs: 61 * MIN, contextTokens: 200_000, model: LUNA }, DEFAULT_REBUILD_POLICY, true, "idle-over-limit", "byModel:gpt-5.6-luna"],
  ["another model: the default entry", { gapMs: 61 * MIN, contextTokens: 200_000, model: "m1" }, DEFAULT_REBUILD_POLICY, true, "idle-over-limit", "default"],
  ["59 minutes", { gapMs: 59 * MIN, contextTokens: 200_000 }, DEFAULT_REBUILD_POLICY, false, "gap-under-idle", "byModel:deepseek"],
  ["exactly 60 minutes is not over it", { gapMs: 60 * MIN, contextTokens: 200_000 }, DEFAULT_REBUILD_POLICY, false, "gap-under-idle", "byModel:deepseek"],
  ["a context no larger than a briefing", { gapMs: 3 * 60 * MIN, contextTokens: 8_000 }, DEFAULT_REBUILD_POLICY, false, "context-below-briefing", "byModel:deepseek"],
  ["a context just over a briefing", { gapMs: 3 * 60 * MIN, contextTokens: 8_001 }, DEFAULT_REBUILD_POLICY, true, "idle-over-limit", "byModel:deepseek"],
  ["no answered call yet", { gapMs: null, contextTokens: null }, DEFAULT_REBUILD_POLICY, false, "no-previous-call", "byModel:deepseek"],
  ["reset since the last call", { gapMs: 3 * 60 * MIN, contextTokens: null }, DEFAULT_REBUILD_POLICY, false, "context-unknown", "byModel:deepseek"],
  ["idle: false turns every model off", { gapMs: 3 * 60 * MIN, contextTokens: 200_000 }, { ...DEFAULT_REBUILD_POLICY, idle: false }, false, "idle-off", "off"],
  ["one model turned off (idleMinutes: null)", { gapMs: 3 * 60 * MIN, contextTokens: 200_000 }, off("deepseek"), false, "idle-off", "byModel:deepseek"],
  ["… and the other still on", { gapMs: 3 * 60 * MIN, contextTokens: 200_000, model: LUNA }, off("deepseek"), true, "idle-over-limit", "byModel:gpt-5.6-luna"],
  ["an exact model id wins over a key it contains", { gapMs: 31 * MIN, contextTokens: 1_001 },
    { ...DEFAULT_REBUILD_POLICY, idle: { default: DEFAULT_IDLE_RULE, byModel: { deepseek: { idleMinutes: null, minContextTokens: 0 }, [DS]: { idleMinutes: 30, minContextTokens: 1_000 } } } },
    true, "idle-over-limit", `byModel:${DS}`],
];
for (const [name, f, policy, rebuild, reason, entry] of table) {
  await check(`idleRebuild — ${name}`, () => {
    const d = idleRebuild({ model: DS, ...f }, policy);
    must(d.rebuild === rebuild && d.reason === reason && d.entry === entry, `got ${show(d)}`);
  });
}

await check("rebuildPolicyOf — an idle section is taken, `false` turns it off, and a broken one refuses the policy", () => {
  must(DEFAULT_IDLE_RULE.idleMinutes === 60 && DEFAULT_IDLE_RULE.minContextTokens === 8_000, `default: ${show(DEFAULT_IDLE_RULE)}`);
  const base = { rules: DEFAULT_REBUILD_POLICY.rules, fallback: DEFAULT_REBUILD_POLICY.fallback };
  const mine = rebuildPolicyOf(JSON.stringify({ ...base, idle: { default: { idleMinutes: 90, minContextTokens: 20_000 }, byModel: { luna: { idleMinutes: null, minContextTokens: 0 } } } }));
  must(mine !== DEFAULT_REBUILD_POLICY && mine?.idle && mine.idle.default.idleMinutes === 90 && mine.idle.byModel?.luna?.idleMinutes === null, `taken: ${show(mine?.idle)}`);
  must(rebuildPolicyOf(JSON.stringify({ ...base, idle: false }))?.idle === false, "off");
  must(rebuildPolicyOf(JSON.stringify(base))?.idle === undefined, "absent: the default applies at use");
  const rule = { idleMinutes: 60, minContextTokens: 1 };
  for (const bad of [{ default: { idleMinutes: 0, minContextTokens: 1 } }, { default: { idleMinutes: "60", minContextTokens: 1 } },
    { default: { idleMinutes: 60, minContextTokens: -1 } }, { default: { idleMinutes: 60 } }, { byModel: { x: rule } }, rule,
    { default: rule, byModel: { x: { idleMinutes: -5, minContextTokens: 1 } } }, { default: rule, byModel: [rule] }, true]) {
    must(rebuildPolicyOf(JSON.stringify({ ...base, idle: bad })) === DEFAULT_REBUILD_POLICY, `refused: ${show(bad)}`);
  }
});

await check("a rebuild_shadow table written before gap_ms: read as it is (gap unknown), then given the column and the gap", () => {
  const host = sqliteHost();
  const sql = host.sql as never;
  host.sql.exec(`CREATE TABLE rebuild_shadow (id TEXT PRIMARY KEY, entries TEXT NOT NULL, trigger TEXT NOT NULL, strategy TEXT NOT NULL,
    decided_at INTEGER NOT NULL, would INTEGER NOT NULL, cold INTEGER NOT NULL, expected INTEGER NOT NULL, rule TEXT,
    cold_hit_rate REAL NOT NULL, settled_at INTEGER, hit_rate REAL)`);
  host.sql.exec("INSERT INTO rebuild_shadow VALUES ('rb_old','pi_entries','cold-wake','briefing',1,0,0,0,'deepseek',0.5,2,0.9)");
  const before = readWakeFacts(sql, "pi_entries", 10, "0");
  must(before.prevWakeHitRate === 0.9 && before.prevWakeGapMs === null, `an old row: ${show(before)}`);
  recordRebuildDecision(sql, (fn) => fn(), {
    tenantId: "t", agentId: "a", key: "pi_entries", trigger: "cold-wake", strategy: "briefing", wouldRebuild: false, predictedCold: false,
    expectedCold: false, status: "would-keep", reason: "warm", rule: "deepseek", coldHitRate: 0.5, awaitOutcome: true, facts: { gapMs: 4_000 }, at: 20,
  });
  settleRebuildOutcome(sql, { tenantId: "t", agentId: "a", entries: "pi_entries", jobId: "mj_1", at: 30, stopReason: "stop", usage: { input: 10, cacheRead: 5 } });
  const after = readWakeFacts(sql, "pi_entries", 40, "0");
  must(after.prevWakeHitRate === 0.5 && after.prevWakeGapMs === 4_000, `the new row: ${show(after)}`);
  host.dispose();
});

// ---- the behaviour summary, as a pure function ----------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 11, 14, 0);
let seqN = 0;
const entry = (message: unknown, at: number): BriefingEntry => ({ id: `e${++seqN}`, timestamp: at, message });
const user = (text: string, at: number) => entry({ role: "user", content: [{ type: "text", text }], timestamp: at }, at);
const calls = (at: number, cs: Array<{ id: string; name: string; arguments: unknown }>, stopReason = "toolUse") =>
  entry({ role: "assistant", content: cs.map((c) => ({ type: "toolCall", ...c })), stopReason, timestamp: at }, at);
const wrote = (text: string, at: number) => entry({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at }, at);
const result = (id: string, isError: boolean, at: number) =>
  entry({ role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: "r" }], isError, timestamp: at }, at);

await check("summariseBehaviour — re-reads before the first send, a repeat of a call that succeeded, the latency to the send", () => {
  const before: BriefingEntry[] = [
    user("old", T0), calls(T0 + 1, [{ id: "o1", name: "state__get", arguments: { key: "notes" } }]), result("o1", false, T0 + 2),
    calls(T0 + 3, [{ id: "o2", name: "raft__messages_read", arguments: { channel: "c", limit: 5 } }]), result("o2", true, T0 + 4),
    wrote("done", T0 + 5),
  ];
  const prior = priorCallKeys(before);
  must(prior.length === 1 && prior[0] === callKey("state__get", { key: "notes" }), `prior keys: only the call that succeeded: ${show(prior)}`);
  const wake = T0 + 60 * MIN;
  const after: BriefingEntry[] = [
    user("briefing --- wake", wake),
    calls(wake + 1000, [{ id: "n1", name: "state__get", arguments: { key: "notes" } }]), result("n1", false, wake + 1100),
    calls(wake + 2000, [{ id: "n2", name: "raft__messages_read", arguments: { limit: 5, channel: "c" } }]), result("n2", false, wake + 2100),
    calls(wake + 3000, [{ id: "n3", name: "raft__messages_send", arguments: { content: "hi" } }]), result("n3", false, wake + 3500),
    calls(wake + 4000, [{ id: "n4", name: "state__get", arguments: { key: "notes" } }]), result("n4", false, wake + 4100),
    wrote("ok", wake + 5000),
  ];
  const b = summariseBehaviour(after, { wakeAt: wake, prior });
  must(b.sent && b.firstSendMs === 3500 && b.toolCallsBeforeSend === 2 && b.recapCallsBeforeSend === 2 && b.firstAction === "recap"
    && b.repeatedCalls === 2 && b.repeatedBeforeSend === 1 && b.priorActions === 1 && b.toolCalls === 4 && b.modelCalls === 5
    && b.runMs === 5000 && b.endedWith === "stop" && b.failedToolCalls === 0, `behaviour: ${show(b)}`);
  must(isRecapTool("state__list") && isRecapTool("raft__tasks_history") && !isRecapTool("raft__messages_send") && !isRecapTool("raft__inbox_check"), "recap tools");
  const none = summariseBehaviour([user("wake", wake), wrote("nothing to do", wake + 10)], { wakeAt: wake, prior });
  must(!none.sent && none.firstSendMs === null && none.firstAction === null && none.toolCalls === 0, `no calls: ${show(none)}`);
});

// ---- the runtime ---------------------------------------------------------------------------------------------------

type Ctx = { systemPrompt: string; messages: any[]; tools: Array<{ name: string }> };
type Answer = (ctx: Ctx, jobId: string) => unknown;
type World = {
  host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string>; calls: Ctx[]; answer: Answer;
  tenant: string; promptTokens: number;
};

const chat: Plugin = {
  id: "chat", version: "1.0.0",
  tools: [
    { name: "send_message", description: "Send a message.", parameters: { type: "object", properties: { text: { type: "string" } } }, sideEffects: "write", idempotency: "none" },
  ] as never,
  async invoke() { return { ok: true }; },
} as Plugin;

const identity = { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" };

function runtimeOver(host: ReturnType<typeof sqliteHost>, sent: string[], policy: RebuildPolicy | null) {
  const standIn = standInLoader();
  return new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [chat], loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    rebuildPolicy: policy,
  } as never);
}

async function world(o: { policy?: RebuildPolicy | null; tenant?: string } = {}): Promise<World> {
  const host = sqliteHost();
  const sent: string[] = [];
  const w: World = { host, sent, answered: new Set(), calls: [], answer: () => null, tenant: o.tenant ?? "t", promptTokens: 1,
    rt: runtimeOver(host, sent, o.policy === undefined ? DEFAULT_REBUILD_POLICY : o.policy) };
  await w.rt.ready();
  await w.rt.store.createAgent(w.tenant, "a");
  for (const [alias, plugin] of [["state", "state"], ["chat", "chat"]] as const) {
    await w.rt.store.setPluginChoice(w.tenant, "a", plugin, "enable");
    const added = await w.rt.addMount(w.tenant, "a", { alias, plugin, config: { account: alias } });
    must(added.ok, `the ${alias} mount was refused: ${show(added)}`);
  }
  await w.rt.bindOperatorModel(w.tenant, "a");
  await w.rt.reconcileSeeds(w.tenant, "a");
  const pending = await w.rt.store.pendingSeedNotices(w.tenant, "a");
  await w.rt.store.takeSeedNotices(w.tenant, "a", new Set(pending.map((n) => `${n.alias}@${n.since}`)));
  w.answer = say("noted");
  return w;
}

const usageOf = (w: World) => ({ promptTokens: w.promptTokens, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 });
const say = (text: string): Answer => function (this: World, _c, id) {
  return fromResponse({ text, finishReason: "stop", truncated: false, usage: usageOf(this) } as ModelResponse, identity, id);
};
const callTool = (name: string, args: unknown): Answer => function (this: World, _c, id) {
  return fromResponse({ text: "", finishReason: "tool_calls", truncated: false, usage: usageOf(this), toolCalls: [{ id: `call_${id}`, name, arguments: args }] } as ModelResponse, identity, id);
};
const script = (...answers: Answer[]): Answer => { let n = 0; return function (this: World, c, id) { return answers[Math.min(n++, answers.length - 1)]!.call(this, c, id); }; };

/** Step and answer until the object asks for nothing; the number of model calls it made. */
async function settle(w: World): Promise<number> {
  const before = w.calls.length;
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step(w.tenant, "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !w.answered.has(id));
    for (const id of pending) {
      w.answered.add(id);
      const job = await w.rt.takeJob(w.tenant, "a", id) as { context: Ctx } | null;
      if (!job) continue;
      w.calls.push(JSON.parse(JSON.stringify(job.context)));
      await w.rt.deliverAnswer(w.tenant, "a", id, w.answer.call(w, w.calls.at(-1)!, id) as never, undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return w.calls.length - before;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error("the object did not settle");
}

/** A push queued at a hook and handed to the agent: a wake. */
async function push(w: World, text: string, opts: { beforeFirstPost?: () => Promise<void> } = {}) {
  ensureInboundTable(w.host.sql as never);
  acceptInbound(w.host.sql as never, { hookId: "h1", alias: "chat", dedupeKey: null, message: text, now: Date.now() });
  return w.rt.deliverPendingInbound(w.tenant, "a", opts);
}

/** The time since the conversation's last answer, as the transcript records it. */
const age = (w: World, ms: number) => w.host.sql.exec("UPDATE pi_entries SET timestamp = timestamp - ? WHERE type = 'message'", ms);

type Row = { kind: string; spanId: string; parentId: string | null; status: string; attrs: Record<string, any> };
const rows = (w: World, kind: string): Row[] => (w.host.sql.exec(
  "SELECT 1 FROM sqlite_master WHERE name = 'trace_outbox'").toArray().length ? w.host.sql.exec(
  "SELECT kind, span_id, parent_id, status, attrs FROM trace_outbox WHERE kind = ? ORDER BY seq", kind).toArray() as any[] : [])
  .map((r) => ({ kind: String(r.kind), spanId: String(r.span_id), parentId: r.parent_id === null ? null : String(r.parent_id), status: String(r.status), attrs: JSON.parse(String(r.attrs)) }));
const coldWakes = (w: World) => rows(w, "rebuild.decision").filter((r) => r.attrs.trigger === "cold-wake");
const textOf = (m: any): string => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
const rebuilds = (w: World) => mainSessions(w.host.sql as never).filter((s) => s.cause === "rebuild").length;
const ANNOUNCES = /rebuil|reset|restor|summar|compact|fresh|new conversation|context (?:was|has been)|idle/i;

/** A first wake answered on a large context, with a tool call that succeeds and a send, then `gap` of silence. */
async function primed(w: World, gapMs: number, contextTokens = 200_000) {
  w.promptTokens = contextTokens;
  w.answer = script(callTool("state__get", { key: "notes" }), callTool("chat__send_message", { text: "on it" }), say("done"));
  must((await push(w, "FIRST WAKE")).posted === 1, "control: the first push was posted");
  must(await settle(w) === 3, "control: the first wake made its three calls");
  age(w, gapMs);
}

await check("61 minutes on a large context: rebuilt before it is answered — the request starts with the briefing and ends with the wake; one decision, its outcome, its behaviour", async () => {
  const w = await world();
  await primed(w, 5 * MIN);
  // A warm wake in between, measured: the previous wake's hit rate and gap the rebuild's row carries.
  w.answer = say("warm");
  must((await push(w, "WARM WAKE")).posted === 1 && await settle(w) === 1, "control: the warm wake");
  must(coldWakes(w).at(-1)!.attrs.idleRebuild === "gap-under-idle", `control: the warm wake was not rebuilt: ${show(coldWakes(w).at(-1))}`);
  age(w, 61 * MIN);
  const decidedBefore = coldWakes(w).length;
  w.promptTokens = 3_000;
  w.answer = script(callTool("state__get", { key: "notes" }), callTool("chat__send_message", { text: "answer" }), say("sent"));
  const pass = await push(w, "SECOND WAKE");
  must(pass.posted === 1, `the push was not posted: ${show(pass)}`);
  must(rebuilds(w) === 1 && currentMainId(w.host.sql as never) === "main.1", `transcripts: ${show(mainSessions(w.host.sql as never))}`);
  must(await settle(w) === 3, "the wake's run did not make its three calls");
  const first = w.calls[4]!;
  must(first.messages.length === 1 && first.messages[0].role === "user", `the rebuilt request: ${first.messages.length} messages`);
  const text = textOf(first.messages[0]);
  const briefing = briefingOf(w.host.sql as never, "main.1");
  must(briefing && text.startsWith(briefing), `the request does not start with the briefing:\n${text.slice(0, 400)}`);
  must(text.endsWith("SECOND WAKE") && text.indexOf("SECOND WAKE") > briefing.length, `the wake is not last:\n${text.slice(-400)}`);
  must(text.includes("FIRST WAKE") && /you sent with chat__send_message\]\n```+\non it\n```+/.test(text) && /state__get \{"key":"notes"\} — ok/.test(text),
    `the briefing lacks the history, the agent's send or its tool calls:\n${text}`);
  must(!ANNOUNCES.test(briefing), `the briefing announces the rebuild:\n${briefing}`);
  must(readBackstop(w.host.sql as never).pending === null, "the briefing is still pending after the wake carried it");

  const decided = coldWakes(w).slice(decidedBefore);
  must(decided.length === 1, `one cold-wake decision for the wake, not ${decided.length}: ${show(decided)}`);
  const d = decided[0]!, a = d.attrs;
  must(d.status === "ran" && a.shadow === false && a.acted === true && a.strategy === "briefing" && a.reason === "idle-over-limit" && a.rule === "idle", `decision: ${show(d)}`);
  must(a.gapMs >= 61 * MIN && a.gapMs < 62 * MIN && a.contextTokens === 200_000 && a.idleMs === 60 * MIN && a.minContextTokens === 8_000, `facts: ${show(a)}`);
  must(a.conversation === "main" && a.to === "main.1" && a.logicalConversation === "main" && a.provider && a.model === "deepseek-flash", `ids: ${show(a)}`);
  must(a.budgetTokens === 8_000 && a.briefingTokens > 0 && a.briefingTokens <= 8_000 && a.messages >= 2 && a.actions === 2 && a.inputs === 0, `briefing: ${show(a)}`);
  must(a.idleEntry === "byModel:deepseek" && a.predictedCold === true && a.shadowReason === "gap-over-limit" && a.shadowRule === "deepseek", `prediction: ${show(a)}`);
  // The warm wake's measurement (200k sent, none of it cached) and its gap (5 minutes), as the shadow rows read them.
  must(a.prevWakeHitRate === 0 && a.prevWakeGapMs >= 5 * MIN && a.prevWakeGapMs < 6 * MIN, `the previous wake: ${show(a)}`);
  const o = rows(w, "rebuild.outcome").filter((r) => r.parentId === d.spanId);
  must(o.length === 1 && o[0]!.attrs.input === 3_000 && o[0]!.attrs.hitRate === 0 && o[0]!.status === "expected-cold", `outcome: ${show(o)}`);
  const opens = rows(w, "harness.open").filter((r) => r.status === "rebuild");
  must(opens.length === 1 && opens[0]!.attrs.detail === "trigger=cold-wake strategy=briefing from=main", `harness.open: ${show(opens)}`);

  const b = rows(w, "rebuild.behaviour");
  must(b.length === 1 && b[0]!.parentId === d.spanId && b[0]!.status === "sent", `behaviour rows: ${show(b)}`);
  const x = b[0]!.attrs;
  must(x.sent === true && x.firstSendMs >= 0 && x.firstSendMs < 30_000 && x.toolCallsBeforeSend === 1 && x.recapCallsBeforeSend === 1
    && x.firstAction === "recap" && x.repeatedCalls === 1 && x.repeatedBeforeSend === 1 && x.priorActions === 2 && x.toolCalls === 2
    && x.modelCalls === 3 && x.endedWith === "stop" && x.conversation === "main.1" && x.logicalConversation === "main", `behaviour: ${show(x)}`);
  const all = show([...coldWakes(w), ...rows(w, "rebuild.outcome"), ...b]);
  must(!all.includes("WAKE") && !all.includes("notes") && !all.includes("on it"), `text in a row: ${all}`);
  // The next wake reads the rebuilt conversation: warm, small, and answered without another rebuild.
  w.answer = say("again");
  await push(w, "THIRD WAKE");
  await settle(w);
  must(rebuilds(w) === 1 && rows(w, "rebuild.behaviour").length === 1, "a second rebuild or behaviour row");
  must(coldWakes(w).at(-1)!.attrs.shadow === true && coldWakes(w).at(-1)!.attrs.idleRebuild === "gap-under-idle", `the next wake: ${show(coldWakes(w).at(-1))}`);
  w.host.dispose();
});

await check("an alarm's step while the wake is being posted leaves the briefing to that post: no run on the briefing alone", async () => {
  const w = await world();
  await primed(w, 61 * MIN);
  // `seal` is awaited inside the wake's post after the rebuild and before the post takes the briefing: a step there is
  // the alarm that lands in between.
  const store = w.rt.store as unknown as { seal: (...a: unknown[]) => Promise<unknown> };
  const seal = store.seal.bind(store);
  let stepped = 0;
  store.seal = async (...a: unknown[]) => {
    if (rebuilds(w) === 1 && !stepped++) await w.rt.step(w.tenant, "a");
    return seal(...a);
  };
  w.answer = say("answered");
  must((await push(w, "SECOND WAKE")).posted === 1, "control: posted");
  must(stepped === 1, "control: the step ran inside the post");
  must(await settle(w) === 1, "the wake made more than one call");
  const first = w.calls[3]!;
  must(first.messages.length === 1 && textOf(first.messages[0]).endsWith("SECOND WAKE"), `the first rebuilt request is not the briefing with the wake:\n${textOf(first.messages[0]).slice(-300)}`);
  w.host.dispose();
});

await check("Raft's own sends are quoted as sent: `messages_send` and `messages_reply`, the reply's text and not the id it answers", () => {
  const entries: BriefingEntry[] = [
    user("hello", T0),
    calls(T0 + 1, [{ id: "r1", name: "raft__messages_send", arguments: { target: "#general", content: "SENT TEXT" } }]), result("r1", false, T0 + 2),
    calls(T0 + 3, [{ id: "r2", name: "raft__messages_reply", arguments: { message: "msg_123", content: "REPLY TEXT" } }]), result("r2", false, T0 + 4),
    wrote("done", T0 + 5),
  ];
  const b = buildBriefing(entries, { conversation: "main", redact: (v) => v });
  must(/you sent with raft__messages_send\]\n`+\nSENT TEXT\n/.test(b.text) && /you sent with raft__messages_reply\]\n`+\nREPLY TEXT\n/.test(b.text), `not quoted as sent:\n${b.text}`);
  must(isSendTool("raft__messages_send") && isSendTool("raft__messages_reply") && !isSendTool("raft__messages_read"), "send tools");
});

/** Every request of a world, with what differs between two runs by construction folded: the clock and the ids (job, call, operation). */
const normal = (c: Ctx) => JSON.stringify(c, (k, v) => (k === "timestamp" ? 0 : k === "jobId" || k === "responseId" || k === "id" || k === "operationId" ? "id"
  : typeof v === "string" ? v.replace(/call_mj_[a-z0-9]+/g, "call") : v));

for (const [what, gap, ctx, why] of [
  ["59 minutes on a large context", 59 * MIN, 200_000, "gap-under-idle"],
  ["three hours on a small context", 3 * 60 * MIN, 5_000, "context-below-briefing"],
] as const) {
  await check(`${what}: not rebuilt, the shadow row says why, and every request is byte-identical with no policy at all`, async () => {
    const run = async (policy: RebuildPolicy | null) => {
      const w = await world({ policy });
      await primed(w, gap, ctx);
      w.answer = script(callTool("chat__send_message", { text: "answer" }), say("sent"));
      must((await push(w, "SECOND WAKE")).posted === 1, "control: posted");
      await settle(w);
      const out = { calls: w.calls.map(normal), rebuilds: rebuilds(w), decided: coldWakes(w), behaviour: rows(w, "rebuild.behaviour").length };
      w.host.dispose();
      return out;
    };
    const on = await run(DEFAULT_REBUILD_POLICY), off = await run(null);
    must(on.rebuilds === 0 && on.behaviour === 0, `rebuilt: ${on.rebuilds}`);
    const d = on.decided.at(-1)!;
    must(on.decided.length === 2 && d.attrs.shadow === true && d.status === "would-keep" && d.attrs.idleRebuild === why
      && on.decided.every((r) => r.attrs.shadow === true), `the shadow rows: ${show(on.decided)}`);
    must(off.decided.length === 0 && on.calls.length === 5 && off.calls.length === 5, `control: ${on.calls.length} / ${off.calls.length} calls`);
    for (let i = 0; i < on.calls.length; i++) {
      const at = [...on.calls[i]!].findIndex((ch, k) => ch !== off.calls[i]![k]);
      must(on.calls[i] === off.calls[i], `request ${i} differs at ${at}:\n${on.calls[i]!.slice(at - 200, at + 200)}\n${off.calls[i]!.slice(at - 200, at + 200)}`);
    }
  });
}

await check("a model with its idle rule turned off (idleMinutes: null): not rebuilt, the row names the entry", async () => {
  const w = await world({ policy: off("deepseek") });
  await primed(w, 3 * 60 * MIN);
  must((await push(w, "SECOND WAKE")).posted === 1, "control: posted");
  await settle(w);
  must(rebuilds(w) === 0 && textOf(w.calls[3]!.messages.at(-1)).endsWith("SECOND WAKE") && w.calls[3]!.messages.length > 1, "rebuilt a model turned off");
  const d = coldWakes(w).at(-1)!;
  must(d.attrs.shadow === true && d.attrs.idleRebuild === "idle-off" && d.attrs.idleEntry === "byModel:deepseek" && d.attrs.wouldRebuild === true,
    `row: ${show(d)}`);
  w.host.dispose();
});

await check("a benchmark agent, and a runtime with no policy: never rebuilt, nothing recorded", async () => {
  for (const o of [{ tenant: BENCH_TENANT }, { policy: null }]) {
    const w = await world(o);
    await primed(w, 3 * 60 * MIN);
    await push(w, "SECOND WAKE");
    await settle(w);
    must(w.calls.length === 4, `control: both wakes ran (${w.calls.length} calls)`);
    must(rebuilds(w) === 0 && rows(w, "rebuild.decision").length === 0 && rows(w, "rebuild.behaviour").length === 0, `${show(o)}: rebuilt or recorded`);
    must(textOf(w.calls[3]!.messages.at(-1)).endsWith("SECOND WAKE") && w.calls[3]!.messages.length > 1, `${show(o)}: the wake is not on the old context`);
    w.host.dispose();
  }
});

await check("a push into a running turn is not a wake: not rebuilt, however long the gap before the turn", async () => {
  const w = await world();
  await primed(w, 3 * 60 * MIN);
  await w.rt.postMessage(w.tenant, "a", "busy", "prompt", "main");
  await w.rt.step(w.tenant, "a");
  must(w.sent.length === 4 && !w.answered.has(w.sent[3]!), "control: a call is out");
  const before = coldWakes(w).length;
  await push(w, "DURING");
  must(rebuilds(w) === 0 && coldWakes(w).length === before, `rebuilt or decided mid-turn: ${rebuilds(w)} ${show(coldWakes(w).slice(before))}`);
  await settle(w);
  must(rebuilds(w) === 0, "rebuilt after the turn");
  w.host.dispose();
});

await check("a conversation marked needs_reset as the wake is prepared: not rebuilt, the shadow row says why", async () => {
  const w = await world();
  await primed(w, 3 * 60 * MIN);
  const sql = w.host.sql as never;
  const mark = async () => {
    for (let i = 0; i < 3; i++) judgeOverflow(sql, "main", true, "any", Date.now());
    // A mark with no binding is never cleared as another binding's (src/runtime/overflow-backstop.ts `needsReset`).
    w.host.sql.exec("UPDATE overflow_backstop SET needs_reset_binding = NULL");
  };
  const pass = await push(w, "SECOND WAKE", { beforeFirstPost: mark });
  must(readBackstop(sql).needsReset !== null && pass.posted === 0, `control: marked, and the post refused: ${show(pass)}`);
  must(rebuilds(w) === 0, "rebuilt a conversation marked needs_reset");
  must(coldWakes(w).at(-1)!.attrs.idleRebuild === "needs-reset" && coldWakes(w).at(-1)!.attrs.shadow === true, `row: ${show(coldWakes(w).at(-1))}`);
  w.host.dispose();
});

await check("pd: not applicable — an agent migrated to pd with an old pi085 transcript is not rebuilt, and says so in its log", async () => {
  const w = await world();
  await primed(w, 3 * 60 * MIN);
  const ap = new ApStore(w.host as never, prefixedNamespace("ap"));
  ap.ensure();
  ap.migrateEngine("pi085", "pd");
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  try {
    const sent: string[] = [];
    const rt = runtimeOver(w.host, sent, DEFAULT_REBUILD_POLICY);
    await rt.ready();
    ensureInboundTable(w.host.sql as never);
    acceptInbound(w.host.sql as never, { hookId: "h1", alias: "chat", dedupeKey: null, message: "PD WAKE", now: Date.now() });
    const before = rows(w, "rebuild.decision").length;
    const pass = await rt.deliverPendingInbound(w.tenant, "a");
    must(pass.posted === 1, `control: the pd push was posted: ${show(pass)}`);
    must(rebuilds(w) === 0 && rows(w, "rebuild.decision").length === before, "a pd agent was rebuilt, or decided as pi085");
    must(lines.some((l) => { const e = JSON.parse(l); return e.evt === "rebuild.skip" && e.reason === "not-applicable" && e.engine === "pd"; }),
      `no not-applicable line: ${lines.filter((l) => l.includes("rebuild")).join("\n")}`);
  } finally { setLogSink(null); }
  w.host.dispose();
});

console.log(`\n  rebuild after a long idle\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(passed === results.length ? 0 : 1);
