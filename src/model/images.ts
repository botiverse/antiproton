/**
 * Images in a model conversation: how one is named inside the agent's object, checked, stored and turned back
 * into bytes for the provider.
 *
 * An image's bytes never enter a Durable Object row. A transcript entry, a `pi_model_jobs` / `ap_model_jobs` row,
 * the request-prefix reading and the model-input evidence all hold the image block pi defines
 * (`{ type: "image", mimeType, data }`) with `data` set to a reference, `apimg:sha256:<hex>:<bytes>`, never base64: a row
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
 * (its `VIEW_MAX_BYTES`, #856), so an image that tool shows is never refused here. About 2 MiB as base64,
 * and the provider's per-request budget is shared with the rest.
 */
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

/**
 * The longest side every provider we offer accepts: Anthropic refuses an image over 8000 pixels on either side, and
 * DeepSeek one over 8192. A refused image would be in every later request of the conversation (a permanent 400 on each
 * call until the image window moved past it), so one is refused here instead, before it is attached.
 */
export const MAX_IMAGE_SIDE = 8000;

/**
 * What a model that cannot see an image is told in its place. It names no model: which ones can see changes with the
 * deployment's list (src/model/context-windows.ts `VISION_MODELS`), and a sentence that named them went stale.
 */
export const NO_VISION_SENTENCE = "This model cannot see images; an owner can switch this agent to a model that can.";

const SHA = /^[0-9a-f]{64}$/;

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The reference for an image whose `bytes` bytes hash to `sha256`: `apimg:sha256:<hex>:<bytes>`. The size rides in the
 * reference so the request's image window (`resolveImages`) is decided from the conversation alone, with nothing read
 * and nothing a failed read could move.
 */
export const imageRef = (sha256: string, bytes: number): string => `${IMAGE_REF_PREFIX}${sha256}:${bytes}`;

const REF = /^([0-9a-f]{64})(?::(\d{1,9}))?$/;

/** The hash a reference names, or null when `data` is not a reference (base64 bytes, or anything else). */
export function imageRefHash(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith(IMAGE_REF_PREFIX)) return null;
  return REF.exec(data.slice(IMAGE_REF_PREFIX.length))?.[1] ?? null;
}

/** The size a reference declares; MAX_IMAGE_BYTES, the most it can be, for one that declares none or an impossible one. */
export function imageRefBytes(data: unknown): number {
  const n = typeof data === "string" ? Number(REF.exec(data.slice(IMAGE_REF_PREFIX.length))?.[2]) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_IMAGE_BYTES ? n : MAX_IMAGE_BYTES;
}

/**
 * The size a reference declares, as written, or null when it declares none. Unlike `imageRefBytes` this is not
 * clamped: it is what the bytes read back are held to (`resolveImages`), so an impossible size simply never matches.
 */
export function imageRefDeclaredBytes(data: unknown): number | null {
  if (typeof data !== "string" || !data.startsWith(IMAGE_REF_PREFIX)) return null;
  const raw = REF.exec(data.slice(IMAGE_REF_PREFIX.length))?.[2];
  return raw === undefined ? null : Number(raw);
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
    // The frame header (SOF0..SOF15 but DHT, JPG and DAC) carries the size; walk the segments to it with the Raft
    // plugin's bounds (its `imageHeader`, #856), so a frame header it reads at the end of a short file is read here too.
    let i = 2;
    while (i + 1 < b.length) {
      if (at(i) !== 0xff) break;
      const marker = at(i + 1);
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = be16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 8 >= b.length || length < 7) break;
        return { mimeType: "image/jpeg", height: be16(i + 5), width: be16(i + 7) };
      }
      i += 2 + length;
    }
    // No frame header found: still a JPEG by its first bytes, with no size to check.
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

/**
 * How many images one request carries, newest first: at most `maxImages`, and at most `maxBytes` of them raw. Every
 * image in the conversation is sent again on every later call, so without a bound the request and the consumer's heap
 * grow with each one: ten 1.5 MiB images are a 20 MB request and about 40 MB of heap, and some twenty-five of them
 * would exhaust a Worker's 128 MB on every later call, retries included, long before a million-token window compacts.
 */
export interface ImageWindow { maxImages: number; maxBytes: number }
export const DEFAULT_IMAGE_WINDOW: ImageWindow = { maxImages: 8, maxBytes: 12 * 1024 * 1024 };

/** Whether any user or tool-result message of `context` holds an image reference. */
export function hasImageRefs(context: { messages?: readonly unknown[] }): boolean {
  return (context.messages ?? []).some((m: any) => Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "image" && imageRefHash(c.data) !== null));
}

