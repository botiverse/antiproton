/**
 * A tool result that shows the model an image: the `view` marker.
 *
 * A plugin cannot put an image in a tool result: a result is JSON the gateway records and the runtime may park,
 * and base64 in it would be a megabyte in the operations row, the transcript and every later request. So a result
 * that wants an image seen carries a reserved top-level field instead, small JSON naming an artifact the agent can
 * already read:
 *
 *     view: { ref: "artifact://…", mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif",
 *             width?: number, height?: number, bytes: number }
 *
 * and the harness does the rest (`viewContent`, called for every tool result by `deliverToolResult` in
 * src/runtime/pi-tools.ts, which both engines share). The field is any tool's, not one plugin's: the first user
 * is the Raft plugin's `attachments_view`, and nothing here knows it.
 *
 * The marker is checked strictly, because what it asks for is reading the agent's storage and showing a model the
 * bytes: exactly these keys, an `artifact://` reference (resolved under the caller's own scope, src/store/refs.ts),
 * one of the four types every vision model we offer takes, `bytes` within MAX_IMAGE_BYTES and equal to what is
 * stored. Whatever is wrong is said in the result's text; an image is never dropped without a word, and a model
 * that cannot see one is told so (`NO_VISION_SENTENCE`).
 */
import {
  IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, NO_VISION_SENTENCE, imageKey, imageProblem, imageRef, sha256Hex,
} from "../model/images.ts";
import { AGENT_REF, keyForRef, type RefOwner } from "../store/refs.ts";

/** The reserved field. */
export const VIEW_FIELD = "view";

export interface ViewMarker {
  ref: string;
  mimeType: typeof IMAGE_MIME_TYPES[number];
  width?: number;
  height?: number;
  bytes: number;
}

const KEYS = new Set(["ref", "mimeType", "width", "height", "bytes"]);
const MAX_REF = 1024;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Why a `view` value is not a marker this harness will act on, or the marker. */
export function parseView(v: unknown): { view: ViewMarker } | { problem: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { problem: "view is not an object" };
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !KEYS.has(k));
  if (extra !== undefined) return { problem: `view has an unknown field ${JSON.stringify(extra.slice(0, 40))}` };
  if (typeof o.ref !== "string" || !o.ref.startsWith(AGENT_REF) || o.ref.length > MAX_REF) return { problem: `view.ref is not an ${AGENT_REF} reference` };
  if (typeof o.mimeType !== "string" || !(IMAGE_MIME_TYPES as readonly string[]).includes(o.mimeType)) {
    return { problem: `view.mimeType is not one of ${IMAGE_MIME_TYPES.join(", ")}` };
  }
  if (!isInt(o.bytes, 1, Number.MAX_SAFE_INTEGER)) return { problem: "view.bytes is not a positive whole number" };
  if (o.bytes > MAX_IMAGE_BYTES) return { problem: `the image is ${o.bytes} bytes, over the ${MAX_IMAGE_BYTES}-byte limit` };
  for (const k of ["width", "height"] as const) {
    if (o[k] === undefined) continue;
    if (!isInt(o[k], 1, Number.MAX_SAFE_INTEGER)) return { problem: `view.${k} is not a positive whole number` };
    if ((o[k] as number) > MAX_IMAGE_SIDE) return { problem: `view.${k} is ${o[k]}, over the ${MAX_IMAGE_SIDE}-pixel limit` };
  }
  return {
    view: {
      ref: o.ref, mimeType: o.mimeType as ViewMarker["mimeType"], bytes: o.bytes,
      ...(o.width === undefined ? {} : { width: o.width as number }),
      ...(o.height === undefined ? {} : { height: o.height as number }),
    },
  };
}

/**
 * A result split into its `view` field and the rest: `view` undefined, and the result itself untouched, when it has
 * none, so a result without one is handled exactly as it was before the field existed.
 */
