-- Companies (orgs), per-company users/cards/devices/events, and classes.
-- The same file runs on the Flask server (SQLite) and on Cloudflare D1 (cloudflare/migrations/).
-- Existing data moves into company #1; existing logins become server owners (org_id NULL).
--
-- Tables are rebuilt in an order that never deletes a row referenced by a foreign key,
-- so it is safe with foreign_keys = ON (D1 cannot turn them off).

CREATE TABLE orgs (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
INSERT INTO orgs(id, name, enabled, created_at) VALUES (1, 'سازمان پیش‌فرض', 1, CAST(strftime('%s','now') AS INTEGER));

-- users: NULL org_id = server owner (sees the admin pages and can open any company)
ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE;

-- cards: the UID is unique per company, not globally
CREATE TABLE cards_new (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    uid         TEXT NOT NULL,
    name        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    valid_until TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE (org_id, uid)
);
INSERT INTO cards_new(id, org_id, uid, name, note, enabled, valid_until, created_at)
    SELECT id, 1, uid, name, note, enabled, valid_until, created_at FROM cards;

-- devices: names are unique per company; keys stay globally unique
CREATE TABLE devices_new (
    id           INTEGER PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key          TEXT NOT NULL UNIQUE,
    direction    TEXT NOT NULL DEFAULT 'toggle',
    open_ms      INTEGER NOT NULL DEFAULT 3000,
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_seen    INTEGER,
    last_ip      TEXT,
    fw           TEXT,
    pending_open INTEGER NOT NULL DEFAULT 0,
    UNIQUE (org_id, name)
);
INSERT INTO devices_new(id, org_id, name, key, direction, open_ms, enabled, last_seen, last_ip, fw, pending_open)
    SELECT id, 1, name, key, direction, open_ms, enabled, last_seen, last_ip, fw, pending_open FROM devices;

-- classes
CREATE TABLE classes (
    id         INTEGER PRIMARY KEY,
    org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (org_id, name)
);
CREATE TABLE class_members (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    card_id  INTEGER NOT NULL REFERENCES cards_new(id) ON DELETE CASCADE,
    PRIMARY KEY (class_id, card_id)
);
-- A slot links a class to a device at a time: weekly (weekday 0=Mon..6=Sun, optional
-- from/to dates) or once (on_date). Times are minutes after local midnight.
CREATE TABLE class_slots (
    id        INTEGER PRIMARY KEY,
    class_id  INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    device_id INTEGER NOT NULL REFERENCES devices_new(id) ON DELETE CASCADE,
    weekday   INTEGER,
    on_date   TEXT,
    start_min INTEGER NOT NULL,
    end_min   INTEGER NOT NULL,
    from_date TEXT,
    to_date   TEXT
);
CREATE INDEX idx_slots_device ON class_slots(device_id);

-- events: + company, + class session (slot + local date) the scan belonged to
CREATE TABLE events_new (
    id           INTEGER PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    ts           INTEGER NOT NULL,
    device_id    INTEGER REFERENCES devices_new(id) ON DELETE SET NULL,
    uid          TEXT NOT NULL,
    card_id      INTEGER REFERENCES cards_new(id) ON DELETE SET NULL,
    name         TEXT NOT NULL DEFAULT '',
    result       TEXT NOT NULL,           -- granted | unknown | disabled | expired | denied | manual | not_member
    direction    TEXT NOT NULL DEFAULT '',
    offline      INTEGER NOT NULL DEFAULT 0,
    class_id     INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    slot_id      INTEGER REFERENCES class_slots(id) ON DELETE SET NULL,
    session_date TEXT
);
INSERT INTO events_new(id, org_id, ts, device_id, uid, card_id, name, result, direction, offline)
    SELECT id, 1, ts, device_id, uid, card_id, name, result, direction, offline FROM events;

-- swap: old events first (nothing references it), then the tables it referenced
DROP TABLE events;
DROP TABLE cards;
DROP TABLE devices;
ALTER TABLE cards_new RENAME TO cards;
ALTER TABLE devices_new RENAME TO devices;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_org_ts ON events(org_id, ts);
CREATE INDEX idx_events_card   ON events(card_id, ts);
CREATE INDEX idx_events_class  ON events(class_id, session_date);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '2');
