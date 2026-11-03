#!/usr/bin/env python3
"""RFID door controller carrier board -- schematic generator.

    python3 generate_schematic.py          (needs KiCad 10's kicad-cli; see README.md)

The .kicad_sch is generated: change this script, not the sheet.

One 12 V input powers everything. A RECOM R-78E switching regulator makes 5 V
for the Wemos D1 mini, the relay coil and the buzzer; the D1 mini's own
regulator makes 3.3 V for the RC522. Pin use matches firmware/src/config.h:

    RC522 SDA/SS D8, SCK D5, MOSI D7, MISO D6, RST D0
    green LED D1, red LED D2, buzzer D3, relay D4

D3 (GPIO0) and D4 (GPIO2) are boot straps that sit HIGH through reset, so the
buzzer and the relay are driven through an inverting stage: they switch on
when the pin goes LOW and stay off while the board boots.
Firmware: RELAY_ACTIVE_LOW true, BUZZER_ACTIVE_LOW true.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from schlib import Design, lint_spec  # noqa: E402

FP_R = "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P7.62mm_Horizontal"
FP_TO92 = "Package_TO_SOT_THT:TO-92_Inline"
FP_TB2 = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal"
FP_TB3 = "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-3-5.08_1x03_P5.08mm_Horizontal"
FP_LED = "LED_THT:LED_D5.0mm"
FP_CDISC = "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm"

# ref: (lib_id, value, footprint, extra fields)
PARTS = {
    "J1": ("Connector:Screw_Terminal_01x02", "12V IN", FP_TB2, {}),
    "F1": ("Device:Polyfuse", "1.1A PTC", "Fuse:Fuse_Bourns_MF-RG1100", {"MPN": "MF-RG1100"}),
    "D1": ("Diode:1N5822", "1N5822", "Diode_THT:D_DO-201AD_P15.24mm_Horizontal", {}),
    "C1": ("Device:C_Polarized", "47uF 25V", "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm", {}),
    "C2": ("Device:C", "100nF", FP_CDISC, {}),
    "U1": ("Converter_DCDC:R-78E5.0-1.0", "R-78E5.0-1.0",
           "Converter_DCDC:Converter_DCDC_RECOM_R-78E-0.5_THT", {"MPN": "R-78E5.0-1.0"}),
    "C3": ("Device:C_Polarized", "22uF 16V", "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm", {}),
    "R7": ("Device:R", "1k", FP_R, {}),
    "D5": ("Device:LED", "PWR yellow", FP_LED, {}),
    "A1": ("RF_Module:WEMOS_D1_mini", "WeMos D1 mini", "RF_Module:WEMOS_D1_mini_light", {}),
    "J2": ("Connector_Generic:Conn_01x08", "RC522",
           "Connector_PinSocket_2.54mm:PinSocket_1x08_P2.54mm_Vertical", {}),
    "C4": ("Device:C", "100nF", FP_CDISC, {}),
    "R1": ("Device:R", "220", FP_R, {}),
    "D2": ("Device:LED", "GREEN", FP_LED, {}),
    "R2": ("Device:R", "220", FP_R, {}),
    "D3": ("Device:LED", "RED", FP_LED, {}),
    "R3": ("Device:R", "47k", FP_R, {}),
    "Q1": ("Transistor_BJT:BC547", "BC547", FP_TO92, {}),
    "R4": ("Device:R", "10k", FP_R, {}),
    "Q2": ("Transistor_BJT:BC337", "BC337", FP_TO92, {}),
    "BZ1": ("Device:Buzzer", "5V active", "Buzzer_Beeper:Buzzer_12x9.5RM7.6", {}),
    "R5": ("Device:R", "47k", FP_R, {}),
    "Q3": ("Transistor_BJT:BC547", "BC547", FP_TO92, {}),
    "R6": ("Device:R", "2.2k", FP_R, {}),
    "Q4": ("Transistor_BJT:BC337", "BC337", FP_TO92, {}),
    "D4": ("Diode:1N4148", "1N4148", "Diode_THT:D_DO-35_SOD27_P7.62mm_Horizontal", {}),
    "K1": ("Relay:SANYOU_SRD_Form_C", "SRD-05VDC-SL-C",
           "Relay_THT:Relay_SPDT_SANYOU_SRD_Series_Form_C", {"MPN": "SRD-05VDC-SL-C"}),
    "J3": ("Connector:Screw_Terminal_01x03", "LOCK RELAY", FP_TB3, {}),
    "J4": ("Connector:Screw_Terminal_01x02", "12V OUT", FP_TB2, {}),
}

NETS = {
    "VIN_RAW":    [("J1", 1), ("F1", 1)],
    "VIN_FUSED":  [("F1", 2), ("D1", 2)],
    "+12V":       [("D1", 1), ("C1", 1), ("C2", 1), ("U1", 1), ("J4", 1)],
    "+5V":        [("U1", 3), ("C3", 1), ("R7", 1), ("A1", 9), ("R4", 1), ("BZ1", 1),
                   ("R6", 1), ("K1", 5), ("D4", 1)],
    "+3V3":       [("A1", 8), ("J2", 8), ("C4", 1)],
    "GND":        [("J1", 2), ("C1", 2), ("C2", 2), ("U1", 2), ("C3", 2), ("D5", 1),
                   ("A1", 10), ("J2", 6), ("C4", 2), ("D2", 1), ("D3", 1),
                   ("Q1", 3), ("Q2", 3), ("Q3", 3), ("Q4", 3), ("J4", 2)],
    "PWR_LED_A":  [("R7", 2), ("D5", 2)],
    # Wemos -> RC522
    "RFID_SS":    [("A1", 7), ("J2", 1)],
    "SPI_SCK":    [("A1", 4), ("J2", 2)],
    "SPI_MOSI":   [("A1", 6), ("J2", 3)],
    "SPI_MISO":   [("A1", 5), ("J2", 4)],
    "RFID_RST":   [("A1", 3), ("J2", 7)],
    # LEDs
    "GREEN_LED":    [("A1", 14), ("R1", 1)],
    "GREEN_LED_A":  [("R1", 2), ("D2", 2)],
    "RED_LED":    [("A1", 13), ("R2", 1)],
    "RED_LED_A":  [("R2", 2), ("D3", 2)],
    # buzzer: D3 -> inverter Q1 -> driver Q2
    "BUZZER":     [("A1", 12), ("R3", 1)],
    "BUZ_B1":     [("R3", 2), ("Q1", 2)],
    "BUZ_DRV":    [("Q1", 1), ("R4", 2), ("Q2", 2)],
    "BUZ_LO":     [("Q2", 1), ("BZ1", 2)],
    # relay: D4 -> inverter Q3 -> driver Q4
    "RELAY":      [("A1", 11), ("R5", 1)],
    "RLY_B1":     [("R5", 2), ("Q3", 2)],
    "RLY_DRV":    [("Q3", 1), ("R6", 2), ("Q4", 2)],
    "COIL_LO":    [("Q4", 1), ("K1", 2), ("D4", 2)],
    "RELAY_COM":  [("K1", 1), ("J3", 1)],
    "RELAY_NO":   [("K1", 3), ("J3", 2)],
    "RELAY_NC":   [("K1", 4), ("J3", 3)],
}
NO_CONNECT = [("A1", 1), ("A1", 2), ("A1", 15), ("A1", 16), ("J2", 5)]


def put(s, ref, x, y, rot=0, mirror=None):
    lib_id, value, fp, extra = PARTS[ref]
    props = {"Footprint": fp}
    props.update(extra)
    s.place(ref, lib_id, value, x, y, rot=rot, mirror=mirror, props=props)


def cap_to_rail(s, ref, x, rail_y, below=6.35, rail=None):
    """Vertical cap hanging below a horizontal rail at rail_y, ground under it."""
    put(s, ref, x, rail_y + below)
    s.wire(s.pin(ref, 1), (x, rail_y))
    s.stub(ref, 2, 2.54, power="GND")
    if rail:
        pass


def power_block(s):
    with s.block("12 V INPUT, PROTECTION & 5 V SUPPLY"):
        y = 50.8
        put(s, "J1", 25.4, y, mirror="y")
        j1 = s.pin("J1", 1)
        g = s.stub("J1", 2, 2.54)
        s.wire(g, (g[0], g[1] + 7.62))
        s.gnd(g[0], g[1] + 7.62)
        s.wire((g[0], g[1] + 3.81), (g[0] - 5.08, g[1] + 3.81))
        s.power("PWR_FLAG", g[0] - 5.08, g[1] + 3.81, rot=90)
        put(s, "F1", j1[0] + 10.16, y, rot=90)
        s.wire(j1, s.pin("F1", 1))
        put(s, "D1", s.pin("F1", 2)[0] + 12.7, y, rot=180)
        s.wire(s.pin("F1", 2), s.pin("D1", 2))
        s.label("VIN_FUSED", s.pin("F1", 2)[0] + 1.27, y)
        k = s.pin("D1", 1)
        put(s, "U1", k[0] + 35.56, y)
        vin = s.pin("U1", "IN")
        s.wire(k, vin)
        # +12V port and its PWR_FLAG on the rail
        xp = k[0] + 3.81
        s.wire((xp, y), (xp, y - 5.08))
        s.power("+12V", xp, y - 5.08)
        xf = k[0] + 7.62
        s.wire((xf, y), (xf, y - 5.08))
        s.power("PWR_FLAG", xf, y - 5.08)
        cap_to_rail(s, "C1", k[0] + 12.7, y)
        cap_to_rail(s, "C2", k[0] + 20.32, y)
        s.stub("U1", "GND", 2.54, power="GND")
        out = s.pin("U1", "OUT")
        xo = out[0] + 25.4
        s.wire(out, (xo, y))
        cap_to_rail(s, "C3", out[0] + 7.62, y)
        s.wire((out[0] + 12.7, y), (out[0] + 12.7, y - 5.08))
        s.power("+5V", out[0] + 12.7, y - 5.08)
        # no PWR_FLAG on +5V: U1's OUT pin is already a power output
        # power LED on the 5 V rail
        put(s, "R7", xo, y + 6.35)
        s.wire(s.pin("R7", 1), (xo, y))
        put(s, "D5", xo, y + 17.78, rot=90)
        s.wire(s.pin("R7", 2), s.pin("D5", 2))
        s.stub("D5", 1, 2.54, power="GND")
        s.note("U1 R-78E5.0-1.0: switching 12 V -> 5 V, 1 A, ~90 % efficient (a 7805 would\n"
               "burn ~3 W here). Peak load ~0.5 A: D1 mini + Wi-Fi 0.35 A, relay 72 mA, buzzer 30 mA.\n"
               "D1 blocks a reversed supply; F1 trips on a shorted lock cable. C1/C2 within 10 mm of U1.",
               17.78, y + 27.94, 1.0)


def wemos_block(s):
    with s.block("WEMOS D1 MINI (ESP8266)"):
        x, y = 170.18, 63.5
        put(s, "A1", x, y)
        s.stub("A1", 9, 2.54, power="+5V")
        s.stub("A1", 8, 7.62, power="+3V3")
        s.stub("A1", 10, 2.54, power="GND")
        for pin, net in ((3, "RFID_RST"), (14, "GREEN_LED"), (13, "RED_LED"), (12, "BUZZER"),
                         (11, "RELAY"), (4, "SPI_SCK"), (5, "SPI_MISO"), (6, "SPI_MOSI"),
                         (7, "RFID_SS")):
            s.stub("A1", pin, 5.08, label=net)
        s.nc("A1", 1, 2, 15, 16)
        s.note("Plugs into two 1x8 female headers.\n"
               "Boot straps: D3/GPIO0 and D4/GPIO2 HIGH, D8/GPIO15 LOW at reset.\n"
               "The D1 mini pulls D3/D4 up with 10k; the 47k base resistors\n"
               "here leave them at ~2.8 V (VIH 2.5 V). USB may stay plugged in.",
               x - 20.32, y + 30.48, 1.0)


def rc522_block(s):
    with s.block("RC522 RFID READER"):
        x, y = 228.6, 60.96
        put(s, "J2", x, y, mirror="x")
        for pin, net in ((1, "RFID_SS"), (2, "SPI_SCK"), (3, "SPI_MOSI"), (4, "SPI_MISO"),
                         (7, "RFID_RST")):
            s.stub("J2", pin, 7.62, label=net)
        s.nc("J2", 5)
        s.stub("J2", 6, 2.54, power="GND")
        p8 = s.pin("J2", 8)
        e = s.stub("J2", 8, 2.54)
        s.wire(e, (e[0], e[1] - 5.08))
        s.power("+3V3", e[0], e[1] - 5.08)
        put(s, "C4", p8[0] - 17.78, p8[1] + 10.16)
        s.stub("C4", 1, 2.54, power="+3V3")
        s.stub("C4", 2, 2.54, power="GND")
        s.note("Module pin order: SDA SCK MOSI MISO IRQ GND RST 3.3V.\n"
               "3.3 V ONLY -- from the D1 mini's regulator (~26 mA).\n"
               "IRQ unused. Plug the module in, or run a cable <= 20 cm.",
               x - 22.86, y + 22.86, 1.0)


def led_block(s):
    with s.block("STATUS LEDS"):
        x, y = 30.48, 127.0
        for i, (r, d, net, anode) in enumerate((("R1", "D2", "GREEN_LED", "GREEN_LED_A"),
                                                ("R2", "D3", "RED_LED", "RED_LED_A"))):
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
               "5 mm LEDs: mount on the front, or bend\n"
               "the legs through the enclosure.", x, y + 27.94, 1.0)


def inverter_driver(s, x, y, rin, qa, rpu, qb, net_in):
    """GPIO -> rin -> NPN qa (inverter) -> node pulled up by rpu -> NPN qb base.
    Returns qb's collector tip."""
    put(s, qa, x, y)
    put(s, rin, x - 12.7, y, rot=90)
    s.wire(s.pin(rin, 2), s.pin(qa, "B"))
    p1 = s.pin(rin, 1)
    s.wire(p1, (p1[0] - 5.08, y))
    s.label(net_in, p1[0] - 5.08, y, angle=180)
    s.stub(qa, "E", 2.54, power="GND")
    c = s.pin(qa, "C")
    xb = c[0] + 17.78
    put(s, qb, xb + 5.08, c[1])
    s.wire(c, s.pin(qb, "B"))
    xr = c[0] + 7.62
    put(s, rpu, xr, c[1] - 7.62)
    s.wire(s.pin(rpu, 2), (xr, c[1]))
    s.stub(rpu, 1, 2.54, power="+5V")
    s.stub(qb, "E", 2.54, power="GND")
    return s.pin(qb, "C")


