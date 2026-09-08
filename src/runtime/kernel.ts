import { createHash } from "node:crypto";
import type { StorageAdapter } from "../core/store.ts";
import type { Json, RuntimeEvent, TaskStatus, WaitSpec } from "../core/types.ts";

export interface AdvanceOutput {
  state: Json;
  status: TaskStatus;
  commands: Array<{ kind: string; payload: Json }>;
  waits: WaitSpec[];
}

export interface HarnessAdapter {
  readonly kind: string;
  readonly stateVersion: number;
  initialize(config: Json): Promise<Json>;
  advance(input: {
    state: Json;
    events: RuntimeEvent[];
    context: { tenantId: string; agentId: string; taskId: string; generation: number };
  }): Promise<AdvanceOutput>;
}

/**
 * Command ids are derived, never random. Re-running advance after a pre-commit
 * crash must produce the same ids so the outbox INSERT OR IGNORE collapses them.
 */
export function commandId(
  taskId: string,
  generation: number,
  checkpointVersion: number,
  index: number,
  kind: string,
  payload: Json,
): string {
  return createHash("sha256")
    .update(`${taskId}|${generation}|${checkpointVersion}|${index}|${kind}|${JSON.stringify(payload ?? null)}`)
    .digest("hex")
    .slice(0, 32);
}

export type CrashPoint = "before_commit" | "after_commit" | null;

/**
 * A checkpoint is written on every advance, by every task, for every tenant, so
 * its size is the framework's cost and not the harness's choice. One harness put
 * a static 447-tool catalogue in its state and rewrote 211 KB per step; nothing
 * refused it. Configuration belongs in the adapter, state belongs here, and the
 * boundary needs enforcing rather than documenting.
 */
export const DEFAULT_MAX_CHECKPOINT_BYTES = 256 * 1024;

/** Resources a tenant can exhaust. Charged where they are actually spent. */
export const QUOTA_STEPS = "steps";
export const QUOTA_MODEL_TOKENS = "model_tokens";
export const QUOTA_TOOL_CALLS = "tool_calls";

export interface StepResult {
  outcome:
    | "committed"
    | "no_lease"
    | "no_work"
    | "crashed_before_commit"
    | "crashed_after_commit"
    | "rejected";
  reason?: string;
  dispatched?: number;
}

export class Kernel {
  // Explicit fields: node's strip-only TS mode rejects parameter properties.
  #store: StorageAdapter;
  #harness: HarnessAdapter;
  #opts: { holder: string; leaseTtlMs?: number; maxCheckpointBytes?: number };

  constructor(
    store: StorageAdapter,
    harness: HarnessAdapter,
    opts: { holder: string; leaseTtlMs?: number; maxCheckpointBytes?: number } = { holder: "worker-1" },
  ) {
    this.#store = store;
    this.#harness = harness;
    this.#opts = opts;
  }

  async step(
    tenantId: string,
    taskId: string,
    crashAt: CrashPoint = null,
    dispatch?: (cmd: { commandId: string; kind: string; payload: Json }) => Promise<void>,
  ): Promise<StepResult> {
    const lease = await this.#store.acquireLease(
      tenantId,
      taskId,
      this.#opts.holder,
      this.#opts.leaseTtlMs ?? 30_000,
    );
    if (!lease) return { outcome: "no_lease" };

    const task = await this.#store.loadTask(tenantId, taskId);
    if (!task) return { outcome: "rejected", reason: "no_task" };

    const events = await this.#store.pendingEvents(tenantId, taskId, "harness");
    if (events.length === 0) return { outcome: "no_work" };

    // The gate sits before the work, not after it. A tenant that is out of
    // budget stops advancing at all, rather than being stopped later by
    // whichever call happens to notice — which is how a runaway loop keeps
    // spending while something downstream refuses it.
    const gate = await this.#store.consumeQuota(tenantId, QUOTA_STEPS, 1);
    if (!gate.allowed) {
      await this.#store.commitAdvance({
        tenantId, taskId, generation: task.generation, fencingToken: lease.fencingToken,
        expectedCheckpointVersion: task.checkpointVersion, checkpoint: task.checkpoint,
        status: "blocked", consumedThrough: null, waits: [], commands: [],
      });
      return { outcome: "rejected", reason: `quota_exceeded: ${QUOTA_STEPS} ${gate.used}/${gate.limit}` };
    }

    const out = await this.#harness.advance({
      state: task.checkpoint,
      events,
      context: {
        tenantId,
        agentId: task.agentId,
        taskId,
        generation: task.generation,
      },
    });

    const commands = out.commands.map((c, i) => ({
      commandId: commandId(taskId, task.generation, task.checkpointVersion, i, c.kind, c.payload),
      kind: c.kind,
      payload: c.payload,
    }));

    // Refuse before committing, so an oversized checkpoint is a loud rejection
    // rather than a per-step storage bill nobody notices.
    const limit = this.#opts.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    const size = JSON.stringify(out.state ?? null).length;
    if (size > limit) {
      return {
        outcome: "rejected",
        reason: `checkpoint_too_large: ${size} bytes exceeds ${limit}`,
      };
    }

    if (crashAt === "before_commit") return { outcome: "crashed_before_commit" };

    const res = await this.#store.commitAdvance({
      tenantId,
      taskId,
      generation: task.generation,
      fencingToken: lease.fencingToken,
      expectedCheckpointVersion: task.checkpointVersion,
      checkpoint: out.state,
      status: out.status,
      consumedThrough: events[events.length - 1]!.sequence,
      waits: out.waits,
      commands,
    });
    if (!res.ok) return { outcome: "rejected", reason: res.reason };

    if (crashAt === "after_commit") return { outcome: "crashed_after_commit" };

    const dispatched = dispatch ? await this.drainOutbox(dispatch, 100, tenantId) : 0;
    return { outcome: "committed", dispatched };
  }

  /** Separate from step() on purpose: recovery must be able to run it alone. */
  async drainOutbox(
    dispatch: (cmd: { commandId: string; kind: string; payload: Json }) => Promise<void>,
    limit = 100,
    tenantId?: string,
  ): Promise<number> {
    const batch = await this.#store.claimOutbox(limit, tenantId);
    for (const cmd of batch) {
      await dispatch(cmd);
      await this.#store.markDispatched(cmd.commandId);
    }
    return batch.length;
  }
}
