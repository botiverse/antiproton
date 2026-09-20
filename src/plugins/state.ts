import type { Plugin, PluginContext } from "./types.ts";
import { READ_WHOLE_MAX } from "./artifacts.ts";
import { toAgentRef } from "../store/refs.ts";
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
 * injected once when the harness opens — `workingSet(store, tenantId, agentId)`,
 * built from the agent and not from any task — where the prefix stays stable and
 * cached; changes made after it opens are already in the transcript as tool
 * results.
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

/** The documents the harness injects when it opens. Named here so the tool
 *  summaries, the injection and the operator view cannot drift apart. */
export const WORKING_SET: ReadonlyArray<{
  key: string; budget: number; what: string;
  /** Keep the end rather than the beginning when it does not fit. */
  tail?: boolean;
}> = [
  { key: "todo", budget: 2000, what: "open items" },
  { key: "memory", budget: 4000, what: "durable facts" },
  { key: "journal", budget: 3000, what: "recent log", tail: true },
];

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Named once because `workingSet` looks a mount up by it. A second copy of the
 *  string is how the injected text came to name a tool nothing had to provide. */
const PLUGIN_ID = "state";

export function statePlugin(
  store: StorageAdapter,
  artifacts: R2Artifacts | null,
  bucket: string,
): Plugin {
  return {
    id: PLUGIN_ID,
    // Seeded to every agent since there has been a seed list: an agent with no
    // memory is the failure this plugin exists to prevent.
    defaultForAllAgents: true,

    /**
     * The working set, put in front of the agent when its harness opens.
     *
     * The runtime used to import `workingSet` from this file by name, which is
     * why no other plugin could say anything in the prompt. Now the mount
     * declares it and the framework asks every mount the same question.
     *
     * **Contributed once per agent, not once per mount.** What is written here
     * lives in `agent_state`, which is keyed by agent rather than by mount, so
     * two mounts of this plugin read the same documents — and two mounts would
     * otherwise put the same paragraph in the prompt twice. The first mount, in
     * the order the gateway itself resolves them, is the one that speaks.
     */
    async promptContribution(ctx) {
      const first = (await store.findMountsByPlugin(
        ctx.caller.tenantId, ctx.caller.agentId, PLUGIN_ID))[0]?.alias;
      if (first && first !== ctx.alias) return null;
      const text = await workingSet(store, ctx.caller.tenantId, ctx.caller.agentId);
      return text.trim() ? text : null;
    },

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
          "up. Write the fact, not the story. Never write a credential. A document is a key in " +
          "the same store `put`, `get`, `list` and `forget` use, so `get` on `journal` returns it " +
          "and a `put` to that key replaces the whole document rather than appending to it.",
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
          "kept in object storage automatically and handed back as a reference. Keys share one " +
          "store with `remember`'s documents, so writing to `memory`, `todo` or `journal` here " +
          "overwrites what you have been remembering.",
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
          "from the artifacts mount, whose `read` can project fields and page.",
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
        summary:
          "What is stored, with sizes and when it changed. Values are not returned. Each row also " +
          "carries `ref`: the r2:// reference when that value was too large to keep inline, and " +
          "null when it was not — so a large value can be opened from the artifacts mount without " +
          "a `get` first.",
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
        // `stateUsage` returns `{ keys, bytes }` — a *count* — so spreading it
        // after `keys: rows` overwrote the listing with the number of rows, and
        // this tool has never returned a key to anyone. The totals are worth
        // having, so they keep their own name rather than the listing's, and
        // they are the whole store while `keys` is what the prefix and the
        // limit selected.
        // Each row's reference as this agent may be shown it; null where the
        // stored key names nothing of its own, which is the same answer `get`
        // gives for that row.
        const shownRows = rows.map((r: any) => ({ ...r, ref: r.ref ? toAgentRef(r.ref, ctx.caller) : null }));
        return { keys: shownRows, total: { keys: usage.keys, bytes: usage.bytes } };
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
          // What this agent may be shown, and whether it may be shown anything:
          // `toAgentRef` is null exactly when the stored key names nothing of
          // this agent's — a legacy row whose key moves through the path. The
          // same call answers "can it be read" and "what do we hand over", so
          // the two cannot disagree.
          const shown = got.ref ? toAgentRef(got.ref, ctx.caller) : null;
          if (got.ref && shown === null) {
            // A row written before the reader refused these segments: the value
            // is there and cannot be fetched. Offering the read call anyway
            // hands the model an instruction that fails, and nothing in the
            // answer says the value is unreachable — it looks like a value it
            // simply has not opened yet (the case behind 2d3de80). So no call is
            // offered, and the one move that helps is: it is `forget`.
            //
            // The reference itself is left out. Its only use here would be the
            // call that cannot work, and `list` still reports `ref` per row,
            // so it stays where it is diagnostic and goes where it would be an
            // instruction.
            return {
              key, found: true, bytes: got.bytes, readable: false,
              note: `this value was stored under a key that is no longer valid, so it cannot be read back; `
                + `remove it with forget { key: "${key}" }`,
            };
          }
          if (got.ref) {
            // The note is the call, with the reference already in it: a model
            // that has to assemble one from a shape guesses the argument names,
            // and a value over the read-back line has to be paged rather than
            // read whole — which the old note never said, so a 60 KB value's
            // only documented route parked again and stopped there — a fresh
            // agent, 2026-09-13, the case behind f0a3bcc.
            const whole = got.bytes <= READ_WHOLE_MAX;
            return {
              key, found: true, bytes: got.bytes, ref: shown,
              note: whole
                ? `too large to return here; read it from the artifacts mount: `
                  + `read { ref: "${shown}" }`
                : `too large to return here, and too large to read back in one call; page it from `
                  + `the artifacts mount: read { ref: "${shown}", from: 0 } — each page's note gives the next`,
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
          // A key becomes part of the object's path once a value is large
          // enough to be parked, so a key that moves through the path names
          // somewhere else: one written this way produced a reference that left
          // this agent's subtree while still beginning with it. `/` stays
          // legal — `list { prefix }` exists so keys can
          // be hierarchical — but a segment that is `.` or `..` is a move
          // rather than a name.
          //
          // Judged here, before the size does, because the alternative is a key
          // that works while the value is small and fails the day it grows.
          // That is the worse failure: it arrives later, to someone who did not
          // write the key, and looks like the value's fault.
          if (key.split("/").some((seg) => seg === "." || seg === "..")) {
            throw new Error(`a key names a value, not a path: \`${key}\` moves through it`);
          }
          const usage = await store.stateUsage(tenantId, agentId);
          const prior = (await store.getState(tenantId, agentId, key))?.bytes ?? 0;
          if (usage.bytes - prior + body.length > cfg.maxTotalBytes) {
            throw new Error(
              `this would take the store past ${cfg.maxTotalBytes} bytes (currently ${usage.bytes}); ` +
              `delete something with the \`forget\` tool on \`${ctx.alias}\``,
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
          return { key, bytes: body.length, stored: "object-storage", ref: toAgentRef(stored.ref, ctx.caller) };
        }
      }
      throw new Error(`unknown tool: ${tool}`);
    },
  };
}

/**
 * The working set, as it is shown to the agent when the harness opens.
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
  // Which name the model can call these by is the operator's choice, not ours:
  // the harness dispatches on `<alias>.remember`, and an agent may hold this
  // plugin under any alias or under none. Naming a tool that is not mounted is
  // not a harmless hint — it is a wrong instruction competing with the right
  // ones, which is why the prompt only mentions artifacts when an artifacts
  // tool is really there (cf/src/runtime.ts). Read after the early return, so
  // an agent with nothing written pays nothing for the lookup. Asked by plugin
  // id, the way the gateway resolves one; the first mount if an operator has
  // made two, since either name reaches the same store.
  const alias = (await store.findMountsByPlugin(tenantId, agentId, PLUGIN_ID))[0]?.alias;
  // Still injected when there is no mount: memory you can read but not edit is
  // worth reading. What is dropped is only the sentence that would tell the
  // agent to call something it has not got.
  // Named as "the X tool on the Y mount" rather than as `Y.X`, because the
  // dotted form is the harness's dispatch address and not a name the model can
  // call: the tool it is offered is `remember`, qualified to `state__remember`
  // only if another mount also has one. Which of those it is depends on the
  // whole mounted set, so a plugin cannot know it — the mount and the tool it
  // belongs to are the two facts that stay true under either.
  const correcting = alias
    ? `They are kept by the \`${alias}\` mount: correct one with its \`remember\` tool when it ` +
      "turns out to be wrong, and drop one with `forget` when it stops being true."
    : "You have no tool mounted for changing it, so treat it as read-only and say so if it is wrong.";
  return (
    "\n\n# What you already know\n" +
    "Written by you on earlier tasks, and shown here so you do not have to go and look. " +
    correcting + "\n\n" +
    parts.join("\n\n")
  );
}
