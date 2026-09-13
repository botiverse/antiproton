/**
 * What `read` does with the arguments its own summary promises.
 *
 * `fields`, `offset` and `limit` page a list. A parked result is often an
 * envelope around the list rather than the list itself — `state.get` parks
 * `{key, found, bytes, updatedAt, value}` — and reading only the top level
 * dropped all three without a word: a fresh agent asked for five items
 * projected to one field and received three hundred whole, larger than what it
 * had stored (Vera, 2026-09-13). Two model-facing sentences promise this works:
 * this tool's summary, and `state.get`'s, which sends the model here.
 *
 * So the cases below are the shapes a reference can point at, and the property
 * is the same for each: either the arguments apply, or the result says they did
 * not. A dropped argument must not look like one that had nothing to do.
 */
import { artifactsPlugin } from "../src/plugins/artifacts.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const BUCKET = "b";
/** The `read` tool, over a bucket holding one JSON document. */
function reader(doc: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(doc));
  const artifacts = { async get() { return body; } } as any;
  const plugin = artifactsPlugin(artifacts, BUCKET);
  const tool = plugin.tools.find((t) => t.name === "read")!;
  const ctx = { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any;
  return (args: Record<string, unknown>) =>
    plugin.invoke(tool.name, { ref: `r2://${BUCKET}/t/t/a/op.json`, ...args } as any, ctx) as Promise<any>;
}

const items = Array.from({ length: 300 }, (_, i) => ({ id: i, label: `row ${i}` }));

await check("a top-level array pages and projects, as it always did", async () => {
  const r = await reader(items)({ fields: ["id"], limit: 5 });
  if (r.kind !== "array" || r.returned !== 5) throw new Error(`not a page of five: ${JSON.stringify(r).slice(0, 120)}`);
  if (Object.keys(r.items[0]).join() !== "id") throw new Error(`not projected: ${JSON.stringify(r.items[0])}`);
  if (r.total !== 300) throw new Error(`total is the whole list, not the page: ${r.total}`);
});

await check("an envelope around one array pages and projects it, and says which", async () => {
  // The shape state.get parks. This is the case the fresh agent hit.
  const r = await reader({ key: "k", found: true, bytes: 19093, updatedAt: 1, value: items })({ fields: ["id"], limit: 5 });
  if (r.kind !== "array") throw new Error(`the envelope's list was not paged: ${JSON.stringify(r).slice(0, 140)}`);
  if (r.at !== "value") throw new Error(`the result does not say which key it paged: ${JSON.stringify(r.at)}`);
  if (r.returned !== 5 || r.total !== 300) throw new Error(`limit ignored: returned ${r.returned} of ${r.total}`);
  if (Object.keys(r.items[0]).join() !== "id") throw new Error(`fields ignored: ${JSON.stringify(r.items[0])}`);
});

await check("no array to page: the arguments are reported, not dropped", async () => {
  const r = await reader({ key: "k", found: true, value: "a string" })({ fields: ["id"], limit: 5 });
  if (r.kind !== "value") throw new Error(`a non-list was paged anyway: ${JSON.stringify(r).slice(0, 120)}`);
  if (!String(r.note ?? "").includes("holds none")) throw new Error(`the refusal to page is silent: ${JSON.stringify(r.note)}`);
});

await check("two arrays is a guess, so it says so and names them", async () => {
  const r = await reader({ rows: items, errors: [] })({ fields: ["id"] });
  if (r.kind !== "value") throw new Error(`one of two arrays was picked: ${JSON.stringify(r).slice(0, 120)}`);
  for (const k of ["rows", "errors"]) {
    if (!String(r.note ?? "").includes(k)) throw new Error(`the note does not name ${k}: ${JSON.stringify(r.note)}`);
  }
});

await check("asking for nothing gets the value whole, with no note about arguments", async () => {
  // The note exists to explain a dropped argument; with none given there is
  // nothing to explain, and a note would be noise on the common path.
  const r = await reader({ key: "k", value: "a string" })({});
  if (r.kind !== "value" || r.note !== undefined) throw new Error(`an unasked-for note appeared: ${JSON.stringify(r)}`);
});

await check("asking for nothing keeps the whole envelope, not its list alone", async () => {
  // The case the one above did not reach: its value held no array, so it never
  // exercised the descent. With an array inside, descending unasked returned
  // fifty items and dropped `key`, `bytes` and `updatedAt` (cody, 2026-09-13).
  // Descending is an inference about intent, and the arguments are its only
  // signal — so with none, nothing is inferred.
  const r = await reader({ key: "k", found: true, bytes: 19_093, updatedAt: 1, value: items })({});
  if (r.kind !== "value") throw new Error(`an envelope was paged without being asked: ${JSON.stringify(r).slice(0, 120)}`);
  for (const k of ["key", "bytes", "updatedAt"]) {
    if (!(k in (r.value as Record<string, unknown>))) throw new Error(`the envelope lost \`${k}\`: ${JSON.stringify(r.value).slice(0, 120)}`);
  }
  if ((r.value as any).value.length !== 300) throw new Error(`the list was truncated unasked: ${(r.value as any).value.length}`);
});

