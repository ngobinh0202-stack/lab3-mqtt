"use strict";

const {Detector, limits, demoSample} = globalThis.FallModel;
const byId = (id) => document.getElementById(id);
const scenarios = {
  fall: "Té ngã",
  bump: "Va chạm",
  tilt: "Nghiêng chậm"
};
const phases = {
  CALIBRATING: ["Đang hiệu chuẩn", "Giữ cảm biến đứng yên để lấy tư thế chuẩn.", "waiting"],
  READY: ["Đang theo dõi", "Đã lấy tư thế chuẩn. Thuật toán đang chờ tín hiệu va đập.", "healthy"],
  VERIFY: ["Đang xác minh", "Đã ghi nhận va đập. Thuật toán kiểm tra độ nghiêng, độ đổi hướng và thời gian giữ tư thế.", "warning"],
  ALARM: ["Phát hiện té ngã", "Va đập đi kèm tư thế nghiêng ổn định. Cảnh báo được giữ đến khi xác nhận.", "alarm"],
  SENSOR_FAULT: ["Lỗi cảm biến", "Kiểm tra kết nối I²C với MPU6050. Hệ thống sẽ hiệu chuẩn lại khi cảm biến hồi phục.", "warning"]
};
const decisionText = {
  impact: "Phát hiện va đập, bắt đầu xác minh.",
  confirmed: "Đủ điều kiện xác minh, đã bật cảnh báo.",
  timeout: "Hết thời gian xác minh, cảnh báo không kích hoạt.",
  sample_gap: "Gián đoạn lấy mẫu, đã hủy xác minh.",
  acknowledged: "Đã xác nhận và xóa cảnh báo.",
  sensor_fault: "Mất tín hiệu cảm biến MPU6050.",
  ready: "Đã lưu tư thế chuẩn."
};
const number = new Intl.NumberFormat("vi-VN", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const asNumber = (value) => Number.isFinite(value) ? number.format(value) : "—";
const wallTime = new Intl.DateTimeFormat("vi-VN", {hour: "2-digit", minute: "2-digit", second: "2-digit"});
const duration = 16000;
const modeDemo = {sample: null, samples: [], events: []};
const modeLive = {sample: null, samples: [], events: []};

let source = "demo";
let selectedMetric = "accel";
let activeScenario = null;
let scenarioResult = "";
let broker = null;
let activeTopic = "";
let lastPacketAt = 0;
let brokerState = "idle";
let pendingCommand = "";
let commandTimeout;
let receivePeakAt = null;

const detector = new Detector();
let simTime = 0;
let batchPeak = 0;
const plot = byId("motion-chart");
const context = plot.getContext("2d");
const scenarioButtons = [...document.querySelectorAll("[data-scenario]")];

function mode() {
  return source === "demo" ? modeDemo : modeLive;
}

function liveFresh() {
  return brokerState === "ready" && modeLive.sample !== null && Date.now() - lastPacketAt <= 4000;
}

function addEvent(target, text, severity = "", sample = target.sample) {
  target.events.unshift({
    when: new Date(),
    text,
    severity,
    source: target === modeDemo ? "MO_PHONG" : sample?.source === "TEST" ? "ESP32_TEST" : "ESP32",
    deviceTime: sample?.ms ?? null,
    peak: sample?.peak_g ?? null
  });
  target.events.length = Math.min(80, target.events.length);
  if (target === mode()) renderHistory();
}

function renderHistory() {
  const target = mode();
  const list = byId("event-list");
  list.replaceChildren(...target.events.slice(0, 5).map((event) => {
    const item = document.createElement("li");
    const indicator = document.createElement("span");
    const text = document.createElement("span");
    const time = document.createElement("time");
    item.className = "event-item " + event.severity;
    indicator.className = "dot";
    indicator.setAttribute("aria-hidden", "true");
    text.textContent = event.text;
    time.dateTime = event.when.toISOString();
    time.textContent = wallTime.format(event.when);
    item.append(indicator, text, time);
    return item;
  }));
  byId("export-button").disabled = target.events.length === 0;
  byId("history-note").textContent = target.events.length
    ? "Hiện tối đa 5 dòng gần nhất. CSV chứa tối đa 80 dòng của phiên này."
    : source === "demo" ? "Chọn một kịch bản để xem kết quả xác minh." : "Nhật ký sẽ hiện khi ESP32 đổi trạng thái.";
}

function appendSample(target, sample) {
  const previous = target.sample;
  target.sample = sample;
  target.samples.push(sample);
  const cutoff = sample.ms - duration - 1500;
  while (target.samples.length > 200 || target.samples[0]?.ms < cutoff) target.samples.shift();
  if (!previous || previous.state !== sample.state || previous.decision !== sample.decision) {
    const text = decisionText[sample.decision];
    if (text && (source === "live" || activeScenario || sample.decision === "acknowledged")) {
      const prefix = sample.source === "TEST" ? "TEST · " : "";
      const detail = sample.decision === "confirmed" ? " Đỉnh va đập " + asNumber(sample.peak_g) + " g." : "";
      addEvent(target, prefix + text + detail, sample.state === "ALARM" ? "alarm" : sample.state === "VERIFY" ? "warning" : "", sample);
    }
  }
}

function render() {
  const isDemo = source === "demo";
  const fresh = isDemo || liveFresh();
  const sample = fresh ? mode().sample : null;
  const [title, detail, style] = sample ? phases[sample.state]
    : brokerState === "ready" ? ["Chờ ESP32", "Broker đã kết nối. Đang chờ số đo mới từ thiết bị.", "waiting"]
    : ["Chưa kết nối", "Nhập thông tin MQTT để nhận trạng thái thiết bị.", "waiting"];

  byId("source-demo").setAttribute("aria-pressed", isDemo);
  byId("source-live").setAttribute("aria-pressed", !isDemo);
  byId("connection-panel").hidden = isDemo;
  byId("scenario-panel").hidden = !isDemo;
  byId("device-controls").hidden = isDemo;
  byId("chart-source").textContent = isDemo ? "Mô phỏng" : sample?.source === "TEST" ? "ESP32 · dữ liệu thử" : "ESP32 / MQTT";
  byId("counter-caption").textContent = isDemo ? "Trong phiên mô phỏng" : "Từ lúc ESP32 khởi động";
  const badge = byId("connection-badge");
  badge.className = "badge " + (isDemo || fresh ? "neutral" : brokerState === "ready" || brokerState === "connecting" ? "pending" : "offline");
  byId("connection-label").textContent = isDemo ? "Mô phỏng trình duyệt"
    : fresh ? "ESP32 trực tuyến" : brokerState === "ready" ? "Broker đã kết nối" : brokerState === "connecting" ? "Đang kết nối" : "MQTT ngoại tuyến";

  byId("accel-value").textContent = asNumber(sample?.accel_g);
  byId("tilt-value").textContent = asNumber(sample?.tilt_deg);
  byId("gyro-value").textContent = asNumber(sample?.gyro_dps);
  byId("count-value").textContent = sample?.event_count ?? (isDemo ? 0 : "—");
  byId("device-state").className = "panel state-panel " + style;
  if (byId("status-title").textContent !== title) byId("status-title").textContent = title;
  byId("status-detail").textContent = sample?.state === "CALIBRATING"
    ? detail + " " + sample.calibration_samples + "/" + limits.calibrationSamples + " mẫu."
    : isDemo && sample?.state === "READY" && activeScenario
      ? "Đang chạy kịch bản " + scenarios[activeScenario.name].toLowerCase() + ". Theo dõi số đo và biểu đồ."
    : isDemo && sample?.state === "READY" && scenarioResult ? scenarioResult
    : sample?.state === "READY" && sample.decision === "timeout" ? "Đã kết thúc xác minh. Tư thế sau va đập chưa đạt điều kiện cảnh báo."
    : sample?.state === "READY" && sample.decision === "sample_gap" ? "Đã hủy xác minh vì mẫu bị gián đoạn."
    : detail;
  const held = Math.min(sample?.held_ms ?? 0, limits.hold);
  byId("hold-progress").value = held;
  byId("progress-value").textContent = asNumber(held / 1000) + " / 1,00 s";
  byId("ack-button").hidden = sample?.state !== "ALARM";
  byId("ack-button").disabled = Boolean(pendingCommand);
  byId("calibrate-button").disabled = sample?.state !== "READY" || sample?.source === "TEST" || Boolean(pendingCommand);
  byId("device-test-button").disabled = sample?.state !== "READY" || sample?.source === "TEST" || Boolean(pendingCommand);
  byId("device-note").textContent = !sample ? "Chờ thiết bị gửi dữ liệu."
    : pendingCommand ? "Đang chờ thiết bị xác nhận lệnh."
    : "LED " + (sample.led ? "đang cảnh báo" : "tắt") + " · Còi " + (sample.buzzer ? "đang cảnh báo" : "tắt");
  scenarioButtons.forEach((button) => {
    button.disabled = Boolean(activeScenario) || sample?.state === "ALARM";
    button.setAttribute("aria-pressed", button.dataset.scenario === activeScenario?.name);
  });
  draw();
}

function draw() {
  const bounds = plot.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = bounds.width;
  const height = bounds.height;
  if (plot.width !== Math.round(width * ratio) || plot.height !== Math.round(height * ratio)) {
    plot.width = Math.round(width * ratio);
    plot.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const data = mode().samples;
  const noData = data.length === 0;
  byId("chart-empty").hidden = !noData;
  if (noData) return;

  const accel = selectedMetric === "accel";
  const points = data.map((sample) => ({
    ms: sample.ms,
    value: accel ? sample.chart_g ?? sample.accel_g : sample.tilt_deg
  }));
  const latest = points[points.length - 1].ms;
  const left = 39;
  const right = width - 12;
  const top = 16;
  const bottom = height - 28;
  const maxValue = accel ? Math.max(4, Math.ceil(Math.max(...points.map((p) => p.value ?? 0)))) : 180;
  const color = accel ? "#63e5c2" : "#c7b5ff";
  const x = (ms) => right - (latest - ms) * (right - left) / duration;
  const y = (value) => bottom - value / maxValue * (bottom - top);

  context.font = "11px Inter, system-ui, sans-serif";
  context.fillStyle = "#91a5bf";
  context.lineWidth = 1;
  context.strokeStyle = "#233145";
  context.textBaseline = "middle";
  context.textAlign = "right";
  for (let index = 0; index <= 4; index++) {
    const value = maxValue * index / 4;
    const row = y(value);
    context.beginPath();
    context.moveTo(left, row);
    context.lineTo(right, row);
    context.stroke();
    const label = accel ? value.toLocaleString("vi-VN", {maximumFractionDigits: 1}) + " g" : value + "°";
    context.fillText(label, left - 6, row);
  }
  for (let seconds = -16; seconds <= 0; seconds += 4) {
    const column = x(latest + seconds * 1000);
    context.beginPath();
    context.moveTo(column, top);
    context.lineTo(column, bottom);
    context.stroke();
    context.textAlign = seconds === 0 ? "right" : "center";
    context.fillText(seconds === 0 ? "0 s" : "−" + Math.abs(seconds) + " s", column, bottom + 15);
  }
  context.save();
  context.beginPath();
  context.rect(left, top - 2, right - left + 1, bottom - top + 4);
  context.clip();
  context.strokeStyle = "#f3b775";
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(left, y(accel ? limits.impact : limits.tilt));
  context.lineTo(right, y(accel ? limits.impact : limits.tilt));
  context.stroke();
  context.setLineDash([]);

  const fill = context.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, accel ? "#63e5c25a" : "#c7b5ff44");
  fill.addColorStop(1, accel ? "#63e5c207" : "#c7b5ff06");
  let segment = [];
  const flush = () => {
    if (segment.length === 0) return;
    context.beginPath();
    context.moveTo(segment[0][0], segment[0][1]);
    segment.slice(1).forEach(([column, row]) => context.lineTo(column, row));
    context.lineTo(segment[segment.length - 1][0], bottom);
    context.lineTo(segment[0][0], bottom);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.beginPath();
    context.moveTo(segment[0][0], segment[0][1]);
    segment.slice(1).forEach(([column, row]) => context.lineTo(column, row));
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.stroke();
    if (segment.length === 1) {
      context.beginPath();
      context.arc(segment[0][0], segment[0][1], 2, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    }
    segment = [];
  };
  let previousTime = null;
  for (const point of points) {
    if (previousTime !== null && point.ms - previousTime > (source === "demo" ? 250 : 1600)) flush();
    if (Number.isFinite(point.value)) segment.push([x(point.ms), y(point.value)]);
    else flush();
    previousTime = point.ms;
  }
  flush();
  context.restore();
}

function selectMetric(value) {
  selectedMetric = value;
  const accel = value === "accel";
  byId("chart-accel").setAttribute("aria-pressed", accel);
  byId("chart-tilt").setAttribute("aria-pressed", !accel);
  byId("legend-label").textContent = accel ? "Gia tốc tổng" : "Góc nghiêng";
  byId("threshold-label").textContent = accel ? "Ngưỡng va đập 2,5 g" : "Ngưỡng tư thế 60°";
  document.querySelector(".legend-line").classList.toggle("tilt", !accel);
  plot.setAttribute("aria-label", accel ? "Biểu đồ gia tốc theo thời gian" : "Biểu đồ góc nghiêng theo thời gian");
  draw();
}

function setSource(value) {
  if (value === source) return;
  if (value === "demo" && broker) stopLive();
  source = value;
  renderHistory();
  render();
}

function simulateTick(updateDisplay = true) {
  for (let step = 0; step < 5; step++) {
    simTime += limits.period;
    const elapsed = activeScenario ? simTime - activeScenario.start : 0;
    const sample = detector.sample(simTime, ...demoSample(activeScenario?.name, elapsed, simTime));
    batchPeak = Math.max(batchPeak, sample.accel_g ?? 0);
    if (step === 4) {
      sample.chart_g = batchPeak;
      batchPeak = 0;
      appendSample(modeDemo, sample);
    }
  }
  if (activeScenario && simTime - activeScenario.start >= 3800) {
    if (activeScenario.name === "tilt") {
      scenarioResult = "Góc nghiêng tăng nhưng gia tốc chưa đạt ngưỡng va đập.";
      addEvent(modeDemo, "Nghiêng chậm · không có va đập, cảnh báo không kích hoạt.");
    } else if (activeScenario.name === "bump") {
      scenarioResult = "Có va đập nhưng tư thế sau va đập chưa đạt điều kiện cảnh báo.";
      addEvent(modeDemo, "Va chạm · đã kết thúc, không phát cảnh báo.");
    }
    activeScenario = null;
  }
  if (source === "demo" && updateDisplay) render();
}

function playScenario(name) {
  if (source !== "demo" || activeScenario || detector.state !== "READY" || !scenarios[name]) return;
  scenarioResult = "";
  activeScenario = {name, start: simTime};
  addEvent(modeDemo, "Bắt đầu kịch bản " + scenarios[name].toLowerCase() + ".", "warning");
  render();
}

function setBrokerStatus(next) {
  brokerState = next;
  const descriptions = {
    idle: "Đang chờ kết nối.",
    connecting: "Đang mở WebSocket và đăng ký topic…",
    ready: "Đã đăng ký topic. Đang chờ bản tin hợp lệ từ ESP32.",
    manual: "Đã ngắt kết nối.",
    closed: "Broker đã đóng kết nối. Bấm Kết nối để thử lại.",
    error: "Không mở được WebSocket. Kiểm tra địa chỉ broker và mạng.",
    timeout: "Quá thời gian chờ MQTT. Bấm Kết nối để thử lại.",
    protocol: "Broker từ chối kết nối hoặc trả về gói MQTT không hợp lệ."
  };
  byId("connection-status").textContent = descriptions[next];
  byId("connect-button").textContent = next === "connecting" || next === "ready" ? "Ngắt kết nối" : "Kết nối";
  if (next !== "ready") {
    lastPacketAt = 0;
    pendingCommand = "";
    clearTimeout(commandTimeout);
  }
  render();
}

function stopLive() {
  const connection = broker;
  broker = null;
  connection?.stop("manual");
  setBrokerStatus("manual");
}

function connectLive(event) {
  event.preventDefault();
  if (brokerState === "connecting" || brokerState === "ready") {
    stopLive();
    return;
  }
  const url = byId("broker-url").value.trim();
  const topic = byId("base-topic").value.trim();
  let address;
  try {
    address = new URL(url);
  } catch {
    byId("connection-status").textContent = "Địa chỉ WebSocket chưa hợp lệ.";
    return;
  }
  if (!["ws:", "wss:"].includes(address.protocol) || address.username || address.password || address.hash) {
    byId("connection-status").textContent = "Nhập URL ws:// hoặc wss:// của broker.";
    return;
  }
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(topic) || topic.length > 100) {
    byId("connection-status").textContent = "Base topic chỉ dùng chữ, số, dấu /, _ và -.";
    return;
  }
  if (activeTopic !== topic) {
    modeLive.events = [];
    renderHistory();
  }
  activeTopic = topic;
  receivePeakAt = null;
  modeLive.sample = null;
  modeLive.samples = [];
  setBrokerStatus("connecting");
  try {
    broker = new globalThis.MqttWire({
      url: address.href,
      topic: topic + "/telemetry",
      status: setBrokerStatus,
      message: onTelemetry
    });
  } catch {
    broker = null;
    setBrokerStatus("error");
  }
}

function validTelemetry(sample) {
  if (!sample || !Object.hasOwn(phases, sample.state) || !["MPU6050", "TEST"].includes(sample.source)) return false;
  const finiteOrNull = (value, max) => value === null || Number.isFinite(value) && value >= 0 && value <= max;
  return Number.isInteger(sample.ms) && sample.ms >= 0 && sample.ms <= 4294967295
    && Number.isInteger(sample.event_count) && sample.event_count >= 0
    && Number.isInteger(sample.calibration_samples) && sample.calibration_samples >= 0 && sample.calibration_samples <= 50
    && Number.isInteger(sample.held_ms) && sample.held_ms >= 0
    && finiteOrNull(sample.accel_g, 14) && finiteOrNull(sample.gyro_dps, 900)
    && finiteOrNull(sample.tilt_deg, 180) && finiteOrNull(sample.peak_g, 14)
    && typeof sample.led === "boolean" && typeof sample.buzzer === "boolean"
    && ["calibration", "ready", "impact", "confirmed", "timeout", "sample_gap", "sensor_fault", "acknowledged"].includes(sample.decision);
}

function onTelemetry(payload) {
  let sample;
  try {
    sample = JSON.parse(payload);
  } catch {
    return;
  }
  if (!validTelemetry(sample)) return;
  const previous = modeLive.sample;
  if (previous && sample.ms <= previous.ms) {
    if (previous.ms - sample.ms < 4000) return;
    modeLive.sample = null;
    modeLive.samples = [];
    receivePeakAt = null;
  }
  if (sample.impact_ms !== null && Number.isInteger(sample.impact_ms) && sample.impact_ms !== receivePeakAt
      && Number.isFinite(sample.peak_g) && sample.peak_g >= limits.impact) {
    receivePeakAt = sample.impact_ms;
    sample.chart_g = sample.peak_g;
  }
  lastPacketAt = Date.now();
  appendSample(modeLive, sample);
  if ((pendingCommand === "ack" && sample.state !== "ALARM")
      || (pendingCommand === "calibrate" && sample.state === "CALIBRATING")
      || (pendingCommand === "test" && sample.source === "TEST")) {
    pendingCommand = "";
    clearTimeout(commandTimeout);
  }
  byId("connection-status").textContent = "Đã nhận số đo từ " + activeTopic + ".";
  if (source === "live") render();
}

function sendCommand(command) {
  if (!liveFresh() || pendingCommand) return;
  if (!broker?.publish(activeTopic + "/cmd", command)) return;
  pendingCommand = command;
  commandTimeout = setTimeout(() => {
    pendingCommand = "";
    byId("connection-status").textContent = "Chưa nhận xác nhận. Kiểm tra thiết bị rồi thử lại.";
    render();
  }, 4000);
  render();
}

function exportHistory() {
  const target = mode();
  if (target.events.length === 0) return;
  const quote = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const header = "thoi_diem_utc,nguon,thoi_gian_mau_ms,dinh_g,noi_dung";
  const rows = target.events.slice().reverse().map((event) =>
    [event.when.toISOString(), event.source, event.deviceTime, event.peak, event.text].map(quote).join(","));
  const url = URL.createObjectURL(new Blob(["\uFEFF" + [header, ...rows].join("\r\n")], {type: "text/csv;charset=utf-8"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = "FallDetection_" + source + ".csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

byId("source-demo").addEventListener("click", () => setSource("demo"));
byId("source-live").addEventListener("click", () => setSource("live"));
byId("chart-accel").addEventListener("click", () => selectMetric("accel"));
byId("chart-tilt").addEventListener("click", () => selectMetric("tilt"));
byId("connection-form").addEventListener("submit", connectLive);
byId("export-button").addEventListener("click", exportHistory);
byId("calibrate-button").addEventListener("click", () => sendCommand("calibrate"));
byId("device-test-button").addEventListener("click", () => sendCommand("test"));
byId("ack-button").addEventListener("click", () => {
  if (source === "live") sendCommand("ack");
  else if (detector.acknowledge()) {
    activeScenario = null;
    simulateTick();
  }
});
scenarioButtons.forEach((button) => button.addEventListener("click", () => playScenario(button.dataset.scenario)));
window.addEventListener("resize", draw);
window.addEventListener("pagehide", () => broker?.stop("manual"));

for (let index = 0; index < 132; index++) simulateTick(false);
renderHistory();
render();
setInterval(() => {
  simulateTick();
  if (source === "live" && brokerState === "ready" && !liveFresh()) {
    if (modeLive.sample) byId("connection-status").textContent = "Mất dữ liệu từ ESP32. Kiểm tra Serial Monitor hoặc Base topic.";
    render();
  }
}, 100);
