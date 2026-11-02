/**
 * The memory subagent in shadow through the real runtime (`memoryWriter: "shadow"`, src/runtime/memory-shadow.ts,
 * cf/src/runtime.ts `#memoryAfterRun`, `#memorySessionEnded`), with the model answered by hand as in test/after-turn.ts:
 * a direct write to `memory` writes a due row and queues a run; once the agent's run has ended the run's short session is
 * posted with no tools; its answer is judged and recorded privately, never applied, with a counts-only heartbeat; and the
 * observer classifies the turn. Under `self` none of it happens and the agent's requests are what they were.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { modelToolName } from "../src/runtime/pi-tools.ts";
import { MEMORY_OBSERVE_PROMPT } from "../src/runtime/memory-shadow.ts";
import { clearMemoryShadow } from "../src/store/memory-shadow.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const REMEMBER = modelToolName("mem", "remember");
const REVISE = modelToolName("mem", "revise");
const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };

async function world(config: Record<string, unknown> | null = { memoryWriter: "shadow" }, memory = "- [owner] reply in English\n- works on Raft") {
  const host = sqliteHost();
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null }, autoRelease: false,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "m1" } as never),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada" } as never);
  await rt.bindOperatorModel("t", "a");
  await rt.store.setPluginChoice("t", "a", "state", "enable");
  const added = await rt.addMount("t", "a", { alias: "mem", plugin: "state", config: config ?? {} });
  must(added.ok, `mount: ${show(added)}`);
  if (memory) await rt.store.putState("t", "a", "memory", { value: memory, ref: null, bytes: JSON.stringify(memory).length });
  return { host, rt, sent, answered: new Set<string>(), jobs: new Map<string, any>() };
}
type World = Awaited<ReturnType<typeof world>>;

async function pump(w: World) {
  let out = await w.rt.step("t", "a");
  for (let i = 0; i < 8 && out.wakeInMs === 0; i++) out = await w.rt.step("t", "a");
  return out;
}
type Kind = "main" | "shadow" | "observe";
const kindOf = (job: any): Kind => String(job.context.systemPrompt ?? "").startsWith("You keep one document") ? "shadow"
  : job.context.systemPrompt === MEMORY_OBSERVE_PROMPT ? "observe" : "main";
/** The model calls out and not yet answered, taken, with their kind. */
async function out(w: World): Promise<Array<{ id: string; job: any; kind: Kind }>> {
  await pump(w);
  const list = [];
  for (const id of w.sent) {
    if (w.answered.has(id)) continue;
    const job = w.jobs.get(id) ?? await w.rt.takeJob("t", "a", id);
    w.jobs.set(id, job);
    list.push({ id, job, kind: kindOf(job) });
  }
  return list;
}
async function answer(w: World, call: { id: string; job: any }, res: Partial<ModelResponse> | { error: string }) {
  w.answered.add(call.id);
  const model = { api: call.job.model.api, provider: call.job.model.provider, id: call.job.model.id };
  const msg = "error" in res
    ? { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: res.error, timestamp: Date.now() }
    : fromResponse({ text: "", finishReason: res.toolCalls ? "tool_calls" : "stop", truncated: false, usage, ...res } as ModelResponse, model, call.id);
  await w.rt.deliverAnswer("t", "a", call.id, msg, undefined);
  await pump(w);
}
async function one(w: World, kind: Kind) {
  const calls = (await out(w)).filter((c) => c.kind === kind);
  must(calls.length >= 1, `no ${kind} call is out (out: ${show((await out(w)).map((c) => c.kind))})`);
  return calls[0]!;
}
const lastUser = (job: any) => {
  const users = (job.context.messages as any[]).filter((m) => m.role === "user");
  const c = users[users.length - 1]?.content;
  return typeof c === "string" ? c : (c as any[]).filter((p) => p.type === "text").map((p) => p.text).join("");
};
const rows = (w: World, kind: string) => (w.host.sql.exec("SELECT status, verdict, ms, attrs FROM trace_outbox WHERE kind = ? ORDER BY seq", kind).toArray() as any[])
  .map((r) => ({ status: r.status, verdict: r.verdict, ms: r.ms, attrs: JSON.parse(r.attrs) }));
