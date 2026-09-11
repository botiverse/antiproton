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

/** A stored value: inline when small, a reference to object storage when not. */
export interface StateEntry {
  value: Json | null;
  ref: string | null;
  bytes: number;
}

/**
 * The seam the plan (§7.1 / §15 risk #1) requires: the Runtime's transactional
 * path must be swappable, and a backend that does not pass the contract in
 * the storage conformance suite is not a candidate, whatever else it offers.
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

  /**
   * The agent's own store, per (tenant, agent), outliving any one task.
   *
   * A long-running agent that cannot write anything down has to re-derive
   * everything it learned on every task, and it knows it: asked to keep a note,
   * it says it has nowhere to keep one. Values are JSON; a text document is a
   * JSON string, so there is one type rather than two. Anything too large to
   * sit in a row is spilled to object storage by the caller and referenced
   * here, which is the same split the tool-result offload already makes.
   */
  putState(
    tenantId: string, agentId: string, key: string, entry: StateEntry,
  ): Promise<void>;
  /** The cheap, additive write. A journal the agent has to read, edit and
   *  rewrite to add a line is a journal it will stop writing. */
  appendState(
    tenantId: string, agentId: string, key: string, text: string, maxBytes: number,
  ): Promise<{ bytes: number; truncated: boolean }>;
  getState(
    tenantId: string, agentId: string, key: string,
  ): Promise<(StateEntry & { updatedAt: number }) | null>;
  deleteState(tenantId: string, agentId: string, key: string): Promise<boolean>;
  listState(
    tenantId: string, agentId: string, prefix?: string, limit?: number,
  ): Promise<Array<{ key: string; bytes: number; ref: string | null; updatedAt: number }>>;
  stateUsage(tenantId: string, agentId: string): Promise<{ keys: number; bytes: number }>;

  /**
   * A message the person wants delivered only once the agent has finished.
   *
   * Deliberately not an event yet. An event in this log means something
   * happened to the conversation, and a follow-up has not happened until it is
   * delivered — writing it early would make it visible to the harness, which is
   * exactly what "wait until the work is done" excludes. It is durable here and
   * moves into the log on completion.
   *
   * The default remains steering: a message typed while the agent works reaches
   * the model before its next call, without stopping the tool call in flight.
   */
  /**
   * Make a task runnable again because something new arrived for it.
   *
   * Was implemented on the Durable Object alone, which held until a follow-up
   * message needed delivering through the same path on both backends. A seam
   * one backend satisfies is not a seam.
   *
   * `completed` and `blocked` reopen; `failed` is permanent. `waiting` reopens
   * only when nothing is outstanding — no unanswered command, no pending
   * decision — so a genuine approval gate cannot be stepped around by typing,
   * while a task stranded by a reply that will never come can still be rescued.
   */
  reopenTask(tenantId: string, taskId: string): Promise<boolean>;

  queueFollowUp(tenantId: string, agentId: string, taskId: string, text: string): Promise<void>;
  /** Move any waiting follow-ups into the log, oldest first. Returns how many. */
  flushFollowUps(tenantId: string, agentId: string, taskId: string): Promise<number>;

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
  /**
   * Config drifts the same way policy does, and more quietly. A `web` mount
   * created before `maxBytes` was lowered kept the old 48 KB for ever, which is
   * above the offload threshold — so every page the agent fetched was parked to
   * storage and came back as a reference it could not use. Creation-only
   * reconciliation cements whatever the first deploy happened to write.
   */
  /** The version a mount pins; the console reconciles it to the registry's. */
  updateMountToolVersion(tenantId: string, agentId: string, alias: string, toolVersion: string): Promise<boolean>;
  updateMountConfig(
    tenantId: string, agentId: string, alias: string, publicConfig: Json,
  ): Promise<boolean>;
  getMountByAlias(tenantId: string, agentId: string, alias: string): Promise<MountRecord | null>;
  /** Point a mount at a different reference, or at none. The value is never here. */
  setMountSecretRef(tenantId: string, agentId: string, alias: string, secretRef: string | null): Promise<boolean>;

  // ---- per-agent secrets, sealed. The store holds ciphertext and metadata; it
  // never sees a value and keeps nothing derived from one.
  putSecret(tenantId: string, agentId: string, name: string, sealed: {
    ciphertext: string; iv: string; account?: string | null; verified?: boolean;
  }): Promise<void>;
  getSecret(tenantId: string, agentId: string, name: string): Promise<{ ciphertext: string; iv: string } | null>;
  secretMeta(tenantId: string, agentId: string, name: string): Promise<{
    account: string | null; verified: boolean;
    createdAt: number; updatedAt: number; lastUsedAt: number | null;
  } | null>;
  touchSecret(tenantId: string, agentId: string, name: string, at: number): Promise<void>;
  removeSecret(tenantId: string, agentId: string, name: string): Promise<boolean>;
  findMountsByPlugin(tenantId: string, agentId: string, plugin: string): Promise<MountRecord[]>;
  listMounts(tenantId: string, agentId: string): Promise<MountRecord[]>;
}
