/**
 * Settings checked where a person can read the answer.
 *
 * The failure worth catching is the quiet one: a mount carrying `timeout_ms`
 * where the plugin reads `timeoutMs` is not rejected by anything, so the plugin
 * uses its default for ever and the symptom appears somewhere else entirely.
 */
import { readFile } from "node:fs/promises";
import { SqliteStore } from "../src/store/sqlite.ts";
import { validateMount, assertMountConfig } from "../src/runtime/mount-config.ts";
import { pluginEnabled, renameSafety, type PluginChoice, isExclusive } from "../src/plugins/types.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { policyFor } from "../src/runtime/gateway.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { sandboxPlugin, execArgv, execOutput, sessionOf, activityOf, providerOf, keepSessions, boxReminder, usageOf, asBoxState, segmentsOf, keptNote, savedNote, notAReasonToRelease } from "../src/plugins/sandbox.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import { exaPlugin } from "../src/plugins/exa.ts";
import { demoPlugin } from "../src/plugins/demo.ts";
import { statePlugin } from "../src/plugins/state.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { appworldPlugins, type Catalogue } from "../src/plugins/appworld.ts";
import { credentialForm, originProblem, credentialState, identityNote, type CredentialRefKind } from "../src/plugins/types.ts";
import { secretRefKind } from "../src/runtime/secrets.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const run9 = sandboxPlugin(null as any, "local");

await check("拼错的键会被拒绝,并给出最接近的那个", () => {
  const p = validateMount(run9, { timeout_ms: 5000 } as any, "env:RUN9");
  if (p.length !== 1) throw new Error(`expected one problem, got ${JSON.stringify(p)}`);
  if (!p[0]!.message.includes('did you mean "timeoutMs"')) {
    throw new Error(`no suggestion: ${p[0]!.message}`);
  }
});

await check("类型不对会被说出来,而不是被强转", () => {
  const p = validateMount(run9, { timeoutMs: "5000" } as any, "env:RUN9");
  if (!p.some((x) => x.message.includes("should be number, got string"))) {
    throw new Error(JSON.stringify(p));
  }
});

await check("需要账号却没有 secret_ref,挂载时就报", () => {
  const p = validateMount(run9, { image: "x" } as any, null);
  if (!p.some((x) => x.message.includes("needs an account"))) throw new Error(JSON.stringify(p));
});

await check("凭据可选的插件,没有账号也能挂", () => {
  const p = validateMount(githubPlugin, {} as any, null);
  if (p.length) throw new Error(`a public-only mount was refused: ${JSON.stringify(p)}`);
});

await check("合法配置不报任何问题", () => {
  const p = validateMount(run9, {
    account: "operator", image: "node:22-alpine", workdir: "/work",
    timeoutMs: 300000,
  } as any, "env:RUN9");
  if (p.length) throw new Error(JSON.stringify(p));
});

await check("account 是控制台的标签,不算插件设置", () => {
  const p = validateMount(githubPlugin, { account: "unauthenticated" } as any, null);
  if (p.length) throw new Error(JSON.stringify(p));
});

await check("还没声明设置的插件不会因为已有的键被拒", () => {
  // Refusing every key on a plugin that declares none would break every mount
  // already carrying one, which is not a migration anyone asked for.
  const p = validateMount({ id: "demo", config: [], credential: undefined }, { anything: 1 } as any, null);
  if (p.length) throw new Error(JSON.stringify(p));
});

await check("assert 版本会抛,并且把问题都带上", () => {
  let msg = "";
  try { assertMountConfig(run9, { timeout_ms: 1, shel: "x" } as any, null); }
  catch (e) { msg = String((e as Error).message); }
  if (!msg.includes("cannot mount sandbox")) throw new Error(`unexpected: ${msg}`);
  if (!msg.includes("timeoutMs") || !msg.includes("needs an account")) {
    throw new Error(`problems were dropped: ${msg}`);
  }
});

await check("network none wraps the shell in an empty network namespace", () => {
  const argv = execArgv({ shell: "/bin/bash", shellPrefix: "act && ", network: "none" }, "curl x");
  if (JSON.stringify(argv) !== JSON.stringify(["unshare", "-n", "--", "/bin/bash", "-lc", "act && curl x"])) {
    throw new Error(`got ${JSON.stringify(argv)}`);
  }
});

await check("network open, or unset, runs the shell as before", () => {
  for (const network of ["open", undefined] as const) {
    const argv = execArgv({ shell: "/bin/sh", network }, "ls");
    if (JSON.stringify(argv) !== JSON.stringify(["/bin/sh", "-lc", "ls"])) throw new Error(`got ${JSON.stringify(argv)}`);
  }
});

await check("network is a mount setting", () => {
  const p = validateMount(run9, { network: "none" } as any, "env:RUN9");
  if (p.length) throw new Error(`unexpected problems: ${p.map((x) => x.message).join("; ")}`);
});

await check("拼错的 network 会被拒绝,而不是悄悄给一张网", () => {
  // The value came from prose — the summary said '"open" or "none"' and the
  // field took any string — so "None" was a valid mount. The one caller that
  // reads it from outside is `bench/swebench/cf.ts`, which passes
  // `process.env.NETWORK` through unchecked to a benchmark whose own default
  // is "none".
  for (const bad of ["None", "NONE", "nome", "off"]) {
    const p = validateMount(run9, { network: bad } as any, "env:RUN9");
    if (!p.some((x) => x.message.includes("should be one of open, none"))) {
      throw new Error(`${JSON.stringify(bad)} was accepted as a network: ${JSON.stringify(p)}`);
    }
  }
});

await check("网络开关失败时向关的一侧倒", () => {
  // A mount written before the choices existed can still carry one of those
  // words, so the gate itself has to hold. Anything present that is not "open"
  // isolates; only "open" and an absent value leave the namespace alone, which
  // is what every mount relies on today.
  for (const bad of ["None", "NONE", "nome", "off", ""] as any[]) {
    const argv = execArgv({ shell: "/bin/sh", network: bad }, "curl x");
    if (argv[0] !== "unshare") {
      throw new Error(`network ${JSON.stringify(bad)} got a route out: ${JSON.stringify(argv)}`);
    }
  }
});

// AppWorld's catalogue is gitignored, and a mount does not need it: one app
// with one API is enough to build the plugin and ask it what it takes.
const catalogue: Catalogue = {
  spotify: {
    description: "music",
    apis: [{
      app_name: "spotify", api_name: "search_songs", path: "/search_songs", method: "GET",
      description: "find songs",
      parameters: [{ name: "access_token", type: "string", required: true, description: "", default: null, constraints: [] }],
    }],
  },
};
const [spotify] = appworldPlugins(catalogue, { apiBaseUrl: "http://localhost:8800" });

await check("appworld says it needs an account instead of failing on the first call", () => {
  const p = validateMount(spotify!, {} as any, null);
  if (!p.some((x) => x.message.includes("needs an account"))) {
    throw new Error(`a mount with no credential was accepted: ${JSON.stringify(p)}`);
  }
});

await check("a credential field carries a label and says which part is secret", () => {
  const form = credentialForm(spotify!.credential);
  if (form.kind !== "fields" || !form.fields.every((k) => k.name && k.summary)) {
    throw new Error(`a page has nothing to label these with: ${JSON.stringify(form)}`);
  }
  const username = form.fields.find((k) => k.name === "username");
  if (username?.secret !== false) throw new Error("a username is an identifier, not a secret");
});

/**
 * The one path that puts a credential where the model can read it.
 *
 * `public_config` is rendered in the console *and* handed to the agent by the
 * builtin `tools.mounts`, while `secret_ref` is exposed in neither. So a
 * credential entered into a settings field rather than the credential field is
 * in the prompt, and nothing downstream can tell it apart from an image name.
 *
 * The check is a declaration rather than a guess about vocabulary. A name is
 * not a value — run9's `secrets` setting names the secrets to inject and
 * carries none of them — so a field whose name is credential-shaped says which
 * of the two it is, and one that says nothing is refused. A new field that
 * forgets to say fails here rather than in the console.
 */
const CREDENTIAL_SHAPED = /token|secret|key|password|credential|auth|bearer/i;
// The bench's `retail` plugin (an extraPlugins entry, not registered here) is
// deliberately absent: it declares no settings, credential or hooks, so no
// check below has anything to read. Add it when it gains any of them.
const everyPlugin: Plugin[] = [
  githubPlugin, httpPlugin, exaPlugin, demoPlugin, run9,
  statePlugin(null as any, null, "local"),
  artifactsPlugin(null as any, "local"),
  raftPlugin,
  builtinToolsPlugin(null as any, () => []),
  ...appworldPlugins(catalogue, { apiBaseUrl: "http://localhost:8800" }),
];

await check("every plugin the runtime registers is in everyPlugin", () => {
  // The checks below run over this list, and it is written by hand: a plugin
  // added to the runtime and not here is skipped by all of them, silently —
  // the list still passes, it just stops describing production. So the list is
  // compared with what the runtime actually registers, the way
  // `test/plugin-enable.ts` builds one.
  const rt = new AgentRuntime({
    ctx: { storage: {} } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any,
  } as any);
  const registered = rt.plugins().map((p) => p.id);
  if (registered.length === 0) throw new Error("the runtime registered nothing, so this compares nothing");
  const listed = new Set(everyPlugin.map((p) => p.id));
  const missing = registered.filter((id) => !listed.has(id));
  if (missing.length) {
    throw new Error(`registered but not in everyPlugin, so no check below covers them: ${missing.join(", ")}`);
  }
});

await check("no plugin takes a credential as a setting", () => {
  for (const plugin of everyPlugin) {
    const form = credentialForm(plugin.credential);
    const credentialKeys = new Set(form.kind === "fields" ? form.fields.map((k) => k.name) : []);
    for (const f of plugin.config ?? []) {
      if (credentialKeys.has(f.name)) {
        throw new Error(`${plugin.id} declares "${f.name}" as both a setting and part of its credential`);
      }
      if (CREDENTIAL_SHAPED.test(f.name) && f.references !== "credential") {
        throw new Error(
          `${plugin.id}'s setting "${f.name}" reads as a credential and does not say it only names one; ` +
          `settings are public, so if it holds a value it is in the prompt`,
        );
      }
    }
  }
});

await check("a credential-shaped setting is refused unless it says it only names one", () => {
  // This used to pin the marker to run9's `secrets` setting. That setting is gone
  // (task #20: its declared type contradicted every consumer, nothing could
  // configure it through a validated mount, and it handed a credential to a
  // container with no policy gate). The rule it existed for still matters, so the
  // case now tests the rule rather than a field that happened to carry it — and it
  // no longer disappears with the next setting that does.
  const marked = (references?: "credential") =>
    [{ name: "apiKeys", type: "string[]" as const, summary: "names only", ...(references ? { references } : {}) }];
  const offending = (config: ReturnType<typeof marked>) =>
    config.filter((f) => CREDENTIAL_SHAPED.test(f.name) && f.references !== "credential");
  if (!offending(marked()).length) throw new Error("a credential-shaped setting without the marker was accepted");
  if (offending(marked("credential")).length) throw new Error("the marker no longer makes such a setting legitimate");
  if (!CREDENTIAL_SHAPED.test("apiKeys")) throw new Error("the pattern stopped matching the case it exists for");
});

await check("a sign-in is a credential the page must not ask anyone to paste", () => {
  // Declared and not implemented: no plugin uses this yet. What is checked is
  // that the rest of the machinery does not assume a credential has fields —
  // a mount still needs an account, and the settings rule still runs.
  const signIn: Pick<Plugin, "id" | "config" | "credential"> = {
    id: "somewhere",
    config: [{ name: "workspace", type: "string", summary: "Which workspace to act in." }],
    credential: {
      required: true,
      summary: "Connect the account at the provider; there is nothing to paste here.",
      shape: { signIn: { provider: "Somewhere", grants: "reading and posting as that account" } },
    },
  };
  const p = validateMount(signIn, { workspace: "w" } as any, null);
  if (!p.some((x) => x.message.includes("needs an account"))) {
    throw new Error(`a mount that was never connected was accepted: ${JSON.stringify(p)}`);
  }
  if (validateMount(signIn, { workspace: "w" } as any, "agent:somewhere").length) {
    throw new Error("a connected mount was refused");
  }
});

await check("every credential shape answers the same question, including the one with no fields", () => {
  // A page asks once and switches on the answer. The failure this prevents is
  // a reader that narrows to `keys` and meets a sign-in in the one path a
  // person uses to connect an account.
  const token = credentialForm(githubPlugin.credential);
  if (token.kind !== "fields" || token.fields.length !== 1 || token.fields[0]!.name !== "token") {
    throw new Error(`a bare token should be one labelled box: ${JSON.stringify(token)}`);
  }
  if (token.fields[0]!.summary !== githubPlugin.credential!.summary) {
    throw new Error("the plugin's own words were thrown away for a generic label");
  }
  const pair = credentialForm(run9.credential);
  if (pair.kind !== "fields" || pair.fields.map((f) => f.name).join() !== "ak,sk") {
    throw new Error(`expected two fields: ${JSON.stringify(pair)}`);
  }
  const none = credentialForm(httpPlugin.credential);
  if (none.kind !== "none") throw new Error("a plugin that needs no account should ask for nothing");
  const signIn = credentialForm({
    required: true, summary: "Connect the account.",
    shape: { signIn: { provider: "Somewhere" } },
  });
  if (signIn.kind !== "signIn" || signIn.signIn.provider !== "Somewhere") {
    throw new Error(`a sign-in should not come back as fields: ${JSON.stringify(signIn)}`);
  }
});

await check("output under the limit is returned whole and says nothing about truncation", () => {
  const r = execOutput("hello", 24_000);
  if (r.output !== "hello" || r.truncated) throw new Error(JSON.stringify(r));
  if ("dropped" in r || "note" in r) throw new Error("a result that lost nothing should not discuss loss");
});

await check("output over the limit says how much went, and that it is gone rather than parked", () => {
  // The threshold no benchmark has ever crossed, which is why it is tested here
  // rather than left for the first person whose build prints a lot.
  const r = execOutput("x".repeat(100), 40);
  if (r.output.length !== 40) throw new Error(`kept ${r.output.length}`);
  if (!r.truncated || r.dropped !== 60) throw new Error(JSON.stringify(r));
  if (!/discarded/.test(r.note ?? "")) {
    throw new Error(`the agent is not told the tail is gone: ${JSON.stringify(r.note)}`);
  }
  if (r.output.length + r.dropped! !== 100) throw new Error("the arithmetic does not account for the whole output");
});

await check("the boundary keeps everything, one past it does not", () => {
  if (execOutput("x".repeat(40), 40).truncated) throw new Error("exactly at the limit was cut");
  if (!execOutput("x".repeat(41), 40).truncated) throw new Error("one past the limit was not cut");
});

await check("a setting that has a default declares it, so a console never shows a blank for a real number", () => {
  // The defect this catches is quiet: a person reads an empty field, assumes
  // there is no limit, and learns the real one from a truncated result.
  const declared = everyPlugin.flatMap((p) => (p.config ?? []).map((f) => [p.id, f] as const));
  const numeric = declared.filter(([, f]) => f.type === "number");
  const blank = numeric.filter(([, f]) => f.default === undefined);
  if (blank.length) {
    throw new Error(`numeric settings with a code default and no declared one: ${blank.map(([id, f]) => `${id}.${f.name}`).join(", ")}`);
  }
});

