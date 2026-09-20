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
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { beginRun, recordRun, type Run } from "../bench/record.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

check("the record and the log differ only in their extension", () => {
  const run = beginRun("tau2", "h9");
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
  const run = beginRun("swebench", "b_daily_1");
  if (!basename(run.json).startsWith("swebench-b_daily_1-")) {
    throw new Error(`the file name does not name the bench and object: ${basename(run.json)}`);
  }
});

check("the directory exists when the paths are handed out, not when they are written", () => {
  // A tee opens the log as the run starts. If the day's directory were made
  // by recordRun — where the mkdir used to live — the open would fail on the
  // first run of each day, which is the run nobody is watching.
  const run = beginRun("tau2", "h9");
  if (!existsSync(dirname(run.json))) throw new Error(`${dirname(run.json)} does not exist yet`);
  if (existsSync(run.json)) throw new Error(`beginRun wrote the record; it is meant to only name it: ${run.json}`);
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

console.log(`\n  Bench run records\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
