import type { Plugin } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";

/**
 * Reading back what the gateway parked. Without this the offload in §5.4 is a
 * dead end: the agent is handed a reference it can never open.
 *
 * Projection and slicing happen host-side on purpose — the point is to keep the
 * model's context small, so returning the whole blob would defeat the offload.
 */

/**
 * Past this size a tool result is parked, for an agent that has this plugin's
 * `read` tool. It lives here because the sentence that tells the model the
 * number is here too; the runtime reads the same constant.
 */
export const PARK_BYTES = 4 * 1024;

/**
 * How much of a stored result one `read { from }` returns. Well under the line
 * at which the reader's own answer would be parked again (cf/src/runtime.ts
 * limitForCall), with room for the escaping a string inside JSON costs.
 */
export const READ_PAGE = 16 * 1024;

export function artifactsPlugin(artifacts: R2Artifacts, bucket: string): Plugin {
  return {
    id: "artifacts",
    // Without it a parked result is a reference the agent cannot open.
    defaultForAllAgents: true,
    version: "1.0.0",

    /**
     * The sentence that makes an `r2://` reference actionable.
     *
     * It lived in the framework's prompt, behind a flag the runtime computed by
     * asking whether an artifacts tool was mounted — which is the plugin's own
     * question, asked from outside. Now the paragraph exists exactly when this
     * mount does, which is the same condition without anybody having to check
     * it.
     *
     * The tool is named the way the prose elsewhere names one — this mount and
     * the bare tool on it — rather than the qualified string, which is for
     * telling the model to call something right now, not for describing what it
     * has. `ctx.alias` because an operator may have mounted this under any name
     * and a sentence about "the artifacts tool" is wrong the moment they do.
     */
    async promptContribution(ctx) {
      return `A tool result over ${PARK_BYTES / 1024} KB comes back as a summary (\`preview\`) with a \`note\` `
        + `giving the exact \`read\` call on \`${ctx.alias}\` that returns all of it; `
        + "for a large list, project only the fields you need.";
    },

    tools: [
      {
        name: "read",
        summary:
          "Read back a parked result by its r2:// reference: whole, fields/offset/limit for part of a list, "
          + "or from to page through one too large to return at once.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            from: { type: "integer", description: "character to read from, a page at a time, as the note says" },
            fields: { type: "array", items: { type: "string" }, description: "keys to keep from each array item" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["ref"],
        },
        sideEffects: "read",
        idempotency: "native",
      },
    ],
    async invoke(tool, args, ctx) {
      if (tool !== "read") throw new Error(`unknown tool: ${tool}`);
      const a = args as { ref: string; from?: number; fields?: string[]; offset?: number; limit?: number };
      const prefix = `r2://${bucket}/t/${ctx.caller.tenantId}/${ctx.caller.agentId}/`;
      // Tenant isolation is enforced on the reference itself, not on a guess
      // about who parked it.
      if (typeof a.ref !== "string" || !a.ref.startsWith(prefix)) {
        throw new Error(`reference is not readable by this agent: ${String(a.ref).slice(0, 80)}`);
      }
      const key = a.ref.slice(`r2://${bucket}/`.length);
      const raw = new TextDecoder().decode(await artifacts.get(key));
      // The continuation a cut result points at: the stored text as-is, a page
      // at a time, each page ending with the call that reads the next — the way
      // pi's own read tool continues a file (pi-coding-agent 0.83.0, dist/core/tools/read.js).
      // It reads text rather than a parsed value so that where one page ends
      // and the next begins is a number the model was given, not a guess about
      // the structure.
      if (a.from !== undefined) {
        const from = Math.max(0, Math.floor(Number(a.from)) || 0);
        let end = Math.min(from + READ_PAGE, raw.length);
        // Half a surrogate pair is not a character; the next page starts with it.
        const last = raw.charCodeAt(end - 1);
        if (end < raw.length && end - 1 > from && last >= 0xd800 && last <= 0xdbff) end--;
        const text = raw.slice(from, end);
        const to = from + text.length;
        return {
          kind: "text", bytes: raw.length, from, to, text,
          note: to < raw.length
            ? `showing characters ${from}-${to} of ${raw.length}; continue with read { ref, from: ${to} }`
            : `end of result (${raw.length} characters)`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { kind: "text", bytes: raw.length, text: raw.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 4000)) };
      }
      // `fields`, `offset` and `limit` page a list, and this tool's summary
      // promises them without conditions — as does `state.get`, which tells the
      // model to open its reference here. But a parked result is often an
      // envelope around the list rather than the list itself: `state.get` parks
      // `{key, found, bytes, updatedAt, value}`. Reading only the top level
      // dropped all three arguments without a word, so an agent that asked for
      // five items projected to one field received three hundred whole, larger
      // than what it had stored (Vera's fresh agent, 2026-09-13).
      //
      // So the page comes from the one array inside, when there is exactly one,
      // and `at` names it. Exactly one, because two would be a guess; with none
      // or several the value is returned whole and the result says the
      // arguments did not apply, which is the part that was missing — a dropped
      // argument is indistinguishable from one that did nothing.
      const pageOf = (items: unknown[]) => {
        const offset = a.offset ?? 0;
        const limit = Math.min(a.limit ?? 50, 200);
        const page = items.slice(offset, offset + limit).map((item) => {
          if (!a.fields?.length || item === null || typeof item !== "object") return item;
          return Object.fromEntries(a.fields.map((f) => [f, (item as any)[f]]));
        });
        return { total: items.length, offset, returned: page.length, items: page };
      };

      if (Array.isArray(parsed)) return { kind: "array", ...pageOf(parsed) };

      // Only descend when the caller asked to page or project. Descending is an
      // inference about what they meant, and the arguments are the only signal
      // of it; without them, returning the array alone would drop the rest of
      // the envelope — a `state.get` reference read with no arguments came back
      // as fifty items with its `key`, `bytes` and `updatedAt` gone (cody,
      // 2026-09-13). A top-level array still pages by default, as it always
      // has: there is nothing else in it to lose.
      const asked = !!a.fields?.length || a.offset !== undefined || a.limit !== undefined;
      if (!asked) return { kind: "value", value: parsed };

      const inner = parsed && typeof parsed === "object"
        ? Object.entries(parsed as Record<string, unknown>).filter(([, v]) => Array.isArray(v))
        : [];
      if (inner.length === 1) {
        const [at, items] = inner[0] as [string, unknown[]];
        return { kind: "array", at, ...pageOf(items) };
      }
      return {
        kind: "value",
        value: parsed,
        note: inner.length === 0
          ? "fields, offset and limit page an array; this artifact holds none, so it came back whole"
          : `fields, offset and limit page one array; this artifact holds ${inner.length} (${inner.map(([k]) => k).join(", ")}), so it came back whole`,
      };
    },
  };
}
