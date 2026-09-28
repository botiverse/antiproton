-- A provisioned agent remembers the hash of the credential it was made with:
-- POST idempotency compared every field but the credential, so a delayed POST retry carrying an old
-- credential would re-attach it over a newer PUT /credential and re-register push with a revoked one.
-- NULL on rows made before this column existed; filled on their next replay or credential change.
ALTER TABLE provisioned_agents ADD COLUMN credential_hash TEXT;
