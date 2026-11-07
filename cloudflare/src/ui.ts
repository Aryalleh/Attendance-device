// Pages and shells built from the UX Pilot SecureEntry designs (page ly1ouh9SJsPPFXWfd24K):
//   Pricing / Pricing_FA (desktop + mobile), BillingOverview / BillingOverview_FA (desktop + mobile).
// The markup and Tailwind classes are the designs', tag for tag; only data, links and the language switch are wired in.
// Desktop and mobile designs are both rendered and swapped at Tailwind's md breakpoint (768 px).
import type { Quote } from "./billing";
import type { Row } from "./db";
import { html, raw, Safe } from "./html";
import { fi, icon } from "./icons";
import * as J from "./jalali";
import { enDate, jday, jdayShort } from "./time";
import { BRAND, csrf, metaTags, type Meta, type PageCtx } from "./views";

export type Lang = "fa" | "en";
const L = (c: PageCtx): Lang => (c.lang === "en" ? "en" : "fa");
/** Persian or English text / class list. */
const t = (l: Lang, fa: string, en: string) => (l === "en" ? en : fa);
const trim1 = (x: number) => String(+x.toFixed(1));

/** 450,000 / ۴۵۰,۰۰۰ */
export const num = (l: Lang, v: number) => (l === "en" ? Math.round(v).toLocaleString("en-US") : J.fa(Math.round(v).toLocaleString("en-US")));
/** English designs write 450k / 1.2M; Persian ones the full number. */
const short = (l: Lang, v: number) =>
  l === "fa" ? num(l, v) : v >= 1e6 ? `${trim1(v / 1e6)}M` : v >= 1000 ? `${trim1(v / 1000)}k` : String(v);
/** Mobile shop prices: '۱.۵ میلیون تومان' / '1.5M Toman'. */
const shortMoney = (l: Lang, v: number) =>
  l === "en" ? `${short(l, v)} Toman` : v >= 1e6 ? `${J.fa(trim1(v / 1e6))} میلیون تومان` : `${num(l, v)} تومان`;
const longDate = (l: Lang, ts: number | null) => (l === "en" ? enDate(ts) : jday(ts));
const shortDate = (l: Lang, ts: number | null) => (l === "en" ? enDate(ts, false) : jdayShort(ts));

// --- page head ----------------------------------------------------------------------------

/** designed = page made only from the designs (Tailwind preflight, no style.css). */
function head(c: PageCtx, title: string, designed: boolean, meta?: Meta) {
  return html`<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#4f46e5">
${meta ? metaTags(c, title, meta) : ""}
<link rel="preload" href="/static/fonts/Vazirmatn.woff2" as="font" type="font/woff2" crossorigin>
${L(c) === "en" ? raw(`<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">`) : ""}
${designed ? raw(`<link rel="stylesheet" href="/static/se-base.css">`) : ""}
<link rel="stylesheet" href="/static/se.css">
${designed ? "" : raw(`<link rel="stylesheet" href="/static/style.css">`)}
</head>`;
}

function flashes(c: PageCtx, cls = "") {
  const tone: Record<string, string> = {
    ok: "bg-green-50 text-green-700 border-green-200", error: "bg-red-50 text-red-700 border-red-200", warn: "bg-amber-50 text-amber-700 border-amber-200",
  };
  return c.flashes.map(([cat, msg]) => html`<div class="${cls} rounded-xl border px-4 py-3 text-sm font-medium ${tone[cat] || tone.ok}">${msg}</div>`);
}

const langUrl = (c: PageCtx, lang: Lang) => `${c.path || "/"}?lang=${lang}`;

// --- public shell: header and footer of SecureEntry - Pricing (desktop) and its mobile version -----------

function publicHeader(c: PageCtx) {
  const l = L(c);
  const nav = (href: string, label: string, on: boolean) =>
    html`<a href="${href}" class="${on ? "text-indigo-600" : "hover:text-indigo-600 transition-colors"}">${label}</a>`;
  const seg = (lang: Lang, label: string) => html`<a href="${langUrl(c, lang)}" class="${l === lang
    ? "px-3 py-1 bg-white shadow-sm rounded-full text-indigo-600" : "px-3 py-1 text-slate-500 hover:text-indigo-600 transition-colors"}">${label}</a>`;
  return html`
<header id="header" class="twr hidden md:block bg-white border-b border-slate-200 sticky top-0 z-50">
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
<a href="/" class="flex items-center gap-2">
<div class="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
${fi("shield-halved")}
</div>
<span class="text-xl font-bold tracking-tight text-slate-900">SecureEntry</span>
</a>
<nav class="hidden md:flex items-center gap-8 text-sm font-medium text-slate-600">
${nav("/pricing#hardware-shop", t(l, "محصولات", "Products"), false)}
${nav("/#features", t(l, "راهکارها", "Solutions"), false)}
${nav("/pricing", t(l, "قیمت‌گذاری", "Pricing"), c.endpoint === "pricing")}
${nav("/llms.txt", t(l, "مستندات", "Documentation"), false)}
</nav>
<div class="flex items-center gap-4">
<div class="flex items-center bg-slate-100 rounded-full p-1 text-xs font-semibold">
${seg("en", "EN")}
${seg("fa", "FA")}
</div>
${c.user ? html`<a href="/dashboard" class="text-sm font-semibold text-slate-600 hover:text-slate-900">${t(l, "داشبورد", "Dashboard")}</a>`
    : html`<a href="/login" class="text-sm font-semibold text-slate-600 hover:text-slate-900">${t(l, "ورود", "Log in")}</a>`}
<a href="/register" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-sm">${t(l, "شروع کنید", "Get Started")}</a>
</div>
</div>
</header>
<header id="header-m" class="twr md:hidden bg-white border-b border-slate-200 sticky top-0 z-50">
<div class="px-4 h-14 flex items-center justify-between">
<a href="/" class="flex items-center gap-2">
<div class="w-7 h-7 bg-indigo-600 rounded flex items-center justify-center text-white text-sm">
${fi("shield-halved")}
</div>
<span class="text-lg font-bold tracking-tight text-slate-900">SecureEntry</span>
</a>
<div class="flex items-center gap-3">
<button class="text-slate-600 text-lg p-2" aria-label="${t(l, "منو", "Menu")}" onclick="document.getElementById('mmenu').classList.toggle('hidden')">${fi("bars")}</button>
</div>
</div>
<div id="mmenu" class="hidden border-t border-slate-100 px-4 py-3 space-y-1 text-sm font-medium text-slate-600">
<a class="block py-2" href="/pricing#hardware-shop">${t(l, "محصولات", "Products")}</a>
<a class="block py-2" href="/#features">${t(l, "راهکارها", "Solutions")}</a>
<a class="block py-2" href="/pricing">${t(l, "قیمت‌گذاری", "Pricing")}</a>
<a class="block py-2" href="/llms.txt">${t(l, "مستندات", "Documentation")}</a>
<a class="block py-2" href="${c.user ? "/dashboard" : "/login"}">${c.user ? t(l, "داشبورد", "Dashboard") : t(l, "ورود", "Log in")}</a>
<a class="block py-2 text-indigo-600 font-bold" href="${langUrl(c, l === "fa" ? "en" : "fa")}">${l === "fa" ? "EN" : "FA"}</a>
</div>
</header>`;
}

