/**
 * cf/scripts/deploy-pinned.sh: deploys origin/master from a worktree of its
 * own, and leaves the checkout it was run from alone.
 *
 * Asked of the real script in a repository built for the purpose: origin is a
 * bare repository beside it (no network), the gate and deploy.sh it would run
 * are stubs that write down where and on what they ran, and `npm` and `curl`
 * are stubs on PATH, the second answering with the build the test says is live.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const here = process.cwd();
const script = join(here, "cf/scripts/deploy-pinned.sh");
const scratch = mkdtempSync(join(tmpdir(), "deploy-pinned-"));
let n = 0;

function fixture() {
  const base = join(scratch, `f${++n}`), repo = join(base, "repo"), origin = join(base, "origin.git");
  const bin = join(base, "bin"), root = join(base, "wts"), calls = join(base, "calls");
  mkdirSync(join(repo, "cf/scripts"), { recursive: true }); mkdirSync(bin); mkdirSync(root);
  copyFileSync(script, join(repo, "cf/scripts/deploy-pinned.sh"));
  // The gate and the deploy it runs, replaced: each appends what it ran on.
  const record = (what: string) =>
    `echo "${what} $(git rev-parse HEAD) $(pwd -P) \${ANTIPROTON_DEPLOY_COMMIT:-unset} \${ANTIPROTON_ENV_FILE:-unset} \${FIXTURE_SECRET:-unset} $*" >> "$CALLS"\n` +
    '[ -z "${FAIL_DEPLOY:-}" ]\n';
  writeFileSync(join(repo, "cf/scripts/verify-and-deploy.sh"), record("gate"));
  writeFileSync(join(repo, "cf/scripts/deploy.sh"), record("deploy"));
  writeFileSync(join(bin, "npm"), '#!/usr/bin/env bash\necho "npm $(pwd -P) $*" >> "$CALLS"\n');
  writeFileSync(join(bin, "curl"), '#!/usr/bin/env bash\necho "{\\"build\\":\\"$(cat "$LIVE")\\"}"\n');
  chmodSync(join(bin, "npm"), 0o755); chmodSync(join(bin, "curl"), 0o755);
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  git("add", "-A"); git("commit", "-qm", "one");
  const older = git("rev-parse", "HEAD");
  // The commit deployed lists the one before it as a deploy floor.
  writeFileSync(join(repo, "cf/deploy-floors.txt"), `# fixture floor\n${older}\n`);
  writeFileSync(join(repo, "b.txt"), "two\n"); git("add", "-A"); git("commit", "-qm", "two");
  const sha = git("rev-parse", "HEAD");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin); git("push", "-q", "origin", "master");
  // The checkout it is run from stands somewhere else, as a shared one may: the deploy must be origin/master all the same.
  git("checkout", "-q", older);
  const env = join(base, "antiproton.env"), live = join(base, "live");
  writeFileSync(env, "FIXTURE_SECRET=from-the-env-file\n");
  writeFileSync(live, sha.slice(0, 7));
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync("bash", [join(repo, "cf/scripts/deploy-pinned.sh"), ...args], {
      encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: base, CALLS: calls, LIVE: live,
        ANTIPROTON_ENV_FILE: env, DEPLOY_PINNED_ROOT: root, ...extra },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
  };
  return { base, repo, git, older, sha, root, env, live, run };
}

/** Makes origin/master a new commit on `parent` whose cf/deploy-floors.txt is
 * `floors` (none when null), then puts the checkout back where it stood. */
function target(f: ReturnType<typeof fixture>, parent: string, floors: string | null) {
  f.git("checkout", "-q", parent);
  if (floors === null) f.git("rm", "-q", "--ignore-unmatch", "cf/deploy-floors.txt");
  else { writeFileSync(join(f.repo, "cf/deploy-floors.txt"), floors); f.git("add", "cf/deploy-floors.txt"); }
  writeFileSync(join(f.repo, "c.txt"), `${Math.random()}\n`); f.git("add", "c.txt");
  f.git("commit", "-qm", "target");
  const sha = f.git("rev-parse", "HEAD");
  f.git("push", "-qf", "origin", "HEAD:master");
  f.git("checkout", "-q", f.older);
  writeFileSync(f.live, sha.slice(0, 7));
  return sha;
}

