// RFID access-control server on Cloudflare Workers + D1 — port of server/app.py.
// Same device API (/api/v1/*) as the Flask server, so the Wemos firmware works with either.
import { checkPassword, hashPassword, kioskMatches, kioskPayload, kioskToken, randomToken, safeEqual, Session } from "./auth";
import {
  activeSlots, addEvent, all, bumpCardsRev, cardsVersion, cardsWithPresence, cardValid, classSessions, classSummary,
  cleanName, decide, Decision, EARLY_MIN, EVENT_SELECT, first, isMember, isUniqueError, normalizeUid, Row, run,
  sessionReport, slotOn, stmt,
} from "./db";
import { esc, Safe } from "./html";
import * as B from "./billing";
import * as J from "./jalali";
import liveTemplate from "./live.html";
import { dayBounds, fmtDt, jdate, jdt, jtime, localDate, now, setTimeZone, today } from "./time";
import * as V from "./views";
import * as UI from "./ui";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  SECRET_KEY: string;              // wrangler secret put SECRET_KEY
  ADMIN_PASSWORD?: string;         // first login when the users table is empty
  ACCESSCTL_API_TOKEN?: string;    // enables the read-only integration API
  ACCESSCTL_WEBHOOK_URL?: string;  // POSTs every access event as JSON
  TZ?: string;                     // panel time zone (wrangler.toml [vars])
  LIVE_POLL_MS?: string;           // live screen refresh; each poll is one Worker request
  ZARINPAL_MERCHANT?: string;      // wrangler secret put ZARINPAL_MERCHANT: enables online payment
  ZARINPAL_SANDBOX?: string;       // "1" = Zarinpal sandbox (test payments, any UUID as merchant)
  VAT_PERCENT?: string;            // VAT added to invoices (wrangler.toml [vars])
}

const KIOSK_HOLD_MS = 5000;  // a scan result stays on the kiosk screen this long (live.html HOLD_MS)
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
  pending: number;       // registrations waiting for approval (server owners only)
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

const PLAN_EN: Record<string, string> = { free: "Free", starter: "Starter", business: "Business", enterprise: "Enterprise" };

function pageCtx(c: Ctx): V.PageCtx {
  const q = c.url.searchParams.get("lang");
  if ((q === "fa" || q === "en") && c.session.data.lang !== q) c.session.set("lang", q);
  return {
    lang: c.session.data.lang || "fa", path: c.url.pathname, planEn: c.org?.plan ? PLAN_EN[c.org.plan] : undefined,
    user: c.user?.username, userId: c.user?.id, owner: c.owner, orgName: c.org?.name,
    locked: Boolean(c.org && !c.org.approved && !c.owner), pending: c.pending,
    plan: c.org?.plan_name || undefined, planWarn: planWarn(c.org),
    endpoint: c.endpoint, origin: c.url.origin, csrf: c.session.csrfToken(), flashes: c.session.popFlashes(),
  };
}

const oid = (c: Ctx): number => c.org!.id;

function planWarn(org: Row | null) {
  if (!org?.plan) return false;
  const st = B.subState(org);
  return st === "past_due" || st === "suspended" || (st === "trialing" && B.daysLeft(org) <= 3);
}

const ORG_SELECT = "SELECT o.*, p.name AS plan_name FROM orgs o LEFT JOIN plans p ON p.id = o.plan WHERE o.id = ?";

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
  if (c.owner) c.pending = (await first(c.db, "SELECT COUNT(*) AS n FROM orgs WHERE approved = 0"))?.n || 0;
  const orgId = u.org_id ?? c.session.data.view_org;
  if (orgId) {
    c.org = await first(c.db, ORG_SELECT, orgId);
    if (!c.org) c.session.set("view_org", undefined);
    else c.org = await settleBilling(c, c.org);
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
    `SELECT d.*, ${B.orgLiveSql("o")} AS org_enabled, o.name AS org_name, p.name AS plan_name FROM devices d JOIN orgs o ON o.id = d.org_id LEFT JOIN plans p ON p.id = o.plan WHERE d.key = ?`, key) : null;
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
  const [doors, org] = await Promise.all([
    all(c.db, "SELECT id, name, last_seen FROM devices WHERE org_id = ? ORDER BY name", orgId),
    first(c.db, `SELECT o.name, ${B.orgLiveSql("o")} AS enabled FROM orgs o WHERE o.id = ?`, orgId),
  ]);
  return json({
    org: { name: org?.name || "", active: Boolean(org?.enabled) },
    events: rows.map((r) => ({
      id: r.id, name: r.name, uid: r.uid, result: r.result, direction: r.direction, door: r.door || "", class: r.class_name || "",
      time: jtime(r.ts, true), date: jdate(r.ts),
    })),
    doors: doors.filter((d) => !doorId || d.id === doorId)
      .map((d) => ({ id: d.id, name: d.name, online: Boolean(d.last_seen && d.last_seen >= cutoff) })),
  });
}

