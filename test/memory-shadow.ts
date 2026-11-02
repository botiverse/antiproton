/**
 * The memory subagent in shadow, piece by piece (src/runtime/memory-shadow.ts, src/store/memory-shadow.ts, the
 * `memoryWriter` setting in src/plugins/state.ts): the setting and how several mounts combine, the state plugin's due
 * row and queued run, how a proposal is judged against the document (the owner's tagged lines, a full document, the
 * cap), the conversation each run is shown, and the private table's retention and delete. Through the runtime:
 * test/memory-shadow-runtime.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.ts";
import { adminMemoryShadow, type MemoryShadowSource } from "../cf/src/admin-memory-shadow.ts";
import { d1ReadAudit, type ReadAudit, type ReadAuditRow } from "../cf/src/read-audit.ts";
import { configOf, memoryWriterOf, memoryWriterProblem, sharedSettings, statePlugin, MEMORY_MAX } from "../src/plugins/state.ts";
import { validateMount } from "../src/runtime/mount-config.ts";
import type { PluginContext } from "../src/plugins/types.ts";
import {
  calledMemory, contextSlices, FIRST_CONTEXT_MESSAGES, isOwnerLine, lineDiff, memoryCallMatcher, memoryShadowPrompt, OWNER_TAG, parseObservation,
  parseProposal, renderConversation, REQUEST_MAX, requestOf, revisedInPlace, simulate, type BranchEntry,
} from "../src/runtime/memory-shadow.ts";
import { FORGOTTEN, MEMORY_SHADOW_RETENTION_MS, MemoryShadowTables, redactable } from "../src/store/memory-shadow.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { modelToolName } from "../src/runtime/pi-tools.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// ---- the setting --------------------------------------------------------------------------------------------------

await check("memoryWriter: self by default; shadow read as set; subagent or anything else read as self", () => {
  must(configOf({}).memoryWriter === "self", "default");
  must(configOf({ memoryWriter: "shadow" }).memoryWriter === "shadow", "shadow");
  for (const v of ["subagent", "SHADOW", 1, null, true]) must(configOf({ memoryWriter: v }).memoryWriter === "self", `${show(v)} was not read as self`);
});

await check("memoryWriter across mounts: shadow on any mount holds; self only when every mount says it; the limits still take the smallest", () => {
  const self = configOf({}), shadow = configOf({ memoryWriter: "shadow", memoryMaxCharacters: 9000 });
  must(sharedSettings([self, shadow]).memoryWriter === "shadow" && sharedSettings([shadow, self]).memoryWriter === "shadow", "order mattered or self won");
  must(sharedSettings([self, self]).memoryWriter === "self" && sharedSettings([]).memoryWriter === "self", "self");
  must(memoryWriterOf([{ memoryWriter: "shadow" }]) === "shadow", "one mount");
  must(sharedSettings([self, shadow]).memoryMaxCharacters === MEMORY_MAX, "the limits stopped taking the smallest");
});

await check("memoryWriter on a mount: self and shadow accepted; subagent refused as not available yet, saying shadow works; a typo refused", () => {
  const plugin = statePlugin(null as never, null, "local");
  for (const ok of [{}, { memoryWriter: "self" }, { memoryWriter: "shadow" }]) must(validateMount(plugin, ok as never, null).length === 0, `${show(ok)} refused`);
  const sub = validateMount(plugin, { memoryWriter: "subagent" }, null);
  must(sub.length === 1 && /not available yet/.test(sub[0]!.message) && /"shadow"/.test(sub[0]!.message), show(sub));
  must(memoryWriterProblem({ memoryWriter: "shadowy" })?.includes('"self" or "shadow"'), "a typo was accepted");
  must(validateMount(plugin, { memoryWriter: 3 } as never, null).length === 1, "a number was accepted");
});

// ---- the state plugin's half: the due row, then the queued run ---------------------------------------------------

async function plugin(config: Record<string, unknown>, opts: { taskId?: string; shadowsMemory?: () => boolean } = {}) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  // The shadow table on a host of the test's own, so a case can damage a cell past the store's API, as damage would.
  const host = sqliteHost();
  (store as any).memoryShadow = new MemoryShadowTables(host).ensure();
  const p = statePlugin(store, null, "local", undefined, opts.shadowsMemory ? { shadowsMemory: opts.shadowsMemory } : {});
  const traces: any[] = [];
  const ctx = { publicConfig: config, credential: null, caller: { tenantId: "t", agentId: "a", taskId: opts.taskId ?? "main" }, alias: "mem",
    trace: (r: unknown) => { traces.push(r); } } as unknown as PluginContext;
  return { store, p, ctx, traces, host };
}

await check("shadow: a direct write to memory writes the due row, then queues the run with the document before and after the write", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "memory", text: "- one" }, ctx);
  await p.invoke("remember", { key: "memory", text: "- two" }, ctx);
  must(traces.length === 2 && traces.every((t) => t.kind === "memory.shadow_due" && t.attrs.op === "remember" && t.attrs.trigger === "chat"), show(traces));
  must(!show(traces).includes("one") && !show(traces).includes("two"), "the due row carries text");
  const runs = store.memoryShadow.queued("t", "a", "main");
  must(runs.length === 2 && runs[0]!.memoryBefore === "" && runs[0]!.memoryMain === "- one" && runs[1]!.memoryBefore === "- one" && runs[1]!.memoryMain === "- one\n- two", show(runs));
  must(runs[0]!.id === traces[0]!.attrs.job && runs[1]!.request === "Remember this:\n- two", show(runs.map((r) => r.request)));
});

await check("shadow: a write to another key, a read, or a write from a subagent's session queues nothing", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "journal", text: "- x" }, ctx);
  await p.invoke("put", { key: "notes/a", value: "x" }, ctx);
  await p.invoke("get", { key: "memory" }, ctx);
  const sub = await plugin({ memoryWriter: "shadow" }, { taskId: "sub_abc" });
  await sub.p.invoke("remember", { key: "memory", text: "- y" }, sub.ctx);
  must(traces.length === 0 && store.memoryShadow.list("t", "a").length === 0 && sub.traces.length === 0, show({ traces, sub: sub.traces }));
});

await check("self: a direct write to memory writes no due row and queues nothing, and answers as before", async () => {
  const self = await plugin({});
  const shadow = await plugin({ memoryWriter: "shadow" });
  const a = await self.p.invoke("remember", { key: "memory", text: "- one" }, self.ctx);
  const b = await shadow.p.invoke("remember", { key: "memory", text: "- one" }, shadow.ctx);
  must(self.traces.length === 0 && self.store.memoryShadow.list("t", "a").length === 0, show(self.traces));
  must(show(a) === show(b), `the answers differ: ${show(a)} vs ${show(b)}`);
});

await check("shadow: a run that cannot be queued never fails the agent's write", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  (store.memoryShadow as any).queue = () => { throw new Error("the table is gone"); };
  const realError = console.error; console.error = () => {};
  try {
    const r = await p.invoke("remember", { key: "memory", text: "- kept" }, ctx) as any;
    must(r.key === "memory", show(r));
  } finally { console.error = realError; }
  must((await store.getState("t", "a", "memory"))?.value === "- kept", "the write did not land");
});

await check("shadow: a failed read of memory around the write never fails the write; the run is queued as readFailed and the due row says so", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" });
  const real = store.getState.bind(store);
  (store as any).getState = async (t: string, a: string, k: string) => { if (k === "memory") throw new Error("read failed"); return real(t, a, k); };
  const r = await p.invoke("remember", { key: "memory", text: "- kept" }, ctx) as any;
  must(r.key === "memory", show(r));
  (store as any).getState = real;
  must((await store.getState("t", "a", "memory"))?.value === "- kept", "the write did not land");
  const runs = store.memoryShadow.queued("t", "a", "main");
  must(runs.length === 1 && runs[0]!.mainOp.readFailed === true && traces[0]?.attrs.read === "failed", show({ runs, traces }));
});

await check("shadow on an engine that runs no shadow sessions (pd): no due row, nothing queued, the write as usual", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" }, { shadowsMemory: () => false });
  await p.invoke("remember", { key: "memory", text: "- one" }, ctx);
  must(traces.length === 0 && store.memoryShadow.list("t", "a").length === 0 && (await store.getState("t", "a", "memory"))?.value === "- one", show(traces));
});

await check("the agent's write is kept with its arguments cut at REQUEST_MAX, as proposals are", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow", maxDocumentBytes: 100_000, memoryMaxCharacters: 100_000 });
  const long = "x".repeat(REQUEST_MAX + 5_000);
  await p.invoke("put", { key: "notes/n", value: "y" }, ctx);
  await p.invoke("put", { key: "memory", value: long }, ctx).catch(() => null);
  const run = store.memoryShadow.list("t", "a")[0]!;
  const kept = String((run.mainOp.args as any).value);
  must(kept.length < REQUEST_MAX + 100 && kept.length < long.length, `kept ${kept.length}`);
});

const rawRows = (store: SqliteStore) => store.memoryShadow.list("t", "a").map((r) => r.id).map((id) => store.memoryShadow.get("t", "a", id)!);
const done = (store: SqliteStore, id: string) =>
  store.memoryShadow.finish("t", "a", id, { outcome: "no_change", errorCode: null, memoryAfter: store.memoryShadow.get("t", "a", id)!.memoryBefore, ops: [{ op: "revise", args: { old: "x" } }], counts: {} });

await check("redaction: a revise of an older line redacts its old wording from every row, deleting none; its own run is redacted as it finishes", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "memory", text: "- secret plan ALPHA" }, ctx);
  await p.invoke("remember", { key: "memory", text: "- likes green tea" }, ctx);
  await p.invoke("remember", { key: "memory", text: "- works on Raft" }, ctx);
  await p.invoke("revise", { key: "memory", old: "- secret plan ALPHA", new: "- plan B" }, ctx);
  const rows = rawRows(store);
  must(rows.length === 4, `rows ${rows.length}`);
  const revise = rows.find((r) => r.mainOp.tool === "revise")!;
  must(revise.memoryBefore.includes("secret plan ALPHA"), "the revise's own run lost its text before it was judged");
  for (const r of rows.filter((x) => x !== revise)) must(!show(r).includes("secret plan ALPHA"), `an earlier row kept the old wording: ${show(r)}`);
  must(rows[rows.length - 1]!.memoryMain === `${FORGOTTEN}`, `the first row's document after: ${show(rows[rows.length - 1]!.memoryMain)}`);
  must(traces.at(-1)?.attrs.redactedRows === 3, show(traces.at(-1)));
  done(store, revise.id);
  const after = show(store.memoryShadow.get("t", "a", revise.id));
  must(!after.includes("secret plan ALPHA") && after.includes(FORGOTTEN) && after.includes("- likes green tea"), after);
});

await check("redaction: a revise of a fragment removes the fragment from the request and the agent's write, and the whole old line from the documents", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "memory", text: "- lives at 12 Rose St, flat 2" }, ctx);
  await p.invoke("revise", { key: "memory", old: "12 Rose St", new: "9 Elm Rd" }, ctx);
  const revise = rawRows(store).find((r) => r.mainOp.tool === "revise")!;
  done(store, revise.id);
  const r = store.memoryShadow.get("t", "a", revise.id)!;
  must(!r.request.includes("12 Rose St") && !show(r.mainOp).includes("12 Rose St"), show({ request: r.request, mainOp: r.mainOp }));
  must(r.memoryBefore === FORGOTTEN && r.memoryMain === "- lives at 9 Elm Rd, flat 2", show(r));
  const first = rawRows(store).find((x) => x.mainOp.tool === "remember")!;
  must(!show(first).includes("12 Rose St"), `the earlier row: ${show(first)}`);
});

await check("redaction: whole lines only: '- chai' removed leaves '- chai with milk' intact", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("put", { key: "memory", value: "- chai\n- chai with milk\n- works on Raft" }, ctx);
  await p.invoke("put", { key: "memory", value: "- chai with milk\n- works on Raft" }, ctx);
  const first = rawRows(store).find((r) => r.memoryBefore === "")!;
  must(first.memoryMain === `${FORGOTTEN}\n- chai with milk\n- works on Raft`, show(first.memoryMain));
  must(String((first.mainOp.args as any).value) === `${FORGOTTEN}\n- chai with milk\n- works on Raft`, show(first.mainOp));
});

await check("redaction: a line with fewer than 4 letters or digits ('-', '---', '## a') is never redacted", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("put", { key: "memory", value: "## a\n-\n---\n- works on Raft" }, ctx);
  await p.invoke("put", { key: "memory", value: "- works on Raft" }, ctx);
  const first = rawRows(store).find((r) => r.memoryBefore === "")!;
  must(first.memoryMain === "## a\n-\n---\n- works on Raft", show(first.memoryMain));
  must(redactable("abcd") && !redactable("- a-b") && !redactable("---") && redactable("- 12 Rose"), "redactable");
});

await check("redaction: the structured cells stay valid JSON, a removed line with quotes and backslashes redacted as a value", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  const line = '- said "ship it" at C:\\work\\notes';
  await p.invoke("remember", { key: "memory", text: line }, ctx);
  const id = rawRows(store)[0]!.id;
  store.memoryShadow.finish("t", "a", id, { outcome: "changed", errorCode: null, memoryAfter: line, ops: [{ op: "remember", key: "memory", args: { text: line } }], counts: {} });
  await p.invoke("forget", { key: "memory" }, ctx);
  const cells = (store.memoryShadow as any).list("t", "a");
  const raw = cells.find((r: any) => r.id === id)!;
  must(show(raw.mainOp) === show({ tool: "remember", args: { key: "memory", text: FORGOTTEN }, result: "ok" }), show(raw.mainOp));
  must(show(raw.ops) === show([{ op: "remember", key: "memory", args: { text: FORGOTTEN } }]), show(raw.ops));
  must(raw.request === `Remember this:\n${FORGOTTEN}` && raw.memoryAfter === FORGOTTEN, show(raw));
});

await check("redaction failure never fails the write: a memory.shadow_redact row with a code and counts; an unparsable cell is counted too", async () => {
  const { store, p, ctx, traces } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "memory", text: "- secret plan ALPHA" }, ctx);
  const real = store.memoryShadow.redactRemoved.bind(store.memoryShadow);
  (store.memoryShadow as any).redactRemoved = () => { throw new Error("disk"); };
  const quietly = console.error; console.error = () => {};
  try { await p.invoke("revise", { key: "memory", old: "- secret plan ALPHA", new: "- plan B" }, ctx); } finally { console.error = quietly; }
  (store.memoryShadow as any).redactRemoved = real;
  must((await store.getState("t", "a", "memory"))?.value === "- plan B", "the write did not land");
  const failRows = traces.filter((t) => t.kind === "memory.shadow_redact");
  must(failRows.length === 1 && failRows[0].attrs.error === "redact_failed" && failRows[0].attrs.lines === 1 && !show(failRows).includes("ALPHA"), show(failRows));
  const s2 = await plugin({ memoryWriter: "shadow" });
  await s2.p.invoke("remember", { key: "memory", text: "- secret plan BRAVO" }, s2.ctx);
  const id = rawRows(s2.store)[0]!.id;
  // A damaged JSON cell: written past the store's own API, as damage would be.
  (s2.store as any).memoryShadow.finish("t", "a", id, { outcome: "no_change", errorCode: null, memoryAfter: null, ops: null, counts: null });
  s2.host.sql.exec("UPDATE memory_shadow SET main_op = '{bad' WHERE id = ?", id);
  await s2.p.invoke("forget", { key: "memory" }, s2.ctx);
  const bad = s2.traces.filter((t) => t.kind === "memory.shadow_redact");
  must(bad.length === 1 && bad[0].attrs.error === "unparsable_cell" && bad[0].attrs.rows === 1, show(bad));
});

await check("redaction under self too, for runs an earlier shadow left; no row deleted", async () => {
  const { store, p, ctx } = await plugin({ memoryWriter: "shadow" });
  await p.invoke("remember", { key: "memory", text: "- secret plan ALPHA" }, ctx);
  must(store.memoryShadow.list("t", "a").length === 1, "a run");
  const self = { ...ctx, publicConfig: {} } as PluginContext;
  await p.invoke("forget", { key: "memory" }, self);
  const rows = store.memoryShadow.list("t", "a");
  must(rows.length === 1 && !show(rows).includes("secret plan ALPHA"), show(rows));
});

// ---- judging a proposal ---------------------------------------------------------------------------------------

const MEM = "- [owner] reply in English\n- works on Raft\n- [owner] never book meetings before 10am";

await check("an edit that deletes an [owner] line is refused, counted once in taggedDeletions, and the document is left as it was", () => {
  const r = simulate(MEM, [{ op: "revise", key: "memory", old: "- [owner] reply in English" }], 8000);
  must(r.results[0]!.result === "refused" && r.results[0]!.code === "owner_line_deleted", show(r.results));
  must(r.counts.taggedDeletions === 1 && r.counts.accepted === 0 && r.counts.refusedCodes.owner_line_deleted === 1 && r.after === MEM, show(r.counts));
  must(r.counts.linesDeleted === 0, "a refused deletion counted as a deletion");
});

await check("an [owner] line's tag taken off is a deletion too; its wording shortened with the tag kept is accepted and marked as touching it", () => {
  const off = simulate(MEM, [{ op: "revise", key: "memory", old: "- [owner] reply in English", new: "- reply in English" }], 8000);
  must(off.results[0]!.code === "owner_line_deleted" && off.counts.taggedDeletions === 1, show(off.results));
  const shorter = simulate(MEM, [{ op: "revise", key: "memory", old: "- [owner] never book meetings before 10am", new: "- [owner] no meetings before 10am" }], 8000);
  must(shorter.results[0]!.result === "accepted" && shorter.counts.touchesOwner === 1 && shorter.counts.taggedDeletions === 0 && shorter.counts.taggedRevised === 1 && shorter.counts.linesRevised === 1, show(shorter));
});

await check("a put that swaps one [owner] line for another, keeping the count, is a deletion: refused and counted", () => {
  const swapped = MEM.replace("- [owner] reply in English", "- [owner] reply in French");
  const r = simulate(MEM, [{ op: "put", key: "memory", value: swapped }], 8000);
  must(r.results[0]!.code === "owner_line_deleted" && r.counts.taggedDeletions === 1 && r.after === MEM, show(r.results));
});

await check("a revise of one [owner] line in place is allowed even when it reverses the meaning, and counted as taggedRevised; one spanning lines is refused", () => {
  const r = simulate(MEM, [{ op: "revise", key: "memory", old: "never book", new: "always book" }], 8000);
  must(r.results[0]!.result === "accepted" && r.counts.taggedRevised === 1 && r.counts.taggedDeletions === 0, show(r.counts));
  const span = simulate(MEM, [{ op: "revise", key: "memory", old: "English\n- works", new: "English and works" }], 8000);
  must(span.results[0]!.code === "owner_line_deleted", show(span.results));
  must(revisedInPlace("- [owner] a\n- b", "- [owner] A\n- b") && !revisedInPlace("- [owner] a\n- b", "- a\n- b") && !revisedInPlace("- [owner] a\n- b", "- [owner] a b"), "revisedInPlace");
});

await check("a whole-document put that drops an [owner] line, and a forget, are refused", () => {
  const put = simulate(MEM, [{ op: "put", key: "memory", value: "- works on Raft" }], 8000);
  must(put.results[0]!.code === "owner_line_deleted" && put.counts.taggedDeletions === 2 && put.after === MEM, show(put.results));
  const forget = simulate(MEM, [{ op: "forget", key: "memory" }], 8000);
  must(forget.results[0]!.code === "forget_refused" && forget.after === MEM, show(forget.results));
});

await check("refusals carry the store's codes: no match, ambiguous, out of range, outside memory, too many", () => {
  const r = simulate("- a\n- a\n- b", [
    { op: "revise", key: "memory", old: "zzz", new: "y" }, { op: "revise", key: "memory", old: "- a", new: "y" },
    { op: "insert", key: "memory", after_line: 9, text: "- c" }, { op: "revise", key: "todo", old: "x" }, { op: "explode", key: "memory" },
    ...Array.from({ length: 12 }, () => ({ op: "remember", key: "memory", text: "- n" })),
  ], 8000);
  const codes = r.results.map((x) => x.code ?? "ok");
  must(show(codes.slice(0, 5)) === show(["revise_no_match", "revise_ambiguous", "insert_out_of_range", "outside_memory", "unknown_op"]), show(codes));
  must(codes.filter((c) => c === "too_many_ops").length === 5 && r.counts.ops === 17, show(codes));
});

/** A memory near its cap: the owner's rules first (the oldest lines), then a long detailed section. */
function fullMemory(cap: number) {
  const head = ["- [owner] reply in English", "- [owner] never book meetings before 10am", "- works on Raft"];
  const details = Array.from({ length: 200 }, (_, i) => `- project X detail ${i}: the vendor contract clause ${i} says something long enough to matter`);
  let doc = head.join("\n");
  for (const d of details) { if (doc.length + 1 + d.length > cap - 20) break; doc += `\n${d}`; }
  return doc;
}

