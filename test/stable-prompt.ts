/**
 * A pi085 conversation's system prompt and tool list stay byte-identical for the conversation's life, and what moves
 * between turns — the state mount's working set, what the agent is holding — reaches the model as a notice at the head
 * of a later message (src/runtime/prompt-context.ts, `AgentRuntime.agent` and `postMessage` in cf/src/runtime.ts).
 *
 * The runtime rows drive the real `AgentRuntime` over node:sqlite with the model scripted through the queue, as
 * test/operation-id.ts does, and read every request off the job rows. A harness reopen is a second runtime over the
 * same storage: what an eviction leaves. The central property is the provider's: the request of call N+1 begins with
 * the whole request of call N — system prompt, tools and every message — byte for byte, across a state write and a
 * reopen; the per-call prefix reading on the `model.call` trace row (src/runtime/request-prefix.ts) says the same.
 */
import { AgentRuntime, HARNESS_NOTICE } from "../cf/src/runtime.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { MountActivity, Plugin } from "../src/plugins/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { canonJson } from "../src/core/canon-json.ts";
import { addedLines, contextNotice, returnContextChange, sectionsOf, takeContextChange, promptContextFor } from "../src/runtime/prompt-context.ts";
import { recordRequestPrefix } from "../src/runtime/request-prefix.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

// ---- a plugin that holds a seat, switched by the case ------------------------------------------------------------

let seat: MountActivity["live"] = null;
const seats: Plugin = {
  id: "seats", version: "1.0.0",
  tools: [{ name: "letgo", description: "Let the seat go.", parameters: { type: "object", properties: {} }, sideEffects: "write", idempotency: "none" }] as never,
  async invoke() { return { ok: true }; },
  holds: {
    tools: { release: "letgo" },
    async activity() { return { live: seat, quietUntil: null, billing: "billed while held" }; },
    async release() { return true; },
  },
} as Plugin;

// ---- the runtime, driven as the worker drives it ------------------------------------------------------------------

type Ctx = { systemPrompt: string; messages: any[]; tools: unknown[] };
type World = { host: ReturnType<typeof sqliteHost>; rt: AgentRuntime; sent: string[]; answered: Set<string>; calls: Ctx[] };

