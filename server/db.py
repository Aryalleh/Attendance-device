"""SQLite storage for the access-control server."""
import os
import re
import sqlite3
import time
from datetime import date, datetime, timedelta

from flask import current_app, g

# Version 1 schema (single company). Newer versions are applied from migrations/*.sql,
# the same files the Cloudflare version runs on D1.
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


MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")
MIGRATIONS = [(2, "0002_multitenant.sql"), (3, "0003_plans_enroll.sql")]


def init_db(path):
    con = connect(path)
    has_meta = con.execute("SELECT 1 FROM sqlite_master WHERE name = 'meta'").fetchone()
    version = con.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone() if has_meta else None
    version = int(version[0]) if version else 1
    if version == 1:
        con.executescript(SCHEMA)
        con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('cards_rev', '1')")
        con.commit()
    for v, name in MIGRATIONS:
        if version < v:
            with open(os.path.join(MIGRATIONS_DIR, name), encoding="utf-8") as f:
                con.executescript("BEGIN;\n" + f.read() + "\nCOMMIT;")
            version = v
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

def add_event(db, *, org_id, ts, device_id, uid, card, result, direction="", offline=False,
              class_id=None, slot_id=None, session_date=None):
    db.execute(
        "INSERT INTO events(org_id, ts, device_id, uid, card_id, name, result, direction, offline, "
        "class_id, slot_id, session_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (org_id, ts, device_id, uid, card["id"] if card else None, card["name"] if card else "",
         result, direction or "", 1 if offline else 0, class_id, slot_id, session_date),
    )


# --- classes -----------------------------------------------------------------
# A class slot links a class to a device: weekly (weekday 0=Mon..6=Sun between from/to
# dates) or once (on_date). Scans on that device inside the slot window count for the
# class; the window opens EARLY_MIN before the start and stays open LATE_MIN after the
# end so early arrivals and late exits are still recorded. Only time inside start..end
# counts towards attendance.

EARLY_MIN = 15
LATE_MIN = 30


def local_ts(day, minutes):
    """Unix time of a local date + minutes after midnight."""
    return int((datetime.combine(day, datetime.min.time()) + timedelta(minutes=minutes)).timestamp())


def slot_on(slot, day):
    """Does this slot have a session on this date?"""
    iso = day.isoformat()
    if slot["on_date"]:
        return slot["on_date"] == iso
    return (slot["weekday"] == day.weekday()
            and (not slot["from_date"] or slot["from_date"] <= iso)
            and (not slot["to_date"] or iso <= slot["to_date"]))


def session_window(slot, day):
    return local_ts(day, slot["start_min"]), local_ts(day, slot["end_min"])


def active_slots(db, device_id, ts):
    """Class sessions open on this device at this time, core window (start..end) first."""
    day = datetime.fromtimestamp(ts).date()
    out = []
    for s in db.execute("SELECT s.*, c.name AS class_name FROM class_slots s JOIN classes c ON c.id = s.class_id "
                        "WHERE s.device_id = ?", (device_id,)).fetchall():
        if not slot_on(s, day):
            continue
        start, end = session_window(s, day)
        if start - EARLY_MIN * 60 <= ts < end + LATE_MIN * 60:
            core = start <= ts < end
            out.append({"slot": s, "class_id": s["class_id"], "slot_id": s["id"], "class_name": s["class_name"],
                        "session_date": day.isoformat(), "core": core, "dist": 0 if core else min(abs(ts - start), abs(ts - end))})
    out.sort(key=lambda x: (not x["core"], x["dist"]))
    return out


def is_member(db, class_id, card_id):
    return db.execute("SELECT 1 FROM class_members WHERE class_id = ? AND card_id = ?",
                      (class_id, card_id)).fetchone() is not None


def decide(db, dev, org_enabled, card, ts):
    """The access decision for one scan. Returns the fields to store with the event."""
    out = {"result": "denied", "direction": "", "class_id": None, "slot_id": None, "session_date": None}
    if not org_enabled or not dev["enabled"]:
        return out
    if dev["enroll"]:
        out["result"] = "enroll"     # card-registration mode: just report the card to the panel
        return out
    if card is None:
        out["result"] = "unknown"
        return out
    valid = card_valid(card)
    if valid != "ok":
        out["result"] = valid
        return out

    sessions = active_slots(db, dev["id"], ts)
    if sessions:
        mine = [x for x in sessions if is_member(db, x["class_id"], card["id"])]
        pick = (mine or sessions)[0]
        out.update(class_id=pick["class_id"], slot_id=pick["slot_id"], session_date=pick["session_date"])
        if not mine:
            out["result"] = "not_member"
            return out
        direction = dev["direction"]
        if direction == "toggle":
            last = db.execute(
                "SELECT direction FROM events WHERE card_id = ? AND slot_id = ? AND session_date = ? "
                "AND result = 'granted' ORDER BY ts DESC, id DESC LIMIT 1",
                (card["id"], pick["slot_id"], pick["session_date"])).fetchone()
            direction = "out" if last and last[0] == "in" else "in"
        out.update(result="granted", direction=direction)
        return out

    direction = dev["direction"]
    if direction == "toggle":
        direction = "out" if last_direction(db, card["id"]) == "in" else "in"
    out.update(result="granted", direction=direction)
    return out


