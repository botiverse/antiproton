/**
 * `attachments_view` (src/plugins/raft.ts): an image attachment kept as the download keeps it, with a `view` the gateway
 * hands the model as image content. What the bytes are is read from the bytes (`imageHeader`), never from Raft's type;
 * the limits (`VIEW_MAX_BYTES`, `VIEW_MAX_SIDE`) are applied to what was read; and the tool is offered exactly where
 * `attachments_download_url` is. The images here are tiny real headers, built below.
 */
import { RAFT_OPERATIONS } from "@botiverse/raft-sdk";
import {
  raftPlugin as raftWithoutStorage, createRaftPlugin, downloadAttachment, viewAttachment, imageHeader, toolsBasisOf, EXCLUDED, FEATURES_BASIS,
  GENERATED, VIEW_TOOL, VIEW_MAX_BYTES, VIEW_MAX_SIDE,
} from "../src/plugins/raft.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import { toolsOf } from "../src/plugins/types.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const originalFetch = globalThis.fetch;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
async function failure(fn: () => Promise<unknown>): Promise<Error> {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error("expected failure");
}

// ---- tiny real images ---------------------------------------------------------------------------------------------

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = (v: number) => [v & 255, (v >>> 8) & 255];
const le24 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
const le32 = (v: number) => [...le16(v & 0xffff), ...le16(v >>> 16)];
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

