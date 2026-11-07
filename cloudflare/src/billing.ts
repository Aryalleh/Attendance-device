// Billing: plans, subscription state and the Zarinpal payment gateway (v4 REST API).
// Amounts are kept in toman; Zarinpal is called in rials (toman × 10, its default currency).
import { all, first, Row } from "./db";
import * as J from "./jalali";
import { localDate, now } from "./time";

export const DAY = 86400;
export const GRACE_DAYS = 3;   // doors keep working this long after a period ends unpaid

/** SQL: the company's doors accept cards (enabled, and not past its paid period + grace). `a` = orgs alias. */
export const orgLiveSql = (a: string) =>
  `(${a}.enabled = 1 AND (${a}.paid_until IS NULL OR ${a}.cancel_at_end = 1 OR ${a}.paid_until > CAST(strftime('%s','now') AS INTEGER) - ${GRACE_DAYS * DAY}))`;

export type BillingEnv = { ZARINPAL_MERCHANT?: string; ZARINPAL_SANDBOX?: string; VAT_PERCENT?: string };

export const vatPercent = (env: BillingEnv) => {
  const n = Number(env.VAT_PERCENT ?? "10");
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 10;
};
export const paymentsEnabled = (env: BillingEnv) => Boolean(env.ZARINPAL_MERCHANT);

/** "۴۵۰,۰۰۰" */
export const money = (n: number | null | undefined) => J.fa(Math.round(n || 0).toLocaleString("en-US"));

export type SubState = "legacy" | "free" | "trialing" | "active" | "past_due" | "suspended" | "canceling";

/** What the subscription looks like right now (computed, so no cron is needed). */
export function subState(org: Row, t = now()): SubState {
  if (!org.plan) return "legacy";
  if (org.sub_status === "free" || org.plan === "free") return "free";
  if (org.paid_until === null || org.paid_until === undefined) return "active";   // manual (enterprise) billing
  if (org.cancel_at_end) return "canceling";
  if (t <= org.paid_until) return org.sub_status === "trialing" ? "trialing" : "active";
  return t <= org.paid_until + GRACE_DAYS * DAY ? "past_due" : "suspended";
}

export const daysLeft = (org: Row, t = now()) => Math.max(0, Math.ceil(((org.paid_until || 0) - t) / DAY));

export async function plans(db: D1Database): Promise<Row[]> {
  return all(db, "SELECT * FROM plans ORDER BY sort");
}
export async function products(db: D1Database, includeInactive = false): Promise<Row[]> {
  return all(db, `SELECT * FROM products ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort`);
}

export type Usage = { doors: number; admins: number; cards: number };
export async function usage(db: D1Database, orgId: number): Promise<Usage> {
  const r = await first(db, `SELECT
    (SELECT COUNT(*) FROM devices WHERE org_id = ?1) AS doors,
    (SELECT COUNT(*) FROM users WHERE org_id = ?1) AS admins,
    (SELECT COUNT(*) FROM cards WHERE org_id = ?1 AND enabled = 1) AS cards`, orgId);
  return { doors: r?.doors || 0, admins: r?.admins || 0, cards: r?.cards || 0 };
}

/** Why the company can't move to this plan right now, or "" if it fits. */
export function fitError(plan: Row, u: Usage): string {
  const over: string[] = [];
  if (plan.max_doors !== null && u.doors > plan.max_doors) over.push(`${J.fa(u.doors)} در (سقف ${J.fa(plan.max_doors)})`);
  if (plan.max_admins !== null && u.admins > plan.max_admins) over.push(`${J.fa(u.admins)} مدیر (سقف ${J.fa(plan.max_admins)})`);
  if (plan.max_cards !== null && u.cards > plan.max_cards) over.push(`${J.fa(u.cards)} کارت فعال (سقف ${J.fa(plan.max_cards)})`);
  return over.length ? `برای طرح «${plan.name}» ابتدا مصرف را کم کنید: ${over.join("، ")}.` : "";
}

/** UPDATE that puts a company on a plan (limits follow the plan). */
export function applyPlanStmt(db: D1Database, orgId: number, plan: Row, f: {
  status: "trialing" | "active" | "free"; paidUntil: number | null; cycle?: string;
}) {
  return db.prepare(`UPDATE orgs SET plan = ?, sub_status = ?, paid_until = ?, cycle = COALESCE(?, cycle), cancel_at_end = 0, next_plan = NULL,
      max_devices = ?, max_users = ?, max_cards = ? WHERE id = ?`)
    .bind(plan.id, f.status, f.paidUntil, f.cycle ?? null, plan.max_doors, plan.max_admins, plan.max_cards, orgId);
}

/** Plan a company starts on when a server owner approves its sign-up. */
export function startPlanStmt(db: D1Database, orgId: number, plan: Row) {
  if (plan.id === "free") return applyPlanStmt(db, orgId, plan, { status: "free", paidUntil: null });
  if (plan.trial_days > 0) return applyPlanStmt(db, orgId, plan, { status: "trialing", paidUntil: now() + plan.trial_days * DAY });
  return applyPlanStmt(db, orgId, plan, { status: "active", paidUntil: null });   // contact-sales plans: billed by hand
}

export const months = (cycle: string) => (cycle === "year" ? 12 : 1);
export const planPrice = (plan: Row, cycle: string) => (cycle === "year" ? plan.price_year : plan.price_month);
export const perMonth = (plan: Row, cycle: string) => planPrice(plan, cycle) / months(cycle);

export async function rentalsMonthly(db: D1Database, orgId: number): Promise<number> {
  const r = await first(db, "SELECT COALESCE(SUM(monthly * qty), 0) AS m FROM rentals WHERE org_id = ? AND ended_at IS NULL", orgId);
  return r?.m || 0;
}

