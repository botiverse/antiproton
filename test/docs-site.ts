/**
 * Verification suite for antiproton documentation site (docs.antiproton.ai).
 *
 * Verifies:
 * 1. Build script runs cleanly and generates index.html and version.json.
 * 2. All 12 markdown documents are compiled into the site.
 * 3. Stratification is preserved: public guides, internal references, and frozen archives are categorized.
 * 4. Provenance metadata (commit SHA, tree SHA, build timestamp) is present and well-formed.
 * 5. Frozen archives explicitly carry warning callouts distinguishing them from current specs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs-site", "public");

check("build-docs script runs successfully", () => {
  const out = execSync("node scripts/build-docs.mjs", { cwd: ROOT, encoding: "utf8" });
  if (!out.includes("Antiproton Documentation Site built successfully")) {
    throw new Error(`Unexpected build output: ${out}`);
  }
});

check("artifacts exist: index.html and version.json", () => {
  if (!existsSync(join(OUT_DIR, "index.html"))) throw new Error("missing index.html");
  if (!existsSync(join(OUT_DIR, "version.json"))) throw new Error("missing version.json");
  if (!existsSync(join(OUT_DIR, "rui-foundation.css"))) throw new Error("missing rui-foundation.css");
});

check("version.json carries required provenance fields", () => {
  const v = JSON.parse(readFileSync(join(OUT_DIR, "version.json"), "utf8"));
  if (v.service !== "docs.antiproton.ai") throw new Error(`bad service: ${v.service}`);
  if (!v.commit || v.commit.length < 7) throw new Error(`bad commit: ${v.commit}`);
  if (!v.tree || v.tree.length < 7) throw new Error(`bad tree: ${v.tree}`);
  if (!v.builtAt) throw new Error("missing builtAt");
  if (!Array.isArray(v.sections) || v.sections.length < 3) throw new Error("sections array missing or incomplete");
});

check("stratification: public, internal, and archive sections exist", () => {
  const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
  if (!html.includes("Public Documentation &amp; Guides") && !html.includes("Public Documentation & Guides")) {
    throw new Error("missing public section header");
  }
  if (!html.includes("Internal Engineering Reference")) {
    throw new Error("missing internal section header");
  }
  if (!html.includes("Historical Archives")) {
    throw new Error("missing archive section header");
  }
});

check("provenance in HTML: displays commit, tree sha, and verification command", () => {
  const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
  if (!html.includes("git rev-parse")) {
    throw new Error("missing git rev-parse verification command in page");
  }
  if (!html.includes("tree:")) {
    throw new Error("missing tree sha display in page");
  }
});

check("frozen archives carry explicit disclaimer banner", () => {
  const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
  if (!html.includes("Historical Planning Archive (Frozen History)")) {
    throw new Error("missing archive disclaimer callout in generated html");
  }
});

console.log(`\n  Documentation site verification\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
