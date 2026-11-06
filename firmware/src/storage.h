#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <vector>
#include "config.h"

// Files use tab-separated lines (not JSON) so they can be streamed with very
// little RAM — the ESP8266 only has ~40 KB of free heap.

inline String cleanName(String s) {
  s.replace('\t', ' ');
  s.replace('\r', ' ');
  s.replace('\n', ' ');
  s.replace('"', '\'');
  s.replace('\\', '/');
  s.trim();
  if (s.length() > NAME_MAX_LEN) {
    // cut on a UTF-8 character boundary (Persian letters are 2 bytes)
    size_t n = NAME_MAX_LEN;
    while (n > 0 && ((uint8_t)s[n] & 0xC0) == 0x80) n--;
    s = s.substring(0, n);
  }
  return s;
}

// Normalise "04 a3 1b 2c", "04a31b2c", "04:A3:1B:2C" -> "04:A3:1B:2C"
inline String normalizeUid(const String& in) {
  String hex, out;
  for (size_t i = 0; i < in.length(); i++) {
    char c = toupper(in[i]);
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) hex += c;
  }
  if (hex.length() < 8 || hex.length() > 20 || hex.length() % 2) return "";
  for (size_t i = 0; i < hex.length(); i += 2) {
    if (i) out += ':';
    out += hex.substring(i, i + 2);
  }
  return out;
}

// Splits "a\tb\tc\td" into up to n fields (the last one keeps the remainder).
inline int splitTabs(const String& line, String* out, int n) {
  int count = 0, start = 0;
  while (count < n - 1) {
    int t = line.indexOf('\t', start);
    if (t < 0) break;
    out[count++] = line.substring(start, t);
    start = t + 1;
  }
  out[count++] = line.substring(start);
  return count;
}

// ---------------------------------------------------------------------------
struct Card {
  String uid;
  String name;
  bool enabled = true;
  bool inside = false;   // last direction was "in" (used for toggle mode)
};

// Line format: uid \t enabled \t inside \t name
class CardStore {
 public:
  explicit CardStore(const char* path) : _path(path) {}
  std::vector<Card> cards;
  bool dirty = false;

  void load() {
    cards.clear();
    File f = LittleFS.open(_path, "r");
    if (!f) return;
    while (f.available() && cards.size() < MAX_CARDS) {
      String line = f.readStringUntil('\n');
      Card c;
      if (parseLine(line, c)) cards.push_back(c);
    }
    f.close();
    dirty = false;
  }

  bool save() {
    File f = LittleFS.open(_path, "w");
    if (!f) return false;
    for (auto& c : cards) writeLine(f, c);
    f.close();
    dirty = false;
    return true;
  }

  static bool parseLine(String line, Card& c) {
    line.trim();
    if (line.length() == 0 || line[0] == '#') return false;
    String p[4];
    if (splitTabs(line, p, 4) < 4) return false;
    c.uid = normalizeUid(p[0]);
    c.enabled = p[1] == "1";
    c.inside = p[2] == "1";
    c.name = cleanName(p[3]);
    return c.uid.length() > 0;
  }

  static void writeLine(Print& out, const Card& c) {
    out.print(c.uid); out.print('\t');
    out.print(c.enabled ? '1' : '0'); out.print('\t');
    out.print(c.inside ? '1' : '0'); out.print('\t');
    out.print(c.name); out.print('\n');
  }

  Card* find(const String& uid) {
    for (auto& c : cards) if (c.uid == uid) return &c;
    return nullptr;
  }

  // returns false when full
  bool upsert(const String& uid, const String& name, bool enabled) {
    Card* c = find(uid);
    if (!c) {
      if (cards.size() >= MAX_CARDS) return false;
      cards.push_back(Card());
      c = &cards.back();
      c->uid = uid;
    }
    c->name = cleanName(name);
    c->enabled = enabled;
    return save();
  }

  bool remove(const String& uid) {
    for (size_t i = 0; i < cards.size(); i++) {
      if (cards[i].uid == uid) {
        cards.erase(cards.begin() + i);
        return save();
      }
    }
    return false;
  }

 private:
  const char* _path;
};

// ---------------------------------------------------------------------------
// Access log. Line format: epoch \t uid \t result \t direction \t name
// result: granted | denied | unknown | enrolled | manual
class EventLog {
 public:
  void append(uint32_t ts, const String& uid, const char* result,
              const String& dir, const String& name) {
    File f = LittleFS.open("/log.tsv", "a");
    if (!f) return;
    f.printf("%u\t%s\t%s\t%s\t%s\n", ts, uid.c_str(), result, dir.c_str(), name.c_str());
    size_t sz = f.size();
    f.close();
    if (sz > LOG_MAX_BYTES) {
      LittleFS.remove("/log.old");
      LittleFS.rename("/log.tsv", "/log.old");
    }
  }

  void clear() {
    LittleFS.remove("/log.tsv");
    LittleFS.remove("/log.old");
  }

  // Calls fn(line) for the newest `n` lines, newest first.
  template <typename F>
  void forEachRecent(size_t n, F fn) {
    std::vector<String> ring;
    ring.reserve(n);
    size_t head = 0;
    File f = LittleFS.open("/log.tsv", "r");
    if (f) {
      while (f.available()) {
        String line = f.readStringUntil('\n');
        if (line.length() == 0) continue;
        if (ring.size() < n) ring.push_back(line);
        else { ring[head] = line; head = (head + 1) % n; }
      }
      f.close();
    }
    for (size_t i = 0; i < ring.size(); i++) {
      size_t idx = (head + ring.size() - 1 - i) % ring.size();
      fn(ring[idx]);
    }
  }
};

// ---------------------------------------------------------------------------
// Server mode: events recorded while the server was unreachable.
// Line format: epoch \t uid \t result \t direction
class OfflineQueue {
 public:
  // live = decided on the device while the server was reachable (shown on the live screen);
  // otherwise the server marks it as decided offline. Line: ts uid result dir [live]
  void push(uint32_t ts, const String& uid, const char* result, const String& dir, bool live = false) {
    File f = LittleFS.open("/queue.tsv", "a");
    if (!f) return;
    if (f.size() < QUEUE_MAX_BYTES)
      f.printf("%u\t%s\t%s\t%s\t%d\n", ts, uid.c_str(), result, dir.c_str(), live ? 1 : 0);
    f.close();
  }
  bool empty() {
    File f = LittleFS.open("/queue.tsv", "r");
    bool e = !f || f.size() == 0;
    if (f) f.close();
    return e;
  }
  void clear() { LittleFS.remove("/queue.tsv"); }
};
