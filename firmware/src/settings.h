#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>

// Persistent device configuration, stored in /config.json and edited from
// the local web panel.
struct Settings {
  String mode = "standalone";      // "standalone" | "server"
  String deviceName = "door-1";    // also the mDNS name: http://door-1.local
  String wifiSsid;
  String wifiPass;
  bool   apOnly = false;           // standalone without a router: device runs its own Wi-Fi
  String apPass = "rfid12345";     // >= 8 chars (WPA2 requirement)
  String adminUser = "admin";
  String adminPass = "admin";
  String serverUrl;                // e.g. http://192.168.1.10:8080
  String deviceKey;                // copied from the server panel (Doors page)
  bool   offlineFallback = true;   // server mode: use cached card list if the server is down
  String direction = "toggle";     // standalone: "in" | "out" | "toggle"
  uint32_t openMs = 3000;          // standalone: how long the lock stays open
  String ntpServer = "pool.ntp.org";

  bool isServerMode() const { return mode == "server"; }

  bool load() {
    File f = LittleFS.open("/config.json", "r");
    if (!f) return false;
    JsonDocument d;
    DeserializationError e = deserializeJson(d, f);
    f.close();
    if (e) return false;
    apply(d.as<JsonObjectConst>());
    return true;
  }

  bool save() const {
    JsonDocument d;
    JsonObject o = d.to<JsonObject>();
    toJson(o, true);
    File f = LittleFS.open("/config.json", "w");
    if (!f) return false;
    serializeJson(d, f);
    f.close();
    return true;
  }

  // includeSecrets=false is what the web panel sees: passwords/keys are blanked.
  void toJson(JsonObject o, bool includeSecrets) const {
    o["mode"] = mode;
    o["deviceName"] = deviceName;
    o["wifiSsid"] = wifiSsid;
    o["apOnly"] = apOnly;
    o["adminUser"] = adminUser;
    o["serverUrl"] = serverUrl;
    o["offlineFallback"] = offlineFallback;
    o["direction"] = direction;
    o["openMs"] = openMs;
    o["ntpServer"] = ntpServer;
    if (includeSecrets) {
      o["wifiPass"] = wifiPass;
      o["apPass"] = apPass;
      o["adminPass"] = adminPass;
      o["deviceKey"] = deviceKey;
    } else {
      o["hasDeviceKey"] = deviceKey.length() > 0;
    }
  }

  // Applies only the keys that are present. Empty secret fields mean
  // "keep the current value", so the panel never has to echo them back.
  void apply(JsonObjectConst o) {
    auto str = [&](const char* k, String& dst, bool secret = false) {
      if (!o[k].is<const char*>()) return;
      String v = o[k].as<const char*>();
      v.trim();
      if (secret && v.length() == 0) return;
      dst = v;
    };
    str("mode", mode);
    str("deviceName", deviceName);
    str("wifiSsid", wifiSsid);
    str("wifiPass", wifiPass, true);
    str("apPass", apPass, true);
    str("adminUser", adminUser);
    str("adminPass", adminPass, true);
    str("serverUrl", serverUrl);
    str("deviceKey", deviceKey, true);
    str("direction", direction);
    str("ntpServer", ntpServer);
    if (o["apOnly"].is<bool>()) apOnly = o["apOnly"];
    if (o["offlineFallback"].is<bool>()) offlineFallback = o["offlineFallback"];
    if (o["openMs"].is<uint32_t>()) openMs = o["openMs"];

    // sanitise
    if (mode != "server") mode = "standalone";
    if (direction != "in" && direction != "out") direction = "toggle";
    if (apPass.length() < 8) apPass = "rfid12345";
    if (adminUser.length() == 0) adminUser = "admin";
    if (deviceName.length() == 0) deviceName = "door-1";
    openMs = constrain(openMs, (uint32_t)500, (uint32_t)30000);
    while (serverUrl.endsWith("/")) serverUrl.remove(serverUrl.length() - 1);
  }
};
