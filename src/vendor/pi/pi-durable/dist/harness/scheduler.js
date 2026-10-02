/*
 * Vendored and modified by antiproton. Not the upstream file.
 *
 * upstream path: @earendil-works/pi-durable/dist/harness/scheduler.js
 * taken from:    @earendil-works/pi-durable 1.0.0 (npm), MIT, Copyright (c) 2025 Mario Zechner — see NOTICE
 * base sha256:   8f051549eb5b8729888fe90bd598e7a1782bd728501c7c08c0e61074233c2083
 * upstream issue: https://github.com/earendil-works/pi/issues/10325
 *
 * What changed (every change is marked "antiproton patch"):
 * - `#sleep` records the wake time on the invocation while its timer is pending, and calls the new
 *   scheduler option `onSleep({ taskId, conversationId, until })` once when the sleep starts.
 * - `inspect()` reports such a task as `{ kind: "running", sleepingUntil }` instead of `{ kind: "running" }`.
 * - A new `wake(taskIds)` ends the listed tasks' sleeps now: one in progress returns at once, and for a live task with
 *   no invocation yet (not started since open) the wake is kept and its first `#sleep` returns at once (kept until it
 *   is used or the task ends). A task whose invocation is running but not sleeping is not woken: a kept wake would
 *   end whatever sleep came next, such as a retry's backoff. `delay` takes a callback that is handed its early end,
 *   beside its abort.
 * - Relative imports of unchanged modules point into the installed package; the source map comment is dropped.
 *
 * Why: a Durable Object is billed while a harness sleeps in-process. Closing the harness mid-sleep is safe
 * (it resumes from the checkpoint), but 1.0.0 gives a host no way to know a task is only sleeping, so
 * src/runtime/durable-drive.ts inferred it from checkpoint phases. With this the scheduler says so itself.
 * `wake`: a sleep waits for a time, and what the task is waiting for (a model answer written by another process) can
 * arrive sooner; 1.0.0 gives a host no way to end the sleep, so the answer waited for the checkpoint's `pollAt`. Every
 * pi-durable sleep re-checks what it waited for when it ends (a poll fetches again and commits a new `pollAt` when not
 * ready), so a wake that came too early costs one extra check.
 *
 * test/pi-vendor.ts fails when the installed file's sha256 or the package version moves from the base above.
 */
import { copyJson } from "@earendil-works/chord";
import { awaitWithContext, withAbortSignal } from "@earendil-works/chord/context";
import { agentHooks } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/agent.js";
import { readContext } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/context.js";
import { closedError, scanAll, Waiters } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/util.js";
const SCAN_PAGE_SIZE = 256;
/** Longest delay `setTimeout` supports; longer sleeps wait in several steps. */
const MAX_TIMER_DELAY = 2_147_483_647;
const LIVE_STATUSES = ["pending", "running", "waiting", "completing"];
/**
 * Durable task scheduler of one Harness.
 *
 * `#live` mirrors every committed non-terminal task record: pending, running, waiting, and completing. The synchronous
 * commit listener updates it on the Session line, so code running on the line reads exactly the committed state from it.
 *
 * Tasks and conversations form one ownership tree (spec §5.5): a task's parent is its owner task, or its conversation;
 * a conversation's parent is its owner task, if any. Walks up that tree decide cascades, idle scopes, and whether a
 * task's ordinary owned work is live, which holds its outcome as `completing` and delays its abort handler.
 *
 * Invariant: every task transition is decided and written by one callback serialized on the Session line. That covers
 * reservation, marks, runtime commits, finalization, and the synchronous step before each phase, which applies the
 * precedence rules and writes a fault or handover. Handlers and joins run off the line. An invocation ends inside the
 * step that decides its end, so a runtime commit it queued either lands before that decision or is rejected.
 */
