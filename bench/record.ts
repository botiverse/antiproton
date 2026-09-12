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

export function recordRun(bench: string, obj: string, body: unknown): string {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = new URL(`../report/runs/${day}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${bench}-${obj}-${Date.now().toString(36)}.json`;
  const rel = file.replace(/^.*\/report\//, "report/");
  // Where and when this file was written, inside the bytes: a record that is
  // copied elsewhere keeps the testimony that otherwise lives only in its
  // path and mtime (Dora, Vera, 2026-09-12). `file` is relative to the tree
  // the driver ran in; `driver` (from the callers) names that tree.
  const written = { at: now.toISOString(), file: rel };
  writeFileSync(file, JSON.stringify({ ...(body as object), written }, null, 1));
  return rel;
}
