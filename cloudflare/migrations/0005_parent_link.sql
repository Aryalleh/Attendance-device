-- Parent link: a private, login-free page per card where parents see when their
-- child arrived and left. NULL = no link. Making a new key revokes the old link.
ALTER TABLE cards ADD COLUMN parent_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_parent_key ON cards(parent_key);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '5');
