import { createHash, randomUUID } from "node:crypto";
import type { StorageAdapter } from "../core/store.ts";
import type { Json, MountPolicy, MountRecord, PolicyDecision } from "../core/types.ts";
import type { ToolError, ToolResult } from "../core/tools.ts";
import { parseToolRef } from "../core/tools.ts";
import type { Plugin, MountActivity, MountUsage } from "../plugins/types.ts";
import { pluginEnabled } from "../plugins/types.ts";

/** Resolves secret_ref -> credential. Values never enter the JS sandbox, a
 *  checkpoint, the trajectory, or a model prompt. */
export interface SecretResolver {
  /** `scope` is the mount's owner. A reference is resolved for the agent whose
   *  mount names it, never for whoever wrote the string. */
  resolve(ref: string, scope?: { tenantId: string; agentId: string }): Promise<string | null>;
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
  /**
   * One queue per mount that declared it cannot overlap, keyed
   * `tenant/agent/alias`.
   *
   * `exclusive` was being honoured by the harness and nowhere else: pi runs a
   * turn's tool calls in parallel unless a tool says otherwise, and
   * `bridgeTools` marks these `executionMode: "sequential"`. But `run_js`
   * dispatches by address and its sandbox allows eight host calls in flight
   * (`maxConcurrentHostCalls`), so a script doing two shells at once never
   * passes through the harness that was enforcing this — and the plugin's own
   * state is read-modify-write, so the second write wins and the first box is
   * forgotten while it goes on being billed.
   *
   * That is the same argument as every other check here: the gateway is the
   * choke point precisely because the paths that reach it are not all the same
   * path (Rex found the read-modify-write; the reachability is ours).
   */
  #queues = new Map<string, Promise<unknown>>();

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

  /**
   * Release whatever this agent's mounts are holding, now the task is done.
   *
   * The scope is the agent, not the task, whatever the name suggests: every
   * mount the agent holds is released, and `ctx.taskId` is carried for the
   * audit record, not used to select. With one conversation the two coincided;
   * with several, the runtime calls this only when no conversation has work
   * open, which is what keeps the name honest.
   *
   * Errors are swallowed on purpose: this runs after the work, and a mount that
   * cannot tidy up must not turn a finished task into a failed one.
   */
  /**
   * The paragraphs the mounted plugins want in the system prompt.
   *
   * In registry order, not mount order: the prompt prefix is cached by the
   * provider, and mounts are listed by alias, so a person renaming one would
   * otherwise reorder the prompt and throw the cache away. The registry is an
   * array that only ever grows at the end, so a new plugin's paragraph lands
   * after every existing byte. Within one plugin, mounts keep their alias
   * order, which is stable for a given set of mounts.
   *
   * No credential is resolved: a paragraph is a description of what the agent
   * can do, and asking for a key to write one would make the prompt depend on
   * a secret being present.
   */
  async promptContributions(ctx: CallContext): Promise<string[]> {
    const mounts = await this.#store.listMounts(ctx.tenantId, ctx.agentId);
    const out: string[] = [];
    for (const [id, plugin] of this.#plugins) {
      if (!plugin.promptContribution) continue;
      for (const mount of mounts.filter((m) => m.plugin === id)) {
        let text: string | null = null;
        try {
          text = await plugin.promptContribution({
            caller: { tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId },
            alias: mount.alias,
            credential: null,
            publicConfig: mount.publicConfig,
            connection: {
              get: () => this.#store.getConnection(ctx.tenantId, ctx.agentId, mount.alias),
              set: (state, expiresAt) =>
                this.#store.putConnection(ctx.tenantId, ctx.agentId, mount.alias, state, expiresAt ?? null),
            },
            async sibling() { return null; },
          });
        } catch (e: any) {
          // A plugin that cannot describe itself must not stop the agent from
          // opening: the paragraph is dropped and the run continues.
          console.warn(`promptContribution failed for ${mount.alias}: ${String(e?.message ?? e)}`);
          text = null;
        }
        if (text?.trim()) out.push(text.trim());
      }
    }
    return out;
  }

