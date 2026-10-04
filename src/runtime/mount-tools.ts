/**
 * Admitting a tool list that came from outside the plugin's source.
 *
 * A plugin's own `tools` are written by its author and reviewed with it; a
 * snapshot is whatever a remote server said when it was asked. So the list is
 * admitted here, once, when it is taken — not by each reader — and what is
 * stored is already the list every reader serves. Filtering in a reader
 * instead would let the catalogue and the gateway disagree about one name:
 * offered by one, refused by the other.
 */
import { TOOL_SEGMENT } from "../core/tools.ts";
import type { ListedTools, SkippedTool, ToolSchema, ToolSnapshot } from "../plugins/types.ts";

const SIDE_EFFECTS = new Set(["read", "write"]);
const IDEMPOTENCY = new Set(["native", "key", "none"]);

/**
 * Bounds on what a server can make a mount store and offer. A snapshot is one
 * row of the mount table and is read on every harness build and every call;
 * every tool kept is also a description and a schema in every model request.
 * "Bytes" counts `String.length`, as everywhere in this repository.
 *
 * - `MAX_SNAPSHOT_TOOLS`: more than a model chooses among well in one prompt.
 * - `MAX_DESCRIPTION_BYTES` and `MAX_SCHEMA_BYTES`: generous for a real tool,
 *   and they stop one tool from taking the whole budget.
 * - `MAX_SNAPSHOT_BYTES`: the whole stored snapshot. Durable Object SQLite
 *   refuses a row over 2 MB (Cloudflare's documented limit) and counts UTF-8,
 *   where one UTF-16 unit is at most 3 bytes; 512 Ki units is at most 1.5 MB,
 *   under that limit with the rest of the row beside it.
 * - `MAX_SKIPPED`: the diagnostics are remote data too; a server listing a
 *   million bad names must not make the skipped list the oversize part.
 *
 * A tool over a bound is skipped with the reason, never shortened: a cut
 * description or schema is a tool that means something its server did not say.
 */
export const MAX_SNAPSHOT_TOOLS = 128;
export const MAX_DESCRIPTION_BYTES = 2 * 1024;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
export const MAX_SKIPPED = 32;
const MAX_SKIPPED_NAME = 80;

/**
 * The listed tools as a snapshot: names an agent can address, each once,
 * within the bounds above, with the reason for every one left out.
 *
 * What the list says about a tool may only make it more conservative here: a
 * side effect or idempotency the kernel does not recognise becomes `write` and
 * `none`; `reads` is dropped, because a remote tool claiming to be the reader
 * of parked results would be handed every large result the agent makes; and
 * every tool is `replay: "never"`, because a remote `readOnlyHint` is a claim
 * and must not earn a silent second run (`ToolSchema.replay`).
 */
export async function admitTools(listed: ListedTools, takenAt: number): Promise<ToolSnapshot> {
  const tools: ToolSchema[] = [];
  const skippedAll: SkippedTool[] = [...(listed.skipped ?? [])];
  const skip = (name: string, reason: string) => skippedAll.push({ name, reason });
  const seen = new Set<string>();
  let bytes = 0;
  for (const t of listed.tools) {
    if (typeof t?.name !== "string") {
      // Not String(): `String(undefined)` is "undefined", which passes the name rule.
      skip(JSON.stringify(t?.name) ?? "(none)", "the server gave no usable name");
      continue;
    }
    const name = t.name;
    if (!TOOL_SEGMENT.test(name)) {
      skip(name, "not a name an agent can address: only letters, digits and _ (no dots, dashes or spaces)");
      continue;
    }
    if (seen.has(name)) {
      skip(name, "listed more than once; the first is kept");
      continue;
    }
    seen.add(name);
    const tool: ToolSchema = {
      name,
      summary: typeof t.summary === "string" ? t.summary : "",
      parameters: t.parameters ?? { type: "object", properties: {} },
      sideEffects: SIDE_EFFECTS.has(t.sideEffects) ? t.sideEffects : "write",
      idempotency: IDEMPOTENCY.has(t.idempotency) ? t.idempotency : "none",
      replay: "never",
    };
    if (tool.summary.length > MAX_DESCRIPTION_BYTES) {
      skip(name, `its description is ${tool.summary.length} characters; the most a mount keeps is ${MAX_DESCRIPTION_BYTES}`);
      continue;
    }
    const schemaBytes = JSON.stringify(tool.parameters ?? null).length;
    if (schemaBytes > MAX_SCHEMA_BYTES) {
      skip(name, `its input schema is ${schemaBytes} characters; the most a mount keeps is ${MAX_SCHEMA_BYTES}`);
      continue;
    }
    if (tools.length >= MAX_SNAPSHOT_TOOLS) {
      skip(name, `the server lists more than ${MAX_SNAPSHOT_TOOLS} tools; the first ${MAX_SNAPSHOT_TOOLS} are kept`);
      continue;
    }
    const size = JSON.stringify(tool).length;
    if (bytes + size > MAX_SNAPSHOT_BYTES) {
      skip(name, `the tools before it already fill the ${MAX_SNAPSHOT_BYTES}-character budget a mount keeps`);
      continue;
    }
    bytes += size;
    tools.push(tool);
  }
  const skipped = skippedAll.slice(0, MAX_SKIPPED).map((s) => ({
    name: s.name.length > MAX_SKIPPED_NAME ? `${s.name.slice(0, MAX_SKIPPED_NAME)}…` : s.name,
    reason: s.reason,
    // Kept through admission: it says the entry is about every tool, which the explanation reads (SkippedTool).
    ...(s.every ? { every: true as const } : {}),
  }));
  if (skippedAll.length > MAX_SKIPPED) {
    skipped.push({ name: `(${skippedAll.length - MAX_SKIPPED} more)`, reason: "not listed one by one; the reasons above are the kinds" });
  }
  return { hash: await snapshotHash(tools, skipped), tools, skipped, takenAt };
}

/** SHA-256 of what a snapshot says, hex. `takenAt` is left out, so asking twice and hearing the same is no change. */
export async function snapshotHash(tools: ToolSchema[], skipped: ToolSnapshot["skipped"]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ tools, skipped }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One line per tool left out of a mount's snapshot, for a page or a `mounts` answer. Empty when nothing was. */
export function skippedToolNotes(snapshot: ToolSnapshot | null | undefined): string[] {
  return (snapshot?.skipped ?? []).map((s) => `remote tool "${s.name}" is not offered: ${s.reason}`);
}
