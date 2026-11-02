"""RFID access-control server: web panel + API for the Wemos D1 mini readers.

Run:  python app.py                      (http://0.0.0.0:8080)
      python app.py set-password admin   (reset a panel password)

Environment:
  ACCESSCTL_DATA         data directory (default ./data)
  ACCESSCTL_HOST/PORT    listen address (default 0.0.0.0:8080)
  ACCESSCTL_API_TOKEN    enables the read-only integration API (Bearer token)
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
        con.execute("INSERT INTO users(username, pw_hash) VALUES ('admin', ?)",
                    (generate_password_hash(pw),))
        con.commit()
        if generated:
            print(f"\n*** Panel login: admin / {pw}  (change it under Settings) ***\n", flush=True)
    con.close()

    app.teardown_appcontext(store.close_db)
    app.jinja_env.filters.update(jdt=fmt_jdt, jdate=fmt_jdate, jtime=fmt_jtime, ago=fmt_ago,
                                 fa=J.fa, jinput=jinput, jlong=J.jlong, jstr=J.jstr)
    app.jinja_env.globals.update(csrf_token=csrf_token, RESULT_FA=RESULT_FA, DIR_FA=DIR_FA)
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


def live_events(door_id):
    """New scans for the live screen. ?init=1 -> the latest few; ?after=<id> -> newer ones."""
    db = get_db()
    where, params = "e.offline = 0", []
    if door_id:
        where += " AND e.device_id = ?"
        params.append(door_id)
    if request.args.get("init"):
        rows = db.execute(EVENT_SELECT + f"WHERE {where} ORDER BY e.id DESC LIMIT 8", params).fetchall()[::-1]
    else:
        rows = db.execute(EVENT_SELECT + f"WHERE {where} AND e.id > ? ORDER BY e.id LIMIT 20",
                          params + [request.args.get("after", 0, type=int)]).fetchall()
    cutoff = now() - ONLINE_WINDOW
    doors = db.execute("SELECT id, name, last_seen FROM devices ORDER BY name").fetchall()
    return jsonify(
        events=[{"id": r["id"], "name": r["name"], "uid": r["uid"], "result": r["result"],
                 "direction": r["direction"], "door": r["door"] or "",
                 "time": fmt_jtime(r["ts"], True), "date": fmt_jdate(r["ts"])} for r in rows],
        doors=[{"id": d["id"], "name": d["name"],
                "online": bool(d["last_seen"] and d["last_seen"] >= cutoff)}
               for d in doors if not door_id or d["id"] == door_id])


def login_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        if not session.get("user"):
            return redirect(url_for("login", next=request.path))
        return view(*a, **kw)
    return wrapped


def device_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        key = request.headers.get("X-Device-Key", "")
        dev = get_db().execute("SELECT * FROM devices WHERE key = ?", (key,)).fetchone() if key else None
        if dev is None:
            return jsonify(error="unknown device key"), 401
        g.device = dev
        return view(*a, **kw)
    return wrapped


def token_required(view):
    @functools.wraps(view)
    def wrapped(*a, **kw):
        token = current_token()
        if not token or request.headers.get("Authorization", "") != f"Bearer {token}":
            return jsonify(error="unauthorized"), 401
        return view(*a, **kw)
    return wrapped


def current_token():
    return current_app.config["API_TOKEN"]


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


def event_payload(ts, device, uid, card, result, direction, offline):
    return {"ts": ts, "time": fmt_dt(ts), "time_jalali": J.latin(fmt_jdt(ts)), "door": device["name"], "uid": uid,
            "name": card["name"] if card else None, "result": result,
            "direction": direction or None, "offline": offline}


def touch_device(db, dev, fw=None):
    db.execute("UPDATE devices SET last_seen = ?, last_ip = ?, fw = COALESCE(?, fw) WHERE id = ?",
               (now(), request.remote_addr, fw, dev["id"]))


def event_filters(args):
    where, params = ["1"], []
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
    d_from, d_to = parse_day(args.get("from")), parse_day(args.get("to"))
    if d_from:
        where.append("e.ts >= ?")
        params.append(day_bounds(d_from)[0])
    if d_to:
        where.append("e.ts < ?")
        params.append(day_bounds(d_to)[1])
    return " AND ".join(where), params


RESULT_FA = {"granted": "مجاز", "unknown": "کارت ناشناس", "disabled": "مسدود",
             "expired": "منقضی", "denied": "رد شد", "manual": "باز کردن دستی"}
DIR_FA = {"in": "ورود", "out": "خروج", "toggle": "ورود/خروج متناوب"}

EVENT_SELECT = ("SELECT e.*, d.name AS door FROM events e "
                "LEFT JOIN devices d ON d.id = e.device_id ")


# --- routes ----------------------------------------------------------------

def register_routes(app):

    # ---- device API (used by the Wemos firmware) ----

    @app.post("/api/v1/scan")
    @device_required
    def api_scan():
        db, dev = get_db(), g.device
        body = request.get_json(silent=True) or {}
        uid = normalize_uid(body.get("uid"))
        if not uid:
            return jsonify(error="invalid uid"), 400
        touch_device(db, dev)

        card = db.execute("SELECT * FROM cards WHERE uid = ?", (uid,)).fetchone()
        direction = ""
        if not dev["enabled"]:
            result = "denied"
        elif card is None:
            result = "unknown"
        else:
            valid = store.card_valid(card)
            result = "granted" if valid == "ok" else valid
        if result == "granted":
            direction = dev["direction"]
            if direction == "toggle":
                direction = "out" if store.last_direction(db, card["id"]) == "in" else "in"

        ts = now()
        store.add_event(db, ts=ts, device_id=dev["id"], uid=uid, card=card,
                        result=result, direction=direction)
        db.commit()
        fire_webhook(event_payload(ts, dev, uid, card, result, direction, False))
        return jsonify(granted=result == "granted", result=result,
                       name=card["name"] if card else "", direction=direction,
                       open_ms=dev["open_ms"])

    @app.post("/api/v1/sync")
    @device_required
    def api_sync():
        db, dev = get_db(), g.device
        body = request.get_json(silent=True) or {}
        touch_device(db, dev, fw=str(body.get("fw", ""))[:16] or None)

        # events the device decided on its own while we were unreachable
        for ev in body.get("events") or []:
            uid = normalize_uid(ev.get("uid"))
            if not uid:
                continue
            ts = int(ev.get("ts") or 0) or now()   # 0 = device had no clock yet
            card = db.execute("SELECT * FROM cards WHERE uid = ?", (uid,)).fetchone()
            result = ev.get("result") if ev.get("result") in ("granted", "denied", "unknown") else "denied"
            direction = ev.get("direction") if ev.get("direction") in ("in", "out") else ""
            store.add_event(db, ts=ts, device_id=dev["id"], uid=uid, card=card,
                            result=result, direction=direction, offline=True)
            fire_webhook(event_payload(ts, dev, uid, card, result, direction, True))

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
        for c in store.cards_with_presence(db):
            if store.card_valid(c, today) == "ok":
                lines.append(f"{c['uid']}\t1\t{1 if c['last_dir'] == 'in' else 0}\t{c['name']}")
        return Response("\n".join(lines) + "\n", mimetype="text/tab-separated-values")

    # ---- integration API (read-only, Bearer token) ----

    @app.get("/api/v1/presence")
    @token_required
    def api_presence():
        rows = store.cards_with_presence(get_db())
        return jsonify([{"name": c["name"], "uid": c["uid"], "inside": c["last_dir"] == "in",
                         "last_seen": c["last_ts"]} for c in rows])

    @app.get("/api/v1/events")
    @token_required
    def api_events():
        since = request.args.get("since", 0, type=int)
        rows = get_db().execute(EVENT_SELECT + "WHERE e.id > ? ORDER BY e.id LIMIT 1000",
                                (since,)).fetchall()
        return jsonify([dict(r) for r in rows])

    # ---- auth ----

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            u = get_db().execute("SELECT * FROM users WHERE username = ?",
                                 (request.form.get("username", ""),)).fetchone()
            if u and check_password_hash(u["pw_hash"], request.form.get("password", "")):
                session.clear()
                session.permanent = True
                session["user"] = u["username"]
                nxt = request.args.get("next", "")
                return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else url_for("live"))
            time.sleep(1)
            flash("نام کاربری یا رمز عبور اشتباه است.", "error")
        return render_template("login.html")

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---- dashboard ----

    # ---- live door screen (landing page) ----

    @app.get("/")
    @login_required
    def live():
        doors = get_db().execute("SELECT id, name FROM devices ORDER BY name").fetchall()
        door_id = request.args.get("door", 0, type=int)
        return render_template("live.html", kiosk=False, doors=doors, door_id=door_id,
                               feed_url=url_for("live_feed", door=door_id or None))

    @app.get("/live/feed")
    def live_feed():
        if not session.get("user"):
            return jsonify(error="login required"), 401
        return live_events(request.args.get("door", 0, type=int))

    @app.get("/kiosk/<token>")
    def kiosk(token):
        dev = kiosk_door(token)
        return render_template("live.html", kiosk=True, doors=[dev], door_id=dev["id"],
                               feed_url=url_for("kiosk_feed", token=token))

    @app.get("/kiosk/<token>/feed")
    def kiosk_feed(token):
        return live_events(kiosk_door(token)["id"])

    # ---- dashboard ----

    @app.get("/dashboard")
    @login_required
    def dashboard():
        db = get_db()
        start, end = day_bounds(date.today())
        cards = store.cards_with_presence(db)
        inside = [c for c in cards if c["last_dir"] == "in"]
        stats = db.execute(
            "SELECT SUM(result = 'granted') AS granted, SUM(result != 'granted') AS denied "
            "FROM events WHERE ts >= ? AND ts < ?", (start, end)).fetchone()
        recent = db.execute(EVENT_SELECT + "ORDER BY e.ts DESC, e.id DESC LIMIT 15").fetchall()
        unknown = db.execute(
            "SELECT e.uid, MAX(e.ts) AS ts, COUNT(*) AS n, d.name AS door FROM events e "
            "LEFT JOIN devices d ON d.id = e.device_id "
            "WHERE e.result = 'unknown' AND e.ts > ? AND e.uid NOT IN (SELECT uid FROM cards) "
            "GROUP BY e.uid ORDER BY ts DESC LIMIT 10", (now() - 7 * 86400,)).fetchall()
        doors = db.execute("SELECT * FROM devices ORDER BY name").fetchall()
        return render_template("dashboard.html", cards=cards, inside=inside, stats=stats,
                               recent=recent, unknown=unknown, doors=doors,
                               online_after=now() - ONLINE_WINDOW)

    # ---- cards ----

    @app.get("/cards")
    @login_required
    def cards():
        q = request.args.get("q", "").strip()
        if q:
            rows = store.cards_with_presence(get_db(), "c.name LIKE ? OR c.uid LIKE ? OR c.note LIKE ?",
                                             (f"%{q}%",) * 3)
        else:
            rows = store.cards_with_presence(get_db())
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
        clash = db.execute("SELECT id, name FROM cards WHERE uid = ? AND id IS NOT ?",
                           (v["uid"], card_id)).fetchone()
        if clash:
            flash(f"این کارت قبلاً برای «{clash['name']}» ثبت شده است.", "error")
            return None
        if card_id:
            db.execute("UPDATE cards SET uid=:uid, name=:name, note=:note, enabled=:enabled, "
                       "valid_until=:valid_until WHERE id=:id", {**v, "id": card_id})
        else:
            db.execute("INSERT INTO cards(uid, name, note, enabled, valid_until, created_at) "
                       "VALUES (:uid, :name, :note, :enabled, :valid_until, :ts)", {**v, "ts": now()})
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
        card = get_db().execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        if card is None:
            abort(404)
        if request.method == "POST":
            if save_card(card_id):
                return redirect(url_for("cards"))
            card = request.form
        history = get_db().execute(EVENT_SELECT + "WHERE e.card_id = ? ORDER BY e.ts DESC LIMIT 30",
                                   (card_id,)).fetchall()
        return render_template("card_form.html", card=card, new=False, card_id=card_id, history=history)

    @app.post("/cards/<int:card_id>/toggle")
    @login_required
    def card_toggle(card_id):
        db = get_db()
        db.execute("UPDATE cards SET enabled = 1 - enabled WHERE id = ?", (card_id,))
        store.bump_cards_rev(db)
        db.commit()
        return redirect(request.referrer or url_for("cards"))

    @app.post("/cards/<int:card_id>/delete")
    @login_required
    def card_delete(card_id):
        db = get_db()
        db.execute("DELETE FROM cards WHERE id = ?", (card_id,))
        store.bump_cards_rev(db)
        db.commit()
        flash("کارت حذف شد. سوابق تردد آن حفظ می‌شود.", "ok")
        return redirect(url_for("cards"))

    # ---- doors (devices) ----

    @app.get("/doors")
    @login_required
    def doors():
        rows = get_db().execute("SELECT * FROM devices ORDER BY name").fetchall()
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
            db.execute("INSERT INTO devices(name, key, direction, open_ms, enabled) "
                       "VALUES (:name, :key, :direction, :open_ms, 1)", {**v, "key": key})
            db.commit()
        except store.sqlite3.IntegrityError:
            flash("دری با این نام وجود دارد.", "error")
            return redirect(url_for("doors"))
        session["new_key"] = {"name": v["name"], "key": key}
        return redirect(url_for("doors"))

    @app.post("/doors/<int:door_id>")
    @login_required
    def door_edit(door_id):
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
        db = get_db()
        dev = db.execute("SELECT * FROM devices WHERE id = ?", (door_id,)).fetchone()
        if dev is None:
            abort(404)
        db.execute("UPDATE devices SET pending_open = 1 WHERE id = ?", (door_id,))
        db.execute("INSERT INTO events(ts, device_id, uid, name, result) VALUES (?, ?, '-', ?, 'manual')",
                   (now(), door_id, f"پنل: {session['user']}"))
        db.commit()
        flash(f"«{dev['name']}» تا چند ثانیه دیگر باز می‌شود.", "ok")
        return redirect(request.referrer or url_for("doors"))

    @app.post("/doors/<int:door_id>/rekey")
    @login_required
    def door_rekey(door_id):
        db = get_db()
        dev = db.execute("SELECT * FROM devices WHERE id = ?", (door_id,)).fetchone()
        if dev is None:
            abort(404)
        key = secrets.token_urlsafe(18)
        db.execute("UPDATE devices SET key = ? WHERE id = ?", (key, door_id))
        db.commit()
        session["new_key"] = {"name": dev["name"], "key": key}
        return redirect(url_for("doors"))

    @app.post("/doors/<int:door_id>/delete")
    @login_required
    def door_delete(door_id):
        db = get_db()
        db.execute("DELETE FROM devices WHERE id = ?", (door_id,))
        db.commit()
        flash("در حذف شد. سوابق تردد آن حفظ می‌شود.", "ok")
        return redirect(url_for("doors"))

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
        doors = db.execute("SELECT id, name FROM devices ORDER BY name").fetchall()
        args = {k: v for k, v in request.args.items() if k != "page"}
        return render_template("events.html", rows=rows, total=total, page=page,
                               pages=max(1, -(-total // PAGE_SIZE)), doors=doors, args=args)

    @app.get("/events.csv")
    @login_required
    def events_csv():
        where, params = event_filters(request.args)
        rows = get_db().execute(EVENT_SELECT + f"WHERE {where} ORDER BY e.ts", params)
        buf = io.StringIO()
        buf.write("\ufeff")   # BOM so Excel shows Persian text correctly
        w = csv.writer(buf)
        w.writerow(["تاریخ", "ساعت", "نام", "شناسه کارت", "در", "نتیجه", "جهت", "آفلاین", "تاریخ میلادی"])
        for r in rows:
            day = datetime.fromtimestamp(r["ts"]).date()
            w.writerow([J.jstr(day), fmt_dt(r["ts"], "%H:%M:%S"), r["name"], r["uid"], r["door"] or "",
                        RESULT_FA.get(r["result"], r["result"]), DIR_FA.get(r["direction"], ""),
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
            "WHERE e.result = 'granted' AND e.ts >= ? AND e.ts < ? "
            "GROUP BY c.id ORDER BY first_seen", (start, end)).fetchall()
        return render_template("attendance.html", rows=rows, day=day,
                               prev=day - timedelta(days=1), next=day + timedelta(days=1))

    # ---- settings ----

    @app.route("/settings", methods=["GET", "POST"])
    @login_required
    def settings():
        db = get_db()
        if request.method == "POST":
            action = request.form.get("action")
            if action == "password":
                u = db.execute("SELECT * FROM users WHERE username = ?", (session["user"],)).fetchone()
                new = request.form.get("new", "")
                if not check_password_hash(u["pw_hash"], request.form.get("current", "")):
                    flash("رمز فعلی اشتباه است.", "error")
                elif len(new) < 8:
                    flash("رمز جدید باید حداقل ۸ کاراکتر باشد.", "error")
                else:
                    db.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (generate_password_hash(new), u["id"]))
                    db.commit()
                    flash("رمز عبور تغییر کرد.", "ok")
            elif action == "add_user":
                name, pw = request.form.get("username", "").strip(), request.form.get("password", "")
                if not name or len(pw) < 8:
                    flash("نام کاربری و رمز حداقل ۸ کاراکتری الزامی است.", "error")
                else:
                    try:
                        db.execute("INSERT INTO users(username, pw_hash) VALUES (?, ?)",
                                   (name, generate_password_hash(pw)))
                        db.commit()
                        flash(f"کاربر «{name}» اضافه شد.", "ok")
                    except store.sqlite3.IntegrityError:
                        flash("این نام کاربری وجود دارد.", "error")
            elif action == "del_user":
                uid = request.form.get("id", type=int)
                if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] <= 1:
                    flash("آخرین کاربر قابل حذف نیست.", "error")
                else:
                    db.execute("DELETE FROM users WHERE id = ?", (uid,))
                    db.commit()
                    if not db.execute("SELECT 1 FROM users WHERE username = ?", (session["user"],)).fetchone():
                        session.clear()
                        return redirect(url_for("login"))
                    flash("کاربر حذف شد.", "ok")
            elif action == "purge":
                days = request.form.get("days", type=int) or 0
                if days >= 1:
                    n = db.execute("DELETE FROM events WHERE ts < ?", (now() - days * 86400,)).rowcount
                    db.commit()
                    flash(f"{J.fa(n)} رویداد قدیمی‌تر از {J.fa(days)} روز حذف شد.", "ok")
            return redirect(url_for("settings"))
        users = db.execute("SELECT id, username FROM users ORDER BY username").fetchall()
        n_events = db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        return render_template("settings.html", users=users, n_events=n_events,
                               api_enabled=bool(current_app.config["API_TOKEN"]),
                               webhook=current_app.config["WEBHOOK_URL"])


# --- entry point -------------------------------------------------------------

def set_password(username):
    con = store.init_db(os.path.join(DATA_DIR, "access.db"))
    pw = getpass.getpass(f"New password for {username}: ")
    if len(pw) < 8:
        sys.exit("Password must be at least 8 characters.")
    cur = con.execute("UPDATE users SET pw_hash = ? WHERE username = ?", (generate_password_hash(pw), username))
    if cur.rowcount == 0:
        con.execute("INSERT INTO users(username, pw_hash) VALUES (?, ?)", (username, generate_password_hash(pw)))
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
