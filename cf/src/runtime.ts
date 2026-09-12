/**
 * The agent runtime, assembled inside a Durable Object.
 *
 * Nothing here is Cloudflare-specific except the wiring: the harness, gateway
 * and plugins are the same modules the Node build uses. What changes is that
 * storage is local, wakeup is an alarm instead of a poll, and the sandbox is a
 * Dynamic Worker instead of QuickJS.
 *
 * The loop is pi's. What this class still owns is everything pi has no opinion
 * about and never will: which tenant is asking, which mounts they have, which
 * credential each mount resolves to, and who is allowed to spend what.
 */
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor } from "../../src/runtime/dynamic-worker-executor.ts";
import { PiAgent, ensureAgentTables, jobSession, sessionsWithWork, markSession } from "../../src/runtime/pi-agent.ts";
import { idleDecision, nudgeText } from "../../src/runtime/idle-lease.ts";
import {
  bridgeTools, qualifyMountedTools, runJsTool, type MountedTool,
  withholdTools,
} from "../../src/runtime/pi-tools.ts";
import { systemPrompt } from "../../src/runtime/pi-prompt.ts";
import { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";

export { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";

/**
 * pi has no task id: a run is an operation and the conversation is a lane.
 * The gateway, quotas and approvals still address a task, so one constant
 * stands where the identifier used to be until those follow.
 */
const LEGACY_TASK = "main";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { assertMountConfig, validateMount } from "../../src/runtime/mount-config.ts";
import { ModelResolver } from "../../src/runtime/model-resolver.ts";
import { envSecrets } from "../../src/runtime/gateway.ts";
import { agentSecrets, agentRef, importKek, isAgentRef, seal } from "../../src/runtime/secrets.ts";
import { MAIN_SESSION } from "../../src/store/pi-storage.ts";

/** The persona fields of an agent record, if it carries any. */
export function personaOf(config: unknown): { name?: string; description?: string } | null {
  const c = (config ?? {}) as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name : undefined;
  const description = typeof c.description === "string" ? c.description : undefined;
  return name || description ? { name, description } : null;
}
import type { MountPolicy } from "../../src/core/types.ts";

/** A mount every agent starts with. `account` alone is the older shape the benchmarks still pass. */
export interface SeedMount {
  alias: string; plugin: string;
  account?: string; config?: Json;
  secretRef?: string | null; policy?: MountPolicy | null;
}
import { credentialForm } from "../../src/plugins/types.ts";
import { githubPlugin } from "../../src/plugins/github.ts";
import { demoPlugin } from "../../src/plugins/demo.ts";
import { httpPlugin } from "../../src/plugins/http.ts";
import { statePlugin, workingSet } from "../../src/plugins/state.ts";
import { run9Plugin } from "../../src/plugins/run9.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { artifactsPlugin } from "../../src/plugins/artifacts.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";
import type { Json } from "../../src/core/types.ts";
import type { ModelResponse } from "../../src/model/types.ts";

/** A model call handed to a Worker. Carries the command id, because the reply
 *  has to land under the same dedup key the inline path would have used. */
/** Commands cheap enough to send elsewhere: pure request/response, no bridge
 *  back into this object. `js.execute` needs the sandbox host, `tool.call` is
 *  short, and neither answers under the `:response` dedup key. */
const OFFLOADABLE = ["model.request"];

export interface ModelJob {
  tenantId: string;
  agentId: string;
  taskId: string;
  commandId: string;
  payload: Json;
}

const OFFLOAD_BYTES = 32 * 1024;

/**
 * What the agent is told about a result too big to hand it whole.
 *
 * This used to project `{number, title}` from an array — the shape of a GitHub
 * issue list, and of nothing else. A fetched page is an object with a long
 * `body`, so it produced an empty preview: the agent received a reference, no
 * readable content, and no idea what it had. Offloading has to leave something
 * usable behind whatever the result looks like, or it is just a dead end with
 * extra steps.
 */
function summarise(value: unknown, budget = 1200): Json {
  const head = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, n)}… (+${s.length - n} chars)`;

  if (typeof value === "string") return head(value, budget);
  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(0, 3).map((v) => summarise(v, Math.floor(budget / 3))),
    };
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    const per = Math.max(120, Math.floor(budget / Math.max(entries.length, 1)));
    for (const [k, v] of entries.slice(0, 20)) {
      out[k] = typeof v === "string" ? head(v, per)
        : Array.isArray(v) ? { count: v.length }
        : v && typeof v === "object" ? "{…}"
        : (v as Json);
    }
    return out;
  }
  return value as Json;
}

/** Same surface the SigV4 client exposes, backed by the R2 binding instead. */
class BoundArtifacts {
  #bucket: R2Bucket;
  #name: string;
  constructor(bucket: R2Bucket, name: string) {
    this.#bucket = bucket;
    this.#name = name;
  }
  async put(key: string, body: string | Uint8Array) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    await this.#bucket.put(key, bytes);
    return { ref: `r2://${this.#name}/${key}`, etag: "", bytes: bytes.byteLength };
  }
  async get(key: string): Promise<Uint8Array> {
    const obj = await this.#bucket.get(key);
    if (!obj) throw new Error(`no such artifact: ${key}`);
    return new Uint8Array(await obj.arrayBuffer());
  }
}