await check("a bare list still pages by default, as it always has", async () => {
  // The asymmetry is deliberate: a top-level array has nothing else in it to
  // lose, so its long-standing default paging is not a silent truncation.
  const r = await reader(items)({});
  if (r.kind !== "array" || r.returned !== 50) throw new Error(`the default page changed: ${JSON.stringify(r).slice(0, 120)}`);
});

await check("以自己的前缀开头,不等于停在里面", async () => {
  // A reference may begin inside this agent's prefix and still move out of it:
  // the prefix test reads the front of the string, and nothing read the rest.
  // What kept it from escaping was R2 treating a key as opaque — true, and
  // written down nowhere, so the guard could not see the dependency it had
  // (Vera, 2026-09-13). Refused here now, so it no longer rests on the store.
  const r = reader({ any: "thing" });
  const escapes = `r2://${BUCKET}/t/t/a/state/aa/../../../../othertenant/u-else/state/pwn.json`;
  let refused = false;
  try { await r({ ref: escapes }); } catch (e) { refused = /not readable by this agent/.test(String((e as Error).message)); }
  if (!refused) throw new Error("a reference that starts inside the prefix and then leaves it was accepted");
});

await check("被拒的是路径段,不是字符: `notes..old` 仍是一个名字", async () => {
  // The refusal must be about a segment that means "up", not about two dots
  // appearing in a name. A guard that cannot tell them apart takes away a
  // legal key to stop an illegal move.
  const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
  const plugin = artifactsPlugin({ async get() { return body; } } as any, BUCKET);
  const ctx = { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any;
  const out = await plugin.invoke("read", { ref: `r2://${BUCKET}/t/t/a/state/notes..old.json` } as any, ctx) as any;
  if (out.kind !== "value") throw new Error(`a name containing two dots was refused: ${JSON.stringify(out)}`);
});

console.log(`\n  What \`read\` does with fields, offset and limit\n  ${"─".repeat(56)}`);
await check("from continues a cut result page by page, and the pages join back into the exact text", async () => {
  // Following the notes is the whole contract: each page says where the next
  // starts, and nothing is skipped or repeated at the seams.
  const doc = Array.from({ length: 2000 }, (_, i) => ({ id: i, label: `row ${i} \u00e9\u{1F600}` }));
  const raw = JSON.stringify(doc);
  const read = reader(doc);
  let from = 0, joined = "", pages = 0;
  for (;;) {
    const r = await read({ from });
    if (r.kind !== "text" || r.from !== from) throw new Error(`not a text page from ${from}: ${JSON.stringify(r).slice(0, 120)}`);
    joined += r.text; pages++;
    const next = /from: (\d+)/.exec(String(r.note));
    if (!next) { if (!/end of result/.test(String(r.note))) throw new Error(`last page does not say it ended: ${r.note}`); break; }
    from = Number(next[1]);
    if (pages > 50) throw new Error("the notes never reach the end");
  }
  if (pages < 3) throw new Error(`expected several pages for ${raw.length} characters, got ${pages}`);
  if (joined !== raw) throw new Error(`pages do not join into the stored text (${joined.length} vs ${raw.length})`);
});

await check("a page never ends inside a character", async () => {
  // Stored text is '"' + 16382 a's + an emoji: character 16383 is the first half
  // of the emoji, exactly where a 16 KB page would end.
  const r = await reader("a".repeat(16_382) + "\u{1F600}")({ from: 0 });
  const last = r.text.charCodeAt(r.text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) throw new Error(`page ends in half a character (length ${r.text.length})`);
  if (!String(r.note).includes("from: 16383")) throw new Error(`next page must start at the emoji: ${r.note}`);
});

await check("from with list arguments says they were not used, rather than dropping them", async () => {
  // Piper, 2026-09-13: fields came back silently ignored, the shape #270 removed.
  const r = await reader(items)({ from: 0, fields: ["id"], limit: 5 });
  if (r.kind !== "text") throw new Error(`from must page text: ${JSON.stringify(r).slice(0, 120)}`);
  if (!/fields, limit .*not used/.test(String(r.note))) throw new Error(`the unused arguments are not named: ${r.note}`);
  const plain = await reader(items)({ from: 0 });
  if (/not used/.test(String(plain.note))) throw new Error(`nothing was given, so nothing is unused: ${plain.note}`);
});

await check("a from on the second half of a character starts at the whole character", async () => {
  // Stored text is '"' + ten a's + an emoji + 'b"': 11 is its first half, 12 its second.
  const r = await reader("a".repeat(10) + "\u{1F600}b")({ from: 12 });
  if (r.from !== 11) throw new Error(`the page must start at the pair, and say so: from ${r.from}`);
  const c = r.text.charCodeAt(0);
  if (c >= 0xdc00 && c <= 0xdfff) throw new Error(`page starts with half a character: ${c.toString(16)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
