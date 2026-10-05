/**
 * The Agents API's `model` field: the owner's pick of a model for the agent, the same pick the console's picker
 * makes (`/ui/agent/model`, cf/src/agent-model.ts) and stored in the same place (0015_model_choices.sql). An
 * API key acts for the owner, so a model chosen here is the owner's choice and nothing more: an admin's agent
 * or tenant row still decides over it (cf/src/model-request.ts resolveModel), and only a model the deployment
 * offers (USER_MODELS, src/model/user-models.ts) can be chosen.
 *
 * What a caller may send, checked in this order:
 *
 *   the name the API answers   what the agent's next turn runs on now (below): changes nothing, stores nothing
 *   the agent's legacy model   the string a record made before this field was the owner's pick holds: changes nothing
 *   "default"                  no pick: whatever the deployment runs for this agent
 *   an option's id             e.g. "gpt-5.6-luna"
 *   "<provider>/<model>"       an offered option by what it names, e.g. "cloudflare/openai/gpt-5.6-luna"
 *
 * The echoes come first so that a caller that sends back the object it read changes nothing, even when the name
 * is an option's id: an agent on the deployment's default reads as that option's id, and echoing it must not
 * pin the agent to it. To pin the model that is the default now, an owner picks it in the console's picker.
 *
 * Under an admin's agent or tenant row anything but an echo is 409 `model_locked`, "default" included — as the
 * console's picker refuses every write then: kept but never run, a pick would be a setting accepted and ignored
 * (shapes.ts). Otherwise a name that is none of the above is 400 `model_not_found`, before anything is made.
 *
 * What the API answers as `model` is what the agent's next turn runs on, not what was sent: the option's id
 * when an offered option names it, else "<provider>/<model>" — which is how an agent an admin moved to a model
 * no option names reads. The binding follows on the next input (#bindModel in cf/src/index.ts), as it does for
 * a console pick.
 *
 * Nothing here names an endpoint or a secret: a provider's id and a model's name are neither.
 */
import { resolveModel } from "../model-request.ts";
import type { ModelLayers } from "../control-plane.ts";
import { optionFor, type UserModel, type UserModels } from "../../../src/model/user-models.ts";
import type { ModelChoice } from "../../../src/model/providers.ts";

export interface ApiModelDeps {
  userModels: UserModels;
  /** The deployment's default model (HARNESS_MODEL), under DEFAULT_PROVIDER. */
  defaultModel: string;
  /** Every scope that may decide this agent's model (cf/src/control-plane.ts d1ModelChoices), in the key's tenant. */
  layers(agentId: string): Promise<ModelLayers>;
  put(agentId: string, choiceId: string): Promise<void>;
  remove(agentId: string): Promise<void>;
}

type Refusal = { ok: false; status: number; message: string; param: string; code: string };

/** The name the API gives a provider and model: an offered option's id, else `<provider>/<model>`. */
export function modelName(choice: ModelChoice, um: UserModels): string {
  return optionFor(um, choice)?.id ?? `${choice.provider}/${choice.model}`;
}

/** What the agent's next turn runs on, by the name above. */
export async function effectiveModel(deps: ApiModelDeps, agentId: string): Promise<string> {
  return modelName(resolveModel(await deps.layers(agentId), deps.userModels, deps.defaultModel).choice, deps.userModels);
}

/**
 * Check `requested` for `agentId` and say what accepting it writes, without writing. Separate from the write so
 * a create can refuse before its agent exists and write only once its index row is in. `previous` is what the
 * agent's record held before this request (StoredAgent.model), absent on a create.
 */
export async function planModel(deps: ApiModelDeps, agentId: string, requested: string, param = "model", previous?: string):
  Promise<{ ok: true; stored: string; apply(): Promise<void> } | Refusal> {
  const layers = await deps.layers(agentId);
  const um = deps.userModels;
  const now = resolveModel(layers, um, deps.defaultModel);
  const unchanged = { ok: true as const, stored: previous ?? "default", apply: async () => {} };
  // Echoes first, before any option is looked up: the name the API answers for this agent now changes nothing,
  // even when it is an option's id. Matched as a pick it would pin the agent to the deployment's default, or
  // overwrite an owner's pick held under an admin's row with the admin's model.
  if (requested === modelName(now.choice, um)) return unchanged;
  // A record from before `model` was the owner's pick may hold any string. Sending it back (a client that read
  // the agent then and edits it now) changes nothing either; only such a string — not "default", not an
  // offered option, which mean what they say.
  if (previous !== undefined && requested === previous && previous !== "default" && !offeredBy(um, previous)) return unchanged;
  if (now.locked) {
    // As the console's picker (cf/src/agent-model.ts): under an admin's row no write — not even clearing the
    // pick — would change what runs, so none is taken.
    return {
      ok: false, status: 409, param, code: "model_locked",
      message: `An administrator has set this agent's model to ${JSON.stringify(modelName(now.choice, um))}, so the model cannot be changed; send that name, or leave model out`,
    };
  }
  if (requested === "default") return { ok: true, stored: "default", apply: () => deps.remove(agentId) };
  const option = offeredBy(um, requested);
  if (!option) {
    const names = ["default", ...um.offered.map((o) => o.id)].map((n) => JSON.stringify(n)).join(", ");
    return {
      ok: false, status: 400, param, code: "model_not_found",
      message: `The model ${JSON.stringify(requested.slice(0, 100))} is not offered by this deployment; choose one of ${names}`,
    };
  }
  return { ok: true, stored: option.id, apply: () => deps.put(agentId, option.id) };
}

function offeredBy(um: UserModels, name: string): UserModel | undefined {
  return um.offered.find((o) => o.id === name || `${o.provider}/${o.model}` === name);
}