function livePage(v: { kiosk: boolean; orgName: string; doors: Row[]; doorId: number; feedUrl: string; pollMs: number }) {
  const doorBlock = v.kiosk
    ? `<p>${esc(v.doors[0].name)}</p>`
    : `<select id="doorSel" aria-label="در">
        <option value="">همه درها</option>
        ${v.doors.map((d) => `<option value="${d.id}" ${d.id === v.doorId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
      </select>`;
  const js = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");
  let out = liveTemplate
    .replace("__ORG_NAME__", () => esc(v.orgName))
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
  return json({
    name: dev.name,
    url: `/kiosk/${await kioskToken(c.env.SECRET_KEY, dev as { id: number; key: string })}`,
    org: { name: dev.org_name, active: Boolean(dev.org_enabled), plan: dev.plan_name || "" },
    lang: "fa",
    hold_ms: KIOSK_HOLD_MS,
  });
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
    const name = formStr(c, "username").trim();
    const u = await first(c.db,
      `SELECT u.*, o.enabled AS org_enabled FROM users u LEFT JOIN orgs o ON o.id = u.org_id
       WHERE u.username IN (?, ?) ORDER BY u.username = ? DESC LIMIT 1`, name, name.toLowerCase(), name);
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

/** '/': landing page for visitors, the waiting page for unapproved companies, else the live screen. */
async function home(c: Ctx) {
  if (!c.user) return page(V.landingPage(pageCtx(c)));
  if (!c.org) return redirect("/admin");
  if (!c.owner && !c.org.approved) return page(V.pendingPage(pageCtx(c), c.org));
  return live(c);
}

// --- self-registration -----------------------------------------------------------------

const MAX_PENDING = 100;   // stop accepting sign-ups while this many wait for approval
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Persian/Arabic digits -> ASCII, separators dropped: '۰۹۱۲ ۳۴۵-۶۷۸۹' -> '09123456789'. */
function normalizePhone(s: string): string {
  return s.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\s\-().]/g, "");
}

const countArg = (v: string) => {
  const n = intArg(normalizePhone(v), 0);
  return n >= 1 && n <= 1000 ? n : 0;
};

async function register(c: Ctx) {
  if (c.user) return redirect("/");
  const planList = (await B.plans(c.db));
  const wanted = c.url.searchParams.get("plan") || "";
  const v = { name: "", email: "", phone: "", plan: planList.some((p) => p.id === wanted) ? wanted : "starter" };
  if (c.req.method === "POST") {
    v.name = cleanName(formStr(c, "name"), 60);
    v.email = formStr(c, "email").trim().toLowerCase();
    v.phone = normalizePhone(formStr(c, "phone").trim());
    v.plan = formStr(c, "plan");
    const pw = formStr(c, "password");
    const plan = planList.find((p) => p.id === v.plan);
    let err = "";
    if (formStr(c, "website")) return redirect("/");   // honeypot: only bots fill the hidden field
    if (!v.name) err = "نام سازمان الزامی است.";
    else if (!EMAIL_RE.test(v.email) || v.email.length > 120) err = "ایمیل معتبر نیست.";
    else if (!/^\+?\d{8,15}$/.test(v.phone)) err = "شماره تلفن معتبر نیست (۸ تا ۱۵ رقم).";
    else if (!plan) err = "یک طرح انتخاب کنید.";
    else if (!validPassword(pw)) err = "رمز عبور باید حداقل ۸ کاراکتر باشد.";
    else if (pw !== formStr(c, "password2")) err = "تکرار رمز عبور یکسان نیست.";
    else if (await first(c.db, "SELECT 1 AS x FROM users WHERE username = ?", v.email)) err = "با این ایمیل قبلاً ثبت‌نام شده است. وارد شوید.";
    else if (await first(c.db, "SELECT 1 AS x FROM orgs WHERE name = ?", v.name)) err = "سازمانی با این نام وجود دارد.";
    else if (((await first(c.db, "SELECT COUNT(*) AS n FROM orgs WHERE approved = 0"))?.n || 0) >= MAX_PENDING) {
      err = "در حال حاضر امکان ثبت‌نام نیست. بعداً دوباره تلاش کنید.";
    }
    if (!err) {
      try {
        // one transaction: the company and its first user (the email is the username)
        await c.db.batch([
          // the plan is stored now; its trial starts when a server owner approves the company
          c.db.prepare("INSERT INTO orgs(name, enabled, approved, email, phone, plan, max_users, max_devices, max_cards, created_at) VALUES (?, 1, 0, ?, ?, ?, ?, ?, ?, ?)")
            .bind(v.name, v.email, v.phone, plan!.id, plan!.max_admins, plan!.max_doors, plan!.max_cards, now()),
          c.db.prepare("INSERT INTO users(username, pw_hash, org_id) VALUES (?, ?, (SELECT id FROM orgs WHERE name = ?))")
            .bind(v.email, await hashPassword(pw), v.name),
        ]);
      } catch (e) {
        if (!isUniqueError(e)) throw e;
        err = "این نام سازمان یا ایمیل قبلاً ثبت شده است.";
      }
    }
    if (err) {
      c.session.flash(err, "error");
    } else {
      const u = await first(c.db, "SELECT id, username FROM users WHERE username = ?", v.email);
      c.session.clear();
      c.session.set("uid", u!.id);
      c.session.set("user", u!.username);
      return redirect("/");
    }
  }
  return page(V.registerPage(pageCtx(c), v, planList));
}

// --- billing: plans, subscription, hardware store, Zarinpal ---------------------------------

function limitMsg(c: Ctx, what: string, n: number) {
  return c.org!.plan
    ? `سقف ${what} در طرح فعلی شما ${J.fa(n)} است. برای افزایش، طرح را در صفحهٔ صورت‌حساب ارتقا دهید.`
    : `سقف ${what} سازمان شما ${J.fa(n)} است. برای افزایش با مدیر سرور تماس بگیرید.`;
}

/** A cancelled subscription drops to the free plan once its paid period is over. */
async function settleBilling(c: Ctx, org: Row): Promise<Row> {
  if (!org.plan || org.plan === "free" || !org.paid_until || now() <= org.paid_until) return org;
  if (!org.cancel_at_end && org.next_plan !== "free") return org;
  const free = await first(c.db, "SELECT * FROM plans WHERE id = 'free'");
  if (!free) return org;
  await B.applyPlanStmt(c.db, org.id, free, { status: "free", paidUntil: null }).run();
  return (await first(c.db, ORG_SELECT, org.id)) || org;
}

async function pricing(c: Ctx) {
  const [plans, products] = await Promise.all([B.plans(c.db), B.products(c.db)]);
  return page(UI.pricingPage(pageCtx(c), { plans, products, jsonld: V.pricingJsonLd(plans) }));
}

async function billing(c: Ctx) {
  const org = c.org!;
  const [plans, u, invoices] = await Promise.all([
    B.plans(c.db), B.usage(c.db, org.id),
    all(c.db, "SELECT * FROM invoices WHERE org_id = ? AND (status = 'paid' OR (status = 'pending' AND kind = 'manual')) ORDER BY id DESC LIMIT 6", org.id),
  ]);
  const state = B.subState(org);
  const plan = plans.find((p) => p.id === org.plan) || null;
  const nextPlan = plans.find((p) => p.id === (org.next_plan || org.plan)) || null;
  const next = nextPlan && !nextPlan.contact && nextPlan.id !== "free" && org.paid_until && state !== "canceling"
    ? await B.quote(c.db, c.env, { ...org, plan: nextPlan.id }, nextPlan, org.cycle || "month") : null;
  return page(UI.billingPage(pageCtx(c), {
    org, plan, state, usage: u, invoices, next, nextPlan,
    payments: B.paymentsEnabled(c.env), vat: B.vatPercent(c.env), daysLeft: B.daysLeft(org),
  }));
}

async function billingCheckout(c: Ctx) {
  const org = c.org!;
  const plan = await first(c.db, "SELECT * FROM plans WHERE id = ?", formStr(c, "plan"));
  const cycle = formStr(c, "cycle") === "year" ? "year" : "month";
  if (!plan) abort(400, "طرح نامعتبر است.");
  if (plan!.contact) {
    c.session.flash(`برای طرح «${plan!.name}» با فروش تماس بگیرید؛ فاکتور آن به‌صورت دستی صادر می‌شود.`, "ok");
    return redirect("/billing");
  }
  const fit = B.fitError(plan!, await B.usage(c.db, org.id));
  if (fit) {
    c.session.flash(fit, "error");
    return redirect("/pricing");
  }
  const state = B.subState(org);
  if (plan!.id === "free") {
    if (state === "active" && org.paid_until) {
      await run(c.db, "UPDATE orgs SET cancel_at_end = 1 WHERE id = ?", org.id);
      c.session.flash(`طرح فعلی تا ${jdate(org.paid_until)} فعال می‌ماند و پس از آن به طرح رایگان می‌روید.`, "ok");
    } else {
      await B.applyPlanStmt(c.db, org.id, plan!, { status: "free", paidUntil: null }).run();
      c.session.flash("طرح شما به «رایگان» تغییر کرد.", "ok");
    }
    return redirect("/billing");
  }
  const q = await B.quote(c.db, c.env, org, plan!, cycle);
  if (q.kind === "downgrade") {
    await run(c.db, "UPDATE orgs SET next_plan = ?, cancel_at_end = 0 WHERE id = ?", plan!.id, org.id);
    c.session.flash(`از تمدید بعدی (${jdate(org.paid_until)}) طرح شما «${plan!.name}» می‌شود.`, "ok");
    return redirect("/billing");
  }
  if (!formStr(c, "confirm")) {
    return page(V.checkoutPage(pageCtx(c), { plan: plan!, cycle, q, vat: B.vatPercent(c.env), payments: B.paymentsEnabled(c.env) }));
  }
  if (!B.paymentsEnabled(c.env)) {
    c.session.flash("پرداخت آنلاین هنوز فعال نشده است. برای خرید یا تمدید با پشتیبانی تماس بگیرید.", "error");
    return redirect("/billing");
  }
  const inv = await createInvoice(c, {
    kind: "plan", item: plan!.id, cycle, amount: q.amount, credit: q.credit, vat: q.vat, total: q.total, period_end: q.periodEnd, note: q.kind,
  });
  return payInvoice(c, inv);
}

async function createInvoice(c: Ctx, f: Row): Promise<Row> {
  for (let attempt = 0; ; attempt++) {
    const number = await B.invoiceNumber(c.db);
    try {
      const r = await run(c.db, `INSERT INTO invoices(org_id, number, kind, item, cycle, mode, qty, amount, credit, vat, total, note, period_end, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.org_id ?? oid(c), number, f.kind, f.item, f.cycle ?? null, f.mode ?? null, f.qty ?? 1,
        f.amount, f.credit ?? 0, f.vat, f.total, f.note ?? "", f.period_end ?? null, now());
      return (await first(c.db, "SELECT * FROM invoices WHERE id = ?", r.meta.last_row_id))!;
    } catch (e) {
      if (!isUniqueError(e) || attempt >= 3) throw e;
    }
  }
}

