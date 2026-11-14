"use strict";

function drawHistory(canvas, history, field, color, fill) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = "#4e627b";

  const values = history.map(sample => sample[field]).filter(Number.isFinite);
  if (!values.length) {
    ctx.textAlign = "center";
    ctx.fillText("Đang chờ số đo", width / 2, height / 2);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const roughStep = Math.max((max - min) / 3, field === "tempC" ? 0.5 : 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const increment = [1, 2, 5, 10].find(base => base * magnitude >= roughStep) * magnitude;
  const lower = Math.floor(min / increment) * increment - (min === max ? increment : 0);
  const upper = Math.max(lower + increment * 3, Math.ceil(max / increment) * increment);
  const plot = { left: 48, right: width - 12, top: 10, bottom: height - 24 };
  const firstTime = history[0].at;
  const duration = Math.max(history.at(-1).at - firstTime, 1000);
  const xAt = time => plot.left + (time - firstTime) / duration * (plot.right - plot.left);
  const yAt = value => plot.bottom - (value - lower) / (upper - lower) * (plot.bottom - plot.top);

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#e2e9f3";
  const tickFormat = new Intl.NumberFormat("vi-VN", {maximumFractionDigits: 1});
  for (let tick = lower; tick <= upper + increment / 10; tick += increment) {
    const y = yAt(tick);
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(tickFormat.format(tick), plot.left - 7, y);
  }

  const timeFormat = new Intl.DateTimeFormat("vi-VN", {hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false});
  const timeTicks = Math.min(4, Math.floor(duration / 1000) + 1, history.length);
  for (let tick = 0; tick < timeTicks; tick++) {
    const ratio = tick / Math.max(timeTicks - 1, 1);
    ctx.textAlign = tick === 0 ? "left" : tick === timeTicks - 1 ? "right" : "center";
    ctx.fillText(timeFormat.format(firstTime + ratio * duration), xAt(firstTime + ratio * duration), height - 9);
  }

  const segments = [[]];
  let previousTime = firstTime;
  for (const sample of history) {
    if ((!Number.isFinite(sample[field]) || sample.at - previousTime > 4500) && segments.at(-1).length) {
      segments.push([]);
    }
    if (Number.isFinite(sample[field])) segments.at(-1).push([xAt(sample.at), yAt(sample[field])]);
    previousTime = sample.at;
  }

  const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
  gradient.addColorStop(0, fill);
  gradient.addColorStop(1, "#ffffff00");
  for (const points of segments) {
    if (!points.length) continue;
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.lineTo(points.at(-1)[0], plot.bottom);
    ctx.lineTo(points[0][0], plot.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const point of points.slice(1)) ctx.lineTo(...point);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.25;
    ctx.lineJoin = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(...points.at(-1), 3.2, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }
}