function publicFooter(c: PageCtx) {
  const l = L(c), fa = l === "fa";
  // links to pages that don't exist yet are plain text in the same style
  const link = (href: string | null, label: string, cls = "hover:text-indigo-400 transition-colors") =>
    href ? html`<a href="${href}" class="${cls}">${label}</a>` : html`<span class="${cls}">${label}</span>`;
  const logo = html`<div class="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
${fi("shield-halved")}
</div>`;
  const name = html`<span class="text-xl font-bold tracking-tight">SecureEntry</span>`;
  return html`
<footer id="footer" class="twr hidden md:block bg-slate-900 text-white py-12">
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8${fa ? " text-right" : ""}">
<div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
<div class="col-span-2 md:col-span-1">
<div class="flex items-center gap-2 mb-6${fa ? " justify-end" : ""}">
${fa ? html`${name}\n${logo}` : html`${logo}\n${name}`}
</div>
<p class="text-slate-400 text-sm leading-relaxed">
${t(l, "کنترل دسترسی مدرن و مدیریت حضور و غیاب برای عصر توزیع شده. اولویت با ابر، مستقل از سخت‌افزار.",
    "Modern access control and attendance management for the distributed era. Cloud-first, hardware-agnostic.")}
</p>
</div>
<div>
<h5 class="font-bold mb-4">${t(l, "محصول", "Product")}</h5>
<ul class="space-y-2 text-sm text-slate-400">
<li>${link("/#features", t(l, "ویژگی‌ها", "Features"))}</li>
<li>${link("/pricing#hardware-shop", t(l, "سخت‌افزار", "Hardware"))}</li>
<li>${link("/pricing", t(l, "قیمت‌گذاری", "Pricing"))}</li>
<li>${link("/llms.txt", t(l, "مستندات API", "API Docs"))}</li>
</ul>
</div>
<div>
<h5 class="font-bold mb-4">${t(l, "شرکت", "Company")}</h5>
<ul class="space-y-2 text-sm text-slate-400">
<li>${link("/#faq", t(l, "درباره ما", "About"))}</li>
<li>${link(null, t(l, "تماس با ما", "Contact"))}</li>
<li>${link(null, t(l, "حریم خصوصی", "Privacy"))}</li>
<li>${link(null, t(l, "شرایط استفاده", "Terms"))}</li>
</ul>
</div>
<div>
<h5 class="font-bold mb-4">${t(l, "پشتیبانی", "Support")}</h5>
<ul class="space-y-2 text-sm text-slate-400">
<li>${link("/#faq", t(l, "مرکز کمک", "Help Center"))}</li>
<li>${link(null, t(l, "وضعیت سیستم", "Status"))}</li>
<li>${link(null, t(l, "یادداشت‌های انتشار", "Release Notes"))}</li>
</ul>
</div>
</div>
<div class="border-t border-slate-800 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
<div class="flex gap-6">
<span class="text-slate-400">${fi("linkedin")}</span>
<span class="text-slate-400">${fi("github")}</span>
<span class="text-slate-400">${fi("twitter")}</span>
</div>
<p class="text-slate-500 text-xs">${t(l, "© ۲۰۲۶ کنترل دسترسی سکور‌انتری. تمامی حقوق محفوظ است.", "© 2026 SecureEntry Access Control. All rights reserved.")}</p>
</div>
</div>
</footer>
<footer id="footer-m" class="twr md:hidden bg-slate-900 text-white py-10 px-4${fa ? " text-right" : ""}">
<div class="flex items-center gap-2 mb-6${fa ? " justify-end" : ""}">
${fa ? html`<span class="font-bold tracking-tight">SecureEntry</span>` : ""}
<div class="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center text-white text-xs">
${fi("shield-halved")}
</div>
${fa ? "" : html`<span class="font-bold tracking-tight">SecureEntry</span>`}
</div>
<p class="text-[10px] text-slate-500 mb-6 uppercase tracking-widest font-bold">${t(l, "کنترل دسترسی ابری", "Cloud Access Control")}</p>
<div class="grid grid-cols-2 gap-8 mb-8 text-xs text-slate-400">
<div class="space-y-2">
<p class="text-white font-bold mb-3">${t(l, "محصول", "Product")}</p>
<a href="/pricing" class="block">${t(l, "قیمت‌گذاری", "Pricing")}</a>
<a href="/pricing#hardware-shop" class="block">${t(l, "سخت‌افزار", "Hardware")}</a>
<a href="/llms.txt" class="block">API</a>
</div>
<div class="space-y-2">
<p class="text-white font-bold mb-3">${t(l, "پشتیبانی", "Support")}</p>
<a href="/llms.txt" class="block">${t(l, "مستندات", "Docs")}</a>
<span class="block">${t(l, "تماس", "Contact")}</span>
<span class="block">${t(l, "شرایط", "Terms")}</span>
</div>
</div>
<div class="border-t border-slate-800 pt-6 flex justify-between items-center${fa ? " flex-row-reverse" : ""}">
<p class="text-[10px] text-slate-500">${t(l, "© ۲۰۲۶ SecureEntry", "© 2026 SecureEntry")}</p>
<div class="flex gap-4 text-slate-400">
${fi("linkedin")}
${fi("twitter")}
</div>
</div>
</footer>`;
}

/** Public pages: designed = the pricing page (only Tailwind); otherwise older content inside the design's header/footer. */
export function publicShell(c: PageCtx, title: string, body: Safe, meta: Meta | undefined, designed: boolean): Safe {
  const l = L(c);
  return html`<!DOCTYPE html>
<html lang="${l}" dir="${l === "fa" ? "rtl" : "ltr"}" class="se">
${head(c, title, designed, meta)}
<body class="bg-slate-50 text-slate-900">
${publicHeader(c)}
${designed ? html`${c.flashes.length ? html`<div class="max-w-7xl mx-auto px-4 pt-4 space-y-2">${flashes(c)}</div>` : ""}${body}`
    : html`<main class="pubmain">${c.flashes.length ? html`<div class="pt-4 space-y-2">${flashes(c)}</div>` : ""}${body}</main>`}
${publicFooter(c)}
</body>
</html>`;
}

// --- pricing (SecureEntry - Pricing / Pricing_FA, desktop and mobile) ---------------------------------------

const PLAN_EN: Record<string, { name: string; blurb: string; features: string[] }> = {
  free: { name: "Free", blurb: "For hobbyists and small setups.", features: ["30-day Access History"] },
  starter: { name: "Starter", blurb: "Perfect for small businesses.", features: ["Attendance Logging", "CSV Report Exports", "Live Monitoring Screen"] },
  business: { name: "Business", blurb: "Scalable security for offices.", features: ["Schedule Classes/Slots", "Kiosk Display Links", "API & Webhooks"] },
  enterprise: { name: "Enterprise", blurb: "Bespoke limits and infrastructure.", features: ["Unlimited Doors & Cards", "Dedicated Support", "Manual Invoicing", "Custom SLA", "Self-hosted Option"] },
};
/** The mobile design's third feature line per plan. */
const PLAN_MOBILE: Record<string, [string, string]> = {
  starter: ["گزارش‌دهی و حضور و غیاب", "Attendance & Reporting"], free: ["تاریخچه ۳۰ روزه", "30-day History"], business: ["API و وب‌هوک", "API & Webhooks"],
};
const PRODUCT_COPY: Record<string, {
  en: string; enBlurb: string; enBadge: string; alt: [string, string]; m: [string, string, string, string]; mAlt: [string, string]; badge: string;
}> = {
  reader: {
    en: "Standard Card Reader Kit", enBlurb: "Wemos + RC522, sleek enclosure, and USB adapter. Pre-flashed.", enBadge: "Main Product",
    alt: ["کارتخوان سکور‌انتری", "SecureEntry Card Reader"], m: ["کیت کارتخوان", "Wemos + RC522", "Card Reader Kit", "Wemos + RC522"],
    mAlt: ["کارتخوان", "Reader"], badge: "bg-indigo-100 text-indigo-700",
  },
  reader_relay: {
    en: "Reader + Relay Kit", enBlurb: "Includes 5V relay for controlling electric door locks directly from the reader.", enBadge: "",
    alt: ["کیت رله", "Reader + Relay Kit"], m: ["توسعه رله", "برای قفل‌های برقی", "Relay Expansion", "For electric locks"],
    mAlt: ["رله", "Relay Expansion"], badge: "bg-indigo-100 text-indigo-700",
  },
  android_kit: {
    en: "Android Door Kit", enBlurb: "NFC Tablet + Wall Mount + Pro App. Perfect for live attendance displays.", enBadge: "Kiosk Mode",
    alt: ["کیت اندروید", "Android Door Kit"], m: ["کیت درب اندرویدی", "نمایشگر کیوسک", "Android Door Kit", "Kiosk Display"],
    mAlt: ["کیت اندروید", "Android Door Kit"], badge: "bg-green-100 text-green-700",
  },
};
const productImg = (id: string) => (PRODUCT_COPY[id] ? `/static/img/${id}.jpg` : "/static/img/reader.jpg");

