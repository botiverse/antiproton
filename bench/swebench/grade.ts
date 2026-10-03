/**
 * SWE-bench's own grading, for both runners (bench/swebench/cf.ts on the object, bench/swebench/run.ts in
 * process), run in the box the agent worked in.
 *
 * Taken from the SWE-bench harness at tag v4.1.0, read on 2026-10-03:
 *   - the test command per repository and version: swebench/harness/constants/python.py, `test_cmd` and
 *     `eval_commands` in MAP_REPO_VERSION_TO_SPECS_PY;
 *   - which tests run: test_spec/python.py `get_test_directives`, the files the test patch touches;
 *   - which files are reset before the test patch: test_spec/python.py `make_eval_script_list_py`, the files
 *     the test patch *modifies*, checked out at the base commit (utils.py `get_modified_files`);
 *   - how a log becomes per-test statuses: log_parsers/python.py `MAP_REPO_TO_PARSER_PY`;
 *   - what counts as resolved: grading.py `test_passed` / `test_failed` / `get_resolution_status` (FULL only).
 *
 * One step of the harness is left out, on purpose: it re-runs the repository's install command before the
 * tests. The box has no network by default (cf/src/index.ts `benchSweStart`), so a `pip install` there
 * cannot fetch build dependencies, and every repository in SWE-bench Verified except requests is installed
 * editable in its image, so a change to a Python file is already what gets imported. A change to a compiled
 * extension (astropy, scikit-learn, matplotlib) is not rebuilt, so such an instance can grade lower here than
 * in the harness.
 */
import { gunzipSync } from "node:zlib";

