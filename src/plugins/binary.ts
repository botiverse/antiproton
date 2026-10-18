import { sniffImage } from "../model/images.ts";

/**
 * Telling bytes that are text from bytes that are not, for every plugin that hands a body to the model: decoding
 * leniently turns a JPEG or a gzip stream into a "text" result of U+FFFD runs, which is neither the file nor
 * anything the model can use. Shared so that `artifacts.read` (src/plugins/artifacts.ts) and the http mount's
 * `get`/`send` (src/plugins/http.ts) draw the line in the same place.
 */

/**
 * File types known by their first bytes that are not text, beyond the four images (`sniffImage`). Only signatures
 * that no ordinary text starts with: a text file beginning "BM" or "BZh" is still text.
 */
const MAGIC: Array<{ at: number; sig: string; mimeType: string }> = [
  { at: 0, sig: "%PDF-", mimeType: "application/pdf" },
  { at: 0, sig: "PK\x03\x04", mimeType: "application/zip" },
  { at: 0, sig: "\x1f\x8b", mimeType: "application/gzip" },
  { at: 0, sig: "7z\xbc\xaf\x27\x1c", mimeType: "application/x-7z-compressed" },
  { at: 0, sig: "\xfd7zXZ\x00", mimeType: "application/x-xz" },
  { at: 0, sig: "\x28\xb5\x2f\xfd", mimeType: "application/zstd" },
  { at: 0, sig: "\x7fELF", mimeType: "application/x-elf" },
  { at: 0, sig: "\x00asm", mimeType: "application/wasm" },
  { at: 257, sig: "ustar", mimeType: "application/x-tar" },
  { at: 4, sig: "ftyp", mimeType: "video/mp4" }, // the brand after it may say otherwise (`magicType`)
];

/** How far a NUL byte is looked for: text has none, and nearly every binary format has one early. */
export const NUL_WINDOW = 8 * 1024;

/** The type a file's own first bytes declare, when they are a known non-text signature. */
export function magicType(b: Uint8Array): string | null {
  const image = sniffImage(b);
  if (image) return image.mimeType;
  const hit = MAGIC.find(({ at, sig }) => at + sig.length <= b.length && [...sig].every((c, k) => b[at + k] === c.charCodeAt(0)));
  if (hit?.sig === "ftyp") {
    // An ISO media file names what it is in the four bytes after `ftyp`: AVIF and HEIC are stills, not video.
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^avi[fs]$/.test(brand)) return "image/avif";
    if (/^(?:hei[cx]|hev[cx]|mif1|msf1)$/.test(brand)) return "image/heic";
  }
  return hit?.mimeType ?? null;
}

/** Whether a NUL byte appears within the first `NUL_WINDOW` bytes. */
export const hasEarlyNul = (b: Uint8Array): boolean => b.subarray(0, NUL_WINDOW).includes(0);

/** The bytes decoded as UTF-8, or null when they are not valid UTF-8. A leading BOM is dropped, as `Response.text()` drops it. */
export function strictUtf8(b: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    return null;
  }
}

/**
 * The bytes as text, or null when they are not text: a known binary signature, a NUL in the first 8 KiB, or
 * bytes that are not valid UTF-8.
 */
export function textOf(b: Uint8Array): string | null {
  if (magicType(b) !== null) return null;
  if (hasEarlyNul(b)) return null;
  return strictUtf8(b);
}