  /**
   * Ask one mount what it is holding, in the shape everyone asks in.
   *
   * Here because this is the only place that builds a `PluginContext`, and
   * because the alternative is what it replaces: three callers reaching into
   * one plugin's connection state for a field named `boxId`, each of them
   * quietly asserting that "something running" is that plugin's idea of it.
   *
   * No credential is resolved. The contract says this must not need one — it is
   * asked precisely when nobody is using the mount, which is when a credential
   * may already have been taken away — so passing one would invite an
   * implementation to depend on it.
   */
  async mountActivity(
    ctx: { tenantId: string; agentId: string; taskId: string }, alias: string,
  ): Promise<MountActivity> {
    const mount = await this.#store.getMountByAlias(ctx.tenantId, ctx.agentId, alias);
    const plugin = mount ? this.#plugins.get(mount.plugin) : null;
    // A mount that keeps nothing, a plugin that is not installed, and a plugin
    // that does not implement this all answer the same thing, and it is the
    // true one: nothing of this mount's is running.
    if (!mount || !plugin?.activity) return { live: null };
    return plugin.activity({
      caller: { tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId },
      alias: mount.alias,
      credential: null,
      publicConfig: mount.publicConfig,
      connection: {
        get: () => this.#store.getConnection(ctx.tenantId, ctx.agentId, mount.alias),
        set: (state, expiresAt) =>
          this.#store.putConnection(ctx.tenantId, ctx.agentId, mount.alias, state, expiresAt ?? null),
      },
      async sibling() { return null; },
    });
  }

  /**
   * What one mount has finished with, in the shape everyone asks in.
   *
   * Separate from `mountActivity` rather than a flag on it, because the two
   * have different callers and different costs: the alarm asks what is running
   * on every pass and must not pay for history nobody reads, while a page asks
   * for history once when a person opens it. A flag would also make the return
   * shape depend on an argument, which is a signature you cannot read without
   * finding the call site.
   *
   * **Not a ledger.** A mount answers from what it kept, and what it kept is
   * bounded and only holds what was handed back properly — so this says
   * "recently, and only the tidy ones". The complete record has to be written
   * where the thing happens, not read back from the thing that did it.
   */
  async mountUsage(
    ctx: { tenantId: string; agentId: string; taskId: string }, alias: string,
  ): Promise<MountUsage[]> {
    const mount = await this.#store.getMountByAlias(ctx.tenantId, ctx.agentId, alias);
    const plugin = mount ? this.#plugins.get(mount.plugin) : null;
    if (!mount || !plugin?.usage) return [];
    return plugin.usage({
      caller: { tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId },
      alias: mount.alias,
      credential: null,
      publicConfig: mount.publicConfig,
      connection: {
        get: () => this.#store.getConnection(ctx.tenantId, ctx.agentId, mount.alias),
        set: (state, expiresAt) =>
          this.#store.putConnection(ctx.tenantId, ctx.agentId, mount.alias, state, expiresAt ?? null),
      },
      async sibling() { return null; },
    });
  }

