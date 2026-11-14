"use strict";

const get = id => document.getElementById(id);
const temperatureMin = 15;
const temperatureMax = 35;
const jumpThreshold = 10;
const jumpHoldMs = 5000;
const staleMs = 5000;
const pressureToAltitude = pressureHpa => 44330 * (1 - (pressureHpa / 1013.25) ** 0.190295);
const labels = ["Nhiệt độ dưới 15 °C", "Nhiệt độ trên 35 °C", "Độ cao thay đổi từ 10 m", "Lỗi đọc BMP180"];
const tempFormat = new Intl.NumberFormat("vi-VN", {minimumFractionDigits: 1, maximumFractionDigits: 1});
const readingFormat = new Intl.NumberFormat("vi-VN", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const deltaFormat = new Intl.NumberFormat("vi-VN", {minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero"});

const history = {demo: [], mqtt: []};
const demo = {scenario: "normal", seq: 0, altitudeM: null, jumpAt: null, mode: "AUTO", led: false, buzzer: false};
let source = "demo";
let live = null;
let session = null;
let pending = null;
let commandFeedback = "";

function record(kind, sample) {
  const points = history[kind];
  if (points.at(-1)?.seq === sample.seq) return;
  if (points.length === 60) points.shift();
  points.push(sample);
}

function demoTick(now = Date.now()) {
  const phase = demo.seq / 4;
  const tempC = {normal: 24 + 0.7 * Math.sin(phase), hot: 39, cold: 10, jump: 24}[demo.scenario];
  const pressureHpa = (demo.scenario === "jump" ? 1008.25 : 1013.25) + 0.15 * Math.sin(phase);
  const altitudeM = pressureToAltitude(pressureHpa);
  const deltaM = demo.altitudeM === null ? 0 : altitudeM - demo.altitudeM;
  if (Math.abs(deltaM) >= jumpThreshold) demo.jumpAt = now;
  demo.altitudeM = altitudeM;
  let alerts = tempC < temperatureMin ? 1 : tempC > temperatureMax ? 2 : 0;
  if (demo.jumpAt !== null && now - demo.jumpAt < jumpHoldMs) alerts |= 4;
  record("demo", {seq: ++demo.seq, tempC, pressureHpa, altitudeM, deltaM, alerts, at: now});
  if (source === "demo") render();
}

function render() {
  const isDemo = source === "demo";
  const sample = isDemo ? history.demo.at(-1) : live;
  const online = isDemo || Boolean(session?.client?.ready && live && Date.now() - live.at < staleMs);
  const current = online ? sample : null;
  const mode = isDemo ? demo.mode : current?.mode;
  const led = isDemo ? (mode === "AUTO" ? Boolean(sample?.alerts) : demo.led) : current?.led;
  const buzzer = isDemo ? (mode === "AUTO" ? Boolean(sample?.alerts) : demo.buzzer) : current?.buzzer;

  const sourceLabel = get("source-label");
  sourceLabel.dataset.online = String(!isDemo && online);
  const sourceText = isDemo ? "Mô phỏng trình duyệt" : online ? "ESP32 trực tuyến" : session?.client?.ready ? "Đang chờ ESP32" : "Chưa kết nối ESP32";
  if (sourceLabel.textContent !== sourceText) sourceLabel.textContent = sourceText;

  get("temp-value").textContent = Number.isFinite(current?.tempC) ? tempFormat.format(current.tempC) : "—";
  get("pressure-value").textContent = Number.isFinite(current?.pressureHpa) ? readingFormat.format(current.pressureHpa) : "—";
  get("altitude-value").textContent = Number.isFinite(current?.altitudeM) ? readingFormat.format(current.altitudeM) : "—";
  get("delta-value").textContent = Number.isFinite(current?.deltaM) ? `${deltaFormat.format(current.deltaM)} m` : "—";

  get("alert-panel").dataset.level = !current ? "offline" : current.alerts ? "warning" : "normal";
  get("alert-icon").textContent = !current ? "·" : current.alerts ? "!" : "✓";
  const alertTitle = get("alert-title");
  const title = !current ? "Đang chờ số đo" : current.alerts ? "Cảnh báo" : "Bình thường";
  if (alertTitle.textContent !== title) alertTitle.textContent = title;
  get("alert-detail").textContent = !current ? "Kết nối Base topic của ESP32 để nhận dữ liệu." : current.alerts ? labels.filter((_, i) => current.alerts & (1 << i)).join(" · ") : "Các chỉ số trong ngưỡng cảnh báo.";

  for (const [id, value] of [["mode-auto", "AUTO"], ["mode-manual", "MANUAL"]]) {
    get(id).setAttribute("aria-pressed", String(mode === value));
    get(id).disabled = !online || Boolean(pending);
  }
  for (const [name, active] of [["led", led], ["buzzer", buzzer]]) {
    get(`${name}-button`).setAttribute("aria-pressed", String(active === true));
    get(`${name}-button`).disabled = !online || mode !== "MANUAL" || Boolean(pending);
    get(`${name}-state`).textContent = active === undefined ? "—" : active ? "Bật" : "Tắt";
  }
  const controlHint = !online ? "Chờ dữ liệu để gửi lệnh điều khiển." : mode === "AUTO" ? "Chọn MANUAL để điều khiển riêng LED và còi." : "LED và còi hoạt động theo lệnh bấm.";
  const feedback = get("control-feedback");
  const controlText = commandFeedback || controlHint;
  if (feedback.textContent !== controlText) feedback.textContent = controlText;

  get("mqtt-panel").hidden = isDemo;
  get("demo-panel").hidden = !isDemo;
  get("source-demo").setAttribute("aria-pressed", String(isDemo));
  get("source-mqtt").setAttribute("aria-pressed", String(!isDemo));
  for (const button of document.querySelectorAll("[data-scenario]")) {
    button.setAttribute("aria-pressed", String(demo.scenario === button.dataset.scenario));
  }

  drawHistory(get("temp-chart"), history[source], "tempC", "#c2571a", "#f4a16b77");
  drawHistory(get("altitude-chart"), history[source], "altitudeM", "#215db7", "#86aff877");
}

function acceptLive(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (!message || !Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > 0xffffffff ||
      !["AUTO", "MANUAL"].includes(message.mode) || !Number.isInteger(message.alerts) || message.alerts < 0 || message.alerts > 15 ||
      typeof message.led !== "boolean" || typeof message.buzzer !== "boolean") return;
  const fields = [message.tempC, message.pressureHpa, message.altitudeM, message.deltaM];
  const numbersValid = fields.every(Number.isFinite) && message.tempC >= -41 && message.tempC <= 86 &&
    message.pressureHpa >= 299 && message.pressureHpa <= 1101 && Math.abs(message.altitudeM) < 10000 && Math.abs(message.deltaM) < 20000;
  if (message.alerts & 8 ? fields.some(value => value !== null) : !numbersValid) return;

  const elapsed = live ? (message.seq - live.seq) >>> 0 : 1;
  if (elapsed > 0x7fffffff) return;
  live = {...message, at: Date.now()};
  record("mqtt", live);
  if (pending && live[pending.field] === pending.value) {
    pending = null;
    commandFeedback = "ESP32 đã xác nhận trạng thái.";
  }
  const feedback = get("mqtt-feedback");
  if (feedback.textContent !== "Đang nhận bản tin từ ESP32.") feedback.textContent = "Đang nhận bản tin từ ESP32.";
  render();
}

function closeSession() {
  const old = session;
  session = null;
  if (old) {
    clearTimeout(old.retry);
    old.client?.stop("manual");
  }
  live = null;
  pending = null;
  commandFeedback = "";
  history.mqtt.length = 0;
  get("disconnect-button").hidden = true;
  get("connect-button").textContent = "Kết nối";
  get("mqtt-feedback").textContent = "Chép Base topic từ Serial Monitor trong Wokwi.";
}

function connect(config) {
  if (session !== config) return;
  get("mqtt-feedback").textContent = "Đang kết nối MQTT…";
  try {
    config.client = new MqttWire({
      url: config.url,
      topic: `${config.base}/telemetry`,
      status(reason) {
        if (session !== config) return;
        if (reason === "ready") {
          get("mqtt-feedback").textContent = "Broker đã kết nối. Đang chờ bản tin ESP32.";
        } else {
          live = null;
          if (pending) commandFeedback = "Mất kết nối khi đang chờ ESP32 xác nhận.";
          pending = null;
          get("mqtt-feedback").textContent = "Mất kết nối broker. Thử lại sau 4 giây…";
          config.retry = setTimeout(() => connect(config), 4000);
        }
        render();
      },
      message: acceptLive
    });
  } catch {
    closeSession();
    get("mqtt-feedback").textContent = "Không mở được WebSocket. Kiểm tra địa chỉ broker.";
  }
  render();
}

function command(field, value) {
  if (source === "demo") {
    if (field === "mode" && demo.mode !== value) {
      demo.mode = value;
      demo.led = false;
      demo.buzzer = false;
    } else if (field !== "mode" && demo.mode === "MANUAL") {
      demo[field] = value;
    }
  } else {
    if (!session?.client?.ready || !live || Date.now() - live.at >= staleMs || pending || live[field] === value) return;
    if (field !== "mode" && live.mode !== "MANUAL") return;
    const token = field === "mode" ? value : value ? "ON" : "OFF";
    if (session.client.publish(`${session.base}/cmd/${field}`, token)) {
      pending = {field, value, sentAt: Date.now()};
      commandFeedback = "Đã gửi lệnh. Đang chờ ESP32 xác nhận…";
    } else {
      commandFeedback = "Gửi lệnh thất bại.";
    }
  }
  render();
}

get("mqtt-form").addEventListener("submit", event => {
  event.preventDefault();
  closeSession();
  const base = get("base-topic").value.trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(get("broker-url").value.trim()); } catch {}
  if (!url || !["ws:", "wss:"].includes(url.protocol) || (location.protocol === "https:" && url.protocol !== "wss:") ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) {
    get("mqtt-feedback").textContent = "Kiểm tra URL WebSocket và Base topic trong Serial Monitor.";
    render();
    return;
  }
  session = {base, url: url.href};
  get("connect-button").textContent = "Kết nối lại";
  get("disconnect-button").hidden = false;
  connect(session);
});

get("disconnect-button").addEventListener("click", () => { closeSession(); render(); });
get("source-demo").addEventListener("click", () => { source = "demo"; closeSession(); render(); });
get("source-mqtt").addEventListener("click", () => { source = "mqtt"; render(); });
get("mode-auto").addEventListener("click", () => command("mode", "AUTO"));
get("mode-manual").addEventListener("click", () => command("mode", "MANUAL"));
get("led-button").addEventListener("click", () => command("led", !(source === "demo" ? demo.led : live?.led)));
get("buzzer-button").addEventListener("click", () => command("buzzer", !(source === "demo" ? demo.buzzer : live?.buzzer)));
get("scenario-buttons").addEventListener("click", event => {
  const scenario = event.target.closest("button")?.dataset.scenario;
  if (!scenario || scenario === demo.scenario) return;
  demo.scenario = scenario;
  demoTick();
});

new ResizeObserver(() => render()).observe(get("temp-chart"));
document.fonts.ready.then(render);

const startedAt = Date.now();
for (let offset = 16; offset >= 0; offset--) demoTick(startedAt - offset * 1000);
setInterval(() => {
  demoTick();
  if (source === "mqtt") {
    if (pending && Date.now() - pending.sentAt >= 3500) {
      pending = null;
      commandFeedback = "Chưa có xác nhận từ ESP32. Có thể gửi lại lệnh.";
    }
    const expired = "Chưa nhận được bản tin ESP32 mới trong 5 giây.";
    const feedback = get("mqtt-feedback");
    if (live && Date.now() - live.at >= staleMs && feedback.textContent !== expired) feedback.textContent = expired;
    render();
  }
}, 1000);
