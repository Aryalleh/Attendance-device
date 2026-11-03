// RFID access-control server on Cloudflare Workers + D1 — port of server/app.py.
// Same device API (/api/v1/*) as the Flask server, so the Wemos firmware works with either.
import { checkPassword, hashPassword, kioskMatches, kioskPayload, kioskToken, randomToken, safeEqual, Session } from "./auth";
import {
  addEvent, all, bumpCardsRev, cardsVersion, cardsWithPresence, cardValid, cleanName, EVENT_SELECT,
  first, isUniqueError, lastDirection, normalizeUid, Row, run, stmt,
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
  return { user: c.session.user, endpoint: c.endpoint, csrf: c.session.csrfToken(), flashes: c.session.popFlashes() };
}

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
  const dev = key ? await first(c.db, "SELECT * FROM devices WHERE key = ?", key) : null;
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

function eventPayload(ts: number, dev: Row, uid: string, card: Row | null, result: string, direction: string, offline: boolean) {
  return {
    ts, time: fmtDt(ts), time_jalali: J.latin(jdt(ts)), door: dev.name, uid,
    name: card ? card.name : null, result, direction: direction || null, offline,
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

function eventFilters(args: URLSearchParams): [string, unknown[]] {
  const where = ["1"], params: unknown[] = [];
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
async function liveEvents(c: Ctx, doorId: number) {
  let where = "e.offline = 0";
  const params: unknown[] = [];
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
  const doors = await all(c.db, "SELECT id, name, last_seen FROM devices ORDER BY name");
  return json({
    events: rows.map((r) => ({
      id: r.id, name: r.name, uid: r.uid, result: r.result, direction: r.direction, door: r.door || "",
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
  await run(c.db, "INSERT OR IGNORE INTO users(username, pw_hash) VALUES ('admin', ?)", await hashPassword(c.env.ADMIN_PASSWORD));
  return true;
}

// --- device API (used by the Wemos firmware) ------------------------------------

async function apiScan(c: Ctx) {
  const dev = await deviceFromKey(c);
  const body: any = await c.req.json().catch(() => ({}));
  const uid = normalizeUid(body?.uid);
  if (!uid) return json({ error: "invalid uid" }, 400);

  const card = await first(c.db, "SELECT * FROM cards WHERE uid = ?", uid);
  let direction = "", result: string;
  if (!dev.enabled) result = "denied";
  else if (!card) result = "unknown";
  else {
    const valid = cardValid(card);
    result = valid === "ok" ? "granted" : valid;
  }
  if (result === "granted") {
    direction = dev.direction;
    if (direction === "toggle") direction = (await lastDirection(c.db, card!.id)) === "in" ? "out" : "in";
  }
  const ts = now();
  await c.db.batch([
    touchDevice(c, dev),
    addEvent(c.db, { ts, deviceId: dev.id, uid, card, result, direction }),
  ]);
  fireWebhook(c, eventPayload(ts, dev, uid, card, result, direction, false));
  return json({ granted: result === "granted", result, name: card ? card.name : "", direction, open_ms: dev.open_ms });
}

async function apiSync(c: Ctx) {
  const dev = await deviceFromKey(c);
  const body: any = await c.req.json().catch(() => ({}));
  const writes = [touchDevice(c, dev, String(body?.fw ?? "").slice(0, 16) || null)];

  // events the device decided on its own while we were unreachable
  for (const ev of Array.isArray(body?.events) ? body.events : []) {
    const uid = normalizeUid(ev?.uid);
    if (!uid) continue;
    const ts = Math.trunc(Number(ev.ts) || 0) || now();   // 0 = device had no clock yet
    const card = await first(c.db, "SELECT * FROM cards WHERE uid = ?", uid);
    const result = ["granted", "denied", "unknown"].includes(ev.result) ? ev.result : "denied";
    const direction = ["in", "out"].includes(ev.direction) ? ev.direction : "";
    writes.push(addEvent(c.db, { ts, deviceId: dev.id, uid, card, result, direction, offline: true }));
    fireWebhook(c, eventPayload(ts, dev, uid, card, result, direction, true));
  }

  const openNow = Boolean(dev.pending_open);
  if (openNow) writes.push(stmt(c.db, "UPDATE devices SET pending_open = 0 WHERE id = ?", dev.id));
  await c.db.batch(writes);
  return json({ time: now(), cards_version: await cardsVersion(c.db), open: openNow, open_ms: dev.open_ms });
}

/** Offline cache for the device: uid \t enabled \t inside \t name, valid cards only. */
async function apiCards(c: Ctx) {
  await deviceFromKey(c);
  const day = today();
  const lines = (await cardsWithPresence(c.db))
    .filter((k) => cardValid(k, day) === "ok")
    .map((k) => `${k.uid}\t1\t${k.last_dir === "in" ? 1 : 0}\t${k.name}`);
  return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/tab-separated-values" } });
}

// --- integration API (read-only, Bearer token) -------------------------------------

async function apiPresence(c: Ctx) {
  requireToken(c);
  const rows = await cardsWithPresence(c.db);
  return json(rows.map((k) => ({ name: k.name, uid: k.uid, inside: k.last_dir === "in", last_seen: k.last_ts })));
}

async function apiEvents(c: Ctx) {
  requireToken(c);
  const rows = await all(c.db, EVENT_SELECT + "WHERE e.id > ? ORDER BY e.id LIMIT 1000", intArg(c.url.searchParams.get("since")));
  return json(rows);
}

// --- auth ---------------------------------------------------------------------------

async function login(c: Ctx) {
  if (!(await ensureAdmin(c))) {
    c.session.flash("هنوز کاربری وجود ندارد. secret با نام ADMIN_PASSWORD را تنظیم کنید یا scripts/set-password.mjs را اجرا کنید.", "error");
  } else if (c.req.method === "POST") {
    const u = await first(c.db, "SELECT * FROM users WHERE username = ?", formStr(c, "username"));
    if (u && (await checkPassword(u.pw_hash, formStr(c, "password")))) {
      c.session.clear();
      c.session.set("user", u.username);
      const nxt = c.url.searchParams.get("next") || "";
      return redirect(nxt.startsWith("/") && !nxt.startsWith("//") ? nxt : "/");
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
  const doors = await all(c.db, "SELECT id, name FROM devices ORDER BY name");
  const doorId = intArg(c.url.searchParams.get("door"));
  return livePage({ kiosk: false, doors, doorId, feedUrl: doorId ? `/live/feed?door=${doorId}` : "/live/feed", pollMs: pollMs(c) });
}

async function liveFeed(c: Ctx) {
  if (!c.session.user) return json({ error: "login required" }, 401);
  return liveEvents(c, intArg(c.url.searchParams.get("door")));
}

async function kiosk(c: Ctx, token: string) {
  const dev = await kioskDoor(c, token);
  return livePage({ kiosk: true, doors: [dev], doorId: dev.id, feedUrl: `/kiosk/${token}/feed`, pollMs: pollMs(c) });
}

async function kioskFeed(c: Ctx, token: string) {
  return liveEvents(c, (await kioskDoor(c, token)).id);
}

// --- dashboard -------------------------------------------------------------------------

async function dashboard(c: Ctx) {
  const [start, end] = dayBounds(today());
  const [cards, stats, recent, unknown, doors] = await Promise.all([
    cardsWithPresence(c.db),
    first(c.db, "SELECT SUM(result = 'granted') AS granted, SUM(result != 'granted') AS denied FROM events WHERE ts >= ? AND ts < ?", start, end),
    all(c.db, EVENT_SELECT + "ORDER BY e.ts DESC, e.id DESC LIMIT 15"),
    all(c.db,
      `SELECT e.uid, MAX(e.ts) AS ts, COUNT(*) AS n, d.name AS door FROM events e
       LEFT JOIN devices d ON d.id = e.device_id
       WHERE e.result = 'unknown' AND e.ts > ? AND e.uid NOT IN (SELECT uid FROM cards)
       GROUP BY e.uid ORDER BY ts DESC LIMIT 10`, now() - 7 * 86400),
    all(c.db, "SELECT * FROM devices ORDER BY name"),
  ]);
  return page(V.dashboardPage(pageCtx(c), {
    cards, inside: cards.filter((k) => k.last_dir === "in"), stats, recent, unknown, doors, onlineAfter: now() - ONLINE_WINDOW,
  }));
}

// --- cards ----------------------------------------------------------------------------------

async function cardsList(c: Ctx) {
  const q = (c.url.searchParams.get("q") || "").trim();
  const rows = q
    ? await cardsWithPresence(c.db, "c.name LIKE ? OR c.uid LIKE ? OR c.note LIKE ?", `%${q}%`, `%${q}%`, `%${q}%`)
    : await cardsWithPresence(c.db);
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
  const clash = await first(c.db, "SELECT id, name FROM cards WHERE uid = ? AND id IS NOT ?", uid, cardId);
  if (clash) {
    c.session.flash(`این کارت قبلاً برای «${clash.name}» ثبت شده است.`, "error");
    return false;
  }
  const write = cardId
    ? stmt(c.db, "UPDATE cards SET uid=?, name=?, note=?, enabled=?, valid_until=? WHERE id=?", uid, name, note, enabled, validUntil, cardId)
    : stmt(c.db, "INSERT INTO cards(uid, name, note, enabled, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      uid, name, note, enabled, validUntil, now());
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
  let card = await first(c.db, "SELECT * FROM cards WHERE id = ?", id);
  if (!card) abort(404);
  if (c.req.method === "POST") {
    if (await saveCard(c, id)) return redirect("/cards");
    card = formAsRow(c);
  }
  const history = await all(c.db, EVENT_SELECT + "WHERE e.card_id = ? ORDER BY e.ts DESC LIMIT 30", id);
  return page(V.cardFormPage(pageCtx(c), { card: card!, isNew: false, cardId: id, history }));
}

async function cardToggle(c: Ctx, id: number) {
  await c.db.batch([stmt(c.db, "UPDATE cards SET enabled = 1 - enabled WHERE id = ?", id), bumpCardsRev(c.db)]);
  return back(c, "/cards");
}

async function cardDelete(c: Ctx, id: number) {
  await c.db.batch([stmt(c.db, "DELETE FROM cards WHERE id = ?", id), bumpCardsRev(c.db)]);
  c.session.flash("کارت حذف شد. سوابق تردد آن حفظ می‌شود.", "ok");
  return redirect("/cards");
}

// --- doors (devices) ------------------------------------------------------------------------

async function doors(c: Ctx) {
  const rows = await all(c.db, "SELECT * FROM devices ORDER BY name");
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
    await run(c.db, "INSERT INTO devices(name, key, direction, open_ms, enabled) VALUES (?, ?, ?, ?, 1)", v.name, key, v.direction, v.open_ms);
  } catch (e) {
    if (!isUniqueError(e)) throw e;
    c.session.flash("دری با این نام وجود دارد.", "error");
    return redirect("/doors");
  }
  c.session.set("new_key", { name: v.name, key });
  return redirect("/doors");
}

async function doorEdit(c: Ctx, id: number) {
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
  const dev = await first(c.db, "SELECT * FROM devices WHERE id = ?", id);
  if (!dev) abort(404);
  await c.db.batch([
    stmt(c.db, "UPDATE devices SET pending_open = 1 WHERE id = ?", id),
    stmt(c.db, "INSERT INTO events(ts, device_id, uid, name, result) VALUES (?, ?, '-', ?, 'manual')", now(), id, `پنل: ${c.session.user}`),
  ]);
  c.session.flash(`«${dev!.name}» تا چند ثانیه دیگر باز می‌شود.`, "ok");
  return back(c, "/doors");
}

async function doorRekey(c: Ctx, id: number) {
  const dev = await first(c.db, "SELECT * FROM devices WHERE id = ?", id);
  if (!dev) abort(404);
  const key = randomToken(18);
  await run(c.db, "UPDATE devices SET key = ? WHERE id = ?", key, id);
  c.session.set("new_key", { name: dev!.name, key });
  return redirect("/doors");
}

async function doorDelete(c: Ctx, id: number) {
  await run(c.db, "DELETE FROM devices WHERE id = ?", id);
  c.session.flash("در حذف شد. سوابق تردد آن حفظ می‌شود.", "ok");
  return redirect("/doors");
}

// --- events / reports ----------------------------------------------------------------------

async function events(c: Ctx) {
  const [where, params] = eventFilters(c.url.searchParams);
  const pageNo = Math.max(1, intArg(c.url.searchParams.get("page"), 1));
  const [total, rows, doorList] = await Promise.all([
    first(c.db, `SELECT COUNT(*) AS n FROM events e WHERE ${where}`, ...params),
    all(c.db, EVENT_SELECT + `WHERE ${where} ORDER BY e.ts DESC, e.id DESC LIMIT ? OFFSET ?`, ...params, PAGE_SIZE, (pageNo - 1) * PAGE_SIZE),
    all(c.db, "SELECT id, name FROM devices ORDER BY name"),
  ]);
  const args: Record<string, string> = {};
  c.url.searchParams.forEach((v, k) => { if (k !== "page") args[k] = v; });
  const n = total?.n || 0;
  return page(V.eventsPage(pageCtx(c), {
    rows, total: n, page: pageNo, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)), doors: doorList, args,
  }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function eventsCsv(c: Ctx) {
  const [where, params] = eventFilters(c.url.searchParams);
  const rows = await all(c.db, EVENT_SELECT + `WHERE ${where} ORDER BY e.ts`, ...params);
  const lines = [["تاریخ", "ساعت", "نام", "شناسه کارت", "در", "نتیجه", "جهت", "آفلاین", "تاریخ میلادی"]];
  for (const r of rows) {
    const day = localDate(r.ts);
    lines.push([J.jstr(day), fmtDt(r.ts).slice(11), r.name, r.uid, r.door || "",
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
     WHERE e.result = 'granted' AND e.ts >= ? AND e.ts < ?
     GROUP BY c.id ORDER BY first_seen`, start, end);
  return page(V.attendancePage(pageCtx(c), { rows, day, prev: J.addDays(day, -1), next: J.addDays(day, 1) }));
}

// --- settings ---------------------------------------------------------------------------------

async function settings(c: Ctx) {
  if (c.req.method === "POST") {
    const action = formStr(c, "action");
    if (action === "password") {
      const u = await first(c.db, "SELECT * FROM users WHERE username = ?", c.session.user);
      const pw = formStr(c, "new");
      if (!u || !(await checkPassword(u.pw_hash, formStr(c, "current")))) c.session.flash("رمز فعلی اشتباه است.", "error");
      else if (pw.length < 8) c.session.flash("رمز جدید باید حداقل ۸ کاراکتر باشد.", "error");
      else {
        await run(c.db, "UPDATE users SET pw_hash = ? WHERE id = ?", await hashPassword(pw), u.id);
        c.session.flash("رمز عبور تغییر کرد.", "ok");
      }
    } else if (action === "add_user") {
      const name = formStr(c, "username").trim(), pw = formStr(c, "password");
      if (!name || pw.length < 8) c.session.flash("نام کاربری و رمز حداقل ۸ کاراکتری الزامی است.", "error");
      else {
        try {
          await run(c.db, "INSERT INTO users(username, pw_hash) VALUES (?, ?)", name, await hashPassword(pw));
          c.session.flash(`کاربر «${name}» اضافه شد.`, "ok");
        } catch (e) {
          if (!isUniqueError(e)) throw e;
          c.session.flash("این نام کاربری وجود دارد.", "error");
        }
      }
    } else if (action === "del_user") {
      const n = await first(c.db, "SELECT COUNT(*) AS n FROM users");
      if ((n?.n || 0) <= 1) c.session.flash("آخرین کاربر قابل حذف نیست.", "error");
      else {
        await run(c.db, "DELETE FROM users WHERE id = ?", intArg(formStr(c, "id")));
        if (!(await first(c.db, "SELECT 1 FROM users WHERE username = ?", c.session.user))) {
          c.session.clear();
          return redirect("/login");
        }
        c.session.flash("کاربر حذف شد.", "ok");
      }
    } else if (action === "purge") {
      const days = intArg(formStr(c, "days"));
      if (days >= 1) {
        const r = await run(c.db, "DELETE FROM events WHERE ts < ?", now() - days * 86400);
        c.session.flash(`${J.fa(r.meta.changes)} رویداد قدیمی‌تر از ${J.fa(days)} روز حذف شد.`, "ok");
      }
    }
    return redirect("/settings");
  }
  const [users, n] = await Promise.all([
    all(c.db, "SELECT id, username FROM users ORDER BY username"),
    first(c.db, "SELECT COUNT(*) AS n FROM events"),
  ]);
  return page(V.settingsPage(pageCtx(c), {
    users, nEvents: n?.n || 0, apiEnabled: Boolean(c.env.ACCESSCTL_API_TOKEN), webhook: c.env.ACCESSCTL_WEBHOOK_URL || "",
  }));
}

// --- router -----------------------------------------------------------------------------------

type Handler = (c: Ctx, ...params: any[]) => Promise<Response> | Response;
type Route = { method: string; pattern: RegExp; endpoint: string; handler: Handler; auth: "login" | "none" };

const routes: Route[] = [];
function route(method: string, path: string, endpoint: string, handler: Handler, auth: Route["auth"] = "login") {
  // '/cards/:int' -> integer param, ':token' -> any segment
  const pattern = new RegExp("^" + path.replace(/:int/g, "(\\d+)").replace(/:token/g, "([^/]+)") + "$");
  for (const m of method.split(",")) routes.push({ method: m, pattern, endpoint, handler, auth });
}

route("POST", "/api/v1/scan", "api_scan", apiScan, "none");
route("POST", "/api/v1/sync", "api_sync", apiSync, "none");
route("GET", "/api/v1/cards", "api_cards", apiCards, "none");
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
route("GET,POST", "/settings", "settings", settings);

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
  const c: Ctx = { req, env, url, db: env.DB, session, waitUntil: (p) => ctx.waitUntil(p), endpoint: r.endpoint };

  let res: Response;
  try {
    if (req.method === "POST" && !isApi) {
      c.form = await req.formData().catch(() => new FormData());
      const token = formStr(c, "csrf");
      if (!token || !session.data.csrf || !safeEqual(token, session.data.csrf)) {
        abort(400, "نشست منقضی شده است — صفحه را دوباره بارگذاری کنید.");
      }
    }
    if (r.auth === "login" && !session.user) {
      res = redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
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
