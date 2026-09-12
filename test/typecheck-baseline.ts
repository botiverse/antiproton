/**
 * The ratchet's baseline file, read the way the ratchet reads it.
 *
 * The file is compared line by line against tsc's output, so a comment inside
 * a line would produce a false NEW and a false CLEARED at once — the entry
 * would match nothing on either side. That is why the reason for keeping an
 * entry could not be written next to it, and why some of the twenty-two look
 * like debts when they are decisions: `test/pi-agent.ts`'s TS2367 is a correct
 * comparison of two literal types, and "fixing" it would weaken a test that is
 * right.
 *
 * This exists because the rule lived inside a script that only runs from a
 * command line, where nothing could check it. The parse is a function now and
 * this is the thing that fails when it changes.
 */
import { baselineSignatures, baselineReasons } from "../scripts/typecheck.mjs";

let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${(e as Error).message}\x1b[0m`); }
};

check("a reason after ` #` is not part of the signature", () => {
  const sig = "test/pi-agent.ts: error TS2367: no overlap";
  const [only] = baselineSignatures(`${sig} # correct comparison; fixing it weakens the test\n`);
  if (only !== sig) throw new Error(`the signature came back as ${JSON.stringify(only)}`);
});

check("a line with no reason is unchanged, and blank lines are dropped", () => {
  const got = baselineSignatures("a.ts: error TS1: x\n\nb.ts: error TS2: y\n");
  if (got.join("|") !== "a.ts: error TS1: x|b.ts: error TS2: y") throw new Error(got.join("|"));
});

check("a `#` that is part of the message survives, because only ` #` separates", () => {
  // tsc writes messages containing `#` (private fields, for one), and eating
  // them would silently shorten a signature until it matched nothing.
  const sig = "cf/src/index.ts: error TS2341: Property '#busy' is private";
  const [only] = baselineSignatures(`${sig}\n`);
  if (only !== sig) throw new Error(`a hash inside the message was cut: ${JSON.stringify(only)}`);
});

check("the real baseline parses to as many signatures as it has entries", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync("typecheck-baseline.txt", "utf8");
  const sigs = baselineSignatures(text);
  if (sigs.some((s) => s.includes(" #"))) throw new Error("a reason leaked into a signature");
  if (sigs.length !== text.split("\n").filter(Boolean).length) {
    throw new Error(`${sigs.length} signatures from ${text.split("\n").filter(Boolean).length} lines`);
  }
});

check("a reason is readable by signature, so --update can carry it", () => {
  const text = [
    "a.ts: error TS1: x # still true, and not a debt",
    "b.ts: error TS2: y",
    "c.ts: error TS3: z # another reason",
  ].join("\n");
  const reasons = baselineReasons(text);
  if (reasons.size !== 2) throw new Error(`${reasons.size} reasons found, not 2`);
  if (reasons.get("a.ts: error TS1: x") !== "still true, and not a debt") throw new Error("the wrong reason came back");
  if (reasons.has("b.ts: error TS2: y")) throw new Error("an entry with no reason invented one");
});

check("a reason is keyed by the signature alone, so it survives a rewrite", () => {
  // The file is rewritten by `--update`, and the only thing that connects the
  // old line to the new one is the signature. A reason keyed on anything else
  // — position, order, the full line — would not survive, which is how both
  // reasons were lost the first time --update ran.
  const before = "x.ts: error TS4: m # why it stays";
  const sig = baselineSignatures(before)[0]!;
  if (baselineReasons(before).get(sig) !== "why it stays") {
    throw new Error("the reason does not come back under the signature the rewrite would use");
  }
});

console.log(`\n  ${"─".repeat(56)}\n  ${6 - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