await check("no setting promises to park something the plugin cannot park", () => {
  // Twice now a summary has said "parked as an artifact" over code that slices
  // and discards. A summary is handed to the agent by tools.mounts, so it is a
  // promise in the prompt rather than a comment.
  for (const plugin of everyPlugin) {
    for (const f of plugin.config ?? []) {
      if (/parked as an artifact/i.test(f.summary)) {
        throw new Error(`${plugin.id}.${f.name} promises parking; check the code actually parks before allowing this wording`);
      }
    }
  }
});

/**
 * `sideEffects` is not a label: the gateway maps it straight to a mount's
 * policy, so a tool that changes something and says "read" is a tool an
 * approval-gated mount lets through. `release` said read, and it destroys the
 * container and everything in it.
 */
await check("an approval-gated mount holds every run9 tool, because every one of them changes something", () => {
  // All six touch the container: run and shell execute in it, save writes to
  // object storage, keep and start_from fork and switch its filesystem, and
  // release destroys it. None is a read, so none may fall to `policy.read`.
  const gated = { write: "approval" as const };
  const through = run9.tools
    .filter((t) => policyFor(gated, t.name, t.sideEffects) !== "approval")
    .map((t) => `${t.name} (${t.sideEffects})`);
  if (through.length) {
    throw new Error(`a mount gating writes lets these through: ${through.join(", ")}`);
  }
});

await check("a tool whose own summary says it destroys something is not declared a read", () => {
  // One direction only. The reverse — "no destructive verb, so it must be a
  // read" — flags twelve tools that correctly declare writes, so it would be
  // noise. This direction has exactly one historical hit and it was real.
  const DESTRUCTIVE = /\b(destroy|destroys|delete|deletes|remove|removes|overwrite|overwrites)\b/i;
  for (const plugin of everyPlugin) {
    for (const t of plugin.tools) {
      if (t.sideEffects === "read" && DESTRUCTIVE.test(t.summary)) {
        throw new Error(`${plugin.id}.${t.name} describes itself as destructive and declares "read"`);
      }
    }
  }
});

await check("the mount's requirement and a field's requirement stay separate", () => {
  // github is the case that separates them: it reads public repositories with
  // no account, so the mount is optional while the token, if given, is a token.
  // A form that took the field's answer for the mount's would mark the box
  // mandatory on a mount the console labels "account optional".
  const form = credentialForm(githubPlugin.credential);
  if (form.kind !== "fields") throw new Error(`expected fields, got ${form.kind}`);
  if (form.accountRequired !== false) throw new Error("github's mount works with no account at all");
  if (form.fields[0]!.required !== true) throw new Error("a token, if supplied, is required to be one");
  // And the name a caller reaches for cannot be the ambiguous one.
  if ("required" in form) throw new Error("the mount-level flag is named `required`, which reads as the field's");
});

await check("only an explicit secret:false reveals a field, so an unset flag never shows a password", () => {
  // `undefined` is falsy, so a page writing `if (field.secret) mask()` against
  // an unset value shows the input in clear — and the two that ship unset are
  // run9's secret key and AppWorld's password. The declarations were right;
  // the obvious reading of them was a plaintext password on screen.
  const shown: string[] = [];
  for (const plugin of everyPlugin) {
    const form = credentialForm(plugin.credential);
    if (form.kind !== "fields") continue;
    for (const f of form.fields) {
      if (typeof f.secret !== "boolean") throw new Error(`${plugin.id}.${f.name} left \`secret\` unresolved`);
      if (typeof f.required !== "boolean") throw new Error(`${plugin.id}.${f.name} left \`required\` unresolved`);
      if (!f.secret) shown.push(`${plugin.id}.${f.name}`);
    }
  }
  // The allowlist is the point: anything new appearing here is a decision.
  if (shown.join() !== "spotify.username") {
    throw new Error(`fields rendered in clear: ${shown.join(", ") || "(none)"}`);
  }
});

await check("the resolver reads the declaration rather than overriding it", () => {
  const form = credentialForm({
    required: true, summary: "x",
    shape: { keys: [
      { name: "id", summary: "an identifier", secret: false },
      { name: "key", summary: "unset, so secret" },
      { name: "opt", summary: "explicitly optional", required: false },
    ] },
  });
  if (form.kind !== "fields") throw new Error("expected fields");
  const [id, key, opt] = form.fields;
  if (id!.secret !== false) throw new Error("an explicit false was overridden");
  if (key!.secret !== true) throw new Error("an unset secret did not default to true");
  if (opt!.required !== false) throw new Error("an explicit optional was overridden");
  if (opt!.secret !== true) throw new Error("optional is not the same question as secret");
});

/**
 * A plugin that has something to hand back is a plugin that holds something per
 * mount, and holding something per mount is exactly what `exclusive` exists for:
 * two calls arriving together both find nothing, both create one, and only the
 * last write to connection state survives. The rest become resources nobody
 * will ever release, billed by the second — fifteen of them accumulated before
 * the meter made it visible, which is why the flag exists at all.
 *
 * Neither declaration was pinned by anything until now: deleting `exclusive`
 * from run9 broke no test, and the symptom is a bill rather than a failure.
 */
await check("declaring `holds` is what serialises a mount, and it is the only thing that does", () => {
  // Both directions used to be assertions that two independent fields agreed.
  // They are now one fact: `isExclusive` is DERIVED from `holds`, so the two
  // can no longer disagree and the pair of rules collapses into their meaning.
  // Asked of the derivation with fixtures, not of the nine plugins: over the
  // real list "every holder is exclusive" cannot fail, because `isExclusive`
  // reads `holds`. An assertion that cannot fail is decoration — what is worth
  // pinning is that the derivation still reads that field at all.
  const holdingFixture = { holds: { async activity() { return { live: null }; }, async release() {} } } as any;
  if (!isExclusive(holdingFixture)) throw new Error("declaring holds no longer serialises the mount");
  if (isExclusive({} as any)) throw new Error("a plugin that declares nothing is being serialised");
  const holders = everyPlugin.filter((p) => !!p.holds);
  // Two http fetches do not interfere; serialising everything would cost every
  // other mount in the turn, so the reverse direction is a rule of its own.
  const idle = everyPlugin.filter((p) => isExclusive(p) && !p.holds).map((p) => p.id);
  if (idle.length) throw new Error(`${idle.join(", ")} serialise calls but hold nothing to release`);
  // Without this the two rules above both pass by there being no holders at all.
  if (!holders.some((p) => p.id === "sandbox")) {
    throw new Error("the sandbox keeps one container per mount and must declare holds; the rules are vacuous without it");
  }
});

await check("a group is all of it or none of it", () => {
  // The reason to group them: a mount that can be started but not stopped
  // leaves the runtime holding a job it cannot end, and one that reports
  // activity but cannot release leaves a container nobody collects. Neither
  // half is useful alone, so the type demands both and this says so out loud.
  for (const p of everyPlugin) {
    if (p.holds && typeof p.holds.release !== "function") throw new Error(`${p.id} holds but cannot release`);
    if (p.holds && typeof p.holds.activity !== "function") throw new Error(`${p.id} holds but cannot say what`);
    if (p.background && typeof p.background.cancel !== "function") throw new Error(`${p.id} starts work it cannot stop`);
    if (p.background && typeof p.background.poll !== "function") throw new Error(`${p.id} starts work it cannot report on`);
  }
  if (!everyPlugin.some((p) => p.background)) {
    throw new Error("no plugin declares background work; the rule above is vacuous");
  }
});

/**
 * The offline half of a verification check.
 *
 * The call itself needs a live run9 or AppWorld, but everything before the call
 * does not — and that half is where a person's mistakes actually land: nothing
 * pasted, the wrong shape pasted, one of a pair missing. Those must answer in
 * words someone can act on rather than throwing, because the page shows the
 * reason beside the box they just typed in.
 */
await check("a verification refuses a malformed credential in words, without calling anything", async () => {
  const ctx = (credential: string | null): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "gh",
    credential, publicConfig: {},
    connection: { get: async () => null, set: async () => {} },
    sibling: async () => null,
  });
  for (const [plugin, partial] of [[run9, JSON.stringify({ ak: "x" })], [spotify!, JSON.stringify({ username: "u" })]] as const) {
    if (typeof plugin.checkCredential !== "function") throw new Error(`${plugin.id} has no check`);
    for (const [label, value] of [["absent", null], ["not json", "oops"], ["half a pair", partial]] as const) {
      const r = await plugin.checkCredential(ctx(value));
      if (r.ok) throw new Error(`${plugin.id} accepted a ${label} credential`);
      if (!r.reason || r.reason.length < 10) throw new Error(`${plugin.id} gave no usable reason for ${label}`);
      // A malformed credential is a verdict, not a missing one: nothing was
      // called, and the answer will not change by trying again.
      if (r.kind !== "rejected") throw new Error(`${plugin.id} called a ${label} credential ${r.kind}`);
    }
  }
});

await check("the plugins that take a credential are the plugins that can verify one", () => {
  // An account is what makes a verified state useful — "acting as X" is
  // checkable against what the person typed, where a bare "verified" is not.
  // The contract allows a check to succeed without naming anything, and `exa`
  // is the one that does: Exa's API exposes no identity endpoint, so there is
  // nothing to name. A page cannot rely on an account being there any more —
  // it has to render a verified mount that names nobody.
  for (const plugin of everyPlugin) {
    const takesOne = credentialForm(plugin.credential).kind !== "none";
    const canCheck = typeof plugin.checkCredential === "function";
    if (takesOne && !canCheck) {
      throw new Error(`${plugin.id} takes a credential and cannot tell anyone whether it works`);
    }
    if (!takesOne && canCheck) {
      throw new Error(`${plugin.id} has a check but no credential to check`);
    }
  }
});

/**
 * A provider that says no and a provider that says nothing are different news.
 *
 * Under the route's rule a rejected key is refused and an unreachable one is
 * kept unverified, so getting this backwards either throws away a good key
 * during an outage or keeps one that is known not to work. The connection is
 * refused on the spot here — no DNS, no external network, ~90 ms.
 */
await check("a provider that cannot be reached is unreachable, not a rejection", async () => {
  const dead = "http://127.0.0.1:1";
  const ctx = (credential: string, publicConfig: any = {}): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "gh",
    credential, publicConfig,
    connection: { get: async () => null, set: async () => {} },
    sibling: async () => null,
  });
  const cases = [
    ["run9", run9, JSON.stringify({ ak: "a", sk: "b" }), { endpoint: dead }],
    ["appworld", appworldPlugins(catalogue, { apiBaseUrl: dead })[0]!, JSON.stringify({ username: "u", password: "p" }), {}],
  ] as const;
  for (const [name, plugin, cred, cfg] of cases) {
    const r = await plugin.checkCredential!(ctx(cred, cfg));
    if (r.ok) throw new Error(`${name} verified a credential against a dead endpoint`);
    if (r.kind !== "unreachable") {
      throw new Error(`${name} called an unreachable provider "${r.kind}", so a good key would be refused during an outage`);
    }
  }
});

await check("every failure says which kind it is, because the field is not optional", () => {
  // The guard against the shape drifting back to a bare reason: a plugin that
  // returns no `kind` would be read as neither, and the route would have to
  // guess which of the two behaviours to apply.
  for (const plugin of everyPlugin) {
    if (typeof plugin.checkCredential !== "function") continue;
    const src = plugin.checkCredential.toString();
    if (/ok:\s*false/.test(src) && !/kind:/.test(src)) {
      throw new Error(`${plugin.id} returns a failure without a kind`);
    }
  }
});

/**
 * The escape hatch is two tools because a gate is decided per tool.
 *
 * `sideEffects` is a property of the schema, not of the arguments — the gateway
 * reads `schema.sideEffects` and never the call — so one `api` that could GET or
 * POST had to declare the wider of the two, and reading a label was held for a
 * person exactly as deleting one was. A gate that stops the harmless thing is a
 * gate people learn to wave through.
 */
await check("reading through the escape hatch does not wait for a person, writing does", () => {
  const gated = { write: "approval" as const };
  const verdict = (name: string) => {
    const t = githubPlugin.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return policyFor(gated, name, t.sideEffects);
  };
  if (verdict("api_get") !== "allow") throw new Error("a read through api_get was held for approval");
  if (verdict("api") !== "approval") throw new Error("a write through api was not held");
  // The split is only safe while the read tool cannot write: no method, no body.
  const get = githubPlugin.tools.find((t) => t.name === "api_get")!;
  const props = Object.keys((get.parameters as any).properties ?? {});
  if (props.join() !== "path") throw new Error(`api_get takes ${props.join(",")} — a read tool with a method is a write tool`);
});

/**
 * The seed list, checked against the plugins it names.
 *
 * `validateMount` exists to catch a mount carrying `timeout_ms` where the
 * plugin reads `timeoutMs`, and the console runs it — but only to *show* the
 * problem on the plugins page, to a person who happens to open it
 * (`cf/src/index.ts` calls `validateMount` only there). Nothing runs it over
 * `DEFAULT_MOUNTS`, which is the one config every agent gets, written by hand,
 * and seeded by both paths since
 * #103. A typo there would reach every agent, be used as the plugin's default
 * for ever, and say so only to whoever opened that page.
 */
const seeded = AgentRuntime.DEFAULT_MOUNTS as Array<{
  alias: string; plugin: string; config?: Record<string, unknown>; secretRef?: string | null;
}>;

await check("每个默认挂载的设置都通过校验", () => {
  for (const m of seeded) {
    const plugin = everyPlugin.find((p) => p.id === m.plugin);
    // A seed naming a plugin nobody installed is a mount whose every call the
    // gateway refuses, and it looks fine in the list until something calls it.
    if (!plugin) throw new Error(`${m.alias} seeds plugin "${m.plugin}", which is not installed`);
    const problems = validateMount(plugin, (m.config ?? {}) as any, m.secretRef ?? null);
    if (problems.length) {
      throw new Error(`${m.alias}: ${problems.map((x) => x.message).join("; ")}`);
    }
  }
});

await check("每个 agent 一开始就有记忆", () => {
  // What the README states since #101, held here rather than in prose: the
  // memory plugin is part of the set every agent is seeded with, so an agent
  // that has never been opened in the console can still write a note.
  if (!seeded.some((m) => m.plugin === "state")) {
    throw new Error("the seed list has no state mount, so a new agent cannot write anything down");
  }
  // Mounts are keyed by alias, so two entries sharing one are not two mounts.
  const aliases = seeded.map((m) => m.alias);
  const dupes = aliases.filter((a, i) => aliases.indexOf(a) !== i);
  if (dupes.length) throw new Error(`the seed list repeats an alias: ${dupes.join(", ")}`);
});

