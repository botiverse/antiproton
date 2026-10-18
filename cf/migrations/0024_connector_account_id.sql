-- Which GitHub account a connector acts as, by GitHub's numeric user id: a login can be renamed, and a reconnect in
-- place (connections/github/confirm with a connector bound into the link) must refuse any other account, or every agent
-- on the connector would silently start acting as someone else. Null on a connector made before this column, and when
-- GitHub's `GET /user` did not answer at the connect; a reconnect then compares the login (`account`) instead, and
-- stores the id it learns.
ALTER TABLE connectors ADD COLUMN account_id TEXT;
