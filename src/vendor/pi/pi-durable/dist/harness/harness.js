/*
 * Vendored and modified by antiproton. Not the upstream file.
 *
 * upstream path: @earendil-works/pi-durable/dist/harness/harness.js
 * taken from:    @earendil-works/pi-durable 1.0.0 (npm), MIT, Copyright (c) 2025 Mario Zechner — see NOTICE
 * base sha256:   5456223287ef144f656aeab73c4ba2933dc5baa5dd8010f9d617c697d5b6bd0e
 * upstream issue: https://github.com/earendil-works/pi/issues/10325
 *
 * What changed (marked "antiproton patch"):
 * - Passes `HarnessOptions.onSleep` to the scheduler, and imports the vendored ./scheduler.js
 *   (see its header for the change and why).
 * - Imports the vendored ./compaction.js (`createCompaction`, a manual compaction) and ./registry.js
 *   (`BUILTIN_TASKS`), whose compaction task can poll a deferred summary (see ./compaction.js), and `open`
 *   refuses a registry whose built-in task of a name is not that one: the package's `createRegistry()` makes such
 *   a registry. Import `createRegistry` from ./registry.js.
 * - Relative imports of unchanged modules point into the installed package; the source map comment is dropped.
 *
 * Only here so the patched scheduler is the one a Harness runs: the package's own harness.js imports its
 * own scheduler.js. Redirecting that import instead would need a loader in every node entry point and an
 * alias in every wrangler config, and one missed would run the unpatched file silently. So our code imports
 * `Harness` from this file (types: ./harness.d.ts); `@earendil-works/pi-durable`'s `Harness` is the unpatched one.
 *
 * test/pi-vendor.ts fails when the installed file's sha256 or the package version moves from the base above.
 */