function runtimeOver(w: Omit<World, "rt"> & { rt?: AgentRuntime }): AgentRuntime {
  const standIn = standInLoader();
  return new AgentRuntime({
    ctx: { storage: { sql: w.host.sql, transactionSync: w.host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [seats],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { w.sent.push(job.commandId); },
  } as never);
}

async function world(): Promise<World> {
  seat = null;
  const base = { host: sqliteHost(), sent: [] as string[], answered: new Set<string>(), calls: [] as Ctx[] };
  const w = { ...base, rt: runtimeOver(base) } as World;
  await w.rt.ready();
  await w.rt.store.createAgent("t", "a");
  for (const [alias, plugin] of [["state", "state"], ["seats", "seats"]] as const) {
    await w.rt.store.setPluginChoice("t", "a", plugin, "enable");
    const added = await w.rt.addMount("t", "a", { alias, plugin, config: { account: alias } });
    must(added.ok, `the ${alias} mount was refused: ${show(added)}`);
  }
  await w.rt.bindOperatorModel("t", "a");
  // The catalogue's own notices (test/capability-notice.ts) are said here, so the cases see only this file's.
  await w.rt.reconcileSeeds("t", "a");
  const pending = await w.rt.store.pendingSeedNotices("t", "a");
  await w.rt.store.takeSeedNotices("t", "a", new Set(pending.map((n) => `${n.alias}@${n.since}`)));
  return w;
}

/** What an eviction does: a new runtime over the same storage, so the next turn opens its harness again. */
function reopen(w: World) {
  w.rt = runtimeOver(w);
}

const remember = async (w: World, key: string, value: string) =>
  w.rt.store.putState("t", "a", key, { value, ref: null, bytes: value.length });

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

/** One user message, answered once; every request the model was sent is kept, as the job row holds it. */
async function turn(w: World, text: string, mode: "prompt" | "steer" = "prompt") {
  await w.rt.postMessage("t", "a", text, mode, "main");
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !w.answered.has(id));
    for (const id of pending) {
      w.answered.add(id);
      const job = await w.rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Ctx } | null;
      if (!job) continue;
      w.calls.push(JSON.parse(JSON.stringify(job.context)));
      await w.rt.deliverAnswer("t", "a", id, fromResponse(say("noted"), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (out?.wakeInMs === null || out?.wakeInMs === undefined) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error("the turn did not settle");
}

const textOf = (m: any): string => typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.map((p: any) => p?.text ?? "").join("") : "";
const lastUser = (c: Ctx) => textOf([...c.messages].reverse().find((m) => m.role === "user"));

/** The request of `next` begins with the whole request of `prev`: system, tools and every message, byte for byte. */
function extendsRequest(prev: Ctx, next: Ctx) {
  must(next.systemPrompt === prev.systemPrompt, `the system prompt moved:\n--- before\n${prev.systemPrompt.slice(-400)}\n--- after\n${next.systemPrompt.slice(-400)}`);
  must(canonJson(next.tools) === canonJson(prev.tools), "the tool list moved");
  must(next.messages.length > prev.messages.length, `no new message: ${prev.messages.length} then ${next.messages.length}`);
  for (let i = 0; i < prev.messages.length; i++) {
    must(JSON.stringify(next.messages[i]) === JSON.stringify(prev.messages[i]), `message ${i} was rewritten: ${show(prev.messages[i]).slice(0, 200)} → ${show(next.messages[i]).slice(0, 200)}`);
  }
}

/** The prefix reading on each answered call's trace row, in order. */
const prefixRows = (w: World) => w.host.sql.exec("SELECT attrs FROM trace_outbox WHERE kind = 'model.call' ORDER BY seq").toArray()
  .map((r: any) => JSON.parse(String(r.attrs)).prefix as Record<string, unknown> | undefined);

await check("a state write and a reopen: the next request extends the last one byte for byte, and its new message carries the change", async () => {
  const w = await world();
  try {
    await remember(w, "memory", "- prefers tea");
    await turn(w, "hello");
    const first = w.calls[0]!;
    must(first.systemPrompt.includes("- prefers tea"), "control: the working set is in the first prompt");
    must(lastUser(first) === "hello", `nothing moved before the first message, so no notice: ${lastUser(first)}`);

    await remember(w, "memory", "- prefers tea\n- lives in Lisbon");
    await remember(w, "todo", "- book the flight");
    reopen(w);
    await turn(w, "again");
    const second = w.calls[1]!;
    extendsRequest(first, second);
    must(!second.systemPrompt.includes("Lisbon") && !second.systemPrompt.includes("book the flight"),
      "the reopened harness re-rendered the working set into the system prompt");
    const said = lastUser(second);
    must(said.startsWith(HARNESS_NOTICE), `the change is not at the head of the message: ${said.slice(0, 120)}`);
    must(said.endsWith("\n\nagain"), `the person's text follows the notice: ${show(said.slice(-40))}`);
    must(/## memory \(durable facts\) — added since you last saw it:\n- lives in Lisbon/.test(said), `memory grew by one line, so one line is said: ${said}`);
    must(!/- prefers tea/.test(said), `a line the model already has is not said again: ${said}`);
    must(/## todo \(open items\) — now reads:\n- book the flight/.test(said), `a new document is said whole: ${said}`);

    // The third call, with nothing moved: the second request is all a prefix of it, and no notice.
    reopen(w);
    await turn(w, "and again");
    extendsRequest(second, w.calls[2]!);
    must(lastUser(w.calls[2]!) === "and again", `nothing moved, nothing said: ${lastUser(w.calls[2]!).slice(0, 200)}`);

    const rows = prefixRows(w);
    must(rows.length === 3 && rows.every(Boolean), `a prefix reading on every call: ${show(rows)}`);
    must(rows[0]!.first === true, `the first call has nothing before it: ${show(rows[0])}`);
    for (const [i, r] of rows.slice(1).entries()) {
      must(r!.broken === null && r!.sharedMessages === w.calls[i]!.messages.length && r!.systemSha256 === rows[0]!.systemSha256
        && r!.toolsSha256 === rows[0]!.toolsSha256, `call ${i + 2} shares call ${i + 1} whole: ${show(r)}`);
    }
  } finally { w.host.dispose(); }
});

await check("unchanged state: a reopen tells the model nothing, and the prompt is the same", async () => {
  const w = await world();
  try {
    await remember(w, "memory", "- prefers tea");
    await remember(w, "journal", "2026-10-11 started");
    await turn(w, "hello");
    reopen(w);
    await turn(w, "again");
    reopen(w);
    await turn(w, "once more");
    extendsRequest(w.calls[0]!, w.calls[1]!);
    extendsRequest(w.calls[1]!, w.calls[2]!);
    for (const c of w.calls) must(!lastUser(c).includes(HARNESS_NOTICE.trim()), `a notice with nothing moved: ${lastUser(c).slice(0, 200)}`);
  } finally { w.host.dispose(); }
});

await check("a seat acquired, then let go: the prompt holds still and each change is told once", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    seat = { id: "seat-9", startedAt: Date.UTC(2026, 9, 11, 9, 30), lastUsedAt: Date.UTC(2026, 9, 11, 9, 30) };
    reopen(w);
    await turn(w, "sit");
    extendsRequest(w.calls[0]!, w.calls[1]!);
    must(!w.calls[1]!.systemPrompt.includes("seat-9"), "the held seat was rendered into the reopened prompt");
    const held = lastUser(w.calls[1]!);
    must(held.startsWith(HARNESS_NOTICE) && /What you are holding now:\n- `seats`: seat-9, held since 09:30 UTC/.test(held), `the seat is told: ${held}`);
    await turn(w, "still sitting");
    must(lastUser(w.calls[2]!) === "still sitting", `told once, not again: ${lastUser(w.calls[2]!).slice(0, 200)}`);
    seat = null;
    reopen(w);
    await turn(w, "stand");
    extendsRequest(w.calls[2]!, w.calls[3]!);
    must(/You are no longer holding anything\./.test(lastUser(w.calls[3]!)), `the release is told: ${lastUser(w.calls[3]!)}`);
  } finally { w.host.dispose(); }
});

await check("a fresh context starts from what is true then: the new conversation's prompt has the working set, and no notice", async () => {
  const w = await world();
  try {
    await remember(w, "memory", "- prefers tea");
    await turn(w, "hello");
    await remember(w, "memory", "- prefers tea\n- lives in Lisbon");
    const fresh = await w.rt.freshContext("t", "a");
    must(fresh.ok, `fresh context: ${show(fresh)}`);
    await turn(w, "new start");
    const c = w.calls[1]!;
    must(c.systemPrompt.includes("- lives in Lisbon"), "the new conversation's prompt was not taken again");
    must(c.messages.length === 1 && lastUser(c) === "new start", `the first message of a new conversation carries no notice: ${show(c.messages).slice(0, 300)}`);
    // And it is fixed from there.
    await remember(w, "memory", "- prefers tea\n- lives in Lisbon\n- has a cat");
    reopen(w);
    await turn(w, "next");
    extendsRequest(c, w.calls[2]!);
    must(/- has a cat/.test(lastUser(w.calls[2]!)), `the change after the new start is told: ${lastUser(w.calls[2]!)}`);
  } finally { w.host.dispose(); }
});

await check("two messages racing after a change: exactly one of them carries the notice", async () => {
  const w = await world();
  try {
    await turn(w, "hello");
    await remember(w, "memory", "- raced");
    await Promise.all([w.rt.postMessage("t", "a", "one", "prompt", "main"), w.rt.postMessage("t", "a", "two", "prompt", "main")]);
    await turn(w, "three");
    const users = w.calls[w.calls.length - 1]!.messages.filter((m) => m.role === "user").map(textOf);
    const carrying = users.filter((u) => u.includes("- raced"));
    must(carrying.length === 1, `told ${carrying.length} times: ${show(users)}`);
  } finally { w.host.dispose(); }
});

// ---- the pieces --------------------------------------------------------------------------------------------------

await check("sections split at headings outside fences: a heading-shaped line in MEMORY.md is the file's text", () => {
  const text = "# Workspace files\nintro\n\n## `MEMORY.md` (20 bytes, writable)\nIts content:\n\n```\n# not a heading\n```\n\n## Other files\n- x";
  const s = sectionsOf(text);
  must(show(s.map((x) => x.key)) === show(["# Workspace files", "## `MEMORY.md`", "## Other files"]), `keys: ${show(s.map((x) => x.key))}`);
  must(s[1]!.body.includes("# not a heading"), `the fenced line stays in its section: ${show(s[1])}`);
});

await check("added lines: only growth reads as added; an edit, or a tail kept by its budget, reads correctly", () => {
  must(show(addedLines(["a", "b"], ["a", "b", "c"])) === show(["c"]), "append");
  must(addedLines(["a", "b"], ["a", "x", "c"]) === null, "an edit is not an append");
  must(addedLines(["a", "b", "c"], ["c", "d"]) === null, "lines lost with no cut marker are an edit, not an append");
  must(show(addedLines(["…", "b", "c"], ["…", "c", "d"])) === show(["d"]), "a tail-kept log that moved on");
  must(addedLines(["a"], ["a"]) === null, "nothing added");
});

await check("the notice: removed and changed sections, a size-only heading change, and nothing when nothing moved", () => {
  const before = { contributions: ["# What you already know\nintro\n\n## memory (durable facts)\n- a\n\n## todo (open items)\n- t"], held: [] };
  must(contextNotice(before, before) === null, "nothing moved");
  const after = { contributions: ["# What you already know\nintro\n\n## memory (durable facts)\n- b"], held: ["- x"] };
  const n = contextNotice(before, after)!;
  must(/## memory \(durable facts\) — now reads:\n- b/.test(n) && /## todo \(open items\) — no longer there\./.test(n)
    && /What you are holding now:\n- x/.test(n) && !/What you already know/.test(n), n);
  const seeded = (size: number, body: string) => ({ contributions: [`## \`MEMORY.md\` (${size} bytes, writable)\n${body}`], held: [] });
  const m = contextNotice(seeded(3, "abc"), seeded(4, "abcd"))!;
  must(/## `MEMORY.md` \(4 bytes, writable\) — now reads:\nabcd/.test(m), m);
});

await check("taking a change is once; a message not written gives it back, unless something moved it since", () => {
  const host = sqliteHost();
  try {
    const a = { contributions: ["## memory (durable facts)\n- a"], held: [] };
    const b = { contributions: ["## memory (durable facts)\n- a\n- b"], held: [] };
    must(promptContextFor(host.sql, "t/a", "main", a, false, 1) === a, "a conversation not started takes what is now");
    must(show(promptContextFor(host.sql, "t/a", "main", b, true, 2)) === show(a), "a started conversation keeps what it took");
    const took = takeContextChange(host.sql, "t/a", "main", b, "N: ");
    must(took && took.notice.startsWith("N: ") && /- b/.test(took.notice), `taken: ${show(took)}`);
    must(takeContextChange(host.sql, "t/a", "main", b, "N: ") === null, "taken twice");
    returnContextChange(host.sql, "t/a", "main", took!);
    must(takeContextChange(host.sql, "t/a", "main", b, "N: ") !== null, "given back, so taken again");
    must(takeContextChange(host.sql, "other/agent", "main", b, "N: ") === null, "no snapshot taken: nothing to compare");
  } finally { host.dispose(); }
});

await check("the prefix reading: whole, broken by an earlier message, by the system prompt, by the tools", () => {
  const host = sqliteHost();
  try {
    const m1 = { role: "user", content: "a" }, m2 = { role: "assistant", content: "b" }, m3 = { role: "user", content: "c" };
    const first = recordRequestPrefix(host.sql, "k", { systemPrompt: "S", messages: [m1], tools: [] });
    must(first.first && first.broken === null && first.messages === 1, show(first));
    const whole = recordRequestPrefix(host.sql, "k", { systemPrompt: "S", messages: [m1, m2, m3], tools: [] });
    must(!whole.first && whole.broken === null && whole.sharedMessages === 1 && whole.sharedChars === canonJson(m1).length, show(whole));
    const edited = recordRequestPrefix(host.sql, "k", { systemPrompt: "S", messages: [m1, { ...m2, content: "x" }, m3], tools: [] });
    must(edited.broken === "message" && edited.sharedMessages === 1, show(edited));
    must(recordRequestPrefix(host.sql, "k", { systemPrompt: "S2", messages: [m1], tools: [] }).broken === "system", "system");
    must(recordRequestPrefix(host.sql, "k", { systemPrompt: "S2", messages: [m1], tools: [{ name: "t" }] }).broken === "tools", "tools");
  } finally { host.dispose(); }
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
