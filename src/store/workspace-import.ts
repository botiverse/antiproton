/**
 * A Raft agent's workspace, brought over once when it moves from a local computer to hosting here
 * (`POST /provision/agents/{agentId}/import`, cf/src/provision/handlers.ts; docs/agent-surface.md "Workspace import"),
 * and the way a newly provisioned agent is given its first files.
 *
 * Each imported file becomes an ordinary `agent_state` row at key = its path, the same row the state plugin's
 * `get` reads and `put` replaces and the workspace's `state/` root shows, written by the same statement
 * src/store/seed-files.ts uses for a seeded file's working copy. Unlike a seeded file there is no snapshot and no
 * mode: an imported file is the agent's own, as it was on the computer it came from.
 *
 * `workspace_import` is one row per agent: the import that happened, its digest (what a retry is compared with),
 * and the manifest it answered with. Its presence is the seal: a second import is refused for good.
 *
 * All or nothing. Everything a request carries is checked before anything is written (the route). A text too
 * large for its row is first put in object storage under a name of this attempt alone (`spillKey`), which no row
 * names yet; then every row and the import's own row are written in ONE transaction (`commitImport`). A failure
 * anywhere before or inside it leaves no row, and the attempt's objects are deleted (cf/src/runtime.ts
 * `importWorkspace`). A file in the workspace is its row, so no imported path is ever readable unless all are.
 *
 * `import_hold` is the wait an agent made with `awaitImport` keeps until its import: no turn starts while it is in
 * place (cf/src/runtime.ts `postMessage`, `#deliverInbound`), and it lifts with the import or, past
 * `IMPORT_HOLD_MAX_MS`, on its own.
 */
import { canonJson } from "../core/canon-json.ts";
import { STATE_INLINE_MAX } from "../plugins/state-key.ts";
import { readSeal, sha256Hex } from "./seed-files.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** One file, decoded: what the stored copy must read back as. Larger than the seed route's, a workspace being larger than an evaluation's notes. */
export const IMPORT_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** All of one import's files together, decoded. */
export const IMPORT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_FILES_MAX = 2000;

export interface ImportedFile { path: string; bytes: number; sha256: string }

/** What an import answers, the first time and on every identical retry. */
export interface ImportRecord {
  migrationId: string;
  importedAt: number;
  fileCount: number;
  bytes: number;
  /** Sorted by path. */
  files: ImportedFile[];
  /** Whether the import carried `instructions`, and whether they have reached the agent yet. */
  instructions: "none" | "pending" | "applied";
}

export const WORKSPACE_IMPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS workspace_import (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, migration_id TEXT NOT NULL, digest TEXT NOT NULL,
  imported_at INTEGER NOT NULL, manifest TEXT NOT NULL, instructions TEXT NOT NULL,
  PRIMARY KEY (tenant_id, agent_id))`;

/**
 * What a retry must repeat to be the same import: its id, its instructions, and each file's path and bytes (by
 * their hash), with the files sorted by path, since paths are unique and their order means nothing. `totalBytes`
 * is not in it: the route refuses one that is not the files' sum, so it can never differ on its own.
 */
export function importDigest(migrationId: string, instructions: string | null, files: readonly ImportedFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ path: f.path, sha256: f.sha256 }));
  return sha256Hex(canonJson({ migrationId, instructions, files: sorted }));
}

function rowsIfAny(sql: Sql, query: string, ...b: unknown[]): any[] {
  try { return sql.exec(query, ...b).toArray(); }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message ?? e))) return []; throw e; }
}

/** The agent's import and its digest, or null. A read: makes no table. */
export function readImport(sql: Sql, tenantId: string, agentId: string): { record: ImportRecord; digest: string } | null {
  const r = rowsIfAny(sql, "SELECT migration_id, digest, imported_at, manifest, instructions FROM workspace_import WHERE tenant_id=? AND agent_id=?",
    tenantId, agentId)[0];
  if (!r) return null;
  const files = JSON.parse(String(r.manifest)) as ImportedFile[];
  return {
    digest: String(r.digest),
    record: {
      migrationId: String(r.migration_id), importedAt: Number(r.imported_at), fileCount: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0), files, instructions: String(r.instructions) as ImportRecord["instructions"],
    },
  };
}

/**
 * Why the agent has started, or null. First the mark every turn writes before it runs (`markStarted`, cf/src/runtime.ts
 * `postMessage`), whatever the route and the engine: the seal's `first-turn` could not be it, being written once, and
 * for an agent whose first input was a push it is `first-inbound`, written when the push was accepted; nor could the
 * main conversation's rows, which pd keeps outside `pi_entries`. Then what an agent that ran before the mark existed
 * left: a message in its main conversation or a fresh context (`priorActivity`'s first two), the `first-turn` seal, a
 * push delivered (posted, so a turn started). A push that is accepted and still queued is not a start: an agent held
 * for its import (`awaitImport`) takes pushes and runs none of them until the import.
 */
export function agentStarted(sql: Sql, tenantId: string, agentId: string): string | null {
  if (rowsIfAny(sql, "SELECT 1 FROM agent_started WHERE tenant_id=? AND agent_id=?", tenantId, agentId).length) return "it has started a turn";
  if (rowsIfAny(sql, "SELECT 1 FROM pi_entries WHERE type = 'message' LIMIT 1").length) return "its main conversation has messages";
  if (rowsIfAny(sql, "SELECT 1 FROM main_sessions WHERE ended_at IS NOT NULL LIMIT 1").length) return "it has had a fresh context";
  if (readSeal(sql, tenantId, agentId)?.how === "first-turn") return "it has started a turn";
  if (rowsIfAny(sql, "SELECT 1 FROM inbound_events WHERE outcome = 'delivered' LIMIT 1").length) return "a push was posted to it";
  return null;
}

const STARTED_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_started (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (tenant_id, agent_id))`;

