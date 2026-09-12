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

export function recordRun(bench: string, obj: string, body: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = new URL(`../report/runs/${day}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${bench}-${obj}-${Date.now().toString(36)}.json`;
  writeFileSync(file, JSON.stringify(body, null, 1));
  return file.replace(/^.*\/report\//, "report/");
}
