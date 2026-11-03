// Panel pages — port of server/templates/*.html (Persian, RTL).
import { html, qs, raw, Safe } from "./html";
import type { Row } from "./db";
import * as J from "./jalali";
import { ago, jdt, jinput, jtime } from "./time";

export const RESULT_FA: Record<string, string> = {
  granted: "مجاز", unknown: "کارت ناشناس", disabled: "مسدود",
  expired: "منقضی", denied: "رد شد", manual: "باز کردن دستی",
};
export const DIR_FA: Record<string, string> = { in: "ورود", out: "خروج", toggle: "ورود/خروج متناوب" };

/** What every page needs from the request. */
export type PageCtx = {
  user?: string;
  endpoint: string;
  csrf: string;
  flashes: [string, string][];
};

const FONT = "/static/fonts/Vazirmatn.woff2";
const NAV: [string, string, string][] = [
  ["live", "/", "نمایشگر"], ["dashboard", "/dashboard", "داشبورد"], ["cards", "/cards", "کارت‌ها"],
  ["doors", "/doors", "درها"], ["events", "/events", "گزارش تردد"], ["attendance", "/attendance", "حضور و غیاب"],
  ["settings", "/settings", "تنظیمات"],
];

export function layout(c: PageCtx, title: string, body: Safe): Safe {
  const navOn = (ep: string) => c.endpoint === ep || (ep === "cards" && (c.endpoint === "card_new" || c.endpoint === "card_edit"));
  return html`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
${c.user ? html`<header><div class="in">
  <span class="brand">🔑 کنترل تردد</span>
  <nav>
    ${NAV.map(([ep, href, label]) => html`<a href="${href}" class="${navOn(ep) ? "on" : ""}">${label}</a>`)}
  </nav>
  <form method="post" action="/logout">${csrf(c)}<button class="btn sec sm">خروج (${c.user})</button></form>
</div></header>` : ""}
<main>
${c.flashes.map(([cat, msg]) => html`<div class="flash ${cat}">${msg}</div>`)}
${body}
</main>
</body>
</html>`;
}

// --- macros ------------------------------------------------------------------

export const csrf = (c: PageCtx) => html`<input type="hidden" name="csrf" value="${c.csrf}">`;

function resultPill(r: string) {
  const cls = ({ granted: "ok", manual: "mut", expired: "warn", disabled: "warn" } as Record<string, string>)[r] || "bad";
  return html`<span class="pill ${cls}">${RESULT_FA[r] || r}</span>`;
}

function dirLabel(d: string) {
  if (d === "in") return html`← ورود`;
  if (d === "out") return html`خروج →`;
  return html`<span class="mut">—</span>`;
}

function eventsTable(rows: Row[], showDoor = true) {
  return html`<div class="scroll"><table>
<thead><tr><th>زمان</th><th>نام</th><th>شناسه کارت</th>${showDoor ? html`<th>در</th>` : ""}<th>نتیجه</th><th>جهت</th></tr></thead>
<tbody>
${rows.length ? rows.map((e) => html`
<tr>
  <td class="nowrap">${jdt(e.ts)}${e.offline ? html` <span class="pill mut" title="هنگام قطع بودن سرور، توسط خود دستگاه تصمیم‌گیری شده">آفلاین</span>` : ""}</td>
  <td>${e.card_id ? html`<a href="/cards/${e.card_id}">${e.name}</a>` : e.name || ""}</td>
  <td class="mono">${e.result === "unknown" ? html`<a href="/cards/new${qs({ uid: e.uid })}" title="ثبت این کارت">${e.uid}</a>` : e.uid}</td>
  ${showDoor ? html`<td>${e.door || "—"}</td>` : ""}
  <td>${resultPill(e.result)}</td>
  <td class="nowrap">${dirLabel(e.direction)}</td>
</tr>`) : html`<tr><td colspan="6" class="mut">رویدادی ثبت نشده است.</td></tr>`}
</tbody></table></div>`;
}

const dot = (on: boolean) => html`<span class="dot ${on ? "on" : "off"}"></span>`;

// --- pages -------------------------------------------------------------------

