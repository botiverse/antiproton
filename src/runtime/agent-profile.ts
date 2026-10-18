/**
 * An agent made for one job rather than for conversation: chosen when the agent is provisioned
 * (`POST /provision/agents` with `profile`, docs/agent-surface.md), kept on the agent's record as `profile`, and never
 * changed after (cf/src/provision/steps.ts).
 *
 * A profile decides four things the default agent leaves to its catalogue and its deployment, each where it is used:
 * - **the mounts and harness**: `toolConfig` below, recorded with the profile, so the paths that already honour an
 *   agent's own tool choice (no catalogue reconcile, no run_js, resume, jobs or subagents) honour it here too, plus
 *   the profile's own mount beside `raft`;
 * - **the tools the model is offered**: none (`#turnTools`, cf/src/runtime.ts). The mounts are there for the plugin's
 *   code and for provisioning, not for the model;
 * - **each model call's output cap** (`maxTokens`), marked on every job the agent's model is asked (`takeJob`);
 * - **the system prompt**: the profile's plugin's instructions, alone (`profilePrompt`, src/runtime/pi-prompt.ts) —
 *   not the default prompt, the persona, or any mount's paragraph.
 *
 * And one that follows from the prompt: an event a service pushes at the agent is a `wake` for the profile's
 * plugin, never a message to the model (`#deliverInbound`, cf/src/runtime.ts).
 *
 * Compiled by both typecheck programs.
 */
import type { ToolConfig } from "../core/tool-config.ts";
import { RAFTBENCH_INSTRUCTIONS, RAFTBENCH_MAX_TOKENS } from "../plugins/raftbench.ts";

export interface ProfileSpec {
  /** The plugin whose code drives the agent, and the alias it is mounted under. */
  plugin: string;
  alias: string;
  /** The whole system prompt. */
  instructions: string;
  toolConfig: ToolConfig;
  /** The output cap of every model call the agent makes (`AgentRuntime.takeJob` marks each job with it). */
  maxTokens: number;
}

export const AGENT_PROFILES = {
  raftbench_service: {
    plugin: "raftbench", alias: "raftbench", instructions: RAFTBENCH_INSTRUCTIONS,
    toolConfig: { mounts: [], harness: "minimal" }, maxTokens: RAFTBENCH_MAX_TOKENS,
  },
} as const satisfies Record<string, ProfileSpec>;

export type AgentProfile = keyof typeof AGENT_PROFILES;

export function isAgentProfile(value: unknown): value is AgentProfile {
  return typeof value === "string" && Object.hasOwn(AGENT_PROFILES, value);
}

/** The profile an agent's record names, or null for every other agent. */
export function profileOf(config: unknown): AgentProfile | null {
  const p = (config as { profile?: unknown } | null | undefined)?.profile;
  return isAgentProfile(p) ? p : null;
}

export function profileSpec(profile: AgentProfile): ProfileSpec {
  const s = AGENT_PROFILES[profile];
  return {
    plugin: s.plugin, alias: s.alias, instructions: s.instructions, maxTokens: s.maxTokens,
    toolConfig: { mounts: [...s.toolConfig.mounts], harness: s.toolConfig.harness },
  };
}
