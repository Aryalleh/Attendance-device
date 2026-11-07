// Local-time helpers. The Flask server used the machine's clock; Workers run in UTC,
// so the panel's time zone comes from the TZ variable in wrangler.toml.
import * as J from "./jalali";

let TZ = "Asia/Tehran";
const formatters = new Map<string, Intl.DateTimeFormat>();

export function setTimeZone(tz: string | undefined) {
  if (tz) TZ = tz;
}

export const now = () => Math.floor(Date.now() / 1000);

type Parts = { y: number; m: number; d: number; H: number; M: number; S: number };

export function localParts(ts: number): Parts {
  let f = formatters.get(TZ);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(TZ, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts * 1000))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour, M: +o.minute, S: +o.second };
}

function offset(ts: number): number {
  const p = localParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S) / 1000 - ts;
}

/** Local calendar date of a timestamp, as ISO. */
export function localDate(ts: number): string {
  const p = localParts(ts);
  return J.isoOf(p.y, p.m, p.d);
}

export const today = () => localDate(now());

/** Unix time of local midnight starting this ISO date. */
function dayStart(iso: string): number {
  const [y, m, d] = J.isoParts(iso);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  const first = guess - offset(guess);
  return guess - offset(first);
}

export function dayBounds(iso: string): [number, number] {
  return [dayStart(iso), dayStart(J.addDays(iso, 1))];
}

const pad = (n: number) => String(n).padStart(2, "0");

export function hms(ts: number, seconds = true): string {
  const p = localParts(ts);
  return seconds ? `${pad(p.H)}:${pad(p.M)}:${pad(p.S)}` : `${pad(p.H)}:${pad(p.M)}`;
}

// --- display filters (same names as the Jinja filters) ----------------------

/** Gregorian, Latin digits (CSV / webhook). */
export function fmtDt(ts: number | null): string {
  return ts ? `${localDate(ts)} ${hms(ts)}` : "";
}

export function jdate(ts: number | null): string {
  return ts ? J.fa(J.jstr(localDate(ts))) : "—";
}

/** '۳۰ آبان ۱۴۰۵' */
export function jday(ts: number | null): string {
  if (!ts) return "—";
  const [y, m, d] = J.toJalali(localDate(ts));
  return `${J.fa(d)} ${J.MONTHS[m - 1]} ${J.fa(y)}`;
}

export function jtime(ts: number | null, seconds = false): string {
  return ts ? J.fa(hms(ts, seconds)) : "—";
}

export function jdt(ts: number | null): string {
  return ts ? `${jdate(ts)} ${jtime(ts, true)}` : "—";
}

export function ago(ts: number | null): string {
  if (!ts) return "هرگز";
  const s = Math.max(0, now() - ts);
  if (s < 60) return `${J.fa(s)} ثانیه پیش`;
  if (s < 3600) return `${J.fa(Math.floor(s / 60))} دقیقه پیش`;
  if (s < 86400) return `${J.fa(Math.floor(s / 3600))} ساعت پیش`;
  return `${J.fa(Math.floor(s / 86400))} روز پیش`;
}

/** Value for a Jalali date input: accepts ISO / Jalali text, returns '1405/08/11' or ''. */
export function jinput(v: string | null | undefined): string {
  const d = v ? J.parse(v) : null;
  return d ? J.jstr(d) : v || "";
}
