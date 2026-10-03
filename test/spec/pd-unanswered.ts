/**
 * A pd agent's object holding what a scripted conversation (./pd-conversation.ts) cannot produce, written by
 * pi-durable's own harness over node:sqlite, run after run in one conversation:
 *
 * | run | what happens                                                                  | outcome            | shown by           |
 * |-----|-------------------------------------------------------------------------------|--------------------|--------------------|
 * | 1   | the model is not registered: fails before its first call, appends nothing      | failed (no_model)  | pdFailedRuns       |
 * | 2   | the model replies with a non-retryable error: that reply is the failure        | failed (model_err) | its reply (control)|
 * | 3   | a `beforeRequest` hook throws: faults before its first call                     | faulted            | pdFailedRuns       |
 * | 4   | the model calls a tool it was not offered; an `afterTools` hook then throws:    | faulted            | pdFailedRuns       |
 * |     | faults in its tools phase, after its tool-calling reply and the tool's result  |                    |                    |
 * | 5   | a retryable error reply, after which the model is gone: no_model on the retry  | failed (no_model)  | its reply + failure|
 * | 6   | answered                                                                        | completed          | its reply          |
 * | 7   | answered; then rewritten `orphaned` (below)                                     | orphaned           | pdFailedRuns       |
 *
 * then two manual compactions (`Conversation.compact`, summaries from the model), a transcript reset with a handoff
 * (`Conversation.reset`), and a task left pending.
 *
 * `orphaned` is the one outcome rewritten by hand: only the scheduler writes it, for a task whose definition cannot be
 * resolved, and `pi.generation` is built into every harness. The record keeps pi-durable's shape (types.d.ts
 * `TaskOutcome`), on a generation that really ran.
 *
 * Around it, what the runtime would have written: the owner row, the engine recorded as `pd`, the directory row that
 * names the main conversation, and `ap_model_jobs` rows in each state the engine leaves them.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { createModels } from "pi-ai-1/models";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import { createRegistry } from "../../src/vendor/pi/pi-durable/dist/harness/registry.js";
import { SqliteStorage } from "../../src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { Harness } from "../../src/vendor/pi/pi-durable/dist/harness/harness.js";
import { durableOffloadedProvider, readAnswer, type ModelJobRequest } from "../../src/model/durable-offloaded.ts";
import { errorMessage, fromResponse } from "../../src/model/pi-bridge.ts";
import { settle } from "../../src/runtime/durable-drive.ts";
import { PiDurableSqlite } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import { ApStore } from "../../src/store/ap-store.ts";
import type { sqliteHost } from "../../src/store/sqlite-host.ts";

type Host = ReturnType<typeof sqliteHost>;

export const HANDOFF = "Start over: the person wants **one** answer.";
export const SUMMARIES = ["First summary.", "Second summary."];
export const NOT_RETRYABLE = "invalid request: bad schema";
export const RETRYABLE = "503 service unavailable";
export const AGENT_THREW = "the agent could not be resolved";

/** A task kind no registry runs: created and left pending. */
const PARKED = defineTask<Record<string, never>, { phase: "start" }, null>({
  name: "test.parked", version: 1, initial: () => ({ phase: "start" }),
  phases: { start: async () => {} },
  abort: async () => {},
});

/** Ids of what each run left, for the tests to name. */
export interface Unanswered { conversationId: number; generations: number[] }