await check("full document: new information that does not fit is refused as memory_full, never fitted by dropping the oldest lines", () => {
  const doc = fullMemory(MEMORY_MAX);
  must(doc.length > MEMORY_MAX - 120 && doc.length <= MEMORY_MAX, `fixture ${doc.length}`);
  const r = simulate(doc, [{ op: "insert", key: "memory", after_line: 3, text: `- prefers Thursday standups; ${"the new office is on floor 7, room 712 by the lifts; ".repeat(3)}` }], MEMORY_MAX);
  must(r.results[0]!.code === "memory_full" && r.after === doc && r.counts.oldestDeleted === 0, show(r.results));
});

await check("full document: compress and move the details to their own document with a pointer, then add the new line: accepted, under the cap, tags intact", () => {
  const doc = fullMemory(MEMORY_MAX);
  const lines = doc.split("\n");
  const detailBlock = lines.slice(3).join("\n");
  const r = simulate(doc, [
    { op: "put", key: "notes/project-x", value: detailBlock },
    { op: "revise", key: "memory", old: detailBlock, new: "- project X: vendor contract details in notes/project-x" },
    { op: "insert", key: "memory", after_line: 3, text: "- prefers Thursday standups" },
  ], MEMORY_MAX);
  must(r.counts.accepted === 3 && r.counts.refused === 0, show(r.results));
  must(r.after.length <= MEMORY_MAX && r.counts.taggedDeletions === 0 && r.counts.moved === 1 && r.counts.movedWithPointer === 1, show(r.counts));
  must(r.after.startsWith("- [owner] reply in English\n- [owner] never book meetings before 10am\n- works on Raft\n- prefers Thursday standups"), r.after.slice(0, 200));
  must(r.counts.oldestDeleted === 0 && r.counts.linesDeleted > 0 && r.counts.linesAdded + r.counts.linesRevised >= 2, show(r.counts));
});

