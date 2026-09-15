/**
 * The control plane: who may sign in, and as which (tenant, agent) (task #18, tygg 2026-09-15).
 *
 * This was a table inside one agent object, addressed as tenant "demo", agent "identities": a
 * central directory dressed as a business object. It is one table, consulted at sign-in, and now
 * it is what it is: a D1 database per deployment, with real SQL behind the admin route, so rows
 * can be listed, counted per tenant and changed without going through an agent.
 *
 * The line this file keeps: control-plane data only. Who may enter and which tenant they belong
 * to, and later the tenant list, quota ceilings and operator switches. What an agent owns (its
 * transcript, secrets, events, mounts) stays in that agent's own object and never moves here.
 *
 * What that costs, accepted on purpose:
 * - D1 has one primary. This buys operability, not decentralisation.
 * - D1 unavailable means new sign-ins are refused ("unavailable"). A person already signed in is
 *   not affected: their tenant and agent are sealed into the session cookie at sign-in, and no
 *   request after that reads this table.
 * - A row exists before its object does, and that is the normal state rather than a gap. An
 *   object is created on first use and records its (tenant, agent) then (AgentDO #claim), so
 *   sign-in builds nothing and has nothing to undo if the first request never comes.
 *
 * Schema: cf/migrations/0001_identities.sql, applied by cf/scripts/deploy.sh before the Worker
 * ships. Depends on: that file. A column changed there is changed in the queries below.
 */

/** What sign-in needs from a row. */
export interface Invitation {
  agentId: string;
  tenantId: string;
}

export interface IdentityRow extends Invitation {
  key: string;
  addedBy: string;
  createdAt: number;
}

export interface ImportReport {
  read: number;
  inserted: number;
  /** Rows D1 already had from open sign-up, replaced by the object's row. */
  replacedSelf: number;
  /** Rows the operator had already written to D1, left as they were. */
  kept: number;
}

export interface IdentityDirectory {
  lookup(key: string): Promise<Invitation | null>;
  /** The operator's write: the row becomes this, whatever it was. Keeps the first created_at. */
  upsert(key: string, row: Invitation, by: string): Promise<void>;
  /** Open sign-up's write: only when the key has no row. Returns whichever row holds afterwards. */
  register(key: string, row: Invitation, by: string): Promise<Invitation>;
  remove(key: string): Promise<void>;
  list(): Promise<IdentityRow[]>;
  /**
   * Copies the rows the object kept (task #18 cutover). An object row replaces a D1 row only when
   * that row came from open sign-up: in the moments between the deploy and the import, sign-up
   * can write a derived row for someone whose invitation still sits in the object, and the
   * object's row is the one the operator meant. A row the operator wrote to D1 is newer intent.
   * Remove with /admin/identity/import once production has imported.
   */
  importRows(rows: IdentityRow[]): Promise<ImportReport>;
}

const COLUMNS = "provider_key, agent_id, tenant_id, added_by, created_at";

export function d1Identities(db: D1Database): IdentityDirectory {
  const invitation = (r: any): Invitation => ({ agentId: String(r.agent_id), tenantId: String(r.tenant_id) });
  return {
    async lookup(key) {
      const r = await db.prepare("SELECT agent_id, tenant_id FROM identities WHERE provider_key = ?").bind(key).first();
      return r ? invitation(r) : null;
    },
    async upsert(key, row, by) {
      await db.prepare(
        `INSERT INTO identities(${COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_key) DO UPDATE SET agent_id = excluded.agent_id, tenant_id = excluded.tenant_id, added_by = excluded.added_by`,
      ).bind(key, row.agentId, row.tenantId, by, Date.now()).run();
    },
    async register(key, row, by) {
      // One batch is one transaction: the row read back is the one this write left or lost to.
      const [, read] = await db.batch([
        db.prepare(`INSERT INTO identities(${COLUMNS}) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO NOTHING`)
          .bind(key, row.agentId, row.tenantId, by, Date.now()),
        db.prepare("SELECT agent_id, tenant_id FROM identities WHERE provider_key = ?").bind(key),
      ]);
      const held = (read.results as any[])[0];
      if (!held) throw new Error(`identities: ${key} has no row right after registering it`);
      return invitation(held);
    },
    async remove(key) {
      await db.prepare("DELETE FROM identities WHERE provider_key = ?").bind(key).run();
    },
    async list() {
      const { results } = await db.prepare(`SELECT ${COLUMNS} FROM identities ORDER BY created_at, provider_key`).all();
      return (results as any[]).map((r) => ({
        key: String(r.provider_key), ...invitation(r), addedBy: String(r.added_by), createdAt: Number(r.created_at),
      }));
    },
    async importRows(rows) {
      const { results } = await db.prepare("SELECT provider_key, added_by FROM identities").all();
      const had = new Map((results as any[]).map((r) => [String(r.provider_key), String(r.added_by)]));
      const report: ImportReport = { read: rows.length, inserted: 0, replacedSelf: 0, kept: 0 };
      for (const r of rows) {
        const by = had.get(r.key);
        if (by === undefined) report.inserted++;
        else if (by === "self") report.replacedSelf++;
        else report.kept++;
      }
      if (rows.length === 0) return report;
      // The rule is in the statement, not in the counting above: the counts describe the batch,
      // the WHERE decides it.
      await db.batch(rows.map((r) => db.prepare(
        `INSERT INTO identities(${COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_key) DO UPDATE SET agent_id = excluded.agent_id, tenant_id = excluded.tenant_id,
           added_by = excluded.added_by, created_at = excluded.created_at
         WHERE identities.added_by = 'self'`,
      ).bind(r.key, r.agentId, r.tenantId, r.addedBy, r.createdAt)));
      return report;
    },
  };
}

export type Admission =
  | { ok: true; row: Invitation; registered: boolean }
  | { ok: false; reason: "not-invited" | "unavailable"; error?: string };

/**
 * The sign-in decision. Never throws: a directory that cannot answer is a refusal the person sees
 * ("unavailable"), not a 500, and no session is issued on a row that was not read.
 */
export async function admit(
  dir: IdentityDirectory,
  key: string,
  o: { openSignup: boolean; derive: () => Invitation },
): Promise<Admission> {
  try {
    const row = await dir.lookup(key);
    if (row) return { ok: true, row, registered: false };
    if (!o.openSignup) return { ok: false, reason: "not-invited" };
    const fresh = o.derive();
    // An operator row written since the lookup wins; sign-up never overwrites one.
    const held = await dir.register(key, fresh, "self");
    return { ok: true, row: held, registered: held.agentId === fresh.agentId && held.tenantId === fresh.tenantId };
  } catch (e) {
    return { ok: false, reason: "unavailable", error: String((e as Error)?.message ?? e) };
  }
}
