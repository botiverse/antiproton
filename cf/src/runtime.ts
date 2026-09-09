/**
 * The agent runtime, assembled inside a Durable Object.
 *
 * Nothing here is Cloudflare-specific except the wiring: the kernel, harness,
 * gateway and plugins are the same modules the Node build uses. What changes is
 * that storage is local, wakeup is an alarm instead of a poll, and the sandbox
 * is a Dynamic Worker instead of QuickJS.
 */
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor } from "../../src/runtime/dynamic-worker-executor.ts";
import { Kernel } from "../../src/runtime/kernel.ts";
import {
  CommandExecutor,
  appendModelFailure,
  appendModelResponse,
  type CommandOffload,
} from "../../src/runtime/commands.ts";
import { CodegenHarness } from "../../src/harness/codegen.ts";
import { HybridHarness, qualifyMountedTools } from "../../src/harness/hybrid.ts";
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
  /** §18.2.1 measured hybrid best (8/8 vs 7/8 vs 5/8); codegen stays selectable
   *  so the mode remains an ablation variable rather than a hard-coded choice. */
  harnessMode?: "codegen" | "hybrid";
  /** Domain policy handed to the harness at task initialisation. */
  policy?: string;
}

export class AgentRuntime {
  readonly store: DurableObjectStore;
  #deps: RuntimeDeps;
  #plugins: Plugin[];
  #gateway: ToolGateway;
  #harness: CodegenHarness | HybridHarness;
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
    this.#harness = deps.harnessMode === "hybrid"
      ? new HybridHarness({ maxTurns: deps.maxTurns ?? 40 })
      // 60, the number the tau2 runner uses, not 10. The budget bounds a single
      // request now that a new message refills it, so a low cap bought nothing
      // and cost the agent the ability to finish anything multi-step.
      : new CodegenHarness({ maxTurns: deps.maxTurns ?? 60 });
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

  async openTask(tenantId: string, agentId: string, taskId: string) {
    const records = await this.store.listMounts(tenantId, agentId);
    const mounts = records.map((m) => ({
      alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
    }));
    // The model sees a plain name; the harness keeps the mount-qualified address
    // it dispatches to, because providers restrict tool-name charsets.
    const byId = new Map(this.#plugins.map((pl) => [pl.id, pl]));
    const tools = qualifyMountedTools(records.flatMap((m) =>
      (byId.get(m.plugin)?.tools ?? []).map((t) => ({
        name: t.name, description: t.summary, parameters: t.parameters,
        address: `${m.alias}.${t.name}`,
      })),
    ));
    const policy = this.#deps.policy ? { policy: this.#deps.policy } : {};
    // What this agent wrote down on earlier tasks. Read here rather than in the
    // harness so the harness keeps holding no I/O of its own.
    const workingSetText = await workingSet(this.store, tenantId, agentId);
    await this.store.createTask(
      tenantId, agentId, taskId,
      await this.#harness.initialize({ mounts, tools, workingSet: workingSetText, ...policy }),
      this.#harness.stateVersion,
    );
  }

  /**
    * The two gestures pi distinguishes, and the reason they are different.
    *
    * `steer` is the default and the one that matters: a message typed while the
    * agent is working reaches the model before its next call, without stopping
    * the tool call in flight. Nothing is aborted; the current turn finishes and
    * the new instruction is simply there when the next one is composed.
    *
    * `followUp` waits until the agent has finished everything. It is not
    * written to the log yet, because an event here means something happened to
    * the conversation and this has not happened until it is delivered.
    */
  async postMessage(
    tenantId: string, agentId: string, taskId: string, text: string,
    mode: "steer" | "followUp" = "steer",
  ) {
    await this.ready();
    const existing = await this.store.loadTask(tenantId, taskId);
    if (!existing) await this.openTask(tenantId, agentId, taskId);
    if (mode === "followUp" && existing && !["completed", "failed"].includes(existing.status)) {
      await this.store.queueFollowUp(tenantId, agentId, taskId, text);
      return { taskId, queued: true, reopened: false, checkpointVersion: existing.checkpointVersion };
    }
    const ev = await this.store.appendEvent({
      tenantId, agentId, taskId, kind: "message", payload: { text },
    });
    // Order matters: append first, then reopen. The reverse briefly exposes a
    // runnable task with nothing to consume.
    const reopened = await this.store.reopenTask(tenantId, taskId);
    return {
      taskId, sequence: ev.sequence, reopened,
      checkpointVersion: existing?.checkpointVersion ?? 0,
    };
  }

  #offload(): CommandOffload | null {
    const send = this.#deps.offloadModel;
    if (!send) return null;
    return async (ctx, cmd) => {
      // Only network-bound commands are worth offloading. `js.execute` needs the
      // host bridge that lives in this object, and `tool.call` is short.
      if (!OFFLOADABLE.includes(cmd.kind)) return false;
      try {
        await send({ ...ctx, commandId: cmd.commandId, payload: cmd.payload });
        return true;
      } catch {
        // A dispatcher that will not accept the job is not a reason to strand
        // the task: fall back to running it here.
        return false;
      }
    };
  }