const KIND_FA: Record<string, string> = { plan: "اشتراک", hardware: "سخت‌افزار", manual: "فاکتور دستی" };

/** Send the customer to Zarinpal for this invoice. */
async function payInvoice(c: Ctx, inv: Row) {
  if (!B.paymentsEnabled(c.env)) {
    c.session.flash("پرداخت آنلاین هنوز فعال نشده است.", "error");
    return redirect("/billing");
  }
  const org = c.org!;
  try {
    const authority = await B.zpRequest(c.env, {
      toman: inv.total, orderId: inv.number, callback: `${c.url.origin}/billing/callback`,
      description: `${KIND_FA[inv.kind] || ""} ${inv.number} · ${org.name}`.slice(0, 250), email: org.email || undefined, mobile: org.phone || undefined,
    });
    await run(c.db, "UPDATE invoices SET authority = ? WHERE id = ? AND status = 'pending'", authority, inv.id);
    return redirect(B.startPayUrl(c.env, authority));
  } catch (e) {
    console.error("zarinpal request", e);
    c.session.flash(e instanceof Error && e.message ? e.message : "اتصال به درگاه پرداخت ممکن نشد.", "error");
    return redirect("/billing");
  }
}

/** Effects of a paid invoice (only ever run once per invoice). */
async function invoicePaidEffects(c: Ctx, inv: Row) {
  if (inv.kind === "plan") {
    const plan = await first(c.db, "SELECT * FROM plans WHERE id = ?", inv.item);
    if (plan) await B.applyPlanStmt(c.db, inv.org_id, plan, { status: "active", paidUntil: inv.period_end, cycle: inv.cycle || "month" }).run();
  } else if (inv.kind === "hardware" && inv.mode === "rent") {
    const p = await first(c.db, "SELECT * FROM products WHERE id = ?", inv.item);
    await run(c.db, "INSERT INTO rentals(org_id, product_id, qty, monthly, started_at) VALUES (?, ?, ?, ?, ?)",
      inv.org_id, inv.item, inv.qty, p?.rent_month ?? Math.round(inv.amount / inv.qty), now());
  } else if (inv.kind === "manual" && inv.period_end) {
    await run(c.db, "UPDATE orgs SET paid_until = MAX(COALESCE(paid_until, 0), ?), sub_status = 'active', cancel_at_end = 0 WHERE id = ?", inv.period_end, inv.org_id);
  }
}

