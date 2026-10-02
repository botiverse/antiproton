/**
 * The vendored pi files (src/vendor/pi/, docs/pi-upstream.md "Changing upstream files").
 *
 * A vendored file is upstream's file at one version plus our change. It stays right only while the
 * installed package is still that version: then the files it imports from the package are the ones it
 * was written against. So each file's header names its upstream path and the sha256 of the file it was
 * taken from, and this fails as soon as the installed file differs — an upgrade has to re-take the file
 * and re-apply the change, not run the old copy against new neighbours.
 *
 * Then the patches themselves: the vendored Harness reports a sleeping task, and ends a sleep on `wake()`, and
 * the package's own does neither (the control), and the vendored SqliteStorage never opens an asynchronous transaction where the package's
 * does (the control); and nothing in the repo opens the package's Harness or SqliteStorage, which would run
 * without the patch.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as bg, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness as UpstreamHarness, type HarnessInspection } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import * as upstreamSqlite from "@earendil-works/pi-durable/storage/sqlite";
import { createModels } from "pi-ai-1/models";
import { Harness, type SleepNotice } from "../src/vendor/pi/pi-durable/dist/harness/harness.js";
import { SqliteStorage } from "../src/vendor/pi/pi-durable/dist/storage/sqlite/storage.js";
import { SQLITE_MIGRATIONS, CURRENT_SQLITE_SCHEMA_VERSION } from "../src/vendor/pi/pi-durable/dist/storage/sqlite/migrations.js";
import { PiDurableSqlite } from "../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const root = new URL("../", import.meta.url);
const vendorDir = new URL("src/vendor/pi/", root);
const sha256 = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");
const show = (v: unknown) => JSON.stringify(v);
function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

type Vendored = { file: string; upstream: string; pkg: string; version: string; base: string; text: string };
function vendored(): Vendored[] {
  const files = (readdirSync(vendorDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".js")).sort();
  return files.map((file) => {
    const text = readFileSync(new URL(file, vendorDir), "utf8");
    const field = (name: string) => text.match(new RegExp(`^ \\* ${name}:\\s+(\\S+)`, "m"))?.[1];
    const upstream = field("upstream path"), base = field("base sha256");
    const taken = text.match(/^ \* taken from:\s+(\S+) (\S+)/m);
    if (!upstream || !base || !taken) throw new Error(`src/vendor/pi/${file}: header lacks upstream path, taken from or base sha256`);
    return { file, upstream, pkg: taken[1]!, version: taken[2]!, base, text };
  });
}

const cases: Array<{ name: string; run(): Promise<void> | void }> = [];
const add = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });

add("there is something vendored, and every file's header names its upstream path, version and base hash", () => {
  const all = vendored();
  check(all.length >= 2, `vendored files: ${show(all.map((v) => v.file))}`);
});

add("the installed package is the version each vendored file was taken from", () => {
  for (const v of vendored()) {
    const installed = JSON.parse(readFileSync(new URL(`node_modules/${v.pkg}/package.json`, root), "utf8")).version;
    check(installed === v.version, `${v.file} was taken from ${v.pkg} ${v.version}; installed is ${installed}`);
  }
});

add("the installed upstream file is byte for byte the one each vendored file was taken from (sha256)", () => {
  for (const v of vendored()) {
    const installed = new URL(`node_modules/${v.upstream}`, root);
    check(existsSync(installed), `${v.upstream} is not installed`);
    const now = sha256(installed);
    check(now === v.base, `${v.upstream} is ${now}, src/vendor/pi/${v.file} was taken from ${v.base}: re-take it and re-apply the patch`);
  }
});

add("every relative import of a vendored file resolves, and none reaches the package's own copy of a vendored file", () => {
  const ours = new Set(vendored().map((v) => v.upstream));
  for (const v of vendored()) {
    for (const [, spec] of v.text.matchAll(/^import [^;]* from "(\.[^"]+)";$/gm)) {
      const target = new URL(spec!, new URL(v.file, vendorDir));
      check(existsSync(target), `${v.file} imports ${spec}, which does not exist`);
      const inPackage = target.pathname.split("/node_modules/")[1];
      check(!inPackage || !ours.has(inPackage), `${v.file} imports the unpatched ${inPackage}`);
    }
  }
});

add("every package a vendored file imports by name resolves to the one copy the package's own files get", () => {
  // A vendored file lives outside the package, so its bare imports resolve from the repo's top-level node_modules;
  // the package's own files would resolve a copy nested in its directory first. Two copies are two module
  // identities (a class, a context key), and the vendored file would be talking to the other one.
  for (const v of vendored()) {
    for (const [, spec] of v.text.matchAll(/^import [^;]* from "([^".][^"]*)";$/gm)) {
      const name = spec!.startsWith("@") ? spec!.split("/").slice(0, 2).join("/") : spec!.split("/")[0]!;
      const nested = new URL(`node_modules/${v.pkg}/node_modules/${name}/`, root);
      check(!existsSync(nested), `${v.pkg} has its own copy of ${name} (${nested.pathname}); ${v.file} imports the top-level one`);
      check(existsSync(new URL(`node_modules/${name}/`, root)), `${v.file} imports ${spec}, which is not installed at the top level`);
    }
  }
});

add("docs/pi-upstream.md and NOTICE list every vendored file", () => {
  const docs = readFileSync(new URL("docs/pi-upstream.md", root), "utf8");
  const notice = readFileSync(new URL("NOTICE", root), "utf8");
  for (const v of vendored()) {
    const path = `src/vendor/pi/${v.file}`;
    check(docs.includes(path), `docs/pi-upstream.md does not list ${path}`);
    check(notice.includes(path), `NOTICE does not list ${path}`);
  }
});

add("nothing outside src/vendor opens pi-durable's own Harness or SqliteStorage, which run unpatched", () => {
  const offenders: string[] = [];
  // SqliteStorage and applySqliteMigrations from the package commit and migrate in an async transaction.
  const unpatched: Array<[string, RegExp]> = [
    ["@earendil-works/pi-durable", /^\s*Harness\b/],
    ["@earendil-works/pi-durable/storage/sqlite", /^\s*(SqliteStorage|applySqliteMigrations)\b/],
  ];
  for (const dir of ["src", "cf/src", "test", "bench"]) {
    const base = new URL(`${dir}/`, root);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.startsWith("vendor/") || `${dir}/${f}` === "test/pi-vendor.ts") continue;
      const text = readFileSync(new URL(f, base), "utf8");
      for (const [, names, from] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
        for (const [pkg, name] of unpatched) {
          if (from === pkg && names!.split(",").some((n) => name.test(n))) offenders.push(`${dir}/${f}`);
        }
      }
    }
  }
  check(offenders.length === 0, `import the vendored Harness or SqliteStorage instead: ${show(offenders)}`);
});

add("the vendored migrations are the package's schema, statement for statement", () => {
  check(show(SQLITE_MIGRATIONS) === show(upstreamSqlite.SQLITE_MIGRATIONS), "the vendored SQLITE_MIGRATIONS differ from the package's");
  check(CURRENT_SQLITE_SCHEMA_VERSION === upstreamSqlite.CURRENT_SQLITE_SCHEMA_VERSION, "schema versions differ");
});

/** Open, commit, read a document and close over a facade that counts which transaction each step asks for. */
async function transactionsAsked(open: (db: PiDurableSqlite & upstreamSqlite.SqliteDatabase) => Promise<upstreamSqlite.SqliteStorage>) {
  const host = sqliteHost();
  const db = new PiDurableSqlite(host, prefixedNamespace("pd"));
  const asked = { transaction: 0, transactionSync: 0 };
  const { transactionSync } = db;
  // The facade has no async transaction; upstream's storage (the control) asks for one, and is handed the
  // facade's own statements, which is enough to count what it asks.
  (db as PiDurableSqlite & upstreamSqlite.SqliteDatabase).transaction = (cb) => { asked.transaction++; return cb(db as never); };
  db.transactionSync = (cb) => { asked.transactionSync++; return transactionSync.call(db, cb) as never; };
  try {
    const storage = await open(db as PiDurableSqlite & upstreamSqlite.SqliteDatabase);
    await storage.commit([{ type: "conversation", value: { id: 1 as never } }], bg);
    await storage.document(1 as never, "current", bg);
    await storage.close(bg);
  } finally { host.dispose(); }
  return asked;
}