const PRICING_FAQ: [string, string, string, string][] = [
  ["آیا می‌توانم از سخت‌افزار خودم استفاده کنم؟", "بله! شما می‌توانید کارتخوان‌های خود را با استفاده از Wemos D1 mini و RC522 بسازید. ما فیرم‌ور رایگان و مستندات کامل ساخت را ارائه می‌دهیم.",
    "Can I use my own hardware?", "Yes! You can build your own readers using Wemos D1 mini and RC522. We provide the firmware and full assembly documentation for free."],
  ["محدودیت «درب» چیست؟", "هر درب مربوط به یک نقطه دسترسی فیزیکی (یک کارتخوان یا یک تبلت NFC) است. طرح‌های ما تعداد درب‌های فعالی که می‌توانید همزمان مدیریت کنید را محدود می‌کنند.",
    "What is a 'Door' limit?", "A door corresponds to one physical access point (a reader or an NFC tablet). Our plans limit the number of active doors you can manage simultaneously."],
  ["آیا از تاریخ شمسی پشتیبانی می‌کنید؟", "قطعاً. سکور‌انتری کاملاً برای محیط‌های سازمانی ایران بومی‌سازی شده و از تقویم جلالی و چیدمان راست‌چین در تمامی گزارش‌ها پشتیبانی می‌کند.",
    "Do you support Jalali dates?", "Absolutely. SecureEntry is fully localized for Iranian corporate environments, supporting Persian RTL layout and Jalali calendar in all reports."],
];
const MOBILE_FAQ: [string, string, string, string][] = [
  ["سخت‌افزار شخصی؟", "بله، می‌توانید از فیرم‌ور ما روی بردهای خودتان استفاده کنید.", "Own hardware?", "Yes, use our free firmware on your own Wemos D1 builds."],
  ["تقویم شمسی؟", "بله، سیستم کاملاً از تاریخ جلالی و تقویم شمسی پشتیبانی می‌کند.", "Jalali Support?", "Fully localized with Persian calendar and RTL support."],
];

/** Desktop feature lines: limits, then the plan's own features. */
function planLines(l: Lang, p: Row): string[] {
  const out: string[] = [];
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (p.max_doors !== null) out.push(l === "en" ? `${num(l, p.max_doors)} ${plural(p.max_doors, "Door", "Doors")}` : `${num(l, p.max_doors)} درب`);
  if (p.max_admins !== null) out.push(l === "en" ? `${num(l, p.max_admins)} ${plural(p.max_admins, "Admin User", "Admin Users")}` : `${num(l, p.max_admins)} کاربر مدیر`);
  if (p.max_cards !== null) out.push(l === "en" ? `${num(l, p.max_cards)} RFID Cards` : `${num(l, p.max_cards)} کارت RFID`);
  const own = l === "en" ? PLAN_EN[p.id]?.features ?? [] : String(p.features || "").split("\n").map((x) => x.trim()).filter(Boolean);
  return out.concat(own);
}
const planName = (l: Lang, p: Row) => (l === "en" ? PLAN_EN[p.id]?.name ?? p.name : p.name);
const planBlurb = (l: Lang, p: Row) => (l === "en" ? PLAN_EN[p.id]?.blurb ?? p.blurb : p.blurb);

/** Call to action of a plan card: sign-up when logged out, checkout when logged in. */
function planCta(c: PageCtx, p: Row, cls: string, label: string) {
  if (!c.user) return html`<a href="/register?plan=${p.id}" class="${cls}">${label}</a>`;
  return html`<form method="post" action="/billing/checkout" class="contents">${csrf(c)}<input type="hidden" name="plan" value="${p.id}"><input type="hidden" name="cycle" value="month" data-cycle-input>
<button class="${cls}">${label}</button></form>`;
}