/** Mark paid if still pending; true when this call did it. */
async function markPaid(c: Ctx, inv: Row, refId: string, cardPan: string) {
  const r = await run(c.db, "UPDATE invoices SET status = 'paid', paid_at = ?, ref_id = ?, card_pan = ? WHERE id = ? AND status != 'paid'",
    now(), refId, cardPan, inv.id);
  if (!r.meta.changes) return false;
  await invoicePaidEffects(c, inv);
  return true;
}

async function billingCallback(c: Ctx) {
  const authority = c.url.searchParams.get("Authority") || "";
  const status = c.url.searchParams.get("Status") || "";
  const inv = authority ? await first(c.db, "SELECT * FROM invoices WHERE authority = ?", authority) : null;
  if (!inv) return page(V.errorPage(404, "پرداختی با این شناسه پیدا نشد."), 404);
  const to = c.user ? `/billing/invoices/${inv.id}` : "/login";
  if (inv.status === "paid") return redirect(to);
  if (status !== "OK") {
    await run(c.db, "UPDATE invoices SET status = 'failed' WHERE id = ? AND status = 'pending' AND kind != 'manual'", inv.id);
    c.session.flash("پرداخت انجام نشد یا لغو شد. مبلغی از حساب شما کم نشده است؛ اگر کم شده، ظرف ۷۲ ساعت برمی‌گردد.", "error");
    return redirect(to);
  }
  const v = await B.zpVerify(c.env, authority, inv.total);
  if (!v.ok) {
    await run(c.db, "UPDATE invoices SET status = 'failed' WHERE id = ? AND status = 'pending' AND kind != 'manual'", inv.id);
    c.session.flash(v.error, "error");
    return redirect(to);
  }
  await markPaid(c, inv, v.refId, v.cardPan);
  c.session.flash(`پرداخت موفق بود. کد پیگیری: ${v.refId}`, "ok");
  return redirect(to);
}

