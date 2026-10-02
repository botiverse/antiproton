/**
 * One agent's workspace as files: three virtual roots, one directory level per listing, and a read
 * that never returns more than `READ_MAX_BYTES`.
 *
 *   state/      what the agent kept with the state plugin (src/plugins/state.ts), one file per key,
 *               `/` in a key making directories. Only the `agent_state` rows: the agent's sealed
 *               secrets (`kept:<name>`, src/runtime/secrets.ts) live in another table and are never
 *               asked for here, and a key that reads like one is refused on both paths anyway, so
 *               that a store which one day put the two together would still not show one.
 *               Mount credentials and hook secrets are not in either.
 *   artifacts/  the agent's objects in the artifacts bucket, under its own scope
 *               (`t/<tenant>/<agent>/`, src/store/refs.ts).
 *   sandbox/    the working directory of the agent's container, only while that container is
 *               already running. A container is billed while it runs, so this never starts one:
 *               when none is running the directory holds a single text file saying so.
 *
 * Read-only throughout: nothing here writes, and nothing here is the agent's to see as a tool.
 * No caller's concepts either; the public API and the provider binding both call these.
 */

import type { HeldListing, HeldRead } from "../../../src/plugins/types.ts";

export const ROOTS = ["state", "artifacts", "sandbox"] as const;
export type Root = typeof ROOTS[number];

/** The most a read returns. Past it a file is reported (`size`) and not returned. */
export const READ_MAX_BYTES = 1024 * 1024;
/** The most entries one listing returns; a directory larger than this is cut, in name order. */
export const LIST_MAX = 1000;
/** The most state keys one listing reads; past it the listing says it was cut. */
const STATE_LIST_MAX = 5000;
/** The name of the file `sandbox/` holds while no container is running. */
export const NOT_RUNNING_FILE = "NOT_RUNNING.txt";
export const NOT_RUNNING_TEXT =
  "The agent's container is not running, so its files cannot be shown.\n\n" +
  "A container is billed while it runs, and this view never starts one. Its files appear here the " +
  "next time the agent is using its container.\n";

/** What the agent's sealed secrets are named in the store (src/runtime/secrets.ts KEPT_PREFIX). */
const SECRET_PREFIX = "kept:";

/** A listing, and what it left out: `truncated` only when entries exist that are not in `files`. */
export type Listing = { files: FileNode[]; truncated?: true; omitted?: number };

export interface FileNode { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string; isHidden?: true }
export interface FileRead { content: string | null; binary: boolean; size: number; mimeType: string; encoding: "utf-8" | "base64" }
export type Refused = { ok: false; status: 400 | 404; param?: string; message: string };

export interface ArtifactObject { key: string; size: number; uploaded: number; contentType?: string }

/** The container's working directory, as the plugin that holds it answers (src/plugins/types.ts HeldFiles). */
export type SandboxList = HeldListing;
export type SandboxRead = HeldRead;

export interface WorkspaceDeps {
  state: {
    /** Keys beginning with `prefix`, at most `limit`. A store may match loosely (SQL LIKE); the caller filters. */
    list(tenantId: string, agentId: string, prefix: string, limit: number): Promise<Array<{ key: string; bytes: number; updatedAt: number }>>;
    get(tenantId: string, agentId: string, key: string): Promise<{ value: unknown; ref: string | null; bytes: number; updatedAt: number } | null>;
  };
  artifacts: {
    /** One level under `prefix` (delimiter `/`): its objects and its sub-prefixes. */
    list(prefix: string, cursor?: string): Promise<{ objects: ArtifactObject[]; prefixes: string[]; cursor?: string }>;
    head(key: string): Promise<ArtifactObject | null>;
    get(key: string): Promise<(ArtifactObject & { bytes: Uint8Array }) | null>;
  };
  sandbox: {
    /** `path` is relative to the container's working directory, "" for the directory itself. */
    list(tenantId: string, agentId: string, path: string): Promise<SandboxList>;
    read(tenantId: string, agentId: string, path: string, maxBytes: number): Promise<SandboxRead>;
  };
}

const iso = (ms: number) => new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
const notFound = (path: string): Refused => ({ ok: false, status: 404, message: `no file or directory at ${path}` });
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** A name that reads as a sealed secret's, as given or once decoded, in any case. */
const isSecretName = (s: string) => [s, decoded(s)].some((v) => v.trim().toLowerCase().startsWith(SECRET_PREFIX));

/**
 * A workspace path as segments under one of the roots, or a refusal. Empty and `.` segments drop out
 * (`state//a/./b` is `state/a/b`); a `..` anywhere is refused rather than resolved, encoded or not,
 * as are a backslash and a control character — a name with one is not a name this view hands out.
 */
