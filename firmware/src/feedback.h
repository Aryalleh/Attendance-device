#pragma once
#include <Arduino.h>
#include "config.h"

// Non-blocking LED / buzzer / relay driver.
// A pattern is a list of steps {green, red, buzzer, ms}, terminated by ms == 0.
struct Step { bool g, r, b; uint16_t ms; };

namespace Patterns {
const Step BOOT[]     = {{1,1,1,80},{0,0,0,80},{1,1,0,300},{0,0,0,0}};
const Step GRANTED[]  = {{1,0,1,120},{1,0,0,0}};
const Step DENIED[]   = {{0,1,1,150},{0,0,0,100},{0,1,1,150},{0,0,0,100},{0,1,1,150},{0,0,0,0}};
const Step UNKNOWN[]  = {{0,1,1,900},{0,0,0,0}};
const Step ENROLLED[] = {{1,1,1,80},{0,0,0,80},{1,1,1,80},{0,0,0,80},{1,0,1,300},{0,0,0,0}};
const Step FAIL[]     = {{0,1,0,100},{0,0,0,100},{0,1,0,100},{0,0,0,100},{0,1,0,100},{0,0,0,0}};
}

class Feedback {
 public:
  enum Idle { IDLE_OK, IDLE_SERVER_DOWN, IDLE_ENROLL, IDLE_SETUP };

  void begin() {
    pinMode(PIN_LED_GREEN, OUTPUT);
    pinMode(PIN_LED_RED, OUTPUT);
    pinMode(PIN_BUZZER, OUTPUT);
    pinMode(PIN_RELAY, OUTPUT);
    write(false, false, false);
    setRelay(false);
  }

  void play(const Step* p) { _pat = p; _step = 0; _stepAt = millis(); apply(); }

  void openDoor(uint32_t ms) { _relayUntil = millis() + ms; _relayOn = true; setRelay(true); }
  bool doorOpen() const { return _relayOn; }
  bool busy() const { return _pat != nullptr; }   // a beep/LED pattern is still playing

  void setIdle(Idle i) { _idle = i; }

  void update() {
    uint32_t now = millis();
    if (_relayOn && (int32_t)(now - _relayUntil) >= 0) { _relayOn = false; setRelay(false); }

    if (_pat) {
      if (_pat[_step].ms && now - _stepAt >= _pat[_step].ms) {
        _step++;
        _stepAt = now;
        if (_pat[_step].ms == 0) { _pat = nullptr; }   // last step reached
        else apply();
      }
      if (_pat) return;
    }

    // idle indication (green also mirrors the open lock)
    bool g = _relayOn, r = false;
    switch (_idle) {
      case IDLE_OK: break;
      case IDLE_SERVER_DOWN: r = (now % 3000) < 60; break;            // short red flash
      case IDLE_ENROLL: { bool ph = (now / 300) % 2; g = ph; r = !ph; } break;
      case IDLE_SETUP: r = (now % 1000) < 500; break;                  // slow red blink
    }
    write(g, r, false);
  }

 private:
  const Step* _pat = nullptr;
  uint8_t _step = 0;
  uint32_t _stepAt = 0;
  uint32_t _relayUntil = 0;
  bool _relayOn = false;
  Idle _idle = IDLE_OK;

  void apply() {
    const Step& s = _pat[_step];
    write(s.g || _relayOn, s.r, s.b);
  }
  static void out(uint8_t pin, bool on, bool activeLow) { digitalWrite(pin, (on ^ activeLow) ? HIGH : LOW); }
  void write(bool g, bool r, bool b) {
    out(PIN_LED_GREEN, g, LED_ACTIVE_LOW);
    out(PIN_LED_RED, r, LED_ACTIVE_LOW);
    out(PIN_BUZZER, b, BUZZER_ACTIVE_LOW);
  }
  void setRelay(bool on) { out(PIN_RELAY, on, RELAY_ACTIVE_LOW); }
};