def session_dates(slot, first, last):
    """Dates (inclusive range) on which this slot has a session."""
    if slot["on_date"]:
        d = date.fromisoformat(slot["on_date"])
        return [d] if first <= d <= last else []
    days, d = [], first
    while d <= last:
        if slot_on(slot, d):
            days.append(d)
        d += timedelta(days=1)
    return days


def presence(events, start, end, now_ts):
    """Seconds inside start..end from a card's in/out events (sorted), plus first in / last out.
    An entry without an exit counts until the end of the session (or now, while it runs)."""
    secs, since, first_in, last_out, open_ = 0, None, None, None, False
    clip = lambda a, b: max(0, min(b, end) - max(a, start))
    for e in events:
        if e["direction"] == "in":
            first_in = first_in or e["ts"]
            if since is None:
                since = e["ts"]
        elif e["direction"] == "out":
            last_out = e["ts"]
            if since is not None:
                secs += clip(since, e["ts"])
                since = None
    if since is not None:
        secs += clip(since, min(end, now_ts))
        open_ = True
    return {"secs": secs, "first_in": first_in, "last_out": last_out, "open": open_, "scans": len(events)}


def class_sessions(db, cls, first, last):
    """All sessions of a class between two dates (no later than today), newest first."""
    today = date.today()
    last = min(last, today)
    out = []
    for s in db.execute("SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id "
                        "WHERE s.class_id = ?", (cls["id"],)).fetchall():
        for d in session_dates(s, first, last):
            start, end = session_window(s, d)
            out.append({"slot": s, "date": d, "start": start, "end": end})
    out.sort(key=lambda x: x["start"], reverse=True)
    return out


def session_report(db, cls, slot, day, now_ts):
    """One session: every member (and anyone else who scanned in) with their time in class."""
    start, end = session_window(slot, day)
    members = db.execute("SELECT c.* FROM cards c JOIN class_members m ON m.card_id = c.id "
                         "WHERE m.class_id = ? ORDER BY c.name COLLATE NOCASE", (cls["id"],)).fetchall()
    evs = db.execute("SELECT * FROM events WHERE slot_id = ? AND session_date = ? AND result = 'granted' "
                     "AND card_id IS NOT NULL ORDER BY ts, id", (slot["id"], day.isoformat())).fetchall()
    by_card = {}
    for e in evs:
        by_card.setdefault(e["card_id"], []).append(e)
    rows = []
    for c in members:
        rows.append({"card": c, **presence(by_card.get(c["id"], []), start, end, now_ts)})
    refused = db.execute("SELECT e.*, d.name AS door, k.name AS class_name FROM events e "
                         "LEFT JOIN devices d ON d.id = e.device_id LEFT JOIN classes k ON k.id = e.class_id "
                         "WHERE e.slot_id = ? AND e.session_date = ? AND e.result != 'granted' ORDER BY e.ts",
                         (slot["id"], day.isoformat())).fetchall()
    return {"start": start, "end": end, "rows": rows, "refused": refused}


def class_summary(db, cls, sessions, now_ts):
    """Per member over many sessions: sessions attended and total time."""
    members = db.execute("SELECT c.* FROM cards c JOIN class_members m ON m.card_id = c.id "
                         "WHERE m.class_id = ? ORDER BY c.name COLLATE NOCASE", (cls["id"],)).fetchall()
    tot = {c["id"]: {"card": c, "attended": 0, "secs": 0} for c in members}
    counts = []
    for s in sessions:
        evs = db.execute("SELECT * FROM events WHERE slot_id = ? AND session_date = ? AND result = 'granted' "
                         "AND card_id IS NOT NULL ORDER BY ts, id", (s["slot"]["id"], s["date"].isoformat())).fetchall()
        by_card = {}
        for e in evs:
            by_card.setdefault(e["card_id"], []).append(e)
        present = 0
        for cid, t in tot.items():
            p = presence(by_card.get(cid, []), s["start"], s["end"], now_ts)
            if p["scans"]:
                t["attended"] += 1
                present += 1
            t["secs"] += p["secs"]
        counts.append(present)
    possible = sum(max(0, min(s["end"], now_ts) - s["start"]) for s in sessions)
    for t in tot.values():
        t["pct"] = round(100 * t["secs"] / possible) if possible else 0
    return list(tot.values()), counts


# --- plans and limits --------------------------------------------------------------

PERIODS = {"day": 1, "week": 7, "month": 30, "year": 365}     # days one paid period covers
LIMITS = {"users": "users", "devices": "devices", "cards": "cards", "classes": "classes"}   # limit -> table


def usage(db, org_id):
    return {k: db.execute(f"SELECT COUNT(*) FROM {t} WHERE org_id = ?", (org_id,)).fetchone()[0]
            for k, t in LIMITS.items()}


def over_limit(db, org, what):
    """The company's limit for `what` if it is already used up (so nothing more may be added), else None."""
    cap = org["max_" + what]
    if cap is None:
        return None
    used = db.execute(f"SELECT COUNT(*) FROM {LIMITS[what]} WHERE org_id = ?", (org["id"],)).fetchone()[0]
    return cap if used >= cap else None


def extend_until(paid_until, period, count):
    """New subscription end date after paying `count` periods (counted from today if already expired)."""
    start = max(date.today(), date.fromisoformat(paid_until)) if paid_until else date.today()
    return start + timedelta(days=PERIODS.get(period, 30) * count)