export function workspacePath(raw: string, param: string, allowTop: boolean): { root: Root | null; segs: string[] } | Refused {
  const bad = (message: string): Refused => ({ ok: false, status: 400, param, message });
  if (raw.length > 2048) return bad(`${param} is at most 2048 characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return bad(`${param} may not contain a backslash or a control character`);
  const segs: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    const plain = decoded(seg);
    if (seg === ".." || plain === ".." || plain === "." || plain.includes("/") || plain.includes("\\")) {
      return bad(`${param} must not move through the tree (no ".." segments)`);
    }
    segs.push(seg);
  }
  if (!segs.length) return allowTop ? { root: null, segs: [] } : bad(`${param} must name a file under ${ROOTS.map((r) => r + "/").join(", ")}`);
  const root = segs[0] as Root;
  if (!(ROOTS as readonly string[]).includes(root)) return bad(`${param} must be under ${ROOTS.map((r) => r + "/").join(", ")}`);
  return { root, segs: segs.slice(1) };
}

const node = (path: string, name: string, isDirectory: boolean, size: number, modified: number): FileNode =>
  ({ name, path, isDirectory, size, modifiedAt: iso(modified), ...(name.startsWith(".") ? { isHidden: true as const } : {}) });

/**
 * The entries a listing shows, in order, and what it left out — the source's own cut (`cut`, with a
 * count when the source knew one) and this listing's cap. Hidden entries left out on request are not
 * "left out": the caller asked for that.
 */
function shown(nodes: FileNode[], includeHidden: boolean, cut: { truncated: boolean; omitted?: number } = { truncated: false }): Listing {
  const visible = nodes
    .filter((n) => includeHidden || !n.isHidden)
    .sort((a, b) => (a.isDirectory === b.isDirectory ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDirectory ? -1 : 1));
  const over = Math.max(0, visible.length - LIST_MAX);
  const files = visible.slice(0, LIST_MAX);
  if (!over && !cut.truncated) return { files };
  const known = cut.truncated ? cut.omitted : 0;
  return { files, truncated: true, ...(known !== undefined ? { omitted: known + over } : {}) };
}

/** One directory level of the agent's workspace. */
export async function workspaceList(
  deps: WorkspaceDeps, tenantId: string, agentId: string, dirPath: string, includeHidden: boolean,
): Promise<({ ok: true } & Listing) | Refused> {
  const p = workspacePath(dirPath, "dirPath", true);
  if ("ok" in p) return p;
  if (p.root === null) return { ok: true, files: ROOTS.map((r) => node(`${r}/`, r, true, 0, 0)) };
  const listed = (l: Listing) => ({ ok: true as const, ...l });
  const base = [p.root, ...p.segs].join("/") + "/";

  if (p.root === "state") {
    if (p.segs.some(isSecretName)) return notFound(base);
    const prefix = p.segs.length ? p.segs.join("/") + "/" : "";
    const all = await deps.state.list(tenantId, agentId, prefix, STATE_LIST_MAX + 1);
    // The same rule as the read: no segment of a key may read as a secret's name.
    const rows = all.slice(0, STATE_LIST_MAX).filter((r) => r.key.startsWith(prefix) && !r.key.split("/").some(isSecretName));
    if (prefix && !rows.length) return notFound(base);
    const dirs = new Map<string, number>();
    const files: FileNode[] = [];
    for (const r of rows) {
      const rest = r.key.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut < 0) { files.push(node(base + rest, rest, false, r.bytes, r.updatedAt)); continue; }
      const dir = rest.slice(0, cut);
      dirs.set(dir, Math.max(dirs.get(dir) ?? 0, r.updatedAt));
    }
    return listed(shown([...files, ...[...dirs].map(([d, at]) => node(`${base}${d}/`, d, true, 0, at))], includeHidden,
      { truncated: all.length > STATE_LIST_MAX }));
  }

  if (p.root === "artifacts") {
    const scope = `t/${tenantId}/${agentId}/`;
    const prefix = scope + (p.segs.length ? p.segs.join("/") + "/" : "");
    const files: FileNode[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.artifacts.list(prefix, cursor);
      for (const o of page.objects) {
        const name = o.key.slice(prefix.length);
        if (!name || name.includes("/")) continue;
        files.push(node(base + name, name, false, o.size, o.uploaded));
      }
      for (const sub of page.prefixes) {
        const name = sub.slice(prefix.length).replace(/\/$/, "");
        if (!name || name.includes("/")) continue;
        files.push(node(`${base}${name}/`, name, true, 0, 0));
      }
      cursor = page.cursor;
    } while (cursor && files.length <= LIST_MAX * 2);
    if (p.segs.length && !files.length) return notFound(base);
    return listed(shown(files, includeHidden, { truncated: !!cursor }));
  }

  const box = await deps.sandbox.list(tenantId, agentId, p.segs.join("/"));
  if (!box.running) {
    if (p.segs.length) return notFound(base);
    return { ok: true, files: [node(`sandbox/${NOT_RUNNING_FILE}`, NOT_RUNNING_FILE, false, new TextEncoder().encode(NOT_RUNNING_TEXT).byteLength, 0)] };
  }
  if (!box.found) {
    return box.notDirectory ? { ok: false, status: 400, param: "dirPath", message: `${base.slice(0, -1)} is a file, not a directory` } : notFound(base);
  }
  return listed(shown(box.entries.map((e) => node(e.isDirectory ? `${base}${e.name}/` : base + e.name, e.name, e.isDirectory, e.isDirectory ? 0 : e.size, e.modifiedAt)),
    includeHidden, { truncated: box.truncated, ...(box.omitted !== undefined ? { omitted: box.omitted } : {}) }));
}

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json", jsonl: "application/x-ndjson", ndjson: "application/x-ndjson",
  csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", htm: "text/html", css: "text/css", xml: "application/xml",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", ts: "text/typescript", py: "text/x-python", sh: "text/x-shellscript",
  yaml: "application/yaml", yml: "application/yaml", toml: "application/toml", log: "text/plain", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip",
};
function mimeOf(name: string, given: string | undefined, binary: boolean): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  const byName = ext ? MIME[ext] : undefined;
  if (byName) return byName;
  if (given && given !== "application/octet-stream") return given;
  return binary ? "application/octet-stream" : "text/plain";
}

/** Text when the bytes are UTF-8 and carry no NUL; base64 otherwise. */
export function asRead(bytes: Uint8Array, name: string, contentType?: string): FileRead {
  let text: string | null = null;
  if (!bytes.includes(0)) {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { text = null; }
  }
  if (text !== null) return { content: text, binary: false, size: bytes.byteLength, mimeType: mimeOf(name, contentType, false), encoding: "utf-8" };
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { content: btoa(bin), binary: true, size: bytes.byteLength, mimeType: mimeOf(name, contentType, true), encoding: "base64" };
}
const tooLarge = (name: string, size: number, contentType?: string): FileRead =>
  ({ content: null, binary: true, size, mimeType: mimeOf(name, contentType, true), encoding: "base64" });

/** What a state value reads as: a text document as its text, anything else as JSON. */
function stateText(value: unknown): { text: string; mime: string } {
  return typeof value === "string" ? { text: value, mime: "text/plain" } : { text: JSON.stringify(value ?? null, null, 2), mime: "application/json" };
}

/** One file of the agent's workspace. */
export async function workspaceRead(
  deps: WorkspaceDeps, tenantId: string, agentId: string, path: string,
): Promise<{ ok: true; file: FileRead } | Refused> {
  const p = workspacePath(path, "path", false);
  if ("ok" in p) return p;
  const shownPath = [p.root, ...p.segs].join("/");
  if (!p.segs.length) return { ok: false, status: 400, param: "path", message: `${shownPath}/ is a directory; list it with workspace-files` };
  const name = p.segs[p.segs.length - 1]!;

  if (p.root === "state") {
    const key = p.segs.join("/");
    if (p.segs.some(isSecretName)) return notFound(shownPath);
    const got = await deps.state.get(tenantId, agentId, key);
    if (!got) return notFound(shownPath);
    let value: unknown = got.value;
    if (got.ref) {
      // A value too large for its row was spilled to the bucket; only under this agent's own scope.
      const scope = `t/${tenantId}/${agentId}/`;
      const objectKey = got.ref.replace(/^r2:\/\/[^/]+\//, "");
      if (!objectKey.startsWith(scope)) return notFound(shownPath);
      const head = await deps.artifacts.head(objectKey);
      if (!head) return notFound(shownPath);
      if (head.size > READ_MAX_BYTES) return { ok: true, file: tooLarge(name, head.size, "application/json") };
      const obj = await deps.artifacts.get(objectKey);
      if (!obj) return notFound(shownPath);
      try { value = JSON.parse(new TextDecoder().decode(obj.bytes)); }
      catch { return { ok: true, file: asRead(obj.bytes, name, "application/json") }; }
    }
    const { text, mime } = stateText(value);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > READ_MAX_BYTES) return { ok: true, file: tooLarge(name, bytes.byteLength, mime) };
    return { ok: true, file: { content: text, binary: false, size: bytes.byteLength, mimeType: mime, encoding: "utf-8" } };
  }

  if (p.root === "artifacts") {
    const key = `t/${tenantId}/${agentId}/${p.segs.join("/")}`;
    const head = await deps.artifacts.head(key);
    if (!head) return notFound(shownPath);
    if (head.size > READ_MAX_BYTES) return { ok: true, file: tooLarge(name, head.size, head.contentType) };
    const obj = await deps.artifacts.get(key);
    if (!obj) return notFound(shownPath);
    return { ok: true, file: asRead(obj.bytes, name, obj.contentType) };
  }

  const got = await deps.sandbox.read(tenantId, agentId, p.segs.join("/"), READ_MAX_BYTES);
  if (!got.running) {
    if (p.segs.length === 1 && name === NOT_RUNNING_FILE) return { ok: true, file: asRead(new TextEncoder().encode(NOT_RUNNING_TEXT), name) };
    return notFound(shownPath);
  }
  if (!got.found) return notFound(shownPath);
  if (got.kind === "directory") return { ok: false, status: 400, param: "path", message: `${shownPath} is a directory; list it with workspace-files` };
  if (got.kind !== "file") return { ok: false, status: 400, param: "path", message: `${shownPath} is not a regular file (a device, socket or the like), and is not read` };
  if (got.size > READ_MAX_BYTES || !got.bytes) return { ok: true, file: tooLarge(name, got.size) };
  return { ok: true, file: asRead(got.bytes, name) };
}
