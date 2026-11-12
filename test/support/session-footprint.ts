/**
 * Where a session is still stored in an agent's SQLite: every table, every column (from `PRAGMA table_info`, so a
 * column added later by ALTER TABLE is seen), every row whose value is text or a blob by `typeof` (sqlite's typing is
 * dynamic, so the declared type is not trusted). The scan finds data stored BY session, job or turn key; it cannot find
 * content that left the session by value (e.g. `plugin_answers.body`, keyed by alias and seq), which is covered only by
 * the retention list in the PR description.
 *
 * Two probe strengths:
 *   - `ids` (the session's id, its job ids): a hit is a value holding one as a whole token, the character before and
 *     after it not `[A-Za-z0-9_-]` (or the start/end).
 *   - `exact` (the turn key: chosen by the plugin, and short): a hit is a value equal to it, whole. A value that only
 *     contains it goes to `partial`, not `hits`.
 * A token match on an id that could match by chance (shorter than 8 characters, or with no letter in it) goes to
 * `suspicious`, not `hits`. A table that could not be scanned (a virtual table, or any error) is listed in `unscanned`,
 * so "no hits" can be told from "not scanned". `limit` caps the rows read per (table, column); unlimited by default.
 *
 * `instr()` narrows the rows in SQL; the token and equality rules are applied here.
 */
type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

export interface FootprintHit { table: string; column: string; rows: number; sample: string }
export interface Footprint {
  hits: FootprintHit[];
  partial: FootprintHit[];
  suspicious: FootprintHit[];
  unscanned: Array<{ table: string; reason: string }>;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const WORD = /[A-Za-z0-9_-]/;
const chancy = (id: string) => id.length < 8 || !/[A-Za-z]/.test(id);

function holdsToken(value: string, id: string): boolean {
  for (let at = value.indexOf(id); at >= 0; at = value.indexOf(id, at + 1)) {
    const before = at > 0 ? value[at - 1]! : "";
    const after = at + id.length < value.length ? value[at + id.length]! : "";
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) return true;
  }
  return false;
}

const text = (v: unknown) => typeof v === "string" ? v
  : v instanceof Uint8Array || v instanceof ArrayBuffer ? Buffer.from(v as Uint8Array).toString("utf8") : String(v);

export function footprint(sql: Sql, probe: { ids: string[]; exact?: string[] }, opts: { limit?: number } = {}): Footprint {
  const ids = probe.ids.filter((s) => typeof s === "string" && s.length > 0);
  const exact = (probe.exact ?? []).filter((s) => typeof s === "string" && s.length > 0);
  const all = [...ids, ...exact];
  const out: Footprint = { hits: [], partial: [], suspicious: [], unscanned: [] };
  if (!all.length) return out;
  const limit = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "";
  const tables = sql.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray()
    .map((r) => ({ name: String(r.name), ddl: String(r.sql ?? "") }));
  for (const { name: table, ddl } of tables) {
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(ddl)) { out.unscanned.push({ table, reason: "virtual table" }); continue; }
    try {
      const columns = sql.exec(`PRAGMA table_info(${quote(table)})`).toArray().map((c) => String(c.name));
      if (!columns.length) { out.unscanned.push({ table, reason: "no columns from PRAGMA table_info" }); continue; }
      const found: Footprint = { hits: [], partial: [], suspicious: [], unscanned: [] };
      for (const column of columns) {
        const c = quote(column);
        const pre = all.map(() => `instr(CAST(${c} AS TEXT), ?) > 0`).join(" OR ");
        const values = sql.exec(`SELECT ${c} AS v FROM ${quote(table)} WHERE typeof(${c}) IN ('text', 'blob') AND (${pre})${limit}`, ...all)
          .toArray().map((r) => text(r.v));
        const sorted = { hits: [] as string[], partial: [] as string[], suspicious: [] as string[] };
        for (const v of values) {
          const tokens = ids.filter((id) => holdsToken(v, id));
          if (exact.some((k) => v === k) || tokens.some((id) => !chancy(id))) sorted.hits.push(v);
          else if (tokens.length) sorted.suspicious.push(v);
          else if (exact.some((k) => v.includes(k))) sorted.partial.push(v);
        }
        for (const kind of ["hits", "partial", "suspicious"] as const) {
          const vs = sorted[kind];
          if (vs.length) found[kind].push({ table, column, rows: vs.length, sample: vs[0]!.slice(0, 120) });
        }
      }
      out.hits.push(...found.hits); out.partial.push(...found.partial); out.suspicious.push(...found.suspicious);
    } catch (e) {
      out.unscanned.push({ table, reason: `${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e).slice(0, 120)}` });
    }
  }
  return out;
}
