/**
 * The Agents API's `model` field: the owner's pick of a model for the agent, the same pick the console's picker
 * makes (`/ui/agent/model`, cf/src/agent-model.ts) and stored in the same place (0015_model_choices.sql). An
 * API key acts for the owner, so a model chosen here is the owner's choice and nothing more: an admin's agent
 * or tenant row still decides over it (cf/src/model-request.ts resolveModel), and only a model the deployment
 * offers (USER_MODELS, src/model/user-models.ts) can be chosen.
 *
 * What a caller may send:
 *
 *   "default"                  no pick: whatever the deployment runs for this agent
 *   an option's id             e.g. "gpt-5.6-luna"
 *   "<provider>/<model>"       an offered option by what it names, e.g. "cloudflare/openai/gpt-5.6-luna"
 *   the name the API answers   what the agent runs on now (below), which changes nothing
 *
 * Anything else is 400 `model_not_found`, before anything is made. A pick an admin's row would override is 409
 * `model_locked` rather than stored: kept but never run, it would be a setting accepted and ignored (shapes.ts).
 * "default" and the name of what runs now are accepted under a lock, since neither asks for something other than
 * what runs.
 *
 * What the API answers as `model` is what the agent's next turn runs on, not what was sent: the option's id
 * when an offered option names it, else "<provider>/<model>" — which is how an agent an admin moved to a model
 * no option names reads. Sending that name back changes nothing — not even an owner's pick held under an admin's
 * row — so a caller that echoes the object it read is neither refused nor has its pick cleared. The binding follows on the next input (#bindModel in
 * cf/src/index.ts), as it does for a console pick.
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
 * a create can refuse before its agent exists and write only once everything else is checked too.
 */
export async function planModel(deps: ApiModelDeps, agentId: string, requested: string, param = "model"):
  Promise<{ ok: true; stored: string; apply(): Promise<void> } | Refusal> {
  const layers = await deps.layers(agentId);
  const um = deps.userModels;
  const option: UserModel | undefined = requested === "default" ? undefined
    : um.offered.find((o) => o.id === requested || `${o.provider}/${o.model}` === requested);
  if (!option && requested !== "default") {
    // The name GET answers for this agent now: accepted, and nothing is written.
    if (requested === modelName(resolveModel(layers, um, deps.defaultModel).choice, um)) {
      return { ok: true, stored: layers.owner ?? "default", apply: async () => {} };
    }
    const names = ["default", ...um.offered.map((o) => o.id)].map((n) => JSON.stringify(n)).join(", ");
    return {
      ok: false, status: 400, param, code: "model_not_found",
      message: `The model ${JSON.stringify(requested.slice(0, 100))} is not offered by this deployment; choose one of ${names}`,
    };
  }
  if (option) {
    const now = resolveModel(layers, um, deps.defaultModel);
    if (now.locked && !(now.choice.provider === option.provider && now.choice.model === option.model)) {
      return {
        ok: false, status: 409, param, code: "model_locked",
        message: `An administrator has set this agent's model to ${JSON.stringify(modelName(now.choice, um))}, so ${JSON.stringify(option.id)} cannot be chosen; send "default" to accept it`,
      };
    }
    return { ok: true, stored: option.id, apply: () => deps.put(agentId, option.id) };
  }
  return { ok: true, stored: "default", apply: () => deps.remove(agentId) };
}