/** A PNG's signature and IHDR (8-bit RGBA), the chunks in `before` ahead of IEND, padded to `size` bytes when asked. */
function png(width: number, height: number, size?: number, before: number[][] = []): Uint8Array {
  const head = bytes([0x89, ...ascii("PNG\r\n\x1a\n")], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0],
    ...before, be32(0), ascii("IEND"), [0xae, 0x42, 0x60, 0x82]);
  if (size === undefined) return head;
  const out = new Uint8Array(size);
  out.set(head);
  return out;
}
/**
 * A baseline JPEG: SOI, APP0, a DHT (C4) before the frame header — whose bytes would read as 0x0101 × 0x0202 if C4 were
 * taken for a SOF — fill bytes, then SOF`sof` with the dimensions, then EOI.
 */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return bytes([0xff, 0xd8], [0xff, 0xe0], [0, 16], ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc4], [0, 8], [0x00, 0x01, 0x01, 0x02, 0x02, 0x00],
    [0xff, 0xff], [0xff, sof], [0, 17], [8], [height >> 8, height & 255], [width >> 8, width & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9]);
}
const riff = (chunk: number[]) => bytes(ascii("RIFF"), le32(4 + chunk.length), ascii("WEBP"), chunk);
/** A lossy WebP (`VP8 `): frame tag, start code, 14-bit width and height. */
const webpLossy = (w: number, h: number) => riff([...ascii("VP8 "), ...le32(10), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
/** A lossless WebP (`VP8L`): signature 0x2f, then width-1 and height-1 in 14 bits each. */
function webpLossless(w: number, h: number): Uint8Array {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff([...ascii("VP8L"), ...le32(5), 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
}
/** An extended WebP (`VP8X`): flags (0x02 is animation), then canvas width-1 and height-1 in 24 bits each. */
const webpExtended = (w: number, h: number, flags = 0x10) => riff([...ascii("VP8X"), ...le32(10), flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
/**
 * A GIF89a with a two-colour global table and `frames` images, each behind a graphic control extension; an animated one
 * carries the NETSCAPE loop extension too. Each image is 1×1 at the screen's origin with one LZW sub-block.
 */
function gif(width: number, height: number, frames = 1): Uint8Array {
  const image = [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];
  const loop = frames > 1 ? [0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0] : [];
  return bytes(ascii("GIF89a"), le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255], loop,
    ...Array.from({ length: frames }, () => image), [0x3b]);
}
const PDF = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n");

// ---- Raft and its storage, faked ---------------------------------------------------------------------------------

function ctx() {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" },
    alias: "raft", credential: "sk_agent_test_1234567890", publicConfig: { serverUrl: "https://raft.example" },
    sibling: async () => null, sandboxForms: async () => [],
  } as any;
}
function fakeArtifacts() {
  const puts: Array<{ key: string; body: Uint8Array; type?: string }> = [];
  return { puts, async put(key: string, body: Uint8Array, type?: string) { puts.push({ key, body, type }); return { ref: `r2://bucket/${key}`, bytes: body.byteLength }; }, async get(): Promise<Uint8Array> { throw new Error("no such artifact"); }, async head() { return null; } };
}
const PRESIGNED = "https://storage.example/obj/x?X-Amz-Signature=SIG";
/** Raft mints a URL for att-1 with `filename` and the type it declares; storage answers with `body`. */
function server(body: Uint8Array, filename: string, mimeType: string) {
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    if (u.href === PRESIGNED) return new Response(body);
    if (u.pathname === "/internal/agent-api/attachments/att-1/url") {
      return new Response(JSON.stringify({ url: PRESIGNED, expiresAt: "2026-10-12T10:05:00Z", filename, mimeType }), { headers: { "content-type": "application/json" } });
    }
    if (u.pathname === "/internal/agent-api/context") {
      return new Response(JSON.stringify({ agent: { id: "agent-1", name: "raft-bot", displayName: null, description: null, runtime: "external", external: true },
        server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: CAPS }, prompt: null }), { headers: { "content-type": "application/json" } });
    }
    if (u.pathname === "/internal/agent-api") {
      return new Response(JSON.stringify({ agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as any;
}
let CAPS: string[] = ["read"];

/** The view of `body` as Raft would hand it over, named `filename`, declared `mimeType`. */
async function view(body: Uint8Array, filename = "pic", mimeType = "image/png", store = fakeArtifacts()) {
  server(body, filename, mimeType);
  return viewAttachment({ attachmentId: "att-1" }, ctx(), store) as Promise<any>;
}

// ---- formats -----------------------------------------------------------------------------------------------------

await check("each format is shown with the type read from its bytes and the dimensions from its header", async () => {
  const cases: Array<[string, Uint8Array, string, number, number]> = [
    ["png", png(640, 480), "image/png", 640, 480],
    ["jpeg (baseline, a DHT before the SOF, fill bytes)", jpeg(1024, 768), "image/jpeg", 1024, 768],
    ["jpeg (progressive SOF2)", jpeg(300, 200, 0xc2), "image/jpeg", 300, 200],
    ["webp VP8", webpLossy(320, 240), "image/webp", 320, 240],
    ["webp VP8L", webpLossless(1999, 17), "image/webp", 1999, 17],
    ["webp VP8X (still, alpha)", webpExtended(800, 600), "image/webp", 800, 600],
    ["gif (one frame)", gif(64, 32), "image/gif", 64, 32],
  ];
  for (const [what, body, mimeType, width, height] of cases) {
    const store = fakeArtifacts();
    const out = await view(body, "pic", "image/png", store);
    const ref = "artifact://raft/attachments/att-1/pic";
    const want = { attachmentId: "att-1", ref, name: "pic", type: "image/png", bytes: body.byteLength,
      view: { ref, mimeType, width, height, bytes: body.byteLength } };
    must(JSON.stringify(out) === JSON.stringify(want), `${what}: ${JSON.stringify(out)}`);
    // Kept exactly as the download keeps it: one object, the bytes as they came, under the download's key.
    must(store.puts.length === 1 && store.puts[0]!.key === "t/tenant/agent/raft/attachments/att-1/pic" && Buffer.compare(Buffer.from(store.puts[0]!.body), Buffer.from(body)) === 0,
      `${what}: stored ${JSON.stringify(store.puts.map((p) => p.key))}`);
    // No bytes in the result: it is small JSON, never the image.
    must(JSON.stringify(out).length < 400, `${what}: the result carries more than a reference`);
  }
});

await check("the type is read from the bytes, never taken from Raft: a JPEG Raft calls image/png is image/jpeg, a PDF it calls image/png is refused", async () => {
  const out = await view(jpeg(10, 20), "photo.png", "image/png");
  must(out.type === "image/png" && out.view.mimeType === "image/jpeg" && out.view.width === 10 && out.view.height === 20, JSON.stringify(out));
  const store = fakeArtifacts();
  const why = await failure(() => view(PDF, "photo.png", "image/png", store));
  must(/is a PDF document, by its first bytes \(Raft calls it "image\/png"\)/.test(why.message), why.message);
  must(why.message.includes("use attachments_download_url"), `no pointer at the download: ${why.message}`);
  // Kept anyway, and the refusal hands over the reference.
  must(store.puts.length === 1 && why.message.includes("It was kept as artifact://raft/attachments/att-1/photo.png."), `kept: ${store.puts.length}: ${why.message}`);
  // Other things that are not one of the four, each named.
  for (const [body, what] of [
    [bytes(ascii("BM"), Array(52).fill(0)), "a BMP image"],
    [new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'), "an SVG image"],
    [bytes(ascii("II*\0"), [8, 0, 0, 0]), "a TIFF image"],
    [bytes([0, 0, 1, 0, 1, 0, 16, 16]), "an ICO icon"],
    [bytes([0, 0, 0, 28], ascii("ftypavif")), "an AVIF image"],
    [bytes([0, 0, 0, 24], ascii("ftypheic")), "a HEIC image"],
    [bytes([0, 0, 0, 32], ascii("ftypisom")), "a video or other ISO media file"],
    [bytes(ascii("PK\x03\x04"), [20, 0]), "a ZIP archive (or a document built on one, such as .docx)"],
    [riff([...ascii("ALPH"), 0, 0, 0, 0]), "a WebP of a kind whose header is not read here"],
    [new TextEncoder().encode("just some text"), "a file of a type this tool does not recognise"],
    [new Uint8Array(0), "a file of a type this tool does not recognise"],
  ] as const) {
    const e = await failure(() => view(body, "x.png", "image/png"));
    must(e.message.includes(` is ${what}, `) && e.message.includes("attachments_download_url"), `${what}: ${e.message}`);
  }
});

await check("an animated GIF (two image descriptors) is refused; the same GIF with one is shown", async () => {
  const two = gif(50, 40, 2);
  // The fixture is what it claims: two image descriptors (0x2c at a block start) where the still one has one.
  must(imageHeader(gif(50, 40, 1)).ok && two.filter((b, i) => b === 0x2c && two[i - 1] === 0).length >= 2, "control: the fixture");
  const why = await failure(() => view(two, "anim.gif", "image/gif"));
  must(/is an animated GIF, by its first bytes/.test(why.message) && why.message.includes("It was kept as artifact://"), why.message);
  const still = await view(gif(50, 40, 1), "still.gif", "image/gif");
  must(still.view.mimeType === "image/gif" && still.view.width === 50 && still.view.height === 40, JSON.stringify(still));
});

/** A PNG chunk: length, type, data, and a CRC the header reader never checks. */
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

await check("an animated PNG (acTL before the image data) is refused; acTL after it, a tEXt before it, and IDAT ending the walk are shown", async () => {
  const actl = chunk("acTL", [...be32(2), ...be32(0)]);
  const idat = chunk("IDAT", [0x78, 0x9c]);
  const why = await failure(() => view(png(64, 48, undefined, [chunk("tEXt", ascii("a\0b")), actl, idat])));
  must(/is an animated PNG, by its first bytes/.test(why.message) && why.message.includes("It was kept as artifact://"), why.message);
  for (const before of [[idat, actl], [chunk("tEXt", ascii("a\0b")), idat]]) {
    const out = await view(png(64, 48, undefined, before));
    must(out.view.mimeType === "image/png" && out.view.width === 64 && out.view.height === 48, JSON.stringify(out));
  }
});

await check("a JPEG with stand-alone markers (TEM, RST0, RST7) before its frame header is read through them", async () => {
  for (const m of [0x01, 0xd0, 0xd7]) {
    const j = jpeg(30, 40);
    const withMarker = bytes([...j.subarray(0, 2)], [0xff, m], [...j.subarray(2)]);
    const got = imageHeader(withMarker);
    must(got.ok && got.width === 30 && got.height === 40, `marker ${m.toString(16)}: ${JSON.stringify(got)}`);
  }
});

await check("an animated WebP (the VP8X animation flag) is refused; the same header without the flag is shown", async () => {
  const why = await failure(() => view(webpExtended(100, 100, 0x12), "anim.webp", "image/webp"));
  must(/is an animated WebP, by its first bytes/.test(why.message), why.message);
  const still = await view(webpExtended(100, 100, 0x10), "still.webp", "image/webp");
  must(still.view.width === 100 && still.view.height === 100, JSON.stringify(still));
});

// ---- limits ------------------------------------------------------------------------------------------------------

await check("the byte limit: exactly VIEW_MAX_BYTES is shown, one byte more is refused with both sizes said", async () => {
  must(VIEW_MAX_BYTES === 1.5 * 1024 * 1024 && VIEW_MAX_SIDE === 2000, `limits: ${VIEW_MAX_BYTES} ${VIEW_MAX_SIDE}`);
  const at = await view(png(100, 100, VIEW_MAX_BYTES));
  must(at.view.bytes === VIEW_MAX_BYTES && at.bytes === VIEW_MAX_BYTES, JSON.stringify(at));
  const store = fakeArtifacts();
  const why = await failure(() => view(png(100, 100, VIEW_MAX_BYTES + 1), "big.png", "image/png", store));
  must(why.message.includes(`1.5 MiB (${VIEW_MAX_BYTES + 1} bytes), over the 1.5 MiB (${VIEW_MAX_BYTES} bytes) limit`), why.message);
  must(why.message.includes("not resized") && why.message.includes("It was kept as artifact://raft/attachments/att-1/big.png.") && store.puts.length === 1, why.message);
});

await check("the side limit: 2000×2000 is shown; 2001 on either side is refused with the dimensions and the limit said", async () => {
  const at = await view(png(VIEW_MAX_SIDE, VIEW_MAX_SIDE));
  must(at.view.width === 2000 && at.view.height === 2000, JSON.stringify(at));
  for (const [w, h] of [[2001, 10], [10, 2001]]) {
    for (const body of [png(w, h), jpeg(w, h), webpLossless(w, h), gif(w, h)]) {
      const why = await failure(() => view(body));
      must(why.message.includes(`${w}×${h} px, over the 2000 px limit on a side`), `${w}×${h}: ${why.message}`);
    }
  }
  // Both over at once: both said.
  const both = await failure(() => view(png(3000, 3000, VIEW_MAX_BYTES + 10)));
  must(both.message.includes("bytes) limit; and 3000×3000 px"), both.message);
});

// ---- headers that cannot be read ---------------------------------------------------------------------------------

await check("a cut-short header is refused, never read past its end, never answered with dimensions it does not give", async () => {
  const samples: Array<[string, Uint8Array]> = [
    // Every dimension with both bytes non-zero, so a byte read past the end (undefined, so 0) cannot give the same answer.
    ["png", png(0x1a3, 0x1b5)], ["jpeg", jpeg(0x3a7, 0x2f1)], ["webp VP8", webpLossy(0x1c3, 0x1d5)], ["webp VP8L", webpLossless(0x2c7, 0x1e9)],
    ["webp VP8X", webpExtended(0x10305, 0x10207)], ["gif", gif(0x123, 0x145)], ["animated gif", gif(0x123, 0x145, 3)],
  ];
  for (const [what, full] of samples) {
    const whole = imageHeader(full);
    for (let k = 0; k < full.length; k++) {
      let got: ReturnType<typeof imageHeader>;
      try { got = imageHeader(full.subarray(0, k)); } catch (e) { throw new Error(`${what} cut at ${k}: threw ${(e as Error).name}: ${(e as Error).message}`); }
      // Either refused, or (a PNG, JPEG or WebP whose header is whole before the file ends) exactly the whole file's answer.
      if (got.ok && JSON.stringify(got) !== JSON.stringify(whole)) throw new Error(`${what} cut at ${k}: ${JSON.stringify(got)}`);
      // A GIF is read to its trailer, so any cut is refused; the others are refused while their dimensions are cut.
      if (what.includes("gif") && got.ok) throw new Error(`${what} cut at ${k} was read as whole`);
    }
  }
  // The minimum lengths at which each is answered, so "refused while cut" above is about the dimensions, not luck.
  // A PNG is read to its first IDAT or IEND (an APNG's acTL comes before either), so a cut before that is refused.
  const whole = png(0x1a3, 0x1b5);
  must(!imageHeader(whole.subarray(0, whole.byteLength - 5)).ok && imageHeader(whole.subarray(0, whole.byteLength - 4)).ok, "png at IEND's type");
  const cutBeforeData = imageHeader(whole.subarray(0, 37));
  must(!cutBeforeData.ok && cutBeforeData.what === "a PNG cut short before its image data, so whether it is animated cannot be told", JSON.stringify(cutBeforeData));
  must(!imageHeader(webpLossy(320, 240).subarray(0, 29)).ok && imageHeader(webpLossy(320, 240).subarray(0, 30)).ok, "VP8 at 29/30");
  // Through the tool: a cut PNG is a refusal saying so, an Error and not a RangeError.
  const why = await failure(() => view(png(640, 480).subarray(0, 20)));
  must(!(why instanceof RangeError) && /a PNG whose header is cut short or malformed/.test(why.message), `${why.name}: ${why.message}`);
});

await check("hostile headers end: JPEG lengths of 0 and 1, a GIF sub-block running off the end, zero dimensions, random bytes", async () => {
  const cases: Array<[string, Uint8Array, RegExp]> = [
    ["jpeg length 0", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xc0]), /JPEG whose frame header/],
    ["jpeg length 1", bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xc0, 0, 17]), /JPEG whose frame header/],
    ["jpeg SOF too short to hold dimensions", bytes([0xff, 0xd8, 0xff, 0xc0, 0, 2, 0xff, 0xd9, 0, 9, 0, 9, 3]), /JPEG whose frame header/],
    ["jpeg SOS before any SOF", bytes([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xc0, 0, 17, 8, 0, 9, 0, 9]), /JPEG whose frame header/],
    ["jpeg SOF height 0 (DNL)", jpeg(10, 0), /JPEG whose header gives no dimensions/],
    ["gif sub-block past the end", bytes(ascii("GIF89a"), le16(1), le16(1), [0, 0, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 200, 1, 2]), /GIF cut short/],
    ["gif with no image", bytes(ascii("GIF89a"), le16(1), le16(1), [0, 0, 0, 0x3b]), /GIF with no image/],
    ["gif with a stray block", bytes(ascii("GIF89a"), le16(1), le16(1), [0, 0, 0, 0x99]), /GIF whose blocks are malformed/],
    ["png 0 wide", png(0, 10), /PNG whose header gives no dimensions/],
    ["gif 0 high", gif(10, 0), /GIF whose header gives no dimensions/],
    ["png IHDR missing", bytes([0x89, ...ascii("PNG\r\n\x1a\n")], be32(13), ascii("IDAT"), be32(1), be32(1)), /PNG whose header is cut short or malformed/],
    ["webp VP8L without its signature", riff([...ascii("VP8L"), ...le32(5), 0x2e, 1, 2, 3, 4]), /WebP whose header is cut short or malformed/],
    ["webp VP8 without its start code", riff([...ascii("VP8 "), ...le32(10), 0, 0, 0, 1, 2, 3, 10, 0, 10, 0]), /WebP whose header is cut short or malformed/],
  ];
  for (const [what, body, want] of cases) {
    const got = imageHeader(body);
    must(!got.ok && want.test(got.what), `${what}: ${JSON.stringify(got)}`);
  }
  // Random bytes behind each signature: every call returns, and an answer it gives has dimensions in range.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
  for (const prefix of [[0x89, ...ascii("PNG\r\n\x1a\n")], [0xff, 0xd8, 0xff], ascii("GIF89a"), [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8X")], []]) {
    for (let t = 0; t < 400; t++) {
      const body = bytes(prefix, Array.from({ length: t % 60 }, rnd));
      const got = imageHeader(body);
      if (got.ok && !(Number.isSafeInteger(got.width) && Number.isSafeInteger(got.height) && got.width > 0 && got.height > 0)) throw new Error(JSON.stringify(got));
    }
  }
});

// ---- the download is untouched -----------------------------------------------------------------------------------

await check("attachments_download_url's result is as it was: the same five fields, for an image too, and no view", async () => {
  for (const [body, name, type] of [[png(10, 10), "pic.png", "image/png"], [PDF, "plan.pdf", "application/pdf"]] as const) {
    const store = fakeArtifacts();
    server(body, name, type);
    const out = await downloadAttachment({ attachmentId: "att-1" }, ctx(), store);
    const want = { attachmentId: "att-1", ref: `artifact://raft/attachments/att-1/${name}`, name, type, bytes: body.byteLength };
    must(JSON.stringify(out) === JSON.stringify(want), JSON.stringify(out));
  }
  // An over-limit image is still downloaded: the view's limits are the view's alone.
  server(png(5000, 5000, VIEW_MAX_BYTES * 2), "huge.png", "image/png");
  const big: any = await downloadAttachment({ attachmentId: "att-1" }, ctx(), fakeArtifacts());
  must(big.bytes === VIEW_MAX_BYTES * 2 && !("view" in big), JSON.stringify(big));
});

// ---- offered exactly where the download is -----------------------------------------------------------------------

const withStorage = createRaftPlugin({ artifacts: fakeArtifacts() });
const has = (tools: readonly { name: string }[], name: string) => tools.some((t) => t.name === name);

await check("not offered without object storage, nor where the download is excluded; a direct call says why", async () => {
  // Control: with storage it is among the tools and in the no-snapshot fallback.
  must(has(withStorage.tools, VIEW_TOOL) && has(withStorage.mountTools!({ toolSnapshot: null } as any), VIEW_TOOL), "control: not offered with storage");
  must(!has(raftWithoutStorage.tools, VIEW_TOOL) && !has(raftWithoutStorage.mountTools!({ toolSnapshot: null } as any), VIEW_TOOL), "offered with no storage");
  CAPS = ["read"];
  server(png(1, 1), "x", "image/png");
  const listed = await raftWithoutStorage.snapshotTools!(ctx());
  must(!has(listed.tools, VIEW_TOOL) && !has(listed.tools, "attachments_download_url"), `listed with no storage: ${listed.tools.map((t) => t.name)}`);
  // Not even from a snapshot a build with storage took.
  const stored = await admitTools(await withStorage.snapshotTools!(ctx()), 0);
  must(has(stored.tools, VIEW_TOOL) && !has(raftWithoutStorage.mountTools!({ toolSnapshot: stored } as any), VIEW_TOOL), "offered from a snapshot with no storage");
  const why = await failure(() => raftWithoutStorage.invoke(VIEW_TOOL, { attachmentId: "att-1" }, ctx()) as Promise<unknown>);
  must(/no object storage/.test(why.message), why.message);
  // A table that excludes the download excludes the view with it.
  const noDownload = createRaftPlugin({ artifacts: fakeArtifacts(), excluded: { ...EXCLUDED, "attachments.downloadUrl": "left out here to exercise a mount that does not offer the download" } });
  must(!has(noDownload.tools, VIEW_TOOL) && !has(noDownload.mountTools!({ toolSnapshot: null } as any), VIEW_TOOL), "offered with the download excluded");
  const unknown = await failure(() => noDownload.invoke(VIEW_TOOL, { attachmentId: "att-1" }, ctx()) as Promise<unknown>);
  must(/unknown raft tool: attachments_view/.test(unknown.message), unknown.message);
});

await check("a snapshot lists the view exactly where it lists the download, and mountTools offers it only beside the download", async () => {
  const base: any = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
  const offered = (snap: any) => toolsOf(withStorage, { ...base, toolSnapshot: snap }).map((t) => t.name);
  // A credential with read: both listed, both offered, the view right after the generated tools.
  CAPS = ["read"];
  server(png(1, 1), "x", "image/png");
  const reading = await admitTools(await withStorage.snapshotTools!(ctx()), 0);
  must(has(reading.tools, "attachments_download_url") && has(reading.tools, VIEW_TOOL), `read: ${reading.tools.map((t) => t.name)}`);
  must(offered(reading).includes("attachments_download_url") && offered(reading).includes(VIEW_TOOL), `read offered: ${offered(reading)}`);
  // One without read: neither listed, neither offered, and both said in skipped with the same reason.
  CAPS = ["send"];
  const sending = await admitTools(await withStorage.snapshotTools!(ctx()), 0);
  must(!has(sending.tools, "attachments_download_url") && !has(sending.tools, VIEW_TOOL), `send: ${sending.tools.map((t) => t.name)}`);
  must(!offered(sending).includes(VIEW_TOOL) && !offered(sending).includes("attachments_download_url"), `send offered: ${offered(sending)}`);
  const skipped = (n: string) => sending.skipped?.find((s) => s.name === n)?.reason;
  must(skipped(VIEW_TOOL) !== undefined && skipped(VIEW_TOOL) === skipped("attachments_download_url"), JSON.stringify(sending.skipped));
  // A snapshot taken before the view existed lists the download alone: the download is offered, the view not yet.
  const older = { ...reading, tools: reading.tools.filter((t) => t.name !== VIEW_TOOL) };
  must(offered(older).includes("attachments_download_url") && !offered(older).includes(VIEW_TOOL), `older: ${offered(older)}`);
  // And a list naming the view without the download does not offer the view.
  const viewOnly = { ...reading, tools: reading.tools.filter((t) => t.name !== "attachments_download_url") };
  must(!offered(viewOnly).includes(VIEW_TOOL), `view without the download: ${offered(viewOnly)}`);
});

await check("toolsBasis moved with the view, so a snapshot taken without it is re-taken at the next turn and the view reaches the mount", async () => {
  const OWN = ["receive_events", "enable_push", "disable_push", "push_status", "integrations_list", "integrations_login", "integrations_actions", "integrations_invoke"];
  const ASSISTANT = ["assistant_owner_inbox", "assistant_owner_messages"];
  const generated = GENERATED.map((op) => ({ name: op.toolName, capability: op.capability }));
  const download = RAFT_OPERATIONS.find((op) => op.name === "attachments.downloadUrl")!;
  // FEATURES_BASIS stands for what a listing records beside the list (the Server's flags), not a tool.
  const named = [FEATURES_BASIS, ...OWN, ...ASSISTANT].map((name) => ({ name }));
  // Control: the formula is the plugin's — with the view it gives the plugin's basis.
  // The upload is in it too (test/raft-attachments-upload.ts), with the capability it needs.
  const upload = { name: "attachments_upload", capability: ["send"] };
  const without = toolsBasisOf([...named, ...generated, upload]);
  must(toolsBasisOf([...named, ...generated, { name: VIEW_TOOL, capability: download.capability }, upload]) === withStorage.toolsBasis, `control: ${withStorage.toolsBasis}`);
  must(withStorage.toolsBasis !== without, "the view left the basis where it was");
  // The runtime's own re-take: a mount whose snapshot was taken under the basis without the view.
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: host } as any, bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any, extraPlugins: [],
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  await rt.store.setPluginChoice("t", "a", "raft", "enable");
  await rt.store.addMount({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: withStorage.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: null, policy: null });
  const offered = async () => toolsOf(withStorage, (await rt.store.getMountByAlias("t", "a", "raft"))!).map((t: any) => t.name);
  CAPS = ["read", "send"];
  server(png(1, 1), "x", "image/png");
  must((await rt.attachCredential("t", "a", "raft", { token: "sk_agent_first_1234567890" })).ok, "attach");
  must((await offered()).includes(VIEW_TOOL), `control: a fresh listing offers the view: ${await offered()}`);
  const m = (await rt.store.getMountByAlias("t", "a", "raft"))!;
  must(m.toolSnapshot.basis === withStorage.toolsBasis, `the runtime's raft has another basis: ${m.toolSnapshot.basis}`);
  const old = { ...m.toolSnapshot, basis: without, tools: m.toolSnapshot.tools.filter((t: any) => t.name !== VIEW_TOOL) };
  await rt.store.updateMountToolSnapshot("t", "a", "raft", old);
  must(!(await offered()).includes(VIEW_TOOL) && (await offered()).includes("attachments_download_url"), "control: the old snapshot offers the download alone");
  await rt.retakeStaleSnapshots("t", "a");
  must((await offered()).includes(VIEW_TOOL), `after the re-take: ${await offered()}`);
  // Control: a snapshot whose basis is the current one is not re-taken, so it is the basis that moved it.
  await rt.store.updateMountToolSnapshot("t", "a", "raft", { ...old, basis: withStorage.toolsBasis });
  await rt.retakeStaleSnapshots("t", "a");
  must(!(await offered()).includes(VIEW_TOOL), "re-taken under the same basis");
});

await check("the description says what it shows, the limits, and where other files go; the schema is the download's", async () => {
  const tool = withStorage.tools.find((t) => t.name === VIEW_TOOL)!;
  for (const term of ["image attachment", "look at it", "PNG, JPEG, WebP or a still GIF", "1.5 MiB", "2000 px", "attachments_download_url"]) {
    must(tool.summary.includes(term), `missing ${term}: ${tool.summary}`);
  }
  const download = withStorage.tools.find((t) => t.name === "attachments_download_url")!;
  must(JSON.stringify(tool.parameters) === JSON.stringify(download.parameters), `parameters: ${JSON.stringify(tool.parameters)}`);
  must(tool.sideEffects === download.sideEffects && tool.idempotency === download.idempotency && !tool.modelOnly, JSON.stringify(tool));
});

await check("arguments are checked before anything is fetched", async () => {
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response("{}"); }) as any;
  for (const args of [{}, { attachmentId: "  " }, { attachmentId: 7 }]) {
    const why = await failure(() => viewAttachment(args, ctx(), fakeArtifacts()));
    must(/attachmentId is required/.test(why.message), why.message);
  }
  const why = await failure(() => viewAttachment("att-1", ctx(), fakeArtifacts()));
  must(/attachments_view takes an object of arguments/.test(why.message) && fetched === 0, `${why.message} fetched=${fetched}`);
});

globalThis.fetch = originalFetch;
console.log(`\n  raft attachments_view\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
