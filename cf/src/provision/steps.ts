/**
 * The provisioning steps that run inside the agent's own object (raft-agent-provider.v1): what the
 * handler's `adopt` and `tool` mean on an AgentRuntime. Kept out of the DO class so
 * test/provision-runtime.ts can drive them through a real runtime, gateway and store.
 */
import type { Json } from "../../../src/core/types.ts";
import type { AgentRuntime } from "../runtime.ts";
import { planBinding } from "../model-request.ts";
import type { ModelChoice } from "../../../src/model/providers.ts";
import { PUSH_KEY, PUSH_STORE, raftPlugin } from "../../../src/plugins/raft.ts";
import type { ProvisionTool, PushStatus } from "./handlers.ts";

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
  model?: ModelChoice | null,
): Promise<{ ok: true; avatar: string; modelRefused?: string } | { ok: false; error: string }> {
  await rt.ready();
  const existing = await rt.store.loadAgent(tenantId, agentId);
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const avatar = typeof config.avatar === "string" ? config.avatar : spec.avatar;
  const persona = { ...config, name: spec.name, description: spec.instructions, avatar, provisionedBy: "raft" };
  if (!existing) await rt.store.createAgent(tenantId, agentId, persona as Json);
  else await rt.store.updateAgentConfig(tenantId, agentId, persona as Json);
  // The operator's model, as the deployment's admin chose it for this agent (model_overrides); Raft's
  // contract offers no choice of its own. The same decision as every other bind (planBinding): a choice that
  // could not be read, or one the providers refuse, leaves an existing binding as it is — the refusal is
  // recorded rather than failing the adopt — and a new agent gets the default. An agent's own credential is not touched.
  const plan = planBinding(await rt.store.getModelBinding(tenantId, agentId), model, rt.operatorProviders() ?? { configs: [], secrets: {} });
  if (plan.refused) console.warn(`model choice for ${agentId} refused: ${plan.refused.slice(0, 200)}`);
  if (plan.bind) await rt.bindOperatorModel(tenantId, agentId, plan.choice);
  // The same default mounts every agent gets — memory (state), artifacts, web, GitHub, sandbox, tools — the way the
  // console and the Agents API seed them. Missed on the first cut: Ant2 on staging had the raft mount and nothing
  // else, so the agent truthfully said it had no memory. Idempotent: adds only what is missing.
  await rt.provision(tenantId, agentId);
  // The raft plugin is not seeded for every agent; this agent has chosen it, the way a person would in the console.
  await rt.store.setPluginChoice(tenantId, agentId, "raft", "enable");
  const mount = await rt.addMount(tenantId, agentId, { alias: PROVISION_MOUNT_ALIAS, plugin: "raft", config: { serverUrl: spec.raftOrigin } });
  if (!mount.ok) return mount;
  return { ok: true, avatar, ...(plan.refused ? { modelRefused: plan.refused } : {}) };
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

/**
 * The push state the raft plugin keeps on its mount, projected for the provider. Read from the rows
 * so a Raft poll leaves no trace row, no usage row and no Agent Activity event behind; under the raft
 * plugin's id, because a database is filed by plugin and the alias alone names nothing.
 */
export async function provisionPushStatus(rt: AgentRuntime, tenantId: string, agentId: string): Promise<PushStatus | null> {
  await rt.ready();
  const raw = rt.store.pluginDb.get({ tenantId, agentId, alias: PROVISION_MOUNT_ALIAS, plugin: raftPlugin.id }, PUSH_STORE, PUSH_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const reached = s.lastReached && typeof s.lastReached === "object" ? s.lastReached as Record<string, unknown> : null;
  return {
    enabled: s.enabled === true,
    registration: s.registration === "active" || s.registration === "uncertain" ? s.registration : null,
    lastReached: reached && typeof reached.deliveryId === "string" && typeof reached.at === "number"
      ? { deliveryId: reached.deliveryId, at: new Date(reached.at).toISOString() } : null,
  };
}