export function pricingPage(c: PageCtx, v: { plans: Row[]; products: Row[]; jsonld: unknown[] }) {
  const l = L(c), fa = l === "fa";
  const featured = (p: Row) => p.id === "starter";
  const price = (p: Row, cycle: "month" | "year") => (cycle === "year" ? p.price_year : p.price_month);
  const unitDesk = (cycle: "month" | "year") => (cycle === "year" ? t(l, "تومان / سالانه", "Toman/yr") : t(l, "تومان / ماهانه", "Toman/mo"));
  const both = (f: (cy: "month" | "year") => Safe) => html`<span data-cycle="month" class="contents">${f("month")}</span><span data-cycle="year" class="hidden">${f("year")}</span>`;

  const card = (p: Row) => {
    const dark = Boolean(p.contact), feat = featured(p);
    const ctaLabel = p.contact ? t(l, "تماس با فروش", "Contact Sales") : p.id === "free" ? t(l, "شروع رایگان", "Start Free")
      : p.trial_days ? (fa ? `شروع دوره آزمایشی ${J.fa(p.trial_days)} روزه` : `Start ${p.trial_days}-day Trial`) : t(l, "انتخاب طرح", "Choose Plan");
    const ctaCls = dark ? "w-full py-3 px-4 bg-white text-slate-900 rounded-xl font-semibold text-sm hover:bg-slate-100 transition-colors text-center"
      : feat ? "w-full py-3 px-4 bg-indigo-600 text-white rounded-xl font-semibold text-sm hover:bg-indigo-700 transition-colors shadow-sm text-center"
      : "w-full py-3 px-4 border border-indigo-600 text-indigo-600 rounded-xl font-semibold text-sm hover:bg-indigo-50 transition-colors text-center";
    const priceRow = dark
      ? html`<div class="flex items-baseline gap-1">
<span class="text-3xl font-bold">${t(l, "سفارشی", "Custom")}</span>
</div>`
      : both((cy) => html`<div class="flex items-baseline gap-1">
<span class="text-3xl font-bold">${short(l, price(p, cy))}</span>
<span class="text-slate-500 font-medium${fa ? " text-sm" : ""}">${unitDesk(cy)}</span>
</div>`);
    return html`
<div id="plan-${p.id}" class="${dark ? "pricing-card bg-slate-900 text-white rounded-2xl p-8 shadow-sm flex flex-col"
      : feat ? "pricing-card bg-white rounded-2xl p-8 border border-indigo-600 shadow-lg shadow-indigo-100 flex flex-col relative scale-105 z-10"
      : "pricing-card bg-white rounded-2xl p-8 border border-slate-200 shadow-sm flex flex-col"}">
${feat ? html`<div class="absolute -top-4 left-1/2 -translate-x-1/2 bg-indigo-600 text-white text-[10px] font-bold py-1 px-3 rounded-full uppercase tracking-widest">${t(l, "محبوب‌ترین", "Most Popular")}</div>` : ""}
<div class="mb-8">
<h3 class="text-lg font-bold${dark ? "" : " text-slate-900"} mb-2">${planName(l, p)}</h3>
${priceRow}
<p class="text-sm ${dark ? "text-slate-400" : "text-slate-500"} mt-2">${planBlurb(l, p)}</p>
</div>
<ul class="space-y-4 mb-8 flex-grow">
${planLines(l, p).map((x) => html`<li class="flex items-center gap-3 text-sm ${dark ? "text-slate-300" : "text-slate-600"}">
${fi("check", dark ? "text-indigo-400" : feat ? "text-indigo-600 font-bold" : "text-indigo-600")} ${x}
</li>`)}
</ul>
${planCta(c, p, ctaCls, ctaLabel)}
</div>`;
  };

  const shopHref = c.user ? "/store" : "/register";
  const product = (p: Row) => {
    const cp = PRODUCT_COPY[p.id];
    const badge = fa ? p.badge : cp?.enBadge ?? "";
    return html`
<div id="product-${p.id}" class="group bg-slate-50 rounded-2xl overflow-hidden border border-slate-200 transition-all hover:shadow-md">
<div class="aspect-square bg-slate-200 overflow-hidden">
<img src="${productImg(p.id)}" alt="${cp ? cp.alt[fa ? 0 : 1] : p.name}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
</div>
<div class="p-6">
<div class="flex justify-between items-start mb-2">
<h4 class="font-bold text-slate-900">${fa ? p.name : cp?.en ?? p.name}</h4>
${badge ? html`<span class="${cp?.badge ?? "bg-indigo-100 text-indigo-700"} text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">${badge}</span>` : ""}
</div>
<p class="text-sm text-slate-500 mb-4">${fa ? p.blurb : cp?.enBlurb ?? p.blurb}</p>
<div class="flex items-center justify-between">
<div>
<span class="text-lg font-bold text-slate-900">${fa ? `${num(l, p.price)} تومان` : `${short(l, p.price)} Toman`}</span>
${p.rent_month ? html`<p class="text-[10px] text-slate-400 font-medium">${fa ? `یا اجاره ${num(l, p.rent_month)} / ماهانه` : `OR RENT FOR ${short(l, p.rent_month)}/mo`}</p>` : ""}
</div>
<a href="${shopHref}" aria-label="${t(l, "سفارش", "Order")}" class="p-2 bg-white border border-slate-200 rounded-lg hover:border-indigo-600 hover:text-indigo-600 transition-all">
${fi("cart-plus")}
</a>
</div>
</div>
</div>`;
  };

  // mobile: the featured plan first, no contact-sales plan
  const mPlans = v.plans.filter((p) => !p.contact).sort((a, b) => Number(featured(b)) - Number(featured(a)) || a.sort - b.sort);
  const mCard = (p: Row) => {
    const feat = featured(p), free = p.id === "free";
    const sep = feat ? t(l, " و ", " & ") : " / ";
    const doors = l === "en" ? `${p.max_doors} ${p.max_doors === 1 ? "Door" : "Doors"}${sep}${p.max_admins} ${p.max_admins === 1 ? "Admin" : "Admins"}`
      : `${num(l, p.max_doors ?? 0)} درب${sep}${num(l, p.max_admins ?? 0)} مدیر`;
    const lines = [doors, l === "en" ? `${num(l, p.max_cards ?? 0)} RFID Cards` : `${num(l, p.max_cards ?? 0)} کارت RFID`];
    if (PLAN_MOBILE[p.id]) lines.push(PLAN_MOBILE[p.id][fa ? 0 : 1]);
    if (feat && p.trial_days) lines.push(fa ? `${J.fa(p.trial_days)} روز تست رایگان` : `${p.trial_days}-day Free Trial`);
    const unit = (cy: "month" | "year") => (free ? t(l, "تومان", "Toman") : cy === "year" ? t(l, "تومان / سال", "Toman/yr") : t(l, "تومان / ماه", "Toman/mo"));
    const cta = feat ? t(l, "شروع تست رایگان", "Start Free Trial") : free ? t(l, "شروع کنید", "Get Started") : t(l, "تماس با فروش", "Contact Sales");
    const ctaCls = feat ? "block w-full py-3 bg-indigo-600 text-white rounded-xl font-bold text-sm text-center shadow-lg shadow-indigo-200"
      : free ? "block w-full py-3 border border-slate-200 text-slate-600 rounded-xl font-bold text-sm text-center"
      : "block w-full py-3 border border-indigo-600 text-indigo-600 rounded-xl font-bold text-sm text-center";
    return html`
<div id="m-plan-${p.id}" class="${feat ? "bg-white rounded-2xl p-6 border-2 border-indigo-600 shadow-xl shadow-indigo-100 relative" : "bg-white rounded-2xl p-6 border border-slate-200 shadow-sm"}">
${feat ? html`<div class="absolute -top-3 ${fa ? "right-6" : "left-6"} bg-indigo-600 text-white text-[9px] font-bold py-1 px-3 rounded-full uppercase tracking-widest">${t(l, "محبوب‌ترین", "Most Popular")}</div>` : ""}
<h3 class="${feat ? "text-xl" : "text-lg"} font-bold text-slate-900 mb-1${fa ? " text-right" : ""}">${planName(l, p)}</h3>
${both((cy) => html`<div class="flex items-baseline gap-1 mb-4${fa ? " justify-start" : ""}">
<span class="${feat ? "text-3xl" : "text-2xl"} font-bold text-slate-900">${short(l, cy === "year" ? p.price_year : p.price_month)}</span>
<span class="text-slate-500 text-sm font-medium">${unit(cy)}</span>
</div>`)}
<ul class="space-y-3 mb-6">
${lines.map((x) => html`<li class="flex items-center gap-3 text-xs text-slate-600">
${fi("check", feat ? "text-indigo-600" : "text-indigo-500")} ${x}
</li>`)}
</ul>
${planCta(c, p, ctaCls, cta)}
</div>`;
  };
  const mProduct = (p: Row) => {
    const cp = PRODUCT_COPY[p.id];
    return html`
<div class="min-w-[240px] bg-white rounded-xl overflow-hidden border border-slate-200 shadow-sm">
<div class="aspect-square bg-slate-200 overflow-hidden">
<img src="${productImg(p.id)}" alt="${cp ? cp.mAlt[fa ? 0 : 1] : p.name}" class="w-full h-full object-cover">
</div>
<div class="p-4${fa ? " text-right" : ""}">
<h4 class="font-bold text-sm text-slate-900 mb-1">${cp ? cp.m[fa ? 0 : 2] : p.name}</h4>
<p class="text-xs text-slate-500 mb-3">${cp ? cp.m[fa ? 1 : 3] : ""}</p>
<div class="flex items-center justify-between${fa ? " flex-row-reverse" : ""}">
<span class="text-sm font-bold text-indigo-600">${shortMoney(l, p.price)}</span>
<a href="${shopHref}" aria-label="${t(l, "سفارش", "Order")}" class="bg-indigo-50 text-indigo-600 p-1.5 rounded-lg text-xs">${fi("cart-plus")}</a>
</div>
</div>
</div>`;
  };

  const body = html`
<main id="main-content" class="hidden md:block">
<section id="hero-pricing" class="py-16 md:py-24 bg-white border-b border-slate-200 overflow-hidden">
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
<h1 class="text-4xl md:text-5xl font-extrabold text-slate-900 mb-6 leading-tight">
${t(l, "کنترل دسترسی مقیاس‌پذیر برای", "Scalable Access Control for")}<br><span class="text-indigo-600">${t(l, "هر سازمان مدرن", "Every Modern Organization")}</span>
</h1>
<p class="text-lg text-slate-600 max-w-2xl mx-auto mb-10">
${t(l, "از یک درب تا سازمان‌های جهانی. حضور و غیاب، کارت‌ها و دستگاه‌ها را در یک پلتفرم ابری یکپارچه مدیریت کنید.",
    "From single doors to global enterprises. Manage attendance, cards, and devices in one unified cloud platform.")}
</p>
<div class="flex items-center justify-center gap-4 mb-12">
<span class="text-sm font-semibold text-slate-600">${t(l, "ماهانه", "Monthly")}</span>
<button id="billing-toggle" type="button" aria-label="${t(l, "ماهانه یا سالانه", "Monthly or yearly")}" class="relative w-14 h-7 bg-indigo-600 rounded-full p-1 transition-colors focus:outline-none">
<div class="translate-x-0 w-5 h-5 bg-white rounded-full transition-transform"></div>
</button>
<span class="text-sm font-semibold text-slate-900 flex items-center gap-2">
${t(l, "سالانه", "Yearly")}
<span class="bg-green-100 text-green-700 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide">${t(l, "۱۷٪ تخفیف", "Save 17%")}</span>
</span>
</div>
</div>
</section>
<section id="pricing-tiers" class="py-16 md:py-24 -mt-20">
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
${v.plans.map(card)}
</div>
</div>
</section>
<section id="hardware-shop" class="py-16 md:py-24 bg-white">
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
<div class="flex flex-col md:flex-row items-center justify-between gap-12 mb-16">
<div class="max-w-xl">
<h2 class="text-3xl font-bold text-slate-900 mb-4 tracking-tight">${t(l, "به سخت‌افزار نیاز دارید؟", "Need Hardware? We've Got You Covered.")}</h2>
<p class="text-lg text-slate-600">
${t(l, "پلتفرم ما با بردهای Wemos D1 mini ساخت خودتان یا کیت‌های آماده و تنظیم شده ما کار می‌کند. متناسب با بودجه خود خرید یا اجاره کنید.",
    "Our platform works with your own Wemos D1 mini builds or our pre-provisioned, plug-and-play kits. Rent or buy to suit your budget.")}
</p>
</div>
<div class="flex gap-4">
<a href="${shopHref}" class="px-6 py-2 bg-slate-100 text-slate-900 rounded-lg font-semibold hover:bg-slate-200 transition-colors">${t(l, "مشاهده همه محصولات", "View All Products")}</a>
</div>
</div>
<div class="grid grid-cols-1 md:grid-cols-3 gap-8">
${v.products.map(product)}
</div>
</div>
</section>
<section id="faq" class="py-16 md:py-24 bg-slate-50">
<div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8${fa ? " text-right" : ""}">
<h2 class="text-3xl font-bold text-slate-900 mb-12 text-center">${t(l, "سوالات متداول", "Frequently Asked Questions")}</h2>
<div class="space-y-4">
${PRICING_FAQ.map(([qf, af, qe, ae]) => html`<div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
<h4 class="font-bold text-slate-900 mb-2">${fa ? qf : qe}</h4>
<p class="text-sm text-slate-600 leading-relaxed">${fa ? af : ae}</p>
</div>`)}
</div>
</div>
</section>
</main>

<main id="main-content-m" class="md:hidden">
<section id="hero-pricing-m" class="py-10 bg-white border-b border-slate-100 text-center px-4">
<h1 class="text-3xl font-extrabold text-slate-900 mb-4 leading-tight">
${t(l, "امنیت دسترسی", "Secure Access")} <br><span class="text-indigo-600">${t(l, "به سادگی", "Made Simple")}</span>
</h1>
<p class="text-sm text-slate-500 mb-8 max-w-xs mx-auto">
${t(l, "پلتفرم ابری یکپارچه برای مدیریت درب، حضور و غیاب و سخت‌افزار.", "Unified cloud platform for door access, attendance, and hardware management.")}
</p>
<div class="flex items-center justify-center gap-3 mb-4 bg-slate-100 p-1 rounded-full w-fit mx-auto">
<button type="button" data-seg="month" class="px-4 py-1.5 text-xs font-bold rounded-full bg-white shadow-sm text-indigo-600">${t(l, "ماهانه", "Monthly")}</button>
<button type="button" data-seg="year" class="px-4 py-1.5 text-xs font-bold text-slate-500">${t(l, "سالانه", "Yearly")}</button>
</div>
<p class="text-[10px] text-green-600 font-bold uppercase tracking-wider">${t(l, "۱۷٪ تخفیف در پرداخت سالانه", "Save 17% with annual billing")}</p>
</section>
<section id="pricing-tiers-m" class="py-8 px-4 space-y-6">
${mPlans.map(mCard)}
</section>
<section id="device-shop" class="py-10 bg-slate-100 overflow-hidden">
<div class="px-4 mb-6${fa ? " text-right" : ""}">
<h2 class="text-xl font-bold text-slate-900">${t(l, "خرید سخت‌افزار", "Get Hardware")}</h2>
<p class="text-xs text-slate-500">${t(l, "کیت‌های آماده برای درب‌های شما.", "Pre-provisioned and ready for your doors.")}</p>
</div>
<div class="flex overflow-x-auto gap-4 px-4 pb-4 no-scrollbar">
${v.products.map(mProduct)}
</div>
</section>
<section id="faq-mini" class="py-10 px-4${fa ? " text-right" : ""}">
<h3 class="font-bold text-slate-900 mb-6 text-center">${t(l, "سوالات سریع", "Quick Questions")}</h3>
<div class="space-y-4">
${MOBILE_FAQ.map(([qf, af, qe, ae]) => html`<div class="bg-white p-4 rounded-xl border border-slate-200">
<h5 class="text-xs font-bold text-slate-900 mb-1 uppercase tracking-tight">${fa ? qf : qe}</h5>
<p class="text-xs text-slate-500 leading-relaxed">${fa ? af : ae}</p>
</div>`)}
</div>
</section>
</main>
<script>
(function () {
  // monthly / yearly: swaps the prices, the toggle knob, the phone tabs and the checkout forms' cycle
  var rtl = document.documentElement.dir === "rtl", cycle = "month";
  var knob = document.querySelector("#billing-toggle > div");
  var on = "px-4 py-1.5 text-xs font-bold rounded-full bg-white shadow-sm text-indigo-600", off = "px-4 py-1.5 text-xs font-bold text-slate-500";
  function set(cy) {
    cycle = cy;
    document.querySelectorAll("[data-cycle]").forEach(function (el) {
      el.className = el.getAttribute("data-cycle") === cy ? "contents" : "hidden";
    });
    knob.className = (cy === "year" ? (rtl ? "-translate-x-7" : "translate-x-7") : "translate-x-0") + " w-5 h-5 bg-white rounded-full transition-transform";
    document.querySelectorAll("[data-seg]").forEach(function (b) { b.className = b.getAttribute("data-seg") === cy ? on : off; });
    document.querySelectorAll("[data-cycle-input]").forEach(function (i) { i.value = cy; });
  }
  document.getElementById("billing-toggle").addEventListener("click", function () { set(cycle === "month" ? "year" : "month"); });
  document.querySelectorAll("[data-seg]").forEach(function (b) { b.addEventListener("click", function () { set(b.getAttribute("data-seg")); }); });
})();
</script>`;
  return publicShell(c, t(l, "قیمت‌گذاری | سکور‌انتری", "Pricing | SecureEntry SaaS"), body, {
    path: "/pricing", jsonld: v.jsonld,
    description: t(l, "قیمت طرح‌های سامانهٔ کنترل تردد و حضور و غیاب: رایگان، استارتر، تجاری و سازمانی، با ۱۴ روز آزمایش رایگان؛ خرید یا اجارهٔ کارتخوان RFID و کیت درب اندرویدی.",
      "SecureEntry plans: Free, Starter, Business and Enterprise with a 14-day trial; buy or rent RFID readers and Android door kits."),
  }, true);
}

