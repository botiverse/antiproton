/**
 * What an agent is told about what it is holding, and who writes it.
 *
 * Three sentences — the session-start paragraph, the idle warning, the line
 * after each result — that were the sandbox's or built from its literals, and
 * are now the framework's, written from what `holds` declares (tygg, cody,
 * 2026-09-22). The cases here are the two ends cody asked for (a declared name
 * resolves; a declared name that is not offered makes all three silent) and the
 * one property the prompt paragraph has to keep: it does not move while a
 * session is open.
 *
 * The fixture plugin is called `seats`, holds a `seat`, and calls its tools
 * `letgo` and `hold_on` — none of the sandbox's words — because the defect
 * being fixed is invisible to any fixture that happens to use them.
 */
import { heldLine, heldPrompt, heldResources, withHeldNote, HELD_KEY, type Held } from "../src/runtime/held.ts";
import type { MountActivity, Plugin } from "../src/plugins/types.ts";
import { offeredToolName } from "../src/runtime/pi-tools.ts";
import { readFile } from "node:fs/promises";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => unknown) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const T0 = 1_700_000_000_000;
const SEAT: MountActivity = {
  live: { id: "seat-77", startedAt: T0, lastUsedAt: T0 + 60_000 },
  quietUntil: null,
  billing: "billed by the hour of the seat, whether or not anyone is in it",
};

function seats(release = "letgo", postpone: string | undefined = "hold_on"): Plugin {
  return {
    id: "seats", version: "1", tools: [],
    holds: {
      tools: { release, ...(postpone ? { postpone } : {}) },
      async activity() { return SEAT; },
      async release() { return true; },
    },
  } as unknown as Plugin;
}
/** A plugin that holds nothing, to prove it is never even asked. */
const plain = { id: "plain", version: "1", tools: [] } as unknown as Plugin;

// What the model was actually offered. `desk__letgo`, not `desk.letgo`: the
// qualifier sanitises the alias, and the whole point of resolving through this
// list is that the offered name is not the address.
const offered = [
  { name: "desk__letgo", address: "desk.letgo", description: "", parameters: {}, effect: "write" },
  { name: "desk__hold_on", address: "desk.hold_on", description: "", parameters: {}, effect: "write" },
] as any[];
const nameOf = (alias: string, tool: string) => offeredToolName(offered, alias, tool);

const MOUNTS = [{ alias: "desk", plugin: "seats" }, { alias: "notes", plugin: "plain" }];

await check("only a plugin that declares holds is asked, and what it answers is what is reported", async () => {
  const asked: string[] = [];
  const held = await heldResources(MOUNTS, [seats(), plain], async (alias) => { asked.push(alias); return SEAT; });
  // The mount holding nothing is filtered out before any state is read: that is
  // what keeps this cheap enough to do on every tool call.
  must(asked.join(",") === "desk", `only the holding mount should be asked, asked: ${asked.join(",") || "none"}`);
  must(held.length === 1 && held[0]!.alias === "desk", `one holding mount expected, got ${JSON.stringify(held)}`);
  must(held[0]!.live.id === "seat-77", "the live id comes from the plugin's own report");
  must(held[0]!.billing === SEAT.billing, "the cost sentence is the plugin's, passed through");
  must(held[0]!.tools.release === "letgo", "the releasing tool's name is the plugin's declaration");
});

await check("a mount holding nothing right now is not reported, even though its plugin holds things", async () => {
  const held = await heldResources([{ alias: "desk", plugin: "seats" }], [seats()], async () => ({ live: null }));
  must(held.length === 0, `nothing alive is not something to tell an agent about: ${JSON.stringify(held)}`);
});

await check("the declared name resolves, and all three sentences use the offered one", async () => {
  const [h] = await heldResources(MOUNTS, [seats(), plain], async () => SEAT);
  const three = {
    prompt: heldPrompt([h!], nameOf)!,
    line: heldLine(h!, nameOf, T0 + 10 * 60_000),
  };
  for (const [where, text] of Object.entries(three)) {
    must(text.includes("desk__letgo"), `${where} does not name the releasing tool as the model was offered it: ${text}`);
    // The failure this resolution exists to stop: a name rebuilt from the alias
    // and the plugin's word for the tool. It resolves, and it is another
    // mount's tool at the length cap or on a collision.
    must(!/desk\.letgo|`letgo`/.test(text), `${where} printed a name it built itself: ${text}`);
  }
  must(three.prompt.includes("desk__hold_on"), `the paragraph must offer the way to keep it: ${three.prompt}`);
  must(three.prompt.includes("seat-77"), `the paragraph must say which one: ${three.prompt}`);
  must(three.line.includes("seat-77"), `the line must say which one: ${three.line}`);
});

await check("a declared tool the model was not offered makes all three sentences silent about calling it", async () => {
  // The other end. The plugin says its releasing tool is `letgo`; nothing in the
  // catalogue is. A withheld tool has no address there at all — policy withheld
  // it, or the mount is read-only — so an instruction to call it is an
  // instruction the agent cannot follow, and the sentences must not give it.
  const [h] = await heldResources(MOUNTS, [seats("gone_away", "also_gone"), plain], async () => SEAT);
  const prompt = heldPrompt([h!], nameOf)!;
  const line = heldLine(h!, nameOf, T0 + 10 * 60_000);
  for (const [where, text] of [["the paragraph", prompt], ["the line", line]] as const) {
    must(!/gone_away|also_gone/.test(text), `${where} named a tool that is not in the catalogue: ${text}`);
    must(!/\bcall\b/i.test(text), `${where} still tells the agent to call something: ${text}`);
    must(!/null|undefined/.test(text), `${where} printed the absence instead of leaving it out: ${text}`);
  }
  // Silent about the call, not silent: the agent is still holding a seat that is
  // still billing, and that is the part it cannot find out any other way.
  must(prompt.includes("seat-77") && line.includes("seat-77"), "the fact it is held must survive the missing tool");
});

