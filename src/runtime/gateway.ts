import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "../core/store.ts";
import type { Json, MountRecord } from "../core/types.ts";
import type { ToolError, ToolResult } from "../core/tools.ts";
import { parseToolRef } from "../core/tools.ts";
import type { Plugin } from "../plugins/types.ts";

/** Resolves secret_ref -> credential. Values never enter the JS sandbox, a
 *  checkpoint, the trajectory, or a model prompt. */
export interface SecretResolver {
  resolve(ref: string): Promise<string | null>;
}

export const envSecrets: SecretResolver = {
  async resolve(ref) {
    return process.env[ref.replace(/^env:/, "")] ?? null;
  },
};

export interface CallContext {
  tenantId: string;
  agentId: string;
  taskId: string;
}

type Resolution = { mount: MountRecord; tool: string } | { error: ToolError };

export class ToolGateway {
  #store: StorageAdapter;
  #plugins: Map<string, Plugin>;
  #secrets: SecretResolver;

  constructor(store: StorageAdapter, plugins: Plugin[], secrets: SecretResolver = envSecrets) {
    this.#store = store;
    this.#plugins = new Map(plugins.map((p) => [p.id, p]));
    this.#secrets = secrets;
  }

  /** alias.tool  →  exact mount.  plugin.tool  →  only if unambiguous. */
  async resolve(ctx: CallContext, raw: string): Promise<Resolution> {
    const ref = parseToolRef(raw);
    if (!ref) return { error: { code: "bad_tool_name", message: `not a tool name: ${raw}` } };

    const byAlias = await this.#store.getMountByAlias(ctx.tenantId, ctx.agentId, ref.head);
    if (byAlias) return { mount: byAlias, tool: ref.tool };

    const byPlugin = await this.#store.findMountsByPlugin(ctx.tenantId, ctx.agentId, ref.head);
    if (byPlugin.length === 1) return { mount: byPlugin[0]!, tool: ref.tool };
    if (byPlugin.length > 1) {
      // Never silently default: that is how cross-account pollution happens.
      return {
        error: {
          code: "ambiguous_mount",
          message: `"${ref.head}" is mounted ${byPlugin.length} times; address one alias explicitly`,
          candidates: byPlugin.map((m) => `${m.alias}.${ref.tool}`),
        },
      };
    }
    return {
      error: {
        code: "not_mounted",
        message: `no mount named "${ref.head}" for this agent`,
        authorizationUrl: `https://harness.local/agents/${ctx.agentId}/mounts/new?plugin=${ref.head}`,
      },
    };
  }

  async invoke(ctx: CallContext, raw: string, args: Json): Promise<ToolResult> {
    const r = await this.resolve(ctx, raw);
    if ("error" in r) return { status: "rejected", error: r.error };

    const plugin = this.#plugins.get(r.mount.plugin);
    if (!plugin) {
      return { status: "rejected", error: { code: "plugin_unavailable", message: r.mount.plugin } };
    }
    // Version is pinned by the mount, so an update mid-flight cannot change the
    // contract an in-flight operation was accepted under.
    if (plugin.version !== r.mount.toolVersion) {
      return {
        status: "rejected",
        error: {
          code: "version_mismatch",
          message: `mount pins ${r.mount.toolVersion}, registry has ${plugin.version}`,
        },
      };
    }
    if (!plugin.tools.some((t) => t.name === r.tool)) {
      return { status: "rejected", error: { code: "unknown_tool", message: r.tool } };
    }

    const operationId = `op_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await this.#store.recordOperation({
      operationId,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      mountAlias: r.mount.alias,
      tool: `${r.mount.plugin}.${r.tool}`,
      toolVersion: r.mount.toolVersion,
    });

    const credential = r.mount.secretRef ? await this.#secrets.resolve(r.mount.secretRef) : null;
    try {
      const store = this.#store;
      const secrets = this.#secrets;
      const mount = r.mount;
      const connectionFor = (alias: string) => ({
        get: () => store.getConnection(ctx.tenantId, ctx.agentId, alias),
        set: (state: Json, expiresAt?: number | null) =>
          store.putConnection(ctx.tenantId, ctx.agentId, alias, state, expiresAt ?? null),
      });
      const result = await plugin.invoke(r.tool, args, {
        caller: { tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId },
        credential,
        publicConfig: mount.publicConfig,
        // Scoped to the mount, not the plugin: two accounts of the same service
        // must never see each other's session.
        connection: connectionFor(mount.alias),
        async sibling(alias: string) {
          // Only this agent's own mounts: never a lookup by tenant or by plugin.
          const other = await store.getMountByAlias(ctx.tenantId, ctx.agentId, alias);
          if (!other) return null;
          return {
            credential: other.secretRef ? await secrets.resolve(other.secretRef) : null,
            connection: connectionFor(other.alias),
          };
        },
      });
      await this.#store.completeOperation(ctx.tenantId, operationId, "succeeded", null);
      return { status: "succeeded", operationId, result };
    } catch (err) {
      const e = err as Error & { retryable?: boolean };
      // A request that may have landed is "unknown", not "failed" (§8.3).
      const status = e.retryable ? "unknown" : "failed";
      await this.#store.completeOperation(ctx.tenantId, operationId, status, null);
      return { status, operationId, error: { code: "tool_error", message: e.message } };
    }
  }
}
