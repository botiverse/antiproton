/**
 * Compaction is off on PiAgent, and a request for it is refused rather than
 * half-done.
 *
 * pi-agent-core 0.85.1 forces `deferred: false` for the summary call
 * (dist/harness/runtime/drive/structural.js, `summaryContext`), the offloaded
 * provider (src/model/pi-offloaded.ts) answers every call deferred anyway, and
 * the summarizer (pi-agent-core 0.85.1 dist/harness/compaction/compaction.js)
 * takes the empty reply as the summary. The result was a compaction entry with
 * an empty summary — everything before the cut gone from the model's context —
 * plus a model job dispatched for an answer nothing would ever read.
 *
 * Each case counts both halves: compaction entries, and model jobs.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { readFileSync } from "node:fs";
import { compactionRefusal, refusingCompaction } from "../cf/src/compact-refusal.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 700) }); }
}

const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };

async function fixture() {
  const host = sqliteHost();
  const dispatched: string[] = [];
  const agent = await PiAgent.open({
    host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: [],
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch(id) { dispatched.push(id); },
  });
  const jobs = () => host.sql.exec("SELECT id, answer FROM pi_model_jobs").toArray() as any[];
  const pending = () => jobs().filter((j) => j.answer == null);
  const answer = (id: string, text: string, promptTokens = 10) => {
    if (!agent.takeJob(id)) throw new Error(`job ${id} was not available`);
    agent.deliver(id, fromResponse({
      text, finishReason: "stop", truncated: false,
      usage: { promptTokens, completionTokens: 10, reasoningTokens: 0, cachedPromptTokens: 0 },
    } as any, { api: "offloaded", provider: MODEL.provider, id: MODEL.id }, id));
  };
  const compactions = async () =>
    (await agent.storage.scanEntries({ order: "asc" }, CTX) as any[]).filter((e) => e.type === "compaction");
  /** One turn: say, step, answer, settle. */
  const turn = async (text: string, reply: string, promptTokens = 10) => {
    await agent.say(text);
    await agent.step();
    const p = pending();
    if (p.length !== 1) throw new Error(`expected one model job for the turn, saw ${p.length}`);
    answer(p[0]!.id, reply, promptTokens);
    for (let i = 0; i < 5 && (await agent.step()).open !== 0; i++) { /* settle */ }
  };
  return { host, agent, dispatched, jobs, pending, answer, compactions, turn };
}

const long = (n: number) => "word ".repeat(n);

await check("compact() refuses, and writes no compaction entry and no model job", async () => {
  const f = await fixture();
  // Enough history that a compaction has something to cut: well past keepRecentTokens (20000).
  for (let i = 0; i < 4; i++) await f.turn(`question ${i} ${long(8_000)}`, `answer ${i} ${long(8_000)}`);
  const jobsBefore = f.jobs().length;
  let refused: unknown = null;
  try { await f.agent.compact(); } catch (e) { refused = e; }
  for (let i = 0; i < 5 && (await f.agent.step()).open !== 0; i++) { /* settle */ }
  const entries = await f.compactions();
  const extra = f.jobs().length - jobsBefore;
  const facts = `compaction entries=${entries.length} (summaries ${JSON.stringify(entries.map((e) => e.summary))}), extra model jobs=${extra}`;
  if (!refused) throw new Error(`compact() resolved instead of refusing; ${facts}`);
  if (!/compaction is unavailable on this agent/.test(String((refused as Error).message))) {
    throw new Error(`compact() refused with the wrong reason: ${(refused as Error).message}`);
  }
  if ((refused as Error).name !== "CompactionUnavailable") throw new Error(`refusal is not a CompactionUnavailable: ${(refused as Error).name}`);
  if (entries.length !== 0) throw new Error(`a compaction entry was written; ${facts}`);
  if (extra !== 0) throw new Error(`a model job was made for the summary; ${facts}`);
  await f.agent.close();
});

await check("a run past the old automatic threshold writes no compaction entry and no extra model job", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await f.turn(`question ${i} ${long(8_000)}`, `answer ${i} ${long(8_000)}`);
  // The answer reports a context of 120k tokens on a 128k window: past
  // contextWindow - reserveTokens (128000 - 16384), where pi's default
  // settings compact before the next turn.
  await f.turn("big one", "ok", 120_000);
  const jobsBefore = f.jobs().length;
  await f.agent.say("next");
  await f.agent.step();
  const entries = await f.compactions();
  const extra = f.jobs().length - jobsBefore;
  const facts = `compaction entries=${entries.length} (summaries ${JSON.stringify(entries.map((e) => e.summary))}), model jobs since=${extra}`;
  if (entries.length !== 0) throw new Error(`a compaction entry was written; ${facts}`);
  // The one job allowed is the turn's own: exactly one, and it is the run's.
  if (extra !== 1) throw new Error(`expected exactly the turn's model job; ${facts}`);
  await f.agent.close();
});

