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
  #opts: { holder: string; leaseTtlMs?: number };

  constructor(
    store: StorageAdapter,
    harness: HarnessAdapter,
    opts: { holder: string; leaseTtlMs?: number } = { holder: "worker-1" },
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

    const dispatched = dispatch ? await this.drainOutbox(dispatch) : 0;
    return { outcome: "committed", dispatched };
  }

  /** Separate from step() on purpose: recovery must be able to run it alone. */
  async drainOutbox(
    dispatch: (cmd: { commandId: string; kind: string; payload: Json }) => Promise<void>,
    limit = 100,
  ): Promise<number> {
    const batch = await this.#store.claimOutbox(limit);
    for (const cmd of batch) {
      await dispatch(cmd);
      await this.#store.markDispatched(cmd.commandId);
    }
    return batch.length;
  }
}
