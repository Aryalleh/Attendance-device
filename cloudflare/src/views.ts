// Panel pages — port of server/templates/*.html (Persian, RTL).
import { html, qs, raw, Safe } from "./html";
import type { ClassSession, MemberTotal, Presence, Row } from "./db";
import type { Quote } from "./billing";
import { money, subState } from "./billing";
import { icon } from "./icons";
import * as J from "./jalali";
import { ago, jdate, jday, jdt, jinput, jtime } from "./time";

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
  locked?: boolean;    // company registered but not yet approved: no panel menu
  pending?: number;    // registrations waiting (shown to server owners)
  plan?: string;       // current plan name, for the top-bar pill
  planWarn?: boolean;  // trial ending soon, payment due or suspended
  endpoint: string;
  origin: string;      // https://host, for canonical and Open Graph URLs
  csrf: string;
  flashes: [string, string][];
};

const FONT = "/static/fonts/Vazirmatn.woff2";
const NAV: [string, string, string, string][] = [
  ["live", "/", "نمایشگر زنده", "tv"], ["dashboard", "/dashboard", "داشبورد", "chart-line"], ["doors", "/doors", "درب‌ها", "door-open"],
  ["cards", "/cards", "کارت‌ها", "id-card"], ["classes", "/classes", "کلاس‌ها", "graduation-cap"], ["events", "/events", "رویدادها", "clock-rotate-left"],
  ["attendance", "/attendance", "حضور روزانه", "calendar-check"],
];
const NAV_SETTINGS: [string, string, string, string][] = [
  ["settings", "/settings", "کاربران و تنظیمات", "gear"], ["billing", "/billing", "صورت‌حساب", "credit-card"], ["store", "/store", "فروشگاه سخت‌افزار", "shop"],
];
export const BRAND = "SecureEntry";

// --- SEO --------------------------------------------------------------------------

export const SITE_NAME = "کنترل تردد";
export const SITE_DESC = "سامانهٔ آنلاین حضور و غیاب و کنترل تردد با کارت RFID و گوشی NFC برای شرکت‌ها، مدارس و دانشگاه‌ها: ثبت ورود و خروج، حضور در کلاس، نمایشگر زنده و گزارش‌گیری.";

/** Search-engine metadata for public pages; pages without it get no description (and noindex via header). */
export type Meta = { description: string; path: string; jsonld?: unknown[] };

const ldJson = (o: unknown) => raw(`<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`);

function metaTags(c: PageCtx, title: string, m: Meta) {
  const url = c.origin + m.path, img = c.origin + "/static/og.png";
  return html`
<meta name="description" content="${m.description}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="fa_IR">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${m.description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${SITE_NAME} — حضور و غیاب با کارت">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${m.description}">
<meta name="twitter:image" content="${img}">
${(m.jsonld || []).map(ldJson)}`;
}

const ALIASES: Record<string, string> = {
  card_new: "cards", card_edit: "cards", class_view: "classes", class_session: "classes",
  invoices: "billing", invoice: "billing",
};

function head(c: PageCtx, title: string, meta?: Meta) {
  return html`<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#4f46e5">
${meta ? metaTags(c, title, meta) : ""}
<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/style.css">
</head>`;
}

const flashes = (c: PageCtx) => c.flashes.map(([cat, msg]) => html`<div class="flash ${cat}">${msg}</div>`);
const logo = (cls = "") => html`<span class="logo ${cls}">${icon("shield-halved")}</span>`;

/** Public pages (landing, pricing, sign-up, login): the header and footer of the SecureEntry pricing design. */
function publicShell(c: PageCtx, title: string, body: Safe, meta?: Meta): Safe {
  const on = (ep: string) => (c.endpoint === ep ? "on" : "");
  return html`<!doctype html>
<html lang="fa" dir="rtl">
${head(c, title, meta)}
<body class="pub">
<header class="pubhead"><div class="in">
  <a class="pbrand" href="/">${logo()}<b>${BRAND}</b></a>
  <nav>
    <a href="/#features">امکانات</a>
    <a href="/pricing" class="${on("pricing")}">قیمت‌گذاری</a>
    <a href="/pricing#hardware">سخت‌افزار</a>
    <a href="/#faq">سوالات متداول</a>
  </nav>
  <div class="pact">
    ${c.user ? html`<a class="btn" href="/dashboard">ورود به پنل</a>` : html`
    <a class="plink" href="/login">ورود</a>
    <a class="btn" href="/register">شروع کنید</a>`}
  </div>
</div></header>
<main class="pubmain">
${flashes(c)}
${body}
</main>
<footer class="pubfoot"><div class="in">
  <div class="fcol fabout">
    <a class="pbrand" href="/">${logo()}<b>${BRAND}</b></a>
    <p>کنترل دسترسی مدرن و مدیریت حضور و غیاب. اولویت با ابر، مستقل از سخت‌افزار.</p>
  </div>
  <div class="fcol"><b>محصول</b><a href="/#features">ویژگی‌ها</a><a href="/pricing#hardware">سخت‌افزار</a><a href="/pricing">قیمت‌گذاری</a><a href="/llms.txt">مستندات API</a></div>
  <div class="fcol"><b>شروع</b><a href="/register">ثبت‌نام سازمان</a><a href="/login">ورود به پنل</a><a href="/#faq">سوالات متداول</a></div>
  <p class="copy">© ${J.fa(new Date().getFullYear())} ${BRAND} · ${SITE_NAME}</p>
</div></footer>
</body>
</html>`;
}

/** Panel pages: the dark sidebar and top bar of the SecureEntry billing design. */
export function layout(c: PageCtx, title: string, body: Safe, meta?: Meta, opts: { public?: boolean; heading?: string } = {}): Safe {
  if (!c.user || opts.public) return publicShell(c, title, body, meta);
  const cur = ALIASES[c.endpoint] || c.endpoint;
  const item = ([ep, href, label, ic]: string[]) =>
    html`<a href="${href}" class="${cur === ep ? "on" : ""}">${icon(ic)}<span>${label}</span></a>`;
  const showNav = c.orgName && !c.locked;
  return html`<!doctype html>
<html lang="fa" dir="rtl">
${head(c, title, meta)}
<body>
<div class="app">
<aside class="side">
  <a class="sbrand" href="${showNav ? "/dashboard" : "/"}">${logo()}<b>${BRAND}</b></a>
  <nav>
    ${showNav ? NAV.map(item) : ""}
    ${showNav ? html`<div class="sgroup">تنظیمات</div>${NAV_SETTINGS.map(item)}` : ""}
    ${c.owner ? html`<div class="sgroup">سرور</div><a href="/admin" class="${cur === "admin" ? "on" : ""}">${icon("user-shield")}<span>مدیریت سرور</span>${c.pending ? html`<span class="count">${J.fa(c.pending)}</span>` : ""}</a>` : ""}
  </nav>
  <div class="suser">
    <span class="av">${(c.user || "?").slice(0, 1).toUpperCase()}</span>
    <div class="who"><b class="ltr">${c.user}</b><small>${c.orgName || "مدیر سرور"}</small></div>
    <form method="post" action="/logout">${csrf(c)}<button class="iconbtn" title="خروج" aria-label="خروج">${icon("arrow-right-from-bracket")}</button></form>
  </div>
</aside>
<div class="appmain">
  <div class="topbar">
    <b class="ttl">${opts.heading || c.orgName || "مدیریت سرور"}</b>
    ${c.plan && showNav ? html`<a class="planpill ${c.planWarn ? "warn" : ""}" href="/billing"><i></i>طرح فعلی: ${c.plan}</a>` : ""}
  </div>
  <main>
${flashes(c)}
${body}
  </main>
</div>
</div>
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
  <h1 class="authh">${logo("lg")}<span>ورود به ${BRAND}</span></h1>
  <form method="post">
    ${csrf(c)}
    <label>ایمیل یا نام کاربری</label><input name="username" dir="ltr" autocomplete="username" autofocus required>
    <label>رمز عبور</label><input name="password" dir="ltr" type="password" autocomplete="current-password" required>
    <p><button class="btn">ورود</button></p>
  </form>
  <p class="mut">حساب ندارید؟ <a href="/register">ثبت‌نام سازمان</a> · <a href="/">صفحه اصلی</a></p>
</div>`);
}

