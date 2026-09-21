/**
 * A run leaves a file, not a terminal.
 *
 * The evidence for four τ² runs and ten SWE-bench instances lived in /tmp for
 * an afternoon — one reboot from gone, behind a page that called it retained.
 * Every on-object runner now writes its per-task rows and totals here, under
 * the object and date it ran on, so a reader who was not present can open the
 * file behind a row. Small JSON, committed by hand with the numbers it backs.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Which code the Worker at `base` is running: its deploy-time commit, read
 * from the ungated probe. Null when the deploy did not say (older Workers),
 * and null rather than a throw when the probe is unreachable, so a record
 * is still written; the field is then an honest "unknown".
 */
export async function workerBuild(base: string): Promise<string | null> {
  try {
    const r = await fetch(`${base}/ui/whoami`);
    const j: any = await r.json();
    return typeof j?.build === "string" && j.build ? j.build : null;
  } catch { return null; }
}

/**
 * Which code the driver itself ran from. Two witnesses write a record: the
 * Worker reports its build, the driver computes the per-task fields from its
 * own checkout, and the two can differ (a driver ahead of or behind the
 * harness). `dirty` says whether the tree had uncommitted changes, in which
 * case the commit does not describe the code that ran; null when the driver
 * is not in a git checkout.
 */
export function driverCommit(): { commit: string; dirty: boolean } | null {
  try {
    const cwd = new URL("./", import.meta.url).pathname;
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    // Scoped to the driver's trees, like deploy.sh: a repository-wide status
    // would count untracked entries elsewhere in the checkout (a symlinked
    // node_modules escapes the "node_modules/" ignore rule, a real directory
    // does not), and the field would then depend on the checkout's shape
    // rather than on the code that ran (Vera, Dora, 2026-09-12).
    // `:(top)` anchors the pathspecs at the repository root; the command runs
    // from bench/, where a bare "bench" would name nothing and hide every edit.
    const dirty = git("status", "--porcelain", "--", ":(top)bench", ":(top)src").length > 0;
    return { commit: git("rev-parse", "--short=7", "HEAD"), dirty };
  } catch { return null; }
}

/**
 * The two paths one run writes: its record and its console log.
 *
 * Both come from here, and they are handed out **before** the run's first line
 * of output, because a tee has to know where it is writing at the moment it
 * starts writing — the stem used to be minted at the end, inside `recordRun`,
 * which is after every line it would have captured (Vera, 2026-09-20). A
 * caller that only got the stem would still be choosing the log's directory,
 * and one that chose `/tmp` is how a record reached the manifest with no log
 * beside it (#463). So the caller receives the path rather than composing it.
 *
 * The day in the path is the day the run STARTED: one run that crosses
 * midnight keeps its two files together, which matters more here than the
 * date being the one the record was written on — `written.at` still says that.
 */
export type Run = { runId: string; json: string; log: string };

/** The runs tree the report page reads, and the default every runner uses. */
const RUNS = new URL("../report/runs/", import.meta.url).pathname;

export function beginRun(bench: string, obj: string, runs = RUNS): Run {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = `${runs}${day}/`;
  // Here and not in recordRun, which is hours later: a tee opens the log as
  // the run starts, and on the first run of any day this directory is the one
  // thing between it and an ENOENT. `runs` exists so a suite can watch that
  // happen — against the repo's own tree the day directory is already there,
  // and an assertion that the mkdir works would pass with the mkdir deleted.
  mkdirSync(dir, { recursive: true });
  const runId = `${bench}-${obj}-${now.getTime().toString(36)}`;
  return { runId, json: `${dir}${runId}.json`, log: `${dir}${runId}.log` };
}

