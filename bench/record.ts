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

export function recordRun(bench: string, obj: string, body: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  const dir = new URL(`../report/runs/${day}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${bench}-${obj}-${Date.now().toString(36)}.json`;
  writeFileSync(file, JSON.stringify(body, null, 1));
  return file.replace(/^.*\/report\//, "report/");
}