await check("陌生人注册进来,拿到的不是一套假的运维工具", () => {
  // `ops` (the demo plugin) was seeded until sign-up opened. Its tools are a
  // fake fleet — `deploy` says "Changes production" and restarts a server that
  // does not exist — and it sat on the first screen of every new account. A
  // demonstration is something an operator chooses to show; being issued one is
  // different. The plugin is still installed, so mounting it is one act away.
  //
  // Named plugin by plugin only until `availability: "opt-in"` exists; the
  // general form of this check is "nothing opt-in is seeded", and it should
  // replace this one rather than sit beside it.
  const shown = seeded.filter((m) => m.plugin === "demo");
  if (shown.length) {
    throw new Error(`the seed list hands every new agent a demonstration: ${shown.map((m) => m.alias).join(", ")}`);
  }
});

await check("没有 summary 把分派地址当成工具名交给模型", () => {
  // `<alias>.<tool>` is what the harness dispatches on. It is not what the model
  // is offered: `qualifyMountedTools` gives it the bare tool name, and
  // `<alias>__<tool>` only when a second mount has the same one — which depends
  // on the whole mounted set, so no plugin can predict it. A summary naming
  // `node.save` therefore names nothing callable, and the agent reading it
  // spends a turn finding that out. Summaries only: a runtime string is not
  // here to be read.
  const toolNames = new Set(everyPlugin.flatMap((p) => p.tools.map((t) => t.name)));
  const prose = everyPlugin.flatMap((p) => [
    ...p.tools.map((t) => ({ where: `${p.id}.${t.name}`, text: t.summary })),
    ...(p.config ?? []).map((f) => ({ where: `${p.id} config ${f.name}`, text: f.summary })),
  ]);
  for (const { where, text } of prose) {
    for (const m of String(text).matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]+)\b/g)) {
      if (toolNames.has(m[2]!)) {
        throw new Error(`${where} offers "${m[0]}", which is a dispatch address and not a tool the model can call`);
      }
    }
  }
});

await check("带凭据的 http 挂载必须点名它的 host", () => {
  // For every other credential plugin the host is fixed by the plugin; here the
  // *agent* chooses the URL, so an unset allowlist means a key that travels
  // wherever it points. The comment at http.ts said this "should be refused at
  // mount time" — a should in a comment is not a does in code, and this is the
  // does. Checked against the mount's secret_ref, not the plugin's credential
  // declaration: `secret_ref` is a mount field, so a mount can carry a key
  // before the plugin ever declares one.
  const refused = (config: any, ref: string | null) =>
    validateMount(httpPlugin, config, ref).some((p) => /carries a credential, so "allowedHosts"/.test(p.message));

  if (!refused({ account: "x" }, "secret:web")) throw new Error("an unset allowlist was accepted on a mount holding a key");
  // Three ways to have no list, and all three have to count. The empty array is
  // the one most easily missed, because in type terms it is a value.
  if (!refused({ account: "x", allowedHosts: null }, "secret:web")) throw new Error("an explicit null allowlist was accepted on a mount holding a key");
  if (!refused({ account: "x", allowedHosts: [] }, "secret:web")) throw new Error("an empty allowlist was accepted on a mount holding a key");
  if (refused({ account: "x", allowedHosts: ["api.example.com"] }, "secret:web")) throw new Error("a named host was refused");
  // And nothing changes for the anonymous mount every agent already has.
  if (refused({ account: "open web", maxBytes: 24_000 }, null)) throw new Error("the anonymous web mount was refused");

  // "Refused at mount time" means the throwing half, which provision calls.
  let threw = "";
  try { assertMountConfig(httpPlugin, { account: "x" } as any, "secret:web"); }
  catch (e) { threw = String((e as Error).message); }
  if (!/cannot mount http/.test(threw)) throw new Error(`it validates but does not refuse: ${threw || "no throw"}`);
});

await check("释放记录带着最后一次使用的时间,所以闲置时长算得出来", () => {
  // `endedAt - startedAt` is how long the box lived; the release policy turns on
  // how long it sat unused, and that is only computable if the record carries
  // `lastUsedAt`. The live state maintains it on every call and the release path
  // resets every other field of that state to zero — so the danger is not a
  // deleted line, it is one more token on a line that already looks right.
  const s = sessionOf(
    { boxId: "b-1", createdAt: 1_000, lastUsedAt: 4_000, execs: 3, saved: ["r2://x"] }, 10_000);
  if (s.lastUsedAt !== 4_000) throw new Error(`lastUsedAt was dropped: ${JSON.stringify(s)}`);
  if (s.endedAt - s.lastUsedAt !== 6_000) throw new Error("idle time is not computable from the record");
  if (s.endedAt - s.startedAt !== 9_000) throw new Error("lifetime changed meaning");
  if (s.execs !== 3 || s.saved.join() !== "r2://x") throw new Error("the rest of the record moved");

  // A box that was never used after it was created: idle since creation, not
  // zero, because a zero here would read as "used a moment ago".
  const never = sessionOf({ boxId: "b-2", createdAt: 2_000 }, 5_000);
  if (never.lastUsedAt !== 2_000) throw new Error(`an unused box reported ${never.lastUsedAt}`);
  if (never.execs !== 0 || never.saved.length !== 0) throw new Error("defaults are wrong");
});

/**
 * A quiet request that is too long is refused, not shortened.
 *
 * The ceiling is the only thing between "remind me later" and "never release
 * it", and an agent silently given an hour when it asked for a day plans
 * against the day: it will not come back in time, and the box is billed for
 * every second in between. So the refusal has to be a refusal, and it has to
 * say the number the mount actually allows — a "no" without the ceiling leaves
 * the agent guessing at a second request.
 */
await check("a quiet request over the mount's ceiling is refused, and the refusal names the ceiling", async () => {
  const ctx = (config: Record<string, unknown>, state: unknown): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "box",
    credential: JSON.stringify({ ak: "x", sk: "y" }), publicConfig: config,
    connection: { get: async () => state, set: async () => { written.push(true); } },
    sibling: async () => null,
  });
  const written: boolean[] = [];
  const live = { boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000 };

  // Over the default ceiling of 60.
  let refused = "";
  try { await run9.invoke("quiet", { minutes: 1440 } as any, ctx({}, live)); }
  catch (e) { refused = String((e as Error).message); }
  if (!refused) throw new Error("a day-long quiet request was accepted");
  if (!refused.includes("60")) throw new Error(`the refusal does not name the ceiling: ${refused}`);
  if (!refused.includes("box")) throw new Error(`the refusal does not name the mount: ${refused}`);
  if (written.length) throw new Error("a refused request still wrote state");

  // The operator's own ceiling, not the default.
  let ownRefusal = "";
  try { await run9.invoke("quiet", { minutes: 20 } as any, ctx({ maxQuietMinutes: 10 }, live)); }
  catch (e) { ownRefusal = String((e as Error).message); }
  if (!ownRefusal.includes("10")) throw new Error(`the mount's own ceiling was not used: ${ownRefusal}`);

  // Not a number, and zero: both are refusals rather than "quiet forever".
  for (const bad of [undefined, null, "30", 0, -5, Infinity, NaN]) {
    let threw = false;
    try { await run9.invoke("quiet", { minutes: bad } as any, ctx({}, live)); } catch { threw = true; }
    if (!threw) throw new Error(`quiet accepted ${JSON.stringify(bad)} as a duration`);
  }
  if (written.length) throw new Error("a refused request still wrote state");
});

/**
 * An accepted quiet request records an instant, and only that.
 *
 * `quietUntil` is written by this plugin and read by the framework's idle wake,
 * so the two halves meet on this field and on nothing else. The test pins the
 * shape rather than the wording: an instant in the future, the rest of the
 * state carried over, and no box invented when there is none.
 */
await check("an accepted quiet request records when to ask again, and leaves the rest of the state alone", async () => {
  let saved: any = null;
  const ctx = (state: unknown): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "box",
    credential: JSON.stringify({ ak: "x", sk: "y" }), publicConfig: {},
    connection: { get: async () => state, set: async (v: unknown) => { saved = v; } },
    sibling: async () => null,
  });
  // Under a lease: only there is a postponement something reads. The case after this one holds the other side.
  const leasedBox = sandboxPlugin(null as any, "local", { warnMs: 5 * 60_000, maxMs: 30 * 60_000 });
  const before = Date.now();
  const r: any = await leasedBox.invoke("quiet", { minutes: 30 } as any,
    ctx({ boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000, execs: 4, envs: [] }));
  if (r.quiet !== true) throw new Error(`a request inside the ceiling was not accepted: ${JSON.stringify(r)}`);
  if (!saved?.quietUntil) throw new Error("nothing was recorded for the wake to read");
  const minutes = (saved.quietUntil - before) / 60_000;
  if (minutes < 29 || minutes > 31) throw new Error(`quietUntil is ${minutes} minutes out, not 30`);
  if (saved.boxId !== "b-1" || saved.execs !== 4) throw new Error("the rest of the box state was dropped");
  // The one field it must not move. Every other handler in the plugin bumps
  // `lastUsedAt`, so "make quiet consistent with the rest" is a plausible edit
  // — and it would record a postponement as a use, which the idle pass and the
  // console both need to tell apart (idle-lease.ts `releaseAt`).
  if (saved.lastUsedAt !== 2_000) throw new Error(`quiet moved lastUsedAt to ${saved.lastUsedAt}, recording a postponement as a use`);

  // No box: nothing will be asked about, so there is nothing to put off. It
  // answers instead of throwing, the way `release` does on an empty mount.
  saved = null;
  const none: any = await leasedBox.invoke("quiet", { minutes: 5 } as any, ctx(null));
  if (none.quiet !== false) throw new Error(`quiet on an empty mount answered ${JSON.stringify(none)}`);
  if (saved) throw new Error("quiet wrote state for a box that does not exist");
});

/**
 * Without a lease, `quiet` says it did nothing, and does nothing.
 *
 * With no lease a box is handed back when the turn ends, and no idle wake reads
 * `quietUntil`. Answering `quiet: true` with an instant would be a postponement
 * nobody performs — the agent plans to come back to a machine that will be gone.
 */
await check("without a lease, quiet answers that there is nothing to postpone and records nothing", async () => {
  let saved: any = null;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "box",
    credential: JSON.stringify({ ak: "x", sk: "y" }), publicConfig: {},
    connection: { get: async () => ({ boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000 }), set: async (v: unknown) => { saved = v; } },
    sibling: async () => null,
  };
  const r: any = await run9.invoke("quiet", { minutes: 30 } as any, ctx);
  if (r.quiet !== false) throw new Error(`quiet without a lease answered ${JSON.stringify(r)}`);
  if (!/turn ends/.test(String(r.note))) throw new Error(`the answer does not say why: ${JSON.stringify(r)}`);
  if (saved) throw new Error("quiet without a lease recorded a postponement nothing will read");
});

/**
 * Every ending of `start_from` says whether the container was released.
 *
 * The tool's summary used to promise a release without conditions, while the
 * call that only lists what is kept performs none — so a model reading
 * `{kept: [], note}` could not tell whether its container had just been taken
 * away. The field exists precisely so that nobody has to
 * infer it, which is a property worth a case of its own: removed, the plugin
 * still passes everything else (Vera checked, and it did).
 */
await check("start_from 的每一个结局都直说【释放了没有】,而且只列出的那次什么也不释放", async () => {
  const calls: string[] = [];
  const kept = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: any) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return new Response("{}");
  }) as any;
  let saved: any = null;
  const ctx = (state: unknown): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "x" }, alias: "box",
    credential: JSON.stringify({ ak: "x", sk: "y" }), publicConfig: {},
    connection: { get: async () => state, set: async (v: unknown) => { saved = v; } },
    sibling: async () => null,
  });
  const live = { boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000, execs: 1,
    envs: [{ name: "ready", snapId: "s-1", savedAt: 5 }] };
  try {
    const listed: any = await run9.invoke("start_from", {} as any, ctx(live));
    if (listed.released !== false) {
      throw new Error(`listing what is kept did not say it released nothing: ${JSON.stringify(listed)}`);
    }
    if (calls.length) throw new Error(`listing what is kept called run9: ${JSON.stringify(calls)}`);
    if (saved) throw new Error("listing what is kept wrote connection state");

    const chosen: any = await run9.invoke("start_from", { name: "ready" } as any, ctx(live));
    if (chosen.released !== true || chosen.releasedPrevious !== "b-1") {
      throw new Error(`naming one released the old container without saying so: ${JSON.stringify(chosen)}`);
    }
    // Nothing was running, so nothing was let go — and that ending has to say
    // so too, or `released` would only ever appear when it is true, which is
    // the inference the field exists to remove.
    saved = null;
    const empty: any = await run9.invoke("start_from", { name: "ready" } as any,
      ctx({ boxId: "", createdAt: 0, lastUsedAt: 0, envs: live.envs }));
    if (empty.released !== false) {
      throw new Error(`choosing an environment with no container running answered ${JSON.stringify(empty)}`);
    }
  } finally {
    globalThis.fetch = kept;
  }
});

/**
 * The three places that tell the model how the box ends must end it the same way.
 *
 * `run` and `shell` describe the container before it exists; the per-execution
 * reminder describes it while it does. An agent reads whichever it happens to
 * be looking at, and it cannot tell which is stale — so a promise mended in one
 * and left in another is worse than the original wrong sentence: it is wrong
 * only sometimes.
 *
 * **Consistency was all this case checked, so it held three copies of a false
 * sentence green.** "Persists between calls" was never true of a deployment
 * with no idle lease — which is production: a settled turn hands its containers
 * back. Vera's probe found nine containers for one agent, `uses: 1` each, while
 * the model quoted the line. So the assertions now name the
 * lifetime the runtime actually gives — this turn — and refuse the promise that
 * outlived it. Three agreeing statements are worth nothing if all three are
 * wrong, and only the wording can be checked here; what makes it true is
 * `cf/src/runtime.ts` releasing on a settled turn while `idle` is unset.
 */
