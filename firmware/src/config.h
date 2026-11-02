#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Wiring (Wemos D1 mini) — see README.md for the full table
//   RC522  SDA(SS)->D8  SCK->D5  MOSI->D7  MISO->D6  RST->D3  3.3V  GND
//   Green LED -> D1, Red LED -> D2, Buzzer -> D0, Relay/lock -> D4
// D4 (GPIO2) and D3 (GPIO0) must be HIGH at boot, D8 (GPIO15) LOW: the
// assignments below respect that (an active-LOW relay stays off at boot).
// ---------------------------------------------------------------------------
#define PIN_RC522_SS   D8
#define PIN_RC522_RST  D3
#define PIN_LED_GREEN  D1
#define PIN_LED_RED    D2
#define PIN_BUZZER     D0
#define PIN_RELAY      D4

// Set to match your modules
#define LED_ACTIVE_LOW     false
#define BUZZER_ACTIVE_LOW  false   // many 3-pin "low level trigger" buzzer modules need true
#define RELAY_ACTIVE_LOW   true    // most blue relay boards are active-LOW

#define FW_VERSION         "1.0.0"

#define MAX_CARDS          200
#define LOG_MAX_BYTES      60000   // local log is rotated to /log.old when it grows past this
#define QUEUE_MAX_BYTES    4096    // offline events waiting to be uploaded (server mode)
#define SCAN_REPEAT_MS     2000    // ignore the same card held on the reader for this long
#define SERVER_TIMEOUT_MS  1500    // after this, fall back to the cached card list
#define SYNC_INTERVAL_MS   5000    // heartbeat to server (remote-open latency)
#define READER_CHECK_MS    30000   // RC522 health check / re-init
#define WIFI_CONNECT_MS    15000   // at boot; after that the setup AP is opened
#define NAME_MAX_LEN       96      // bytes (UTF-8): ~32 Persian letters + margin
