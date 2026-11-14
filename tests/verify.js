"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {AlertTracker, Actuators, altitudeFromPressure, validTelemetry} = require("../model.js");
require("../mqtt-wire.js");

let tracker;
let actuators;
let active;
const transcript = [];
const expected = [];

function reset() {
  tracker = new AlertTracker();
  actuators = new Actuators();
  active = 0;
  transcript.push("reset");
}

function output(prefix = "") {
  const state = actuators.get(active);
  expected.push(prefix + [active, Number(state.mode === "AUTO"), Number(state.led), Number(state.buzzer)].join(" "));
}

function sample(ms, temperature, altitude, flags) {
  const valid = temperature !== null;
  transcript.push(["sample", ms, Number(valid), temperature ?? 0, altitude ?? 0].join(" "));
  active = tracker.update(ms, temperature, altitude);
  assert.equal(active, flags);
  output();
}

function command(index, accepted, led, buzzer) {
  const commands = ["auto", "manual", "led-on", "led-off", "buzzer-on", "buzzer-off"];
  transcript.push("cmd " + index);
  assert.equal(actuators.apply(commands[index]), accepted);
  const state = actuators.get(active);
  assert.equal(state.led, led);
  assert.equal(state.buzzer, buzzer);
  output(Number(accepted) + " ");
}

reset();
sample(0, 36.5, 60, 0);
sample(1000, 35, 61, 0);
sample(2000, 38, 62, 0);
sample(3000, 39.2, 62, 2);
sample(4000, 34, 62, 1);
sample(5000, 36.5, 69.99, 0);
sample(6000, 39.2, 77.99, 6);
sample(7000, 36.5, 77.99, 4);
sample(10000, 36.5, 77.99, 4);
sample(11000, 36.5, 77.99, 0);
sample(12000, 36.5, 61, 4);
sample(13000, null, null, 8);
sample(14000, 36.5, 500, 0);
sample(17000, 36.5, 60, 0);
command(2, false, false, false);
command(1, true, false, false);
command(2, true, true, false);
command(4, true, true, true);
command(3, true, false, true);
command(1, true, false, true);
command(5, true, false, false);
sample(18000, 39.2, 60, 2);
command(0, true, true, true);
sample(19000, 36.5, 60, 0);
command(1, true, false, false);

reset();
sample(0xfffffff0, 36.5, 60, 0);
sample(984, 36.5, 80, 4);
sample(1984, 36.5, 81, 4);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runner-core-"));
try {
  const binary = path.join(tmp, "runner-core");
  const compile = spawnSync(process.env.CXX || "g++", [
    "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic",
    path.join(__dirname, "runner_core.cpp"), "-o", binary
  ], {encoding: "utf8"});
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(binary, {encoding: "utf8", input: transcript.join("\n") + "\n"});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const [bmp, altitude, ...actual] = run.stdout.trim().split("\n");
  assert.equal(bmp, "BMP180 15.0 69964");
  altitude.split(" ").slice(1).map(Number).forEach((measured, index) => {
    assert.ok(Math.abs(measured - altitudeFromPressure([101325, 100600, 100384][index])) < 0.01);
  });
  assert.deepEqual(actual, expected);
  console.log("BMP180: ví dụ Bosch cho 15,0 °C và 69.964 Pa; công thức độ cao khớp.");
  console.log("FreeRTOS logic: " + actual.length + " bước cảnh báo/điều khiển khớp giữa C++ và JS.");
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

const telemetry = {seq: 50, ms: 50000, t: 36.5, p: 100600, h: 60.52, alerts: 0,
  mode: "AUTO", led: false, buzzer: false, ack: "", ok: false};
assert.ok(validTelemetry(telemetry));
assert.ok(validTelemetry({...telemetry, t: null, p: null, h: null, alerts: 8}));
assert.equal(validTelemetry({...telemetry, alerts: 8}), false);
assert.equal(validTelemetry({...telemetry, h: 0}), false);
assert.equal(validTelemetry({...telemetry, ack: "invalid"}), false);

class FakeSocket {
  static OPEN = 1;
  static CLOSING = 2;
  readyState = 0;
  sent = [];
  constructor(url, protocol) { this.url = url; this.protocol = protocol; }
  send(bytes) { this.sent.push([...bytes]); }
  close() { this.readyState = 3; }
  deliver(bytes) { this.onmessage({data: Uint8Array.from(bytes).buffer}); }
}
globalThis.WebSocket = FakeSocket;

const states = [];
const messages = [];
const root = "runner/lab3/a1b2c3d4";
const mqtt = new globalThis.MqttWire({url: "wss://example.invalid/mqtt",
  topic: root + "/telemetry", message: (value) => messages.push(JSON.parse(value)), status: (value) => states.push(value)});
const socket = mqtt.socket;
assert.equal(socket.protocol, "mqtt");
socket.readyState = FakeSocket.OPEN;
socket.onopen();
assert.equal(socket.sent[0][0], 0x10);
socket.deliver([0x20, 2]);
socket.deliver([0, 0]);
assert.equal(socket.sent[1][0], 0x82);
socket.deliver([0x90, 3, 0, 1, 0]);
const topic = Buffer.from(mqtt.topic);
const body = [0, topic.length, ...topic, ...Buffer.from(JSON.stringify(telemetry))];
const remaining = [body.length % 128 | 128, Math.floor(body.length / 128)];
socket.deliver([0x31, ...remaining, ...body]);
assert.deepEqual(messages, []);
socket.deliver([0x30, ...remaining, ...body.slice(0, 75)]);
socket.deliver(body.slice(75));
assert.deepEqual(messages, [telemetry]);
assert.ok(mqtt.publish(root + "/cmd", "5ee1bb9a:led-on"));
assert.equal(socket.sent[2][0], 0x30);
assert.match(Buffer.from(socket.sent[2]).toString(), /runner\/lab3\/a1b2c3d4\/cmd5ee1bb9a:led-on$/);
mqtt.stop("manual");
assert.deepEqual(states, ["ready", "manual"]);
assert.deepEqual(socket.sent[3], [0xe0, 0]);
console.log("MQTT: kiểm tra đăng ký, phân mảnh, retained, gói lệnh và ngắt kết nối.");
