#!/usr/bin/env python3
"""Place the RFID attendance device carrier board (2 layers, 85 x 40 mm, all through-hole, top side).

    $KPY place_board.py [--force]      (KiCad 10's own Python; see README.md)

Creates the board from the schematic on the first run. Re-running resets every
footprint to this table: lock a part in KiCad, or move it here, first.

Floor plan (top view, origin top-left, Y down):

    +----+-----------------------+-----------------------------------+
    | J1 |   A1 Wemos D1 mini    | R1 -> D1 green       J2 relay hdr |
    | RC |   antenna at the top  | R2 -> D2 red          (VCC GND IN)|
    | 522|   edge (keep-out)     | R3 -> Q1 -> R4 -> Q2              |
    |    |                       |  C2      BZ1 buzzer               |
    | C1 |   USB end at bottom   |                                   |
    +----+-----------------------+-----------------------------------+

* A1's antenna end is flush with the top edge over the footprint's own copper
  keep-out; its micro-USB end faces the bottom edge so the cable stays reachable.
  Nothing tall sits below it.
* A1's left pins (D0, D5-D8, 3V3) face the RC522 socket J1; its right pins
  (D1-D4, GND, 5V) face the LEDs, buzzer driver and relay header.
* Each signal leaves its pin on its own row, so the routes in route_board.py
  are short and mostly straight.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcblib  # noqa: E402

NAME = "rfid-door-controller"
W, H = 85.0, 40.0

# ref: (x, y, rotation) of pad 1, board mm
TABLE = {
    "A1": (17.0, 8.5, 0),        # left pins x = 17, right pins x = 39.86, pitch 2.54 from y = 8.5
    "J1": (5.0, 28.82, 180),     # RC522: pin 1 (SDA) at the bottom, pin 8 (3.3V) at the top
    "C1": (7.5, 36.0, 0),        # 3.3 V decoupling at the RC522 feed
    # LEDs: one row each, resistor then LED (anode toward the resistor)
    "R1": (45.0, 4.0, 0),
    "D1": (59.2, 4.0, 180),      # green
    "R2": (46.5, 11.5, 0),
    "D2": (60.7, 11.5, 180),     # red
    # buzzer driver: BUZZER on y = 18.66, BUZ_DRV on y = 19.93
    "R3": (44.0, 18.66, 0),
    "Q1": (56.0, 19.93, 90),     # C 19.93, B 18.66, E 17.39
    "R4": (60.0, 27.55, 90),     # 10k: +5V at the bottom, BUZ_DRV on top
    "Q2": (64.5, 21.2, 90),      # C 21.20, B 19.93, E 18.66
    "BZ1": (72.3, 31.0, 180),    # + pad 1 on the right, - pad 2 toward Q2
    "C2": (44.0, 33.0, 0),       # 5 V bulk
    # optional relay module header on the right edge: 1 VCC, 2 GND, 3 IN
    "J2": (81.0, 10.0, 0),
}

HOLES = [(3.5, 3.5), (3.5, 36.5), (81.5, 3.5), (81.5, 36.5)]


def main():
    pcblib.create_board(HERE, NAME, layers=2)
    b = pcblib.Board(HERE, NAME, size=(W, H))
    b.sync_footprints()
    b.link_schematic()
    b.outline(radius=2.0)
    for x, y in HOLES:
        b.hole(x, y, 3.2)
    b.place_all(TABLE)
    b.tidy_references()
    b.check()
    b.save(force="--force" in sys.argv)
    b.render(os.path.join(HERE, "render"), views=("top",))


if __name__ == "__main__":
    main()