const memoryNow = async (w: World) => (await w.rt.store.getState("t", "a", "memory"))?.value;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args as never });

/** A chat turn in which the agent remembers `text` with its own tool, then ends with "noted". */
async function chatThatRemembers(w: World, text: string, said = "please remember that I prefer short replies") {
  await w.rt.postMessage("t", "a", said, "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REMEMBER, { key: "memory", text })] });
  await answer(w, await one(w, "main"), { text: "noted" });
}

await check("shadow: a direct write writes a due row, then the subagent's run is recorded privately with a counts-only heartbeat, and memory keeps the agent's own write", async () => {
  const w = await world();
  await chatThatRemembers(w, "- prefers short replies");
  const afterMain = await memoryNow(w);
  must(afterMain === "- [owner] reply in English\n- works on Raft\n- prefers short replies", `the agent's own write: ${show(afterMain)}`);
  const due = rows(w, "memory.shadow_due");
  must(due.length === 1 && due[0]!.attrs.op === "remember" && due[0]!.attrs.trigger === "chat" && due[0]!.attrs.main === "ok", show(due));
  const shadow = await one(w, "shadow");
  must((shadow.job.context.tools ?? []).length === 0, `the shadow session was offered tools: ${show(shadow.job.context.tools)}`);
  const input = lastUser(shadow.job);
  must(input.includes("1| - [owner] reply in English") && !input.includes("prefers short replies\n</memory>"), `shown the document before the write: ${input.slice(0, 300)}`);
  must(input.includes("Remember this:\n- prefers short replies") && input.includes("please remember that I prefer short replies"), `request and conversation: ${input}`);
  await answer(w, shadow, { text: JSON.stringify({ ops: [{ op: "insert", key: "memory", after_line: 1, text: "- [owner] keep replies short" }] }) });
  must(await memoryNow(w) === afterMain, `the shadow run changed memory: ${show(await memoryNow(w))}`);
  const beats = rows(w, "memory.shadow");
  must(beats.length === 1 && beats[0]!.status === "changed" && beats[0]!.attrs.job === due[0]!.attrs.job, show(beats));
  const b = beats[0]!.attrs;
  must(b.insert === 1 && b.accepted === 1 && b.refused === 0 && b.taggedDeletions === 0 && b.taggedAdded === 1 && b.linesAdded === 1, show(b));
  must(b.mainLinesAdded === 1 && b.sameAsMain === false && typeof beats[0]!.ms === "number" && beats[0]!.ms >= 0, show(beats[0]));
  const text = show(w.host.sql.exec("SELECT attrs FROM trace_outbox WHERE kind LIKE 'memory.%'").toArray());
  for (const secret of ["short replies", "keep replies short", "English", "Raft"]) must(!text.includes(secret), `a trace row carries "${secret}": ${text}`);
  const run = w.rt.store.memoryShadow.get("t", "a", due[0]!.attrs.job)!;
  must(run.state === "done" && run.outcome === "changed" && run.memoryAfter === "- [owner] reply in English\n- [owner] keep replies short\n- works on Raft", show(run));
  must(run.memoryMain === afterMain && run.memoryBefore === "- [owner] reply in English\n- works on Raft" && (run.ops as any[]).length === 1, show(run));
});

await check("shadow: the observer classifies the finished turn: intent and whether the agent changed its memory, counts only", async () => {
  const w = await world();
  await chatThatRemembers(w, "- prefers short replies");
  const obs = await one(w, "observe");
  must((obs.job.context.tools ?? []).length === 0, "the observer was offered tools");
  await answer(w, obs, { text: '{"intent": true}' });
  const o = rows(w, "memory.observe");
  must(o.length === 1 && o[0]!.attrs.intent === true && o[0]!.attrs.called === true && o[0]!.attrs.sampled === true && o[0]!.attrs.trigger === "chat", show(o));
});

await check("shadow: an intent with no memory change is counted as intent true, called false", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "from now on never schedule me before 10am", "prompt", "main");
  await answer(w, await one(w, "main"), { text: "ok" });
  must(rows(w, "memory.shadow_due").length === 0, "a due row without a write");
  const obs = await one(w, "observe");
  must(lastUser(obs.job).includes("never schedule me before 10am"), "the observer was not shown the turn");
  await answer(w, obs, { text: '{"intent": true}' });
  const o = rows(w, "memory.observe");
  must(o.length === 1 && o[0]!.attrs.intent === true && o[0]!.attrs.called === false, show(o));
});

