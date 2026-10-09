/**
 * Workspace files given to an agent before it first runs (an evaluation's setup), and the seal that ends that window.
 * Shared by the two stores (src/store/durable-object.ts, src/store/sqlite.ts), as src/store/seed-record.ts is, so
 * both keep the same rows by the same rule; the runtime seals through the same function from inside its own
 * synchronous run (cf/src/runtime.ts `receiveHook`).
 *
 * Two copies of each file, written in one transaction. `seed_files` is the snapshot: what the setup gave, with its
 * mode and hash, never written again once sealed, and reachable by no tool. The working copy is an ordinary
 * `agent_state` row at key = path, the one the state plugin's `get` reads and its `put` may replace (unless the
 * mode is `readonly`, which the plugin asks `listSeedFiles` about). So an evaluator can compare what the agent ended
 * with against what it was given, by hash.
 *
 * `seed_seal` is one row per agent: when the window closed, how (`explicit`, or the first accepted inbound push,
 * or the first turn), and the manifest it closed on. Writes are refused from then on. The seal and a write are each
 * synchronous statements in the agent's own object, so one of them is first and the other sees it: a write that
 * lands after the push that starts the agent's first turn was accepted is refused, even while that turn is still
 * queued.
 *
 * `bytes` here is the file's UTF-8 length: the body arrives as bytes and its hash is of those bytes, so the two are
 * counted in the same unit (the exception for binary payloads in AGENTS.md's convention). The working copy's own
 * `bytes` is the state plugin's, the length of the value's JSON, as for any other key.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../core/canon-json.ts";
import { STATE_INLINE_MAX, STATE_KEY } from "../plugins/state-key.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

export type SeedMode = "writable" | "readonly";
export const SEED_MODES: readonly SeedMode[] = ["writable", "readonly"];
/**
 * `prior-activity` is the seal a write finds was owed: the agent has run already (`priorActivity`), but before the
 * seal existed, so nothing closed its window then.
 */
export type SealHow = "explicit" | "first-inbound" | "first-turn" | "prior-activity";

/** One file, as large as an evaluation's notes plausibly are. */
export const SEED_FILE_MAX_BYTES = 256 * 1024;
/** All of an agent's seeded files together. */
export const SEED_AGENT_MAX_BYTES = 2 * 1024 * 1024;

/** What a seeded file is, without its content: the manifest's row, and what the state plugin is told. */
export interface SeedFileMeta { path: string; mode: SeedMode; bytes: number; sha256: string }

export interface SeedSeal {
  sealedAt: number;
  how: SealHow;
  /** sha256 of `canonJson(manifest)` (src/core/canon-json.ts). */
  manifestSha256: string;
  /** Sorted by path. */
  manifest: SeedFileMeta[];
}

