"use strict";

const {limits, flags, altitudeFromPressure, pressureFromAltitude, AlertTracker, Actuators, validTelemetry} = RunnerModel;
const byId = (id) => document.getElementById(id);
const number = (value, digits = 1) => Number.isFinite(value)
  ? value.toLocaleString("vi-VN", {minimumFractionDigits: digits, maximumFractionDigits: digits}) : "—";
const timeLabel = (date) => date.toLocaleTimeString("vi-VN", {hour12: false});
const sessionPattern = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i;
const historyWindow = 90000;
const expiryMs = 60000;
const commandTimeoutMs = 20000;
const demoTracker = new AlertTracker();
const demoOutputs = new Actuators();
const scenarioButtons = [...document.querySelectorAll("[data-scenario]")];
const scenarios = {
  normal: "Nhiệt độ quanh 36,5 °C, áp suất ổn định.",
  high: "Nhiệt độ 39,2 °C, vượt ngưỡng trên.",
  low: "Nhiệt độ 34,0 °C, dưới ngưỡng dưới.",
  jump: "Đổi độ cao khoảng 18 m trong một mẫu."
};

function createStream() {
  return {points: [], events: [], current: null, lastReceivedAt: 0};
}

const demo = createStream();
let live = createStream();
let source = "demo";
let scenario = "normal";
let scenarioAt = 90000;
let simulationMs = 90000;
let baseAltitude = 60;
let connection = null;
let brokerStatus = "offline";
let topicRoot = "";
let pending = null;
let controlMessage = "";

function alertText(value) {
  if (value & flags.fault) return "Lỗi đọc cảm biến BMP180.";
  const messages = [];
  if (value & flags.low) messages.push("Nhiệt độ thấp");
  if (value & flags.high) messages.push("Nhiệt độ cao");
  if (value & flags.jump) messages.push("Độ cao thay đổi đột ngột");
  return messages.join(" · ");
}

function ingest(stream, sample, shownAt = new Date()) {
  const previous = stream.current;
  stream.current = sample;
  stream.lastReceivedAt = Date.now();
  if (previous?.seq === sample.seq) return;
  stream.points.push({...sample, shownAt});
  while (stream.points.length > 128) stream.points.shift();
  const before = previous?.alerts || 0;
  if (sample.alerts !== before && (sample.alerts || before)) {
    stream.events.unshift({date: shownAt, text: alertText(sample.alerts) || "Các chỉ số đã trở về bình thường."});
    stream.events.length = Math.min(stream.events.length, 10);
  }
}

function demoSample(shownAt = new Date()) {
  const elapsed = simulationMs - scenarioAt;
  let temperature = 36.5 + Math.sin(simulationMs / 4300) * 0.24 + Math.sin(simulationMs / 9100) * 0.12;
  if (scenario === "high") temperature = 39.2;
  if (scenario === "low") temperature = 34;
  if (scenario === "jump" && elapsed === 0) baseAltitude += 18;
  const pressure = pressureFromAltitude(baseAltitude + Math.sin(simulationMs / 7000) * 1.4);
  const altitude = altitudeFromPressure(pressure);
  const alerts = demoTracker.update(simulationMs, temperature, altitude);
  ingest(demo, {seq: simulationMs / 1000, ms: simulationMs, t: temperature, p: pressure, h: altitude,
    alerts, ...demoOutputs.get(alerts), ack: "", ok: false}, shownAt);
}

function setText(id, value) {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
}

function renderEvents(stream) {
  const list = byId("event-list");
  if (list.renderedEvents === stream.events[0] && list.renderedStream === stream) return;
  list.renderedEvents = stream.events[0];
  list.renderedStream = stream;
  const nodes = stream.events.map((event) => {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = event.date.toISOString();
    time.textContent = timeLabel(event.date);
    item.append(time, event.text);
    return item;
  });
  if (!nodes.length) {
    const empty = document.createElement("li");
    empty.className = "empty-event";
    empty.textContent = "Chưa ghi nhận cảnh báo.";
    nodes.push(empty);
  }
  list.replaceChildren(...nodes);
}

