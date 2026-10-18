/**
 * What `read` does with the arguments its own summary promises.
 *
 * `fields`, `offset` and `limit` page a list. A parked result is often an
 * envelope around the list rather than the list itself — `state.get` parks
 * `{key, found, bytes, updatedAt, value}` — and reading only the top level
 * dropped all three without a word: a fresh agent asked for five items
 * projected to one field and received three hundred whole, larger than what it
 * had stored. Two model-facing sentences promise this works:
 * this tool's summary, and `state.get`'s, which sends the model here.
 *
 * So the cases below are the shapes a reference can point at, and the property
 * is the same for each: either the arguments apply, or the result says they did
 * not. A dropped argument must not look like one that had nothing to do.
 */
import { createHash, randomBytes } from "node:crypto";
import { artifactsPlugin, BASE64_PAGE } from "../src/plugins/artifacts.ts";
import { BoundArtifacts } from "../cf/src/runtime.ts";
import { R2Artifacts } from "../src/store/artifacts.ts";

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
  // fifty items and dropped `key`, `bytes` and `updatedAt`.
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
  // Refused here now, so it no longer rests on the store.
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

await check("模型拿到的引用里没有桶名、租户名、agent 名", async () => {
  // The whole point of the change: what a reference carries is the path under
  // this agent's own scope, and nothing about where the agent lives (tygg,
  // 2026-09-14). Asserting the shown form is present is not enough — a value
  // that carried both would pass that.
  const r = reader({ ok: true });
  const out = await r({ ref: "artifact://state/huge2.json" });
  if (out.kind !== "value") throw new Error(`the shown form was not readable: ${JSON.stringify(out)}`);
  const text = JSON.stringify(out);
  for (const leak of ["r2://", "/t/", BUCKET]) {
    if (text.includes(leak)) throw new Error(`the answer carries ${leak}: ${text.slice(0, 140)}`);
  }
});

await check("旧转录里的原始引用仍读得回来,但别人的仍然不行", async () => {
  // Transcripts written before the change hold raw references, so refusing
  // them outright would make old work unreadable — the failure we repaired
  // twice this week. They are accepted only inside the caller's own scope.
  const r = reader({ ok: true });
  const mine = await r({ ref: `r2://${BUCKET}/t/t/a/state/huge2.json` });
  if (mine.kind !== "value") throw new Error(`a legacy reference of this agent's was refused: ${JSON.stringify(mine)}`);

  let refused = false;
  try { await r({ ref: `r2://${BUCKET}/t/other/u-else/state/huge2.json` }); }
  catch (e) { refused = /not readable by this agent/.test(String((e as Error).message)); }
  if (!refused) throw new Error("a legacy reference belonging to another agent was accepted");
});

