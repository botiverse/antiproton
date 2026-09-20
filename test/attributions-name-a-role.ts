/**
 * An attribution in a comment says WHAT the person contributed, not only who.
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
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

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

check("no attribution in this lane is a bare name", () => {
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