// --- public pages: landing, sign-up, waiting for approval -------------------------

/** Questions and answers shown on the landing page and published as FAQPage data (for search and AI answers). */
export const FAQ: [string, string][] = [
  ["سامانهٔ کنترل تردد چیست؟",
    "یک سامانهٔ تحت وب برای حضور و غیاب و کنترل تردد با کارت است. افراد کارت RFID یا کارت NFC خود را به دستگاه نزدیک می‌کنند و ساعت ورود و خروج، حضور در کلاس و گزارش‌ها در پنل سازمان ثبت می‌شود."],
  ["چه دستگاهی برای کارت‌خوانی لازم است؟",
    "دو گزینه دارید: یک دستگاه کارت‌خوان ارزان با ماژول RC522 و برد Wemos D1 mini (ESP8266) که با Wi-Fi به سامانه وصل می‌شود، یا یک گوشی اندرویدی دارای NFC با برنامهٔ رایگان «در» که گوشی را به دستگاه کارت‌خوان و نمایشگر کیوسک تبدیل می‌کند."],
  ["از چه کارت‌هایی پشتیبانی می‌شود؟",
    "کارت‌ها و تگ‌های RFID با فرکانس ۱۳٫۵۶ مگاهرتز مانند MIFARE Classic و NTAG، از جمله بیشتر کارت‌های پرسنلی و دانشجویی. هر کارت با شناسهٔ یکتای خود (UID) در پنل ثبت می‌شود."],
  ["حضور و غیاب کلاس چطور کار می‌کند؟",
    "برای هر کلاس اعضا و زمان‌بندی هفتگی یا تک‌جلسه‌ای روی یک دستگاه تعریف می‌کنید. هر کارتی که در زمان جلسه زده شود به همان جلسه ثبت می‌شود و فهرست حاضران، غایبان و مدت حضور هر نفر را می‌بینید و خروجی CSV می‌گیرید."],
  ["چطور برای سازمانم ثبت‌نام کنم؟",
    "فرم ثبت‌نام را با نام سازمان، ایمیل، شماره تلفن همراه و تعداد کاربران و دستگاه‌های مورد نیاز پر کنید. پس از تأیید مدیر سامانه، پنل سازمان شما فعال می‌شود و می‌توانید دستگاه‌ها و کارت‌ها را تعریف کنید."],
  ["آیا داده‌های هر سازمان جداست؟",
    "بله. هر سازمان کاربران، کارت‌ها، دستگاه‌ها، کلاس‌ها و گزارش‌های جداگانه دارد و داده‌های سازمان‌های دیگر را نمی‌بیند."],
];

export function landingPage(c: PageCtx) {
  const feature = (ic: string, title: string, text: string) =>
    html`<div class="box feature"><div class="ficon" aria-hidden="true">${icon(ic)}</div><h3>${title}</h3><p class="mut">${text}</p></div>`;
  const title = "کنترل تردد | سامانهٔ حضور و غیاب با کارت RFID و NFC";
  const site = c.origin + "/";
  const jsonld = [
    {
      "@context": "https://schema.org", "@type": "WebSite", "@id": site + "#website",
      url: site, name: SITE_NAME, inLanguage: "fa-IR", description: SITE_DESC,
    },
    {
      "@context": "https://schema.org", "@type": "SoftwareApplication", "@id": site + "#app",
      name: SITE_NAME, alternateName: "سامانهٔ حضور و غیاب با کارت",
      applicationCategory: "BusinessApplication", applicationSubCategory: "Attendance and access control",
      operatingSystem: "Web, Android", inLanguage: "fa-IR", url: site, image: c.origin + "/static/og.png",
      description: SITE_DESC,
      featureList: [
        "ثبت ورود و خروج با کارت RFID", "گوشی اندرویدی NFC به‌عنوان دستگاه کارت‌خوان", "نمایشگر زنده کنار در",
        "حضور و غیاب کلاس با زمان‌بندی", "گزارش تردد و خروجی CSV", "چند سازمانی با داده‌های جدا",
      ],
    },
    {
      "@context": "https://schema.org", "@type": "FAQPage", inLanguage: "fa-IR",
      mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
    },
  ];
  return layout(c, title, html`
<section class="phero">
  <span class="eyebrow">${icon("shield-halved")} ${BRAND} · ${SITE_NAME}</span>
  <h1>حضور و غیاب و کنترل تردد با کارت،<br><span>برای هر سازمان مدرن</span></h1>
  <p class="lead">کارمندان یا دانشجویان کارت RFID را به دستگاه یا گوشی NFC نزدیک می‌کنند؛ ساعت ورود و خروج، حضور در کلاس‌ها و گزارش‌ها همه در یک پنل تحت وب ثبت می‌شود.</p>
  <div class="cta">
    <a class="btn big" href="/register">شروع دورهٔ آزمایشی ۱۴ روزه</a>
    <a class="btn ghost big" href="/pricing">مشاهدهٔ قیمت‌ها</a>
  </div>
</section>

<section class="lsec" id="features" aria-labelledby="f-title">
<h2 id="f-title" class="sec-title">امکانات</h2>
<div class="features">
  ${feature("microchip", "دستگاه کارت‌خوان RFID", "دستگاه ارزان با ماژول RC522 و Wemos D1 mini، یا یک گوشی اندرویدی دارای NFC را به‌عنوان دستگاه ورود تعریف کنید.")}
  ${feature("tv", "نمایشگر زندهٔ تردد", "نام و نتیجهٔ هر تردد همان لحظه روی نمایشگر یا تبلت کنار در دیده می‌شود.")}
  ${feature("graduation-cap", "حضور و غیاب کلاس", "برای هر کلاس اعضا و زمان‌بندی تعریف کنید و حاضران، غایبان و مدت حضور هر جلسه را ببینید.")}
  ${feature("chart-line", "گزارش و خروجی", "گزارش تردد، حضور روزانه، افراد داخل ساختمان و خروجی CSV برای هر بازهٔ زمانی.")}
  ${feature("users", "چند سازمانی", "هر شرکت، مدرسه یا دانشگاه کاربران، کارت‌ها و گزارش‌های جداگانهٔ خود را دارد.")}
  ${feature("plug", "اتصال به سامانه‌های دیگر", "API فقط‌خواندنی و Webhook برای ارسال هر تردد به نرم‌افزار حقوق و دستمزد یا سامانه‌های دیگر.")}
</div>
</section>

<section class="box steps lsec" aria-labelledby="s-title">
  <h2 id="s-title">چطور شروع کنم؟</h2>
  <ol>
    <li>یک طرح انتخاب کنید و فرم ثبت‌نام را با ایمیل و شماره تماس پر کنید.</li>
    <li>مدیر سامانه درخواست شما را تأیید می‌کند و دورهٔ آزمایشی ۱۴ روزه شروع می‌شود.</li>
    <li>دستگاه‌ها و کارت‌ها را تعریف کنید؛ پیش از پایان دوره، اشتراک را آنلاین با زرین‌پال پرداخت کنید.</li>
  </ol>
  <p><a class="btn" href="/register">شروع ثبت‌نام</a> <a class="btn ghost" href="/pricing">مقایسهٔ طرح‌ها</a></p>
</section>

<section class="box faq lsec" id="faq" aria-labelledby="q-title">
  <h2 id="q-title">پرسش‌های متداول</h2>
  ${FAQ.map(([q, a]) => html`<details><summary><h3>${q}</h3></summary><p>${a}</p></details>`)}
</section>`,
    { description: SITE_DESC, path: "/", jsonld });
}

