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
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import {
  bridgeTools, qualifyMountedTools, runJsTool, type MountedTool,
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
import { ModelResolver } from "../../src/runtime/model-resolver.ts";
import { envSecrets } from "../../src/runtime/gateway.ts";
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
}

export class AgentRuntime {
  readonly store: DurableObjectStore;
  #deps: RuntimeDeps;
  #plugins: Plugin[];
  #gateway: ToolGateway;
  #agent: PiAgent | null = null;
  #agentKey = "";
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
    this.#gateway = new ToolGateway(this.store, plugins, {
      resolve: async (ref) =>
        ref === OPERATOR_RUN9_REF
          ? (deps.operatorRun9 ? JSON.stringify(deps.operatorRun9) : null)
          : envSecrets.resolve(ref),
    });
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

  static readonly DEFAULT_MOUNTS = [
    { alias: "tools", plugin: "tools", account: "builtin" },
    { alias: "artifacts", plugin: "artifacts", account: "builtin" },
    { alias: "gh_public", plugin: "github", account: "unauthenticated" },
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
    mounts: Array<{ alias: string; plugin: string; account: string }> = AgentRuntime.DEFAULT_MOUNTS,
  ) {
    await this.ready();
    if (await this.store.loadTask(tenantId, `${agentId}:probe`)) return { agentId, created: false };
    try {
      await this.store.createAgent(tenantId, agentId, {});
    } catch {
      return { agentId, created: false };
    }
    for (const m of mounts) {
      await this.store.addMount({
        tenantId, agentId, alias: m.alias, plugin: m.plugin,
        installationId: `inst-${m.alias}`, connectionId: null, toolVersion: "1.0.0",
        publicConfig: { account: m.account }, secretRef: null,
      });
    }
    return { agentId, created: true };
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
      tools: qualifyMountedTools(records.flatMap((m) =>
        (byId.get(m.plugin)?.tools ?? []).map((t) => ({
          name: t.name, description: t.summary, parameters: t.parameters,
          address: `${m.alias}.${t.name}`,
        })),
      )),
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
  async agent(tenantId: string, agentId: string): Promise<PiAgent> {
    await this.ready();
    const key = `${tenantId}/${agentId}`;
    if (this.#agent && this.#agentKey === key) return this.#agent;

    const binding = await this.store.getModelBinding(tenantId, agentId);
    if (!binding) throw new Error(`no model binding for ${key}`);
    const { tools } = await this.#catalogueFor(tenantId, agentId);
    const host = this.#host({ tenantId, agentId, taskId: LEGACY_TASK });
    const store = this.store;

    const agent = await PiAgent.open({
      host: this.#deps.ctx.storage,
      sessionId: key,
      // Read here rather than inside the harness, so the harness keeps holding
      // no I/O of its own.
      systemPrompt: systemPrompt({
        workingSet: await workingSet(this.store, tenantId, agentId),
        policy: this.#deps.policy,
        // The object mounts the sandbox itself, below, and parks large tool
        // results — so both paragraphs describe something that is really there.
        sandbox: true,
        artifacts: true,
      }),
      model: {
        provider: binding.provider,
        id: binding.model,
        contextWindow: this.#deps.contextWindow ?? ASSUMED_CONTEXT_WINDOW,
      },
      tools: tools as MountedTool[],
      toolHost: host,
      dispatch: async (jobId) => {
        const send = this.#deps.offloadModel;
        if (!send) throw new Error("no dispatcher configured");
        await send({ tenantId, agentId, taskId: LEGACY_TASK, commandId: jobId, payload: null });
      },
    });
    // The tools the model is offered are the mounts plus the sandbox. run_js is
    // not a mount — it is the one tool whose body is this object rather than a
    // plugin — so it is added here rather than resolved through the gateway.
    agent.harness.setTools([
      ...bridgeTools(tools as MountedTool[], host),
      runJsTool(this.#executor as any, host, {
        onCalls: (n) => { void store.consumeQuota(tenantId, "tool_calls", n); },
      }),
    ] as any, BACKGROUND_CONTEXT);

    this.#agent = agent;
    this.#agentKey = key;
    return agent;
  }

  /** Compact on demand, the way pi's /compact does: an operation like any
   *  other, so it is admitted, durable, and drives on the same pass. */
  async requestCompaction(tenantId: string, agentId: string) {
    return (await this.agent(tenantId, agentId)).compact();
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
  ) {
    const agent = await this.agent(tenantId, agentId);
    const res: any = await agent.say(text, mode);
    // What actually happened rather than what was asked for: a run admitted
    // carries an operation id, a queued message carries an entry id.
    const landed = res?.value?.operationId ? "prompt" : mode === "followUp" ? "followUp" : "steer";
    return { mode: landed, queued: landed !== "prompt", result: res };
  }

  /** One pass, which is all an alarm should ever do. */
  async step(tenantId: string, agentId: string) {
    const agent = await this.agent(tenantId, agentId);
    const out = await agent.step();
    // A finished run should not still be holding a metered container.
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    if (out.open === 0 && out.settled.length) {
      const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK });
      releaseFailed = r.failed;
    }
    return { ...out, releaseFailed };
  }

  /** What the worker asks for, and what it hands back. */
  async takeJob(tenantId: string, agentId: string, jobId: string) {
    return (await this.agent(tenantId, agentId)).takeJob(jobId);
  }

  async deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown) {
    return (await this.agent(tenantId, agentId)).deliver(jobId, answer as any);
  }
}
