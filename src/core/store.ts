import type {
  AdvanceTxn,
  CommitResult,
  Json,
  Lease,
  OperationRecord,
  OperationStatus,
  RuntimeEvent,
  TaskRecord,
  WaitSpec,
} from "./types.ts";

/**
 * The seam the plan (§7.1 / §15 risk #1) requires: business state may live in
 * db9, but the Runtime's transactional path must be swappable. Any backend that
 * passes test/conformance.ts is a candidate.
 */
export interface StorageAdapter {
  readonly name: string;
  init(): Promise<void>;
  close(): Promise<void>;

  createAgent(tenantId: string, agentId: string, config?: Json): Promise<void>;
  createTask(tenantId: string, agentId: string, taskId: string, checkpoint: Json): Promise<void>;
  loadTask(tenantId: string, taskId: string): Promise<TaskRecord | null>;

  /** Returns inserted=false when dedupKey was already seen (§14 重复消息). */
  appendEvent(e: {
    tenantId: string;
    agentId: string;
    taskId?: string | null;
    threadId?: string | null;
    kind: string;
    payload: Json;
    dedupKey?: string | null;
  }): Promise<{ inserted: boolean; sequence: number; eventId: string }>;

  pendingEvents(tenantId: string, taskId: string, consumer: string): Promise<RuntimeEvent[]>;

  acquireLease(tenantId: string, taskId: string, holder: string, ttlMs: number): Promise<Lease | null>;

  /** Atomic: checkpoint + cursor + waits + outbox, guarded by fencing/generation/version. */
  commitAdvance(txn: AdvanceTxn): Promise<CommitResult>;

  /** Transactional park: refuses to release while unconsumed work exists (lost wakeup). */
  releaseIfNoWork(
    tenantId: string,
    taskId: string,
    fencingToken: number,
    consumer: string,
  ): Promise<"released" | "has_work" | "fenced">;

  claimOutbox(limit: number): Promise<Array<{ commandId: string; taskId: string; kind: string; payload: Json }>>;
  markDispatched(commandId: string): Promise<void>;

  recordOperation(op: Omit<OperationRecord, "status" | "resultRef">): Promise<void>;
  getOperation(tenantId: string, operationId: string): Promise<OperationRecord | null>;
  completeOperation(
    tenantId: string,
    operationId: string,
    status: OperationStatus,
    resultRef: string | null,
  ): Promise<void>;

  /** Registers a wait, resolving it immediately if the operation already finished. */
  registerWait(
    tenantId: string,
    taskId: string,
    generation: number,
    wait: WaitSpec,
  ): Promise<"registered" | "already_satisfied">;

  interrupt(tenantId: string, taskId: string): Promise<number>;
}