export function loginPage(c: PageCtx) {
  return layout(c, "ورود · کنترل تردد", html`
<div class="login box">
  <h1>🔑 کنترل تردد</h1>
  <form method="post">
    ${csrf(c)}
    <label>نام کاربری</label><input name="username" dir="ltr" autocomplete="username" autofocus required>
    <label>رمز عبور</label><input name="password" dir="ltr" type="password" autocomplete="current-password" required>
    <p><button class="btn">ورود</button></p>
  </form>
</div>`);
}

export function dashboardPage(c: PageCtx, v: {
  cards: Row[]; inside: Row[]; stats: Row | null; recent: Row[]; unknown: Row[]; doors: Row[]; onlineAfter: number;
}) {
  return layout(c, "داشبورد · کنترل تردد", html`
<div class="stats">
  <div class="stat"><b>${J.fa(v.inside.length)}</b><span>نفر داخل</span></div>
  <div class="stat"><b>${J.fa(v.stats?.granted || 0)}</b><span>تردد مجاز امروز</span></div>
  <div class="stat"><b>${J.fa(v.stats?.denied || 0)}</b><span>تردد رد شده امروز</span></div>
  <div class="stat"><b>${J.fa(v.cards.length)}</b><span>کارت ثبت‌شده</span></div>
</div>

<div class="grid">
  <div class="box">
    <h2>درها</h2>
    ${v.doors.length ? v.doors.map((d) => html`
    <div class="row" style="padding:4px 0">
      <div>${dot(d.last_seen && d.last_seen >= v.onlineAfter)}${d.name}
        <span class="mut">· ${ago(d.last_seen)}</span></div>
      <form class="inline auto" method="post" action="/doors/${d.id}/open">${csrf(c)}<button class="btn sm">باز کن</button></form>
    </div>`) : html`
    <p class="mut">هنوز دری تعریف نشده. از صفحه <a href="/doors">درها</a> یک در اضافه کنید و کلید آن را در تنظیمات دستگاه وارد کنید.</p>`}
  </div>

  <div class="box">
    <h2>افراد داخل</h2>
    ${v.inside.length ? v.inside.map((p) => html`
    <div style="padding:3px 0"><a href="/cards/${p.id}">${p.name}</a> <span class="mut">از ساعت ${jtime(p.last_ts)}</span></div>`)
      : html`<p class="mut">کسی داخل نیست.</p>`}
  </div>

  ${v.unknown.length ? html`
  <div class="box">
    <h2>کارت‌های ثبت‌نشده (۷ روز اخیر)</h2>
    <table>
      ${v.unknown.map((u) => html`
      <tr><td class="mono">${u.uid}</td><td class="mut">${J.fa(u.n)} بار · ${ago(u.ts)}${u.door ? html` · ${u.door}` : ""}</td>
        <td class="end"><a class="btn sm" href="/cards/new${qs({ uid: u.uid })}">ثبت کارت</a></td></tr>`)}
    </table>
  </div>` : ""}
</div>

<div class="box">
  <div class="row"><h2>آخرین ترددها</h2><a class="auto" href="/events">گزارش کامل ←</a></div>
  ${eventsTable(v.recent)}
</div>
<script>setTimeout(()=>location.reload(), 15000)</script>`);
}

