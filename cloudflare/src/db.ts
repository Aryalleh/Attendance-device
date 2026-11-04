// D1 storage — port of server/db.py. Schema lives in migrations/*.sql (shared with the Flask server).
import * as J from "./jalali";
import { dayBounds, localDate, now, today } from "./time";

export type Row = Record<string, any>;

export async function all(db: D1Database, sql: string, ...params: unknown[]): Promise<Row[]> {
  return (await db.prepare(sql).bind(...params.map(nul)).all<Row>()).results;
}

export async function first(db: D1Database, sql: string, ...params: unknown[]): Promise<Row | null> {
  return db.prepare(sql).bind(...params.map(nul)).first<Row>();
}

export async function run(db: D1Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).bind(...params.map(nul)).run();
}

export const stmt = (db: D1Database, sql: string, ...params: unknown[]) =>
  db.prepare(sql).bind(...params.map(nul));

const nul = (v: unknown) => (v === undefined ? null : v);

export const isUniqueError = (e: unknown) => String((e as Error)?.message ?? e).includes("UNIQUE constraint failed");

/** '04 a3 1b 2c' / '04a31b2c' / '04:A3:1B:2C' -> '04:A3:1B:2C' (or '' if invalid). */
export function normalizeUid(raw: unknown): string {
  const hex = String(raw ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length < 8 || hex.length > 20 || hex.length % 2) return "";
  return hex.match(/../g)!.join(":");
}

