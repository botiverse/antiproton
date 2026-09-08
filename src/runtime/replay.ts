import type { StorageAdapter } from "../core/store.ts";
import type { Json } from "../core/types.ts";
import type { HarnessAdapter } from "./kernel.ts";

/**
 * Rebuild harness state from the log.
 *
 * `advance` is deterministic and events are append-only, so state is a fold:
 * `state = fold(advance, snapshot, events after it)`. The checkpoint is
 * therefore a cache, not the truth.
 *
 * That distinction is what makes compaction safe. A harness that compacts is
 * editing its own working view; the events it dropped are still in the log, so
 * the full history can still be reconstructed — which is what an audit needs,
 * and what "rewind this agent to before it did that" needs.
 *
 * Commands are discarded here. Replay reconstructs what the agent knew, and
 * must never re-emit what it did.
 */
export interface Rebuilt {
  state: Json;
  /** The sequence the rebuilt state accounts for. */
  throughSequence: number;
  /** Events folded on top of the snapshot; 0 means the snapshot was exact. */
  replayed: number;
  fromSnapshot: number;
}

export async function rebuildState(
  store: StorageAdapter,
  harness: HarnessAdapter,
  tenantId: string,
  taskId: string,
  through: number = Number.MAX_SAFE_INTEGER,
): Promise<Rebuilt> {
  const snap = await store.getSnapshot(tenantId, taskId, through);
  if (!snap) throw new Error(`no snapshot for ${tenantId}/${taskId}; cannot rebuild`);

  let state = snap.stateVersion !== 0 && snap.stateVersion !== harness.stateVersion
    ? await harness.migrate(snap.state, snap.stateVersion)
    : snap.state;

  const events = await store.taskEvents(tenantId, taskId, snap.throughSequence, through);
  // One event at a time: an advance that consumed a batch and one that consumed
  // them singly must agree, and folding singly is the stricter of the two.
  let last = snap.throughSequence;
  for (const e of events) {
    const out = await harness.advance({
      state,
      events: [e],
      context: { tenantId, agentId: e.agentId, taskId, generation: 0 },
    });
    state = out.state;
    last = e.sequence;
  }
  return { state, throughSequence: last, replayed: events.length, fromSnapshot: snap.throughSequence };
}