export function cardsPage(c: PageCtx, v: { cards: Row[]; q: string; today: string }) {
  return layout(c, "کارت‌ها · کنترل تردد", html`
<div class="row" style="margin-bottom:12px">
  <h1>کارت‌ها</h1>
  <form class="auto" method="get"><input name="q" value="${v.q}" placeholder="جستجوی نام، شناسه، توضیحات"></form>
  <a class="btn auto" href="/cards/new">+ کارت جدید</a>
</div>
<div class="box scroll">
<table>
<thead><tr><th>نام</th><th>شناسه کارت</th><th>دسترسی</th><th>وضعیت حضور</th><th>آخرین تردد</th><th></th></tr></thead>
<tbody>
${v.cards.length ? v.cards.map((k) => html`
<tr>
  <td><a href="/cards/${k.id}">${k.name}</a>${k.note ? html`<div class="mut" style="font-size:12px">${k.note}</div>` : ""}</td>
  <td class="mono">${k.uid}</td>
  <td>
    ${!k.enabled ? html`<span class="pill bad">مسدود</span>`
      : k.valid_until && k.valid_until < v.today ? html`<span class="pill warn">منقضی (${J.fa(jinput(k.valid_until))})</span>`
      : html`<span class="pill ok">مجاز</span>${k.valid_until ? html` <span class="mut" style="font-size:12px">تا ${J.fa(jinput(k.valid_until))}</span>` : ""}`}
  </td>
  <td>${k.last_dir === "in" ? html`<span class="pill ok">داخل</span>` : k.last_dir === "out" ? html`<span class="pill mut">بیرون</span>` : html`<span class="mut">—</span>`}</td>
  <td class="nowrap mut">${ago(k.last_ts)}</td>
  <td class="nowrap end">
    <form class="inline" method="post" action="/cards/${k.id}/toggle">${csrf(c)}<button class="btn sec sm">${k.enabled ? "مسدود کن" : "مجاز کن"}</button></form>
    <a class="btn sec sm" href="/cards/${k.id}">ویرایش</a>
  </td>
</tr>`) : html`
<tr><td colspan="6" class="mut">${v.q ? "موردی پیدا نشد." : "هنوز کارتی ثبت نشده. یک کارت جدید را جلوی دستگاه بگیرید؛ در داشبورد با دکمه «ثبت کارت» نمایش داده می‌شود."}</td></tr>`}
</tbody>
</table>
</div>`);
}

export function cardFormPage(c: PageCtx, v: { card: Row; isNew: boolean; cardId?: number; history?: Row[] }) {
  const k = v.card;
  const enabled = k.enabled && k.enabled !== "0";
  return layout(c, `${v.isNew ? "کارت جدید" : k.name} · کنترل تردد`, html`
<h1>${v.isNew ? "کارت جدید" : "ویرایش کارت"}</h1>
<div class="box">
<form method="post">
  ${csrf(c)}
  <div class="row">
    <div><label>نام و نام خانوادگی</label><input name="name" value="${k.name || ""}" maxlength="32" required autofocus></div>
    <div><label>شناسه کارت (UID)</label><input name="uid" class="mono" value="${k.uid || ""}" placeholder="04:A3:1B:2C" required></div>
  </div>
  <div class="row">
    <div><label>توضیحات (واحد، تلفن، …)</label><input name="note" value="${k.note || ""}" maxlength="200"></div>
    <div><label>اعتبار تا تاریخ (خالی = بدون انقضا)</label><input name="valid_until" dir="ltr" value="${jinput(k.valid_until)}" placeholder="1405/12/29"></div>
  </div>
  <label class="check"><input type="checkbox" name="enabled" value="1" ${enabled ? "checked" : ""}> دسترسی مجاز است</label>
  <p class="row">
    <button class="btn auto">ذخیره</button>
    <a class="btn sec auto" href="/cards">انصراف</a>
  </p>
</form>
${v.isNew ? html`<p class="mut">راهنما: شناسه کارت را نمی‌دانید؟ کارت را جلوی یکی از دستگاه‌ها بگیرید؛ در داشبورد زیر «کارت‌های ثبت‌نشده» ظاهر می‌شود.</p>` : ""}
</div>
${!v.isNew ? html`
<div class="box">
  <h2>سوابق تردد</h2>
  ${eventsTable(v.history || [])}
</div>
<form method="post" action="/cards/${v.cardId}/delete" onsubmit="return confirm('این کارت حذف شود؟')">
  ${csrf(c)}<button class="btn red">حذف کارت</button>
</form>` : ""}`);
}

const DIR_LONG: Record<string, string> = { in: "فقط ورود", out: "فقط خروج", toggle: "ورود/خروج متناوب" };

