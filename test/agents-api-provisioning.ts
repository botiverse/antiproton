/**
 * An API agent has only what its caller declared, plus a container when a session asks for one (task #17).
 */
import { apiAgentSeeds, harnessExtras } from "../cf/src/agents-api/provisioning.ts";
import { offersCapability } from "../src/runtime/pi-tools.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const DEFAULTS = ["tools", "artifacts", "web", "gh", "state", "sandbox"].map((alias) => ({ alias, plugin: alias }));

await check("an API agent is seeded with nothing for environment none, and only the sandbox for a hosted environment", () => {
  assert(apiAgentSeeds(DEFAULTS, "none").length === 0, `none: ${JSON.stringify(apiAgentSeeds(DEFAULTS, "none"))}`);
  const hosted = apiAgentSeeds(DEFAULTS, "container").map((m) => m.alias);
  assert(hosted.join() === "sandbox", `hosted: ${hosted}`);
});

await check("an API agent is not offered run_js, and jobs only when something offered can leave work running", () => {
  const consoleAgent = harnessExtras({ apiAgent: false, sandbox: true, hasBackgroundMount: true });
  assert(consoleAgent.runJs && consoleAgent.jobs, `console agent: ${JSON.stringify(consoleAgent)}`);
  const bare = harnessExtras({ apiAgent: true, sandbox: true, hasBackgroundMount: false });
  assert(!bare.runJs && !bare.jobs, `api agent with nothing backgroundable: ${JSON.stringify(bare)}`);
  const hosted = harnessExtras({ apiAgent: true, sandbox: true, hasBackgroundMount: true });
  assert(!hosted.runJs && hosted.jobs, `api agent with background work: ${JSON.stringify(hosted)}`);
  const noSandboxDeployment = harnessExtras({ apiAgent: false, sandbox: false, hasBackgroundMount: false });
  assert(!noSandboxDeployment.runJs && noSandboxDeployment.jobs, `deployment without run_js: ${JSON.stringify(noSandboxDeployment)}`);
});

await check("`jobs` follows the capability, not the sandbox's name", () => {
  // The point of the step: a plugin that is not the sandbox, declaring
  // `background`, gets `jobs`; and the sandbox's name alone no longer does.
  const records = [{ alias: "worker", plugin: "other" }, { alias: "web", plugin: "http" }];
  const offered = [{ address: "worker.start" }, { address: "web.get" }] as any;
  const declares = new Set(["other"]);
  const withBackground = offersCapability(records, offered, (id) => declares.has(id));
  assert(withBackground, "a non-sandbox plugin declaring background did not offer jobs");
  assert(harnessExtras({ apiAgent: true, sandbox: false, hasBackgroundMount: withBackground }).jobs,
    "jobs was withheld from an API agent that has background work");
  // Take the declaration away and the same mounts stop qualifying — this is
  // the half that makes the line above a reading rather than a tautology.
  const without = offersCapability(records, offered, () => false);
  assert(!without, "a mount with no background capability still qualified");
  assert(!harnessExtras({ apiAgent: true, sandbox: false, hasBackgroundMount: without }).jobs,
    "jobs was offered to an API agent with nothing that can leave work running");
  // An alias nobody knows about must not count as a capability.
  assert(!offersCapability(records, [{ address: "ghost.run" }] as any, () => true),
    "a tool whose alias is not a mount was treated as one");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
