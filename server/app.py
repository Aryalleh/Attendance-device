"""RFID access-control server: web panel + API for the Wemos D1 mini readers and the Android app.

Several companies (or teams) share one server. Each has its own users, cards, devices,
logs and classes and cannot see the others. Server owners (users without a company)
create companies and can open any company's panel.

Run:  python app.py                      (http://0.0.0.0:8080)
      python app.py set-password admin   (reset a panel password; creates a server owner)

Environment:
  ACCESSCTL_DATA         data directory (default ./data)
  ACCESSCTL_HOST/PORT    listen address (default 0.0.0.0:8080)
  ACCESSCTL_API_TOKEN    enables the read-only integration API (Bearer token, all companies)
  ACCESSCTL_WEBHOOK_URL  POSTs every access event as JSON to this URL
"""
import csv
import functools
import hashlib
import getpass
import io
import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.request
from datetime import date, datetime, timedelta

from flask import (Flask, Response, abort, current_app, flash, g, jsonify,
                   redirect, render_template, request, session, url_for)
from itsdangerous import BadSignature, URLSafeSerializer
from werkzeug.security import check_password_hash, generate_password_hash

import db as store
import jalali as J
from db import clean_name, get_db, normalize_uid, now

DATA_DIR = os.path.abspath(os.environ.get("ACCESSCTL_DATA", "data"))
ONLINE_WINDOW = 30          # a door counts as online if it synced within this many seconds
PAGE_SIZE = 100

log = logging.getLogger("accessctl")


def create_app():
    os.makedirs(DATA_DIR, exist_ok=True)
    app = Flask(__name__)
    app.config["DB_PATH"] = os.path.join(DATA_DIR, "access.db")
    app.config["API_TOKEN"] = os.environ.get("ACCESSCTL_API_TOKEN", "")
    app.config["WEBHOOK_URL"] = os.environ.get("ACCESSCTL_WEBHOOK_URL", "")
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=7)
    app.secret_key = _load_secret()

    con = store.init_db(app.config["DB_PATH"])
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        pw = os.environ.get("ACCESSCTL_ADMIN_PASSWORD")
        generated = not pw
        pw = pw or secrets.token_urlsafe(9)
        con.execute("INSERT INTO users(username, pw_hash, org_id) VALUES ('admin', ?, NULL)",
                    (generate_password_hash(pw),))
        con.commit()
        if generated:
            print(f"\n*** Panel login (server owner): admin / {pw}  (change it under Settings) ***\n", flush=True)
    con.close()

    app.teardown_appcontext(store.close_db)
    app.jinja_env.filters.update(jdt=fmt_jdt, jdate=fmt_jdate, jtime=fmt_jtime, ago=fmt_ago,
                                 fa=J.fa, jinput=jinput, jlong=J.jlong, jstr=J.jstr, hm=fmt_hm, dur=fmt_dur)
    app.jinja_env.globals.update(csrf_token=csrf_token, RESULT_FA=RESULT_FA, DIR_FA=DIR_FA,
                                 WEEKDAYS_FA=WEEKDAYS_FA, WEEK_ORDER=WEEK_ORDER)
    app.before_request(load_user)
    app.before_request(csrf_protect)
    register_routes(app)
    return app