/** The one reference that maps to the operator's configured key. A tenant that
 *  wants its own account uses its own reference instead. */
export const OPERATOR_SECRET_REF = "operator:model";
/** Same idea for the sandbox account. Kept distinct so a tenant can be moved
 *  onto its own run9 project without touching its model binding. */
export const OPERATOR_RUN9_REF = "operator:run9";

export interface RuntimeDeps {
  ctx: any;
  bucketName: string;
  bucket: R2Bucket;
  loader: any;
  makeToolBinding: (execId: string) => unknown;
  /**
   * The operator's own model account. Used only to seed a binding on request
   * (`bindOperatorModel`), never as a fallback: an agent whose tenant has no
   * binding is refused, because the alternative is every tenant silently
   * spending this key.
   */
  operatorModel?: { baseUrl: string; apiKey: string; model: string };
  /** The operator's sandbox account, behind OPERATOR_RUN9_REF. Absent means the
   *  `node` mount resolves to no credential and its tools refuse to run, which
   *  is the right failure: a deployment without keys should not start boxes. */
  operatorRun9?: { ak: string; sk: string };
  /** The key under which per-agent secrets are sealed at rest: 32 bytes,
   *  base64, a Worker secret. Absent means `agent:` references cannot be
   *  stored or resolved, and the credential form says so. */
  secretKek?: string;
  /**
   * Durable Objects bill wall clock, Workers bill CPU — and a model call is
   * ~94% waiting. Handing `model.request` to a Worker lets the object go idle
   * for the whole completion instead of being billed for it. Omitted = inline.
   */
  offloadModel?: (job: ModelJob) => Promise<void>;
  /** Domain plugins beyond the built-ins (the benchmark mounts `retail` here). */
  extraPlugins?: Plugin[];
  maxTurns?: number;
  /**
   * What the bound model can hold, in tokens.
   *
   * Configuration rather than a constant, because it is the one number here
   * that changes by an order of magnitude between models: a threshold that is
   * most of a small window is a rounding error in a large one. Unset means the
   * conservative assumption, which compacts early rather than discovering the
   * limit from a refused call.
   */
  contextWindow?: number;
  /** Domain policy handed to the harness at task initialisation. */
  policy?: string;
  /**
   * Whether this agent is offered `run_js`.
   *
   * On by default, because the deployed console has a sandbox. It is a switch
   * rather than a constant so the benchmark can hold it fixed: the Node τ²
   * runner never offered the sandbox, and running the object arm with it on
   * meant the two arms differed by a tool and two paragraphs of prompt while
   * being reported as the same measurement. It is also the only way to ask
   * whether a sandbox helps on a task whose every action is one domain call —
   * a question SWE-bench cannot answer, because there it obviously does.
   */
  sandbox?: boolean;
  /**
   * Mount-qualified addresses the model is never offered.
   *
   * For a benchmark whose grader runs after the agent in the same container:
   * `node.release` says it destroys the box and stops the meter, so an agent
   * tidying up calls it — rightly, in production — and the grader then scores
   * a fresh box from the base image. The runner owns that lifetime instead.
   */
  withholdTools?: string[];
  /**
   * Whether a settled run hands its containers back by itself.
   *
   * On by default: a finished task should not hold a metered machine. Off only
   * when something still has to happen in that machine after the agent is
   * done — grading — and whoever switched it off takes the release, and the
   * bill for forgetting it, on themselves.
   */
  autoRelease?: boolean;
  /**
   * Keep a metered container between passes, ask the agent about it when it
   * goes quiet, and take it back at a ceiling the agent cannot move.
   *
   * Absent means the behaviour this had before: release after every pass that
   * settles with nothing open, which never bills for an idle box and makes
   * "the container persists between calls" false wherever the tools say it.
   * Present means the lease: see src/runtime/idle-lease.ts for the schedule.
   * A deployment turns it on by setting both numbers, because both are prices
   * — a reminder costs a model turn, a box costs seconds.
   */
  idle?: { afterMs: number; maxMs: number };
}