await check("full document: an evict-oldest proposal is caught: refused where the oldest lines are the owner's, counted as oldestDeleted where they are not", () => {
  const doc = fullMemory(MEMORY_MAX);
  const evict = simulate(doc, [{ op: "revise", key: "memory", old: "- [owner] reply in English\n- [owner] never book meetings before 10am\n" }], MEMORY_MAX);
  must(evict.results[0]!.code === "owner_line_deleted" && evict.counts.taggedDeletions === 2, show(evict.results));
  const untagged = doc.split("\n").slice(2).join("\n");
  const oldest = untagged.split("\n").slice(0, 3).join("\n") + "\n";
  const r = simulate(untagged, [{ op: "revise", key: "memory", old: oldest }, { op: "remember", key: "memory", text: "- new fact" }], MEMORY_MAX);
  must(r.counts.accepted === 2 && r.counts.oldestDeleted === 3, show(r.counts));
});

await check("the shadow prompt states the rules: the owner tag at write time, never delete it, compress or move with a pointer, never evict the oldest, the cap", () => {
  const p = memoryShadowPrompt(8000);
  for (const s of [OWNER_TAG, "Decide that when you write the line", "Never delete a line that carries", "notes/<topic>", "says where they are",
    "Never make room by deleting the oldest lines", "at most 8000 characters", '{"ops": []}']) must(p.includes(s), `missing: ${s}`);
  must(isOwnerLine("- [owner] x") && isOwnerLine("[owner] x") && !isOwnerLine("- x [owner]"), "isOwnerLine");
});

