"""SQLite storage for the access-control server."""
import re
import sqlite3
import time
from datetime import date

from flask import current_app, g

SCHEMA = """
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
"""

_UID_HEX = re.compile(r"[^0-9A-F]")


def normalize_uid(raw):
    """'04 a3 1b 2c' / '04a31b2c' / '04:A3:1B:2C' -> '04:A3:1B:2C' (or '' if invalid)."""
    hexs = _UID_HEX.sub("", (raw or "").upper())
    if not 8 <= len(hexs) <= 20 or len(hexs) % 2:
        return ""
    return ":".join(hexs[i:i + 2] for i in range(0, len(hexs), 2))


def clean_name(s, limit=32):
    s = re.sub(r"[\t\r\n\"\\]", " ", s or "").strip()
    return s[:limit]


def connect(path):
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def init_db(path):
    con = connect(path)
    con.executescript(SCHEMA)
    con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('cards_rev', '1')")
    con.commit()
    return con


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DB_PATH"])
    return g.db


def close_db(_exc=None):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def now():
    return int(time.time())


# --- cards -----------------------------------------------------------------

def bump_cards_rev(db):
    db.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'cards_rev'")


def cards_version(db):
    """Changes whenever the card list changes, and daily (so expiries propagate)."""
    rev = db.execute("SELECT value FROM meta WHERE key = 'cards_rev'").fetchone()[0]
    return f"{rev}-{date.today().isoformat()}"


def card_valid(card, today=None):
    today = today or date.today().isoformat()
    if not card["enabled"]:
        return "disabled"
    if card["valid_until"] and today > card["valid_until"]:
        return "expired"
    return "ok"


LAST_DIR_SQL = """
    (SELECT e.direction FROM events e
      WHERE e.card_id = c.id AND e.result = 'granted' AND e.direction IN ('in', 'out')
      ORDER BY e.ts DESC, e.id DESC LIMIT 1)
"""
LAST_TS_SQL = """
    (SELECT e.ts FROM events e
      WHERE e.card_id = c.id AND e.result = 'granted'
      ORDER BY e.ts DESC, e.id DESC LIMIT 1)
"""


def cards_with_presence(db, where="1", params=()):
    return db.execute(
        f"SELECT c.*, {LAST_DIR_SQL} AS last_dir, {LAST_TS_SQL} AS last_ts "
        f"FROM cards c WHERE {where} ORDER BY c.name COLLATE NOCASE",
        params,
    ).fetchall()


def last_direction(db, card_id):
    row = db.execute(
        "SELECT direction FROM events WHERE card_id = ? AND result = 'granted' "
        "AND direction IN ('in', 'out') ORDER BY ts DESC, id DESC LIMIT 1",
        (card_id,),
    ).fetchone()
    return row[0] if row else None


# --- events ----------------------------------------------------------------

def add_event(db, *, ts, device_id, uid, card, result, direction="", offline=False):
    db.execute(
        "INSERT INTO events(ts, device_id, uid, card_id, name, result, direction, offline) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (ts, device_id, uid, card["id"] if card else None, card["name"] if card else "",
         result, direction or "", 1 if offline else 0),
    )
