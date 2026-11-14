#pragma once

#include <cctype>
#include <cmath>
#include <cstring>
#include <stdint.h>

namespace runner {

constexpr float seaLevelPa = 101325.0f;
constexpr float lowTemperatureC = 35.0f;
constexpr float highTemperatureC = 38.0f;
constexpr float altitudeJumpM = 8.0f;
constexpr uint32_t samplePeriodMs = 1000;
constexpr uint32_t maxSampleGapMs = 2500;
constexpr uint32_t jumpHoldMs = 5000;

enum Alert : uint8_t {
  Normal = 0, TemperatureLow = 1, TemperatureHigh = 2, AltitudeJump = 4, SensorFault = 8
};

inline float altitudeFromPressure(float pressurePa) {
  return 44330.0f * (1.0f - std::pow(pressurePa / seaLevelPa, 1.0f / 5.255f));
}

class AlertTracker {
 public:
  uint8_t update(uint32_t now, bool valid, float temperature, float altitude) {
    if (!valid || !std::isfinite(temperature) || !std::isfinite(altitude)) {
      previousValid = false;
      jumpActive = false;
      return SensorFault;
    }

    if (previousValid && now - previousAt <= maxSampleGapMs
        && std::fabs(altitude - previousAltitude) >= altitudeJumpM) {
      jumpActive = true;
      jumpAt = now;
    }
    previousValid = true;
    previousAt = now;
    previousAltitude = altitude;
    if (jumpActive && now - jumpAt >= jumpHoldMs) jumpActive = false;

    uint8_t flags = Normal;
    if (temperature < lowTemperatureC) flags |= TemperatureLow;
    if (temperature > highTemperatureC) flags |= TemperatureHigh;
    if (jumpActive) flags |= AltitudeJump;
    return flags;
  }

 private:
  bool previousValid = false;
  bool jumpActive = false;
  uint32_t previousAt = 0;
  uint32_t jumpAt = 0;
  float previousAltitude = 0;
};

enum class CommandKind { Auto, Manual, LedOn, LedOff, BuzzerOn, BuzzerOff };

struct Command {
  CommandKind kind;
  char id[9];
};

inline bool parseCommand(const char* payload, size_t length, Command& command) {
  if (length <= 9 || length >= 24 || payload[8] != ':') return false;
  for (size_t i = 0; i < 8; ++i) {
    if (!std::isxdigit(static_cast<unsigned char>(payload[i]))) return false;
  }

  const struct { const char* text; CommandKind kind; } allowed[] = {
    {"auto", CommandKind::Auto}, {"manual", CommandKind::Manual},
    {"led-on", CommandKind::LedOn}, {"led-off", CommandKind::LedOff},
    {"buzzer-on", CommandKind::BuzzerOn}, {"buzzer-off", CommandKind::BuzzerOff}
  };
  for (const auto& entry : allowed) {
    if (length - 9 == std::strlen(entry.text) && std::memcmp(payload + 9, entry.text, length - 9) == 0) {
      command.kind = entry.kind;
      std::memcpy(command.id, payload, 8);
      command.id[8] = '\0';
      return true;
    }
  }
  return false;
}

struct Outputs {
  bool led;
  bool buzzer;
};

class Actuators {
 public:
  bool automatic = true;

  bool apply(CommandKind command) {
    if (command == CommandKind::Auto || command == CommandKind::Manual) {
      const bool nextAuto = command == CommandKind::Auto;
      if (automatic != nextAuto) manual = {false, false};
      automatic = nextAuto;
      return true;
    }
    if (automatic) return false;

    switch (command) {
      case CommandKind::LedOn: manual.led = true; break;
      case CommandKind::LedOff: manual.led = false; break;
      case CommandKind::BuzzerOn: manual.buzzer = true; break;
      case CommandKind::BuzzerOff: manual.buzzer = false; break;
      default: return false;
    }
    return true;
  }

  Outputs get(uint8_t alerts) const {
    if (!automatic) return manual;
    const bool active = alerts != Normal;
    return {active, active};
  }

 private:
  Outputs manual{false, false};
};

}  // namespace runner