await check("shadow: two writes in one turn: each run is shown the conversation since the one before, and the mark moves on", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "remember ALPHA please", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REMEMBER, { key: "memory", text: "- alpha" })] });
  await answer(w, await one(w, "main"), { text: "now BRAVO", toolCalls: [call("c2", REMEMBER, { key: "memory", text: "- bravo" })] });
  await answer(w, await one(w, "main"), { text: "done" });
  const shadows = (await out(w)).filter((c) => c.kind === "shadow").map((c) => lastUser(c.job));
  must(shadows.length === 2, `runs: ${shadows.length}`);
  const first = shadows.find((s) => s.includes("Remember this:\n- alpha"))!, second = shadows.find((s) => s.includes("Remember this:\n- bravo"))!;
  must(first && second, show(shadows));
  const conv = (s: string) => s.slice(s.indexOf("<conversation>"));
  must(conv(first).includes("remember ALPHA please") && !conv(first).includes("BRAVO"), `the first run: ${conv(first)}`);
  must(conv(second).includes("now BRAVO") && !conv(second).includes("remember ALPHA please") && !conv(second).includes('"- alpha"'), `the second run: ${conv(second)}`);
  must(rows(w, "memory.shadow_due").length === 2, "two due rows");
});

await check("shadow: a run whose answer fails or cannot be read is a failed heartbeat with a code; the agent's turn already ended normally", async () => {
  const w = await world();
  await chatThatRemembers(w, "- one");
  await answer(w, await one(w, "shadow"), { error: "provider exploded" });
  await w.rt.postMessage("t", "a", "remember two", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REMEMBER, { key: "memory", text: "- two" })] });
  await answer(w, await one(w, "main"), { text: "noted again" });
  await answer(w, await one(w, "shadow"), { text: "I would add a line." });
  const beats = rows(w, "memory.shadow");
  must(show(beats.map((b) => [b.status, b.attrs.error])) === show([["failed", "turn_failed"], ["failed", "unparseable"]]), show(beats));
  const text = show(beats);
  must(!text.includes("provider exploded") && !text.includes("I would add"), "a failure row carries text");
  must(await memoryNow(w) === "- [owner] reply in English\n- works on Raft\n- one\n- two", `the agent's writes: ${show(await memoryNow(w))}`);
  const main = (await out(w)).filter((c) => c.kind === "main");
  must(main.length === 0, "the main conversation was left waiting");
});

await check("shadow: a due row whose run has not started is countable: due rows outnumber heartbeats until the agent's run ends", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "remember gamma", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REMEMBER, { key: "memory", text: "- gamma" })] });
  // The agent's run is still going (its next model call is out): the write's run is owed and not started.
  must((await out(w)).every((c) => c.kind === "main"), "a memory subagent session was posted mid-run");
  must(rows(w, "memory.shadow_due").length === 1 && rows(w, "memory.shadow").length === 0, `due ${rows(w, "memory.shadow_due").length}, heartbeats ${rows(w, "memory.shadow").length}`);
  await answer(w, await one(w, "main"), { text: "noted" });
  await answer(w, await one(w, "shadow"), { text: '{"ops": []}' });
  must(rows(w, "memory.shadow").length === 1, "the run did not end with a heartbeat");
});

await check("switched back to self before the run ended: the queued run is finished as skipped (writer_self) with its heartbeat and redacted", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "remember gamma", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REVISE, { key: "memory", old: "- works on Raft", new: "- works on Antiproton" })] });
  w.host.sql.exec("UPDATE mounts SET public_config = ? WHERE alias = 'mem'", JSON.stringify({ memoryWriter: "self" }));
  await answer(w, await one(w, "main"), { text: "noted" });
  must((await out(w)).length === 0, "a memory subagent session was posted under self");
  const beats = rows(w, "memory.shadow");
  must(beats.length === 1 && beats[0]!.status === "skipped" && beats[0]!.attrs.error === "writer_self", show(beats));
  const run = w.rt.store.memoryShadow.list("t", "a")[0]!;
  must(run.state === "done" && !JSON.stringify(run).includes("works on Raft"), JSON.stringify(run));
});

