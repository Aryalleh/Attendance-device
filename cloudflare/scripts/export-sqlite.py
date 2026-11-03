"""Export the Flask server's SQLite data as SQL for D1.

    python3 scripts/export-sqlite.py ../server/data/access.db > export.sql
    npx wrangler d1 execute accessctl --remote --file export.sql

Copies cards, doors (with their keys, so devices keep working), events and the card
revision. Panel users are NOT copied: the Worker stores passwords differently, so set
them again with ADMIN_PASSWORD or scripts/set-password.mjs.
"""
import sqlite3
import sys

TABLES = {
    "cards": ["id", "uid", "name", "note", "enabled", "valid_until", "created_at"],
    "devices": ["id", "name", "key", "direction", "open_ms", "enabled", "last_seen", "last_ip", "fw", "pending_open"],
    "events": ["id", "ts", "device_id", "uid", "card_id", "name", "result", "direction", "offline"],
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
    out = sys.stdout
    # parents before children (events reference cards and devices)
    for table, cols in TABLES.items():
        for row in con.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY 1"):
            out.write(f"INSERT OR REPLACE INTO {table}({', '.join(cols)}) VALUES ({', '.join(map(q, row))});\n")


if __name__ == "__main__":
    main()