export function doorsPage(c: PageCtx, v: {
  doors: Row[]; onlineAfter: number; newKey?: { name: string; key: string }; kioskLinks: Record<number, string>; origin: string;
}) {
  return layout(c, "درها · کنترل تردد", html`
<h1>درها</h1>

${v.newKey ? html`
<div class="key">
  <b>کلید دستگاه برای «${v.newKey.name}»</b> — آن را در پنل دستگاه، بخش تنظیمات ← سرور وارد کنید. این کلید فقط یک بار نمایش داده می‌شود.
  <code dir="ltr">${v.newKey.key}</code>
  آدرس سرور برای دستگاه: <span class="mono">${v.origin}</span>
</div>` : ""}

<div class="box scroll">
<table>
<thead><tr><th>در</th><th>وضعیت</th><th>جهت</th><th>زمان باز ماندن</th><th>نسخه / IP</th><th></th></tr></thead>
<tbody>
${v.doors.length ? v.doors.map((d) => html`
<tr>
  <td><b>${d.name}</b>${!d.enabled ? html` <span class="pill bad">غیرفعال</span>` : ""}</td>
  <td class="nowrap">${dot(d.last_seen && d.last_seen >= v.onlineAfter)}${ago(d.last_seen)}</td>
  <td>${DIR_LONG[d.direction]}</td>
  <td>${J.fa((d.open_ms / 1000).toFixed(1))} ثانیه</td>
  <td class="mono mut">${d.fw || "—"} · ${d.last_ip || "—"}</td>
  <td class="nowrap end">
    <form class="inline" method="post" action="/doors/${d.id}/open">${csrf(c)}<button class="btn sm">باز کن</button></form>
    <a class="btn sec sm" href="${v.kioskLinks[d.id]}" target="_blank" title="لینک نمایشگر این در برای تبلت/مانیتور کنار در — بدون نیاز به ورود. با «کلید جدید» باطل می‌شود.">نمایشگر</a>
    <details style="display:inline-block;vertical-align:top"><summary class="btn sec sm">ویرایش</summary>
      <div class="box popup">
        <form method="post" action="/doors/${d.id}">${csrf(c)}
          <label>نام</label><input name="name" value="${d.name}" required>
          <label>جهت</label>
          <select name="direction">${[["toggle", "ورود/خروج متناوب"], ["in", "فقط ورود"], ["out", "فقط خروج"]].map(([val, l]) =>
            html`<option value="${val}" ${d.direction === val ? "selected" : ""}>${l}</option>`)}</select>
          <label>زمان باز ماندن قفل (میلی‌ثانیه)</label><input name="open_ms" type="number" dir="ltr" min="500" max="30000" value="${d.open_ms}">
          <label class="check"><input type="checkbox" name="enabled" value="1" ${d.enabled ? "checked" : ""}> فعال (در غیرفعال همه کارت‌ها را رد می‌کند)</label>
          <p><button class="btn">ذخیره</button></p>
        </form>
        <form class="inline" method="post" action="/doors/${d.id}/rekey" onsubmit="return confirm('کلید جدید ساخته شود؟ تا وارد کردن کلید جدید، دستگاه کار نمی‌کند.')">${csrf(c)}<button class="btn sec sm">کلید جدید</button></form>
        <form class="inline" method="post" action="/doors/${d.id}/delete" onsubmit="return confirm('این در حذف شود؟')">${csrf(c)}<button class="btn red sm">حذف</button></form>
      </div>
    </details>
  </td>
</tr>`) : html`
<tr><td colspan="6" class="mut">هنوز دری تعریف نشده است.</td></tr>`}
</tbody>
</table>
</div>

<div class="box">
  <h2>افزودن در</h2>
  <form method="post" action="/doors/new" class="row">
    ${csrf(c)}
    <div><label>نام</label><input name="name" placeholder="ورودی اصلی" required></div>
    <div><label>جهت</label><select name="direction"><option value="toggle">ورود/خروج متناوب</option><option value="in">فقط ورود</option><option value="out">فقط خروج</option></select></div>
    <div><label>زمان باز ماندن قفل (میلی‌ثانیه)</label><input name="open_ms" type="number" dir="ltr" min="500" max="30000" value="3000"></div>
    <div class="auto"><button class="btn">افزودن</button></div>
  </form>
  <p class="mut">دکمه «نمایشگر» یک لینک اختصاصی برای تبلت یا مانیتور کنار همان در باز می‌کند که بدون ورود به پنل، نام فرد و نتیجه را با صدا نشان می‌دهد. هر کس این لینک را داشته باشد ترددهای آن در را می‌بیند؛ با «کلید جدید» باطل می‌شود.</p>
  <p class="mut">برای ثبت دقیق ورود و خروج از دو دستگاه استفاده کنید (یکی «فقط ورود» و یکی «فقط خروج»)، یا یک دستگاه در حالت «متناوب» که هر بار کارت‌زدن به ترتیب ورود ← خروج ثبت می‌شود.</p>
</div>`);
}