export const SEED_FILES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seed_files (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL,
     bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content TEXT, ref TEXT, seeded_at INTEGER NOT NULL,
     PRIMARY KEY (tenant_id, agent_id, path))`,
  `CREATE TABLE IF NOT EXISTS seed_seal (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, sealed_at INTEGER NOT NULL, how TEXT NOT NULL,
     manifest_sha256 TEXT NOT NULL, manifest TEXT NOT NULL,
     PRIMARY KEY (tenant_id, agent_id))`,
];

/**
 * Why `path` cannot name a seeded file, or null. The state plugin's key rule, since the working copy is a state key;
 * then what that rule lets through and the key would still get wrong: a `.`, `..` or empty segment, which the
 * plugin's `put` refuses once a value is large enough to be spilled (its object key would move), and a `kept:` name,
 * which is where the plugin keeps secrets (src/runtime/secrets.ts). The colon already fails the key rule; it is asked
 * by name so that loosening the rule does not open it.
 */
export function seedPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "path is required";
  if (path.startsWith("kept:")) return "kept: names a secret, not a file";
  if (!STATE_KEY.test(path)) return `path must match ${STATE_KEY} (a state key)`;
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) return "path must not have an empty, `.` or `..` segment";
  return null;
}

/**
 * The body as text, or why it cannot be a seeded file: larger than one file may be, carrying a NUL, or not UTF-8.
 * A BOM is kept as a character, so the text re-encodes to exactly these bytes and its hash is theirs.
 */
export function seedText(bytes: Uint8Array): { text: string } | { problem: string; status: 413 | 422 } {
  if (bytes.byteLength > SEED_FILE_MAX_BYTES) return { problem: `a seeded file is at most ${SEED_FILE_MAX_BYTES} bytes; this is ${bytes.byteLength}`, status: 413 };
  if (bytes.includes(0)) return { problem: "the body carries a NUL byte; a seeded file is UTF-8 text", status: 422 };
  try { return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return { problem: "the body is not valid UTF-8", status: 422 }; }
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(typeof value === "string" ? new TextEncoder().encode(value) : value).digest("hex");
}

/** The manifest's hash: of its canonical JSON, so it is the same however the rows were read. */
export function manifestSha256(manifest: readonly SeedFileMeta[]): string {
  return sha256Hex(canonJson(manifest));
}

/** Whether a text kept as a state value stays in its row: the plugin's own measure, the length of its JSON. */
export function seedInline(text: string): boolean {
  return JSON.stringify(text).length <= STATE_INLINE_MAX;
}

const meta = (r: any): SeedFileMeta => ({ path: String(r.path), mode: String(r.mode) as SeedMode, bytes: Number(r.bytes), sha256: String(r.sha256) });

/** Every seeded file of the agent, without content, sorted by path. Read-only. */
export function listSeedFiles(sql: Sql, tenantId: string, agentId: string): SeedFileMeta[] {
  return sql.exec("SELECT path, mode, bytes, sha256 FROM seed_files WHERE tenant_id=? AND agent_id=? ORDER BY path",
    tenantId, agentId).toArray().map(meta);
}

/** One file's snapshot: its text when kept inline, else the reference to it in object storage. */
export function seedSnapshot(sql: Sql, tenantId: string, agentId: string, path: string):
  (SeedFileMeta & { content: string | null; ref: string | null; seededAt: number }) | null {
  const r = sql.exec("SELECT * FROM seed_files WHERE tenant_id=? AND agent_id=? AND path=?", tenantId, agentId, path).toArray()[0];
  return r ? { ...meta(r), content: r.content ?? null, ref: r.ref ?? null, seededAt: Number(r.seeded_at) } : null;
}

export function readSeal(sql: Sql, tenantId: string, agentId: string): SeedSeal | null {
  const r = sql.exec("SELECT sealed_at, how, manifest_sha256, manifest FROM seed_seal WHERE tenant_id=? AND agent_id=?",
    tenantId, agentId).toArray()[0];
  return r ? { sealedAt: Number(r.sealed_at), how: String(r.how) as SealHow, manifestSha256: String(r.manifest_sha256), manifest: JSON.parse(String(r.manifest)) } : null;
}

/**
 * Close the window, once: the first call writes the row with the manifest as it stands, every later one finds it and
 * changes nothing (`sealedNow` false), whatever its `how`. Inside the caller's transaction, or its synchronous run.
 */
export function sealSeedFiles(sql: Sql, tenantId: string, agentId: string, how: SealHow, now: number): { seal: SeedSeal; sealedNow: boolean } {
  const had = readSeal(sql, tenantId, agentId);
  if (had) return { seal: had, sealedNow: false };
  const manifest = listSeedFiles(sql, tenantId, agentId);
  const seal: SeedSeal = { sealedAt: now, how, manifestSha256: manifestSha256(manifest), manifest };
  sql.exec("INSERT INTO seed_seal(tenant_id, agent_id, sealed_at, how, manifest_sha256, manifest) VALUES (?,?,?,?,?,?)",
    tenantId, agentId, now, how, seal.manifestSha256, JSON.stringify(manifest));
  return { seal, sealedNow: true };
}

/** One file to seed, its two copies already decided: the snapshot's text or reference, and the working copy's row. */
export interface SeedWrite {
  path: string; mode: SeedMode; bytes: number; sha256: string;
  /** The snapshot: its text when kept inline (`ref` null), or null with `ref` naming the object it was spilled to. */
  content: string | null; ref: string | null;
  /** The working copy, an `agent_state` row as the state plugin writes one: `value` the value's JSON text, or null with `ref`. */
  working: { value: string | null; ref: string | null; bytes: number };
}

export type SeedWriteResult =
  | { ok: true; changed: boolean; file: SeedFileMeta }
  | { ok: false; code: "sealed" | "agent_cap"; message: string };

/**
 * What the store may answer besides: the write came with its text inline, too large for a row, on the strength of
 * a repeat (the same bytes and mode as the file held when the caller looked), and the file no longer holds them. The
 * caller spills and writes again (cf/src/runtime.ts `seedWrite`); it is never a route's answer.
 */
export type SeedStoreResult = SeedWriteResult | { ok: false; code: "spill"; message: string };

/** Rows of a read, or none when the table was never made: asking whether an agent ran must not create its tables. */
function rowsIfAny(sql: Sql, query: string, ...b: unknown[]): any[] {
  try { return sql.exec(query, ...b).toArray(); }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return []; throw e; }
}

/**
 * Why this agent has already run, or null: a message in its main transcript (pi's unprefixed `pi_entries`,
 * src/store/pi-storage.ts `piTables`), a main conversation ended by a fresh context (`main_sessions`,
 * cf/src/fresh-context.ts), or a push accepted for it (`inbound_pending`, or `delivered` in `inbound_events`,
 * src/runtime/inbound.ts). An agent that ran before seals existed has no seal and would otherwise take a seed over
 * the state it built; the turn or push that seals today (`first-turn`, `first-inbound`) leaves one of these too.
 * The names are spelled here rather than imported, so the stores do not load the engine; test/eval-seed-object.ts
 * runs a real turn and a real push against this.
 */
export function priorActivity(sql: Sql): string | null {
  if (rowsIfAny(sql, "SELECT 1 FROM pi_entries WHERE type = 'message' LIMIT 1").length) return "its main conversation has messages";
  if (rowsIfAny(sql, "SELECT 1 FROM main_sessions WHERE ended_at IS NOT NULL LIMIT 1").length) return "it has had a fresh context";
  if (rowsIfAny(sql, "SELECT 1 FROM inbound_pending LIMIT 1").length
    || rowsIfAny(sql, "SELECT 1 FROM inbound_events WHERE outcome = 'delivered' LIMIT 1").length) return "a push was accepted for it";
  return null;
}

/**
 * Write both copies, or neither, inside the caller's transaction. Refused once sealed, and an agent that has already
 * run (`priorActivity`) is sealed here, as `prior-activity`, and refused; refused when the agent's files would pass
 * `SEED_AGENT_MAX_BYTES` together. The same bytes and mode as the file already holds is no write at all, so a retried
 * setup changes nothing, not even the time; anything different replaces both copies. Whether that repeat is one is
 * decided here, in the transaction: a caller that sent a large text inline because it looked like a repeat is told
 * to spill (`spill`) when it no longer is, so no row ever keeps more than a value's inline limit.
 */
export function writeSeedFile(sql: Sql, tenantId: string, agentId: string, w: SeedWrite, now: number): SeedStoreResult {
  let sealed = readSeal(sql, tenantId, agentId);
  if (!sealed && priorActivity(sql)) sealed = sealSeedFiles(sql, tenantId, agentId, "prior-activity", now).seal;
  if (sealed) {
    return { ok: false, code: "sealed", message: `the workspace was sealed (${sealed.how}) at ${new Date(sealed.sealedAt).toISOString()}; seeded files can no longer change` };
  }
  const file: SeedFileMeta = { path: w.path, mode: w.mode, bytes: w.bytes, sha256: w.sha256 };
  const prior = sql.exec("SELECT mode, sha256 FROM seed_files WHERE tenant_id=? AND agent_id=? AND path=?", tenantId, agentId, w.path).toArray()[0];
  if (prior && prior.mode === w.mode && prior.sha256 === w.sha256) return { ok: true, changed: false, file };
  if ((w.content !== null && !seedInline(w.content)) || (w.working.value !== null && w.working.value.length > STATE_INLINE_MAX)) {
    return { ok: false, code: "spill", message: `${w.path} is too large to keep in its row and is no longer a repeat; spill it` };
  }
  const others = Number(sql.exec("SELECT COALESCE(SUM(bytes), 0) AS n FROM seed_files WHERE tenant_id=? AND agent_id=? AND path != ?",
    tenantId, agentId, w.path).toArray()[0]?.n ?? 0);
  if (others + w.bytes > SEED_AGENT_MAX_BYTES) {
    return { ok: false, code: "agent_cap", message: `an agent's seeded files are at most ${SEED_AGENT_MAX_BYTES} bytes together; the others hold ${others} and this is ${w.bytes}` };
  }
  sql.exec(
    `INSERT INTO seed_files(tenant_id, agent_id, path, mode, bytes, sha256, content, ref, seeded_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, agent_id, path) DO UPDATE SET mode=excluded.mode, bytes=excluded.bytes, sha256=excluded.sha256,
       content=excluded.content, ref=excluded.ref, seeded_at=excluded.seeded_at`,
    tenantId, agentId, w.path, w.mode, w.bytes, w.sha256, w.content, w.ref, now);
  // The same statement both stores' `putState` runs, so the row reads back through `getState` like any other.
  sql.exec(
    `INSERT INTO agent_state(tenant_id, agent_id, key, value, ref, bytes, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, agent_id, key) DO UPDATE SET value=excluded.value, ref=excluded.ref, bytes=excluded.bytes,
       updated_at=excluded.updated_at`,
    tenantId, agentId, w.path, w.working.value, w.working.ref, w.working.bytes, now);
  return { ok: true, changed: true, file };
}
