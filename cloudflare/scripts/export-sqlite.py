"""Export the Flask server's SQLite data as SQL for D1.

    python3 scripts/export-sqlite.py ../server/data/access.db > export.sql
    npx wrangler d1 execute accessctl --remote --file export.sql

Copies companies, cards, devices (with their keys, so devices keep working), classes
with their members and schedules, events and the card revision. Both databases must be
on the same schema: start the Flask server once (it upgrades its database) and run
`npm run db:migrate` for D1 first.

Panel users are NOT copied: the Worker stores passwords differently, so set them again
with ADMIN_PASSWORD / scripts/set-password.mjs (server owner), then create the company
logins on the admin page.
"""
import sqlite3
import sys

# parents before children
TABLES = {
    "orgs": ["id", "name", "enabled", "created_at"],
    "cards": ["id", "org_id", "uid", "name", "note", "enabled", "valid_until", "created_at"],
    "devices": ["id", "org_id", "name", "key", "direction", "open_ms", "enabled", "last_seen", "last_ip", "fw", "pending_open"],
    "classes": ["id", "org_id", "name", "note", "created_at"],
    "class_members": ["class_id", "card_id"],
    "class_slots": ["id", "class_id", "device_id", "weekday", "on_date", "start_min", "end_min", "from_date", "to_date"],
    "events": ["id", "org_id", "ts", "device_id", "uid", "card_id", "name", "result", "direction", "offline",
               "class_id", "slot_id", "session_date"],
    "meta": ["key", "value"],
}


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    ver = con.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
    if not ver or int(ver[0]) < 2:
        sys.exit("This database is from an older server version: start the current Flask server once "
                 "(it upgrades the database), then run this again.")
    out = sys.stdout
    for table, cols in TABLES.items():
        for row in con.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY 1"):
            values = ", ".join(map(q, row))
            if table == "orgs":
                # the D1 migration already created company #1: update it instead of replacing
                # (a REPLACE would delete it and everything that belongs to it)
                out.write(f"INSERT INTO orgs({', '.join(cols)}) VALUES ({values}) ON CONFLICT(id) DO UPDATE SET "
                          "name = excluded.name, enabled = excluded.enabled;\n")
            else:
                out.write(f"INSERT OR REPLACE INTO {table}({', '.join(cols)}) VALUES ({values});\n")


if __name__ == "__main__":
    main()
