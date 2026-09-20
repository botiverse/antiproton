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
 * **Scope is this lane deliberately.** The same shape exists in three places
 * outside it (`cf/src/ui.ts:1219` and `:1255`, `test/call-id-in-the-record.ts:125`),
 * and those comments belong to @Nova and @cody — widening this scan is theirs to
 * accept, not mine to impose through a gate they did not agree to. Raised in the
 * thread above instead.
 *
 * This file is not in its own scope, because the defect appears here as a
 * fixture and would red the suite that quotes it. The cost is real: the three
 * names in this docblock are the ones nothing checks.
 */
import { readFileSync, readdirSync } from "node:fs";

/** JSDoc tags and the like: an `@` in a comment that is not a person. */
const NOT_A_PERSON = /^@(link|param|returns?|see|example|throws|deprecated|type|typedef|template|module|name|default|ts-[a-z-]+)$/;

/**
 * A name with nothing after it but a date.
 *
 * The date is not a role: it says when, which the git record already says, and
 * not what — which only the thread says.
 */
const BARE = /(@[A-Za-z][A-Za-z0-9_-]*)(?:\)|, 20[0-9]{2}-[0-9]{2}-[0-9]{2}\))/g;

const FILES = [
  ...readdirSync("src/plugins").filter((f) => f.endsWith(".ts")).map((f) => `src/plugins/${f}`),
  "test/identity-wording.ts",
  "test/identity-in-the-record.ts",
  "test/github-errors.ts",
  "test/github-auth-status.ts",
];

/** Every `@handle` in these files, bare or not, so the scan can prove it has a subject. */
function namesIn(text: string): string[] {
  return (text.match(/@[A-Za-z][A-Za-z0-9_-]*/g) ?? []).filter((n) => !NOT_A_PERSON.test(n));
}

/** The bare ones, as `file:line — the text that carries them`. */
function bareIn(file: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
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
    throw new Error(`a name with no role, so a reader cannot check it against the thread:\n      ${bare.join("\n      ")}`);
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

console.log(`\n  an attribution says what the person contributed\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
