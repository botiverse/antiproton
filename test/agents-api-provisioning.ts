/**
 * An API agent has only what its caller declared, plus a container when a session asks for one (task #17).
 */
import { apiAgentSeeds, harnessExtras } from "../cf/src/agents-api/provisioning.ts";
import { offersCapability } from "../src/runtime/pi-tools.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const DEFAULTS = ["tools", "artifacts", "web", "gh", "state", "sandbox"].map((alias) => ({ alias, plugin: alias }));

await check("a container comes from the plugin that provides one, whatever the row is called", () => {
  // `provides` is asked of the plugin; the alias is the operator's and says
  // nothing. Renaming that row used to mean a session asking for a container
  // silently got none — `environment: "container"` honoured by giving nothing.
  const gives = (id: string) => (id === "sandbox" ? (["container"] as const) : undefined);
  assert(apiAgentSeeds(DEFAULTS, "none", gives).length === 0,
    `none: ${JSON.stringify(apiAgentSeeds(DEFAULTS, "none", gives))}`);
  const hosted = apiAgentSeeds(DEFAULTS, "container", gives).map((m) => m.alias);
  assert(hosted.join() === "sandbox", `hosted: ${hosted}`);

  // The step itself: the same plugin under a name nobody special-cases.
  const renamed = [{ alias: "box", plugin: "sandbox" }, { alias: "web", plugin: "http" }];
  assert(apiAgentSeeds(renamed, "container", gives).map((m) => m.alias).join() === "box",
    `a renamed row was not picked: ${JSON.stringify(apiAgentSeeds(renamed, "container", gives))}`);

  // And a second plugin that can provide one qualifies without anyone editing
  // this function — which is the whole reason it asks rather than matches.
  const twoProviders = (id: string) => (id === "sandbox" || id === "vm" ? (["container"] as const) : undefined);
  assert(apiAgentSeeds([{ alias: "vm1", plugin: "vm" }], "container", twoProviders).length === 1,
    "a second container provider was not recognised");

  // The empty case must be visible rather than silent: asking for a container
  // when nothing provides one yields nothing, and that is what the caller sees.
  assert(apiAgentSeeds(DEFAULTS, "container", () => undefined).length === 0,
    "a catalogue with no container provider still seeded something");

  // Everything above asks a fixture. Without this, all of it stays green while
  // the real sandbox has quietly lost the declaration — and then a session
  // asking for a container gets none, which is exactly the silent failure this
  // step exists to remove.
  const real = sandboxPlugin(null as any, "local", null);
  assert(real.provides?.includes("container"),
    `the sandbox must declare that it provides a container, got ${JSON.stringify(real.provides)}`);
  assert(apiAgentSeeds([{ alias: "sandbox", plugin: "sandbox" }], "container",
    (id) => (id === real.id ? real.provides : undefined)).length === 1,
    "the real plugin's own declaration did not seed a container");
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