// --- panel shell: sidebar and header of SecureEntry - BillingOverview (desktop), header and tab bar of its mobile version ---

type NavItem = [string, string, string, string, string];   // endpoint, href, icon, fa, en
const NAV: NavItem[] = [
  ["dashboard", "/dashboard", "chart-line", "داشبورد", "Dashboard"],
  ["doors", "/doors", "door-open", "درب‌ها", "Doors"],
  ["settings", "/settings", "users", "کاربران", "Users"],
  ["cards", "/cards", "id-card", "کارت‌ها", "Cards"],
  ["events", "/events", "clock-rotate-left", "رویدادها", "Events"],
  // pages the design's sidebar doesn't list, kept reachable
  ["live", "/", "tv", "نمایشگر زنده", "Live Screen"],
  ["classes", "/classes", "graduation-cap", "کلاس‌ها", "Classes"],
  ["attendance", "/attendance", "calendar-check", "حضور روزانه", "Daily Attendance"],
];
const NAV_SETTINGS: NavItem[] = [
  ["billing", "/billing", "credit-card", "صورت‌حساب", "Billing"],
  ["store", "/store", "shop", "فروشگاه سخت‌افزار", "Shop Hardware"],
];
const TABS: NavItem[] = [
  ["doors", "/doors", "door-open", "درب‌ها", "Doors"],
  ["settings", "/settings", "users", "کاربران", "Users"],
  ["billing", "/billing", "credit-card", "صورت‌حساب", "Billing"],
  ["store", "/store", "shop", "فروشگاه", "Shop"],
];
const ALIASES: Record<string, string> = {
  card_new: "cards", card_edit: "cards", class_view: "classes", class_session: "classes",
  invoices: "billing", invoice: "billing", billing_checkout: "billing",
};

export type ShellOpts = { heading?: string; designed?: boolean; mobileTitle?: boolean };