function freshDevice() {
  return brokerStatus === "ready" && live.current && Date.now() - live.lastReceivedAt < expiryMs;
}

function render() {
  const isDemo = source === "demo";
  const stream = isDemo ? demo : live;
  const fresh = isDemo || freshDevice();
  const data = fresh ? stream.current : null;
  const flagsValue = data?.alerts || 0;
  const label = !data ? "Chờ ESP32" : flagsValue & flags.fault ? "Lỗi cảm biến" : flagsValue ? "Có cảnh báo" : "Bình thường";
  const state = !data ? "unknown" : flagsValue ? "alert" : "normal";
  const nowLabel = isDemo ? "Dữ liệu mô phỏng" : fresh ? "ESP32 trực tuyến"
    : brokerStatus === "ready" ? "Chờ dữ liệu ESP32" : brokerStatus === "connecting" ? "Đang kết nối" : "MQTT ngoại tuyến";

  byId("source-demo").setAttribute("aria-pressed", isDemo);
  byId("source-live").setAttribute("aria-pressed", !isDemo);
  byId("connection-panel").hidden = isDemo;
  byId("scenario-panel").hidden = !isDemo;
  byId("connection-pill").dataset.state = isDemo ? "demo" : fresh ? "live"
    : ["ready", "connecting"].includes(brokerStatus) ? "waiting" : "offline";
  setText("connection-label", nowLabel);
  byId("hero-light").dataset.state = state;
  setText("hero-label", label);

  setText("temperature-value", number(data?.t));
  setText("pressure-value", number(Number.isFinite(data?.p) ? data.p / 100 : null, 2));
  setText("pressure-detail", number(data?.p, 0) + " Pa");
  setText("altitude-value", number(data?.h));
  setText("alert-detail", !data ? "Đang chờ bản tin hợp lệ từ thiết bị." : flagsValue ? alertText(flagsValue) : "Các chỉ số đang trong khoảng thử nghiệm.");
  byId("alert-detail").dataset.state = state;
  setText("sample-age", data ? "Mẫu lúc " + timeLabel(stream.points.at(-1).shownAt) : "—");

  const mode = data?.mode;
  const available = Boolean(data) && !pending;
  byId("mode-auto").disabled = !available;
  byId("mode-manual").disabled = !available;
  byId("mode-auto").setAttribute("aria-pressed", mode === "AUTO");
  byId("mode-manual").setAttribute("aria-pressed", mode === "MANUAL");
  for (const [name, output] of [["led", data?.led], ["buzzer", data?.buzzer]]) {
    byId(name + "-button").disabled = !available || mode !== "MANUAL";
    byId(name + "-button").setAttribute("aria-pressed", output === true);
    setText(name + "-state", output === undefined ? "—" : output ? "Bật" : "Tắt");
  }
  setText("control-message", controlMessage || (!data ? "Kết nối ESP32 để gửi lệnh."
    : mode === "MANUAL" ? "Hai nút điều khiển độc lập." : "Chọn MANUAL để điều khiển từng thiết bị."));
  setText("scenario-hint", scenarios[scenario]);
  scenarioButtons.forEach((button) => button.setAttribute("aria-pressed", button.dataset.scenario === scenario));
  byId("export-button").disabled = !stream.points.length;
  renderEvents(stream);
  drawChart("temperature", stream.points, "t", "#a95234", [limits.low, limits.high]);
  drawChart("altitude", stream.points, "h", "#237b57", []);
}

