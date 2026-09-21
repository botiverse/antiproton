/**
 * "Depends on:" notes name the version they were checked against. For a package
 * this repo installs, that version must be the installed one: upgrading the
 * package fails here until each note — and the code it guards — is re-checked
 * and moved to the new version.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const installed: Record<string, string> = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|mjs|js)$/.test(name)) yield p;
  }
}

const notes: Array<{ file: string; line: number; name: string; version: string }> = [];
for (const dir of ["src", "cf/src", "test", "bench"]) {
  for (const file of files(join(root, dir))) {
    readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      const m = /Depends on: (@?[\w./-]+) (\d+\.\d+\.\d+)/.exec(text);
      if (m && !text.includes("/Depends on:")) notes.push({ file: file.slice(root.length), line: i + 1, name: m[1]!, version: m[2]! });
    });
  }
}

const failures: string[] = [];
const checked = notes.filter((n) => n.name in installed);
for (const n of checked) {
  const want = String(installed[n.name]).replace(/^[\^~=]/, "");
  if (n.version !== want) failures.push(`${n.file}:${n.line} says ${n.name} ${n.version}, but package.json has ${installed[n.name]}: re-check what this note guards, then update it`);
}
if (checked.length < 4) failures.push(`only ${checked.length} dependency notes on installed packages were found; the check would pass without checking anything`);

console.log(`${notes.length} dependency notes, ${checked.length} on installed packages`);
for (const f of failures) console.log(`FAIL - ${f}`);
console.log(failures.length ? `0/1 passed` : `1/1 passed`);
process.exit(failures.length ? 1 : 0);