import { withAbortSignal, withoutAbortSignal } from "@earendil-works/chord/context";
import { ResetEntry } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/entries.js";
import { SessionImpl } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/session/session.js";
import { ROOT_CONVERSATION_ID } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/types.js";
import { AgentDoc, configure, createAgent, resolveAgent, resolveSettings } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/agent.js";
// antiproton patch: the vendored compaction (a `poll` phase for a deferred summary) and the registry holding it.
import { createCompaction } from "./compaction.js";
import { readContext } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/context.js";
import { InboxDoc, withdrawQueuedInputs } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/inbox.js";
import { LiveDoc, settleSchedulerOutcome } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/live.js";
import { BUILTIN_TASKS } from "./registry.js";
import { TaskScheduler } from "./scheduler.js";
import { Submissions } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/submissions.js";
import { TaskGraphView } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/task-graph.js";
import { addUsageState, UsageDoc } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/usage.js";
import { scanAll } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/util.js";
import { ConversationViews } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/view.js";
const SCAN_PAGE_SIZE = 256;
class ConversationImpl {
    id;
    #host;
    constructor(id, host) {
        this.id = id;
        this.#host = host;
    }
    agent(context) {
        return this.#host.harness.resolveAgent(this.id, undefined, context);
    }
    configure(change, context) {
        return this.#host.harness.commitWith((tx) => configure(tx, this.id, change), context);
    }
    submit(submission, context) {
        return this.#host.submissions.submit(this.id, submission, context);
    }
    compact(instructions, context) {
        this.#host.tasks.resume();
        const input = { reason: "manual", ...(instructions === undefined ? {} : { instructions }) };
        return this.#host.harness.commitWith((tx) => createCompaction(tx, this.id, input), context);
    }
    async reset(handoff, context) {
        const model = handoff === undefined
            ? {}
            : { model: [{ role: "user", content: handoff, timestamp: this.#host.now() }] };
        const entry = { kind: ResetEntry.kind, head: "self", ...model };
        await this.#host.submissions.submit(this.id, { type: "write", entry }, context);
    }
    commit(change, context) {
        return this.#host.harness.commitWith(change, context, { conversationId: this.id });
    }
    context(context) {
        return readContext(this.#host.harness, this.#host.storage, this.id, context);
    }
    entries(query, limit, cursor, context) {
        const bounded = {
            conversationId: this.id,
            ...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
            ...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
        };
        return this.#host.harness.readOnLine(() => this.#host.storage.scanEntries(bounded, limit, cursor, context));
    }
    fork(at, options, context) {
        return this.#host.create({ kind: "fork", parentId: this.id, at, ownership: options.ownership }, options, context);
    }
    abort(context, options) {
        this.#host.tasks.resume();
        return this.#host.tasks.abortConversation(this.id, options?.background === true, context);
    }
    waitForIdle(context) {
        this.#host.tasks.resume();
        return this.#host.tasks.waitForIdle(this.id, context);
    }
    viewState(context) {
        return this.#host.views.state(this.id, context);
    }
    watch(context) {
        return this.#host.views.watch(this.id, context);
    }
}
/** Session kernel extended with conversation handles and a registry. */
class HarnessImpl extends SessionImpl {
    #storage;
    #options;
    #report;
    #host;
    #tasks;
    #submissions;
    #taskGraph;
    #closed = false;
    constructor(storage, options, context) {
        super(storage);
        this.#storage = storage;
        this.#options = options;
        this.#report = options.onReport ?? (() => { });
        const now = options.now ?? Date.now;
        const settings = () => resolveSettings(options.settings);
        this.#tasks = new TaskScheduler({
            session: this,
            storage,
            registry: options.registry,
            models: options.models,
            agent: (id, snapshot, callContext) => this.resolveAgent(id, snapshot, callContext),
            settings,
            env: (id, callContext) => this.buildEnv(id, callContext),
            now,
            report: this.#report,
            settleOutcome: settleSchedulerOutcome,
            withdrawInputs: withdrawQueuedInputs,
            conversation: async (id, binding, callContext) => {
                const record = await this.readOnLine(() => storage.conversation(id, callContext));
                return record === undefined ? undefined : boundConversation(id, binding, this.#submissions, this.#tasks);
            },
            context: withoutAbortSignal(context),
            // antiproton patch: the host's sleep notice (HarnessOptions.onSleep).
            onSleep: options.onSleep,
        });
        this.#submissions = new Submissions(this, storage, now, settings, () => this.#tasks.resume());
        this.#taskGraph = new TaskGraphView(this, storage);
        this.#host = {
            harness: this,
            storage,
            tasks: this.#tasks,
            submissions: this.#submissions,
            views: new ConversationViews(this, storage),
            now,
            create: (target, createOptions, context) => this.#create(target, createOptions, context),
        };
    }
    /** Resolve a conversation's committed `pi.agent` against `snapshot`, or the current one, and the current settings. */
    async resolveAgent(id, snapshot, context) {
        const registry = snapshot ?? this.#options.registry.snapshot();
        const state = await this.snapshot(AgentDoc, id, context);
        return resolveAgent(state, registry, resolveSettings(this.#options.settings), this.#report);
    }
    /** Build a conversation's environment from its current `cwd`; `undefined` without an `env` option. */
    async buildEnv(id, context) {
        const build = this.#options.env;
        if (build === undefined)
            return undefined;
        const cwd = (await this.snapshot(AgentDoc, id, context))?.cwd;
        return build({ conversationId: id, ...(cwd === undefined ? {} : { cwd }), read: this }, context);
    }
    /** Reconcile surviving `running` tasks to `pending`; part of open. */
    openTasks(context) {
        return this.#tasks.open(context);
    }
    resume() {
        this.#assertOpen();
        this.#tasks.resume();
    }
    getTask(id, context) {
        return this.readOnLine(() => this.#storage.task(id, context));
    }
    inspect(context) {
        return this.readOnLine(async () => {
            const { scheduling, tasks } = await this.#tasks.inspect(this.#options.registry.snapshot());
            const scan = (status) => scanAll((cursor) => this.#storage.scanSubmissions({ status }, SCAN_PAGE_SIZE, cursor, context));
            const submissions = [...(await scan("queued")), ...(await scan("placed"))].sort((a, b) => a.id - b.id);
            return { scheduling, tasks, submissions };
        });
    }
    submission(id, context) {
        return this.#submissions.get(id, context);
    }
    abortSubmission(id, context, conversationId) {
        return this.#submissions.abort(id, context, conversationId);
    }
    abortTask(id, context) {
        return this.#tasks.abort(id, context);
    }
    waitForTask(id, context) {
        this.#tasks.resume();
        return this.#tasks.waitForTask(id, context);
    }
    waitForIdle(context) {
        this.#tasks.resume();
        return this.#tasks.waitForIdle(undefined, context);
    }
    /** Sum every conversation's committed `pi.usage`. Each document is read at its own point; totals only grow. */
    async usage(context) {
        const conversations = await this.readOnLine(() => scanAll((cursor) => this.#storage.scanConversations({}, SCAN_PAGE_SIZE, cursor, context)));
        const total = UsageDoc.definition.initial();
        for (const { id } of conversations) {
            const state = await this.snapshot(UsageDoc, id, context);
            if (state !== undefined)
                addUsageState(total, state);
        }
        return total;
    }
    taskGraph(context) {
        return this.#taskGraph.state(context);
    }
    watchTaskGraph(context) {
        return this.#taskGraph.watch(context);
    }
    root(context, options) {
        return this.#create({ kind: "root" }, options ?? {}, context);
    }
    async conversation(id, context) {
        this.#assertOpen();
        const record = await this.readOnLine(() => this.#storage.conversation(id, context));
        return record === undefined ? undefined : new ConversationImpl(record.id, this.#host);
    }
    createConversation(options, context) {
        return this.#create({ kind: "independent", ownership: options.ownership }, options, context);
    }
    close(context) {
        this.#closed = true;
        return super.close(context);
    }
    /** Join task invocations after admission is sealed and before Storage closes; writes no task outcome. */
    beforeClose() {
        return this.#tasks.join();
    }
    async #create(target, options, context) {
        this.#assertOpen();
        const id = await this.commitWith(async (tx) => {
            if (target.kind === "root" && (await tx.conversation(ROOT_CONVERSATION_ID)) !== undefined) {
                return ROOT_CONVERSATION_ID;
            }
            const record = target.kind === "root"
                ? await tx.createRootConversation()
                : target.kind === "fork"
                    ? await tx.forkConversation(target.parentId, target.at, { ownership: target.ownership })
                    : await tx.createConversation({ ownership: target.ownership });
            if (options.agent !== undefined)
                await configure(tx, record.id, options.agent);
            if (options.init !== undefined)
                await options.init(tx, record.id);
            return record.id;
        }, context);
        return new ConversationImpl(id, this.#host);
    }
    /**
     * The built-in creation hook, in every commit that creates or forks a conversation: empty `pi.live`, `pi.inbox`, and
     * `pi.usage`, the conversation's `pi.agent` (see `createAgent()`), then `HarnessOptions.conversationCreated`.
     */
    async conversationCreated(tx, record) {
        await tx.doc(LiveDoc, record.id);
        await tx.doc(InboxDoc, record.id);
        await tx.doc(UsageDoc, record.id);
        await createAgent(tx, record);
        await this.#options.conversationCreated?.(tx, record);
    }
    #assertOpen() {
        if (this.#closed)
            throw new Error("Harness is closed");
    }
}
/**
 * Invocation-bound handle for tasks and tools. Every operation, and every operation of a submission it returns, first
 * checks the invocation and runs under its signal, so it rejects once the invocation ends; admitted work stays durable.
 */
function boundConversation(id, binding, submissions, tasks) {
    const bind = (context) => withAbortSignal(binding.signal, context);
    const bound = (operation) => {
        return async (context) => {
            binding.check();
            return operation(bind(context));
        };
    };
    return {
        id,
        submit: async (draft, context) => {
            binding.check();
            const submission = await submissions.submit(id, draft, bind(context));
            return {
                id: submission.id,
                status: bound((callContext) => submission.status(callContext)),
                wait: bound((callContext) => submission.wait(callContext)),
                abort: bound((callContext) => submission.abort(callContext)),
            };
        },
        abort: async (context, options) => {
            binding.check();
            return tasks.abortConversation(id, options?.background === true, bind(context));
        },
        waitForIdle: bound((callContext) => tasks.waitForIdle(id, callContext)),
    };
}
export const Harness = {
    /** Open a Harness over storage. The registry may keep changing while the Harness runs. */
    async open(storage, options, context) {
        context.abortSignal?.throwIfAborted();
        const snapshot = options.registry.snapshot();
        // antiproton patch: the built-in task must be this file's, not only one of the same name: a registry made by
        // the package's createRegistry() holds the package's compaction, which cannot summarize on a deferred-only
        // provider, and would run in its place silently. The error names the vendored registry.
        const missing = BUILTIN_TASKS.filter((task) => snapshot.task(task.definition.name) !== task);
        if (missing.length > 0) {
            const names = missing.map((task) => task.definition.name).join(", ");
            throw new Error(`Registry lacks built-in tasks ${names}; create it with createRegistry() of src/vendor/pi/pi-durable/dist/harness/registry.js`);
        }
        const harness = new HarnessImpl(storage, options, context);
        try {
            await harness.openTasks(context);
        }
        catch (error) {
            // The caller's context may be what failed open: close without it, and rethrow the open error.
            await harness
                .close(withoutAbortSignal(context))
                .catch((closeError) => options.onReport?.(closeError));
            throw error;
        }
        return harness;
    },
};
