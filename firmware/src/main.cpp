// RFID access controller — Wemos D1 mini + RC522
//
//  * standalone mode: card list, access log and admin panel live on the device
//  * server mode:     the device asks the server for every scan; a cached card
//                     list keeps the door working when the server is down, and
//                     offline events are uploaded when it comes back.

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <memory>
#include <ESP8266mDNS.h>
#include <LittleFS.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h>

#include "config.h"
#include "settings.h"
#include "storage.h"
#include "feedback.h"
#include "panel_html.h"

Settings S;
CardStore localCards("/cards.tsv");   // standalone mode
CardStore cacheCards("/cache.tsv");   // server mode (offline copy)
EventLog evlog;
OfflineQueue offlineQ;
Feedback fb;
MFRC522 rfid(PIN_RC522_SS, PIN_RC522_RST);
ESP8266WebServer web(80);

// runtime state
bool setupAp = false;
bool serverOk = false;
bool readerOk = false;
String cacheVersion;
String network;
uint32_t lastSyncMs = 0, lastReaderCheckMs = 0, lastPollMs = 0;
uint32_t lastNetOkMs = 0;   // last successful reply from the server (Wi-Fi link watchdog)
uint32_t rebootAtMs = 0, cardsDirtySinceMs = 0;

String lastUid, lastName, lastResult;
uint32_t lastTime = 0, lastScanMs = 0;

bool enrollArmed = false;
String enrollName, enrollDoneUid;
uint32_t enrollUntilMs = 0;

// ---------------------------------------------------------------------------
// time
bool timeValid() { return time(nullptr) > 1600000000; }
uint32_t nowTs() { return timeValid() ? (uint32_t)time(nullptr) : 0; }
void setEpoch(uint32_t t) {
  timeval tv = {(time_t)t, 0};
  settimeofday(&tv, nullptr);
}

CardStore& activeCards() { return S.isServerMode() ? cacheCards : localCards; }

void markCardsDirty() { if (!cardsDirtySinceMs) cardsDirtySinceMs = millis() | 1; }

void setLast(const String& uid, const String& name, const char* result) {
  lastUid = uid;
  lastName = name;
  lastResult = result;
  lastTime = nowTs();
}

// ---------------------------------------------------------------------------
// server communication
//
// serverUrl may be http:// (Flask server on the LAN) or https:// (Cloudflare
// Worker, which is HTTPS-only). For https the connection is encrypted but the
// certificate is NOT verified (setInsecure): the ESP8266 has no CA store and
// Cloudflare rotates certificates. Someone who can intercept the device's
// traffic could impersonate the server and read the device key.
BearSSL::Session tlsSession;   // reused so later requests skip the slow full handshake

// Failover: requests go to serverUrl; after a request gets no HTTP reply at all
// they go to serverUrl2 (if set), and the primary is retried every few minutes.
bool useBackup = false;
uint32_t backupSinceMs = 0;

bool hasBackup() { return S.serverUrl2.length() > 0; }
const String& activeUrl() { return useBackup && hasBackup() ? S.serverUrl2 : S.serverUrl; }
const String& activeKey() { return useBackup && hasBackup() && S.deviceKey2.length() ? S.deviceKey2 : S.deviceKey; }

void switchServer(bool backup, const char* why) {
  if (useBackup == backup) return;
  useBackup = backup;
  backupSinceMs = millis();
  Serial.printf("[sync] %s: now using %s server %s\n", why, backup ? "failover" : "primary", activeUrl().c_str());
}

// called after every request: no reply at all means "unreachable"
void noteServerResult(int code) {
  if (code > 0 || !hasBackup()) return;
  switchServer(!useBackup, useBackup ? "failover server unreachable" : "primary server unreachable");
}

bool serverIsHttps() { return activeUrl().startsWith("https://"); }

std::unique_ptr<WiFiClient> serverClient() {
  if (!serverIsHttps()) return std::unique_ptr<WiFiClient>(new WiFiClient());
  auto* c = new BearSSL::WiFiClientSecure();
  c->setInsecure();
  c->setSession(&tlsSession);
  return std::unique_ptr<WiFiClient>(c);
}