/**
 * How far the window's start moves at a time, in images. The provider caches a request's prefix, and image bytes are
 * part of it: a window that always held exactly the newest images would drop the oldest at every new one, changing
 * the request near its start on every image turn. Its start is instead a multiple of this, so it moves once per
 * `IMAGE_WINDOW_STEP` images and drops that many at once.
 */
export const IMAGE_WINDOW_STEP = 4;

/** What an image outside the window is sent as: a line of its own, after whatever text came before it. */
export const omittedImageText = (mimeType: unknown, sha256: string) =>
  `\n\n[earlier image omitted: ${String(mimeType)} ${sha256.slice(0, 8)}; view it again if it is needed]`;

/**
 * What became of one image reference of a request (`resolveImagesReported`), in conversation order. Names and sizes
 * only: never bytes, a URL or a storage key.
 *
 * - `included_in_request`: its bytes are in the request.
 * - `omitted`: sent as a note instead, and never read. `over_budget`: the images after it already fill the window's
 *   budget; `before_window`: it would fit, but the window's start moves a step at a time (`IMAGE_WINDOW_STEP`) and has
 *   moved past it; `non_vision_model`: the model cannot see images, so none is read.
 * - `load_failed`: in the window, but not sent: `missing` (nothing stored under its hash), `read_error` (the read
 *   threw, no store was reachable, or the bytes no longer hash to the reference), `size_mismatch` (the bytes read are
 *   not the size the reference declares).
 */
export type ImageItemResult = "included_in_request" | "omitted" | "load_failed";
export type ImageItemReason = "before_window" | "over_budget" | "non_vision_model" | "missing" | "read_error" | "size_mismatch";
export interface ImageItem {
  index: number;
  sha256: string;
  /** The size the reference declares; null when it declares none. */
  declaredBytes: number | null;
  /** The size of the bytes read; null when nothing was read (omitted, missing, or the read failed). */
  readBytes: number | null;
  result: ImageItemResult;
  reason?: ImageItemReason;
}

/**
 * `context` with image references replaced, for the provider call, decided here at the call so the stored history
 * stays as it was written. Which images are sent is decided from the references alone (each declares its size,
 * `imageRef`), so it is the same whatever a read returns:
 *
 * - The images from the window's start on become their bytes as base64. Counting every image block of the
 *   conversation oldest first, `fits` is the oldest from which the images to the end fit `window` (no more than
 *   `maxImages`, no more than `maxBytes`). The start is `fits` snapped forward to a multiple of the step,
 *   `min(IMAGE_WINDOW_STEP, maxImages)`, but never past the newest image when that one fits on its own. As images are
 *   added it only moves forward, so between compactions an image that has left never returns; and it moves once per
 *   step, so the provider's cached prefix (which holds image bytes) breaks once per step of new images rather than at
 *   every one. A window too small for the step (a budget of fewer images than the step) moves with each image instead,
 *   since the newest image is the one the model has just asked to see.
 * - Every image before the start becomes a short note naming it (`omittedImageText`), and is never read; the consumer
 *   holds at most the window.
 * - One in the window that cannot be read, whose bytes are not the size its reference declares, or whose bytes no
 *   longer hash to the reference, becomes a text block saying so: the conversation goes on, rather than a job that
 *   fails on every retry for an image that will not come back. A size that differs is refused even when the hash
 *   matches, because the window was sized from the declared sizes and must not carry more than it counted.
 *
 * A context with no reference is returned as it is.
 */
export async function resolveImages<C extends { messages?: readonly unknown[] }>(
  context: C, load: ImageLoader | undefined, window: ImageWindow = DEFAULT_IMAGE_WINDOW,
): Promise<C> {
  return (await resolveImagesReported(context, load, window)).context;
}

/** Every image reference of `context`, oldest first, where it sits and what it declares. */
function imageSlots(messages: readonly unknown[]) {
  const slots: Array<{ m: any; ci: number; sha: string; bytes: number; declared: number | null; mimeType: unknown }> = [];
  for (const m of messages as any[]) {
    if (!Array.isArray(m?.content)) continue;
    m.content.forEach((c: any, ci: number) => {
      const sha = c?.type === "image" ? imageRefHash(c.data) : null;
      if (sha !== null) slots.push({ m, ci, sha, bytes: imageRefBytes(c.data), declared: imageRefDeclaredBytes(c.data), mimeType: c.mimeType });
    });
  }
  return slots;
}

/**
 * What a model that cannot see images is sent in place of each reference is decided elsewhere (the serializers); this
 * is what became of each one, for the evidence: every one omitted, nothing read. `windowStart` is the number of
 * references, the index past the last, since no image is sent.
 */
