# RFID access control (Wemos D1 mini + RC522)

A door reader that identifies people by RFID card, opens an electric lock for
allowed cards, refuses (with a buzzer alarm) unknown or blocked cards, and
logs every entry/exit with date and time.

```
            ┌───────────── server mode ──────────────┐
 card ─► RC522 ─► Wemos D1 mini ──HTTP──► server (Raspberry Pi, Flask + SQLite)
                   │  LEDs, buzzer, relay → lock      web panel: cards, doors, log,
                   │                                   attendance, who's inside
                   └─ standalone mode: cards + log + panel on the Wemos itself
```

| | **Server mode** | **Standalone mode** |
|---|---|---|
| Who decides | the server | the Wemos |
| Card list / log | SQLite on the server | flash on the Wemos (≤200 cards, ~2000 log lines) |
| Admin panel | server: `http://<pi>:8080` | device: `http://<device-name>.local` or its IP |
| Multiple doors | yes, shared card list | each door is independent |
| Server down? | door keeps working from a cached card list; events are uploaded later | n/a |
| Needs a router | yes | no — the device can create its own Wi-Fi |

You switch modes in the device's own panel (Settings → Mode). No display is needed.

---

## 1. Hardware

| Part | Notes |
|---|---|
| Wemos D1 mini (ESP8266) | |
| RC522 RFID module + 13.56 MHz cards/tags | **3.3 V only** |
| Green LED + red LED (+ 220 Ω resistors) or an LED module | |
| Buzzer module (active buzzer) | set `BUZZER_ACTIVE_LOW` in `config.h` to match it |
| Relay module or MOSFET module + 12 V electric lock / strike | relay must switch from 3.3 V logic; put a flyback diode across the lock coil |
| 5 V supply for the Wemos, 12 V for the lock | common GND |

### Wiring

| RC522 | Wemos | | Module | Wemos |
|---|---|---|---|---|
| SDA (SS) | D8 | | Green LED | D1 |
| SCK | D5 | | Red LED | D2 |
| MOSI | D7 | | Buzzer | D3 |
| MISO | D6 | | Relay IN (lock) | D4 |
| RST | D0 | | | |
| 3.3V | 3V3 | | | |
| GND | G | | | |
| IRQ | — | | | |

SCK/MISO/MOSI (D5/D6/D7) are the ESP8266's hardware SPI pins and can't be moved.
D3/D4 must be HIGH and D8 LOW at boot. An active-LOW relay on D4 stays **off** while
the board boots. For the buzzer on D3, a **low-level-trigger** module (set
`BUZZER_ACTIVE_LOW true`) is best: it stays silent at boot. A high-level-trigger module
will chirp briefly at power-on. If its input pulls D3 to GND, the board won't boot
normally; it enters flash mode instead. D4 is also the
Wemos's on-board LED, so that LED lights while the lock is open.

Pins and active-high/low polarity are set in `firmware/src/config.h`.

### Signals

| What you see/hear | Meaning |
|---|---|
| short beep + green on while the lock is open | access granted |
| 3 × red + beep | blocked / expired card |
| 1 long red + beep | unknown card |
| green/red alternating | waiting for a card to enroll (standalone) |
| short red flash every 3 s | server mode: server unreachable (using offline cache) |
| slow red blink | setup Wi-Fi hotspot is open (not connected to the router) |
| 3 × red, no beep at boot | RC522 not detected — check wiring |

---

## 2. Firmware