export class TaskScheduler {
    #session;
    #storage;
    #registry;
    #models;
    #agent;
    #settings;
    #env;
    #now;
    #report;
    #settleOutcome;
    #withdrawInputs;
    #conversation;
    #context;
    // antiproton patch: told when an invocation starts sleeping.
    #onSleep;
    // antiproton patch: wakes asked for a live task that was not sleeping; its next sleep returns at once.
    #wakes = new Set();
    #live = new Map();
    #invocations = new Map();
    #taskWaiters = new Waiters();
    /** Idle waiters by conversation; `undefined` waits for the whole Harness. */
    #idleWaiters = new Waiters();
    /** Definition whose migration failed per task; retried only once the registry resolves another definition. */
    #failedMigrations = new Map();
    /** Owner task of each loaded conversation, `null` when ownerless. */
    #edges = new Map();
    /** Tasks that own a loaded conversation; their nodes stay in `#settled` once terminal. */
    #conversationOwners = new Set();
    /** Ownership fields of terminal tasks that walks pass through. */
    #settled = new Map();
    /**
     * `failFast` waiters the next reconcile checks for a failed task in `on`: at open, when they start waiting, and when
     * one of their tasks fails.
     */
    #failFastChecks = new Set();
    #reconcileScheduled = false;
    #cascadePending = false;
    #unsubscribeRegistry = () => { };
    #enabled = false;
    #closing = false;
    #dirty = false;
    #draining = false;
    constructor(options) {
        this.#session = options.session;
        this.#storage = options.storage;
        this.#registry = options.registry;
        this.#models = options.models;
        this.#agent = options.agent;
        this.#settings = options.settings;
        this.#env = options.env;
        this.#now = options.now;
        this.#report = options.report;
        this.#settleOutcome = options.settleOutcome;
        this.#withdrawInputs = options.withdrawInputs;
        this.#conversation = options.conversation;
        this.#context = options.context;
        this.#onSleep = options.onSleep;
    }
    /** Load live tasks and change surviving `running` tasks back to `pending`. Dispatches nothing. */
    async open(context) {
        this.#session.subscribeCommits((publication) => this.#observe(publication));
        this.#session.subscribeClose(() => this.#seal());
        this.#unsubscribeRegistry = this.#registry.subscribe(() => this.#kick());
        await this.#session.commitWith(async (tx) => {
            // Every table read before the first write.
            const scans = [];
            for (const status of LIVE_STATUSES) {
                scans.push(await scanAll((cursor) => tx.scanTasks({ status }, SCAN_PAGE_SIZE, cursor)));
            }
            for (const records of scans) {
                for (const record of records) {
                    this.#live.set(record.id, record);
                    if (record.state.status === "running") {
                        tx.setTask(withState(record, { status: "pending", checkpoint: record.state.checkpoint }));
                    }
                    if (record.state.status === "waiting" && record.state.policy === "failFast") {
                        this.#failFastChecks.add(record.id);
                    }
                }
            }
        }, context);
        // Derive abort marks a crash left unapplied below cancelled owners, and finalize held outcomes.
        this.#cascadePending = true;
        this.#scheduleReconcile();
    }
    /** Enable scheduling. Idempotent; the kick does nothing once closing. */
    resume() {
        this.#enabled = true;
        this.#kick();
    }
    /**
     * antiproton patch: end the listed tasks' sleeps now. A task sleeping returns from `runtime.sleep` at once; a live
     * task with no invocation (not started yet) keeps the wake, and its first sleep returns at once. A task whose
     * invocation runs but does not sleep is left alone: its next sleep may be one the wake is not about (a retry's
     * backoff after the answer it was woken for). Ids of tasks that are not live are ignored. Writes nothing.
     */
    wake(taskIds) {
        if (this.#closing)
            return;
        for (const id of taskIds) {
            const invocation = this.#invocations.get(id);
            if (invocation?.endSleep !== undefined)
                invocation.endSleep();
            else if (invocation === undefined && this.#live.has(id))
                this.#wakes.add(id);
        }
    }
    /** Wait for every invocation signalled by `#seal()`. Writes nothing. */
    async join() {
        await Promise.allSettled([...this.#invocations.values()].map((invocation) => invocation.done));
    }
    /**
     * Commit the abort mark, or settle a task that no registered definition can take as `orphaned` when nothing it owns
     * is live, then join the run invocation seen on the line; the commit listener signalled it. The abort invocation
     * starts once the task's ordinary owned work is gone. A `completing` task is only marked.
     */
    async abort(id, context) {
        const marked = await this.#session.commitWith(async (tx) => {
            const current = await tx.task(id);
            if (current === undefined)
                throw new Error(`Task ${id} does not exist`);
            if (current.state.status === "terminal")
                return { result: "terminal" };
            const invocation = this.#invocations.get(id);
            if (invocation === undefined && current.state.status !== "completing") {
                await this.#loadScopes(false);
                if (!this.#ownedLive().has(id)) {
                    const resolution = this.#resolve(current, this.#registry.snapshot());
                    if (resolution.kind === "blocked") {
                        await this.#terminate(tx, current, { status: "orphaned", reason: resolution.reason });
                        return { result: "marked" };
                    }
                }
            }
            if (!current.abortRequested)
                tx.setTask({ ...current, abortRequested: true });
            return { result: "marked", run: invocation?.mode === "run" ? invocation : undefined };
        }, context);
        // The commit listener signalled the run; join it.
        if (marked.run !== undefined)
            await awaitWithContext(marked.run.done, context);
        return marked.result;
    }
    async waitForTask(id, context) {
        // Check and register on the line so no terminal publication falls between them.
        const found = await this.#session.readOnLine(async () => {
            if (this.#closing)
                throw closedError();
            if (this.#live.has(id))
                return { promise: this.#taskWaiters.add(id, context) };
            const record = await this.#storage.task(id, context);
            if (record === undefined)
                throw new Error(`Task ${id} does not exist`);
            return { promise: Promise.resolve(record) };
        });
        return found.promise;
    }
    /**
     * Resolve when ordinary traversal from the conversation, or from every ownerless conversation, reaches no live
     * non-background task.
     */
    waitForIdle(conversationId, context) {
        if (this.#closing)
            return Promise.reject(closedError());
        if (this.#idle(conversationId))
            return Promise.resolve();
        this.#scheduleReconcile();
        return this.#idleWaiters.add(conversationId, context);
    }
    /**
     * `Conversation.abort()`: in one commit, withdraw the queued inputs and mark every live non-background task that
     * ordinary traversal from the conversation reaches; resolves once the scope is idle. With `background`, traversal
     * crosses background boundaries, and the wait also covers every task it reached.
     */
    async abortConversation(conversationId, background, context) {
        const reached = await this.#session.commitWith(async (tx) => {
            const queued = await this.#loadScopes(true);
            const scope = { conversation: conversationId };
            const reached = [];
            for (const record of this.#live.values()) {
                if (record.background && !background)
                    continue;
                if (this.#inScope(parentOf(record), scope, background) !== true)
                    continue;
                reached.push(record.id);
                if (!record.abortRequested)
                    tx.setTask({ ...record, abortRequested: true });
            }
            for (const id of queued) {
                if (this.#inScope({ conversation: id }, scope, background) === true)
                    await this.#withdrawInputs(tx, id);
            }
            return reached;
        }, context);
        if (background)
            for (const id of reached)
                await this.waitForTask(id, context);
        await this.waitForIdle(conversationId, context);
    }
    // ─── Scheduling ────────────────────────────────────────────────────────
    #observe(publication) {
        const updated = [];
        const failed = [];
        let changed = false;
        for (const change of publication.changes) {
            if (change.type !== "task")
                continue;
            changed = true;
            const record = change.value;
            const previous = this.#live.get(record.id);
            if (failedOutcome(record) && (previous === undefined || !failedOutcome(previous)))
                failed.push(record.id);
            if (record.state.status === "terminal") {
                this.#live.delete(record.id);
                // antiproton patch: a wake kept for a task that ended is never used.
                this.#wakes.delete(record.id);
                this.#failedMigrations.delete(record.id);
                this.#failFastChecks.delete(record.id);
                if (this.#conversationOwners.has(record.id))
                    this.#settled.set(record.id, nodeOf(record));
                this.#taskWaiters.resolve(record.id, record);
                // Its owner may finalize now.
                this.#scheduleReconcile();
                continue;
            }
            if (record.abortRequested && previous?.abortRequested !== true) {
                this.#cascadePending = true;
                // Signal a run invocation of the newly marked task; its next step ends it.
                const invocation = this.#invocations.get(record.id);
                if (invocation?.mode === "run")
                    invocation.controller.abort();
            }
            const status = record.state.status;
            if (status === "completing" && previous?.state.status !== "completing") {
                if (cancellationIntent(record))
                    this.#cascadePending = true;
                this.#scheduleReconcile();
            }
            if (status === "waiting" && record.state.policy === "failFast" && previous?.state.status !== "waiting") {
                this.#failFastChecks.add(record.id);
                this.#scheduleReconcile();
            }
            this.#live.set(record.id, record);
            updated.push(record);
        }
        for (const id of failed) {
            for (const record of this.#live.values()) {
                const state = record.state;
                if (state.status === "waiting" && state.policy === "failFast" && state.on.includes(id)) {
                    this.#failFastChecks.add(record.id);
                    this.#scheduleReconcile();
                }
            }
        }
        for (const change of publication.changes) {
            if (change.type === "conversation" && !this.#edges.has(change.value.id)) {
                this.#setEdge(change.value.id, change.value.owner?.taskId ?? null);
            }
        }
        for (const change of publication.changes) {
            // A queued input below a cancelled owner is withdrawn, even after its cascade.
            if (change.type !== "submission" || change.value.status !== "queued" || change.value.type !== "input")
                continue;
            const up = { conversation: change.value.conversationId };
            if (!this.#chainKnown(up) || this.#belowCancelled(up))
                this.#cascadePending = true;
        }
        for (const record of updated) {
            // Work created below a cancelled owner, even after its cascade, is aborted too.
            if (!this.#chainKnown(parentOf(record)))
                this.#scheduleReconcile();
            else if (!record.background && !record.abortRequested && this.#belowCancelled(parentOf(record))) {
                this.#cascadePending = true;
            }
        }
        // Also retries, with the next commit of any kind, a cascade whose commit failed.
        if (this.#cascadePending)
            this.#scheduleReconcile();
        if (!changed)
            return;
        this.#resolveIdleWaiters();
        this.#kick();
    }
    #resolveIdleWaiters() {
        for (const conversationId of this.#idleWaiters.keys()) {
            if (this.#idle(conversationId))
                this.#idleWaiters.resolve(conversationId);
        }
    }
    // ─── Ownership ───────────────────────────────────────────────────────────
    #scheduleReconcile() {
        if (this.#reconcileScheduled || this.#closing)
            return;
        this.#reconcileScheduled = true;
        queueMicrotask(() => void this.#reconcile());
    }
    /**
     * One commit that applies what committed records imply: abort marks below live owners with cancellation intent
     * (spec §5.4), `failFast` marks (spec §5.5), withdrawn queued inputs below cancelled owners, and the final terminal
     * record of every `completing` task whose ordinary owned work is gone. The durable records are the intent, so this
     * also repairs whatever a crash left unapplied. Resolves idle waiters that the loaded edges decide.
     */
    async #reconcile() {
        this.#reconcileScheduled = false;
        const cascade = this.#cascadePending;
        this.#cascadePending = false;
        const checks = [...this.#failFastChecks];
        this.#failFastChecks.clear();
        try {
            await this.#session.commitWith(async (tx) => {
                if (this.#closing)
                    return;
                const queued = await this.#loadScopes(cascade);
                const marked = new Set();
                const mark = (record) => {
                    if (record.abortRequested || marked.has(record.id))
                        return;
                    marked.add(record.id);
                    tx.setTask({ ...record, abortRequested: true });
                };
                // Loading edges can reveal a cancelled owner, so marks are derived on every pass.
                for (const record of this.#live.values()) {
                    if (!record.background && this.#belowCancelled(parentOf(record)))
                        mark(record);
                }
                for (const id of checks) {
                    const waiter = this.#live.get(id);
                    if (waiter?.state.status !== "waiting" || !(await this.#anyFailed(waiter.state.on)))
                        continue;
                    // Every other live task: the failed one keeps its own outcome.
                    for (const member of waiter.state.on) {
                        const record = this.#live.get(member);
                        if (record !== undefined && !failedOutcome(record))
                            mark(record);
                    }
                }
                for (const id of queued)
                    if (this.#belowCancelled({ conversation: id }))
                        await this.#withdrawInputs(tx, id);
                await this.#finalize(tx);
            }, this.#context);
        }
        catch (error) {
            // Any pass may have staged marks, so a failed one is retried with the next commit.
            this.#cascadePending = true;
            for (const id of checks)
                this.#failFastChecks.add(id);
            if (!this.#closing)
                this.#report(error);
        }
        this.#resolveIdleWaiters();
    }
    /** Whether any of `ids` holds or ended with an outcome other than `completed`. */
    async #anyFailed(ids) {
        for (const id of ids) {
            const record = this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
            if (record !== undefined && failedOutcome(record))
                return true;
        }
        return false;
    }
    /**
     * Write the terminal record of every `completing` task without live ordinary owned work. Finalizing one can free its
     * owner, so this repeats over the commit's candidates until nothing changes. A held scheduler outcome gets its
     * Harness cleanup here.
     */
    async #finalize(tx) {
        for (;;) {
            const overlay = overlayOf(tx);
            const owned = this.#ownedLive(overlay);
            const done = [...this.#liveRecords(overlay)].filter((record) => record.state.status === "completing" && !owned.has(record.id));
            if (done.length === 0)
                return;
            for (const record of done) {
                const outcome = record.state.outcome;
                tx.setTask(withState(record, { status: "terminal", outcome }));
                // REMINDER: only the scheduler writes `faulted` and `orphaned` (spec §5.4); their cleanup waits for this commit.
                if (outcome.status === "faulted" || outcome.status === "orphaned") {
                    await this.#settleOutcome(tx, record, outcome);
                }
            }
        }
    }
    /**
     * Load the owner chains of every live task and, with `queued`, of every conversation with queued submissions, on the
     * Session line; returns the latter. Reads committed Storage directly, so it may run inside a commit callback.
     */
    async #loadScopes(queued) {
        for (const record of [...this.#live.values()]) {
            if (!this.#chainKnown(parentOf(record)))
                await this.#loadChain(parentOf(record));
        }
        if (!queued)
            return [];
        const submissions = await scanAll((cursor) => this.#storage.scanSubmissions({ status: "queued" }, SCAN_PAGE_SIZE, cursor, this.#context));
        const conversations = [...new Set(submissions.map((submission) => submission.conversationId))];
        for (const id of conversations)
            await this.#loadChain({ conversation: id });
        return conversations;
    }
    /** Load the owner edges and task nodes from `start` up to its ownerless root. */
    async #loadChain(start, overlay) {
        let at = start;
        while (at !== undefined) {
            if ("task" in at) {
                let node = this.#node(at.task, overlay);
                if (node === undefined) {
                    const record = await this.#storage.task(at.task, this.#context);
                    if (record === undefined)
                        return;
                    node = nodeOf(record);
                    if (record.state.status === "terminal")
                        this.#settled.set(record.id, node);
                }
                at = parentOf(node);
            }
            else {
                let edge = this.#edge(at.conversation, overlay);
                if (edge === undefined) {
                    const record = await this.#storage.conversation(at.conversation, this.#context);
                    edge = record?.owner?.taskId ?? null;
                    this.#setEdge(at.conversation, edge);
                }
                at = edge === null ? undefined : { task: edge };
            }
        }
    }
    #setEdge(conversationId, owner) {
        this.#edges.set(conversationId, owner);
        if (owner !== null)
            this.#conversationOwners.add(owner);
    }
    /** Owner task of a conversation, `null` when ownerless, `undefined` while not loaded. */
    #edge(id, overlay) {
        return overlay?.edges.has(id) === true ? overlay.edges.get(id) : this.#edges.get(id);
    }
    #node(id, overlay) {
        return overlay?.tasks.get(id) ?? this.#live.get(id) ?? this.#settled.get(id);
    }
    /** Walk up from `start`: owner tasks and conversations, ending at an ownerless root or an edge not loaded yet. */
    *#above(start, overlay) {
        let at = start;
        while (at !== undefined) {
            if ("task" in at) {
                const node = this.#node(at.task, overlay);
                if (node === undefined) {
                    yield { unknown: true };
                    return;
                }
                yield { task: at.task, node };
                at = parentOf(node);
            }
            else {
                yield { conversation: at.conversation };
                const edge = this.#edge(at.conversation, overlay);
                if (edge === undefined) {
                    yield { unknown: true };
                    return;
                }
                at = edge === null ? undefined : { task: edge };
            }
        }
    }
    /** Whether every owner above `start` is loaded. */
    #chainKnown(start, overlay) {
        for (const step of this.#above(start, overlay))
            if ("unknown" in step)
                return false;
        return true;
    }
    /** Live records, with the overlay's candidates replacing committed ones; terminal candidates are gone. */
    *#liveRecords(overlay) {
        for (const record of this.#live.values()) {
            const candidate = overlay?.tasks.get(record.id) ?? record;
            if (candidate.state.status !== "terminal")
                yield candidate;
        }
        if (overlay === undefined)
            return;
        for (const record of overlay.tasks.values()) {
            if (!this.#live.has(record.id) && record.state.status !== "terminal")
                yield record;
        }
    }
    /**
     * Every task with live ordinary owned work (spec §5.5), mapped to that work: each live non-background task counts for
     * every owner task above it up to and including the first background one. Owner chains must be loaded.
     */
    #ownedLive(overlay) {
        const owned = new Map();
        for (const record of this.#liveRecords(overlay)) {
            if (record.background)
                continue;
            for (const step of this.#above(parentOf(record), overlay)) {
                if ("unknown" in step)
                    break;
                if (!("task" in step))
                    continue;
                const below = owned.get(step.task);
                if (below === undefined)
                    owned.set(step.task, [record.id]);
                else
                    below.push(record.id);
                if (step.node.background)
                    break;
            }
        }
        return owned;
    }
    /**
     * Whether ordinary traversal from `scope` reaches `start`: walking up reaches the scope's conversation, or an
     * ownerless one for `roots`, without crossing a background owner, unless `crossBackground`. `undefined` while an
     * edge is not loaded.
     */
    #inScope(start, scope, crossBackground = false) {
        for (const step of this.#above(start)) {
            if ("unknown" in step)
                return undefined;
            if ("conversation" in step) {
                if ("conversation" in scope && step.conversation === scope.conversation)
                    return true;
            }
            else if (step.node.background && !crossBackground) {
                return false;
            }
        }
        return "roots" in scope;
    }
    /**
     * Whether a live owner's cancellation intent reaches `start`: walking up finds an owner with intent before a
     * background owner without it. Terminal owners never cascade (spec §5.4).
     */
    #belowCancelled(start) {
        for (const step of this.#above(start)) {
            if ("unknown" in step)
                return false;
            if (!("task" in step))
                continue;
            const live = this.#live.get(step.task);
            if (live !== undefined && cancellationIntent(live))
                return true;
            if (step.node.background)
                return false;
        }
        return false;
    }
    /** Close listener: runs synchronously once admission is sealed, before `join()`. */
    #seal() {
        this.#closing = true;
        this.#unsubscribeRegistry();
        const error = closedError();
        this.#taskWaiters.rejectAll(error);
        this.#idleWaiters.rejectAll(error);
        for (const invocation of this.#invocations.values())
            invocation.controller.abort();
    }
    #kick() {
        this.#dirty = true;
        if (this.#draining || !this.#enabled || this.#closing)
            return;
        this.#draining = true;
        // Never commit synchronously from a commit or registry listener.
        queueMicrotask(() => void this.#drain());
    }
    async #drain() {
        try {
            while (this.#dirty && this.#enabled && !this.#closing) {
                this.#dirty = false;
                for (const reservation of await this.#reserve())
                    this.#start(reservation);
            }
        }
        catch (error) {
            if (!this.#closing)
                this.#report(error);
        }
        finally {
            this.#draining = false;
            // A wakeup that arrived during a failed pass still needs its pass.
            if (this.#dirty)
                this.#kick();
        }
    }
    /** Reserve every eligible task in one commit; orphan abort-marked tasks no definition can take. */
    async #reserve() {
        const reservations = [];
        try {
            await this.#session.commitWith(async (tx) => {
                if (!this.#enabled || this.#closing)
                    return;
                await this.#loadScopes(false);
                const owned = this.#ownedLive();
                // Taken once per pass, and only when some task is a candidate.
                let snapshot;
                for (const record of [...this.#live.values()]) {
                    if (this.#invocations.has(record.id) || this.#waitingOn(record, owned).length > 0)
                        continue;
                    if (record.state.status === "completing")
                        continue;
                    const runnable = record;
                    const mode = record.abortRequested ? "abort" : "run";
                    snapshot ??= this.#registry.snapshot();
                    const resolution = this.#resolve(runnable, snapshot);
                    if (resolution.kind === "blocked") {
                        if (mode === "abort") {
                            await this.#terminate(tx, record, { status: "orphaned", reason: resolution.reason });
                        }
                        continue;
                    }
                    if (resolution.record !== runnable || record.state.status !== "running") {
                        tx.setTask(withState(resolution.record, {
                            status: "running",
                            checkpoint: resolution.record.state.checkpoint,
                        }));
                    }
                    // Registered on the line, so marks and later reservations see it and close joins it.
                    const invocation = this.#createInvocation(record, mode);
                    reservations.push({ invocation, task: resolution.task, snapshot });
                }
            }, this.#context);
        }
        catch (error) {
            for (const { invocation } of reservations) {
                this.#invocations.delete(invocation.taskId);
                invocation.finish();
            }
            throw error;
        }
        return reservations;
    }
    /**
     * Live tasks a task waits for before its next invocation: its live ordinary owned work when abort-marked, since
     * abort runs bottom-up, otherwise the live part of the `on` of a wait.
     */
    #waitingOn(record, owned) {
        if (record.abortRequested)
            return owned.get(record.id) ?? [];
        if (record.state.status !== "waiting")
            return [];
        return record.state.on.filter((id) => this.#live.has(id));
    }
    /** Resolve the record's definition by kind, migrating an older stored version. */
    #resolve(record, snapshot) {
        const fit = this.#fit(record, snapshot.task(record.kind));
        if ("reason" in fit)
            return { kind: "blocked", reason: fit.reason };
        if (!fit.migrates)
            return { kind: "ready", task: fit.task, record };
        const definition = erased(fit.task);
        try {
            if (definition.migrate === undefined)
                throw missingMigration(record, definition);
            const migrated = definition.migrate(record.input, record.state.checkpoint, record.version);
            const state = { ...record.state, checkpoint: copyJson(migrated.checkpoint) };
            const migratedRecord = { ...record, version: definition.version, input: copyJson(migrated.input), state };
            return { kind: "ready", task: fit.task, record: migratedRecord };
        }
        catch (error) {
            this.#failedMigrations.set(record.id, { task: fit.task, error });
            this.#report(error);
            return { kind: "blocked", reason: "migration_failed" };
        }
    }
    #fit(record, task) {
        if (task === undefined)
            return { reason: "missing_task" };
        const version = task.definition.version;
        if (version === record.version)
            return { task, migrates: false };
        if (version < record.version)
            return { reason: "task_too_old" };
        const failed = this.#failedMigrations.get(record.id);
        if (failed?.task === task)
            return { reason: "migration_failed", error: failed.error };
        return { task, migrates: true };
    }
    /**
     * Scheduling state and every live task with its derived state, read on the Session line. Runs no task code: a
     * pending migration shows as `ready` with `migrates`, and only a migration the scheduler already tried, or one that
     * cannot exist, shows as failed.
     */
    async inspect(snapshot) {
        await this.#loadScopes(false);
        const owned = this.#ownedLive();
        const tasks = [];
        for (const record of this.#live.values()) {
            tasks.push({ record, state: this.#inspectTask(record, snapshot, owned) });
        }
        const scheduling = this.#closing ? "closing" : this.#enabled ? "running" : "paused";
        return { scheduling, tasks };
    }
    #inspectTask(record, snapshot, owned) {
        // antiproton patch: a running invocation inside `runtime.sleep` says until when.
        const invocation = this.#invocations.get(record.id);
        if (invocation !== undefined)
            return invocation.sleepingUntil === undefined ? { kind: "running" } : { kind: "running", sleepingUntil: invocation.sleepingUntil };
        if (record.state.status === "completing")
            return { kind: "completing" };
        const on = this.#waitingOn(record, owned);
        if (on.length > 0)
            return { kind: "waiting", on };
        const fit = this.#fit(record, snapshot.task(record.kind));
        if ("reason" in fit)
            return { kind: "blocked", ...fit };
        if (fit.migrates && fit.task.definition.migrate === undefined) {
            return { kind: "blocked", reason: "migration_failed", error: missingMigration(record, erased(fit.task)) };
        }
        return { kind: "ready", migrates: fit.migrates };
    }
    #createInvocation(record, mode) {
        const controller = new AbortController();
        const { promise: done, resolve: finish } = Promise.withResolvers();
        const invocation = {
            taskId: record.id,
            conversationId: record.conversationId,
            mode,
            controller,
            context: withAbortSignal(controller.signal, this.#context),
            watches: new Set(),
            ended: false,
            done,
            finish: () => finish(),
        };
        this.#invocations.set(record.id, invocation);
        return invocation;
    }
    #start(reservation) {
        const invocation = reservation.invocation;
        void (async () => {
            try {
                if (invocation.mode === "run")
                    await this.#run(reservation);
                else
                    await this.#runAbort(reservation);
            }
            catch (error) {
                this.#report(error);
            }
            finally {
                this.#end(invocation);
                invocation.finish();
                this.#kick();
            }
        })();
    }
    /** Run phase handlers, each preceded by a step that decides on the line whether the invocation continues. */
    async #run(reservation) {
        const invocation = reservation.invocation;
        const state = { task: reservation.task, snapshot: reservation.snapshot, reported: undefined };
        const phase = { snapshot: () => state.snapshot, task: () => state.task, agent: undefined };
        const runtime = this.#runtime(invocation, phase);
        let previous;
        for (;;) {
            const current = await this.#step(invocation, (tx, current) => this.#decide(tx, current, previous, state));
            // Close may seal between the decision and dispatch.
            if (current === undefined || this.#closing)
                return;
            const checkpoint = current.state.checkpoint;
            // Each phase handler resolves its agent afresh, at first use.
            phase.agent = undefined;
            try {
                await erased(state.task).phases[checkpoint.phase](current, runtime, invocation.context);
                previous = { checkpoint };
            }
            catch (error) {
                previous = { checkpoint, failure: { error } };
            }
        }
    }
    /**
     * Precedence rules for a run invocation, on the line. Rules 1 (terminal, `completing`, or `waiting`) and 2 (closing)
     * are applied by `#step`. Returns whether the invocation continues with the next phase.
     */
    #decide(tx, current, previous, state) {
        // 3. abort mark: end; a fresh abort invocation starts once the task's ordinary owned work is gone.
        if (current.abortRequested)
            return false;
        if (previous === undefined)
            return true;
        // 4. uncaught error.
        if (previous.failure !== undefined)
            return { fault: previous.failure.error };
        // 6. no durable progress.
        if (jsonEqual(current.state.checkpoint, previous.checkpoint)) {
            const message = `Task ${current.kind} phase ${previous.checkpoint.phase} returned without durable progress`;
            return { fault: new Error(message) };
        }
        // 5. progress: refresh the snapshot; hand over to a replacement definition that can take the task.
        state.snapshot = this.#registry.snapshot();
        const next = state.snapshot.task(current.kind);
        if (next !== state.task) {
            if (next !== undefined && canReserve(next, current)) {
                tx.setTask(withState(current, { status: "pending", checkpoint: current.state.checkpoint }));
                return false;
            }
            if (state.reported === undefined || state.reported.task !== next) {
                state.reported = { task: next };
                const cause = next === undefined ? "missing_task" : "incompatible_task";
                this.#report(new Error(`Task ${current.id} keeps running under its old ${current.kind} definition`, { cause }));
            }
        }
        return true;
    }
    /** Run the abort handler once; rules 1, 2, and 4 apply, and returning without an outcome faults. */
    async #runAbort(reservation) {
        const invocation = reservation.invocation;
        const current = this.#live.get(invocation.taskId);
        if (current === undefined || this.#closing)
            return;
        let failure;
        try {
            const phase = { snapshot: () => reservation.snapshot, task: () => reservation.task, agent: undefined };
            const runtime = this.#runtime(invocation, phase);
            await erased(reservation.task).abort(current, runtime, invocation.context);
        }
        catch (error) {
            failure = { error };
        }
        const message = `Abort handler of task ${invocation.taskId} returned without a terminal outcome`;
        await this.#step(invocation, () => ({ fault: failure?.error ?? new Error(message) }));
    }
    /**
     * One synchronous decision on the Session line. A task that is no longer running (rule 1: terminal, `completing`, or
     * `waiting`) or a closing Harness (rule 2) ends the invocation without a write; otherwise `decide` may stage a write
     * and returns whether the invocation continues. Ending happens inside the callback, before a fault's Harness
     * cleanup. A rejected step, such as admission after close, also ends the invocation.
     */
    async #step(invocation, decide) {
        try {
            return await this.#session.commitWith(async (tx) => {
                const found = this.#live.get(invocation.taskId);
                const current = found?.state.status === "running" ? found : undefined;
                const decision = current !== undefined && !this.#closing ? decide(tx, current) : false;
                if (decision === true)
                    return current;
                this.#end(invocation);
                if (decision !== false) {
                    const message = decision.fault instanceof Error ? decision.fault.message : String(decision.fault);
                    await this.#terminate(tx, current, { status: "faulted", error: { message } });
                }
                return undefined;
            }, this.#context);
        }
        catch (error) {
            this.#end(invocation);
            if (!this.#closing)
                this.#report(error);
            return undefined;
        }
    }
    /**
     * Write an outcome the scheduler decided. While the task's ordinary owned work is live it holds as `completing` and
     * its Harness cleanup waits for the final commit (spec §5.5, rule 4); otherwise it is terminal with its cleanup.
     */
    async #terminate(tx, record, outcome) {
        await this.#loadScopes(false);
        if (this.#ownedLive(overlayOf(tx)).has(record.id)) {
            tx.setTask(withState(record, { status: "completing", outcome }));
            return;
        }
        tx.setTask(withState(record, { status: "terminal", outcome }));
        await this.#settleOutcome(tx, record, outcome);
    }
    /**
     * Replace a running task's state with what it committed. A terminal state holds as `completing` while ordinary owned
     * work is live, judged on the commit's candidates, so work the same commit creates below the task counts. A wait is
     * validated first.
     */
    async #commitState(tx, invocation, current, next) {
        if (next.status === "waiting")
            await this.#validateWait(tx, invocation, current, next.on, next.policy);
        if (next.status === "terminal") {
            const overlay = overlayOf(tx);
            await this.#loadScopes(false);
            for (const record of overlay.tasks.values())
                await this.#loadChain(parentOf(record), overlay);
            if (this.#ownedLive(overlay).has(current.id)) {
                tx.setTask(withState(current, { status: "completing", outcome: next.outcome }));
                return;
            }
        }
        tx.setTask(withState(current, next));
    }
    /**
     * A wait names existing tasks other than the waiter and its owners, which could never finish first; `failFast` only
     * tasks the waiter owns. An abort handler cannot wait.
     */
    async #validateWait(tx, invocation, current, on, policy) {
        if (invocation.mode === "abort")
            throw new Error(`Abort handler of task ${current.id} cannot wait`);
        const overlay = overlayOf(tx);
        await this.#loadChain(parentOf(current));
        const owners = new Set();
        for (const step of this.#above(parentOf(current)))
            if ("task" in step)
                owners.add(step.task);
        for (const id of on) {
            if (id === current.id || owners.has(id)) {
                throw new Error(`Task ${current.id} cannot wait on itself or its owner ${id}`);
            }
            const member = overlay.tasks.get(id) ?? this.#live.get(id) ?? (await this.#storage.task(id, this.#context));
            if (member === undefined)
                throw new Error(`Task ${id} does not exist`);
            if (policy === "failFast" && member.owner !== current.id) {
                throw new Error(`Task ${current.id} can wait failFast only on tasks it owns; ${id} is not one`);
            }
        }
    }
    /** End an invocation: its runtime operations reject from now on, its signal aborts, its watches stop, and its task is free. */
    #end(invocation) {
        if (invocation.ended)
            return;
        invocation.ended = true;
        if (this.#invocations.get(invocation.taskId) === invocation)
            this.#invocations.delete(invocation.taskId);
        for (const watch of invocation.watches)
            void watch.stop();
        // Pending waits bound to the invocation, such as a tool's waitForTask(), reject with it.
        invocation.controller.abort(endedError(invocation));
    }
    /** No live non-background task in the scope; a task whose owner edges are not loaded yet counts as inside. */
    #idle(conversationId) {
        const scope = conversationId === undefined ? { roots: true } : { conversation: conversationId };
        for (const record of this.#live.values()) {
            if (!record.background && this.#inScope(parentOf(record), scope) !== false)
                return false;
        }
        return true;
    }
    // ─── Invocation runtime ──────────────────────────────────────────────────
    #runtime(invocation, phase) {
        // Resolved at most once per phase handler, at first use, with the invocation's context; fixed for the phase.
        const agent = () => {
            if (invocation.ended)
                return Promise.reject(endedError(invocation));
            if (phase.agent === undefined) {
                phase.agent = this.#agent(invocation.conversationId, phase.snapshot(), invocation.context);
                // A caller that stops waiting must not leave the shared resolution's failure unobserved.
                phase.agent.catch(() => { });
            }
            return phase.agent;
        };
        const hooks = {
            each: async (name, invoke) => {
                for (const handlers of agentHooks(await agent(), phase.task().definition.name)) {
                    const handler = handlers[name];
                    if (typeof handler !== "function")
                        continue;
                    try {
                        await invoke(handler.bind(handlers));
                    }
                    catch (error) {
                        if (invocation.controller.signal.aborted)
                            throw error;
                        this.#report(error);
                    }
                }
            },
        };
        const settings = this.#settings;
        return {
            taskId: invocation.taskId,
            conversationId: invocation.conversationId,
            signal: invocation.controller.signal,
            models: this.#models,
            agent: (context) => invocation.ended ? Promise.reject(endedError(invocation)) : awaitWithContext(agent(), context),
            get settings() {
                return settings();
            },
            env: (context) => this.#read(invocation, () => this.#env(invocation.conversationId, context)),
            hooks: hooks,
            get registry() {
                return phase.snapshot();
            },
            commit: (change, context) => this.#gated(invocation, async (tx, current) => {
                const next = await change(tx, current);
                if (next !== undefined)
                    await this.#commitState(tx, invocation, current, next);
            }, context),
            memo: ((name, ...rest) => {
                if (rest.length === 1) {
                    return this.#read(invocation, async () => memoOf(this.#live.get(invocation.taskId), name));
                }
                const candidate = rest[0];
                return this.#gated(invocation, (tx, current) => {
                    const winner = memoOf(current, name);
                    if (winner !== undefined)
                        return winner;
                    tx.setTask({ ...current, memos: { ...current.memos, [name]: candidate } });
                    return candidate;
                }, rest[1]);
            }),
            sleep: (until, context) => this.#sleep(invocation, until, context),
            watchDoc: ((...args) => this.#watchDoc(invocation, args)),
            snapshot: ((...args) => this.#read(invocation, () => sessionMethod(this.#session, "snapshot")(...args))),
            snapshotAsOf: ((...args) => this.#read(invocation, () => sessionMethod(this.#session, "snapshotAsOf")(...args))),
            getTask: ((id, context) => this.#read(invocation, () => this.#session.readOnLine(() => this.#storage.task(id, context)))),
            waitForTask: ((id, context) => this.#read(invocation, () => this.waitForTask(id, withAbortSignal(invocation.controller.signal, context)))),
            outcomes: ((ids, context) => this.#read(invocation, () => this.#session.readOnLine(async () => {
                const outcomes = [];
                for (const id of ids) {
                    const state = (await this.#storage.task(id, context))?.state;
                    if (state?.status !== "terminal")
                        throw new Error(`Task ${id} is not terminal`);
                    outcomes.push(state.outcome);
                }
                return outcomes;
            }))),
            conversation: (id, context) => this.#read(invocation, () => this.#conversation(id, {
                signal: invocation.controller.signal,
                check: () => {
                    if (invocation.ended)
                        throw endedError(invocation);
                },
            }, context)),
            entry: ((...args) => {
                const [token, id, context] = args.length === 2
                    ? [undefined, args[0], args[1]]
                    : [args[0], args[1], args[2]];
                return this.#read(invocation, async () => {
                    const found = await this.#session.readOnLine(() => this.#storage.entry(invocation.conversationId, id, context));
                    const entry = found?.entry;
                    return token === undefined || entry?.kind === token.kind ? entry : undefined;
                });
            }),
            context: (conversationId, context, at) => this.#read(invocation, () => readContext(this.#session, this.#storage, conversationId, context, at)),
            now: () => {
                if (invocation.ended)
                    throw endedError(invocation);
                return this.#now();
            },
            report: (error) => {
                if (invocation.ended)
                    throw endedError(invocation);
                this.#report(error);
            },
        };
    }
    /** Run a committed-state read unless the invocation has ended. */
    async #read(invocation, read) {
        if (invocation.ended)
            throw endedError(invocation);
        return read();
    }
    /** Commit after rereading the task on the line and gating the invocation. */
    #gated(invocation, change, context) {
        if (invocation.ended)
            return Promise.reject(endedError(invocation));
        return this.#session.commitWith(async (tx) => {
            if (invocation.ended)
                throw endedError(invocation);
            if (this.#closing)
                throw closedError();
            const found = this.#live.get(invocation.taskId);
            if (found === undefined)
                throw new Error(`Task ${invocation.taskId} is terminal`);
            if (found.state.status !== "running")
                throw new Error(`Task ${invocation.taskId} is ${found.state.status}`);
            const current = found;
            if (invocation.mode === "run" && current.abortRequested) {
                throw new Error(`Task ${invocation.taskId} has a durable abort mark`);
            }
            return change(tx, current);
        }, context, { conversationId: invocation.conversationId, taskId: invocation.taskId });
    }
    /** Wait until the Harness clock reaches `until`, rechecking it after every timer. */
    async #sleep(invocation, until, context) {
        if (invocation.ended)
            throw endedError(invocation);
        const signals = [invocation.controller.signal];
        if (context.abortSignal !== undefined)
            signals.push(context.abortSignal);
        const signal = AbortSignal.any(signals);
        // antiproton patch: while the timer below is pending the invocation runs no code, so inspect() reports
        // `sleepingUntil` and the host is told once; a host may close the Harness then and reopen it at `until`.
        // A wake (`wake`) ends the sleep early: a kept one before it starts, `endSleep` while it waits.
        try {
            for (;;) {
                signal.throwIfAborted();
                if (this.#wakes.delete(invocation.taskId))
                    return;
                const remaining = until - this.#now();
                if (remaining <= 0)
                    return;
                if (invocation.sleepingUntil !== until) {
                    invocation.sleepingUntil = until;
                    try {
                        this.#onSleep?.({ taskId: invocation.taskId, conversationId: invocation.conversationId, until });
                    }
                    catch (error) {
                        this.#report(error);
                    }
                }
                let woken = false;
                await delay(Math.min(remaining, MAX_TIMER_DELAY), signal, (end) => {
                    invocation.endSleep = () => {
                        woken = true;
                        end();
                    };
                });
                invocation.endSleep = undefined;
                if (woken)
                    return;
            }
        }
        finally {
            invocation.sleepingUntil = undefined;
            invocation.endSleep = undefined;
        }
    }
    async #watchDoc(invocation, args) {
        if (invocation.ended)
            throw endedError(invocation);
        const watch = (await sessionMethod(this.#session, "watchDoc")(...args));
        if (watch === undefined)
            return undefined;
        if (invocation.ended) {
            void watch.stop();
            throw endedError(invocation);
        }
        invocation.watches.add(watch);
        void watch.closed.then(() => invocation.watches.delete(watch));
        return watch;
    }
}
/** A live owner's durable cancellation intent: its abort mark, or a held outcome other than `completed`. */
function cancellationIntent(record) {
    return record.state.status !== "terminal" && (record.abortRequested || failedOutcome(record));
}
/** Whether the record holds or ends with an outcome other than `completed`. */
function failedOutcome(record) {
    const state = record.state;
    return (state.status === "completing" || state.status === "terminal") && state.outcome.status !== "completed";
}
function parentOf(node) {
    return node.owner !== undefined ? { task: node.owner } : { conversation: node.conversationId };
}
function nodeOf(record) {
    return {
        conversationId: record.conversationId,
        ...(record.owner === undefined ? {} : { owner: record.owner }),
        background: record.background,
    };
}
function overlayOf(tx) {
    const tasks = new Map(tx.stagedTasks().map((record) => [record.id, record]));
    const edges = new Map(tx.stagedConversations().map((record) => [record.id, record.owner?.taskId ?? null]));
    return { tasks, edges };
}
/** Own memo entry only; memo names such as `toString` must not resolve to inherited properties. */
function memoOf(record, name) {
    const memos = record?.memos;
    return memos !== undefined && Object.hasOwn(memos, name) ? memos[name] : undefined;
}
/** Overloaded Session method bound for forwarding an argument list unchanged. */
function sessionMethod(session, name) {
    return session[name].bind(session);
}
function missingMigration(record, definition) {
    return new Error(`Task ${record.kind} version ${definition.version} has no migration from ${record.version}`);
}
function erased(task) {
    return task.definition;
}
function endedError(invocation) {
    return new Error(`Task ${invocation.taskId} invocation has ended`);
}
/** Replace a live record's state; memos disappear once an outcome is decided. */
function withState(record, state) {
    if (state.status !== "terminal" && state.status !== "completing")
        return { ...record, state };
    const { memos: _memos, ...rest } = record;
    return { ...rest, state };
}
/** Whether a definition can take the task at reservation: same version, or newer with a migration. */
function canReserve(task, record) {
    const definition = task.definition;
    return (definition.version === record.version || (definition.version > record.version && definition.migrate !== undefined));
}
// antiproton patch: `onEnd` is handed a function that ends the delay early, beside its abort.
function delay(ms, signal, onEnd) {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const end = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
        };
        const timer = setTimeout(end, ms);
        signal.addEventListener("abort", onAbort, { once: true });
        onEnd?.(end);
    });
}
/** Structural equality of two JSON values; object key order is ignored. */
function jsonEqual(left, right) {
    if (left === right)
        return true;
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
        return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
            return false;
        return left.every((value, index) => jsonEqual(value, right[index]));
    }
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length)
        return false;
    return keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}