export class AgentRuntime {
  readonly store: DurableObjectStore;
  #deps: RuntimeDeps;
  #plugins: Plugin[];
  /**
   * What the registry says a plugin's version is. A mount pins a version and
   * the gateway refuses a call when the pin and the registry disagree, so a
   * seed that writes a literal is a seed that breaks the day the plugin moves:
   * github went to 2.0.0 and every mount written as "1.0.0" was refused.
   */
  pluginVersion(id: string): string | undefined {
    return this.#plugins.find((p) => p.id === id)?.version;
  }

  /**
   * Re-pin every stored mount to the registry's version.
   *
   * A mount written before a plugin moved keeps the old pin, and nothing else
   * repairs it: seeding runs once, and the gateway's answer to a stale pin is
   * to refuse the call. github went to 2.0.0 and every mount seeded before
   * that day was refused on every call after it, silently, because the one
   * test that would have noticed died the same day. Every mount today is
   * seeded by the operator (a person cannot add one from the console), so
   * there is no person's pin to protect and following the registry is right;
   * if a person ever pins a version on purpose, this is where that stops.
   */
  async repinMounts(tenantId: string, agentId: string): Promise<string[]> {
    const repinned: string[] = [];
    for (const m of await this.store.listMounts(tenantId, agentId)) {
      const v = this.pluginVersion(m.plugin);
      if (v && v !== m.toolVersion) {
        await this.store.updateMountToolVersion(tenantId, agentId, m.alias, v);
        repinned.push(`${m.alias}: ${m.toolVersion} -> ${v}`);
      }
    }
    return repinned;
  }