export interface GradedInstance {
  instance_id: string;
  repo: string;
  version: string;
  base_commit: string;
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

const PYTEST = "pytest -rA";
const DJANGO = "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1";
const DJANGO_LOCALE = ["export LANG=en_US.UTF-8", "export LC_ALL=en_US.UTF-8", "export PYTHONIOENCODING=utf8", "export LANGUAGE=en_US:en"];

/** The test command, per repository, with the versions where SWE-bench uses another. */
const TEST_CMD: Record<string, { cmd: string; byVersion?: Record<string, string> }> = {
  "astropy/astropy": {
    cmd: PYTEST,
    byVersion: Object.fromEntries(["0.1", "0.2", "0.3", "0.4", "1.1", "1.2", "1.3"]
      .map((v) => [v, "pytest -rA -vv -o console_output_style=classic --tb=no"])),
  },
  "django/django": { cmd: DJANGO, byVersion: { "1.9": "./tests/runtests.py --verbosity 2" } },
  "matplotlib/matplotlib": { cmd: PYTEST },
  "mwaskom/seaborn": { cmd: "pytest --no-header -rA" },
  "pallets/flask": { cmd: PYTEST },
  "psf/requests": { cmd: PYTEST },
  "pydata/xarray": { cmd: PYTEST },
  "pylint-dev/pylint": { cmd: PYTEST },
  "pytest-dev/pytest": { cmd: PYTEST },
  "scikit-learn/scikit-learn": { cmd: PYTEST },
  "sphinx-doc/sphinx": { cmd: "tox --current-env -epy39 -v --" },
  "sympy/sympy": { cmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose" },
};

/** Commands run before the tests, where SWE-bench has any (django's locale). */
function evalCommands(repo: string, version: string): string[] {
  if (repo !== "django/django") return [];
  if (["3.0", "3.1", "3.2"].includes(version)) {
    return ["sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen", "export LANG=en_US.UTF-8",
      "export LANGUAGE=en_US:en", "export LC_ALL=en_US.UTF-8"];
  }
  return ["1.7", "1.8", "1.9", "1.10", "1.11", "2.0", "2.1", "2.2"].includes(version) ? DJANGO_LOCALE : [];
}

/** The repository's test command. A repository not in the table is refused: a guessed command grades nothing. */
export function testCommand(repo: string, version: string): string {
  const spec = TEST_CMD[repo];
  if (!spec) throw new Error(`no SWE-bench test command known for ${repo}; add it from the harness's specs`);
  return spec.byVersion?.[version] ?? spec.cmd;
}

const NON_TEST_EXTS = [".json", ".png", "csv", ".txt", ".md", ".jpg", ".jpeg", ".pkl", ".yml", ".yaml", ".toml"];

/** What the test command is given: the files the test patch touches, as django names modules. */
export function testDirectives(inst: Pick<GradedInstance, "repo" | "test_patch">): string[] {
  const files = [...inst.test_patch.matchAll(/diff --git a\/.* b\/(.*)/g)].map((m) => m[1]!)
    .filter((d) => !NON_TEST_EXTS.some((ext) => d.endsWith(ext)));
  if (inst.repo !== "django/django") return files;
  return files.map((d) => {
    let x = d.endsWith(".py") ? d.slice(0, -3) : d;
    if (x.startsWith("tests/")) x = x.slice("tests/".length);
    return x.replace(/\//g, ".");
  });
}

/**
 * The files a patch modifies (not the ones it creates): the source path of every file whose source is not
 * /dev/null. Read per file block, from its `--- ` header line before the first hunk, so a removed line that
 * happens to begin with `--` inside a hunk is never taken for a header.
 */
export function modifiedFiles(patch: string): string[] {
  const out: string[] = [];
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { inHeader = true; continue; }
    if (!inHeader) continue;
    if (line.startsWith("@@")) { inHeader = false; continue; }
    if (line.startsWith("--- ")) {
      const src = line.slice(4).split("\t")[0]!.trim();
      if (src.startsWith("a/")) out.push(src.slice(2));
      inHeader = false;
    }
  }
  return out;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const GRADE_LOG = "/tmp/swe-grade.log";
export const APPLY_FAILED = ">>>>> Patch Apply Failed";
export const START = ">>>>> Start Test Output";
export const END = ">>>>> End Test Output";

/**
 * One shell command that grades: reset the files the test patch modifies to the base commit, apply the test
 * patch, run the repository's test command over the test patch's files, and leave the whole log, gzipped, at
 * `${GRADE_LOG}.gz`. It prints only the log's size, so its own answer is never the thing that gets cut.
 */
export function gradeCommand(inst: GradedInstance, workdir = "/testbed"): string {
  const reset = modifiedFiles(inst.test_patch);
  const b64 = Buffer.from(inst.test_patch, "utf8").toString("base64");
  const test = [testCommand(inst.repo, inst.version), ...testDirectives(inst).map(q)].join(" ");
  return [
    `cd ${q(workdir)}`,
    ...evalCommands(inst.repo, inst.version),
    `git config --global --add safe.directory ${q(workdir)} >/dev/null 2>&1`,
    `{`,
    ...(reset.length ? [`git checkout ${q(inst.base_commit)} -- ${reset.map(q).join(" ")} || echo ${q(">>>>> Reset Failed")}`] : []),
    `printf %s ${q(b64)} | base64 -d > /tmp/swe-test.patch`,
    `if git apply -v /tmp/swe-test.patch; then`,
    `echo ${q(START)}`,
    `${test}`,
    `echo ${q(END)}`,
    `else echo ${q(APPLY_FAILED)}; fi`,
    `} > ${GRADE_LOG} 2>&1`,
    `gzip -c ${GRADE_LOG} > ${GRADE_LOG}.gz`,
    `echo "log_gz_bytes=$(wc -c < ${GRADE_LOG}.gz)"`,
  ].join("\n");
}

// ------------------------------------------------------------ log parsers (log_parsers/python.py)

type StatusMap = Record<string, string>;
const STATUSES = ["FAILED", "PASSED", "SKIPPED", "ERROR", "XFAIL"];

function parsePytest(log: string): StatusMap {
  const m: StatusMap = {};
  for (let line of log.split("\n")) {
    if (!STATUSES.some((s) => line.startsWith(s))) continue;
    if (line.startsWith("FAILED")) line = line.replace(/ - /g, " ");
    const t = line.split(/\s+/).filter(Boolean);
    if (t.length > 1) m[t[1]!] = t[0]!;
  }
  return m;
}

function parsePytestOptions(log: string): StatusMap {
  const m: StatusMap = {};
  for (let line of log.split("\n")) {
    if (!STATUSES.some((s) => line.startsWith(s))) continue;
    if (line.startsWith("FAILED")) line = line.replace(/ - /g, " ");
    const t = line.split(/\s+/).filter(Boolean);
    if (t.length <= 1) continue;
    const opt = /(.*?)\[(.*)\]/.exec(t[1]!);
    let name = t[1]!;
    if (opt) {
      let option = opt[2]!;
      if (option.startsWith("/") && !option.startsWith("//") && !option.includes("*")) option = "/" + option.split("/").pop();
      name = `${opt[1]}[${option}]`;
    }
    m[name] = t[0]!;
  }
  return m;
}

function parsePytestV2(log: string): StatusMap {
  const m: StatusMap = {};
  for (let line of log.split("\n")) {
    line = line.replace(/\[(\d+)m/g, "").replace(/[\x01-\x1f]/g, "");
    if (STATUSES.some((s) => line.startsWith(s))) {
      if (line.startsWith("FAILED")) line = line.replace(/ - /g, " ");
      const t = line.split(/\s+/).filter(Boolean);
      if (t.length >= 2) m[t[1]!] = t[0]!;
    } else if (STATUSES.some((s) => line.endsWith(s))) {
      const t = line.split(/\s+/).filter(Boolean);
      if (t.length >= 2) m[t[0]!] = t[1]!;
    }
  }
  return m;
}

function parseSeaborn(log: string): StatusMap {
  const m: StatusMap = {};
  for (const line of log.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (line.startsWith("FAILED")) m[parts[1]!] = "FAILED";
    else if (line.includes(" PASSED ")) { if (parts[1] === "PASSED") m[parts[0]!] = "PASSED"; }
    else if (line.startsWith("PASSED")) m[parts[1]!] = "PASSED";
  }
  return m;
}

function parseMatplotlib(log: string): StatusMap {
  return parsePytest(log.replace(/MouseButton\.LEFT/g, "1").replace(/MouseButton\.RIGHT/g, "3"));
}

function parseSympy(log: string): StatusMap {
  const m: StatusMap = {};
  for (const x of log.matchAll(/(_*) (.*)\.py:(.*) (_*)/g)) m[`${x[2]}.py:${x[3]}`] = "FAILED";
  for (let line of log.split("\n")) {
    line = line.trim();
    if (!line.startsWith("test_")) continue;
    const name = line.split(/\s+/)[0]!;
    if (line.endsWith(" E")) m[name] = "ERROR";
    if (line.endsWith(" F")) m[name] = "FAILED";
    if (line.endsWith(" ok")) m[name] = "PASSED";
  }
  return m;
}

function parseDjango(log: string): StatusMap {
  const m: StatusMap = {};
  let prev: string | null = null;
  for (let line of log.split("\n")) {
    line = line.trim();
    if (line.includes("--version is equivalent to version")) m["--version is equivalent to version"] = "PASSED";
    if (line.includes(" ... ")) prev = line.split(" ... ")[0]!;
    for (const suffix of [" ... ok", " ... OK", " ...  OK"]) {
      if (line.endsWith(suffix)) {
        if (line.startsWith("Applying sites.0002_alter_domain_unique...test_no_migrations")) {
          line = line.split("...").slice(1).join("...").trim();
        }
        m[line.slice(0, line.lastIndexOf(suffix))] = "PASSED";
        break;
      }
    }
    if (line.includes(" ... skipped")) m[line.split(" ... skipped")[0]!] = "SKIPPED";
    if (line.endsWith(" ... FAIL")) m[line.split(" ... FAIL")[0]!] = "FAILED";
    if (line.startsWith("FAIL:")) m[line.split(/\s+/)[1]!.trim()] = "FAILED";
    if (line.endsWith(" ... ERROR")) m[line.split(" ... ERROR")[0]!] = "ERROR";
    if (line.startsWith("ERROR:")) m[line.split(/\s+/)[1]!.trim()] = "ERROR";
    if (line.startsWith("ok") && prev !== null) m[prev] = "PASSED";
  }
  for (const re of [
    /^(.*?)\s\.\.\.\sTesting against Django installed in ([\s\S]*?) silenced\)\.\nok$/gm,
    /^(.*?)\s\.\.\.\sInternal Server Error: \/(.*)\/\nok$/gm,
    /^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$/gm,
  ]) for (const x of log.matchAll(re)) m[x[1]!] = "PASSED";
  return m;
}

const PARSER: Record<string, (log: string) => StatusMap> = {
  "astropy/astropy": parsePytestV2,
  "django/django": parseDjango,
  "matplotlib/matplotlib": parseMatplotlib,
  "mwaskom/seaborn": parseSeaborn,
  "pallets/flask": parsePytest,
  "psf/requests": parsePytestOptions,
  "pydata/xarray": parsePytest,
  "pylint-dev/pylint": parsePytestOptions,
  "pytest-dev/pytest": parsePytest,
  "scikit-learn/scikit-learn": parsePytestV2,
  "sphinx-doc/sphinx": parsePytestV2,
  "sympy/sympy": parseSympy,
};

/** Per-test statuses from a grading log, read between the markers, or from the whole log if that finds none. */
export function parseTestLog(repo: string, log: string): StatusMap {
  const parse = PARSER[repo];
  if (!parse) throw new Error(`no SWE-bench log parser known for ${repo}`);
  const between = log.includes(START) && log.includes(END) ? log.split(START)[1]!.split(END)[0]! : "";
  const m = parse(between);
  return Object.keys(m).length ? m : parse(log);
}

// ------------------------------------------------------------ the verdict (grading.py)

export interface GradeReport {
  resolved: boolean;
  /** Why nothing was graded, when nothing was: the test patch did not apply, a reset failed, or no log. */
  error?: string;
  failToPass: { total: number; passed: number; failed: string[] };
  passToPass: { total: number; passed: number; failed: string[] };
}

const passed = (t: string, m: StatusMap) => t in m && (m[t] === "PASSED" || m[t] === "XFAIL");
const failed = (t: string, m: StatusMap) => !(t in m) || m[t] === "FAILED" || m[t] === "ERROR";

/** Every FAIL_TO_PASS and PASS_TO_PASS test, against the log. Resolved is SWE-bench's FULL: none failed. */
export function gradeFromLog(inst: GradedInstance, log: string): GradeReport {
  const f2p: string[] = JSON.parse(inst.FAIL_TO_PASS);
  const p2p: string[] = JSON.parse(inst.PASS_TO_PASS);
  const none = (ids: string[]) => ({ total: ids.length, passed: 0, failed: ids });
  const bad = [APPLY_FAILED, ">>>>> Reset Failed"].find((c) => log.includes(c))
    ?? (!(log.includes(START) && log.includes(END)) ? "the test output markers are missing" : undefined);
  if (bad) return { resolved: false, error: bad, failToPass: none(f2p), passToPass: none(p2p) };
  const m = parseTestLog(inst.repo, log);
  const side = (ids: string[]) => ({
    total: ids.length,
    passed: ids.filter((t) => passed(t, m)).length,
    failed: ids.filter((t) => failed(t, m)),
  });
  const failToPass = side(f2p), passToPass = side(p2p);
  return { resolved: failToPass.failed.length === 0 && passToPass.failed.length === 0, failToPass, passToPass };
}

// ------------------------------------------------------------ talking to the box

/** What a shell call answers, as far as grading reads it. */
export interface ShellAnswer {
  status: string;
  result?: any;
  error?: { code?: string; message?: string };
  background?: { alias: string; handle: unknown };
}

/**
 * A shell call's finished answer.
 *
 * The sandbox hands a command that outlives its grace window (5 s by default) to the background and answers
 * `running` with no output. Grading reads output, so it waits here, polling the job, until it ends or the
 * deadline passes. Waited for by the runner and not by the object: an object held open on a sleep loop is
 * billed for the whole of it, which is why the window exists (83f0658).
 */
export async function settleShell(
  first: ShellAnswer,
  poll: (bg: NonNullable<ShellAnswer["background"]>) => Promise<{ done: boolean; result?: any }>,
  o: { deadlineAt: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<ShellAnswer> {
  if (first.status !== "running" || !first.background) return first;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    if (now() > o.deadlineAt) {
      return { status: "failed", error: { code: "grading_timeout", message: "the grading command was still running at the deadline" } };
    }
    await sleep(o.intervalMs ?? 5_000);
    const p = await poll(first.background);
    if (p.done) return { status: "succeeded", result: p.result };
  }
}

/**
 * A file in the box, whole, read in pieces small enough that no piece is cut by the mount's output limit
 * (24,000 bytes): each piece is base64, and its decoded length is checked against what the file still holds,
 * so a piece that came back short fails the read instead of grading half a log.
 */
export async function readBoxFile(run: (command: string) => Promise<string>, path: string, chunk = 12_000): Promise<Buffer> {
  const size = Number((await run(`wc -c < ${q(path)}`)).trim());
  if (!Number.isFinite(size) || size < 0) throw new Error(`could not size ${path}`);
  const parts: Buffer[] = [];
  for (let off = 0; off < size; off += chunk) {
    const b = Buffer.from((await run(`tail -c +${off + 1} ${q(path)} | head -c ${chunk} | base64 -w0`)).trim(), "base64");
    const want = Math.min(chunk, size - off);
    if (b.length !== want) throw new Error(`reading ${path} at ${off}: got ${b.length} bytes, expected ${want}`);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** The grading log the command above left, unzipped. */
export async function readGradeLog(run: (command: string) => Promise<string>): Promise<string> {
  return gunzipSync(await readBoxFile(run, `${GRADE_LOG}.gz`)).toString("utf8");
}