await check("run, shell and the per-execution reminder end the container the same way", async () => {
  const run = run9.tools.find((t) => t.name === "run")!.summary;
  const shell = run9.tools.find((t) => t.name === "shell")!.summary;
  const reminder = boxReminder("box");
  // With a lease all three state the other lifetime, and none of them the turn's.
  const lease = { warnMs: 5 * 60_000, maxMs: 30 * 60_000 };
  const leased = sandboxPlugin(null as any, "local", lease);
  const leasedReminder = boxReminder("box", lease);
  for (const [where, text] of [
    ["leased run", leased.tools.find((t) => t.name === "run")!.summary],
    ["leased shell", leased.tools.find((t) => t.name === "shell")!.summary],
    ["the leased reminder", leasedReminder],
  ] as const) {
    if (!/until you release it/.test(text) || !/later ones/.test(text)) {
      throw new Error(`${where} does not say the container stays, in later turns, until the agent releases it: ${text.slice(0, 200)}`);
    }
    if (!/after 30 idle minutes it is released/.test(text) || !/5 minutes before that you are told/.test(text)) {
      throw new Error(`${where} does not state the lease's own numbers: ${text.slice(0, 240)}`);
    }
    // The agent can keep the box, and the text says with what.
    if (!/`quiet` postpones the release/.test(text)) {
      throw new Error(`${where} does not say the release can be postponed with quiet: ${text.slice(0, 240)}`);
    }
    // /tmp is a tmpfs in a run9 box and was emptied while the box sat idle; the working directory was not
    // (production, 2026-09-15). An agent told only "files survive" keeps its work where it will vanish.
    if (!/files under \/tmp do not survive while it sits idle/.test(text) || !/keep your work in the working directory/.test(text)) {
      throw new Error(`${where} does not say /tmp is lost while the box is idle, or where to keep work: ${text.slice(-240)}`);
    }
    if (/handed back when the turn ends|every call in this turn uses/.test(text)) {
      throw new Error(`${where} still ends the container with the turn under a lease: ${text.slice(0, 200)}`);
    }
  }
  // Silence has a consequence under a lease, and the reminder is the one an agent holds when it matters.
  if (!/\bkeep\b/.test(leasedReminder) || !leasedReminder.includes("box")) {
    throw new Error(`the leased reminder does not name what survives it, or the mount: ${leasedReminder}`);
  }
  for (const [where, text] of [["run", run], ["shell", shell], ["the reminder", reminder]] as const) {
    // Each says how far the container reaches: every call in this turn, which
    // is the part an agent can plan against.
    if (!/every call in this turn|same one for every call in this turn|this turn uses the same one/.test(text)) {
      throw new Error(`${where} no longer says the container is the same one for every call in this turn: ${text.slice(0, 160)}`);
    }
    // …and each says the same thing about where it stops. An agent that reads
    // only one of the three must not come away planning a second turn in a
    // container that will not be there.
    if (!/handed back when the turn ends/.test(text)) {
      throw new Error(`${where} says the box survives calls without saying the turn ends it: ${text.slice(0, 160)}`);
    }
    // The sentence that was wrong for as long as it existed. It is refused by
    // name, because "persists between calls" is exactly what someone tidying
    // this wording would write again.
    if (/persists between calls|persists across calls|until you release it/.test(text)) {
      throw new Error(`${where} promises the container outlives the turn, which no deployment does: ${text.slice(0, 160)}`);
    }
    if (/goes idle|idle long enough/.test(text)) {
      throw new Error(`${where} promises the idle question while the lease is off: ${text.slice(0, 160)}`);
    }
  }
  // What outlives a turn is a kept filesystem, and the reminder is the one an
  // agent is holding at the moment it matters — when its container is about to
  // go and it has not saved anything.
  if (!/\bkeep\b/.test(reminder)) {
    throw new Error(`the reminder ends the container without naming what survives it: ${reminder}`);
  }
  // When the lease is switched on, the reminder is also the one that has to say
  // silence has a consequence — the other two describe a box that may not exist
  // yet. That assertion belongs to the change that sets the numbers.
  // And it names the mount, because an agent with two of them cannot act on
  // "the container".
  if (!reminder.includes("box")) throw new Error(`the reminder does not name the mount: ${reminder}`);
});

/**
 * The artifacts paragraph follows its mount's name.
 *
 * It used to be the framework's sentence, printed whenever a flag said an
 * artifacts tool was around, and it called the thing "the artifacts tool" — a
 * name that is only right while the operator happens to have used it. Written
 * by the mount, it can say the name that mount actually has. The test mounts it
 * under a different alias for the same reason the bug existed: the default one
 * hides the difference.
 */
await check("the artifacts paragraph names the mount it came from, whatever it is called", async () => {
  const plugin = artifactsPlugin({} as any, "bucket");
  const say = async (alias: string) =>
    (await plugin.promptContribution!({ alias, caller: { tenantId: "t", agentId: "a", taskId: "k" } } as any)) ?? "";

  for (const alias of ["artifacts", "files"]) {
    const text = await say(alias);
    if (!text.includes(`\`${alias}\``)) throw new Error(`mounted as ${alias}, the paragraph says: ${text}`);
    if (!text.includes("read")) throw new Error(`the paragraph does not say which tool reads one back: ${text}`);
    // The qualified form is for telling the model to call something now; a
    // description names the mount and the bare tool.
    if (text.includes("__")) throw new Error(`a description should not carry a qualified tool name: ${text}`);
  }
});

/**
 * Two layers, and the order between them is the design.
 *
 * The layers exist because "not mounted" could not say why: an agent that had
 * never been offered a plugin and an agent that had turned it off looked the
 * same, and provisioning — which adds whatever is missing on every console
 * open — treated the second as the first and put it back. So silence has to be
 * distinguishable from a decision, which is what `"inherit"` is for.
 *
 * The half worth a test is the precedence: an agent's own answer wins over the
 * plugin's default, in both directions. A default that flips must not move an
 * agent that has already chosen — otherwise turning a plugin on for everyone
 * silently re-arms it for the people who turned it off.
 */
await check("an agent's own answer beats the plugin default, in both directions", async () => {
  const onByDefault = { defaultForAllAgents: true };
  const optIn = { defaultForAllAgents: false };
  const undeclared = {};

  const cases: Array<[typeof optIn | Record<string, never>, PluginChoice | null | undefined, boolean, string]> = [
    [onByDefault, "inherit", true, "inherit follows a default of on"],
    [onByDefault, null, true, "no record is the same as inherit"],
    [onByDefault, undefined, true, "an absent record is the same as inherit"],
    [onByDefault, "disable", false, "an agent may refuse what everyone else gets"],
    [optIn, "inherit", false, "inherit follows a default of off"],
    [optIn, "enable", true, "an agent may ask for what nobody else gets"],
    [undeclared, "inherit", false, "a plugin that did not declare belongs to nobody by default"],
    [undeclared, "enable", true, "and can still be asked for"],
  ];
  for (const [plugin, choice, want, why] of cases) {
    const got = pluginEnabled(plugin as any, choice);
    if (got !== want) throw new Error(`${why}: pluginEnabled(${JSON.stringify(plugin)}, ${JSON.stringify(choice)}) = ${got}`);
  }
});

/**
 * What the declarations say today, held against what is actually seeded.
 *
 * The flag is only worth having if it means the same thing the seed list means,
 * and the two live in different files — one in each plugin, one in
 * `cf/src/runtime.ts`. This is the test that notices when they drift: a plugin
 * that starts claiming every agent without being seeded, or a seed for a plugin
 * that says it belongs to nobody.
 *
 * `demo` needed an exception while it was leaving the seed list (#213). It has
 * left, so the exception is gone: it now passes the same way every other opt-in
 * plugin does — declared by nobody, seeded by nobody — and if anyone puts it
 * back in either place without the other, this fails.
 */
await check("the plugins that claim every agent are the ones actually seeded", async () => {
  const declared = new Set(
    [statePlugin({} as any, null, "b"), httpPlugin, githubPlugin, run9, demoPlugin]
      .filter((p) => (p as any).defaultForAllAgents === true)
      .map((p) => p.id),
  );
  // The two builtin ones are constructed with runtime handles this suite does
  // not have; their ids are checked against the seed list instead.
  const seeded = new Set(AgentRuntime.DEFAULT_MOUNTS.map((m) => m.plugin));
  for (const id of declared) {
    if (!seeded.has(id)) throw new Error(`${id} claims every agent but nothing seeds it`);
  }
  for (const id of seeded) {
    if (id === "tools" || id === "artifacts") continue;
    if (!declared.has(id)) throw new Error(`${id} is seeded to every agent but does not declare it`);
  }
});

/**
 * A mount with something running under it cannot be renamed yet.
 *
 * The operation moves rows in `mounts` and `connections`, both keyed by the
 * alias. Doing that while a container is alive is the one case that hurts: the
 * box keeps billing under a name nothing looks up any more, and `release` reads
 * the new alias and finds nothing. So the rule is "wait", and the refusal has
 * to carry the number the person needs next — how long it has been idle tells
 * them whether to wait or to release it.
 */
await check("a mount is renamable only while nothing is running under it", async () => {
  const now = 10_000;
  const idle = renameSafety(activityOf(null), now);
  if (!idle.safe) throw new Error("an empty mount refused a rename");
  if (!renameSafety({ live: null }, now).safe) throw new Error("no live resource still refused");
  if (!renameSafety(undefined, now).safe) throw new Error("an unknown mount refused a rename");

  const busy = renameSafety(activityOf({ boxId: "b-9", createdAt: 1_000, lastUsedAt: 4_000 } as any), now);
  if (busy.safe) throw new Error("a running container let the rename through");
  if (busy.live.id !== "b-9") throw new Error(`the refusal does not name what is running: ${JSON.stringify(busy)}`);
  if (busy.live.idleMs !== 6_000) throw new Error(`idle time is wrong: ${busy.live.idleMs}`);
  if (!/release|idle/.test(busy.reason)) throw new Error(`the refusal does not say what to do: ${busy.reason}`);

  // A box that has never been used dates from its creation, not from zero —
  // the same rule the release record follows, so the two agree about age.
  const fresh = renameSafety(activityOf({ boxId: "b-1", createdAt: 7_000 } as any), now);
  if (fresh.safe || fresh.live.idleMs !== 3_000) throw new Error(`an unused box reported ${JSON.stringify(fresh)}`);
});

/**
 * "The provider is run9" is a claim the code can refuse, not a comment.
 *
 * The plugin is the capability — a sandbox — and run9 is who supplies one
 * today. Writing that as a setting with `choices` means a mount asking for
 * something else is refused at the page; this test is about the other door,
 * the mount that reaches the call anyway. It must not fall through to the
 * provider we happen to implement: "it ran on run9" is the wrong answer to
 * "run it somewhere else", and it is wrong silently.
 */
await check("a sandbox mount asking for a provider we do not have is refused, not quietly run on run9", async () => {
  if (providerOf({}) !== "run9") throw new Error("the default provider is not run9");
  if (providerOf({ provider: "run9" }) !== "run9") throw new Error("run9 was not accepted by name");

  for (const asked of ["fly", "e2b", "", "RUN9"]) {
    let refused = "";
    try { providerOf({ provider: asked }); } catch (e) { refused = String((e as Error).message); }
    if (!refused) throw new Error(`the "${asked}" provider was accepted, and would have run on run9`);
    if (!refused.includes(asked)) throw new Error(`the refusal does not name what was asked for: ${refused}`);
  }

  // And the setting itself carries the list, so the console and the mount
  // validator refuse the same values without repeating them.
  const field = (run9.config ?? []).find((f) => f.name === "provider");
  if (!field) throw new Error("the plugin no longer declares which provider a mount may ask for");
  if (JSON.stringify(field.choices) !== JSON.stringify(["run9"])) {
    throw new Error(`the declared choices and the implemented providers disagree: ${JSON.stringify(field.choices)}`);
  }
});

/**
 * The mount answers "is something running here", so nobody has to look inside it.
 *
 * The rename asks before it moves rows, the console panel asks before it draws,
 * and the idle sweep asks before it nudges. Each of them used to read `boxId`
 * out of the sandbox's connection state, which is why the panel could only find
 * a container under the alias `node`. The two rules worth pinning are that it
 * answers without a credential — it is asked precisely when a mount is unused,
 * and an unused mount may have had its key removed — and that a mount holding
 * nothing says so rather than throwing.
 */
await check("a mount reports what it is holding, with no credential and no call out", async () => {
  const ctx = (state: unknown): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: null, publicConfig: {},
    connection: { get: async () => state, set: async () => {} },
    sibling: async () => null,
  });
  if (typeof run9.holds?.activity !== "function") throw new Error("the sandbox no longer reports its activity");

  const empty = await run9.holds!.activity(ctx(null));
  if (empty.live !== null) throw new Error(`an empty mount reported ${JSON.stringify(empty)}`);

  const busy = await run9.holds!.activity(ctx({ boxId: "b-7", createdAt: 1_000, lastUsedAt: 5_000 }));
  if (busy.live?.id !== "b-7" || busy.live?.lastUsedAt !== 5_000) {
    throw new Error(`a running container was not reported: ${JSON.stringify(busy)}`);
  }
  // And the decision built on it agrees, so the two halves cannot drift: the
  // rename refuses exactly when the mount says something is live.
  if (renameSafety(busy, 6_000).safe) throw new Error("a live container did not block a rename");
  if (!renameSafety(empty, 6_000).safe) throw new Error("an empty mount blocked a rename");
});

/**
 * The session window forgets, and that is why it is not the audit record.
 *
 * It keeps the newest handful and drops the rest with nothing saying so, and a
 * container reaches it only by being released — a leaked one, or one whose
 * worker died mid-call, never appears. Both limits are fine for a console
 * meter and fatal for "what did this tenant use", which is why that record
 * belongs where the provider's key is held.
 *
 * The test exists so the cap cannot quietly become "keep everything" (a
 * connection record that grows without bound) or "keep one" (a panel that
 * forgets what the agent did an hour ago) without someone deciding to.
 */
await check("the session window keeps the newest and drops the rest, which is why it is a meter", () => {
  const at = (n: number) => sessionOf({ boxId: `b-${n}`, createdAt: n, lastUsedAt: n }, n + 10);
  let window: ReturnType<typeof sessionOf>[] = [];
  for (let n = 1; n <= 25; n++) window = keepSessions(window, at(n));

  if (window.length !== 20) throw new Error(`the window holds ${window.length}, not the declared 20`);
  if (window[0]!.boxId !== "b-25") throw new Error(`the newest is not first: ${window[0]!.boxId}`);
  if (window.some((s) => s.boxId === "b-5")) throw new Error("an entry past the cap survived");
  // The dropped ones leave nothing behind — no count, no marker. That is the
  // property that makes reading this as a total wrong.
  if (JSON.stringify(window).includes("dropped")) throw new Error("the window now claims to say what it lost");

  // And an empty history is a first session, not a crash.
  const first = keepSessions(undefined, at(1));
  if (first.length !== 1 || first[0]!.boxId !== "b-1") throw new Error("the first release did not record");
});

/**
 * The three strings say what this deployment does, in both directions.
 *
 * Half of this was already structural: writing the lease promise while the
 * lease is off turns the test above red. The other half was a comment and a
 * memory — nothing stopped someone setting the two numbers and leaving the
 * sentences describing the old behaviour, which is the same defect the
 * reminder itself carried for months, only pointing the other way (Vera).
 *
 * So the configuration is the input. Whether the lease runs is decided by
 * `RUN9_WARN_MINUTES` being positive and `RUN9_MAX_IDLE_MINUTES` larger
 * (`cf/src/index.ts`), and the wording has to agree with them. Turning
 * the lease on without rewriting the strings fails here, and rewriting them
 * without turning it on fails above. Neither direction needs anyone to
 * remember anything.
 */
