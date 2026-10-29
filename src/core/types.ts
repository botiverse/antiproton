// Runtime domain types. Deliberately storage-agnostic: every field that the
// conformance suite exercises has to survive a swap of StorageAdapter.

import type { ToolSnapshot } from "../plugins/types.ts";

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
  | "unknown"
  /** Refused before it ran — by policy — so nothing landed and nothing will. An end, not a failure. */
  | "rejected";

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
  /** Which harness schema wrote this checkpoint. Distinct from
   *  checkpointVersion, which is optimistic-concurrency, not schema. */
  stateVersion: number;
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
  /** The harness schema this checkpoint is written in. */
  stateVersion: number;
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
  /**
   * The name the model was offered this tool under and called it by, exactly as it appeared in its tool list (a
   * collision tie-break's suffix included): recorded at dispatch, because nothing after it can tell which of two
   * clashing tools got the suffix: the gateway looks the tool a call resolved to up in the turn's offered list
   * (`InvokeOpts.offered`). Null when that list does not hold it (no model named the call, or the tool was not offered
   * this turn) and on a row from before it was recorded. `tool` is the dispatch address (`<plugin>.<tool>`), which no model sees.
   */
  modelName: string | null;
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

/**
 * What a mount is allowed to do without a human.
 *
 * Evaluated at the gateway, the same choke point that holds credentials, so a
 * policy cannot be bypassed by any harness or any sandbox. `approval` does not
 * block a thread: the call is recorded and the model is told it is held, because
 * in a service the approver may take hours and nothing should be holding a
 * process for them. The decision, or the hold's expiry, reaches the agent later
 * as a notice (cf/src/runtime.ts `#tellApprovals`).
 */
export type PolicyDecision = "allow" | "deny" | "approval";

export interface MountPolicy {
  /** Applied to tools declaring `sideEffects: "read"`. Default allow. */
  read?: PolicyDecision;
  /** Applied to tools declaring `sideEffects: "write"`. Default allow. */
  write?: PolicyDecision;
  /** Per-tool override, by bare tool name. Beats the side-effect default. */
  tools?: Record<string, PolicyDecision>;
}

/** A call held back pending a human decision. */
export interface ApprovalRecord {
  tenantId: string;
  operationId: string;
  agentId: string;
  taskId: string;
  mountAlias: string;
  tool: string;
  /** Exactly what was asked for — this is what an approver is approving. */
  request: Json;
  state: ApprovalState;
  approver: string | null;
  decidedAt: number | null;
  createdAt: number;
  /**
   * When an undecided hold is denied as `expired` (src/runtime/gateway.ts `expireApproval`). Null only on a row the
   * gateway was told to keep open (a TTL of 0); every pending row from before the column existed was given its
   * creation plus the default TTL when the column was added (src/store/approvals-schema.ts).
   */
  expiresAt: number | null;
  /** Who decided, as the deciding path said it: Raft's server-side checked user, a console sign-in, or the expiry. */
  decidedBy: DecidedBy | null;
  /**
   * What an approved call's run came to, once it ended (`executed` or `failed`): a summary of its result or error, at
   * most NOTICE_RESULT_MAX characters (src/runtime/approval-notice.ts), as the tool gave it. Not redacted here: a reader
   * that shows it to anyone but the agent redacts it (cf/src/approvals.ts). Null before the run ends.
   */
  outcome: { summary: string } | null;
  /** When an approved call's run was claimed (`StorageAdapter.claimApprovalRun`); null before, and for other states. */
  runAt: number | null;
}

/**
 * Where a held call stands. `approved` is a decision whose run has not ended yet; the run ends it as `executed` or
 * `failed`. `expired` is its own end, not a `denied`: nobody refused it, nobody decided in time, and the agent is told
 * exactly that.
 */
export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

/**
 * Who decided a held call. `raft` is what Raft's server said after its own identity check (docs/raft-approvals.md):
 * antiproton records it and does not re-check it, since the caller is the provider token.
 */
export type DecidedBy =
  | { via: "raft"; raftUserId: string; role: "agent_owner" | "server_owner" | "server_admin" }
  | { via: "console"; approver: string }
  | { via: "expiry" };

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
  /** Absent means allow everything, which is the only sane default for a
   *  mount the operator has just deliberately created — except the tools its
   *  plugin's `defaultPolicy` names (`policyFor`). */
  policy?: MountPolicy | null;
  /** What a remote server listed for this mount; see `ToolSnapshot`. Absent
   *  for every plugin whose tools are its own. */
  toolSnapshot?: ToolSnapshot | null;
}
