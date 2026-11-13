(function (root) {
  "use strict";

  const limits = Object.freeze({
    period: 20,
    calibrationSamples: 50,
    calibrationDrift: 5,
    impact: 2.5,
    tilt: 60,
    directionChange: 35,
    previousPoseAge: 1000,
    gyro: 25,
    hold: 1000,
    window: 2400,
    maxGap: 100
  });

  function unit(vector, norm) {
    return vector.map((value) => value / norm);
  }

  function angle(first, second) {
    const dot = first.reduce((sum, value, index) => sum + value * second[index], 0);
    return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
  }

  class Detector {
    constructor() {
      this.count = 0;
      this.peak = 0;
      this.lastTime = null;
      this.calibrate();
    }

    calibrate() {
      if (this.state === "ALARM") return false;
      this.state = "CALIBRATING";
      this.reference = null;
      this.lastStable = null;
      this.beforeImpact = null;
      this.firstDirection = null;
      this.calibrationCount = 0;
      this.impactAt = null;
      this.stableAt = null;
      this.held = 0;
      this.decision = "calibration";
      return true;
    }

    fault() {
      if (this.state === "ALARM") return;
      this.calibrate();
      this.state = "SENSOR_FAULT";
      this.lastTime = null;
      this.decision = "sensor_fault";
    }

    acknowledge() {
      if (this.state !== "ALARM") return false;
      this.state = "READY";
      this.impactAt = null;
      this.stableAt = null;
      this.held = 0;
      this.decision = "acknowledged";
      return true;
    }

    sample(now, ax, ay, az, gx, gy, gz) {
      const gravity = Math.hypot(ax, ay, az);
      const gyro = Math.hypot(gx, gy, gz);
      if (!Number.isFinite(gravity) || !Number.isFinite(gyro)) {
        this.fault();
        return this.snapshot(now, null, null, null, null, null, null);
      }

      if (this.state === "SENSOR_FAULT") this.calibrate();
      const gap = this.lastTime === null ? 0 : now - this.lastTime;
      this.lastTime = now;
      if (gap > limits.maxGap && this.state === "VERIFY") this.cancel("sample_gap");
      if (gap > limits.maxGap && this.state === "CALIBRATING") this.calibrationCount = 0;

      const quasiStatic = gravity >= 0.8 && gravity <= 1.2;
      const direction = quasiStatic ? unit([ax, ay, az], gravity) : null;

      if (this.state === "CALIBRATING") {
        if (gravity >= 0.9 && gravity <= 1.1 && gyro < 8) {
          if (this.calibrationCount === 0 || angle(this.firstDirection, direction) > limits.calibrationDrift) {
            this.firstDirection = direction;
            this.calibrationCount = 0;
          }
          if (++this.calibrationCount === limits.calibrationSamples) {
            this.reference = direction;
            this.state = "READY";
            this.decision = "ready";
          }
        } else {
          this.calibrationCount = 0;
        }
      }

      const tilt = direction && this.reference ? angle(this.reference, direction) : null;
      if (this.state === "READY" && gravity >= limits.impact) {
        this.state = "VERIFY";
        this.impactAt = now;
        this.stableAt = null;
        this.held = 0;
        this.peak = gravity;
        this.beforeImpact = this.lastStable && now - this.lastStable.time <= limits.previousPoseAge
          ? this.lastStable.direction : this.reference;
        this.decision = "impact";
      }

      if (this.state === "VERIFY") {
        if (now - this.impactAt > limits.window) {
          this.cancel("timeout");
        } else {
          this.peak = Math.max(this.peak, gravity);
          const stable = tilt !== null && tilt >= limits.tilt && gyro < limits.gyro
            && angle(this.beforeImpact, direction) >= limits.directionChange;
          if (!stable) this.stableAt = null;
          else if (this.stableAt === null) this.stableAt = now;
          this.held = this.stableAt === null ? 0 : now - this.stableAt;
          if (this.held >= limits.hold) {
            this.state = "ALARM";
            this.count++;
            this.decision = "confirmed";
          }
        }
      }

      if (direction && gyro < limits.gyro) this.lastStable = {direction, time: now};

      return this.snapshot(now, ax, ay, az, gravity, gyro, tilt);
    }

    cancel(reason) {
      this.state = "READY";
      this.impactAt = null;
      this.stableAt = null;
      this.held = 0;
      this.decision = reason;
    }

    snapshot(ms, ax, ay, az, accel_g, gyro_dps, tilt_deg) {
      return {
        ms, ax, ay, az, accel_g, gyro_dps, tilt_deg,
        state: this.state,
        decision: this.decision,
        peak_g: this.peak,
        held_ms: this.held,
        event_count: this.count,
        calibration_samples: this.calibrationCount
      };
    }
  }

  function demoSample(scenario, elapsed, clock) {
    const wiggle = Math.sin(clock / 430) * 0.018;
    const magnitude = 1 + Math.sin(clock / 190) * 0.035 + Math.cos(clock / 72) * 0.016;
    if (scenario === "fall") {
      if (elapsed >= 700 && elapsed < 800) return [0, 0, 0.62, 0, 0, 0];
      if (elapsed >= 800 && elapsed < 940) return [0.28, 0, 3.38, 0, 76, 0];
      if (elapsed >= 940 && elapsed < 1200) return [0.78, 0, 0.63, 0, 74, 0];
      if (elapsed >= 1200) return [0.984 + wiggle * 0.05, 0, 0.16, 0, 2.2, 0];
    }
    if (scenario === "bump") {
      if (elapsed >= 800 && elapsed < 940) return [0.10, 0, 3.07, 0, 38, 0];
      if (elapsed >= 940 && elapsed < 1350) return [0.12, 0, 1.07, 0, 14, 0];
    }
    if (scenario === "tilt" && elapsed >= 350) {
      const rotation = Math.min(1.31, (elapsed - 350) / 1150 * 1.31);
      return [Math.sin(rotation), 0, Math.cos(rotation), 0, elapsed < 1500 ? 55 : 2, 0];
    }
    return [wiggle, 0.006, magnitude, 0.9, 1.2, 0.4];
  }

  const api = {Detector, limits, demoSample};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FallModel = api;
}(globalThis));