export function eventsPage(c: PageCtx, v: {
  rows: Row[]; total: number; page: number; pages: number; doors: Row[]; args: Record<string, string>;
}) {
  const a = v.args;
  return layout(c, "گزارش تردد · کنترل تردد", html`
<h1>گزارش تردد</h1>
<form class="box row" method="get">
  <div><label>جستجو</label><input name="q" value="${a.q || ""}" placeholder="نام یا شناسه کارت"></div>
  <div><label>نتیجه</label><select name="result"><option value="">همه</option>
    ${["granted", "unknown", "disabled", "expired", "denied", "manual"].map((r) =>
      html`<option value="${r}" ${a.result === r ? "selected" : ""}>${RESULT_FA[r]}</option>`)}</select></div>
  <div><label>در</label><select name="door"><option value="">همه</option>
    ${v.doors.map((d) => html`<option value="${d.id}" ${a.door === String(d.id) ? "selected" : ""}>${d.name}</option>`)}</select></div>
  <div><label>از تاریخ</label><input name="from" dir="ltr" value="${a.from || ""}" placeholder="1405/08/01"></div>
  <div><label>تا تاریخ</label><input name="to" dir="ltr" value="${a.to || ""}" placeholder="1405/08/30"></div>
  <div class="auto"><button class="btn">فیلتر</button> <a class="btn sec" href="/events.csv${qs(a)}">خروجی اکسل (CSV)</a></div>
</form>
<div class="box">
  <p class="mut" style="margin-top:0">${J.fa(v.total)} رویداد</p>
  ${eventsTable(v.rows)}
  ${v.pages > 1 ? html`
  <div class="pager">
    ${v.page > 1 ? html`<a class="btn sec sm" href="/events${qs({ page: v.page - 1, ...a })}">→ جدیدتر</a>` : ""}
    <span class="mut">صفحه ${J.fa(v.page)} از ${J.fa(v.pages)}</span>
    ${v.page < v.pages ? html`<a class="btn sec sm" href="/events${qs({ page: v.page + 1, ...a })}">قدیمی‌تر ←</a>` : ""}
  </div>` : ""}
</div>`);
}

export function attendancePage(c: PageCtx, v: { rows: Row[]; day: string; prev: string; next: string }) {
  return layout(c, "حضور و غیاب · کنترل تردد", html`
<div class="row" style="margin-bottom:12px">
  <h1>حضور و غیاب — ${J.jlong(v.day)}</h1>
  <a class="btn sec auto" href="/attendance${qs({ date: J.jstr(v.prev) })}" title="روز قبل">→</a>
  <form class="auto" method="get"><input name="date" dir="ltr" value="${J.jstr(v.day)}" style="width:9em" onchange="this.form.submit()"></form>
  <a class="btn sec auto" href="/attendance${qs({ date: J.jstr(v.next) })}" title="روز بعد">←</a>
</div>
<div class="box scroll">
<table>
<thead><tr><th>نام</th><th>اولین ورود</th><th>آخرین خروج</th><th>مدت حضور</th><th>تعداد تردد</th></tr></thead>
<tbody>
${v.rows.length ? v.rows.map((r) => {
    const a = r.first_in || r.first_seen, b = r.last_out;
    return html`
<tr>
  <td><a href="/cards/${r.id}">${r.name}</a></td>
  <td>${r.first_in ? jtime(r.first_in) : "—"}</td>
  <td>${r.last_out ? jtime(r.last_out) : "—"}</td>
  <td>${b && b > a ? `${J.fa(Math.floor((b - a) / 3600))} ساعت و ${J.fa(Math.floor(((b - a) % 3600) / 60))} دقیقه` : html`<span class="mut">—</span>`}</td>
  <td>${J.fa(r.scans)} <a class="mut" href="/events${qs({ q: r.uid, from: J.jstr(v.day), to: J.jstr(v.day) })}">جزئیات</a></td>
</tr>`;
  }) : html`
<tr><td colspan="5" class="mut">در این روز ترددی ثبت نشده است.</td></tr>`}
</tbody>
</table>
</div>`);
}