int postJson(const char* path, JsonDocument& req, JsonDocument& resp) {
  if (WiFi.status() != WL_CONNECTED || S.serverUrl.isEmpty()) return -1;
  auto client = serverClient();
  HTTPClient http;
  http.setTimeout(serverIsHttps() ? SERVER_TIMEOUT_TLS_MS : SERVER_TIMEOUT_MS);
  if (!http.begin(*client, activeUrl() + path)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", activeKey());
  String body;
  serializeJson(req, body);
  int code = http.POST(body);
  if (code > 0) lastNetOkMs = millis();   // any HTTP reply proves the link works
  noteServerResult(code);
  if (code == 200) {
    String r = http.getString();
    if (deserializeJson(resp, r)) code = -2;
  }
  http.end();
  return code;
}

void fetchCards(const String& version) {
  auto client = serverClient();
  HTTPClient http;
  http.setTimeout(serverIsHttps() ? 8000 : 4000);
  if (!http.begin(*client, activeUrl() + "/api/v1/cards")) return;
  http.addHeader("X-Device-Key", activeKey());
  int code = http.GET();
  if (code != 200) { http.end(); return; }
  String body = http.getString();
  http.end();

  std::vector<Card> fresh;
  int start = 0;
  while (start < (int)body.length() && fresh.size() < MAX_CARDS) {
    int nl = body.indexOf('\n', start);
    if (nl < 0) nl = body.length();
    Card c;
    if (CardStore::parseLine(body.substring(start, nl), c)) fresh.push_back(c);
    start = nl + 1;
  }
  cacheCards.cards.swap(fresh);
  cacheCards.save();
  cacheVersion = version;
  File f = LittleFS.open("/cache.ver", "w");
  if (f) { f.print(version); f.close(); }
  Serial.printf("[sync] card cache updated: %u cards (v%s)\n", cacheCards.cards.size(), version.c_str());
}

void syncServer() {
  // on the failover server: give the primary another chance every few minutes
  if (useBackup && millis() - backupSinceMs >= PRIMARY_RETRY_MS) switchServer(false, "retrying");
  JsonDocument req;
  req["fw"] = FW_VERSION;
  req["cards_version"] = cacheVersion;
  JsonArray ev = req["events"].to<JsonArray>();
  bool hadQueue = false;
  File f = LittleFS.open("/queue.tsv", "r");
  if (f) {
    while (f.available()) {
      String line = f.readStringUntil('\n');
      line.trim();
      if (line.isEmpty()) continue;
      String p[4];
      if (splitTabs(line, p, 4) < 4) continue;
      JsonObject o = ev.add<JsonObject>();
      o["ts"] = (uint32_t)p[0].toInt();
      o["uid"] = p[1];
      o["result"] = p[2];
      o["direction"] = p[3];
      hadQueue = true;
    }
    f.close();
  }

  JsonDocument resp;
  int code = postJson("/api/v1/sync", req, resp);
  serverOk = code == 200;
  if (!serverOk) return;
  if (hadQueue) offlineQ.clear();

  uint32_t t = resp["time"] | 0;
  if (t && (!timeValid() || abs((int32_t)(t - nowTs())) > 2)) setEpoch(t);

  if (resp["open"] | false) {
    fb.openDoor(resp["open_ms"] | 3000);
    fb.play(Patterns::GRANTED);
    setLast("", "باز کردن از راه دور (سرور)", "manual");
  }
  String ver = resp["cards_version"] | "";
  if (ver.length() && ver != cacheVersion) fetchCards(ver);
}

// ---------------------------------------------------------------------------
// card handling
void grant(uint32_t openMs) { fb.openDoor(openMs); fb.play(Patterns::GRANTED); }

// Decide using a local card list (standalone, or server-mode offline fallback).
// Returns the result string and fills name/dir.
const char* decideLocal(CardStore& store, const String& uid, String& name, String& dir) {
  Card* c = store.find(uid);
  if (!c) { fb.play(Patterns::UNKNOWN); return "unknown"; }
  name = c->name;
  if (!c->enabled) { fb.play(Patterns::DENIED); return "denied"; }
  dir = S.isServerMode() ? String("toggle") : S.direction;
  if (dir == "toggle") dir = c->inside ? "out" : "in";
  c->inside = dir == "in";
  markCardsDirty();
  grant(S.openMs);
  return "granted";
}

void handleServerScan(const String& uid) {
  if (WiFi.status() == WL_CONNECTED && S.serverUrl.length()) {
    JsonDocument req, resp;
    req["uid"] = uid;
    int code = postJson("/api/v1/scan", req, resp);
    if (code == 200) {
      serverOk = true;
      bool granted = resp["granted"] | false;
      String name = resp["name"] | "";
      String dir = resp["direction"] | "";
      String result = resp["result"] | (granted ? "granted" : "denied");
      if (granted) {
        grant(resp["open_ms"] | 3000);
        if (Card* c = cacheCards.find(uid)) { c->inside = dir == "in"; markCardsDirty(); }
      } else {
        // "enroll": the device is in card-registration mode on the server; the panel names the card
        fb.play(result == "enroll" ? Patterns::ENROLLED : result == "unknown" ? Patterns::UNKNOWN : Patterns::DENIED);
      }
      lastUid = uid; lastName = name; lastResult = result; lastTime = nowTs();
      return;
    }
    serverOk = false;
    Serial.printf("[scan] server error %d, using offline mode\n", code);
  }

  String name, dir;
  const char* result;
  if (S.offlineFallback) {
    result = decideLocal(cacheCards, uid, name, dir);
  } else {
    fb.play(Patterns::FAIL);
    result = "denied";
  }
  offlineQ.push(nowTs(), uid, result, dir);
  setLast(uid, name, result);
}

void handleCard(const String& uid) {
  uint32_t ms = millis();
  if (uid == lastUid && ms - lastScanMs < SCAN_REPEAT_MS) return;
  lastScanMs = ms;
  Serial.printf("[scan] %s\n", uid.c_str());

  if (enrollArmed && !S.isServerMode()) {
    enrollArmed = false;
    fb.setIdle(Feedback::IDLE_OK);
    if (localCards.upsert(uid, enrollName, true)) {
      enrollDoneUid = uid;
      fb.play(Patterns::ENROLLED);
      evlog.append(nowTs(), uid, "enrolled", "", cleanName(enrollName));
      setLast(uid, enrollName, "enrolled");
    } else {
      fb.play(Patterns::FAIL);
      setLast(uid, "", "full");
    }
    return;
  }

  if (S.isServerMode()) { handleServerScan(uid); return; }

  String name, dir;
  const char* result = decideLocal(localCards, uid, name, dir);
  evlog.append(nowTs(), uid, result, dir, name);
  setLast(uid, name, result);
}

bool checkReader() {
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

void pollReader() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  String uid;
  char b[4];
  for (byte i = 0; i < rfid.uid.size; i++) {
    snprintf(b, sizeof(b), i ? ":%02X" : "%02X", rfid.uid.uidByte[i]);
    uid += b;
  }
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  handleCard(uid);
}

// ---------------------------------------------------------------------------
// web panel
bool auth() {
  if (web.authenticate(S.adminUser.c_str(), S.adminPass.c_str())) return true;
  web.requestAuthentication(BASIC_AUTH, "RFID door");
  return false;
}

void sendJson(int code, JsonDocument& d) {
  String out;
  serializeJson(d, out);
  web.send(code, "application/json", out);
}

void sendMsg(int code, const char* key, const String& text) {
  JsonDocument d;
  d[key] = text;
  sendJson(code, d);
}

bool readBody(JsonDocument& d) {
  if (deserializeJson(d, web.arg("plain"))) { sendMsg(400, "error", "درخواست نامعتبر"); return false; }
  return true;
}

void startChunked(const char* type) {
  web.setContentLength(CONTENT_LENGTH_UNKNOWN);
  web.send(200, type, "");
}

// Gregorian -> Jalali (Shamsi)
void g2j(int gy, int gm, int gd, int& jy, int& jm, int& jd) {
  static const int gdm[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  int gy2 = gm > 2 ? gy + 1 : gy;
  long days = 355666L + 365L * gy + (gy2 + 3) / 4 - (gy2 + 99) / 100 + (gy2 + 399) / 400 + gd + gdm[gm - 1];
  jy = -1595 + 33 * (days / 12053);
  days %= 12053;
  jy += 4 * (days / 1461);
  days %= 1461;
  if (days > 365) { jy += (days - 1) / 365; days = (days - 1) % 365; }
  if (days < 186) { jm = 1 + days / 31; jd = 1 + days % 31; }
  else { jm = 7 + (days - 186) / 30; jd = 1 + (days - 186) % 30; }
}

const char* resultFa(const String& r) {
  if (r == "granted") return "مجاز";
  if (r == "denied") return "رد شد";
  if (r == "unknown") return "کارت ناشناس";
  if (r == "enrolled") return "ثبت کارت";
  if (r == "manual") return "باز کردن دستی";
  return r.c_str();
}

void setupWeb() {
  web.on("/", HTTP_GET, [] {
    if (!auth()) return;
    web.send_P(200, "text/html", PANEL_HTML);
  });

  web.on("/api/status", HTTP_GET, [] {
    if (!auth()) return;
    JsonDocument d;
    d["mode"] = S.mode;
    d["deviceName"] = S.deviceName;
    d["network"] = network;
    d["ip"] = WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    d["rssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    d["time"] = nowTs();
    d["serverOk"] = serverOk;
    d["serverBackup"] = useBackup && hasBackup();
    d["queued"] = !offlineQ.empty();
    d["cards"] = activeCards().cards.size();
    d["readerOk"] = readerOk;
    d["uptime"] = millis() / 1000;
    d["heap"] = ESP.getFreeHeap();
    d["fw"] = FW_VERSION;
    d["lastUid"] = lastUid;
    d["lastName"] = lastName;
    d["lastResult"] = lastResult;
    d["lastTime"] = lastTime;
    sendJson(200, d);
  });

  web.on("/api/cards", HTTP_GET, [] {
    if (!auth()) return;
    startChunked("application/json");
    bool first = true;
    for (auto& c : activeCards().cards) {
      JsonDocument d;
      d["uid"] = c.uid;
      d["name"] = c.name;
      d["enabled"] = c.enabled;
      d["inside"] = c.inside;
      String s = first ? "[" : ",";
      serializeJson(d, s);
      web.sendContent(s);
      first = false;
    }
    web.sendContent(first ? "[]" : "]");
    web.sendContent("");
  });

  web.on("/api/cards", HTTP_POST, [] {
    if (!auth()) return;
    if (S.isServerMode()) return sendMsg(409, "error", "حالت سرور: کارت‌ها را در پنل سرور مدیریت کنید");
    JsonDocument d;
    if (!readBody(d)) return;
    String uid = normalizeUid(d["uid"] | "");
    String name = cleanName(d["name"] | "");
    if (uid.isEmpty()) return sendMsg(400, "error", "شناسه کارت نامعتبر است (مثال: 04:A3:1B:2C)");
    if (name.isEmpty()) return sendMsg(400, "error", "نام الزامی است");
    if (!localCards.upsert(uid, name, d["enabled"] | true))
      return sendMsg(507, "error", "حافظه کارت‌ها پر است");
    sendMsg(200, "message", "«" + name + "» ذخیره شد");
  });

  web.on("/api/cards/delete", HTTP_POST, [] {
    if (!auth()) return;
    if (S.isServerMode()) return sendMsg(409, "error", "حالت سرور: کارت‌ها را در پنل سرور مدیریت کنید");
    JsonDocument d;
    if (!readBody(d)) return;
    if (!localCards.remove(normalizeUid(d["uid"] | ""))) return sendMsg(404, "error", "کارت پیدا نشد");
    sendMsg(200, "message", "حذف شد");
  });

  web.on("/api/enroll", HTTP_POST, [] {
    if (!auth()) return;
    if (S.isServerMode()) return sendMsg(409, "error", "حالت سرور: کارت را بزنید و سپس در پنل سرور ثبت کنید");
    JsonDocument d;
    if (!readBody(d)) return;
    enrollName = cleanName(d["name"] | "");
    if (enrollName.isEmpty()) return sendMsg(400, "error", "نام الزامی است");
    enrollArmed = true;
    enrollDoneUid = "";
    enrollUntilMs = millis() + 30000;
    fb.setIdle(Feedback::IDLE_ENROLL);
    sendMsg(200, "message", "کارت را جلوی دستگاه بگیرید");
  });

  web.on("/api/enroll", HTTP_GET, [] {
    if (!auth()) return;
    JsonDocument d;
    d["armed"] = enrollArmed;
    d["uid"] = enrollDoneUid;
    sendJson(200, d);
  });

  web.on("/api/log", HTTP_GET, [] {
    if (!auth()) return;
    size_t n = constrain(web.arg("n").toInt(), 1, 300);
    startChunked("application/json");
    bool first = true;
    evlog.forEachRecent(n, [&](const String& line) {
      String p[5];
      if (splitTabs(line, p, 5) < 5) return;
      JsonDocument d;
      d["t"] = (uint32_t)p[0].toInt();
      d["uid"] = p[1];
      d["r"] = p[2];
      d["d"] = p[3];
      d["name"] = p[4];
      String s = first ? "[" : ",";
      serializeJson(d, s);
      web.sendContent(s);
      first = false;
    });
    web.sendContent(first ? "[]" : "]");
    web.sendContent("");
  });

  // CSV export with times converted to the browser's timezone (?tz=<minutes east of UTC>)
  web.on("/log.csv", HTTP_GET, [] {
    if (!auth()) return;
    long tz = web.arg("tz").toInt() * 60;
    web.sendHeader("Content-Disposition", "attachment; filename=access-log.csv");
    startChunked("text/csv");
    web.sendContent("\xEF\xBB\xBF" "تاریخ,ساعت,نام,شناسه کارت,نتیجه,جهت,تاریخ میلادی\n");
    for (const char* path : {"/log.old", "/log.tsv"}) {
      File f = LittleFS.open(path, "r");
      if (!f) continue;
      while (f.available()) {
        String line = f.readStringUntil('\n');
        String p[5];
        if (splitTabs(line, p, 5) < 5) continue;
        time_t t = p[0].toInt();
        char ts[64] = ",,";
        char greg[12] = "";
        if (t > 1600000000) {
          t += tz;
          struct tm tmv;
          gmtime_r(&t, &tmv);
          int jy, jm, jd;
          g2j(tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday, jy, jm, jd);
          snprintf(ts, sizeof(ts), "%04d/%02d/%02d,%02d:%02d:%02d,", jy, jm, jd,
                   tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
          strftime(greg, sizeof(greg), "%Y-%m-%d", &tmv);
        }
        const char* dir = p[3] == "in" ? "ورود" : p[3] == "out" ? "خروج" : "";
        String row = String(ts) + "\"" + p[4] + "\"," + p[1] + "," + resultFa(p[2]) + "," + dir + "," + greg + "\n";
        web.sendContent(row);
      }
      f.close();
    }
    web.sendContent("");
  });

  web.on("/api/log/clear", HTTP_POST, [] {
    if (!auth()) return;
    evlog.clear();
    sendMsg(200, "message", "گزارش پاک شد");
  });

  web.on("/api/settings", HTTP_GET, [] {
    if (!auth()) return;
    JsonDocument d;
    S.toJson(d.to<JsonObject>(), false);
    sendJson(200, d);
  });

  web.on("/api/settings", HTTP_POST, [] {
    if (!auth()) return;
    JsonDocument d;
    if (!readBody(d)) return;
    S.apply(d.as<JsonObjectConst>());
    if (!S.save()) return sendMsg(500, "error", "ذخیره تنظیمات ناموفق بود");
    sendMsg(200, "message", "ذخیره شد، دستگاه راه‌اندازی مجدد می‌شود");
    rebootAtMs = millis() + 1000;
  });

  // The panel sends the browser clock; used when there's no NTP/server time
  // (e.g. standalone with the device's own Wi-Fi).
  web.on("/api/time", HTTP_POST, [] {
    if (!auth()) return;
    JsonDocument d;
    if (!readBody(d)) return;
    uint32_t t = d["epoch"] | 0;
    bool fromNet = (WiFi.status() == WL_CONNECTED);
    if (t > 1600000000 && (!timeValid() || (!fromNet && abs((int32_t)(t - nowTs())) > 30))) setEpoch(t);
    sendMsg(200, "message", "ok");
  });

  web.on("/api/open", HTTP_POST, [] {
    if (!auth()) return;
    grant(S.openMs);
    if (!S.isServerMode()) evlog.append(nowTs(), "-", "manual", "", "پنل وب");
    setLast("", "پنل وب", "manual");
    sendMsg(200, "message", "در باز شد");
  });

  web.on("/api/reboot", HTTP_POST, [] {
    if (!auth()) return;
    sendMsg(200, "message", "در حال راه‌اندازی مجدد");
    rebootAtMs = millis() + 500;
  });

  web.onNotFound([] { sendMsg(404, "error", "پیدا نشد"); });
  web.begin();
}

// ---------------------------------------------------------------------------
// network
const char* wifiStatusText(wl_status_t st) {
  switch (st) {
    case WL_NO_SSID_AVAIL:   return "network not found (out of range, 5 GHz only, or SSID typo)";
    case WL_CONNECT_FAILED:  return "connection failed";
    case WL_WRONG_PASSWORD:  return "wrong password";
    case WL_DISCONNECTED:    return "disconnected / still trying";
    case WL_IDLE_STATUS:     return "idle";
    case WL_CONNECTED:       return "connected";
    default:                 return "unknown";
  }
}

void logWifiFailure() {
  Serial.printf("[wifi] could not join \"%s\": %s (status %d)\n", S.wifiSsid.c_str(),
                wifiStatusText(WiFi.status()), WiFi.status());
  int n = WiFi.scanNetworks();
  bool seen = false;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == S.wifiSsid) {
      seen = true;
      Serial.printf("[wifi]   seen: channel %d, signal %d dBm, encryption %d\n",
                    WiFi.channel(i), WiFi.RSSI(i), WiFi.encryptionType(i));
    }
  }
  if (!seen) Serial.printf("[wifi]   \"%s\" not visible to the ESP8266 (%d networks found)\n", S.wifiSsid.c_str(), n);
  WiFi.scanDelete();
}

String setupApName() { return "RFID-Setup-" + String(ESP.getChipId(), HEX); }

WiFiEventHandler onDisconnect, onGotIp;

// Radio settings: the chip's defaults (802.11n, full power) without modem sleep,
// which some routers mishandle. If joining keeps failing we alternate to 802.11g
// on the next attempt (some routers never answer the ESP8266's 802.11n
// association: disconnect reason 2), and keep whichever mode last worked.
// Only ever called while NOT connected: changing the PHY mode on a live link
// stops traffic without any disconnect event.
bool phyG = false;
uint32_t joinStartMs = 0;

void configureRadio() {
  WiFi.setPhyMode(phyG ? WIFI_PHY_MODE_11G : WIFI_PHY_MODE_11N);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
}

void beginJoin() {
  configureRadio();
  WiFi.begin(S.wifiSsid.c_str(), S.wifiPass.c_str());
  joinStartMs = millis();
  Serial.printf("[wifi] joining \"%s\" (802.11%s)\n", S.wifiSsid.c_str(), phyG ? "g" : "n");
}

void startNetwork() {
  WiFi.persistent(false);
  onDisconnect = WiFi.onStationModeDisconnected([](const WiFiEventStationModeDisconnected& e) {
    // log every reason; collapse rapid repeats of the same one
    static uint8_t lastReason = 0;
    static uint32_t lastMs = 0;
    static uint16_t repeats = 0;
    uint32_t now = millis();
    if (e.reason != lastReason || now - lastMs > 10000) {
      if (repeats) Serial.printf("[wifi] (reason %d repeated %u more times)\n", lastReason, repeats);
      Serial.printf("[wifi] router disconnect reason %d\n", e.reason);
      lastReason = e.reason;
      lastMs = now;
      repeats = 0;
    } else {
      repeats++;
    }
  });
  onGotIp = WiFi.onStationModeGotIP([](const WiFiEventStationModeGotIP& e) {
    Serial.printf("[wifi] got IP %s\n", e.ip.toString().c_str());
  });
  WiFi.hostname(S.deviceName);

  if (!S.isServerMode() && S.apOnly) {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(S.deviceName.c_str(), S.apPass.c_str());
    network = "وای‌فای خود دستگاه «" + S.deviceName + "»";
    Serial.printf("[wifi] AP \"%s\" at %s\n", S.deviceName.c_str(), WiFi.softAPIP().toString().c_str());
    return;
  }

  if (S.wifiSsid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    beginJoin();
    uint32_t t0 = millis();
    bool switched = false;
    fb.setIdle(Feedback::IDLE_SETUP);
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_MS) {
      // half the boot window in 802.11n, the other half in 802.11g
      if (!switched && millis() - t0 >= WIFI_CONNECT_MS / 2) {
        switched = true;
        phyG = !phyG;
        beginJoin();
      }
      fb.update();
      delay(50);
    }
    fb.setIdle(Feedback::IDLE_OK);
    if (WiFi.status() == WL_CONNECTED) {
      network = "وای‌فای «" + S.wifiSsid + "»";
      Serial.printf("[wifi] connected, IP %s\n", WiFi.localIP().toString().c_str());
      return;
    }
  }

  if (S.wifiSsid.length()) logWifiFailure();

  // Not configured or router unreachable: open a setup AP. The device still
  // works as a reader meanwhile, and keeps retrying the router in background.
  WiFi.mode(WIFI_AP_STA);
  configureRadio();
  WiFi.softAP(setupApName().c_str(), S.apPass.c_str());
  if (S.wifiSsid.length()) beginJoin();
  setupAp = true;
  fb.setIdle(Feedback::IDLE_SETUP);
  network = "وای‌فای راه‌اندازی «" + setupApName() + "» (به روتر وصل نیست)";
  Serial.printf("[wifi] setup AP \"%s\" pass \"%s\" at %s\n", setupApName().c_str(),
                S.apPass.c_str(), WiFi.softAPIP().toString().c_str());
}

// Router came back while the setup AP was open. mDNS is restarted around the
// AP teardown (it is bound to the AP interface; leaving it caused a crash) and
// the radio settings are left alone, as the link is already up.
void closeSetupAp() {
  MDNS.end();
  WiFi.softAPdisconnect(true);   // AP_STA -> STA
  MDNS.begin(S.deviceName.c_str());
  MDNS.addService("http", "tcp", 80);
  setupAp = false;
  fb.setIdle(Feedback::IDLE_OK);
  network = "وای‌فای «" + S.wifiSsid + "»";
  configTime(0, 0, S.ntpServer.c_str());
  Serial.println("[wifi] setup AP closed");
}

// Keeps the router link alive: retries while disconnected (alternating
// 802.11n/g), and in server mode rejoins when the link is "up" but the server
// has stopped answering, which some routers cause without a disconnect event.
void maintainWifi(uint32_t ms) {
  if (S.wifiSsid.isEmpty() || (!S.isServerMode() && S.apOnly)) return;
  static bool wasUp = false;
  static uint32_t upSinceMs = 0, lastRejoinMs = 0, lastLogMs = 0;

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasUp) {
      wasUp = true;
      upSinceMs = ms;
      Serial.printf("[wifi] connected, IP %s, signal %d dBm, 802.11%s\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI(), phyG ? "g" : "n");
      if (setupAp) closeSetupAp();
    }
    uint32_t quietMs = ms - max(lastNetOkMs, upSinceMs);
    if (S.isServerMode() && S.serverUrl.length() && quietMs > LINK_DEAD_MS && ms - lastRejoinMs > LINK_DEAD_MS) {
      Serial.printf("[wifi] connected but no reply from the server for %us: rejoining\n", quietMs / 1000);
      lastRejoinMs = ms;
      wasUp = false;
      WiFi.disconnect();
      beginJoin();
    }
    return;
  }

  if (wasUp) {
    wasUp = false;
    joinStartMs = ms;   // give the SDK's own auto-reconnect a chance first
    Serial.println("[wifi] link lost, reconnecting");
  }
  if (ms - joinStartMs >= WIFI_RETRY_MS) {
    phyG = !phyG;
    beginJoin();
  }
  if (ms - lastLogMs >= 30000) {
    lastLogMs = ms;
    Serial.printf("[wifi] still trying \"%s\": %s\n", S.wifiSsid.c_str(), wifiStatusText(WiFi.status()));
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  Serial.println("\n[boot] RFID access controller " FW_VERSION);
  fb.begin();

  if (!LittleFS.begin()) {
    Serial.println("[boot] formatting filesystem");
    LittleFS.format();
    LittleFS.begin();
  }
  if (!S.load()) S.save();
  localCards.load();
  cacheCards.load();
  File f = LittleFS.open("/cache.ver", "r");
  if (f) { cacheVersion = f.readString(); f.close(); }

  SPI.begin();
  rfid.PCD_Init();
  readerOk = checkReader();
  byte ver = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("[boot] reader %s (version 0x%02X), mode %s, %u cards\n", readerOk ? "OK" : "NOT FOUND",
                ver, S.mode.c_str(), activeCards().cards.size());
  if (!readerOk)
    Serial.println(ver == 0xFF ? "[rfid] 0xFF: MISO not connected/floating, or SDA(D8) not wired"
                               : "[rfid] 0x00: RC522 unpowered (3.3V/GND), held in reset (RST->D0), or MISO shorted to GND");

  startNetwork();
  if (WiFi.status() == WL_CONNECTED) configTime(0, 0, S.ntpServer.c_str());
  MDNS.begin(S.deviceName.c_str());
  MDNS.addService("http", "tcp", 80);
  setupWeb();

  fb.play(readerOk ? Patterns::BOOT : Patterns::FAIL);
}

void loop() {
  uint32_t ms = millis();
  web.handleClient();
  MDNS.update();
  fb.update();

  maintainWifi(ms);

  if (ms - lastPollMs >= 50) {
    lastPollMs = ms;
    pollReader();
  }

  if (ms - lastReaderCheckMs >= READER_CHECK_MS) {
    lastReaderCheckMs = ms;
    readerOk = checkReader();
    if (!readerOk) {
      Serial.println("[rfid] reader not responding, re-initialising");
      rfid.PCD_Init();
      readerOk = checkReader();
    }
  }

  if (S.isServerMode() && ms - lastSyncMs >= SYNC_INTERVAL_MS) {
    lastSyncMs = ms;
    syncServer();
  }

  if (!enrollArmed && !setupAp)
    fb.setIdle(S.isServerMode() && !serverOk ? Feedback::IDLE_SERVER_DOWN : Feedback::IDLE_OK);

  if (enrollArmed && (int32_t)(ms - enrollUntilMs) >= 0) {
    enrollArmed = false;
    fb.setIdle(Feedback::IDLE_OK);
  }

  // batch "inside" flag writes to spare the flash
  if (cardsDirtySinceMs && ms - cardsDirtySinceMs > 10000) {
    cardsDirtySinceMs = 0;
    activeCards().save();
  }

  if (rebootAtMs && (int32_t)(ms - rebootAtMs) >= 0) ESP.restart();
}