export function registerPage(c: PageCtx, v: { name: string; email: string; phone: string; plan: string }, plans: Row[]) {
  return layout(c, "ثبت‌نام سازمان | کنترل تردد، حضور و غیاب با کارت", html`
<div class="register box">
  <h1>ثبت‌نام سازمان</h1>
  <p class="mut">پس از ثبت‌نام وارد پنل می‌شوید، اما تا تأیید مدیر سامانه پنل قفل است. دورهٔ آزمایشی از زمان تأیید شروع می‌شود و تا پایان آن پرداختی لازم نیست. <a href="/pricing">مقایسهٔ طرح‌ها</a></p>
  <form method="post">
    ${csrf(c)}
    <div class="hp" aria-hidden="true"><label>وب‌سایت</label><input name="website" tabindex="-1" autocomplete="off"></div>
    <label>نام سازمان / شرکت / مدرسه</label><input name="name" value="${v.name}" maxlength="60" required autofocus>
    <div class="row">
      <div><label>ایمیل (نام کاربری شما)</label><input name="email" type="email" dir="ltr" value="${v.email}" autocomplete="email" required></div>
      <div><label>شماره تلفن همراه</label><input name="phone" type="tel" dir="ltr" value="${v.phone}" placeholder="09121234567" autocomplete="tel" required></div>
    </div>
    <label>طرح</label>
    <div class="planpick">
      ${plans.map((p) => html`<label class="pp"><input type="radio" name="plan" value="${p.id}" ${v.plan === p.id ? "checked" : ""} required>
        <span><b>${p.name}</b><small>${p.contact ? "تماس با فروش" : p.price_month ? html`${money(p.price_month)} تومان / ماهانه` : "رایگان"}</small>
        <small class="mut">${p.trial_days ? `${J.fa(p.trial_days)} روز آزمایش رایگان` : p.max_doors !== null ? `${J.fa(p.max_doors)} درب · ${J.fa(p.max_cards)} کارت` : "نامحدود"}</small></span></label>`)}
    </div>
    <div class="row">
      <div><label>رمز عبور (حداقل ۸ کاراکتر)</label><input name="password" type="password" dir="ltr" minlength="8" autocomplete="new-password" required></div>
      <div><label>تکرار رمز عبور</label><input name="password2" type="password" dir="ltr" minlength="8" autocomplete="new-password" required></div>
    </div>
    <p><button class="btn">ثبت‌نام</button></p>
  </form>
  <p class="mut">قبلاً ثبت‌نام کرده‌اید؟ <a href="/login">ورود</a> · <a href="/">صفحه اصلی</a></p>
</div>`, {
    path: "/register",
    description: "ثبت‌نام سازمان در سامانهٔ کنترل تردد و حضور و غیاب با کارت RFID: طرح رایگان یا ۱۴ روز آزمایش رایگان طرح‌های استارتر و تجاری.",
  });
}

