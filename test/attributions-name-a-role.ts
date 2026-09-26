/**
 * An `@handle` in a comment says WHAT the person contributed, not only who.
 *
 * **It reads `@handle` only, and that is the narrower half.** The same
 * attribution written without the `@` — `(cody, 2026-09-12)` — is invisible
 * here, and that spelling is the repository's older and far more common one:
 * 24 in `src/plugins`, 12 in `cf/src`, 32 in `test`, against 26 with the `@`.
 * This case used to be called "no attribution … is a bare name", which claimed
 * the wider set; it was reviewed, gated and merged under that name, because
 * every check asked what the name said it asked. Worth keeping, because it is
 * the part that generalises past this file (@cody's phrasing): **the name of an
 * assertion travels further than its body.** A reader decides whether to read
 * the body FROM the name, so an over-wide name hides its own body — @Nova, who
 * approved the scope extension, measured the PATTERN (`\(@…\)` finds nothing in
 * `cf/src`) and never had reason to question what the case's name claimed. It is
 * the same position as an assertion that cannot reach its subject, from the
 * other side: one promises less than it checks, the other promises more, and
 * **both are green**. Sweeping the older spelling is
 * a judgement per site rather than an assertion (many of them point at a
 * reproducible observation and should stay), so it belongs in a cleanup someone
 * reads line by line — @Nova's call, and theirs is to leave the gate narrow.
 *
 * A name is the one claim in a comment a later reader cannot re-derive from
 * this repository, and no check can say whether it is the RIGHT name — that is
 * why two wrong ones survived three merges here. But one half of it is
 * mechanical: whether the name carries a role at all.
 *
 * The two defects @Rex traced (2026-09-20, #plugins:770a1824) both had the same
 * signature in the tree — `(@Rex, 2026-09-20)` and a bare `(@Nova)` — while
 * their three siblings said "@Rex found the shape" and "@Nova traced the fields
 * two hops further". One credits a person for a contribution a reader cannot
 * check against the thread; the others name the contribution, so a reader can.
 *
 * **Scope grows only where it was invited.** It began as this lane; `cf/src` was
 * added after @Nova repaired both sites there (#453) and said the extension was
 * mine to make. `test/` is still out, though no longer for the reason that stood
 * here: that one named a bare handle in `test/call-id-in-the-record.ts`, which
 * @cody removed in #433 — the file now holds no `@` at all. The hazard was real
 * (extending then would have landed an assertion FALSE on arrival, dragging the
 * true one red beside it — @Vera's correction of my weaker "a cross-PR dependency
 * in a gate"), but it has expired. What keeps `test/` out today is the paragraph
 * below: the fixtures in this file.
 *
 * This file is not in its own scope, because the defect appears here as a
 * fixture and would red the suite that quotes it. The cost is real: the three
 * names in this docblock are the ones nothing checks.
 *
 * **Adding a role is not the only repair, and often not the best one** (@Nova,
 * who is named at both defect sites and argued the opposite direction in
 * #plugins:770a1824): a check that only knows "bare" will push everyone toward
 * inventing a role, which keeps a name that should have gone. The question this
 * suite CANNOT ask is @Nova's — *what can a reader do with this name?* If it
 * points at something checkable (a thread, a reproducible observation) the role
 * is the other half of "where to look"; if it only records who thought of it,
 * **delete the name and keep the reason** — `#433` and `ac3fadd` were both repaired
 * that way. So the third case below asserts that the no-name repair PASSES, rather
 * than leaving it as advice in a comment nothing enforces.
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** JSDoc tags and the like: an `@` in a comment that is not a person. */
const NOT_A_PERSON = /^@(link|param|returns?|see|example|throws|deprecated|type|typedef|template|module|name|default|ts-[a-z-]+)$/;