const worktrees = (f: ReturnType<typeof fixture>) => f.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

check("the script parses", () => {
  const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
});

check("production: the gate runs in a fresh worktree at origin/master, the live build is read, and the worktree is removed", () => {
  const f = fixture();
  const r = f.run([]);
  if (r.status !== 0) throw new Error(`exited ${r.status}:\n${r.out}`);
  const npm = r.calls.find((l) => l.startsWith("npm "));
  const gate = r.calls.find((l) => l.startsWith("gate "))?.split(" ");
  if (!npm?.includes(" ci ")) throw new Error(`npm ci did not run: ${r.calls.join("\n")}`);
  if (!gate) throw new Error(`the gate did not run:\n${r.out}`);
  if (gate[1] !== f.sha) throw new Error(`the gate ran on ${gate[1]}, not origin/master ${f.sha}`);
  if (!gate[2].startsWith(f.root)) throw new Error(`the gate ran in ${gate[2]}, not a worktree under ${f.root}`);
  if (gate[4] !== f.env) throw new Error(`the gate was not told the env file: ${gate[4]}`);
  if (!new RegExp(`^STEP live build ${f.sha.slice(0, 7)} read \\d\\d:\\d\\d:\\d\\dZ$`, "m").test(r.out)) throw new Error(`no timed live build line:\n${r.out}`);
  if (f.git("rev-parse", "HEAD") !== f.older) throw new Error("the checkout it was run from was moved");
  if (worktrees(f) !== 1 || readdirSync(f.root).length !== 0) throw new Error(`the worktree was left behind: ${readdirSync(f.root).join(", ")}`);
});

check("preview: deploy.sh runs with the env file sourced and the commit pinned", () => {
  const f = fixture();
  const r = f.run(["--preview"]);
  if (r.status !== 0) throw new Error(`exited ${r.status}:\n${r.out}`);
  const d = r.calls.find((l) => l.startsWith("deploy "))?.split(" ");
  if (!d) throw new Error(`deploy.sh did not run:\n${r.out}`);
  if (r.calls.some((l) => l.startsWith("gate "))) throw new Error("a preview ran the production gate");
  if (d[1] !== f.sha || d[3] !== f.sha) throw new Error(`deploy.sh ran on ${d[1]} pinned to ${d[3]}, not ${f.sha}`);
  if (d[5] !== "from-the-env-file") throw new Error(`the env file was not sourced: ${d[5]}`);
  if (!d.slice(6).join(" ").includes("--config wrangler.preview.jsonc")) throw new Error(`not the preview config: ${d.slice(6).join(" ")}`);
  if (worktrees(f) !== 1) throw new Error("the worktree was left behind");
});

check("a failed deploy fails the script, and still removes the worktree", () => {
  const f = fixture();
  const r = f.run([], { FAIL_DEPLOY: "1" });
  if (r.status === 0 || !r.out.includes("STEP deploy FAILED")) throw new Error(`exited ${r.status}:\n${r.out}`);
  if (r.out.includes("STEP live build")) throw new Error("read the live build after a failed deploy");
  if (worktrees(f) !== 1 || readdirSync(f.root).length !== 0) throw new Error("the worktree was left behind");
});

check("a live build that is not the commit fails the script", () => {
  // One reading only: the stub answers at once, and the script's retries
  // would otherwise make this case take two minutes.
  const f = fixture();
  writeFileSync(f.live, f.older.slice(0, 7));
  const r = spawnSync("bash", ["-c", 'sleep() { :; }; export -f sleep; exec bash "$@"', "x", join(f.repo, "cf/scripts/deploy-pinned.sh"), "--preview"], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, PATH: `${join(f.base, "bin")}:${process.env.PATH}`, HOME: f.base, CALLS: join(f.base, "calls"), LIVE: f.live,
      ANTIPROTON_ENV_FILE: f.env, DEPLOY_PINNED_ROOT: f.root },
  });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status === 0 || !out.includes(`STEP live build MISMATCH (expected ${f.sha.slice(0, 7)})`)) throw new Error(`exited ${r.status}:\n${out}`);
  if (worktrees(f) !== 1) throw new Error("the worktree was left behind");
});

