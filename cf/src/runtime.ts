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
import { CommandExecutor } from "../../src/runtime/commands.ts";
import { CodegenHarness } from "../../src/harness/codegen.ts";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { githubPlugin } from "../../src/plugins/github.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { artifactsPlugin } from "../../src/plugins/artifacts.ts";
import type { Plugin } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";

const OFFLOAD_BYTES = 32 * 1024;

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

export interface RuntimeDeps {
  ctx: any;
  bucketName: string;
  bucket: R2Bucket;
  loader: any;
  makeToolBinding: (execId: string) => unknown;
  modelBaseUrl: string;
  modelApiKey: string;
  modelName: string;
}

export class AgentRuntime {
  readonly store: DurableObjectStore;
  #deps: RuntimeDeps;
  #plugins: Plugin[];
  #gateway: ToolGateway;
  #harness: CodegenHarness;
  #executor: DynamicWorkerExecutor;
  #model: OpenAiCompatibleModel;
  #artifacts: BoundArtifacts;
  #ready = false;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.store = new DurableObjectStore(deps.ctx);
    this.#artifacts = new BoundArtifacts(deps.bucket, deps.bucketName);
    const plugins: Plugin[] = [];
    plugins.push(
      githubPlugin,
      artifactsPlugin(this.#artifacts as any, deps.bucketName),
      builtinToolsPlugin(this.store, () => plugins),
    );
    this.#plugins = plugins;
    this.#gateway = new ToolGateway(this.store, plugins);
    this.#harness = new CodegenHarness({ maxTurns: 10 });
    this.#executor = new DynamicWorkerExecutor({
      loader: deps.loader,
      makeToolBinding: deps.makeToolBinding,
    });
    this.#model = new OpenAiCompatibleModel({
      baseUrl: deps.modelBaseUrl,
      apiKey: deps.modelApiKey,
      model: deps.modelName,
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
      async invoke(call: { tool: string; args: any }): Promise<ToolResult> {
        const res = await gw.invoke(ctx, call.tool, call.args);
        if (res.status !== "succeeded") return res;
        const body = JSON.stringify(res.result);
        if (body.length <= OFFLOAD_BYTES) return res;
        const key = `t/${ctx.tenantId}/${ctx.agentId}/${res.operationId}.json`;
        const stored = await artifacts.put(key, body);
        await store.completeOperation(ctx.tenantId, res.operationId, "succeeded", stored.ref);
        const items = Array.isArray(res.result) ? (res.result as any[]) : [];
        return {
          status: "succeeded",
          operationId: res.operationId,
          result: {
            ref: stored.ref, bytes: stored.bytes, count: items.length,
            preview: items.slice(0, 5).map((i) => ({ number: i.number, title: i.title })),
            note: "parked; read with artifacts.read { ref, fields, offset, limit }",
          },
        };
      },
    };
  }

  async provision(tenantId: string, agentId: string) {
    await this.ready();
    if (await this.store.loadTask(tenantId, `${agentId}:probe`)) return { agentId, created: false };
    try {
      await this.store.createAgent(tenantId, agentId, {});
    } catch {
      return { agentId, created: false };
    }
    for (const m of [
      { alias: "tools", plugin: "tools", account: "builtin" },
      { alias: "artifacts", plugin: "artifacts", account: "builtin" },
      { alias: "gh_public", plugin: "github", account: "unauthenticated" },
    ]) {
      await this.store.addMount({
        tenantId, agentId, alias: m.alias, plugin: m.plugin,
        installationId: `inst-${m.alias}`, connectionId: null, toolVersion: "1.0.0",
        publicConfig: { account: m.account }, secretRef: null,
      });
    }
    return { agentId, created: true };
  }

  async openTask(tenantId: string, agentId: string, taskId: string) {
    const mounts = (await this.store.listMounts(tenantId, agentId)).map((m) => ({
      alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
    }));
    await this.store.createTask(tenantId, agentId, taskId, await this.#harness.initialize({ mounts }));
  }

  async postMessage(tenantId: string, agentId: string, taskId: string, text: string) {
    await this.ready();
    if (!(await this.store.loadTask(tenantId, taskId))) await this.openTask(tenantId, agentId, taskId);
    const ev = await this.store.appendEvent({
      tenantId, agentId, taskId, kind: "message", payload: { text },
    });
    return { taskId, sequence: ev.sequence };
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
          this.store, this.#model, this.#host(callCtx), this.#executor,
        );
        const kernel = new Kernel(this.store, this.#harness, {
          holder: "do-worker", leaseTtlMs: 120_000,
        });
        await kernel.step(tenantId, taskId, null, (cmd) => commands.dispatch(callCtx, cmd));
        trace.push(...commands.trace);
      }
    }
    const more = (await this.store.tasksWithPendingWork(1)).length > 0;
    return { steps, more, trace };
  }
}
