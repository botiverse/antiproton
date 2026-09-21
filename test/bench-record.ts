/**
 * The two paths a run writes come from one producer.
 *
 * #463 put a record on the report page with its console log left in /tmp: the
 * runner composed the log's path itself, and the record's path came from
 * `recordRun`, so nothing in the tree said they had to agree. The repair is
 * `beginRun`, which hands out both — and what makes it a repair is not that
 * the stems match today, but that THE CALLER HAS NOTHING LEFT TO DECIDE.
 *
 * So these cases ask for the property that survives a new runner being
 * written next week: same directory, same stem, and a stem that exists before
 * the first line of output rather than after the last one.
 *
 * `recordRun` is exercised against a handle pointing into a temporary tree.
 * It writes wherever the handle says, which is the point — and a suite that
 * let it write into report/runs would leave a file the publish script would
 * happily send to the public bucket.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { beginRun, recordRun, teeRun, type Run } from "../bench/record.ts";

/** A runs tree of this suite's own. Nothing here writes into report/runs: a
 *  stray record there is one the publish script would send to the bucket. */
function runsTree(): { runs: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bench-record-"));
  return { runs: join(dir, "report/runs/"), dir };
}

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

check("the record and the log differ only in their extension", () => {
  const { runs, dir } = runsTree();
  const run = beginRun("tau2", "h9", runs);
  rmSync(dir, { recursive: true, force: true });
  if (dirname(run.json) !== dirname(run.log)) {
    throw new Error(`the two files are in different directories:\n  ${run.json}\n  ${run.log}`);
  }
  if (`${run.json.replace(/\.json$/, "")}.log` !== run.log) {
    throw new Error(`the stems differ:\n  ${run.json}\n  ${run.log}`);
  }
  if (basename(run.json) !== `${run.runId}.json`) {
    throw new Error(`the record is not named after the run id (${run.runId}): ${basename(run.json)}`);
  }
});

check("the paths carry the bench and the object, so a directory of them reads", () => {
  const { runs, dir } = runsTree();
  const run = beginRun("swebench", "b_daily_1", runs);
  rmSync(dir, { recursive: true, force: true });
  if (!basename(run.json).startsWith("swebench-b_daily_1-")) {
    throw new Error(`the file name does not name the bench and object: ${basename(run.json)}`);
  }
});

check("the directory exists when the paths are handed out, not when they are written", () => {
  // A tee opens the log as the run starts. If the day's directory were made
  // by recordRun — where the mkdir used to live — the open would fail on the
  // first run of each day, which is the run nobody is watching.
  //
  // The day directory must be one that did NOT already exist, which is why
  // this runs against a tree of its own: in report/runs today's directory is
  // there whatever the code does, and the check would pass either way.
  const { runs, dir } = runsTree();
  const run = beginRun("tau2", "h9", runs);
  const made = existsSync(dirname(run.json));
  const wrote = existsSync(run.json);
  rmSync(dir, { recursive: true, force: true });
  if (!made) throw new Error(`${dirname(run.json)} does not exist yet, so a tee opening the log now would fail`);
  if (wrote) throw new Error(`beginRun wrote the record; it is meant to only name it: ${run.json}`);
});

check("recordRun writes where the handle says, and nowhere else", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-record-"));
  const day = join(dir, "report/runs/2026-01-01");
  mkdirSync(day, { recursive: true });
  const run: Run = { runId: "tau2-h9-abc", json: join(day, "tau2-h9-abc.json"), log: join(day, "tau2-h9-abc.log") };
  const rel = recordRun(run, { bench: "tau2-retail", results: [] });
  const body = JSON.parse(readFileSync(run.json, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  if (rel !== "report/runs/2026-01-01/tau2-h9-abc.json") throw new Error(`it reported a path the report page cannot resolve: ${rel}`);
  if (body.bench !== "tau2-retail") throw new Error(`the body did not survive the write: ${JSON.stringify(body)}`);
  // The record says where it was written, because a copy of it elsewhere
  // keeps nothing else (Dora, Vera, 2026-09-12).
  if (body.written?.file !== rel) throw new Error(`written.file disagrees with the returned path: ${JSON.stringify(body.written)}`);
  if (!body.written?.at) throw new Error(`the record does not say when it was written: ${JSON.stringify(body.written)}`);
});

check("a day directory that went away between begin and record does not cost the run", () => {
  // Hours separate the two calls, and the write is what the hours were for.
  const dir = mkdtempSync(join(tmpdir(), "bench-record-"));
  const day = join(dir, "report/runs/2026-01-01");
  const run: Run = { runId: "tau2-h9-abc", json: join(day, "tau2-h9-abc.json"), log: join(day, "tau2-h9-abc.log") };
  let failed: string | null = null;
  try { recordRun(run, { bench: "tau2-retail" }); } catch (e) { failed = String((e as Error).message); }
  const wrote = existsSync(run.json);
  rmSync(dir, { recursive: true, force: true });
  if (failed) throw new Error(`the record was lost to a missing directory: ${failed}`);
  if (!wrote) throw new Error(`recordRun reported success without writing anything`);
});

/**
 * Runs `teeRun` and puts everything back: it patches two globals and adds a
 * process listener, and a suite that left those in place would append its own
 * later output to a deleted temp file and swallow the next throw in the run.
 */
function withTee<T>(run: Run, fn: () => T): T {
  const log = console.log, error = console.error;
  const before = new Set(process.listeners("uncaughtException"));
  try {
    teeRun(run);
    return fn();
  } finally {
    console.log = log;
    console.error = error;
    for (const l of process.listeners("uncaughtException")) {
      if (!before.has(l)) process.removeListener("uncaughtException", l);
    }
  }
}

check("the tee writes to the handle's log, which the caller never names", () => {
  // The defect this whole file is about: the log's location was the caller's
  // to choose, and one caller chose /tmp (#463). `teeRun` takes the handle,
  // so there is no path argument to get wrong.
  const { runs, dir } = runsTree();
  const run = beginRun("tau2", "h9", runs);
  const said: string[] = [];
  withTee(run, () => {
    const say = console.log;
    console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); (say as any)(...a); };
    console.log("a line");
    console.error("a diagnostic");
  });
  const written = existsSync(run.log) ? readFileSync(run.log, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  if (!written.includes("a diagnostic")) {
    throw new Error(`console.error is not in the log, so a run's diagnostics live only in the terminal: ${JSON.stringify(written)}`);
  }
});

