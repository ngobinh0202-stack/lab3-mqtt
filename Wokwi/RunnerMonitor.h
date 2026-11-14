#pragma once

#include <cmath>
#include <cstdint>

namespace runner {

constexpr float seaLevelPa = 101325.0f;
constexpr float minTempC = 15.0f;
constexpr float maxTempC = 35.0f;
constexpr float altitudeJumpM = 10.0f;
constexpr uint32_t samplePeriodMs = 1000;
constexpr uint32_t jumpHoldMs = 5000;

enum Alert : uint8_t { LowTemp = 1, HighTemp = 2, AltitudeJump = 4, SensorError = 8 };
enum class Mode : uint8_t { Auto, Manual };
enum class Target : uint8_t { Mode, Led, Buzzer };

struct AlertData {
  uint32_t seq;
  uint32_t sampledAtMs;
  float tempC;
  float altitudeM;
  bool valid;
};

struct Command {
  Target target;
  bool active;
};

struct Status {
  uint32_t seq = 0;
  uint8_t alerts = 0;
  float deltaM = 0.0f;
  Mode mode = Mode::Auto;
  bool led = false;
  bool buzzer = false;
};

inline float altitudeFromPa(float pressurePa) {
  return 44330.0f * (1.0f - std::pow(pressurePa / seaLevelPa, 0.190295f));
}

class Monitor {
 public:
  const Status &status() const { return current; }

  void update(const AlertData &sample, uint32_t nowMs) {
    current.seq = sample.seq;
    current.deltaM = 0.0f;
    temperatureAlert = 0;
    sensorError = !sample.valid;
    if (sample.valid) {
      if (sample.tempC < minTempC) temperatureAlert = LowTemp;
      else if (sample.tempC > maxTempC) temperatureAlert = HighTemp;

      if (hasPrevious && sample.seq - previous.seq == 1 &&
          sample.sampledAtMs - previous.sampledAtMs <= 2 * samplePeriodMs) {
        current.deltaM = sample.altitudeM - previous.altitudeM;
        if (std::fabs(current.deltaM) >= altitudeJumpM) {
          jumpActive = true;
          lastJumpMs = sample.sampledAtMs;
        }
      }
      previous = sample;
    }
    hasPrevious = sample.valid;
    refresh(nowMs);
  }

  void control(Command command, uint32_t nowMs) {
    if (command.target == Target::Mode) {
      const Mode requested = command.active ? Mode::Manual : Mode::Auto;
      if (current.mode != requested) {
        current.mode = requested;
        manualLed = false;
        manualBuzzer = false;
      }
    } else if (current.mode == Mode::Manual) {
      if (command.target == Target::Led) manualLed = command.active;
      if (command.target == Target::Buzzer) manualBuzzer = command.active;
    }
    refresh(nowMs);
  }

  void refresh(uint32_t nowMs) {
    if (jumpActive && nowMs - lastJumpMs >= jumpHoldMs) jumpActive = false;
    current.alerts = temperatureAlert;
    if (sensorError) current.alerts |= SensorError;
    if (jumpActive) current.alerts |= AltitudeJump;

    bool autoAlert = current.alerts != 0;
    current.led = current.mode == Mode::Auto ? autoAlert : manualLed;
    current.buzzer = current.mode == Mode::Auto ? autoAlert : manualBuzzer;
  }

 private:
  Status current;
  AlertData previous{};
  bool hasPrevious = false;
  bool sensorError = false;
  bool jumpActive = false;
  bool manualLed = false;
  bool manualBuzzer = false;
  uint8_t temperatureAlert = 0;
  uint32_t lastJumpMs = 0;
};

}  // namespace runner
