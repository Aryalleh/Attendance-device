#!/usr/bin/env python3
"""RFID attendance device carrier board -- schematic generator.

    python3 generate_schematic.py [--force] [--render DIR]   (needs KiCad 10's kicad-cli; see README.md)

The .kicad_sch is generated: change this script, not the sheet.

Power comes from one USB cable into the Wemos D1 mini. The D1 mini's 5V pin
feeds the buzzer (and an optional relay module); its own regulator makes
3.3 V for the RC522. Pin use matches firmware/src/config.h and docs/assembly-en.md:

    RC522 SDA/SS D8, SCK D5, MOSI D7, MISO D6, RST D0
    green LED D1, red LED D2, buzzer D3, optional relay module D4

D3 (GPIO0) is a boot strap that sits HIGH through reset, so the buzzer is
driven through an inverting two-transistor stage (assembly guide, option B):
it sounds when D3 goes LOW and stays silent while the board boots.
Firmware: BUZZER_ACTIVE_LOW true, RELAY_ACTIVE_LOW true (active-LOW relay module).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from schlib import Design, lint_spec  # noqa: E402

FP_R = "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"
FP_TO92 = "Package_TO_SOT_THT:TO-92_Inline"
FP_LED = "LED_THT:LED_D5.0mm"

# ref: (lib_id, value, footprint, extra fields)
PARTS = {
    "A1": ("RF_Module:WEMOS_D1_mini", "WeMos D1 mini", "RF_Module:WEMOS_D1_mini_light", {}),
    "C2": ("Device:C_Polarized", "47uF 10V", "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm", {}),
    "J1": ("Connector_Generic:Conn_01x08", "RC522",
           "Connector_PinSocket_2.54mm:PinSocket_1x08_P2.54mm_Vertical", {}),
    "C1": ("Device:C", "100nF", "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm", {}),
    "R1": ("Device:R", "220", FP_R, {}),
    "D1": ("Device:LED", "GREEN", FP_LED, {}),
    "R2": ("Device:R", "220", FP_R, {}),
    "D2": ("Device:LED", "RED", FP_LED, {}),
    "R3": ("Device:R", "47k", FP_R, {}),
    "Q1": ("Transistor_BJT:BC547", "BC547", FP_TO92, {}),
    "R4": ("Device:R", "10k", FP_R, {}),
    "Q2": ("Transistor_BJT:BC337", "BC337", FP_TO92, {}),
    "BZ1": ("Device:Buzzer", "5V active", "Buzzer_Beeper:Buzzer_12x9.5RM7.6", {}),
    "J2": ("Connector_Generic:Conn_01x03", "RELAY (opt.)",
           "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical", {}),
}

NETS = {
    "+5V":        [("A1", 9), ("C2", 1), ("R4", 1), ("BZ1", 1), ("J2", 1)],
    "+3V3":       [("A1", 8), ("J1", 8), ("C1", 1)],
    "GND":        [("A1", 10), ("C2", 2), ("J1", 6), ("C1", 2), ("D1", 1), ("D2", 1),
                   ("Q1", 3), ("Q2", 3), ("J2", 2)],
    # Wemos -> RC522
    "RFID_SS":    [("A1", 7), ("J1", 1)],
    "SPI_SCK":    [("A1", 4), ("J1", 2)],
    "SPI_MOSI":   [("A1", 6), ("J1", 3)],
    "SPI_MISO":   [("A1", 5), ("J1", 4)],
    "RFID_RST":   [("A1", 3), ("J1", 7)],
    # LEDs
    "GREEN_LED":  [("A1", 14), ("R1", 1)],
    "GREEN_LED_A": [("R1", 2), ("D1", 2)],
    "RED_LED":    [("A1", 13), ("R2", 1)],
    "RED_LED_A":  [("R2", 2), ("D2", 2)],
    # buzzer: D3 -> inverter Q1 -> driver Q2
    "BUZZER":     [("A1", 12), ("R3", 1)],
    "BUZ_B1":     [("R3", 2), ("Q1", 2)],
    "BUZ_DRV":    [("Q1", 1), ("R4", 2), ("Q2", 2)],
    "BUZ_LO":     [("Q2", 1), ("BZ1", 2)],
    # optional relay module on D4
    "RELAY":      [("A1", 11), ("J2", 3)],
}
NO_CONNECT = [("A1", 1), ("A1", 2), ("A1", 15), ("A1", 16), ("J1", 5)]


def put(s, ref, x, y, rot=0, mirror=None):
    lib_id, value, fp, extra = PARTS[ref]
    props = {"Footprint": fp}
    props.update(extra)
    s.place(ref, lib_id, value, x, y, rot=rot, mirror=mirror, props=props)


def wemos_block(s):
    with s.block("WEMOS D1 MINI (ESP8266) -- USB POWER"):
        x, y = 170.18, 63.5
        put(s, "A1", x, y)
        # +5V and GND enter the board through the D1 mini's USB socket
        p5 = s.stub("A1", 9, 2.54)
        s.wire(p5, (p5[0], p5[1] - 10.16))
        s.power("+5V", p5[0], p5[1] - 10.16)
        s.wire((p5[0], p5[1] - 2.54), (p5[0] - 5.08, p5[1] - 2.54))
        s.power("PWR_FLAG", p5[0] - 5.08, p5[1] - 2.54, rot=90)
        s.stub("A1", 8, 7.62, power="+3V3")
        g = s.stub("A1", 10, 2.54)
        s.wire(g, (g[0], g[1] + 5.08))
        s.gnd(g[0], g[1] + 5.08)
        s.wire((g[0], g[1] + 2.54), (g[0] - 5.08, g[1] + 2.54))
        s.power("PWR_FLAG", g[0] - 5.08, g[1] + 2.54, rot=90)
        for pin, net in ((3, "RFID_RST"), (14, "GREEN_LED"), (13, "RED_LED"), (12, "BUZZER"),
                         (11, "RELAY"), (4, "SPI_SCK"), (5, "SPI_MISO"), (6, "SPI_MOSI"),
                         (7, "RFID_SS")):
            s.stub("A1", pin, 5.08, label=net)
        s.nc("A1", 1, 2, 15, 16)
        # bulk capacitor on the 5 V rail for the buzzer and a relay module
        put(s, "C2", x - 25.4, y - 15.24)
        s.stub("C2", 1, 2.54, power="+5V")
        s.stub("C2", 2, 2.54, power="GND")
        s.note("Plugs into two 1x8 female headers. Powered from its micro-USB\n"
               "socket (5 V, >= 500 mA). Total draw < 400 mA.\n"
               "Boot straps: D3/GPIO0 and D4/GPIO2 HIGH, D8/GPIO15 LOW at reset.\n"
               "The 47k base resistor leaves D3 at ~2.8 V (VIH 2.5 V).\n"
               "C2: bulk for buzzer and relay-module switching.",
               x - 25.4, y + 35.56, 1.0)


def rc522_block(s):
    with s.block("RC522 RFID READER"):
        x, y = 228.6, 60.96
        put(s, "J1", x, y, mirror="x")
        for pin, net in ((1, "RFID_SS"), (2, "SPI_SCK"), (3, "SPI_MOSI"), (4, "SPI_MISO"),
                         (7, "RFID_RST")):
            s.stub("J1", pin, 7.62, label=net)
        s.nc("J1", 5)
        s.stub("J1", 6, 2.54, power="GND")
        p8 = s.pin("J1", 8)
        e = s.stub("J1", 8, 2.54)
        s.wire(e, (e[0], e[1] - 5.08))
        s.power("+3V3", e[0], e[1] - 5.08)
        put(s, "C1", p8[0] - 33.02, p8[1] - 2.54)
        s.stub("C1", 1, 2.54, power="+3V3")
        s.stub("C1", 2, 2.54, power="GND")
        s.note("Module pin order: SDA SCK MOSI MISO IRQ GND RST 3.3V.\n"
               "3.3 V ONLY -- from the D1 mini's regulator (~26 mA).\n"
               "IRQ unused. Plug the module in, or run a cable <= 15 cm.",
               x - 22.86, y + 22.86, 1.0)


def led_block(s):
    with s.block("STATUS LEDS"):
        x, y = 30.48, 127.0
        for i, (r, d, net) in enumerate((("R1", "D1", "GREEN_LED"), ("R2", "D2", "RED_LED"))):
            yy = y + i * 15.24
            put(s, r, x + 10.16, yy, rot=90)
            p1 = s.pin(r, 1)
            s.wire(p1, (p1[0] - 5.08, yy))
            s.label(net, p1[0] - 5.08, yy, angle=180)
            put(s, d, x + 25.4, yy, rot=180)
            s.wire(s.pin(r, 2), s.pin(d, 2))
            kk = s.pin(d, 1)
            s.wire(kk, (kk[0] + 2.54, yy))
            s.wire((kk[0] + 2.54, yy), (kk[0] + 2.54, yy + 2.54))
            s.gnd(kk[0] + 2.54, yy + 2.54)
        s.note("Active HIGH. (3.3 V - 2.0 V) / 220 = ~6 mA.\n"
               "5 mm LEDs: long leg (anode) toward the resistor.",
               x, y + 27.94, 1.0)


def buzzer_block(s):
    with s.block("BUZZER DRIVER (silent at boot)"):
        x, y = 104.14, 134.62
        put(s, "Q1", x, y)
        put(s, "R3", x - 12.7, y, rot=90)
        s.wire(s.pin("R3", 2), s.pin("Q1", "B"))
        p1 = s.pin("R3", 1)
        s.wire(p1, (p1[0] - 5.08, y))
        s.label("BUZZER", p1[0] - 5.08, y, angle=180)
        s.stub("Q1", "E", 2.54, power="GND")
        c = s.pin("Q1", "C")
        put(s, "Q2", c[0] + 22.86, c[1])
        s.wire(c, s.pin("Q2", "B"))
        xr = c[0] + 7.62
        put(s, "R4", xr, c[1] - 7.62)
        s.wire(s.pin("R4", 2), (xr, c[1]))
        s.stub("R4", 1, 2.54, power="+5V")
        s.stub("Q2", "E", 2.54, power="GND")
        qc = s.pin("Q2", "C")
        put(s, "BZ1", qc[0] + 2.54, qc[1] - 7.62)
        s.wire(qc, s.pin("BZ1", 2))
        s.stub("BZ1", 1, 2.54, power="+5V")
        s.note("D3 HIGH (boot, idle): Q1 on, Q2 off, silent.\n"
               "D3 LOW: buzzer on. Firmware BUZZER_ACTIVE_LOW true.\n"
               "BZ1: 5 V ACTIVE buzzer (beeps on DC), + pin to +5V.",
               x - 22.86, y + 12.7, 1.0)


def relay_block(s):
    with s.block("OPTIONAL RELAY MODULE"):
        x, y = 200.66, 134.62
        put(s, "J2", x, y)
        e = s.stub("J2", 1, 2.54)
        s.wire(e, (e[0], e[1] - 5.08))
        s.power("+5V", e[0], e[1] - 5.08)
        s.stub("J2", 2, 2.54, power="GND")
        s.stub("J2", 3, 7.62, label="RELAY")
        s.note("1 VCC  2 GND  3 IN, for an active-LOW 5 V relay module\n"
               "(RELAY_ACTIVE_LOW true). D4 is HIGH at boot: relay off.\n"
               "Give the lock its OWN supply -- never the USB 5 V --\n"
               "and fit a flyback diode across the lock coil.",
               x - 22.86, y + 15.24, 1.0)


def build(d):
    s = d.sheet("rfid-door-controller.kicad_sch", "RFID Attendance Device", paper="A4",
                comment="Wemos D1 mini + RC522 carrier, USB powered")
    wemos_block(s)
    rc522_block(s)
    led_block(s)
    buzzer_block(s)
    relay_block(s)
    s.arrange()
    return s


def main():
    force = "--force" in sys.argv
    d = Design(HERE, "rfid-door-controller", title="RFID Attendance Device", rev="B",
               company="card-reader")
    lint_spec({k: v[:3] for k, v in PARTS.items()}, NETS, NO_CONNECT, project_dir=HERE)
    build(d)
    d.write(force=force)
    ok = d.verify(NETS, NO_CONNECT)
    d.erc()
    d.check_text()
    if "--render" in sys.argv:
        d.render(sys.argv[sys.argv.index("--render") + 1])
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