/** Add `n` calendar months to a timestamp (day of month clamped, time of day kept). */
export function addMonths(ts: number, n: number): number {
  const d = new Date(ts * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return Math.floor(d.getTime() / 1000);
}

export type Quote = {
  kind: "renew" | "upgrade" | "start" | "downgrade";
  amount: number; credit: number; rentals: number; vat: number; total: number;
  periodStart: number; periodEnd: number;
};

/**
 * Price of moving `org` to `plan` for `cycle`, starting from its current state.
 * - same plan and cycle while paid: renewal, the new period starts when the current one ends
 * - more per month than now while paid: upgrade now, unused days of the last payment are credited
 * - less per month while paid: a downgrade, which waits for the renewal (no payment now)
 * - trial: the new period starts when the trial ends, so trial days aren't lost
 */
export async function quote(db: D1Database, env: BillingEnv, org: Row, plan: Row, cycle: string, t = now()): Promise<Quote> {
  const state = subState(org, t);
  const cur = org.plan ? await first(db, "SELECT * FROM plans WHERE id = ?", org.plan) : null;
  const paid = (state === "active" || state === "canceling") && org.paid_until && cur && cur.id !== "free";
  let kind: Quote["kind"] = "start", start = t, credit = 0;
  if (state === "trialing") start = Math.max(t, org.paid_until);
  if (paid) {
    if (cur!.id === plan.id && (org.cycle || "month") === cycle) {
      kind = "renew"; start = org.paid_until;
    } else if (perMonth(plan, cycle) > perMonth(cur!, org.cycle || "month") || (cur!.id === plan.id && cycle === "year")) {
      kind = "upgrade";
      const last = await first(db, `SELECT * FROM invoices WHERE org_id = ? AND kind = 'plan' AND status = 'paid' AND period_end = ?
        ORDER BY paid_at DESC LIMIT 1`, org.id, org.paid_until);
      if (last && last.period_end > t) {
        // unused share of what was paid (before VAT) for the current period
        const span = Math.max(1, last.period_end - addMonths(last.period_end, -months(last.cycle || "month")));
        credit = Math.floor(((last.amount + last.credit) * Math.min(span, last.period_end - t)) / span);
      }
    } else {
      kind = "downgrade"; start = org.paid_until;
    }
  }
  const m = months(cycle);
  const rentals = (await rentalsMonthly(db, org.id)) * m;
  const gross = planPrice(plan, cycle) + rentals;
  credit = Math.min(credit, gross);
  const amount = gross - credit;
  const vat = Math.round((amount * vatPercent(env)) / 100);
  return { kind, amount, credit, rentals, vat, total: amount + vat, periodStart: start, periodEnd: addMonths(start, m) };
}

/** Next invoice number, INV-<jalali year>-<4 digits>. */
export async function invoiceNumber(db: D1Database, t = now()): Promise<string> {
  const jy = J.toJalali(localDate(t))[0];
  const r = await first(db, "SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?", `INV-${jy}-%`);
  return `INV-${jy}-${String((r?.n || 0) + 1).padStart(4, "0")}`;
}

// --- Zarinpal ---------------------------------------------------------------------

const zpHost = (env: BillingEnv) => (env.ZARINPAL_SANDBOX === "1" ? "sandbox.zarinpal.com" : "payment.zarinpal.com");
export const startPayUrl = (env: BillingEnv, authority: string) => `https://${zpHost(env)}/pg/StartPay/${encodeURIComponent(authority)}`;

const ZP_ERRORS: Record<string, string> = {
  "-9": "اطلاعات ارسالی به درگاه نامعتبر است.", "-10": "شناسه پذیرنده نامعتبر است.", "-11": "درگاه پرداخت فعال نیست.",
  "-12": "تلاش بیش از حد؛ کمی بعد دوباره امتحان کنید.", "-50": "مبلغ پرداخت‌شده با فاکتور یکسان نیست.",
  "-51": "پرداخت ناموفق بود.", "-54": "شناسه پرداخت نامعتبر است.",
};
const zpError = (j: any) => {
  const code = String(j?.errors?.code ?? j?.data?.code ?? "");
  return ZP_ERRORS[code] || `خطای درگاه پرداخت${code ? ` (${J.fa(code)})` : ""}.`;
};

async function zpPost(env: BillingEnv, path: string, body: unknown): Promise<any> {
  const r = await fetch(`https://${zpHost(env)}/pg/v4/payment/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

/** Start a payment; returns the authority to redirect to, or throws a Persian message. */
export async function zpRequest(env: BillingEnv, p: { toman: number; description: string; callback: string; email?: string; mobile?: string; orderId: string }) {
  const metadata: Record<string, string> = { order_id: p.orderId };
  if (p.email) metadata.email = p.email;
  if (p.mobile && /^09\d{9}$/.test(p.mobile)) metadata.mobile = p.mobile;
  const j = await zpPost(env, "request.json", {
    merchant_id: env.ZARINPAL_MERCHANT, amount: p.toman * 10, description: p.description, callback_url: p.callback, metadata,
  });
  if (j?.data?.code === 100 && j.data.authority) return String(j.data.authority);
  throw new Error(zpError(j));
}

/** Confirm a payment after the customer comes back. 100 = verified now, 101 = verified before. */
export async function zpVerify(env: BillingEnv, authority: string, toman: number) {
  const j = await zpPost(env, "verify.json", { merchant_id: env.ZARINPAL_MERCHANT, amount: toman * 10, authority });
  const code = j?.data?.code;
  if (code === 100 || code === 101) return { ok: true as const, refId: String(j.data.ref_id ?? ""), cardPan: String(j.data.card_pan ?? "") };
  return { ok: false as const, error: zpError(j) };
}
