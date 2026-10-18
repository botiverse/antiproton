/**
 * The operator's read-only check that a string is stored nowhere for one agent (`POST /admin/storage-scan`): every
 * table and row of the agent's Durable Object SQLite, and every R2 object under the agent's own prefixes in the
 * artifacts bucket. For checking a data contract such as RaftBench's (no copy of the source text outlives a run,
 * docs/agent-surface.md), against the deployment rather than a test's fake.
 *
 * What it answers says where, never what: table names and a count of objects, with how much was read. The needle is
 * neither returned nor logged, and no row or object content leaves this file. A match is case-insensitive, in a
 * cell's raw text and in every string a JSON cell decodes to (so an escaped copy is found too). Bounded: past the caps
 * the answer says `truncated`, and a `found: false` then proves nothing about what was not read.
 */
import { tracePrefix } from "./trace-r2.ts";

/**
 * The object's SQL, read through its cursor: the Durable Object's `exec` returns one, iterated row by row, so a table
 * is never held whole in memory and a scan stops at its caps having read no further.
 */
type Sql = { exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> };

/**
 * Per call. The scan runs inside the agent's live object, synchronously for the tables, so the caps are what keep one
 * scan from holding it: a few MB of cells read and a bounded number of rows, well under the object's memory; an R2
 * object larger than `maxObjectBytes` is not read at all, and counted as skipped.
 */
export interface ScanLimits { maxRows: number; maxBytes: number; maxObjects: number; maxObjectBytes: number }
export const SCAN_LIMITS: ScanLimits = { maxRows: 200_000, maxBytes: 8 * 1024 * 1024, maxObjects: 2_000, maxObjectBytes: 16 * 1024 * 1024 };

export interface StorageScan {
  found: boolean;
  tables: string[];
  objects: number;
  scanned: { tables: number; rows: number; objects: number };
  /** R2 objects over the per-object cap, not read. */
  skipped: number;
  truncated: boolean;
}

/** The needle a request may name: words enough to be specific, short enough to be a marker. */
export function needleProblem(needle: unknown): string | null {
  if (typeof needle !== "string") return "needle is a string";
  if (needle.trim().length < 4) return "needle is at least 4 characters";
  if (needle.length > 500) return "needle is at most 500 characters";
  return null;
}

/** Whether `text` holds `needle` (lower-cased), as it stands or in any string it decodes to as JSON. */
function holds(text: string, needle: string): boolean {
  if (text.toLowerCase().includes(needle)) return true;
  const t = text.trimStart();
  if (t[0] !== "{" && t[0] !== "[" && t[0] !== "\"") return false;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return false; }
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") { if (v.toLowerCase().includes(needle) || (v !== text && holds(v, needle))) return true; }
    else if (v && typeof v === "object") stack.push(...Object.values(v as Record<string, unknown>));
  }
  return false;
}

const cellText = (v: unknown): string | null =>
  typeof v === "string" ? v
  : v instanceof ArrayBuffer ? new TextDecoder().decode(new Uint8Array(v))
  : ArrayBuffer.isView(v) ? new TextDecoder().decode(v as Uint8Array)
  : null;

/** Every table of an agent's object, row by row. Reads only. */
export function scanTables(sql: Sql, needle: string, limits: ScanLimits = SCAN_LIMITS): { tables: string[]; scanned: { tables: number; rows: number }; truncated: boolean } {
  const n = needle.toLowerCase();
  const found = new Set<string>();
  let rows = 0, bytes = 0, tables = 0, truncated = false;
  const names = [...sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")].map((r) => String(r.name));
  outer: for (const name of names) {
    tables++;
    for (const row of sql.exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`)) {
      if (rows >= limits.maxRows || bytes >= limits.maxBytes) { truncated = true; break outer; }
      rows++;
      for (const cell of Object.values(row as Record<string, unknown>)) {
        const text = cellText(cell);
        if (text === null) continue;
        bytes += text.length;
        if (!found.has(name) && holds(text, n)) found.add(name);
      }
    }
  }
  return { tables: [...found], scanned: { tables, rows }, truncated };
}

/** The part of an R2 bucket this reads. */
export interface ScanBucket {
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string; size?: number }>; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** The agent's R2 prefixes: its own objects (`t/…`) and its trace export (`trace/…`). */
export function agentPrefixes(tenantId: string, agentId: string): string[] {
  return [`t/${tenantId}/${agentId}/`, tracePrefix(tenantId, agentId)];
}

/** Every object under the agent's prefixes. Reads only; an object over the per-object cap is not read, and says so. */
export async function scanObjects(bucket: ScanBucket, prefixes: string[], needle: string, limits: ScanLimits = SCAN_LIMITS):
  Promise<{ objects: number; scanned: number; skipped: number; truncated: boolean }> {
  const n = needle.toLowerCase();
  let objects = 0, scanned = 0, skipped = 0, bytes = 0, truncated = false;
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
      for (const o of page.objects) {
        if (scanned >= limits.maxObjects) return { objects, scanned, skipped, truncated: true };
        // Not read: an object of unknown size is not trusted to be small.
        if (o.size === undefined || o.size > limits.maxObjectBytes) { skipped++; truncated = true; continue; }
        const body = await bucket.get(o.key);
        if (!body) continue;
        const text = await body.text();
        scanned++;
        bytes += text.length;
        if (holds(text, n)) objects++;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return { objects, scanned, skipped, truncated };
}
