/**
 * The models an agent's owner may pick for their own agent: deployment configuration, one `USER_MODELS` var
 * (a JSON array of `{ id, label, provider, model }`), checked against the deployment's providers
 * (src/model/providers.ts) the way MODEL_PROVIDERS is checked on its own. An owner names an option by its
 * `id`, never a provider or a model: what an id stands for is the operator's to say and to change, so an
 * owner cannot reach a model, a provider or a spend the deployment did not list.
 *
 * Absent (or empty) is no options, and the feature is off: the owner's route lists nothing and accepts
 * only `default`. A declaration that is refused is no options as well, with the reason kept for the admin
 * (`/admin/models`), for the same reason MODEL_PROVIDERS keeps its own: the Worker still opens, and an
 * owner's stored choice falls through to what the deployment would bind anyway.
 */
import { modelProblem, providerStatus, type ModelChoice, type ModelProviders } from "./providers.ts";

export interface UserModel { id: string; label: string; provider: string; model: string }

/** The options a deployment declares and can serve now, or why the declaration was refused. */
export interface UserModels {
  /**
   * The options whose provider is available — its secrets set — in declaration order. A declared option
   * whose provider is not is left out rather than offered: picking it would only fail at the call, and a
   * stored pick of it falls through (cf/src/model-request.ts resolveModel) until the secret is set.
   */
  offered: UserModel[];
  error?: string;
}

// `default` is the owner route's word for "no choice" (cf/src/agent-model.ts), so no option may be named it.
const OPTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = new Set(["default"]);

/**
 * Check a USER_MODELS value (the JSON text, or the array wrangler hands over when the var is an object)
 * against `providers` and return its entries. Throws with the first reason it is refused. Unknown fields
 * are refused rather than ignored, as MODEL_PROVIDERS refuses them: a field this does not read is a field
 * someone believed did something.
 */
export function parseUserModels(raw: unknown, providers: ModelProviders): UserModel[] {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { throw new Error("USER_MODELS is not JSON"); }
  }
  if (!Array.isArray(v)) throw new Error("USER_MODELS is an array of { id, label, provider, model }");
  const seen = new Set<string>();
  const out: UserModel[] = [];
  for (const [i, e] of v.entries()) {
    const at = `USER_MODELS[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`${at} is not an object`);
    const o = e as Record<string, unknown>;
    const extra = Object.keys(o).find((k) => !["id", "label", "provider", "model"].includes(k));
    if (extra) throw new Error(`${at} has an unknown field ${extra}`);
    if (typeof o.id !== "string" || !OPTION_ID.test(o.id) || RESERVED.has(o.id)) throw new Error(`${at}.id is a lower-case name other than "default"`);
    if (seen.has(o.id)) throw new Error(`${at}.id ${o.id} is declared twice`);
    seen.add(o.id);
    if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 60) throw new Error(`${o.id}.label is a name of 1 to 60 characters`);
    if (typeof o.provider !== "string" || typeof o.model !== "string") throw new Error(`${o.id} names a provider and that provider's model`);
    // The same check the admin's write and the call itself make, so an option that is listed is one
    // that can be bound: an undeclared provider, or a model named the wrong way for its provider.
    const problem = modelProblem(providers, { provider: o.provider, model: o.model });
    if (problem) throw new Error(`${o.id}: ${problem}`);
    out.push({ id: o.id, label: o.label, provider: o.provider, model: o.model });
  }
  return out;
}

/** The deployment's owner options, from its environment and its providers. A refused declaration is returned as `error`, not thrown. */
export function userModelsFrom(env: Record<string, unknown>, providers: ModelProviders): UserModels {
  if (env.USER_MODELS === undefined || env.USER_MODELS === "") return { offered: [] };
  let declared: UserModel[];
  try {
    declared = parseUserModels(env.USER_MODELS, providers);
  } catch (e) {
    return { offered: [], error: String((e as Error)?.message ?? e) };
  }
  const available = new Set(providerStatus(providers).filter((p) => p.available).map((p) => p.id));
  return { offered: declared.filter((o) => available.has(o.provider)) };
}

/** The offered option that names exactly this provider and model, if one does. */
export function optionFor(um: UserModels, choice: ModelChoice): UserModel | null {
  return um.offered.find((o) => o.provider === choice.provider && o.model === choice.model) ?? null;
}
