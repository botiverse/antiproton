import type { Plugin, PluginContext } from "./types.ts";
import type { StorageAdapter } from "../core/store.ts";
import type { R2Artifacts } from "../store/artifacts.ts";
import type { Json } from "../core/types.ts";

/**
 * Somewhere for the agent to put things down.
 *
 * Without this a long-running agent re-derives everything on every task, and it
 * knows it: asked to remember something it answers that it has nowhere to keep
 * it. What the existing mounts offered was `artifacts.read`, which reads back
 * what the *gateway* parked — there was no way for the agent to write.
 *
 * The shape follows what pi-memory and Codex converged on independently, since
 * both were built by watching agents fail to use worse designs:
 *
 *   - Plain text documents a person can read and edit, not opaque blobs. An
 *     operator has to be able to see what an agent believes about their
 *     account, and correct it.
 *   - Separate documents for separate lifetimes — durable facts, open items,
 *     what happened — so the working set can be trimmed by priority instead of
 *     all at once.
 *   - Appending must be one call. A journal you have to read, edit and rewrite
 *     to add a line is a journal that stops being written.
 *
 * What does *not* carry over is pi's injection of the whole working set before
 * every turn. Measured on this deployment, editing the system message drops the
 * prompt cache from 84.9% to 0.0% — 6.6x the uncached tokens — so re-writing it
 * each turn would cost more than the memory is worth. The working set is
 * injected once when the task opens, where the prefix stays stable and cached;
 * changes made during a task are already in the transcript as tool results.
 *
 * Small values live in the object's own SQLite: transactional, strongly
 * consistent, and already isolated per (tenant, agent) by construction. Large
 * ones spill to object storage and leave a reference behind, which is the same
 * split the tool-result offload makes — and the reference is readable with the
 * `artifacts.read` that already exists, rather than a second paging tool.
 */

/** Above this a value is spilled rather than kept in a row. Matches the
 *  tool-result offload threshold: the same question, the same answer. */
const INLINE_MAX = 32 * 1024;

interface StateConfig {
  account?: string;
  /** Refuse writes once the agent's own store passes this. Not a quota on the
   *  tenant — a guard against one agent filling the object's 10 GB. */
  maxTotalBytes?: number;
  /** The largest single value, spilled or not. */
  maxValueBytes?: number;
  /** Cap on an appended document before its head is dropped. */
  maxDocumentBytes?: number;
}

const DEFAULTS: Required<Omit<StateConfig, "account">> = {
  maxTotalBytes: 64 * 1024 * 1024,
  maxValueBytes: 4 * 1024 * 1024,
  maxDocumentBytes: 64 * 1024,
};

/** The documents the harness injects when a task opens. Named here so the tool
 *  summaries, the injection and the operator view cannot drift apart. */