export function recordRun(run: Run, body: unknown): string {
  // Made again rather than trusted from beginRun: hours pass between the two,
  // and the write is the payoff of all of them — a directory that went away in
  // between should cost a syscall, not the run.
  mkdirSync(dirname(run.json), { recursive: true });
  const rel = run.json.replace(/^.*\/report\//, "report/");
  // Where and when this file was written, inside the bytes: a record that is
  // copied elsewhere keeps the testimony that otherwise lives only in its
  // path and mtime (Dora, Vera, 2026-09-12). `file` is relative to the tree
  // the driver ran in; `driver` (from the callers) names that tree.
  const written = { at: new Date().toISOString(), file: rel };
  writeFileSync(run.json, JSON.stringify({ ...(body as object), written }, null, 1));
  return rel;
}

/**
 * Send this run's console output to its own log, so the record and the log
 * cannot be separated by where the caller happened to redirect. The path is
 * not a parameter: it comes from the handle, which is the whole point — a run
 * whose log location is an argument is a run where someone can pass /tmp, and
 * one did (#463).
 *
 * ONE PATCH POINT, not one per call site. The runners have eighteen and
 * thirteen `console.log` calls and no shared logger between them, so writing
 * to the file at each would mean thirty-one places have to remember, and the
 * thirty-second never would.
 *
 * `appendFileSync` flushes per line, which is what a run that dies mid-way
 * needs: it leaves what it printed, and that file is then the only evidence
 * of that run.
 *
 * `args.map(String)` is faithful for the runners as they stand — every
 * argument they pass is already a string (checked: the only non-string call
 * is `console.log()` with no arguments, which is a blank line on both sides).
 * It is NOT console.log's general behaviour: an object becomes
 * `[object Object]` and `%s` is not substituted, so a call added later with
 * anything else reads differently in the file than in the terminal.
 *
 * Lives here rather than in each runner because two verbatim copies are the
 * same failure one level up — a third runner copies it, or copies it wrong
 * (@Vera, 2026-09-20, #465).
 */
/**
 * Colour codes are for a terminal, and the log file is not one.
 *
 * `\x1b[32m✓\x1b[0m` costs nine bytes and occupies no columns, so a reader
 * outside a terminal — the report page serves these as `text/plain` — sees
 * `^[[32m✓^[[0m task 0    db=ok` and every column after the mark pushed nine
 * bytes right. These files are TABLES whose alignment is byte counts, so the
 * escapes do not make them ugly, they make them wrong, and exactly on the
 * column a reader runs their eye down (@Vera, 2026-09-21).
 *
 * Stripped HERE rather than at each `mark`, because the two consumers want
 * different bytes from the same call: the terminal keeps its colour, the file
 * does not get it. Asking `process.stdout.isTTY` at the producer cannot serve
 * both — in a watched run the file would still get the escapes, and in a
 * redirected one the terminal would lose its colour. And the producers are
 * not one place: four sites across the two teed runners emit colour
 * (`bench/tau2/cf.ts:378`, `bench/swebench/cf.ts:247,297,311`).
 *
 * Only what is written from here on. The records already published keep their
 * escapes and cannot be rewritten, so a reader-side strip on the report page
 * is a separate and still-needed fix (@Nova's surface).
 */
const SGR = /\x1b\[[0-9;]*m/g;

export function teeRun(run: Run): void {
  const line = (args: unknown[]) => args.map(String).join(" ").replace(SGR, "") + "\n";
  for (const which of ["log", "error"] as const) {
    const say = console[which].bind(console);
    console[which] = (...args: unknown[]) => {
      say(...args);
      appendFileSync(run.log, line(args));
    };
  }
  // And the trace of an uncaught throw, which console.error does not see: Node
  // writes it straight to fd 2. Patching the console is necessary but not
  // enough, which is why this handler exists rather than being assumed — it
  // was measured, with only the loop above, that a run which throws leaves a
  // log stopping at its last ordinary line.
  //
  // It goes through `console.error` on purpose. Installing a handler STOPS
  // Node's own default action, so appending to the file directly would trade
  // one loss for another: the file would hold the cause and whoever was
  // watching the run would see the output stop and the process exit 1 in
  // silence. Through the patched console.error, both get the same bytes.
  process.on("uncaughtException", (e) => {
    console.error((e as Error)?.stack ?? e);
    process.exit(1);
  });
}
