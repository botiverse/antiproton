/**
 * The ratchet's baseline files, read the way the ratchet reads them.
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
 *
 * There are two programs now, node and worker, each with its own baseline, and
 * the rules that make that safe — each compared only with its own file, and no
 * file checked by neither or counted by both — are functions here too.
 */
import { readFileSync } from "node:fs";
import { baselineSignatures, baselineReasons, signatures, compare, boundary, PROGRAMS } from "../scripts/typecheck.mjs";

let passed = 0, failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
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

check("each real baseline parses to as many signatures as it has entries", () => {
  // Synchronous on purpose: this used to be an async function handed to a
  // `check` that does not await, so a failure in it could not be reported as
  // one.
  for (const p of PROGRAMS) {
    const text = readFileSync(p.baseline, "utf8");
    const sigs = baselineSignatures(text);
    if (sigs.some((s) => s.includes(" #"))) throw new Error(`a reason leaked into a signature in ${p.baseline}`);
    const lines = text.split("\n").filter(Boolean).length;
    if (sigs.length !== lines) throw new Error(`${sigs.length} signatures from ${lines} lines in ${p.baseline}`);
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

check("a signature is the file, code and message, without line or column", () => {
  const out = [
    "src/a.ts(3,7): error TS2554: Expected 0 arguments, but got 1.",
    "src/a.ts(90,1): error TS2554: Expected 0 arguments, but got 1.",
    "  Type 'null' is not assignable to type 'number'.",
    "/abs/path/listed/by/--listFiles.ts",
  ].join("\n");
  const got = signatures(out);
  if (got.join("|") !== "src/a.ts: error TS2554: Expected 0 arguments, but got 1.") throw new Error(got.join("|"));
});

check("a signature one program clears is GONE there and NEW in neither", () => {
  // The artifacts.ts TS2554 was in the one-program baseline; after the split it
  // occurs in neither program. Copied into both baselines, it must come back as
  // two GONEs and no NEW — a clearance that read as NEW anywhere would fail
  // the deploy for a fix.
  const cleared = "src/store/artifacts.ts: error TS2554: Expected 0 arguments, but got 1.";
  const kept = "cf/src/index.ts: error TS2339: Property 'ToolBinding' does not exist on type 'Exports'.";
  const node = compare([], `${cleared} # both runtimes' globals in one program\n`);
  const worker = compare([kept], `${cleared}\n${kept}\n`);
  if (node.fresh.length || worker.fresh.length) throw new Error(`NEW: ${[...node.fresh, ...worker.fresh].join(" | ")}`);
  if (node.gone.join() !== cleared || worker.gone.join() !== cleared) throw new Error("the clearance was not named GONE in each baseline");
});

check("a signature that moved programs is NEW only where it now occurs", () => {
  // The other direction, so the rule is not only "nothing is ever NEW": the
  // same error under a program whose baseline lacks it is NEW there, and the
  // program that dropped it only says GONE.
  const moved = "src/plugins/http.ts: error TS2345: string[][]";
  const node = compare([moved], "");
  const worker = compare([], `${moved}\n`);
  if (node.fresh.join() !== moved || worker.fresh.length) throw new Error("NEW landed in the wrong program");
  if (worker.gone.join() !== moved || node.gone.length) throw new Error("GONE landed in the wrong program");
});

const program = (roots: string[], imported: string[] = []) => ({ roots: new Set(roots), files: new Set([...roots, ...imported]) });

check("the boundary accepts shared code one program names and the other imports", () => {
  // src/** is named by node and imported by the worker; so is bench/meter.ts,
  // which cf/src/index.ts imports. Both are the same code under two globals.
  const programs = {
    node: program(["src/core/types.ts", "bench/meter.ts", "test/secrets.ts"]),
    worker: program(["cf/src/index.ts", "test/auth.ts"], ["src/core/types.ts", "bench/meter.ts"]),
  };
  const problems = boundary(programs, ["src/core/types.ts", "bench/meter.ts", "test/secrets.ts", "cf/src/index.ts", "test/auth.ts"]);
  if (problems.length) throw new Error(problems.join(" | "));
});

check("the boundary names a file in neither program, cf/src under node, and a root of both", () => {
  const programs = {
    node: program(["test/confirm.ts"], ["cf/src/runtime.ts"]),
    worker: program(["cf/src/runtime.ts", "test/confirm.ts"]),
  };
  const problems = boundary(programs, ["test/forgotten.ts", "cf/src/runtime.ts", "test/confirm.ts"]);
  const expect = [
    "test/forgotten.ts: in neither program",
    "cf/src/runtime.ts: in the node program",
    "test/confirm.ts: a root of node and worker",
  ];
  if (problems.length !== 3 || expect.some((e, i) => !problems[i]?.startsWith(e))) throw new Error(problems.join(" | "));
});

check("a program with no roots is a broken boundary, not a clean run", () => {
  // tsc failing to start produces no errors, and no errors reads as clean.
  const problems = boundary({ node: program([]), worker: program(["cf/src/index.ts"]) }, ["cf/src/index.ts"]);
  if (!problems.some((p) => p.startsWith("node: no root files"))) throw new Error(problems.join(" | ") || "no problem reported");
});

console.log(`\n  ${"─".repeat(56)}\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
