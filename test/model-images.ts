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
import { callQueuedModel, operatorModelOf, type ModelEnv } from "../cf/src/model-request.ts";
import { fromResponse, toRequest, toResponsesInput } from "../src/model/pi-bridge.ts";
import {
  IMAGE_REF_PREFIX, MAX_IMAGE_BYTES, NO_VISION_SENTENCE, imageKey, imageRef, imageRefHash, resolveImages, sha256Hex, sniffImage,
} from "../src/model/images.ts";
import { acceptsImages } from "../src/model/context-windows.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
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
      const b = objects.get(key);
      return b ? { arrayBuffer: async () => b.slice().buffer } : null;
    },
    async head(key: string) { return objects.has(key) ? {} : null; },
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
    [{ ...VIEW, height: 9000 }, "over the 8192-pixel limit"],
    [{ ref: VIEW.ref, mimeType: VIEW.mimeType }, "bytes is not"],
  ];
  for (const [v, says] of refused) {
    const got = parseView(v);
    must("problem" in got && got.problem.includes(says), `${show(v).slice(0, 80)}: ${show(got)} (wanted "${says}")`);
  }
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
  const store = { get: async (k: string) => { const o = await bucket.get(k); if (!o) throw new Error("no such artifact"); return new Uint8Array(await o.arrayBuffer()); }, put: (k: string, b: Uint8Array) => bucket.put(k, b) };
  const ref = await attachViewImage(VIEW, OWNER, store);
  must(ref === imageRef(IMG_SHA) && imageRefHash(ref) === IMG_SHA, `ref ${ref}`);
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
  await refusedWith({ ...VIEW, ref: "artifact://uploads/huge.png", bytes: bucket.objects.get("t/t/a/uploads/huge.png")!.byteLength }, OWNER, "over the 8192-pixel limit");
  bucket.objects.set("t/t/a/uploads/fake.png", new TextEncoder().encode("not an image at all"));
  await refusedWith({ ...VIEW, ref: "artifact://uploads/fake.png", bytes: 19 }, OWNER, "not a PNG, JPEG, WebP or GIF");
});

