/*
 * Vendored and modified by antiproton. Not the upstream file.
 *
 * upstream path: @earendil-works/pi-durable/dist/harness/registry.js
 * taken from:    @earendil-works/pi-durable 1.0.0 (npm), MIT, Copyright (c) 2025 Mario Zechner — see NOTICE
 * base sha256:   9731cc15ae463c29021f460e3503d9adf9a4303e7d82859d7547c99c5f1311fe
 * upstream issue: none yet (see ./compaction.js)
 *
 * What changed (marked "antiproton patch"):
 * - `BUILTIN_TASKS` holds the vendored ./compaction.js's `CompactionTask` (see its header for the change and why).
 * - Relative imports of unchanged modules point into the installed package; the source map comment is dropped.
 *
 * Only here so the patched compaction is the one a registry holds: the scheduler runs a task record with the
 * definition the registry holds by its kind, and the package's registry.js imports its own compaction.js. So our
 * code imports `createRegistry` from this file (types: ./registry.d.ts), and ./harness.js imports `BUILTIN_TASKS`
 * from it; `@earendil-works/pi-durable`'s `createRegistry` is the unpatched one.
 *
 * test/pi-vendor.ts fails when the installed file's sha256 or the package version moves from the base above.
 */
import { INSTRUCTIONS_KEY } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/agent.js";
// antiproton patch: the vendored compaction task, with its `poll` phase.
import { CompactionTask } from "./compaction.js";
import { GenerationTask } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/generation.js";
import { ToolTask } from "../../../../../../node_modules/@earendil-works/pi-durable/dist/harness/tool.js";
const SECTION_KEY = /^[a-z][a-z0-9_-]*$/;
/** Built-in task definitions every registry holds; they are not an extension and cannot be removed or replaced. */
export const BUILTIN_TASKS = [GenerationTask, ToolTask, CompactionTask];
/** Immutable published registry state. */
class RegistryState {
    #extensions;
    #byName;
    #tasks;
    constructor(extensions) {
        this.#extensions = extensions;
        this.#byName = new Map(extensions.map((extension) => [extension.name, extension]));
        const tasks = new Map();
        for (const task of BUILTIN_TASKS)
            tasks.set(task.definition.name, task);
        for (const extension of extensions) {
            for (const task of extension.tasks ?? []) {
                const name = task.definition.name;
                if (tasks.has(name))
                    throw new Error(`Task ${name} of extension ${extension.name} is already installed`);
                tasks.set(name, task);
            }
        }
        this.#tasks = tasks;
    }
    installed() {
        return this.#extensions;
    }
    extension(name) {
        return this.#byName.get(name);
    }
    tools() {
        return this.#extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => ({ extension, tool })));
    }
    sections() {
        return this.#extensions.flatMap((extension) => (extension.sections ?? []).map((section) => ({ extension, section })));
    }
    tasks() {
        return [...this.#tasks.values()];
    }
    task(name) {
        return this.#tasks.get(name);
    }
}
class RegistryImpl {
    #current = new RegistryState([]);
    #listeners = new Set();
    snapshot() {
        return this.#current;
    }
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    install(extension) {
        validateExtension(extension);
        const current = this.#current.installed();
        const index = current.findIndex((installed) => installed.name === extension.name);
        const next = index < 0 ? [...current, extension] : current.map((installed, at) => (at === index ? extension : installed));
        this.#publish(next);
    }
    uninstall(extension) {
        const current = this.#current.installed();
        if (!current.some((installed) => installed.name === extension.name))
            return;
        this.#publish(current.filter((installed) => installed.name !== extension.name));
    }
    /** Build and validate the next state, which throws on a task name collision, then publish it synchronously. */
    #publish(extensions) {
        this.#current = new RegistryState(extensions);
        for (const listener of [...this.#listeners])
            listener();
    }
}
/** Unique tool names and section keys within one extension; valid, unreserved section keys. */
function validateExtension(extension) {
    const tools = new Set();
    for (const tool of extension.tools ?? []) {
        if (tools.has(tool.name))
            throw new Error(`Extension ${extension.name} has two tools named ${tool.name}`);
        tools.add(tool.name);
    }
    const sections = new Set();
    for (const { key } of extension.sections ?? []) {
        if (!SECTION_KEY.test(key))
            throw new TypeError(`Section key ${JSON.stringify(key)} must match ${SECTION_KEY}`);
        if (key === INSTRUCTIONS_KEY)
            throw new Error(`Section key ${key} is reserved for the agent's instructions`);
        if (sections.has(key))
            throw new Error(`Extension ${extension.name} has two sections with key ${key}`);
        sections.add(key);
    }
}
/** Create an application-owned registry holding only the built-in tasks. */
export function createRegistry() {
    return new RegistryImpl();
}