export const WORKING_SET = [
  { key: "todo", budget: 2000, what: "open items" },
  { key: "memory", budget: 4000, what: "durable facts" },
  { key: "journal", budget: 3000, what: "recent log", tail: true },
] as const;

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function statePlugin(
  store: StorageAdapter,
  artifacts: R2Artifacts | null,
  bucket: string,
): Plugin {
  return {
    id: "state",
    config: [
      // Two thresholds, and only one of them is this setting. A value over
      // INLINE_MAX spills to object storage and comes back as a reference; a
      // value over this is refused outright. "Anything bigger must go to object
      // storage" described the first while naming the second.
      //
      // The declared defaults come from DEFAULTS rather than being written
      // again here: a console showing a blank default for a setting that has
      // one is how a person learns the wrong number.
      { name: "maxValueBytes", type: "number", default: DEFAULTS.maxValueBytes,
        summary: `Largest single value; anything bigger is refused. Values over ${INLINE_MAX / 1024} KiB are kept in object storage and handed back as a reference, which is not configurable.` },
      { name: "maxDocumentBytes", type: "number", default: DEFAULTS.maxDocumentBytes,
        summary: "Largest working-set document before its head is trimmed." },
      { name: "maxTotalBytes", type: "number", default: DEFAULTS.maxTotalBytes,
        summary: "How much this agent may keep in total. A write that would pass it is refused." },
    ],
    version: "1.0.0",
    tools: [
      {
        name: "remember",
        summary:
          "Append one line to a document that survives this task. Use `memory` for a fact worth " +
          "having next time (a preference, a decision, a hard-won detail), `todo` for something " +
          "still open, `journal` for what happened. These three are shown to you automatically " +
          "when a task starts, so anything you put there you will see again without looking it " +
          "up. Write the fact, not the story. Never write a credential.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "memory | todo | journal, or your own document name" },
            text: { type: "string", description: "one line; include the date if it matters" },
          },
          required: ["key", "text"],
        },
        sideEffects: "write",
        idempotency: "none",
      },
      {
        name: "put",
        summary:
          "Store a value under a key, replacing whatever was there. For data rather than notes — " +
          "a result you will need later, a structure you do not want to rebuild. Large values are " +
          "kept in object storage automatically and handed back as a reference.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" }, value: {} },
          required: ["key", "value"],
        },
        sideEffects: "write",
        idempotency: "key",
      },
      {
        name: "get",
        summary:
          "Read a key back. A value too large to return arrives as an r2:// reference; open it " +
          "with artifacts.read, which can project fields and page.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
        sideEffects: "read",
        idempotency: "native",
      },
      {
        name: "list",
        summary: "What is stored, with sizes and when it changed. Values are not returned.",
        parameters: {
          type: "object",
          properties: {
            prefix: { type: "string" },
            limit: { type: "integer" },
          },
        },
        sideEffects: "read",
        idempotency: "native",
      },
      {
        name: "forget",
        summary:
          "Delete a key. Use it when something you wrote down turned out to be wrong — stale " +
          "memory is worse than none, because you will act on it.",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
        sideEffects: "write",
        idempotency: "key",
      },
    ],

    async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
      const cfg = { ...DEFAULTS, ...(ctx.publicConfig as StateConfig) };
      const { tenantId, agentId } = ctx.caller;
      const a = (args ?? {}) as { key?: string; text?: string; value?: Json; prefix?: string; limit?: number };

      if (tool === "list") {
        const rows = await store.listState(tenantId, agentId, a.prefix ?? "", Math.min(a.limit ?? 50, 200));
        const usage = await store.stateUsage(tenantId, agentId);
        return { keys: rows, ...usage };
      }

      const key = String(a.key ?? "");
      // A key is a name, not a path into someone else's data. The store scopes
      // by (tenant, agent) anyway; this keeps the names readable to an operator.
      if (!KEY.test(key)) {
        throw new Error(`invalid key ${JSON.stringify(key).slice(0, 60)}: letters, digits and . _ - / only`);
      }

      switch (tool) {
        case "remember": {
          const text = String(a.text ?? "").trim();
          if (!text) throw new Error("nothing to remember");
          const r = await store.appendState(tenantId, agentId, key, text, cfg.maxDocumentBytes);
          return {
            key, bytes: r.bytes,
            ...(r.truncated ? { note: "the document was full; its oldest lines were dropped" } : {}),
          };
        }

        case "get": {
          const got = await store.getState(tenantId, agentId, key);
          if (!got) return { key, found: false };
          if (got.ref) {
            return {
              key, found: true, bytes: got.bytes, ref: got.ref,
              note: "too large to return here; read it with artifacts.read { ref, fields, offset, limit }",
            };
          }
          return { key, found: true, bytes: got.bytes, updatedAt: got.updatedAt, value: got.value };
        }

        case "forget":
          return { key, deleted: await store.deleteState(tenantId, agentId, key) };

        case "put": {
          const body = JSON.stringify(a.value ?? null);
          if (body.length > cfg.maxValueBytes) {
            throw new Error(`value is ${body.length} bytes; the limit is ${cfg.maxValueBytes}`);
          }
          // Checked before writing, not after: the point is to refuse, not to
          // notice afterwards that the object is full.
          const usage = await store.stateUsage(tenantId, agentId);
          const prior = (await store.getState(tenantId, agentId, key))?.bytes ?? 0;
          if (usage.bytes - prior + body.length > cfg.maxTotalBytes) {
            throw new Error(
              `this would take the store past ${cfg.maxTotalBytes} bytes (currently ${usage.bytes}); ` +
              `delete something with state.forget`,
            );
          }
          if (body.length <= INLINE_MAX) {
            await store.putState(tenantId, agentId, key, {
              value: a.value ?? null, ref: null, bytes: body.length,
            });
            return { key, bytes: body.length, stored: "inline" };
          }
          if (!artifacts) throw new Error("no object storage is mounted, and the value is too large to inline");
          const stored = await artifacts.put(`t/${tenantId}/${agentId}/state/${key}.json`, body);
          await store.putState(tenantId, agentId, key, {
            value: null, ref: stored.ref, bytes: body.length,
          });
          return { key, bytes: body.length, stored: "object-storage", ref: stored.ref };
        }
      }
      throw new Error(`unknown tool: ${tool}`);
    },
  };
}

/**
 * The working set, as it is shown to the agent when a task opens.
 *
 * Budgeted and ordered the way pi orders it — open items first, then durable
 * facts, then the log, which is the first thing to lose — because the reason to
 * push memory in at all is that an agent that has to remember to go and look
 * will not look.
 */
export async function workingSet(
  store: StorageAdapter, tenantId: string, agentId: string,
): Promise<string> {
  const parts: string[] = [];
  for (const doc of WORKING_SET) {
    const got = await store.getState(tenantId, agentId, doc.key);
    const text = typeof got?.value === "string" ? got.value : got?.value ? JSON.stringify(got.value) : "";
    if (!text.trim()) continue;
    const kept = text.length <= doc.budget
      ? text
      : doc.tail
        ? `…\n${text.slice(text.length - doc.budget)}`
        : `${text.slice(0, doc.budget)}\n…`;
    parts.push(`## ${doc.key} (${doc.what})\n${kept}`);
  }
  if (!parts.length) return "";
  return (
    "\n\n# What you already know\n" +
    "Written by you on earlier tasks, and shown here so you do not have to go and look. " +
    "Correct it with state.remember when it turns out to be wrong, and delete it with " +
    "state.forget when it stops being true.\n\n" +
    parts.join("\n\n")
  );
}