add("the vendored SqliteStorage migrates, commits and reads in transactionSync, and never opens an async transaction", async () => {
  const asked = await transactionsAsked((db) => SqliteStorage.open(db));
  check(show(asked) === show({ transaction: 0, transactionSync: 3 }), `asked ${show(asked)}`);
});

add("the control: pi-durable's own SqliteStorage opens an async transaction for each of the three", async () => {
  const asked = await transactionsAsked((db) => upstreamSqlite.SqliteStorage.open(db));
  check(show(asked) === show({ transaction: 3, transactionSync: 0 }), `asked ${show(asked)}`);
});

add("the vendored SqliteStorage refuses a database without transactionSync, and closes it", async () => {
  let closed = false;
  const db = { exec: async () => {}, run: async () => {}, get: async () => undefined, all: async () => [], close: async () => { closed = true; } };
  const error = await SqliteStorage.open(db as never).then(() => null, (e: unknown) => e);
  check(String(error).includes("transactionSync"), `open said ${show(String(error))}`);
  check(closed, "the database was not closed");
});

/** A task that sleeps once until `NAP_UNTIL` and completes. */
let napUntil = 0;
const Nap = defineTask<Record<string, never>, { phase: "nap" }, null>({
  name: "vendor-test.nap", version: 1, initial: () => ({ phase: "nap" }),
  phases: {
    nap: async (_task, runtime, context) => {
      await runtime.sleep(napUntil, context);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

/** Open a harness, start the nap, and read the inspection once the task's invocation is in its sleep. */
async function napping(open: typeof Harness.open, sleeps: SleepNotice[]) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "vendor-test", tasks: [Nap] }));
  const h = await open(new MemoryStorage(), { models: createModels(), registry, onSleep: (s) => sleeps.push(s) }, bg);
  napUntil = Date.now() + 60_000;
  const root = await h.root(bg);
  const taskId = await root.commit((tx) => tx.createTask(Nap, {}, { ownership: { kind: "conversation" } }), bg);
  h.resume();
  // The sleep starts a few microtasks after resume; poll the inspection until the timer is up.
  let inspection: HarnessInspection | undefined;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r));
    inspection = await h.inspect(bg);
    if (timers() > 0 && inspection.tasks[0]?.state.kind === "running") break;
  }
  return { h, taskId, inspection: inspection!, until: napUntil };
}

