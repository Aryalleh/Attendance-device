#!/usr/bin/env python3
"""Route the RFID attendance device carrier board (2 layers) and pour ground.

    $KPY route_board.py            (KiCad 10's own Python; see README.md)

Idempotent: every track, via and zone is removed and redrawn. Run it after
place_board.py. Every pad a route starts or ends on is checked against the
placement in place_board.py and against the netlist; if a part moved or a net
changed, the script stops instead of drawing through a pad.

Layer plan:
  TOP     almost every track, plus a GND pour.
  BOTTOM  GND pour and three tracks that must cross others:
            +3V3     D1 mini -> round the left of the RC522 socket -> its pin 8
            SPI_SCK  crosses MISO/MOSI on its way to the socket
            BUZ_LO   Q2 collector -> buzzer, under the +5V trunk

Track widths (1 oz copper, IPC-2221 outer layer; USB limits the board to ~0.5 A):
  +5V      0.8 mm
  +3V3, buzzer current   0.6 mm
  signals  0.4 mm
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pcbnew  # noqa: E402
from routelib import Router, F, B  # noqa: E402

import place_board as plan  # noqa: E402

W_5, W_MID, W_SIG = 0.8, 0.6, 0.4

r = Router(__file__, plan.NAME, size=(plan.W, plan.H))


def P(ref, num, expect, net=None):
    """Pad centre, asserting position (and net, when given)."""
    return r.pad(ref, num, expect=expect, net=net)


def net_of(ref, num):
    for p in r.fps[ref].Pads():
        if p.GetNumber() == str(num):
            return p.GetNetname()
    raise KeyError((ref, num))


def T(pts, width, net, layer=F):
    """Track through pts. net is a name, or (ref, pad) for nets the schematic leaves unnamed."""
    if isinstance(net, tuple):
        net = net_of(*net)
    r.track(net, pts, width, layer)


def route_reader():
    """D1 mini left column -> RC522 socket J1 (pin 1 at the bottom)."""
    T([P("A1", 3, (17.0, 13.58), "/RFID_RST"), P("J1", 7, (5.0, 13.58), "/RFID_RST")],
      W_SIG, "/RFID_RST")
    # MISO, MOSI and SS each step down to their socket row; order is kept, so no crossings
    T([P("A1", 5, (17.0, 18.66), "/SPI_MISO"), (10.0, 18.66), (7.46, 21.2),
       P("J1", 4, (5.0, 21.2), "/SPI_MISO")], W_SIG, "/SPI_MISO")
    T([P("A1", 6, (17.0, 21.2), "/SPI_MOSI"), (10.0, 21.2), (7.46, 23.74),
       P("J1", 3, (5.0, 23.74), "/SPI_MOSI")], W_SIG, "/SPI_MOSI")
    T([P("A1", 7, (17.0, 23.74), "/RFID_SS"), (12.54, 23.74), (7.46, 28.82),
       P("J1", 1, (5.0, 28.82), "/RFID_SS")], W_SIG, "/RFID_SS")
    # SCK crosses MISO and MOSI: bottom layer, pad to pad, no vias
    T([P("A1", 4, (17.0, 16.12), "/SPI_SCK"), (14.5, 16.12), (14.5, 24.0), (12.22, 26.28),
       P("J1", 2, (5.0, 26.28), "/SPI_SCK")], W_SIG, "/SPI_SCK", B)
    # 3.3 V: bottom, under the socket row and up its left side; C1 tapped on the way
    a18 = P("A1", 8, (17.0, 26.28), "+3V3")
    y3, x3 = 31.0, 2.2
    T([a18, (17.0, y3), (x3, y3), (x3, 11.04), P("J1", 8, (5.0, 11.04), "+3V3")], W_MID, "+3V3", B)
    T([(7.5, y3), P("C1", 1, (7.5, 36.0), "+3V3")], W_MID, "+3V3", B)


def route_leds():
    T([P("A1", 14, (39.86, 13.58), "/GREEN_LED"), (42.0, 11.44), (42.0, 6.0), (44.0, 4.0),
       P("R1", 1, (45.0, 4.0), "/GREEN_LED")], W_SIG, "/GREEN_LED")
    T([P("A1", 13, (39.86, 16.12), "/RED_LED"), (42.24, 16.12), (46.5, 11.86),
       P("R2", 1, (46.5, 11.5), "/RED_LED")], W_SIG, "/RED_LED")
    T([P("R1", 2, (52.62, 4.0)), P("D1", 2, (56.66, 4.0))], W_SIG, ("R1", 2))
    T([P("R2", 2, (54.12, 11.5)), P("D2", 2, (58.16, 11.5))], W_SIG, ("R2", 2))


def route_buzzer():
    T([P("A1", 12, (39.86, 18.66), "/BUZZER"), P("R3", 1, (44.0, 18.66), "/BUZZER")], W_SIG, "/BUZZER")
    T([P("R3", 2, (51.62, 18.66)), P("Q1", 2, (56.0, 18.66))], W_SIG, ("R3", 2))
    # BUZ_DRV along y = 19.93: Q1 collector -> R4 pull-up -> Q2 base
    T([P("Q1", 1, (56.0, 19.93)), P("R4", 2, (60.0, 19.93)), P("Q2", 2, (64.5, 19.93))],
      W_SIG, ("Q1", 1))
    # buzzer low side under the +5V trunk
    T([P("Q2", 1, (64.5, 21.2)), (64.5, 30.0), P("BZ1", 2, (64.7, 31.0))], W_MID, ("Q2", 1), B)


def route_power():
    # +5V trunk along y = 27.55 from the D1 mini's 5V pin to the relay header
    a19 = P("A1", 9, (39.86, 26.28), "+5V")
    y5, xr = 27.55, 83.3
    T([a19, (41.13, y5), P("R4", 1, (60.0, y5), "+5V"), (xr, y5), (xr, 10.0),
       P("J2", 1, (81.0, 10.0), "+5V")], W_5, "+5V")
    T([(44.0, y5), P("C2", 1, (44.0, 33.0), "+5V")], W_5, "+5V")
    T([(72.3, y5), P("BZ1", 1, (72.3, 31.0), "+5V")], W_MID, "+5V")


def route_relay():
    T([P("A1", 11, (39.86, 21.2), "/RELAY"), (41.66, 23.0), (66.5, 23.0), (66.5, 17.0),
       (68.42, 15.08), P("J2", 3, (81.0, 15.08), "/RELAY")], W_SIG, "/RELAY")
    P("J2", 2, (81.0, 12.54), "GND")


# GND stitching: ties the two pours together in the open areas
STITCH = [(25.0, 14.0), (32.0, 14.0), (25.0, 24.0), (32.0, 24.0), (28.5, 31.0), (10.0, 28.6),
          (12.0, 6.0), (50.0, 8.0), (66.0, 8.0), (72.0, 10.0), (72.0, 19.0), (76.0, 22.0),
          (50.0, 25.3), (55.0, 32.0), (77.0, 33.0), (76.0, 4.0), (22.0, 36.0)]


def silk():
    """Board name and connector legends on the top silkscreen."""
    texts = [("RFID Attendance  rev B", (56.0, 38.4), 1.0, 0),
             ("RC522", (11.0, 8.0), 1.0, 0),
             ("RELAY", (75.5, 7.6), 0.8, 0),
             ("+5V", (77.3, 10.0), 0.8, 0), ("GND", (77.3, 12.54), 0.8, 0),
             ("USB", (28.5, 38.4), 1.0, 0)]
    for d in list(r.board.GetDrawings()):
        if d.GetClass() == "PCB_TEXT" and d.GetLayer() == pcbnew.F_SilkS:
            r.board.Remove(d)
            r._removed.append(d)
    for s, (x, y), size, rot in texts:
        t = pcbnew.PCB_TEXT(r.board)
        t.SetText(s)
        t.SetLayer(pcbnew.F_SilkS)
        t.SetPosition(r.pt(x, y))
        t.SetTextSize(pcbnew.VECTOR2I(pcbnew.FromMM(size), pcbnew.FromMM(size)))
        t.SetTextThickness(pcbnew.FromMM(0.15))
        t.SetTextAngleDegrees(rot)
        r.board.Add(t)


def main():
    r.clear()
    route_reader()
    route_leds()
    route_buzzer()
    route_power()
    route_relay()
    r.check_moved()
    for xy in STITCH:
        r.via("GND", xy, 0.8, 0.4)
    silk()
    r.zone("GND", F, "GND top", clearance=0.3)
    r.zone("GND", B, "GND bottom", clearance=0.3)
    r.fill()
    r.save()
    r.drc_report()
    r.report()


if __name__ == "__main__":
    main()
