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
 * mine to make. `test/` is still out: `test/call-id-in-the-record.ts:125` is
 * @cody's, and he is removing it in #433 — adding the directory now would write
 * an assertion that is FALSE today, which would drag the true one red beside it
 * (@Vera's correction of my weaker reason, "a cross-PR dependency in a gate").
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
 * **delete the name and keep the reason** — `git blame` remembers people,
 * comments should remember reasons. `#433` and `ac3fadd` were both repaired that
 * way. So the third case below asserts that the no-name repair PASSES, rather
 * than leaving it as advice in a comment nothing enforces.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** JSDoc tags and the like: an `@` in a comment that is not a person. */
const NOT_A_PERSON = /^@(link|param|returns?|see|example|throws|deprecated|type|typedef|template|module|name|default|ts-[a-z-]+)$/;

/**
 * An attribution is a claim in a COMMENT, so only comment lines are read.
 *
 * `test/raft-plugin.ts:325` is the case that settles it: `"Release Bot
 * (@raft-bot)"` is a GitHub account inside a string literal, and it matches the
 * bare-name shape exactly. Asking its author what `@raft-bot` contributed is the
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
 * in `cf/src/secret-shape.ts:41` read as people — an address is not a handle,
 * and that comment is about credentials rather than about anyone.
 */
const BARE = /(?<![A-Za-z0-9_.\-])(@[A-Za-z][A-Za-z0-9_-]*)(?:\)|, 20[0-9]{2}-[0-9]{2}-[0-9]{2}\))/g;

/**
 * Directories are read, never globbed.
 *
 * `git ls-files 'test/**\/*.ts'` finds 3 of 95 and `'cf/src/**\/*.ts'` 10 of 47,
 * because `**` requires a directory level (@cody hit it on #433's scope and @Rex
 * reproduced it on this one before it reached here). **A glob's blind spot
 * answers with a small clean number rather than an error** (@Nova).
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
      `      say what the person contributed, or delete the name and keep the reason (@Nova: git blame remembers people)\n      ` +
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

check("a handle in DATA is not an attribution", () => {
  // `test/raft-plugin.ts:325` is the case: "Release Bot (@raft-bot)" is a GitHub
  // account in a string literal, and it matches the bare shape exactly. Asking
  // its author what @raft-bot contributed is the ritual @Nova warned about.
  const data = `  if (checked.account !== "Release Bot (@raft-bot)") throw new Error("x");`;
  if (bareIn("x", data).length !== 0) throw new Error("read a string literal as an attribution");
  // And an address is not a handle, or `cf/src/secret-shape.ts:41` names a person.
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
