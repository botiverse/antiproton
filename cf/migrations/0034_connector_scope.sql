-- What a connector's authorization covers, as far as GitHub and the connect flow said it (GET …/connections/github,
-- `scopes` and `requestedScopes`; docs/agent-surface.md). Additive, no backfill: NULL on a connector made before this
-- migration reads as "not recorded", never as "no scopes".
--
-- granted_scope: the `scope` value of GitHub's token response, verbatim (comma-separated OAuth scopes). Written at the
--   connect and at a reconnect in place (replaced by the new grant), and at a renewal only when the renewal's answer
--   carries a non-empty `scope`: an answer without one leaves what the connector holds. NULL also when the answer
--   that made the connector carried no `scope` key at all. An empty string is GitHub naming no OAuth scope.
-- requested_scope: the scopes the connect flow asked GitHub for (cf/src/provision/connect.ts `scopesFor`),
--   space-separated as sent in the authorize URL. What was asked, not what was granted.
ALTER TABLE connectors ADD COLUMN granted_scope TEXT;
ALTER TABLE connectors ADD COLUMN requested_scope TEXT;