  async releaseTask(
    ctx: CallContext,
    /** One mount rather than all of them. A plugin's `release` was always
     *  per-mount — it is handed the alias and that mount's own connection —
     *  and the fan-out is here, so this is where a caller that means one box
     *  says so (Piper, 2026-09-12). */
    opts?: { alias?: string },
  ): Promise<{ released: string[]; failed: Array<{ alias: string; error: string }> }> {
    const released: string[] = [];
    const failed: Array<{ alias: string; error: string }> = [];
    for (const mount of await this.#store.listMounts(ctx.tenantId, ctx.agentId)) {
      if (opts?.alias && mount.alias !== opts.alias) continue;
      const plugin = this.#plugins.get(mount.plugin);
      if (!plugin?.release) continue;
      try {
        const did = await plugin.release({
          caller: { tenantId: ctx.tenantId, agentId: ctx.agentId, taskId: ctx.taskId },
          alias: mount.alias,
          credential: mount.secretRef
            ? await this.#secrets.resolve(mount.secretRef, { tenantId: mount.tenantId, agentId: mount.agentId })
            : null,
          publicConfig: mount.publicConfig,
          connection: {
            get: () => this.#store.getConnection(ctx.tenantId, ctx.agentId, mount.alias),
            set: (state, expiresAt) =>
              this.#store.putConnection(ctx.tenantId, ctx.agentId, mount.alias, state, expiresAt ?? null),
          },
          async sibling() { return null; },
        });
        // Only report what was actually holding something: a release log that
        // names every mount tells you nothing about what was costing anything.
        if (did !== false) released.push(mount.alias);
      } catch (e) {
        // Best effort, but not silent. Swallowing this is how a metered
        // container stays alive with nothing left that would notice — the
        // same failure, one layer up, that stopBox was fixed for.
        failed.push({ alias: mount.alias, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    return { released, failed };
  }

  async invoke(
    ctx: CallContext,
    raw: string,
    args: Json,
    opts: { idempotencyKey?: string; approved?: boolean; operationId?: string; confirm?: boolean } = {},
  ): Promise<ToolResult> {
    // Resolved before queueing, because which queue a call belongs in is a
    // property of the mount it names, and refusals should not wait behind
    // someone else's container.
    const r0 = await this.resolve(ctx, raw);
    if ("error" in r0) return { status: "rejected", error: r0.error };
    if (!this.#plugins.get(r0.mount.plugin)?.exclusive) return this.#invoke(ctx, raw, args, opts);

    const key = `${ctx.tenantId}/${ctx.agentId}/${r0.mount.alias}`;
    // The chain is the lock: each call waits for the one before it to settle.
    // A failure must not break the chain — the caller behind a refused call is
    // owed its turn, not the refusal.
    const tail = this.#queues.get(key) ?? Promise.resolve();
    const run = tail.then(() => this.#invoke(ctx, raw, args, opts), () => this.#invoke(ctx, raw, args, opts));
    const settled = run.then(() => {}, () => {});
    this.#queues.set(key, settled);
    // Dropped when it settles, but only if nobody queued behind it — otherwise
    // a finishing call would remove the queue its successor is waiting on.
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return run;
  }

  async #invoke(
    ctx: CallContext,
    raw: string,
    args: Json,
    opts: { idempotencyKey?: string; approved?: boolean; operationId?: string; confirm?: boolean } = {},
  ): Promise<ToolResult> {
    const r = await this.resolve(ctx, raw);
    if ("error" in r) return { status: "rejected", error: r.error };
    // The agent's own hold: a call sent with `opts.confirm` is held exactly as
    // a policy hold would be, and the person decides. It is an option, not an
    // argument, so the plugin's parameter names stay its own (appworld
    // forwards every argument it receives to an API whose names nobody here
    // chose). The model can only write arguments; the bridge lifts the field
    // out at the model boundary (pi-tools.ts, `liftConfirm`).
    const confirm = opts.confirm === true;

    const plugin = this.#plugins.get(r.mount.plugin);
    if (!plugin) {
      return { status: "rejected", error: { code: "plugin_unavailable", message: r.mount.plugin } };
    }
    // Withholding the tools is not the same as refusing the call, and only the
    // second one holds. A conversation opened before the plugin was switched
    // off still has the old tool list, and `run_js` dispatches by address —
    // both reach the mount without ever consulting a catalogue. The choke
    // point is here, as it is for credentials and policy.
    //
    // It costs one indexed read on the hottest path, and that is deliberate:
    // it could be folded into the mount lookup above, which reads rows of the
    // same agent, but then the switch would be enforced by a query written for
    // something else. One choke point is worth more than one saved read, and
    // this note exists so the cost reads as a decision rather than as an
    // oversight nobody dares remove (Piper asked, 2026-09-12).
    const choices = await this.#store.pluginChoices(ctx.tenantId, ctx.agentId);
    if (!pluginEnabled(plugin, choices[r.mount.plugin])) {
      return {
        status: "rejected",
        // Addressed to the model, which must do something else now: it says
        // the mount still exists and that a person, not the agent, reopens it.
        error: {
          code: "plugin_disabled",
          message: `the \`${r.mount.alias}\` mount is switched off for this agent; someone has to turn it back on`,
        },
      };
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
            // These three messages reach the model, so they must not name the
            // dispatch address: `alias.tool` is how the gateway routes, while
            // the model was offered `alias__tool`, and the qualifier is not a
            // rule this file could apply anyway (it truncates and breaks ties
            // over the whole catalogue). The call it just made is the subject;
            // it does not need to be named back (Piper, Vera, Dora, #113's
            // class, 2026-09-12).
            message:
              `this call was already attempted under this key ` +
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

    const verdict = opts.approved ? "allow" : confirm ? "approval" : policyFor(r.mount.policy, r.tool, schema.sideEffects);
    if (verdict === "deny") {
      return {
        status: "rejected",
        // The one the model must act on: it says the road is closed, so the
        // next thing it does is choose another tool or explain to a person.
        error: { code: "policy_denied", message: `this call is denied by the \`${r.mount.alias}\` mount's policy` },
      };
    }
    if (verdict === "approval") {
      // Recorded, not executed, and not blocking a thread: the approver may
      // take hours and nothing should hold a process for them. The task parks
      // on the operation and is woken by the decision.
      await this.#store.requireApproval({
        tenantId: ctx.tenantId, operationId, agentId: ctx.agentId, taskId: ctx.taskId,
        mountAlias: r.mount.alias, tool: r.tool,
        // `heldBy` tells the card who asked for it: a policy, or the agent.
        request: { tool: raw, args, heldBy: confirm ? "agent" : "policy" },
      });
      return {
        status: "pending",
        operationId,
        error: {
          code: "awaiting_approval",
          message: `this call is held for approval`,
        },
      } as ToolResult;
    }

    const credential = r.mount.secretRef
      ? await this.#secrets.resolve(r.mount.secretRef, { tenantId: r.mount.tenantId, agentId: r.mount.agentId })
      : null;
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
        alias: mount.alias,
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
            credential: other.secretRef
              ? await secrets.resolve(other.secretRef, { tenantId: other.tenantId, agentId: other.agentId })
              : null,
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

  /**
   * Operator-only: does this mount's credential work? Runs the plugin's own
   * `checkCredential` with the same context a call would get, minus a task.
   * Never a tool, so the model cannot ask; the value still never leaves the
   * plugin's call context.
   */
  async checkMount(tenantId: string, agentId: string, alias: string):
    Promise<{ ok: true; account?: string } | { ok: false; kind: "rejected" | "unreachable"; reason: string } | null> {
    const mount = await this.#store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return null;
    const plugin = this.#plugins.get(mount.plugin);
    if (!plugin?.checkCredential) return null;
    const credential = mount.secretRef
      ? await this.#secrets.resolve(mount.secretRef, { tenantId, agentId }) : null;
    const store = this.#store;
    const connectionFor = (a: string) => ({
      get: () => store.getConnection(tenantId, agentId, a),
      set: (state: Json, expiresAt?: number | null) => store.putConnection(tenantId, agentId, a, state, expiresAt ?? null),
    });
    try {
      return await plugin.checkCredential({
        caller: { tenantId, agentId, taskId: "credential-check" },
        alias,
        credential, publicConfig: mount.publicConfig, connection: connectionFor(alias),
        async sibling() { return null; },
      });
    } catch (e) {
      // A check that threw gave no verdict on the key: the provider was not
      // reached, or the plugin failed before asking it. Either way it is not
      // a rejection, and the route keeps the key unverified rather than
      // refusing it. Said explicitly, since the route reads `kind`.
      return { ok: false, kind: "unreachable", reason: String((e as Error).message ?? e).slice(0, 200) };
    }
  }
}
