import type { Plugin, PluginContext } from "./types.ts";
import { READ_WHOLE_MAX } from "./artifacts.ts";
import { toAgentRef } from "../store/refs.ts";
import type { StorageAdapter } from "../core/store.ts";
import type { R2Artifacts } from "../store/artifacts.ts";
import type { Json } from "../core/types.ts";
import { importKek, KEPT_NAME, KEPT_PREFIX, open, seal } from "../runtime/secrets.ts";
import { STATE_INLINE_MAX, STATE_KEY } from "./state-key.ts";
import type { SeedFileMeta, SeedMode } from "../store/seed-files.ts";

type SealingKey = Awaited<ReturnType<typeof importKek>>;

export const SECRET_VALUE_MAX = 8_000;

/*
 * Kept secrets, one set of rules for both ways in: the agent's own `secret_*`
 * tools below, under `kept:`, and the owner's console (`/ui/secret`), under
 * `owner:` (src/runtime/secrets.ts says who reads which). One copy, so a name or
 * a value one of them accepts is one the other accepts too. `prefix` picks the
 * namespace; the tools below only ever pass the default.
 */

/** Why `name` cannot name a kept secret, or null. */
export function keptNameProblem(name: unknown): string | null {
  return typeof name === "string" && KEPT_NAME.test(name) ? null : "name must be 1–64 letters, digits, . _ or -";
}

/** Why `value` cannot be kept, or null. */
export function keptValueProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "value must be a non-empty string";
  if (value.length > SECRET_VALUE_MAX) return `value is longer than ${SECRET_VALUE_MAX} characters`;
  return null;
}

/** Seal and keep one value under a name the caller has checked. */
export async function keptPut(store: StorageAdapter, key: SealingKey, tenantId: string, agentId: string, name: string, value: string, prefix = KEPT_PREFIX): Promise<void> {
  await store.putSecret(tenantId, agentId, prefix + name, await seal(key, value));
}

/** Whether there was one to delete. */
export async function keptDelete(store: StorageAdapter, tenantId: string, agentId: string, name: string, prefix = KEPT_PREFIX): Promise<boolean> {
  return store.removeSecret(tenantId, agentId, prefix + name);
}

/** The names with their times, never a value: what `secret_list` answers. */
export async function keptList(store: StorageAdapter, tenantId: string, agentId: string, prefix = KEPT_PREFIX) {
  const rows = await store.listSecretNames(tenantId, agentId, prefix);
  return rows.map((r) => ({
    name: r.name.slice(prefix.length), storedAt: new Date(r.updatedAt).toISOString(),
    lastReadAt: r.lastUsedAt === null ? null : new Date(r.lastUsedAt).toISOString(),
  }));
}

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

/** Named once because `workingSet` looks a mount up by it. A second copy of the
 *  string is how the injected text came to name a tool nothing had to provide. */
const PLUGIN_ID = "state";

/**
 * The mode of each path an evaluation's setup seeded (src/store/seed-files.ts),
 * by path. Anything but `writable` is held as `readonly`: the setup route
 * writes only those two, and a third would be a row nobody meant, which should
 * fail closed rather than open.
 */
async function seedModes(store: StorageAdapter, tenantId: string, agentId: string): Promise<Map<string, SeedMode>> {
  return new Map((await store.listSeedFiles(tenantId, agentId)).map((f) => [f.path, seedModeOf(f)]));
}

function seedModeOf(f: SeedFileMeta): SeedMode {
  return f.mode === "writable" ? "writable" : "readonly";
}

/** Whether `tool` is declared as a write that takes a `key`: what the read-only guard holds to it. */
function writesAKey(plugin: Plugin, tool: string): boolean {
  const t = plugin.tools.find((x) => x.name === tool);
  const props = (t?.parameters as { properties?: Record<string, unknown> } | null)?.properties;
  return t?.sideEffects === "write" && !!props && "key" in props;
}

