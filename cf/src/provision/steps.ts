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
import type { Fail, ProvisionTool, PushStatus } from "./handlers.ts";
import { sameToolConfig, toolConfigOf, type ToolConfig } from "../../../src/core/tool-config.ts";
import { interruptsOf } from "../../../src/plugins/types.ts";

/** The alias the provisioned mount carries: the plugin's own name, as a person would pick. */
export const PROVISION_MOUNT_ALIAS = "raft";
/**
 * What the agent's record says made it (`provisionedBy`). Written before the default mounts are seeded, and on
 * every agent Raft has made, so a seed that is not for a Raft-hosted agent can be told from the record alone
 * (`agentKind` and a catalogue row's `for`, cf/src/runtime.ts).
 */
export const PROVISIONED_BY = "raft";
/** The task the push tools run under when the provider, not the model, calls them. */
export const PROVISION_TASK = "provision";
/** The home the provisioned agents are listed under, so the console can find them. */
export const PROVIDER_HOME = "u-raft-provider";

/**
 * Why this deployment cannot give an agent `toolConfig`, or null. Asked of the agent's object, before anything is
 * written, because only it knows its plugins: a named mount whose plugin cannot run here (`unavailable`) would
 * otherwise be skipped by `provision` without a word, and the agent would be one tool short of what was asked.
 *
 * Under `minimal` there is no `resume`, so a tool's question cannot be answered: the harness drops it and tells the
 * model nothing was done and to call again if it still applies (`toolQuestion`, src/runtime/pi-tools.ts). A mount
 * whose plugin asks questions is refused here rather than given that changed flow. `raft` is the exception, and is
 * always mounted: its only question is a held send or task write when newer messages arrived, a model's own call
 * records those messages as seen before asking, and so calling again — what the dropped question tells the model to
 * do — goes ahead (src/plugins/raft.ts `heldCall`). With `mounts` absent the catalogue's entries are asked the same.
 */
function toolConfigProblem(rt: AgentRuntime, t: ToolConfig): string | null {
  const catalogue = rt.catalogue().filter((m) => m.for.includes("raft"));
  const named = t.mounts === null ? catalogue.map((m) => m.alias) : t.mounts;
  for (const alias of named) {
    const entry = catalogue.find((m) => m.alias === alias);
    if (!entry) return `mounts entry "${alias}" is not a default mount for an agent Raft hosts`;
    const plugin = rt.plugins().find((p) => p.id === entry.plugin);
    if (!plugin) return `mounts entry "${alias}": its plugin ${entry.plugin} is not installed here`;
    const why = plugin.unavailable?.();
    if (why && t.mounts !== null) return `mounts entry "${alias}" cannot run on this deployment: ${why}`;
    if (t.harness === "minimal" && interruptsOf(plugin)) {
      return `mounts entry "${alias}": ${entry.plugin} asks the model questions, which need resume, and harness "minimal" offers none`;
    }
  }
  return null;
}

/**
 * The record, the model, the mount. Each step is idempotent: a second call with the same spec changes
 * nothing, a call with a new name or instructions updates the persona and leaves the rest.
 *
 * `toolConfig` (an evaluation's `mounts` and `harness`, src/core/tool-config.ts) is written into the record in the
 * same write that makes it, and never changed after: a later adopt that asks for another one, including none (a POST
 * without the fields, on an agent made minimal), is refused with 409 and writes nothing, so defaults are never
 * quietly given back to a minimal agent. Absent (`undefined`, a PATCH) asks nothing and keeps the recorded one. With a
 * mount list the agent is provisioned with exactly those catalogue entries and marked `chosen`
 * (src/store/seed-record.ts), which no reconcile passes, so the catalogue never adds to it later.
 */
export async function adoptProvisionedAgent(
  rt: AgentRuntime, tenantId: string, agentId: string,
  spec: { name: string; instructions: string; raftOrigin: string; avatar: string; toolConfig?: ToolConfig | null },
  model?: ModelChoice | null,
): Promise<{ ok: true; avatar: string; modelRefused?: string } | { ok: false; error: string; refused?: Fail }> {
  await rt.ready();
  const existing = await rt.store.loadAgent(tenantId, agentId);
  const config = (existing?.config ?? {}) as Record<string, unknown>;
  const recorded = toolConfigOf(config);
  if (spec.toolConfig !== undefined && existing && !sameToolConfig(recorded, spec.toolConfig)) {
    const say = (t: ToolConfig | null) => t === null ? "none (the default tools)" : JSON.stringify(t);
    const error = `this agent was provisioned with toolConfig ${say(recorded)}, and this request asks for ${say(spec.toolConfig)}; ` +
      "an agent's tools are fixed when it is made, so a different set needs a new agent";
    return { ok: false, error, refused: { status: 409, code: "tool_config_conflict", message: error } };
  }
  const toolConfig = spec.toolConfig === undefined ? recorded : spec.toolConfig;
  const problem = toolConfig ? toolConfigProblem(rt, toolConfig) : null;
  if (problem) return { ok: false, error: problem, refused: { status: 400, code: "invalid", message: problem, param: "mounts" } };
  const avatar = typeof config.avatar === "string" ? config.avatar : spec.avatar;
  const persona = {
    ...config, name: spec.name, description: spec.instructions, avatar, provisionedBy: PROVISIONED_BY,
    ...(toolConfig ? { toolConfig } : {}),
  };
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
  // else, so the agent truthfully said it had no memory. Idempotent: adds only what is missing. The record above
  // is written first on purpose: a seed not for an agent Raft hosts (`reminder`) is told apart by it.
  if (toolConfig?.mounts) {
    // Exactly the entries named, in the catalogue's own settings, and the agent marked so no reconcile adds to it.
    const named = new Set(toolConfig.mounts);
    await rt.provision(tenantId, agentId, rt.catalogue().filter((m) => named.has(m.alias)), { chosen: true });
  } else await rt.provision(tenantId, agentId);
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
