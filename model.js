(function (root) {
  "use strict";

  const limits = Object.freeze({seaLevel: 101325, low: 35, high: 38, jump: 8, gap: 2500, hold: 5000});
  const flags = Object.freeze({low: 1, high: 2, jump: 4, fault: 8});
  const altitudeFromPressure = (p) => 44330 * (1 - (p / limits.seaLevel) ** (1 / 5.255));
  const pressureFromAltitude = (h) => Math.round(limits.seaLevel * (1 - h / 44330) ** 5.255);

  class AlertTracker {
    previous = null;
    jumpAt = null;

    update(ms, temperature, altitude) {
      if (!Number.isFinite(temperature) || !Number.isFinite(altitude)) {
        this.previous = this.jumpAt = null;
        return flags.fault;
      }
      if (this.previous && ((ms - this.previous.ms) >>> 0) <= limits.gap
          && Math.abs(altitude - this.previous.altitude) >= limits.jump) {
        this.jumpAt = ms;
      }
      this.previous = {ms, altitude};
      if (this.jumpAt !== null && ((ms - this.jumpAt) >>> 0) >= limits.hold) this.jumpAt = null;
      return (temperature < limits.low ? flags.low : 0)
        | (temperature > limits.high ? flags.high : 0)
        | (this.jumpAt !== null ? flags.jump : 0);
    }
  }

  class Actuators {
    mode = "AUTO";
    led = false;
    buzzer = false;

    apply(command) {
      if (command === "auto" || command === "manual") {
        const mode = command.toUpperCase();
        if (this.mode !== mode) this.led = this.buzzer = false;
        this.mode = mode;
        return true;
      }
      const match = /^(led|buzzer)-(on|off)$/.exec(command);
      if (this.mode !== "MANUAL" || !match) return false;
      this[match[1]] = match[2] === "on";
      return true;
    }

    get(alerts) {
      if (this.mode === "MANUAL") return {mode: this.mode, led: this.led, buzzer: this.buzzer};
      return {mode: this.mode, led: Boolean(alerts), buzzer: Boolean(alerts)};
    }
  }

  function validTelemetry(sample) {
    const uint32 = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    const between = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
    if (!sample || !uint32(sample.seq) || !uint32(sample.ms)
        || !Number.isInteger(sample.alerts) || sample.alerts < 0 || sample.alerts > 15
        || !["AUTO", "MANUAL"].includes(sample.mode)
        || typeof sample.led !== "boolean" || typeof sample.buzzer !== "boolean"
        || typeof sample.ack !== "string" || !/^(?:[a-f0-9]{8})?$/i.test(sample.ack)
        || typeof sample.ok !== "boolean") return false;
    if (sample.alerts & flags.fault) return sample.t === null && sample.p === null && sample.h === null;
    return between(sample.t, -40.1, 85.1) && Number.isInteger(sample.p)
      && between(sample.p, 29950, 110050) && between(sample.h, -1000, 10000)
      && Math.abs(sample.h - altitudeFromPressure(sample.p)) < 0.1;
  }

  const api = {limits, flags, altitudeFromPressure, pressureFromAltitude, AlertTracker, Actuators, validTelemetry};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RunnerModel = api;
}(globalThis));
