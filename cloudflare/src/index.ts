// RFID access-control server on Cloudflare Workers + D1 — port of server/app.py.
// Same device API (/api/v1/*) as the Flask server, so the Wemos firmware works with either.
import { checkPassword, hashPassword, kioskMatches, kioskPayload, kioskToken, randomToken, safeEqual, Session } from "./auth";
import {
  activeSlots, addEvent, all, bumpCardsRev, cardsVersion, cardsWithPresence, cardValid, classSessions, classSummary,
  cleanName, decide, Decision, EARLY_MIN, EVENT_SELECT, first, isMember, isUniqueError, normalizeUid, Row, run,
  sessionReport, slotOn, stmt,
} from "./db";
import { esc, Safe } from "./html";
import * as J from "./jalali";
import liveTemplate from "./live.html";
import { dayBounds, fmtDt, jdate, jdt, jtime, localDate, now, setTimeZone, today } from "./time";
import * as V from "./views";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SECRET_KEY: string;              // wrangler secret put SECRET_KEY
  ADMIN_PASSWORD?: string;         // first login when the users table is empty
  ACCESSCTL_API_TOKEN?: string;    // enables the read-only integration API
  ACCESSCTL_WEBHOOK_URL?: string;  // POSTs every access event as JSON
  TZ?: string;                     // panel time zone (wrangler.toml [vars])
  LIVE_POLL_MS?: string;           // live screen refresh; each poll is one Worker request
}

const ONLINE_WINDOW = 30;   // a door counts as online if it synced within this many seconds
const PAGE_SIZE = 100;

class HttpError extends Error {
  constructor(public status: number, message = "") { super(message); }
}
const abort = (status: number, message = ""): never => { throw new HttpError(status, message); };

type Ctx = {
  req: Request;
  env: Env;
  url: URL;
  db: D1Database;
  session: Session;
  user: Row | null;      // logged-in user
  owner: boolean;        // server owner (no company of their own)
  org: Row | null;       // company being viewed
  waitUntil: (p: Promise<unknown>) => void;
  form?: FormData;
  endpoint: string;
};

// --- responses ----------------------------------------------------------------

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const page = (body: Safe | string, status = 200) =>
  new Response(String(body), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

const back = (c: Ctx, fallback: string) => {
  const ref = c.req.headers.get("Referer");
  try {
    if (ref && new URL(ref).origin === c.url.origin) return redirect(ref);
  } catch { /* bad header */ }
  return redirect(fallback);
};

function pageCtx(c: Ctx): V.PageCtx {
  return {
    user: c.user?.username, userId: c.user?.id, owner: c.owner, orgName: c.org?.name,
    endpoint: c.endpoint, csrf: c.session.csrfToken(), flashes: c.session.popFlashes(),
  };
}

const oid = (c: Ctx): number => c.org!.id;

/** A row of the current company, or 404 (ids from another company are never served). */
async function ownRow(c: Ctx, table: "cards" | "devices" | "classes", id: number): Promise<Row> {
  const row = await first(c.db, `SELECT * FROM ${table} WHERE id = ? AND org_id = ?`, id, oid(c));
  if (!row) abort(404);
  return row!;
}

/** Load the logged-in user and the company they are looking at. */
async function loadUser(c: Ctx) {
  const uid = c.session.data.uid;
  if (!uid) return;
  const u = await first(c.db, "SELECT u.*, o.enabled AS org_enabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.id = ?", uid);
  if (!u || (u.org_id && !u.org_enabled)) {
    c.session.clear();
    if (u) c.session.flash("حساب سازمان شما غیرفعال شده است.", "error");
    return;
  }
  c.user = u;
  c.owner = u.org_id === null;
  const orgId = u.org_id ?? c.session.data.view_org;
  if (orgId) {
    c.org = await first(c.db, "SELECT * FROM orgs WHERE id = ?", orgId);
    if (!c.org) c.session.set("view_org", undefined);
  }
}

const validPassword = (pw: string) => pw.length >= 8;

const intArg = (v: string | null | undefined, dflt = 0) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && /^-?\d+$/.test((v ?? "").trim()) ? n : dflt;
};

const formStr = (c: Ctx, k: string) => {
  const v = c.form?.get(k);
  return typeof v === "string" ? v : "";
};

// --- helpers --------------------------------------------------------------------

async function deviceFromKey(c: Ctx): Promise<Row> {
  const key = c.req.headers.get("X-Device-Key") || "";
  const dev = key ? await first(c.db,
    "SELECT d.*, o.enabled AS org_enabled, o.name AS org_name FROM devices d JOIN orgs o ON o.id = d.org_id WHERE d.key = ?", key) : null;
  if (!dev) throw new HttpError(401, "unknown device key");
  return dev;
}

function requireToken(c: Ctx) {
  const token = c.env.ACCESSCTL_API_TOKEN;
  if (!token || !safeEqual(c.req.headers.get("Authorization") || "", `Bearer ${token}`)) {
    throw new HttpError(401, "unauthorized");
  }
}

function touchDevice(c: Ctx, dev: Row, fw: string | null = null) {
  return stmt(c.db, "UPDATE devices SET last_seen = ?, last_ip = ?, fw = COALESCE(?, fw) WHERE id = ?",
    now(), c.req.headers.get("CF-Connecting-IP") || "", fw, dev.id);
}

function eventPayload(ts: number, dev: Row, uid: string, card: Row | null, d: Decision, offline: boolean) {
  return {
    ts, time: fmtDt(ts), time_jalali: J.latin(jdt(ts)), org: dev.org_name, org_id: dev.org_id, door: dev.name, uid,
    name: card ? card.name : null, result: d.result, direction: d.direction || null, class_id: d.classId, offline,
  };
}

function fireWebhook(c: Ctx, payload: unknown) {
  const url = c.env.ACCESSCTL_WEBHOOK_URL;
  if (!url) return;
  // never let a webhook break the door
  c.waitUntil(fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    .then((r) => r.body?.cancel())
    .catch((e) => console.warn("webhook failed:", e)));
}

