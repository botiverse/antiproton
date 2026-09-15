/**
 * An API agent has only what its caller declared, plus a container when a session asks for one (task #17).
 */
import { apiAgentSeeds, harnessExtras } from "../cf/src/agents-api/provisioning.ts";

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

await check("an API agent is not offered run_js, and jobs only when it has a sandbox; a console agent keeps both", () => {
  const consoleAgent = harnessExtras({ apiAgent: false, sandbox: true, hasSandboxMount: true });
  assert(consoleAgent.runJs && consoleAgent.jobs, `console agent: ${JSON.stringify(consoleAgent)}`);
  const bare = harnessExtras({ apiAgent: true, sandbox: true, hasSandboxMount: false });
  assert(!bare.runJs && !bare.jobs, `api agent without a container: ${JSON.stringify(bare)}`);
  const hosted = harnessExtras({ apiAgent: true, sandbox: true, hasSandboxMount: true });
  assert(!hosted.runJs && hosted.jobs, `api agent with a container: ${JSON.stringify(hosted)}`);
  const noSandboxDeployment = harnessExtras({ apiAgent: false, sandbox: false, hasSandboxMount: false });
  assert(!noSandboxDeployment.runJs && noSandboxDeployment.jobs, `deployment without run_js: ${JSON.stringify(noSandboxDeployment)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