export function statePlugin(
  store: StorageAdapter,
  artifacts: R2Artifacts | null,
  bucket: string,
  /** The deployment's key for sealing secrets; resolves to null where none is configured. */
  kek: () => Promise<SealingKey | null> = async () => null,
): Plugin {
  const plugin: Plugin = {
    id: PLUGIN_ID,

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
     *
     * The files an evaluation's setup put in the workspace come first, from
     * the same mount and for the same reason (`seededFiles`): an agent with
     * none gets exactly the paragraph it got before there were any.
     */
    async promptContribution(ctx) {
      const first = (await store.findMountsByPlugin(
        ctx.caller.tenantId, ctx.caller.agentId, PLUGIN_ID))[0]?.alias;
      if (first && first !== ctx.alias) return null;
      const { tenantId, agentId } = ctx.caller;
      const seeds = await store.listSeedFiles(tenantId, agentId);
      // A working-set document that is also a seeded path is shown once, in
      // the seeded block: under "What you already know" it would be headed
      // "written by you", which a file the setup gave is not.
      const text = await seededFiles(store, tenantId, agentId, seeds)
        + await workingSet(store, tenantId, agentId, new Set(seeds.map((f) => f.path)));
      return text.trim() ? text : null;
    },

    config: [
      // Two thresholds, and only one of them is this setting. A value over
      // STATE_INLINE_MAX spills to object storage and comes back as a reference; a
      // value over this is refused outright. "Anything bigger must go to object
      // storage" described the first while naming the second.
      //
      // The declared defaults come from DEFAULTS rather than being written
      // again here: a console showing a blank default for a setting that has
      // one is how a person learns the wrong number.
      { name: "maxValueBytes", type: "number", default: DEFAULTS.maxValueBytes,
        summary: `Largest single value; anything bigger is refused. Values over ${STATE_INLINE_MAX / 1024} KiB are kept in object storage and handed back as a reference, which is not configurable.` },
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
        name: "secret_put",
        summary:
          "Keep a secret you were given (an API key, a token, a password) under a name, sealed at rest, " +
          "replacing any value under that name. Use this rather than `put` or `remember` for anything secret. " +
          "The value you pass is part of this conversation; after this, refer to it by name.",
        parameters: {
          type: "object", additionalProperties: false, required: ["name", "value"],
          properties: {
            name: { type: "string", description: "letters, digits, . _ -; up to 64" },
            value: { type: "string", description: `the secret; up to ${SECRET_VALUE_MAX} characters` },
          },
        },
        sideEffects: "write",
        idempotency: "key",
      },
      {
        name: "secret_get",
        summary:
          "Read back a secret you kept with `secret_put`, only when you need the value itself. To call an HTTP API " +
          "with it, you do not: name it in the HTTP tool's `secretHeaders` and it is filled in on the way out. Otherwise best from `run_js`: " +
          "code can pass the value to the sandbox's shell, in a command or an environment variable, without " +
          "printing it, and then it never enters this conversation. Called directly, the value is shown here and " +
          "kept in the record. Mount credentials cannot be read this way.",
        parameters: {
          type: "object", additionalProperties: false, required: ["name"],
          properties: { name: { type: "string" } },
        },
        sideEffects: "read",
        idempotency: "native",
      },
      {
        name: "secret_list",
        summary: "The names of the secrets you kept, with when each was stored and last read. Never the values.",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        sideEffects: "read",
        idempotency: "native",
      },
      {
        name: "secret_delete",
        summary: "Delete a secret you kept, when it is no longer valid or no longer needed.",
        parameters: {
          type: "object", additionalProperties: false, required: ["name"],
          properties: { name: { type: "string" } },
        },
        sideEffects: "write",
        idempotency: "key",
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

      if (tool.startsWith("secret_")) {
        const s = (args ?? {}) as { name?: unknown; value?: unknown };
        if (tool === "secret_list") return { secrets: await keptList(store, tenantId, agentId) };
        const badName = keptNameProblem(s.name);
        if (badName) throw new Error(badName);
        const name = s.name as string;
        const row = KEPT_PREFIX + name;
        if (tool === "secret_delete") return { name, deleted: await keptDelete(store, tenantId, agentId, name) };
        const key = await kek();
        if (!key) throw new Error("this deployment has no key for sealing secrets, so it cannot keep one");
        if (tool === "secret_put") {
          const badValue = keptValueProblem(s.value);
          if (badValue) throw new Error(badValue);
          await keptPut(store, key, tenantId, agentId, name, s.value as string);
          return { name, kept: true };
        }
        if (tool === "secret_get") {
          const sealed = await store.getSecret(tenantId, agentId, row);
          if (!sealed) throw new Error(`no secret named ${s.name}; secret_list shows the names you kept`);
          const value = await open(key, sealed);
          await store.touchSecret(tenantId, agentId, row, Date.now());
          return { name: s.name, value };
        }
        throw new Error(`unknown tool: ${tool}`);
      }

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
        // A seeded path says how it was given, so a refusal to change it is
        // not the first the agent hears of it; any other row has no `seed`.
        const modes = await seedModes(store, tenantId, agentId);
        const shownRows = rows.map((r: any) => ({
          ...r, ref: r.ref ? toAgentRef(r.ref, ctx.caller) : null,
          ...(modes.has(r.key) ? { seed: modes.get(r.key) } : {}),
        }));
        return { keys: shownRows, total: { keys: usage.keys, bytes: usage.bytes } };
      }

      const key = String(a.key ?? "");
      // A key is a name, not a path into someone else's data. The store scopes
      // by (tenant, agent) anyway; this keeps the names readable to an operator.
      if (!STATE_KEY.test(key)) {
        throw new Error(`invalid key ${JSON.stringify(key).slice(0, 60)}: letters, digits and . _ - / only`);
      }

      // The one place a write to a seeded path is judged, before any tool's
      // own case: every tool declared as a write that takes a `key` is asked
      // here, by its declaration rather than by a list of names, so a write
      // tool added later is held to it without anyone remembering to. A
      // `writable` seeded path is an ordinary key from here on. The secret
      // tools returned above: they write `secrets`, never `agent_state`.
      const seed = (await seedModes(store, tenantId, agentId)).get(key);
      if (seed === "readonly" && writesAKey(plugin, tool)) {
        throw new Error(
          `\`${key}\` was provided at setup as read-only; it cannot be changed or removed. `
          + "Keep your own notes under another key.",
        );
      }
      const seeded = seed ? { seed } : {};

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
          if (!got) return { key, found: false, ...seeded };
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
              key, found: true, bytes: got.bytes, readable: false, ...seeded,
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
              key, found: true, bytes: got.bytes, ref: shown, ...seeded,
              note: whole
                ? `too large to return here; read it from the artifacts mount: `
                  + `read { ref: "${shown}" }`
                : `too large to return here, and too large to read back in one call; page it from `
                  + `the artifacts mount: read { ref: "${shown}", from: 0 } — each page's note gives the next`,
            };
          }
          return { key, found: true, bytes: got.bytes, updatedAt: got.updatedAt, value: got.value, ...seeded };
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
          if (body.length <= STATE_INLINE_MAX) {
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
  return plugin;
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
  /** Keys left out: the seeded paths, which are not the agent's own writing. */
  skip: ReadonlySet<string> = new Set(),
): Promise<string> {
  const parts: string[] = [];
  for (const doc of WORKING_SET) {
    if (skip.has(doc.key)) continue;
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

/** The seeded file whose text is shown in the prompt, not only named. */
export const SEEDED_MEMORY = "MEMORY.md";
/** How much of it, in characters: the working set's own `memory` budget. */
export const SEEDED_MEMORY_BUDGET = 4000;

/**
 * A code fence `text` cannot close: one backtick longer than its longest run of
 * backticks, and never shorter than three. A closing fence has to be at least
 * as long as the opening one, so nothing inside can end the block early and
 * have the rest read as the prompt's own sections. Begin and end markers made
 * of words would not do: the file can contain the same words.
 */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The lines of `text` that are not inside a code fence, read by `fenceFor`'s
 * own rule rather than a copy of it: a line beginning with a run of backticks
 * at least as long as the shortest fence (`fenceFor("")`) opens one, and only a
 * line of backticks and nothing else that the open fence is not proof against
 * (`fenceFor(line)` longer than it, i.e. at least as many backticks) closes it;
 * a fence never closed runs to the end. The fence lines themselves are dropped
 * too. Lines end at `\n`, `\r\n` or a lone `\r`.
 *
 * What the evaluation's record reads the system prompt through
 * (cf/src/fresh-context.ts `seededPathsListed`, `workingSetKeys`): `MEMORY.md`
 * is shown inside a fence and the agent can write it, so a line in it shaped
 * like the prompt's own would otherwise be counted as the prompt saying it.
 */
export function unfencedLines(text: string): string[] {
  const out: string[] = [];
  const shortest = fenceFor("").length;
  let open = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (open) {
      if (/^`+$/.test(line) && fenceFor(line).length > open) open = 0;
      continue;
    }
    const run = /^`+/.exec(line)?.[0].length ?? 0;
    if (run >= shortest) { open = run; continue; }
    out.push(line);
  }
  return out;
}

/**
 * The sizes a seeded path's line can give, each from a number written as
 * digits: the working copy's now, the setup's when the copy is in object
 * storage, or none because it was removed. One table, read by `seedLine` to
 * write a line and by `isSeedLine` to recognise one.
 */
const SEED_SIZES = {
  now: (n: string) => `${n} bytes`,
  setup: (n: string) => `${n} bytes at setup, kept in object storage`,
  removed: (_n: string) => "removed",
} as const;

/**
 * The start of the line the setup block gives a seeded path: the heading over
 * `MEMORY.md`'s text, or an item in the list of the others. Everything after it
 * is prose for the model and free to change; this part is what the
 * evaluation's record recognises (`isSeedLine`), so it is written only here.
 */
export function seedLine(path: string, size: string, mode: SeedMode): string {
  return `${path === SEEDED_MEMORY ? "## " : "- "}\`${path}\` (${size}, ${mode})`;
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `line` is the setup block's line for `path`: what `seedLine` writes
 * for it, with any size `SEED_SIZES` can give and either mode. Built from those
 * two, so a change to the line's shape is a change to what is recognised.
 */
export function isSeedLine(line: string, path: string): boolean {
  const SIZE = "\u0000size\u0000", MODE = "\u0000mode\u0000", N = "\u0000n\u0000";
  const sizes = Object.values(SEED_SIZES).map((f) => escapeRe(f(N)).replace(escapeRe(N), "\\d+"));
  const pattern = escapeRe(seedLine(path, SIZE, MODE as SeedMode))
    .replace(escapeRe(SIZE), `(?:${sizes.join("|")})`)
    .replace(escapeRe(MODE), `(?:${(["writable", "readonly"] satisfies SeedMode[]).join("|")})`);
  return new RegExp(`^${pattern}`).test(line);
}

/**
 * A working copy's size as the setup counted the file: UTF-8 bytes of its
 * text, so an unedited copy reads the same number as its manifest entry (the
 * binary-payload exception in AGENTS.md's convention, as in seed-files.ts).
 * Null when the value is not in the row; it is not fetched.
 */
function utf8Bytes(value: Json | undefined): number | null {
  if (value == null) return null;
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

/**
 * The files an evaluation's setup put in the workspace (src/store/seed-files.ts),
 * as the agent is shown them when the harness opens: `MEMORY.md`'s working copy
 * in full up to a budget, fenced, then every other seeded path with its working
 * copy's size now and its mode. Empty when nothing was seeded, so the prompt of
 * an agent without seeds is the prompt it always had. `files` is the seed list
 * when the caller has already read it.
 *
 * Read from the working copies, never the snapshot: what the agent is told is
 * what its `get` would answer, so a file it removed is said to be removed. A
 * working copy kept in object storage is not fetched — opening the harness
 * does not wait on a bucket — so its size is the one the setup recorded, said
 * to be that, and the agent is told to `get` it.
 *
 * Never "written by you", which is how the working set below begins: the
 * agent did not write these, and a model told it did will defend their
 * content as its own conclusion.
 *
 * A path is printed exactly as stored, in the line `seedLine` makes for it,
 * since the evaluation's record counts a seeded path as listed only where a
 * line `isSeedLine` recognises names it (cf/src/fresh-context.ts
 * `seededPathsListed`, which skips fenced text by `unfencedLines`); a mention
 * elsewhere, in the fenced file included, is not a listing.
 * It is operator text becoming prompt text, so one that fails the key rule —
 * which no setup route lets through, as the rule has no room for a newline, a
 * backtick or any control character — is not printed at all, only counted.
 */
export async function seededFiles(
  store: StorageAdapter, tenantId: string, agentId: string, files?: readonly SeedFileMeta[],
): Promise<string> {
  files ??= await store.listSeedFiles(tenantId, agentId);
  if (!files.length) return "";
  const alias = (await store.findMountsByPlugin(tenantId, agentId, PLUGIN_ID))[0]?.alias;
  // Named the way the working set names its tools: the tool, on the mount.
  const getTool = alias ? `the \`get\` tool on the \`${alias}\` mount` : null;
  const shown = files.filter((f) => STATE_KEY.test(f.path));
  const hidden = files.length - shown.length;
  const sizeOf = (f: SeedFileMeta, got: { value: Json; ref: string | null } | null) => {
    if (!got) return SEED_SIZES.removed("");
    const now = utf8Bytes(got.value);
    return now === null ? SEED_SIZES.setup(String(f.bytes)) : SEED_SIZES.now(String(now));
  };
  const parts: string[] = [
    "# Workspace files provided at setup\n" +
    "These files were put in your workspace when it was set up, before your first task. Each is a key in your " +
    "state store, named by its path. " +
    (getTool
      ? `Open one with ${getTool}, its path as the \`key\`.`
      : "You have no tool mounted for opening them."),
  ];
  const memory = shown.find((f) => f.path === SEEDED_MEMORY);
  if (memory) {
    const mode = seedModeOf(memory);
    const got = await store.getState(tenantId, agentId, memory.path);
    const what = mode === "writable"
      ? "A working file handed to you to maintain."
      : "Provided as read-only: you can read it but not change or remove it.";
    let body: string;
    if (!got) {
      body = "It has since been removed from your workspace.";
    } else if (got.ref && got.value == null) {
      body = `${what} It is too large to show here and is kept in object storage; ` +
        (getTool ? `read it with ${getTool}.` : "you have no tool mounted for reading it.");
    } else {
      const text = typeof got.value === "string" ? got.value : JSON.stringify(got.value);
      let kept = text;
      let cut = "";
      if (text.length > SEEDED_MEMORY_BUDGET) {
        // Not between the two halves of a surrogate pair.
        const end = /[\uD800-\uDBFF]/.test(text[SEEDED_MEMORY_BUDGET - 1]!) ? SEEDED_MEMORY_BUDGET - 1 : SEEDED_MEMORY_BUDGET;
        kept = text.slice(0, end);
        cut = `\n… cut at ${end} of ${text.length} characters; ` +
          (getTool ? `get \`${SEEDED_MEMORY}\` with ${getTool} for the rest.` : "the rest is not shown.");
      }
      kept = kept.trimEnd();
      const fence = fenceFor(kept);
      // The cut line is outside the fence: it is the prompt speaking, not the file.
      body = `${what} Its current content is the text inside the fence below:\n\n` +
        `${fence}\n${kept}\n${fence}${cut}`;
    }
    parts.push(`${seedLine(memory.path, sizeOf(memory, got), mode)}\n${body}`);
  }
  const others = shown.filter((f) => f !== memory);
  const lines: string[] = [];
  for (const f of others) {
    const mode = seedModeOf(f);
    const got = await store.getState(tenantId, agentId, f.path);
    const how = !got
      ? (mode === "writable"
        ? "handed to you to maintain, and since removed from your workspace"
        : "provided as read-only, and no longer in your workspace")
      : mode === "writable"
        ? "a working file handed to you to maintain; " +
          (getTool ? `open it with ${getTool}` : "you have no tool mounted for opening it")
        : (getTool ? `it can be read with ${getTool}` : "it can be read") + " but not changed or removed";
    lines.push(`${seedLine(f.path, sizeOf(f, got), mode)}: ${how}.`);
  }
  if (hidden) lines.push(`- and ${hidden} more whose ${hidden === 1 ? "name" : "names"} cannot be shown here.`);
  if (lines.length) parts.push((memory ? "## Other files\n" : "") + lines.join("\n"));
  return "\n\n" + parts.join("\n\n");
}