def _load_secret():
    path = os.path.join(DATA_DIR, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    with open(path) as f:
        return f.read().strip()


# --- helpers ---------------------------------------------------------------

WEEKDAYS_FA = ["دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه", "یکشنبه"]   # index = date.weekday()
WEEK_ORDER = [5, 6, 0, 1, 2, 3, 4]   # Saturday first


def fmt_dt(ts, fmt="%Y-%m-%d %H:%M:%S"):
    """Gregorian, Latin digits (CSV / webhook)."""
    return datetime.fromtimestamp(ts).strftime(fmt) if ts else ""


def fmt_jdate(ts):
    """Unix time -> '۱۴۰۵/۰۸/۱۱'."""
    return J.fa(J.jstr(datetime.fromtimestamp(ts).date())) if ts else "—"


def fmt_jtime(ts, seconds=False):
    return J.fa(datetime.fromtimestamp(ts).strftime("%H:%M:%S" if seconds else "%H:%M")) if ts else "—"


def fmt_jdt(ts):
    return f"{fmt_jdate(ts)} {fmt_jtime(ts, True)}" if ts else "—"


def fmt_hm(minutes):
    """Minutes after midnight -> '۱۰:۳۰'."""
    return J.fa(f"{minutes // 60:02d}:{minutes % 60:02d}")


def fmt_dur(secs):
    """Seconds -> '۱ ساعت و ۲۵ دقیقه'."""
    m = int(secs or 0) // 60
    if m < 60:
        return f"{J.fa(m)} دقیقه"
    return f"{J.fa(m // 60)} ساعت" + (f" و {J.fa(m % 60)} دقیقه" if m % 60 else "")


def parse_hm(s):
    """'10:30' / '۱۰:۳۰' / '9' -> minutes after midnight, or None."""
    s = J.latin((s or "").strip()).replace("٫", ":").replace(".", ":")
    try:
        h, _, m = s.partition(":")
        h, m = int(h), int(m or 0)
    except ValueError:
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def fmt_ago(ts):
    if not ts:
        return "هرگز"
    s = max(0, now() - ts)
    if s < 60:
        return f"{J.fa(s)} ثانیه پیش"
    if s < 3600:
        return f"{J.fa(s // 60)} دقیقه پیش"
    if s < 86400:
        return f"{J.fa(s // 3600)} ساعت پیش"
    return f"{J.fa(s // 86400)} روز پیش"


def jinput(v):
    """Value for a Jalali date input: accepts ISO / Jalali text, returns '1405/08/11' or ''."""
    d = J.parse(v) if v else None
    return J.jstr(d) if d else (v or "")


def day_bounds(day):
    start = datetime.combine(day, datetime.min.time())
    return int(start.timestamp()), int((start + timedelta(days=1)).timestamp())


def parse_day(s, default=None):
    """Jalali ('1405/08/11', Persian digits OK) or Gregorian ('2026-11-02')."""
    return J.parse(s) or default


def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return session["csrf"]


def csrf_protect():
    if request.method == "POST" and not request.path.startswith("/api/"):
        if request.form.get("csrf") != session.get("csrf"):
            abort(400, "نشست منقضی شده است — صفحه را دوباره بارگذاری کنید.")


# --- who is logged in, and which company they are looking at ----------------

def load_user():
    """g.user: the logged-in user; g.owner: server owner; g.org: the company being viewed."""
    g.user = g.org = None
    g.owner = False
    if request.path.startswith(("/api/", "/static/", "/kiosk/", "/parent/")):
        return
    uid = session.get("uid")
    if not uid:
        return
    db = get_db()
    u = db.execute("SELECT u.*, o.enabled AS org_enabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id "
                   "WHERE u.id = ?", (uid,)).fetchone()
    if u is None or (u["org_id"] and not u["org_enabled"]):
        session.clear()
        if u is not None:
            flash("حساب سازمان شما غیرفعال شده است.", "error")
        return
    g.user = u
    g.owner = u["org_id"] is None
    org_id = u["org_id"] or session.get("view_org")
    if org_id:
        g.org = db.execute("SELECT * FROM orgs WHERE id = ?", (org_id,)).fetchone()
        if g.org is None:
            session.pop("view_org", None)


def oid():
    return g.org["id"]


def login_required(view):
    """A company page: needs a login and a company (owners pick one on the admin page)."""
    @functools.wraps(view)
    def wrapped(*a, **kw):
        if not g.user:
            return redirect(url_for("login", next=request.path))
        if g.org is None:
            return redirect(url_for("admin"))
        return view(*a, **kw)
    return wrapped


def owner_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        if not g.user:
            return redirect(url_for("login", next=request.path))
        if not g.owner:
            abort(403)
        return view(*a, **kw)
    return wrapped


def own_row(table, row_id):
    """A row of the current company, or 404 (ids from another company are never served)."""
    row = get_db().execute(f"SELECT * FROM {table} WHERE id = ? AND org_id = ?", (row_id, oid())).fetchone()
    if row is None:
        abort(404)
    return row


# --- live screen helpers ---------------------------------------------------

def _kiosk_serializer():
    return URLSafeSerializer(current_app.secret_key, salt="kiosk")


def _key_tag(dev):
    return hashlib.sha256(dev["key"].encode()).hexdigest()[:12]


def kiosk_token(dev):
    """Login-free link to one door's live screen. Changing the door key revokes it."""
    return _kiosk_serializer().dumps({"d": dev["id"], "k": _key_tag(dev)})


def kiosk_door(token):
    try:
        data = _kiosk_serializer().loads(token)
    except BadSignature:
        abort(404)
    dev = get_db().execute("SELECT * FROM devices WHERE id = ?", (data.get("d"),)).fetchone()
    if dev is None or data.get("k") != _key_tag(dev):
        abort(404)
    return dev


def live_events(org_id, door_id):
    """New scans for the live screen. ?init=1 -> the latest few; ?after=<id> -> newer ones."""
    db = get_db()
    where, params = "e.offline = 0 AND e.org_id = ?", [org_id]
    if door_id:
        where += " AND e.device_id = ?"
        params.append(door_id)
    if request.args.get("init"):
        rows = db.execute(EVENT_SELECT + f"WHERE {where} ORDER BY e.id DESC LIMIT 8", params).fetchall()[::-1]
    else:
        rows = db.execute(EVENT_SELECT + f"WHERE {where} AND e.id > ? ORDER BY e.id LIMIT 20",
                          params + [request.args.get("after", 0, type=int)]).fetchall()
    cutoff = now() - ONLINE_WINDOW
    doors = db.execute("SELECT id, name, last_seen FROM devices WHERE org_id = ? ORDER BY name", (org_id,)).fetchall()
    return jsonify(
        events=[{"id": r["id"], "name": r["name"], "uid": r["uid"], "result": r["result"],
                 "direction": r["direction"], "door": r["door"] or "", "class": r["class_name"] or "",
                 "time": fmt_jtime(r["ts"], True), "date": fmt_jdate(r["ts"])} for r in rows],
        doors=[{"id": d["id"], "name": d["name"],
                "online": bool(d["last_seen"] and d["last_seen"] >= cutoff)}
               for d in doors if not door_id or d["id"] == door_id])


def device_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        key = request.headers.get("X-Device-Key", "")
        dev = get_db().execute("SELECT d.*, o.enabled AS org_enabled, o.name AS org_name FROM devices d "
                               "JOIN orgs o ON o.id = d.org_id WHERE d.key = ?", (key,)).fetchone() if key else None
        if dev is None:
            return jsonify(error="unknown device key"), 401
        g.device = dev
        return view(*a, **kw)
    return wrapped


def token_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        token = current_app.config["API_TOKEN"]
        if not token or request.headers.get("Authorization", "") != f"Bearer {token}":
            return jsonify(error="unauthorized"), 401
        return view(*a, **kw)
    return wrapped


def fire_webhook(payload):
    url = current_app.config["WEBHOOK_URL"]
    if not url:
        return

    def send():
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).close()
        except Exception as e:  # never let a webhook break the door
            log.warning("webhook failed: %s", e)
    threading.Thread(target=send, daemon=True).start()


def event_payload(ts, device, uid, card, d, offline):
    return {"ts": ts, "time": fmt_dt(ts), "time_jalali": J.latin(fmt_jdt(ts)),
            "org": device["org_name"], "org_id": device["org_id"], "door": device["name"], "uid": uid,
            "name": card["name"] if card else None, "result": d["result"],
            "direction": d["direction"] or None, "class_id": d["class_id"], "offline": offline}


def touch_device(db, dev, fw=None):
    db.execute("UPDATE devices SET last_seen = ?, last_ip = ?, fw = COALESCE(?, fw) WHERE id = ?",
               (now(), request.remote_addr, fw, dev["id"]))