await check("the container's wording and the lease switch say the same thing", async () => {
  const jsonc = await readFile(new URL("../cf/wrangler.jsonc", import.meta.url), "utf8");
  // Deliberately dumb, but not dumb about where the value sits: the first
  // version anchored to the start of a line, so two variables written on one
  // line hid the second one and the test went quiet instead of red (Vera found
  // this by breaking it and getting green). Comment lines are dropped, since a
  // comment naming the variable is not the variable being set.
  const code = jsonc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const setting = (name: string) => {
    const m = code.match(new RegExp(`"${name}"\\s*:\\s*"?(\\d+)"?`));
    return m ? Number(m[1]) : 0;
  };
  // The same rule cf/src/index.ts applies to the same two numbers.
  const leaseOn = setting("RUN9_WARN_MINUTES") > 0 && setting("RUN9_MAX_IDLE_MINUTES") > setting("RUN9_WARN_MINUTES");
  // The plugin as this deployment builds it: cf/src/runtime.ts hands it the lease these two numbers make
  // (cf/src/index.ts), so the wording checked is the wording production sends.
  const lease = leaseOn
    ? { warnMs: setting("RUN9_WARN_MINUTES") * 60_000, maxMs: setting("RUN9_MAX_IDLE_MINUTES") * 60_000 }
    : null;
  const deployed = sandboxPlugin(null as any, "local", lease);

  // The third field: whether the text states the lease's minutes. `release` describes the lease without
  // numbers, so it is held to the switch and not to the figures; it was left off this list when it began
  // describing the lease, and said so unconditionally, with nothing here to go red (2026-09-15).
  const says = [
    ["run", deployed.tools.find((t) => t.name === "run")!.summary, true],
    ["shell", deployed.tools.find((t) => t.name === "shell")!.summary, true],
    ["the reminder", boxReminder("box", lease), true],
    ["release", deployed.tools.find((t) => t.name === "release")!.summary, false],
    ["quiet", deployed.tools.find((t) => t.name === "quiet")!.summary, false],
    // `keep` and `save` say what a copy does not license, and "leave it running" is a lease promise too; they
    // said it unconditionally for one merge, with nothing on this list to go red (cody, #327 review).
    ["keep", deployed.tools.find((t) => t.name === "keep")!.summary, false],
    ["save", deployed.tools.find((t) => t.name === "save")!.summary, false],
    ["keep's result", keptNote(lease), false],
    ["save's result", savedNote(lease), false],
  ] as const;
  for (const [where, text, statesMinutes] of says) {
    const promises = /goes idle|idle long enough|asked whether to keep|idle minutes it is released|postpones the release|released on its own|keeps it longer|Postpone the release|leave it running/.test(text);
    if (leaseOn && !promises) {
      throw new Error(`the lease is configured but ${where} still describes a box that only you can end: ${text.slice(0, 140)}`);
    }
    if (!leaseOn && promises) {
      throw new Error(`${where} promises the idle question, and no lease is configured to ask it: ${text.slice(0, 140)}`);
    }
    if (!leaseOn || !statesMinutes) continue;
    if (!text.includes(`after ${setting("RUN9_MAX_IDLE_MINUTES")} idle minutes`)) {
      throw new Error(`${where} does not state the configured ceiling (${setting("RUN9_MAX_IDLE_MINUTES")} minutes): ${text.slice(0, 200)}`);
    }
    // The warning is the other number the lease is built from, and nothing held it (Vera).
    if (!text.includes(`${setting("RUN9_WARN_MINUTES")} minutes before that you are told`)) {
      throw new Error(`${where} does not state the configured warning (${setting("RUN9_WARN_MINUTES")} minutes): ${text.slice(0, 260)}`);
    }
  }
});

/**
 * Who is asked whether a credential works, once something sits in front of run9.
 *
 * With our own service in the path the mount stops holding run9's key and
 * starts holding a token we issued, so asking run9 proves nothing — it has
 * never seen it — and passing the question through would make the service
 * answer whether an id the caller does not own exists, which is what it is
 * there to refuse. Which one answers is declared, not inferred from the
 * endpoint's hostname, for the same reason the provider is a setting.
 *
 * The verdicts stay the three `checkCredential` has always had, because a page
 * that cannot tell "your key is wrong" from "we could not ask" sends a person
 * to re-type a key that was fine (#45).
 */
