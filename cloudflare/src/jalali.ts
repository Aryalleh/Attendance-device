// Jalali (Shamsi) calendar helpers and Persian digits — port of server/jalali.py.
// Gregorian dates are passed around as ISO strings ('2026-11-02').

export const MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
// Monday-first, like Python's date.weekday()
const WEEKDAYS = ["دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه", "یکشنبه"];

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits -> Persian digits. */
export function fa(s: unknown): string {
  return String(s).replace(/[0-9]/g, (c) => FA_DIGITS[+c]);
}

/** Persian/Arabic digits -> Latin digits. */
export function latin(s: unknown): string {
  return String(s)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

const div = (a: number, b: number) => Math.floor(a / b);
const mod = (a: number, b: number) => ((a % b) + b) % b;

export function g2j(gy: number, gm: number, gd: number): [number, number, number] {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * div(days, 12053);
  days = mod(days, 12053);
  jy += 4 * div(days, 1461);
  days = mod(days, 1461);
  if (days > 365) {
    jy += div(days - 1, 365);
    days = mod(days - 1, 365);
  }
  if (days < 186) return [jy, 1 + div(days, 31), 1 + mod(days, 31)];
  return [jy, 7 + div(days - 186, 30), 1 + mod(days - 186, 30)];
}

export function j2g(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + div(jy, 33) * 8 + div(mod(jy, 33) + 3, 4) + jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * div(days, 146097);
  days = mod(days, 146097);
  if (days > 36524) {
    days -= 1;
    gy += 100 * div(days, 36524);
    days = mod(days, 36524);
    if (days >= 365) days += 1;
  }
  gy += 4 * div(days, 1461);
  days = mod(days, 1461);
  if (days > 365) {
    gy += div(days - 1, 365);
    days = mod(days - 1, 365);
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthLen = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gd > monthLen[gm]) {
    gd -= monthLen[gm];
    gm += 1;
  }
  return [gy, gm + 1, gd];
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isoParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

export function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

/** Valid Gregorian date -> ISO string, else null. */
export function gregorian(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return isoOf(y, m, d);
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = isoParts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function toJalali(iso: string): [number, number, number] {
  return g2j(...isoParts(iso));
}

/** ISO date -> '1405/08/11' (Latin digits, for inputs/URLs). */
export function jstr(iso: string): string {
  const [y, m, d] = toJalali(iso);
  return `${y}/${pad(m)}/${pad(d)}`;
}

/** ISO date -> 'یکشنبه ۱۱ آبان ۱۴۰۵'. */
export function jlong(iso: string): string {
  const [y, m, d] = toJalali(iso);
  const [gy, gm, gd] = isoParts(iso);
  const weekday = (new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[weekday]} ${fa(d)} ${MONTHS[m - 1]} ${fa(y)}`;
}

/** '1405/08/11', '۱۴۰۵-۸-۱۱' (Jalali) or '2026-11-02' (Gregorian) -> ISO date, else null. */
export function parse(s: string | null | undefined): string | null {
  if (!s) return null;
  const parts = latin(s).trim().split(/[/\-.\s]+/);
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const [y, m, d] = parts.map(Number);
  if (y > 1700) return gregorian(y, m, d);
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= (m <= 6 ? 31 : 30))) return null;
  const g = gregorian(...j2g(y, m, d));
  if (!g) return null;
  const back = toJalali(g);
  return back[0] === y && back[1] === m && back[2] === d ? g : null; // rejects 30 Esfand in non-leap years
}
