/**
 * A run_js program that does not parse: the model is handed the engine's own error (src/runtime/dynamic-worker-executor.ts
 * `compileErrorMessage`), with the place the engine names given in the program's lines and the line itself under a
 * caret. The engine's answer here is the one local workerd gave for preview's program (wrangler 4.129.0, workerd
 * 1.20260903.1, `wrangler dev --local` with a Worker Loader binding, the module the executor generates; 2026-10-15).
 * On preview the model was handed only "Invalid or unexpected token", and resent the program 300+ times.
 */
import { compileErrorMessage, DynamicWorkerExecutor, isCompileError } from "../src/runtime/dynamic-worker-executor.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

/** Preview's program, as its agent sent it. */
const SOURCE = "const r = await tool`raft__messages_read ${ { target: \"#onboarding-owner\", limit: 10, consume: false, before: 3e2834a7 } }`;\n" +
  "output(JSON.stringify(r).slice(0, 4000));";
/** What local workerd's loader threw for it, verbatim (the message; its stack repeats it). */
const ENGINE = "Failed to start Worker:\nUncaught SyntaxError: Invalid or unexpected token\n  at main.js:135:110";
const workerdError = () => new Error(ENGINE);

const EXPECTED = [
  "Uncaught SyntaxError: Invalid or unexpected token",
  "  at line 1, column 111 of the program",
  "1 | …et: \"#onboarding-owner\", limit: 10, consume: false, before: 3e2834a7 } }`;",
  " ".repeat(65) + "^",
].join("\n");

await check("preview's program: the engine's sentence, the place in the program's own lines, and the line with a caret under the token", () => {
  must(SOURCE.indexOf("3e2834a7") + 1 === 111, "the fixture's column is not the token's");
  const m = compileErrorMessage(workerdError(), SOURCE);
  must(m === EXPECTED, `got:\n${m}\nexpected:\n${EXPECTED}`);
  const [, , line, caret] = m.split("\n");
  must(line!.slice(caret!.indexOf("^")).startsWith("3e2834a7"), "the caret is not under the token");
  must(!/quote|hint|looks like/i.test(m), "words were added to the engine's");
});

await check("through the executor: eval_error, with that message", async () => {
  const ex = new DynamicWorkerExecutor({
    loader: { load: () => ({ getEntrypoint: () => ({ fetch: async () => { throw workerdError(); } }) }) } as any,
    makeToolBinding: () => ({}),
  });
  const r = await ex.execute(SOURCE, { async invoke() { return { status: "succeeded", operationId: "op", result: {} }; } } as any);
  must(r.status === "failed" && r.error?.code === "eval_error" && r.error.message === EXPECTED, JSON.stringify(r));
});

await check("the loader's wrapped shape is the script's error; a message that only mentions the word still is not", () => {
  must(isCompileError(workerdError()), "workerd's wrapped SyntaxError read as the host's");
  must(!isCompileError(new Error("Failed to start Worker:\nError: out of memory")), "a start failure that is not a SyntaxError");
  must(!isCompileError(new Error("ReferenceError: SyntaxError is not defined")), "a mention");
});

await check("the place is also read from the stack; with none, or one outside the program, the sentence goes alone", () => {
  const bare = Object.assign(new Error("Invalid or unexpected token"), { name: "SyntaxError", stack: "SyntaxError: Invalid or unexpected token\n  at main.js:135:110" });
  must(compileErrorMessage(bare, SOURCE) === "Invalid or unexpected token\n  at line 1, column 111 of the program\n" + EXPECTED.split("\n").slice(2).join("\n"), compileErrorMessage(bare, SOURCE));
  must(compileErrorMessage(Object.assign(new Error("Invalid or unexpected token"), { name: "SyntaxError", stack: "" }), SOURCE) === "Invalid or unexpected token", "no place");
  // An unclosed template is reported past the program's end, in the module's own lines.
  must(compileErrorMessage(new Error("Failed to start Worker:\nUncaught SyntaxError: Unexpected end of input\n  at main.js:150:2"), "x = `a"), "Uncaught SyntaxError: Unexpected end of input");
  // A column of 0 is left out by the engine: the caret is at the line's start.
  const atStart = compileErrorMessage(new Error("Failed to start Worker:\nUncaught SyntaxError: Invalid or unexpected token\n  at main.js:136"), "ok();\n@x");
  must(atStart.endsWith("  at line 2, column 1 of the program\n2 | @x\n    ^"), atStart);
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