add("the vendored Harness: a sleep is reported with its T (inspect and onSleep, once), and close leaves no timer", async () => {
  const sleeps: SleepNotice[] = [];
  const { h, taskId, inspection, until } = await napping(Harness.open, sleeps);
  const live = timers();
  await h.close(bg);
  const [task] = inspection.tasks;
  check(show(task?.state) === show({ kind: "running", sleepingUntil: until }), `inspect said ${show(task?.state)}, the task sleeps until ${until}`);
  check(sleeps.length === 1 && sleeps[0]?.until === until && sleeps[0]?.taskId === taskId, `onSleep ${show(sleeps)}, task ${taskId}`);
  check(live > 0, "the control: no live timer was seen while the task slept");
  check(timers() === 0, `live timers after close: ${timers()}`);
});

add("the control: pi-durable's own Harness reports the same sleep as plain running and never calls onSleep", async () => {
  const sleeps: SleepNotice[] = [];
  const { h, inspection } = await napping(UpstreamHarness.open as typeof Harness.open, sleeps);
  await h.close(bg);
  check(show(inspection.tasks[0]?.state) === show({ kind: "running" }), `upstream inspect said ${show(inspection.tasks[0]?.state)}`);
  check(sleeps.length === 0, `upstream called onSleep: ${show(sleeps)}`);
});

/**
 * A task that sleeps, then waits on `gate` while its invocation is still running: in "end" the sleep runs out
 * (`DOZE_MS`); in "abort" it is aborted through the signal of the context it was given. Either way inspect()
 * must stop reporting `sleepingUntil` once the sleep is over.
 */
let dozeMode: "end" | "abort" = "end";
let dozeAbort = new AbortController();
let afterSleep: () => void = () => {};
let gate: Promise<void> = Promise.resolve();
const DOZE_MS = 300;
const Doze = defineTask<Record<string, never>, { phase: "doze" }, null>({
  name: "vendor-test.doze", version: 1, initial: () => ({ phase: "doze" }),
  phases: {
    doze: async (_task, runtime, context) => {
      if (dozeMode === "end") await runtime.sleep(Date.now() + DOZE_MS, context);
      else await runtime.sleep(Date.now() + 60_000, withAbortSignal(dozeAbort.signal, context)).catch(() => {});
      afterSleep();
      await gate;
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
    },
  },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});

