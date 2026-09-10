/**
 * Can pi's harness actually drive a turn on our storage?
 *
 * This is the load-bearing question for replacing the loop, and it is asked
 * before anything is deleted. The pieces are the real ones — PiSqliteStorage,
 * StorageBackedSession, AgentHarness — and only the provider is faked, because
 * the point is the loop and not the model.
 *
 * What matters is not that a reply comes back. It is that the whole turn is
 * durable: the prompt, the assistant message, the tool call and its result are
 * rows in our SQLite when the run ends, and `AgentHarness.create` on a fresh
 * process finds them again. That is what the Durable Object needs — it is
 * evicted between alarms and rebuilds from storage every time.
 */
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { AgentHarness } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { PiSqliteStorage } from "../src/store/pi-storage.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 400) }); }
}

const calls: string[] = [];

/** One tool, standing in for a mount: the harness must reach it and record it. */
function echoTool() {
  return {
    name: "echo",
    label: "Echo",
    description: "Echo a word back",
    parameters: Type.Object({ word: Type.String() }),
    async execute(_id: string, params: { word: string }) {
      calls.push(params.word);
      return { content: [{ type: "text" as const, text: `echoed ${params.word}` }], details: null };
    },
  };
}

function fixture() {
  const host = sqliteHost();
  const storage = new PiSqliteStorage(host);
  const session = new StorageBackedSession(
    { id: "s1", createdAt: Date.now(), storageVersion: 1 }, storage as any);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { host, storage, session, faux, models };
}

async function open(f: ReturnType<typeof fixture>) {
  const { harness, open } = await AgentHarness.create({
    session: f.session as any,
    models: f.models,
    model: f.faux.getModel(),
    tools: [echoTool()] as any,
    systemPrompt: "you are a test",
  }, CTX);
  return { harness, open };
}

await check("一轮完整的 turn 落在我们的 SQLite 里", async () => {
  const f = fixture();
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { word: "hello" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const { harness } = await open(f);
  const lane = await harness.lane("main", CTX);
  const res = await lane.prompt("say hello", undefined, CTX);
  if (!(res as any).ok) throw new Error(`prompt rejected: ${JSON.stringify(res).slice(0, 200)}`);

  if (calls.length !== 1 || calls[0] !== "hello") throw new Error(`tool not reached: ${JSON.stringify(calls)}`);

  const entries = await f.storage.scanEntries({ order: "asc" }, CTX);
  const kinds = entries.map((e: any) => e.type === "message" ? `message:${e.message.role}` : e.type);
  // user prompt, assistant tool call, tool result, assistant answer.
  for (const want of ["message:user", "message:assistant", "message:toolResult"]) {
    if (!kinds.includes(want)) throw new Error(`missing ${want} — got ${kinds.join(", ")}`);
  }
  const text = JSON.stringify(entries);
  if (!text.includes("echoed hello")) throw new Error("the tool result never became an entry");
  await harness.close(CTX);
});

await check("驱逐后重建:同一个存储上找得回来", async () => {
  const f = fixture();
  f.faux.setResponses([fauxAssistantMessage("first answer")]);
  const a = await open(f);
  const laneA = await a.harness.lane("main", CTX);
  await laneA.prompt("one", undefined, CTX);
  await a.harness.close(CTX);

  // A brand-new storage object over the same database — literally what the
  // Durable Object does on every wake, since closing the harness closes the
  // storage it was holding.
  const storage2 = new PiSqliteStorage(f.host);
  const session2 = new StorageBackedSession(
    { id: "s1", createdAt: Date.now(), storageVersion: 1 }, storage2 as any);
  const { harness: b } = await AgentHarness.create({
    session: session2 as any, models: f.models, model: f.faux.getModel(),
    tools: [echoTool()] as any, systemPrompt: "you are a test",
  }, CTX);
  const laneB = await b.lane("main", CTX);
  const seen = await laneB.findEntries(undefined, CTX);
  if (!JSON.stringify(seen).includes("first answer")) {
    throw new Error("a rebuilt harness lost the transcript");
  }
  await b.close(CTX);
});

await check("create 会报告上次没跑完的 operation", async () => {
  const f = fixture();
  const { open: openOps } = await open(f);
  // Nothing was interrupted, so nothing is open. The point is that the field
  // exists and is the recovery signal — it replaces sweeping for stale tasks.
  if (!Array.isArray(openOps)) throw new Error("create did not report open operations");
});

console.log(`\n  pi agent loop on our storage\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
