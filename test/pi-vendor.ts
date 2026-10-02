/**
 * The vendored pi files (src/vendor/pi/, docs/pi-upstream.md "Changing upstream files").
 *
 * A vendored file is upstream's file at one version plus our change. It stays right only while the
 * installed package is still that version: then the files it imports from the package are the ones it
 * was written against. So each file's header names its upstream path and the sha256 of the file it was
 * taken from, and this fails as soon as the installed file differs — an upgrade has to re-take the file
 * and re-apply the change, not run the old copy against new neighbours.
 *
 * Then the patch itself: the vendored Harness reports a sleeping task and the package's own does not
 * (the control), and nothing in the repo opens the package's Harness, which would run without the patch.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as bg } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTask, Harness as UpstreamHarness, type HarnessInspection } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createModels } from "pi-ai-1/models";
import { Harness, type SleepNotice } from "../src/vendor/pi/pi-durable/dist/harness/harness.js";

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

add("docs/pi-upstream.md and NOTICE list every vendored file", () => {
  const docs = readFileSync(new URL("docs/pi-upstream.md", root), "utf8");
  const notice = readFileSync(new URL("NOTICE", root), "utf8");
  for (const v of vendored()) {
    const path = `src/vendor/pi/${v.file}`;
    check(docs.includes(path), `docs/pi-upstream.md does not list ${path}`);
    check(notice.includes(path), `NOTICE does not list ${path}`);
  }
});

add("nothing outside src/vendor opens pi-durable's own Harness, which runs the unpatched scheduler", () => {
  const offenders: string[] = [];
  for (const dir of ["src", "cf/src", "test", "bench"]) {
    const base = new URL(`${dir}/`, root);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts") || f.startsWith("vendor/") || `${dir}/${f}` === "test/pi-vendor.ts") continue;
      const text = readFileSync(new URL(f, base), "utf8");
      for (const [, names] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@earendil-works\/pi-durable"/g)) {
        if (names!.split(",").some((n) => /^\s*Harness\b/.test(n))) offenders.push(`${dir}/${f}`);
      }
    }
  }
  check(offenders.length === 0, `import the vendored Harness instead: ${show(offenders)}`);
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

let passed = 0;
console.log(`\n  vendored pi files (src/vendor/pi/)\n  ${"─".repeat(56)}`);
for (const c of cases) {
  try { await c.run(); passed++; console.log(`    \x1b[32m✓\x1b[0m ${c.name}`); }
  catch (e) { console.log(`    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`); }
}
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${cases.length - passed} failed\n`);
process.exit(passed === cases.length ? 0 : 1);
