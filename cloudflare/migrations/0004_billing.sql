-- Billing: plans, subscriptions, hardware store, invoices paid through Zarinpal.
-- Existing companies keep plan = NULL: no billing, no new limits, nothing changes for them.

-- Plans are rows so the server owner can change prices and limits from /admin without a deploy.
-- Prices in toman (VAT added at checkout). Limits: NULL = unlimited.
CREATE TABLE plans (
    id           TEXT PRIMARY KEY,           -- free | starter | business | enterprise
    name         TEXT NOT NULL,
    blurb        TEXT NOT NULL DEFAULT '',
    price_month  INTEGER NOT NULL DEFAULT 0,
    price_year   INTEGER NOT NULL DEFAULT 0,
    max_doors    INTEGER,
    max_admins   INTEGER,
    max_cards    INTEGER,
    features     TEXT NOT NULL DEFAULT '',   -- one per line, shown on the pricing page
    trial_days   INTEGER NOT NULL DEFAULT 0,
    contact      INTEGER NOT NULL DEFAULT 0, -- 1 = "contact sales" instead of self-serve checkout
    sort         INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plans(id, name, blurb, price_month, price_year, max_doors, max_admins, max_cards, features, trial_days, contact, sort) VALUES
 ('free', 'رایگان', 'برای استفاده شخصی و راه‌اندازی‌های کوچک.', 0, 0, 1, 1, 25,
  'تاریخچه ۳۰ روزه', 0, 0, 1),
 ('starter', 'استارتر', 'ایده‌آل برای کسب‌وکارهای کوچک.', 450000, 4500000, 3, 2, 200,
  'ثبت حضور و غیاب' || char(10) || 'خروجی CSV گزارش‌ها' || char(10) || 'صفحه مانیتورینگ زنده', 14, 0, 2),
 ('business', 'تجاری', 'امنیت مقیاس‌پذیر برای دفاتر کاری.', 1200000, 12000000, 10, 5, 2000,
  'زمان‌بندی کلاس‌ها/شیفت‌ها' || char(10) || 'لینک‌های نمایش کیوسک' || char(10) || 'API و وب‌هوک', 14, 0, 3),
 ('enterprise', 'سازمانی', 'محدودیت‌ها و زیرساخت اختصاصی.', 0, 0, NULL, NULL, NULL,
  'درب‌ها و کارت‌های نامحدود' || char(10) || 'پشتیبانی اختصاصی' || char(10) || 'صدور فاکتور دستی' || char(10) || 'SLA سفارشی' || char(10) || 'گزینه میزبانی شخصی', 0, 1, 4);

CREATE TABLE products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    blurb       TEXT NOT NULL DEFAULT '',
    badge       TEXT NOT NULL DEFAULT '',
    price       INTEGER NOT NULL,            -- buy, toman
    rent_month  INTEGER,                     -- NULL = not for rent
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0
);
INSERT INTO products(id, name, blurb, badge, price, rent_month, sort) VALUES
 ('reader', 'کیت کارتخوان استاندارد', 'Wemos + RC522 همراه با قاب شکیل و آداپتور USB. برنامه‌ریزی شده.', 'محصول اصلی', 1500000, 120000, 1),
 ('reader_relay', 'کیت کارتخوان + رله', 'شامل رله ۵ ولت برای کنترل مستقیم قفل‌های برقی درب از طریق کارتخوان.', '', 2100000, 180000, 2),
 ('android_kit', 'کیت درب اندرویدی', 'تبلت NFC + پایه دیواری + اپلیکیشن پرو. مناسب برای نمایش زنده حضور و غیاب.', 'حالت کیوسک', 8500000, 650000, 3);

-- Subscription state lives on the company.
--   paid_until: end of the trial or paid period (NULL = not billed). Doors stop 3 days after it.
--   cancel_at_end: don't renew; at paid_until the company drops to the free plan.
--   next_plan: a downgrade that starts at the next renewal.
ALTER TABLE orgs ADD COLUMN plan          TEXT REFERENCES plans(id);
ALTER TABLE orgs ADD COLUMN cycle         TEXT NOT NULL DEFAULT 'month';
ALTER TABLE orgs ADD COLUMN sub_status    TEXT;   -- trialing | active | free | NULL (not billed)
ALTER TABLE orgs ADD COLUMN paid_until    INTEGER;
ALTER TABLE orgs ADD COLUMN cancel_at_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orgs ADD COLUMN next_plan     TEXT;
ALTER TABLE orgs ADD COLUMN max_cards     INTEGER;   -- NULL = unlimited

-- One row per payment: a plan period or a hardware order. Amounts in toman.
CREATE TABLE invoices (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    number      TEXT NOT NULL UNIQUE,         -- INV-1405-0012
    kind        TEXT NOT NULL,                -- plan | hardware
    item        TEXT NOT NULL,                -- plan id or product id
    cycle       TEXT,                         -- plan: month | year
    mode        TEXT,                         -- hardware: buy | rent
    qty         INTEGER NOT NULL DEFAULT 1,
    amount      INTEGER NOT NULL,             -- before VAT, after credit
    credit      INTEGER NOT NULL DEFAULT 0,   -- unused days of the previous plan
    vat         INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
    authority   TEXT UNIQUE,                  -- Zarinpal payment id
    ref_id      TEXT,                         -- Zarinpal reference after verify
    card_pan    TEXT,                         -- masked card number from Zarinpal
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    paid_at     INTEGER,
    period_end  INTEGER,                      -- plan: paid_until after this payment
    shipped     INTEGER NOT NULL DEFAULT 0    -- hardware: sent to the customer
);
CREATE INDEX invoices_org ON invoices(org_id, created_at);

-- Rented devices are added to every plan renewal until returned.
CREATE TABLE rentals (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    product_id  TEXT NOT NULL REFERENCES products(id),
    qty         INTEGER NOT NULL DEFAULT 1,
    monthly     INTEGER NOT NULL,             -- price per month when rented
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER
);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '4');