function eventFilters(c: Ctx, args: URLSearchParams): [string, unknown[]] {
  const where = ["e.org_id = ?"], params: unknown[] = [oid(c)];
  const q = (args.get("q") || "").trim();
  if (q) {
    where.push("(e.name LIKE ? OR e.uid LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (args.get("result")) {
    where.push("e.result = ?");
    params.push(args.get("result"));
  }
  if (args.get("door")) {
    where.push("e.device_id = ?");
    params.push(args.get("door"));
  }
  if (args.get("class")) {
    where.push("e.class_id = ?");
    params.push(args.get("class"));
  }
  const from = J.parse(args.get("from")), to = J.parse(args.get("to"));
  if (from) {
    where.push("e.ts >= ?");
    params.push(dayBounds(from)[0]);
  }
  if (to) {
    where.push("e.ts < ?");
    params.push(dayBounds(to)[1]);
  }
  return [where.join(" AND "), params];
}

async function kioskDoor(c: Ctx, token: string): Promise<Row> {
  const p = await kioskPayload(c.env.SECRET_KEY, token);
  const dev = p ? await first(c.db, "SELECT * FROM devices WHERE id = ?", p.d) : null;
  if (!p || !dev || !(await kioskMatches(p, dev))) abort(404);
  return dev!;
}

/** New scans for the live screen. ?init=1 -> the latest few; ?after=<id> -> newer ones. */
async function liveEvents(c: Ctx, orgId: number, doorId: number) {
  let where = "e.offline = 0 AND e.org_id = ?";
  const params: unknown[] = [orgId];
  if (doorId) {
    where += " AND e.device_id = ?";
    params.push(doorId);
  }
  let rows: Row[];
  if (c.url.searchParams.get("init")) {
    rows = (await all(c.db, EVENT_SELECT + `WHERE ${where} ORDER BY e.id DESC LIMIT 8`, ...params)).reverse();
  } else {
    rows = await all(c.db, EVENT_SELECT + `WHERE ${where} AND e.id > ? ORDER BY e.id LIMIT 20`,
      ...params, intArg(c.url.searchParams.get("after")));
  }
  const cutoff = now() - ONLINE_WINDOW;
  const doors = await all(c.db, "SELECT id, name, last_seen FROM devices WHERE org_id = ? ORDER BY name", orgId);
  return json({
    events: rows.map((r) => ({
      id: r.id, name: r.name, uid: r.uid, result: r.result, direction: r.direction, door: r.door || "", class: r.class_name || "",
      time: jtime(r.ts, true), date: jdate(r.ts),
    })),
    doors: doors.filter((d) => !doorId || d.id === doorId)
      .map((d) => ({ id: d.id, name: d.name, online: Boolean(d.last_seen && d.last_seen >= cutoff) })),
  });
}

function livePage(v: { kiosk: boolean; doors: Row[]; doorId: number; feedUrl: string; pollMs: number }) {
  const doorBlock = v.kiosk
    ? `<span>${esc(v.doors[0].name)}</span>`
    : `<select id="doorSel" aria-label="در">
        <option value="">همه درها</option>
        ${v.doors.map((d) => `<option value="${d.id}" ${d.id === v.doorId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
      </select>`;
  const js = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");
  let out = liveTemplate
    .replace("__DOOR_BLOCK__", () => doorBlock)
    .replace("__FEED__", () => js(v.feedUrl))
    .replace("__KIOSK__", () => js(v.kiosk))
    .replace("__POLL_MS__", () => String(v.pollMs));
  out = v.kiosk ? out.replace(/__DASH_OPEN__[\s\S]*?__DASH_CLOSE__/, "") : out.replace("__DASH_OPEN__", "").replace("__DASH_CLOSE__", "");
  return page(out);
}

const pollMs = (c: Ctx) => Math.max(1000, intArg(c.env.LIVE_POLL_MS, 3000));

/** First run: create 'admin' from the ADMIN_PASSWORD secret. */
async function ensureAdmin(c: Ctx): Promise<boolean> {
  const n = await first(c.db, "SELECT COUNT(*) AS n FROM users");
  if (n && n.n > 0) return true;
  if (!c.env.ADMIN_PASSWORD) return false;
  await run(c.db, "INSERT OR IGNORE INTO users(username, pw_hash, org_id) VALUES ('admin', ?, NULL)", await hashPassword(c.env.ADMIN_PASSWORD));
  return true;
}

// --- device API (used by the Wemos firmware and the Android app) ---------------------

async function apiScan(c: Ctx) {
  const dev = await deviceFromKey(c);
  const body: any = await c.req.json().catch(() => ({}));
  const uid = normalizeUid(body?.uid);
  if (!uid) return json({ error: "invalid uid" }, 400);

  const card = await first(c.db, "SELECT * FROM cards WHERE org_id = ? AND uid = ?", dev.org_id, uid);
  const ts = now();
  const d = await decide(c.db, dev, Boolean(dev.org_enabled), card, ts);
  await c.db.batch([
    touchDevice(c, dev),
    addEvent(c.db, { orgId: dev.org_id, ts, deviceId: dev.id, uid, card, ...d }),
  ]);
  fireWebhook(c, eventPayload(ts, dev, uid, card, d, false));
  return json({ granted: d.result === "granted", result: d.result, name: card ? card.name : "", direction: d.direction, open_ms: dev.open_ms });
}

async function apiSync(c: Ctx) {
  const dev = await deviceFromKey(c);
  const body: any = await c.req.json().catch(() => ({}));
  const writes = [touchDevice(c, dev, String(body?.fw ?? "").slice(0, 16) || null)];

  // events the device decided on its own while we were unreachable (Wemos offline fallback)
  for (const ev of Array.isArray(body?.events) ? body.events : []) {
    const uid = normalizeUid(ev?.uid);
    if (!uid) continue;
    const ts = Math.trunc(Number(ev.ts) || 0) || now();   // 0 = device had no clock yet
    const card = await first(c.db, "SELECT * FROM cards WHERE org_id = ? AND uid = ?", dev.org_id, uid);
    const result = ["granted", "denied", "unknown"].includes(ev.result) ? ev.result : "denied";
    const direction = ["in", "out"].includes(ev.direction) ? ev.direction : "";
    const d: Decision = { result, direction, classId: null, slotId: null, sessionDate: null };
    // count it for a class if a member scanned during a session
    if (card && result === "granted") {
      for (const x of await activeSlots(c.db, dev.id, ts)) {
        if (await isMember(c.db, x.classId, card.id)) {
          Object.assign(d, { classId: x.classId, slotId: x.slotId, sessionDate: x.sessionDate });
          break;
        }
      }
    }
    writes.push(addEvent(c.db, { orgId: dev.org_id, ts, deviceId: dev.id, uid, card, offline: true, ...d }));
    fireWebhook(c, eventPayload(ts, dev, uid, card, d, true));
  }

  const openNow = Boolean(dev.pending_open);
  if (openNow) writes.push(stmt(c.db, "UPDATE devices SET pending_open = 0 WHERE id = ?", dev.id));
  await c.db.batch(writes);
  return json({ time: now(), cards_version: await cardsVersion(c.db), open: openNow, open_ms: dev.open_ms });
}

/** Offline cache for the device: uid \t enabled \t inside \t name, valid cards only. */
async function apiCards(c: Ctx) {
  const dev = await deviceFromKey(c);
  const day = today();
  const lines = !dev.org_enabled ? [] : (await cardsWithPresence(c.db, "c.org_id = ?", dev.org_id))
    .filter((k) => cardValid(k, day) === "ok")
    .map((k) => `${k.uid}\t1\t${k.last_dir === "in" ? 1 : 0}\t${k.name}`);
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/tab-separated-values" } });
}

// Live-screen link for this door; the Android app shows it full screen.
async function apiKiosk(c: Ctx) {
  const dev = await deviceFromKey(c);
  return json({ name: dev.name, url: `/kiosk/${await kioskToken(c.env.SECRET_KEY, dev as { id: number; key: string })}` });
}

// --- integration API (read-only, Bearer token, all companies; ?org=<id> to filter) -----

async function apiPresence(c: Ctx) {
  requireToken(c);
  const org = intArg(c.url.searchParams.get("org"));
  const rows = org ? await cardsWithPresence(c.db, "c.org_id = ?", org) : await cardsWithPresence(c.db);
  return json(rows.map((k) => ({ org_id: k.org_id, name: k.name, uid: k.uid, inside: k.last_dir === "in", last_seen: k.last_ts })));
}

async function apiEvents(c: Ctx) {
  requireToken(c);
  const since = intArg(c.url.searchParams.get("since"));
  const org = intArg(c.url.searchParams.get("org"));
  const rows = org
    ? await all(c.db, EVENT_SELECT + "WHERE e.id > ? AND e.org_id = ? ORDER BY e.id LIMIT 1000", since, org)
    : await all(c.db, EVENT_SELECT + "WHERE e.id > ? ORDER BY e.id LIMIT 1000", since);
  return json(rows);
}

// --- auth ---------------------------------------------------------------------------

async function login(c: Ctx) {
  if (!(await ensureAdmin(c))) {
    c.session.flash("هنوز کاربری وجود ندارد. secret با نام ADMIN_PASSWORD را تنظیم کنید یا scripts/set-password.mjs را اجرا کنید.", "error");
  } else if (c.req.method === "POST") {
    const u = await first(c.db, "SELECT u.*, o.enabled AS org_enabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.username = ?",
      formStr(c, "username"));
    if (u && (await checkPassword(u.pw_hash, formStr(c, "password")))) {
      if (u.org_id && !u.org_enabled) {
        c.session.flash("حساب سازمان شما غیرفعال شده است.", "error");
        return page(V.loginPage(pageCtx(c)));
      }
      c.session.clear();
      c.session.set("uid", u.id);
      c.session.set("user", u.username);
      const nxt = c.url.searchParams.get("next") || "";
      if (nxt.startsWith("/") && !nxt.startsWith("//")) return redirect(nxt);
      return redirect(u.org_id === null ? "/admin" : "/");
    }
    await new Promise((r) => setTimeout(r, 1000));
    c.session.flash("نام کاربری یا رمز عبور اشتباه است.", "error");
  }
  return page(V.loginPage(pageCtx(c)));
}

function logout(c: Ctx) {
  c.session.clear();
  return redirect("/login");
}

// --- live screen ----------------------------------------------------------------------

async function live(c: Ctx) {
  const doors = await all(c.db, "SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", oid(c));
  const doorId = intArg(c.url.searchParams.get("door"));
  return livePage({ kiosk: false, doors, doorId, feedUrl: doorId ? `/live/feed?door=${doorId}` : "/live/feed", pollMs: pollMs(c) });
}

async function liveFeed(c: Ctx) {
  if (!c.user || !c.org) return json({ error: "login required" }, 401);
  return liveEvents(c, oid(c), intArg(c.url.searchParams.get("door")));
}

async function kiosk(c: Ctx, token: string) {
  const dev = await kioskDoor(c, token);
  return livePage({ kiosk: true, doors: [dev], doorId: dev.id, feedUrl: `/kiosk/${token}/feed`, pollMs: pollMs(c) });
}

async function kioskFeed(c: Ctx, token: string) {
  const dev = await kioskDoor(c, token);
  return liveEvents(c, dev.org_id, dev.id);
}

// --- dashboard -------------------------------------------------------------------------

async function dashboard(c: Ctx) {
  const [start, end] = dayBounds(today());
  const o = oid(c);
  const [cards, stats, recent, unknown, doors, classes] = await Promise.all([
    cardsWithPresence(c.db, "c.org_id = ?", o),
    first(c.db, "SELECT SUM(result = 'granted') AS granted, SUM(result != 'granted') AS denied FROM events WHERE org_id = ? AND ts >= ? AND ts < ?", o, start, end),
    all(c.db, EVENT_SELECT + "WHERE e.org_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 15", o),
    all(c.db,
      `SELECT e.uid, MAX(e.ts) AS ts, COUNT(*) AS n, d.name AS door FROM events e
       LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.org_id = ? AND e.result = 'unknown' AND e.ts > ? AND e.uid NOT IN (SELECT uid FROM cards WHERE org_id = ?)
       GROUP BY e.uid ORDER BY ts DESC LIMIT 10`, o, now() - 7 * 86400, o),
    all(c.db, "SELECT * FROM devices WHERE org_id = ? ORDER BY name", o),
    all(c.db, "SELECT * FROM classes WHERE org_id = ? ORDER BY name", o),
  ]);
  // class sessions running right now
  const running: V.Running[] = [];
  const t = now(), d = today();
  for (const k of classes) {
    for (const s of await classSessions(c.db, k, d, d)) {
      if (s.start - EARLY_MIN * 60 <= t && t < s.end) {
        const rep = await sessionReport(c.db, k, s.slot, s.date, t);
        running.push({ cls: k, s, here: rep.rows.filter((r) => r.open).length, members: rep.rows.length });
      }
    }
  }
  return page(V.dashboardPage(pageCtx(c), {
    cards, inside: cards.filter((k) => k.last_dir === "in"), stats, recent, unknown, doors, running, onlineAfter: now() - ONLINE_WINDOW,
  }));
}

// --- cards ----------------------------------------------------------------------------------

async function cardsList(c: Ctx) {
  const q = (c.url.searchParams.get("q") || "").trim();
  const rows = q
    ? await cardsWithPresence(c.db, "c.org_id = ? AND (c.name LIKE ? OR c.uid LIKE ? OR c.note LIKE ?)", oid(c), `%${q}%`, `%${q}%`, `%${q}%`)
    : await cardsWithPresence(c.db, "c.org_id = ?", oid(c));
  return page(V.cardsPage(pageCtx(c), { cards: rows, q, today: today() }));
}

function formAsRow(c: Ctx): Row {
  const r: Row = {};
  c.form?.forEach((v, k) => { if (typeof v === "string") r[k] = v; });
  return r;
}

async function saveCard(c: Ctx, cardId: number | null): Promise<boolean> {
  const uid = normalizeUid(formStr(c, "uid"));
  const name = cleanName(formStr(c, "name"));
  const note = Array.from(formStr(c, "note").trim()).slice(0, 200).join("");
  const enabled = formStr(c, "enabled") ? 1 : 0;
  const validRaw = formStr(c, "valid_until").trim();
  const validUntil = J.parse(validRaw);
  if (!uid) {
    c.session.flash("شناسه کارت نامعتبر است. به صورت هگز وارد کنید، مثلاً 04:A3:1B:2C", "error");
    return false;
  }
  if (!name) {
    c.session.flash("نام الزامی است.", "error");
    return false;
  }
  if (validRaw && !validUntil) {
    c.session.flash("تاریخ اعتبار نامعتبر است (مثال: 1405/12/29).", "error");
    return false;
  }
  const clash = await first(c.db, "SELECT id, name FROM cards WHERE org_id = ? AND uid = ? AND id IS NOT ?", oid(c), uid, cardId);
  if (clash) {
    c.session.flash(`این کارت قبلاً برای «${clash.name}» ثبت شده است.`, "error");
    return false;
  }
  const write = cardId
    ? stmt(c.db, "UPDATE cards SET uid=?, name=?, note=?, enabled=?, valid_until=? WHERE id=? AND org_id=?",
      uid, name, note, enabled, validUntil, cardId, oid(c))
    : stmt(c.db, "INSERT INTO cards(org_id, uid, name, note, enabled, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      oid(c), uid, name, note, enabled, validUntil, now());
  await c.db.batch([write, bumpCardsRev(c.db)]);
  c.session.flash(`«${name}» ذخیره شد.`, "ok");
  return true;
}

async function cardNew(c: Ctx) {
  if (c.req.method === "POST" && (await saveCard(c, null))) return redirect("/cards");
  const card = c.req.method === "POST" ? formAsRow(c) : { uid: normalizeUid(c.url.searchParams.get("uid")), enabled: 1 };
  return page(V.cardFormPage(pageCtx(c), { card, isNew: true }));
}

async function cardEdit(c: Ctx, id: number) {
  let card = await ownRow(c, "cards", id);
  if (c.req.method === "POST") {
    if (await saveCard(c, id)) return redirect("/cards");
    card = formAsRow(c);
  }
  const [history, classes] = await Promise.all([
    all(c.db, EVENT_SELECT + "WHERE e.card_id = ? ORDER BY e.ts DESC LIMIT 30", id),
    all(c.db, "SELECT k.* FROM classes k JOIN class_members m ON m.class_id = k.id WHERE m.card_id = ? ORDER BY k.name", id),
  ]);
  return page(V.cardFormPage(pageCtx(c), { card, isNew: false, cardId: id, history, classes }));
}

async function cardToggle(c: Ctx, id: number) {
  await ownRow(c, "cards", id);
  await c.db.batch([stmt(c.db, "UPDATE cards SET enabled = 1 - enabled WHERE id = ?", id), bumpCardsRev(c.db)]);
  return back(c, "/cards");
}

async function cardDelete(c: Ctx, id: number) {
  await ownRow(c, "cards", id);
  await c.db.batch([stmt(c.db, "DELETE FROM cards WHERE id = ?", id), bumpCardsRev(c.db)]);
  c.session.flash("کارت حذف شد. سوابق تردد آن حفظ می‌شود.", "ok");
  return redirect("/cards");
}

// --- doors (devices) ------------------------------------------------------------------------

async function doors(c: Ctx) {
  const rows = await all(c.db, "SELECT * FROM devices WHERE org_id = ? ORDER BY name", oid(c));
  const kioskLinks: Record<number, string> = {};
  for (const d of rows) kioskLinks[d.id] = `/kiosk/${await kioskToken(c.env.SECRET_KEY, d as { id: number; key: string })}`;
  return page(V.doorsPage(pageCtx(c), {
    doors: rows, onlineAfter: now() - ONLINE_WINDOW, newKey: c.session.popNewKey(), kioskLinks, origin: c.url.origin,
  }));
}

function doorFormValues(c: Ctx) {
  const dir = formStr(c, "direction");
  return {
    name: cleanName(formStr(c, "name")),
    direction: ["in", "out", "toggle"].includes(dir) ? dir : "toggle",
    open_ms: Math.max(500, Math.min(30000, intArg(formStr(c, "open_ms"), 3000) || 3000)),
    enabled: formStr(c, "enabled") ? 1 : 0,
  };
}

async function doorNew(c: Ctx) {
  const v = doorFormValues(c);
  if (!v.name) {
    c.session.flash("نام در الزامی است.", "error");
    return redirect("/doors");
  }
  const key = randomToken(18);
  try {
    await run(c.db, "INSERT INTO devices(org_id, name, key, direction, open_ms, enabled) VALUES (?, ?, ?, ?, ?, 1)",
      oid(c), v.name, key, v.direction, v.open_ms);
  } catch (e) {
    if (!isUniqueError(e)) throw e;
    c.session.flash("دری با این نام وجود دارد.", "error");
    return redirect("/doors");
  }
  c.session.set("new_key", { name: v.name, key });
  return redirect("/doors");
}

async function doorEdit(c: Ctx, id: number) {
  await ownRow(c, "devices", id);
  const v = doorFormValues(c);
  try {
    await run(c.db, "UPDATE devices SET name=?, direction=?, open_ms=?, enabled=? WHERE id=?", v.name, v.direction, v.open_ms, v.enabled, id);
    c.session.flash(`«${v.name}» ذخیره شد.`, "ok");
  } catch (e) {
    if (!isUniqueError(e)) throw e;
    c.session.flash("دری با این نام وجود دارد.", "error");
  }
  return redirect("/doors");
}

async function doorOpen(c: Ctx, id: number) {
  const dev = await ownRow(c, "devices", id);
  await c.db.batch([
    stmt(c.db, "UPDATE devices SET pending_open = 1 WHERE id = ?", id),
    stmt(c.db, "INSERT INTO events(org_id, ts, device_id, uid, name, result) VALUES (?, ?, ?, '-', ?, 'manual')",
      oid(c), now(), id, `پنل: ${c.user!.username}`),
  ]);
  c.session.flash(`«${dev.name}» تا چند ثانیه دیگر باز می‌شود.`, "ok");
  return back(c, "/doors");
}

async function doorRekey(c: Ctx, id: number) {
  const dev = await ownRow(c, "devices", id);
  const key = randomToken(18);
  await run(c.db, "UPDATE devices SET key = ? WHERE id = ?", key, id);
  c.session.set("new_key", { name: dev.name, key });
  return redirect("/doors");
}

async function doorDelete(c: Ctx, id: number) {
  await ownRow(c, "devices", id);
  await run(c.db, "DELETE FROM devices WHERE id = ?", id);
  c.session.flash("در حذف شد. سوابق تردد آن حفظ می‌شود؛ زمان‌بندی کلاس‌های این در حذف شد.", "ok");
  return redirect("/doors");
}

// --- classes ------------------------------------------------------------------------------

async function classesList(c: Ctx) {
  if (c.req.method === "POST") {
    const name = cleanName(formStr(c, "name"), 60);
    if (!name) {
      c.session.flash("نام کلاس الزامی است.", "error");
    } else {
      try {
        const r = await run(c.db, "INSERT INTO classes(org_id, name, note, created_at) VALUES (?, ?, ?, ?)",
          oid(c), name, Array.from(formStr(c, "note").trim()).slice(0, 200).join(""), now());
        return redirect(`/classes/${r.meta.last_row_id}`);
      } catch (e) {
        if (!isUniqueError(e)) throw e;
        c.session.flash("کلاسی با این نام وجود دارد.", "error");
      }
    }
    return redirect("/classes");
  }
  const [rows, slots] = await Promise.all([
    all(c.db,
      `SELECT k.*, (SELECT COUNT(*) FROM class_members m WHERE m.class_id = k.id) AS members
       FROM classes k WHERE k.org_id = ? ORDER BY k.name COLLATE NOCASE`, oid(c)),
    all(c.db,
      `SELECT s.*, d.name AS door FROM class_slots s JOIN classes k ON k.id = s.class_id
       LEFT JOIN devices d ON d.id = s.device_id WHERE k.org_id = ? ORDER BY s.on_date, s.weekday, s.start_min`, oid(c)),
  ]);
  const byClass = new Map<number, Row[]>();
  for (const s of slots) byClass.set(s.class_id, [...(byClass.get(s.class_id) || []), s]);
  return page(V.classesPage(pageCtx(c), { classes: rows, slots: byClass }));
}

function rangeArgs(c: Ctx): [string, string] {
  const last = J.parse(c.url.searchParams.get("to")) || today();
  const firstDay = J.parse(c.url.searchParams.get("from")) || J.addDays(last, -29);
  return firstDay <= last ? [firstDay, last] : [last, firstDay];
}

async function classView(c: Ctx, id: number) {
  const cls = await ownRow(c, "classes", id);
  const [firstDay, last] = rangeArgs(c);
  const sessions = await classSessions(c.db, cls, firstDay, last);
  const [[summary, counts], slots, cards, doorList] = await Promise.all([
    classSummary(c.db, cls, sessions),
    all(c.db, "SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id WHERE s.class_id = ? ORDER BY s.on_date, s.weekday, s.start_min", id),
    all(c.db,
      `SELECT c.*, EXISTS(SELECT 1 FROM class_members m WHERE m.class_id = ? AND m.card_id = c.id) AS member
       FROM cards c WHERE c.org_id = ? ORDER BY c.name COLLATE NOCASE`, id, oid(c)),
    all(c.db, "SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", oid(c)),
  ]);
  return page(V.classPage(pageCtx(c), {
    cls, sessions: sessions.map((s, i) => [s, counts[i]]), summary, slots, cards, doors: doorList,
    first: firstDay, last, nMembers: cards.filter((k) => k.member).length,
  }));
}

async function classCsv(c: Ctx, id: number) {
  const cls = await ownRow(c, "classes", id);
  const [firstDay, last] = rangeArgs(c);
  const sessions = await classSessions(c.db, cls, firstDay, last);
  const [summary] = await classSummary(c.db, cls, sessions);
  const lines: unknown[][] = [
    ["کلاس", "از", "تا", "تعداد جلسات"], [cls.name, J.jstr(firstDay), J.jstr(last), sessions.length], [],
    ["نام", "شناسه کارت", "جلسات حاضر", "مجموع حضور (دقیقه)", "درصد حضور"],
    ...summary.map((t) => [t.card.name, t.card.uid, t.attended, Math.floor(t.secs / 60), t.pct]),
  ];
  const body = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=class-${id}.csv` },
  });
}