check("the tee still prints, so the file is a copy and not a diversion", () => {
  // Cheap to get backwards: a tee that only writes the file leaves whoever is
  // watching the run with nothing.
  const { runs, dir } = runsTree();
  const run = beginRun("tau2", "h9", runs);
  const seen: string[] = [];
  const say = console.log;
  console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    withTee(run, () => { console.log("on both"); });
  } finally { console.log = say; }
  const written = existsSync(run.log) ? readFileSync(run.log, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  if (!seen.includes("on both")) throw new Error(`the terminal did not get the line: ${JSON.stringify(seen)}`);
  if (!written.includes("on both")) throw new Error(`the file did not get the line: ${JSON.stringify(written)}`);
});

check("the log gets the text without the colour, and the terminal keeps it", () => {
  // The escapes cost nine bytes and no columns, so in a plain-text reader —
  // which is what the report page serves these as — they push every column
  // after the mark nine bytes right. A log is a table; that is a wrong table,
  // not an ugly one (@Vera, 2026-09-21).
  const { runs, dir } = runsTree();
  const run = beginRun("tau2", "h9", runs);
  const seen: string[] = [];
  const say = console.log;
  console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    withTee(run, () => {
      console.log(`  \x1b[32m✓\x1b[0m task 0    db=ok`);
      console.log(`  \x1b[31m✗\x1b[0m task 1    db=NO`);
    });
  } finally { console.log = say; }
  const written = readFileSync(run.log, "utf8");
  rmSync(dir, { recursive: true, force: true });
  if (written.includes("\x1b")) throw new Error(`the log kept an escape sequence: ${JSON.stringify(written)}`);
  if (!written.includes("✓ task 0")) throw new Error(`stripping took the mark with it: ${JSON.stringify(written)}`);
  if (!seen.some((l) => l.includes("\x1b"))) throw new Error(`the terminal lost its colour, which nobody asked for: ${JSON.stringify(seen)}`);
  // The point of the strip, stated as the property a reader depends on.
  const [a, b] = written.split("\n");
  if (Buffer.byteLength(a) !== Buffer.byteLength(b)) {
    throw new Error(`two rows of the same table differ in byte length (${Buffer.byteLength(a)} vs ${Buffer.byteLength(b)}), so the columns do not line up`);
  }
});

check("an uncaught throw leaves its trace in the log AND on the terminal", () => {
  // Node stops printing the trace itself once a handler is installed, so a
  // handler that writes only the file trades one loss for the other — that
  // happened, and both halves are asserted here (#465).
  //
  // In a child process, because the case ends in `process.exit(1)`.
  const dir = mkdtempSync(join(tmpdir(), "bench-record-"));
  const day = join(dir, "report/runs/2026-01-01");
  mkdirSync(day, { recursive: true });
  const log = join(day, "t-x.log");
  const script = join(dir, "throws.mjs");
  writeFileSync(script, [
    `import { teeRun } from ${JSON.stringify(new URL("../bench/record.ts", import.meta.url).pathname)};`,
    `teeRun({ runId: "t-x", json: ${JSON.stringify(join(day, "t-x.json"))}, log: ${JSON.stringify(log)} });`,
    `console.log("ordinary line");`,
    `const api = async () => { throw new Error("THE CAUSE"); };`,
    `await api();`,
  ].join("\n"));
  let code = 0, stderr = "";
  try {
    execFileSync(process.execPath, [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    code = err.status ?? -1;
    stderr = err.stderr ?? "";
  }
  const written = existsSync(log) ? readFileSync(log, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  if (!written.includes("ordinary line")) throw new Error(`the log lost the output before the throw: ${JSON.stringify(written)}`);
  if (!written.includes("THE CAUSE")) throw new Error(`the log ends at the last ordinary line, with no cause: ${JSON.stringify(written)}`);
  if (!stderr.includes("THE CAUSE")) throw new Error(`the terminal saw the run stop in silence: ${JSON.stringify(stderr)}`);
  if (code !== 1) throw new Error(`a run that died reported ${code}, not 1`);
});

console.log(`\n  Bench run records\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