async function billingCancel(c: Ctx) {
  const state = B.subState(c.org!);
  if (state === "active" || state === "trialing") {
    await run(c.db, "UPDATE orgs SET cancel_at_end = 1 WHERE id = ?", oid(c));
    c.session.flash(`اشتراک لغو شد. تا ${jdate(c.org!.paid_until)} همه امکانات فعال است و پس از آن به طرح رایگان می‌روید.`, "ok");
  }
  return redirect("/billing");
}

async function billingResume(c: Ctx) {
  await run(c.db, "UPDATE orgs SET cancel_at_end = 0, next_plan = NULL WHERE id = ?", oid(c));
  c.session.flash("اشتراک شما دوباره تمدیدشونده است.", "ok");
  return redirect("/billing");
}

async function invoicesList(c: Ctx) {
  const rows = await all(c.db, "SELECT * FROM invoices WHERE org_id = ? ORDER BY id DESC LIMIT 200", oid(c));
  const st = B.subState(c.org!);
  return page(V.invoicesPage(pageCtx(c), { rows, canCancel: st === "active" || st === "trialing" }));
}

async function ownInvoice(c: Ctx, id: number) {
  const inv = await first(c.db, "SELECT * FROM invoices WHERE id = ? AND org_id = ?", id, oid(c));
  if (!inv) abort(404);
  return inv!;
}

async function invoiceView(c: Ctx, id: number) {
  const inv = await ownInvoice(c, id);
  const item = inv.kind === "plan" ? await first(c.db, "SELECT name FROM plans WHERE id = ?", inv.item)
    : inv.kind === "hardware" ? await first(c.db, "SELECT name FROM products WHERE id = ?", inv.item) : null;
  return page(V.invoicePage(pageCtx(c), { inv, org: c.org!, itemName: item?.name || inv.note || "", vat: B.vatPercent(c.env) }));
}

async function invoicePay(c: Ctx, id: number) {
  const inv = await ownInvoice(c, id);
  if (inv.status === "paid") return redirect(`/billing/invoices/${id}`);
  // plan prices depend on the day they were quoted: an old unpaid one is quoted again
  if (inv.kind === "plan" && now() - inv.created_at > 3600) {
    c.session.flash("این پیش‌فاکتور منقضی شده است؛ طرح را دوباره انتخاب کنید.", "error");
    return redirect("/pricing");
  }
  return payInvoice(c, inv);
}

async function store(c: Ctx) {
  const [products, orders, rentals] = await Promise.all([
    B.products(c.db),
    all(c.db, "SELECT i.*, p.name FROM invoices i LEFT JOIN products p ON p.id = i.item WHERE i.org_id = ? AND i.kind = 'hardware' AND i.status = 'paid' ORDER BY i.id DESC LIMIT 20", oid(c)),
    all(c.db, "SELECT r.*, p.name FROM rentals r JOIN products p ON p.id = r.product_id WHERE r.org_id = ? AND r.ended_at IS NULL", oid(c)),
  ]);
  const state = B.subState(c.org!);
  const canRent = Boolean(c.org!.plan && c.org!.plan !== "free" && c.org!.paid_until && (state === "active" || state === "trialing"));
  return page(V.storePage(pageCtx(c), { products, orders, rentals, canRent, payments: B.paymentsEnabled(c.env), vat: B.vatPercent(c.env) }));
}

async function storeOrder(c: Ctx) {
  const p = await first(c.db, "SELECT * FROM products WHERE id = ? AND active = 1", formStr(c, "product"));
  const mode = formStr(c, "mode") === "rent" ? "rent" : "buy";
  const qty = intArg(normalizePhone(formStr(c, "qty")), 1);
  const address = Array.from(formStr(c, "address").trim()).slice(0, 400).join("");
  if (!p) abort(400, "محصول نامعتبر است.");
  let err = "";
  if (qty < 1 || qty > 20) err = "تعداد باید بین ۱ تا ۲۰ باشد.";
  else if (address.length < 10) err = "نشانی و کد پستی ارسال را کامل وارد کنید.";
  else if (mode === "rent" && !p!.rent_month) err = "این محصول اجاره‌ای نیست.";
  else if (mode === "rent") {
    const state = B.subState(c.org!);
    if (!(c.org!.plan && c.org!.plan !== "free" && c.org!.paid_until && (state === "active" || state === "trialing"))) {
      err = "اجاره فقط همراه یک اشتراک پولی فعال ممکن است؛ اجاره هر ماه به تمدید اشتراک اضافه می‌شود.";
    }
  }
  if (err) {
    c.session.flash(err, "error");
    return redirect("/store");
  }
  const amount = (mode === "rent" ? p!.rent_month : p!.price) * qty;
  const vat = Math.round((amount * B.vatPercent(c.env)) / 100);
  if (!B.paymentsEnabled(c.env)) {
    c.session.flash("پرداخت آنلاین هنوز فعال نشده است. برای سفارش با پشتیبانی تماس بگیرید.", "error");
    return redirect("/store");
  }
  const inv = await createInvoice(c, { kind: "hardware", item: p!.id, mode, qty, amount, vat, total: amount + vat, note: address });
  return payInvoice(c, inv);
}

