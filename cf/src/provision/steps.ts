/**
 * The provisioning steps that run inside the agent's own object (raft-agent-provider.v1): what the
 * handler's `adopt` and `tool` mean on an AgentRuntime. Kept out of the DO class so
 * test/provision-runtime.ts can drive them through a real runtime, gateway and store.
 */
import type { Json } from "../../../src/core/types.ts";
import type { AgentRuntime } from "../runtime.ts";
import type { ProvisionTool } from "./handlers.ts";

/** The alias the provisioned mount carries: the plugin's own name, as a person would pick. */
export const PROVISION_MOUNT_ALIAS = "raft";
/** The task the push tools run under when the provider, not the model, calls them. */
export const PROVISION_TASK = "provision";
/** The home the provisioned agents are listed under, so the console can find them. */
export const PROVIDER_HOME = "u-raft-provider";

/**
 * The record, the model, the mount. Each step is idempotent: a second call with the same spec changes
 * nothing, a call with a new name or instructions updates the persona and leaves the rest.
 */
export async function adoptProvisionedAgent(
  rt: AgentRuntime, tenantId: string, agentId: string,
  spec: { name: string; instructions: string; raftOrigin: string; avatar: string },
): Promise<{ ok: true; avatar: string } | { ok: false; error: string }> {
  await rt.ready();
  const existing = await rt.store.loadAgent(tenantId, agentId);
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const avatar = typeof config.avatar === "string" ? config.avatar : spec.avatar;
  const persona = { ...config, name: spec.name, description: spec.instructions, avatar, provisionedBy: "raft" };
  if (!existing) await rt.store.createAgent(tenantId, agentId, persona as Json);
  else await rt.store.updateAgentConfig(tenantId, agentId, persona as Json);
  // The deployment's model; a caller-chosen one was checked against the offered list by the handler.
  await rt.bindOperatorModel(tenantId, agentId);
  // The plugin is not seeded for every agent; this agent has chosen it, the way a person would in the console.
  await rt.store.setPluginChoice(tenantId, agentId, "raft", "enable");
  const mount = await rt.addMount(tenantId, agentId, { alias: PROVISION_MOUNT_ALIAS, plugin: "raft", config: { serverUrl: spec.raftOrigin } });
  if (!mount.ok) return mount;
  return { ok: true, avatar };
}

/** One of the raft plugin's push tools, through the gateway, as the model would call it. */
export async function provisionTool(
  rt: AgentRuntime, tenantId: string, agentId: string, name: ProvisionTool,
): Promise<{ ok: true; result: Json } | { ok: false; error: string }> {
  await rt.ready();
  const r = await rt.gateway().invoke({ tenantId, agentId, taskId: PROVISION_TASK }, `${PROVISION_MOUNT_ALIAS}.${name}`, {});
  if (r.status === "succeeded") return { ok: true, result: r.result };
  const err = "error" in r ? r.error : undefined;
  const message = err === undefined ? r.status
    : typeof err === "string" ? err
    : typeof (err as { message?: unknown }).message === "string" ? String((err as { message: string }).message)
    : JSON.stringify(err);
  return { ok: false, error: `${name}: ${message}` };
}
