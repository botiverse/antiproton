/**
 * The caller's functions (an Agents API agent's `openai.tools`) reach a session through exactly one derivation in
 * `#turnTools` (cf/src/runtime.ts): `apiTools` is read once, `callerDefs` and `callerTools` are derived from it under
 * one check (`callerFree`: subagent, short `iso_` session, memory call), and every consumer reads those two values.
 *
 * A source-shape test on purpose. The behaviour (a short session is not offered them, on pi085 and pd) is tested in
 * test/subagents.ts; this one fails the day a second path hands the caller's functions to a session without going
 * through that check, which no behaviour test of the existing paths would notice. When it fails, route the new path
 * through `callerDefs`/`callerTools`, or, if the new path is right, update the counts here with why.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../cf/src/runtime.ts", import.meta.url), "utf8");
const lines = src.split("\n");
let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n      ${detail}`}`);
  if (!ok) failed++;
}
const where = (re: RegExp) => lines.flatMap((l, i) => (re.test(l) ? [`${i + 1}: ${l.trim()}`] : []));

const reads = where(/\.openai\b[^=]*\?\.\s*tools|\bapiConfig\?\.tools\b/);
check("the caller's functions are read from the agent record in one place", reads.length === 1,
  `expected 1 read of openai.tools, found ${reads.length}:\n      ${reads.join("\n      ")}`);

const uses = where(/\bapiTools\b/);
const allowed = uses.filter((l) => /const apiTools =|const callerDefs =|const callerTools =|apiTools\.filter\(/.test(l));
check("apiTools is used only to derive callerDefs and callerTools", uses.length === allowed.length && uses.length > 0,
  `unexpected uses of apiTools:\n      ${uses.filter((l) => !allowed.includes(l)).join("\n      ")}`);

const gate = where(/const callerFree = /);
check("one check decides who is offered them, and it names short sessions", gate.length === 1 && /\bisolated\b/.test(gate[0] ?? "")
  && /\bchild\b/.test(gate[0] ?? "") && /\bmemoryCall\b/.test(gate[0] ?? ""), `callerFree: ${gate.join(" | ") || "missing"}`);

const derived = where(/const caller(Defs|Tools) = /);
check("both derived values start from that check", derived.length === 2 && derived.every((l) => l.includes("!callerFree")),
  `derivations:\n      ${derived.join("\n      ")}`);

const handOffs = where(/\bclientTools\s*[:(]/).filter((l) => !/^\d+: (\*|\/\/|import)/.test(l));
check("the caller's functions are handed to an engine in exactly two places (pi085 clientTools(), pd clientTools:)",
  handOffs.length === 2 && handOffs.some((l) => /clientTools\(callerDefs/.test(l)) && handOffs.some((l) => /clientTools: callerDefs/.test(l)),
  `hand-offs:\n      ${handOffs.join("\n      ")}`);

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
