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
import { limitForCall, offloadLimit, parkResult, parkedReader, tooLargeResult, withLimitNote } from "../cf/src/runtime.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";

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

await check("a parked result keeps its summary and gives the exact call that reads all of it", async () => {
  // Summary kept; the note is the next call, pi-style, named
  // as the model was offered it. A whole read fits under the reader's line.
  const value = { full_name: "cloudflare/workerd", stargazers_count: 7000, description: "x".repeat(9_000) };
  const body = JSON.stringify(value);
  const parked = tooLargeResult(value, body, { ref: "r2://x", readBack: "files__read" });
  must((parked.preview as any)?.full_name === "cloudflare/workerd", `the summary is kept: ${JSON.stringify(parked.preview).slice(0, 80)}`);
  must(String(parked.note).includes('files__read { ref: "r2://x" }'), `the note must be the call: ${parked.note}`);
  must(!String(parked.note).includes("from:"), `a result that fits one read is not paged: ${parked.note}`);
  must(!String(parked.note).includes("artifacts.read"), "the note must not name a dispatch address");
  must(parked.ref === "r2://x" && parked.bytes === body.length, `ref and size: ${JSON.stringify(parked).slice(0, 120)}`);
  // Over the reader's own line a whole read would be parked again, so the call pages.
  const big = { description: "x".repeat(offloadLimit(null) + 1) };
  const paged = tooLargeResult(big, JSON.stringify(big), { ref: "r2://y", readBack: "files__read" });
  must(String(paged.note).includes('files__read { ref: "r2://y", from: 0 }'), `a result over the reader's line must be paged: ${paged.note}`);
  // Without a reader: no reference, the loss stated, the same shape otherwise.
  const gone = tooLargeResult(value, body, null);
  must(!("ref" in gone), `nothing to read it back with, so no reference: ${JSON.stringify(gone).slice(0, 120)}`);
  must(/discarded, not stored/.test(String(gone.note)), `the loss must be stated: ${gone.note}`);
  must(Object.keys(gone).join() === "preview,bytes,note" && Object.keys(parked).join() === "preview,bytes,ref,note",
    `one shape: ${Object.keys(parked)} / ${Object.keys(gone)}`);
});

await check("a storage failure while parking does not fail a call that succeeded: one retry, then the loss stated", async () => {
  // R2 answered a put with an internal error (10001) and the model was told its GitHub read had failed (task #19).
  const value = { full_name: "cloudflare/workerd", description: "x".repeat(9_000) };
  const body = JSON.stringify(value);
  const run = async (failures: number, completeFails = false) => {
    let puts = 0; const completed: string[] = [];
    const result = await parkResult(value, body, "t/t/a/op.json", "artifacts__read", {
      async put(key) {
        puts++;
        if (puts <= failures) throw new Error(`We encountered an internal error. (10001) key ${key}`);
        return { ref: `r2://bucket/${key}` };
      },
      async complete(ref) {
        if (completeFails) throw new Error(`db unavailable key t/t/a/op.json`);
        completed.push(ref);
      },
      shownRef: (ref) => ref.replace("r2://bucket/t/t/a/", "artifact://"),
    });
    return { result, puts, completed };
  };
  const first = await run(0);
  must(first.puts === 1 && first.result.ref === "artifact://op.json" && first.completed.join() === "r2://bucket/t/t/a/op.json",
    `a put that works is made once and recorded: ${JSON.stringify(first).slice(0, 200)}`);
  const retried = await run(1);
  must(retried.puts === 2 && retried.result.ref === "artifact://op.json" && retried.completed.length === 1,
    `one failed put is retried and the result is parked: ${JSON.stringify(retried).slice(0, 200)}`);
  const lost = await run(2);
  must(lost.puts === 2, `a second failure is not retried again: ${lost.puts} puts`);
  must(!("ref" in lost.result) && lost.completed.length === 0, `nothing stored, so no reference and no record: ${JSON.stringify(lost).slice(0, 200)}`);
  must((lost.result.preview as any)?.full_name === "cloudflare/workerd", "the summary is still returned");
  must(/could not be confirmed/.test(String(lost.result.note)) && /succeeded/.test(String(lost.result.note)), `the unconfirmed store and the success are both said: ${lost.result.note}`);
  // Two failed puts do not prove nothing landed (a 5xx may have), so the note must not claim it (Ada, #341).
  must(!/not kept|nothing to read back|not stored/.test(String(lost.result.note)), `the note claims more than is known: ${lost.result.note}`);
  must(!/10001|t\/t\/a|bucket/.test(JSON.stringify(lost.result)), `the storage error's text and the key stay out of the result: ${lost.result.note}`);
  // Stored, then recording the reference failed: the call and the copy both exist, so the copy is still offered.
  let unrecorded: Awaited<ReturnType<typeof run>> | null = null;
  const logged = console.error; console.error = () => {};
  try { unrecorded = await run(0, true); } catch (e) { must(false, `a failure to record the reference failed the call: ${(e as Error).message}`); }
  finally { console.error = logged; }
  must(unrecorded!.result.ref === "artifact://op.json", `the stored copy is still offered: ${JSON.stringify(unrecorded!.result).slice(0, 200)}`);
  must(!/db unavailable|t\/t\/a|bucket/.test(JSON.stringify(unrecorded!.result)), `the recording error's text stays out of the result: ${JSON.stringify(unrecorded!.result).slice(0, 200)}`);
});

