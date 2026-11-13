"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {Detector, demoSample, limits} = require("../model.js");
require("../mqtt-wire.js");

const readyPose = [0, 0, 1, 0, 0, 0];
const tilted = [0.984, 0, 0.16, 0, 2.2, 0];
const impact = [0.28, 0, 3.38, 0, 76, 0];
const phases = ["CALIBRATING", "READY", "VERIFY", "ALARM", "SENSOR_FAULT"];
const decisions = ["calibration", "ready", "impact", "confirmed", "timeout", "sample_gap", "sensor_fault", "acknowledged"];
const operations = [];
const expected = [];
const traces = {};
let model;
let time;

function record(command) {
  operations.push(command);
  expected.push([phases.indexOf(model.state), decisions.indexOf(model.decision), model.count, model.held].join(","));
}

function reset() {
  model = new Detector();
  time = 0;
  record("R");
}

function sample(values, gap = limits.period) {
  time += gap;
  const result = model.sample(time, ...values);
  record(["S", time, ...values].join(" "));
  return result;
}

function hold(values, steps) {
  for (let index = 0; index < steps; index++) sample(values);
}

function calibrate() {
  hold(readyPose, limits.calibrationSamples);
  assert.equal(model.state, "READY");
}

const cases = [
  ["Té ngã", "fall", "ALARM", 1],
  ["Va chạm", "bump", "READY", 0],
  ["Nghiêng chậm", "tilt", "READY", 0]
];
for (const [name, scenario, phase, count] of cases) {
  reset();
  calibrate();
  const begin = time;
  const samples = [];
  for (let step = 20; step <= 3800; step += 20) {
    samples.push(sample(demoSample(scenario, step, begin + step)));
  }
  assert.equal(model.state, phase);
  assert.equal(model.count, count);
  traces[scenario] = samples;
  console.log(name + " → " + phase + ", cảnh báo: " + count);
}

reset();
calibrate();
hold(tilted, 70);
sample(impact);
hold(tilted, 135);
assert.equal(model.state, "READY");
assert.equal(model.count, 0);
console.log("Va đập khi đang nghiêng, cùng hướng sau va đập → READY");

reset();
calibrate();
sample(impact);
hold(tilted, 30);
sample(tilted, 120);
hold(tilted, 70);
assert.equal(model.state, "READY");
assert.equal(model.decision, "sample_gap");
assert.equal(model.count, 0);
console.log("Gián đoạn lấy mẫu 120 ms trong VERIFY → READY");

reset();
calibrate();
sample(impact);
hold(tilted, 65);
assert.equal(model.count, 1);
model.fault();
record("F");
assert.equal(model.state, "ALARM");
hold(readyPose, 70);
assert.equal(model.count, 1);
assert.equal(model.acknowledge(), true);
record("A");
assert.equal(model.state, "READY");
assert.equal(model.count, 1);
console.log("Giữ ALARM qua lỗi cảm biến, xác nhận không tăng bộ đếm → READY");

reset();
calibrate();
model.fault();
record("F");
assert.equal(model.state, "SENSOR_FAULT");
hold(readyPose, 49);
assert.equal(model.state, "CALIBRATING");
sample(readyPose);
assert.equal(model.state, "READY");
console.log("Mất cảm biến, phục hồi sau 50 mẫu tĩnh → READY");

if (!process.argv.includes("--web-only")) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fall-detection-"));
  try {
    const executable = path.join(temporary, "detector_trace");
    const compile = spawnSync(process.env.CXX || "g++", [
      "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic",
      path.join(__dirname, "detector_trace.cpp"), "-o", executable
    ], {encoding: "utf8"});
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const result = spawnSync(executable, {input: operations.join("\n") + "\n", encoding: "utf8"});
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const rows = result.stdout.trimEnd().split("\n");
    assert.equal(rows.length, expected.length);
    rows.forEach((row, index) => assert.equal(row, expected[index], operations[index] + " tại dòng " + (index + 1)));
    console.log("JavaScript và C++ khớp " + rows.length + " bước xử lý.");
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

class FakeSocket {
  static OPEN = 1;
  static CLOSING = 2;

  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = 0;
    this.sent = [];
  }

  send(bytes) { this.sent.push([...bytes]); }
  close() { this.readyState = 3; }
  deliver(bytes) { this.onmessage({data: Uint8Array.from(bytes).buffer}); }
}

globalThis.WebSocket = FakeSocket;
const status = [];
const payloads = [];
const root = "falldetection/ndd/test";
const session = new globalThis.MqttWire({
  url: "wss://example.invalid/mqtt", topic: root + "/telemetry",
  status: (state) => status.push(state),
  message: (text) => payloads.push(text)
});
const socket = session.socket;
const topic = Buffer.from(session.topic);
const body = [0, topic.length, ...topic, ...Buffer.from('{"valid":true}')];
socket.readyState = FakeSocket.OPEN;
socket.onopen();
assert.equal(socket.protocol, "mqtt");
assert.equal(socket.sent[0][0], 0x10);
socket.deliver([0x20, 2]);
socket.deliver([0, 0]);
assert.equal(socket.sent[1][0], 0x82);
assert.deepEqual(status, []);
socket.deliver([0x90, 3, 0, 1, 0, 0x31, body.length, ...body]);
assert.deepEqual(status, ["ready"]);
assert.deepEqual(payloads, []);
socket.deliver([0x30, body.length, ...body]);
assert.deepEqual(payloads, ['{"valid":true}']);
assert.equal(session.publish(root + "/cmd", "ack"), true);
assert.equal(socket.sent[2][0], 0x30);
session.stop("manual");
assert.deepEqual(socket.sent[3], [0xe0, 0]);
assert.deepEqual(status, ["ready", "manual"]);
console.log("MQTT: CONNECT, SUBACK, phân mảnh, lọc retained, lệnh và DISCONNECT hợp lệ.");

const traceIndex = process.argv.indexOf("--trace");
if (traceIndex !== -1) fs.writeFileSync(process.argv[traceIndex + 1], JSON.stringify(traces));