await check("lineDiff counts added, revised and deleted lines, and a deletion at the top as oldestDeleted", () => {
  must(show(lineDiff("a\nb\nc", "a\nB\nc\nd")) === show({ added: 1, revised: 1, deleted: 0, oldestDeleted: 0 }), show(lineDiff("a\nb\nc", "a\nB\nc\nd")));
  must(show(lineDiff("a\nb\nc", "c")) === show({ added: 0, revised: 0, deleted: 2, oldestDeleted: 2 }), show(lineDiff("a\nb\nc", "c")));
  must(show(lineDiff("", "x")) === show({ added: 1, revised: 0, deleted: 0, oldestDeleted: 0 }), "from empty");
});

await check("answers: JSON, fenced JSON or a bare list read as ops; prose is unparseable; JSON without ops is not_ops; the observer's boolean", () => {
  must(show(parseProposal('{"ops":[{"op":"remember","key":"memory","text":"x"}]}')) === show({ ok: true, ops: [{ op: "remember", key: "memory", text: "x" }] }), "plain");
  must(parseProposal('Here:\n```json\n{"ops": []}\n```').ok, "fenced");
  must(parseProposal('[{"op":"forget","key":"memory"}]').ok, "list");
  must(show(parseProposal("I would add a line")) === show({ ok: false, code: "unparseable" }) && show(parseProposal('{"x":1}')) === show({ ok: false, code: "not_ops" }), "refusals");
  must(show(parseObservation('{"intent": false}')) === show({ ok: true, intent: false }) && !parseObservation('{"intent":"yes"}').ok && !parseObservation(null).ok, "observer");
});