await check("viewContent: attached for a model that sees, the sentence for one that does not, the reason when it cannot be", async () => {
  const sees = { seesImages: async () => true, attachImage: async () => imageRef(IMG_SHA) };
  const shown = { name: "chart.png" };
  const ok = await viewContent(VIEW, shown, sees);
  must(ok.length === 2 && ok[1]!.type === "image" && (ok[1] as any).data === imageRef(IMG_SHA) && (ok[1] as any).mimeType === "image/png", show(ok));
  must(ok[0]!.type === "text" && (ok[0] as any).text === `{"name":"chart.png"}\n\nImage attached: artifact://uploads/chart.png (image/png, 64x64, ${IMG.byteLength} bytes).`, show(ok[0]));

  let attached = 0;
  const blind = await viewContent(VIEW, shown, { seesImages: async () => false, attachImage: async () => { attached++; return "x"; } });
  must(blind.length === 1 && (blind[0] as any).text.endsWith(NO_VISION_SENTENCE) && attached === 0, `${show(blind)}, attached ${attached}`);
  must(NO_VISION_SENTENCE.includes("cannot see images") && NO_VISION_SENTENCE.includes("DeepSeek Flash or GPT-5.6 Luna"), NO_VISION_SENTENCE);

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
// Builders and the result's shape copied from test/raft-attachments-view.ts (#856): its `view()` hands back
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
/** What attachments_view returns for `body` named `filename`, and the store it kept it in. */
function raftView(body: Uint8Array, mimeType: string, width: number, height: number, filename = "pic") {
  const ref = `artifact://raft/attachments/att-1/${filename}`;
  const result = { attachmentId: "att-1", ref, name: filename, type: "image/png", bytes: body.byteLength,
    view: { ref, mimeType, width, height, bytes: body.byteLength } };
  const objects = new Map([[`t/tenant/agent/raft/attachments/att-1/${filename}`, body]]);
  const store = {
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
    must(ref === imageRef(sha256Hex(body)) && r.objects.has(imageKey(RAFT_OWNER, sha256Hex(body))), `${what}: ${ref}`);
  }
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
  { role: "user", content: [{ type: "text", text: "What is in this chart?" }, { type: "image", data: imageRef(B_SHA), mimeType: "image/png" }], timestamp: 1 },
  { role: "assistant", api: "offloaded", provider: "openai-compatible", model: "deepseek-flash",
    content: [{ type: "toolCall", id: "call_1", name: "view", arguments: { name: "a.png" } }, { type: "toolCall", id: "call_2", name: "read", arguments: {} }],
    stopReason: "toolUse", jobId: "mj_1", timestamp: 2 },
  { role: "toolResult", toolCallId: "call_1", toolName: "view",
    content: [{ type: "text", text: "{\"name\":\"a.png\"}\n\nImage attached: artifact://a.png (image/png, 8 bytes)." }, { type: "image", data: imageRef(B_SHA), mimeType: "image/png" }], isError: false, timestamp: 3 },
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
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push(JSON.stringify({ url: String(input), body: init?.body }));
    return new Response(reply, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await callQueuedModel(env, j, "mj_2", images); } finally { globalThis.fetch = real; }
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
    request: String.raw`{"url":"https://api.deepseek.com/chat/completions","body":"{\"model\":\"deepseek-v4-pro\",\"messages\":[{\"role\":\"system\",\"content\":\"Look closely.\"},{\"role\":\"user\",\"content\":\"What is in this chart?\\n\\nThis model cannot see images; an owner can switch this agent to a model that can (DeepSeek Flash or GPT-5.6 Luna).\"},{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"view\",\"arguments\":\"{\\\"name\\\":\\\"a.png\\\"}\"}},{\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_1\",\"content\":\"{\\\"name\\\":\\\"a.png\\\"}\\n\\nImage attached: artifact://a.png (image/png, 8 bytes).\\n\\nThis model cannot see images; an owner can switch this agent to a model that can (DeepSeek Flash or GPT-5.6 Luna).\"},{\"role\":\"tool\",\"tool_call_id\":\"call_2\",\"content\":\"page\"}],\"max_tokens\":32768,\"temperature\":0}"}` },
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
    must(parts[1]!.type === "text" && parts[1]!.text!.startsWith("(an image could not be loaded: ") && parts[1]!.text!.includes(says), `${name}: ${show(parts)}`);
    toRequest(ctx as never, { images: true });
  }
  const plain = { messages: [{ role: "user", content: "hi" }] };
  must(await resolveImages(plain, loader({})) === plain, "a context without references was copied");
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
async function turn(w: World, text: string, script: ModelResponse[]) {
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
      const next = script[at++];
      must(next, `the model was called more often than scripted (${at})`);
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
      must(tr.content.length === 2 && tr.content[1]!.type === "image" && tr.content[1]!.data === imageRef(IMG_SHA) && tr.content[1]!.mimeType === "image/png", show(tr.content));
      must(tr.content[0]!.text === `{"name":"chart.png"}\n\nImage attached: artifact://uploads/chart.png (image/png, 64x64, ${IMG.byteLength} bytes).`, show(tr.content[0]));
      must(Buffer.from(w.bucket.objects.get(imageKey(OWNER, IMG_SHA)) ?? []).equals(Buffer.from(IMG)), `stored: ${show([...w.bucket.objects.keys()])}`);
      const rows = everyRow(w.host);
      must(rows.some((v) => v.includes(imageRef(IMG_SHA))), "control: no row holds the reference, so the scan below proves nothing");
      for (const piece of IMG_PIECES) must(!rows.some((v) => v.includes(piece)), `a row holds the image's bytes (${piece.slice(0, 12)}…)`);
      // The job as the queue consumer takes it, called with the bucket the Worker reads.
      const reads: string[] = [];
      const sent = await capture(w.env, w.jobs[1]!.job, CHAT_REPLY, async (sha) => {
        reads.push(sha);
        const o = await w.bucket.get(imageKey(OWNER, sha));
        return o ? new Uint8Array(await o.arrayBuffer()) : null;
      });
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
      must(tr.content.length === 2 && tr.content[1]!.data === imageRef(IMG_SHA), show(tr.content).slice(0, 400));
      const shown = JSON.parse(tr.content[0]!.text!.split("\n\nImage attached:")[0]!);
      must(typeof shown.ref === "string" && shown.ref.startsWith("artifact://") && !("view" in shown), `the parked wrapper: ${show(shown).slice(0, 300)}`);
      const parked = [...w.bucket.objects.entries()].find(([k]) => k.endsWith(".json"));
      must(parked && !new TextDecoder().decode(parked[1]).includes("\"view\""), "the parked body kept the view field");
    } finally { w.host.dispose(); }
  });
}

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