export function splitView(result: unknown): { view: unknown; rest: unknown } {
  if (result === null || typeof result !== "object" || Array.isArray(result) || !Object.prototype.hasOwnProperty.call(result, VIEW_FIELD)) {
    return { view: undefined, rest: result };
  }
  const { [VIEW_FIELD]: view, ...rest } = result as Record<string, unknown>;
  return { view, rest };
}

/** The result with its `view` field put back after the runtime replaced the rest (a parked or cut result). */
export function withView(result: unknown, view: unknown): unknown {
  if (view === undefined) return result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) return { ...(result as object), [VIEW_FIELD]: view };
  return { result, [VIEW_FIELD]: view };
}

/** What the tool host does for a marker: whether the agent's model sees images, and the image stored for the model. */
export interface ViewHost {
  /** Whether the agent's bound model can see images now. Absent: none can be shown here. */
  seesImages?(): Promise<boolean>;
  /** The image the marker names, stored for the model; resolves to the reference for its image block. Throws why not. */
  attachImage?(view: ViewMarker): Promise<string>;
}

type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

const describe = (v: ViewMarker) => `${v.ref} (${v.mimeType}${v.width && v.height ? `, ${v.width}x${v.height}` : ""}, ${v.bytes} bytes)`;

/**
 * A tool result's content for the model when it carries a `view` field, or null when it does not. `shown` is the rest
 * of the result as the model reads it (it may be wrapped, as a result after a program is); its JSON is the text, and a
 * sentence after it says what became of the image: attached, not visible to this model, or not attachable and why.
 */
export async function viewContent(view: unknown, shown: unknown, host: ViewHost): Promise<Content> {
  const json = JSON.stringify(shown ?? null);
  const say = (sentence: string): Content => [{ type: "text", text: `${json}\n\n${sentence}` }];
  const parsed = parseView(view);
  if ("problem" in parsed) return say(`The result's image could not be attached: ${parsed.problem}.`);
  const v = parsed.view;
  if (!host.seesImages || !host.attachImage) return say(`The result has an image, ${describe(v)}, but images cannot be shown to the model here.`);
  if (!(await host.seesImages())) return say(`The result has an image, ${describe(v)}. ${NO_VISION_SENTENCE}`);
  let ref: string;
  try {
    ref = await host.attachImage(v);
  } catch (e) {
    return say(`The result's image, ${v.ref}, could not be attached: ${String((e as Error)?.message ?? e).slice(0, 200)}.`);
  }
  return [{ type: "text", text: `${json}\n\nImage attached: ${describe(v)}.` }, { type: "image", data: ref, mimeType: v.mimeType }];
}

/** Where an image's bytes are read from and stored to: the agent's artifacts (`R2Artifacts`' surface). */
export interface ImageStore {
  /** The stored size without reading the object (R2's `head`), or null when there is none. Asked before `get`. */
  size(key: string): Promise<number | null>;
  get(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array): Promise<unknown>;
}

/**
 * The tool host's `attachImage`: the marker's artifact read under the caller's own scope, checked against the marker
 * and its own header (src/model/images.ts `imageProblem`), and stored once under its hash for the queue consumer to
 * read back. Resolves to the reference the image block holds.
 */
export async function attachViewImage(view: ViewMarker, owner: RefOwner, store: ImageStore): Promise<string> {
  const key = keyForRef(view.ref, owner);
  if (key === null) throw new Error("the reference is not readable by this agent");
  // The size first, from the object's metadata: the marker's `bytes` is within the cap (`parseView`), so a stored
  // object that is larger is refused before a byte of it is read.
  const size = await store.size(key);
  if (size === null) throw new Error("no such artifact");
  if (size !== view.bytes) throw new Error(`the artifact is ${size} bytes, not ${view.bytes} as the result says`);
  const bytes = await store.get(key);
  if (bytes.byteLength !== view.bytes) throw new Error(`the artifact is ${bytes.byteLength} bytes, not ${view.bytes} as the result says`);
  const problem = imageProblem(bytes, view.mimeType);
  if (problem) throw new Error(problem);
  const sha = sha256Hex(bytes);
  await store.put(imageKey(owner, sha), bytes);
  return imageRef(sha);
}

