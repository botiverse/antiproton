-- A deleted agent's held calls stay in the provider-wide copy as the record of who decided what for it, instead of
-- going with the agent (cf/src/approvals.ts `markAgentDeleted`). `agent_deleted_at` is when its agent was deleted:
-- null on a live agent's row. A marked row is never listed (the list leaves deleted agents out), keeps its ids,
-- status, timestamps and the item's tool and `decidedBy`, and loses the item's argument and outcome summaries, which
-- stay in the agent's own object. Marked rows are dropped AUDIT_RETENTION_MS after the delete; a live agent's ended
-- rows APPROVAL_RETENTION_MS after their last change, as before.
ALTER TABLE provider_approvals ADD COLUMN agent_deleted_at INTEGER;

-- Rows of an agent deleted before this column existed (a delete whose removal of them failed) are marked as of that
-- delete, so they are kept as the record rather than left to neither prune.
UPDATE provider_approvals
   SET agent_deleted_at = (SELECT COALESCE(p.deleted_at, p.updated_at) FROM provisioned_agents p
                            WHERE p.tenant_id = provider_approvals.tenant_id AND p.agent_id = provider_approvals.agent_id),
       item = json_remove(item, '$.args', '$.outcome', '$.route', '$.description')
 WHERE EXISTS (SELECT 1 FROM provisioned_agents p
                WHERE p.tenant_id = provider_approvals.tenant_id AND p.agent_id = provider_approvals.agent_id AND p.status = 'deleted');

-- The two prunes (`d1ApprovalIndex.prune`), each by the column it compares, over only the rows it may drop. The
-- conditions are spelled as the prune spells them: SQLite uses a partial index only when the query implies its WHERE.
CREATE INDEX provider_approvals_ended ON provider_approvals(updated_at)
  WHERE agent_deleted_at IS NULL AND status IN ('denied', 'expired', 'executed', 'failed');
CREATE INDEX provider_approvals_audit ON provider_approvals(agent_deleted_at) WHERE agent_deleted_at IS NOT NULL;