async function classEdit(c: Ctx, id: number) {
  await ownRow(c, "classes", id);
  const name = cleanName(formStr(c, "name"), 60);
  if (!name) c.session.flash("نام کلاس الزامی است.", "error");
  else {
    try {
      await run(c.db, "UPDATE classes SET name = ?, note = ? WHERE id = ?", name, Array.from(formStr(c, "note").trim()).slice(0, 200).join(""), id);
      c.session.flash("ذخیره شد.", "ok");
    } catch (e) {
      if (!isUniqueError(e)) throw e;
      c.session.flash("کلاسی با این نام وجود دارد.", "error");
    }
  }
  return redirect(`/classes/${id}`);
}

async function classMembers(c: Ctx, id: number) {
  await ownRow(c, "classes", id);
  const chosen = new Set((c.form?.getAll("card") || []).map((x) => intArg(String(x))).filter((x) => x > 0));
  const valid = (await all(c.db, "SELECT id FROM cards WHERE org_id = ?", oid(c))).map((r) => r.id as number).filter((x) => chosen.has(x));
  await c.db.batch([
    stmt(c.db, "DELETE FROM class_members WHERE class_id = ?", id),
    ...valid.map((cardId) => stmt(c.db, "INSERT INTO class_members(class_id, card_id) VALUES (?, ?)", id, cardId)),
  ]);
  c.session.flash(`اعضای کلاس ذخیره شد (${J.fa(valid.length)} نفر).`, "ok");
  return redirect(`/classes/${id}`);
}