/** Panel pages. designed = the page body is the design's own markup (billing). */
export function panelShell(c: PageCtx, title: string, body: Safe, opts: ShellOpts = {}): Safe {
  const l = L(c), fa = l === "fa";
  const cur = ALIASES[c.endpoint] || c.endpoint;
  const showNav = Boolean(c.orgName && !c.locked);
  const navLabel = [...NAV, ...NAV_SETTINGS].find(([ep]) => ep === cur);
  const heading = opts.heading || (navLabel ? navLabel[fa ? 3 : 4] : c.orgName || t(l, "مدیریت سرور", "Server admin"));
  const item = ([ep, href, ic, f, e]: NavItem) => html`
<a href="${href}" class="${cur === ep ? "flex items-center gap-3 px-3 py-2 rounded-lg bg-indigo-600 text-white shadow-lg shadow-indigo-900/20"
    : "flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-800 hover:text-white transition-colors"}">
${fi(ic, "w-5")}
<span class="text-sm font-medium">${fa ? f : e}</span>
</a>`;
  const initial = (c.user || "?").slice(0, 1).toUpperCase();
  const pill = c.plan && showNav ? html`
<a href="/billing" class="${c.planWarn ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"} text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-2">
<span class="w-1.5 h-1.5 ${c.planWarn ? "bg-amber-500" : "bg-green-500"} rounded-full animate-pulse"></span>
${fa ? `طرح فعلی: ${c.plan}` : `PLAN: ${(c.planEn || c.plan).toUpperCase()}`}
</a>` : "";
  const logout = html`<form method="post" action="/logout" class="contents">${csrf(c)}<button class="text-slate-500 hover:text-white" title="${t(l, "خروج", "Log out")}" aria-label="${t(l, "خروج", "Log out")}">${fi("arrow-right-from-bracket")}</button></form>`;
  return html`<!DOCTYPE html>
<html lang="${l}" dir="${fa ? "rtl" : "ltr"}" class="se">
${head(c, title, Boolean(opts.designed))}
<body class="bg-slate-50 text-slate-900">
<div class="md:flex md:h-screen md:overflow-hidden">
<aside id="sidebar" class="twr hidden md:flex w-64 bg-slate-900 text-slate-400 flex-col shrink-0">
<a href="${showNav ? "/dashboard" : "/admin"}" class="p-6 flex items-center gap-3 text-white">
<div class="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center">
${fi("shield-halved")}
</div>
<span class="font-bold text-lg tracking-tight">SecureEntry</span>
</a>
<nav class="flex-grow px-4 space-y-1 overflow-y-auto">
${showNav ? NAV.map(item) : ""}
${showNav ? html`<div class="pt-4 pb-2 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">${t(l, "تنظیمات", "Settings")}</div>
${NAV_SETTINGS.map(item)}` : ""}
${c.owner ? html`<div class="pt-4 pb-2 px-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">${t(l, "سرور", "Server")}</div>
${item(["admin", "/admin", "user-shield", "مدیریت سرور" + (c.pending ? ` (${J.fa(c.pending)})` : ""), "Server admin" + (c.pending ? ` (${c.pending})` : "")])}` : ""}
</nav>
<div class="p-4 border-t border-slate-800">
<div class="flex items-center gap-3 px-3 py-2">
<div class="w-8 h-8 rounded-full bg-slate-700 text-white flex items-center justify-center text-sm font-bold shrink-0">${initial}</div>
<div class="flex-grow min-w-0${fa ? " text-right" : ""}">
<p class="text-sm font-semibold text-white truncate" dir="auto">${c.user}</p>
<p class="text-[10px] text-slate-500 truncate">${c.orgName || t(l, "مدیر سرور", "Server owner")}</p>
</div>
${logout}
</div>
</div>
</aside>
<main class="flex-grow md:overflow-y-auto pb-20 md:pb-0">
${opts.designed ? "" : html`<header class="twr hidden md:flex bg-white border-b border-slate-200 h-16 items-center justify-between px-8 sticky top-0 z-10">
<h1 class="text-lg font-bold text-slate-900">${heading}</h1>
<div class="flex items-center gap-4">
${pill}
<a href="/events" class="text-slate-400 hover:text-slate-600" aria-label="${t(l, "رویدادها", "Events")}">${fi("bell")}</a>
<a href="/#faq" class="text-slate-400 hover:text-slate-600" aria-label="${t(l, "راهنما", "Help")}">${fi("circle-question")}</a>
</div>
</header>`}
<header id="header" class="twr md:hidden bg-white border-b border-slate-200 h-14 flex items-center justify-between px-4 sticky top-0 z-50">
<a href="${showNav ? "/dashboard" : "/admin"}" class="flex items-center gap-2">
<div class="w-6 h-6 bg-indigo-600 rounded flex items-center justify-center text-white text-[10px]">
${fi("shield-halved")}
</div>
<span class="font-bold text-slate-900">SecureEntry</span>
</a>
<div class="flex items-center gap-4">
<a href="/events" class="text-slate-400" aria-label="${t(l, "رویدادها", "Events")}">${fi("bell")}</a>
<button class="w-7 h-7 rounded-full bg-slate-700 text-white flex items-center justify-center text-xs font-bold" aria-label="${t(l, "منو", "Menu")}"
  onclick="document.getElementById('pmenu').classList.toggle('hidden')">${initial}</button>
</div>
</header>
<div id="pmenu" class="twr hidden md:hidden fixed inset-x-0 top-14 z-40 bg-white border-b border-slate-200 shadow-lg px-4 py-3 text-sm font-medium text-slate-700">
${showNav ? [...NAV, ...NAV_SETTINGS].map(([ep, href, ic, f, e]) => html`<a href="${href}" class="flex items-center gap-3 py-2 ${cur === ep ? "text-indigo-600" : ""}">${fi(ic, "w-5 text-slate-400")}<span>${fa ? f : e}</span></a>`) : ""}
${c.owner ? html`<a href="/admin" class="flex items-center gap-3 py-2">${fi("user-shield", "w-5 text-slate-400")}<span>${t(l, "مدیریت سرور", "Server admin")}</span></a>` : ""}
<div class="flex items-center justify-between border-t border-slate-100 mt-2 pt-3 text-xs text-slate-500">
<span dir="auto">${c.user}</span>
<form method="post" action="/logout" class="contents">${csrf(c)}<button class="font-bold text-red-600">${t(l, "خروج", "Log out")}</button></form>
</div>
</div>
${opts.designed ? body : html`<div class="p-4 md:p-8">
${c.flashes.length ? html`<div class="space-y-2 mb-4">${flashes(c)}</div>` : ""}
${opts.mobileTitle === false ? "" : html`<h1 class="md:hidden text-lg font-bold mb-4">${heading}</h1>`}
${body}
</div>`}
</main>
${showNav ? html`<nav class="twr md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 h-16 px-6 flex items-center justify-between z-50${fa ? " flex-row-reverse" : ""}">
${TABS.map(([ep, href, ic, f, e]) => html`<a href="${href}" class="flex flex-col items-center gap-1 ${cur === ep ? "text-indigo-600" : "text-slate-400"}">
${fi(ic, "text-lg")}
<span class="text-[9px] font-bold">${fa ? f : e}</span>
</a>`)}
</nav>` : ""}
</div>
</body>
</html>`;
}

// --- billing overview (SecureEntry - BillingOverview / BillingOverview_FA, desktop and mobile) ---------------

export type BillingView = {
  org: Row; plan: Row | null; state: string; usage: { doors: number; admins: number; cards: number };
  invoices: Row[]; next: Quote | null; nextPlan: Row | null; payments: boolean; vat: number; daysLeft: number;
};

