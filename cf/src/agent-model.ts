/**
 * `/ui/agent/model`: the model an owner picks for their own agent, from the options the deployment lists
 * (USER_MODELS, src/model/user-models.ts), stored apart from the admin's rows (0015_model_choices.sql). The
 * caller has already been found to own the agent — the console's gate in cf/src/index.ts answers 404 for an
 * agent that is not the viewer's — and this decides nothing about who.
 *
 *   GET                       → the state below
 *   POST agentId, choice      → the state below, after the pick; `choice` is an option's id, or `default` to clear it
 *
 *   { effective: { label, provider, model, source: "default" | "owner" | "admin" },
 *     options: [{ id, label }], selected: id | null, locked: boolean }
 *
 * JSON from this module; the route in cf/src/index.ts renders agentModelBlock when the request
 * carries hx-request, so the same answer is a panel for the picker and data for anything else. The
 * form body is the console's other writes' shape, so a plain form post works too. `selected` is the
 * stored pick only while it is offered; a pick whose option is gone reads as null, the way it binds.
 * `locked`: an admin's agent or tenant row decides this agent, and a new pick is refused with 409
 * rather than stored to no effect — a pick that is kept but never runs would read, to the owner,
 * as one that does.
 *
 * Nothing here names an endpoint, a gateway or a secret: an option is an id and a label, and the effective
 * model is a provider's id and a model's name, neither of them an address or a credential.
 *
 * A stored pick is bound at once: the route in cf/src/index.ts asks the agent's object to rebind
 * (AgentDO.rebindModel, #bindModel with resolveModel deciding what is current), so the agent's next model call
 * runs on it whatever starts the turn.
 */
import type { ModelChoices } from "./control-plane.ts";
import { resolveModel } from "./model-request.ts";
import { optionFor, type UserModels } from "../../src/model/user-models.ts";
import { enabledUserKeyProviders, userChoiceProblem, userKeyOffProblem, userKeyProblem } from "../../src/model/user-key.ts";

/** What the card says about the owner's own key (`AgentRuntime.modelKeyState`): never the key. */
export interface OwnKeyState { provider: string; label: string; model: string; storedAt: string | null; refusedAt: string | null }

export interface AgentModelDeps {
  choices: ModelChoices;
  userModels: UserModels;
  /** The deployment's default model (HARNESS_MODEL), under DEFAULT_PROVIDER. */
  defaultModel: string;
  now(): number;
  /** The agent's own-key binding, when it has one; absent where the route does not ask. */
  ownKey?(): Promise<OwnKeyState | null>;
  /** This deployment's USER_KEY_PROVIDERS setting (`enabledUserKeyProviders`); absent is none offered. */
  userKeyProviders?: unknown;
}

export async function agentModel(
  method: string, form: FormData | null,
  who: { tenantId: string; agentId: string; actor: string },
  deps: AgentModelDeps,
): Promise<Response> {
  if (method === "POST") {
    if (!form) return refuse(400, "invalid", "expected a form body");
    const choice = String(form.get("choice") ?? "").trim();
    if (!choice) return refuse(422, "invalid", "choice is an option's id, or default");
    // Locked first: while an admin's row decides this agent, no pick — not even clearing one — would change
    // what runs, and saying "stored" would claim it does.
    const now = resolveModel(await deps.choices.layers(who.tenantId, who.agentId), deps.userModels, deps.defaultModel);
    if (now.locked) return refuse(409, "locked", "an administrator has set this agent's model, so it cannot be chosen here");
    // On the owner's own key, no pick here would run (planBinding never moves that binding): said rather than stored.
    if (await deps.ownKey?.()) return refuse(409, "own_key", "this agent runs on your own model key; remove the key to choose one of the deployment's models");
    if (choice === "default") {
      await deps.choices.remove(who.tenantId, who.agentId);
    } else {
      // Only an id the deployment offers now: an id that was listed once, or whose provider has no secret,
      // would be stored and then passed over at every run.
      if (!deps.userModels.offered.some((o) => o.id === choice)) return refuse(422, "unknown_choice", `no model option ${JSON.stringify(choice.slice(0, 64))} is offered here`);
      await deps.choices.put({ tenantId: who.tenantId, agentId: who.agentId, choiceId: choice, setBy: who.actor, setAt: deps.now() });
    }
  } else if (method !== "GET") {
    return refuse(405, "method", "GET or POST");
  }
  return Response.json(await stateOf(who, deps), { headers: { "cache-control": "no-store" } });
}