export function settingsPage(c: PageCtx, v: { users: Row[]; nEvents: number; apiEnabled: boolean; webhook: string }) {
  return layout(c, "تنظیمات · کنترل تردد", html`
<h1>تنظیمات</h1>
<div class="grid">
  <div class="box">
    <h2>تغییر رمز عبور من</h2>
    <form method="post">${csrf(c)}<input type="hidden" name="action" value="password">
      <label>رمز فعلی</label><input type="password" dir="ltr" name="current" autocomplete="current-password" required>
      <label>رمز جدید (حداقل ۸ کاراکتر)</label><input type="password" dir="ltr" name="new" autocomplete="new-password" minlength="8" required>
      <p><button class="btn">تغییر رمز</button></p>
    </form>
  </div>

  <div class="box">
    <h2>کاربران پنل</h2>
    <table>
      ${v.users.map((u) => html`
      <tr><td class="ltr">${u.username}${u.username === c.user ? html` <span class="mut">(شما)</span>` : ""}</td>
        <td class="end">${v.users.length > 1 ? html`<form class="inline" method="post" onsubmit="return confirm(this.dataset.q)" data-q="کاربر ${u.username} حذف شود؟">${csrf(c)}<input type="hidden" name="action" value="del_user"><input type="hidden" name="id" value="${u.id}"><button class="btn red sm">حذف</button></form>` : ""}</td></tr>`)}
    </table>
    <form method="post" class="row">${csrf(c)}<input type="hidden" name="action" value="add_user">
      <div><label>نام کاربری</label><input name="username" dir="ltr" required></div>
      <div><label>رمز عبور</label><input type="password" dir="ltr" name="password" minlength="8" required></div>
      <div class="auto"><button class="btn">افزودن</button></div>
    </form>
  </div>

  <div class="box">
    <h2>داده‌ها</h2>
    <p>${J.fa(v.nEvents)} رویداد ذخیره شده است.</p>
    <form method="post" class="row" onsubmit="return confirm('رویدادهای قدیمی برای همیشه حذف شوند؟')">${csrf(c)}<input type="hidden" name="action" value="purge">
      <div><label>حذف رویدادهای قدیمی‌تر از (روز)</label><input type="number" dir="ltr" name="days" min="1" value="365"></div>
      <div class="auto"><button class="btn red">حذف</button></div>
    </form>
  </div>

  <div class="box">
    <h2>اتصال به سرویس‌های دیگر</h2>
    <p>API فقط‌خواندنی: ${v.apiEnabled ? html`<span class="pill ok">فعال</span>` : html`<span class="pill mut">غیرفعال</span> — secret <span class="mono">ACCESSCTL_API_TOKEN</span> را تنظیم کنید`}</p>
    <p class="mono mut" style="font-size:12px;text-align:left">GET /api/v1/presence<br>GET /api/v1/events?since=&lt;last id&gt;<br>Header: Authorization: Bearer &lt;token&gt;</p>
    <p>Webhook: ${v.webhook ? html`<span class="mono">${v.webhook}</span>` : html`<span class="pill mut">غیرفعال</span> — secret <span class="mono">ACCESSCTL_WEBHOOK_URL</span> را تنظیم کنید`}</p>
  </div>
</div>`);
}

export function errorPage(status: number, message: string) {
  return html`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title>
<link rel="stylesheet" href="/static/style.css"></head>
<body><main><div class="box"><h1>${status}</h1><p>${message}</p><p><a href="/">بازگشت</a></p></div></main></body></html>`;
}

export { raw };
