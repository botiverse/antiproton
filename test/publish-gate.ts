/**
 * What the publish gate does when it cannot judge a file.
 *
 * `scripts/publish-runs.sh` sends records to a world-readable bucket, so its
 * credential check sits on a path where a miss cannot be taken back. The check
 * has three answers — found, clean, could-not-run — and the third is the one
 * this suite is about: it has twice tried to collapse into "clean". First the
 * matcher was imported relative to the caller's directory, so running the
 * script from anywhere else failed the import, exited non-zero, and published
 * a token (cody, #354). Then the read and the match sat outside the try, so a
 * plugin whose looksLike regex throws would exit 1, which the caller reads as
 * clean (Ada, #354).
 *
 * Every case here stops before the upload branch, so the suite needs no
 * network and no bucket.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** A tree the script can run in: its own copy of the script, one record, and
 *  whatever cf/src/secret-shape.ts the case wants it to find. */
function root(record: string, matcher: string | null, mode = 0o644): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-gate-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "report/runs/2026-01-01"), { recursive: true });
  copyFileSync(join(REPO, "scripts/publish-runs.sh"), join(dir, "scripts/publish-runs.sh"));
  const file = join(dir, "report/runs/2026-01-01/record.log");
  writeFileSync(file, record);
  chmodSync(file, mode);
  if (matcher !== null) {
    mkdirSync(join(dir, "cf/src"), { recursive: true });
    writeFileSync(join(dir, "cf/src/secret-shape.ts"), matcher);
  }
  return dir;
}

/** The token the script needs to reach the bucket. Every case here stops
 *  before the upload, so its value is never used — but without one set, the
 *  script refuses at the top, which is a different case (below). */
const WITH_TOKEN = { ...process.env, CF_API_TOKEN: "unused-tests-stop-before-upload" };

/** Runs the script in `dir` and reports how it ended. */
function run(dir: string, env: NodeJS.ProcessEnv = WITH_TOKEN): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [join(dir, "scripts/publish-runs.sh")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const WORKING = `export function secretMatch(t) { return /gho_[A-Za-z0-9]{36}/.test(t) ? { kind: "github-token", plugins: ["github"] } : null; }`;
const THROWS = `export function secretMatch() { throw new TypeError("Invalid regular expression: missing )"); }`;

check("a matcher that throws stops the publish instead of passing the file", () => {
  const dir = root("an ordinary line\n", THROWS);
  const { code, out } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  if (code !== 2) throw new Error(`a throwing matcher ended with ${code}, not 2 — 1 would mean the file counted as clean: ${out}`);
  if (!out.includes("STOPPED")) throw new Error(`nothing said the publish stopped: ${out}`);
});

check("a matcher that cannot be imported stops the publish", () => {
  const dir = root("an ordinary line\n", null);
  const { code, out } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  if (code !== 2) throw new Error(`a missing matcher ended with ${code}, not 2: ${out}`);
});

check("a record that cannot be read stops the publish", () => {
  const dir = root("an ordinary line\n", WORKING, 0o000);
  const { code, out } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  if (code !== 2) throw new Error(`an unreadable record ended with ${code}, not 2: ${out}`);
});

check("a credential the matcher recognises is refused, not published", () => {
  const dir = root(`token gho_${"A".repeat(36)}\n`, WORKING);
  const { code, out } = run(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!out.includes("REFUSED")) throw new Error(`the credential was not refused: ${out}`);
  if (code === 0) throw new Error(`a run that refused a file reported success (${code})`);
});

check("with no token at all, it stops before reading or fetching anything", () => {
  // wrangler reads CLOUDFLARE_API_TOKEN and the credential file calls it
  // CF_API_TOKEN, so the first run of this script failed at the upload with
  // every check already passed (Vera, 2026-09-16). It must say so at the top.
  const { CF_API_TOKEN, CLOUDFLARE_API_TOKEN, ...bare } = process.env;
  const dir = root(`token gho_${"A".repeat(36)}\n`, WORKING);
  const { code, out } = run(dir, bare);
  rmSync(dir, { recursive: true, force: true });
  if (code !== 3) throw new Error(`a missing token ended with ${code}, not 3: ${out}`);
  if (!out.includes("CLOUDFLARE_API_TOKEN") || !out.includes("CF_API_TOKEN")) {
    throw new Error(`the refusal does not name both variables, so a reader cannot act on it: ${out}`);
  }
  // A credential sat in that file, and the run ended before anything read it.
  if (out.includes("REFUSED")) throw new Error(`it read the records before asking for a token: ${out}`);
});

check("publishing the same key twice leaves one row for it, not two", () => {
  // scripts/publish-runs.sh appended a row for every upload without asking
  // whether that key was already listed, so writing the manifest first and
  // publishing second duplicated the key — it happened twice in one day (Vera).
  // A duplicate passes every "does it resolve" check, because both copies name
  // the same object and both fetch 200.
  //
  // This is the first case here that reaches the upload branch, and it has to
  // be: asserting the script's *text* does not bite. A blind append spelled
  // `>>"$MANIFEST"` satisfies such a check while duplicating, and renaming the
  // temp file breaks it while behaving identically (both measured, Piper and
  // Vera, 2026-09-16). What cannot be faked is running publish twice and
  // finding one row — that pins idempotence, not a spelling.
  //
  // It still needs no network: `npx` is a stub that reports success, and
  // PUBLISH_RUNS_BASE points at a closed port, so the "already in the bucket?"
  // fetch fails and falls through to the upload.
  const dir = root("an ordinary line\n", WORKING);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npx"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "npx"), 0o755);
  const env = {
    ...WITH_TOKEN,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PUBLISH_RUNS_BASE: "http://127.0.0.1:9",
  };
  const first = run(dir, env);
  const second = run(dir, env);
  const manifest = join(dir, "report/runs/manifest.tsv");
  let rows: string[] = [];
  try {
    rows = readFileSync(manifest, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no manifest was written, so the upload branch was never reached: ${first.out}${second.out}`);
  }
  rmSync(dir, { recursive: true, force: true });
  if (rows.length === 0) throw new Error(`the manifest is empty after two publishes: ${first.out}${second.out}`);
  const keys = rows.map((l) => l.split("\t")[0]);
  const distinct = new Set(keys);
  if (rows.length !== distinct.size) {
    throw new Error(`${rows.length} rows for ${distinct.size} key(s) — publishing twice duplicated a row:\n${rows.join("\n")}`);
  }
});

console.log(`\n  Publish gate\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