check("a worktree that cannot be made stops it before anything runs", () => {
  const f = fixture();
  const notADir = join(f.base, "a-file");
  writeFileSync(notADir, "x\n");
  const r = f.run([], { DEPLOY_PINNED_ROOT: notADir });
  if (r.status === 0 || !r.out.includes("STEP worktree FAILED")) throw new Error(`exited ${r.status}:\n${r.out}`);
  if (r.calls.length) throw new Error(`ran anyway: ${r.calls.join("\n")}`);
  if (worktrees(f) !== 1) throw new Error("a worktree was registered");
});

check("an origin that cannot be fetched stops it before anything runs", () => {
  const f = fixture();
  f.git("remote", "set-url", "origin", join(f.base, "no-such-origin.git"));
  const r = f.run([]);
  if (r.status === 0 || !r.out.includes("STEP fetch FAILED")) throw new Error(`exited ${r.status}:\n${r.out}`);
  if (r.calls.length) throw new Error(`ran anyway: ${r.calls.join("\n")}`);
});

check("an env file that cannot be read stops it before anything runs", () => {
  const f = fixture();
  const r = f.run([], { ANTIPROTON_ENV_FILE: join(f.base, "missing.env") });
  if (r.status === 0 || !r.out.includes("STEP env FAILED")) throw new Error(`exited ${r.status}:\n${r.out}`);
  if (r.calls.length) throw new Error(`ran anyway: ${r.calls.join("\n")}`);
});

const REASON = "the provisioning DELETE answers changed";
const refusedEarly = (r: { status: number | null; out: string; calls: string[] }, text: string) => {
  if (r.status === 0 || !r.out.includes(text)) throw new Error(`expected a refusal containing ${JSON.stringify(text)}; exited ${r.status}:\n${r.out}`);
  if (r.calls.length) throw new Error(`ran anyway: ${r.calls.join("\n")}`);
};

check("floors: a target that has every floor as an ancestor passes the floor check", () => {
  const f = fixture();
  for (const args of [[], ["--preview"]]) {
    const r = f.run(args);
    if (r.status !== 0 || !r.out.includes("STEP floor ok (1 checked)")) throw new Error(`exited ${r.status}:\n${r.out}`);
  }
});

check("floors: a target older than a floor is refused, naming the floor and its reason, before anything runs", () => {
  const f = fixture();
  // The floor is f.sha; the target is built on the commit before it.
  target(f, f.older, `# header\n\n# ${REASON}\n${f.sha}  # guarded by: deploy check\n`);
  for (const args of [[], ["--preview"]]) refusedEarly(f.run(args), `floor not satisfied: ${f.sha} ${REASON} guarded by: deploy check)`);
});

check("floors: a target without cf/deploy-floors.txt predates every floor and is refused", () => {
  const f = fixture();
  target(f, f.older, null);
  refusedEarly(f.run([]), "predates every deploy floor");
});

check("floors: a floor that is not a commit here is \"cannot check\", never a pass", () => {
  const f = fixture();
  target(f, f.sha, `${"0123456789abcdef".repeat(2)}01234567\n`);
  refusedEarly(f.run([]), "cannot check floor 0123456789abcdef");
  refusedEarly(f.run([]), "this is not a floor violation");
});

