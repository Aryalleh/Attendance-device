"""Jalali (Shamsi) calendar helpers and Persian digits — no external dependencies."""
import re
from datetime import date

MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
          "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]
WEEKDAYS = ["دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه", "یکشنبه"]  # date.weekday() order

_FA = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
_TO_LATIN = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def fa(s):
    """Latin digits -> Persian digits."""
    return str(s).translate(_FA)


def latin(s):
    """Persian/Arabic digits -> Latin digits."""
    return str(s).translate(_TO_LATIN)


def g2j(gy, gm, gd):
    g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    gy2 = gy + 1 if gm > 2 else gy
    days = (355666 + 365 * gy + (gy2 + 3) // 4 - (gy2 + 99) // 100
            + (gy2 + 399) // 400 + gd + g_d_m[gm - 1])
    jy = -1595 + 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        return jy, 1 + days // 31, 1 + days % 31
    return jy, 7 + (days - 186) // 30, 1 + (days - 186) % 30


def j2g(jy, jm, jd):
    jy += 1595
    days = (-355668 + 365 * jy + (jy // 33) * 8 + ((jy % 33) + 3) // 4 + jd
            + ((jm - 1) * 31 if jm < 7 else (jm - 7) * 30 + 186))
    gy = 400 * (days // 146097)
    days %= 146097
    if days > 36524:
        days -= 1
        gy += 100 * (days // 36524)
        days %= 36524
        if days >= 365:
            days += 1
    gy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        gy += (days - 1) // 365
        days = (days - 1) % 365
    gd = days + 1
    leap = (gy % 4 == 0 and gy % 100 != 0) or gy % 400 == 0
    month_len = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    gm = 0
    while gd > month_len[gm]:
        gd -= month_len[gm]
        gm += 1
    return gy, gm + 1, gd


def to_jalali(d):
    return g2j(d.year, d.month, d.day)


def jstr(d):
    """date -> '1405/08/11' (Latin digits, for inputs/URLs)."""
    y, m, dd = to_jalali(d)
    return f"{y}/{m:02d}/{dd:02d}"


def jlong(d):
    """date -> 'یکشنبه ۱۱ آبان ۱۴۰۵'."""
    y, m, dd = to_jalali(d)
    return f"{WEEKDAYS[d.weekday()]} {fa(dd)} {MONTHS[m - 1]} {fa(y)}"


def parse(s):
    """Parse '1405/08/11', '۱۴۰۵-۸-۱۱' (Jalali) or '2026-11-02' (Gregorian) -> date, else None."""
    if not s:
        return None
    parts = re.split(r"[/\-.\s]+", latin(s).strip())
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    y, m, d = map(int, parts)
    try:
        if y > 1700:
            return date(y, m, d)
        if not (1 <= m <= 12 and 1 <= d <= (31 if m <= 6 else 30)):
            return None
        g = date(*j2g(y, m, d))
        return g if to_jalali(g) == (y, m, d) else None   # rejects 30 Esfand in non-leap years
    except ValueError:
        return None