/** Billing actions on /admin; false if `action` isn't one of them. */
async function adminBilling(c: Ctx, action: string, orgId: number): Promise<boolean> {
  const num = (k: string) => { const v = formStr(c, k).trim(); return v === "" ? null : Math.max(0, intArg(normalizePhone(v))); };
  if (action === "set_plan") {
    const id = formStr(c, "plan");
    const days = num("days");
    if (id === "") {
      await run(c.db, "UPDATE orgs SET plan = NULL, sub_status = NULL, paid_until = NULL, cancel_at_end = 0, next_plan = NULL WHERE id = ?", orgId);
    } else {
      const plan = await first(c.db, "SELECT * FROM plans WHERE id = ?", id);
      if (!plan) return true;
      await B.applyPlanStmt(c.db, orgId, plan, plan.id === "free" ? { status: "free", paidUntil: null }
        : { status: "active", paidUntil: days ? now() + days * B.DAY : null }).run();
    }
    c.session.flash("طرح سازمان ذخیره شد.", "ok");
  } else if (action === "plan_save") {
    await run(c.db, `UPDATE plans SET name = ?, blurb = ?, price_month = ?, price_year = ?, max_doors = ?, max_admins = ?, max_cards = ?,
        trial_days = ?, features = ? WHERE id = ?`,
      cleanName(formStr(c, "name"), 40) || formStr(c, "id"), formStr(c, "blurb").trim().slice(0, 200), num("price_month") ?? 0, num("price_year") ?? 0,
      num("max_doors"), num("max_admins"), num("max_cards"), num("trial_days") ?? 0, formStr(c, "features").trim().slice(0, 1000), formStr(c, "id"));
    c.session.flash("طرح ذخیره شد. سقف سازمان‌هایی که این طرح را دارند در تمدید بعدی به‌روز می‌شود.", "ok");
  } else if (action === "product_save") {
    await run(c.db, "UPDATE products SET name = ?, blurb = ?, badge = ?, price = ?, rent_month = ?, active = ? WHERE id = ?",
      cleanName(formStr(c, "name"), 60) || formStr(c, "id"), formStr(c, "blurb").trim().slice(0, 300), cleanName(formStr(c, "badge"), 30),
      num("price") ?? 0, num("rent_month") || null, formStr(c, "active") ? 1 : 0, formStr(c, "id"));
    c.session.flash("محصول ذخیره شد.", "ok");
  } else if (action === "invoice_new") {
    const amount = num("amount");
    const days = num("days");
    if (!amount || !(await first(c.db, "SELECT 1 AS x FROM orgs WHERE id = ?", orgId))) c.session.flash("سازمان و مبلغ را وارد کنید.", "error");
    else {
      const vat = Math.round((amount * B.vatPercent(c.env)) / 100);
      const inv = await createInvoice(c, {
        org_id: orgId, kind: "manual", item: "manual", amount, vat, total: amount + vat,
        note: formStr(c, "note").trim().slice(0, 200), period_end: days ? now() + days * B.DAY : null,
      });
      c.session.flash(`فاکتور ${inv.number} صادر شد؛ مشتری آن را از صفحهٔ صورت‌حساب می‌پردازد.`, "ok");
    }
  } else if (action === "invoice_paid") {
    const inv = await first(c.db, "SELECT * FROM invoices WHERE id = ?", intArg(formStr(c, "id")));
    if (inv && (await markPaid(c, inv, formStr(c, "ref").trim().slice(0, 60) || "دستی", ""))) c.session.flash(`فاکتور ${inv.number} پرداخت‌شده ثبت شد.`, "ok");
  } else if (action === "invoice_shipped") {
    await run(c.db, "UPDATE invoices SET shipped = 1 - shipped WHERE id = ? AND kind = 'hardware'", intArg(formStr(c, "id")));
  } else if (action === "rental_end") {
    await run(c.db, "UPDATE rentals SET ended_at = ? WHERE id = ? AND ended_at IS NULL", now(), intArg(formStr(c, "id")));
    c.session.flash("اجاره پایان یافت.", "ok");
  } else return false;
  return true;
}

// --- search engines and AI crawlers ------------------------------------------------------

const text = (body: string, type = "text/plain") =>
  new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "public, max-age=3600" } });

const PRIVATE_PATHS = ["/api/", "/kiosk/", "/live/", "/billing", "/store", "/dashboard", "/cards", "/doors", "/classes", "/events", "/attendance", "/settings", "/admin", "/logout"];

