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
import { SESSION_STORE } from "../src/plugins/raft-agent-login.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
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
    // "No credential" is not a state that clears on its own, so no call may report it as retriable: the gateway
    // records a `retryable` failure as `unknown`, which means "it may have landed", and retrying this one can only
    // fail again. Asserted as `!== true` rather than `=== false` because an absent field is already the answer every
    // reader handles — what must never appear is the claim.
    for (const [kind, r] of [["none", none], ["agent", agent], ["operator", operator]] as const) {
      const e = r.error! as { retryable?: boolean; transient?: boolean };
      must(e.retryable !== true, `${id} / ${kind}: a missing credential is reported as retriable`);
      must(e.transient !== true, `${id} / ${kind}: a missing credential is reported as transient`);
    }
    const said = new Set([none.error!.message, agent.error!.message, operator.error!.message]);
    must(said.size === 3,
      `${id} answers "no account attached", "the agent's account could not be read" and "the operator's credential is ` +
      `not configured here" with ${said.size} sentence${said.size === 1 ? "" : "s"}; two of them have different ` +
      `people to fetch: ${JSON.stringify([...said])}`);
  });
}

await check("raft: every Agent Login tool reports the identity the call had, not one sentence for three states", async () => {
  // The Agent Login functions live beside the plugin (src/plugins/raft-agent-login.ts) and reach the model through
  // four of raft's tools, so a plugin-level case that only drives `receive_events` never touches them. This drives
  // all four with no credential AND a kept session row, which is the state in which a session is read before any
  // Raft call: the read must not become the first thing that fails, and if it ever does it must say which state it
  // is in. (It cannot today: `loadSession` swallows a session that does not open, and the call stops at
  // `requireCredential`, which is where the identity comes from.)
  const host = sqliteHost();
  const plugin = raftPlugin;
  const tables = new PluginDbTables(host).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
  const db = openPluginDatabase(tables, scope, plugin.database);
  await db.put(SESSION_STORE, { v: 1, serviceId: "svc", clientId: "cid", returnUrl: "https://app.test/cb",
    scopes: null, expiresAt: null, createdAt: 1, iv: "AAAA", ciphertext: "AAAA" } as any, "svc");
  for (const kind of ["none", "agent", "operator"] as const) {
    const seen = new Set<string>();
    for (const tool of ["integrations_list", "integrations_login", "integrations_actions", "integrations_invoke"]) {
      const ctx: any = {
        caller: { tenantId: "t", agentId: "a", taskId: "main" }, alias: "raft",
        publicConfig: { serverUrl: "https://raft.test" }, credential: null, credentialRefKind: kind,
        db, sibling: async () => null, sandboxForms: async () => [],
        offered: (plugin.tools ?? []).map((t: any) => t.name),
      };
      let e: any = null;
      try { await plugin.invoke(tool, { service: "svc", action: "a" }, ctx); } catch (err) { e = err; }
      if (!e) throw new Error(`${tool} answered with no credential at all (kind ${kind})`);
      const want = kind === "none" ? "none" : "unreadable";
      if (e.identity !== want) throw new Error(`${tool} / ${kind}: identity is ${JSON.stringify(e.identity)}, not "${want}"`);
      if (kind !== "none" && e.credentialRef !== kind) throw new Error(`${tool} / ${kind}: credentialRef is ${JSON.stringify(e.credentialRef)}`);
      if (e.retryable === true || e.transient === true) {
        throw new Error(`${tool} / ${kind}: a missing credential is reported as something to retry`);
      }
      seen.add(e.message);
    }
    if (seen.size !== 1) throw new Error(`${kind}: the four tools disagree about the state: ${JSON.stringify([...seen])}`);
  }
  host.dispose();
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