/**
 * An attribution is a claim in a COMMENT, so only comment lines are read.
 *
 * The case that settles it is `test/raft-plugin.ts`'s `"Release Bot
 * (@raft-bot)"` assertion: that handle is a GitHub account inside a string
 * literal, and it matches the bare-name shape exactly. Asking its author what `@raft-bot` contributed is the
 * ritual @Nova warned about, arrived at by a scan that could not tell a comment
 * from data.
 */
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/**
 * A name with nothing after it but a date.
 *
 * The date is not a role: it says when, which the git record already says, and
 * not what — which only the thread says.
 *
 * The `@` may not follow a word character, or `git@github.com` and `user@host)`
 * in `cf/src/secret-shape.ts`'s `url-with-password` shape read as people — an
 * address is not a handle, and that comment is about credentials, not anyone.
 */
const BARE = /(?<![A-Za-z0-9_.\-])(@[A-Za-z][A-Za-z0-9_-]*)(?:\)|, 20[0-9]{2}-[0-9]{2}-[0-9]{2}\))/g;

/**
 * Directories are read, never globbed.
 *
 * `git ls-files 'test/**\/*.ts'` finds 3 of 95 and `'cf/src/**\/*.ts'` 10 of 47,
 * because `**` requires a directory level (@cody hit it on #433's scope and @Rex
 * reproduced it on this one before it reached here). **A glob's blind spot
 * answers with a small clean number rather than an error**.
 *
 * The walk is recursive because the opposite assumption is just as wrong: I read
 * "`cf/src` is flat" from those two numbers and wrote a flat `readdirSync`, and
 * the completeness case below caught it on its first run — 27 files read of 37
 * tracked, the other 10 in `agents-api/` and `vendor/`. **Both errors came from
 * believing a claim about the shape of the tree instead of asking it.**
 */
const DIRS = ["src/plugins", "cf/src"];
const NAMED = [
  "test/identity-wording.ts",
  "test/identity-in-the-record.ts",
  "test/github-errors.ts",
  "test/github-auth-status.ts",
];

/** Vendored copies: not ours to edit, so a rule about our comments does not reach them. */
const NOT_OURS = ["cf/src/vendor"];

function tsIn(dir: string): string[] {
  if (NOT_OURS.includes(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsIn(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : [],
  );
}

const FILES = [...DIRS.flatMap(tsIn), ...NAMED];

/** Every `@handle` in these files, bare or not, so the scan can prove it has a subject. */
function namesIn(text: string): string[] {
  return (text.match(/(?<![A-Za-z0-9_.\-])@[A-Za-z][A-Za-z0-9_-]*/g) ?? []).filter((n) => !NOT_A_PERSON.test(n));
}

/** The bare ones, as `file:line — the text that carries them`. */
function bareIn(file: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!COMMENT.test(line)) return;
    for (const m of line.matchAll(BARE)) {
      if (NOT_A_PERSON.test(m[1]!)) continue;
      out.push(`${file}:${i + 1} — ${line.trim()}`);
    }
  });
  return out;
}

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

check("no `@handle` in this lane is a bare name", () => {
  const bare = FILES.flatMap((f) => bareIn(f, readFileSync(f, "utf8")));
  if (bare.length > 0) {
    throw new Error(
      `a name with no role, so a reader cannot check it against the thread — repair it EITHER way:\n` +
      `      say what the person contributed, or delete the name and keep the reason\n      ` +
      bare.join("\n      "),
    );
  }
});

check("the scan can still reach its subject", () => {
  // Without this, deleting every attribution would make the check above pass by
  // having nothing to look at — "nothing ran" reading as "all passed", one level
  // up (@cody's gate rule, which caught exactly that on `identity-wording.ts`).
  const found = FILES.flatMap((f) => namesIn(readFileSync(f, "utf8")));
  if (found.length === 0) {
    throw new Error("no attribution anywhere in scope, so this suite is no longer asking anything");
  }
});

