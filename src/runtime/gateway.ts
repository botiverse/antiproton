import { createHash, randomUUID } from "node:crypto";
import type { StorageAdapter } from "../core/store.ts";
import type { Json, MountPolicy, MountRecord, PolicyDecision } from "../core/types.ts";
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

/**
 * What a mount may do without a human.
 *
 * Per-tool beats the side-effect default, and an absent policy allows — a mount
 * the operator has just deliberately created should work. The check lives here,
 * at the same choke point that holds credentials, so no harness and no sandbox
 * can route around it.
 */
export function policyFor(
  policy: MountPolicy | null | undefined,
  tool: string,
  sideEffects: "read" | "write",
): PolicyDecision {
  if (!policy) return "allow";
  const perTool = policy.tools?.[tool];
  if (perTool) return perTool;
  return (sideEffects === "write" ? policy.write : policy.read) ?? "allow";
}

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

  /**
   * `idempotencyKey` makes a call replayable.
   *
   * A command that crashed after dispatch is re-sent by the outbox, and the
   * sandbox re-runs the same source — but every tool call inside it used to
   * mint a fresh random operation id, so a write simply happened twice with
   * nothing able to notice. Deriving the id from the key (the same trick the
   * outbox already uses for command ids) makes the replay recognisable.
   *
   * A repeated read is re-executed, which is harmless. A repeated write is not
   * executed again: it answers `unknown`, which is exactly what that status
   * means — the request may already have landed.
   */
  /**
   * Apply a human decision to a held call.
   *
   * Deciding is atomic and happens once, so one approval can never authorise
   * two executions. On approval the recorded request is executed exactly as it
   * was recorded — an approver approved that request, not whatever the agent
   * might ask for next — and the result rides the completion event back to the
   * task, which the store wakes.
   */
  async applyApproval(
    tenantId: string,
    operationId: string,
    decision: "approved" | "denied",
    approver: string,
  ): Promise<{ ok: false; reason: string } | { ok: true; executed: boolean; result?: ToolResult }> {
    const decided = await this.#store.decideApproval(tenantId, operationId, decision, approver);
    if (!decided.ok) return { ok: false, reason: decided.reason };

    const a = decided.record;
    if (decision === "denied") {
      await this.#store.completeOperation(tenantId, operationId, "cancelled", null, {
        denied: true, approver,
      });
      return { ok: true, executed: false };
    }

    const req = a.request as { tool: string; args: Json };
    const ctx: CallContext = { tenantId, agentId: a.agentId, taskId: a.taskId };
    // `approved` bypasses the policy check for this one recorded call only.
    const result = await this.invoke(ctx, req.tool, req.args, { approved: true, operationId });
    await this.#store.completeOperation(
      tenantId, operationId, result.status === "succeeded" ? "succeeded" : "failed", null, result as Json,
    );
    return { ok: true, executed: true, result };
  }

  async invoke(
    ctx: CallContext,
    raw: string,
    args: Json,
    opts: { idempotencyKey?: string; approved?: boolean; operationId?: string } = {},
  ): Promise<ToolResult> {
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

    const schema = plugin.tools.find((t) => t.name === r.tool)!;
    const operationId = opts.operationId ?? (opts.idempotencyKey
      ? `op_${createHash("sha256").update(`${ctx.tenantId}|${ctx.taskId}|${opts.idempotencyKey}`).digest("hex").slice(0, 20)}`
      : `op_${randomUUID().replace(/-/g, "").slice(0, 20)}`);

    if (opts.idempotencyKey) {
      const prior = await this.#store.getOperation(ctx.tenantId, operationId);
      if (prior && schema.sideEffects === "write") {
        return {
          status: "unknown",
          operationId,
          error: {
            code: "already_attempted",
            message:
              `${r.mount.alias}.${r.tool} was already attempted under this key ` +
              `(status ${prior.status}); it may have landed, so it is not repeated`,
          },
        };
      }
      // A read is safe to redo; recordOperation below is a no-op on conflict.
    }

    await this.#store.recordOperation({
      operationId,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      mountAlias: r.mount.alias,
      tool: `${r.mount.plugin}.${r.tool}`,
      toolVersion: r.mount.toolVersion,
    });

    const verdict = opts.approved ? "allow" : policyFor(r.mount.policy, r.tool, schema.sideEffects);
    if (verdict === "deny") {
      return {
        status: "rejected",
        error: { code: "policy_denied", message: `${r.mount.alias}.${r.tool} is denied by policy` },
      };
    }
    if (verdict === "approval") {
      // Recorded, not executed, and not blocking a thread: the approver may
      // take hours and nothing should hold a process for them. The task parks
      // on the operation and is woken by the decision.
      await this.#store.requireApproval({
        tenantId: ctx.tenantId, operationId, agentId: ctx.agentId, taskId: ctx.taskId,
        mountAlias: r.mount.alias, tool: r.tool, request: { tool: raw, args },
      });
      return {
        status: "pending",
        operationId,
        error: {
          code: "awaiting_approval",
          message: `${r.mount.alias}.${r.tool} is held for approval`,
        },
      } as ToolResult;
    }

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