/**
 * A turn is starting: the first one's time is kept, every later one changes nothing. Written synchronously in the
 * same step as the hold's check (cf/src/runtime.ts `postMessage`), so an import, decided in one transaction, sees
 * either no mark and no turn yet, or the mark.
 */
export function markStarted(sql: Sql, tenantId: string, agentId: string, now: number): void {
  sql.exec(STARTED_SCHEMA);
  sql.exec("INSERT OR IGNORE INTO agent_started(tenant_id, agent_id, at) VALUES (?,?,?)", tenantId, agentId, now);
}

// ---- the hold: an agent made to wait for its import (`awaitImport` on POST /provision/agents).

/**
 * How long an agent waits for its import before it runs without one. A migration imports within minutes of the
 * create; past this the hold lifts on its own, so no agent is held for ever by an import that never came.
 */
export const IMPORT_HOLD_MAX_MS = 24 * 60 * 60_000;

const HOLD_SCHEMA = `CREATE TABLE IF NOT EXISTS import_hold (
  tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, since INTEGER NOT NULL, lifted_at INTEGER, how TEXT,
  PRIMARY KEY (tenant_id, agent_id))`;

export interface ImportHold { since: number; liftedAt: number | null; how: "import" | "valve" | null }

/** The agent's hold, lifted or not, or null for an agent never held. A read: makes no table. */
export function readHold(sql: Sql, tenantId: string, agentId: string): ImportHold | null {
  const r = rowsIfAny(sql, "SELECT since, lifted_at, how FROM import_hold WHERE tenant_id=? AND agent_id=?", tenantId, agentId)[0];
  return r ? { since: Number(r.since), liftedAt: r.lifted_at === null ? null : Number(r.lifted_at), how: r.how === null ? null : String(r.how) as ImportHold["how"] } : null;
}

/**
 * Hold the agent until its import: once per agent, so a create's replay never holds it again after the import, or
 * the valve, lifted it. Never for an agent already imported or started.
 */
export function placeHold(sql: Sql, tenantId: string, agentId: string, now: number): boolean {
  if (readImport(sql, tenantId, agentId) || agentStarted(sql, tenantId, agentId) || readHold(sql, tenantId, agentId)) return false;
  sql.exec(HOLD_SCHEMA);
  sql.exec("INSERT INTO import_hold(tenant_id, agent_id, since) VALUES (?,?,?)", tenantId, agentId, now);
  return true;
}

/** Lift a hold still in place; false when there is none (never held, or lifted already). */
export function liftHold(sql: Sql, tenantId: string, agentId: string, how: "import" | "valve", now: number): ImportHold | null {
  const h = readHold(sql, tenantId, agentId);
  if (!h || h.liftedAt !== null) return null;
  sql.exec("UPDATE import_hold SET lifted_at=?, how=? WHERE tenant_id=? AND agent_id=? AND lifted_at IS NULL", now, how, tenantId, agentId);
  return { since: h.since, liftedAt: now, how };
}

/** Seeded paths (preview's evaluation setup): each is a snapshot and a working copy that must stay a pair. */
export function seededPaths(sql: Sql, tenantId: string, agentId: string): Set<string> {
  return new Set(rowsIfAny(sql, "SELECT path FROM seed_files WHERE tenant_id=? AND agent_id=?", tenantId, agentId).map((r) => String(r.path)));
}