await check("four writes in one run, the last a revise of the first: no row deleted, every due row gets a heartbeat, the old wording redacted everywhere", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "keep these", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [
    call("c1", REMEMBER, { key: "memory", text: "- secret plan ALPHA" }), call("c2", REMEMBER, { key: "memory", text: "- likes green tea" }),
    call("c3", REMEMBER, { key: "memory", text: "- office on floor 7" }), call("c4", REVISE, { key: "memory", old: "- secret plan ALPHA", new: "- plan B" }),
  ] });
  await answer(w, await one(w, "main"), { text: "done" });
  for (const c of (await out(w)).filter((x) => x.kind === "shadow")) await answer(w, c, { text: '{"ops": []}' });
  must(rows(w, "memory.shadow_due").length === 4 && rows(w, "memory.shadow").length === 4, `due ${rows(w, "memory.shadow_due").length}, heartbeats ${rows(w, "memory.shadow").length}`);
  const stored = w.host.sql.exec("SELECT memory_before, memory_main, memory_after, request, main_op, ops FROM memory_shadow").toArray();
  must(stored.length === 4, `rows ${stored.length}`);
  must(!JSON.stringify(stored).includes("secret plan ALPHA"), JSON.stringify(stored));
  for (const r of stored as any[]) for (const k of ["main_op", "ops"]) if (r[k] !== null) JSON.parse(r[k]);
});

await check("the operator's clear: every row goes, a queued run gets a cleared heartbeat, one in flight ends job_missing; a second clear deletes 0", async () => {
  const w = await world();
  await chatThatRemembers(w, "- one");
  const posted = await one(w, "shadow");
  w.rt.store.memoryShadow.queue("t", "a", { id: "ms_q", trigger: "chat", session: "main", request: "r", mainOp: { tool: "remember", args: {}, result: "ok" }, memoryBefore: "", memoryMain: "x" });
  const first = clearMemoryShadow(w.host.sql as never, "t", "a");
  must(first.deleted === 2 && first.stillRecording === true, JSON.stringify(first));
  await answer(w, posted, { text: '{"ops": []}' });
  const beats = rows(w, "memory.shadow").map((b) => [b.status, b.attrs.error]);
  must(JSON.stringify(beats.sort()) === JSON.stringify([["failed", "job_missing"], ["skipped", "cleared"]]), JSON.stringify(beats));
  must(rows(w, "memory.shadow_due").length === 1 && w.rt.store.memoryShadow.list("t", "a").length === 0, "rows left");
  must(clearMemoryShadow(w.host.sql as never, "t", "a").deleted === 0, "the second clear deleted something");
  const cleared = rows(w, "memory.shadow_clear");
  must(cleared.length === 2 && cleared[0]!.attrs.deleted === 2 && cleared[1]!.attrs.deleted === 0, JSON.stringify(cleared));
  w.host.sql.exec("UPDATE mounts SET public_config = ? WHERE alias = 'mem'", JSON.stringify({ memoryWriter: "self" }));
  must(clearMemoryShadow(w.host.sql as never, "t", "a").stillRecording === false, "stillRecording under self");
});

await check("self: no due row, no run, no observer, no row in memory_shadow; the agent's requests are the same as with the setting unset", async () => {
  const self = await world({ memoryWriter: "self" });
  const unset = await world(null);
  const requests: Record<string, any[]> = { self: [], unset: [] };
  for (const [name, w] of [["self", self], ["unset", unset]] as const) {
    await w.rt.postMessage("t", "a", "please remember that I prefer short replies", "prompt", "main");
    const first = await one(w, "main");
    requests[name]!.push(first.job.context);
    await answer(w, first, { toolCalls: [call("c1", REMEMBER, { key: "memory", text: "- prefers short replies" })] });
    const second = await one(w, "main");
    requests[name]!.push(second.job.context);
    await answer(w, second, { text: "noted" });
    must((await out(w)).length === 0, `${name}: another model call is out`);
    for (const k of ["memory.shadow_due", "memory.shadow", "memory.observe"]) must(rows(w, k).length === 0, `${name}: a ${k} row`);
    must(w.rt.store.memoryShadow.list("t", "a").length === 0, `${name}: a memory_shadow row`);
    must(await memoryNow(w) === "- [owner] reply in English\n- works on Raft\n- prefers short replies", `${name}: memory`);
  }
  const strip = (cs: any[]) => show(cs.map((c) => ({ systemPrompt: c.systemPrompt, tools: c.tools, messages: (c.messages as any[]).map((m) => ({ role: m.role, content: m.content })) })));
  must(strip(requests.self!) === strip(requests.unset!), "self's requests differ from unset's");
});