async function sleepThenAfter(mode: "end" | "abort") {
  dozeMode = mode;
  dozeAbort = new AbortController();
  let open!: () => void;
  gate = new Promise<void>((r) => { open = r; });
  const slept = new Promise<void>((r) => { afterSleep = r; });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "vendor-test", tasks: [Doze] }));
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, bg);
  try {
    const root = await h.root(bg);
    await root.commit((tx) => tx.createTask(Doze, {}, { ownership: { kind: "conversation" } }), bg);
    h.resume();
    let during: unknown;
    for (let i = 0; i < 100 && during === undefined; i++) {
      await new Promise((r) => setImmediate(r));
      const state = (await h.inspect(bg)).tasks[0]?.state as { sleepingUntil?: number } | undefined;
      if (state?.sleepingUntil !== undefined) during = state;
    }
    if (mode === "abort") dozeAbort.abort();
    await slept;
    const after = (await h.inspect(bg)).tasks[0]?.state;
    open();
    return { during, after };
  } finally { open(); await h.close(bg); }
}

add("the vendored Harness: once a sleep runs out, inspect() reports plain running again", async () => {
  const { during, after } = await sleepThenAfter("end");
  check(during !== undefined, "control: the sleep was never reported");
  check(show(after) === show({ kind: "running" }), `after the sleep inspect said ${show(after)}`);
});

add("the vendored Harness: once a sleep is aborted, inspect() reports plain running again", async () => {
  const { during, after } = await sleepThenAfter("abort");
  check(during !== undefined, "control: the sleep was never reported");
  check(show(after) === show({ kind: "running" }), `after the aborted sleep inspect said ${show(after)}`);
});

/** Resolve with how long `p` took, or reject after `ms`: a woken nap must not wait for its 60 s. */
async function within<T>(ms: number, p: Promise<T>): Promise<number> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not done within ${ms} ms`)), ms); })]);
    return Date.now() - t0;
  } finally { clearTimeout(timer); }
}

add("the vendored Harness: wake() ends a sleep in progress, and the task goes on at once", async () => {
  const sleeps: SleepNotice[] = [];
  const { h, taskId, inspection } = await napping(Harness.open, sleeps);
  try {
    check((inspection.tasks[0]?.state as { sleepingUntil?: number }).sleepingUntil !== undefined, "control: the nap was not asleep");
    h.wake([taskId]);
    const ms = await within(2_000, h.waitForTask(taskId, bg));
    check(ms < 1_000, `the woken task took ${ms} ms`);
    check(timers() === 0, `live timers after the woken sleep: ${timers()}`);
  } finally { await h.close(bg); }
});

add("the vendored Harness: a wake asked before the sleep starts is kept, and the next sleep returns at once", async () => {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "vendor-test", tasks: [Nap] }));
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, bg);
  try {
    napUntil = Date.now() + 60_000;
    const root = await h.root(bg);
    const taskId = await root.commit((tx) => tx.createTask(Nap, {}, { ownership: { kind: "conversation" } }), bg);
    // Not resumed yet: no invocation, so the wake is kept for the task. An id that is no live task is ignored.
    h.wake([taskId, "no-such-task" as unknown as typeof taskId]);
    h.resume();
    const ms = await within(2_000, h.waitForTask(taskId, bg));
    check(ms < 1_000, `the pre-woken task took ${ms} ms`);
  } finally { await h.close(bg); }
});

add("the vendored Harness: a wake for another task leaves a sleep alone", async () => {
  const { h, taskId } = await napping(Harness.open, []);
  try {
    h.wake(["no-such-task" as unknown as typeof taskId]);
    await new Promise((r) => setTimeout(r, 50));
    const state = (await h.inspect(bg)).tasks[0]?.state as { sleepingUntil?: number } | undefined;
    check(state?.sleepingUntil !== undefined, `the nap stopped sleeping: ${show(state)}`);
  } finally { await h.close(bg); }
});

add("the control: pi-durable's own Harness has no wake", async () => {
  const { h } = await napping(UpstreamHarness.open as typeof Harness.open, []);
  try { check(typeof (h as { wake?: unknown }).wake === "undefined", "upstream's Harness has a wake: re-check the patch"); }
  finally { await h.close(bg); }
});

let passed = 0;
console.log(`\n  vendored pi files (src/vendor/pi/)\n  ${"─".repeat(56)}`);
for (const c of cases) {
  try { await c.run(); passed++; console.log(`    \x1b[32m✓\x1b[0m ${c.name}`); }
  catch (e) { console.log(`    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`); }
}
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${cases.length - passed} failed\n`);
process.exit(passed === cases.length ? 0 : 1);