/** Whether a text stays in its row as a state value: the plugin's own measure, the length of its JSON. */
export const importInline = (text: string) => JSON.stringify(text).length <= STATE_INLINE_MAX;

/** Where a spilled file of this attempt goes: under the agent's scope, named by the attempt, never by the path. */
export const spillKey = (tenantId: string, agentId: string, attempt: string, sha256: string) =>
  `t/${tenantId}/${agentId}/import/${attempt}/${sha256}.json`;

/** One file's row, decided before the transaction: its value's JSON inline, or the reference to it. */
export interface ImportRow { path: string; value: string | null; ref: string | null; bytes: number }

export type CommitResult =
  | { ok: true; created: boolean; record: ImportRecord; lifted?: ImportHold | null }
  | { ok: false; code: "already_imported" | "agent_active" | "reserved"; message: string };

/**
 * What the agent's object answers without writing: an identical import made already (`created` false), or the
 * refusal of this one — another import made already, an agent that has started, a path an evaluation seeded. Null:
 * write it. Asked before the upload, as a guess that saves one, and again inside the transaction, where it decides.
 */
export function importDecided(sql: Sql, tenantId: string, agentId: string, digest: string, paths: readonly string[]): CommitResult | null {
  const had = readImport(sql, tenantId, agentId);
  if (had) {
    if (had.digest === digest) return { ok: true, created: false, record: had.record };
    return { ok: false, code: "already_imported",
      message: `this agent's workspace was imported already (migrationId ${had.record.migrationId}, ${new Date(had.record.importedAt).toISOString()}); an import happens once` };
  }
  const started = agentStarted(sql, tenantId, agentId);
  if (started) return { ok: false, code: "agent_active", message: `the agent has already run (${started}); an import never overwrites a live agent's workspace` };
  const seeded = seededPaths(sql, tenantId, agentId);
  const clash = paths.find((p) => seeded.has(p));
  if (clash) return { ok: false, code: "reserved", message: `${clash} is a file the evaluation setup seeded; import under another path` };
  return null;
}

/**
 * The import, decided (`importDecided`) and written inside the caller's transaction: every row and the import's
 * own row, or nothing: a statement that throws part-way rolls them all back with the transaction
 * (test/workspace-import.ts makes one throw).
 */
export function commitImport(
  sql: Sql, tenantId: string, agentId: string,
  imp: { migrationId: string; digest: string; files: ImportedFile[]; rows: ImportRow[]; instructions: boolean },
  now: number,
): CommitResult {
  const decided = importDecided(sql, tenantId, agentId, imp.digest, imp.rows.map((r) => r.path));
  if (decided) return decided;
  sql.exec(WORKSPACE_IMPORT_SCHEMA);
  for (const r of imp.rows) {
    // The statement both stores' `putState` and a seeded working copy run, so the row reads back like any other.
    sql.exec(
      `INSERT INTO agent_state(tenant_id, agent_id, key, value, ref, bytes, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, agent_id, key) DO UPDATE SET value=excluded.value, ref=excluded.ref, bytes=excluded.bytes,
         updated_at=excluded.updated_at`,
      tenantId, agentId, r.path, r.value, r.ref, r.bytes, now);
  }
  const files = [...imp.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const instructions = imp.instructions ? "pending" : "none";
  sql.exec("INSERT INTO workspace_import(tenant_id, agent_id, migration_id, digest, imported_at, manifest, instructions) VALUES (?,?,?,?,?,?,?)",
    tenantId, agentId, imp.migrationId, imp.digest, now, JSON.stringify(files), instructions);
  // Without instructions the import is whole here, and the agent may run. With them it waits until they are applied
  // (`markInstructionsApplied`), so its first turn is never built on the persona it had before the import.
  const lifted = imp.instructions ? null : liftHold(sql, tenantId, agentId, "import", now);
  return { ok: true, created: true, lifted, record: { migrationId: imp.migrationId, importedAt: now, fileCount: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0), files, instructions } };
}

/** The instructions have reached the agent: a retry no longer applies them, and a hold waiting for them lifts. */
export function markInstructionsApplied(sql: Sql, tenantId: string, agentId: string, migrationId: string, now: number): ImportHold | null {
  sql.exec("UPDATE workspace_import SET instructions='applied' WHERE tenant_id=? AND agent_id=? AND migration_id=? AND instructions='pending'",
    tenantId, agentId, migrationId);
  const r = readImport(sql, tenantId, agentId);
  return r && r.record.migrationId === migrationId && r.record.instructions === "applied" ? liftHold(sql, tenantId, agentId, "import", now) : null;
}
