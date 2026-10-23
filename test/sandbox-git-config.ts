/**
 * git's config slots across container forms.
 *
 * git takes its settings from the environment as one numbered list
 * (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_i`, `GIT_CONFIG_VALUE_i`), so a second
 * plugin with a git setting beside github's credential helper must not clash
 * on those names (both would be left out of the container): the slots are not
 * claimed, and the environment numbers every wired form's entries again. A
 * name a container has one of (`GH_TOKEN`) still clashes. With github alone
 * the environment is what it was.
 */
import { claimedNames, envFor } from "../src/plugins/sandbox.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import type { SandboxForm } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const github = githubPlugin.sandboxForm!;
// A second service whose git setting is a header (Stamp's git over HTTPS takes
// `Authorization: Bearer`), declared at index 0 the way github declares its own.
const header: SandboxForm = {
  summary: "git over HTTPS to stamp.build",
  egress: [{ name: "STAMP_SESSION", header: "authorization", hosts: ["stamp.build"], value: (t) => `Bearer ${t}`, placeholder: (p) => `Bearer ${p}` }],
  env: (p) => ({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://stamp.build/.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${p}`,
  }),
};
const wired = (...forms: Array<[SandboxForm, string]>) => ({ wired: forms.map(([f, p]) => ({ env: f.env(p) })) }) as any;

await check("git's config slots are not claimed; GH_TOKEN still is", () => {
  const names = [...claimedNames(github), ...claimedNames(header)];
  must(!names.some((n) => n.startsWith("GIT_CONFIG_")), `a git config slot is claimed: ${names.join(", ")}`);
  must(claimedNames(github).includes("GH_TOKEN"), `GH_TOKEN is no longer claimed: ${claimedNames(github).join(", ")}`);
});

await check("two forms' git settings are numbered across the container", () => {
  const env = envFor(wired([github, "__AP_GITHUB__"], [header, "__AP_STAMP__"]));
  must(env.GIT_CONFIG_COUNT === "2", `count: ${env.GIT_CONFIG_COUNT}`);
  must(env.GIT_CONFIG_KEY_0 === github.env("x").GIT_CONFIG_KEY_0, `key 0: ${env.GIT_CONFIG_KEY_0}`);
  must(env.GIT_CONFIG_VALUE_0.includes("__AP_GITHUB__"), "value 0 is not github's helper");
  must(env.GIT_CONFIG_KEY_1 === "http.https://stamp.build/.extraHeader", `key 1: ${env.GIT_CONFIG_KEY_1}`);
  must(env.GIT_CONFIG_VALUE_1 === "Authorization: Bearer __AP_STAMP__", `value 1: ${env.GIT_CONFIG_VALUE_1}`);
  must(env.GH_TOKEN === "__AP_GITHUB__", "the rest of github's environment is kept");
});

await check("the numbering follows the order the mounts were wired", () => {
  const env = envFor(wired([header, "__AP_STAMP__"], [github, "__AP_GITHUB__"]));
  must(env.GIT_CONFIG_KEY_0 === "http.https://stamp.build/.extraHeader" && env.GIT_CONFIG_KEY_1 === github.env("x").GIT_CONFIG_KEY_0,
    `order: ${env.GIT_CONFIG_KEY_0}, ${env.GIT_CONFIG_KEY_1}`);
});

await check("with github alone the environment is unchanged", () => {
  const env = envFor(wired([github, "__AP_GITHUB__"]));
  must(JSON.stringify(env) === JSON.stringify(github.env("__AP_GITHUB__")), `changed: ${JSON.stringify(env)}`);
  must(JSON.stringify(envFor(null)) === "{}", "no wired mount has an environment");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