function robotsTxt(c: Ctx) {
  const dis = PRIVATE_PATHS.map((p) => `Disallow: ${p}`).join("\n");
  // AI assistants and answer engines are welcome on the public pages (GEO)
  const bots = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot",
    "Perplexity-User", "Google-Extended", "Applebot-Extended", "Bingbot", "Googlebot"];
  return text(`User-agent: *\nAllow: /\n${dis}\n\n` + bots.map((b) => `User-agent: ${b}\nAllow: /\n${dis}\n`).join("\n")
    + `\nSitemap: ${c.url.origin}/sitemap.xml\n`);
}

function sitemapXml(c: Ctx) {
  const urls = [["/", "1.0"], ["/pricing", "0.9"], ["/register", "0.8"]];
  return text(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, pr]) => `  <url><loc>${c.url.origin}${p}</loc><changefreq>weekly</changefreq><priority>${pr}</priority></url>`).join("\n")}
</urlset>
`, "application/xml");
}

/** llms.txt: a plain summary for AI assistants (https://llmstxt.org). */
function llmsTxt(c: Ctx) {
  const o = c.url.origin;
  return text(`# ${V.SITE_NAME} (Attendance & access control with RFID cards)

> ${V.SITE_DESC}

A web service (Persian, fa-IR) where companies, schools and universities record attendance and door access with RFID/NFC cards. Each organization registers, is approved by the operator, then manages its own panel users, card readers, cards, classes and reports.

## Key facts
- Card readers: a low-cost RC522 + Wemos D1 mini (ESP8266) Wi-Fi device, or an Android phone with NFC running the free door app (kiosk screen).
- Cards: 13.56 MHz RFID/NFC cards and tags (MIFARE Classic, NTAG), identified by UID.
- Features: entry/exit log, live door screen, daily attendance, class attendance with weekly or one-off sessions, CSV export, read-only API and webhook, multi-organization with separate data.
- Sign-up: name, email, mobile number, number of panel users and devices needed; the panel unlocks after operator approval.

## Pages
- [Home](${o}/): overview, features and FAQ
- [Register an organization](${o}/register)
- [Login](${o}/login)

