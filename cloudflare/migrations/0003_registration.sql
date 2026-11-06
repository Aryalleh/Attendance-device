-- Self-registration: a company signs up on /register and waits for a server owner to approve it.
-- Existing companies stay approved with no limits.
ALTER TABLE orgs ADD COLUMN approved    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orgs ADD COLUMN email       TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN phone       TEXT NOT NULL DEFAULT '';
ALTER TABLE orgs ADD COLUMN max_users   INTEGER;   -- NULL = unlimited
ALTER TABLE orgs ADD COLUMN max_devices INTEGER;   -- NULL = unlimited

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '3');
