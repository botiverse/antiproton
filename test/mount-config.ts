/**
 * Settings checked where a person can read the answer.
 *
 * The failure worth catching is the quiet one: a mount carrying `timeout_ms`
 * where the plugin reads `timeoutMs` is not rejected by anything, so the plugin
 * uses its default for ever and the symptom appears somewhere else entirely.
 */
import { validateMount, assertMountConfig } from "../src/runtime/mount-config.ts";
import { pluginEnabled, renameSafety, type PluginChoice } from "../src/plugins/types.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { policyFor } from "../src/runtime/gateway.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { sandboxPlugin, execArgv, execOutput, sessionOf, activityOf, providerOf, keepSessions, boxReminder } from "../src/plugins/sandbox.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import { demoPlugin } from "../src/plugins/demo.ts";
import { statePlugin } from "../src/plugins/state.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { appworldPlugins, type Catalogue } from "../src/plugins/appworld.ts";
import { credentialForm } from "../src/plugins/types.ts";
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
    timeoutMs: 300000, secrets: ["STRIPE_KEY"],
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
const everyPlugin: Plugin[] = [
  githubPlugin, httpPlugin, demoPlugin, run9,
  statePlugin(null as any, null, "local"),
  artifactsPlugin(null as any, "local"),
  builtinToolsPlugin(null as any, () => []),
  ...appworldPlugins(catalogue, { apiBaseUrl: "http://localhost:8800" }),
];

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

await check("the marker is what makes run9's secrets setting legitimate, not its name", () => {
  const field = run9.config!.find((f) => f.name === "secrets")!;
  if (field.references !== "credential") throw new Error("run9's secrets setting lost its marker");
  const { references, ...unmarked } = field;
  if (!CREDENTIAL_SHAPED.test(unmarked.name)) throw new Error("the pattern stopped matching the case it exists for");
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
await check("a plugin with something to release is exclusive, because holding is what exclusive is for", () => {
  const holders = everyPlugin.filter((p) => typeof p.release === "function");
  const unguarded = holders.filter((p) => !p.exclusive).map((p) => p.id);
  if (unguarded.length) {
    throw new Error(`${unguarded.join(", ")} release something per mount but allow concurrent calls`);
  }
  // Without this the rule above passes by having no holders at all.
  if (!holders.some((p) => p.id === "sandbox")) {
    throw new Error("the sandbox keeps one container per mount and must declare release; the rule is vacuous without it");
  }
});

await check("a plugin that holds nothing is not needlessly serialised", () => {
  // The reverse is not the same rule: two http fetches do not interfere, and
  // making everything exclusive would serialise calls that have no reason to be.
  const idle = everyPlugin.filter((p) => p.exclusive && typeof p.release !== "function").map((p) => p.id);
  if (idle.length) throw new Error(`${idle.join(", ")} serialise calls but hold nothing to release`);
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
  // The contract allows a check to succeed without naming anything; none of
  // ours does, so the page can rely on an account being there.
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
 * (`cf/src/index.ts:1370`). Nothing runs it over `DEFAULT_MOUNTS`, which is the
 * one config every agent gets, written by hand, and seeded by both paths since
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
  const before = Date.now();
  const r: any = await run9.invoke("quiet", { minutes: 30 } as any,
    ctx({ boxId: "b-1", createdAt: 1_000, lastUsedAt: 2_000, execs: 4, envs: [] }));
  if (r.quiet !== true) throw new Error(`a request inside the ceiling was not accepted: ${JSON.stringify(r)}`);
  if (!saved?.quietUntil) throw new Error("nothing was recorded for the wake to read");
  const minutes = (saved.quietUntil - before) / 60_000;
  if (minutes < 29 || minutes > 31) throw new Error(`quietUntil is ${minutes} minutes out, not 30`);
  if (saved.boxId !== "b-1" || saved.execs !== 4) throw new Error("the rest of the box state was dropped");
  // The one field it must not move. Every other handler in the plugin bumps
  // `lastUsedAt`, so "make quiet consistent with the rest" is a plausible edit
  // — and it would defeat the absolute ceiling, because an agent could push the
  // idle clock forward indefinitely with legal requests under the cap.
  if (saved.lastUsedAt !== 2_000) throw new Error(`quiet moved lastUsedAt to ${saved.lastUsedAt}, so the idle ceiling can be pushed forever`);

  // No box: nothing will be asked about, so there is nothing to put off. It
  // answers instead of throwing, the way `release` does on an empty mount.
  saved = null;
  const none: any = await run9.invoke("quiet", { minutes: 5 } as any, ctx(null));
  if (none.quiet !== false) throw new Error(`quiet on an empty mount answered ${JSON.stringify(none)}`);
  if (saved) throw new Error("quiet wrote state for a box that does not exist");
});

/**
 * The three places that tell the model how the box ends must end it the same way.
 *
 * `run` and `shell` describe the container before it exists; the per-execution
 * reminder describes it while it does. An agent reads whichever it happens to
 * be looking at, and it cannot tell which is stale — so a promise mended in one
 * and left in another is worse than the original wrong sentence: it is wrong
 * only sometimes. This is the test that failed to exist while "persists between
 * calls until you release it" outlived the behaviour it described.
 */
await check("run, shell and the per-execution reminder end the container the same way", async () => {
  const run = run9.tools.find((t) => t.name === "run")!.summary;
  const shell = run9.tools.find((t) => t.name === "shell")!.summary;
  const reminder = boxReminder("box");
  for (const [where, text] of [["run", run], ["shell", shell], ["the reminder", reminder]] as const) {
    // Each says the box survives calls…
    if (!/persists between calls|across calls/.test(text)) {
      throw new Error(`${where} no longer says the container survives calls: ${text.slice(0, 120)}`);
    }
    // …and each says the same thing about how it ends. Today that is "when you
    // release it", because the lease is off until the two numbers are set; the
    // day they are, all three gain the idle clause together and this assertion
    // changes with them. What must never differ is the three of them.
    if (!/release/.test(text)) {
      throw new Error(`${where} says the box survives calls without saying what ends it: ${text.slice(0, 160)}`);
    }
    if (/goes idle|idle long enough/.test(text)) {
      throw new Error(`${where} promises the idle question while the lease is off: ${text.slice(0, 160)}`);
    }
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
  if (typeof run9.activity !== "function") throw new Error("the sandbox no longer reports its activity");

  const empty = await run9.activity!(ctx(null));
  if (empty.live !== null) throw new Error(`an empty mount reported ${JSON.stringify(empty)}`);

  const busy = await run9.activity!(ctx({ boxId: "b-7", createdAt: 1_000, lastUsedAt: 5_000 }));
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

console.log(`\n  Mount settings\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
