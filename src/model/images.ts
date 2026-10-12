/**
 * Images in a model conversation: how one is named inside the agent's object, checked, stored and turned back
 * into bytes for the provider.
 *
 * An image's bytes never enter a Durable Object row. A transcript entry, a `pi_model_jobs` / `ap_model_jobs` row,
 * the request-prefix reading and the model-input evidence all hold the image block pi defines
 * (`{ type: "image", mimeType, data }`) with `data` set to a reference, `apimg:sha256:<hex>`, never base64: a row
 * is capped at 2 MB, an image may be 1.5 MB raw (2 MB as base64), and every later request in the conversation
 * carries every image again. The bytes live in R2 once, under the agent's own prefix and keyed by their hash
 * (`imageKey`), and the queue consumer swaps each reference for its bytes right before the provider call
 * (`resolveImages`, called by `callQueuedModel` in cf/src/model-request.ts). Hashing a message hashes the
 * reference, so the prefix reading (src/runtime/request-prefix.ts) and the evidence (cf/src/fresh-context.ts) see
 * the same image as the same message on every call, with no bytes read.
 *
 * The reference is not valid base64 (it has colons), so one that reaches a serializer unresolved is caught there
 * (src/model/pi-bridge.ts) instead of being sent as an image the provider cannot decode.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** The prefix of an image block's `data` when it holds a reference rather than bytes. */
export const IMAGE_REF_PREFIX = "apimg:sha256:";

/** The image types every vision model we offer accepts (DeepSeek: jpeg, png, gif, webp; OpenAI the same four). */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

/**
 * The largest image attached, raw, inclusive: 1.5 MiB, the cap the Raft plugin's `attachments_view` applies
 * (`VIEW_MAX_BYTES`, src/plugins/raft.ts), so an image that tool shows is never refused here. About 2 MiB as base64,
 * and the provider's per-request budget is shared with the rest.
 */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * The longest side a provider accepts: DeepSeek refuses an image over 8192 pixels on either side. A refused image
 * would be in every later request of the conversation, so one is refused here instead, before it is attached.
 */
export const MAX_IMAGE_SIDE = 8192;

/** What a model that cannot see an image is told in its place. */
export const NO_VISION_SENTENCE =
  "This model cannot see images; an owner can switch this agent to a model that can (DeepSeek Flash or GPT-5.6 Luna).";

const SHA = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The reference for an image whose bytes hash to `sha256`. */
export const imageRef = (sha256: string): string => `${IMAGE_REF_PREFIX}${sha256}`;

/** The hash a reference names, or null when `data` is not a reference (base64 bytes, or anything else). */
export function imageRefHash(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith(IMAGE_REF_PREFIX)) return null;
  const h = data.slice(IMAGE_REF_PREFIX.length);
  return SHA.test(h) ? h : null;
}

/**
 * Where the bytes an image reference names are kept: under the agent's own prefix, so the consumer reads them with
 * the queue message's tenant and agent and nothing a message carries can point at another agent's.
 */
export function imageKey(owner: { tenantId: string; agentId: string }, sha256: string): string {
  if (!SHA.test(sha256)) throw new Error("an image key needs a sha256 hex digest");
  return `t/${owner.tenantId}/${owner.agentId}/model-images/${sha256}`;
}

/** The type and size an image's own bytes declare; null when they are none of the four types. */
export function sniffImage(b: Uint8Array): { mimeType: ImageMimeType; width?: number; height?: number } | null {
  const at = (i: number) => b[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => ((at(i) << 24) >>> 0) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3);
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  if (b.length >= 24 && at(0) === 0x89 && ascii(1, "PNG\r\n\x1a\n") && ascii(12, "IHDR")) {
    return { mimeType: "image/png", width: be32(16), height: be32(20) };
  }
  if (b.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) {
    return { mimeType: "image/gif", width: le16(6), height: le16(8) };
  }
  // Each chunk's own length decides: a lossless (VP8L) file can end at byte 25, before the others' size fields.
  if (b.length >= 16 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (b.length >= 30 && ascii(12, "VP8X")) return { mimeType: "image/webp", width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    if (b.length >= 25 && ascii(12, "VP8L")) {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (b.length >= 30 && ascii(12, "VP8 ")) return { mimeType: "image/webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    return { mimeType: "image/webp" };
  }
  if (b.length >= 4 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    // The frame header (SOF0..SOF15 but DHT, JPG and DAC) carries the size; walk the segments to it.
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1);
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: "image/jpeg", height: be16(i + 5), width: be16(i + 7) };
      }
      i += 2 + be16(i + 2);
    }
    return { mimeType: "image/jpeg" };
  }
  return null;
}