Install [PlatformIO](https://platformio.org/) (VS Code extension or `pip install platformio`), then:

```bash
cd firmware
pio run -t upload        # build + flash
pio device monitor       # serial log, 115200 baud
```

### First start

1. On first boot the device opens a Wi-Fi hotspot **`RFID-Setup-xxxxxx`**, password **`rfid12345`**.
2. Connect to it and open **http://192.168.4.1**. Log in as **admin / admin**.
3. In **Settings**, choose a mode, fill in the Wi-Fi and server settings, **change the admin password**, then press *Save & reboot*.

If the router is unreachable at boot, the setup hotspot opens again. The door
keeps working meanwhile, and the hotspot closes once the router is reachable.

### Standalone (small teams)

- **Add cards:** on the Cards tab, type a name, press **Scan to add**, then hold the card on the reader.
  Or scan an unknown card first: the Status tab then offers **Add this card**.
- **Block, allow or delete** cards from the same list.
- **Log tab:** shows the latest 100 events. **Download CSV** exports the whole log in your browser's timezone.
- **No router:** tick *"No router — this device creates its own Wi-Fi"*. The device then runs
  hotspot `<device name>` with your password at http://192.168.4.1. The clock is set from your
  phone or PC whenever you open the panel. With a router, it uses NTP instead.
- **Direction:** `toggle` makes scans alternate in → out → in. Use `in` or `out` for a reader that only handles one side.

### Server mode

1. In the server panel, go to **Doors → Add a door**. Copy the **device key** shown (it is shown only once).
2. In the device panel, set Mode = Server, enter the **Server URL** (e.g. `http://192.168.1.10:8080`) and the **Device key**.
3. Scan a new card. It appears on the server dashboard under **Unregistered cards**, where you click **Register**.

The device sends a heartbeat every 5 s. Through it, the device downloads the card list whenever it
changes, picks up "Open" commands from the panel, takes its clock from the server, and uploads
events it decided while offline (marked *offline* in the log). To make the door stay locked when
the server is down, untick *"use the cached card list"*.

---

## 3. Server (Raspberry Pi or any Linux box)

```bash
sudo mkdir -p /opt/accessctl && sudo chown $USER /opt/accessctl
cp -r server /opt/accessctl/
python3 -m venv /opt/accessctl/venv
/opt/accessctl/venv/bin/pip install -r /opt/accessctl/server/requirements.txt

# try it
cd /opt/accessctl/server && ACCESSCTL_DATA=/opt/accessctl/data ../venv/bin/python app.py
```

The first start prints the generated **admin password**. Open `http://<pi-ip>:8080`.

To run it as a service, next to whatever else the Pi is doing, edit `User=` in
`server/accessctl.service`, then:

```bash
sudo cp server/accessctl.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now accessctl
journalctl -u accessctl -f
```

It's a single process (waitress, 8 threads) with one SQLite file in `ACCESSCTL_DATA`.
Back up `access.db` and `secret_key` from that folder.
To reset a password: `../venv/bin/python app.py set-password admin`.

### Panel

Both panels (server and device) are in **Persian, right-to-left**. Dates are shown in the
**Shamsi (Jalali) calendar** with Persian digits. Date fields take Shamsi dates such as
`1405/08/11` (Persian digits work too). CSV exports include Shamsi and Gregorian dates and
start with a UTF-8 BOM, so Excel displays Persian names correctly. The server bundles the
Vazirmatn font (`static/fonts`, SIL OFL), so it doesn't need internet. The device panel uses
the system font (Tahoma/Segoe UI).


- **Dashboard**: who is inside, today's counts, door online/offline status with an *Open* button, unregistered cards, recent activity.
- **Cards**: add, edit, block or allow; optional **valid-until** date and a note; per-card history.
- **Doors**: direction (entry, exit or toggle), unlock time, enable/disable, new key.
- **Log**: filter by name, UID, result, door and date; CSV export.
- **Attendance**: first in, last out and time on site per person per day.
- **Settings**: panel users and passwords, purging old events.

### Hooking it into other things on the server

- `ACCESSCTL_WEBHOOK_URL=http://…`: every event is POSTed as JSON, e.g.
  `{"time": "...", "door": "Main", "name": "Sara", "uid": "04:A3:1B:2C", "result": "granted", "direction": "in", "offline": false}`.
  Works with Node-RED, Home Assistant, a Telegram bot, etc.
- `ACCESSCTL_API_TOKEN=…` enables `GET /api/v1/presence` and `GET /api/v1/events?since=<id>`
  (header `Authorization: Bearer <token>`).

### Device ↔ server protocol

All requests carry the header `X-Device-Key: <key>`.

| Call | Body | Reply |
|---|---|---|
| `POST /api/v1/scan` | `{"uid":"04:A3:1B:2C"}` | `{"granted":true,"result":"granted","name":"Sara","direction":"in","open_ms":3000}` |
| `POST /api/v1/sync` | `{"fw":"1.0.0","cards_version":"…","events":[{ts,uid,result,direction}…]}` | `{"time":…,"cards_version":"…","open":false,"open_ms":3000}` |
| `GET /api/v1/cards` | — | TSV lines `uid⇥1⇥inside⇥name` (valid cards only) |

`result` is one of `granted | unknown | disabled | expired | denied` (denied = door disabled).

---

## Security notes

- Basic 13.56 MHz cards (MIFARE Classic, cheap tags) **can be cloned**. Only the UID is checked,
  so this suits offices, labs and team rooms, not high-security doors.
- The device panel uses HTTP Basic auth, and device ↔ server traffic is plain HTTP. Keep both on
  a trusted LAN or Wi-Fi, and don't port-forward them to the internet.
- Change `admin/admin` and the hotspot password on first setup.
- Fail-secure vs fail-safe: a normal strike with an active-LOW relay stays locked when power is lost.
  Check what your fire code requires for exit doors, and add a mechanical or exit-button release on the inside.