await check("following the note of a result too big for one read returns the exact result", async () => {
  // The seam between the runtime's note and the reader's pages.
  const value = Array.from({ length: 4000 }, (_, i) => ({ id: i, t: `\u00e9\u{1F600}${i}` }));
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  const plugin = artifactsPlugin({ async get() { return bytes; } } as any, "b");
  const ctx = { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any;
  const ref = "r2://b/t/t/a/op.json";
  let note = String(tooLargeResult(value, body, { ref, readBack: "artifacts__read" }).note);
  let joined = "", pages = 0;
  for (let m = /from: (\d+)/.exec(note); m; m = /from: (\d+)/.exec(note)) {
    const page: any = await plugin.invoke("read", { ref, from: Number(m[1]) }, ctx);
    joined += page.text; note = String(page.note);
    if (++pages > 50) throw new Error("the notes never reach the end");
  }
  must(pages >= 3, `expected several pages for ${body.length} characters, got ${pages}`);
  must(joined === body, `pages != result (${joined.length} vs ${body.length})`);
});

await check("every offered tool's own description states the limit and what to do at it", async () => {
  // pi puts the limit in each tool's description. A sentence in two plugins'
  // descriptions described a behaviour every mounted call has.
  const reader = { name: "artifacts__read", address: "artifacts.read" };
  const tools = [
    { name: "gh__api_get", address: "gh.api_get", description: "Read any GitHub REST endpoint." },
    { name: "artifacts__read", address: "artifacts.read", description: "Read back a parked result." },
  ];
  const withReader = withLimitNote(tools, reader);
  must(withReader[0]!.description.includes(`over ${offloadLimit("artifacts__read") / 1024} KB`) && withReader[0]!.description.includes("artifacts__read"),
    `with a reader: ${withReader[0]!.description}`);
  must(withReader[1]!.description === "Read back a parked result.", `the reader's own description is left alone: ${withReader[1]!.description}`);
  const without = withLimitNote([tools[0]!], null);
  must(without[0]!.description.includes(`over ${offloadLimit(null) / 1024} KB`) && /discarded/.test(without[0]!.description),
    `without a reader: ${without[0]!.description}`);
});

await check("the reader is found by what the tool DOES, not by the plugin's id and the tool's name", async () => {
  // The old form rebuilt the string `artifacts` + `.read`. Both halves of that
  // are things an operator or an author may change, and changing either left
  // the runtime with no reader and nothing saying so — every parked result a
  // dead end, silently.
  const parked = { reads: "parked-result" as const };
  const P = { parameters: { type: "object" }, sideEffects: "read" as const };
  const gh = { name: "gh__api_get", address: "gh.api_get", description: "", ...P };

  // 1. The same plugin under a different alias is still the reader.
  const renamed = [gh, { name: "vault__read", address: "vault.read", description: "", ...P, ...parked }];
  must(parkedReader(renamed)?.address === "vault.read", `an alias rename lost the reader: ${JSON.stringify(parkedReader(renamed))}`);

  // 2. A different tool name on a different plugin qualifies, because the
  //    declaration is the qualification.
  const other = [gh, { name: "box__fetch_back", address: "box.fetch_back", description: "", ...P, ...parked }];
  must(parkedReader(other)?.name === "box__fetch_back", `a second reader was not recognised: ${JSON.stringify(parkedReader(other))}`);

  // 3. Nothing declaring it means no reader — and this is the half that must
  //    not quietly become "the first tool": the limit note then has to say the
  //    rest is discarded rather than name a tool that cannot read it back.
  must(parkedReader([gh]) === null, "a tool that declares nothing was taken for the reader");
  const note = withLimitNote([gh], parkedReader([gh]));
  must(/discarded/.test(note[0]!.description) && !/read/i.test(note[0]!.description.split("over")[1] ?? ""),
    `with no reader the note must not name one: ${note[0]!.description}`);

  // 4. An address that merely LOOKS like the old pattern is not enough — this
  //    is what makes the three above a reading rather than a coincidence.
  const lookalike = [{ name: "artifacts__read", address: "artifacts.read", description: "", ...P }];
  must(parkedReader(lookalike) === null, "the old name pattern still qualifies a tool that declares nothing");

  // 5. And the declaration has to still be ON something. Everything above is
  //    about fixtures; without this the whole rule passes with the real plugin
  //    having quietly lost the field, and every parked result becomes a dead
  //    end while this suite stays green.
  const declaring = artifactsPlugin(null as any, "local").tools.filter((t) => t.reads === "parked-result");
  must(declaring.length === 1 && declaring[0]!.name === "read",
    `artifacts must declare exactly one parked-result reader, got ${JSON.stringify(declaring.map((t) => t.name))}`);
});

await check("a 10 KB result is parked when it can be read back, and kept whole when it cannot", async () => {
  // The line is low only where parking loses nothing; where the rest would be
  // discarded, a 10 KB result still arrives whole.
  must(10_000 > offloadLimit("files__read"), `with a reader, 10 KB must be parked (limit ${offloadLimit("files__read")})`);
  must(10_000 <= offloadLimit(null), `without a reader, 10 KB must not be cut (limit ${offloadLimit(null)})`);
  must(4 * 1024 <= offloadLimit("files__read"), "exactly 4 KiB still goes inline");
});

await check("a page read back from a parked result is not parked again at 4 KB", async () => {
  // The host sees addresses, not offered names, so the reader is matched by its
  // address; a 10 KB page must come back whole, while any other 10 KB result
  // from the same agent is still parked.
  const reader = { name: "artifacts__read", address: "artifacts.read" };
  must(10_000 <= limitForCall("artifacts.read", reader), `a 10 KB page read back must arrive whole (limit ${limitForCall("artifacts.read", reader)})`);
  must(10_000 > limitForCall("http.get", reader), `any other 10 KB result is still parked (limit ${limitForCall("http.get", reader)})`);
});

await check("run_js' missing fetch is stated as run_js' own, not as true of every place code runs", async () => {
  // A fresh agent read "There is no fetch" and then found fetch in the sandbox
  // container it had just used (Vera's fresh agent, 2026-09-13). The sentence
  // was about run_js; unscoped, it read as a claim about everywhere.
  const p = systemPrompt({ sandbox: true });
  must(!/(^|[.\n] ?)There is no fetch/.test(p), "an unscoped 'There is no fetch' is back in the prompt");
  must(/run_js code has no fetch/.test(p) && /true of run_js alone/.test(p), "the prompt must say whose fetch is missing");
});

await check("the model is told the size at which its results are parked", async () => {
  // A behaviour the model has to adapt to is stated where the model reads
  // and the number in that sentence is the one that parks.
  const said = await artifactsPlugin(null as any, "b").promptContribution!({ alias: "artifacts" } as any);
  must(String(said).includes(`over ${offloadLimit("artifacts__read") / 1024} KB`), `the prompt must state the parking size: ${said}`);
  must(String(said).includes("over 4 KB"), `tygg's number is 4K: ${said}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
