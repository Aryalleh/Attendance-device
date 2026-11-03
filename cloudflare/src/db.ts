// D1 storage — port of server/db.py. Schema lives in migrations/0001_init.sql.
import { today } from "./time";

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
  ts: number; deviceId: number; uid: string; card: Row | null; result: string; direction?: string; offline?: boolean;
}) {
  return stmt(db,
    `INSERT INTO events(ts, device_id, uid, card_id, name, result, direction, offline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.ts, e.deviceId, e.uid, e.card ? e.card.id : null, e.card ? e.card.name : "",
    e.result, e.direction || "", e.offline ? 1 : 0);
}

export const EVENT_SELECT = "SELECT e.*, d.name AS door FROM events e LEFT JOIN devices d ON d.id = e.device_id ";
