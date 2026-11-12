#pragma once
// Board abstraction: the firmware runs on an ESP8266 (Wemos D1 mini) or an
// ESP32 (ESP32 DevKit / ESP-WROOM-32). Everything that differs between the two
// Arduino cores lives here, so main.cpp stays the same for both.
#include <Arduino.h>
#include <LittleFS.h>

#if defined(ESP32)
  #include <WiFi.h>
  #include <WebServer.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
  #include <ESPmDNS.h>
  #include <esp_wifi.h>
  #define BOARD_NAME "ESP32"
  using WebServerT = WebServer;
  using SecureClientT = WiFiClientSecure;
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266WebServer.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClientSecureBearSSL.h>
  #include <ESP8266mDNS.h>
  #define BOARD_NAME "ESP8266"
  using WebServerT = ESP8266WebServer;
  using SecureClientT = BearSSL::WiFiClientSecure;
#else
  #error "Unsupported board: build for an ESP8266 or ESP32 environment (see platformio.ini)"
#endif

namespace Plat {

// Mount the filesystem, formatting it if it can't be mounted.
inline bool fsBegin() {
#if defined(ESP32)
  return LittleFS.begin(true);
#else
  if (LittleFS.begin()) return true;
  Serial.println("[boot] formatting filesystem");
  LittleFS.format();
  return LittleFS.begin();
#endif
}

// Open for reading without the ESP32 core logging an error for a missing file.
inline File openRead(const char* path) {
  if (!LittleFS.exists(path)) return File();
  return LittleFS.open(path, "r");
}

// Largest single free heap block (TLS needs one big block).
inline uint32_t maxFreeBlock() {
#if defined(ESP32)
  return ESP.getMaxAllocHeap();
#else
  return ESP.getMaxFreeBlockSize();
#endif
}

// Last 3 bytes of the station MAC, as the ESP8266's chip ID has always been.
inline uint32_t chipId() {
#if defined(ESP32)
  uint64_t m = ESP.getEfuseMac();   // byte 0 = first MAC byte
  return ((uint32_t)((m >> 24) & 0xFF) << 16) | ((uint32_t)((m >> 32) & 0xFF) << 8) | (uint32_t)((m >> 40) & 0xFF);
#else
  return ESP.getChipId();
#endif
}

// Must be called before WiFi.mode() on the ESP32.
inline void setHostname(const String& name) {
#if defined(ESP32)
  WiFi.setHostname(name.c_str());
#else
  WiFi.hostname(name);
#endif
}

// 802.11g-only or b/g/n on the station interface, and no modem sleep.
// Call only while the radio is on (after WiFi.mode()) and not connected.
inline void configureRadio(bool phyG) {
#if defined(ESP32)
  uint8_t proto = WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G;
  if (!phyG) proto |= WIFI_PROTOCOL_11N;
  esp_wifi_set_protocol(WIFI_IF_STA, proto);
  WiFi.setSleep(false);
#else
  WiFi.setPhyMode(phyG ? WIFI_PHY_MODE_11G : WIFI_PHY_MODE_11N);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
#endif
}

inline void mdnsUpdate() {
#if defined(ESP8266)
  MDNS.update();   // the ESP32's mDNS runs in its own task
#endif
}

// TCP connect with a timeout in milliseconds.
inline bool tcpConnect(WiFiClient& c, const IPAddress& ip, uint16_t port, uint32_t timeoutMs) {
#if defined(ESP32)
  return c.connect(ip, port, timeoutMs);
#else
  c.setTimeout(timeoutMs);
  return c.connect(ip, port);
#endif
}

}  // namespace Plat