await check("requests say the write: remember, insert, revise to new text, revise to delete, put, forget", () => {
  must(requestOf("remember", { key: "memory", text: "x" }) === "Remember this:\nx", "remember");
  must(requestOf("revise", { key: "memory", old: "a", new: "b" }) === "Change this text:\na\nto:\nb", "revise");
  must(requestOf("revise", { key: "memory", old: "a" }) === "Delete this text:\na", "delete");
  must(requestOf("insert", { key: "memory", after_line: 2, text: "x" }) === "Add this, at line 2:\nx", "insert");
  must(requestOf("put", { key: "memory", value: "v" }).startsWith("Replace the whole memory with:") && requestOf("forget", { key: "memory" }) === "Forget the whole memory.", "put, forget");
});

// ---- the conversation each run is shown -----------------------------------------------------------------------

const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}): BranchEntry => ({ id, type: "message", message: { role, content, ...extra } });
const write = (id: string, text: string) => msg(id, "assistant", [{ type: "toolCall", id: `c${id}`, name: modelToolName("mem", "remember"), arguments: { key: "memory", text } }]);
const calls = memoryCallMatcher(["mem"], modelToolName);

await check("two writes in one turn: the second run is shown only what came after the first write; the mark is the last entry shown", () => {
  const b: BranchEntry[] = [
    msg("e1", "user", "older talk"), msg("e2", "assistant", [{ type: "text", text: "old answer" }]),
    msg("e3", "user", "remember ALPHA"), write("e4", "alpha"), msg("e5", "toolResult", [{ type: "text", text: "ok" }], { toolName: "mem__remember" }),
    msg("e6", "assistant", [{ type: "text", text: "and BRAVO" }]), write("e7", "bravo"), msg("e8", "toolResult", [{ type: "text", text: "ok" }], { toolName: "mem__remember" }),
  ];
  const { slices, marker } = contextSlices(b, "e2", 2, calls.isWrite);
  must(show(slices.map((s) => s.map((e) => e.id))) === show([["e3", "e4"], ["e5", "e6", "e7"]]), show(slices.map((s) => s.map((e) => e.id))));
  must(marker === "e7", `marker ${marker}`);
  const second = renderConversation(slices[1]!);
  must(second.includes("and BRAVO") && !second.includes("ALPHA") && !second.includes("older talk"), second);
  const next = contextSlices(b, marker, 1, calls.isWrite);
  must(show(next.slices[0]!.map((e) => e.id)) === show(["e8"]), "the next run was shown the turn again");
});

