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
 * A pick takes effect on the agent's next run, when its binding is found stale and bound again (#bindModel in
 * cf/src/index.ts, with resolveModel deciding what is current).
 */
import type { ModelChoices } from "./control-plane.ts";
import { resolveModel } from "./model-request.ts";
import { optionFor, type UserModels } from "../../src/model/user-models.ts";

export interface AgentModelDeps {
  choices: ModelChoices;
  userModels: UserModels;
  /** The deployment's default model (HARNESS_MODEL), under DEFAULT_PROVIDER. */
  defaultModel: string;
  now(): number;
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
  return {
    effective: {
      // An option's label when what runs is one — whoever chose it — else the model's own name.
      label: optionFor(deps.userModels, r.choice)?.label ?? r.choice.model,
      provider: r.choice.provider,
      model: r.choice.model,
      source: r.source,
    },
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