function drawChart(id, points, metric, color, references) {
  const canvas = byId(id + "-chart");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const end = points.at(-1)?.ms ?? 0;
  const windowPoints = points.map((point) => ({age: (end - point.ms) >>> 0, value: point[metric]}))
    .filter((point) => point.age <= historyWindow);
  const measured = windowPoints.filter((point) => Number.isFinite(point.value));
  byId(id + "-empty").hidden = Boolean(measured.length);
  if (!measured.length) return;

  const values = measured.map((point) => point.value).concat(references);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const scale = Math.max(maximum - minimum, metric === "t" ? 2 : 5);
  const margin = scale * 0.12 + (scale - (maximum - minimum)) / 2;
  const low = minimum - margin;
  const high = maximum + margin;
  const left = width < 300 ? 39 : 48;
  const right = width - 10;
  const top = 12;
  const bottom = height - 24;
  const x = (age) => right - (right - left) * age / historyWindow;
  const y = (value) => bottom - (bottom - top) * (value - low) / (high - low);

  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "#52685b";
  ctx.strokeStyle = "#e2ebe4";
  ctx.textAlign = "right";
  for (let tick = 0; tick <= 4; ++tick) {
    const value = low + (high - low) * tick / 4;
    const py = y(value);
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
    ctx.fillText(number(value, metric === "t" ? 1 : 0), left - 6, py + 3);
  }
  for (const seconds of [90, 60, 30, 0]) {
    const px = x(seconds * 1000);
    ctx.textAlign = seconds === 0 ? "right" : "center";
    ctx.fillText(seconds ? "−" + seconds + "s" : "Hiện tại", px, height - 6);
  }
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#bd7b62";
  for (const value of references) {
    ctx.beginPath();
    ctx.moveTo(left, y(value));
    ctx.lineTo(right, y(value));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  let previous = null;
  for (const point of windowPoints) {
    if (!Number.isFinite(point.value)) {
      previous = null;
      continue;
    }
    const px = x(point.age);
    const py = y(point.value);
    if (previous && previous.age - point.age <= limits.gap) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    previous = point;
  }
  ctx.stroke();
  const last = windowPoints.at(-1);
  if (Number.isFinite(last.value)) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x(last.age), y(last.value), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function stopConnection() {
  const old = connection;
  if (pending) clearTimeout(pending.timer);
  connection = null;
  old?.stop("manual");
  brokerStatus = "offline";
  pending = null;
  controlMessage = "";
  byId("connect-button").disabled = false;
  byId("disconnect-button").hidden = true;
}

function switchSource(next) {
  if (source === next) return;
  source = next;
  controlMessage = "";
  if (next === "demo") {
    stopConnection();
    setText("connection-message", "Đang chờ kết nối.");
  }
  render();
}

function connect(event) {
  event.preventDefault();
  const root = byId("topic-root").value.trim();
  let url;
  try {
    url = new URL(byId("broker-url").value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "wss:" || (local && url.protocol === "ws:")) || url.username || url.password || url.hash) throw new Error("url");
  } catch {
    setText("connection-message", "Nhập địa chỉ WSS hợp lệ, ví dụ wss://broker.emqx.io:8084/mqtt.");
    return;
  }
  if (!sessionPattern.test(root) || root.endsWith("/telemetry") || root.endsWith("/cmd")) {
    setText("connection-message", "Nhập Base topic đầy đủ từ Serial Monitor, bỏ phần /telemetry hoặc /cmd.");
    return;
  }

  stopConnection();
  topicRoot = root;
  live = createStream();
  brokerStatus = "connecting";
  byId("connect-button").disabled = true;
  byId("disconnect-button").hidden = false;
  setText("connection-message", "Đang kết nối tới broker…");
  try {
    const opened = new MqttWire({
      url: url.href, topic: root + "/telemetry",
      message: (payload) => { if (connection === opened) onTelemetry(payload); },
      status: (status) => {
        if (connection !== opened) return;
        if (status === "ready") {
          brokerStatus = "ready";
          setText("connection-message", "Broker đã kết nối. Đang chờ số đo từ ESP32.");
        } else {
          stopConnection();
          const errorText = status === "protocol" ? "Broker từ chối MQTT. Kiểm tra cổng và đường dẫn /mqtt."
            : status === "timeout" ? "Hết thời gian chờ broker. Bấm Kết nối để thử lại."
            : "Mất kết nối broker. Kiểm tra mạng và bấm Kết nối.";
          setText("connection-message", errorText);
        }
        render();
      }
    });
    connection = opened;
  } catch {
    stopConnection();
    setText("connection-message", "Trình duyệt không mở được WebSocket.");
  }
  render();
}

function onTelemetry(payload) {
  let sample;
  try { sample = JSON.parse(payload); } catch { return; }
  if (!validTelemetry(sample)) return;
  const before = live.current;
  if (before && sample.seq !== before.seq && ((sample.seq - before.seq) >>> 0) >= 0x80000000) return;
  if (before && sample.seq === before.seq && sample.ms !== before.ms) return;
  ingest(live, sample);
  if (pending && sample.ack === pending.id) {
    clearTimeout(pending.timer);
    pending = null;
    controlMessage = sample.ok ? "ESP32 đã xác nhận lệnh." : "ESP32 từ chối lệnh. Kiểm tra chế độ MANUAL.";
  }
  setText("connection-message", "Đang nhận dữ liệu từ " + topicRoot + ".");
  render();
}

function sendCommand(command) {
  if (source === "demo") {
    if (!demo.current || !demoOutputs.apply(command)) return;
    demo.current = {...demo.current, ...demoOutputs.get(demo.current.alerts)};
    controlMessage = "";
    render();
    return;
  }
  if (!freshDevice() || pending) return;
  const id = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0");
  if (!connection?.publish(topicRoot + "/cmd", id + ":" + command)) {
    controlMessage = "Chưa gửi được lệnh. Kiểm tra kết nối.";
    render();
    return;
  }
  const timer = setTimeout(() => {
    if (pending?.id !== id) return;
    pending = null;
    controlMessage = "Hết thời gian chờ ESP32 xác nhận.";
    render();
  }, commandTimeoutMs);
  pending = {id, timer};
  controlMessage = "Đang chờ ESP32 xác nhận…";
  render();
}

function exportData() {
  const stream = source === "demo" ? demo : live;
  if (!stream.points.length) return;
  const header = "thoigian_utc,nguon,mau,nhietdo_c,apsuat_pa,docao_m,co_canhbao";
  const rows = stream.points.map((p) => [p.shownAt.toISOString(), source === "demo" ? "SIMULATION" : "ESP32",
    p.seq, p.t?.toFixed(2) ?? "", p.p ?? "", p.h?.toFixed(2) ?? "", p.alerts].join(","));
  const url = URL.createObjectURL(new Blob(["\ufeff" + [header, ...rows].join("\r\n")], {type: "text/csv;charset=utf-8"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = "RunnerMonitor_" + source + ".csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

byId("source-demo").addEventListener("click", () => switchSource("demo"));
byId("source-live").addEventListener("click", () => switchSource("live"));
byId("connection-form").addEventListener("submit", connect);
byId("disconnect-button").addEventListener("click", () => {
  stopConnection();
  setText("connection-message", "Đã ngắt kết nối MQTT.");
  render();
});
byId("mode-auto").addEventListener("click", () => sendCommand("auto"));
byId("mode-manual").addEventListener("click", () => sendCommand("manual"));
byId("led-button").addEventListener("click", () => sendCommand("led-" + ((source === "demo" ? demo : live).current?.led ? "off" : "on")));
byId("buzzer-button").addEventListener("click", () => sendCommand("buzzer-" + ((source === "demo" ? demo : live).current?.buzzer ? "off" : "on")));
byId("export-button").addEventListener("click", exportData);
scenarioButtons.forEach((button) => button.addEventListener("click", () => {
  scenario = button.dataset.scenario;
  scenarioAt = simulationMs + 1000;
  controlMessage = "";
  render();
}));
window.addEventListener("resize", render);
window.addEventListener("pagehide", stopConnection);

const started = Date.now();
for (let i = 0; i <= 90; ++i) {
  simulationMs = i * 1000;
  demoSample(new Date(started - (90 - i) * 1000));
}
render();
setInterval(() => {
  simulationMs += 1000;
  demoSample();
  render();
}, 1000);
