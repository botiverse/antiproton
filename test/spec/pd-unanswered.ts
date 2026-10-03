/**
 * A pd agent's object holding what a scripted conversation (./pd-conversation.ts) cannot produce, written by
 * pi-durable's own harness over node:sqlite rather than as hand-made rows:
 *
 * - a run that failed before its first model call: the conversation's model is not registered, so the generation
 *   ends `failed` (`no_model`) and appends nothing;
 * - a run whose model call came back with an error: the generation appends that reply (stopReason `error`) and then
 *   ends `failed` — the control, since the transcript shows it already;
 * - a compaction entry, appended through a commit in the shape pi-durable's compaction writes;
 * - a transcript reset with a handoff (`Conversation.reset`).
 *
 * Around it, what the runtime would have written: the owner row, the engine recorded as `pd`, the directory row that
 * names the main conversation, and `ap_model_jobs` rows in each state the engine leaves them.
 */
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { createModels } from "pi-ai-1/models";
import { defineTask } from "@earendil-works/pi-durable";
import { createRegistry } from "../../src/vendor/pi/pi-durable/dist/harness/registry.js";
import { SqliteStorage } from "../../src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { Harness } from "../../src/vendor/pi/pi-durable/dist/harness/harness.js";
import { durableOffloadedProvider, readAnswer, type ModelJobRequest } from "../../src/model/durable-offloaded.ts";
import { errorMessage } from "../../src/model/pi-bridge.ts";
import { settle } from "../../src/runtime/durable-drive.ts";
import { PiDurableSqlite } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import { ApStore } from "../../src/store/ap-store.ts";
import type { sqliteHost } from "../../src/store/sqlite-host.ts";

type Host = ReturnType<typeof sqliteHost>;

/** A task kind no registry runs: created and left pending. */
const PARKED = defineTask<Record<string, never>, { phase: "start" }, null>({
  name: "test.parked", version: 1, initial: () => ({ phase: "start" }),
  phases: { start: async () => {} },
  abort: async () => {},
});

export const SUMMARY = "The person asked twice; nothing was answered.";
export const HANDOFF = "Start over: the person wants **one** answer.";

/** Every job the failing provider answers is this error. */
export const PROVIDER_ERROR = "provider 500";

export async function unansweredObject(host: Host) {
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  const ap = new ApStore(host, prefixedNamespace("ap"));
  ap.ensure();
  ap.setEngineOnce("pd");

  const models = createModels();
  models.setProvider(durableOffloadedProvider({
    id: "failing", pollAfterMs: 1, models: [{ id: "m", contextWindow: 100_000 }],
    port: {
      async start(request: ModelJobRequest) { return `job_${request.model.id}_${Math.random()}`; },
      async poll(id: string) {
        return readAnswer(JSON.stringify({ ...errorMessage(PROVIDER_ERROR, { api: "offloaded", provider: "failing", id: "m" }), jobId: id }));
      },
    },
  }));
  const open = async () => Harness.open(await SqliteStorage.open(new PiDurableSqlite(host, prefixedNamespace("pd"))),
    { models, registry: createRegistry(), settings: { stream: { deferred: true }, retry: { enabled: false } } }, bg);
  const drive = async (h: Harness) => {
    const r = await settle(h, { context: bg, deadlineMs: 10_000, minParkMs: 1, subscribe: () => () => {} });
    if (r.state !== "idle") throw new Error(`the harness did not settle idle: ${r.state}`);
  };

  // A run with no model to call: it fails before its first model call.
  let h = await open();
  const root = await h.root(bg, { agent: { model: { provider: "gone", modelId: "m" }, instructions: "Answer in one word." } });
  const conversationId = Number(root.id);
  ap.openConversation({ taskId: "main", tenantId: "demo", agentId: "u-a", conversationId, createdAt: 1 });
  await root.submit({ type: "input", content: "hello" }, bg);
  await drive(h);

  // A run whose model call comes back with an error: its reply is in the transcript.
  h = await open();
  const again = await h.root(bg);
  await again.configure({ model: { provider: "failing", modelId: "m" } }, bg);
  await again.submit({ type: "input", content: "again" }, bg);
  await drive(h);

  h = await open();
  const last = await h.root(bg);
  await last.commit(async (tx) => {
    await tx.appendEntry(last.id, {
      kind: "pi.compaction",
      model: [{ role: "user", content: [{ type: "text", text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>` }], timestamp: Date.now() }],
    });
  }, bg);
  await last.reset(HANDOFF, bg);
  await drive(h);

  // Work the harness has not finished: a background task created and never run, as an evicted object leaves one.
  h = await open();
  const parked = await h.root(bg);
  await parked.commit(async (tx) => { await tx.createTask(PARKED, {}, { ownership: { kind: "conversation" }, conversationId: parked.id, background: true }); }, bg);
  await h.close(bg);

  // The engine's job rows: one still out, one answered, one whose generation was aborted (kept unanswered, so a late
  // answer is still billed, and owed nothing).
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at) VALUES ('mj_open', ?, '{\"x\":1}', 3)", conversationId);
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, answer, created_at, answered_at, state) VALUES ('mj_done', ?, '{}', '{}', 1, 2, 'consumed')", conversationId);
  ap.query("INSERT INTO model_jobs (id, conversation_id, request, created_at, state) VALUES ('mj_cancelled', ?, '{}', 2, 'cancelled')", conversationId);
  return { conversationId };
}
