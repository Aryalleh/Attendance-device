-- Schema copied from server/db.py so the Flask server and the Worker stay interchangeable.
CREATE TABLE IF NOT EXISTS cards (
    id          INTEGER PRIMARY KEY,
    uid         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    valid_until TEXT,                       -- 'YYYY-MM-DD' or NULL (no expiry)
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    key          TEXT NOT NULL UNIQUE,
    direction    TEXT NOT NULL DEFAULT 'toggle',   -- in | out | toggle
    open_ms      INTEGER NOT NULL DEFAULT 3000,
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_seen    INTEGER,
    last_ip      TEXT,
    fw           TEXT,
    pending_open INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    uid       TEXT NOT NULL,
    card_id   INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    name      TEXT NOT NULL DEFAULT '',     -- name at the time of the event
    result    TEXT NOT NULL,                -- granted | unknown | disabled | expired | denied | manual
    direction TEXT NOT NULL DEFAULT '',     -- in | out | ''
    offline   INTEGER NOT NULL DEFAULT 0    -- decided by the device while the server was down
);
CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_card ON events(card_id, ts);
CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    pw_hash  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta(key, value) VALUES ('cards_rev', '1');
