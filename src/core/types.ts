// Runtime domain types. Deliberately storage-agnostic: every field that the
// conformance suite exercises has to survive a swap of StorageAdapter.

export type Json = unknown;

export type TaskStatus =
  | "runnable"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "blocked"
  | "failed"; // added vs the plan: permanent failure needs a terminal state

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface RuntimeEvent {
  eventId: string;
  tenantId: string;
  agentId: string;
  taskId: string | null;
  threadId: string | null;
  sequence: number;
  kind: string;
  payload: Json;
  dedupKey: string | null;
  createdAt: number;
}

export interface Lease {
  tenantId: string;
  taskId: string;
  holder: string;
  fencingToken: number;
  expiresAt: number;
}

export interface TaskRecord {
  tenantId: string;
  agentId: string;
  taskId: string;
  status: TaskStatus;
  generation: number;
  checkpointVersion: number;
  fencingToken: number;
  checkpoint: Json;
}

export interface WaitSpec {
  kind: "operation" | "message" | "timer";
  operationId?: string;
  deadline?: number;
}

export interface OutboxCommand {
  commandId: string;
  kind: string;
  payload: Json;
}

/** Everything a single advance commits atomically. */
export interface AdvanceTxn {
  tenantId: string;
  taskId: string;
  generation: number;
  fencingToken: number;
  expectedCheckpointVersion: number;
  checkpoint: Json;
  status: TaskStatus;
  consumedThrough: number | null;
  waits: WaitSpec[];
  commands: OutboxCommand[];
}

export type CommitResult =
  | { ok: true; checkpointVersion: number }
  | {
      ok: false;
      reason: "fenced" | "stale_generation" | "version_conflict" | "no_task";
    };

export interface OperationRecord {
  operationId: string;
  tenantId: string;
  agentId: string;
  taskId: string; // ownership fields the plan's §7.2 model was missing
  mountAlias: string;
  tool: string;
  toolVersion: string;
  status: OperationStatus;
  resultRef: string | null;
}

/**
 * Which provider, which model, and whose key.
 *
 * Per tenant, with an optional per-agent override. The credential is a
 * reference resolved server-side exactly as a mount's is: the binding that
 * leaves the store never carries it, so it cannot reach a prompt, a
 * checkpoint or a trajectory by accident.
 */
export interface ModelBinding {
  tenantId: string;
  /** null is the tenant's default; a row with an agentId overrides it. */
  agentId: string | null;
  provider: string;
  model: string;
  baseUrl: string;
  secretRef: string;
}

/** Config-time binding. The agent addresses `alias`, never a connection id. */
export interface MountRecord {
  tenantId: string;
  agentId: string;
  alias: string;
  plugin: string;
  installationId: string;
  connectionId: string | null;
  toolVersion: string;
  publicConfig: Record<string, Json>;
  secretRef: string | null;
}