## FAQ
${V.FAQ.map(([q, a]) => `### ${q}\n${a}`).join("\n\n")}
`);
}

async function live(c: Ctx) {
  const doors = await all(c.db, "SELECT id, name FROM devices WHERE org_id = ? ORDER BY name", oid(c));
  const doorId = intArg(c.url.searchParams.get("door"));
  return livePage({ kiosk: false, orgName: c.org!.name, doors, doorId, feedUrl: doorId ? `/live/feed?door=${doorId}` : "/live/feed", pollMs: pollMs(c) });
}

async function liveFeed(c: Ctx) {
  if (!c.user || !c.org) return json({ error: "login required" }, 401);
  if (!c.owner && !c.org.approved) return json({ error: "waiting for approval" }, 403);
  return liveEvents(c, oid(c), intArg(c.url.searchParams.get("door")));
}

async function kiosk(c: Ctx, token: string) {
  const dev = await kioskDoor(c, token);
  const org = await first(c.db, "SELECT name FROM orgs WHERE id = ?", dev.org_id);
  return livePage({ kiosk: true, orgName: org?.name || "", doors: [dev], doorId: dev.id, feedUrl: `/kiosk/${token}/feed`, pollMs: pollMs(c) });
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
  if (enabled && !c.owner && c.org!.max_cards !== null) {
    const n = await first(c.db, "SELECT COUNT(*) AS n FROM cards WHERE org_id = ? AND enabled = 1 AND id IS NOT ?", oid(c), cardId);
    if ((n?.n || 0) >= c.org!.max_cards) {
      c.session.flash(limitMsg(c, "کارت فعال", c.org!.max_cards), "error");
      return false;
    }
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
  const card = await ownRow(c, "cards", id);
  if (!card.enabled && !c.owner && c.org!.max_cards !== null) {
    const n = await first(c.db, "SELECT COUNT(*) AS n FROM cards WHERE org_id = ? AND enabled = 1", oid(c));
    if ((n?.n || 0) >= c.org!.max_cards) {
      c.session.flash(limitMsg(c, "کارت فعال", c.org!.max_cards), "error");
      return back(c, "/cards");
    }
  }
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
  if (!c.owner && c.org!.max_devices !== null) {
    const n = await first(c.db, "SELECT COUNT(*) AS n FROM devices WHERE org_id = ?", oid(c));
    if ((n?.n || 0) >= c.org!.max_devices) {
      c.session.flash(limitMsg(c, "در", c.org!.max_devices), "error");
      return redirect("/doors");
    }
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
    else if (action === "add_user") {
      const n = await first(c.db, "SELECT COUNT(*) AS n FROM users WHERE org_id = ?", oid(c));
      if (!c.owner && c.org!.max_users !== null && (n?.n || 0) >= c.org!.max_users) {
        c.session.flash(limitMsg(c, "مدیر", c.org!.max_users), "error");
      } else await addUser(c, oid(c));
    } else if (action === "del_user") {
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
    } else if (action === "approve") {
      const org = await first(c.db, "SELECT * FROM orgs WHERE id = ? AND approved = 0", orgId);
      const plan = await first(c.db, "SELECT * FROM plans WHERE id = ?", formStr(c, "plan"));
      if (org && plan) {
        await c.db.batch([c.db.prepare("UPDATE orgs SET approved = 1 WHERE id = ?").bind(orgId), B.startPlanStmt(c.db, orgId, plan)]);
        c.session.flash(`سازمان «${org.name}» با طرح «${plan.name}» تأیید شد و اکنون به پنل دسترسی دارد.`, "ok");
      }
    } else if (await adminBilling(c, action, orgId)) {
      // handled
    } else if (action === "limits") {
      const lim = (k: string) => countArg(formStr(c, k)) || null;   // empty or 0 = unlimited
      const org = await first(c.db, "SELECT * FROM orgs WHERE id = ?", orgId);
      if (org) {
        await run(c.db, "UPDATE orgs SET max_users = ?, max_devices = ?, max_cards = ? WHERE id = ?", lim("max_users"), lim("max_devices"), lim("max_cards"), orgId);
        c.session.flash("سقف‌ها ذخیره شد.", "ok");
      }
    } else if (action === "reject") {
      const org = await first(c.db, "SELECT * FROM orgs WHERE id = ? AND approved = 0", orgId);
      if (org) {
        await run(c.db, "DELETE FROM orgs WHERE id = ?", orgId);   // its user goes with it (ON DELETE CASCADE)
        c.session.flash(`درخواست «${org.name}» رد و حذف شد.`, "ok");
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
  const [orgs, users, adminPlans, adminProducts, invoices, rentals] = await Promise.all([
    all(c.db,
      `SELECT o.*,
         (SELECT COUNT(*) FROM devices WHERE org_id = o.id) AS n_devices,
         (SELECT COUNT(*) FROM cards WHERE org_id = o.id) AS n_cards,
         (SELECT COUNT(*) FROM classes WHERE org_id = o.id) AS n_classes,
         (SELECT MAX(ts) FROM events WHERE org_id = o.id) AS last_event
       FROM orgs o ORDER BY o.approved, o.name COLLATE NOCASE`),
    all(c.db, "SELECT id, username, org_id FROM users ORDER BY username"),
    B.plans(c.db),
    B.products(c.db, true),
    all(c.db, "SELECT i.*, o.name AS org_name FROM invoices i JOIN orgs o ON o.id = i.org_id ORDER BY i.id DESC LIMIT 50"),
    all(c.db, "SELECT r.*, p.name, o.name AS org_name FROM rentals r JOIN products p ON p.id = r.product_id JOIN orgs o ON o.id = r.org_id WHERE r.ended_at IS NULL ORDER BY r.started_at DESC"),
  ]);
  const byOrg = new Map<number | null, Row[]>();
  for (const u of users) byOrg.set(u.org_id, [...(byOrg.get(u.org_id) || []), u]);
  return page(V.adminPage(pageCtx(c), {
    orgs: orgs.filter((o) => o.approved), pending: orgs.filter((o) => !o.approved).sort((a, b) => a.created_at - b.created_at), users: byOrg, apiEnabled: Boolean(c.env.ACCESSCTL_API_TOKEN), webhook: c.env.ACCESSCTL_WEBHOOK_URL || "",
    plans: adminPlans, products: adminProducts, invoices, rentals, payments: B.paymentsEnabled(c.env),
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
route("GET", "/", "live", home, "none");
route("GET,POST", "/register", "register", register, "none");
route("GET", "/robots.txt", "robots", robotsTxt, "none");
route("GET", "/sitemap.xml", "sitemap", sitemapXml, "none");
route("GET", "/llms.txt", "llms", llmsTxt, "none");
route("GET", "/live/feed", "live_feed", liveFeed, "none");
route("GET", "/kiosk/:token", "kiosk", kiosk, "none");
route("GET", "/kiosk/:token/feed", "kiosk_feed", kioskFeed, "none");
route("GET", "/pricing", "pricing", pricing, "none");
route("GET", "/billing/callback", "billing_callback", billingCallback, "none");
route("GET", "/billing", "billing", billing);
route("POST", "/billing/checkout", "billing_checkout", billingCheckout);
route("POST", "/billing/cancel", "billing_cancel", billingCancel);
route("POST", "/billing/resume", "billing_resume", billingResume);
route("GET", "/billing/invoices", "invoices", invoicesList);
route("GET", "/billing/invoices/:int", "invoice", invoiceView);
route("POST", "/billing/invoices/:int/pay", "invoice_pay", invoicePay);
route("GET", "/store", "store", store);
route("POST", "/store/order", "store_order", storeOrder);
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
    req, env, url, db: env.DB, session, user: null, owner: false, org: null, pending: 0,
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
    } else if (r.auth === "login" && !c.owner && !c.org!.approved) {
      res = page(V.pendingPage(pageCtx(c), c.org!));   // registered, waiting for a server owner
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

  // only the public landing and sign-up pages may be indexed
  const indexable = !c.user && (r.endpoint === "live" || r.endpoint === "register" || r.endpoint === "pricing") && res.status === 200;
  if (!indexable && !["robots", "sitemap", "llms"].includes(r.endpoint)) {
    res = new Response(res.body, res);
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
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
