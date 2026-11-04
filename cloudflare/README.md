# Access-control server on Cloudflare Workers

The same server as `../server` (Flask + SQLite), ported to a Cloudflare Worker with a
D1 database. Same panel, same live door screen, and the same device API (`/api/v1/*`),
so a Wemos reader works with either server.

| Flask server | Worker |
|---|---|
| `server/app.py`, `templates/` | `src/index.ts`, `src/views.ts`, `src/live.html` |
| SQLite `data/access.db` | D1 database `accessctl` (`migrations/0001_init.sql`) |
| machine's local time | `TZ` in `wrangler.toml` (default `Asia/Tehran`) |
| `ACCESSCTL_*` environment variables | Worker secrets with the same names |
| first start prints an admin password | `ADMIN_PASSWORD` secret |
| plain `http://` on the LAN | `https://` only, so the firmware needs the HTTPS change (below) |

## Deploy

You need a Cloudflare account and Node.js 18 or newer.

```bash
cd cloudflare
npm install
npx wrangler login

npx wrangler d1 create accessctl        # copy the printed database_id into wrangler.toml
npm run db:migrate                      # create the tables in D1

npx wrangler secret put SECRET_KEY      # paste a long random string, e.g. from: openssl rand -hex 32
npx wrangler secret put ADMIN_PASSWORD  # password for user "admin"

npm run deploy                          # prints https://accessctl.<your-subdomain>.workers.dev
```

Open that URL and log in as `admin` (the server owner). On **مدیریت سرور** create a company with its
login; that company then adds its own devices, cards and classes in its panel. Enter the server address and the
device key in each device. Companies, classes and the upgrade of an existing database work exactly as on the Flask
server (see the main README): `npm run db:migrate` applies `migrations/0002_multitenant.sql`, which moves existing
data into «سازمان پیش‌فرض», and `0003_plans_enroll.sql` adds plans, subscriptions, tickets and card-registration mode.

Optional:

```bash
npx wrangler secret put ACCESSCTL_API_TOKEN     # read-only API: /api/v1/presence, /api/v1/events
npx wrangler secret put ACCESSCTL_WEBHOOK_URL   # POSTs every access event as JSON
node scripts/set-password.mjs admin             # reset a panel password
```

## Move the data over from the Flask server

```bash
python3 scripts/export-sqlite.py ../server/data/access.db > export.sql
npx wrangler d1 execute accessctl --remote --file export.sql
```

This copies companies, cards, devices (with their keys, so devices keep working), classes with their
members and schedules, events and the card revision. Start the current Flask server once first (it upgrades its
database), and run `npm run db:migrate` on D1. Panel users are not copied, because passwords are stored differently:
use `ADMIN_PASSWORD` or `set-password.mjs` for the server owner, then recreate company logins on the admin page.

## Point a device at the Worker

1. Flash the firmware from `../firmware`. It needs the HTTPS support added alongside this Worker.
2. In the device panel under Settings → Server, set:
   - **Server address:** `https://accessctl.<your-subdomain>.workers.dev` (no trailing slash)
   - **Device key:** the key from the Worker's **Doors** page
   - **Mode:** server

The device encrypts its traffic to the Worker, but it does not verify the certificate.
The ESP8266 has no certificate store, and Cloudflare rotates its certificates. Someone
who can intercept the device's network could pretend to be the server and read the
device key. If that happens, use **New key** on the Doors page. TLS also makes a card
check slower: about 1 to 2 seconds on the first request, then faster because the device
reuses the TLS session. If the server doesn't answer within 4 seconds, the device
decides from its cached card list.

## Running locally

```bash
printf 'SECRET_KEY=dev-secret-0123456789\nADMIN_PASSWORD=testpass123\n' > .dev.vars
npm run db:migrate:local
npm run dev            # http://127.0.0.1:8787, uses a local D1 database
```

## Limits on the free plan

The free plan allows 100,000 Worker requests per day.

- Each door syncs every 5 seconds: about 17,000 requests a day per door.
- An open live screen polls every `LIVE_POLL_MS` (3 s by default): about 29,000 requests a day per screen.

So the free plan covers about 3 doors and 1 live screen. Use the Workers Paid plan
($5/month, 10 million requests) for more.