def event_filters(args):
    where, params = ["e.org_id = ?"], [oid()]
    q = args.get("q", "").strip()
    if q:
        where.append("(e.name LIKE ? OR e.uid LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    if args.get("result"):
        where.append("e.result = ?")
        params.append(args["result"])
    if args.get("door"):
        where.append("e.device_id = ?")
        params.append(args["door"])
    if args.get("class"):
        where.append("e.class_id = ?")
        params.append(args["class"])
    d_from, d_to = parse_day(args.get("from")), parse_day(args.get("to"))
    if d_from:
        where.append("e.ts >= ?")
        params.append(day_bounds(d_from)[0])
    if d_to:
        where.append("e.ts < ?")
        params.append(day_bounds(d_to)[1])
    return " AND ".join(where), params


RESULT_FA = {"granted": "مجاز", "unknown": "کارت ناشناس", "disabled": "مسدود",
             "expired": "منقضی", "denied": "رد شد", "manual": "باز کردن دستی",
             "not_member": "عضو کلاس نیست"}
DIR_FA = {"in": "ورود", "out": "خروج", "toggle": "ورود/خروج متناوب"}

EVENT_SELECT = ("SELECT e.*, d.name AS door, k.name AS class_name FROM events e "
                "LEFT JOIN devices d ON d.id = e.device_id "
                "LEFT JOIN classes k ON k.id = e.class_id ")


def valid_password(pw):
    return len(pw or "") >= 8


# --- routes ----------------------------------------------------------------

def register_routes(app):

    # ---- device API (used by the Wemos firmware and the Android app) ----

    @app.post("/api/v1/scan")
    @device_required
    def api_scan():
        db, dev = get_db(), g.device
        body = request.get_json(silent=True) or {}
        uid = normalize_uid(body.get("uid"))
        if not uid:
            return jsonify(error="invalid uid"), 400
        touch_device(db, dev)

        card = db.execute("SELECT * FROM cards WHERE org_id = ? AND uid = ?", (dev["org_id"], uid)).fetchone()
        ts = now()
        d = store.decide(db, dev, dev["org_enabled"], card, ts)
        store.add_event(db, org_id=dev["org_id"], ts=ts, device_id=dev["id"], uid=uid, card=card, **d)
        db.commit()
        fire_webhook(event_payload(ts, dev, uid, card, d, False))
        return jsonify(granted=d["result"] == "granted", result=d["result"],
                       name=card["name"] if card else "", direction=d["direction"],
                       open_ms=dev["open_ms"])

    @app.post("/api/v1/sync")
    @device_required
    def api_sync():
        db, dev = get_db(), g.device
        body = request.get_json(silent=True) or {}
        touch_device(db, dev, fw=str(body.get("fw", ""))[:16] or None)

        # events the device decided on its own while we were unreachable (Wemos offline fallback)
        for ev in body.get("events") or []:
            uid = normalize_uid(ev.get("uid"))
            if not uid:
                continue
            ts = int(ev.get("ts") or 0) or now()   # 0 = device had no clock yet
            card = db.execute("SELECT * FROM cards WHERE org_id = ? AND uid = ?", (dev["org_id"], uid)).fetchone()
            result = ev.get("result") if ev.get("result") in ("granted", "denied", "unknown") else "denied"
            direction = ev.get("direction") if ev.get("direction") in ("in", "out") else ""
            d = {"result": result, "direction": direction, "class_id": None, "slot_id": None, "session_date": None}
            # count it for a class if a member scanned during a session
            if card is not None and result == "granted":
                for x in store.active_slots(db, dev["id"], ts):
                    if store.is_member(db, x["class_id"], card["id"]):
                        d.update(class_id=x["class_id"], slot_id=x["slot_id"], session_date=x["session_date"])
                        break
            store.add_event(db, org_id=dev["org_id"], ts=ts, device_id=dev["id"], uid=uid, card=card,
                            offline=True, **d)
            fire_webhook(event_payload(ts, dev, uid, card, d, True))

        open_now = bool(dev["pending_open"])
        if open_now:
            db.execute("UPDATE devices SET pending_open = 0 WHERE id = ?", (dev["id"],))
        db.commit()
        return jsonify(time=now(), cards_version=store.cards_version(db),
                       open=open_now, open_ms=dev["open_ms"])

    @app.get("/api/v1/cards")
    @device_required
    def api_cards():
        """Offline cache for the device: uid \\t enabled \\t inside \\t name, valid cards only."""
        db = get_db()
        today = date.today().isoformat()
        lines = []
        if g.device["org_enabled"]:
            for c in store.cards_with_presence(db, "c.org_id = ?", (g.device["org_id"],)):
                if store.card_valid(c, today) == "ok":
                    lines.append(f"{c['uid']}\t1\t{1 if c['last_dir'] == 'in' else 0}\t{c['name']}")
        return Response("\n".join(lines) + "\n", mimetype="text/tab-separated-values")

    @app.get("/api/v1/kiosk")
    @device_required
    def api_kiosk():
        """Live-screen link for this door; the Android app shows it full screen."""
        dev = g.device
        return jsonify(name=dev["name"], url=url_for("kiosk", token=kiosk_token(dev)))

    # ---- integration API (read-only, Bearer token, all companies; ?org=<id> to filter) ----

    @app.get("/api/v1/presence")
    @token_required
    def api_presence():
        org = request.args.get("org", type=int)
        rows = store.cards_with_presence(get_db(), "c.org_id = ?" if org else "1", (org,) if org else ())
        return jsonify([{"org_id": c["org_id"], "name": c["name"], "uid": c["uid"], "inside": c["last_dir"] == "in",
                         "last_seen": c["last_ts"]} for c in rows])

    @app.get("/api/v1/events")
    @token_required
    def api_events():
        since = request.args.get("since", 0, type=int)
        org = request.args.get("org", type=int)
        rows = get_db().execute(EVENT_SELECT + "WHERE e.id > ?" + (" AND e.org_id = ?" if org else "") +
                                " ORDER BY e.id LIMIT 1000", (since, org) if org else (since,)).fetchall()
        return jsonify([dict(r) for r in rows])

    # ---- auth ----

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            u = get_db().execute("SELECT u.*, o.enabled AS org_enabled FROM users u "
                                 "LEFT JOIN orgs o ON o.id = u.org_id WHERE u.username = ?",
                                 (request.form.get("username", ""),)).fetchone()
            if u and check_password_hash(u["pw_hash"], request.form.get("password", "")):
                if u["org_id"] and not u["org_enabled"]:
                    flash("حساب سازمان شما غیرفعال شده است.", "error")
                    return render_template("login.html")
                session.clear()
                session.permanent = True
                session["uid"] = u["id"]
                session["user"] = u["username"]
                nxt = request.args.get("next", "")
                if nxt.startswith("/") and not nxt.startswith("//"):
                    return redirect(nxt)
                return redirect(url_for("admin") if u["org_id"] is None else url_for("live"))
            time.sleep(1)
            flash("نام کاربری یا رمز عبور اشتباه است.", "error")
        return render_template("login.html")

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---- live door screen (landing page) ----

    @app.get("/")
    @login_required
    def live():
        doors = get_db().execute("SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        door_id = request.args.get("door", 0, type=int)
        return render_template("live.html", kiosk=False, doors=doors, door_id=door_id,
                               feed_url=url_for("live_feed", door=door_id or None))

    @app.get("/live/feed")
    def live_feed():
        if not g.user or g.org is None:
            return jsonify(error="login required"), 401
        return live_events(oid(), request.args.get("door", 0, type=int))

    @app.get("/kiosk/<token>")
    def kiosk(token):
        dev = kiosk_door(token)
        return render_template("live.html", kiosk=True, doors=[dev], door_id=dev["id"],
                               feed_url=url_for("kiosk_feed", token=token))

    @app.get("/kiosk/<token>/feed")
    def kiosk_feed(token):
        dev = kiosk_door(token)
        return live_events(dev["org_id"], dev["id"])

    # ---- dashboard ----

    @app.get("/dashboard")
    @login_required
    def dashboard():
        db = get_db()
        start, end = day_bounds(date.today())
        cards = store.cards_with_presence(db, "c.org_id = ?", (oid(),))
        inside = [c for c in cards if c["last_dir"] == "in"]
        stats = db.execute(
            "SELECT SUM(result = 'granted') AS granted, SUM(result != 'granted') AS denied "
            "FROM events WHERE org_id = ? AND ts >= ? AND ts < ?", (oid(), start, end)).fetchone()
        recent = db.execute(EVENT_SELECT + "WHERE e.org_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 15",
                            (oid(),)).fetchall()
        unknown = db.execute(
            "SELECT e.uid, MAX(e.ts) AS ts, COUNT(*) AS n, d.name AS door FROM events e "
            "LEFT JOIN devices d ON d.id = e.device_id "
            "WHERE e.org_id = ? AND e.result = 'unknown' AND e.ts > ? "
            "AND e.uid NOT IN (SELECT uid FROM cards WHERE org_id = ?) "
            "GROUP BY e.uid ORDER BY ts DESC LIMIT 10", (oid(), now() - 7 * 86400, oid())).fetchall()
        doors = db.execute("SELECT * FROM devices WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        # class sessions running right now
        running = []
        for k in db.execute("SELECT * FROM classes WHERE org_id = ? ORDER BY name", (oid(),)).fetchall():
            for s in store.class_sessions(db, k, date.today(), date.today()):
                if s["start"] - store.EARLY_MIN * 60 <= now() < s["end"]:
                    rep = store.session_report(db, k, s["slot"], s["date"], now())
                    here = sum(1 for r in rep["rows"] if r["open"])
                    running.append({"cls": k, "s": s, "here": here, "members": len(rep["rows"])})
        return render_template("dashboard.html", cards=cards, inside=inside, stats=stats,
                               recent=recent, unknown=unknown, doors=doors, running=running,
                               online_after=now() - ONLINE_WINDOW)

    # ---- cards ----

    @app.get("/cards")
    @login_required
    def cards():
        q = request.args.get("q", "").strip()
        if q:
            rows = store.cards_with_presence(get_db(), "c.org_id = ? AND (c.name LIKE ? OR c.uid LIKE ? OR c.note LIKE ?)",
                                             (oid(),) + (f"%{q}%",) * 3)
        else:
            rows = store.cards_with_presence(get_db(), "c.org_id = ?", (oid(),))
        return render_template("cards.html", cards=rows, q=q, today=date.today().isoformat())

    def card_form_values():
        f = request.form
        return {
            "uid": normalize_uid(f.get("uid")),
            "name": clean_name(f.get("name")),
            "note": f.get("note", "").strip()[:200],
            "enabled": 1 if f.get("enabled") else 0,
            "valid_until": parse_day(f.get("valid_until")),
            "valid_until_raw": f.get("valid_until", "").strip(),
        }

    def save_card(card_id=None):
        v = card_form_values()
        if not v["uid"]:
            flash("شناسه کارت نامعتبر است. به صورت هگز وارد کنید، مثلاً 04:A3:1B:2C", "error")
            return None
        if not v["name"]:
            flash("نام الزامی است.", "error")
            return None
        if v.pop("valid_until_raw") and not v["valid_until"]:
            flash("تاریخ اعتبار نامعتبر است (مثال: 1405/12/29).", "error")
            return None
        if v["valid_until"]:
            v["valid_until"] = v["valid_until"].isoformat()
        db = get_db()
        clash = db.execute("SELECT id, name FROM cards WHERE org_id = ? AND uid = ? AND id IS NOT ?",
                           (oid(), v["uid"], card_id)).fetchone()
        if clash:
            flash(f"این کارت قبلاً برای «{clash['name']}» ثبت شده است.", "error")
            return None
        if card_id:
            db.execute("UPDATE cards SET uid=:uid, name=:name, note=:note, enabled=:enabled, "
                       "valid_until=:valid_until WHERE id=:id AND org_id=:org", {**v, "id": card_id, "org": oid()})
        else:
            db.execute("INSERT INTO cards(org_id, uid, name, note, enabled, valid_until, created_at) "
                       "VALUES (:org, :uid, :name, :note, :enabled, :valid_until, :ts)", {**v, "ts": now(), "org": oid()})
        store.bump_cards_rev(db)
        db.commit()
        flash(f"«{v['name']}» ذخیره شد.", "ok")
        return True

    @app.route("/cards/new", methods=["GET", "POST"])
    @login_required
    def card_new():
        if request.method == "POST" and save_card():
            return redirect(url_for("cards"))
        card = request.form if request.method == "POST" else {
            "uid": normalize_uid(request.args.get("uid")), "enabled": 1}
        return render_template("card_form.html", card=card, new=True)

    @app.route("/cards/<int:card_id>", methods=["GET", "POST"])
    @login_required
    def card_edit(card_id):
        card = own_row("cards", card_id)
        if request.method == "POST":
            if save_card(card_id):
                return redirect(url_for("cards"))
            card = request.form
        db = get_db()
        history = db.execute(EVENT_SELECT + "WHERE e.card_id = ? ORDER BY e.ts DESC LIMIT 30", (card_id,)).fetchall()
        classes = db.execute("SELECT k.* FROM classes k JOIN class_members m ON m.class_id = k.id "
                             "WHERE m.card_id = ? ORDER BY k.name", (card_id,)).fetchall()
        row = own_row("cards", card_id)
        parent_url = url_for("parent_page", key=row["parent_key"], _external=True) if row["parent_key"] else None
        return render_template("card_form.html", card=card, new=False, card_id=card_id, history=history,
                               classes=classes, parent_url=parent_url)

    @app.post("/cards/<int:card_id>/toggle")
    @login_required
    def card_toggle(card_id):
        own_row("cards", card_id)
        db = get_db()
        db.execute("UPDATE cards SET enabled = 1 - enabled WHERE id = ?", (card_id,))
        store.bump_cards_rev(db)
        db.commit()
        return redirect(request.referrer or url_for("cards"))

    @app.post("/cards/<int:card_id>/delete")
    @login_required
    def card_delete(card_id):
        own_row("cards", card_id)
        db = get_db()
        db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        store.bump_cards_rev(db)
        db.commit()
        flash("کارت حذف شد. سوابق تردد آن حفظ می‌شود.", "ok")
        return redirect(url_for("cards"))

    # ---- parent link: a private page per card for the child's parents ----

    @app.post("/cards/<int:card_id>/parent-link")
    @login_required
    def card_parent_link(card_id):
        own_row("cards", card_id)
        db = get_db()
        if request.form.get("action") == "off":
            db.execute("UPDATE cards SET parent_key = NULL WHERE id = ?", (card_id,))
            flash("لینک والدین غیرفعال شد.", "ok")
        else:
            db.execute("UPDATE cards SET parent_key = ? WHERE id = ?", (secrets.token_urlsafe(18), card_id))
            flash("لینک جدید والدین ساخته شد. لینک قبلی دیگر کار نمی‌کند.", "ok")
        db.commit()
        return redirect(url_for("card_edit", card_id=card_id) + "#parent")

    @app.get("/parent/<key>")
    def parent_page(key):
        db = get_db()
        card = db.execute("SELECT c.*, o.name AS org_name, o.enabled AS org_enabled FROM cards c "
                          "JOIN orgs o ON o.id = c.org_id WHERE c.parent_key = ?", (key,)).fetchone()
        if card is None or not card["org_enabled"]:
            abort(404)
        return render_template("parent.html", card=card, rep=store.parent_report(db, card),
                               today=date.today())

    # ---- doors (devices) ----

    @app.get("/doors")
    @login_required
    def doors():
        rows = get_db().execute("SELECT * FROM devices WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        return render_template("doors.html", doors=rows, online_after=now() - ONLINE_WINDOW,
                               new_key=session.pop("new_key", None),
                               kiosk_links={d["id"]: url_for("kiosk", token=kiosk_token(d)) for d in rows})

    def door_form_values():
        f = request.form
        return {
            "name": clean_name(f.get("name")),
            "direction": f.get("direction") if f.get("direction") in ("in", "out", "toggle") else "toggle",
            "open_ms": max(500, min(30000, request.form.get("open_ms", 3000, type=int) or 3000)),
            "enabled": 1 if f.get("enabled") else 0,
        }

    @app.post("/doors/new")
    @login_required
    def door_new():
        v = door_form_values()
        if not v["name"]:
            flash("نام در الزامی است.", "error")
            return redirect(url_for("doors"))
        db = get_db()
        key = secrets.token_urlsafe(18)
        try:
            db.execute("INSERT INTO devices(org_id, name, key, direction, open_ms, enabled) "
                       "VALUES (:org, :name, :key, :direction, :open_ms, 1)", {**v, "key": key, "org": oid()})
            db.commit()
        except store.sqlite3.IntegrityError:
            flash("دری با این نام وجود دارد.", "error")
            return redirect(url_for("doors"))
        session["new_key"] = {"name": v["name"], "key": key}
        return redirect(url_for("doors"))

    @app.post("/doors/<int:door_id>")
    @login_required
    def door_edit(door_id):
        own_row("devices", door_id)
        v = door_form_values()
        db = get_db()
        try:
            db.execute("UPDATE devices SET name=:name, direction=:direction, open_ms=:open_ms, "
                       "enabled=:enabled WHERE id=:id", {**v, "id": door_id})
            db.commit()
            flash(f"«{v['name']}» ذخیره شد.", "ok")
        except store.sqlite3.IntegrityError:
            flash("دری با این نام وجود دارد.", "error")
        return redirect(url_for("doors"))

    @app.post("/doors/<int:door_id>/open")
    @login_required
    def door_open(door_id):
        dev = own_row("devices", door_id)
        db = get_db()
        db.execute("UPDATE devices SET pending_open = 1 WHERE id = ?", (door_id,))
        db.execute("INSERT INTO events(org_id, ts, device_id, uid, name, result) VALUES (?, ?, ?, '-', ?, 'manual')",
                   (oid(), now(), door_id, f"پنل: {session['user']}"))
        db.commit()
        flash(f"«{dev['name']}» تا چند ثانیه دیگر باز می‌شود.", "ok")
        return redirect(request.referrer or url_for("doors"))

    @app.post("/doors/<int:door_id>/rekey")
    @login_required
    def door_rekey(door_id):
        dev = own_row("devices", door_id)
        db = get_db()
        key = secrets.token_urlsafe(18)
        db.execute("UPDATE devices SET key = ? WHERE id = ?", (key, door_id))
        db.commit()
        session["new_key"] = {"name": dev["name"], "key": key}
        return redirect(url_for("doors"))

    @app.post("/doors/<int:door_id>/delete")
    @login_required
    def door_delete(door_id):
        own_row("devices", door_id)
        db = get_db()
        db.execute("DELETE FROM devices WHERE id = ?", (door_id,))
        db.commit()
        flash("در حذف شد. سوابق تردد آن حفظ می‌شود؛ زمان‌بندی کلاس‌های این در حذف شد.", "ok")
        return redirect(url_for("doors"))

    # ---- classes ----

    @app.route("/classes", methods=["GET", "POST"])
    @login_required
    def classes():
        db = get_db()
        if request.method == "POST":
            name = clean_name(request.form.get("name"), 60)
            if not name:
                flash("نام کلاس الزامی است.", "error")
            else:
                try:
                    cur = db.execute("INSERT INTO classes(org_id, name, note, created_at) VALUES (?, ?, ?, ?)",
                                     (oid(), name, request.form.get("note", "").strip()[:200], now()))
                    db.commit()
                    return redirect(url_for("class_view", class_id=cur.lastrowid))
                except store.sqlite3.IntegrityError:
                    flash("کلاسی با این نام وجود دارد.", "error")
            return redirect(url_for("classes"))
        rows = db.execute(
            "SELECT k.*, (SELECT COUNT(*) FROM class_members m WHERE m.class_id = k.id) AS members, "
            "(SELECT COUNT(*) FROM class_slots s WHERE s.class_id = k.id) AS slots "
            "FROM classes k WHERE k.org_id = ? ORDER BY k.name COLLATE NOCASE", (oid(),)).fetchall()
        slots = db.execute("SELECT s.*, d.name AS door FROM class_slots s JOIN classes k ON k.id = s.class_id "
                           "LEFT JOIN devices d ON d.id = s.device_id WHERE k.org_id = ? "
                           "ORDER BY s.on_date, s.weekday, s.start_min", (oid(),)).fetchall()
        by_class = {}
        for s in slots:
            by_class.setdefault(s["class_id"], []).append(s)
        return render_template("classes.html", classes=rows, slots=by_class)

    def range_args():
        last = parse_day(request.args.get("to"), date.today())
        first = parse_day(request.args.get("from"), last - timedelta(days=29))
        return (first, last) if first <= last else (last, first)

    @app.get("/classes/<int:class_id>")
    @login_required
    def class_view(class_id):
        cls = own_row("classes", class_id)
        db = get_db()
        first, last = range_args()
        sessions = store.class_sessions(db, cls, first, last)
        summary, counts = store.class_summary(db, cls, sessions, now())
        slots = db.execute("SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id "
                           "WHERE s.class_id = ? ORDER BY s.on_date, s.weekday, s.start_min", (class_id,)).fetchall()
        cards = db.execute("SELECT c.*, EXISTS(SELECT 1 FROM class_members m WHERE m.class_id = ? AND m.card_id = c.id) "
                           "AS member FROM cards c WHERE c.org_id = ? ORDER BY c.name COLLATE NOCASE",
                           (class_id, oid())).fetchall()
        doors = db.execute("SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        return render_template("class.html", cls=cls, sessions=list(zip(sessions, counts)), summary=summary,
                               slots=slots, cards=cards, doors=doors, first=first, last=last,
                               n_members=sum(1 for c in cards if c["member"]))

    @app.get("/classes/<int:class_id>/summary.csv")
    @login_required
    def class_csv(class_id):
        cls = own_row("classes", class_id)
        db = get_db()
        first, last = range_args()
        sessions = store.class_sessions(db, cls, first, last)
        summary, _ = store.class_summary(db, cls, sessions, now())
        buf = io.StringIO()
        buf.write("﻿")
        w = csv.writer(buf)
        w.writerow(["کلاس", "از", "تا", "تعداد جلسات"])
        w.writerow([cls["name"], J.jstr(first), J.jstr(last), len(sessions)])
        w.writerow([])
        w.writerow(["نام", "شناسه کارت", "جلسات حاضر", "مجموع حضور (دقیقه)", "درصد حضور"])
        for t in summary:
            w.writerow([t["card"]["name"], t["card"]["uid"], t["attended"], t["secs"] // 60, t["pct"]])
        return Response(buf.getvalue(), mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename=class-{class_id}.csv"})

    @app.post("/classes/<int:class_id>/edit")
    @login_required
    def class_edit(class_id):
        own_row("classes", class_id)
        name = clean_name(request.form.get("name"), 60)
        if not name:
            flash("نام کلاس الزامی است.", "error")
        else:
            db = get_db()
            try:
                db.execute("UPDATE classes SET name = ?, note = ? WHERE id = ?",
                           (name, request.form.get("note", "").strip()[:200], class_id))
                db.commit()
                flash("ذخیره شد.", "ok")
            except store.sqlite3.IntegrityError:
                flash("کلاسی با این نام وجود دارد.", "error")
        return redirect(url_for("class_view", class_id=class_id))

    @app.post("/classes/<int:class_id>/members")
    @login_required
    def class_members(class_id):
        own_row("classes", class_id)
        db = get_db()
        chosen = {int(x) for x in request.form.getlist("card") if x.isdigit()}
        valid = {r[0] for r in db.execute("SELECT id FROM cards WHERE org_id = ?", (oid(),))}
        db.execute("DELETE FROM class_members WHERE class_id = ?", (class_id,))
        db.executemany("INSERT INTO class_members(class_id, card_id) VALUES (?, ?)",
                       [(class_id, c) for c in sorted(chosen & valid)])
        db.commit()
        flash(f"اعضای کلاس ذخیره شد ({J.fa(len(chosen & valid))} نفر).", "ok")
        return redirect(url_for("class_view", class_id=class_id))

    @app.post("/classes/<int:class_id>/slots")
    @login_required
    def class_slot_add(class_id):
        own_row("classes", class_id)
        f = request.form
        db = get_db()
        dev = db.execute("SELECT id FROM devices WHERE id = ? AND org_id = ?",
                         (f.get("device", type=int), oid())).fetchone()
        start, end = parse_hm(f.get("start")), parse_hm(f.get("end"))
        kind = f.get("kind")
        err = None
        if dev is None:
            err = "دستگاه را انتخاب کنید."
        elif start is None or end is None or end <= start:
            err = "ساعت شروع و پایان را درست وارد کنید (مثال ۱۰:۳۰ تا ۱۲:۰۰؛ پایان بعد از شروع)."
        values = {"class_id": class_id, "device_id": dev and dev["id"], "start": start, "end": end,
                  "weekday": None, "on_date": None, "from_date": None, "to_date": None}
        if not err and kind == "once":
            d = parse_day(f.get("on_date"))
            if not d:
                err = "تاریخ جلسه را وارد کنید (مثال ۱۴۰۵/۰۸/۲۰)."
            else:
                values["on_date"] = d.isoformat()
        elif not err:
            days = [int(x) for x in f.getlist("weekday") if x.isdigit() and 0 <= int(x) <= 6]
            fd, td = parse_day(f.get("from_date")), parse_day(f.get("to_date"))
            if not days:
                err = "حداقل یک روز هفته را انتخاب کنید."
            elif (f.get("from_date") and not fd) or (f.get("to_date") and not td):
                err = "تاریخ شروع یا پایان دوره نامعتبر است."
            # without a start date the schedule starts today (no sessions before the class existed)
            values.update(from_date=(fd or date.today()).isoformat(), to_date=td and td.isoformat())
        if err:
            flash(err, "error")
            return redirect(url_for("class_view", class_id=class_id))
        rows = [values] if kind == "once" else [{**values, "weekday": w} for w in days]
        for r in rows:
            db.execute("INSERT INTO class_slots(class_id, device_id, weekday, on_date, start_min, end_min, "
                       "from_date, to_date) VALUES (:class_id, :device_id, :weekday, :on_date, :start, :end, "
                       ":from_date, :to_date)", r)
        db.commit()
        flash("زمان‌بندی اضافه شد.", "ok")
        return redirect(url_for("class_view", class_id=class_id))

    @app.post("/classes/<int:class_id>/slots/<int:slot_id>/delete")
    @login_required
    def class_slot_delete(class_id, slot_id):
        own_row("classes", class_id)
        db = get_db()
        db.execute("DELETE FROM class_slots WHERE id = ? AND class_id = ?", (slot_id, class_id))
        db.commit()
        flash("زمان‌بندی حذف شد. ترددهای ثبت‌شده باقی می‌مانند.", "ok")
        return redirect(url_for("class_view", class_id=class_id))

    @app.post("/classes/<int:class_id>/delete")
    @login_required
    def class_delete(class_id):
        cls = own_row("classes", class_id)
        db = get_db()
        db.execute("DELETE FROM classes WHERE id = ?", (class_id,))
        db.commit()
        flash(f"کلاس «{cls['name']}» حذف شد.", "ok")
        return redirect(url_for("classes"))

    @app.get("/classes/<int:class_id>/session/<int:slot_id>/<day>")
    @login_required
    def class_session(class_id, slot_id, day):
        cls = own_row("classes", class_id)
        db = get_db()
        slot = db.execute("SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id "
                          "WHERE s.id = ? AND s.class_id = ?", (slot_id, class_id)).fetchone()
        try:
            d = date.fromisoformat(day)
        except ValueError:
            abort(404)
        if slot is None or not store.slot_on(slot, d):
            abort(404)
        rep = store.session_report(db, cls, slot, d, now())
        return render_template("class_session.html", cls=cls, slot=slot, day=d, rep=rep, now=now())

    # ---- events / reports ----

    @app.get("/events")
    @login_required
    def events():
        db = get_db()
        where, params = event_filters(request.args)
        page = max(1, request.args.get("page", 1, type=int))
        total = db.execute(f"SELECT COUNT(*) FROM events e WHERE {where}", params).fetchone()[0]
        rows = db.execute(EVENT_SELECT + f"WHERE {where} ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?",
                          params + [PAGE_SIZE, (page - 1) * PAGE_SIZE]).fetchall()
        doors = db.execute("SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        cls = db.execute("SELECT id, name FROM classes WHERE org_id = ? ORDER BY name", (oid(),)).fetchall()
        args = {k: v for k, v in request.args.items() if k != "page"}
        return render_template("events.html", rows=rows, total=total, page=page,
                               pages=max(1, -(-total // PAGE_SIZE)), doors=doors, classes=cls, args=args)

    @app.get("/events.csv")
    @login_required
    def events_csv():
        where, params = event_filters(request.args)
        rows = get_db().execute(EVENT_SELECT + f"WHERE {where} ORDER BY e.ts", params)
        buf = io.StringIO()
        buf.write("﻿")   # BOM so Excel shows Persian text correctly
        w = csv.writer(buf)
        w.writerow(["تاریخ", "ساعت", "نام", "شناسه کارت", "در", "کلاس", "نتیجه", "جهت", "آفلاین", "تاریخ میلادی"])
        for r in rows:
            day = datetime.fromtimestamp(r["ts"]).date()
            w.writerow([J.jstr(day), fmt_dt(r["ts"], "%H:%M:%S"), r["name"], r["uid"], r["door"] or "",
                        r["class_name"] or "", RESULT_FA.get(r["result"], r["result"]), DIR_FA.get(r["direction"], ""),
                        "بله" if r["offline"] else "", day.isoformat()])
        return Response(buf.getvalue(), mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition": "attachment; filename=access-events.csv"})

    @app.get("/attendance")
    @login_required
    def attendance():
        day = parse_day(request.args.get("date"), date.today())
        start, end = day_bounds(day)
        rows = get_db().execute(
            "SELECT c.id, c.name, c.uid, "
            " MIN(CASE WHEN e.direction = 'in'  THEN e.ts END) AS first_in, "
            " MAX(CASE WHEN e.direction = 'out' THEN e.ts END) AS last_out, "
            " MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen, COUNT(*) AS scans "
            "FROM events e JOIN cards c ON c.id = e.card_id "
            "WHERE e.org_id = ? AND e.result = 'granted' AND e.ts >= ? AND e.ts < ? "
            "GROUP BY c.id ORDER BY first_seen", (oid(), start, end)).fetchall()
        return render_template("attendance.html", rows=rows, day=day,
                               prev=day - timedelta(days=1), next=day + timedelta(days=1))

    # ---- settings (per company) ----

    @app.route("/settings", methods=["GET", "POST"])
    @login_required
    def settings():
        db = get_db()
        if request.method == "POST":
            action = request.form.get("action")
            if action == "password":
                change_own_password(db)
            elif action == "add_user":
                add_user(db, oid())
            elif action == "del_user":
                uid = request.form.get("id", type=int)
                n = db.execute("SELECT COUNT(*) FROM users WHERE org_id = ?", (oid(),)).fetchone()[0]
                if n <= 1 and not g.owner:
                    flash("آخرین کاربر سازمان قابل حذف نیست.", "error")
                elif uid == g.user["id"]:
                    flash("کاربر فعلی را نمی‌توانید حذف کنید.", "error")
                else:
                    db.execute("DELETE FROM users WHERE id = ? AND org_id = ?", (uid, oid()))
                    db.commit()
                    flash("کاربر حذف شد.", "ok")
            elif action == "purge":
                days = request.form.get("days", type=int) or 0
                if days >= 1:
                    n = db.execute("DELETE FROM events WHERE org_id = ? AND ts < ?",
                                   (oid(), now() - days * 86400)).rowcount
                    db.commit()
                    flash(f"{J.fa(n)} رویداد قدیمی‌تر از {J.fa(days)} روز حذف شد.", "ok")
            return redirect(url_for("settings"))
        users = db.execute("SELECT id, username FROM users WHERE org_id = ? ORDER BY username", (oid(),)).fetchall()
        n_events = db.execute("SELECT COUNT(*) FROM events WHERE org_id = ?", (oid(),)).fetchone()[0]
        return render_template("settings.html", users=users, n_events=n_events,
                               api_enabled=bool(current_app.config["API_TOKEN"]),
                               webhook=current_app.config["WEBHOOK_URL"])

    def change_own_password(db):
        new = request.form.get("new", "")
        if not check_password_hash(g.user["pw_hash"], request.form.get("current", "")):
            flash("رمز فعلی اشتباه است.", "error")
        elif not valid_password(new):
            flash("رمز جدید باید حداقل ۸ کاراکتر باشد.", "error")
        else:
            db.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (generate_password_hash(new), g.user["id"]))
            db.commit()
            flash("رمز عبور تغییر کرد.", "ok")

    def add_user(db, org_id):
        name, pw = request.form.get("username", "").strip(), request.form.get("password", "")
        if not name or not valid_password(pw):
            flash("نام کاربری و رمز حداقل ۸ کاراکتری الزامی است.", "error")
            return False
        try:
            db.execute("INSERT INTO users(username, pw_hash, org_id) VALUES (?, ?, ?)",
                       (name, generate_password_hash(pw), org_id))
            db.commit()
            flash(f"کاربر «{name}» اضافه شد.", "ok")
            return True
        except store.sqlite3.IntegrityError:
            flash("این نام کاربری قبلاً استفاده شده است.", "error")
            return False

    # ---- server owner: companies and their users ----

    @app.route("/admin", methods=["GET", "POST"])
    @owner_required
    def admin():
        db = get_db()
        if request.method == "POST":
            action = request.form.get("action")
            org_id = request.form.get("org", type=int)
            if action == "new_org":
                name = clean_name(request.form.get("name"), 60)
                if not name:
                    flash("نام سازمان الزامی است.", "error")
                elif not request.form.get("username", "").strip() or not valid_password(request.form.get("password")):
                    flash("برای سازمان یک نام کاربری و رمز حداقل ۸ کاراکتری وارد کنید.", "error")
                elif db.execute("SELECT 1 FROM users WHERE username = ?",
                                (request.form.get("username", "").strip(),)).fetchone():
                    flash("این نام کاربری قبلاً استفاده شده است.", "error")
                else:
                    try:
                        cur = db.execute("INSERT INTO orgs(name, enabled, created_at) VALUES (?, 1, ?)", (name, now()))
                        if add_user(db, cur.lastrowid):
                            flash(f"سازمان «{name}» ساخته شد.", "ok")
                    except store.sqlite3.IntegrityError:
                        db.rollback()
                        flash("سازمانی با این نام وجود دارد.", "error")
            elif action == "rename":
                name = clean_name(request.form.get("name"), 60)
                try:
                    if name:
                        db.execute("UPDATE orgs SET name = ? WHERE id = ?", (name, org_id))
                        db.commit()
                except store.sqlite3.IntegrityError:
                    flash("سازمانی با این نام وجود دارد.", "error")
            elif action == "toggle":
                db.execute("UPDATE orgs SET enabled = 1 - enabled WHERE id = ?", (org_id,))
                db.commit()
            elif action == "delete":
                org = db.execute("SELECT * FROM orgs WHERE id = ?", (org_id,)).fetchone()
                if org and request.form.get("confirm", "").strip() == org["name"]:
                    db.execute("DELETE FROM orgs WHERE id = ?", (org_id,))
                    db.commit()
                    if session.get("view_org") == org_id:
                        session.pop("view_org")
                    flash(f"سازمان «{org['name']}» و همه داده‌های آن حذف شد.", "ok")
                else:
                    flash("برای حذف، نام سازمان را دقیقاً وارد کنید.", "error")
            elif action == "add_user":
                if db.execute("SELECT 1 FROM orgs WHERE id = ?", (org_id,)).fetchone():
                    add_user(db, org_id)
            elif action == "add_owner":
                add_user(db, None)
            elif action == "reset_pw":
                pw = request.form.get("password", "")
                if not valid_password(pw):
                    flash("رمز باید حداقل ۸ کاراکتر باشد.", "error")
                else:
                    db.execute("UPDATE users SET pw_hash = ? WHERE id = ?",
                               (generate_password_hash(pw), request.form.get("id", type=int)))
                    db.commit()
                    flash("رمز عبور تغییر کرد.", "ok")
            elif action == "del_user":
                uid = request.form.get("id", type=int)
                u = db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
                owners = db.execute("SELECT COUNT(*) FROM users WHERE org_id IS NULL").fetchone()[0]
                if u is None or uid == g.user["id"]:
                    flash("کاربر فعلی را نمی‌توانید حذف کنید.", "error")
                elif u["org_id"] is None and owners <= 1:
                    flash("آخرین مدیر سرور قابل حذف نیست.", "error")
                else:
                    db.execute("DELETE FROM users WHERE id = ?", (uid,))
                    db.commit()
                    flash(f"کاربر «{u['username']}» حذف شد.", "ok")
            elif action == "password":
                change_own_password(db)
            return redirect(url_for("admin"))

        orgs = db.execute(
            "SELECT o.*, "
            "(SELECT COUNT(*) FROM devices WHERE org_id = o.id) AS n_devices, "
            "(SELECT COUNT(*) FROM cards WHERE org_id = o.id) AS n_cards, "
            "(SELECT COUNT(*) FROM classes WHERE org_id = o.id) AS n_classes, "
            "(SELECT MAX(ts) FROM events WHERE org_id = o.id) AS last_event "
            "FROM orgs o ORDER BY o.name COLLATE NOCASE").fetchall()
        users = db.execute("SELECT id, username, org_id FROM users ORDER BY username").fetchall()
        by_org = {}
        for u in users:
            by_org.setdefault(u["org_id"], []).append(u)
        return render_template("admin.html", orgs=orgs, users=by_org,
                               api_enabled=bool(current_app.config["API_TOKEN"]),
                               webhook=current_app.config["WEBHOOK_URL"])

    @app.post("/admin/view")
    @owner_required
    def admin_view():
        """Open a company's panel as the server owner."""
        org_id = request.form.get("org", type=int)
        if org_id and get_db().execute("SELECT 1 FROM orgs WHERE id = ?", (org_id,)).fetchone():
            session["view_org"] = org_id
            return redirect(url_for("dashboard"))
        session.pop("view_org", None)
        return redirect(url_for("admin"))


# --- entry point -------------------------------------------------------------

def set_password(username):
    con = store.init_db(os.path.join(DATA_DIR, "access.db"))
    pw = getpass.getpass(f"New password for {username}: ")
    if len(pw) < 8:
        sys.exit("Password must be at least 8 characters.")
    cur = con.execute("UPDATE users SET pw_hash = ? WHERE username = ?", (generate_password_hash(pw), username))
    if cur.rowcount == 0:
        con.execute("INSERT INTO users(username, pw_hash, org_id) VALUES (?, ?, NULL)",
                    (username, generate_password_hash(pw)))
        print(f"Created server owner '{username}'.")
    con.commit()
    print("Done.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.makedirs(DATA_DIR, exist_ok=True)
    if len(sys.argv) == 3 and sys.argv[1] == "set-password":
        set_password(sys.argv[2])
        sys.exit()
    host = os.environ.get("ACCESSCTL_HOST", "0.0.0.0")
    port = int(os.environ.get("ACCESSCTL_PORT", "8080"))
    application = create_app()
    try:
        from waitress import serve
        serve(application, host=host, port=port, threads=8)
    except ImportError:
        log.warning("waitress not installed, using the Flask development server")
        application.run(host=host, port=port)