  #gateway: ToolGateway;
  #secrets!: import("../../src/runtime/gateway.ts").SecretResolver;
  #kek: Promise<CryptoKey | null> = Promise.resolve(null);
  #unchecked = new Map<string, string>();
  // One harness per (agent, session): a conversation is a session inside the
  // agent's object, with its own transcript and the agent's shared mounts,
  // credentials and memory. Keyed so a second conversation never reads the
  // first one's transcript, and cached so a wake does not rebuild them all.
  #agents = new Map<string, PiAgent>();
  #executor: DynamicWorkerExecutor;
  #models: ModelResolver;
  #artifacts: BoundArtifacts;
  #ready = false;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.store = new DurableObjectStore(deps.ctx);
    this.#artifacts = new BoundArtifacts(deps.bucket, deps.bucketName);
    const plugins: Plugin[] = [];
    plugins.push(
      githubPlugin,
      demoPlugin,
      httpPlugin,
      run9Plugin(this.#artifacts as any, deps.bucketName),
      statePlugin(this.store, this.#artifacts as any, deps.bucketName),
      artifactsPlugin(this.#artifacts as any, deps.bucketName),
      ...(deps.extraPlugins ?? []),
      builtinToolsPlugin(this.store, () => plugins),
    );
    this.#plugins = plugins;
    // Three reference forms, one resolver: the operator's sandbox account,
    // the agent's own sealed store, and the Worker environment. The gateway
    // passes the mount's owner as scope, so an `agent:` reference only ever
    // reaches the store of the agent whose mount names it.
    const kekPromise = deps.secretKek ? importKek(deps.secretKek) : Promise.resolve(null);
    const operator = {
      resolve: async (ref: string) =>
        ref === OPERATOR_RUN9_REF
          ? (deps.operatorRun9 ? JSON.stringify(deps.operatorRun9) : null)
          : envSecrets.resolve(ref),
    };
    this.#kek = kekPromise;
    this.#secrets = {
      resolve: async (ref, scope) => agentSecrets(this.store, await kekPromise, operator).resolve(ref, scope),
    };
    this.#gateway = new ToolGateway(this.store, plugins, this.#secrets);
    this.#executor = new DynamicWorkerExecutor({
      loader: deps.loader,
      makeToolBinding: deps.makeToolBinding,
    });
    // Credentials come from the same resolver mounts use, so a model key is
    // dereferenced server-side and never travels with the binding.
    this.#models = new ModelResolver(this.store, {
      resolve: async (ref) =>
        ref === OPERATOR_SECRET_REF
          ? (deps.operatorModel?.apiKey ?? null)
          : envSecrets.resolve(ref),
    });
  }

  // ---- per-agent credentials, from the console. Value in, metadata out.

  /**
   * Store a credential for one of this agent's mounts and point the mount at
   * it. `fields` is what the form posted, keyed by the plugin's declared field
   * names; a bare token comes as `{ token }`. The value is sealed before it
   * touches storage, and if the plugin can check it and says no, nothing is
   * stored and the reason comes back instead.
   */
  async attachCredential(tenantId: string, agentId: string, alias: string, fields: Record<string, string>):
    Promise<{ ok: true; verified: boolean; account: string | null; error: string | null } | { ok: false; error: string }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a credential" };
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return { ok: false, error: `no mount named ${alias}` };
    const plugin = this.#plugins.find((p) => p.id === mount.plugin);
    if (!plugin?.credential) return { ok: false, error: `${mount.plugin} takes no credential` };
    const form = credentialForm(plugin.credential);
    if (form.kind !== "fields") return { ok: false, error: "this credential is a sign-in, not something to paste" };
    const missing = form.fields.filter((f) => f.required && !String(fields[f.name] ?? "").trim());
    if (missing.length) return { ok: false, error: `missing: ${missing.map((f) => f.name).join(", ")}` };
    // The mount's settings are judged again with the reference this attach
    // would set, because a rule can depend on a credential being present
    // (http's allowlist is advice on an anonymous mount and a boundary on one
    // holding a key). Mount-time validation saw a mount with no key; this is
    // the moment it gains one, and "mount first, attach later" must not be a
    // way around a refusal the seed path would have made.
    const problems = validateMount(plugin, mount.publicConfig as any, agentRef(alias));
    if (problems.length) return { ok: false, error: problems.map((x) => x.message).join("; ") };
    // The value a plugin reads: a bare token, or one JSON object of the fields.
    const value = plugin.credential.shape === "token"
      ? String(fields.token ?? "").trim()
      : JSON.stringify(Object.fromEntries(form.fields.map((f) => [f.name, String(fields[f.name] ?? "").trim()])));
    const sealed = await seal(kek, value);
    const name = alias;
    // Check before keeping, with the candidate in place: the check reads the
    // credential through the same resolver a call would, so the mount points
    // at the sealed candidate first and is pointed back if the plugin says no.
    const previous = mount.secretRef;
    await this.store.putSecret(tenantId, agentId, name, { ciphertext: sealed.ciphertext, iv: sealed.iv });
    await this.store.setMountSecretRef(tenantId, agentId, alias, agentRef(name));
    const check = await this.#gateway.checkMount(tenantId, agentId, alias);
    // A refused key and an unanswered one are different news. Refused: the
    // provider looked and said no, so nothing is kept and the reason is shown.
    // Unreachable: nobody looked, so the key is kept unverified with the
    // reason beside it, rather than lost and blamed for an outage.
    if (check && !check.ok && check.kind === "rejected") {
      await this.store.removeSecret(tenantId, agentId, name);
      await this.store.setMountSecretRef(tenantId, agentId, alias, previous && !isAgentRef(previous) ? previous : null);
      return { ok: false, error: check.reason };
    }
    if (check?.ok) {
      await this.store.putSecret(tenantId, agentId, name, {
        ciphertext: sealed.ciphertext, iv: sealed.iv, account: check.account ?? null, verified: true,
      });
    }
    const unreachable = check && !check.ok ? `kept, could not be checked: ${check.reason}` : null;
    if (unreachable) this.#unchecked.set(`${tenantId}/${agentId}/${alias}`, unreachable);
    else this.#unchecked.delete(`${tenantId}/${agentId}/${alias}`);
    return { ok: true, verified: !!check?.ok, account: check?.ok ? (check.account ?? null) : null, error: unreachable };
  }

  async removeCredential(tenantId: string, agentId: string, alias: string): Promise<boolean> {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount || !isAgentRef(mount.secretRef)) return false;
    await this.store.removeSecret(tenantId, agentId, alias);
    await this.store.setMountSecretRef(tenantId, agentId, alias, null);
    return true;
  }

  /** What a page may show for a mount's credential. Never the value, and
   *  nothing derived from it: an account name is the far end's label. */
  async credentialMeta(tenantId: string, agentId: string, mount: { alias: string; secretRef: string | null }) {
    const attached = !!mount.secretRef;
    const meta = isAgentRef(mount.secretRef) ? await this.store.secretMeta(tenantId, agentId, mount.alias) : null;
    return {
      attached,
      // A reference the operator configured at deploy time, not one entered
      // on the page: attached, and not something the page can replace.
      operator: attached && !isAgentRef(mount.secretRef),
      verified: meta?.verified ?? false,
      account: meta?.account ?? null,
      setAt: meta?.updatedAt ?? null,
      lastUsedAt: meta?.lastUsedAt ?? null,
      storable: !!this.#deps.secretKek,
      // Why an attached key is still unverified, when the store knows: the
      // provider could not be reached at attach time. Held in memory only, so
      // it clears on the next successful check or the next object start.
      error: this.#unchecked.get(`${tenantId}/${agentId}/${mount.alias}`) ?? null,
    };
  }

  async ready() {
    if (!this.#ready) {
      await this.store.init();
      this.#ready = true;
    }
  }

  /** §5.4 lives here: the sandbox never receives a large result, only a reference. */
  #host(ctx: { tenantId: string; agentId: string; taskId: string }) {
    const gw = this.#gateway;
    const store = this.store;
    const artifacts = this.#artifacts;
    return {
      async invoke(call: { tool: string; args: any; opts?: any }): Promise<ToolResult> {
        const res = await gw.invoke(ctx, call.tool, call.args, call.opts);
        if (res.status !== "succeeded") return res;
        const body = JSON.stringify(res.result);
        if (body.length <= OFFLOAD_BYTES) return res;
        const key = `t/${ctx.tenantId}/${ctx.agentId}/${res.operationId}.json`;
        const stored = await artifacts.put(key, body);
        await store.completeOperation(ctx.tenantId, res.operationId, "succeeded", stored.ref);
        return {
          status: "succeeded",
          operationId: res.operationId,
          result: {
            ref: stored.ref,
            bytes: stored.bytes,
            preview: summarise(res.result),
            note: "parked because it is large; read the rest with artifacts.read { ref, fields, offset, limit }",
          },
        };
      },
    };
  }

  /**
   * What every agent is mounted with, whichever path makes it first: the
   * console on first open, or the API on first run. There was a shorter list
   * for the API path once, and an agent run before it was opened had no
   * memory; one list, read by both, is the only way that stays fixed.
   */
  static readonly DEFAULT_MOUNTS: SeedMount[] = [
    { alias: "tools", plugin: "tools", config: { account: "builtin" },
      secretRef: null, policy: null },
    // Without this a parked result is a reference the agent cannot open.
    { alias: "artifacts", plugin: "artifacts", config: { account: "builtin" },
      secretRef: null, policy: null },
    // Open, like everything else seeded here. The page can still show a held
    // call: the agent raises one itself with `confirm: true` on any call.
    { alias: "ops", plugin: "demo", config: { account: "demo-fleet" },
      secretRef: null, policy: null },
    // Open on purpose: the agent holds no credential and writes need a
    // human. maxBytes stays under the offload threshold so an ordinary page
    // reaches the model directly rather than via a round trip to storage.
    // Open, including writes, because the gate was on the wrong axis. It
    // was meant to stop data leaving, but an agent can put anything it
    // wants into a query string on a GET — so gating POST made the same
    // exfiltration one step less convenient and nothing more, at the cost
    // of stopping every ordinary API call for a signature. What actually
    // bounds where data can go is `allowedHosts`, which covers both.
    //
    // The gate still exists and still works; a mount that reaches
    // something that matters should use it, and use an allowlist too.
    { alias: "web", plugin: "http", config: { account: "open web", maxBytes: 24_000 },
      secretRef: null, policy: null },
    // GitHub, the first real user of the credential page. Seeded with no
    // token, so it reads public repositories; the person attaches their
    // own token there and the mount acts as that account. Writes are open:
    // the person's decision (task #10) is that the default allows every
    // operation a tool offers, and the agent decides which of its own calls
    // to hold for a person, by sending `confirm: true` with the call.
    { alias: "gh", plugin: "github", config: { account: "GitHub" },
      secretRef: null, policy: null },
    // A real container, for tasks that need one. Its tools describe
    // themselves as a last resort so the agent reaches for free in-process
    // JS first, and the framework releases the box once the agent has no
    // conversation with work open (the scope is the agent, not a task).
    { alias: "node", plugin: "run9", config: { account: "container" },
      secretRef: OPERATOR_RUN9_REF, policy: null },
    // The agent's own store. Deliberately not behind approval: an agent
    // that must ask a person before writing a note will not keep notes, and
    // the blast radius is its own memory, scoped to this (tenant, agent).
    { alias: "state", plugin: "state", config: { account: "agent memory" },
      secretRef: null, policy: null },

  ];

  /** What is installed, for a console that wants to show settings rather than
   *  guess them from whichever mounts happen to exist. */
  plugins(): Plugin[] {
    return this.#plugins;
  }

  /** The gateway, so an approval decided outside a task can act on it. */
  gateway() {
    return this.#gateway;
  }

  async provision(
    tenantId: string,
    agentId: string,
    mounts: SeedMount[] = AgentRuntime.DEFAULT_MOUNTS,
  ) {
    await this.ready();
    if (await this.store.loadTask(tenantId, `${agentId}:probe`)) return { agentId, created: false };
    // The record and the mounts are separate questions. An agent the console
    // created has a record (name, description) and no mounts yet; the old
    // guard read "record exists" as "already provisioned" and gave such an
    // agent its first run with no tools and no memory. Each seed mount is
    // added only if absent, so this is safe to call on every first run.
    let created = false;
    if (!(await this.store.loadAgent(tenantId, agentId))) {
      await this.store.createAgent(tenantId, agentId, {});
      created = true;
    }
    for (const m of mounts) {
      // The skip comes first on purpose: the assert below runs only for a
      // mount being added, so an open of an agent that already has its seven
      // costs one read per seed and no validation. Moving the assert above
      // this line would run it on every open of every agent.
      if (await this.store.getMountByAlias(tenantId, agentId, m.alias)) continue;
      // The seed is hand-written and reaches every agent, and the console's
      // validator only shows problems to whoever opens the plugins page. The
      // throwing one had no caller at all. A misspelt setting is refused here,
      // at the first agent it would have reached, rather than becoming the
      // plugin's silent default everywhere.
      const plugin = this.#plugins.find((p) => p.id === m.plugin);
      if (plugin) assertMountConfig(plugin, (m.config ?? { account: m.account }) as Record<string, Json>, m.secretRef ?? null);
      await this.store.addMount({
        tenantId, agentId, alias: m.alias, plugin: m.plugin,
        installationId: `inst-${m.alias}`, connectionId: null,
        toolVersion: this.pluginVersion(m.plugin) ?? "1.0.0",
        publicConfig: m.config ?? { account: m.account }, secretRef: m.secretRef ?? null, policy: m.policy ?? null,
      });
    }
    return { agentId, created };
  }

  /**
   * Point a tenant at the operator's model account, explicitly.
   *
   * This exists so a demo or a benchmark can be set up in one call. It is a
   * deliberate act with a visible binding row behind it, not a default that
   * quietly applies to everyone who forgot to configure one.
   */
  async bindOperatorModel(tenantId: string, agentId: string | null = null) {
    await this.ready();
    const m = this.#deps.operatorModel;
    if (!m) throw new Error("no operator model configured on this deployment");
    await this.store.setModelBinding({
      tenantId, agentId, provider: "openai-compatible",
      model: m.model, baseUrl: m.baseUrl, secretRef: OPERATOR_SECRET_REF,
    });
    return { tenantId, agentId, model: m.model };
  }

  /** Mounts as the model sees them: a plain name, plus the mount-qualified
   *  address the harness dispatches to, because providers restrict name
   *  charsets. */
  async #catalogueFor(tenantId: string, agentId: string) {
    const records = await this.store.listMounts(tenantId, agentId);
    const byId = new Map(this.#plugins.map((pl) => [pl.id, pl]));
    return {
      records,
      mounts: records.map((m) => ({
        alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
      })),
      tools: qualifyMountedTools(withholdTools(records.flatMap((m) =>
        (byId.get(m.plugin)?.tools ?? []).map((t) => ({
          name: t.name, description: t.summary, parameters: t.parameters,
          address: `${m.alias}.${t.name}`,
          // Carried through so replay policy and exclusivity are decided by the
          // plugin that knows, not guessed at the point of use.
          sideEffects: t.sideEffects, idempotency: t.idempotency,
          exclusive: byId.get(m.plugin)?.exclusive,
        })),
      ), this.#deps.withholdTools ?? [])),
    };
  }

  /**
   * The agent, built from storage.
   *
   * Rebuilt whenever the object is asked about a different agent, and on every
   * wake, because the object may have been evicted since the last one. Building
   * it starts no timers and no provider work — it reads the transcript and
   * reports what was left open.
   */
  async agent(tenantId: string, agentId: string, session: string = MAIN_SESSION): Promise<PiAgent> {
    await this.ready();
    const key = `${tenantId}/${agentId}`;
    const cacheKey = `${key}#${session}`;
    const cached = this.#agents.get(cacheKey);
    if (cached) return cached;

    const binding = await this.store.getModelBinding(tenantId, agentId);
    if (!binding) throw new Error(`no model binding for ${key}`);
    // Before the catalogue is read: a stale pin is a mount whose every call
    // the gateway refuses, and the harness opening is the one moment every
    // agent passes through, console-made or API-made.
    await this.repinMounts(tenantId, agentId);
    const { tools } = await this.#catalogueFor(tenantId, agentId);
    const sandbox = this.#deps.sandbox ?? true;
    // The call context's task is the conversation, so held calls and audit
    // rows say which conversation asked. The first session's id is the same
    // string the single-conversation object always used.
    const host = this.#host({ tenantId, agentId, taskId: session === MAIN_SESSION ? LEGACY_TASK : session });
    const store = this.store;
    // The tools the model is offered are the mounts plus the sandbox. run_js is
    // not a mount — it is the one tool whose body is this object rather than a
    // plugin — so it is built here and handed to open beside the mounts. It
    // has to be in that list: open reconciles the names a session remembers
    // against it, and a tool added afterwards was removed on every reopen.
    const extraTools = sandbox
      ? [runJsTool(this.#executor as any, host, {
          onCalls: (n) => { void store.consumeQuota(tenantId, "tool_calls", n); },
          // So a script names a tool the way the model's own list names it.
          tools: tools as MountedTool[],
        })]
      : [];

    const agent = await PiAgent.open({
      host: this.#deps.ctx.storage,
      sessionId: session === MAIN_SESSION ? key : `${key}#${session}`,
      session,
      // Read here rather than inside the harness, so the harness keeps holding
      // no I/O of its own.
      systemPrompt: systemPrompt({
        // The agent's own record: a person named and described it at creation,
        // and that is the first thing the prompt says after the core.
        persona: personaOf((await this.store.loadAgent(tenantId, agentId))?.config),
        workingSet: await workingSet(this.store, tenantId, agentId),
        policy: this.#deps.policy,
        // Each paragraph appears only where the thing it describes is really
        // there. Telling an agent to read a result back "with the artifacts
        // tool" when no artifacts tool is mounted is not a hint, it is a wrong
        // instruction competing with the ones that matter.
        sandbox,
        artifacts: (tools as MountedTool[]).some((t) => t.address.startsWith("artifacts.")),
      }),
      model: {
        provider: binding.provider,
        id: binding.model,
        contextWindow: this.#deps.contextWindow ?? ASSUMED_CONTEXT_WINDOW,
      },
      tools: tools as MountedTool[],
      extraTools: extraTools as any,
      toolHost: host,
      dispatch: async (jobId) => {
        const send = this.#deps.offloadModel;
        if (!send) throw new Error("no dispatcher configured");
        await send({ tenantId, agentId, taskId: LEGACY_TASK, commandId: jobId, payload: null });
      },
    });
    this.#agents.set(cacheKey, agent);
    return agent;
  }

  /** Compact on demand, the way pi's /compact does: an operation like any
   *  other, so it is admitted, durable, and drives on the same pass. */
  async requestCompaction(tenantId: string, agentId: string, session: string = MAIN_SESSION) {
    return (await this.agent(tenantId, agentId, session)).compact();
  }

  /**
   * The two gestures pi distinguishes, and the reason they are different.
   *
   * `steer` is the default and the one that matters: a message typed while the
   * agent is working reaches the model before its next call, without stopping
   * the tool call in flight. Nothing is aborted; the current turn finishes and
   * the new instruction is simply there when the next one is composed.
   *
   * `followUp` waits until the agent has finished everything.
   */
  async postMessage(
    tenantId: string, agentId: string, text: string,
    mode: "prompt" | "steer" | "followUp" = "prompt",
    session: string = MAIN_SESSION,
  ) {
    const agent = await this.agent(tenantId, agentId, session);
    // A conversation that has just been spoken to has work until a step says
    // otherwise, so the next wake steps it.
    markSession(this.#deps.ctx.storage.sql, session, true);
    const res: any = await agent.say(text, mode);
    // What actually happened rather than what was asked for: a run admitted
    // carries an operation id, a queued message carries an entry id.
    const landed = res?.value?.operationId ? "prompt" : mode === "followUp" ? "followUp" : "steer";
    return { mode: landed, queued: landed !== "prompt", result: res };
  }

  /**
   * One pass over every session with work, which is all an alarm should ever
   * do. A session is stepped when its last step left something open or a
   * model call of its is still out; the rest stay closed and cost nothing.
   * The wake is the soonest any session asked for.
   */
  async step(tenantId: string, agentId: string) {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureAgentTables(sql);
    const sessions = sessionsWithWork(sql);
    if (!sessions.length) sessions.push(MAIN_SESSION);
    let open = 0, wakeInMs: number | null = null;
    const settled: Array<{ operationId: string; status: string }> = [];
    for (const session of sessions) {
      const agent = await this.agent(tenantId, agentId, session);
      const out = await agent.step();
      open += out.open;
      settled.push(...out.settled);
      if (out.wakeInMs !== null) wakeInMs = wakeInMs === null ? out.wakeInMs : Math.min(wakeInMs, out.wakeInMs);
      markSession(sql, session, out.open > 0 || out.wakeInMs !== null);
    }
    // A finished run should not still be holding a metered container — either
    // by handing it back at once, or, where the deployment leases them, by
    // asking the agent first and taking it at the ceiling.
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    if (this.#deps.autoRelease !== false && open === 0) {
      if (!this.#deps.idle) {
        if (settled.length) {
          const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK });
          releaseFailed = r.failed;
        }
      } else {
        // Runs on every idle pass, not only after work settles: the reminder
        // that matters is the one nothing else would have woken us for.
        const idle = await this.#idlePass(tenantId, agentId);
        releaseFailed = idle.releaseFailed;
        if (idle.wakeInMs !== null) wakeInMs = wakeInMs === null ? idle.wakeInMs : Math.min(wakeInMs, idle.wakeInMs);
      }
    }
    return { open, wakeInMs, settled, releaseFailed };
  }

  /**
   * One look at every metered mount: remind, take, or come back later.
   *
   * The state is the plugin's (run9 writes `boxId`, `lastUsedAt`, and the
   * agent's `quietUntil`); the schedule is the framework's, which is why this
   * reads that state rather than the plugin reading a clock. A mount with no
   * live box says nothing and costs nothing.
   */
  async #idlePass(tenantId: string, agentId: string): Promise<{
    wakeInMs: number | null; releaseFailed: Array<{ alias: string; error: string }>;
  }> {
    const { afterMs, maxMs } = this.#deps.idle!;
    const now = Date.now();
    const sql = this.#deps.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS box_reminders(
      alias TEXT NOT NULL, box_id TEXT NOT NULL, sent INTEGER NOT NULL,
      PRIMARY KEY (alias, box_id))`);
    let wakeInMs: number | null = null;
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    const soon = (ms: number) => { wakeInMs = wakeInMs === null ? ms : Math.min(wakeInMs, ms); };

    for (const mount of await this.store.listMounts(tenantId, agentId)) {
      const state = (await this.store.getConnection(tenantId, agentId, mount.alias)) as any;
      const boxId = typeof state?.boxId === "string" ? state.boxId : "";
      const lastUsedAt = Number(state?.lastUsedAt) || 0;
      // No box, or a state that cannot say when it was last used: nothing to
      // schedule from, and inventing a clock here is how a box in use gets
      // taken mid-task.
      if (!boxId || !lastUsedAt) continue;
      const row = sql.exec("SELECT sent FROM box_reminders WHERE alias = ? AND box_id = ?", mount.alias, boxId)
        .toArray()[0] as any;
      const sent = Number(row?.sent) || 0;
      const d = idleDecision({ lastUsedAt, quietUntil: Number(state?.quietUntil) || 0, sent, now, afterMs, maxMs });
      if (d.do === "wait") { soon(d.wakeInMs); continue; }
      if (d.do === "nudge") {
        // The reminder is a turn the agent takes, so it is a message rather
        // than a signal: the model has to be able to answer it with a call.
        await this.postMessage(tenantId, agentId,
          nudgeText(mount.alias, d.idleMs, lastUsedAt + maxMs - now), "prompt");
        sql.exec("INSERT INTO box_reminders(alias, box_id, sent) VALUES (?,?,?) " +
          "ON CONFLICT(alias, box_id) DO UPDATE SET sent = excluded.sent", mount.alias, boxId, d.nth);
        soon(d.wakeInMs);
        continue;
      }
      // Past the ceiling. The gateway releases every mount the agent holds —
      // its scope has always been the agent — so with a second metered mount
      // the earliest ceiling takes both; per-mount release is run9's to add.
      const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK });
      releaseFailed = [...releaseFailed, ...r.failed];
      sql.exec("DELETE FROM box_reminders WHERE alias = ? AND box_id = ?", mount.alias, boxId);
    }
    return { wakeInMs, releaseFailed };
  }

  /** What the worker asks for, and what it hands back. The job row says which
   *  session asked, so the answer lands in the transcript that is waiting. */
  async takeJob(tenantId: string, agentId: string, jobId: string) {
    await this.ready();
    const session = jobSession(this.#deps.ctx.storage.sql, jobId) ?? MAIN_SESSION;
    return (await this.agent(tenantId, agentId, session)).takeJob(jobId);
  }

  async deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown) {
    await this.ready();
    const session = jobSession(this.#deps.ctx.storage.sql, jobId) ?? MAIN_SESSION;
    return (await this.agent(tenantId, agentId, session)).deliver(jobId, answer as any);
  }
}