await check("说不出别人的东西: 新形式里根本没有能指向别人的那一段", async () => {
  // Under the shown form the caller supplies only the path inside its own
  // scope, so naming another agent's object is not refused — it cannot be
  // expressed. The nearest attempt is a path, and it resolves under the
  // caller's own prefix.
  const seen: string[] = [];
  const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
  const plugin = artifactsPlugin({ async get(key: string) { seen.push(key); return body; } } as any, BUCKET);
  const ctx = { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any;
  await plugin.invoke("read", { ref: "artifact://t/other/u-else/state/huge2.json" } as any, ctx);
  if (seen[0] !== "t/t/a/t/other/u-else/state/huge2.json") {
    throw new Error(`an attempt to name another agent did not land under the caller's own scope: ${seen[0]}`);
  }
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

// ---- bytes that are not text -------------------------------------------------------------------------------------
// Every stored object was decoded as UTF-8 and, when it did not parse as JSON, returned as text: a JPEG came back as
// {"kind":"text","bytes":217302} of U+FFFD, and `bytes` counted UTF-16 characters, not bytes.

const REF = `r2://${BUCKET}/t/t/a/op.bin`;
/** The `read` tool over a store holding `body`, with the content type it was stored with when one is given. */
function bytesReader(body: Uint8Array, contentType?: string) {
  const artifacts = contentType === undefined
    ? { async get() { return body; } }
    : { async get() { return body; }, async getObject() { return { bytes: body, contentType }; } };
  const plugin = artifactsPlugin(artifacts, BUCKET);
  const ctx = { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any;
  return (args: Record<string, unknown> = {}) => plugin.invoke("read", { ref: REF, ...args } as any, ctx) as Promise<any>;
}
const cat = (...parts: Array<number[] | Uint8Array>) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) => cat([0x89, ...ascii("PNG\r\n\x1a\n")], be32(13), ascii("IHDR"), be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0],
  be32(0), ascii("IEND"), [0xae, 0x42, 0x60, 0x82]);
const jpeg = (w: number, h: number) => cat([0xff, 0xd8], [0xff, 0xe0], [0, 16], ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0], [0, 17], [8], [h >> 8, h & 255], [w >> 8, w & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const notText = (r: any) => {
  if ("text" in r || "value" in r || "items" in r) throw new Error(`binary content came back as text: ${JSON.stringify(r).slice(0, 160)}`);
};

await check("a JPEG is an image with its size and dimensions, and a view so the model sees it", async () => {
  const body = jpeg(1449, 2048);
  const r = await bytesReader(body)();
  notText(r);
  if (r.kind !== "image" || r.mimeType !== "image/jpeg") throw new Error(`not read as a JPEG: ${JSON.stringify(r).slice(0, 160)}`);
  if (r.width !== 1449 || r.height !== 2048 || r.bytes !== body.byteLength) throw new Error(`size or dimensions wrong: ${JSON.stringify(r)}`);
  if (r.sha256 !== sha(body)) throw new Error(`sha256 wrong: ${r.sha256}`);
  const v = r.view;
  if (!v || v.ref !== "artifact://op.bin" || v.mimeType !== "image/jpeg" || v.bytes !== body.byteLength || v.width !== 1449 || v.height !== 2048) {
    throw new Error(`no view, or not the stored image's: ${JSON.stringify(v)}`);
  }
});

await check("a PNG is an image with a view; one over the harness's side limit is described and not shown", async () => {
  const r = await bytesReader(png(640, 480))();
  if (r.kind !== "image" || r.mimeType !== "image/png" || r.width !== 640 || r.height !== 480 || !r.view) {
    throw new Error(`not a viewable PNG: ${JSON.stringify(r).slice(0, 160)}`);
  }
  const big = await bytesReader(png(9000, 10))();
  notText(big);
  if (big.kind !== "image" || big.view !== undefined) throw new Error(`an image over the limit was offered for viewing: ${JSON.stringify(big)}`);
  if (!/cannot be shown: .*9000x10, over the 8192-pixel limit/.test(String(big.note))) throw new Error(`the note does not say why: ${big.note}`);
});

await check("random bytes are binary: size and sha256, no text", async () => {
  const body = new Uint8Array(randomBytes(4096));
  const r = await bytesReader(body)();
  notText(r);
  if (r.kind !== "binary" || r.bytes !== 4096 || r.sha256 !== sha(body)) throw new Error(`not described as binary: ${JSON.stringify(r).slice(0, 160)}`);
  if (!/binary content is not returned as text/.test(String(r.note))) throw new Error(`no hint: ${r.note}`);
});

await check("bytes that are not valid UTF-8, with no NUL and no signature, are binary", async () => {
  const body = cat(ascii("caf"), [0xe9], ascii(" au lait, "), [0xc3, 0x28], ascii(" and more text"));
  if (body.includes(0)) throw new Error("fixture holds a NUL, so it would not test the decoder");
  const r = await bytesReader(body)();
  notText(r);
  if (r.kind !== "binary" || r.bytes !== body.byteLength) throw new Error(`invalid UTF-8 was not binary: ${JSON.stringify(r).slice(0, 160)}`);
});

await check("valid UTF-8 with a NUL in it is binary", async () => {
  const body = new TextEncoder().encode("header\0payload that is otherwise plain text");
  const r = await bytesReader(body)();
  notText(r);
  if (r.kind !== "binary") throw new Error(`a NUL-holding file was text: ${JSON.stringify(r).slice(0, 160)}`);
});

await check("a known signature names the type: gzip", async () => {
  const r = await bytesReader(cat([0x1f, 0x8b, 0x08, 0x00], ascii("rest")))();
  if (r.kind !== "binary" || r.mimeType !== "application/gzip") throw new Error(`gzip not named: ${JSON.stringify(r)}`);
});

await check("multi-byte UTF-8 text: bytes is the stored byte length, not a count of characters", async () => {
  const text = "héllo 世界 \u{1F600} plain text, not JSON";
  const body = new TextEncoder().encode(text);
  if (body.byteLength === text.length) throw new Error("fixture is single-byte, so it would not test the count");
  const r = await bytesReader(body)();
  if (r.kind !== "text" || r.text !== text) throw new Error(`text changed: ${JSON.stringify(r)}`);
  if (r.bytes !== body.byteLength) throw new Error(`bytes is ${r.bytes}, the file is ${body.byteLength} bytes`);
  const paged = await bytesReader(body)({ from: 0 });
  if (paged.kind !== "text" || paged.bytes !== body.byteLength || paged.text !== text) throw new Error(`from page wrong: ${JSON.stringify(paged)}`);
});

await check("JSON with multi-byte characters still reads as a value", async () => {
  const r = await bytesReader(new TextEncoder().encode(JSON.stringify({ name: "世界", n: 1 })))();
  if (r.kind !== "value" || r.value.name !== "世界" || r.value.n !== 1) throw new Error(`JSON changed: ${JSON.stringify(r)}`);
});

await check("the content type it was stored with is the type of a file no signature names", async () => {
  const body = cat([0x01, 0x02, 0x00, 0x03]);
  const r = await bytesReader(body, "application/x-custom")();
  if (r.kind !== "binary" || r.mimeType !== "application/x-custom" || r.contentType !== "application/x-custom") {
    throw new Error(`stored type not used: ${JSON.stringify(r)}`);
  }
  // The bytes outrank a declared type.
  const lied = await bytesReader(png(10, 10), "text/plain")();
  if (lied.kind !== "image" || lied.mimeType !== "image/png") throw new Error(`a declared type overrode the bytes: ${JSON.stringify(lied)}`);
});

await check("the runtime's store keeps the content type it is given, and read reports it", async () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket = {
    async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { httpMetadata: { contentType: o.contentType }, async arrayBuffer() { return o.bytes.slice().buffer; } } : null;
    },
  } as any;
  const store = new BoundArtifacts(bucket, BUCKET);
  await store.put("t/t/a/op.bin", cat([0x00, 0x10, 0x20]), "application/x-sqlite3");
  const plugin = artifactsPlugin(store, BUCKET);
  const r = await plugin.invoke("read", { ref: REF } as any, { caller: { tenantId: "t", agentId: "a" }, alias: "artifacts" } as any) as any;
  if (r.kind !== "binary" || r.mimeType !== "application/x-sqlite3") throw new Error(`the stored content type was lost: ${JSON.stringify(r)}`);
});

await check("encoding base64 pages the stored bytes, and the pages put back are the file", async () => {
  const body = new Uint8Array(randomBytes(BASE64_PAGE * 2 + 100));
  const read = bytesReader(body);
  const parts: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < 5; i++) {
    const r = await read({ encoding: "base64", from });
    if (r.kind !== "base64" || r.from !== from || r.bytes !== body.byteLength) throw new Error(`page wrong: ${JSON.stringify(r).slice(0, 160)}`);
    if (r.to - r.from > BASE64_PAGE) throw new Error(`page over ${BASE64_PAGE} bytes: ${r.to - r.from}`);
    parts.push(Buffer.from(r.data, "base64"));
    if (r.to >= body.byteLength) {
      if (!/end of artifact/.test(r.note)) throw new Error(`last page does not say so: ${r.note}`);
      break;
    }
    if (!r.note.includes(`from: ${r.to}`)) throw new Error(`the note does not give the next call: ${r.note}`);
    from = r.to;
  }
  if (!Buffer.concat(parts).equals(Buffer.from(body))) throw new Error("the pages do not reassemble the file");
  await read({ encoding: "hex" }).then(() => { throw new Error("an unknown encoding was accepted"); }, (e) => {
    if (!/encoding must be "base64"/.test(String(e?.message))) throw e;
  });
});