check("floors: git answering the ancestry question with neither 0 nor 1 is \"cannot check\", never a pass", () => {
  const f = fixture();
  // A git that fails merge-base (as a corrupt object store would, exit 128)
  // and is the real git for everything else.
  const stub = join(f.base, "gitstub"); mkdirSync(stub);
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(stub, "git"), `#!/usr/bin/env bash\ncase " $* " in *" merge-base "*) exit 128 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(stub, "git"), 0o755);
  const r = f.run([], { PATH: `${stub}:${join(f.base, "bin")}:${process.env.PATH}` });
  refusedEarly(r, `cannot check floor ${f.older}: commit missing locally or git error 128`);
});

check("floors: an entry that is not a full 40-character SHA is refused", () => {
  const f = fixture();
  target(f, f.sha, `${f.older.slice(0, 12)}\n`);
  refusedEarly(f.run([]), "not a full 40-character SHA");
});

check("floors: a floor this checkout lists but the target's file dropped still holds", () => {
  const f = fixture();
  const t = target(f, f.older, `${f.older}\n`);
  writeFileSync(join(f.repo, "cf/deploy-floors.txt"), `# ${REASON}\n${f.sha}\n`);
  refusedEarly(f.run(["--preview"]), `floor not satisfied: ${f.sha} ${REASON} [listed in this checkout's cf/deploy-floors.txt but not in ${t.slice(0, 7)}'s]`);
  const r = f.run(["--preview"], { DEPLOY_BELOW_FLOOR: f.sha, DEPLOY_BELOW_FLOOR_REASON: "drill" });
  if (r.status !== 0 || !new RegExp(`STEP deploy crossed floor ${f.sha} at \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ: drill`).test(r.out)) throw new Error(`exited ${r.status}:\n${r.out}`);
});

check("floors: DEPLOY_BELOW_FLOOR must name the exact floor crossed and give a reason; then it deploys, loudly, and the next deploy above every floor says so", () => {
  const f = fixture();
  const t = target(f, f.older, `# ${REASON}\n${f.sha}\n`);
  refusedEarly(f.run(["--preview"], { DEPLOY_BELOW_FLOOR: f.older, DEPLOY_BELOW_FLOOR_REASON: "rollback" }), `floor not satisfied: ${f.sha}`);
  refusedEarly(f.run(["--preview"], { DEPLOY_BELOW_FLOOR: f.sha.slice(0, 12), DEPLOY_BELOW_FLOOR_REASON: "rollback" }), `floor not satisfied: ${f.sha}`);
  refusedEarly(f.run(["--preview"], { DEPLOY_BELOW_FLOOR: `${f.sha} ${f.older}`, DEPLOY_BELOW_FLOOR_REASON: "rollback" }), `DEPLOY_BELOW_FLOOR names ${f.older}`);
  refusedEarly(f.run(["--preview"], { DEPLOY_BELOW_FLOOR: f.sha }), "DEPLOY_BELOW_FLOOR needs DEPLOY_BELOW_FLOOR_REASON");
  refusedEarly(f.run(["--preview"], { DEPLOY_BELOW_FLOOR_REASON: "rollback" }), "names no floor");
  const r = f.run(["--preview"], { DEPLOY_BELOW_FLOOR: f.sha, DEPLOY_BELOW_FLOOR_REASON: "rollback for an outage" });
  if (r.status !== 0) throw new Error(`exited ${r.status}:\n${r.out}`);
  if (!new RegExp(`STEP deploy crossed floor ${f.sha} at \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ: rollback for an outage`).test(r.out)) throw new Error(`no crossed-floor line:\n${r.out}`);
  if (!r.out.includes("Tell Raft (AppFather)")) throw new Error(`no warning to tell Raft:\n${r.out}`);
  if (r.calls.find((l) => l.startsWith("deploy "))?.split(" ")[1] !== t) throw new Error(`did not deploy ${t}:\n${r.calls.join("\n")}`);
  const marker = join(f.base, "tmp/antiproton-below-floor.preview");
  if (!existsSync(marker)) throw new Error("no marker left for the next deploy");
  // Back above: a target that contains the floor.
  target(f, f.sha, `${f.sha}\n`);
  const back = f.run(["--preview"]);
  if (back.status !== 0 || !back.out.includes(`STEP back above all floors (previous deploy crossed ${f.sha})`)) throw new Error(`exited ${back.status}:\n${back.out}`);
  if (existsSync(marker)) throw new Error("the marker was not removed");
  const again = f.run(["--preview"]);
  if (again.status !== 0 || again.out.includes("back above")) throw new Error(`reported twice:\n${again.out}`);
});

console.log(`\n  Deploy from a pinned worktree\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
