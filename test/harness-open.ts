/**
 * Each harness `AgentRuntime.agent` builds leaves one `harness.open` trace row saying why (src/runtime/harness-open.ts),
 * and a reused one leaves none. Driven over the real runtime on node:sqlite with the model scripted through the queue,
 * as test/stable-prompt.ts does; an eviction is a second runtime over the same storage, a deploy is one with another
 * version id.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { harnessKeyChange } from "../src/runtime/harness-open.ts";
import { harnessKey, catalogueKey } from "../cf/src/runtime.ts";
import { setLogSink } from "../src/core/log.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

type World = { host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string> };

function runtimeOver(w: Omit<World, "rt">, versionId: string | null = "v1"): AgentRuntime {
  const standIn = standInLoader();
  return new AgentRuntime({
    ctx: { storage: { sql: w.host.sql, transactionSync: w.host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { w.sent.push(job.commandId); },
    ...(versionId ? { versionId } : {}),
  } as never);
}

async function world(): Promise<World> {
  const base = { host: sqliteHost(), sent: [] as string[], answered: new Set<string>() };
  const w = { ...base, rt: runtimeOver(base) } as World;
  await w.rt.ready();
  await w.rt.store.createAgent("t", "a", { name: "Ada", description: "FIRST-PERSONA" } as never);
  await w.rt.bindOperatorModel("t", "a");
  return w;
}

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

async function turn(w: World, text: string) {
  await w.rt.postMessage("t", "a", text, "prompt", "main");
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !w.answered.has(id));
    for (const id of pending) {
      w.answered.add(id);
      const job = await w.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string } } | null;
      if (!job) continue;
      await w.rt.deliverAnswer("t", "a", id, fromResponse(say("noted"), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error("the turn did not settle");
}

type Open = { status: string; verdict: string; ms: number | null; attrs: Record<string, any> };
const opens = (w: World): Open[] => w.host.sql.exec("SELECT status, verdict, ms, attrs FROM trace_outbox WHERE kind = 'harness.open' ORDER BY seq")
  .toArray().map((r: any) => ({ status: String(r.status), verdict: String(r.verdict), ms: r.ms === null ? null : Number(r.ms), attrs: JSON.parse(String(r.attrs)) }));
const prefixes = (w: World) => w.host.sql.exec("SELECT attrs FROM trace_outbox WHERE kind = 'model.call' ORDER BY seq").toArray()
  .map((r: any) => JSON.parse(String(r.attrs)).prefix as Record<string, any>);

await check("first message: one cold-start row, named first, with the engine, the conversation and the hashes its first call was sent", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    const rows = opens(w);
    must(rows.length === 1, `one open: ${show(rows)}`);
    const [r] = rows;
    must(r!.status === "cold-start" && r!.verdict === "ok" && r!.attrs.reason === "cold-start" && r!.attrs.cause === "first", show(r));
    must(r!.attrs.engine === "pi085" && r!.attrs.session === "main" && r!.attrs.conversation === "main" && r!.attrs.prevAgeMs === null, show(r));
    must(r!.attrs.version === "v1" && typeof r!.ms === "number", show(r));
    const p = prefixes(w)[0]!;
    must(/^[0-9a-f]{64}$/.test(r!.attrs.systemSha256) && r!.attrs.systemSha256 === p.systemSha256,
      `the system prompt hash is the one the first call was sent: ${r!.attrs.systemSha256} vs ${p.systemSha256}`);
    must(/^[0-9a-f]{64}$/.test(r!.attrs.toolsSha256) && r!.attrs.tools > 0 && r!.attrs.toolsSha256 === p.toolsSha256,
      `the tool list hash is the one the first call was sent: ${r!.attrs.toolsSha256} vs ${p.toolsSha256}`);
    must(!JSON.stringify(r).includes("FIRST-PERSONA"), "the row carries prompt content");
  } finally { w.host.dispose(); }
});

await check("a second message with nothing changed reuses the harness and writes no row", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    const before = await w.rt.agent("t", "a");
    await turn(w, "again");
    must(await w.rt.agent("t", "a") === before, "control: the harness was reused");
    must(opens(w).length === 1, `a reuse wrote a row: ${show(opens(w))}`);
  } finally { w.host.dispose(); }
});

await check("a persona change: key-change naming persona and nothing else, with the previous harness's age", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    must(await w.rt.store.updateAgentConfig("t", "a", { name: "Ada", description: "SECOND-PERSONA" }), "control: the persona was written");
    await sleep(5);
    await turn(w, "again");
    const rows = opens(w);
    must(rows.length === 2, `two opens: ${show(rows)}`);
    const r = rows[1]!;
    must(r.status === "key-change" && show(r.attrs.changed) === show(["persona"]), show(r));
    must(r.attrs.cause === undefined && typeof r.attrs.prevAgeMs === "number" && r.attrs.prevAgeMs >= 5, show(r));
    must(r.attrs.systemSha256 !== rows[0]!.attrs.systemSha256, "the new persona's prompt hashed the same");
  } finally { w.host.dispose(); }
});

await check("an eviction: the next runtime's open is a cold start caused by eviction; a new version id makes it a deploy", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    w.rt = runtimeOver(w, "v1");
    await turn(w, "after eviction");
    w.rt = runtimeOver(w, "v2");
    await turn(w, "after deploy");
    w.rt = runtimeOver(w, null);
    await turn(w, "no binding");
    const rows = opens(w);
    must(show(rows.map((r) => [r.status, r.attrs.cause])) === show([["cold-start", "first"], ["cold-start", "evicted"], ["cold-start", "deploy"], ["cold-start", "unknown"]]), show(rows.map((r) => r.attrs)));
    must(rows.slice(1).every((r) => typeof r.attrs.prevAgeMs === "number" && show(r.attrs.changed) === "[]"), show(rows));
  } finally { w.host.dispose(); }
});

await check("dropHarnesses: the next open is `dropped` with the caller's reason, also when the runtime is rebuilt after it (a restart)", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    await w.rt.dropHarnesses("t", "a", "restart");
    await turn(w, "after the drop");
    await w.rt.dropHarnesses("t", "a", "restart");
    w.rt = runtimeOver(w);
    await turn(w, "after a restart");
    await turn(w, "and then reused");
    const rows = opens(w);
    must(show(rows.map((r) => [r.status, r.attrs.detail ?? null])) === show([["cold-start", null], ["dropped", "restart"], ["dropped", "restart"]]), show(rows.map((r) => r.attrs)));
  } finally { w.host.dispose(); }
});

await check("a fresh context: the next open is `fresh-context`, on the new conversation", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    const fresh = await w.rt.freshContext("t", "a");
    must(fresh.ok, `fresh context: ${show(fresh)}`);
    await turn(w, "new start");
    const rows = opens(w);
    must(rows.length === 2, show(rows));
    const r = rows[1]!;
    must(r.status === "fresh-context" && r.attrs.session === "main" && r.attrs.conversation === (fresh as any).newSessionId
      && r.attrs.conversation !== rows[0]!.attrs.conversation, show(r));
  } finally { w.host.dispose(); }
});

await check("the log line: each open is one `harness.open` line with the reason and the hashes", async () => {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  const w = await world();
  try {
    await turn(w, "hello");
    await turn(w, "again");
    const ours = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "harness.open");
    must(ours.length === 1 && ours[0].reason === "cold-start" && ours[0].agentId === "a" && ours[0].systemSha256 === opens(w)[0]!.attrs.systemSha256, show(ours));
  } finally { setLogSink(null); w.host.dispose(); }
});

await check("harnessKeyChange: names persona, model, mounts, tools and plugins, each alone", () => {
  const b = { provider: "openai-compatible", model: "m1", baseUrl: "https://x", secretRef: "operator:model" };
  const mount = { alias: "s", plugin: "state", toolVersion: "1", publicConfig: {}, secretRef: null, policy: null, toolSnapshot: { hash: "h1" } } as never;
  const cat = catalogueKey([mount], { state: "enable" });
  const k = harnessKey(cat, { name: "n", description: "d" }, b);
  must(show(harnessKeyChange(k, k)) === "[]", "same");
  must(show(harnessKeyChange(k, harnessKey(cat, { name: "n", description: "d2" }, b))) === show(["persona"]), "persona");
  must(show(harnessKeyChange(k, harnessKey(cat, { name: "n", description: "d" }, { ...b, model: "m2" }))) === show(["model"]), "model");
  const other = (m: Record<string, unknown>, c: Record<string, string> = { state: "enable" }) =>
    harnessKey(catalogueKey([{ ...(mount as object), ...m } as never], c as never), { name: "n", description: "d" }, b);
  must(show(harnessKeyChange(k, other({ toolVersion: "2" }))) === show(["mounts"]), "mounts");
  must(show(harnessKeyChange(k, other({ toolSnapshot: { hash: "h2" } }))) === show(["tools"]), "tools");
  must(show(harnessKeyChange(k, other({}, { state: "disable" }))) === show(["plugins"]), "plugins");
  must(show(harnessKeyChange("not json", k)) === "[]", "unparsable names nothing");
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