export function pendingPage(c: PageCtx, org: Row) {
  return layout(c, "در انتظار تأیید · کنترل تردد", html`
<div class="register box">
  <div class="ficon">⏳</div>
  <h1>ثبت‌نام «${org.name}» در انتظار تأیید است</h1>
  <p>درخواست شما دریافت شد. پس از بررسی و تأیید مدیر سامانه، پنل برای شما باز می‌شود و می‌توانید دستگاه‌ها و کارت‌ها را تعریف کنید.</p>
  <table>
    <tr><th>ایمیل</th><td class="ltr">${org.email || "—"}</td></tr>
    <tr><th>تلفن</th><td class="ltr">${org.phone || "—"}</td></tr>
    <tr><th>طرح انتخابی</th><td>${org.plan_name || "—"}</td></tr>
    <tr><th>سقف درب / مدیر</th><td>${org.max_devices ? J.fa(org.max_devices) : "∞"} / ${org.max_users ? J.fa(org.max_users) : "∞"}</td></tr>
  </table>
  <p><a class="btn sec" href="/">بررسی دوباره</a></p>
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

export function adminPage(c: PageCtx, v: {
  orgs: Row[]; pending: Row[]; users: Map<number | null, Row[]>; apiEnabled: boolean; webhook: string;
  plans: Row[]; products: Row[]; invoices: Row[]; rentals: Row[]; payments: boolean;
}) {
  const planSelect = (cur: string | null, withNone: boolean) => html`<select name="plan">
    ${withNone ? html`<option value="" ${cur ? "" : "selected"}>بدون صورت‌حساب (سفارشی)</option>` : ""}
    ${v.plans.map((p) => html`<option value="${p.id}" ${cur === p.id ? "selected" : ""}>${p.name}</option>`)}</select>`;
  const hidden = (n: string, val: unknown) => html`<input type="hidden" name="${n}" value="${val}">`;
  const limitInputs = (o: Row) => html`
    <div><label>سقف کاربران</label><input type="number" name="max_users" dir="ltr" min="0" max="1000" value="${o.max_users ?? ""}" placeholder="نامحدود" style="width:7em"></div>
    <div><label>سقف دستگاه‌ها</label><input type="number" name="max_devices" dir="ltr" min="0" max="1000" value="${o.max_devices ?? ""}" placeholder="نامحدود" style="width:7em"></div>
    <div><label>سقف کارت فعال</label><input type="number" name="max_cards" dir="ltr" min="0" max="1000" value="${o.max_cards ?? ""}" placeholder="نامحدود" style="width:7em"></div>`;
  const limit = (n: number | null) => (n ? J.fa(n) : "∞");
  return layout(c, "مدیریت سرور · کنترل تردد", html`
<h1>مدیریت سرور</h1>

${v.pending.length ? html`
<div class="box pendingbox">
  <h2>درخواست‌های ثبت‌نام در انتظار تأیید (${J.fa(v.pending.length)})</h2>
  <div class="scroll"><table>
  <thead><tr><th>سازمان</th><th>ایمیل</th><th>تلفن</th><th>ثبت</th><th>تأیید با طرح (دورهٔ آزمایشی از همین حالا)</th><th></th></tr></thead>
  <tbody>
  ${v.pending.map((o) => html`
  <tr>
    <td><b>${o.name}</b></td>
    <td class="ltr"><a href="mailto:${o.email}">${o.email}</a></td>
    <td class="ltr"><a href="tel:${o.phone}">${o.phone}</a></td>
    <td class="nowrap mut">${ago(o.created_at)}</td>
    <td><form method="post" class="row">${csrf(c)}${hidden("action", "approve")}${hidden("org", o.id)}<div>${planSelect(o.plan || "starter", false)}</div>
      <div class="auto"><button class="btn sm">تأیید</button></div></form></td>
    <td class="end"><form class="inline" method="post" onsubmit="return confirm(this.dataset.q)" data-q="درخواست ${o.name} رد و حذف شود؟">${csrf(c)}${hidden("action", "reject")}${hidden("org", o.id)}<button class="btn red sm">رد</button></form></td>
  </tr>`)}
  </tbody></table></div>
</div>` : ""}

<p class="mut">هر سازمان (شرکت یا تیم) کاربران، کارت‌ها، دستگاه‌ها، کلاس‌ها و گزارش‌های جداگانه دارد و داده‌های سازمان‌های دیگر را نمی‌بیند. کاربران هر سازمان دستگاه‌های خودشان را تعریف می‌کنند.</p>

<div class="box scroll">
<table>
<thead><tr><th>سازمان</th><th>وضعیت</th><th>طرح</th><th>کاربران</th><th>دستگاه</th><th>کارت</th><th>کلاس</th><th>آخرین تردد</th><th></th></tr></thead>
<tbody>
${v.orgs.length ? v.orgs.map((o) => {
    const us = v.users.get(o.id) || [];
    return html`
<tr>
  <td><b>${o.name}</b>${o.email || o.phone ? html`<div class="mut ltr" style="font-size:12px">${o.email} ${o.phone}</div>` : ""}</td>
  <td>${o.enabled ? html`<span class="pill ok">فعال</span>` : html`<span class="pill bad">غیرفعال</span>`}</td>
  <td class="nowrap">${o.plan ? html`${v.plans.find((p) => p.id === o.plan)?.name || o.plan}<div class="mut sm">${STATE_FA[subState(o)]}${o.paid_until ? ` · تا ${jdate(o.paid_until)}` : ""}</div>` : html`<span class="mut">سفارشی</span>`}</td>
  <td class="ltr">${us.length ? us.map((u) => u.username).join("، ") : html`<span class="mut">—</span>`} <span class="mut">(${limit(o.max_users)})</span></td>
  <td>${J.fa(o.n_devices)} / ${limit(o.max_devices)}</td><td>${J.fa(o.n_cards)} / ${limit(o.max_cards)}</td><td>${J.fa(o.n_classes)}</td>
  <td class="nowrap mut">${ago(o.last_event)}</td>
  <td class="nowrap end">
    <form class="inline" method="post" action="/admin/view">${csrf(c)}${hidden("org", o.id)}<button class="btn sm">ورود به پنل</button></form>
    <details style="display:inline-block;vertical-align:top"><summary class="btn sec sm">مدیریت</summary>
      <div class="box popup" style="min-width:300px">
        <form method="post">${csrf(c)}${hidden("action", "rename")}${hidden("org", o.id)}
          <label>نام سازمان</label><input name="name" value="${o.name}" required>
          <p><button class="btn sm">ذخیره نام</button></p></form>
        <form method="post" class="row">${csrf(c)}${hidden("action", "set_plan")}${hidden("org", o.id)}
          <div><label>طرح</label>${planSelect(o.plan, true)}</div>
          <div><label>روزهای پرداخت‌شده از امروز</label><input type="number" name="days" dir="ltr" min="0" max="3650" placeholder="خالی = بدون سررسید" style="width:9em"></div>
          <div class="auto"><button class="btn sm">ذخیره طرح</button></div></form>
        <p class="mut sm">طرح، سقف‌ها را هم تنظیم می‌کند. سقف‌ها را جداگانه هم می‌توانید عوض کنید:</p>
        <form method="post" class="row">${csrf(c)}${hidden("action", "limits")}${hidden("org", o.id)}${limitInputs(o)}
          <div class="auto"><button class="btn sm">ذخیره سقف</button></div></form>
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
  }) : html`<tr><td colspan="9" class="mut">هنوز سازمانی ساخته نشده است.</td></tr>`}
</tbody>
</table>
</div>

<h2 class="sec-title" id="billing">صورت‌حساب و فروش</h2>
<p class="mut">پرداخت آنلاین: ${v.payments ? html`<span class="pill ok">زرین‌پال فعال</span>` : html`<span class="pill mut">غیرفعال</span> — secret <span class="mono">ZARINPAL_MERCHANT</span> را تنظیم کنید`}</p>

<div class="box scroll">
  <h2>فاکتورها</h2>
  <table class="tbl">
  <thead><tr><th>شماره</th><th>سازمان</th><th>شرح</th><th>مبلغ</th><th>وضعیت</th><th>تاریخ</th><th></th></tr></thead>
  <tbody>
  ${v.invoices.length ? v.invoices.map((i) => html`
  <tr>
    <td class="mono">${i.number}</td><td>${i.org_name}</td>
    <td>${i.kind === "plan" ? `اشتراک ${v.plans.find((p) => p.id === i.item)?.name || i.item}` : i.kind === "hardware" ? html`${i.mode === "rent" ? "اجاره" : "خرید"} ${v.products.find((p) => p.id === i.item)?.name || i.item} × ${J.fa(i.qty)}<div class="mut sm">${i.note}</div>` : i.note || "دستی"}</td>
    <td class="nowrap">${money(i.total)}</td>
    <td>${i.status === "paid" ? html`<span class="pill ok">پرداخت شده</span>` : i.status === "pending" ? html`<span class="pill warn">در انتظار</span>` : html`<span class="pill bad">ناموفق</span>`}
      ${i.ref_id ? html`<div class="mono mut sm">${i.ref_id}</div>` : ""}</td>
    <td class="nowrap mut">${jdate(i.paid_at || i.created_at)}</td>
    <td class="nowrap end">
      ${i.status !== "paid" ? html`<form class="inline" method="post">${csrf(c)}${hidden("action", "invoice_paid")}${hidden("id", i.id)}
        <input name="ref" placeholder="شمارهٔ واریز" style="width:8em"><button class="btn sec sm">ثبت پرداخت دستی</button></form>` : ""}
      ${i.kind === "hardware" && i.status === "paid" ? html`<form class="inline" method="post">${csrf(c)}${hidden("action", "invoice_shipped")}${hidden("id", i.id)}
        <button class="btn ${i.shipped ? "sec" : ""} sm">${i.shipped ? "ارسال شد ✓" : "علامت ارسال"}</button></form>` : ""}
    </td>
  </tr>`) : html`<tr><td colspan="7" class="mut">هنوز فاکتوری نیست.</td></tr>`}
  </tbody></table>
  <details><summary>صدور فاکتور دستی (مثلاً طرح سازمانی)</summary>
    <form method="post" class="row">${csrf(c)}${hidden("action", "invoice_new")}
      <div><label>سازمان</label><select name="org">${v.orgs.map((o) => html`<option value="${o.id}">${o.name}</option>`)}</select></div>
      <div><label>مبلغ بدون مالیات (تومان)</label><input name="amount" type="number" dir="ltr" min="1000" required></div>
      <div><label>شرح</label><input name="note" maxlength="200" required></div>
      <div><label>روزهای اعتبار پس از پرداخت</label><input name="days" type="number" dir="ltr" min="0" max="3650" placeholder="خالی = تمدید نمی‌کند"></div>
      <div class="auto"><button class="btn">صدور</button></div>
    </form>
    <p class="mut sm">مشتری فاکتور را در صفحهٔ صورت‌حساب خود می‌بیند و با زرین‌پال می‌پردازد؛ یا پرداخت کارت‌به‌کارت را این‌جا دستی ثبت کنید.</p>
  </details>
</div>

${v.rentals.length ? html`
<div class="box scroll">
  <h2>دستگاه‌های اجاره‌ای فعال</h2>
  <table class="tbl"><tbody>${v.rentals.map((r) => html`<tr><td>${r.org_name}</td><td>${r.name} × ${J.fa(r.qty)}</td><td>${money(r.monthly * r.qty)} / ماه</td><td class="mut">از ${jdate(r.started_at)}</td>
    <td class="end"><form class="inline" method="post" onsubmit="return confirm('دستگاه بازگردانده شد و اجاره پایان یابد؟')">${csrf(c)}${hidden("action", "rental_end")}${hidden("id", r.id)}<button class="btn sec sm">پایان اجاره</button></form></td></tr>`)}</tbody></table>
</div>` : ""}

<div class="grid">
  <div class="box scroll">
    <h2>طرح‌ها</h2>
    <p class="mut sm">قیمت‌ها به تومان و بدون مالیات. سقف خالی = نامحدود. ویژگی‌ها هر کدام در یک خط.</p>
    ${v.plans.map((p) => html`
    <details><summary>${p.name} · ${p.contact ? "تماس با فروش" : html`${money(p.price_month)} / ماه`}</summary>
      <form method="post">${csrf(c)}${hidden("action", "plan_save")}${hidden("id", p.id)}
        <div class="row"><div><label>نام</label><input name="name" value="${p.name}"></div><div><label>توضیح کوتاه</label><input name="blurb" value="${p.blurb}"></div></div>
        <div class="row">
          <div><label>ماهانه</label><input name="price_month" type="number" dir="ltr" min="0" value="${p.price_month}"></div>
          <div><label>سالانه</label><input name="price_year" type="number" dir="ltr" min="0" value="${p.price_year}"></div>
          <div><label>روز آزمایشی</label><input name="trial_days" type="number" dir="ltr" min="0" max="90" value="${p.trial_days}"></div>
        </div>
        <div class="row">
          <div><label>درب</label><input name="max_doors" type="number" dir="ltr" min="0" value="${p.max_doors ?? ""}" placeholder="∞"></div>
          <div><label>مدیر</label><input name="max_admins" type="number" dir="ltr" min="0" value="${p.max_admins ?? ""}" placeholder="∞"></div>
          <div><label>کارت فعال</label><input name="max_cards" type="number" dir="ltr" min="0" value="${p.max_cards ?? ""}" placeholder="∞"></div>
        </div>
        <label>ویژگی‌ها</label><textarea name="features" rows="3">${p.features}</textarea>
        <p><button class="btn sm">ذخیره طرح</button></p>
      </form>
    </details>`)}
  </div>
  <div class="box scroll">
    <h2>محصولات سخت‌افزاری</h2>
    ${v.products.map((p) => html`
    <details><summary>${p.name} · ${money(p.price)}${p.active ? "" : " (غیرفعال)"}</summary>
      <form method="post">${csrf(c)}${hidden("action", "product_save")}${hidden("id", p.id)}
        <div class="row"><div><label>نام</label><input name="name" value="${p.name}"></div><div><label>برچسب</label><input name="badge" value="${p.badge}"></div></div>
        <label>توضیح</label><input name="blurb" value="${p.blurb}">
        <div class="row">
          <div><label>قیمت خرید</label><input name="price" type="number" dir="ltr" min="0" value="${p.price}"></div>
          <div><label>اجارهٔ ماهانه</label><input name="rent_month" type="number" dir="ltr" min="0" value="${p.rent_month ?? ""}" placeholder="اجاره‌ای نیست"></div>
        </div>
        <label class="check"><input type="checkbox" name="active" value="1" ${p.active ? "checked" : ""}> در فروشگاه نمایش داده شود</label>
        <p><button class="btn sm">ذخیره محصول</button></p>
      </form>
    </details>`)}
  </div>
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

// --- billing: pricing, subscription, store, invoices (SecureEntry pricing & billing designs) ---------

const toman = (n: number | null | undefined) => html`${money(n)} <small>تومان</small>`;
const CYCLE_FA: Record<string, string> = { month: "پرداخت ماهانه", year: "پرداخت سالانه" };
const STATE_FA: Record<string, string> = {
  legacy: "طرح سفارشی", free: "رایگان", trialing: "دوره آزمایشی", active: "فعال", past_due: "سررسید گذشته",
  suspended: "تعلیق", canceling: "لغو در پایان دوره",
};
const INV_STATUS: Record<string, [string, string]> = { paid: ["ok", "پرداخت شده"], pending: ["warn", "در انتظار پرداخت"], failed: ["bad", "ناموفق"] };
const invStatus = (st: string) => { const [cls, t] = INV_STATUS[st] || ["mut", st]; return html`<span class="pill ${cls}">${t}</span>`; };

/** "۳ درب", "۲ کاربر مدیر"… then the plan's own feature lines. */
function planLines(p: Row): string[] {
  const out: string[] = [];
  if (p.max_doors !== null) out.push(`${J.fa(p.max_doors.toLocaleString("en-US"))} درب`);
  if (p.max_admins !== null) out.push(`${J.fa(p.max_admins)} کاربر مدیر`);
  if (p.max_cards !== null) out.push(`${J.fa(p.max_cards.toLocaleString("en-US"))} کارت RFID`);
  return out.concat(String(p.features || "").split("\n").map((x) => x.trim()).filter(Boolean));
}

function planCard(p: Row, featured: boolean, action: Safe, cycleToggle: boolean, cycle = "month") {
  const priceBlock = p.contact ? html`<div class="price"><b>سفارشی</b></div>` : cycleToggle
    ? html`<div class="price pm"><b>${money(p.price_month)}</b><span>تومان / ماهانه</span></div>
           <div class="price py"><b>${money(p.price_year)}</b><span>تومان / سالانه</span></div>`
    : html`<div class="price"><b>${money(cycle === "year" ? p.price_year : p.price_month)}</b><span>تومان / ${cycle === "year" ? "سالانه" : "ماهانه"}</span></div>`;
  return html`
<div class="tier ${featured ? "featured" : ""} ${p.contact ? "dark" : ""}" id="plan-${p.id}">
  ${featured ? html`<span class="ribbon">محبوب‌ترین</span>` : ""}
  <h3>${p.name}</h3>
  ${priceBlock}
  <p class="blurb">${p.blurb}</p>
  <ul>${planLines(p).map((l) => html`<li>${icon("check")}${l}</li>`)}</ul>
  ${action}
</div>`;
}

function cycleSwitch(id: string) {
  return html`<label class="cycle" for="${id}"><span class="cm">ماهانه</span><span class="sw"><i></i></span><span class="cy">سالانه <em>۱۷٪ تخفیف</em></span></label>`;
}

function productCard(p: Row, footer: Safe | string = "") {
  return html`
<div class="product">
  <div class="pimg">${icon(p.id === "android_kit" ? "tablet-screen-button" : p.id === "reader_relay" ? "plug" : "microchip")}</div>
  <div class="pbody">
    <div class="ptitle"><h3>${p.name}</h3>${p.badge ? html`<span class="badge">${p.badge}</span>` : ""}</div>
    <p class="blurb">${p.blurb}</p>
    <div class="pprice"><b>${money(p.price)} تومان</b>${p.rent_month ? html`<span>یا اجاره ${money(p.rent_month)} / ماهانه</span>` : ""}</div>
    ${footer}
  </div>
</div>`;
}

const PRICING_FAQ: [string, string][] = [
  ["آیا می‌توانم از سخت‌افزار خودم استفاده کنم؟", "بله! شما می‌توانید کارتخوان‌های خود را با استفاده از Wemos D1 mini و RC522 بسازید. ما فیرم‌ور رایگان و مستندات کامل ساخت را ارائه می‌دهیم."],
  ["محدودیت «درب» چیست؟", "هر درب مربوط به یک نقطه دسترسی فیزیکی (یک کارتخوان یا یک تبلت NFC) است. طرح‌های ما تعداد درب‌های فعالی که می‌توانید همزمان مدیریت کنید را محدود می‌کنند."],
  ["آیا از تاریخ شمسی پشتیبانی می‌کنید؟", "قطعاً. سامانه کاملاً برای محیط‌های سازمانی ایران بومی‌سازی شده و از تقویم جلالی و چیدمان راست‌چین در تمامی گزارش‌ها پشتیبانی می‌کند."],
  ["پرداخت چطور انجام می‌شود؟", "پرداخت آنلاین با همهٔ کارت‌های بانکی عضو شتاب از طریق درگاه زرین‌پال انجام می‌شود و فاکتور رسمی در پنل صادر می‌شود."],
];

export function pricingPage(c: PageCtx, v: { plans: Row[]; products: Row[] }) {
  const action = (p: Row) => {
    const href = c.user ? "/billing#plans" : `/register?plan=${p.id}`;
    const label = p.contact ? "تماس با فروش" : p.id === "free" ? "شروع رایگان" : p.trial_days ? `شروع دوره آزمایشی ${J.fa(p.trial_days)} روزه` : "انتخاب طرح";
    return html`<a class="btn ${p.id === "starter" ? "" : p.contact ? "light" : "ghost"} wide" href="${href}">${label}</a>`;
  };
  const jsonld = [{
    "@context": "https://schema.org", "@type": "Product", name: `${BRAND} — ${SITE_NAME}`, description: SITE_DESC,
    offers: v.plans.filter((p) => !p.contact).map((p) => ({ "@type": "Offer", name: p.name, price: p.price_month * 10, priceCurrency: "IRR" })),
  }];
  return layout(c, `قیمت‌گذاری | ${BRAND}`, html`
<section class="phero">
  <h1>کنترل دسترسی مقیاس‌پذیر برای<br><span>هر سازمان مدرن</span></h1>
  <p class="lead">از یک درب تا سازمان‌های بزرگ. حضور و غیاب، کارت‌ها و دستگاه‌ها را در یک پلتفرم ابری یکپارچه مدیریت کنید.</p>
</section>
<section class="pricing">
  <input type="checkbox" id="yearly" class="cyc-input">
  ${cycleSwitch("yearly")}
  <div class="tiers">${v.plans.map((p) => planCard(p, p.id === "starter", action(p), true))}</div>
</section>
<section class="hardware" id="hardware">
  <div class="hwhead">
    <div><h2>به سخت‌افزار نیاز دارید؟</h2>
    <p class="lead">پلتفرم ما با بردهای Wemos D1 mini ساخت خودتان یا کیت‌های آماده و تنظیم شدهٔ ما کار می‌کند. متناسب با بودجهٔ خود خرید یا اجاره کنید.</p></div>
    <a class="btn ghost" href="${c.user ? "/store" : "/register"}">مشاهده همه محصولات</a>
  </div>
  <div class="products">${v.products.map((p) => productCard(p))}</div>
</section>
<section class="pfaq faq" id="faq">
  <h2>سوالات متداول</h2>
  ${PRICING_FAQ.map(([q, a]) => html`<details><summary><h3>${q}</h3></summary><p>${a}</p></details>`)}
</section>`, {
    path: "/pricing", jsonld,
    description: "قیمت طرح‌های سامانهٔ کنترل تردد و حضور و غیاب: رایگان، استارتر، تجاری و سازمانی، با ۱۴ روز آزمایش رایگان؛ خرید یا اجارهٔ کارتخوان RFID و کیت درب اندرویدی.",
  }, { public: true });
}

function usageBar(label: string, used: number, max: number | null) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return html`
<div class="usage">
  <div class="uhead"><span>${label}</span><b>${J.fa(used)} / ${max === null ? "∞" : J.fa(max)}</b></div>
  <div class="ubar ${pct >= 90 ? "full" : ""}"><i style="width:${max === null ? 0 : pct}%"></i></div>
</div>`;
}

function invoiceRows(c: PageCtx, rows: Row[]) {
  return rows.length ? rows.map((i) => html`
<tr>
  <td class="mono">${i.number}</td>
  <td class="nowrap">${jday(i.paid_at || i.created_at)}</td>
  <td class="nowrap">${money(i.total)} تومان</td>
  <td>${invStatus(i.status)}</td>
  <td class="end nowrap">
    ${i.status === "pending" ? html`<form class="inline" method="post" action="/billing/invoices/${i.id}/pay">${csrf(c)}<button class="btn sm">پرداخت</button></form>` : ""}
    <a class="btn sec sm" href="/billing/invoices/${i.id}">مشاهده</a>
  </td>
</tr>`) : html`<tr><td colspan="5" class="mut">هنوز فاکتوری صادر نشده است.</td></tr>`;
}

export function billingPage(c: PageCtx, v: {
  org: Row; plan: Row | null; plans: Row[]; state: string; usage: { doors: number; admins: number; cards: number };
  invoices: Row[]; rentals: Row[]; next: Quote | null; nextPlan: Row | null; payments: boolean; vat: number; daysLeft: number; cycle: string;
}) {
  const o = v.org, st = v.state;
  const banner = (cls: string, ic: string, title: string, text: string, action: Safe | string) => html`
<div class="banner ${cls}">
  <div class="bicon">${icon(ic)}</div>
  <div class="btext"><h4>${title}</h4><p>${text}</p></div>
  ${action}
</div>`;
  const choose = html`<a class="btn light" href="#plans">انتخاب طرح</a>`;
  const renewForm = (label: string, cls = "btn") => v.nextPlan ? html`
<form method="post" action="/billing/checkout" class="inline">${csrf(c)}
  <input type="hidden" name="plan" value="${v.nextPlan.id}"><input type="hidden" name="cycle" value="${o.cycle || "month"}">
  <button class="${cls}">${label}</button></form>` : "";
  const top =
    st === "trialing" ? banner("brand", "rocket", `${J.fa(v.daysLeft)} روز تا پایان دوره آزمایشی باقی مانده`,
      `دوره آزمایشی شما در تاریخ ${jday(o.paid_until)} پایان می‌یابد. برای جلوگیری از قطع سرویس، طرح خود را ارتقا دهید.`, choose)
    : st === "past_due" ? banner("warn", "bell", "پرداخت اشتراک سررسید گذشته است",
      `دورهٔ شما ${jday(o.paid_until)} تمام شد. درها تا ${J.fa(3)} روز پس از آن کار می‌کنند؛ برای جلوگیری از قطع، تمدید کنید.`, renewForm("تمدید و پرداخت", "btn light"))
    : st === "suspended" ? banner("bad", "credit-card", "اشتراک تعلیق شده است",
      "کارت‌ها روی درها پذیرفته نمی‌شوند و نمایشگرها پیام تعلیق نشان می‌دهند. با تمدید، همه چیز بلافاصله فعال می‌شود.", renewForm("تمدید و فعال‌سازی", "btn light"))
    : st === "canceling" ? banner("muted", "calendar-check", "اشتراک لغو شده است",
      `تا ${jday(o.paid_until)} همهٔ امکانات فعال است و پس از آن به طرح رایگان می‌روید.`,
      html`<form method="post" action="/billing/resume" class="inline">${csrf(c)}<button class="btn light">ادامهٔ اشتراک</button></form>`)
    : st === "legacy" ? banner("muted", "user-shield", "طرح سفارشی", "صورت‌حساب این سازمان توسط مدیر سرور تنظیم می‌شود. برای جابه‌جایی به یکی از طرح‌های زیر می‌توانید یکی را انتخاب کنید.", choose)
    : "";
  const planName = v.plan ? v.plan.name : "سفارشی";
  const maxOf = (k: string, legacy: number | null) => (v.plan ? v.plan[k] : legacy);
  const nextBox = v.next && v.nextPlan ? html`
  <div class="box nextpay">
    <div>
      <h3 class="cap">پرداخت بعدی</h3>
      <p class="big">${money(v.next.total)} <small>تومان</small></p>
      <p class="mut">سررسید: ${jday(o.paid_until)}${v.nextPlan.id !== o.plan ? html` · طرح «${v.nextPlan.name}»` : ""}</p>
      <p class="mut sm vatline">${icon("file-invoice")} شامل ${J.fa(v.vat)}٪ مالیات بر ارزش افزوده${v.next.rentals ? html` و ${money(v.next.rentals)} تومان اجارهٔ دستگاه` : ""}</p>
    </div>
    <div class="nextact">
      ${renewForm(st === "trialing" ? "پرداخت و فعال‌سازی" : "تمدید زودهنگام", "btn line wide")}
      ${st === "active" || st === "trialing" ? html`<form method="post" action="/billing/cancel" onsubmit="return confirm(this.dataset.q)" data-q="اشتراک در پایان دوره لغو شود؟">${csrf(c)}<button class="linkbtn">لغو اشتراک</button></form>` : ""}
    </div>
  </div>` : html`
  <div class="box nextpay">
    <div>
      <h3 class="cap">پرداخت بعدی</h3>
      <p class="big">—</p>
      <p class="mut">${st === "free" ? "طرح رایگان هزینه‌ای ندارد." : st === "canceling" ? "پس از پایان دوره پرداختی نخواهید داشت." : "صورت‌حساب به‌صورت دستی صادر می‌شود."}</p>
    </div>
  </div>`;
  const pendingManual = v.invoices.filter((i) => i.status === "pending");
  const planAction = (p: Row) => {
    if (p.contact) return html`<form method="post" action="/billing/checkout">${csrf(c)}<input type="hidden" name="plan" value="${p.id}"><button class="btn light wide">تماس با فروش</button></form>`;
    const current = o.plan === p.id && (p.id === "free" || (o.cycle || "month") === v.cycle);
    const label = current ? (st === "trialing" || st === "past_due" || st === "suspended" ? "پرداخت این طرح" : p.id === "free" ? "طرح فعلی" : "تمدید")
      : p.id === "free" ? "رفتن به رایگان" : "انتخاب";
    if (current && p.id === "free") return html`<button class="btn ghost wide" disabled>طرح فعلی</button>`;
    return html`<form method="post" action="/billing/checkout">${csrf(c)}
      <input type="hidden" name="plan" value="${p.id}"><input type="hidden" name="cycle" value="${v.cycle}">
      <button class="btn ${p.id === "starter" ? "" : "ghost"} wide">${label}</button></form>`;
  };
  return layout(c, "صورت‌حساب · " + BRAND, html`
${top}
${pendingManual.length ? html`<div class="flash warn">${J.fa(pendingManual.length)} فاکتور در انتظار پرداخت دارید. <a href="/billing/invoices/${pendingManual[0].id}">مشاهده و پرداخت</a></div>` : ""}
${!v.payments ? html`<div class="flash warn">پرداخت آنلاین هنوز فعال نشده است؛ برای تمدید یا خرید با پشتیبانی تماس بگیرید.</div>` : ""}
<div class="bgrid">
  <div class="box curplan">
    <div class="cphead">
      <div>
        <h3 class="cap">اشتراک فعلی</h3>
        <div class="cpname"><span>طرح ${planName}</span><span class="tag">${st === "trialing" ? "دوره آزمایشی" : st === "free" || st === "legacy" ? STATE_FA[st] : CYCLE_FA[o.cycle || "month"]}</span>
          ${st === "past_due" || st === "suspended" ? html`<span class="pill bad">${STATE_FA[st]}</span>` : ""}</div>
      </div>
      <a class="lnk" href="#plans">تغییر طرح</a>
    </div>
    <div class="usages">
      ${usageBar("درب‌ها", v.usage.doors, maxOf("max_doors", o.max_devices))}
      ${usageBar("مدیران", v.usage.admins, maxOf("max_admins", o.max_users))}
      ${usageBar("کارت‌های فعال", v.usage.cards, maxOf("max_cards", o.max_cards))}
    </div>
    ${o.next_plan && o.next_plan !== o.plan ? html`<p class="mut sm">از تمدید بعدی طرح شما «${v.plans.find((p) => p.id === o.next_plan)?.name || o.next_plan}» می‌شود.</p>` : ""}
  </div>
  ${nextBox}
</div>

<div class="box">
  <div class="boxhead"><h2>فاکتورهای اخیر</h2><a class="lnk" href="/billing/invoices">مشاهده همه</a></div>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>مبلغ</th><th>وضعیت</th><th class="end">عملیات</th></tr></thead>
    <tbody>${invoiceRows(c, v.invoices)}</tbody>
  </table></div>
</div>

${v.rentals.length ? html`
<div class="box">
  <h2>دستگاه‌های اجاره‌ای</h2>
  <table class="tbl"><tbody>${v.rentals.map((r) => html`<tr><td>${r.name}</td><td>${J.fa(r.qty)} عدد</td><td>${money(r.monthly * r.qty)} تومان / ماهانه</td><td class="mut">از ${jday(r.started_at)}</td></tr>`)}</tbody></table>
  <p class="mut sm">اجاره هر ماه به تمدید اشتراک اضافه می‌شود. برای بازگرداندن دستگاه با پشتیبانی تماس بگیرید.</p>
</div>` : ""}

<section class="box" id="plans">
  <div class="boxhead"><h2>انتخاب طرح</h2>
    <div class="seg"><a href="?cycle=month#plans" class="${v.cycle === "month" ? "on" : ""}">ماهانه</a><a href="?cycle=year#plans" class="${v.cycle === "year" ? "on" : ""}">سالانه <em>۱۷٪ تخفیف</em></a></div>
  </div>
  <div class="tiers inpanel">${v.plans.map((p) => planCard(p, o.plan === p.id, planAction(p), false, v.cycle))}</div>
  <p class="mut sm">مبالغ بدون ${J.fa(v.vat)}٪ مالیات بر ارزش افزوده است. در ارتقا، روزهای استفاده‌نشدهٔ طرح فعلی از مبلغ کم می‌شود؛ کاهش طرح از تمدید بعدی اعمال می‌شود.</p>
</section>

<div class="hwcta">
  <div class="hwicon">${icon("microchip")}</div>
  <div class="hwtext"><h3>تعداد درب‌ها کافی نیست؟</h3><p>کارتخوان‌های تنظیم شده و کیت‌های رله را از فروشگاه ما سفارش دهید. ارسال سریع به دفتر شما.</p></div>
  <a class="btn dark" href="/store">بازدید از فروشگاه</a>
</div>`, undefined, { heading: "بررسی صورت‌حساب" });
}

export function checkoutPage(c: PageCtx, v: { plan: Row; cycle: string; q: Quote; vat: number; payments: boolean }) {
  const KIND: Record<string, string> = { renew: "تمدید", upgrade: "ارتقای طرح", start: "شروع اشتراک", downgrade: "کاهش طرح" };
  const line = (label: string, val: Safe | string) => html`<tr><th>${label}</th><td class="end">${val}</td></tr>`;
  return layout(c, "پرداخت · " + BRAND, html`
<div class="pagehead"><h1>${KIND[v.q.kind]}: طرح ${v.plan.name}</h1></div>
<div class="box checkout">
  <table class="tbl">
    ${line(`طرح ${v.plan.name} (${CYCLE_FA[v.cycle]})`, html`${money(v.cycle === "year" ? v.plan.price_year : v.plan.price_month)} تومان`)}
    ${v.q.rentals ? line("اجارهٔ دستگاه‌ها", html`${money(v.q.rentals)} تومان`) : ""}
    ${v.q.credit ? line("اعتبار روزهای باقی‌ماندهٔ طرح فعلی", html`−${money(v.q.credit)} تومان`) : ""}
    ${line(`مالیات بر ارزش افزوده (${J.fa(v.vat)}٪)`, html`${money(v.q.vat)} تومان`)}
    <tr class="total"><th>مبلغ قابل پرداخت</th><td class="end">${money(v.q.total)} تومان</td></tr>
  </table>
  <p class="mut">دورهٔ جدید: ${jday(v.q.periodStart)} تا ${jday(v.q.periodEnd)}</p>
  <form method="post" action="/billing/checkout" class="row">${csrf(c)}
    <input type="hidden" name="plan" value="${v.plan.id}"><input type="hidden" name="cycle" value="${v.cycle}"><input type="hidden" name="confirm" value="1">
    <div class="auto"><button class="btn big" ${v.payments ? "" : "disabled"}>${icon("credit-card")} پرداخت با زرین‌پال</button></div>
    <div class="auto"><a class="btn sec big" href="/billing#plans">انصراف</a></div>
  </form>
</div>`);
}

export function storePage(c: PageCtx, v: { products: Row[]; orders: Row[]; rentals: Row[]; canRent: boolean; payments: boolean; vat: number }) {
  const form = (p: Row) => html`
<form method="post" action="/store/order" class="order">${csrf(c)}
  <input type="hidden" name="product" value="${p.id}">
  <div class="modes">
    <label class="check"><input type="radio" name="mode" value="buy" checked> خرید · ${money(p.price)} تومان</label>
    ${p.rent_month ? html`<label class="check ${v.canRent ? "" : "mut"}"><input type="radio" name="mode" value="rent" ${v.canRent ? "" : "disabled"}> اجاره · ${money(p.rent_month)} تومان / ماهانه</label>` : ""}
  </div>
  <details><summary class="btn wide">سفارش</summary>
    <label>تعداد</label><input name="qty" type="number" dir="ltr" min="1" max="20" value="1">
    <label>نشانی کامل، کد پستی و نام گیرنده</label><textarea name="address" rows="3" required minlength="10" maxlength="400"></textarea>
    <p><button class="btn wide" ${v.payments ? "" : "disabled"}>پرداخت با زرین‌پال</button></p>
    <p class="mut sm">به مبلغ ${J.fa(v.vat)}٪ مالیات بر ارزش افزوده اضافه می‌شود.${p.rent_month ? " اجاره از ماه دوم به تمدید اشتراک اضافه می‌شود." : ""}</p>
  </details>
</form>`;
  return layout(c, "فروشگاه سخت‌افزار · " + BRAND, html`
<p class="mut">کیت‌های آماده و برنامه‌ریزی‌شده برای درب‌های شما. پس از پرداخت، سفارش ظرف ۳ روز کاری ارسال می‌شود.${v.canRent ? "" : " اجاره فقط همراه یک اشتراک پولی فعال ممکن است."}</p>
${!v.payments ? html`<div class="flash warn">پرداخت آنلاین هنوز فعال نشده است؛ برای سفارش با پشتیبانی تماس بگیرید.</div>` : ""}
<div class="products">${v.products.map((p) => productCard(p, form(p)))}</div>
${v.orders.length || v.rentals.length ? html`
<div class="box">
  <h2>سفارش‌های شما</h2>
  <div class="scroll"><table class="tbl">
    <thead><tr><th>فاکتور</th><th>محصول</th><th>نوع</th><th>تاریخ</th><th>ارسال</th></tr></thead>
    <tbody>${v.orders.map((o) => html`<tr><td class="mono"><a href="/billing/invoices/${o.id}">${o.number}</a></td><td>${o.name} × ${J.fa(o.qty)}</td>
      <td>${o.mode === "rent" ? "اجاره" : "خرید"}</td><td>${jday(o.paid_at)}</td><td>${o.shipped ? html`<span class="pill ok">ارسال شد</span>` : html`<span class="pill warn">در حال آماده‌سازی</span>`}</td></tr>`)}</tbody>
  </table></div>
</div>` : ""}`, undefined, { heading: "فروشگاه سخت‌افزار" });
}

export function invoicesPage(c: PageCtx, v: { rows: Row[] }) {
  return layout(c, "فاکتورها · " + BRAND, html`
<div class="pagehead"><h1>فاکتورها</h1><a class="btn sec" href="/billing">بازگشت به صورت‌حساب</a></div>
<div class="box scroll"><table class="tbl">
  <thead><tr><th>شماره فاکتور</th><th>تاریخ</th><th>مبلغ</th><th>وضعیت</th><th class="end">عملیات</th></tr></thead>
  <tbody>${invoiceRows(c, v.rows)}</tbody>
</table></div>`);
}

export function invoicePage(c: PageCtx, v: { inv: Row; org: Row; itemName: string; vat: number }) {
  const i = v.inv;
  const desc = i.kind === "plan" ? `اشتراک طرح ${v.itemName} (${CYCLE_FA[i.cycle || "month"]})`
    : i.kind === "hardware" ? `${i.mode === "rent" ? "اجارهٔ ماه اول" : "خرید"} ${v.itemName}` : (i.note || "فاکتور دستی");
  const line = (label: string, val: Safe | string) => html`<tr><th>${label}</th><td class="end">${val}</td></tr>`;
  return layout(c, `فاکتور ${i.number} · ${BRAND}`, html`
<div class="pagehead noprint"><h1>فاکتور ${i.number}</h1>
  <div class="row auto">
    ${i.status === "pending" ? html`<form class="inline" method="post" action="/billing/invoices/${i.id}/pay">${csrf(c)}<button class="btn">پرداخت با زرین‌پال</button></form>` : ""}
    <button class="btn sec" onclick="print()">چاپ</button>
    <a class="btn sec" href="/billing/invoices">همه فاکتورها</a>
  </div>
</div>
<div class="box invoice">
  <div class="invhead">
    <div><span class="pbrand">${logo()}<b>${BRAND}</b></span><p class="mut sm">صورتحساب فروش کالا و خدمات</p></div>
    <div class="end"><p class="mono">${i.number}</p><p>${jday(i.paid_at || i.created_at)}</p>${invStatus(i.status)}</div>
  </div>
  <p><b>خریدار:</b> ${v.org.name}${v.org.email ? html` · <span class="ltr">${v.org.email}</span>` : ""}${v.org.phone ? html` · <span class="ltr">${v.org.phone}</span>` : ""}</p>
  <table class="tbl">
    ${line(`${desc}${i.qty > 1 ? ` × ${J.fa(i.qty)}` : ""}`, html`${money(i.amount + i.credit)} تومان`)}
    ${i.credit ? line("اعتبار طرح قبلی", html`−${money(i.credit)} تومان`) : ""}
    ${line("مالیات بر ارزش افزوده", html`${money(i.vat)} تومان`)}
    <tr class="total"><th>جمع کل</th><td class="end">${money(i.total)} تومان</td></tr>
  </table>
  ${i.period_end && i.kind !== "hardware" ? html`<p class="mut">اعتبار تا ${jday(i.period_end)}</p>` : ""}
  ${i.kind === "hardware" ? html`<p class="mut">نشانی ارسال: ${i.note}</p>` : ""}
  ${i.status === "paid" ? html`<p class="mut">کد پیگیری زرین‌پال: <span class="mono">${i.ref_id || "—"}</span>${i.card_pan ? html` · کارت <span class="mono">${i.card_pan}</span>` : ""}</p>` : ""}
</div>`);
}

export function errorPage(status: number, message: string) {
  return html`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title>
<link rel="stylesheet" href="/static/style.css"></head>
<body><main><div class="box"><h1>${status}</h1><p>${message}</p><p><a href="/">بازگشت</a></p></div></main></body></html>`;
}

export { raw };
