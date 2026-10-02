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
import type { ListedTools, ToolSchema, ToolSnapshot } from "../plugins/types.ts";

const SIDE_EFFECTS = new Set(["read", "write"]);
const IDEMPOTENCY = new Set(["native", "key", "none"]);

/**
 * The listed tools as a snapshot: names an agent can address, each once, with
 * the reason for every one left out.
 *
 * What the list says about a tool may only make it more conservative here: a
 * side effect or idempotency the kernel does not recognise becomes `write` and
 * `none`, and `reads` is dropped, because a remote tool claiming to be the
 * reader of parked results would be handed every large result the agent makes.
 */
export async function admitTools(listed: ListedTools, takenAt: number): Promise<ToolSnapshot> {
  const tools: ToolSchema[] = [];
  const skipped: Array<{ name: string; reason: string }> = [...(listed.skipped ?? [])];
  const seen = new Set<string>();
  for (const t of listed.tools) {
    if (typeof t?.name !== "string") {
      // Not String(): `String(undefined)` is "undefined", which passes the name rule.
      skipped.push({ name: JSON.stringify(t?.name) ?? "(none)", reason: "the server gave no usable name" });
      continue;
    }
    const name = t.name;
    if (!TOOL_SEGMENT.test(name)) {
      skipped.push({ name, reason: "not a name an agent can address: only letters, digits and _ (no dots, dashes or spaces)" });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "listed more than once; the first is kept" });
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      summary: typeof t.summary === "string" ? t.summary : "",
      parameters: t.parameters ?? { type: "object", properties: {} },
      sideEffects: SIDE_EFFECTS.has(t.sideEffects) ? t.sideEffects : "write",
      idempotency: IDEMPOTENCY.has(t.idempotency) ? t.idempotency : "none",
    });
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
