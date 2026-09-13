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

console.log(`\n  What \`read\` does with fields, offset and limit\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
