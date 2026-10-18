-- GitHub user tokens from an App with expiring tokens live 8 hours, and come with a refresh token that
-- lives about 6 months and is single-use: refreshing spends it and the old access token together (#935).
-- A connector shared by several agents is therefore refreshed in one place, here: the refresh token is
-- sealed with SECRET_KEK like the access token beside it, and every agent's mount copies the result.
-- All columns are null for a token that does not expire, which is refreshed by nothing.
ALTER TABLE connectors ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE connectors ADD COLUMN refresh_iv TEXT;
ALTER TABLE connectors ADD COLUMN expires_at INTEGER;          -- the access token's expiry, ms since the epoch
ALTER TABLE connectors ADD COLUMN refresh_expires_at INTEGER;  -- the refresh token's
ALTER TABLE connectors ADD COLUMN refreshed_at INTEGER;        -- when the pair was last rotated
-- A refresh in progress: whoever set it may trade the refresh token until then, and nobody else may.
-- A lease rather than a flag, so a holder that died mid-refresh blocks nobody past its expiry.
ALTER TABLE connectors ADD COLUMN refreshing_until INTEGER;
-- GitHub refused the refresh, or the renewed token: only the person reconnecting can mend it. Cleared by
-- a reconnect, which makes a new connector, and by a rotation.
ALTER TABLE connectors ADD COLUMN broken_at INTEGER;
ALTER TABLE connectors ADD COLUMN broken_reason TEXT;
-- When the connection was last checked, whatever came of it: the connect, a pointing at an agent, a renewal,
-- and a refused one all set it. What Raft shows as `lastCheckedAt`.
ALTER TABLE connectors ADD COLUMN last_checked_at INTEGER;

-- The same state for an agent's connection that has no connector (made before 0012). Cleared when the
-- row is written again, which a reconnect does.
ALTER TABLE provisioned_connections ADD COLUMN broken_at INTEGER;
ALTER TABLE provisioned_connections ADD COLUMN broken_reason TEXT;

-- Why, for an event the deployment records itself (`broken`): GitHub's error code and description,
-- never a token.
ALTER TABLE connector_events ADD COLUMN reason TEXT;
