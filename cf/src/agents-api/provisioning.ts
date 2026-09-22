/**
 * What an agent made through the Agents API is given beyond the function tools its caller declared
 * (task #17).
 *
 * The console's agents are seeded with the platform's mounts (web, GitHub, artifacts, state, tools,
 * sandbox) and offered run_js and jobs. An API agent is described entirely by its caller: `agent.tools`
 * lists what it has, and nothing else may be offered to the model beside it. Vera's τ² run through the API
 * found the platform's six mounts, run_js and their prompt paragraphs offered next to the retail
 * functions, invisible in `agent.tools` (2026-09-15). The one addition a caller asks for is a container:
 * a session with `environment: { type: "openai_hosted" }` gets the sandbox mount.
 */

/** The seed mounts for an API agent's first input in a session with this environment. */
export function apiAgentSeeds<T extends { alias: string }>(defaults: readonly T[], environment: "none" | "container"): T[] {
  return environment === "container" ? defaults.filter((m) => m.alias === "sandbox") : [];
}

/** Which of the harness's own tools the model is offered. */
export function harnessExtras(o: { apiAgent: boolean; sandbox: boolean; hasBackgroundMount: boolean }): { runJs: boolean; jobs: boolean } {
  return {
    runJs: o.sandbox && !o.apiAgent,
    // `jobs` lists and stops work that a call left running, so it is worth
    // offering exactly when something offered can leave work running. That was
    // the sandbox and only the sandbox, which is why this used to ask for it by
    // name; asked as a capability, the second plugin to declare `background`
    // gets the tool without anyone remembering to come back here.
    jobs: !o.apiAgent || o.hasBackgroundMount,
  };
}
