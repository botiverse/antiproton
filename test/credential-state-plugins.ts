/**
 * Every shipped plugin that declares a credential says WHICH credential state a failed call was in.
 *
 * `credentialState` and `identityNote` (src/plugins/types.ts) exist because a call made with no
 * credential has two causes that are fixed by different people: nobody attached an account, or the
 * mount names one that did not arrive — the operator's, which whoever deploys has to configure, or
 * the agent's own. Those two produce the same `credential: null` at the plugin, so a plugin that
 * reads only that field has to guess, and a guess written as a fact is how a person spends an
 * afternoon attaching a token to a mount that already has one (docs on `credentialState`).
 *
 * `test/gateway-credential-kind.ts` pins the mechanism with a synthetic plugin. Nothing pinned the
 * shipped ones, and `sandbox` — one of the three that declare a credential — answered all three
 * states with the one sentence "run9 mount has no credential", with no fields beside it, so a page
 * reading the record could not badge the failure and a reader could not tell who was to fix it.
 *
 * The check is prose-independent on purpose: it asks that the three states not answer the same
 * thing, and that the state travel as the fields `PluginErrorFields` declares. What each sentence
 * says is `identityNote`'s business, and pinning its words here would make a rewording red.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appworldPlugins, type Catalogue } from "../src/plugins/appworld.ts";
import { exaPlugin } from "../src/plugins/exa.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** A plugin's own store, in the shape `PluginContext.db` has: nothing kept, nothing written. */
const emptyDb = () => ({ get: async () => undefined, put: async () => "state", list: async () => [] });

/** One app, one API: enough to build an AppWorld plugin and name a tool of it. */
const APPWORLD_STANDIN: Catalogue = {
  spotify: {
    description: "music",
    apis: [{
      app_name: "spotify", api_name: "search_songs", path: "/search_songs", method: "GET", description: "find songs",
      parameters: [{ name: "access_token", type: "string", required: true, description: "", default: null, constraints: [] }],
    }],
  },
};

interface Case {
  /** The plugin, built as the runtime builds it. */
  plugin: Plugin;
  /** A tool of it that cannot answer without the mount's credential. */
  tool: string;
  args: Record<string, unknown>;
  /** Settings the tool needs before the credential is the reason it fails. */
  config: Record<string, unknown>;
}

/**
 * One entry per shipped plugin that declares a credential (`credential: {` at plugin level), each
 * with a tool that needs it. `github`'s mount is documented as working without an account — it reads
 * public repositories — so its "no credential" case is not a failure at all and it is checked below
 * by its failure path instead (a refusal from the service, src/plugins/github.ts `markIdentity`).
 */
const CREDENTIAL_PLUGINS: Record<string, Case> = {
  exa: { plugin: exaPlugin, tool: "search", args: { query: "anything" }, config: {} },
  github: { plugin: githubPlugin, tool: "issue_create",
    args: { owner: "botiverse", repo: "antiproton", title: "t", body: "b" }, config: {} },
  raft: { plugin: raftPlugin, tool: "receive_events", args: {}, config: { serverUrl: "https://api.raft.build" } },
  // AppWorld's catalogue is gitignored and a mount does not need it: one app with one API is enough to
  // build the plugin and call it, the same stand-in `test/mount-config.ts` uses.
  appworld: { plugin: appworldPlugins(APPWORLD_STANDIN, { apiBaseUrl: "http://localhost:8800" })[0]!, tool: "search_songs",
    args: {}, config: {} },
  sandbox: { plugin: sandboxPlugin(null as any, "local"), tool: "shell", args: { command: "echo hi" },
    config: { endpoint: "https://sandbox.example" } },
};

await check("every shipped plugin that declares a credential is one this check reads", () => {
  const found = readdirSync(join(import.meta.dirname, "..", "src", "plugins"))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /^\s*credential: \{/m.test(readFileSync(join(import.meta.dirname, "..", "src", "plugins", f), "utf8")))
    .map((f) => f.replace(/\.ts$/, ""));
  const missing = found.filter((id) => !(id in CREDENTIAL_PLUGINS));
  must(found.length > 0, "the scan found no plugin declaring a credential, so it can never be wrong");
  must(!missing.length,
    `declares a credential and this check does not drive it: ${missing.join(", ")} — add it to CREDENTIAL_PLUGINS, ` +
    `or it is the plugin whose states can still be told apart by nobody`);
});

/** The failure a call makes with `credential: null` and the given kind, or null when it answered. */
async function failure(c: Case, kind: "none" | "agent" | "operator") {
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "main" },
    alias: "mount", publicConfig: c.config,
    credential: null, credentialRefKind: kind,
    db: emptyDb(), sibling: async () => null, sandboxForms: async () => [], offered: [],
  };
  try {
    const r = await c.plugin.invoke(c.tool, c.args as any, ctx);
    return { answered: r };
  } catch (e: any) {
    return { error: e as Error & { identity?: string; credentialRef?: string } };
  }
}

for (const [id, c] of Object.entries(CREDENTIAL_PLUGINS)) {
  await check(`${id}: a missing credential is reported as the state it is in, and the three do not read alike`, async () => {
    const none = await failure(c, "none");
    const agent = await failure(c, "agent");
    const operator = await failure(c, "operator");
    for (const [kind, r] of [["none", none], ["agent", agent], ["operator", operator]] as const) {
      must("error" in r, `${id} answered with no credential at all (kind ${kind}): a tool that needs one must fail, ` +
        `or this case is measuring a tool that does not`);
    }
    must(none.error!.identity === "none", `none: identity is ${JSON.stringify(none.error!.identity)}, not "none"`);
    for (const [kind, r] of [["agent", agent], ["operator", operator]] as const) {
      must(r.error!.identity === "unreadable",
        `${kind}: identity is ${JSON.stringify(r.error!.identity)}, not "unreadable" — so the state is in the sentence only`);
      must(r.error!.credentialRef === kind, `${kind}: credentialRef is ${JSON.stringify(r.error!.credentialRef)}, not "${kind}"`);
    }
    const said = new Set([none.error!.message, agent.error!.message, operator.error!.message]);
    must(said.size === 3,
      `${id} answers "no account attached", "the agent's account could not be read" and "the operator's credential is ` +
      `not configured here" with ${said.size} sentence${said.size === 1 ? "" : "s"}; two of them have different ` +
      `people to fetch: ${JSON.stringify([...said])}`);
  });
}

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
