/**
 * A run leaves a file, not a terminal.
 *
 * The evidence for four τ² runs and ten SWE-bench instances lived in /tmp for
 * an afternoon — one reboot from gone, behind a page that called it retained.
 * Every on-object runner now writes its per-task rows and totals here, under
 * the object and date it ran on, so a reader who was not present can open the
 * file behind a row. Small JSON, committed by hand with the numbers it backs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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

export function beginRun(bench: string, obj: string): Run {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = new URL(`../report/runs/${day}/`, import.meta.url).pathname;
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
