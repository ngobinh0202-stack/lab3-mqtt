#ifndef FALLDETECTION_FALL_DETECTOR_H
#define FALLDETECTION_FALL_DETECTOR_H

#include <math.h>
#include <stdint.h>

struct Motion {
  float ax;
  float ay;
  float az;
  float gx;
  float gy;
  float gz;
};

struct Reading {
  float accel = NAN;
  float gyro = NAN;
  float tilt = NAN;
};

enum class Phase { Calibrating, Ready, Verify, Alarm, Fault };
enum class Decision { Calibration, Ready, Impact, Confirmed, Timeout, Gap, Fault, Ack };

class FallDetector {
 public:
  static constexpr uint32_t periodMs = 20;
  static constexpr uint32_t holdMs = 1000;
  static constexpr uint32_t windowMs = 2400;
  static constexpr uint32_t maxGapMs = 100;
  static constexpr int calibrationSamples = 50;
  static constexpr float impactG = 2.5f;
  static constexpr float minimumTilt = 60.0f;
  static constexpr float directionChange = 35.0f;
  static constexpr uint32_t previousPoseAgeMs = 1000;
  static constexpr float maximumGyro = 25.0f;

  Phase phase = Phase::Calibrating;
  Decision decision = Decision::Calibration;
  uint32_t count = 0;
  uint32_t heldMs = 0;
  float peakG = 0.0f;
  int calibrationCount = 0;

  bool calibrate() {
    if (phase == Phase::Alarm) return false;
    phase = Phase::Calibrating;
    decision = Decision::Calibration;
    calibrationCount = 0;
    hasStable = false;
    holding = false;
    heldMs = 0;
    return true;
  }

  void fault() {
    if (!calibrate()) return;
    phase = Phase::Fault;
    decision = Decision::Fault;
    hasPrevious = false;
  }

  bool acknowledge() {
    if (phase != Phase::Alarm) return false;
    finish(Decision::Ack);
    return true;
  }

  Reading sample(uint32_t now, const Motion& sample) {
    Reading reading;
    reading.accel = magnitude(sample.ax, sample.ay, sample.az);
    reading.gyro = magnitude(sample.gx, sample.gy, sample.gz);
    if (!isfinite(reading.accel) || !isfinite(reading.gyro)) {
      fault();
      return Reading{};
    }

    if (phase == Phase::Fault) calibrate();
    if (hasPrevious && now - lastTime > maxGapMs) {
      if (phase == Phase::Verify) finish(Decision::Gap);
      if (phase == Phase::Calibrating) calibrationCount = 0;
    }
    hasPrevious = true;
    lastTime = now;

    const bool quasiStatic = reading.accel >= 0.8f && reading.accel <= 1.2f;
    Vector direction{};
    if (quasiStatic) {
      direction = {sample.ax / reading.accel, sample.ay / reading.accel, sample.az / reading.accel};
    }

    if (phase == Phase::Calibrating) {
      if (reading.accel >= 0.9f && reading.accel <= 1.1f && reading.gyro < 8.0f) {
        if (calibrationCount == 0 || angle(firstDirection, direction) > 5.0f) {
          firstDirection = direction;
          calibrationCount = 0;
        }
        if (++calibrationCount == calibrationSamples) {
          reference = direction;
          phase = Phase::Ready;
          decision = Decision::Ready;
        }
      } else {
        calibrationCount = 0;
      }
    }

    if (quasiStatic && phase != Phase::Calibrating) reading.tilt = angle(reference, direction);

    if (phase == Phase::Ready && reading.accel >= impactG) {
      phase = Phase::Verify;
      decision = Decision::Impact;
      impactTime = now;
      holding = false;
      heldMs = 0;
      peakG = reading.accel;
      beforeImpact = hasStable && now - lastStableTime <= previousPoseAgeMs ? lastStable : reference;
    }
    if (phase == Phase::Verify) {
      if (now - impactTime > windowMs) {
        finish(Decision::Timeout);
      } else {
        if (reading.accel > peakG) peakG = reading.accel;
        const bool stable = isfinite(reading.tilt) && reading.tilt >= minimumTilt && reading.gyro < maximumGyro
            && angle(beforeImpact, direction) >= directionChange;
        if (stable && !holding) stableTime = now;
        holding = stable;
        heldMs = holding ? now - stableTime : 0;
        if (heldMs >= holdMs) {
          phase = Phase::Alarm;
          decision = Decision::Confirmed;
          count++;
        }
      }
    }
    if (quasiStatic && reading.gyro < maximumGyro) {
      lastStable = direction;
      lastStableTime = now;
      hasStable = true;
    }
    return reading;
  }

 private:
  struct Vector { float x, y, z; };
  Vector firstDirection{};
  Vector reference{};
  Vector lastStable{};
  Vector beforeImpact{};
  bool hasPrevious = false;
  bool hasStable = false;
  bool holding = false;
  uint32_t lastTime = 0;
  uint32_t lastStableTime = 0;
  uint32_t impactTime = 0;
  uint32_t stableTime = 0;

  static float magnitude(float x, float y, float z) {
    return sqrtf(x * x + y * y + z * z);
  }

  static float angle(const Vector& first, const Vector& second) {
    const float dot = first.x * second.x + first.y * second.y + first.z * second.z;
    return acosf(fmaxf(-1.0f, fminf(1.0f, dot))) * 57.2957795f;
  }

  void finish(Decision reason) {
    phase = Phase::Ready;
    decision = reason;
    holding = false;
    heldMs = 0;
  }
};

#endif