def buzzer_block(s):
    with s.block("BUZZER DRIVER (silent at boot)"):
        x, y = 104.14, 134.62
        c = inverter_driver(s, x, y, "R3", "Q1", "R4", "Q2", "BUZZER")
        put(s, "BZ1", c[0] + 2.54, c[1] - 7.62)
        s.wire(c, s.pin("BZ1", 2))
        s.stub("BZ1", 1, 2.54, power="+5V")
        s.note("D3 HIGH (boot, idle): Q1 on, Q2 off, silent.\n"
               "D3 LOW: buzzer on. Firmware BUZZER_ACTIVE_LOW true.",
               x - 22.86, y + 12.7, 1.0)


def relay_block(s):
    with s.block("LOCK RELAY (energised when D4 is LOW)"):
        x, y = 182.88, 134.62
        c = inverter_driver(s, x, y, "R5", "Q3", "R6", "Q4", "RELAY")
        # coil: pin 2 at the bottom to Q4's collector, pin 5 at the top to +5V
        kx = c[0] + 5.08
        put(s, "K1", kx, c[1] - 20.32)
        s.wire(c, (c[0], s.pin("K1", 2)[1]), s.pin("K1", 2))
        s.stub("K1", 5, 2.54, power="+5V")
        # flyback diode across the coil, cathode to +5V
        top, bot = s.pin("K1", 5), s.pin("K1", 2)
        xd = top[0] - 15.24
        put(s, "D4", xd, (top[1] + bot[1]) / 2, rot=270)
        s.wire(s.pin("D4", 1), (xd, top[1]), top)
        s.wire(s.pin("D4", 2), (xd, bot[1]), bot)
        # contacts to the terminal block on labels
        s.stub("K1", 1, 5.08, label="RELAY_COM")
        s.stub("K1", 3, 5.08, label="RELAY_NO")
        s.stub("K1", 4, 5.08, label="RELAY_NC")
        jx, jy = kx + 27.94, c[1] - 22.86
        put(s, "J3", jx, jy)
        for pin, net in ((1, "RELAY_COM"), (2, "RELAY_NO"), (3, "RELAY_NC")):
            s.stub("J3", pin, 7.62, label=net)
        put(s, "J4", jx, jy + 15.24)
        s.stub("J4", 1, 7.62, power="+12V")
        g = s.pin("J4", 2)
        s.wire(g, (g[0] - 2.54, g[1]), (g[0] - 2.54, g[1] + 5.08))
        s.gnd(g[0] - 2.54, g[1] + 5.08)
        s.note("D4 HIGH (boot, idle): relay off. Firmware RELAY_ACTIVE_LOW true.\n"
               "Q4 base (5 - 0.7) V / 2.2k = 2 mA for a 72 mA coil (forced beta 36).\n"
               "Contacts 10 A / 28 VDC, potential-free. Fail-secure strike: J4 +12V -> COM,\n"
               "lock between NO and J4 GND (use NC for a fail-safe maglock).\n"
               "Fit a 1N4007 across the lock coil itself.",
               x - 22.86, y + 12.7, 1.0)


def build(d):
    s = d.sheet("rfid-door-controller.kicad_sch", "RFID Door Controller", paper="auto",
                comment="Wemos D1 mini + RC522 carrier, 12 V in, relay lock output")
    power_block(s)
    wemos_block(s)
    rc522_block(s)
    led_block(s)
    buzzer_block(s)
    relay_block(s)
    s.arrange()
    return s


def main():
    force = "--force" in sys.argv
    d = Design(HERE, "rfid-door-controller", title="RFID Door Controller", rev="A",
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
