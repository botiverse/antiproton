/**
 * Documentation index and links:
 * Every markdown document under docs/ (except docs/README.md itself) must be
 * indexed in docs/README.md with its authoritative status.
 *
 * Why this suite exists:
 * In run 17 of the quality sweep, Rex found docs/ax-design.md was added by #600
 * without being indexed in docs/README.md. The table in docs/README.md is not
 * just a file list; it carries an authoritative status column distinguishing
 * current specs from frozen pre-implementation history.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const docsReadmePath = "docs/README.md";
const docsReadmeText = readFileSync(docsReadmePath, "utf8");

// Parse indexed markdown files from docs/README.md
const indexedFiles = new Set<string>();
for (const line of docsReadmeText.split("\n")) {
  const m = line.match(/^\|\s*\[`([^`]+\.md)`\]\([^)]+\)\s*\|\s*([^|]+)\|\s*([^|]+)\|/);
  if (m) {
    indexedFiles.add(m[1]!);
  }
}

check("docs/README.md carries an index table with files and authoritative status", () => {
  if (indexedFiles.size === 0) {
    throw new Error("No indexed markdown files found in docs/README.md table");
  }
});

check("every markdown file in docs/ (except README.md) is indexed in docs/README.md", () => {
  const diskFiles = readdirSync("docs")
    .filter((f) => f.endsWith(".md") && f !== "README.md");

  const missing = diskFiles.filter((f) => !indexedFiles.has(f));
  if (missing.length > 0) {
    throw new Error(`Unindexed documents in docs/README.md: ${missing.join(", ")}`);
  }
});

check("no ghost files: every indexed file in docs/README.md actually exists on disk", () => {
  const diskFiles = new Set(readdirSync("docs"));
  const ghost = [...indexedFiles].filter((f) => !diskFiles.has(f));
  if (ghost.length > 0) {
    throw new Error(`docs/README.md indexes non-existent files: ${ghost.join(", ")}`);
  }
});

console.log(`\n  Documentation indexing\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