await check("without a mark the first run is shown the most recent messages; a missing write falls back to the end", () => {
  const b = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", [{ type: "text", text: `t${i}` }]));
  const { slices, marker } = contextSlices(b, "gone", 1, calls.isWrite);
  must(slices[0]!.length === FIRST_CONTEXT_MESSAGES && slices[0]![0]!.id === "m10" && marker === "m29", show({ n: slices[0]!.length, first: slices[0]![0]!.id, marker }));
  const two = contextSlices(b, null, 2, calls.isWrite);
  must(two.slices[1]!.length === 0, "the second run without a write of its own was shown the same messages again");
});

await check("called: a direct write to memory and a memory_update call both count; a write to another key or another mount's tool does not", () => {
  must(calledMemory([write("a", "x")], calls.isChange), "direct write");
  const update = msg("u", "assistant", [{ type: "toolCall", id: "c", name: modelToolName("mem", "memory_update"), arguments: { request: "x" } }]);
  must(calledMemory([update], calls.isChange), "memory_update");
  const journal = msg("j", "assistant", [{ type: "toolCall", id: "c", name: modelToolName("mem", "remember"), arguments: { key: "journal", text: "x" } }]);
  const other = msg("o", "assistant", [{ type: "toolCall", id: "c", name: modelToolName("other", "remember"), arguments: { key: "memory", text: "x" } }]);
  must(!calledMemory([journal, other], calls.isChange), "another key or mount counted");
});