export async function unansweredObject(host: Host): Promise<Unanswered> {
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  const ap = new ApStore(host, prefixedNamespace("ap"));
  ap.ensure();
  ap.setEngineOnce("pd");

  // Resolving the conversation's agent reads each selected extension's tools. This one's throw on demand, which faults
  // the phase resolving it: pi-durable reports a throwing hook, section or wrap, but not a failed agent resolution
  // (src/vendor/pi/pi-durable/dist/harness/scheduler.js `hooks.each` awaits it outside its catch). `reads` counts down the resolutions still let
  // through; at 0 the next read throws.
  let reads = Number.POSITIVE_INFINITY;
  const extension = defineExtension({ name: "unanswered" });
  Object.defineProperty(extension, "tools", {
    get() {
      if (reads <= 0) throw new Error(AGENT_THREW);
      reads--;
      return [];
    },
  });
  const registry = createRegistry();
  registry.install(extension);
  reads = Number.POSITIVE_INFINITY;

  const models = createModels();
  let summaries = 0;
  /** A provider whose every answer is `answer(model id)`; `once` runs after its first answer is read. */
  const provider = (id: string, answer: (jobId: string) => object, once?: () => void) => {
    let read = false;
    models.setProvider(durableOffloadedProvider({
      id, pollAfterMs: 1, models: [{ id: "m", contextWindow: 100_000 }],
      port: {
        async start(request: ModelJobRequest) { return `job_${request.model.provider}_${Math.random()}`; },
        async poll(jobId: string) {
          const out = readAnswer(JSON.stringify(answer(jobId)));
          if (!read) { read = true; once?.(); }
          return out;
        },
      },
    }));
  };
  const who = (id: string) => ({ api: "offloaded", provider: id, id: "m" });
  const text = (id: string, t: string) => (jobId: string) =>
    fromResponse({ text: t, finishReason: "stop", truncated: false, usage: { promptTokens: 3, completionTokens: 1, cachedPromptTokens: 0, reasoningTokens: 0 } }, who(id), jobId);
  provider("failing", (jobId) => ({ ...errorMessage(NOT_RETRYABLE, who("failing")), jobId }));
  provider("flaky", (jobId) => ({ ...errorMessage(RETRYABLE, who("flaky")), jobId }), () => models.deleteProvider("flaky"));
  // Armed when the tool-calling reply is read: the poll phase that appends it has resolved its agent, and the tools
  // phase that follows resolves it again, and throws.
  let armTools = false;
  provider("tooly", (jobId) => fromResponse({ text: "", finishReason: "tool_calls", truncated: false,
    toolCalls: [{ id: "call_1", name: "nope", arguments: {} }],
    usage: { promptTokens: 3, completionTokens: 1, cachedPromptTokens: 0, reasoningTokens: 0 } } as any, who("tooly"), jobId), () => { if (armTools) reads = 1; });
  provider("ok", (jobId) => text("ok", summaries > 0 ? SUMMARIES[summaries - 1]! : "Fine.")(jobId));

  const open = async () => Harness.open(await SqliteStorage.open(new PiDurableSqlite(host, prefixedNamespace("pd"))), {
    models, registry,
    settings: { stream: { deferred: true }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { keepRecentTokens: 1 } },
  }, bg);
  const drive = async (h: Harness) => {
    const r = await settle(h, { context: bg, deadlineMs: 10_000, minParkMs: 60_000, subscribe: () => () => {} });
    if (r.state !== "idle") throw new Error(`the harness did not settle idle: ${r.state}`);
  };
  /** One run: `model` configured, `text` submitted, driven until idle. */
  const run = async (model: string, input: string) => {
    const h = await open();
    const c = await h.root(bg, { agent: { model: { provider: model, modelId: "m" }, instructions: "Answer in one word.", extensions: [extension] } });
    await c.configure({ model: { provider: model, modelId: "m" } }, bg);
    await c.submit({ type: "input", content: input }, bg);
    await drive(h);
    return Number(c.id);
  };

  const conversationId = await run("gone", "hello");
  ap.openConversation({ taskId: "main", tenantId: "demo", agentId: "u-a", conversationId, createdAt: 1 });
  await run("failing", "again");
  reads = 0;
  await run("ok", "fault before");
  reads = Number.POSITIVE_INFINITY;
  armTools = true;
  await run("tooly", "call a tool");
  armTools = false;
  reads = Number.POSITIVE_INFINITY;
  await run("flaky", "retry me");
  await run("ok", "answer me");
  await run("ok", "answer me again");

  for (let i = 0; i < SUMMARIES.length; i++) {
    // Something new to compact each time: a compaction needs entries past the last one's cut.
    summaries = 0;
    if (i > 0) await run("ok", `more ${i}`);
    summaries = i + 1;
    const h = await open();
    await (await h.root(bg)).compact(undefined, bg);
    await drive(h);
  }

  let h = await open();
  await (await h.root(bg)).reset(HANDOFF, bg);
  await drive(h);

  // Work the harness has not finished: a background task created and never run, as an evicted object leaves one.
  h = await open();
  const parked = await h.root(bg);
  await parked.commit(async (tx) => { await tx.createTask(PARKED, {}, { ownership: { kind: "conversation" }, conversationId: parked.id, background: true }); }, bg);
  await h.close(bg);

  const generations = host.sql.exec("SELECT id FROM pd_tasks WHERE kind = ? ORDER BY id", JSON.stringify("pi.generation")).toArray().map((r) => Number(r.id));
  // Run 7's generation, as the scheduler would leave it orphaned.
  const orphan = generations[6]!;
  const record = JSON.parse(String(host.sql.exec("SELECT record FROM pd_tasks WHERE id = ?", orphan).toArray()[0]!.record));
  record.state = { status: "terminal", outcome: { status: "orphaned", reason: "missing_task" } };
  host.sql.exec("UPDATE pd_tasks SET record = ? WHERE id = ?", JSON.stringify(record), orphan);

  // The engine's job rows: one still out, one answered, one whose generation was aborted (kept unanswered, so a late
  // answer is still billed, and owed nothing).
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at) VALUES ('mj_open', ?, '{\"x\":1}', 3)", conversationId);
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, answer, created_at, answered_at, state) VALUES ('mj_done', ?, '{}', '{}', 1, 2, 'consumed')", conversationId);
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at, state) VALUES ('mj_cancelled', ?, '{}', 2, 'cancelled')", conversationId);
  return { conversationId, generations };
}
