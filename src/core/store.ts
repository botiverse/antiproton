import type {
  AdvanceTxn,
  CommitResult,
  Json,
  ApprovalRecord,
  Lease,
  ModelBinding,
  OperationRecord,
  OperationStatus,
  RuntimeEvent,
  MountPolicy,
  MountRecord,
  TaskRecord,
  WaitSpec,
} from "./types.ts";

/**
 * The seam the plan (§7.1 / §15 risk #1) requires: the Runtime's transactional
 * path must be swappable, and a backend that does not pass the contract in
 * test/spec/kernel-spec.ts is not a candidate, whatever else it offers.
 *
 * Two implementations keep the seam honest: SqliteStore in Node and
 * DurableObjectStore at the edge.
 */
export interface StorageAdapter {
  readonly name: string;
  init(): Promise<void>;
  close(): Promise<void>;

  createAgent(tenantId: string, agentId: string, config?: Json): Promise<void>;
  /**
   * Snapshots and the raw task log.
   *
   * `advance` is deterministic and events are append-only, so harness state is
   * a fold of the log: `state = fold(advance, snapshot, events after it)`. That
   * makes the checkpoint a cache rather than the truth, which is what lets
   * compaction be a lossy *view* instead of a destructive edit — the history it
   * hides is still in the log, so a task can be rebuilt, rewound or forked, and
   * an audit still has everything that happened.
   */
  putSnapshot(
    tenantId: string, taskId: string, throughSequence: number, state: Json, stateVersion: number,
  ): Promise<void>;
  /**
   * Keep the oldest snapshot and the newest `keep`, drop the rest.
   *
   * Snapshots exist to bound rebuild cost, not to be a second history — the
   * log is the history. Keeping every one is quadratic in a long task, because
   * each holds the whole conversation and they are written at a fixed cadence.
   * The oldest is kept so a full rewind never has to start from nothing.
   */
  pruneSnapshots(tenantId: string, taskId: string, keep: number): Promise<number>;

  /** The newest snapshot at or before `atOrBefore`. */
  getSnapshot(
    tenantId: string, taskId: string, atOrBefore?: number,
  ): Promise<{ throughSequence: number; state: Json; stateVersion: number } | null>;
  /** Raw log for one task in (after, through], independent of any cursor. */
  taskEvents(
    tenantId: string, taskId: string, after?: number, through?: number,
  ): Promise<RuntimeEvent[]>;

  createTask(
    tenantId: string, agentId: string, taskId: string, checkpoint: Json, stateVersion?: number,
  ): Promise<void>;
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

  /** Scoped by tenant: a worker draining one tenant's task must never dispatch
   *  another tenant's commands, and per-tenant scoping is what makes fair
   *  scheduling possible later (§12.1). */
  claimOutbox(limit: number, tenantId?: string): Promise<Array<{ commandId: string; taskId: string; kind: string; payload: Json }>>;
  markDispatched(commandId: string): Promise<void>;

  recordOperation(op: Omit<OperationRecord, "status" | "resultRef">): Promise<void>;
  getOperation(tenantId: string, operationId: string): Promise<OperationRecord | null>;
  completeOperation(
    tenantId: string,
    operationId: string,
    status: OperationStatus,
    resultRef: string | null,
    /** Carried on the wakeup event. An operation that finished long after the
     *  execution that started it still has to deliver what it produced. */
    result?: Json,
  ): Promise<void>;

  /** Registers a wait, resolving it immediately if the operation already finished. */
  registerWait(
    tenantId: string,
    taskId: string,
    generation: number,
    wait: WaitSpec,
  ): Promise<"registered" | "already_satisfied">;

  interrupt(tenantId: string, taskId: string): Promise<number>;

  /**
   * Per-mount session state: what a plugin derives from a credential and needs
   * again next call — an access token, a session cookie, a cursor.
   *
   * Not the credential itself (that stays behind secret_ref) and never visible
   * to the model. Any integration whose auth is an exchange rather than a
   * static header needs somewhere to put the result; without it every call has
   * to re-authenticate, or the token ends up in the agent's context, which is
   * exactly what config-time binding exists to prevent.
   */
  /**
   * Atomic check-and-charge against a tenant's budget.
   *
   * A runaway loop costs real money and, in a shared service, starves everyone
   * else — so this has to be durable (it survives a restart), atomic (two
   * workers cannot both spend the last of it) and enforced at a choke point
   * rather than trusted to callers.
   *
   * A tenant with no row of its own falls back to the row for "*", so a
   * deployment sets one account-wide default instead of remembering to
   * provision every tenant. No "*" row and no tenant row means unlimited,
   * which is a deployment choice and is reported by `usage`.
   */
  consumeQuota(
    tenantId: string,
    resource: string,
    amount: number,
  ): Promise<{ allowed: boolean; used: number; limit: number | null }>;

  /** Configure a budget. `limit: null` removes it. `windowMs: null` is a lifetime cap. */
  setQuota(
    tenantId: string,
    resource: string,
    limit: number | null,
    windowMs?: number | null,
  ): Promise<void>;

  usage(tenantId: string): Promise<
    Array<{ resource: string; used: number; limit: number | null; windowStart: number }>
  >;

  getConnection(tenantId: string, agentId: string, alias: string): Promise<Json | null>;
  putConnection(
    tenantId: string,
    agentId: string,
    alias: string,
    state: Json,
    expiresAt?: number | null,
  ): Promise<void>;

  /**
   * Whose model account this agent spends. A tenant with no binding cannot run:
   * refusing is the only safe default, because the alternative is every tenant
   * quietly spending the operator's own key.
   */
  setModelBinding(b: ModelBinding): Promise<void>;
  /** Agent override first, then the tenant default, then null. */
  getModelBinding(tenantId: string, agentId: string): Promise<ModelBinding | null>;

  /** Hold a call for a human. The request is stored verbatim: an approver has
   *  to be able to see exactly what they are approving. */
  requireApproval(
    a: Omit<ApprovalRecord, "state" | "approver" | "decidedAt" | "createdAt">,
  ): Promise<void>;
  getApproval(tenantId: string, operationId: string): Promise<ApprovalRecord | null>;
  /** Decide once. A second decision is refused rather than applied, so an
   *  approval cannot be replayed into a second execution. */
  decideApproval(
    tenantId: string, operationId: string, decision: "approved" | "denied", approver: string,
  ): Promise<{ ok: true; record: ApprovalRecord } | { ok: false; reason: "not_found" | "already_decided" }>;
  listApprovals(
    tenantId: string, state?: "pending" | "approved" | "denied",
  ): Promise<ApprovalRecord[]>;

  addMount(m: MountRecord): Promise<void>;
  /**
   * Change a mount's policy after it exists.
   *
   * Needed because provisioning is not atomic: a run that created the mount and
   * then failed to set its policy left a permanently permissive mount, and an
   * "already exists" guard cemented it. Configuration has to be reconcilable,
   * not just creatable.
   */
  updateMountPolicy(
    tenantId: string, agentId: string, alias: string, policy: MountPolicy | null,
  ): Promise<boolean>;
  getMountByAlias(tenantId: string, agentId: string, alias: string): Promise<MountRecord | null>;
  findMountsByPlugin(tenantId: string, agentId: string, plugin: string): Promise<MountRecord[]>;
  listMounts(tenantId: string, agentId: string): Promise<MountRecord[]>;
}