/**
 * Why these bytes cannot be shown to a model as `mimeType`, or null when they can: within MAX_IMAGE_BYTES, of the type
 * they claim by their own header, and no side over MAX_IMAGE_SIDE.
 */
export function imageProblem(bytes: Uint8Array, mimeType: string): string | null {
  if (bytes.byteLength === 0) return "the image is empty";
  if (bytes.byteLength > MAX_IMAGE_BYTES) return `the image is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`;
  const seen = sniffImage(bytes);
  if (!seen) return `the bytes are not a PNG, JPEG, WebP or GIF image`;
  if (seen.mimeType !== mimeType) return `the bytes are ${seen.mimeType}, not ${mimeType} as declared`;
  if ((seen.width ?? 0) > MAX_IMAGE_SIDE || (seen.height ?? 0) > MAX_IMAGE_SIDE) {
    return `the image is ${seen.width}x${seen.height}, over the ${MAX_IMAGE_SIDE}-pixel limit on a side`;
  }
  return null;
}

/** Reads the bytes stored for an image hash, or null when there are none. */
export type ImageLoader = (sha256: string) => Promise<Uint8Array | null>;

/** Whether any user or tool-result message of `context` holds an image reference. */
export function hasImageRefs(context: { messages?: readonly unknown[] }): boolean {
  return (context.messages ?? []).some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "image" && imageRefHash(c.data) !== null));
}

/**
 * `context` with each image reference replaced by its bytes as base64, for the provider call. Each distinct image is
 * read once. One that cannot be read, or whose bytes no longer hash to the reference, becomes a text block saying so:
 * the conversation goes on, rather than a job that fails on every retry for an image that will not come back. A
 * context with no reference is returned as it is.
 */
export async function resolveImages<C extends { messages?: readonly unknown[] }>(context: C, load: ImageLoader | undefined): Promise<C> {
  if (!hasImageRefs(context)) return context;
  const cache = new Map<string, Promise<{ data: string } | { problem: string }>>();
  const fetchOne = (sha: string) => {
    let p = cache.get(sha);
    if (!p) {
      p = (async () => {
        if (!load) return { problem: "no image store is reachable here" };
        let bytes: Uint8Array | null;
        try { bytes = await load(sha); } catch (e) { return { problem: `reading it failed (${String((e as Error)?.message ?? e).slice(0, 120)})` }; }
        if (!bytes) return { problem: "it is no longer stored" };
        if (sha256Hex(bytes) !== sha) return { problem: "the stored bytes no longer match it" };
        return { data: Buffer.from(bytes).toString("base64") };
      })();
      cache.set(sha, p);
    }
    return p;
  };
  const messages = await Promise.all((context.messages ?? []).map(async (m: any) => {
    if (!Array.isArray(m?.content) || !m.content.some((c: any) => c?.type === "image" && imageRefHash(c.data) !== null)) return m;
    const content = await Promise.all(m.content.map(async (c: any) => {
      const sha = c?.type === "image" ? imageRefHash(c.data) : null;
      if (sha === null) return c;
      const got = await fetchOne(sha);
      return "data" in got ? { ...c, data: got.data } : { type: "text", text: `(an image could not be loaded: ${got.problem})` };
    }));
    return { ...m, content };
  }));
  return { ...context, messages };
}