export function billingPage(c: PageCtx, v: BillingView) {
  const l = L(c), fa = l === "fa";
  const o = v.org, st = v.state;
  const pName = v.plan ? planName(l, v.plan) : t(l, "سفارشی", "Custom");
  const cycleTag = st === "trialing" ? t(l, "دوره آزمایشی", "Trial") : st === "free" ? t(l, "رایگان", "Free")
    : st === "legacy" ? t(l, "سفارشی", "Custom") : o.cycle === "year" ? t(l, "پرداخت سالانه", "Yearly Billing") : t(l, "پرداخت ماهانه", "Monthly Billing");
  const limit = (k: string, legacy: number | null) => (v.plan ? v.plan[k] : legacy);
  const usage: [string, string, number, number | null][] = [
    ["درب‌ها", "Doors", v.usage.doors, limit("max_doors", o.max_devices)],
    ["مدیران", "Admins", v.usage.admins, limit("max_admins", o.max_users)],
    ["کارت‌های فعال", "Active Cards", v.usage.cards, limit("max_cards", o.max_cards)],
  ];
  const pct = (u: number, m: number | null) => (m ? Math.min(100, Math.round((u / m) * 100)) : 0);
  const of = (u: number, m: number | null) => `${num(l, u)} / ${m === null ? "∞" : num(l, m)}`;

  // "Update billing info" = pay or renew the next period (Zarinpal keeps no saved card); otherwise choose a plan
  const payForm = (cls: string, label: string) => v.next && v.nextPlan
    ? html`<form method="post" action="/billing/checkout" class="contents">${csrf(c)}<input type="hidden" name="plan" value="${v.nextPlan.id}"><input type="hidden" name="cycle" value="${o.cycle || "month"}">
<button class="${cls}">${label}</button></form>`
    : html`<a href="/pricing" class="${cls} block text-center">${label}</a>`;

  // banners: the design's trial banner; the other states reuse its layout
  type Banner = { bg: string; ic: string; title: string; text: string; mTitle: string; mText: string; btn: string; mBtn: string; action: "plans" | "pay" | "resume" };
  const banner: Banner | null =
    st === "trialing" ? {
      bg: "bg-indigo-600 shadow-indigo-100", ic: "rocket",
      title: fa ? `${J.fa(v.daysLeft)} روز تا پایان دوره آزمایشی باقی مانده` : `Trial Period Ends in ${v.daysLeft} Days`,
      text: fa ? `دوره آزمایشی شما در تاریخ ${jday(o.paid_until)} پایان می‌یابد. برای جلوگیری از قطع سرویس، طرح خود را ارتقا دهید.`
        : `Your ${pName.toLowerCase()} plan trial will end on ${enDate(o.paid_until)}. Upgrade now to avoid interruption.`,
      mTitle: fa ? `${J.fa(v.daysLeft)} روز تا پایان آزمایشی` : `Trial Ends in ${v.daysLeft} Days`,
      mText: fa ? `برای فعال ماندن داده‌های خود، قبل از ${jdayShort(o.paid_until)} ارتقا دهید.` : `Upgrade to keep your data active after ${enDate(o.paid_until, false)}.`,
      btn: t(l, "انتخاب طرح", "Choose Plan"), mBtn: t(l, "ارتقای طرح", "Upgrade Plan"), action: "plans",
    }
    : st === "past_due" ? {
      bg: "bg-amber-500 shadow-amber-100", ic: "bell",
      title: t(l, "پرداخت اشتراک سررسید گذشته است", "Your Payment Is Overdue"),
      text: fa ? `دورهٔ شما ${jday(o.paid_until)} تمام شد. درها تا ۳ روز پس از آن کار می‌کنند؛ برای جلوگیری از قطع سرویس، تمدید کنید.`
        : `Your period ended on ${enDate(o.paid_until)}. Doors keep working for 3 days; renew now to avoid interruption.`,
      mTitle: t(l, "پرداخت سررسید گذشته", "Payment Overdue"), mText: t(l, "برای جلوگیری از قطع سرویس، تمدید کنید.", "Renew now to avoid interruption."),
      btn: t(l, "تمدید و پرداخت", "Renew Now"), mBtn: t(l, "تمدید و پرداخت", "Renew Now"), action: "pay",
    }
    : st === "suspended" ? {
      bg: "bg-red-600 shadow-red-100", ic: "credit-card",
      title: t(l, "اشتراک تعلیق شده است", "Subscription Suspended"),
      text: t(l, "کارت‌ها روی درها پذیرفته نمی‌شوند و نمایشگرها پیام تعلیق نشان می‌دهند. با تمدید، همه چیز بلافاصله فعال می‌شود.",
        "Doors don't accept cards and kiosk screens show the suspended notice. Renewing turns everything back on at once."),
      mTitle: t(l, "اشتراک تعلیق شده است", "Subscription Suspended"), mText: t(l, "با تمدید، درها بلافاصله فعال می‌شوند.", "Renew to turn the doors back on."),
      btn: t(l, "تمدید و فعال‌سازی", "Renew Now"), mBtn: t(l, "تمدید و فعال‌سازی", "Renew Now"), action: "pay",
    }
    : st === "canceling" ? {
      bg: "bg-slate-700 shadow-slate-200", ic: "calendar-check",
      title: t(l, "اشتراک لغو شده است", "Subscription Cancelled"),
      text: fa ? `تا ${jday(o.paid_until)} همهٔ امکانات فعال است و پس از آن به طرح رایگان می‌روید.` : `Everything stays on until ${enDate(o.paid_until)}; after that you move to the Free plan.`,
      mTitle: t(l, "اشتراک لغو شده است", "Subscription Cancelled"),
      mText: fa ? `تا ${jdayShort(o.paid_until)} فعال است.` : `Active until ${enDate(o.paid_until, false)}.`,
      btn: t(l, "ادامهٔ اشتراک", "Keep Subscription"), mBtn: t(l, "ادامهٔ اشتراک", "Keep Subscription"), action: "resume",
    }
    : null;
  const bannerBtn = (b: Banner, cls: string, label: string) =>
    b.action === "plans" ? html`<a href="/pricing" class="${cls}">${label}</a>`
      : b.action === "resume" ? html`<form method="post" action="/billing/resume" class="contents">${csrf(c)}<button class="${cls}">${label}</button></form>`
      : payForm(cls, label);

  const invStatus = (s: string, mobile: boolean) => {
    const [cls, f, e] = s === "paid" ? [mobile ? "bg-green-50 text-green-600" : "bg-green-100 text-green-700", "پرداخت شده", "Paid"]
      : s === "pending" ? [mobile ? "bg-amber-50 text-amber-600" : "bg-amber-100 text-amber-700", "در انتظار پرداخت", "Pending"]
      : [mobile ? "bg-red-50 text-red-600" : "bg-red-100 text-red-700", "ناموفق", "Failed"];
    return mobile ? html`<span class="${cls} text-[9px] px-2 py-0.5 rounded font-bold uppercase">${fa ? f : e}</span>`
      : html`<span class="${cls} text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wide">${fa ? f : e}</span>`;
  };
  const money = (n: number) => (fa ? `${num(l, n)} تومان` : `${num(l, n)} Toman`);
  const dueText = v.next ? (fa ? `سررسید: ${jday(o.paid_until)}` : `Due on ${enDate(o.paid_until)}`)
    : st === "free" ? t(l, "طرح رایگان هزینه‌ای ندارد.", "The Free plan costs nothing.")
    : st === "canceling" ? t(l, "پس از پایان دوره پرداختی ندارید.", "No payment after this period.")
    : t(l, "صورت‌حساب به‌صورت دستی صادر می‌شود.", "Invoiced manually.");

  const desktop = html`
<header class="bg-white border-b border-slate-200 h-16 flex items-center justify-between px-8 sticky top-0 z-10">
<h1 class="text-lg font-bold text-slate-900">${t(l, "بررسی صورت‌حساب", "Billing Overview")}</h1>
<div class="flex items-center gap-4">
${v.plan ? html`<div class="${c.planWarn ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"} text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-2">
<span class="w-1.5 h-1.5 ${c.planWarn ? "bg-amber-500" : "bg-green-500"} rounded-full animate-pulse"></span>
${fa ? `طرح فعلی: ${pName}` : `PLAN: ${pName.toUpperCase()}`}
</div>` : ""}
<a href="/events" class="text-slate-400 hover:text-slate-600" aria-label="${t(l, "رویدادها", "Events")}">${fi("bell")}</a>
<a href="/#faq" class="text-slate-400 hover:text-slate-600" aria-label="${t(l, "راهنما", "Help")}">${fi("circle-question")}</a>
</div>
</header>
<div class="p-8">
${c.flashes.length || !v.payments ? html`<div class="space-y-2 mb-6">${flashes(c)}${!v.payments ? html`<div class="rounded-xl border px-4 py-3 text-sm font-medium bg-amber-50 text-amber-700 border-amber-200">${t(l, "پرداخت آنلاین هنوز فعال نشده است؛ برای تمدید یا خرید با پشتیبانی تماس بگیرید.", "Online payment isn't enabled yet; contact support to renew or buy.")}</div>` : ""}</div>` : ""}
${banner ? html`<div class="${banner.bg} rounded-2xl p-6 mb-8 text-white flex items-center justify-between shadow-lg">
<div class="flex items-center gap-4">
<div class="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center text-2xl">
${fi(banner.ic)}
</div>
<div>
<h4 class="font-bold text-lg">${banner.title}</h4>
<p class="text-indigo-100 text-sm">${banner.text}</p>
</div>
</div>
${bannerBtn(banner, "bg-white text-indigo-600 px-6 py-2 rounded-lg font-bold text-sm hover:bg-indigo-50 transition-colors", banner.btn)}
</div>` : ""}
<div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
<div class="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-6">
<div class="flex justify-between items-start mb-6">
<div>
<h3 class="text-slate-500 text-xs font-bold uppercase tracking-widest mb-1">${t(l, "اشتراک فعلی", "Current Subscription")}</h3>
<div class="flex items-center gap-3">
<span class="text-2xl font-bold text-slate-900">${fa ? `طرح ${pName}` : `${pName} Plan`}</span>
<span class="bg-slate-100 text-slate-600 text-[10px] px-2 py-0.5 rounded font-bold uppercase">${cycleTag}</span>
</div>
</div>
<a href="/pricing" class="text-indigo-600 font-bold text-sm hover:underline">${t(l, "تغییر طرح", "Change Plan")}</a>
</div>
<div class="grid grid-cols-1 md:grid-cols-3 gap-8">
${usage.map(([f, e, u, m]) => html`<div>
<div class="flex justify-between items-end mb-2">
<span class="text-[10px] font-bold text-slate-400 uppercase tracking-tight">${fa ? f : e}</span>
<span class="text-xs font-bold text-slate-900${fa ? " text-left" : ""}">${of(u, m)}</span>
</div>
<div class="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
<div class="bg-indigo-600 h-full rounded-full shadow-inner" style="width: ${pct(u, m)}%"></div>
</div>
</div>`)}
</div>
</div>
<div class="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between">
<div>
<h3 class="text-slate-500 text-xs font-bold uppercase tracking-widest mb-1">${t(l, "پرداخت بعدی", "Next Payment")}</h3>
<p class="text-2xl font-bold text-slate-900">${v.next ? money(v.next.total) : "—"}</p>
<p class="text-slate-500 text-xs mt-1">${dueText}</p>
</div>
<div class="pt-6 border-t border-slate-100">
<div class="flex items-center gap-3 text-sm text-slate-600 mb-4">
${fi("receipt", "text-slate-400")}
<span>${fa ? `شامل ${J.fa(v.vat)}٪ مالیات بر ارزش افزوده` : `Includes VAT (${v.vat}%)`}</span>
</div>
${payForm("w-full py-2 border border-slate-200 rounded-lg text-sm font-bold hover:bg-slate-50 transition-colors", t(l, "ویرایش اطلاعات پرداخت", "Update Billing Info"))}
</div>
</div>
</div>
<div class="bg-white border border-slate-200 rounded-2xl overflow-hidden">
<div class="p-6 border-b border-slate-100 flex justify-between items-center">
<h3 class="font-bold text-slate-900">${t(l, "فاکتورهای اخیر", "Recent Invoices")}</h3>
<a href="/billing/invoices" class="text-xs font-bold text-indigo-600 hover:underline">${t(l, "مشاهده همه", "View All")}</a>
</div>
<table class="w-full ${fa ? "text-right" : "text-left"}">
<thead>
<tr class="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-50 border-b border-slate-100">
<th class="px-6 py-3">${t(l, "شماره فاکتور", "Invoice Number")}</th>
<th class="px-6 py-3">${t(l, "تاریخ", "Date")}</th>
<th class="px-6 py-3">${t(l, "مبلغ", "Amount")}</th>
<th class="px-6 py-3">${t(l, "وضعیت", "Status")}</th>
<th class="px-6 py-3 ${fa ? "text-left" : "text-right"}">${t(l, "عملیات", "Action")}</th>
</tr>
</thead>
<tbody class="text-sm text-slate-600 divide-y divide-slate-100">
${v.invoices.length ? v.invoices.map((i) => html`<tr>
<td class="px-6 py-4 font-medium text-slate-900">${i.number}</td>
<td class="px-6 py-4">${longDate(l, i.paid_at || i.created_at)}</td>
<td class="px-6 py-4">${money(i.total)}</td>
<td class="px-6 py-4">
${invStatus(i.status, false)}
</td>
<td class="px-6 py-4 ${fa ? "text-left" : "text-right"}">
<a href="/billing/invoices/${i.id}" class="text-indigo-600 hover:text-indigo-800" aria-label="${t(l, "دریافت فاکتور", "Download invoice")}">${fi("download")}</a>
</td>
</tr>`) : html`<tr><td colspan="5" class="px-6 py-4 text-slate-400">${t(l, "هنوز فاکتوری صادر نشده است.", "No invoices yet.")}</td></tr>`}
</tbody>
</table>
</div>
<div class="mt-8 bg-slate-100 rounded-2xl p-6 border border-slate-200 flex items-center gap-6${fa ? " text-right" : ""}">
<div class="w-16 h-16 bg-white rounded-xl flex items-center justify-center text-3xl text-slate-400">
${fi("microchip")}
</div>
<div class="flex-grow">
<h4 class="font-bold text-slate-900 mb-1">${t(l, "تعداد درب‌ها کافی نیست؟", "Running out of doors?")}</h4>
<p class="text-sm text-slate-500">${t(l, "کارتخوان‌های تنظیم شده و کیت‌های رله را از فروشگاه ما سفارش دهید. ارسال سریع به دفتر شما.",
    "Order pre-provisioned card readers and relay kits from our hardware shop. Fast shipping to your office.")}</p>
</div>
<a href="/store" class="px-6 py-2 bg-slate-900 text-white rounded-lg font-bold text-sm hover:bg-slate-800 transition-colors${fa ? " shrink-0" : ""}">${t(l, "بازدید از فروشگاه", "Visit Shop")}</a>
</div>
</div>`;

  const rev = fa ? " flex-row-reverse" : "";
  const mobile = html`
<div class="p-4 space-y-6">
${c.flashes.length ? html`<div class="space-y-2">${flashes(c)}</div>` : ""}
<div class="flex items-center justify-between">
<h1 class="text-lg font-bold${fa ? " text-right" : ""}">${t(l, "بررسی صورت‌حساب", "Billing Overview")}</h1>
${v.plan ? html`<div class="${c.planWarn ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"} text-[10px] font-bold px-3 py-1 rounded-full flex items-center gap-2">
<span class="w-1.5 h-1.5 ${c.planWarn ? "bg-amber-500" : "bg-green-500"} rounded-full"></span>
${fa ? pName : pName.toUpperCase()}
</div>` : ""}
</div>
${banner ? html`<div class="${banner.bg} rounded-xl p-5 text-white shadow-lg${fa ? " text-right" : ""}">
<div class="flex gap-4 mb-4${rev}">
<div class="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center text-xl shrink-0">
${fi(banner.ic)}
</div>
<div${fa ? raw(` class="flex-grow"`) : ""}>
<h4 class="font-bold text-sm">${banner.mTitle}</h4>
<p class="text-indigo-100 text-[11px] mt-1">${banner.mText}</p>
</div>
</div>
${bannerBtn(banner, "w-full bg-white text-indigo-600 py-2.5 rounded-lg font-bold text-xs block text-center", banner.mBtn)}
</div>` : ""}
<div class="bg-white border border-slate-200 rounded-xl p-5 space-y-5 shadow-sm${fa ? " text-right" : ""}">
<div class="flex justify-between items-center pb-3 border-b border-slate-100${rev}">
<h3 class="text-xs font-bold text-slate-500 uppercase tracking-widest">${t(l, "وضعیت مصرف", "Plan Usage")}</h3>
<a href="/pricing" class="text-indigo-600 font-bold text-[11px]">${t(l, "تغییر طرح", "Change Plan")}</a>
</div>
${usage.map(([f, e, u, m]) => html`<div>
<div class="flex justify-between items-end mb-2${rev}">
<span class="text-[10px] font-bold text-slate-400 uppercase tracking-tight">${fa ? f : e}</span>
<span class="text-xs font-bold text-slate-900${fa ? " text-left" : ""}">${of(u, m)}</span>
</div>
<div class="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
<div class="bg-indigo-600 h-full rounded-full" style="width: ${pct(u, m)}%"></div>
</div>
</div>`)}
</div>
<div class="bg-slate-900 rounded-xl p-5 text-white shadow-lg${fa ? " text-right" : ""}">
<div class="flex justify-between items-start mb-6${rev}">
<div>
<h3 class="text-slate-400 text-[10px] font-bold uppercase tracking-widest mb-1">${t(l, "پرداخت بعدی", "Next Payment")}</h3>
<p class="text-xl font-bold">${v.next ? (fa ? `${num(l, v.next.total)} تومان` : `${short(l, v.next.total)} Toman`) : "—"}</p>
<p class="text-slate-500 text-[10px] mt-1">${v.next ? (fa ? `سررسید: ${jday(o.paid_until)}` : `Due ${enDate(o.paid_until)}`) : dueText}</p>
</div>
<div class="bg-white/10 p-2 rounded-lg text-lg">
${fi("credit-card")}
</div>
</div>
${payForm("w-full py-2.5 border border-slate-700 rounded-lg text-xs font-bold hover:bg-slate-800 transition-colors", t(l, "بروزرسانی پرداخت", "Update Billing"))}
</div>
<div class="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm${fa ? " text-right" : ""}">
<div class="p-4 border-b border-slate-100 flex justify-between items-center${rev}">
<h3 class="font-bold text-sm">${t(l, "فاکتورهای اخیر", "Recent Invoices")}</h3>
<a href="/billing/invoices" class="text-[11px] font-bold text-indigo-600 uppercase">${t(l, "همه", "View All")}</a>
</div>
<div class="divide-y divide-slate-100">
${v.invoices.length ? v.invoices.map((i) => html`<a href="/billing/invoices/${i.id}" class="p-4 flex items-center justify-between${rev}">
<div>
<p class="text-xs font-bold text-slate-900">${i.number}</p>
<p class="text-[10px] text-slate-400">${shortDate(l, i.paid_at || i.created_at)} • ${fa ? `${num(l, i.total)} تومان` : `${short(l, i.total)} Toman`}</p>
</div>
<div class="flex items-center gap-3">
${invStatus(i.status, true)}
<span class="text-slate-300">${fi(fa ? "chevron-left" : "chevron-right")}</span>
</div>
</a>`) : html`<p class="p-4 text-xs text-slate-400">${t(l, "هنوز فاکتوری صادر نشده است.", "No invoices yet.")}</p>`}
</div>
</div>
</div>`;

  return panelShell(c, t(l, "بررسی صورت‌حساب | پنل سکور‌انتری", "Billing Overview | SecureEntry Panel"),
    html`<div class="hidden md:block">${desktop}</div><div class="md:hidden">${mobile}</div>`, { designed: true });
}

export { icon };