export function nonVisionImageItems(context: { messages?: readonly unknown[] }): { items: ImageItem[]; windowStart: number } {
  const slots = imageSlots(context.messages ?? []);
  return {
    items: slots.map((s, index) => ({ index, sha256: s.sha, declaredBytes: s.declared, readBytes: null, result: "omitted" as const, reason: "non_vision_model" as const })),
    windowStart: slots.length,
  };
}

/** `resolveImages`, and what became of each reference (`ImageItem`) and where the window started. */
export async function resolveImagesReported<C extends { messages?: readonly unknown[] }>(
  context: C, load: ImageLoader | undefined, window: ImageWindow = DEFAULT_IMAGE_WINDOW,
): Promise<{ context: C; items: ImageItem[]; windowStart: number }> {
  if (!hasImageRefs(context)) return { context, items: [], windowStart: 0 };
  const messages = (context.messages ?? []).map((m: any) => Array.isArray(m?.content) ? { ...m, content: [...m.content] } : m);
  const slots = imageSlots(messages);
  const { fits, start } = windowBounds(slots.map((x) => x.bytes), window);
  type Read = { data: string; length: number } | { problem: string; reason: ImageItemReason; length: number | null };
  const read = new Map<string, Promise<Read>>();
  const fetchOne = (sha: string) => {
    let p = read.get(sha);
    if (!p) {
      p = (async (): Promise<Read> => {
        if (!load) return { problem: "no image store is reachable here", reason: "read_error", length: null };
        let bytes: Uint8Array | null;
        try { bytes = await load(sha); } catch (e) { return { problem: `reading it failed (${String((e as Error)?.message ?? e).slice(0, 120)})`, reason: "read_error", length: null }; }
        if (!bytes) return { problem: "it is no longer stored", reason: "missing", length: null };
        if (sha256Hex(bytes) !== sha) return { problem: "the stored bytes no longer match it", reason: "read_error", length: bytes.byteLength };
        return { data: Buffer.from(bytes).toString("base64"), length: bytes.byteLength };
      })();
      read.set(sha, p);
    }
    return p;
  };
  const items: ImageItem[] = [];
  for (const [k, slot] of slots.entries()) {
    const item = { index: k, sha256: slot.sha, declaredBytes: slot.declared };
    if (k < start) {
      slot.m.content[slot.ci] = { type: "text", text: omittedImageText(slot.mimeType, slot.sha) };
      items.push({ ...item, readBytes: null, result: "omitted", reason: k < fits ? "over_budget" : "before_window" });
      continue;
    }
    let got = await fetchOne(slot.sha);
    // Per reference, not per hash: two references to one hash may declare different sizes.
    if ("data" in got && slot.declared !== null && got.length !== slot.declared) {
      got = { problem: `it is ${got.length} bytes, not the ${slot.declared} its reference declares`, reason: "size_mismatch", length: got.length };
    }
    if ("problem" in got) {
      slot.m.content[slot.ci] = { type: "text", text: `\n\n(an image could not be loaded: ${got.problem})` };
      items.push({ ...item, readBytes: got.length, result: "load_failed", reason: got.reason });
    } else {
      slot.m.content[slot.ci] = { ...slot.m.content[slot.ci], data: got.data };
      items.push({ ...item, readBytes: got.length, result: "included_in_request" });
    }
  }
  return { context: { ...context, messages }, items, windowStart: start };
}

/** The step the window's start moves by for `window`: `IMAGE_WINDOW_STEP`, or the whole window when that is smaller. */
export const windowStep = (window: ImageWindow): number => Math.max(1, Math.min(IMAGE_WINDOW_STEP, window.maxImages));

/**
 * The index of the first image sent, of images whose sizes are `sizes`, oldest first (see `resolveImages`). A function
 * of the sizes and the window alone.
 */
export function windowStart(sizes: readonly number[], window: ImageWindow): number {
  return windowBounds(sizes, window).start;
}

/**
 * `start`, the index of the first image sent, and `fits`, the oldest from which the images to the end fit the budget:
 * an image before `fits` is over the budget, one from `fits` up to `start` was passed over by the step.
 */
export function windowBounds(sizes: readonly number[], window: ImageWindow): { fits: number; start: number } {
  const n = sizes.length;
  let fits = n, bytes = 0;
  while (fits > 0 && n - (fits - 1) <= window.maxImages && bytes + sizes[fits - 1]! <= window.maxBytes) bytes += sizes[--fits]!;
  const snapped = Math.ceil(fits / windowStep(window)) * windowStep(window);
  // The newest image, when it fits on its own, is always sent.
  return { fits, start: fits < n ? Math.min(snapped, n - 1) : n };
}
