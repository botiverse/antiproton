import type { StorageAdapter } from "../core/store.ts";
import type { ModelAdapter } from "../model/types.ts";
import { OpenAiCompatibleModel } from "../model/openai-compatible.ts";
import type { SecretResolver } from "./gateway.ts";

/**
 * Which model account a call spends.
 *
 * The runtime used to take one base URL, one model name and one API key from
 * the environment, which meant every tenant spent the operator's own account.
 * That is fine for a single-tenant script and disqualifying for a shared
 * service: there is no way to bill it, no way to honour a customer's own
 * provider agreement, and no way to stop one tenant's runaway loop from
 * spending another's money.
 *
 * A binding is resolved the same way a mount is — public configuration in the
 * store, the credential behind a `secret_ref` that only the server dereferences
 * — so a key never reaches a prompt, a checkpoint or a trajectory.
 */
export interface ModelCaller {
  tenantId: string;
  agentId: string;
}

export class ModelResolver {
  #store: StorageAdapter;
  #secrets: SecretResolver;
  /** Keyed by the resolved binding, not by tenant: a re-bound key takes effect
   *  on the next call rather than whenever the cache happens to be dropped. */
  #cache = new Map<string, ModelAdapter>();

  constructor(store: StorageAdapter, secrets: SecretResolver) {
    this.#store = store;
    this.#secrets = secrets;
  }

  async resolve(caller: ModelCaller): Promise<ModelAdapter> {
    const b = await this.#store.getModelBinding(caller.tenantId, caller.agentId);
    if (!b) {
      // Fail closed. The alternative — falling back to an operator key — is how
      // a shared service ends up paying for everyone silently.
      throw new Error(
        `no model binding for ${caller.tenantId}/${caller.agentId}; ` +
        `configure one before running an agent`,
      );
    }
    if (b.provider !== "openai-compatible") {
      throw new Error(`unsupported model provider: ${b.provider}`);
    }
    const key = `${b.provider}|${b.baseUrl}|${b.model}|${b.secretRef}`;
    const hit = this.#cache.get(key);
    if (hit) return hit;

    const apiKey = await this.#secrets.resolve(b.secretRef);
    if (!apiKey) {
      throw new Error(`model credential ${b.secretRef} did not resolve for ${caller.tenantId}`);
    }
    const model = new OpenAiCompatibleModel({ baseUrl: b.baseUrl, apiKey, model: b.model });
    this.#cache.set(key, model);
    return model;
  }
}

/** Accepts either a fixed adapter or a per-caller resolver, so a single-tenant
 *  script and a shared service use the same executor. */
export type ModelSource = ModelAdapter | ((caller: ModelCaller) => Promise<ModelAdapter>);

export const asModelSource = (m: ModelSource) =>
  typeof m === "function" ? m : async () => m;
