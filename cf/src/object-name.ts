/**
 * One Durable Object per (tenant, agent).
 *
 * §12.1 rule 1 asks for isolation that is structural rather than a predicate.
 * Sharing one object put every tenant's rows in one SQLite database, so the
 * only thing standing between two customers was a WHERE clause being correct
 * everywhere, forever. Addressing by identity means the other tenant's data is
 * not in the database being queried at all.
 *
 * The separator is not a legal character in either id (both are validated on
 * the way in), so no two distinct pairs can collide on one name.
 */
export function agentObjectName(tenantId: string, agentId: string): string {
  for (const [label, v] of [["tenant", tenantId], ["agent", agentId]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) {
      throw new Error(`invalid ${label} id: ${JSON.stringify(v).slice(0, 60)}`);
    }
  }
  return `a/${tenantId}/${agentId}`;
}