await check("with compaction switched back on, the before_compaction hook still declines it", async () => {
  // The setting is one guard; the hook is the other, and the one every
  // compaction passes before its model call whatever the settings say.
  // pi's overflow recovery does not read `enabled` either, but it only fires
  // on a non-deferred answer (pi-agent-core 0.85.1 dist/harness/runtime/drive/response.js,
  // `publishResponse`), which this provider never gives — so it cannot be
  // driven from here; turning the setting back on is the case that can.
  const f = await fixture();
  await f.agent.harness.setCompactionSettings({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }, CTX);
  for (let i = 0; i < 3; i++) await f.turn(`question ${i} ${long(8_000)}`, `answer ${i} ${long(8_000)}`);
  await f.turn("big one", "ok", 120_000);
  const jobsBefore = f.jobs().length;
  await f.agent.say("next");
  await f.agent.step();
  const entries = await f.compactions();
  const extra = f.jobs().length - jobsBefore;
  if (entries.length !== 0) throw new Error(`a compaction entry was written: ${JSON.stringify(entries.map((e) => e.summary))}`);
  if (extra !== 1) throw new Error(`expected exactly the turn's model job, saw ${extra}`);
  await f.agent.close();
});

// ---- the routes: /ui/compact and /admin/compact (cf/src/index.ts) ---------

await check("the object's uiCompact turns the refusal into a value, and both routes answer 409 with the reason", async () => {
  const f = await fixture();
  // What AgentDO.uiCompact runs, over the engine's real compact().
  const r = await refusingCompaction(() => f.agent.compact());
  const admin = compactionRefusal(r, "json");
  if (!admin || admin.status !== 409) throw new Error(`/admin/compact answered ${admin?.status ?? "the success path"}`);
  const body = await admin.json() as any;
  if (!/compaction is unavailable on this agent/.test(String(body.error))) throw new Error(`/admin/compact error: ${JSON.stringify(body)}`);
  const ui = compactionRefusal(r, "text");
  if (!ui || ui.status !== 409) throw new Error(`/ui/compact answered ${ui?.status ?? "the success path"}`);
  // The console prints a non-2xx's text body under the form (cf/src/ui.ts,
  // htmx:afterRequest): it must be the reason, in plain text, not JSON or HTML.
  if (!(ui.headers.get("content-type") ?? "").startsWith("text/plain")) throw new Error(`/ui/compact content-type ${ui.headers.get("content-type")}`);
  if (!/compaction is unavailable on this agent/.test(await ui.text())) throw new Error("/ui/compact body is not the reason");
  // A compaction that went ahead is not mistaken for a refusal, and any other failure still throws.
  if (compactionRefusal({ ok: true }, "json") !== null || compactionRefusal(undefined, "text") !== null) throw new Error("a non-refusal was answered as one");
  let threw = false;
  try { await refusingCompaction(async () => { throw new Error("storage fault"); }); } catch { threw = true; }
  if (!threw) throw new Error("an unrelated failure was swallowed as a refusal");
  await f.agent.close();
});

await check("the routes and the object are wired to it", async () => {
  const index = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const arm = (path: string) => {
    const start = index.indexOf(`case "${path}": {`);
    if (start < 0) throw new Error(`route ${path} not found, so this checks nothing`);
    const next = index.indexOf("\n        case ", start + 1);
    return index.slice(start, next < 0 ? index.length : next);
  };
  if (!/return compactionRefusal\(r, "json"\) \?\? Response\.json\(r\)/.test(arm("/admin/compact"))) {
    throw new Error("/admin/compact no longer answers a refusal with compactionRefusal");
  }
  const ui = arm("/ui/compact");
  const refusal = ui.indexOf('compactionRefusal(await stub.uiCompact(');
  const success = ui.indexOf("stub.uiTranscript(");
  if (refusal < 0 || !/if \(refused\) return refused;/.test(ui) || refusal > success) {
    throw new Error("/ui/compact no longer answers a refusal before rendering the transcript as a success");
  }
  const obj = index.slice(index.indexOf("async uiCompact("), index.indexOf("async uiSay("));
  if (!/refusingCompaction\(/.test(obj)) throw new Error("AgentDO.uiCompact no longer turns the refusal into a value; it would cross RPC as a 500");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
