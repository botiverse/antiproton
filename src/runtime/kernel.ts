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
  /**
   * Bring a checkpoint written by an older `stateVersion` up to this one.
   *
   * Required, not optional: an adapter that declares a version is promising it
   * can read its own past. This was declared and never called for long enough
   * that a migration shipped dead — the harness had one, the kernel had no path
   * to it, and its test called the function directly so it stayed green.
   */
  migrate(state: Json, from: number): Promise<Json>;
  /**
   * Shrink a checkpoint that has outgrown its budget, or return null if it
   * cannot. Called by the kernel *before* refusing, because refusing alone is a
   * deadlock: the only thing that would make the state smaller runs inside
   * advance, and advance is what the size is stopping.
   */
  shrink?(state: Json, targetBytes: number): Promise<Json | null>;
  /** Versions start at 1; 0 is reserved for "never recorded". */
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

/**
 * How often to snapshot, in consumed events.
 *
 * Rebuilding folds the log from the last snapshot, so with only the one written
 * at creation a long task costs O(all events) to reconstruct — and long tasks
 * are the point. Periodic snapshots keep rebuild bounded without making the
 * checkpoint authoritative: the log is still the truth, these are just closer
 * starting points.
 */
export const DEFAULT_SNAPSHOT_EVERY = 50;

/** Snapshots to keep besides the first. Each holds the whole conversation, so
 *  keeping them all is quadratic; keeping a few bounds rebuild just as well. */
export const DEFAULT_SNAPSHOTS_KEPT = 3;

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
  #opts: {
    holder: string; leaseTtlMs?: number; maxCheckpointBytes?: number;
    snapshotEvery?: number; snapshotsKept?: number;
  };

  constructor(
    store: StorageAdapter,
    harness: HarnessAdapter,
    opts: {
      holder: string; leaseTtlMs?: number; maxCheckpointBytes?: number;
      snapshotEvery?: number; snapshotsKept?: number;
    } = { holder: "worker-1" },
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
        stateVersion: task.stateVersion, status: "blocked", consumedThrough: null, waits: [], commands: [],
      });
      return { outcome: "rejected", reason: `quota_exceeded: ${QUOTA_STEPS} ${gate.used}/${gate.limit}` };
    }

    // Migrate before advancing, and commit the result under the new version, so
    // it happens exactly once however many times the task is resumed.
    // 0 means "no version was ever recorded" — a task opened before versions
    // were tracked, or by a caller that did not pass one. Adopting the current
    // version is right; migrating from a version that was never written is not.
    const needsMigration =
      task.stateVersion !== 0 && task.stateVersion !== this.#harness.stateVersion;
    const state = needsMigration
      ? await this.#harness.migrate(task.checkpoint, task.stateVersion)
      : task.checkpoint;

    const out = await this.#harness.advance({
      state,
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

    // A checkpoint that outgrows its budget used to be refused here and
    // nowhere else: nothing committed, so the events stayed unconsumed, the
    // alarm kept re-arming on work that could never be done, and the page read
    // "working" for ever. The comment claimed a loud rejection; the caller
    // discarded the outcome, so it was the quietest failure in the system.
    //
    // It is also a deadlock on its own terms. What would make the state smaller
    // lives inside advance, and advance is exactly what the size is stopping.
    // So the harness is asked to shrink first, and only a harness that cannot
    // is refused — visibly, as a blocked task rather than a silent spin.
    const limit = this.#opts.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    let finalState = out.state;
    let size = JSON.stringify(finalState ?? null).length;
    if (size > limit && this.#harness.shrink) {
      const smaller = await this.#harness.shrink(finalState, Math.floor(limit * 0.7));
      if (smaller) {
        finalState = smaller;
        size = JSON.stringify(finalState ?? null).length;
      }
    }
    if (size > limit) {
      await this.#store.appendEvent({
        tenantId, agentId: task.agentId, taskId,
        kind: "task.blocked",
        payload: { reason: "checkpoint_too_large", bytes: size, limit },
        // Once per generation, not once per attempt: without this the record of
        // being stuck becomes more work, which is more attempts, which is more
        // records.
        dedupKey: `blocked:${taskId}:${task.generation}:checkpoint_too_large`,
      });
      await this.#store.commitAdvance({
        tenantId, taskId, generation: task.generation, fencingToken: lease.fencingToken,
        expectedCheckpointVersion: task.checkpointVersion, checkpoint: task.checkpoint,
        stateVersion: task.stateVersion, status: "blocked", consumedThrough: null,
        waits: [], commands: [],
      });
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
      checkpoint: finalState,
      stateVersion: this.#harness.stateVersion,
      status: out.status,
      consumedThrough: events[events.length - 1]!.sequence,
      waits: out.waits,
      commands,
    });
    if (!res.ok) return { outcome: "rejected", reason: res.reason };

    // After the commit, never before it: a snapshot of state that was not
    // durably committed would be a starting point for a history that did not
    // happen. Failing to write one costs a longer rebuild, nothing more.
    const consumed = events[events.length - 1]!.sequence;
    const every = this.#opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    const prior = await this.#store.getSnapshot(tenantId, taskId);
    if (!prior || consumed - prior.throughSequence >= every) {
      try {
        await this.#store.putSnapshot(
          tenantId, taskId, consumed, finalState, this.#harness.stateVersion,
        );
        await this.#store.pruneSnapshots(
          tenantId, taskId, this.#opts.snapshotsKept ?? DEFAULT_SNAPSHOTS_KEPT,
        );
      } catch { /* a missing snapshot only makes rebuild slower */ }
    }

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