await check("the endpoint answers for the credential when it is not the provider", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const reply = (status: number, body: string) =>
    ((url: any, init?: any) => {
      calls.push(String(url));
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;

  const ctx = (extra: Record<string, unknown>): any => ({
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", ...extra },
    connection: { get: async () => null, set: async () => {} }, sibling: async () => null,
  });
  try {
    globalThis.fetch = reply(200, "{}");
    const ok = await run9.checkCredential!(ctx({ verifyWith: "endpoint" }));
    if (!ok.ok) throw new Error(`a good token was not accepted: ${JSON.stringify(ok)}`);
    if (!calls[0]!.endsWith("/credential")) throw new Error(`asked the wrong place: ${calls[0]}`);
    if (/workspace\/boxes/.test(calls[0]!)) throw new Error("the service was asked about a box it does not own");

    calls.length = 0;
    globalThis.fetch = reply(401, "nope");
    const bad = await run9.checkCredential!(ctx({ verifyWith: "endpoint" }));
    if (bad.ok || bad.kind !== "rejected") throw new Error(`a refused token was not rejected: ${JSON.stringify(bad)}`);

    calls.length = 0;
    globalThis.fetch = reply(503, "down");
    const down = await run9.checkCredential!(ctx({ verifyWith: "endpoint" }));
    if (down.ok || down.kind !== "unreachable") {
      throw new Error(`a service outage was read as a verdict on the key: ${JSON.stringify(down)}`);
    }

    // And the default is unchanged: without the setting it still asks run9, so
    // the deployment that has no service in front keeps working.
    calls.length = 0;
    globalThis.fetch = reply(400, '{"error":"box not found"}');
    const direct = await run9.checkCredential!(ctx({}));
    if (!direct.ok) throw new Error(`the provider path broke: ${JSON.stringify(direct)}`);
    if (!/workspace\/boxes\//.test(calls[0]!)) throw new Error(`the default no longer asks run9: ${calls[0]}`);
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * The model never names a container, so it can never name someone else's.
 *
 * Every sandbox tool acts on *this mount's* box, found in this mount's own
 * connection state — none of them takes an id. That is what makes the isolation
 * hold without anything in front of run9: a shared account and a shared key are
 * safe here only because the agent has no way to say which box it means (tygg,
 * 2026-09-12: "the tool simply cannot see other people's").
 *
 * The rule is worth a test rather than a comment because breaking it looks like
 * a feature. `release(boxId)`, `logs(boxId)`, a `list` that takes a project —
 * each is an obvious thing to add, and any of them turns a shared project into
 * a reachable one. If a tool ever does need an id, the id has to be checked
 * against this mount's state before it is used, and this test is the place that
 * says so.
 */
await check("no sandbox tool lets the model name a container", () => {
  const suspect = /^(box|box_id|boxId|container|id|project|snap|snapshot|exec|execId)$/i;
  for (const t of run9.tools) {
    const props = Object.keys(((t.parameters as any) ?? {}).properties ?? {});
    const named = props.filter((p) => suspect.test(p));
    if (named.length) {
      throw new Error(
        `the \`${t.name}\` tool takes ${named.join(", ")}: the model can now say which container it means, ` +
        "and every agent shares one run9 project — check it against this mount's state first",
      );
    }
  }
  // And the property that makes the rule meaningful: the tools that act on a
  // container act on the one in this mount's state, which is the only one it
  // knows about.
  const acts = run9.tools.filter((t) => ["run", "shell", "save", "release", "quiet"].includes(t.name));
  if (acts.length !== 5) throw new Error(`the acting tools changed: ${acts.map((t) => t.name).join(", ")}`);
});

/**
 * Everything the console needs about a container, asked of the mount.
 *
 * The panel used to read `boxId`, `sessions`, `execs` and `saved` out of this
 * plugin's own connection state — the second half of the coupling the audit
 * found, and the reason it could only find a container under the alias `node`.
 * `activity` answers what is running and `usage` what has finished, so a page
 * can draw any mount that answers and skip the ones that do not.
 *
 * The two are separate calls because their callers are: a sweep on a timer
 * wants one fact and must not pay for a history it will not read.
 */
await check("a mount answers what it is running and what it has finished", async () => {
  const state = {
    boxId: "b-live", createdAt: 1_000, lastUsedAt: 4_000, quietUntil: 9_000,
    sessions: [
      { boxId: "b-2", startedAt: 500, endedAt: 900, lastUsedAt: 800, execs: 3, saved: ["r2://a"] },
      { boxId: "b-1", startedAt: 100, endedAt: 400, lastUsedAt: 300, execs: 0, saved: [] },
    ],
  };
  const now = activityOf(state as any);
  if (now.live?.id !== "b-live") throw new Error(`the running container was not reported: ${JSON.stringify(now)}`);
  if (now.live.startedAt !== 1_000 || now.live.lastUsedAt !== 4_000) throw new Error("the live times are wrong");
  if (now.quietUntil !== 9_000) throw new Error("a deferred reminder is invisible to the page");
  // The sentence about cost belongs to the plugin: a console that writes it
  // has to know which mounts are containers, which is the coupling this ends.
  if (!/second/.test(now.billing ?? "")) throw new Error(`the mount does not say how it is charged: ${now.billing}`);

  const past = usageOf(state as any);
  if (past.length !== 2 || past[0]!.id !== "b-2") throw new Error(`the history is wrong: ${JSON.stringify(past)}`);
  if (past[0]!.uses !== 3 || past[0]!.kept?.[0] !== "r2://a") throw new Error("what a session did was dropped");
  if (past[1]!.endedAt - past[1]!.lastUsedAt !== 100) throw new Error("idle time is no longer computable from history");

  // An empty mount answers, rather than throwing or inventing a container.
  const empty = activityOf(null);
  if (empty.live !== null || !empty.billing) throw new Error(`an empty mount answered ${JSON.stringify(empty)}`);
  if (usageOf(null).length !== 0) throw new Error("an empty mount invented a history");

  // And neither call goes anywhere. The contract says so because of when they
  // are asked: a sweep on a timer, about a mount nobody is using, whose
  // credential may already have been taken away. A network call here would be
  // paid per mount per tick, and would fail exactly when the answer matters.
  // cody found the credential half of this rule unwatched for `usage`; this is
  // the other half, watched for both.
  const original = globalThis.fetch;
  const reached: string[] = [];
  globalThis.fetch = ((url: any) => {
    reached.push(String(url));
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  try {
    const ctx = (): any => ({
      caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
      credential: null, publicConfig: {},
      connection: { get: async () => state, set: async () => {} }, sibling: async () => null,
    });
    await run9.holds!.activity(ctx());
    await run9.holds!.usage!(ctx());
    if (reached.length) throw new Error(`answering cost a network call: ${reached.join(", ")}`);
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * A row this version cannot read means "nothing is running", not a broken mount.
 *
 * `connection.get()` returns `Json`, which is `unknown`, so the `as BoxState`
 * this replaced was an assertion the compiler could not check — on data that
 * outlives the code that wrote it. The failure that matters is not a mistyped
 * call site but this call site reading something an older version stored, and a
 * generic type parameter would have hidden exactly that (Rex).
 *
 * The direction of the failure is the part worth pinning: unrecognised
 * degrades to "no container", which every path already handles and which heals
 * itself on the next call. Throwing would turn one unreadable row into a mount
 * nobody can use again.
 */
await check("an unreadable row reads as no container, and a usable one still reads", () => {
  const good = { boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000, execs: 3 };
  if (asBoxState(good)?.boxId !== "b-1") throw new Error("a usable row was rejected");
  // Fields this version does not know about are not a reason to refuse: a row
  // written by a newer version still has everything this one reads.
  if (asBoxState({ ...good, somethingNew: true })?.boxId !== "b-1") throw new Error("an extra field was fatal");
  // Absent is not the same as malformed: every reader defaults these.
  if (asBoxState({ ...good, sessions: [] })?.boxId !== "b-1") throw new Error("an empty session list was rejected");

  for (const bad of [
    null, undefined, 42, "b-1", [], {},
    { boxId: 7, createdAt: 1, lastUsedAt: 1 },          // id of the wrong type
    { boxId: "b", createdAt: "1", lastUsedAt: 1 },      // a clock that is a string
    { boxId: "b", createdAt: 1 },                       // half the clocks
  ]) {
    if (asBoxState(bad as any) !== null) throw new Error(`accepted ${JSON.stringify(bad)} as a container record`);
  }

  // And the whole point: what an unreadable row does downstream. Every path
  // begins at `state?.boxId`, so null is the answer that lets the next call
  // start a fresh container instead of failing forever.
  const a = activityOf(asBoxState({ boxId: 7 } as any));
  if (a.live !== null) throw new Error("an unreadable row reported a running container");
  if (usageOf(asBoxState("nonsense" as any)).length !== 0) throw new Error("an unreadable row produced history");
});

/**
 * A container whose history cannot be read is still a container.
 *
 * `asBoxState` used to check that `sessions` and `envs` were arrays and nothing
 * about what was in them, so a `null` entry threw in `usageOf` and a half-written
 * one reported `undefined` as a reading (Rex). Rejecting the row is not the cure:
 * its id names a box that exists and is billed, and "nothing is running" would
 * start a second one and orphan it. So an unreadable entry is dropped, a list
 * that is not a list reads as absent, and the container is kept.
 */
await check("an unreadable session or environment is dropped, and the container it came with is kept", () => {
  const box = { boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000 };
  const session = { boxId: "b-0", startedAt: 1, endedAt: 2, lastUsedAt: 2, execs: 1, saved: ["py"] };
  const env = { name: "py", snapId: "s-1", savedAt: 3 };
  const s = asBoxState({
    ...box,
    sessions: [null, session, { boxId: "b-9" }, 7, { ...session, saved: [1] }],
    envs: [null, env, { name: "half" }, { ...env, note: 5 }],
  } as any);
  if (s?.boxId !== "b-1") throw new Error("an unreadable history entry lost a running container");
  const usage = usageOf(s);
  if (usage.length !== 1 || usage[0]!.id !== "b-0" || usage[0]!.kept?.[0] !== "py") {
    throw new Error(`usage read ${JSON.stringify(usage)}`);
  }
  if (s.envs?.length !== 1 || s.envs[0]!.name !== "py") throw new Error(`envs read ${JSON.stringify(s.envs)}`);

  // A list that is not a list: the container still reads, the list as absent.
  const t = asBoxState({ ...box, sessions: { 0: {} }, envs: "none" } as any);
  if (activityOf(t).live?.id !== "b-1") throw new Error("a malformed list lost a running container");
  if (usageOf(t).length !== 0 || t?.envs !== undefined) throw new Error("a malformed list was read as entries");
});

/**
 * A new container does not forget what was kept.
 *
 * Release carries `envs` over on purpose: a forked snapshot outlives the box it
 * came from. Creation then wrote the new record without them, so the first
 * command in the next container erased the list — `start_from` answered
 * "nothing kept", and the snapshots stayed in run9, billed, with nothing here
 * naming them.
 */
await check("starting a new container keeps the list of kept environments", async () => {
  const kept = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url);
    if (init?.method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/execs\/e\d+$/.test(path)) {
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    }
    return new Response("{}");
  }) as any;
  let stored: any = { boxId: "", createdAt: 0, lastUsedAt: 0, sessions: [],
    envs: [{ name: "ready", snapId: "s-1", savedAt: 5 }] };
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000 },
    connection: { get: async () => stored, set: async (v: unknown) => { stored = v; } },
    sibling: async () => null,
  };
  try {
    await sandboxPlugin(null as any, "local").invoke("shell", { command: "echo ok" } as any, ctx);
    if (!stored.boxId) throw new Error("no container was started, so this case checked nothing");
    if (stored.envs?.[0]?.snapId !== "s-1") throw new Error(`the new container's record lost what was kept: ${JSON.stringify(stored.envs)}`);
    const listed: any = await sandboxPlugin(null as any, "local").invoke("start_from", {} as any, ctx);
    if (listed.kept?.[0]?.name !== "ready") throw new Error(`start_from lists ${JSON.stringify(listed)}`);
  } finally {
    globalThis.fetch = kept;
  }
});

/**
 * A result names the image this container started from, not the mount's setting.
 *
 * The shell description tells the agent to read `image` instead of probing, so
 * it has to be true of the machine the command ran on. Read from the setting, it
 * stopped being true the moment the default changed (alpine to bookworm): a box
 * still running from before, or one started from an environment kept then, is
 * alpine while the setting says bookworm, and the agent runs apt-get on it.
 * Where nothing was recorded, the result says so rather than guessing.
 */
await check("a result reports the image its container started from, and says so when that was never recorded", async () => {
  const original = globalThis.fetch;
  const creates: any[] = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url).replace("https://sandbox.example", "");
    const method = init?.method ?? "GET";
    if (method === "POST" && /workspace\/boxes$/.test(path)) { creates.push(JSON.parse(init.body)); return new Response("{}"); }
    if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/execs\/e\d+$/.test(path)) {
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    }
    if (method === "GET" && /workspace\/boxes$/.test(path)) {
      return new Response(JSON.stringify(creates.map((c) => ({ box_id: c.box_id, box_snap_id: "src-1" }))));
    }
    if (method === "POST" && /snaps\/src-1\/fork$/.test(path)) return new Response(JSON.stringify({ snap_id: "s-new" }));
    return new Response("{}");
  }) as any;
  const plugin = sandboxPlugin(null as any, "local");
  const defaultImage = String(plugin.config!.find((f) => f.name === "image")!.default);
  const mount = (stored: any, publicConfig: Record<string, unknown> = {}) => {
    const box = { stored };
    const ctx: any = {
      caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
      credential: JSON.stringify({ ak: "a", sk: "b" }),
      publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000, ...publicConfig },
      connection: { get: async () => box.stored, set: async (v: unknown) => { box.stored = v; } },
      sibling: async () => null,
    };
    return { box, ctx };
  };
  try {
    // A new container from the setting: recorded, reported, and carried into what is kept from it.
    const fresh = mount(null);
    const r1: any = await plugin.invoke("shell", { command: "echo ok" } as any, fresh.ctx);
    if (r1.image !== defaultImage || fresh.box.stored.image !== defaultImage) {
      throw new Error(`a new container reported ${r1.image} and recorded ${fresh.box.stored.image}, not ${defaultImage}`);
    }
    await plugin.invoke("keep", { name: "ready" } as any, fresh.ctx);
    if (fresh.box.stored.envs?.[0]?.image !== defaultImage) {
      throw new Error(`keep did not record the image: ${JSON.stringify(fresh.box.stored.envs)}`);
    }

    // Started from a kept environment: its image, whatever the setting says now.
    const restored = mount({ boxId: "", createdAt: 0, lastUsedAt: 0, startFrom: "s-old",
      envs: [{ name: "old", snapId: "s-old", savedAt: 1, image: "img-then" }] }, { image: "img-now" });
    const r2: any = await plugin.invoke("shell", { command: "echo ok" } as any, restored.ctx);
    if (creates.at(-1)?.source_snap_id !== "s-old") throw new Error("the case did not start from the kept environment");
    if (r2.image !== "img-then") throw new Error(`a container started from a kept environment reported ${r2.image}`);

    // Nothing recorded — a box from before this, or an environment kept before
    // it — is not reported as the setting.
    for (const stored of [
      { boxId: "b-old", createdAt: 1, lastUsedAt: 1 },
      { boxId: "", createdAt: 0, lastUsedAt: 0, startFrom: "s-legacy", envs: [{ name: "legacy", snapId: "s-legacy", savedAt: 1 }] },
    ]) {
      const legacy = mount(stored, { image: "img-now" });
      const r: any = await plugin.invoke("shell", { command: "echo ok" } as any, legacy.ctx);
      if (r.image !== null) throw new Error(`an unrecorded image was reported as ${r.image}`);
      if (!/not recorded/.test(String(r.imageNote))) throw new Error(`the result does not say the image is unknown: ${JSON.stringify(r).slice(0, 300)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

await check("the shell description names the default image and how to install more on it", () => {
  const plugin = sandboxPlugin(null as any, "local");
  const defaultImage = String(plugin.config!.find((f) => f.name === "image")!.default);
  const summary = plugin.tools.find((t) => t.name === "shell")!.summary;
  const tag = defaultImage.split("/").pop()!;
  if (!/bookworm/.test(tag)) throw new Error(`the default image is ${defaultImage}`);
  if (!summary.includes(tag)) throw new Error(`the description does not name the default image ${tag}: ${summary}`);
  if (!/apt-get/.test(summary) || /\bapk\b/.test(summary)) throw new Error(`the description gives the wrong installer: ${summary}`);
});

/**
 * The tool list is a measurement, and a default without one is red.
 *
 * What a registry tag contains cannot be asserted from here, so the list lives
 * in `MEASURED_IMAGES` with the date it was taken, and this case is what makes a
 * change of default fail until somebody measures the new image. The sentence is
 * built from that entry, so the two cannot drift apart either.
 */
await check("the default image has a dated measurement, and the description says what it measured", async () => {
  const sb: any = await import("../src/plugins/sandbox.ts");
  const plugin = sandboxPlugin(null as any, "local");
  const defaultImage = String(plugin.config!.find((f) => f.name === "image")!.default);
  const m = sb.MEASURED_IMAGES?.[defaultImage];
  if (!m) throw new Error(`${defaultImage} is the default and nobody has measured what is in it: add it to MEASURED_IMAGES after checking a fresh box`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.measured) || !m.present.length || !/command -v/.test(m.command ?? "")) {
    throw new Error(`the measurement is incomplete, or does not say how to take it again: ${JSON.stringify(m)}`);
  }
  const summary = plugin.tools.find((t) => t.name === "shell")!.summary;
  if (!summary.includes(sb.defaultImageSentence(defaultImage))) throw new Error("the description is not built from the measurement");
  for (const tool of [...m.present, ...m.missing]) {
    if (!summary.includes(tool)) throw new Error(`the description does not mention ${tool}`);
  }
  if (!/not been measured/.test(sb.defaultImageSentence("example.test/unmeasured:1"))) {
    throw new Error("an unmeasured image is described as if it had been measured");
  }
});

/**
 * Dropped entries are counted where the page reads, not dropped in silence.
 *
 * `asBoxState` drops what it cannot read so a corrupt history cannot lose a
 * billed container. Rex asked for a count (2026-09-15) and it was deferred to
 * the first change to `Env`'s shape, which is when an older row can really
 * differ: recording images is that change.
 */
await check("a mount reports how many entries of its record it could not read", async () => {
  const plugin = sandboxPlugin(null as any, "local");
  const activity = (raw: unknown) => plugin.holds!.activity({
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox", credential: null, publicConfig: {},
    connection: { get: async () => raw, set: async () => {} }, sibling: async () => null,
  } as any);
  const box = { boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000 };
  const session = { boxId: "b-0", startedAt: 1, endedAt: 2, lastUsedAt: 2, execs: 1, saved: [] };
  const env = { name: "py", snapId: "s-1", savedAt: 3, image: "img" };
  const clean = await activity({ ...box, sessions: [session], envs: [env] });
  if (clean.unreadable !== undefined) throw new Error(`a clean record reported ${clean.unreadable} unreadable entries`);
  const dirty = await activity({ ...box, sessions: [null, session, { boxId: "b-9" }], envs: [env, { ...env, image: 5 }] });
  if (dirty.live?.id !== "b-1" || dirty.unreadable !== 3) throw new Error(`dirty record: ${JSON.stringify(dirty)}`);
  const lists = await activity({ ...box, sessions: { 0: {} }, envs: "none" });
  if (lists.unreadable !== 2) throw new Error(`lists that are not lists: ${JSON.stringify(lists)}`);
});

/**
 * The row itself, and not only what its lists hold.
 *
 * The count exists so that leniency which keeps a billed container does not
 * also hide a corrupt record, and the case it did not cover
 * is the one that costs the most: when the row does not read at all,
 * `asBoxState` answers "no container", the idle sweep skips a mount with no
 * `boxId` (cf/src/runtime.ts), and the console draws a clean idle mount. Those
 * three agree and all three are wrong together — an id scrambled in that row
 * names a container nobody releases and nobody can see, which is the outcome
 * the element-level leniency was written to avoid.
 *
 * What must stay silent is the reason this is a count and not a flag: a record
 * that was never written reads as nothing, and so does the one `release`
 * leaves behind (`boxId: ""`). Reporting either would put "corrupt" on every
 * idle mount, which is how an alarm stops being read.
 */
await check("a record that is present but does not read at all is reported, and an absent one is not", async () => {
  const plugin = sandboxPlugin(null as any, "local");
  const activity = (raw: unknown) => plugin.holds!.activity({
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox", credential: null, publicConfig: {},
    connection: { get: async () => raw, set: async () => {} }, sibling: async () => null,
  } as any);
  for (const raw of ["nonsense", 42, { boxId: 123, createdAt: "x" }]) {
    const a = await activity(raw);
    if (a.live !== null) throw new Error(`an unreadable row reported a container: ${JSON.stringify(a)}`);
    if (!a.unreadable) throw new Error(`an unreadable row said nothing was wrong: ${JSON.stringify(a)}`);
  }
  for (const raw of [null, undefined, { boxId: "", createdAt: 0, lastUsedAt: 0 }]) {
    const a = await activity(raw);
    if (a.unreadable !== undefined) throw new Error(`a readable record reported ${a.unreadable}: ${JSON.stringify(a)}`);
  }
  // Damage at both levels is counted at both: the row, and the entries inside it.
  const both = await activity({ boxId: 123, createdAt: "x", sessions: [null, null] });
  if (both.unreadable !== 3) throw new Error(`a bad row with bad entries: ${JSON.stringify(both)}`);
});

/**
 * GitHub from inside the container, without the token inside it.
 *
 * Measured on run9 (2026-09-15, fake values echoed back by httpbin): the egress
 * proxy swaps a placeholder that appears verbatim in a header (`token P`,
 * `Bearer P`), leaves it alone for a host not listed, and does not see one
 * inside Basic auth, which base64-encodes `user:P`. So git's header is
 * registered whole: placeholder `base64(x-access-token:P)`, value
 * `base64(x-access-token:<token>)` — exactly what git sends when its credential
 * helper answers `x-access-token` and P, as `gh auth git-credential` also does.
 */
await check("the GitHub token becomes two placeholders, one of them what git sends, and neither is the token", async () => {
  const sb: any = await import("../src/plugins/sandbox.ts");
  if (typeof sb.githubSecrets !== "function") throw new Error("githubSecrets is not exported");
  const token = "github_pat_FAKE0123456789";
  const regs = sb.githubSecrets(token, "h-t-a-0123456789-abcdefgh");
  const api = regs.find((r: any) => r.hosts.includes("api.github.com"));
  const git = regs.find((r: any) => r.hosts.includes("github.com"));
  if (regs.length !== 2 || !api || !git || api === git) throw new Error(`registrations: ${JSON.stringify(regs)}`);
  if (api.value !== token || api.placeholder.includes(token)) throw new Error("the API registration is wrong");
  if (!/^[A-Za-z0-9_]+$/.test(api.placeholder)) throw new Error(`the placeholder is not safe to put in a shell: ${api.placeholder}`);
  if (git.placeholder !== btoa(`x-access-token:${api.placeholder}`)) throw new Error("the git placeholder is not the header git sends");
  if (git.value !== btoa(`x-access-token:${token}`)) throw new Error("the git value is not the header GitHub expects");
  if (sb.githubSecrets(token, "h-t-a-0123456789-zzzzzzzz")[0].placeholder === api.placeholder) {
    throw new Error("two boxes got the same placeholder; run9 requires them unique across the project");
  }
});

await check("every command sees GH_TOKEN as the placeholder, and git gets it for github.com and nowhere else", async () => {
  const sb: any = await import("../src/plugins/sandbox.ts");
  if (typeof sb.githubEnv !== "function") throw new Error("githubEnv is not exported");
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const P = "__AP_GH_TOKEN_probe1234__";
  const command = `echo "token=$GH_TOKEN"; ` +
    `printf 'protocol=https\nhost=github.com\n\n' | git credential fill; ` +
    `printf 'protocol=https\nhost=gitlab.com\n\n' | git credential fill`;
  const argv: string[] = sb.execArgv({ shell: "/bin/sh" }, command, sb.githubEnv(P));
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: mkdtempSync(join(tmpdir(), "gh-env-")),
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1",
  } });
  const out = `${r.stdout}${r.stderr}`;
  if (!out.includes(`token=${P}`)) throw new Error(`GH_TOKEN was not the placeholder: ${out}`);
  if (!out.includes("username=x-access-token") || (out.match(/password=/g) ?? []).length !== 1 || !out.includes(`password=${P}`)) {
    throw new Error(`git credentials were not scoped to github.com: ${out}`);
  }
});

await check("a container gets a GitHub mount's token only as a placeholder, and nothing from anything else", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url).replace("https://sandbox.example", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/execs\/e\d+$/.test(path)) {
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    }
    return new Response("{}");
  }) as any;
  const token = "github_pat_FAKE0123456789";
  const plugin = sandboxPlugin(null as any, "local");
  const start = async (sibling: unknown, publicConfig: Record<string, unknown> = {}) => {
    calls.length = 0;
    const box: any = { stored: null };
    const asked: string[] = [];
    const ctx: any = {
      caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
      credential: JSON.stringify({ ak: "a", sk: "b" }),
      publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000, ...publicConfig },
      connection: { get: async () => box.stored, set: async (v: unknown) => { box.stored = v; } },
      sibling: async (alias: string) => { asked.push(alias); return sibling; },
    };
    const result: any = await plugin.invoke("shell", { command: "gh repo view" } as any, ctx);
    return {
      result, stored: box.stored, asked,
      create: calls.find((c) => c.method === "POST" && /workspace\/boxes$/.test(c.path))?.body,
      secrets: calls.filter((c) => /\/secrets$/.test(c.path)).map((c) => c.body),
      exec: calls.find((c) => /background-execs$/.test(c.path))?.body,
    };
  };
  try {
    const gh = await start({ plugin: "github", credential: token, connection: null });
    if (gh.asked.join() !== "gh") throw new Error(`asked for mounts ${JSON.stringify(gh.asked)}`);
    if (gh.create?.network_mode !== "managed") throw new Error(`the box was not created with managed networking: ${JSON.stringify(gh.create)}`);
    const hosts = gh.secrets.map((b: any) => (b.allowed_hosts ?? []).join(",")).sort();
    if (gh.secrets.length !== 2 || !hosts.some((h: string) => h.split(",").includes("github.com"))) {
      throw new Error(`registered ${JSON.stringify(hosts)}`);
    }
    const P = gh.stored?.githubPlaceholder;
    if (!P || !gh.exec?.command.join(" ").includes(P)) throw new Error(`the command does not carry the placeholder: ${JSON.stringify(gh.exec)}`);
    for (const [what, v] of [["command", gh.exec], ["record", gh.stored], ["result", gh.result]] as const) {
      if (JSON.stringify(v).includes(token)) throw new Error(`the token is in the ${what}`);
    }
    if (!/GitHub/.test(String(gh.result.github))) throw new Error(`the result does not say GitHub works here: ${JSON.stringify(gh.result).slice(0, 300)}`);

    for (const [why, sibling, cfg] of [
      ["another plugin's credential", { plugin: "http", credential: token, connection: null }, {}],
      ["a GitHub mount with no token", { plugin: "github", credential: null, connection: null }, {}],
      ["no such mount", null, {}],
      ["a container with no network", { plugin: "github", credential: token, connection: null }, { network: "none" }],
      ["the setting turned off", { plugin: "github", credential: token, connection: null }, { github: "" }],
      ["a GitHub mount whose writes need approval", { plugin: "github", credential: token, connection: null, policy: { write: "approval" } }, {}],
      ["a GitHub mount with one tool denied", { plugin: "github", credential: token, connection: null, policy: { tools: { pr_create: "deny" } } }, {}],
    ] as const) {
      const r = await start(sibling, cfg);
      if (r.secrets.length || r.create?.network_mode === "managed" || r.stored?.githubPlaceholder
        || JSON.stringify(r.exec).includes("GH_TOKEN") || JSON.stringify(calls).includes(token)) {
        throw new Error(`${why}: something was registered or exported`);
      }
    }

    // Withheld because of policy: the agent is told why, and where GitHub still works.
    const held = await start({ plugin: "github", credential: token, connection: null, policy: { write: "approval" } });
    if (held.stored?.githubWithheld !== "gh" || !/approval or denied/.test(String(held.result.github))) {
      throw new Error(`a policy-held mount did not say why GitHub is missing: ${JSON.stringify(held.result.github)}`);
    }

    // run9 refusing the registration: the box already exists and is billed, so
    // the call fails but the record still names the box, without a placeholder
    // that would promise GitHub works in it.
    const working = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => /\/secrets$/.test(String(url))
      ? new Response("no", { status: 500 })
      : working(url, init)) as any;
    let threw = false;
    const box: any = { stored: null };
    try {
      await plugin.invoke("shell", { command: "gh repo view" } as any, {
        caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
        credential: JSON.stringify({ ak: "a", sk: "b" }),
        publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000 },
        connection: { get: async () => box.stored, set: async (v: unknown) => { box.stored = v; } },
        sibling: async () => ({ plugin: "github", credential: token, connection: null }),
      } as any);
    } catch { threw = true; }
    if (!threw) throw new Error("a refused registration was treated as success");
    if (!box.stored?.boxId) throw new Error("a refused registration left the billed box with no record naming it");
    if (box.stored.githubPlaceholder) throw new Error("the record promises GitHub in a box where registration failed");
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * A sibling says which plugin it is.
 *
 * The sandbox sends a sibling's credential to GitHub's hosts, so it has to know
 * the alias still names a GitHub mount; an alias pointing at anything else would
 * send that mount's credential to GitHub. Only the gateway knows, so this goes
 * through the real one rather than a hand-built context.
 */
await check("the gateway's sibling names the plugin of the mount it found", async () => {
  const { SqliteStore } = await import("../src/store/sqlite.ts");
  const { ToolGateway } = await import("../src/runtime/gateway.ts");
  const probe: any = {
    id: "probe", version: "1.0.0", defaultForAllAgents: true,
    tools: [{ name: "peek", summary: "x", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "safe" }],
    invoke: async (_t: string, _a: unknown, ctx: any) => ({
      found: await ctx.sibling("gh"), held: await ctx.sibling("held"), missing: await ctx.sibling("nope"),
    }),
  };
  const github: any = { id: "github", version: "1.0.0", defaultForAllAgents: true, tools: [], invoke: async () => null };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k", {});
  const mount = (alias: string, plugin: string, secretRef: string | null, policy: unknown = null) => store.addMount({
    tenantId: "t", agentId: "a", alias, plugin, installationId: `i-${alias}`, connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef, policy,
  } as any);
  await mount("p", "probe", null);
  await mount("gh", "github", "ref:gh");
  await mount("held", "github", "ref:gh", { write: "approval" });
  const gw = new ToolGateway(store, [probe, github], { async resolve(ref: string) { return ref === "ref:gh" ? "tok" : null; } } as any);
  const r: any = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "p.peek", {});
  if (r.status !== "succeeded") throw new Error(`the probe did not run: ${JSON.stringify(r)}`);
  if (r.result.found?.plugin !== "github" || r.result.found.credential !== "tok") throw new Error(`sibling answered ${JSON.stringify(r.result.found)}`);
  if (r.result.missing !== null) throw new Error("a missing sibling was invented");
  // And its policy, because a plugin acting for that mount outside the gateway must honour it.
  if (r.result.found.policy !== null || r.result.held?.policy?.write !== "approval") {
    throw new Error(`sibling did not pass the policy through: ${JSON.stringify(r.result)}`);
  }
});

await check("a container acts as a mount only when nothing on that mount is held or denied", async () => {
  const sb: any = await import("../src/plugins/sandbox.ts");
  if (typeof sb.policyLetsContainerAct !== "function") throw new Error("policyLetsContainerAct is not exported");
  const cases: Array<[unknown, boolean]> = [
    [null, true], [{}, true], [{ read: "allow", write: "allow", tools: { pr_create: "allow" } }, true],
    [{ write: "approval" }, false], [{ write: "deny" }, false], [{ read: "approval" }, false],
    [{ tools: { issue_create: "deny" } }, false], [{ write: "allow", tools: { api: "approval" } }, false],
  ];
  for (const [policy, want] of cases) {
    if (sb.policyLetsContainerAct(policy) !== want) throw new Error(`${JSON.stringify(policy)} should be ${want}`);
  }
});

/**
 * A running container's GitHub access follows the mount, not the moment it started.
 *
 * Checked only at creation, a mount switched to approval kept its container
 * signed in until the container was released, which under a lease can be hours
 * (cody, reviewing #339); a token taken away or replaced was the same gap. So
 * before each command the mount is read again, and when what may be wired in
 * has changed, the container's GitHub secrets are deleted, measured on run9 to
 * stop substitution on the next request, and registered again only if allowed.
 */
await check("a running container's GitHub access follows the mount: held, removed, replaced, attached later", async () => {
  const original = globalThis.fetch;
  let secrets: Array<Record<string, any>> = [];
  const log: string[] = [];
  let failDelete = false;
  let n = 0;
  let sid = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const path = String(url).replace("https://sandbox.example", "");
    const method = init?.method ?? "GET";
    if (/\/secrets$/.test(path) && method === "POST") {
      const b = JSON.parse(init.body);
      const created = { secret_id: `s${++sid}`, ...b };
      secrets.push(created);
      log.push(`POST ${b.name}`);
      return new Response(JSON.stringify(created));
    }
    if (/\/secrets$/.test(path) && method === "GET") { log.push("LIST"); return new Response(JSON.stringify(secrets)); }
    const del = /\/secrets\/([^/]+)$/.exec(path);
    if (del && method === "DELETE") {
      log.push(`DELETE ${del[1]}`);
      if (failDelete) return new Response("no", { status: 500 });
      secrets = secrets.filter((x) => x.secret_id !== del[1]);
      return new Response("");
    }
    if (method === "POST" && /background-execs$/.test(path)) {
      log.push(`EXEC ${JSON.parse(init.body).command.join(" ").includes("GH_TOKEN") ? "with" : "without"} GH_TOKEN`);
      return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    }
    if (/execs\/e\d+$/.test(path)) {
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    }
    return new Response("{}");
  }) as any;
  const plugin = sandboxPlugin(null as any, "local");
  let mount: any = { plugin: "github", credential: "tok-1", connection: null, policy: null };
  const box: any = { stored: null };
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", graceMs: 10_000 },
    connection: { get: async () => box.stored, set: async (v: unknown) => { box.stored = v; } },
    sibling: async () => mount,
  };
  const run = async () => { log.length = 0; return await plugin.invoke("shell", { command: "gh repo view" } as any, ctx) as any; };
  const registered = (name: string) => secrets.find((x) => x.name === name);
  const holds = (token: string) => secrets.some((x) => x.value === token || x.value === btoa(`x-access-token:${token}`));
  try {
    await run();
    if (secrets.length !== 2 || !box.stored.githubPlaceholder) throw new Error(`not wired in at creation: ${JSON.stringify(box.stored)}`);
    if (JSON.stringify(box.stored).includes("tok-1")) throw new Error("the record holds the token");
    const placeholder = box.stored.githubPlaceholder;

    await run();
    if (log.some((l) => /LIST|DELETE|POST GH/.test(l))) throw new Error(`an unchanged mount touched the box's secrets: ${log}`);

    mount = { ...mount, policy: { write: "approval" } };
    let r = await run();
    if (secrets.length || box.stored.githubPlaceholder || box.stored.githubWithheld !== "gh"
      || !log.includes("EXEC without GH_TOKEN") || !/approval or denied/.test(String(r.github))) {
      throw new Error(`a policy held after creation: ${log} ${JSON.stringify(box.stored)}`);
    }

    mount = { ...mount, policy: null, credential: "tok-2" };
    await run();
    // A new placeholder, not the old one: run9 accepts a deleted secret's placeholder
    // again and then does not substitute it (measured, 2026-09-15).
    if (!holds("tok-2") || secrets.length !== 2 || !box.stored.githubPlaceholder || box.stored.githubPlaceholder === placeholder
      || box.stored.githubWithheld || !log.includes("EXEC with GH_TOKEN")) {
      throw new Error(`allowed again with a new token: ${log} ${JSON.stringify(box.stored)}`);
    }

    mount = { ...mount, credential: "tok-3" };
    await run();
    if (holds("tok-2") || !holds("tok-3") || secrets.length !== 2) throw new Error(`a replaced token stayed registered: ${log}`);

    mount = { ...mount, credential: null };
    r = await run();
    if (secrets.length || box.stored.githubPlaceholder || box.stored.githubWithheld || !log.includes("EXEC without GH_TOKEN")) {
      throw new Error(`a removed token stayed: ${log} ${JSON.stringify(box.stored)}`);
    }

    mount = { ...mount, credential: "tok-4" };
    await run();
    if (!holds("tok-4") || !log.includes("EXEC with GH_TOKEN")) throw new Error(`a token attached later was not wired in: ${log}`);

    mount = { ...mount, policy: { write: "deny" } };
    failDelete = true;
    let threw = false;
    try { await run(); } catch { threw = true; }
    if (!threw || log.some((l) => l.startsWith("EXEC"))) throw new Error(`a failed revocation still ran the command: ${log}`);
    if (!box.stored.githubPlaceholder) throw new Error("the record stopped naming access that is still registered");
    failDelete = false;

    // A container from before this change: a placeholder and no digest.
    secrets = [{ secret_id: "old1", name: "GH_TOKEN", value: "tok-5" }, { secret_id: "old2", name: "GH_TOKEN_GIT", value: btoa("x-access-token:tok-5") }];
    box.stored = { boxId: "h-t-a-legacy", createdAt: 1, lastUsedAt: 1, execs: 1, sessions: [], githubPlaceholder: "__AP_GH_TOKEN_legacy__" };
    mount = { plugin: "github", credential: "tok-5", connection: null, policy: null };
    await run();
    if (!box.stored.githubTokenDigest || !registered("GH_TOKEN") || !log.includes("EXEC with GH_TOKEN")) {
      throw new Error(`a container from before was not brought in line: ${log} ${JSON.stringify(box.stored)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * The full reminder once per container, a short line after.
 *
 * It went on every result when it was 132 bytes (2026-09-13). With the lease
 * terms it grew past 400, and background-job notices carry the whole result, so
 * one conversation repeated it dozens of times (cody, reading the task #19
 * trajectory). The reason it was on every result still holds, since an agent
 * that thought the box was volatile reinstalled on every call, so the short line
 * keeps that fact, and the full terms stay where they are always present: the
 * run and shell descriptions, sent every turn, and the first result of each box.
 */
await check("a container's first result carries the full reminder, and later ones a short line that agrees with it", async () => {
  const sb: any = await import("../src/plugins/sandbox.ts");
  const lease = { warnMs: 5 * 60_000, maxMs: 30 * 60_000 };
  const cfg = { maxOutputBytes: 24_000 } as any;
  const rec = { state: "succeeded", exit_code: 0, output_summary: "ok" };
  for (const [label, l] of [["leased", lease], ["no lease", null]] as const) {
    const first = sb.finished(rec, cfg, { boxId: "b", createdAt: 1, lastUsedAt: 1, execs: 0 }, "box", l);
    const later = sb.finished(rec, cfg, { boxId: "b", createdAt: 1, lastUsedAt: 1, execs: 3 }, "box", l);
    if (first.reminder !== boxReminder("box", l as any)) throw new Error(`${label}: the first result lost the full reminder`);
    const short = String(later.reminder ?? "");
    if (!short || short.length >= 140) throw new Error(`${label}: a later result's reminder is ${short.length} characters: ${short}`);
    if (!/same container/.test(short)) throw new Error(`${label}: the short line no longer says it is the same container: ${short}`);
    if (l) {
      if (!/until you release it/.test(short) || !/30 idle minutes/.test(short) || /turn ends/.test(short)) {
        throw new Error(`leased: the short line disagrees with the lease: ${short}`);
      }
    } else if (!/turn ends/.test(short) || /release it or/.test(short)) {
      throw new Error(`no lease: the short line disagrees with the turn's lifetime: ${short}`);
    }
  }
});

/**
 * Releasing writes over its own record, not over somebody else's.
 *
 * `releaseTask` does not take the per-mount lock that `invoke` takes
 * (`gateway.ts` uses `#queues` only there), so an operator release or the idle
 * sweep can interleave with a command on the same mount. The bad order is:
 * the command finds no container, creates one and records it, and then the
 * release — which read the old state before deleting the old box — clears the
 * record on top. The new container is alive and billed with nothing naming it,
 * which is the orphan `asBoxState` exists to avoid. cody is taking the lock in
 * the gateway; this is the half that does not depend on the caller, since a
 * lock only holds inside one object instance (cody and Piper, 2026-09-16).
 */
await check("a release does not clear a record that names a different container, and still records its own session", async () => {
  const original = globalThis.fetch;
  const plugin = sandboxPlugin(null as any, "local");
  const released = { boxId: "b-old", createdAt: 1_000, lastUsedAt: 2_000, execs: 2, saved: [], sessions: [],
    envs: [{ name: "kept", snapId: "s-1", savedAt: 5 }] };
  // What a command racing this release would have written: a different container.
  const raced = { boxId: "b-new", createdAt: 9_000, lastUsedAt: 9_100, execs: 1, saved: [], sessions: [] };
  // The interleaving is defined by when the other writer lands, not by how many
  // reads happen first: it arrives while the box is being deleted.
  const run = async (raceAtDelete: boolean) => {
    let landed = false;
    let stored: any = released;
    globalThis.fetch = (async (_url: string, init?: any) => {
      if ((init?.method ?? "GET") === "DELETE" && raceAtDelete) { landed = true; stored = raced; }
      return new Response("");
    }) as any;
    const ctx: any = {
      caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
      credential: JSON.stringify({ ak: "a", sk: "b" }),
      publicConfig: { endpoint: "https://sandbox.example" },
      connection: { get: async () => stored, set: async (v: unknown) => { stored = v; } },
      sibling: async () => null,
    };
    const result: any = await plugin.invoke("release", {} as any, ctx);
    return { result, stored, landed };
  };
  try {
    const contended = await run(true);
    if (!contended.landed) throw new Error("the case never raced: no delete was sent");
    if (contended.result.released !== true) throw new Error(`the old container was not released: ${JSON.stringify(contended.result)}`);
    if (contended.stored.boxId !== "b-new") {
      throw new Error(`the release cleared a record naming another container: ${JSON.stringify(contended.stored)}`);
    }
    const kept = contended.stored.sessions ?? [];
    if (!kept.some((x: any) => x.boxId === "b-old")) throw new Error(`the released container's session was lost: ${JSON.stringify(kept)}`);
    if (kept.some((x: any) => x.boxId === "b-new")) throw new Error(`a running container was recorded as finished: ${JSON.stringify(kept)}`);

    // Uncontended: nothing else touched the record, so it is cleared as before.
    const alone = await run(false);
    if (alone.result.released !== true || alone.stored.boxId !== "") {
      throw new Error(`an uncontended release did not clear: ${JSON.stringify(alone.stored)}`);
    }
    if (!alone.stored.sessions?.length || alone.stored.envs?.[0]?.name !== "kept") {
      throw new Error(`the cleared record lost history: ${JSON.stringify(alone.stored)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * What the catalogue calls a mount's label, and why it is not "account".
 *
 * The `mounts` tool used to say it listed "which account each is bound to",
 * and hand the model `account: "open web"` — a description dressed as an
 * identity. Four of the five seeded values are descriptions ("open web",
 * "agent memory", "container", "builtin"); only GitHub's is an account. A
 * field that is an identity for one mount and a description for four gives the
 * model no way to know which it is holding.
 */
await check("the catalogue offers a mount's label, and does not call it an account", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "web", installationId: "i", connectionId: null,
    plugin: "http", toolVersion: "1.0.0", publicConfig: { account: "open web" }, secretRef: null, policy: null,
  } as any);
  const tools = builtinToolsPlugin(store, () => [httpPlugin]);
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "tools",
    credential: null, publicConfig: {},
    connection: { get: async () => null, set: async () => {} },
    sibling: async () => null, record: async () => {},
  };
  // `search` answers from the catalogue, which is where the field lived.
  const found: any = await tools.invoke("search", { query: "get" }, ctx);
  const hit = (Array.isArray(found) ? found : found.matches ?? [])[0];
  if (!hit) throw new Error(`nothing matched: ${JSON.stringify(found).slice(0, 200)}`);
  if (hit.account !== undefined) throw new Error("the model is still told a description is an account");
  if (hit.label !== "open web") throw new Error(`the label is missing: ${JSON.stringify(hit)}`);

  const summary = tools.tools.find((t) => t.name === "mounts")!.summary;
  if (/account/i.test(summary)) throw new Error(`the tool still promises accounts: ${summary}`);

  // `mounts` hands back the configuration as it was written, where `account` is
  // the operator's own key and means whatever they put in it. That is raw
  // config, not the catalogue describing a mount, so it stays as it is.
  const listed: any = await tools.invoke("mounts", {}, ctx);
  const row = (listed.mounts ?? listed)[0];
  if (row?.config?.account !== "open web") throw new Error(`the raw config stopped coming through: ${JSON.stringify(row)}`);
});

await check("从盒子里存出来的文件,名字是【解析过的路径】,不是原样拼进去", async () => {
  // The key sanitised characters and kept segments, so a saved file could be
  // named `work/../etc/x` — which the reader refuses (#289), leaving a file an
  // agent saved and could never open again. The name is now
  // what the box itself would call the file.
  const cases: Array<[string, string]> = [
    ["/work/out.txt", "work/out.txt"],
    ["/work/./out.txt", "work/out.txt"],
    ["/work//out.txt", "work/out.txt"],
    ["/work/../etc/x", "etc/x"],
    ["/../../escape", "escape"],          // `..` at the root stays at the root
  ];
  for (const [path, want] of cases) {
    const got = segmentsOf(path).join("/");
    if (got !== want) throw new Error(`${path} became ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }
  // and the property that matters: no segment the reader would refuse
  for (const [path] of cases) {
    if (segmentsOf(path).some((seg) => seg === "" || seg === "." || seg === "..")) {
      throw new Error(`${path} still carries a segment that makes its reference unreadable`);
    }
  }
});

console.log(`\n  Mount settings\n  ${"─".repeat(56)}`);
/**
 * When to release, said so that "the user will come back" has an answer.
 *
 * Vera's blind-use run (2026-09-15): an agent told the user would return to the files kept a snapshot, saved an
 * archive, then released the container "to stop billing", because `release` said to destroy it as soon as the
 * work that needed it was done. Under the lease that is the wrong trade: the idle release bounds the cost, and the
 * next visit pays for a new machine. So `release` says when not to release, and what the kept copies are for.
 */
await check("release says to leave a container someone will come back to, and what kept copies are for", async () => {
  // Under a lease: without one there is nothing to leave running, and the case below holds that side.
  const release = sandboxPlugin(null as any, "local", { warnMs: 5 * 60_000, maxMs: 30 * 60_000 })
    .tools.find((t) => t.name === "release")!.summary;
  if (!/will not be needed again/.test(release)) throw new Error(`release does not say when to release: ${release}`);
  if (!/come back to it, leave it running/.test(release)) throw new Error(`release does not say to leave a box someone returns to: ${release}`);
  if (!/`quiet` keeps it longer/.test(release)) throw new Error(`release does not point to quiet: ${release}`);
  if (!/for starting a fresh machine later/.test(release)) throw new Error(`release does not say what keep and save are for: ${release}`);
  if (/as soon as you no longer need the machine/.test(release)) throw new Error(`release still says to destroy the box as soon as the work is done: ${release}`);
});

/**
 * What `keep` and `save` hand back does not read as permission to release.
 *
 * Vera's blind-use round 4 (2026-09-15): told the user would come back, an agent kept the environment, saved an
 * archive, and released the container "since I've kept the environment and saved the archive". Both notes it had
 * just been handed said the copy "survives release" and nothing else about release. This holds the words; whether
 * an agent now leaves the container running is judged by re-running that prompt, not here.
 */
await check("keep and save say a surviving copy is not a reason to release", async () => {
  const lease = { warnMs: 5 * 60_000, maxMs: 30 * 60_000 };
  // Both sides: the sentence is owed with or without a lease, and what it may promise differs (the switch case
  // holds "leave it running" to the lease; this one holds that the sentence is there at all).
  for (const l of [lease, null]) {
    const plugin = sandboxPlugin(null as any, "local", l);
    const texts: [string, string][] = [
      ["keep's result", keptNote(l)],
      ["save's result", savedNote(l)],
      ["keep", plugin.tools.find((t) => t.name === "keep")!.summary],
      ["save", plugin.tools.find((t) => t.name === "save")!.summary],
    ];
    for (const [where, text] of texts) {
      const which = `${where}${l ? "" : " without a lease"}`;
      if (!text.includes(notAReasonToRelease(l))) throw new Error(`${which} does not say a copy is no reason to release: ${text}`);
      if (/survives (its )?release/.test(text)) throw new Error(`${which} still offers survival as the whole story: ${text}`);
      // The side the switch case cannot reach while cf/wrangler.jsonc has the lease on: it only ever builds the
      // deployed plugin, so an unconditional lease promise here passed it once already.
      if (!l && /leave it running|released on its own|`quiet`/.test(text)) {
        throw new Error(`${which} promises what only a lease keeps: ${text}`);
      }
    }
  }
  const leased = sandboxPlugin(null as any, "local", lease)
    .tools.find((t) => t.name === "release")!.summary;
  if (!/leave it running, even after keeping or saving/.test(leased)) throw new Error(`release does not rule out keeping as a reason: ${leased}`);
  if (leased.indexOf("leave it running") > leased.indexOf("released on its own")) {
    throw new Error(`release says the container goes on its own before it says to leave it running: ${leased}`);
  }
});

await check("without a lease, release promises nothing a lease would keep", async () => {
  const release = run9.tools.find((t) => t.name === "release")!.summary;
  if (/leave it running|released on its own|`quiet`/.test(release)) throw new Error(`release promises the lease with none configured: ${release}`);
  if (!/handed back when the turn ends/.test(release)) throw new Error(`release does not say the box ends with the turn: ${release}`);
  if (!/will not be needed again/.test(release)) throw new Error(`release does not say when to release: ${release}`);
});

const ORIGIN_PLUGIN: Plugin = {
  id: "remote", version: "1.0.0", tools: [],
  config: [{ name: "serverUrl", type: "string", format: "origin", summary: "Where the credential goes." }],
  async invoke() { return null; },
};
const LEGAL_ORIGINS = [
  "https://api.example.com", "https://api.example.com/", "https://api.example.com:8443",
  "http://localhost:8787", "http://127.0.0.1", "http://[::1]:3000/",
];
const ILLEGAL_ORIGINS = [
  "https://api.example.com/x", "https://api.example.com?x=1", "https://api.example.com/?",
  "https://api.example.com#top", "https://user:pw@api.example.com", "https://user@api.example.com",
  "http://api.example.com", "http://10.0.0.1", "ftp://api.example.com", "file:///etc/passwd",
  "api.example.com", "", "/internal",
  // Parse to the right origin but are not written as one.
  "https:api.example.com", "https://api.example.com/.", "https://api.example.com/ ", " https://api.example.com",
  "https://api.example.com:443", "https://API.example.com", "http://LOCALHOST:8787",
];

await check("a declared origin is refused at mount time when it has a path, query, user or plain http", () => {
  for (const v of ILLEGAL_ORIGINS) {
    const problems = validateMount(ORIGIN_PLUGIN, { serverUrl: v }, null);
    if (problems.length !== 1 || problems[0]!.key !== "serverUrl") {
      throw new Error(`${JSON.stringify(v)} was not refused once: ${JSON.stringify(problems)}`);
    }
  }
  for (const v of LEGAL_ORIGINS) {
    const problems = validateMount(ORIGIN_PLUGIN, { serverUrl: v }, null);
    if (problems.length) throw new Error(`${JSON.stringify(v)} was refused: ${JSON.stringify(problems)}`);
  }
});

await check("a refused origin says what is wrong with it, not only that it is wrong", () => {
  // The exact-spelling rule refuses all of these on its own; the reasons are
  // for the person at the console, so each is pinned here.
  const said: Array<[string, RegExp]> = [
    ["https://user@api.example.com", /user name or password/],
    ["https://api.example.com/x", /no path, query or fragment/],
    ["https://api.example.com/?", /no path, query or fragment/],
    ["http://api.example.com", /must be https/],
    ["api.example.com", /absolute URL/],
    ["https://api.example.com:443", /written as https:\/\/api\.example\.com$/],
  ];
  for (const [v, want] of said) {
    const got = originProblem(v);
    if (!got || !want.test(got)) throw new Error(`${v}: ${got}`);
  }
});

await check("an origin the mount accepted is one a plugin can call: every path stays on it", () => {
  // The consumer's side (Vera's rule): accepting a value is only half; the way
  // a plugin uses it — `new URL(path, origin)` — must land on that origin.
  for (const v of LEGAL_ORIGINS) {
    if (originProblem(v) !== null) throw new Error(`${v} is legal to the validator but not to originProblem`);
    const origin = new URL(v).origin;
    for (const path of ["/internal/agent-api", "/a/b?c=1", "x"]) {
      const url = new URL(path, v);
      if (url.origin !== origin) throw new Error(`${path} on ${v} went to ${url.origin}`);
      if (!url.href.startsWith(`${origin}/`)) throw new Error(`${path} on ${v} became ${url.href}`);
    }
  }
});

/**
 * The contract declares the kinds of credential reference a plugin may be told
 * about; the runtime computes them. Two lists, one fact — so this fails if
 * either side grows a kind the other does not have, rather than a plugin
 * silently falling into its "not one I know" branch for a real kind.
 */
await check("every kind the runtime can report is one the contract declares, and no more", () => {
  const declared: CredentialRefKind[] = ["none", "agent", "operator", "env", "other"];
  const refs = [null, undefined, "", "agent:gh", "operator:run9", "env:GITHUB_TOKEN", "something-else"];
  const produced = new Set(refs.map((r) => secretRefKind(r as any)));
  for (const kind of produced) {
    if (!declared.includes(kind as CredentialRefKind)) throw new Error(`the runtime reports ${kind}, which the contract does not declare`);
  }
  for (const kind of declared) {
    if (!produced.has(kind as any)) throw new Error(`the contract declares ${kind}, which no reference in this list produces`);
  }
});

await check("a null credential is a different state, and a different sentence, per kind", () => {
  const base = { alias: "gh", credential: null };
  const states = new Map<string, string>();
  for (const kind of ["none", "agent", "operator", "env", "other"] as CredentialRefKind[]) {
    const ctx = { ...base, credentialRefKind: kind };
    states.set(kind, `${credentialState(ctx)}|${identityNote(ctx)}`);
  }
  // Not reported is its own state: it must not collapse into either answer.
  const unreported = `${credentialState(base)}|${identityNote(base)}`;
  if ([...states.values()].includes(unreported)) throw new Error("an unreported kind answers as one of the known ones");
  if (states.get("none") === states.get("agent")) throw new Error("a mount with no account reads like one whose credential cannot be read");
  // Who fixes it differs, so the two unreadable families must not share a
  // sentence; the ones fixed by the same person may.
  if (states.get("agent") === states.get("operator")) throw new Error("an agent credential and a deployment one send the same person");
  if (states.get("operator") !== states.get("env")) throw new Error("two deployment-held kinds give two answers for one action");
});

await check("format is declared only on string settings", () => {
  const wrong = everyPlugin.flatMap((p) => (p.config ?? [])
    .filter((f) => f.format !== undefined && f.type !== "string").map((f) => `${p.id}.${f.name}`));
  if (wrong.length) throw new Error(`format on a non-string setting: ${wrong.join(", ")}`);
  const odd = { ...ORIGIN_PLUGIN, config: [{ ...ORIGIN_PLUGIN.config![0]!, type: "number" as const }] };
  const problems = validateMount(odd, { serverUrl: 5 }, null);
  if (problems.length) throw new Error(`a number setting was judged as an origin: ${JSON.stringify(problems)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
// A suite that runs no cases must not report success. `pass === results.length` is the whole of
// this file's verdict, and an empty run satisfies it — which is how a suite
// dies without saying so: the gate runs every file (#245), but a file that
// stopped asserting anything still exits 0. `cf/src/runtime.ts` records what
// that cost once, when the one test guarding a version pin died the same day
// the pin broke and nothing went red until the breakage reached production.
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