  /** Called back by the dispatcher once the model answered (or failed). */
  async deliverModel(job: ModelJob, outcome: { ok: true; res: ModelResponse } | { ok: false; error: string }) {
    await this.ready();
    const ctx = { tenantId: job.tenantId, agentId: job.agentId, taskId: job.taskId };
    if (outcome.ok) await appendModelResponse(this.store, ctx, job.commandId, outcome.res);
    else await appendModelFailure(this.store, ctx, job.commandId, outcome.error);
  }

  /**
   * What is left for this object to look after now that the queue owns the
   * model call.
   *
   * Everything that used to be here — re-dispatching a model request whose
   * reply never came, giving up on it after fifteen minutes, keeping an alarm
   * alive so that sweep could happen at all — was a reimplementation of
   * "redeliver until acked". The queue does that, and does it whether or not
   * this object is awake. What it cannot do is recover work that runs *inside*
   * the object: a `js.execute` whose invocation the platform cancelled leaves a
   * row saying `dispatched` with no result and nothing that would run it again.
   * That, and only that, is swept here.
   */
  async sweepStale(olderThanMs = 45_000): Promise<number> {
    await this.ready();
    // Retire what has already been answered, so "still dispatched" means it.
    await this.store.settleAnswered();
    await this.store.reclaimStuckClaims(olderThanMs);
    return this.store.requeueStale(olderThanMs, ["js.execute", "tool.call"]);
  }

  /** True while some command is out with a dispatcher. Such a task has no
   *  pending events, so nothing else would schedule the sweep. */
  /**
   * Local work still outstanding — the only reason this object now needs an
   * alarm of its own. A task waiting on a model call needs no alarm at all: the
   * queue will deliver the reply, and delivering it wakes the object.
   */
  async hasOffloadInFlight(): Promise<boolean> {
    await this.ready();
    return (await this.store.outstandingCommands(["js.execute", "tool.call"])) > 0;
  }

  /**
   * One bounded slice of work. An alarm invocation must end; if there is more to
   * do it re-arms rather than looping until the platform cuts it off.
   */
  async drain(maxSteps = 4) {
    await this.ready();
    const trace: unknown[] = [];
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      const pending = await this.store.tasksWithPendingWork(5);
      if (!pending.length) break;
      for (const { tenantId, taskId } of pending) {
        const task = await this.store.loadTask(tenantId, taskId);
        if (!task) continue;
        const callCtx = { tenantId, agentId: task.agentId, taskId };
        const commands = new CommandExecutor(
          this.store, (caller) => this.#models.resolve(caller), this.#host(callCtx), this.#executor,
          undefined, this.#offload(),
        );
        const kernel = new Kernel(this.store, this.#harness, {
          holder: "do-worker", leaseTtlMs: 120_000,
        });
        await kernel.step(tenantId, taskId, null, (cmd) => commands.dispatch(callCtx, cmd));
        trace.push(...commands.trace);
        // A finished task should not still be holding a metered container.
        const after = await this.store.loadTask(tenantId, taskId);
        if (after && ["completed", "failed"].includes(after.status)) {
          await this.#gateway.releaseTask(callCtx);
          // Now that the work is done, anything held back for exactly this
          // moment is delivered and the task picks it up.
          if (await this.store.flushFollowUps(tenantId, task.agentId, taskId)) {
            await this.store.reopenTask(tenantId, taskId);
          }
        }
      }
    }
    const more = (await this.store.tasksWithPendingWork(1)).length > 0;
    return { steps, more, trace };
  }
}