await check("a from on binary content is named as not used, not silently dropped", async () => {
  const r = await bytesReader(new Uint8Array(randomBytes(64)))({ from: 10 });
  if (r.kind !== "binary" || !/from page text or a list, so they were not used/.test(String(r.note))) throw new Error(`from was dropped silently: ${JSON.stringify(r)}`);
});

await check("both stores answer size (sandbox put) and getObject (read) for the same object", async () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const bucket = {
    async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { httpMetadata: { contentType: o.contentType }, async arrayBuffer() { return o.bytes.slice().buffer; } } : null;
    },
    async head(key: string) { const o = objects.get(key); return o ? { size: o.bytes.byteLength } : null; },
  } as any;
  const bound = new BoundArtifacts(bucket, BUCKET);
  await bound.put("t/t/a/p.jpg", cat([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
  const got = await bound.getObject("t/t/a/p.jpg");
  if (await bound.size("t/t/a/p.jpg") !== 4 || await bound.size("t/t/a/none") !== null) throw new Error("binding size wrong");
  if (got.bytes.byteLength !== 4 || got.contentType !== "image/jpeg") throw new Error(`binding getObject wrong: ${JSON.stringify(got)}`);

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string, init?: any) => {
      const there = String(url).endsWith("/b/t/t/a/p.jpg");
      if (init?.method === "HEAD") return there ? new Response(null, { headers: { "content-length": "4" } }) : new Response(null, { status: 404 });
      return there ? new Response(cat([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg" } }) : new Response("", { status: 404 });
    }) as any;
    const sig = new R2Artifacts({ endpoint: "https://r2.example", accessKeyId: "k", secretAccessKey: "s", bucket: BUCKET });
    if (await sig.size("t/t/a/p.jpg") !== 4 || await sig.size("t/t/a/none") !== null) throw new Error("SigV4 size wrong");
    const o = await sig.getObject("t/t/a/p.jpg");
    if (o.bytes.byteLength !== 4 || o.contentType !== "image/jpeg") throw new Error(`SigV4 getObject wrong: ${JSON.stringify(o)}`);
  } finally { globalThis.fetch = realFetch; }
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
