/**
 * The operator's own credentials behind a mount's `operator:` reference, resolved in one place: by the runtime when a
 * plugin's call needs one (cf/src/runtime.ts, the gateway's resolver), and by the evaluation export
 * (cf/src/eval-read.ts `agentSecretValues`), which scrubs every value a mount of the agent can be handed. Two copies of
 * this mapping could drift, and a reference the export resolved differently from the call would leave that key in it.
 */

/** The operator's sandbox account. Kept distinct from the model's reference so a
 *  tenant can be moved onto its own run9 project without touching its model binding. */
export const OPERATOR_RUN9_REF = "operator:run9";
/** The operator's Exa key, for the web search every agent is seeded with. */
export const OPERATOR_EXA_REF = "operator:exa";

/** The deployment's credentials an `operator:` reference may name, as the runtime is given them (`RuntimeDeps`). */
export interface OperatorCredentials {
  operatorRun9?: { ak: string; sk: string };
  operatorExa?: string;
}

/** The Worker environment's operator credentials, read as the agent object reads them for its runtime. */
export function operatorCredentials(env: { RUN9?: string; EXA_API_KEY?: string }): OperatorCredentials {
  return { operatorRun9: env.RUN9 ? JSON.parse(env.RUN9) : undefined, operatorExa: env.EXA_API_KEY };
}

/**
 * What `ref` resolves to: the run9 account as JSON, the Exa key, or what `fallback` makes of any other reference
 * (the runtime's is the Worker environment). Null when the deployment holds none.
 */
export function resolveOperatorRef(
  ref: string, creds: OperatorCredentials, fallback: (ref: string) => Promise<string | null>,
): Promise<string | null> {
  if (ref === OPERATOR_RUN9_REF) return Promise.resolve(creds.operatorRun9 ? JSON.stringify(creds.operatorRun9) : null);
  if (ref === OPERATOR_EXA_REF) return Promise.resolve(creds.operatorExa || null);
  return fallback(ref);
}