await check("the session-start paragraph does not move while the session is open", async () => {
  // It lands in the system prompt, which a provider caches as a prefix and which
  // is rebuilt on every open. A number that ticks would throw that cache away
  // once per open (Rex found the boundary, cody set the rule, 2026-09-22).
  const [h] = await heldResources(MOUNTS, [seats(), plain], async () => SEAT);
  const real = Date.now;
  let first: string, later: string;
  try {
    Date.now = () => T0 + 60_000;
    first = heldPrompt([h!], nameOf)!;
    // Hours later, same session, same held seat.
    Date.now = () => T0 + 4 * 3_600_000;
    later = heldPrompt([h!], nameOf)!;
  } finally { Date.now = real; }
  must(first === later, `the paragraph read the clock:\n  ${first}\n  ${later}`);
  // And the red method cody named: a duration written into it. Caught by shape
  // rather than by comparing two calls, because a duration measured from
  // `startedAt` alone would pass the comparison above and still be wrong on the
  // next open.
  must(!/\b\d+\s*(m|min|mins|minute|minutes|s|sec|secs|second|seconds|h|hour|hours)\b/i.test(first),
    `a duration in the paragraph invalidates the cached prefix once per open: ${first}`);
  must(!/\bidle\b|\bremaining\b|\bleft\b|\bago\b/i.test(first),
    `the paragraph must not carry anything that counts down: ${first}`);
});

await check("the line after a result is short, says what is held, and is the only per-result sentence", async () => {
  // It went on every result when the sandbox wrote it at 132 bytes, grew past
  // 400 with the lease terms, and background-job notices carry the whole result
  // — so one conversation read it dozens of times (task #19). The framework's
  // version carries only what changes: which thing, how long idle, what lets it
  // go. The terms live in the tool descriptions, sent every turn.
  const [h] = await heldResources(MOUNTS, [seats(), plain], async () => SEAT);
  const line = heldLine(h!, nameOf, T0 + 13 * 60_000);
  must(line.length < 220, `a line repeated on every result is ${line.length} characters: ${line}`);
  must(/idle 12 minutes/.test(line), `the line must say how long it has sat: ${line}`);
  must(line.includes(SEAT.billing!), `the plugin's cost sentence is what says why it matters: ${line}`);
  // Freshly used: no duration at all rather than "idle 0 minutes".
  const fresh = heldLine(h!, nameOf, T0 + 70_000);
  must(!/idle/.test(fresh), `a seat just used is not idle: ${fresh}`);
});

await check("the line is attached to the result, and never replaces what the tool returned", async () => {
  const noted = withHeldNote({ state: "succeeded", exitCode: 0 }, "still holding") as any;
  must(noted.state === "succeeded" && noted.exitCode === 0, `the tool's own result must survive: ${JSON.stringify(noted)}`);
  must(noted[HELD_KEY] === "still holding", `the line must be on the result: ${JSON.stringify(noted)}`);
  // A shape with nowhere to put it is handed back untouched rather than wrapped:
  // wrapping changes what the tool's description promised, and losing a reminder
  // is better than losing the work the call just did.
  must(withHeldNote(["a", "b"], "x") instanceof Array, "an array must not be turned into an object");
  must(withHeldNote("text", "x") === "text", "a string result must come back as it was");
});

await check("the idle pass reaches into nothing that belongs to one plugin", async () => {
  // The rule the rewrite exists to keep. `boxId` is one plugin's word, and for
  // as long as this loop read it, the framework's idle pass was the sandbox's
  // idle pass wearing the framework's name — a second plugin that held
  // something got no warning and no reclaim, with nothing going red.
  const src = await readFile(new URL("../cf/src/runtime.ts", import.meta.url), "utf8");
  const at = src.indexOf("async #idlePass(");
  must(at > 0, "the idle pass was renamed; this guard is now pointing at nothing");
  // Comments only, stripped: the loop's own comment says what it used to read
  // and why it stopped, which is the sentence most worth keeping and the one a
  // guard over raw text goes red on. Same lesson as the attribution gate — a
  // rule about code must not be enforced against prose (Piper, 2026-09-19).
  const body = src.slice(at, src.indexOf("\n  }\n", at))
    .split("\n").map((l) => l.replace(/\s*\/\/.*$/, "")).filter((l) => l.trim()).join("\n");
  // Reaching into it, not naming it: the loop drops the superseded
  // `box_warnings` table by name, which is the one statement that has to say it.
  for (const word of ["boxId", "FROM box_warnings", "INTO box_warnings", '"release"', '"quiet"', "container"]) {
    must(!body.includes(word), `the idle pass still reaches for ${word}, which belongs to one plugin`);
  }
  must(body.includes("heldResources"), "the idle pass must ask the plugins what they are holding");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