check("every `.ts` in a scanned directory is actually scanned", () => {
  // The guard above stops an EMPTY scope; it cannot see a PARTIAL one, and 10
  // files of 47 would pass green (@Rex, who checked this suite's scope against
  // @cody's glob before the extension reached it). So a second instrument counts
  // the same directories: `git ls-files`, which knows nothing about `readdirSync`.
  for (const dir of DIRS) {
    const tracked = execFileSync("git", ["ls-files", `${dir}/*.ts`], { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .filter((f) => !NOT_OURS.some((skip) => f.startsWith(`${skip}/`)));
    const scanned = tsIn(dir);
    if (tracked.length !== scanned.length) {
      const missing = tracked.filter((f) => !scanned.includes(f));
      throw new Error(
        `${dir}: git tracks ${tracked.length} \`.ts\` files and this suite reads ${scanned.length}` +
        (missing.length ? ` — unread: ${missing.join(", ")}` : "") +
        ` (a subdirectory appearing here is the likely cause, and it is a decision rather than a bug)`,
      );
    }
  }
});

/** A commit cited in a comment, as `` `<sha>` ``. */
const CITED_SHA = /`([0-9a-f]{7,40})`/g;

/**
 * Where a cited commit stands relative to a tree: three answers, not two.
 *
 * `unreachable` is the defect — the address opens for whoever wrote it and for
 * nobody else. `ahead` is not a defect in the comment at all: the checkout is
 * behind the commit it names. @cody lost a reading to that shape minutes after
 * #461 merged (`git fetch` moves `origin/master`, not the tree you stand in),
 * and a red naming the wrong cause sends the next reader to edit a comment that
 * is correct.
 */
function standing(sha: string, at: string, cwd?: string): "ok" | "ahead" | "unreachable" {
  const ask = (a: string, b: string) => {
    try {
      execFileSync("git", [...(cwd ? ["-C", cwd] : []), "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
      return true;
    } catch { return false; }
  };
  if (ask(sha, at)) return "ok";
  return ask(at, sha) ? "ahead" : "unreachable";
}

check("every commit a comment cites is reachable from this history", () => {
  // @Nova's second step, as an assertion rather than a command someone remembers
  // to run: `git cat-file -e` says the object is in THIS clone, which is a
  // reading about the machine. A commit that lives only on a branch passes it —
  // and after a squash merge and a branch delete, nothing references it, so it
  // is gone here and never existed in a fresh clone. Reachability from HEAD is
  // what makes the address open for the next reader rather than for me.
  const bad: string[] = [];
  for (const f of FILES) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (!COMMENT.test(line)) return;
      for (const m of line.matchAll(CITED_SHA)) {
        const sha = m[1]!;
        const where = standing(sha, "HEAD");
        if (where === "ahead") {
          bad.push(`${f}:${i + 1} — \`${sha}\` is AHEAD of this checkout: the comment is fine and this working tree is stale (\`git fetch\` moves \`origin/master\`, not the tree you are in)`);
        } else if (where === "unreachable") {
          bad.push(`${f}:${i + 1} — \`${sha}\` is not reachable from HEAD, so it opens for whoever wrote it and nobody else`);
        }
      }
    });
  }
  if (bad.length > 0) throw new Error(`a dead address is worse than none:\n      ${bad.join("\n      ")}`);
});

check("unreachable, reachable and ahead are told apart, each from a real commit", () => {
  // The two states have to be told apart, or the case above would accept
  // whatever this clone happens to hold.
  //
  // Built in a throwaway repository rather than here: the first version made the
  // object with `commit-tree` in this one, which would leave a dangling commit
  // in every clone the gate runs in — mine, @Vera's, and the one
  // `verify-and-deploy.sh` uses before a deploy. @cody refused it for the reason
  // that matters more than the bytes: `gate.sh` says "Both are git reads;
  // neither touches production", and once running a check can change the thing
  // it checks, even slightly, that property does not come back. The property
  // needed is "SOME repository has such a commit", not this one.
  const dir = mkdtempSync(join(tmpdir(), "reachability-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q", ".");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");

    // AHEAD: a child of where we stand. Not an ancestor of HEAD — which is why
    // asking only that question is not enough, and it is the state @cody's
    // stale worktree was in.
    git("commit", "-q", "--allow-empty", "-m", "newer");
    const newer = git("rev-parse", "HEAD");
    git("checkout", "-q", base);

    // UNREACHABLE: a root of its own, so neither commit can reach the other.
    // A commit on a deleted branch does NOT serve here: it is a descendant of
    // base, so it is `ahead`, and using it would prove only the weaker claim.
    git("checkout", "-q", "--orphan", "elsewhere");
    git("commit", "-q", "--allow-empty", "-m", "unrelated");
    const unrelated = git("rev-parse", "HEAD");
    git("checkout", "-q", base);
    git("branch", "-qD", "elsewhere"); // nothing references it now
    git("cat-file", "-e", `${unrelated}^{commit}`); // …and it still exists

    if (standing(base, "HEAD", dir) !== "ok") throw new Error("the tree's own commit was not called reachable");
    if (standing(newer, "HEAD", dir) !== "ahead") throw new Error("a commit this tree is behind was not called ahead");
    if (standing(unrelated, "HEAD", dir) !== "unreachable") {
      throw new Error("a commit on an unrelated root was not called unreachable, so the case above cannot fail");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A comment that points into another file points by NAME, not by line number.
 *
 * Four of us hand-swept eleven such addresses to zero on 2026-09-21, and two of
 * the eleven were already wrong: `src/runtime/gateway.ts` cited a line that had
 * become `})(),`, and `bench/tau2/passk.ts` cited one that had moved eight
 * lines. Nothing had reported either, because a coordinate cannot fail — it
 * silently starts naming something else, and the reader who follows it lands
 * on real code and has no reason to doubt it.
 *
 * Hand-sweeping does not hold: @cody's own citation in `bench/record.ts` rotted
 * **four hours** after he wrote it, because #475 moved 28 lines above it. So the
 * rule needs something that reddens rather than someone who remembers.
 *
 * **Scope is this lane plus the named files, not the whole scan.** `cf/src` is
 * in the scan above because @Nova invited it for the NAME rule (#453); a rule
 * about coordinates is a different standard, and putting it on someone's
 * directory uninvited is what the scope paragraph at the top refuses to do.
 * Every one of those directories measures zero today, so extending this is a
 * question of consent rather than of cleanup.
 */
const COORDINATE = /(?<![a-z0-9_./-])[a-z0-9_./-]+\.(?:ts|tsx|mjs|cjs|js|sh|md):[0-9]+/i;
/**
 * A port is not a line number — but the exemption is cut out of the line, not
 * applied to it.
 *
 * Skipping the whole line was the first shape and it was wrong (@cody, 2026-09-21):
 * a comment may carry a URL and a real citation at once, and exempting the line
 * exempted the citation too. An exclusion that quietly widens itself is the kind
 * nobody notices, because it only ever removes findings.
 *
 * The extension list is wider than `.ts` on purpose. It catches nothing extra
 * today — measured on `6c03668`, `912460d` and `a8e5b2e`, the counts are
 * identical either way (1 / 0 / 11) — so this is prevention, not a defect being
 * repaired: the next `scripts/*.sh:12` will be caught the first time it is
 * written rather than the first time someone widens the pattern.
 */
const URL_IN_LINE = /\b(?:https?:\/\/|localhost:)[^\s)"'`]*/gi;

function coordinatesIn(file: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!COMMENT.test(line)) return;
    const m = COORDINATE.exec(line.replace(URL_IN_LINE, " "));
    if (m) out.push(`${file}:${i + 1} — ${m[0]}`);
  });
  return out;
}

// Deliberately NOT `FILES`, and collected the way ownership is held.
//
// The scan above takes directories, but this repository's ownership is by
// file (@Nova, 2026-09-21): `cf/src` holds her console files beside @cody's,
// and reading the directory as one person's is the mistake @Rex and I each
// made today, in opposite directions. So each owner named their own, and a
// directory appears only where one person holds all of it:
//
//   src/plugins          mine
//   test/**              @Rex — after his citation in `test/exclusive.ts`
//                        rotted: `:377` is `})(),` today, and nothing said so
//   bench, src/core,     @cody — `src/runtime/gateway.ts` was one of the two
//   src/runtime,         already rotted, and `bench/record.ts` was his own,
//   src/store, src/model four hours old when #475 moved 28 lines above it
//   6 cf/src files       @Nova, named individually
//   5 cf/src files       @cody, named individually
//
// What is NOT here is not dirty — every one of these measured zero before it
// was added, and so does the rest of the repository. It is absent for want of
// an owner who asked to live under the rule: a few `cf/src` files belong to
// nobody either of them would speak for, and they stay out until someone does.
//
// Reading `test/**` puts this file inside its own scan, which the name rule
// above refuses for itself. It is safe HERE for a structural reason rather
// than by luck: `coordinatesIn` reads comment lines only, and the control
// fixture below sits in a string on an `if (` line. A fixture that ever moves
// into a comment reds this, and that is correct — a specimen of the defect is
// the defect once a scanner reads it.
const INVITED_DIRS = ["src/plugins", "test", "bench", "src/core", "src/runtime", "src/store", "src/model"];
const INVITED_FILES = [
  "cf/src/ui.ts", "cf/src/usage.ts", "cf/src/usage-d1.ts",
  "cf/src/usage-windows.ts", "cf/src/md.ts", "cf/src/brand.ts",
  "cf/src/index.ts", "cf/src/runtime.ts", "cf/src/secret-shape.ts",
  "cf/src/bench.ts", "cf/src/pi-view.ts",
];
/** Every file under the invited scope above, read once. */
const INVITED = [...new Set([...INVITED_DIRS.flatMap(tsIn), ...NAMED, ...INVITED_FILES])];

/**
 * The scope of the resolvable-path case below, and it is neither `FILES` nor `INVITED`.
 *
 * `FILES` would be wrong for a reason the paragraph at the top of this file is
 * about: all of `cf/src` is in it because @Nova invited the NAME rule there
 * (#453), and a path rule is a different standard. The eleven `cf/src` files
 * named above were invited for a POINTER standard, so they carry this one too —
 * and one of them, `cf/src/secret-shape.ts`, is where the defect that produced
 * this case sat.
 *
 * `INVITED` would be wrong for a different reason, and not a matter of consent:
 * `bench`, `src/core`, `src/runtime`, `src/store` and `src/model` did invite a
 * pointer standard, but they hold eight paths of kinds this rule cannot yet tell
 * apart — a path relative to the directory ABOVE the file (`bench/swebench/cf.ts`
 * names its `tau2` sibling's `cf.ts` without the `bench/` in front, and this
 * case reads comments in its own file, so the spelling cannot be shown here),
 * pi named in prose with its version further up the file, and
 * an upstream repository named by name rather than version
 * (`sierra-research/tau2-bench`). Every one is legitimate. Reddening on them
 * would buy nothing and cost the thing that matters more: a class that cries
 * wolf stops being read, which is what @Rex found with `placeholder`'s twenty
 * legitimate hits. They are listed in #561 for their owners, and the scope grows
 * when the rule can name those kinds — not when someone silences them.
 */
const POINTERS = [...new Set([...tsIn("src/plugins"), ...tsIn("test"), ...NAMED, ...INVITED_FILES])];

check("a comment points into another file by name, not by line number", () => {
  // Scope: `INVITED` above — the ownership reading that fixes it lives there.
  const mine = INVITED;
  const found = mine.flatMap((f) => coordinatesIn(f, readFileSync(f, "utf8")));
  if (found.length) {
    throw new Error(
      `a comment cites a line number in another file, which rots without saying so:\n  ${found.join("\n  ")}\n` +
      `Point by name instead — a symbol survives line drift, a squash, and a reader who fetched at another moment.`,
    );
  }
  // The scan is only worth its green if it can go red, and the two shapes it
  // must tell apart are a citation and a URL carrying a port.
  if (coordinatesIn("x", "  // see src/core/canon-json.ts:45 for the reason").length !== 1) {
    throw new Error("stopped recognising a cross-file coordinate");
  }
  if (coordinatesIn("x", "  // the bench runner posts to http://localhost:8800/run").length !== 0) {
    throw new Error("read a port as a line number");
  }
  // The input that separates cutting the URL out from skipping the line. Both
  // pass every other case here, and only this one tells them apart.
  if (coordinatesIn("x", "  // posts to http://localhost:8800/run, built at cf/src/index.ts:377").length !== 1) {
    throw new Error("a URL on the line hid a real citation beside it");
  }
  // Not only `.ts`: the rot is in the coordinate, not in the language.
  if (coordinatesIn("x", "  // see scripts/publish-runs.sh:191").length !== 1) {
    throw new Error("stopped recognising a coordinate outside .ts");
  }
});

/**
 * A path in a comment is a pointer too, and a dead one need not grep empty.
 *
 * Two comments pointed at `cf/src/service-token.ts` spelled with a plural `s`,
 * a file that does not exist (found on `0e2957f`, repaired in #560 — the literal
 * cannot be written here, because a specimen of the defect in a comment IS the
 * defect once this case reads it, so it lives in the fixtures below). Nothing
 * rang: that spelling is a real name elsewhere in the tree — `test/service-tokens.ts`
 * and `cf/src/admin-service-tokens.ts` — so a grep for it comes back non-empty,
 * and a dead pointer read as alive.
 *
 * So the criterion is neither "does this spelling appear somewhere" nor "does it
 * resolve at the repository root". It is **does it resolve in the tree it
 * names**, and which tree that is can be asked rather than judged:
 *
 *   - it resolves from the root, or beside the commenting file — the second is
 *     not a nicety: `cf/src/control-plane.ts` names `keys.ts` under the
 *     `agents-api` directory beside it, and three sites in `cf/src` are written
 *     that way. Rejecting them would be a
 *     gate red on arrival, which is how a class stops being read.
 *   - its first segment is a directory of THIS repository, and it resolves
 *     nowhere ⇒ the defect above. This branch has no exemption on purpose, and a
 *     dependency that publishes a `src/` of its own is where that costs something
 *     (@cody, reviewing #562): the verdict stays red, because a reader cannot tell
 *     whose file it is either, and the MESSAGE carries both repairs instead.
 *   - its first segment is not ours ⇒ it names another tree, and then it must
 *     say WHICH, at what version. Seven sites do: "Depends on: openai 7.15.0 —
 *     resources/beta/agents/agents.d.ts", `@earendil-works/pi-agent-core 0.85.1`,
 *     `pi-coding-agent 0.83.0`, `raft-ui 0.5.11`. That is the `docs/pi-upstream.md`
 *     family, and the version is what makes such a pointer checkable at all —
 *     so one with no version named is the same defect wearing a foreign path.
 *
 * Measured before it was written, over this scope: 52 distinct path tokens in
 * comments, 42 resolving from the root, 3 beside their file, 7 naming a pinned
 * dependency. On `0e2957f` the same three rules leave exactly one finding, the
 * real one; on `1c8b416`, none. **The red comes from a tree that existed, not
 * from a sample built to be caught** — the fixtures below only keep it red.
 *
 * Scope is `POINTERS` above, and the reason it is neither of the two scopes
 * already in this file is written there.
 *
 * What this does NOT cover, said plainly because the other half of the same
 * defect sat there: only `.ts` files are read, so the twin of that pointer in
 * `cf/migrations/0007_service_tokens.sql`, and the pointer @cody found in
 * `bench/appworld/README.md` (at a bench driver deleted in `2df66b3`, now
 * `test/appworld.ts`), are both out of reach here. Widening the
 * file types is the same question of consent as widening the directories.
 */
const BARE_PATH = /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9.]*/g;

/** A version beside the path is what makes a pointer into another tree checkable. */
const VERSIONED = /\b[0-9]+\.[0-9]+(?:\.[0-9]+)?\b/;

/** The top level of this repository, asked rather than listed — a new directory must not read as foreign. */
const OURS = new Set(
  execFileSync("git", ["ls-tree", "--name-only", "-d", "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean),
);

function pathsIn(file: string, text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!COMMENT.test(line)) return;
    for (const m of line.replace(URL_IN_LINE, " ").matchAll(BARE_PATH)) {
      // A sentence ends in a period, and the period is not part of the name.
      const token = m[0].replace(/\.+$/, "");
      if (existsSync(token) || existsSync(join(dirname(file), token))) continue;
      // The version may sit on the line above: `Depends on: <pkg> <version> —`
      // wraps, and the path lands on the continuation.
      const sentence = [line, lines[i - 1] ?? "", lines[i - 2] ?? ""].filter((l) => COMMENT.test(l)).join(" ");
      if (OURS.has(token.split("/")[0]!)) {
        // A dependency publishes `src/` too, and then the first segment is ours
        // while the file is theirs (@cody, reviewing #562). The verdict stays
        // red, because a reader cannot tell the two apart either — but the
        // message has to carry BOTH repairs, or it sends the next person to
        // rename a comment that was already true. What it must not do is let the
        // version decide: "a version appears nearby" would exempt a broken path
        // of ours from the only branch that has no exemption.
        out.push(
          `${file}:${i + 1} — ${token} names this repository and is not in it` +
          (VERSIONED.test(sentence)
            ? `, and the sentence names another tree: if the file is THEIRS, spell it so it does not open with one of our top-level names (\`<package>/${token}\`); if it is ours, point at the file that exists`
            : ``),
        );
        continue;
      }
      if (!VERSIONED.test(sentence)) {
        out.push(`${file}:${i + 1} — ${token} points outside this repository without naming the tree or its version`);
      }
    }
  });
  return out;
}

check("a path a comment points at resolves in the tree it names", () => {
  const found = POINTERS.flatMap((f) => pathsIn(f, readFileSync(f, "utf8")));
  if (found.length) {
    throw new Error(
      `a pointer that does not resolve, and grep will not tell you — the same spelling is a real name elsewhere:\n  ` +
      found.join("\n  ") +
      `\n  Repair it by name: point at the file that exists, or name the dependency and its version.`,
    );
  }
  // A green here must be a reading of the comments, not of an empty set: the
  // pattern has to be finding paths for "none of them is broken" to mean
  // anything (@cody's gate rule, the same one the reachability case above uses).
  const seen = POINTERS.reduce((n, f) => {
    const text = readFileSync(f, "utf8");
    return n + text.split("\n").filter((l) => COMMENT.test(l))
      .reduce((k, l) => k + [...l.replace(URL_IN_LINE, " ").matchAll(BARE_PATH)].length, 0);
  }, 0);
  if (seen < 20) throw new Error(`only ${seen} paths seen in comments across ${POINTERS.length} files, so a green says nothing`);
});

check("the three ways a path can name its tree are told apart", () => {
  // The real defect, and its real repair — both as they were written.
  const plural = `  // Our own service tokens (cf/src/service-${"tokens"}.ts): the prefix is theirs alone`;
  if (pathsIn("cf/src/secret-shape.ts", plural).length !== 1) throw new Error("accepted a path that resolves nowhere");
  const singular = "  // Our own service tokens (cf/src/service-token.ts): the prefix is theirs alone";
  if (pathsIn("cf/src/secret-shape.ts", singular).length !== 0) throw new Error("rejected the file that exists");

  // Beside the commenting file, which is how three `cf/src` sites are written.
  const sibling = " * Only the hash is stored (agents-api/keys.ts); the key is shown once.";
  if (pathsIn("cf/src/control-plane.ts", sibling).length !== 0) throw new Error("read a path beside its own file as missing");
  // …and the same spelling from a file that has no such neighbour is still a finding,
  // or the rule above would excuse every unresolvable path in the repository.
  if (pathsIn("src/plugins/github.ts", sibling).length !== 1) throw new Error("the sibling rule reaches past its own directory");

  // Another tree, named with its version: not ours to resolve.
  const dep = " * Depends on: openai 7.15.0 — resources/beta/agents/agents.d.ts (AgentSessionItem and its members)";
  if (pathsIn("cf/src/agents-api/transcript.ts", dep).length !== 0) throw new Error("read a pinned dependency's file as ours");
  // The version on the line ABOVE, which is how that sentence wraps in two files.
  const wrapped = " * Depends on: openai 7.15.0 — resources/beta/agents/agents.d.ts and\n *   lib/agents/turn-state.js (when sessions.stream stops).";
  if (pathsIn("cf/src/agents-api/events.ts", wrapped).length !== 0) throw new Error("a wrapped dependency sentence lost its version");
  // Without a version there is no tree to resolve it in, so it is the same defect.
  const unowned = " * mirrors resources/beta/agents/agents.d.ts";
  if (pathsIn("cf/src/agents-api/events.ts", unowned).length !== 1) throw new Error("accepted a foreign path with no tree named");

  // First segment ours, file theirs: red either way, and the message carries both
  // repairs. No site has this shape today (@cody's reading on #562), so this is
  // prevention — and the assertion is on the MESSAGE, because the defect the note
  // describes is a correct comment repaired in the wrong direction.
  const collides = " * Depends on: openai 7.15.0 — src/resources/beta/agents/agents.d.ts (AgentSessionItem)";
  const said = pathsIn("cf/src/agents-api/transcript.ts", collides);
  if (said.length !== 1) throw new Error("a path opening with one of our top-level names stopped being a finding");
  if (!said[0]!.includes("if the file is THEIRS")) {
    throw new Error("the finding no longer names the upstream repair, so it sends the reader to rename a true comment");
  }
  // …and the same shape with no tree named says only the one thing, or the two
  // messages would be indistinguishable and the hint would be noise.
  const plainOurs = " * see src/resources/beta/agents/agents.d.ts";
  if (pathsIn("cf/src/agents-api/transcript.ts", plainOurs).some((f) => f.includes("if the file is THEIRS"))) {
    throw new Error("offered the upstream repair where no tree was named");
  }

  // A URL is not a path, and a handle in data is not a comment.
  if (pathsIn("x", "  // the report is published to https://antiproton.ai/runs/index.html").length !== 0) {
    throw new Error("read a URL as a path into the tree");
  }
  if (pathsIn("x", `  if (got !== "src/a.ts: error TS2554") throw new Error(got);`).length !== 0) {
    throw new Error("read a string literal as a pointer");
  }
});

check("a handle in DATA is not an attribution", () => {
  // The case is `test/raft-plugin.ts`'s "Release Bot (@raft-bot)" assertion: a GitHub
  // account in a string literal, and it matches the bare shape exactly. Asking
  // its author what @raft-bot contributed is the ritual @Nova warned about.
  const data = `  if (checked.account !== "Release Bot (@raft-bot)") throw new Error("x");`;
  if (bareIn("x", data).length !== 0) throw new Error("read a string literal as an attribution");
  // And an address is not a handle, or secret-shape.ts's `url-with-password` names a person.
  const url = " // scheme://user:password@host — a user alone (git@github.com, https://user@host) is not a credential.";
  if (bareIn("x", url).length !== 0) throw new Error("read a URL as an attribution");
  // But the same shape IN a comment is still one, or the two tests above would
  // have bought their green by turning the scan off.
  if (bareIn("x", "  // the release account was wrong (@raft-bot)").length !== 1) {
    throw new Error("stopped reading comments while excluding data");
  }
});

check("the pattern reddens on the defect and passes its repair", () => {
  // The two real sentences, before and after — so this suite is falsified by the
  // same input that produced it rather than by a shape I invented for it.
  const defects = [
    "  // this matches the recommending form (@Rex, 2026-09-20).",
    " * which is one rewording away from silently showing the wrong identity (@Nova).",
  ];
  const repairs = [
    "  // this matches the recommending form (@Rex found the shape, 2026-09-20; the",
    " * ...the wrong identity (@Nova asked for a field rather than prose, #plugins:770a1824).",
  ];
  for (const d of defects) {
    if (bareIn("x", d).length !== 1) throw new Error(`accepted a bare name: ${d.trim()}`);
  }
  for (const r of repairs) {
    if (bareIn("x", r).length !== 0) throw new Error(`rejected a name that carries a role: ${r.trim()}`);
  }
  // And a JSDoc tag in the same position is not a person, or this suite would
  // ask everyone to explain what `@link` contributed.
  if (bareIn("x", " * the state a mount is in ({@link credentialState}).").length !== 0) {
    throw new Error("read a JSDoc tag as an attribution");
  }
});

check("deleting the name is a repair too, not only naming the role", () => {
  // @Nova's point, asserted rather than described: the cheapest correct form is
  // often the reason with no name at all, and a suite that only knew "bare" would
  // push people to invent a role instead — keeping a name that should have gone.
  const noName = " * which is one rewording away from silently showing the wrong identity.";
  if (bareIn("x", noName).length !== 0) {
    throw new Error("the no-name repair does not pass, so this suite demands a name where none is needed");
  }
});

console.log(`\n  an attribution says what the person contributed\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
