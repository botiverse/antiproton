/**
 * The paragraphs plugins put in the system prompt.
 *
 * The order is the interesting part, and it is about money rather than tidiness:
 * a provider caches the prompt by prefix, so anything that can reorder the
 * paragraphs throws that cache away on a turn where nothing about the agent
 * changed. Mounts are listed by alias, so mount order would let a rename do it;
 * registry order cannot, because the registry only ever grows at the end.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { offloadLimit, tooLargeResult } from "../cf/src/runtime.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };

const says = (id: string, text: (alias: string) => string | null, extra: Partial<Plugin> = {}): Plugin => ({
  id, version: "1.0.0", tools: [],
  async invoke() { return { ok: true }; },
  async promptContribution(ctx: any) { return text(ctx.alias); },
  ...extra,
} as Plugin);

async function fixture(plugins: Plugin[], mounts: Array<[string, string]>) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin] of mounts) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, installationId: `i-${alias}`, connectionId: null,
      plugin, toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    } as any);
  }
  const gw = new ToolGateway(store, plugins, { async resolve() { return "SECRET"; } } as any);
  return { store, gw };
}

await check("paragraphs come in registry order, whatever the aliases are called", async () => {
  // Registered second, but its mount sorts first by alias: mount order would
  // put it first, registry order must not.
  const { gw } = await fixture(
    [says("first", () => "FIRST"), says("second", () => "SECOND")],
    [["aaa", "second"], ["zzz", "first"]],
  );
  const out = await gw.promptContributions({ tenantId: "t", agentId: "a", taskId: "k" } as any);
  must(JSON.stringify(out) === JSON.stringify(["FIRST", "SECOND"]),
    `registry order expected, got ${JSON.stringify(out)}`);
});

await check("two mounts of one plugin keep alias order, so the set of mounts fixes the prompt", async () => {
  const { gw } = await fixture([says("p", (alias) => `from ${alias}`)], [["m2", "p"], ["m1", "p"]]);
  const out = await gw.promptContributions({ tenantId: "t", agentId: "a", taskId: "k" } as any);
  must(JSON.stringify(out) === JSON.stringify(["from m1", "from m2"]), `alias order within a plugin, got ${JSON.stringify(out)}`);
});

await check("nothing to say adds nothing: no blank paragraph, no empty heading", async () => {
  const { gw } = await fixture(
    [says("quiet", () => null), says("blank", () => "   "), says("loud", () => "TEXT")],
    [["q", "quiet"], ["b", "blank"], ["l", "loud"]],
  );
  const out = await gw.promptContributions({ tenantId: "t", agentId: "a", taskId: "k" } as any);
  must(JSON.stringify(out) === JSON.stringify(["TEXT"]), `only the paragraph with words, got ${JSON.stringify(out)}`);
});

await check("a plugin that throws loses its paragraph and nothing else", async () => {
  // Opening the harness must not depend on every plugin being able to describe
  // itself: the agent still runs, one paragraph short.
  const { gw } = await fixture(
    [says("bad", () => { throw new Error("boom"); }), says("good", () => "STILL HERE")],
    [["x", "bad"], ["y", "good"]],
  );
  const out = await gw.promptContributions({ tenantId: "t", agentId: "a", taskId: "k" } as any);
  must(JSON.stringify(out) === JSON.stringify(["STILL HERE"]), `the good paragraph must survive, got ${JSON.stringify(out)}`);
});

await check("no credential is resolved to write a paragraph", async () => {
  let asked = 0;
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "m", installationId: "i", connectionId: null,
    plugin: "p", toolVersion: "1.0.0", publicConfig: {}, secretRef: "agent:key", policy: null,
  } as any);
  let sawCredential: unknown = "unset";
  const plugin = says("p", () => "TEXT");
  (plugin as any).promptContribution = async (ctx: any) => { sawCredential = ctx.credential; return "TEXT"; };
  const gw = new ToolGateway(store, [plugin], { async resolve() { asked++; return "SECRET"; } } as any);
  await gw.promptContributions({ tenantId: "t", agentId: "a", taskId: "k" } as any);
  must(asked === 0, "a paragraph must not make the gateway resolve a secret");
  must(sawCredential === null, `the plugin must see no credential, saw ${JSON.stringify(sawCredential)}`);
});

await check("a result too large to send says something true in both cases", async () => {
  // With a reader: a reference, and the tool named as the model was offered it
  // — this sentence is an instruction to call something, so it must be a name
  // the model can copy rather than the gateway's `artifacts.read` address.
  const parked = tooLargeResult({ head: "…" } as any, 40_000, { ref: "r2://x", readBack: "files__read" });
  must(parked.ref === "r2://x" && String(parked.note).includes("files__read"), `parked note: ${JSON.stringify(parked)}`);
  must(!String(parked.note).includes("artifacts.read"), "the note must not name a dispatch address");
  // Without one: no reference at all, and the loss stated. A reference nobody
  // can open reads as though the content is still somewhere.
  const gone = tooLargeResult({ head: "…" } as any, 40_000, null);
  must(!("ref" in gone), `nothing to read it back with, so no reference: ${JSON.stringify(gone)}`);
  must(/discarded, not stored/.test(String(gone.note)), `the loss must be stated: ${gone.note}`);
  must(gone.bytes === 40_000 && "preview" in gone, "how much there was, and what the start of it looked like");
});

await check("a 10 KB result is parked when it can be read back, and kept whole when it cannot", async () => {
  // The line is low only where parking loses nothing; where the rest would be
  // discarded, a 10 KB result still arrives whole.
  must(10_000 > offloadLimit("files__read"), `with a reader, 10 KB must be parked (limit ${offloadLimit("files__read")})`);
  must(10_000 <= offloadLimit(null), `without a reader, 10 KB must not be cut (limit ${offloadLimit(null)})`);
  must(4 * 1024 <= offloadLimit("files__read"), "exactly 4 KiB still goes inline");
});

await check("the model is told the size at which its results are parked", async () => {
  // A behaviour the model has to adapt to is stated where the model reads
  // (tygg, 2026-09-13), and the number in that sentence is the one that parks.
  const said = await artifactsPlugin(null as any, "b").promptContribution!({ alias: "artifacts" } as any);
  must(String(said).includes(`over ${offloadLimit("artifacts__read") / 1024} KB`), `the prompt must state the parking size: ${said}`);
  must(String(said).includes("over 4 KB"), `tygg's number is 4K: ${said}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
