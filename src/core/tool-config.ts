/**
 * What an evaluation asked an agent's tools to be when it was provisioned (`POST /provision/agents` with `mounts` or
 * `harness`, behind EVAL_SEED_ROUTES; docs/agent-surface.md "Evaluation setup (preview only)"). Kept on the agent's
 * record as `toolConfig` and read from there by the step that builds a turn's tools (`#turnTools`, cf/src/runtime.ts),
 * by provisioning (cf/src/provision/steps.ts), and by the seed manifest's hash (src/store/seed-files.ts) — one copy,
 * so the tools a turn offers and the manifest an evaluator verifies cannot describe two different agents. The seal
 * keeps its own copy, the one its hash was computed with (src/store/seed-files.ts `sealSeedFiles`).
 *
 * Always in its canonical form (`canonicalToolConfig`): a mount list is a set, so it is kept sorted, and two agents
 * asked for the same mounts in another order are recorded, compared and hashed alike.
 *
 * Absent means today's agent: the catalogue's mounts, reconciled as the catalogue grows, and the harness's own tools.
 * Compiled by both typecheck programs, so it uses nothing that exists in only one runtime.
 */

/** `minimal`: the harness offers no run_js, no resume and no jobs. `default`: what every agent is offered. */
export type HarnessMode = "default" | "minimal";

export interface ToolConfig {
  /** The catalogue aliases this agent was given, raft aside (provisioning always adds it), sorted; null: the catalogue's. */
  mounts: string[] | null;
  harness: HarnessMode;
}

/** The agent's `toolConfig`, or null when it has none (or one this build cannot read, which no path writes). */
export function toolConfigOf(config: unknown): ToolConfig | null {
  const t = (config as { toolConfig?: unknown } | null | undefined)?.toolConfig;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const { mounts, harness } = t as Record<string, unknown>;
  const list = Array.isArray(mounts) && mounts.every((m) => typeof m === "string") ? [...mounts] as string[] : null;
  if (mounts !== null && list === null) return null;
  if (harness !== "default" && harness !== "minimal") return null;
  return canonicalToolConfig({ mounts: list, harness });
}

/** The one form a tool choice is kept in: the mount list sorted (by code unit, as `canonJson` orders keys). */
export function canonicalToolConfig(t: ToolConfig): ToolConfig {
  return { mounts: t.mounts === null ? null : [...t.mounts].sort(), harness: t.harness };
}

/** Whether two answers ask for the same tools. Compared canonically, so a mount list's order is not the agent's. */
export function sameToolConfig(a: ToolConfig | null, b: ToolConfig | null): boolean {
  const key = (t: ToolConfig | null) => JSON.stringify(t === null ? null : canonicalToolConfig(t));
  return key(a) === key(b);
}