/** '10:30' / '۱۰:۳۰' / '9' -> minutes after midnight, or null. */
function parseHm(s: string): number | null {
  const m = J.latin(s.trim()).replace(/[٫.]/g, ":").match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

async function classSlotAdd(c: Ctx, id: number) {
  await ownRow(c, "classes", id);
  const dev = await first(c.db, "SELECT id FROM devices WHERE id = ? AND org_id = ?", intArg(formStr(c, "device")), oid(c));
  const start = parseHm(formStr(c, "start")), end = parseHm(formStr(c, "end"));
  const kind = formStr(c, "kind");
  let err = "";
  let rows: unknown[][] = [];
  if (!dev) err = "دستگاه را انتخاب کنید.";
  else if (start === null || end === null || end <= start) err = "ساعت شروع و پایان را درست وارد کنید (مثال ۱۰:۳۰ تا ۱۲:۰۰؛ پایان بعد از شروع).";
  else if (kind === "once") {
    const d = J.parse(formStr(c, "on_date"));
    if (!d) err = "تاریخ جلسه را وارد کنید (مثال ۱۴۰۵/۰۸/۲۰).";
    else rows = [[null, d, null, null]];
  } else {
    const days = (c.form?.getAll("weekday") || []).map((x) => intArg(String(x), -1)).filter((x) => x >= 0 && x <= 6);
    const fromRaw = formStr(c, "from_date"), toRaw = formStr(c, "to_date");
    const fd = J.parse(fromRaw), td = J.parse(toRaw);
    if (!days.length) err = "حداقل یک روز هفته را انتخاب کنید.";
    else if ((fromRaw && !fd) || (toRaw && !td)) err = "تاریخ شروع یا پایان دوره نامعتبر است.";
    // without a start date the schedule starts today (no sessions before the class existed)
    else rows = days.map((w) => [w, null, fd || today(), td]);
  }
  if (err) {
    c.session.flash(err, "error");
    return redirect(`/classes/${id}`);
  }
  await c.db.batch(rows.map(([w, onDate, fromDate, toDate]) => stmt(c.db,
    `INSERT INTO class_slots(class_id, device_id, weekday, on_date, start_min, end_min, from_date, to_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, dev!.id, w, onDate, start, end, fromDate, toDate)));
  c.session.flash("زمان‌بندی اضافه شد.", "ok");
  return redirect(`/classes/${id}`);
}

async function classSlotDelete(c: Ctx, id: number, slotId: number) {
  await ownRow(c, "classes", id);
  await run(c.db, "DELETE FROM class_slots WHERE id = ? AND class_id = ?", slotId, id);
  c.session.flash("زمان‌بندی حذف شد. ترددهای ثبت‌شده باقی می‌مانند.", "ok");
  return redirect(`/classes/${id}`);
}

async function classDelete(c: Ctx, id: number) {
  const cls = await ownRow(c, "classes", id);
  await run(c.db, "DELETE FROM classes WHERE id = ?", id);
  c.session.flash(`کلاس «${cls.name}» حذف شد.`, "ok");
  return redirect("/classes");
}

async function classSession(c: Ctx, id: number, slotId: number, day: string) {
  const cls = await ownRow(c, "classes", id);
  const slot = await first(c.db, "SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id WHERE s.id = ? AND s.class_id = ?", slotId, id);
  if (!slot || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !slotOn(slot, day)) abort(404);
  const t = now();
  const rep = await sessionReport(c.db, cls, slot!, day, t);
  return page(V.classSessionPage(pageCtx(c), { cls, slot: slot!, day, now: t, rep }));
}

// --- events / reports ----------------------------------------------------------------------

async function events(c: Ctx) {
  const [where, params] = eventFilters(c, c.url.searchParams);
  const pageNo = Math.max(1, intArg(c.url.searchParams.get("page"), 1));
  const [total, rows, doorList, classList] = await Promise.all([
    first(c.db, `SELECT COUNT(*) AS n FROM events e WHERE ${where}`, ...params),
    all(c.db, EVENT_SELECT + `WHERE ${where} ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?`, ...params, PAGE_SIZE, (pageNo - 1) * PAGE_SIZE),
    all(c.db, "SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", oid(c)),
    all(c.db, "SELECT id, name FROM classes WHERE org_id = ? ORDER BY name", oid(c)),
  ]);
  const args: Record<string, string> = {};
  c.url.searchParams.forEach((v, k) => { if (k !== "page") args[k] = v; });
  const n = total?.n || 0;
  return page(V.eventsPage(pageCtx(c), {
    rows, total: n, page: pageNo, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)), doors: doorList, classes: classList, args,
  }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function eventsCsv(c: Ctx) {
  const [where, params] = eventFilters(c, c.url.searchParams);
  const rows = await all(c.db, EVENT_SELECT + `WHERE ${where} ORDER BY e.ts`, ...params);
  const lines = [["تاریخ", "ساعت", "نام", "شناسه کارت", "در", "کلاس", "نتیجه", "جهت", "آفلاین", "تاریخ میلادی"]];
  for (const r of rows) {
    const day = localDate(r.ts);
    lines.push([J.jstr(day), fmtDt(r.ts).slice(11), r.name, r.uid, r.door || "", r.class_name || "",
      V.RESULT_FA[r.result] || r.result, V.DIR_FA[r.direction] || "", r.offline ? "بله" : "", day]);
  }
  // BOM so Excel shows Persian text correctly
  const body = "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=access-events.csv" },
  });
}

async function attendance(c: Ctx) {
  const day = J.parse(c.url.searchParams.get("date")) || today();
  const [start, end] = dayBounds(day);
  const rows = await all(c.db,
    `SELECT c.id, c.name, c.uid,
       MIN(CASE WHEN e.direction = 'in'  THEN e.ts END) AS first_in,
       MAX(CASE WHEN e.direction = 'out' THEN e.ts END) AS last_out,
       MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen, COUNT(*) AS scans
     FROM events e JOIN cards c ON c.id = e.card_id
     WHERE e.org_id = ? AND e.result = 'granted' AND e.ts >= ? AND e.ts < ?
     GROUP BY c.id ORDER BY first_seen`, oid(c), start, end);
  return page(V.attendancePage(pageCtx(c), { rows, day, prev: J.addDays(day, -1), next: J.addDays(day, 1) }));
}

// --- settings (per company) -------------------------------------------------------------

async function changeOwnPassword(c: Ctx) {
  const pw = formStr(c, "new");
  if (!(await checkPassword(c.user!.pw_hash, formStr(c, "current")))) c.session.flash("رمز فعلی اشتباه است.", "error");
  else if (!validPassword(pw)) c.session.flash("رمز جدید باید حداقل ۸ کاراکتر باشد.", "error");
  else {
    await run(c.db, "UPDATE users SET pw_hash = ? WHERE id = ?", await hashPassword(pw), c.user!.id);
    c.session.flash("رمز عبور تغییر کرد.", "ok");
  }
}

async function addUser(c: Ctx, orgId: number | null): Promise<boolean> {
  const name = formStr(c, "username").trim(), pw = formStr(c, "password");
  if (!name || !validPassword(pw)) {
    c.session.flash("نام کاربری و رمز حداقل ۸ کاراکتری الزامی است.", "error");
    return false;
  }
  try {
    await run(c.db, "INSERT INTO users(username, pw_hash, org_id) VALUES (?, ?, ?)", name, await hashPassword(pw), orgId);
    c.session.flash(`کاربر «${name}» اضافه شد.`, "ok");
    return true;
  } catch (e) {
    if (!isUniqueError(e)) throw e;
    c.session.flash("این نام کاربری قبلاً استفاده شده است.", "error");
    return false;
  }
}

async function settings(c: Ctx) {
  if (c.req.method === "POST") {
    const action = formStr(c, "action");
    if (action === "password") await changeOwnPassword(c);
    else if (action === "add_user") await addUser(c, oid(c));
    else if (action === "del_user") {
      const id = intArg(formStr(c, "id"));
      const n = await first(c.db, "SELECT COUNT(*) AS n FROM users WHERE org_id = ?", oid(c));
      if ((n?.n || 0) <= 1 && !c.owner) c.session.flash("آخرین کاربر سازمان قابل حذف نیست.", "error");
      else if (id === c.user!.id) c.session.flash("کاربر فعلی را نمی‌توانید حذف کنید.", "error");
      else {
        await run(c.db, "DELETE FROM users WHERE id = ? AND org_id = ?", id, oid(c));
        c.session.flash("کاربر حذف شد.", "ok");
      }
    } else if (action === "purge") {
      const days = intArg(formStr(c, "days"));
      if (days >= 1) {
        const r = await run(c.db, "DELETE FROM events WHERE org_id = ? AND ts < ?", oid(c), now() - days * 86400);
        c.session.flash(`${J.fa(r.meta.changes)} رویداد قدیمی‌تر از ${J.fa(days)} روز حذف شد.`, "ok");
      }
    }
    return redirect("/settings");
  }
  const [users, n] = await Promise.all([
    all(c.db, "SELECT id, username FROM users WHERE org_id = ? ORDER BY username", oid(c)),
    first(c.db, "SELECT COUNT(*) AS n FROM events WHERE org_id = ?", oid(c)),
  ]);
  return page(V.settingsPage(pageCtx(c), { users, nEvents: n?.n || 0 }));
}

// --- server owner: companies and their users ----------------------------------------------

async function admin(c: Ctx) {
  if (c.req.method === "POST") {
    const action = formStr(c, "action");
    const orgId = intArg(formStr(c, "org"));
    if (action === "new_org") {
      const name = cleanName(formStr(c, "name"), 60);
      const username = formStr(c, "username").trim();
      if (!name) c.session.flash("نام سازمان الزامی است.", "error");
      else if (!username || !validPassword(formStr(c, "password"))) c.session.flash("برای سازمان یک نام کاربری و رمز حداقل ۸ کاراکتری وارد کنید.", "error");
      else if (await first(c.db, "SELECT 1 AS x FROM users WHERE username = ?", username)) c.session.flash("این نام کاربری قبلاً استفاده شده است.", "error");
      else {
        try {
          const r = await run(c.db, "INSERT INTO orgs(name, enabled, created_at) VALUES (?, 1, ?)", name, now());
          if (await addUser(c, r.meta.last_row_id)) c.session.flash(`سازمان «${name}» ساخته شد.`, "ok");
        } catch (e) {
          if (!isUniqueError(e)) throw e;
          c.session.flash("سازمانی با این نام وجود دارد.", "error");
        }
      }
    } else if (action === "rename") {
      const name = cleanName(formStr(c, "name"), 60);
      try {
        if (name) await run(c.db, "UPDATE orgs SET name = ? WHERE id = ?", name, orgId);
      } catch (e) {
        if (!isUniqueError(e)) throw e;
        c.session.flash("سازمانی با این نام وجود دارد.", "error");
      }
    } else if (action === "toggle") {
      await run(c.db, "UPDATE orgs SET enabled = 1 - enabled WHERE id = ?", orgId);
    } else if (action === "delete") {
      const org = await first(c.db, "SELECT * FROM orgs WHERE id = ?", orgId);
      if (org && formStr(c, "confirm").trim() === org.name) {
        await run(c.db, "DELETE FROM orgs WHERE id = ?", orgId);
        if (c.session.data.view_org === orgId) c.session.set("view_org", undefined);
        c.session.flash(`سازمان «${org.name}» و همه داده‌های آن حذف شد.`, "ok");
      } else c.session.flash("برای حذف، نام سازمان را دقیقاً وارد کنید.", "error");
    } else if (action === "add_user") {
      if (await first(c.db, "SELECT 1 AS x FROM orgs WHERE id = ?", orgId)) await addUser(c, orgId);
    } else if (action === "add_owner") {
      await addUser(c, null);
    } else if (action === "reset_pw") {
      const pw = formStr(c, "password");
      if (!validPassword(pw)) c.session.flash("رمز باید حداقل ۸ کاراکتر باشد.", "error");
      else {
        await run(c.db, "UPDATE users SET pw_hash = ? WHERE id = ?", await hashPassword(pw), intArg(formStr(c, "id")));
        c.session.flash("رمز عبور تغییر کرد.", "ok");
      }
    } else if (action === "del_user") {
      const id = intArg(formStr(c, "id"));
      const u = await first(c.db, "SELECT * FROM users WHERE id = ?", id);
      const owners = await first(c.db, "SELECT COUNT(*) AS n FROM users WHERE org_id IS NULL");
      if (!u || id === c.user!.id) c.session.flash("کاربر فعلی را نمی‌توانید حذف کنید.", "error");
      else if (u.org_id === null && (owners?.n || 0) <= 1) c.session.flash("آخرین مدیر سرور قابل حذف نیست.", "error");
      else {
        await run(c.db, "DELETE FROM users WHERE id = ?", id);
        c.session.flash(`کاربر «${u.username}» حذف شد.`, "ok");
      }
    } else if (action === "password") {
      await changeOwnPassword(c);
    }
    return redirect("/admin");
  }
  const [orgs, users] = await Promise.all([
    all(c.db,
      `SELECT o.*,
         (SELECT COUNT(*) FROM devices WHERE org_id = o.id) AS n_devices,
         (SELECT COUNT(*) FROM cards WHERE org_id = o.id) AS n_cards,
         (SELECT COUNT(*) FROM classes WHERE org_id = o.id) AS n_classes,
         (SELECT MAX(ts) FROM events WHERE org_id = o.id) AS last_event
       FROM orgs o ORDER BY o.name COLLATE NOCASE`),
    all(c.db, "SELECT id, username, org_id FROM users ORDER BY username"),
  ]);
  const byOrg = new Map<number | null, Row[]>();
  for (const u of users) byOrg.set(u.org_id, [...(byOrg.get(u.org_id) || []), u]);
  return page(V.adminPage(pageCtx(c), {
    orgs, users: byOrg, apiEnabled: Boolean(c.env.ACCESSCTL_API_TOKEN), webhook: c.env.ACCESSCTL_WEBHOOK_URL || "",
  }));
}

/** Open a company's panel as the server owner. */
async function adminView(c: Ctx) {
  const orgId = intArg(formStr(c, "org"));
  if (orgId && (await first(c.db, "SELECT 1 AS x FROM orgs WHERE id = ?", orgId))) {
    c.session.set("view_org", orgId);
    return redirect("/dashboard");
  }
  c.session.set("view_org", undefined);
  return redirect("/admin");
}

// --- router -----------------------------------------------------------------------------------

type Handler = (c: Ctx, ...params: any[]) => Promise<Response> | Response;
// login = a company page (owners must pick a company first), owner = server-owner pages
type Route = { method: string; pattern: RegExp; endpoint: string; handler: Handler; auth: "login" | "owner" | "none" };

const routes: Route[] = [];
function route(method: string, path: string, endpoint: string, handler: Handler, auth: Route["auth"] = "login") {
  // '/cards/:int' -> integer param, ':token' -> any segment
  const pattern = new RegExp("^" + path.replace(/:int/g, "(\\d+)").replace(/:token/g, "([^/]+)") + "$");
  for (const m of method.split(",")) routes.push({ method: m, pattern, endpoint, handler, auth });
}

route("POST", "/api/v1/scan", "api_scan", apiScan, "none");
route("POST", "/api/v1/sync", "api_sync", apiSync, "none");
route("GET", "/api/v1/cards", "api_cards", apiCards, "none");
route("GET", "/api/v1/kiosk", "api_kiosk", apiKiosk, "none");
route("GET", "/api/v1/presence", "api_presence", apiPresence, "none");
route("GET", "/api/v1/events", "api_events", apiEvents, "none");
route("GET,POST", "/login", "login", login, "none");
route("POST", "/logout", "logout", logout, "none");
route("GET", "/", "live", live);
route("GET", "/live/feed", "live_feed", liveFeed, "none");
route("GET", "/kiosk/:token", "kiosk", kiosk, "none");
route("GET", "/kiosk/:token/feed", "kiosk_feed", kioskFeed, "none");
route("GET", "/dashboard", "dashboard", dashboard);
route("GET", "/cards", "cards", cardsList);
route("GET,POST", "/cards/new", "card_new", cardNew);
route("GET,POST", "/cards/:int", "card_edit", cardEdit);
route("POST", "/cards/:int/toggle", "card_toggle", cardToggle);
route("POST", "/cards/:int/delete", "card_delete", cardDelete);
route("GET", "/doors", "doors", doors);
route("POST", "/doors/new", "door_new", doorNew);
route("POST", "/doors/:int", "door_edit", doorEdit);
route("POST", "/doors/:int/open", "door_open", doorOpen);
route("POST", "/doors/:int/rekey", "door_rekey", doorRekey);
route("POST", "/doors/:int/delete", "door_delete", doorDelete);
route("GET", "/events", "events", events);
route("GET", "/events.csv", "events_csv", eventsCsv);
route("GET", "/attendance", "attendance", attendance);
route("GET,POST", "/classes", "classes", classesList);
route("GET", "/classes/:int", "class_view", classView);
route("GET", "/classes/:int/summary.csv", "class_csv", classCsv);
route("POST", "/classes/:int/edit", "class_edit", classEdit);
route("POST", "/classes/:int/members", "class_members", classMembers);
route("POST", "/classes/:int/slots", "class_slot_add", classSlotAdd);
route("POST", "/classes/:int/slots/:int/delete", "class_slot_delete", classSlotDelete);
route("POST", "/classes/:int/delete", "class_delete", classDelete);
route("GET", "/classes/:int/session/:int/:token", "class_session", classSession);
route("GET,POST", "/settings", "settings", settings);
route("GET,POST", "/admin", "admin", admin, "owner");
route("POST", "/admin/view", "admin_view", adminView, "owner");

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith("/api/");
  if (!env.SECRET_KEY) {
    return isApi ? json({ error: "server not configured" }, 500)
      : page(V.errorPage(500, "SECRET_KEY تنظیم نشده است: npx wrangler secret put SECRET_KEY"), 500);
  }
  setTimeZone(env.TZ);

  let match: RegExpMatchArray | null = null;
  let r: Route | undefined;
  let methodMismatch = false;
  for (const candidate of routes) {
    const m = url.pathname.match(candidate.pattern);
    if (!m) continue;
    if (candidate.method !== req.method && !(candidate.method === "GET" && req.method === "HEAD")) {
      methodMismatch = true;
      continue;
    }
    r = candidate;
    match = m;
    break;
  }
  if (!r || !match) {
    if (methodMismatch) return new Response("Method Not Allowed", { status: 405 });
    return page(V.errorPage(404, "صفحه پیدا نشد."), 404);
  }

  const session = isApi ? new Session({}, env.SECRET_KEY) : await Session.load(req, env.SECRET_KEY);
  const c: Ctx = {
    req, env, url, db: env.DB, session, user: null, owner: false, org: null,
    waitUntil: (p) => ctx.waitUntil(p), endpoint: r.endpoint,
  };

  let res: Response;
  try {
    if (req.method === "POST" && !isApi) {
      c.form = await req.formData().catch(() => new FormData());
      const token = formStr(c, "csrf");
      if (!token || !session.data.csrf || !safeEqual(token, session.data.csrf)) {
        abort(400, "نشست منقضی شده است — صفحه را دوباره بارگذاری کنید.");
      }
    }
    if (!isApi && !url.pathname.startsWith("/kiosk/")) await loadUser(c);
    if (r.auth !== "none" && !c.user) {
      res = redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
    } else if (r.auth === "login" && !c.org) {
      res = redirect("/admin");
    } else if (r.auth === "owner" && !c.owner) {
      res = page(V.errorPage(403, "این صفحه فقط برای مدیر سرور است."), 403);
    } else {
      const params = match.slice(1).map((p) => (/^\d+$/.test(p) ? Number(p) : decodeURIComponent(p)));
      res = await r.handler(c, ...params);
    }
  } catch (e) {
    if (!(e instanceof HttpError)) {
      console.error(e);
      e = new HttpError(500, "خطای داخلی سرور");
    }
    const err = e as HttpError;
    res = isApi ? json({ error: err.message || "error" }, err.status) : page(V.errorPage(err.status, err.message || "پیدا نشد."), err.status);
  }

  if (session.dirty) {
    res = new Response(res.body, res);
    res.headers.append("Set-Cookie", await session.cookie(url.protocol === "https:"));
  }
  return res;
}

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
