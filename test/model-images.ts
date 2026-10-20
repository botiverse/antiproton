/**
 * Images shown to a vision model: the `view` marker a tool result carries (src/runtime/tool-view.ts), the reference an
 * image block holds instead of its bytes (src/model/images.ts), and the request each serializer builds from it
 * (src/model/pi-bridge.ts) once the queue consumer has read the bytes back (`callQueuedModel`, cf/src/model-request.ts).
 *
 * The request rows pin, byte for byte, what reaches `fetch` for a conversation with an image in a user message and in
 * a tool result: at DeepSeek's chat/completions (the tool result's image in a user message after the run of results,
 * the only place DeepSeek takes one), and at the Responses API for gpt-5.6-luna in both of its tool-image forms. A
 * model that cannot see images is sent the sentence saying so, and nothing is read for it.
 *
 * The runtime rows drive the real `AgentRuntime` (cf/src/runtime.ts) on both engines over node:sqlite, a plugin whose
 * result carries a `view`, and an in-memory bucket: the image is stored once under the agent's prefix, the transcript
 * and the job row hold its reference, and no row of the object holds its bytes in any form.
 *
 * test/model-request-snapshot.ts and test/pi-bridge.ts pin that a request without an image is the one it always was.
 */
import { Buffer } from "node:buffer";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { callQueuedModel, imageLoaderFor, imageWindowOf, operatorModelOf, queuedCall, type ModelEnv } from "../cf/src/model-request.ts";
import { fromResponse, toRequest, toResponsesInput } from "../src/model/pi-bridge.ts";
import {
  DEFAULT_IMAGE_WINDOW, IMAGE_REF_PREFIX, IMAGE_WINDOW_STEP, MAX_IMAGE_BYTES, omittedImageText, MAX_IMAGE_SIDE, NO_VISION_SENTENCE, imageProblem, imageKey, imageRef, imageRefHash, resolveImages, sha256Hex, sniffImage,
} from "../src/model/images.ts";
import { acceptsImages } from "../src/model/context-windows.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { interrupt, type Plugin } from "../src/plugins/types.ts";
import { attachViewImage, parseView, splitView, viewContent, withView, type ViewMarker } from "../src/runtime/tool-view.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { deflateSync } from "node:zlib";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// ---- images ---------------------------------------------------------------------------------------------------

/** A real PNG, `w` by `h`, of noise from `seed`: its base64 shares nothing with another's past the header. */
function png(w: number, h: number, seed = 1): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  let s = seed;
  const rows = Math.min(h, 64), raw = Buffer.alloc((Math.min(w, 64) * 3 + 1) * rows);
  for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) >>> 0; raw[i] = i % (Math.min(w, 64) * 3 + 1) === 0 ? 0 : s >>> 24; }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 3, 0, 2, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff, 0xd9]);
const WEBP_VP8X = (() => { const b = Buffer.alloc(30); b.write("RIFF", 0); b.write("WEBP", 8); b.write("VP8X", 12); b.writeUIntLE(99, 24, 3); b.writeUIntLE(49, 27, 3); return new Uint8Array(b); })();

const OWNER = { tenantId: "t", agentId: "a" };
const IMG = png(64, 64, 7);
const IMG_B64 = Buffer.from(IMG).toString("base64");
const IMG_SHA = sha256Hex(IMG);
const VIEW: ViewMarker = { ref: "artifact://uploads/chart.png", mimeType: "image/png", width: 64, height: 64, bytes: IMG.byteLength };

/** An in-memory R2 bucket, the binding's surface as the runtime and the consumer read it. */
function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    objects, puts,
    async put(key: string, body: Uint8Array | string) {
      puts.push(key);
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body));
      return {};
    },
    async get(key: string) {
      this.gets.push(key);
      const b = objects.get(key);
      return b ? { arrayBuffer: async () => b.slice().buffer } : null;
    },
    heads: [] as string[], gets: [] as string[],
    async head(key: string) { this.heads.push(key); const b = objects.get(key); return b ? { size: b.byteLength } : null; },
    async list() { return { objects: [], truncated: false }; },
    async delete(key: string) { objects.delete(key); },
  };
}

// ---- the marker -----------------------------------------------------------------------------------------------

await check("a view marker is read strictly: its five keys, an artifact:// reference, four types, a size within the limit", () => {
  must("view" in parseView(VIEW), `the marker was refused: ${show(parseView(VIEW))}`);
  must("view" in parseView({ ref: "artifact://x.jpg", mimeType: "image/jpeg", bytes: 1 }), "width and height are optional");
  const refused: Array<[unknown, string]> = [
    [null, "not an object"], [[VIEW], "not an object"], ["artifact://x", "not an object"],
    [{ ...VIEW, data: "iVBOR" }, "unknown field \"data\""],
    [{ ...VIEW, ref: "r2://bucket/t/t/a/x.png" }, "not an artifact:// reference"],
    [{ ...VIEW, ref: "https://example.com/x.png" }, "not an artifact:// reference"],
    [{ ...VIEW, ref: `artifact://${"x".repeat(2000)}` }, "not an artifact:// reference"],
    [{ ...VIEW, mimeType: "image/svg+xml" }, "mimeType is not one of"],
    [{ ...VIEW, mimeType: "IMAGE/PNG" }, "mimeType is not one of"],
    [{ ...VIEW, bytes: 0 }, "bytes is not a positive whole number"],
    [{ ...VIEW, bytes: 1.5 }, "bytes is not a positive whole number"],
    [{ ...VIEW, bytes: "182" }, "bytes is not a positive whole number"],
    [{ ...VIEW, bytes: MAX_IMAGE_BYTES + 1 }, "over the 1572864-byte limit"],
    [{ ...VIEW, width: 0 }, "width is not a positive whole number"],
    [{ ...VIEW, height: 9000 }, "over the 8000-pixel limit"],
    [{ ref: VIEW.ref, mimeType: VIEW.mimeType }, "bytes is not"],
  ];
  for (const [v, says] of refused) {
    const got = parseView(v);
    must("problem" in got && got.problem.includes(says), `${show(v).slice(0, 80)}: ${show(got)} (wanted "${says}")`);
  }
});

await check("the side limit is 8000 pixels, the smallest a vision model we offer accepts (Anthropic's): 8000 is attached, 8001 is refused", () => {
  must(MAX_IMAGE_SIDE === 8000, `MAX_IMAGE_SIDE ${MAX_IMAGE_SIDE}`);
  for (const [w, h] of [[8000, 10], [1200, 8000]]) must(imageProblem(png(w, h), "image/png") === null, `${w}x${h} refused: ${imageProblem(png(w, h), "image/png")}`);
  for (const [w, h] of [[8001, 10], [1200, 8100]]) must(/over the 8000-pixel limit/.test(String(imageProblem(png(w, h), "image/png"))), `${w}x${h}: ${imageProblem(png(w, h), "image/png")}`);
  must("problem" in parseView({ ...VIEW, width: 8001 }) && !("problem" in parseView({ ...VIEW, width: 8000 })), "the view marker's side check");
});

await check("splitView leaves a result without the field untouched, and withView puts it back on a wrapper", () => {
  const plain = { a: 1 };
  const s = splitView(plain);
  must(s.view === undefined && s.rest === plain, "a result without view was copied or changed");
  for (const v of [null, "text", [1], 3]) must(splitView(v).rest === v && splitView(v).view === undefined, `${show(v)} was split`);
  const both = splitView({ a: 1, view: VIEW });
  must(show(both.rest) === show({ a: 1 }) && both.view === (both.view as ViewMarker) && show(both.view) === show(VIEW), show(both));
  must(withView(plain, undefined) === plain, "withView with nothing to add changed the result");
  must(show(withView({ preview: "x" }, VIEW)) === show({ preview: "x", view: VIEW }), "withView on an object");
});