await check("shadow: a refused direct write is shadowed too, with the agent's refusal code on its due row", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "change it", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: [call("c1", REVISE, { key: "memory", old: "not there", new: "x" })] });
  await answer(w, await one(w, "main"), { text: "could not" });
  const due = rows(w, "memory.shadow_due");
  must(due.length === 1 && due[0]!.attrs.main === "refused" && due[0]!.attrs.op === "revise", show(due));
  await answer(w, await one(w, "shadow"), { text: '{"ops": []}' });
  const beats = rows(w, "memory.shadow");
  must(beats.length === 1 && beats[0]!.status === "no_change" && beats[0]!.attrs.mainResult === "refused" && beats[0]!.attrs.ops === 0, show(beats));
});

await check("ten writes in one run: three runs are started, the other seven finished as skipped (per_run_cap), so due rows and heartbeats balance", async () => {
  const w = await world();
  await w.rt.postMessage("t", "a", "remember these ten", "prompt", "main");
  await answer(w, await one(w, "main"), { toolCalls: Array.from({ length: 10 }, (_, i) => call(`c${i}`, REMEMBER, { key: "memory", text: `- fact ${i}` })) });
  await answer(w, await one(w, "main"), { text: "all noted" });
  const shadows = (await out(w)).filter((c) => c.kind === "shadow");
  must(shadows.length === 3, `started ${shadows.length}`);
  const skipped = rows(w, "memory.shadow");
  must(skipped.length === 7 && skipped.every((r) => r.status === "skipped" && r.verdict === "cancelled" && r.attrs.error === "per_run_cap"), show(skipped));
  for (const c of shadows) await answer(w, c, { text: '{"ops": []}' });
  must(rows(w, "memory.shadow_due").length === 10 && rows(w, "memory.shadow").length === 10, `due ${rows(w, "memory.shadow_due").length}, heartbeats ${rows(w, "memory.shadow").length}`);
  must(await memoryNow(w) === "- [owner] reply in English\n- works on Raft\n" + Array.from({ length: 10 }, (_, i) => `- fact ${i}`).join("\n"), "the agent's writes");
});

await check("a shadow run past 7 days is pruned by the next pass, with no new run queued", async () => {
  const w = await world();
  w.rt.store.memoryShadow.queue("t", "a", { id: "ms_old", trigger: "chat", session: "main", request: "r", mainOp: { tool: "remember", args: {}, result: "ok" }, memoryBefore: "", memoryMain: "x" });
  w.rt.store.memoryShadow.queue("t", "a", { id: "ms_new", trigger: "chat", session: "main", request: "r", mainOp: { tool: "remember", args: {}, result: "ok" }, memoryBefore: "", memoryMain: "x" });
  w.host.sql.exec("UPDATE memory_shadow SET due_at = ? WHERE id = 'ms_old'", Date.now() - 8 * 24 * 3_600_000);
  await w.rt.step("t", "a");
  must(show(w.rt.store.memoryShadow.list("t", "a").map((r) => r.id)) === show(["ms_new"]), show(w.rt.store.memoryShadow.list("t", "a").map((r) => r.id)));
});

await check("an agent's delete deletes its shadow runs and marks", async () => {
  const w = await world();
  await chatThatRemembers(w, "- delta");
  must(w.rt.store.memoryShadow.list("t", "a").length === 1, "no run before the delete");
  await w.rt.stopTurn("t", "a", "delete");
  must(w.rt.store.memoryShadow.list("t", "a").length === 0, "the runs outlived the delete");
  must(w.host.sql.exec("SELECT COUNT(*) AS n FROM memory_shadow_marks").toArray()[0]!.n === 0, "the marks outlived the delete");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