// ---- the private table ----------------------------------------------------------------------------------------

await check("memory_shadow: kept 7 days, pruned as a new run is queued; an agent's delete takes its runs and marks, not another agent's", () => {
  const host = sqliteHost();
  let now = 1_000_000_000_000;
  const t = new MemoryShadowTables(host, { now: () => now }).ensure();
  must(MEMORY_SHADOW_RETENTION_MS === 7 * 24 * 3_600_000, "retention");
  const run = (id: string) => ({ id, trigger: "chat" as const, session: "main", request: "r", mainOp: { tool: "remember", args: {}, result: "ok" }, memoryBefore: "", memoryMain: "x" });
  t.queue("t", "a", run("old"));
  t.queue("t", "b", run("other"));
  t.setMark("t", "a", "main", "e1");
  now += MEMORY_SHADOW_RETENTION_MS + 1;
  t.queue("t", "a", run("new"));
  must(show(t.list("t", "a").map((r) => r.id)) === show(["new"]) && t.mark("t", "a", "main") === null, show(t.list("t", "a")));
  must(t.list("t", "b").length === 1, "another agent's row was pruned by this agent's write");
  t.setMark("t", "a", "main", "e2");
  t.deleteAgent("t", "a");
  must(t.list("t", "a").length === 0 && t.mark("t", "a", "main") === null && t.list("t", "b").length === 1, "the delete");
});

// ---- the operator's read ---------------------------------------------------------------------------------------