export function cleanName(s: unknown, limit = 32): string {
  return Array.from(String(s ?? "").replace(/[\t\r\n"\\]/g, " ").trim()).slice(0, limit).join("");
}

// --- cards -----------------------------------------------------------------

export const bumpCardsRev = (db: D1Database) =>
  stmt(db, "UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'cards_rev'");

/** Changes whenever the card list changes, and daily (so expiries propagate). */
export async function cardsVersion(db: D1Database): Promise<string> {
  const r = await first(db, "SELECT value FROM meta WHERE key = 'cards_rev'");
  return `${r?.value ?? 1}-${today()}`;
}

export function cardValid(card: Row, day = today()): "ok" | "disabled" | "expired" {
  if (!card.enabled) return "disabled";
  if (card.valid_until && day > card.valid_until) return "expired";
  return "ok";
}

const LAST_DIR_SQL = `(SELECT e.direction FROM events e
  WHERE e.card_id = c.id AND e.result = 'granted' AND e.direction IN ('in', 'out')
  ORDER BY e.ts DESC, e.id DESC LIMIT 1)`;
const LAST_TS_SQL = `(SELECT e.ts FROM events e
  WHERE e.card_id = c.id AND e.result = 'granted'
  ORDER BY e.ts DESC, e.id DESC LIMIT 1)`;

export function cardsWithPresence(db: D1Database, where = "1", ...params: unknown[]) {
  return all(db,
    `SELECT c.*, ${LAST_DIR_SQL} AS last_dir, ${LAST_TS_SQL} AS last_ts
     FROM cards c WHERE ${where} ORDER BY c.name COLLATE NOCASE`, ...params);
}

export async function lastDirection(db: D1Database, cardId: number): Promise<string | null> {
  const r = await first(db,
    `SELECT direction FROM events WHERE card_id = ? AND result = 'granted'
     AND direction IN ('in', 'out') ORDER BY ts DESC, id DESC LIMIT 1`, cardId);
  return r ? r.direction : null;
}

// --- events ----------------------------------------------------------------

export function addEvent(db: D1Database, e: {
  orgId: number; ts: number; deviceId: number; uid: string; card: Row | null; result: string; direction?: string;
  offline?: boolean; classId?: number | null; slotId?: number | null; sessionDate?: string | null;
}) {
  return stmt(db,
    `INSERT INTO events(org_id, ts, device_id, uid, card_id, name, result, direction, offline, class_id, slot_id, session_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.orgId, e.ts, e.deviceId, e.uid, e.card ? e.card.id : null, e.card ? e.card.name : "",
    e.result, e.direction || "", e.offline ? 1 : 0, e.classId ?? null, e.slotId ?? null, e.sessionDate ?? null);
}

// --- classes -----------------------------------------------------------------
// Same rules as server/db.py: a slot links a class to a device weekly (weekday 0=Mon..6=Sun
// between from/to dates) or once (on_date). The scan window opens EARLY_MIN before the start
// and stays open LATE_MIN after the end; only start..end counts as time in class.

export const EARLY_MIN = 15;
export const LATE_MIN = 30;

/** Python-style weekday (0=Mon..6=Sun) of an ISO date. */
export function weekday(iso: string): number {
  const [y, m, d] = J.isoParts(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Unix time of a local date + minutes after midnight. */
export const localTs = (iso: string, minutes: number) => dayBounds(iso)[0] + minutes * 60;

export function slotOn(slot: Row, iso: string): boolean {
  if (slot.on_date) return slot.on_date === iso;
  return slot.weekday === weekday(iso) && (!slot.from_date || slot.from_date <= iso) && (!slot.to_date || iso <= slot.to_date);
}

export const sessionWindow = (slot: Row, iso: string): [number, number] => [localTs(iso, slot.start_min), localTs(iso, slot.end_min)];

export type ActiveSlot = { slot: Row; classId: number; slotId: number; sessionDate: string; core: boolean; dist: number };

/** Class sessions open on this device at this time, core window (start..end) first. */
export async function activeSlots(db: D1Database, deviceId: number, ts: number): Promise<ActiveSlot[]> {
  const day = localDate(ts);
  const out: ActiveSlot[] = [];
  for (const s of await all(db, "SELECT * FROM class_slots WHERE device_id = ?", deviceId)) {
    if (!slotOn(s, day)) continue;
    const [start, end] = sessionWindow(s, day);
    if (start - EARLY_MIN * 60 <= ts && ts < end + LATE_MIN * 60) {
      const core = start <= ts && ts < end;
      out.push({ slot: s, classId: s.class_id, slotId: s.id, sessionDate: day, core, dist: core ? 0 : Math.min(Math.abs(ts - start), Math.abs(ts - end)) });
    }
  }
  return out.sort((a, b) => Number(!a.core) - Number(!b.core) || a.dist - b.dist);
}

export async function isMember(db: D1Database, classId: number, cardId: number): Promise<boolean> {
  return (await first(db, "SELECT 1 AS x FROM class_members WHERE class_id = ? AND card_id = ?", classId, cardId)) !== null;
}

export type Decision = { result: string; direction: string; classId: number | null; slotId: number | null; sessionDate: string | null };

/** The access decision for one scan. */
export async function decide(db: D1Database, dev: Row, orgEnabled: boolean, card: Row | null, ts: number): Promise<Decision> {
  const out: Decision = { result: "denied", direction: "", classId: null, slotId: null, sessionDate: null };
  if (!orgEnabled || !dev.enabled) return out;
  if (!card) return { ...out, result: "unknown" };
  const valid = cardValid(card);
  if (valid !== "ok") return { ...out, result: valid };

  const sessions = await activeSlots(db, dev.id, ts);
  if (sessions.length) {
    const mine: ActiveSlot[] = [];
    for (const x of sessions) if (await isMember(db, x.classId, card.id)) mine.push(x);
    const pick = (mine.length ? mine : sessions)[0];
    Object.assign(out, { classId: pick.classId, slotId: pick.slotId, sessionDate: pick.sessionDate });
    if (!mine.length) return { ...out, result: "not_member" };
    let direction = dev.direction;
    if (direction === "toggle") {
      const last = await first(db,
        `SELECT direction FROM events WHERE card_id = ? AND slot_id = ? AND session_date = ? AND result = 'granted'
         ORDER BY ts DESC, id DESC LIMIT 1`, card.id, pick.slotId, pick.sessionDate);
      direction = last && last.direction === "in" ? "out" : "in";
    }
    return { ...out, result: "granted", direction };
  }
  let direction = dev.direction;
  if (direction === "toggle") direction = (await lastDirection(db, card.id)) === "in" ? "out" : "in";
  return { ...out, result: "granted", direction };
}

/** Dates (inclusive ISO range) on which this slot has a session. */
export function sessionDates(slot: Row, firstDay: string, lastDay: string): string[] {
  if (slot.on_date) return firstDay <= slot.on_date && slot.on_date <= lastDay ? [slot.on_date] : [];
  const days: string[] = [];
  for (let d = firstDay; d <= lastDay; d = J.addDays(d, 1)) if (slotOn(slot, d)) days.push(d);
  return days;
}

export type Presence = { secs: number; first_in: number | null; last_out: number | null; open: boolean; scans: number };

/** Seconds inside start..end from a card's sorted in/out events; an entry without an exit counts until the end (or now). */
export function presence(events: Row[], start: number, end: number, nowTs: number): Presence {
  let secs = 0, since: number | null = null, firstIn: number | null = null, lastOut: number | null = null, open = false;
  const clip = (a: number, b: number) => Math.max(0, Math.min(b, end) - Math.max(a, start));
  for (const e of events) {
    if (e.direction === "in") {
      firstIn = firstIn ?? e.ts;
      if (since === null) since = e.ts;
    } else if (e.direction === "out") {
      lastOut = e.ts;
      if (since !== null) {
        secs += clip(since, e.ts);
        since = null;
      }
    }
  }
  if (since !== null) {
    secs += clip(since, Math.min(end, nowTs));
    open = true;
  }
  return { secs, first_in: firstIn, last_out: lastOut, open, scans: events.length };
}

export type ClassSession = { slot: Row; date: string; start: number; end: number };

/** All sessions of a class between two ISO dates (no later than today), newest first. */
export async function classSessions(db: D1Database, cls: Row, firstDay: string, lastDay: string): Promise<ClassSession[]> {
  const t = today();
  if (lastDay > t) lastDay = t;
  const out: ClassSession[] = [];
  const slots = await all(db, "SELECT s.*, d.name AS door FROM class_slots s LEFT JOIN devices d ON d.id = s.device_id WHERE s.class_id = ?", cls.id);
  for (const s of slots) {
    for (const d of sessionDates(s, firstDay, lastDay)) {
      const [start, end] = sessionWindow(s, d);
      out.push({ slot: s, date: d, start, end });
    }
  }
  return out.sort((a, b) => b.start - a.start);
}

const classMembers = (db: D1Database, classId: number) =>
  all(db, "SELECT c.* FROM cards c JOIN class_members m ON m.card_id = c.id WHERE m.class_id = ? ORDER BY c.name COLLATE NOCASE", classId);

async function sessionEvents(db: D1Database, slotId: number, iso: string): Promise<Map<number, Row[]>> {
  const evs = await all(db,
    `SELECT * FROM events WHERE slot_id = ? AND session_date = ? AND result = 'granted' AND card_id IS NOT NULL ORDER BY ts, id`,
    slotId, iso);
  const by = new Map<number, Row[]>();
  for (const e of evs) by.set(e.card_id, [...(by.get(e.card_id) || []), e]);
  return by;
}

/** One session: every member with their time in class, plus refused scans. */
export async function sessionReport(db: D1Database, cls: Row, slot: Row, iso: string, nowTs = now()) {
  const [start, end] = sessionWindow(slot, iso);
  const [members, byCard, refused] = await Promise.all([
    classMembers(db, cls.id),
    sessionEvents(db, slot.id, iso),
    all(db, EVENT_SELECT + "WHERE e.slot_id = ? AND e.session_date = ? AND e.result != 'granted' ORDER BY e.ts", slot.id, iso),
  ]);
  const rows = members.map((c) => ({ card: c, ...presence(byCard.get(c.id) || [], start, end, nowTs) }));
  return { start, end, rows, refused };
}

export type MemberTotal = { card: Row; attended: number; secs: number; pct: number };

/** Per member over many sessions: sessions attended and total time; plus present count per session. */
export async function classSummary(db: D1Database, cls: Row, sessions: ClassSession[], nowTs = now()): Promise<[MemberTotal[], number[]]> {
  const members = await classMembers(db, cls.id);
  const tot = new Map<number, MemberTotal>(members.map((c) => [c.id, { card: c, attended: 0, secs: 0, pct: 0 }]));
  const counts: number[] = [];
  const evs = await Promise.all(sessions.map((s) => sessionEvents(db, s.slot.id, s.date)));
  sessions.forEach((s, i) => {
    let present = 0;
    for (const [cid, t] of tot) {
      const p = presence(evs[i].get(cid) || [], s.start, s.end, nowTs);
      if (p.scans) {
        t.attended++;
        present++;
      }
      t.secs += p.secs;
    }
    counts.push(present);
  });
  const possible = sessions.reduce((a, s) => a + Math.max(0, Math.min(s.end, nowTs) - s.start), 0);
  for (const t of tot.values()) t.pct = possible ? Math.round((100 * t.secs) / possible) : 0;
  return [[...tot.values()], counts];
}

export const EVENT_SELECT = "SELECT e.*, d.name AS door, k.name AS class_name FROM events e LEFT JOIN devices d ON d.id = e.device_id LEFT JOIN classes k ON k.id = e.class_id ";
