// Panel pages — port of server/templates/*.html (Persian, RTL).
import { html, qs, raw, Safe } from "./html";
import type { ClassSession, MemberTotal, Presence, Row } from "./db";
import * as J from "./jalali";
import { ago, jdt, jinput, jtime } from "./time";

export const WEEKDAYS_FA = ["دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه", "یکشنبه"];   // index = 0=Mon..6=Sun
const WEEK_ORDER = [5, 6, 0, 1, 2, 3, 4];   // Saturday first

/** Minutes after midnight -> '۱۰:۳۰'. */
export const hm = (m: number) => J.fa(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/** Seconds -> '۱ ساعت و ۲۵ دقیقه'. */
export function dur(secs: number): string {
  const m = Math.floor((secs || 0) / 60);
  if (m < 60) return `${J.fa(m)} دقیقه`;
  return `${J.fa(Math.floor(m / 60))} ساعت` + (m % 60 ? ` و ${J.fa(m % 60)} دقیقه` : "");
}

export const RESULT_FA: Record<string, string> = {
  granted: "مجاز", unknown: "کارت ناشناس", disabled: "مسدود",
  expired: "منقضی", denied: "رد شد", manual: "باز کردن دستی", not_member: "عضو کلاس نیست",
};
export const DIR_FA: Record<string, string> = { in: "ورود", out: "خروج", toggle: "ورود/خروج متناوب" };

/** What every page needs from the request. */
export type PageCtx = {
  user?: string;
  userId?: number;
  owner?: boolean;
  orgName?: string;
  endpoint: string;
  csrf: string;
  flashes: [string, string][];
};

const FONT = "/static/fonts/Vazirmatn.woff2";
const NAV: [string, string, string][] = [
  ["live", "/", "نمایشگر"], ["dashboard", "/dashboard", "داشبورد"], ["cards", "/cards", "کارت‌ها"],
  ["doors", "/doors", "دستگاه‌ها"], ["classes", "/classes", "کلاس‌ها"], ["events", "/events", "گزارش تردد"],
  ["attendance", "/attendance", "حضور روزانه"], ["settings", "/settings", "تنظیمات"],
];

export function layout(c: PageCtx, title: string, body: Safe): Safe {
  const navOn = (ep: string) => c.endpoint === ep || (ep === "cards" && (c.endpoint === "card_new" || c.endpoint === "card_edit"))
    || (ep === "classes" && (c.endpoint === "class_view" || c.endpoint === "class_session"));
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
  <span class="brand">🔑 ${c.orgName || "کنترل تردد"}</span>
  <nav>
    ${c.orgName ? NAV.map(([ep, href, label]) => html`<a href="${href}" class="${navOn(ep) ? "on" : ""}">${label}</a>`) : ""}
    ${c.owner ? html`<a href="/admin" class="${c.endpoint === "admin" ? "on" : ""}">مدیریت سرور</a>` : ""}
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
  const cls = ({ granted: "ok", manual: "mut", expired: "warn", disabled: "warn", not_member: "warn" } as Record<string, string>)[r] || "bad";
  return html`<span class="pill ${cls}">${RESULT_FA[r] || r}</span>`;
}

function dirLabel(d: string) {
  if (d === "in") return html`← ورود`;
  if (d === "out") return html`خروج →`;
  return html`<span class="mut">—</span>`;
}

function eventsTable(rows: Row[], showDoor = true) {
  return html`<div class="scroll"><table>
<thead><tr><th>زمان</th><th>نام</th><th>شناسه کارت</th>${showDoor ? html`<th>دستگاه</th>` : ""}<th>کلاس</th><th>نتیجه</th><th>جهت</th></tr></thead>
<tbody>
${rows.length ? rows.map((e) => html`
<tr>
  <td class="nowrap">${jdt(e.ts)}${e.offline ? html` <span class="pill mut" title="هنگام قطع بودن سرور، توسط خود دستگاه تصمیم‌گیری شده">آفلاین</span>` : ""}</td>
  <td>${e.card_id ? html`<a href="/cards/${e.card_id}">${e.name}</a>` : e.name || ""}</td>
  <td class="mono">${e.result === "unknown" ? html`<a href="/cards/new${qs({ uid: e.uid })}" title="ثبت این کارت">${e.uid}</a>` : e.uid}</td>
  ${showDoor ? html`<td>${e.door || "—"}</td>` : ""}
  <td>${e.class_id ? html`<a href="/classes/${e.class_id}">${e.class_name}</a>` : html`<span class="mut">—</span>`}</td>
  <td>${resultPill(e.result)}</td>
  <td class="nowrap">${dirLabel(e.direction)}</td>
</tr>`) : html`<tr><td colspan="7" class="mut">رویدادی ثبت نشده است.</td></tr>`}
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

export type Running = { cls: Row; s: ClassSession; here: number; members: number };

export function dashboardPage(c: PageCtx, v: {
  cards: Row[]; inside: Row[]; stats: Row | null; recent: Row[]; unknown: Row[]; doors: Row[]; onlineAfter: number; running: Running[];
}) {
  return layout(c, "داشبورد · کنترل تردد", html`
<div class="stats">
  <div class="stat"><b>${J.fa(v.inside.length)}</b><span>نفر داخل</span></div>
  <div class="stat"><b>${J.fa(v.stats?.granted || 0)}</b><span>تردد مجاز امروز</span></div>
  <div class="stat"><b>${J.fa(v.stats?.denied || 0)}</b><span>تردد رد شده امروز</span></div>
  <div class="stat"><b>${J.fa(v.cards.length)}</b><span>کارت ثبت‌شده</span></div>
</div>

${v.running.length ? html`
<div class="box">
  <h2>کلاس‌های در حال برگزاری</h2>
  ${v.running.map((r) => html`
  <div class="row" style="padding:4px 0">
    <div><a href="/classes/${r.cls.id}/session/${r.s.slot.id}/${r.s.date}"><b>${r.cls.name}</b></a>
      <span class="mut">· ${r.s.slot.door || "—"} · ${hm(r.s.slot.start_min)} تا ${hm(r.s.slot.end_min)}</span></div>
    <div class="auto"><span class="pill ok">${J.fa(r.here)} نفر حاضر</span> <span class="mut">از ${J.fa(r.members)} عضو</span></div>
  </div>`)}
</div>` : ""}

<div class="grid">
  <div class="box">
    <h2>دستگاه‌ها</h2>
    ${v.doors.length ? v.doors.map((d) => html`
    <div class="row" style="padding:4px 0">
      <div>${dot(d.last_seen && d.last_seen >= v.onlineAfter)}${d.name}
        <span class="mut">· ${ago(d.last_seen)}</span></div>
      <form class="inline auto" method="post" action="/doors/${d.id}/open">${csrf(c)}<button class="btn sm">باز کن</button></form>
    </div>`) : html`
    <p class="mut">هنوز دستگاهی تعریف نشده. از صفحه <a href="/doors">دستگاه‌ها</a> یک دستگاه اضافه کنید و کلید آن را در تنظیمات دستگاه وارد کنید.</p>`}
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

export function cardFormPage(c: PageCtx, v: { card: Row; isNew: boolean; cardId?: number; history?: Row[]; classes?: Row[] }) {
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
  <h2>کلاس‌ها</h2>
  ${v.classes?.length ? v.classes.map((k) => html`<a class="pill ok" href="/classes/${k.id}">${k.name}</a> `)
    : html`<p class="mut">عضو هیچ کلاسی نیست. اعضای هر کلاس از صفحهٔ همان کلاس انتخاب می‌شوند.</p>`}
</div>
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
  return layout(c, "دستگاه‌ها · کنترل تردد", html`
<h1>دستگاه‌ها</h1>
<p class="mut">هر دستگاه (کارت‌خوان Wemos یا گوشی اندروید) یک کلید دارد. کلید را در تنظیمات دستگاه یا برنامهٔ اندروید وارد کنید. برای حضور و غیاب کلاس‌ها، دستگاه را در صفحهٔ هر کلاس به زمان‌های آن کلاس وصل کنید.</p>

${v.newKey ? html`
<div class="key">
  <b>کلید دستگاه برای «${v.newKey.name}»</b> — آن را در پنل دستگاه، بخش تنظیمات ← سرور وارد کنید. این کلید فقط یک بار نمایش داده می‌شود.
  <code dir="ltr">${v.newKey.key}</code>
  آدرس سرور برای دستگاه: <span class="mono">${v.origin}</span>
</div>` : ""}

<div class="box scroll">
<table>
<thead><tr><th>دستگاه</th><th>وضعیت</th><th>جهت</th><th>زمان باز ماندن</th><th>نسخه / IP</th><th></th></tr></thead>
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
<tr><td colspan="6" class="mut">هنوز دستگاهی تعریف نشده است.</td></tr>`}
</tbody>
</table>
</div>

<div class="box">
  <h2>افزودن دستگاه</h2>
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
  rows: Row[]; total: number; page: number; pages: number; doors: Row[]; classes: Row[]; args: Record<string, string>;
}) {
  const a = v.args;
  return layout(c, "گزارش تردد · کنترل تردد", html`
<h1>گزارش تردد</h1>
<form class="box row" method="get">
  <div><label>جستجو</label><input name="q" value="${a.q || ""}" placeholder="نام یا شناسه کارت"></div>
  <div><label>نتیجه</label><select name="result"><option value="">همه</option>
    ${["granted", "unknown", "disabled", "expired", "denied", "not_member", "manual"].map((r) =>
      html`<option value="${r}" ${a.result === r ? "selected" : ""}>${RESULT_FA[r]}</option>`)}</select></div>
  <div><label>کلاس</label><select name="class"><option value="">همه</option>
    ${v.classes.map((k) => html`<option value="${k.id}" ${a.class === String(k.id) ? "selected" : ""}>${k.name}</option>`)}</select></div>
  <div><label>دستگاه</label><select name="door"><option value="">همه</option>
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
  return layout(c, "حضور روزانه · کنترل تردد", html`
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

export function settingsPage(c: PageCtx, v: { users: Row[]; nEvents: number }) {
  return layout(c, "تنظیمات · کنترل تردد", html`
<h1>تنظیمات</h1>
<div class="grid">
  ${!c.owner ? html`
  <div class="box">
    <h2>تغییر رمز عبور من</h2>
    <form method="post">${csrf(c)}<input type="hidden" name="action" value="password">
      <label>رمز فعلی</label><input type="password" dir="ltr" name="current" autocomplete="current-password" required>
      <label>رمز جدید (حداقل ۸ کاراکتر)</label><input type="password" dir="ltr" name="new" autocomplete="new-password" minlength="8" required>
      <p><button class="btn">تغییر رمز</button></p>
    </form>
  </div>` : ""}

  <div class="box">
    <h2>کاربران پنل این سازمان</h2>
    <table>
      ${v.users.map((u) => html`
      <tr><td class="ltr">${u.username}${u.id === c.userId ? html` <span class="mut">(شما)</span>` : ""}</td>
        <td class="end">${(v.users.length > 1 || c.owner) && u.id !== c.userId ? html`<form class="inline" method="post" onsubmit="return confirm(this.dataset.q)" data-q="کاربر ${u.username} حذف شود؟">${csrf(c)}<input type="hidden" name="action" value="del_user"><input type="hidden" name="id" value="${u.id}"><button class="btn red sm">حذف</button></form>` : ""}</td></tr>`)}
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
</div>`);
}

// --- server owner -------------------------------------------------------------------

export function adminPage(c: PageCtx, v: { orgs: Row[]; users: Map<number | null, Row[]>; apiEnabled: boolean; webhook: string }) {
  const hidden = (n: string, val: unknown) => html`<input type="hidden" name="${n}" value="${val}">`;
  return layout(c, "مدیریت سرور · کنترل تردد", html`
<h1>مدیریت سرور</h1>
<p class="mut">هر سازمان (شرکت یا تیم) کاربران، کارت‌ها، دستگاه‌ها، کلاس‌ها و گزارش‌های جداگانه دارد و داده‌های سازمان‌های دیگر را نمی‌بیند. کاربران هر سازمان دستگاه‌های خودشان را تعریف می‌کنند.</p>

<div class="box scroll">
<table>
<thead><tr><th>سازمان</th><th>وضعیت</th><th>کاربران</th><th>دستگاه</th><th>کارت</th><th>کلاس</th><th>آخرین تردد</th><th></th></tr></thead>
<tbody>
${v.orgs.length ? v.orgs.map((o) => {
    const us = v.users.get(o.id) || [];
    return html`
<tr>
  <td><b>${o.name}</b></td>
  <td>${o.enabled ? html`<span class="pill ok">فعال</span>` : html`<span class="pill bad">غیرفعال</span>`}</td>
  <td class="ltr">${us.length ? us.map((u) => u.username).join("، ") : html`<span class="mut">—</span>`}</td>
  <td>${J.fa(o.n_devices)}</td><td>${J.fa(o.n_cards)}</td><td>${J.fa(o.n_classes)}</td>
  <td class="nowrap mut">${ago(o.last_event)}</td>
  <td class="nowrap end">
    <form class="inline" method="post" action="/admin/view">${csrf(c)}${hidden("org", o.id)}<button class="btn sm">ورود به پنل</button></form>
    <details style="display:inline-block;vertical-align:top"><summary class="btn sec sm">مدیریت</summary>
      <div class="box popup" style="min-width:300px">
        <form method="post">${csrf(c)}${hidden("action", "rename")}${hidden("org", o.id)}
          <label>نام سازمان</label><input name="name" value="${o.name}" required>
          <p><button class="btn sm">ذخیره نام</button></p></form>
        <form method="post">${csrf(c)}${hidden("action", "toggle")}${hidden("org", o.id)}
          <p><button class="btn sec sm">${o.enabled ? "غیرفعال کن (ورود کاربران و همه دستگاه‌ها متوقف می‌شود)" : "فعال کن"}</button></p></form>
        <h3>کاربران</h3>
        ${us.map((u) => html`
        <div class="row" style="padding:2px 0"><span class="ltr">${u.username}</span>
          <form class="inline auto" method="post">${csrf(c)}${hidden("action", "reset_pw")}${hidden("id", u.id)}
            <input type="password" name="password" dir="ltr" minlength="8" placeholder="رمز جدید" style="width:9em" required><button class="btn sec sm">تغییر رمز</button></form>
          <form class="inline" method="post" onsubmit="return confirm(this.dataset.q)" data-q="کاربر ${u.username} حذف شود؟">${csrf(c)}${hidden("action", "del_user")}${hidden("id", u.id)}<button class="btn red sm">حذف</button></form>
        </div>`)}
        <form method="post" class="row">${csrf(c)}${hidden("action", "add_user")}${hidden("org", o.id)}
          <div><label>کاربر جدید</label><input name="username" dir="ltr" required></div>
          <div><label>رمز</label><input type="password" name="password" dir="ltr" minlength="8" required></div>
          <div class="auto"><button class="btn sm">افزودن</button></div></form>
        <form method="post" onsubmit="return confirm('همه کارت‌ها، دستگاه‌ها، کلاس‌ها و گزارش‌های این سازمان برای همیشه حذف شوند؟')">${csrf(c)}
          ${hidden("action", "delete")}${hidden("org", o.id)}
          <label>برای حذف کامل، نام سازمان را بنویسید</label><input name="confirm" placeholder="${o.name}">
          <p><button class="btn red sm">حذف سازمان</button></p></form>
      </div>
    </details>
  </td>
</tr>`;
  }) : html`<tr><td colspan="8" class="mut">هنوز سازمانی ساخته نشده است.</td></tr>`}
</tbody>
</table>
</div>

<div class="grid">
  <div class="box">
    <h2>سازمان جدید</h2>
    <form method="post">${csrf(c)}${hidden("action", "new_org")}
      <label>نام سازمان / شرکت / تیم</label><input name="name" required>
      <div class="row">
        <div><label>نام کاربری مدیر سازمان</label><input name="username" dir="ltr" required></div>
        <div><label>رمز (حداقل ۸ کاراکتر)</label><input type="password" name="password" dir="ltr" minlength="8" required></div>
      </div>
      <p><button class="btn">ساخت سازمان</button></p>
    </form>
    <p class="mut">این نام کاربری و رمز را به سازمان بدهید. آن‌ها با آن وارد پنل خودشان می‌شوند، دستگاه تعریف می‌کنند و می‌توانند کاربران دیگری برای سازمان خود بسازند.</p>
  </div>

  <div class="box">
    <h2>مدیران سرور</h2>
    ${(v.users.get(null) || []).map((u) => html`
    <div class="row" style="padding:2px 0"><span class="ltr">${u.username}</span>${u.id === c.userId ? html` <span class="mut">(شما)</span>` : html`
      <form class="inline auto" method="post" onsubmit="return confirm(this.dataset.q)" data-q="مدیر ${u.username} حذف شود؟">${csrf(c)}${hidden("action", "del_user")}${hidden("id", u.id)}<button class="btn red sm">حذف</button></form>`}</div>`)}
    <form method="post" class="row">${csrf(c)}${hidden("action", "add_owner")}
      <div><label>نام کاربری</label><input name="username" dir="ltr" required></div>
      <div><label>رمز</label><input type="password" name="password" dir="ltr" minlength="8" required></div>
      <div class="auto"><button class="btn sm">افزودن مدیر</button></div></form>
    <h3>تغییر رمز من</h3>
    <form method="post">${csrf(c)}${hidden("action", "password")}
      <div class="row">
        <div><label>رمز فعلی</label><input type="password" dir="ltr" name="current" autocomplete="current-password" required></div>
        <div><label>رمز جدید</label><input type="password" dir="ltr" name="new" autocomplete="new-password" minlength="8" required></div>
        <div class="auto"><button class="btn sm">تغییر رمز</button></div>
      </div>
    </form>
  </div>

  <div class="box">
    <h2>اتصال به سرویس‌های دیگر</h2>
    <p>API فقط‌خواندنی (همه سازمان‌ها): ${v.apiEnabled ? html`<span class="pill ok">فعال</span>` : html`<span class="pill mut">غیرفعال</span> — secret <span class="mono">ACCESSCTL_API_TOKEN</span> را تنظیم کنید`}</p>
    <p class="mono mut" style="font-size:12px;text-align:left">GET /api/v1/presence?org=&lt;id&gt;<br>GET /api/v1/events?since=&lt;last id&gt;&amp;org=&lt;id&gt;<br>Header: Authorization: Bearer &lt;token&gt;</p>
    <p>Webhook: ${v.webhook ? html`<span class="mono">${v.webhook}</span>` : html`<span class="pill mut">غیرفعال</span> — secret <span class="mono">ACCESSCTL_WEBHOOK_URL</span> را تنظیم کنید`}</p>
  </div>
</div>`);
}

// --- classes -------------------------------------------------------------------------

function slotLabel(s: Row) {
  return html`${s.on_date ? J.fa(jinput(s.on_date)) : `${WEEKDAYS_FA[s.weekday]}‌ها`} ${hm(s.start_min)}–${hm(s.end_min)}`;
}

export function classesPage(c: PageCtx, v: { classes: Row[]; slots: Map<number, Row[]> }) {
  return layout(c, "کلاس‌ها · کنترل تردد", html`
<h1>کلاس‌ها</h1>
<p class="mut">برای هر کلاس اعضا را انتخاب کنید و آن را در زمان‌های مشخص به یک دستگاه وصل کنید. در آن زمان‌ها اعضا با کارت‌زدن ورود و خروج خود را ثبت می‌کنند؛ کارت افرادی که عضو کلاس نیستند رد می‌شود.</p>
<div class="box scroll">
<table>
<thead><tr><th>کلاس</th><th>اعضا</th><th>زمان‌بندی</th><th></th></tr></thead>
<tbody>
${v.classes.length ? v.classes.map((k) => html`
<tr>
  <td><a href="/classes/${k.id}"><b>${k.name}</b></a>${k.note ? html`<div class="mut" style="font-size:12px">${k.note}</div>` : ""}</td>
  <td>${J.fa(k.members)} نفر</td>
  <td>${(v.slots.get(k.id) || []).length ? (v.slots.get(k.id) || []).map((s) => html`<div class="nowrap">${slotLabel(s)} <span class="mut">· ${s.door || "—"}</span></div>`)
    : html`<span class="mut">بدون زمان‌بندی</span>`}</td>
  <td class="end"><a class="btn sec sm" href="/classes/${k.id}">گزارش و تنظیم</a></td>
</tr>`) : html`<tr><td colspan="4" class="mut">هنوز کلاسی تعریف نشده است.</td></tr>`}
</tbody>
</table>
</div>
<div class="box">
  <h2>کلاس جدید</h2>
  <form method="post" class="row">${csrf(c)}
    <div><label>نام کلاس</label><input name="name" maxlength="60" placeholder="ریاضی ۱ — گروه الف" required></div>
    <div><label>توضیحات (اختیاری)</label><input name="note" maxlength="200"></div>
    <div class="auto"><button class="btn">ساخت کلاس</button></div>
  </form>
</div>`);
}

export function classPage(c: PageCtx, v: {
  cls: Row; sessions: [ClassSession, number][]; summary: MemberTotal[]; slots: Row[]; cards: Row[]; doors: Row[];
  first: string; last: string; nMembers: number;
}) {
  const k = v.cls;
  const n = v.sessions.length;
  return layout(c, `${k.name} · کلاس‌ها`, html`
<div class="row" style="margin-bottom:12px">
  <h1>${k.name}</h1>
  <a class="btn sec auto" href="/classes">همه کلاس‌ها</a>
</div>
${k.note ? html`<p class="mut">${k.note}</p>` : ""}

<form class="box row" method="get">
  <div><label>از تاریخ</label><input name="from" dir="ltr" value="${J.jstr(v.first)}" style="width:9em"></div>
  <div><label>تا تاریخ</label><input name="to" dir="ltr" value="${J.jstr(v.last)}" style="width:9em"></div>
  <div class="auto"><button class="btn">نمایش</button> <a class="btn sec" href="/classes/${k.id}/summary.csv${qs({ from: J.jstr(v.first), to: J.jstr(v.last) })}">خروجی اکسل (CSV)</a></div>
</form>

<div class="box scroll">
  <h2>خلاصه حضور اعضا <span class="mut" style="font-size:14px">(${J.fa(n)} جلسه)</span></h2>
  <table>
  <thead><tr><th>نام</th><th>جلسات حاضر</th><th>مجموع زمان حضور</th><th>درصد حضور</th></tr></thead>
  <tbody>
  ${v.summary.length ? v.summary.map((t) => html`
  <tr>
    <td><a href="/cards/${t.card.id}">${t.card.name}</a></td>
    <td>${J.fa(t.attended)} از ${J.fa(n)}</td>
    <td>${dur(t.secs)}</td>
    <td><span class="pill ${t.pct >= 75 ? "ok" : t.pct >= 40 ? "warn" : "bad"}">${J.fa(t.pct)}٪</span></td>
  </tr>`) : html`<tr><td colspan="4" class="mut">هنوز عضوی برای این کلاس انتخاب نشده است (پایین صفحه).</td></tr>`}
  </tbody>
  </table>
</div>

<div class="box scroll">
  <h2>جلسات</h2>
  <table>
  <thead><tr><th>تاریخ</th><th>ساعت</th><th>دستگاه</th><th>حاضران</th><th></th></tr></thead>
  <tbody>
  ${n ? v.sessions.map(([s, present]) => html`
  <tr>
    <td class="nowrap">${WEEKDAYS_FA[weekdayOf(s.date)]} ${J.fa(J.jstr(s.date))}</td>
    <td class="nowrap">${hm(s.slot.start_min)} تا ${hm(s.slot.end_min)}</td>
    <td>${s.slot.door || "—"}</td>
    <td>${J.fa(present)} از ${J.fa(v.nMembers)}</td>
    <td class="end"><a class="btn sec sm" href="/classes/${k.id}/session/${s.slot.id}/${s.date}">ورود و خروج‌ها</a></td>
  </tr>`) : html`<tr><td colspan="5" class="mut">در این بازه جلسه‌ای برگزار نشده است.</td></tr>`}
  </tbody>
  </table>
</div>

<div class="grid">
  <div class="box">
    <h2>زمان‌بندی و دستگاه</h2>
    ${v.slots.length ? v.slots.map((s) => html`
    <div class="row" style="padding:3px 0">
      <div>${s.on_date ? html`<span class="pill mut">یک‌بار</span> ${J.fa(jinput(s.on_date))}` : html`<span class="pill ok">هفتگی</span> ${WEEKDAYS_FA[s.weekday]}‌ها`}
        ${hm(s.start_min)} تا ${hm(s.end_min)} <span class="mut">· ${s.door || "—"}${s.from_date || s.to_date ? ` · از ${J.fa(jinput(s.from_date)) || "…"} تا ${J.fa(jinput(s.to_date)) || "…"}` : ""}</span></div>
      <form class="inline auto" method="post" action="/classes/${k.id}/slots/${s.id}/delete" onsubmit="return confirm('این زمان‌بندی حذف شود؟')">${csrf(c)}<button class="btn red sm">حذف</button></form>
    </div>`) : html`<p class="mut">هنوز زمانی تعریف نشده است.</p>`}
    ${!v.doors.length ? html`<p class="flash error">ابتدا در صفحهٔ <a href="/doors">دستگاه‌ها</a> یک دستگاه بسازید.</p>` : html`
    <form method="post" action="/classes/${k.id}/slots">${csrf(c)}
      <h3>افزودن زمان</h3>
      <label class="check"><input type="radio" name="kind" value="weekly" checked onchange="kindChanged(this.form)"> هفتگی (تکرار در روزهای انتخابی)</label>
      <label class="check"><input type="radio" name="kind" value="once" onchange="kindChanged(this.form)"> یک‌بار (جلسهٔ فوق‌العاده در یک تاریخ)</label>
      <div class="weekly">
        <label>روزهای هفته</label>
        <div>${WEEK_ORDER.map((w) => html`<label class="check" style="display:inline-block;margin-inline-end:10px"><input type="checkbox" name="weekday" value="${w}"> ${WEEKDAYS_FA[w]}</label>`)}</div>
        <div class="row">
          <div><label>از تاریخ (خالی = از امروز)</label><input name="from_date" dir="ltr" placeholder="1405/07/01"></div>
          <div><label>تا تاریخ (اختیاری)</label><input name="to_date" dir="ltr" placeholder="1405/10/30"></div>
        </div>
      </div>
      <div class="once" style="display:none"><label>تاریخ جلسه</label><input name="on_date" dir="ltr" placeholder="1405/08/20"></div>
      <div class="row">
        <div><label>ساعت شروع</label><input name="start" dir="ltr" placeholder="10:00" required></div>
        <div><label>ساعت پایان</label><input name="end" dir="ltr" placeholder="11:30" required></div>
        <div><label>دستگاه</label><select name="device">${v.doors.map((d) => html`<option value="${d.id}">${d.name}</option>`)}</select></div>
      </div>
      <p><button class="btn">افزودن</button></p>
      <p class="mut">کارت‌زدن از ۱۵ دقیقه قبل از شروع تا ۳۰ دقیقه بعد از پایان برای این کلاس ثبت می‌شود؛ فقط زمان بین شروع و پایان کلاس در مدت حضور حساب می‌شود.</p>
    </form>
    <script>function kindChanged(f){const once=f.kind.value==='once';f.querySelector('.once').style.display=once?'':'none';f.querySelector('.weekly').style.display=once?'none':''}</script>`}
  </div>

  <div class="box">
    <h2>اعضای کلاس <span class="mut" style="font-size:14px">(${J.fa(v.nMembers)} نفر)</span></h2>
    ${v.cards.length ? html`
    <form method="post" action="/classes/${k.id}/members">${csrf(c)}
      <input placeholder="جستجو…" oninput="const q=this.value.trim();this.form.querySelectorAll('.m').forEach(e=>e.style.display=e.textContent.includes(q)?'':'none')">
      <div style="max-height:360px;overflow:auto;margin:8px 0">
      ${v.cards.map((m) => html`<label class="check m"><input type="checkbox" name="card" value="${m.id}" ${m.member ? "checked" : ""}> ${m.name} <span class="mono mut" style="font-size:12px">${m.uid}</span></label>`)}
      </div>
      <button class="btn">ذخیره اعضا</button>
    </form>` : html`<p class="mut">ابتدا در صفحهٔ <a href="/cards">کارت‌ها</a> افراد را ثبت کنید.</p>`}
  </div>

  <div class="box">
    <h2>ویرایش کلاس</h2>
    <form method="post" action="/classes/${k.id}/edit">${csrf(c)}
      <label>نام</label><input name="name" value="${k.name}" maxlength="60" required>
      <label>توضیحات</label><input name="note" value="${k.note}" maxlength="200">
      <p><button class="btn">ذخیره</button></p>
    </form>
    <form method="post" action="/classes/${k.id}/delete" onsubmit="return confirm(this.dataset.q)" data-q="کلاس «${k.name}» حذف شود؟ ترددها باقی می‌مانند ولی دیگر به این کلاس متصل نیستند.">${csrf(c)}<button class="btn red sm">حذف کلاس</button></form>
  </div>
</div>`);
}

export function classSessionPage(c: PageCtx, v: {
  cls: Row; slot: Row; day: string; now: number; rep: { start: number; end: number; rows: ({ card: Row } & Presence)[]; refused: Row[] };
}) {
  const r = v.rep;
  return layout(c, `${v.cls.name} · جلسه`, html`
<div class="row" style="margin-bottom:12px">
  <h1>${v.cls.name} — ${WEEKDAYS_FA[weekdayOf(v.day)]} ${J.fa(J.jstr(v.day))}</h1>
  <a class="btn sec auto" href="/classes/${v.cls.id}">بازگشت به کلاس</a>
</div>
<p class="mut">ساعت ${hm(v.slot.start_min)} تا ${hm(v.slot.end_min)} · دستگاه: ${v.slot.door || "—"}
  ${r.start <= v.now && v.now < r.end ? html` · <span class="pill ok">در حال برگزاری</span>` : v.now < r.start ? html` · <span class="pill mut">شروع نشده</span>` : ""}</p>
<div class="box scroll">
<table>
<thead><tr><th>نام</th><th>وضعیت</th><th>ورود</th><th>خروج</th><th>مدت حضور در کلاس</th><th>تعداد کارت‌زدن</th></tr></thead>
<tbody>
${r.rows.length ? r.rows.map((x) => html`
<tr>
  <td><a href="/cards/${x.card.id}">${x.card.name}</a></td>
  <td>${!x.scans ? html`<span class="pill bad">غایب</span>` : x.open && v.now < r.end ? html`<span class="pill ok">داخل کلاس</span>`
    : x.open ? html`<span class="pill warn" title="خروج ثبت نشده؛ تا پایان کلاس حساب شد">خروج ثبت نشد</span>` : html`<span class="pill mut">حاضر</span>`}</td>
  <td>${x.first_in ? jtime(x.first_in) : "—"}</td>
  <td>${x.last_out ? jtime(x.last_out) : "—"}</td>
  <td>${x.scans ? dur(x.secs) : "—"}</td>
  <td>${J.fa(x.scans)}</td>
</tr>`) : html`<tr><td colspan="6" class="mut">این کلاس عضوی ندارد.</td></tr>`}
</tbody>
</table>
</div>
${r.refused.length ? html`
<div class="box">
  <h2>کارت‌های ردشده در این جلسه</h2>
  ${eventsTable(r.refused)}
</div>` : ""}`);
}

function weekdayOf(iso: string): number {
  const [y, m, d] = J.isoParts(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function errorPage(status: number, message: string) {
  return html`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title>
<link rel="stylesheet" href="/static/style.css"></head>
<body><main><div class="box"><h1>${status}</h1><p>${message}</p><p><a href="/">بازگشت</a></p></div></main></body></html>`;
}

export { raw };
