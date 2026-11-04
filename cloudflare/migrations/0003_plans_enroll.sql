-- Plans, subscriptions and support tickets; card-registration mode for devices.
-- Same file runs on the Flask server and on Cloudflare D1 (cloudflare/migrations/).

-- Plans the server owner sells. A NULL limit means unlimited.
CREATE TABLE plans (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    period      TEXT NOT NULL DEFAULT 'month',     -- day | week | month | year
    price       INTEGER NOT NULL DEFAULT 0,        -- per period, in the currency shown on the panel
    max_users   INTEGER,
    max_devices INTEGER,
    max_cards   INTEGER,
    max_classes INTEGER,
    note        TEXT NOT NULL DEFAULT '',
    public      INTEGER NOT NULL DEFAULT 1,        -- shown to companies on their subscription page
    created_at  INTEGER NOT NULL
);

-- A company's subscription: the plan it is on, its own limits and price (copied from the
-- plan, or set by hand for a custom plan) and how long it has paid for.
-- Existing companies keep NULL limits = unlimited.
ALTER TABLE orgs ADD COLUMN plan_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL;
ALTER TABLE orgs ADD COLUMN period      TEXT;
ALTER TABLE orgs ADD COLUMN price       INTEGER;
ALTER TABLE orgs ADD COLUMN max_users   INTEGER;
ALTER TABLE orgs ADD COLUMN max_devices INTEGER;
ALTER TABLE orgs ADD COLUMN max_cards   INTEGER;
ALTER TABLE orgs ADD COLUMN max_classes INTEGER;
ALTER TABLE orgs ADD COLUMN paid_until  TEXT;    -- ISO date; NULL = no subscription tracking

CREATE TABLE payments (
    id         INTEGER PRIMARY KEY,
    org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL DEFAULT 0,
    paid_until TEXT NOT NULL,                     -- the subscription end date this payment set
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

-- Support tickets between a company and the server owner (plan requests, custom plans, questions).
CREATE TABLE tickets (
    id           INTEGER PRIMARY KEY,
    org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'other',   -- plan | custom | other
    subject      TEXT NOT NULL,
    plan_id      INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    want_period  TEXT,                            -- custom plan request
    want_users   INTEGER,
    want_devices INTEGER,
    want_cards   INTEGER,
    want_classes INTEGER,
    status       TEXT NOT NULL DEFAULT 'open',    -- open | closed
    owner_unread INTEGER NOT NULL DEFAULT 1,      -- new message for the server owner
    org_unread   INTEGER NOT NULL DEFAULT 0,      -- new reply for the company
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_tickets_org ON tickets(org_id, updated_at);
CREATE TABLE ticket_messages (
    id         INTEGER PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author     TEXT NOT NULL,                     -- username at the time
    from_owner INTEGER NOT NULL DEFAULT 0,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Card-registration mode: scans on this device don't open anything; the panel's
-- "register cards" page pops up each new card so it can be named on the spot.
ALTER TABLE devices ADD COLUMN enroll INTEGER NOT NULL DEFAULT 0;

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', '3');
