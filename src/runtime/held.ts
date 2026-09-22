/**
 * What an agent is still holding, gathered by the kernel from what each plugin
 * declares — and the three sentences that tell it so.
 *
 * tygg's framing (2026-09-22): *how* a thing is released is the plugin's own
 * business and its own words; *which* of its things are still unreleased is
 * general, and the plugin system should push that. Half of that was already
 * true — the runtime decided when to release and the plugin decided how — and
 * the missing half was the middle: "what are you holding right now" was said
 * half by the sandbox inside its own tool results and half by the kernel using
 * the sandbox's nouns ("container", the literals `release` and `quiet`).
 *
 * So nothing here knows what a container is. It asks `holds.activity()` what
 * is alive, `holds.tools` what releases it, and `activity.billing` how it is
 * charged — and a second plugin that holds something gets all three sentences
 * without touching this file.
 */
import type { Holding, MountActivity, Plugin } from "../plugins/types.ts";

/** One thing an agent is holding, with everything the three sentences need. */
export interface Held {
  alias: string;
  live: NonNullable<MountActivity["live"]>;
  quietUntil: number | null;
  /** The plugin's own sentence about the cost, when it has one. */
  billing: string | null;
  tools: Holding["tools"];
}

/**
 * Every mount of this agent that is holding something, by asking the plugins.
 *
 * `activityOf` is passed in rather than a gateway, because the answer has to
 * come through the same path a mounted call takes (the credential is resolved
 * there, and `activity` is documented as needing none) and because a function
 * is what a test can supply. Mounts whose plugin declares no `holds` are not
 * asked: not holding anything is the whole of what they have to say.
 */
export async function heldResources(
  mounts: readonly { alias: string; plugin: string }[],
  plugins: readonly Plugin[],
  activityOf: (alias: string) => Promise<MountActivity>,
): Promise<Held[]> {
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const out: Held[] = [];
  for (const mount of mounts) {
    const holds = byId.get(mount.plugin)?.holds;
    if (!holds) continue;
    const activity = await activityOf(mount.alias);
    // Nothing alive is not something to tell an agent about; it is the answer
    // to a question nobody asked.
    if (!activity.live) continue;
    out.push({
      alias: mount.alias,
      live: activity.live,
      quietUntil: activity.quietUntil ?? null,
      billing: activity.billing ?? null,
      tools: holds.tools,
    });
  }
  return out;
}

/** How the runtime names a mount's tool to the model, or null when it is not offered. */
export type NameOf = (alias: string, tool: string) => string | null;

/**
 * The paragraph a session opens with: what you are already holding.
 *
 * It exists because `release` is scoped to the AGENT, not to a task, so a new
 * session inherits whatever the last one left alive — and nothing told it.
 *
 * **Only facts that do not move while the session is open.** This lands in the
 * system prompt, which the provider caches as a prefix and which is rebuilt on
 * every `open`, so a number that ticks would invalidate that prefix once per
 * open (@Rex found the boundary, @cody set the rule, 2026-09-22). Which mount,
 * which live id, since when, and what the tools are called: all fixed for as
 * long as the thing is held. How long it has been idle and how long is left
 * appear in the two message-side sentences below instead.
 */
export function heldPrompt(held: readonly Held[], nameOf: NameOf): string | null {
  if (!held.length) return null;
  const lines = held.map((h) => {
    const release = nameOf(h.alias, h.tools.release);
    const postpone = h.tools.postpone ? nameOf(h.alias, h.tools.postpone) : null;
    const since = new Date(h.live.startedAt).toISOString().slice(11, 16);
    const how = [
      release ? `\`${release}\` lets it go` : null,
      postpone ? `\`${postpone}\` keeps it longer` : null,
    ].filter(Boolean).join("; ");
    return `- \`${h.alias}\`: ${h.live.id}, held since ${since} UTC${h.billing ? ` — ${h.billing}` : ""}.`
      + (how ? ` ${how}.` : "");
  });
  return `You are already holding these, from before this session began:\n${lines.join("\n")}`;
}

/**
 * The line appended after a tool result on a mount that is holding something.
 *
 * Replaces the generic half of what the sandbox used to put in its own result
 * (`reminder`): that half was the same sentence for anything that holds a
 * resource, and it was written by one plugin. The half that is genuinely the
 * plugin's — what survives a release, what `/tmp` does, the lease's terms —
 * stays in its tool descriptions, where it is said every turn rather than once.
 */
export function heldLine(h: Held, nameOf: NameOf, now: number): string {
  const release = nameOf(h.alias, h.tools.release);
  const idleMin = Math.max(0, Math.round((now - h.live.lastUsedAt) / 60_000));
  const idle = idleMin >= 1 ? `, idle ${idleMin} minute${idleMin === 1 ? "" : "s"}` : "";
  return `[${h.alias} is still holding ${h.live.id}${idle}${h.billing ? `; ${h.billing}` : ""}.`
    + (release ? ` Call \`${release}\` when you are done with it.]` : "]");
}

/**
 * The key `heldLine` is attached under, on the result the model reads.
 *
 * A key on the result rather than a field on `ToolResult`, because the model
 * only ever sees the result, and because the line has to survive the two paths
 * a large result takes (parked as a reference, or truncated) — both of which
 * replace the result with a wrapper of their own, so the note is attached after
 * that decision, not before it.
 */
export const HELD_KEY = "holding";

/**
 * A result with the holding line attached, or the result unchanged when there
 * is nowhere to put it.
 *
 * Nowhere means a result that is not a JSON object: an array or a bare string
 * has no key to add, and wrapping it would change the shape the tool's own
 * description promised. `Holding` requires object results for exactly this
 * reason, so the unchanged branch is the contract being broken rather than a
 * case to design for — but it returns the result rather than throwing, because
 * losing a reminder is better than losing the work the call just did.
 */
export function withHeldNote(result: unknown, line: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), [HELD_KEY]: line };
}