async function stateOf(who: { tenantId: string; agentId: string }, deps: AgentModelDeps) {
  const r = resolveModel(await deps.choices.layers(who.tenantId, who.agentId), deps.userModels, deps.defaultModel);
  const stored = (await deps.ownKey?.()) ?? null;
  const enabled = enabledUserKeyProviders(deps.userKeyProviders);
  // A binding to a vendor this deployment has switched off still shows, marked, so the owner can see why the agent
  // makes no model call and remove it.
  const own = stored ? { ...stored, ...(enabled.some((p) => p.id === stored.provider) ? {} : { off: true as const }) } : null;
  return {
    effective: own
      // What runs is the binding on the owner's key, which no row above decides.
      ? { label: `${own.model} (${own.label}, your key)`, provider: own.provider, model: own.model, source: "own" as const }
      : {
        // An option's label when what runs is one — whoever chose it — else the model's own name.
        label: optionFor(deps.userModels, r.choice)?.label ?? r.choice.model,
        provider: r.choice.provider,
        model: r.choice.model,
        source: r.source,
      },
    ownKey: own,
    // The vendors an owner may run this agent on with their own key, and their models: the catalogue is code
    // (src/model/user-key.ts), and the deployment switches each one on (USER_KEY_PROVIDERS). Ids and labels only.
    keyProviders: enabled.map((p) => ({ id: p.id, label: p.label, keyFrom: p.keyFrom, models: p.models.map((m) => ({ id: m.id, label: m.label })) })),
    // Each field named rather than spread: an option's provider and model are the operator's mapping, and a
    // field added to UserModel later must not reach the page by default.
    options: deps.userModels.offered.map((o) => ({ id: o.id, label: o.label })),
    selected: r.selected?.id ?? null,
    locked: r.locked,
  };
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export interface AgentModelKeyDeps extends Omit<AgentModelDeps, "ownKey"> {
  agent: {
    put(provider: string, model: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>;
    remove(): Promise<{ ok: true; removed: boolean }>;
    state(): Promise<OwnKeyState | null>;
  };
}

/**
 * `/ui/agent/model-key`: the owner runs their agent on their own key with a model vendor (src/model/user-key.ts).
 *
 *   POST provider, model, key  → the model card's state (`agentModel`'s), the agent bound to that model on that key
 *   POST remove=1              → the same, the key deleted and the agent back on the deployment's model
 *
 * The caller has been found to own the agent (the console's gate). An admin's agent or tenant row refuses a key as it
 * refuses a pick (409): a model an admin set for cost or compliance is not undone by paying for another. The key is
 * checked, sealed in the agent's object and never answered back, logged or put in an error: a refusal says what is
 * wrong with it in words of its own.
 */
export async function agentModelKey(
  method: string, form: FormData | null,
  who: { tenantId: string; agentId: string; actor: string },
  deps: AgentModelKeyDeps,
): Promise<Response> {
  if (method !== "POST") return refuse(405, "method", "POST");
  if (!form) return refuse(400, "invalid", "expected a form body");
  const state = () => stateOf(who, { ...deps, ownKey: () => deps.agent.state() });
  if (String(form.get("remove") ?? "") === "1") {
    await deps.agent.remove();
    return Response.json(await state(), { headers: { "cache-control": "no-store" } });
  }
  const now = resolveModel(await deps.choices.layers(who.tenantId, who.agentId), deps.userModels, deps.defaultModel);
  if (now.locked) return refuse(409, "locked", "an administrator has set this agent's model, so it cannot run on your own key");
  const provider = String(form.get("provider") ?? "").trim();
  const model = String(form.get("model") ?? "").trim();
  const choiceBad = userChoiceProblem(provider, model);
  if (choiceBad) return refuse(422, "invalid", choiceBad);
  // The one place a key is written from (AgentDO.uiPutModelKey checks again): a vendor this deployment has not
  // switched on is refused before anything is stored or bound, whatever the page offered.
  if (!enabledUserKeyProviders(deps.userKeyProviders).some((p) => p.id === provider)) return refuse(409, "provider_off", userKeyOffProblem(provider));
  const bad = userKeyProblem(form.get("key"));
  if (bad) return refuse(422, "invalid", bad);
  const put = await deps.agent.put(provider, model, String(form.get("key")));
  if (!put.ok) return refuse(422, "invalid", put.error);
  return Response.json(await state(), { headers: { "cache-control": "no-store" } });
}