/** D1 as node:sqlite with every migration applied, as test/assistant-decisions.ts makes it. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { db, d1: { prepare: (q: string) => stmt(q) } };
}
const TOKEN = "operator-token";
const DAY = 24 * 3_600_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const RUNS = [{ id: "ms_1" }];
function source(stillRecording = true) {
  const asked: Array<[string, string, number, number]> = [];
  const cleared: string[] = [];
  let rows = 3;
  const open = (_t: string, _a: string): MemoryShadowSource => ({
    adminMemoryShadow: async (t, a, from, to) => { asked.push([t, a, from, to]); return a === "a" ? RUNS : null; },
    adminMemoryShadowClear: async (_t2, a) => { cleared.push(a); if (a !== "a") return null; const deleted = rows; rows = 0; return { deleted, stillRecording }; },
  });
  return { asked, cleared, open };
}
const del = (q: string, headers: Record<string, string> = {}) => new Request(`https://x/admin/memory-shadow?${q}`, { method: "DELETE", headers });
const get = (q: string, headers: Record<string, string> = {}) => new Request(`https://x/admin/memory-shadow?${q}`, { headers });
const quiet = async <T>(fn: () => Promise<T>) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

await check("GET /admin/memory-shadow: the operator's token or nothing, and never an object opened without it", async () => {
  for (const headers of [{}, { "x-harness-token": "wrong" }] as Array<Record<string, string>>) {
    const s = source();
    const res = await adminMemoryShadow(get("tenantId=t&agentId=a&reason=x", headers), TOKEN, s.open, null);
    must(res.status === 401 && s.asked.length === 0, `${show(headers)}: ${res.status}`);
  }
  const unset = source();
  must((await adminMemoryShadow(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": "" }), undefined, unset.open, null)).status === 401 && unset.asked.length === 0, "no token configured opened");
});

await check("GET /admin/memory-shadow: always audited as an assistant's read: a reason is required, a row written, a failed write refuses", async () => {
  const { db, d1: database } = d1();
  const s = source();
  const none = await adminMemoryShadow(get("tenantId=t&agentId=a", { "x-harness-token": TOKEN }), TOKEN, s.open, d1ReadAudit(database as never), T0);
  must(none.status === 400 && (await none.json() as { code?: string }).code === "read_reason_required" && s.asked.length === 0, `no reason: ${none.status}`);
  const res = await adminMemoryShadow(get("tenantId=t&agentId=a&from=2026-09-10T00:00:00Z&to=1790000000000", { "x-harness-token": TOKEN, "x-read-reason": "compare day 2" }), TOKEN, s.open, d1ReadAudit(database as never), T0);
  must(res.status === 200 && res.headers.get("cache-control") === "no-store", `read: ${res.status}`);
  const body = await res.json() as any;
  must(show(body.records) === show(RUNS) && show(s.asked) === show([["t", "a", Date.parse("2026-09-10T00:00:00Z"), 1_790_000_000_000]]), show({ body, asked: s.asked }));
  const rows = db.prepare("SELECT route, agent_id, session, token_kind, reason, assistant, outcome FROM admin_read_audit").all() as any[];
  must(rows.length === 1 && rows[0].route === "/admin/memory-shadow" && rows[0].agent_id === "a" && rows[0].reason === "compare day 2" &&
    rows[0].assistant === 1 && rows[0].outcome === "read" && rows[0].session === null, `audit: ${show(rows)}`);
  const failing: ReadAudit = { record: async (_r: ReadAuditRow) => { throw new Error("D1 down"); } };
  const s2 = source();
  const refused = await quiet(() => adminMemoryShadow(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s2.open, failing, T0));
  must(refused.status === 503 && s2.asked.length === 0, `audit down: ${refused.status}`);
});

await check("GET /admin/memory-shadow: the last 7 days by default, a bad range is a 400, an agent the object lacks a 404", async () => {
  const s = source();
  const res = await adminMemoryShadow(get("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
  must(res.status === 200 && show(s.asked) === show([["t", "a", T0 - 7 * DAY, T0]]), `default: ${show(s.asked)}`);
  for (const q of ["from=yesterday", "from=20&to=10"]) {
    const r = await adminMemoryShadow(get(`tenantId=t&agentId=a&reason=x&${q}`, { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
    must(r.status === 400, `${q}: ${r.status}`);
  }
  const missing = await adminMemoryShadow(get("tenantId=t&agentId=nobody&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, { record: async () => {} }, T0);
  must(missing.status === 404, `missing: ${missing.status}`);
});

await check("DELETE /admin/memory-shadow: the GET's gate: the operator's token, a reason, an audit row naming the clear, refused when it cannot be written", async () => {
  for (const headers of [{}, { "x-harness-token": "wrong" }] as Array<Record<string, string>>) {
    const s = source();
    const res = await adminMemoryShadow(del("tenantId=t&agentId=a&reason=x", headers), TOKEN, s.open, null);
    must(res.status === 401 && s.cleared.length === 0, `${show(headers)}: ${res.status}`);
  }
  const { db, d1: database } = d1();
  const s = source();
  const none = await adminMemoryShadow(del("tenantId=t&agentId=a", { "x-harness-token": TOKEN }), TOKEN, s.open, d1ReadAudit(database as never), T0);
  must(none.status === 400 && s.cleared.length === 0, `no reason: ${none.status}`);
  const res = await adminMemoryShadow(del("tenantId=t&agentId=a", { "x-harness-token": TOKEN, "x-read-reason": "owner asked" }), TOKEN, s.open, d1ReadAudit(database as never), T0);
  const body = await res.json() as any;
  must(res.status === 200 && body.deleted === 3 && body.stillRecording === true && /set it back to "self"/.test(body.note), show(body));
  const rows = db.prepare("SELECT route, agent_id, reason, assistant, outcome FROM admin_read_audit").all() as any[];
  must(rows.length === 1 && rows[0].route === "DELETE /admin/memory-shadow" && rows[0].reason === "owner asked" && rows[0].assistant === 1, `audit: ${show(rows)}`);
  const failing: ReadAudit = { record: async (_r: ReadAuditRow) => { throw new Error("D1 down"); } };
  const s2 = source();
  const refused = await quiet(() => adminMemoryShadow(del("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s2.open, failing, T0));
  must(refused.status === 503 && s2.cleared.length === 0, `audit down: ${refused.status}`);
});

await check("DELETE /admin/memory-shadow: idempotent (a second clear says deleted 0), no stillRecording note under self, 404 for an agent the object lacks", async () => {
  const s = source(false);
  const ok = { record: async () => {} };
  const first = await (await adminMemoryShadow(del("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, ok, T0)).json() as any;
  const second = await (await adminMemoryShadow(del("tenantId=t&agentId=a&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, ok, T0)).json() as any;
  must(first.deleted === 3 && second.deleted === 0 && second.stillRecording === false && second.note === undefined, show({ first, second }));
  const missing = await adminMemoryShadow(del("tenantId=t&agentId=nobody&reason=x", { "x-harness-token": TOKEN }), TOKEN, s.open, ok, T0);
  must(missing.status === 404, `missing: ${missing.status}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
