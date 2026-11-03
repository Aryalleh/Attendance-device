#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Wiring (Wemos D1 mini) — see README.md for the full table
//   RC522  SDA(SS)->D8  SCK->D5  MOSI->D7  MISO->D6  RST->D0  3.3V  GND
//   Green LED -> D1, Red LED -> D2, Buzzer -> D3, Relay/lock -> D4
// SCK/MISO/MOSI are the ESP8266 hardware SPI pins and can't be moved.
// D4 (GPIO2) and D3 (GPIO0) must be HIGH at boot, D8 (GPIO15) LOW: an
// active-LOW relay on D4 and a low-trigger buzzer on D3 both stay off at boot.
// ---------------------------------------------------------------------------
#define PIN_RC522_SS   D8
#define PIN_RC522_RST  D0
#define PIN_LED_GREEN  D1
#define PIN_LED_RED    D2
#define PIN_BUZZER     D3
#define PIN_RELAY      D4

// Set to match your modules
#define LED_ACTIVE_LOW     false
#define BUZZER_ACTIVE_LOW  false   // many 3-pin "low level trigger" buzzer modules need true
#define RELAY_ACTIVE_LOW   true    // most blue relay boards are active-LOW

#define FW_VERSION         "1.0.1"

#define MAX_CARDS          200
#define LOG_MAX_BYTES      60000   // local log is rotated to /log.old when it grows past this
#define QUEUE_MAX_BYTES    4096    // offline events waiting to be uploaded (server mode)
#define SCAN_REPEAT_MS     2000    // ignore the same card held on the reader for this long
#define SERVER_TIMEOUT_MS  1500    // after this, fall back to the cached card list
#define SERVER_TIMEOUT_TLS_MS 4000 // same for https:// servers (Cloudflare Workers): TLS is slower
#define SYNC_INTERVAL_MS   5000    // heartbeat to server (remote-open latency)
#define READER_CHECK_MS    30000   // RC522 health check / re-init
#define WIFI_CONNECT_MS    15000   // at boot; after that the setup AP is opened
#define WIFI_RETRY_MS      20000   // while disconnected: rejoin (alternating 802.11n/g) this often
#define LINK_DEAD_MS       45000   // server mode: rejoin Wi-Fi if the server is silent this long
#define PRIMARY_RETRY_MS   300000  // while on the failover server, retry the primary this often
#define NAME_MAX_LEN       96      // bytes (UTF-8): ~32 Persian letters + margin