await check("sniffImage reads type and size from the bytes themselves", () => {
  must(show(sniffImage(png(300, 200))) === show({ mimeType: "image/png", width: 300, height: 200 }), show(sniffImage(png(300, 200))));
  must(show(sniffImage(GIF)) === show({ mimeType: "image/gif", width: 3, height: 2 }), show(sniffImage(GIF)));
  must(show(sniffImage(JPEG)) === show({ mimeType: "image/jpeg", height: 20, width: 30 }), show(sniffImage(JPEG)));
  must(show(sniffImage(WEBP_VP8X)) === show({ mimeType: "image/webp", width: 100, height: 50 }), show(sniffImage(WEBP_VP8X)));
  must(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")) === null, "svg was taken for an image");
});

await check("attachViewImage reads under the caller's scope, checks the bytes, and stores them once under their hash", async () => {
  const bucket = memoryBucket();
  bucket.objects.set("t/t/a/uploads/chart.png", IMG);
  const store = {
    size: async (k: string) => (await bucket.head(k))?.size ?? null,
    get: async (k: string) => { const o = await bucket.get(k); if (!o) throw new Error("no such artifact"); return new Uint8Array(await o.arrayBuffer()); },
    put: (k: string, b: Uint8Array) => bucket.put(k, b),
  };
  const ref = await attachViewImage(VIEW, OWNER, store);
  must(ref === imageRef(IMG_SHA, IMG.byteLength) && imageRefHash(ref) === IMG_SHA, `ref ${ref}`);
  must(show(bucket.puts) === show([`t/t/a/model-images/${IMG_SHA}`]) && Buffer.from(bucket.objects.get(imageKey(OWNER, IMG_SHA))!).equals(Buffer.from(IMG)), `stored ${show(bucket.puts)}`);
  const refusedWith = async (v: ViewMarker, owner: typeof OWNER, says: string) => {
    try { await attachViewImage(v, owner, store); } catch (e) { must(String((e as Error).message).includes(says), `${v.ref}: ${(e as Error).message}`); return; }
    throw new Error(`${show(v)} was attached`);
  };
  await refusedWith(VIEW, { tenantId: "t", agentId: "other" }, "no such artifact");
  await refusedWith({ ...VIEW, ref: "artifact://../a/uploads/chart.png" }, OWNER, "not readable by this agent");
  await refusedWith({ ...VIEW, bytes: IMG.byteLength + 1 }, OWNER, `is ${IMG.byteLength} bytes, not`);
  await refusedWith({ ...VIEW, mimeType: "image/jpeg" }, OWNER, "the bytes are image/png, not image/jpeg");
  bucket.objects.set("t/t/a/uploads/huge.png", png(9000, 10));
  await refusedWith({ ...VIEW, ref: "artifact://uploads/huge.png", bytes: bucket.objects.get("t/t/a/uploads/huge.png")!.byteLength }, OWNER, "over the 8000-pixel limit");
  bucket.objects.set("t/t/a/uploads/fake.png", new TextEncoder().encode("not an image at all"));
  await refusedWith({ ...VIEW, ref: "artifact://uploads/fake.png", bytes: 19 }, OWNER, "not a PNG, JPEG, WebP or GIF");
});

await check("viewContent: attached for a model that sees, the sentence for one that does not, the reason when it cannot be", async () => {
  const sees = { seesImages: async () => true, attachImage: async () => imageRef(IMG_SHA, IMG.byteLength) };
  const shown = { name: "chart.png" };
  const ok = await viewContent(VIEW, shown, sees);
  must(ok.length === 2 && ok[1]!.type === "image" && (ok[1] as any).data === imageRef(IMG_SHA, IMG.byteLength) && (ok[1] as any).mimeType === "image/png", show(ok));
  must(ok[0]!.type === "text" && (ok[0] as any).text === `{"name":"chart.png"}\n\nImage attached: artifact://uploads/chart.png (image/png, 64x64, ${IMG.byteLength} bytes).`, show(ok[0]));

  let attached = 0;
  const blind = await viewContent(VIEW, shown, { seesImages: async () => false, attachImage: async () => { attached++; return "x"; } });
  must(blind.length === 1 && (blind[0] as any).text.endsWith(NO_VISION_SENTENCE) && attached === 0, `${show(blind)}, attached ${attached}`);
  must(NO_VISION_SENTENCE.includes("cannot see images") && NO_VISION_SENTENCE === "This model cannot see images; an owner can switch this agent to a model that can.", NO_VISION_SENTENCE);

  const bad = await viewContent({ ...VIEW, mimeType: "image/bmp" }, shown, sees);
  must(bad.length === 1 && (bad[0] as any).text.includes("could not be attached: view.mimeType is not one of"), show(bad));
  const failed = await viewContent(VIEW, shown, { seesImages: async () => true, attachImage: async () => { throw new Error("no such artifact"); } });
  must(failed.length === 1 && (failed[0] as any).text.endsWith("could not be attached: no such artifact."), show(failed));
  const nowhere = await viewContent(VIEW, shown, {});
  must(nowhere.length === 1 && (nowhere[0] as any).text.includes("images cannot be shown to the model here"), show(nowhere));
});

await check("the capability table: DeepSeek Flash and GPT-5.6 Luna see images, by name as windows are matched", () => {
  for (const m of ["deepseek-flash", "openai/gpt-5.6-luna", "deepseek/deepseek-flash", "gpt-5.6-luna-2026-10-01"]) must(acceptsImages(m), `${m} should see images`);
  for (const m of ["deepseek-v4-pro", "openai/gpt-5.6-terra", "m1", "", undefined]) must(!acceptsImages(m), `${m} should not`);
});

// ---- the Raft plugin's attachments_view, as it shapes a result -------------------------------------------------
//
// Builders and the result's shape copied from #856's attachments_view tests: its `view()` hands back
// `{ attachmentId, ref, name, type, bytes, view: { ref, mimeType, width, height, bytes } }`, the file kept at
// `t/<tenant>/<agent>/raft/attachments/<id>/<filename>` and shown as `artifact://raft/attachments/<id>/<filename>`.
// Every result it can return must pass here, and its size cap (1.5 MiB, inclusive) must be this one.

const ascii = (str: string) => [...str].map((c) => c.charCodeAt(0));
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = (v: number) => [v & 255, (v >>> 8) & 255];
const le24 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
const le32 = (v: number) => [...le16(v & 0xffff), ...le16(v >>> 16)];
const bytesOf = (...parts: number[][]) => new Uint8Array(parts.flat());
function rpng(width: number, height: number, size?: number): Uint8Array {
  const head = bytesOf([0x89, ...ascii("PNG\r\n\x1a\n")], be32(13), ascii("IHDR"), be32(width), be32(height), [8, 6, 0, 0, 0], [0, 0, 0, 0],
    be32(0), ascii("IEND"), [0xae, 0x42, 0x60, 0x82]);
  if (size === undefined) return head;
  const out = new Uint8Array(size);
  out.set(head);
  return out;
}
function rjpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return bytesOf([0xff, 0xd8], [0xff, 0xe0], [0, 16], ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc4], [0, 8], [0x00, 0x01, 0x01, 0x02, 0x02, 0x00],
    [0xff, 0xff], [0xff, sof], [0, 17], [8], [height >> 8, height & 255], [width >> 8, width & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9]);
}
const riff = (chunk: number[]) => bytesOf(ascii("RIFF"), le32(4 + chunk.length), ascii("WEBP"), chunk);
const webpLossy = (w: number, h: number) => riff([...ascii("VP8 "), ...le32(10), 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
function webpLossless(w: number, h: number): Uint8Array {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff([...ascii("VP8L"), ...le32(5), 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
}
const webpExtended = (w: number, h: number, flags = 0x10) => riff([...ascii("VP8X"), ...le32(10), flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
function rgif(width: number, height: number): Uint8Array {
  const image = [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];
  return bytesOf(ascii("GIF89a"), le16(width), le16(height), [0x80, 0, 0], [0, 0, 0, 255, 255, 255], image, [0x3b]);
}
/**
 * The Raft plugin's own header reader (`imageHeader` in #856, at 3bb71b2), copied verbatim as the oracle: every file
 * it accepts must be one `sniffImage` accepts, as the same type with the same dimensions. Replace with an import of
 * it once both have landed.
 */
type OracleHeader =
  | { ok: true; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; width: number; height: number }
  | { ok: false; what: string };
function oracleHeader(b: Uint8Array): OracleHeader {
  const n = b.byteLength;
  const at = (i: number, s: string) => i + s.length <= n && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  const be16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const sized = (mimeType: Extract<OracleHeader, { ok: true }>["mimeType"], width: number, height: number, name: string): OracleHeader =>
    width > 0 && height > 0 ? { ok: true, mimeType, width, height } : { ok: false, what: `${name} whose header gives no dimensions` };

  if (at(0, "\x89PNG\r\n\x1a\n")) {
    if (n < 24 || !at(12, "IHDR")) return { ok: false, what: "a PNG whose header is cut short or malformed" };
    // Chunks to the image data: an APNG declares its animation (`acTL`) before the first IDAT, so a file cut before
    // either cannot be told still from animated and is refused. Each step moves at least a chunk's 12 framing bytes.
    for (let i = 8; ; i += 12 + b[i]! * 2 ** 24 + (b[i + 1]! << 16 | b[i + 2]! << 8 | b[i + 3]!)) {
      if (i + 8 > n) return { ok: false, what: "a PNG cut short before its image data, so whether it is animated cannot be told" };
      if (at(i + 4, "acTL")) return { ok: false, what: "an animated PNG" };
      if (at(i + 4, "IDAT") || at(i + 4, "IEND")) break;
    }
    return sized("image/png", b[16]! * 2 ** 24 + (b[17]! << 16 | b[18]! << 8 | b[19]!), b[20]! * 2 ** 24 + (b[21]! << 16 | b[22]! << 8 | b[23]!), "a PNG");
  }
  if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Segments from the first marker, fill bytes skipped, to the frame header: the first SOFn, C0–CF but for DHT (C4),
    // JPG (C8) and DAC (CC), which share the range. Each step moves at least two bytes, and anything that is not a
    // marker where one should be (where a length under 2 lands) ends the walk.
    let i = 2;
    while (i + 1 < n) {
      if (b[i] !== 0xff) break;
      const m = b[i + 1]!;
      if (m === 0xff) { i++; continue; }
      if (m === 0xd9 || m === 0xda) break;
      // TEM and RST0–7 stand alone, with no length after them.
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const length = be16(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 8 >= n || length < 7) break;
        return sized("image/jpeg", be16(i + 7), be16(i + 5), "a JPEG");
      }
      i += 2 + length;
    }
    return { ok: false, what: "a JPEG whose frame header (its dimensions) could not be found: cut short or malformed" };
  }
  if (at(0, "RIFF") && at(8, "WEBP")) {
    if (at(12, "VP8 ")) {
      if (n < 30 || !(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return { ok: false, what: "a WebP whose header is cut short or malformed" };
      return sized("image/webp", le16(26) & 0x3fff, le16(28) & 0x3fff, "a WebP");
    }
    if (at(12, "VP8L")) {
      if (n < 25 || b[20] !== 0x2f) return { ok: false, what: "a WebP whose header is cut short or malformed" };
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! * 2 ** 24);
      return sized("image/webp", (bits & 0x3fff) + 1, (Math.floor(bits / 2 ** 14) & 0x3fff) + 1, "a WebP");
    }
    if (at(12, "VP8X")) {
      if (n < 30) return { ok: false, what: "a WebP whose header is cut short or malformed" };
      if (b[20]! & 0x02) return { ok: false, what: "an animated WebP" };
      return sized("image/webp", le24(24) + 1, le24(27) + 1, "a WebP");
    }
    return { ok: false, what: "a WebP of a kind whose header is not read here" };
  }
  if (at(0, "GIF87a") || at(0, "GIF89a")) {
    const width = le16(6);
    const height = le16(8);
    // Every block to the trailer, counting image descriptors: a GIF that does not reach its trailer cannot be told
    // still from animated, so it is refused rather than taken as still.
    let i = 13 + (b[10]! & 0x80 ? 3 * 2 ** ((b[10]! & 7) + 1) : 0);
    let frames = 0;
    // A cut anywhere lands `i` at or past the end, which the loop's first line refuses.
    const subBlocks = () => { while (i < n && b[i] !== 0) i += b[i]! + 1; i++; };
    for (;;) {
      if (i >= n) return { ok: false, what: "a GIF cut short before its end, so whether it is animated cannot be told" };
      const block = b[i]!;
      if (block === 0x3b) break;
      if (block === 0x2c) {
        if (++frames > 1) return { ok: false, what: "an animated GIF" };
        const packed = b[i + 9] ?? 0;
        i += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0) + 1;
        subBlocks();
      } else if (block === 0x21) {
        i += 2;
        subBlocks();
      } else return { ok: false, what: "a GIF whose blocks are malformed" };
    }
    if (frames === 0) return { ok: false, what: "a GIF with no image in it" };
    return sized("image/gif", width, height, "a GIF");
  }
  if (at(0, "%PDF-")) return { ok: false, what: "a PDF document" };
  if (at(0, "BM")) return { ok: false, what: "a BMP image" };
  if (at(0, "II*\0") || at(0, "MM\0*")) return { ok: false, what: "a TIFF image" };
  if (at(0, "\0\0\x01\0")) return { ok: false, what: "an ICO icon" };
  if (at(4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^avi[fs]$/.test(brand)) return { ok: false, what: "an AVIF image" };
    if (/^(?:hei[cx]|hev[cx]|mif1|msf1)$/.test(brand)) return { ok: false, what: "a HEIC image" };
    return { ok: false, what: "a video or other ISO media file" };
  }
  if (at(0, "PK\x03\x04")) return { ok: false, what: "a ZIP archive (or a document built on one, such as .docx)" };
  const head = new TextDecoder().decode(b.subarray(0, 1024));
  if (/<svg[\s>]/i.test(head)) return { ok: false, what: "an SVG image" };
  return { ok: false, what: "a file of a type this tool does not recognise" };
}

/** What attachments_view returns for `body` named `filename`, and the store it kept it in. */
function raftView(body: Uint8Array, mimeType: string, width: number, height: number, filename = "pic") {
  const ref = `artifact://raft/attachments/att-1/${filename}`;
  const result = { attachmentId: "att-1", ref, name: filename, type: "image/png", bytes: body.byteLength,
    view: { ref, mimeType, width, height, bytes: body.byteLength } };
  const objects = new Map([[`t/tenant/agent/raft/attachments/att-1/${filename}`, body]]);
  const store = {
    size: async (k: string) => objects.get(k)?.byteLength ?? null,
    get: async (k: string) => { const b = objects.get(k); if (!b) throw new Error("no such artifact"); return b; },
    put: async (k: string, b: Uint8Array) => { objects.set(k, b); return {}; },
  };
  return { result, store, objects };
}
const RAFT_OWNER = { tenantId: "tenant", agentId: "agent" };

await check("every result attachments_view returns (#856's own cases) is a marker this harness attaches", async () => {
  const cases: Array<[string, Uint8Array, string, number, number]> = [
    ["png", rpng(640, 480), "image/png", 640, 480],
    ["jpeg (baseline, a DHT before the SOF, fill bytes)", rjpeg(1024, 768), "image/jpeg", 1024, 768],
    ["jpeg (progressive SOF2)", rjpeg(300, 200, 0xc2), "image/jpeg", 300, 200],
    ["webp VP8", webpLossy(320, 240), "image/webp", 320, 240],
    ["webp VP8L", webpLossless(1999, 17), "image/webp", 1999, 17],
    ["webp VP8X (still, alpha)", webpExtended(800, 600), "image/webp", 800, 600],
    ["gif (one frame)", rgif(64, 32), "image/gif", 64, 32],
    ["png at its side limit", rpng(2000, 2000), "image/png", 2000, 2000],
    ["a filename with a space", rpng(10, 10), "image/png", 10, 10],
  ];
  for (const [what, body, mimeType, width, height] of cases) {
    const r = raftView(body, mimeType, width, height, what === "a filename with a space" ? "my photo.png" : "pic");
    const { view, rest } = splitView(r.result);
    const parsed = parseView(view);
    must("view" in parsed, `${what}: ${show(parsed)}`);
    must(show(rest) === show({ attachmentId: "att-1", ref: r.result.ref, name: r.result.name, type: "image/png", bytes: body.byteLength }), `${what}: rest ${show(rest)}`);
    const seen = sniffImage(body);
    must(seen?.mimeType === mimeType && seen.width === width && seen.height === height, `${what}: the harness reads ${show(seen)}`);
    const ref = await attachViewImage((parsed as { view: ViewMarker }).view, RAFT_OWNER, r.store);
    must(ref === imageRef(sha256Hex(body), body.byteLength) && r.objects.has(imageKey(RAFT_OWNER, sha256Hex(body))), `${what}: ${ref}`);
  }
});

await check("whatever attachments_view's own header reader accepts, sniffImage accepts alike, at every length", () => {
  const fixtures: Array<[string, Uint8Array]> = [
    ["png", rpng(640, 480)], ["png padded", rpng(3, 4, 64)], ["jpeg", rjpeg(1024, 768)], ["jpeg SOF2", rjpeg(300, 200, 0xc2)],
    ["webp VP8", webpLossy(320, 240)], ["webp VP8L", webpLossless(1999, 17)], ["webp VP8L 1x1", webpLossless(1, 1)],
    ["webp VP8X", webpExtended(800, 600)], ["gif", rgif(64, 32)], ["generated png", IMG], ["gif (other builder)", GIF], ["jpeg (other builder)", JPEG], ["webp (other builder)", WEBP_VP8X],
  ];
  let accepted = 0;
  for (const [what, body] of fixtures) {
    // Every prefix too: the shortest file the plugin accepts is the one a length rule disagrees about.
    for (let n = 1; n <= body.byteLength; n++) {
      const cut = body.subarray(0, n);
      const theirs = oracleHeader(cut);
      if (!theirs.ok) continue;
      accepted++;
      const ours = sniffImage(cut);
      must(ours?.mimeType === theirs.mimeType && ours.width === theirs.width && ours.height === theirs.height,
        `${what} at ${n} bytes: the plugin reads ${show(theirs)}, the harness ${show(ours)}`);
      must(imageProblem(cut, theirs.mimeType) === null || theirs.width > MAX_IMAGE_SIDE || theirs.height > MAX_IMAGE_SIDE,
        `${what} at ${n} bytes: ${imageProblem(cut, theirs.mimeType)}`);
    }
  }
  must(accepted >= fixtures.length, `control: the oracle accepted only ${accepted} files`);
});

await check("the byte cap is attachments_view's, 1.5 MiB inclusive: 1,572,864 is attached, 1,572,865 is refused", async () => {
  must(MAX_IMAGE_BYTES === 1_572_864, `cap ${MAX_IMAGE_BYTES}`);
  const at = raftView(rpng(100, 100, 1_572_864), "image/png", 100, 100);
  const parsed = parseView(at.result.view);
  must("view" in parsed, show(parsed));
  must((await attachViewImage((parsed as { view: ViewMarker }).view, RAFT_OWNER, at.store)).startsWith(IMAGE_REF_PREFIX), "not attached at the cap");
  const over = raftView(rpng(100, 100, 1_572_865), "image/png", 100, 100);
  const refused = parseView(over.result.view);
  must("problem" in refused && refused.problem.includes("1572865 bytes, over the 1572864-byte limit"), show(refused));
  // The bytes' own check says the same, for a marker that understates them.
  let threw = "";
  try { await attachViewImage({ ...(parsed as { view: ViewMarker }).view, bytes: 1_572_865 }, RAFT_OWNER, over.store); } catch (e) { threw = String((e as Error).message); }
  must(threw.includes("over the 1572864-byte limit"), threw);
});

// ---- the requests ---------------------------------------------------------------------------------------------

const ENV: ModelEnv & Record<string, unknown> = {
  HARNESS_MODEL: "deepseek-flash",
  DEEPSEEK_API_KEY: "sk-snapshot-deepseek",
  AI_GATEWAY_TOKEN: "snapshot-gateway-token",
  MODEL_PROVIDERS: JSON.stringify([
    { id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
    { id: "cloudflare", baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat",
      auth: { secret: "AI_GATEWAY_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model" },
  ]),
};

// Eight bytes stand in for an image in the request rows: the serializers send what they are given, and a short
// base64 keeps the literals readable. Their hash is the reference the conversation holds.
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const B_SHA = sha256Hex(BYTES);
const loader = (store: Record<string, Uint8Array>, reads: string[] = []) => async (sha: string) => { reads.push(sha); return store[sha] ?? null; };

/** A conversation with an image in the user's message and one in the first of two tool results, as pi085 writes it. */
const CONVERSATION = [
  { role: "user", content: [{ type: "text", text: "What is in this chart?" }, { type: "image", data: imageRef(B_SHA, BYTES.byteLength), mimeType: "image/png" }], timestamp: 1 },
  { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash",
    content: [{ type: "toolCall", id: "call_1", name: "view", arguments: { name: "a.png" } }, { type: "toolCall", id: "call_2", name: "read", arguments: {} }],
    stopReason: "toolUse", jobId: "mj_1", timestamp: 2 },
  { role: "toolResult", toolCallId: "call_1", toolName: "view",
    content: [{ type: "text", text: "{\"name\":\"a.png\"}\n\nImage attached: artifact://a.png (image/png, 8 bytes)." }, { type: "image", data: imageRef(B_SHA, BYTES.byteLength), mimeType: "image/png" }], isError: false, timestamp: 3 },
  { role: "toolResult", toolCallId: "call_2", toolName: "read", content: [{ type: "text", text: "page" }], isError: false, timestamp: 4 },
];
const V1 = { systemPrompt: "Look closely.", messages: CONVERSATION };
const V2 = { version: 2, messages: [{ role: "system", content: "Look closely." }, ...CONVERSATION] };

const job = (context: unknown, operator: { provider: string; model: string }) => ({
  model: { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" }, context, options: {},
  operatorModel: operator.model, operatorProvider: operator.provider,
});
const CHAT_REPLY = JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "A chart." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const RESPONSES_REPLY = JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "A chart." }] }], usage: { input_tokens: 1, output_tokens: 1 } });

async function capture(env: ModelEnv, j: unknown, reply: string, images?: (sha: string) => Promise<Uint8Array | null>): Promise<string> {
  return captureWith(() => callQueuedModel(env, j, "mj_2", images), reply);
}
async function captureWith(run: () => Promise<unknown>, reply: string): Promise<string> {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push(JSON.stringify({ url: String(input), body: init?.body }));
    return new Response(reply, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = real; }
  must(seen.length === 1, `expected one request, saw ${seen.length}`);
  return seen[0]!;
}

const B64 = Buffer.from(BYTES).toString("base64");
const ROWS: Array<{ name: string; env: ModelEnv; job: unknown; reply: string; request: string }> = [
  { name: "deepseek-flash, version 1: the user's image in its message, the tool's in a user message after both results",
    env: ENV, job: job(V1, { provider: "deepseek", model: "deepseek-flash" }), reply: CHAT_REPLY,
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","body":"{\"model\":\"deepseek-flash\",\"messages\":[{\"role\":\"system\",\"content\":\"Look closely.\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What is in this chart?\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,AQIDBAUGBwg=\"}}]},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"view\",\"arguments\":\"{\\\"name\\\":\\\"a.png\\\"}\"}},{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"{\\\"name\\\":\\\"a.png\\\"}\\n\\nImage attached: artifact://a.png (image/png, 8 bytes).\"},{\"role\":\"tool\",\"tool_call_id\":\"call_2\",\"content\":\"page\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Attached image(s) from tool result:\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,AQIDBAUGBwg=\"}}]}],\"max_tokens\":32768,\"temperature\":0}"}` },
  { name: "gpt-5.6-luna, version 2, Responses: input_image in the user message and inside function_call_output (the default)",
    env: ENV, job: job(V2, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }), reply: RESPONSES_REPLY,
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses","body":"{\"model\":\"openai/gpt-5.6-luna\",\"input\":[{\"role\":\"developer\",\"content\":\"Look closely.\"},{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"What is in this chart?\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AQIDBAUGBwg=\",\"detail\":\"auto\"}]},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"view\",\"arguments\":\"{\\\"name\\\":\\\"a.png\\\"}\"},{\"type\":\"function_call\",\"call_id\":\"call_2\",\"name\":\"read\",\"arguments\":\"{}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":[{\"type\":\"input_text\",\"text\":\"{\\\"name\\\":\\\"a.png\\\"}\\n\\nImage attached: artifact://a.png (image/png, 8 bytes).\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AQIDBAUGBwg=\",\"detail\":\"auto\"}]},{\"type\":\"function_call_output\",\"call_id\":\"call_2\",\"output\":\"page\"}],\"max_output_tokens\":32768,\"store\":false,\"reasoning\":{\"effort\":\"medium\",\"summary\":\"auto\"},\"include\":[\"reasoning.encrypted_content\"]}"}` },
  { name: "gpt-5.6-luna, version 2, Responses with RESPONSES_TOOL_IMAGES=user: the tool's image in a user message after the results",
    env: { ...ENV, RESPONSES_TOOL_IMAGES: "user" }, job: job(V2, { provider: "cloudflare", model: "openai/gpt-5.6-luna" }), reply: RESPONSES_REPLY,
    request: String.raw`{"url":"https://gateway.ai.cloudflare.com/v1/acct/gw/compat/responses","body":"{\"model\":\"openai/gpt-5.6-luna\",\"input\":[{\"role\":\"developer\",\"content\":\"Look closely.\"},{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"What is in this chart?\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AQIDBAUGBwg=\",\"detail\":\"auto\"}]},{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"view\",\"arguments\":\"{\\\"name\\\":\\\"a.png\\\"}\"},{\"type\":\"function_call\",\"call_id\":\"call_2\",\"name\":\"read\",\"arguments\":\"{}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_1\",\"output\":\"{\\\"name\\\":\\\"a.png\\\"}\\n\\nImage attached: artifact://a.png (image/png, 8 bytes).\"},{\"type\":\"function_call_output\",\"call_id\":\"call_2\",\"output\":\"page\"},{\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Attached image(s) from tool result:\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AQIDBAUGBwg=\",\"detail\":\"auto\"}]}],\"max_output_tokens\":32768,\"store\":false,\"reasoning\":{\"effort\":\"medium\",\"summary\":\"auto\"},\"include\":[\"reasoning.encrypted_content\"]}"}` },
  { name: "deepseek-v4-pro (cannot see images), version 1: each image is the sentence, and nothing is read",
    env: ENV, job: job(V1, { provider: "deepseek", model: "deepseek-v4-pro" }), reply: CHAT_REPLY,
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","body":"{\"model\":\"deepseek-v4-pro\",\"messages\":[{\"role\":\"system\",\"content\":\"Look closely.\"},{\"role\":\"user\",\"content\":\"What is in this chart?\\n\\nThis model cannot see images; an owner can switch this agent to a model that can.\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"view\",\"arguments\":\"{\\\"name\\\":\\\"a.png\\\"}\"}},{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"{\\\"name\\\":\\\"a.png\\\"}\\n\\nImage attached: artifact://a.png (image/png, 8 bytes).\\n\\nThis model cannot see images; an owner can switch this agent to a model that can.\"},{\"role\":\"tool\",\"tool_call_id\":\"call_2\",\"content\":\"page\"}],\"max_tokens\":32768,\"temperature\":0}"}` },
];

for (const row of ROWS) {
  await check(`request: ${row.name}`, async () => {
    const reads: string[] = [];
    const got = await capture(row.env, row.job, row.reply, loader({ [B_SHA]: BYTES }, reads));
    must(got === row.request, `request changed\n    got  ${got}\n    want ${row.request}`);
    const sees = acceptsImages((row.job as { operatorModel: string }).operatorModel);
    must(sees ? reads.length === 1 : reads.length === 0, `read ${reads.length} times (each image once for a vision model, never otherwise)`);
    must(!got.includes(IMAGE_REF_PREFIX), "a reference reached the provider");
    must(sees === got.includes(B64), `the bytes ${sees ? "never" : "still"} reached the provider`);
  });
}

await check("a reference that is never resolved is refused by the serializer, not sent", () => {
  for (const [name, build] of [["toRequest", () => toRequest(V1 as never, { images: true })], ["toResponsesInput", () => toResponsesInput(V2 as never, "openai/gpt-5.6-luna", { images: true })]] as const) {
    let threw = "";
    try { build(); } catch (e) { threw = String((e as Error).message); }
    must(threw.includes("never resolved to its bytes"), `${name}: ${threw || "built a request"}`);
  }
});

await check("an image that cannot be read back becomes a sentence in its place, not a failed job", async () => {
  const missing = await resolveImages(V1, loader({}));
  const changed = await resolveImages(V1, loader({ [B_SHA]: new Uint8Array([9]) }));
  const unreadable = await resolveImages(V1, async () => { throw new Error("r2 down"); });
  const none = await resolveImages(V1, undefined);
  for (const [name, ctx, says] of [["missing", missing, "no longer stored"], ["changed", changed, "no longer match"], ["unreadable", unreadable, "reading it failed (r2 down)"], ["no loader", none, "no image store"]] as const) {
    const parts = (ctx.messages[0] as { content: Array<{ type: string; text?: string }> }).content;
    must(parts[1]!.type === "text" && parts[1]!.text!.startsWith("\n\n(an image could not be loaded: ") && parts[1]!.text!.includes(says), `${name}: ${show(parts)}`);
    toRequest(ctx as never, { images: true });
  }
  const plain = { messages: [{ role: "user", content: "hi" }] };
  must(await resolveImages(plain, loader({})) === plain, "a context without references was copied");
});

// ---- the image window -----------------------------------------------------------------------------------------

/**
 * `n` distinct images, image `i` of `size(i)` bytes, made on demand from their index, and a loader that counts its
 * reads and fails (throws) for the indices in `failing`.
 */
function manyImages(n: number, size: number | ((i: number) => number), failing: ReadonlySet<number> = new Set()) {
  const sizeOf = typeof size === "number" ? () => size : size;
  const make = (i: number) => { const b = new Uint8Array(sizeOf(i)); b.fill(i & 255); b[0] = i >> 8; b[1] = i & 255; return b; };
  const shas = Array.from({ length: n }, (_, i) => sha256Hex(make(i)));
  const index = new Map(shas.map((h, i) => [h, i]));
  const reads: string[] = [];
  const load = async (sha: string) => {
    reads.push(sha);
    const i = index.get(sha);
    if (i !== undefined && failing.has(i)) throw new Error("r2 unavailable");
    return i === undefined ? null : make(i);
  };
  // One image per tool result, oldest first, as a long conversation holds them.
  const context = (k = n) => ({
    version: 2,
    messages: shas.slice(0, k).flatMap((h, i) => [
      { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "show", arguments: {} }] },
      { role: "toolResult", toolCallId: `c${i}`, toolName: "show", content: [{ type: "text", text: `image ${i}` }, { type: "image", data: imageRef(h, sizeOf(i)), mimeType: "image/png" }], isError: false },
    ]),
  });
  return { shas, reads, load, context };
}
const imagesIn = (ctx: { messages: readonly any[] }) => ctx.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .filter((c: any) => c.type === "image" || /^\n\n(\[earlier image omitted|\(an image could not)/.test(c.text ?? ""));

await check("the window: the newest 8 images are sent, each older one is a note naming it, and only the 8 are read", async () => {
  const m = manyImages(12, 1000);
  const stored = JSON.stringify(m.context());
  const out = await resolveImages(m.context(), m.load) as { messages: any[] };
  const parts = imagesIn(out);
  must(parts.length === 12, `parts: ${parts.length}`);
  for (let i = 0; i < 12; i++) {
    const p = parts[i];
    if (i < 4) must(p.type === "text" && p.text === omittedImageText("image/png", m.shas[i]!), `image ${i}: ${show(p).slice(0, 120)}`);
    else must(p.type === "image" && !p.data.startsWith(IMAGE_REF_PREFIX), `image ${i} not sent: ${show(p).slice(0, 120)}`);
  }
  must(m.reads.length === 8 && m.reads.every((h) => m.shas.indexOf(h) >= 4), `reads ${m.reads.length}: ${show(m.reads.map((h) => m.shas.indexOf(h)))}`);
  must(JSON.stringify(m.context()) === stored, "control: the builder is not deterministic");
  must(DEFAULT_IMAGE_WINDOW.maxImages === 8 && DEFAULT_IMAGE_WINDOW.maxBytes === 12 * 1024 * 1024, show(DEFAULT_IMAGE_WINDOW));
});

await check("the window's byte budget stops at the first image that does not fit, snapped to a step, and only the window is read", async () => {
  const m = manyImages(10, MAX_IMAGE_BYTES);
  const out = await resolveImages(m.context(), m.load, { maxImages: 8, maxBytes: 6 * 1024 * 1024 }) as { messages: any[] };
  const sent = imagesIn(out).map((p: any) => p.type);
  // Four fit (images 6 to 9), so the start is 6, snapped forward to 8: two are sent.
  must(show(sent) === show([...Array(8).fill("text"), ...Array(2).fill("image")]), show(sent));
  // The sizes are in the references, so only what is sent is read.
  must(m.reads.length === 2, `reads ${m.reads.length}`);
});

await check("an image that leaves the window never comes back: each later image moves the window forward only", async () => {
  const m = manyImages(14, 1024 * 1024);
  const w = { maxImages: 5, maxBytes: 4.5 * 1024 * 1024 };
  let before: string[] = [];
  for (let k = 1; k <= 14; k++) {
    const out = await resolveImages(m.context(k), m.load, w) as { messages: any[] };
    const kinds = imagesIn(out).map((p: any) => p.type);
    // The images sent are the newest run, and every image omitted before is omitted still.
    const firstSent = kinds.indexOf("image");
    must(kinds.slice(firstSent).every((t) => t === "image") && kinds.slice(0, firstSent).every((t) => t === "text"), `${k}: ${show(kinds)}`);
    must(before.every((t, i) => t === "image" || kinds[i] === "text"), `${k}: an omitted image came back: ${show(before)} then ${show(kinds)}`);
    const start = Math.ceil(Math.max(0, k - 4) / IMAGE_WINDOW_STEP) * IMAGE_WINDOW_STEP;
    must(kinds.filter((t) => t === "image").length === k - start, `${k}: ${show(kinds)}`);
    before = kinds;
  }
});

await check("over twenty image turns the request's prefix breaks at most once per 4 images, within the limits, and no image returns", async () => {
  const N = 20;
  for (const [name, size, w] of [
    ["by count", 1000, { maxImages: 8, maxBytes: 12 * 1024 * 1024 }],
    ["by bytes", 1000, { maxImages: 8, maxBytes: 4500 }],
    ["by count, small", 1000, { maxImages: 5, maxBytes: 12 * 1024 * 1024 }],
  ] as const) {
    const m = manyImages(N, size);
    let prev: string[] = [], breaks = 0, omittedBefore = 0;
    for (let k = 1; k <= N; k++) {
      const out = await resolveImages(m.context(k), m.load, w) as { messages: any[] };
      const req = toRequest(out as never, { images: true }).messages.map((x) => JSON.stringify(x));
      if (prev.some((x, i) => req[i] !== x)) breaks++;
      prev = req;
      const kinds = imagesIn(out).map((p: any) => p.type);
      const sent = kinds.filter((t) => t === "image").length;
      must(sent <= w.maxImages && sent * size <= w.maxBytes, `${name} ${k}: ${sent} images sent`);
      const omitted = kinds.indexOf("image") === -1 ? kinds.length : kinds.indexOf("image");
      must(omitted >= omittedBefore && kinds.slice(omitted).every((t) => t === "image"), `${name} ${k}: an image returned: ${show(kinds)}`);
      omittedBefore = omitted;
    }
    must(breaks <= Math.ceil(N / IMAGE_WINDOW_STEP), `${name}: ${breaks} prefix breaks over ${N} image turns`);
    must(breaks >= 1, `${name}: control: the window never moved`);
  }
});

await check("forty 1.5 MiB images: one request carries the window, and the consumer reads only the window", async () => {
  const m = manyImages(40, MAX_IMAGE_BYTES);
  const heap = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const out = await resolveImages(m.context(), m.load, imageWindowOf({ HARNESS_MODEL: "deepseek-flash" }));
  const body = JSON.stringify(toRequest(out as never, { images: true }));
  const grew = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - heap;
  // The count fills (8 × 1.5 MiB is the byte budget exactly) before a ninth is read.
  must(m.reads.length === 8, `reads ${m.reads.length}`);
  const sent = imagesIn(out as { messages: any[] }).filter((p: any) => p.type === "image").length;
  must(sent === 8, `images sent ${sent}`);
  // 8 × 1.5 MiB is the byte budget exactly: about 16 MB as base64, never the 80 MB forty would be.
  must(body.length < 17 * 1024 * 1024, `request ${body.length} chars`);
  must(grew < 80 * 1024 * 1024, `heap grew ${Math.round(grew / 1048576)} MiB`);
  const env = imageWindowOf({ HARNESS_MODEL: "x", MODEL_IMAGES_MAX: "3", MODEL_IMAGES_MAX_BYTES: "1000" });
  must(env.maxImages === 3 && env.maxBytes === 1000, show(env));
  must(show(imageWindowOf({ HARNESS_MODEL: "x", MODEL_IMAGES_MAX: "0", MODEL_IMAGES_MAX_BYTES: "lots" })) === show(DEFAULT_IMAGE_WINDOW), "bad vars were taken");
});

await check("callQueuedModel applies the window from its environment: MODEL_IMAGES_MAX=4 of 10 starts at image 8", async () => {
  const m = manyImages(10, 100);
  const sent = await capture({ ...ENV, MODEL_IMAGES_MAX: "4" }, job(m.context(), { provider: "deepseek", model: "deepseek-flash" }), CHAT_REPLY, m.load);
  const urls = sent.split("data:image/png;base64,").length - 1;
  // Four fit (images 6 to 9); the start snaps forward to 8.
  must(urls === 2 && m.reads.length === 2, `data URLs ${urls}, reads ${m.reads.length}`);
  must(sent.split("[earlier image omitted:").length - 1 === 8, "the eight older images are not named");
});

await check("every window size 1..9 and byte budget: the newest image is always sent when it fits, limits hold, the start only moves forward", async () => {
  const KB = 1024;
  const sizes = (i: number) => [1500, 500, 1000, 1500, 300][i % 5]! * KB;
  const N = 20;
  const m = manyImages(N, sizes);
  let cases = 0;
  for (let maxImages = 1; maxImages <= 9; maxImages++) {
    for (const maxBytes of [1000 * KB, 1500 * KB, 2000 * KB, 4000 * KB, 6144 * KB, 12288 * KB]) {
      let before = 0;
      for (let k = 1; k <= N; k++) {
        const kinds = imagesIn(await resolveImages(m.context(k), m.load, { maxImages, maxBytes }) as { messages: any[] }).map((p: any) => p.type);
        const start = kinds.indexOf("image") === -1 ? k : kinds.indexOf("image");
        const at = `${maxImages} images, ${maxBytes / KB} KiB, ${k} in the conversation: ${show(kinds)}`;
        must(kinds.slice(start).every((t) => t === "image"), `not a run of the newest: ${at}`);
        if (sizes(k - 1) <= maxBytes) must(kinds[k - 1] === "image", `the newest image, which fits, was not sent: ${at}`);
        let total = 0;
        for (let i = start; i < k; i++) total += sizes(i);
        must(k - start <= maxImages && total <= maxBytes, `over the window: ${at}`);
        must(start >= before, `the start moved back from ${before}: ${at}`);
        before = start;
        cases++;
      }
    }
  }
  must(cases === 9 * 6 * N, `cases ${cases}`);
  // Where only the count binds, the start moves once per step, min(4, the window), and never more often.
  for (let maxImages = 1; maxImages <= 9; maxImages++) {
    let before = 0, moves = 0;
    for (let k = 1; k <= N; k++) {
      const kinds = imagesIn(await resolveImages(m.context(k), m.load, { maxImages, maxBytes: 100 * 1024 * KB }) as { messages: any[] }).map((p: any) => p.type);
      const start = kinds.indexOf("image");
      if (start !== before) moves++;
      before = start;
    }
    const step = Math.min(IMAGE_WINDOW_STEP, maxImages);
    must(moves <= Math.ceil(N / step), `${maxImages} images: the start moved ${moves} times over ${N} images (step ${step})`);
  }
});

await check("a read that fails takes the room its reference declares: the window does not move back, and older images stay omitted", async () => {
  const MiB = 1024 * 1024;
  const healthy = manyImages(11, MiB);
  const flaky = manyImages(11, MiB, new Set([9]));
  const w = { maxImages: 8, maxBytes: 6 * MiB };
  const ok = imagesIn(await resolveImages(healthy.context(), healthy.load, w) as { messages: any[] });
  const failed = imagesIn(await resolveImages(flaky.context(), flaky.load, w) as { messages: any[] });
  const kind = (p: any) => p.type === "image" ? "image" : p.text.includes("could not be loaded") ? "failed" : "omitted";
  must(show(failed.map(kind)) === show(ok.map((p: any, i: number) => i === 9 ? "failed" : kind(p))), `healthy ${show(ok.map(kind))}, flaky ${show(failed.map(kind))}`);
  must(failed.slice(0, 8).every((p: any) => kind(p) === "omitted"), `older images came back: ${show(failed.map(kind))}`);
});

await check("attachViewImage asks the stored size first, and refuses a mismatch or an oversize object without reading it", async () => {
  const objects = new Map<string, Uint8Array>([["t/t/a/uploads/chart.png", IMG], ["t/t/a/uploads/big.png", png(10, 10, 2)]]);
  const gets: string[] = [];
  const sizes = new Map<string, number>([["t/t/a/uploads/big.png", 50 * 1024 * 1024]]);
  const store = {
    size: async (k: string) => sizes.get(k) ?? objects.get(k)?.byteLength ?? null,
    get: async (k: string) => { gets.push(k); const b = objects.get(k); if (!b) throw new Error("no such artifact"); return b; },
    put: async () => ({}),
  };
  for (const [v, says] of [
    [{ ...VIEW, ref: "artifact://uploads/big.png" }, "is 52428800 bytes, not"],
    [{ ...VIEW, bytes: IMG.byteLength - 1 }, `is ${IMG.byteLength} bytes, not`],
    [{ ...VIEW, ref: "artifact://uploads/none.png" }, "no such artifact"],
  ] as const) {
    let threw = "";
    try { await attachViewImage(v, OWNER, store); } catch (e) { threw = String((e as Error).message); }
    must(threw.includes(says), `${v.ref}: ${threw}`);
  }
  must(gets.length === 0, `read before the size was checked: ${show(gets)}`);
  await attachViewImage(VIEW, OWNER, store);
  must(show(gets) === show(["t/t/a/uploads/chart.png"]), show(gets));
});

// ---- the runtime ----------------------------------------------------------------------------------------------

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });
const call = (id: string, name: string, args: unknown): ModelResponse =>
  ({ text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id, name, arguments: args as never }] });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** A plugin whose `show` result asks for an image to be seen, beside `extra` (a large one is parked). */
function pictures(view: unknown, extra: Record<string, unknown> = {}): Plugin {
  return {
    id: "pics", version: "1.0.0",
    tools: [{ name: "show", description: "Shows an image.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" }] as never,
    async invoke() { return { name: "chart.png", ...extra, view } as never; },
  };
}

async function world(engine: "pi085" | "pd", model: string, plugin: Plugin, extra: Record<string, unknown> = {}) {
  const host = sqliteHost();
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const bucket = memoryBucket();
  bucket.objects.set("t/t/a/uploads/chart.png", IMG);
  const sent: string[] = [];
  const standIn = standInLoader();
  const env: ModelEnv = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: model };
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: bucket as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [plugin],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf(env),
    offloadModel: async (j: { commandId: string }) => { sent.push(j.commandId); },
    ...extra,
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.store.setPluginChoice("t", "a", "pics", "enable");
  const added = await rt.addMount("t", "a", { alias: "pics", plugin: "pics", config: {} });
  must(added.ok, `the mount was refused: ${show(added)}`);
  await rt.bindOperatorModel("t", "a");
  return { host, bucket, rt, sent, env, jobs: [] as Array<{ id: string; job: any }> };
}
type World = Awaited<ReturnType<typeof world>>;

/** One user message, answered by `script` in order; every job taken is kept, as the consumer would read it. */
type Step = ModelResponse | ((job: any) => ModelResponse);
async function turn(w: World, text: string, script: Step[]) {
  let at = 0;
  const answered = new Set<string>();
  await w.rt.postMessage("t", "a", text, "prompt", "main");
  for (let guard = 0; guard < 200; guard++) {
    const out = await w.rt.step("t", "a") as { wakeInMs?: number | null };
    const pending = w.sent.filter((id) => !answered.has(id) && !w.jobs.some((j) => j.id === id));
    for (const id of pending) {
      answered.add(id);
      const job = await w.rt.takeJob("t", "a", id) as any;
      if (!job) continue;
      w.jobs.push({ id, job });
      const step = script[at++];
      must(step, `the model was called more often than scripted (${at})`);
      const next = typeof step === "function" ? step(job) : step;
      await w.rt.deliverAnswer("t", "a", id, fromResponse(next!, { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
    }
    if (pending.length) continue;
    if (at >= script.length && (out?.wakeInMs === null || out?.wakeInMs === undefined)) return;
    await sleep(Math.min(out?.wakeInMs ?? 20, 50));
  }
  throw new Error(`the turn did not settle; ${at} of ${script.length} answered`);
}

/** Every value in every row of every table of the object, as text. */
function everyRow(host: ReturnType<typeof sqliteHost>): string[] {
  const tables = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => String(r.name));
  const out: string[] = [];
  for (const t of tables) {
    for (const r of host.sql.exec(`SELECT * FROM "${t}"`).toArray()) {
      for (const v of Object.values(r as Record<string, unknown>)) {
        out.push(v instanceof Uint8Array || v instanceof ArrayBuffer ? Buffer.from(v as Uint8Array).toString("latin1") : String(v));
      }
    }
  }
  return out;
}
const IMG_PIECES = [IMG_B64.slice(40, 100), Buffer.from(IMG).subarray(40, 80).toString("latin1"), Buffer.from(IMG).subarray(40, 80).toString("hex")];

/** The tool result the model was shown, from the last job's context. */
function toolResultOf(j: any) {
  const m = [...j.context.messages].reverse().find((x: any) => x.role === "toolResult");
  must(m, `no tool result in ${show(j.context.messages).slice(0, 300)}`);
  return m as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
}

await check("pi085: the prefix reading and the input evidence see an image in history as the same message on the next call", async () => {
  const w = await world("pi085", "deepseek-flash", pictures(VIEW), { modelInputEvidence: true });
  try {
    await turn(w, "show me", [call("c1", "pics__show", {}), say("a chart")]);
    await turn(w, "and again?", [say("still a chart")]);
    must(w.jobs.length === 3, `jobs: ${w.jobs.length}`);
    const prefix = JSON.parse(String(w.host.sql.exec("SELECT prefix FROM pi_model_jobs WHERE id = ?", w.jobs[2]!.id).toArray()[0]?.prefix));
    // Everything the second call sent, the image's tool result among it, is the third call's prefix.
    must(prefix.broken === null && prefix.sharedMessages === w.jobs[1]!.job.context.messages.length && prefix.messages > prefix.sharedMessages, `prefix ${show(prefix)}`);
    const digest = JSON.parse(String(w.host.sql.exec("SELECT digest FROM model_input_digests WHERE job_id = ?", w.jobs[2]!.id).toArray()[0]?.digest));
    const imageAt = w.jobs[2]!.job.context.messages.findIndex((m: any) => m.role === "toolResult");
    must(digest.messages[imageAt]?.role === "toolResult" && digest.messages[imageAt]?.messageId, `the image's message is not found in the transcript: ${show(digest.messages[imageAt])}`);
  } finally { w.host.dispose(); }
});

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: a vision model's tool result carries the image as a reference; no row holds its bytes; the consumer sends them`, async () => {
    const w = await world(engine, "deepseek-flash", pictures(VIEW));
    try {
      await turn(w, "show me", [call("c1", "pics__show", {}), say("a chart")]);
      must(w.jobs.length === 2, `jobs: ${w.jobs.length}`);
      const tr = toolResultOf(w.jobs[1]!.job);
      must(tr.content.length === 2 && tr.content[1]!.type === "image" && tr.content[1]!.data === imageRef(IMG_SHA, IMG.byteLength) && tr.content[1]!.mimeType === "image/png", show(tr.content));
      must(tr.content[0]!.text === `{"name":"chart.png"}\n\nImage attached: artifact://uploads/chart.png (image/png, 64x64, ${IMG.byteLength} bytes).`, show(tr.content[0]));
      must(Buffer.from(w.bucket.objects.get(imageKey(OWNER, IMG_SHA)) ?? []).equals(Buffer.from(IMG)), `stored: ${show([...w.bucket.objects.keys()])}`);
      const rows = everyRow(w.host);
      must(rows.some((v) => v.includes(imageRef(IMG_SHA, IMG.byteLength))), "control: no row holds the reference, so the scan below proves nothing");
      for (const piece of IMG_PIECES) must(!rows.some((v) => v.includes(piece)), `a row holds the image's bytes (${piece.slice(0, 12)}…)`);
      // The job as the queue consumer takes it, called with the bucket the Worker reads.
      const reads: string[] = [];
      // The consumer's own loader (`imageLoaderFor`, what modelQueueDeps hands callQueuedModel), keyed by the queue
      // message's tenant and agent, reads what the tool host stored for that agent, and nothing for another.
      const own = imageLoaderFor(w.bucket, OWNER);
      for (const other of [{ tenantId: "t", agentId: "other" }, { tenantId: "other", agentId: "a" }]) {
        must(await imageLoaderFor(w.bucket, other)(IMG_SHA) === null, `${show(other)} read agent a's image`);
      }
      const sent = await capture(w.env, w.jobs[1]!.job, CHAT_REPLY, async (sha) => { reads.push(sha); return own(sha); });
      // The consumer's `call` itself (`queuedCall`, what modelQueueDeps installs), given a message whose object id
      // names nothing: the image comes from the tenant and agent it names.
      const viaQueue = await captureWith(() => queuedCall(w.env, w.bucket)(w.jobs[1]!.job, { jobId: "mj_q", tenantId: "t", agentId: "a", doId: "do-elsewhere" } as never), CHAT_REPLY);
      must(viaQueue.includes(`data:image/png;base64,${IMG_B64}`), `queuedCall did not read the agent's image: ${viaQueue.slice(0, 200)}`);
      // And a message naming another agent, or another tenant, reads nothing of this one's.
      for (const other of [{ tenantId: "t", agentId: "other" }, { tenantId: "other", agentId: "a" }]) {
        const elsewhere = await captureWith(() => queuedCall(w.env, w.bucket)(w.jobs[1]!.job, { jobId: "mj_q", ...other, doId: "do-elsewhere" } as never), CHAT_REPLY);
        must(!elsewhere.includes("data:image/") && elsewhere.includes("(an image could not be loaded: it is no longer stored)"),
          `a message naming ${show(other)} was sent agent a's image: ${elsewhere.slice(0, 200)}`);
      }
      const body = JSON.parse(JSON.parse(sent).body);
      const last = body.messages[body.messages.length - 1];
      must(last.role === "user" && show(last.content) === show([{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${IMG_B64}` } }]),
        `the last message: ${show(last).slice(0, 300)}`);
      must(body.messages[body.messages.length - 2].role === "tool", "the image's message does not follow the tool result");
      must(show(reads) === show([IMG_SHA]), `reads ${show(reads)}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a model that cannot see images is told so in the result, and nothing is read or stored`, async () => {
    const w = await world(engine, "deepseek-v4-pro", pictures(VIEW));
    try {
      await turn(w, "show me", [call("c1", "pics__show", {}), say("cannot")]);
      const tr = toolResultOf(w.jobs[1]!.job);
      must(tr.content.length === 1 && tr.content[0]!.text!.endsWith(`The result has an image, artifact://uploads/chart.png (image/png, 64x64, ${IMG.byteLength} bytes). ${NO_VISION_SENTENCE}`), show(tr.content));
      must(![...w.bucket.objects.keys()].some((k) => k.includes("model-images")), `stored ${show([...w.bucket.objects.keys()])}`);
    } finally { w.host.dispose(); }
  });

  await check(`${engine}: a marker that is invalid, or names nothing, is a sentence saying why`, async () => {
    const w = await world(engine, "deepseek-flash", pictures({ ...VIEW, ref: "artifact://uploads/gone.png" }));
    try {
      await turn(w, "show me", [call("c1", "pics__show", {}), say("gone")]);
      const tr = toolResultOf(w.jobs[1]!.job);
      must(tr.content.length === 1 && tr.content[0]!.text!.endsWith("The result's image, artifact://uploads/gone.png, could not be attached: no such artifact."), show(tr.content));
    } finally { w.host.dispose(); }
    const v = await world(engine, "deepseek-flash", pictures({ ...VIEW, data: IMG_B64 }));
    try {
      await turn(v, "show me", [call("c1", "pics__show", {}), say("refused")]);
      const tr = toolResultOf(v.jobs[1]!.job);
      must(tr.content.length === 1 && tr.content[0]!.text!.endsWith("The result's image could not be attached: view has an unknown field \"data\"."), show(tr.content));
    } finally { v.host.dispose(); }
  });

  await check(`${engine}: a result too large to show is parked without its view, and the image is still attached`, async () => {
    const w = await world(engine, "deepseek-flash", pictures(VIEW, { rows: Array.from({ length: 400 }, (_, i) => ({ i, text: "row text" })) }));
    try {
      await turn(w, "show me", [call("c1", "pics__show", {}), say("parked")]);
      const tr = toolResultOf(w.jobs[1]!.job);
      must(tr.content.length === 2 && tr.content[1]!.data === imageRef(IMG_SHA, IMG.byteLength), show(tr.content).slice(0, 400));
      const shown = JSON.parse(tr.content[0]!.text!.split("\n\nImage attached:")[0]!);
      must(typeof shown.ref === "string" && shown.ref.startsWith("artifact://") && !("view" in shown), `the parked wrapper: ${show(shown).slice(0, 300)}`);
      const parked = [...w.bucket.objects.entries()].find(([k]) => k.endsWith(".json"));
      must(parked && !new TextDecoder().decode(parked[1]).includes("\"view\""), "the parked body kept the view field");
    } finally { w.host.dispose(); }
  });
}

/** A plugin whose `ask` asks first, and whose answer carries a `view`. */
function askingPictures(): Plugin {
  return {
    id: "pics", version: "1.0.0",
    tools: [{ name: "ask", description: "Asks, then shows.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" }] as never,
    async invoke() { return interrupt({ question: "show it?", answer: { choices: ["yes", "no"] }, state: {} }); },
    interrupts: {
      async resume() { return { name: "chart.png", view: VIEW } as never; },
      async cancel() {},
    },
  };
}
const lastToolText = (job: any) => {
  const m = [...job.context.messages].reverse().find((x: any) => x.role === "toolResult");
  return String(m?.content?.find((c: any) => c.type === "text")?.text ?? "");
};

for (const engine of ["pi085", "pd"] as const) {
  await check(`${engine}: a tool's question, answered with resume, comes back with its view attached as a call's would`, async () => {
    const w = await world(engine, "deepseek-flash", askingPictures());
    try {
      await turn(w, "ask me", [
        call("c1", "pics__ask", {}),
        (job) => call("c2", "resume", { token: JSON.parse(lastToolText(job)).token, answer: "yes" }),
        say("seen"),
      ]);
      const tr = toolResultOf(w.jobs[2]!.job);
      must(tr.content.length === 2 && tr.content[1]!.type === "image" && tr.content[1]!.data === imageRef(IMG_SHA, IMG.byteLength), show(tr.content).slice(0, 300));
    } finally { w.host.dispose(); }
  });
}

await check("an agent on its own credential is asked about the model its calls run on (HARNESS_MODEL), not its binding's", async () => {
  for (const [harness, bound, sees] of [["deepseek-v4-pro", "deepseek-flash", false], ["deepseek-flash", "deepseek-v4-pro", true]] as const) {
    const w = await world("pi085", harness, pictures(VIEW));
    try {
      await w.rt.store.setModelBinding({ tenantId: "t", agentId: "a", provider: "own", model: bound, baseUrl: "https://own.example/v1", secretRef: "secret:own-model" });
      await turn(w, "show me", [call("c1", "pics__show", {}), say("done")]);
      must(w.jobs[1]!.job.operatorModel === null, `control: the job runs on ${w.jobs[1]!.job.operatorModel}, not the default`);
      const tr = toolResultOf(w.jobs[1]!.job);
      must(sees ? tr.content[1]?.type === "image" : tr.content.length === 1 && tr.content[0]!.text!.endsWith(NO_VISION_SENTENCE),
        `HARNESS_MODEL ${harness}, bound ${bound}: ${show(tr.content).slice(0, 300)}`);
    } finally { w.host.dispose(); }
  }
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
