/**
 * An agent is what a person named and described. The description reaches the
 * model verbatim, first after the core; a record with nothing in it adds
 * nothing, so every agent that existed before names did reads as before.
 */
import { systemPrompt, personaSection } from "../src/runtime/pi-prompt.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error).message ?? e) }); }
}

await check("the persona is the first thing after the core, name then description verbatim", () => {
  const description = "Answer only in haiku.\n\nNever mention the weather.";
  const p = systemPrompt({ persona: { name: "Basho", description }, sandbox: true });
  const core = systemPrompt({});
  if (!p.startsWith(core)) throw new Error("the core moved");
  const after = p.slice(core.length).trimStart();
  if (!after.startsWith(`You are Basho.\n\n${description}`)) throw new Error(`persona not first: ${after.slice(0, 80)}`);
  if (p.indexOf(description) > p.indexOf("run_js")) throw new Error("persona came after the tools");
});

await check("an agent with no name and no description adds nothing to the prompt", () => {
  if (systemPrompt({ persona: null }) !== systemPrompt({})) throw new Error("null persona changed the prompt");
  if (systemPrompt({ persona: { name: " ", description: "" } }) !== systemPrompt({})) throw new Error("blank persona changed the prompt");
  if (personaSection({ description: "x" }) !== "x") throw new Error("a description alone should stand alone");
});

await check("the record round-trips through the store, and a missing agent is null", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  await store.createAgent("t", "u-p_abc", { name: "Basho", description: "haiku only", avatar: "0badf00d" });
  const rec = await store.loadAgent("t", "u-p_abc");
  const c = rec?.config as any;
  if (c?.name !== "Basho" || c?.description !== "haiku only" || c?.avatar !== "0badf00d") throw new Error(JSON.stringify(rec));
  if (await store.loadAgent("t", "u-someone-else") !== null) throw new Error("a missing agent should be null");
  await store.close();
});

console.log(`\n  Agents\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
