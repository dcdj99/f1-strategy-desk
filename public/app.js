import {
  HAM, simulateGhost, realStrategy, validateStrategy, progressAt, classify, tyreAt, tyreModelLap,
  realProgress, ghostProgress, timeAtGhostLaps, raceOdds, pitLoss, inWindow,
} from "./sim.js";
import { buildSummary, builtInRadio, builtInDebrief, timeLapRadio, stintSpans as spans } from "./engineer.js";

const $ = (id) => document.getElementById(id);
const [race, BANK, CONFIG] = await Promise.all([
  fetch("data/race.json").then((r) => r.json()),
  fetch("data/engineer.json").then((r) => r.json()),
  // Opus writes the radio only when the server is set up for it; otherwise the built-in lines play.
  fetch("api/config").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]);
const TOTAL = race.race.total_laps;
const VSC = new Set(race.race.neutralised_laps);
const driverByNum = Object.fromEntries(race.drivers.map((d) => [d.num, d]));
const REAL_STINTS = realStrategy(race);
const REAL_POS = driverByNum[HAM].final_pos;
const EVENTS = race.events || [];

// ---------------------------------------------------------------- state
const state = {
  stints: REAL_STINTS.map((s) => ({ ...s })),
  ghost: null,
  t: 0,
  playing: false,
  running: false,
  finished: false,
  speed: 60,
  radio: [],        // queued messages {t, lap, from, text, shown}, played at race time t
  ai: null,         // engineer response once it arrives
  summary: null,
  odds: null,       // finishing positions over many reruns with different passing luck
  note: "",         // one-off message under the timeline
};
const MAX_STINTS = 4;
const ODDS_RUNS = 200;

const timeline = (num) => race.timelines[String(num)] || [];
const leaderFinish = Math.min(
  ...race.drivers.map((d) => timeline(d.num)).filter((b) => b.length >= TOTAL).map((b) => b[TOTAL - 1][1]),
);
const raceEnd = Math.max(...Object.values(race.timelines).map((b) => (b.length ? b[b.length - 1][1] : 0)));

// Stopped before the flag (car leaves the map).
function retired(num) {
  const b = timeline(num);
  return b.length < TOTAL && b[b.length - 1][1] < leaderFinish;
}

// Stopped short of 90% race distance: not classified.
function outOfRace(num) {
  return retired(num) && timeline(num).length < Math.floor(0.9 * TOTAL);
}

// In the pit lane, from the car-position feed. The ghost drives Hamilton's real run down it.
const realInPit = (num, t) => inWindow(race.pit_windows?.[String(num)], t);
const ghostInPit = (t) => inWindow(state.ghost?.pitWindows, t);
// The replay slows to this while you or Hamilton are in the pit lane, so the stop can be seen.
const PIT_SPEED = 8;

// A retired car stays on the map where it stopped for this long, so you can see what brought out the VSC.
const STOPPED_SHOWN_S = 180;
const stopOf = (num) => (retired(num) ? race.retired?.[String(num)] : null);

// Moments pointed out on the map at the car involved: a car going off (the stewards' messages, which
// come a minute or more later, give the time) and a car stopping.
const CALLOUTS = [];
for (const e of EVENTS) {
  const code = driverByNum[e.driver]?.code;
  if (e.kind === "incident" && e.at != null && !CALLOUTS.some((c) => c.num === e.driver && c.t === e.at)) {
    CALLOUTS.push({ t: e.at, num: e.driver, what: e.what });
  } else if (e.kind === "out") {
    CALLOUTS.push({ t: e.t, num: e.driver, what: e.text.replace(`${code} `, "") });
  }
}
// Each stays up about three seconds on screen, longer at slow replay speeds.
const calloutsAt = (t) => CALLOUTS.filter((c) => t >= c.t && t < c.t + Math.max(8, 3 * state.speed));

// A pit-lane starter waiting at the pit exit: where it really was (laps), or null once it has joined.
function startAt(num, t) {
  const s = race.pit_lane_starts?.[String(num)];
  return s && t < s.join ? s.at[Math.max(0, Math.floor(t))] / 10000 : null;
}

// ---------------------------------------------------------------- track geometry
const canvas = $("track");
const ctx = canvas.getContext("2d");
const trackLayer = document.createElement("canvas");
let geo = null;

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  trackLayer.width = canvas.width;
  trackLayer.height = canvas.height;

  const pts = race.track.map(([f, x, y]) => [f, x, -y]);
  // Leave the right-hand pit-wall column (gap, tyres, ticker, radio) clear on wide screens.
  const wall = r.width > 900 ? 22 * 16 + 48 : 30;
  const pad = { top: 130 * dpr, bottom: 40 * dpr, left: 40 * dpr, right: wall * dpr };
  const W = canvas.width - pad.left - pad.right;
  const H = canvas.height - pad.top - pad.bottom;
  let best = null;
  for (let deg = 0; deg < 180; deg += 3) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [, x, y] of pts) {
      const rx = x * c - y * s, ry = x * s + y * c;
      minX = Math.min(minX, rx); maxX = Math.max(maxX, rx); minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
    }
    const scale = Math.min(W / (maxX - minX), H / (maxY - minY));
    if (!best || scale > best.scale) best = { c, s, scale, minX, maxX, minY, maxY };
  }
  const { c, s, scale, minX, maxX, minY, maxY } = best;
  const ox = pad.left + (W - (maxX - minX) * scale) / 2;
  const oy = pad.top + (H - (maxY - minY) * scale) / 2;
  const toCanvas = (x, y) => [ox + (x * c - y * s - minX) * scale, oy + (x * s + y * c - minY) * scale];
  geo = {
    dpr,
    pts: pts.map(([f, x, y]) => [f, ...toCanvas(x, y)]),
    lane: [],
    // Labels stay clear of the pit-wall column; the main straight runs right beside it.
    labelRight: canvas.width - pad.right + 12 * dpr,
  };
  // The pit lane runs within 18 m of the track, a few pixels at this scale. Push it out from the
  // track (keeping its shape) so it reads as its own lane.
  const lane = (race.pit_lane || []).map(([f, x, y]) => [f, ...toCanvas(x, -y)]);
  const off = lane.map(([f, x, y]) => { const [tx, ty] = pointAt(f); return [x - tx, y - ty]; });
  const widest = Math.max(0, ...off.map(([dx, dy]) => Math.hypot(dx, dy)));
  const k = widest ? Math.max(1, (20 * dpr) / widest) : 1;
  geo.lane = lane.map(([f], i) => { const [tx, ty] = pointAt(f); return [f, tx + off[i][0] * k, ty + off[i][1] * k]; });
  drawTrackLayer(false);
}

// A point along a polyline of [fraction, x, y], clamped to its ends.
function along(p, frac) {
  let lo = 0, hi = p.length - 1;
  if (frac <= p[0][0]) return [p[0][1], p[0][2]];
  if (frac >= p[hi][0]) return [p[hi][1], p[hi][2]];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid][0] <= frac) lo = mid; else hi = mid;
  }
  const k = (frac - p[lo][0]) / (p[hi][0] - p[lo][0] || 1);
  return [p[lo][1] + (p[hi][1] - p[lo][1]) * k, p[lo][2] + (p[hi][2] - p[lo][2]) * k];
}

// On the racing line, `laps` round.
function pointAt(laps) {
  return along(geo.pts, ((laps % 1) + 1) % 1);
}

// In the pit lane, `laps` round. Its points run from before the line (0.95) to past it (1.08).
function lanePoint(laps) {
  const L = geo.lane;
  let f = ((laps % 1) + 1) % 1;
  if (f < 0.5) f += 1;
  if (!L.length || f < L[0][0] || f > L[L.length - 1][0]) return pointAt(laps);
  return along(L, f);
}

let trackVsc = null;
function drawTrackLayer(vsc) {
  trackVsc = vsc;
  const g = trackLayer.getContext("2d");
  const d = geo.dpr;
  g.clearRect(0, 0, trackLayer.width, trackLayer.height);
  g.lineJoin = "round";
  g.lineCap = "round";
  const path = new Path2D();
  geo.pts.forEach(([, x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();

  // Pit lane, under the track so it merges where it splits off and rejoins.
  if (geo.lane.length) {
    const lane = new Path2D();
    geo.lane.forEach(([, x, y], i) => (i ? lane.lineTo(x, y) : lane.moveTo(x, y)));
    g.strokeStyle = "#1a2c50";
    g.lineWidth = 12 * d;
    g.stroke(lane);
    g.strokeStyle = "#8a9bc2";
    g.lineWidth = 1.5 * d;
    g.setLineDash([5 * d, 4 * d]);
    g.stroke(lane);
    g.setLineDash([]);
    // Name it near the entry, on the side away from the track, clear of the cars' labels in the pit box.
    const [f, lx, ly] = geo.lane[Math.round(geo.lane.length * 0.15)];
    const [tx, ty] = pointAt(f);
    const n = Math.hypot(lx - tx, ly - ty) || 1;
    g.font = `600 ${12 * d}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    g.fillStyle = "#8a9bc2";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("Pit lane", lx + ((lx - tx) / n) * 26 * d, ly + ((ly - ty) / n) * 26 * d);
  }

  g.strokeStyle = "#1a2c50";
  g.lineWidth = 22 * d;
  g.stroke(path);
  g.strokeStyle = "#22375f";
  g.lineWidth = 16 * d;
  g.stroke(path);

  g.shadowColor = vsc ? "rgba(255,181,71,0.9)" : "rgba(243,238,221,0.75)";
  g.shadowBlur = 14 * d;
  g.strokeStyle = vsc ? "#ffb547" : "#f3eedd";
  g.lineWidth = 2 * d;
  g.stroke(path);
  g.shadowBlur = 0;

  // Start/finish line
  const [x0, y0] = pointAt(0);
  const [x1, y1] = pointAt(0.004);
  const ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
  g.strokeStyle = "#ffffff";
  g.lineWidth = 3 * d;
  g.beginPath();
  g.moveTo(x0 - Math.cos(ang) * 14 * d, y0 - Math.sin(ang) * 14 * d);
  g.lineTo(x0 + Math.cos(ang) * 14 * d, y0 + Math.sin(ang) * 14 * d);
  g.stroke();
}

// ---------------------------------------------------------------- drawing cars
function drawCar(x, y, r, fill, opts = {}) {
  const d = geo.dpr;
  ctx.save();
  if (opts.glow) { ctx.shadowColor = opts.glow; ctx.shadowBlur = 20 * d; }
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r * d, 0, Math.PI * 2);
  ctx.fill();
  if (opts.ring) { ctx.shadowBlur = 0; ctx.strokeStyle = opts.ring; ctx.lineWidth = 2 * d; ctx.stroke(); }
  ctx.restore();
}

// A ring round a car something has just happened to.
function drawCallout(x, y) {
  const d = geo.dpr;
  ctx.save();
  ctx.strokeStyle = "#ffb547";
  ctx.lineWidth = 2.5 * d;
  ctx.beginPath();
  ctx.arc(x, y, 13 * d, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// A cross over a car that has stopped.
function drawStopped(x, y) {
  const d = geo.dpr, r = 4 * d;
  ctx.save();
  ctx.strokeStyle = "#f3eedd";
  ctx.lineWidth = 2 * d;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(x, y, text, color, dy = -18, size = 16) {
  const d = geo.dpr;
  ctx.save();
  ctx.font = `600 ${size * d}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  ctx.textAlign = "center";
  // Keep long labels on the canvas.
  const half = ctx.measureText(text).width / 2 + 6 * d;
  x = Math.max(half, Math.min(Math.min(canvas.width, geo.labelRight) - half, x));
  ctx.lineWidth = 4 * d;
  ctx.strokeStyle = "rgba(8,18,39,0.9)";
  ctx.strokeText(text, x, y + dy * d);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + dy * d);
  ctx.restore();
}

function render() {
  const t = state.t;
  const vscNow = state.running && vscActive(t);
  if (vscNow !== trackVsc) drawTrackLayer(vscNow);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(trackLayer, 0, 0);

  const gp = state.ghost ? ghostProgress(race, state.ghost, t) : null;
  // Hamilton and your ghost, on the racing line or in the pit lane.
  const rp = realProgress(race, HAM, t);
  const realPit = realInPit(HAM, t);
  const [rx, ry] = realPit ? lanePoint(rp) : pointAt(rp);
  const ghostPit = gp !== null && ghostInPit(t);
  const [gx, gy] = gp === null ? [rx, ry] : ghostPit ? lanePoint(gp) : pointAt(gp);

  let leader = null, ahead = null, behind = null;
  const pitLaneStart = [];
  const calls = state.running ? calloutsAt(t) : [];
  const callLabels = [];
  for (const d of race.drivers) {
    if (d.num === HAM) continue;
    const b = timeline(d.num);
    if (!b.length) continue;
    const done = t > b[b.length - 1][1];
    // A retired car runs on after its last lap until it stops, then stays there a while.
    const stop = stopOf(d.num);
    if (done && retired(d.num) && !(stop && t < stop.t + STOPPED_SHOWN_S)) continue;
    const stopped = stop && t >= stop.t;
    const p = realProgress(race, d.num, t);
    // Pit-lane starters wait at the pit exit until the field has gone past.
    const waiting = startAt(d.num, t);
    const pit = (!done && realInPit(d.num, t)) || (stop?.pit != null && t >= stop.pit);
    const [x, y] = waiting !== null ? lanePoint(waiting) : pit ? lanePoint(p) : pointAt(p);
    drawCar(x, y, 5.5, d.colour, { alpha: stopped ? 0.6 : done && !stop ? 0.35 : 0.9 });
    if (stopped) drawStopped(x, y);
    const call = calls.find((c) => c.num === d.num);
    if (call) {
      drawCallout(x, y);
      callLabels.push({ x, y, text: `${d.code} ${call.what}` });
    }
    if (waiting !== null) pitLaneStart.push({ p, x, y, code: d.code });
    else if (state.running && pit && !stopped && !call) drawLabel(x, y, `${d.code} pit`, "#ffb547", -14, 13);
    if (stopped) continue;
    if (!leader || p > leader.p) leader = { p, x, y, code: d.code };
    if (gp !== null && !done) {
      if (p > gp && p - gp < 0.15 && (!ahead || p < ahead.p)) ahead = { p, x, y, code: d.code, pit };
      if (p < gp && gp - p < 0.15 && (!behind || p > behind.p)) behind = { p, x, y, code: d.code, pit };
    }
  }
  // Under-car labels, skipping any that would land on one already drawn (the field is bunched at the start).
  const placed = [{ x: rx, y: ry }, { x: gx, y: gy }];
  const underLabel = (n, text, color, size = 14) => {
    if (placed.some((q) => Math.hypot(q.x - n.x, q.y - n.y) < 28 * geo.dpr)) return;
    placed.push(n);
    drawLabel(n.x, n.y, text, color, 22, size);
  };
  // What just happened to a car: above it, or below it when you and Hamilton are labelled close by.
  for (const c of callLabels) {
    const nearUs = [[rx, ry], [gx, gy]].some(([qx, qy]) => Math.hypot(qx - c.x, qy - c.y) < 40 * geo.dpr);
    drawLabel(c.x, c.y, c.text, "#ffb547", nearUs ? 24 : -20, 14);
    placed.push(c);
  }
  if (pitLaneStart.length) {
    const last = pitLaneStart.reduce((a, c) => (c.p < a.p ? c : a));
    underLabel(last, `${pitLaneStart.map((c) => c.code).join(" ")} from pit lane`, "#ffb547", 13);
  }
  if (leader && t > 0) underLabel(leader, `P1 ${leader.code}`, "#f3eedd");
  // Cars in the pit lane already carry a "pit" label with their name.
  for (const n of [ahead, behind]) if (n && !n.pit && n.code !== leader?.code) underLabel(n, n.code, "#a9b3c7");

  // The real Hamilton, on Ferrari's strategy
  drawCar(rx, ry, 8, "#e8112d", { ring: "#ffffff" });
  const hamCall = calls.find((c) => c.num === HAM);
  if (hamCall) drawCallout(rx, ry);
  const realLabel = state.running && realPit ? "Hamilton (pit)" : hamCall ? `Hamilton ${hamCall.what}` : "Hamilton";

  // Your ghost Hamilton
  if (state.ghost) {
    drawCar(gx, gy, 9, "rgba(212,232,255,0.92)", { glow: "rgba(212,232,255,0.95)" });
    // Where the ghost is driving Hamilton's real lap, it went off with him.
    const youToo = hamCall && state.ghost.traffic[Math.floor(progressAt(timeline(HAM), hamCall.t))]?.mode === "lewis";
    if (youToo) drawCallout(gx, gy);
    const info = state.running && t < state.ghost.finish ? state.ghost.traffic[Math.floor(progressAt(state.ghost.bounds, t))] : null;
    const stuck = info?.held ? `You (stuck behind ${info.held}${info.chance ? `, ${Math.round(info.chance * 100)}% a lap to pass` : ""})` : null;
    const youLabel = ghostPit ? "You (pit)" : youToo ? `You ${hamCall.what}` : stuck || "You";
    if (Math.hypot(gx - rx, gy - ry) < 40 * geo.dpr) {
      drawLabel((gx + rx) / 2, Math.min(gy, ry), youToo && !ghostPit && !realPit ? `You + Hamilton ${hamCall.what}` : `${youLabel} + ${realLabel}`, "#f3eedd");
    } else {
      drawLabel(rx, ry, realLabel, "#ff8b95");
      drawLabel(gx, gy, youLabel, "#d4e8ff");
    }
  } else {
    drawLabel(rx, ry, realLabel, "#ff8b95");
  }
}

function vscActive(t) {
  let on = false;
  for (const e of EVENTS) {
    if (e.t > t) break;
    if (e.kind === "vsc") on = true;
    if (e.kind === "vsc_end") on = false;
  }
  return on;
}

function currentLeaderLap(t) {
  let best = 0;
  for (const num of Object.keys(race.timelines)) best = Math.max(best, progressAt(race.timelines[num], t));
  return Math.min(TOTAL, Math.floor(best) + 1);
}

// ---------------------------------------------------------------- HUD
const towerList = $("tower-list");
function updateTower() {
  const t = state.t;
  const rows = [];
  for (const d of race.drivers) {
    const b = timeline(d.num);
    if (!b.length) continue;
    const done = t > b[b.length - 1][1];
    const p = done ? b.length : realProgress(race, d.num, t);
    rows.push({ num: d.num, code: d.code, colour: d.colour, p, finishedAt: done ? b[b.length - 1][1] : Infinity, out: done && outOfRace(d.num) });
  }
  const order = (a, b) => (a.out - b.out) || (b.p - a.p) || (a.finishedAt - b.finishedAt);
  rows.sort(order);
  rows.forEach((r, i) => (r.pos = i + 1));

  if (state.ghost) {
    const gb = state.ghost.bounds;
    const done = t > gb[gb.length - 1][1];
    const ghostRow = {
      num: "you", code: "YOU", colour: "#d4e8ff", you: true, out: false,
      p: done ? gb.length : ghostProgress(race, state.ghost, t), finishedAt: done ? gb[gb.length - 1][1] : Infinity,
    };
    ghostRow.pos = rows.filter((r) => r.num !== HAM && order(r, ghostRow) < 0).length + 1;
    const idx = rows.findIndex((r) => order(r, ghostRow) > 0);
    rows.splice(idx < 0 ? rows.length : idx, 0, ghostRow);
  }

  towerList.innerHTML = rows.map((r) => {
    const cls = [r.you ? "you" : "", r.num === HAM ? "ham" : "", r.out ? "out" : ""].join(" ");
    const note = r.you ? "you" : r.num === HAM ? "real" : r.out ? "out" : "";
    return `<li class="${cls}"><span class="pos">${r.you ? "P" + r.pos : r.pos}</span><span class="bar" style="background:${r.colour}"></span>` +
      `<span class="code">${r.code}</span><span class="note">${note}</span></li>`;
  }).join("");
}

function tyreHud(who, stints, progress) {
  const lap = Math.min(TOTAL, Math.floor(progress) + 1);
  const ty = tyreAt(stints, lap);
  const loss = tyreModelLap(race.model, lap, ty.compound, ty.age) - tyreModelLap(race.model, lap, ty.compound, 0);
  const c = $(`tyre-${who}-c`);
  c.className = `compound ${ty.compound.toLowerCase()}`;
  c.textContent = ty.compound[0];
  const w = $(`tyre-${who}-w`);
  w.style.width = `${Math.max(4, 100 - (loss / 4) * 100)}%`;
  w.classList.toggle("cliff", ty.age > race.model.cliff_at[ty.compound]);
  $(`tyre-${who}-a`).textContent = `${ty.age} laps`;
}

function updateHud() {
  const t = state.t;
  const leaderLap = state.running ? currentLeaderLap(t) : 0;
  $("lap-now").textContent = leaderLap;
  $("vsc-flag").hidden = !(state.running && vscActive(t));
  updateTicker();
  updatePlayhead();
  if (!state.ghost) return;

  const realB = timeline(HAM);
  const gp = progressAt(state.ghost.bounds, t);
  const rp = progressAt(realB, t);
  tyreHud("you", state.stints, gp);
  tyreHud("real", REAL_STINTS, rp);

  const k = Math.min(Math.floor(gp), Math.floor(rp));
  const delta = $("delta");
  if (k >= 1) {
    const gap = state.ghost.bounds[k - 1][1] - realB[k - 1][1];
    delta.hidden = false;
    delta.classList.toggle("behind", gap > 0.05);
    $("delta-value").textContent = `${gap > 0.05 ? "+" : gap < -0.05 ? "−" : ""}${Math.abs(gap).toFixed(1)}s`;
    $("delta-label").textContent = gap > 0.05 ? "behind Ferrari's call" : gap < -0.05 ? "ahead of Ferrari's call" : "level with Ferrari's call";
  } else {
    delta.hidden = true;
  }

  // Radio: show messages once their moment has come (works when scrubbing backwards too).
  let changed = false;
  for (const m of state.radio) {
    const show = m.t <= t;
    if (m.shown !== show) { m.shown = show; changed = true; }
  }
  if (changed) renderRadio();
}

let tickerKey = "";
function updateTicker() {
  const happened = state.running ? EVENTS.filter((e) => e.t <= state.t) : [];
  const recent = happened.slice(-3);
  const key = recent.map((e) => e.t).join(",");
  if (key === tickerKey) return;
  tickerKey = key;
  $("ticker").innerHTML = recent.map((e) =>
    `<li class="${e.kind}"><span class="tlap">Lap ${e.lap}</span><span class="ttext" title="${escapeHtml(e.text)}">${escapeHtml(shortEvent(e.text))}</span></li>`).join("");
}

// Stewards' wording is long; the ticker gets one line.
function shortEvent(text) {
  return text
    .replace("leaving the track and gaining an advantage", "off track")
    .replace("reviewed no further investigation", "no investigation")
    .replace("will be investigated after the race", "investigation after the race");
}

function renderRadio() {
  const shown = state.radio.filter((m) => m.shown).slice(-3);
  $("radio").innerHTML = shown.map((m) =>
    `<li class="${m.from}"><span class="from">${m.from === "engineer" ? "Pit wall" : "Car 44"}, ${m.lap > TOTAL ? "flag" : `lap ${m.lap}`}</span>${escapeHtml(m.text)}</li>`,
  ).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- timeline
const ruler = $("ruler");
const tl = $("timeline");
const pct = (lap) => `${((lap - 1) / TOTAL) * 100}%`;
const compoundName = (c) => (c === "SOFT" ? "Soft" : "Medium");

const stintSpans = (stints) => spans(stints, TOTAL);

function renderRuler() {
  const st = state.stints;
  let html = "";
  const v = [...VSC].sort((a, b) => a - b);
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    html += `<span class="vsc" title="Virtual safety car, laps ${v[i]}–${v[j]}: boxing at the end of lap ${v[j] - v[i] > 1 ? `${v[i]}–${v[j] - 1}` : v[i]} is cheaper" style="left:${pct(v[i])};width:${((v[j] - v[i] + 1) / TOTAL) * 100}%"></span>`;
    i = j;
  }
  for (const s of stintSpans(st)) {
    html += `<div class="stint ${s.compound.toLowerCase()}" style="left:${pct(s.from)};width:${(s.laps / TOTAL) * 100}%">${compoundName(s.compound)} ${s.laps}</div>`;
  }
  st.slice(1).forEach((s, i) => {
    html += `<button class="pit" data-i="${i + 1}" style="left:${pct(s.from)}" ` +
      `aria-label="Stop ${i + 1}: box at the end of lap ${s.from - 1}. Arrow keys move it, Delete removes it."><span>Box ${s.from - 1}</span></button>`;
  });
  ruler.innerHTML = html;
  renderSheet();

  const v2 = validateStrategy(race, st);
  const msgs = [...v2.problems];
  if (v2.dsq) msgs.push("Only one tyre compound: the stewards will disqualify you.");
  if (state.note) msgs.push(state.note);
  $("warn").textContent = msgs.join(" ");
  $("race").disabled = !v2.ok;
  $("add-stop").disabled = st.length >= MAX_STINTS;

  // Planning shows the pit sheet; racing shows the replay controls.
  $("controls").dataset.mode = state.running ? "race" : "plan";
  $("pitsheet").hidden = state.running;
  $("playback").hidden = !state.running;
  $("ruler-hint").textContent = state.running
    ? "Drag along the timeline to jump to any lap."
    : st.length >= MAX_STINTS ? "Drag a stop to move it. Three stops is the limit." : "Click the bar to add a stop. Drag a stop to move it.";
  tl.classList.toggle("scrubbable", state.running);
  tl.classList.toggle("addable", !state.running && st.length < MAX_STINTS);
  if (state.running) $("add-hint").hidden = true;
}

function tyrePick(i, compound, label) {
  return `<span class="tyre-pick" role="radiogroup" aria-label="${label}">` +
    ["SOFT", "MEDIUM"].map((c) =>
      `<button role="radio" class="chip ${c.toLowerCase()}" data-key="tyre-${i}-${c}" data-act="tyre" data-i="${i}" data-c="${c}" ` +
      `aria-checked="${c === compound}">${compoundName(c)}</button>`).join("") +
    `</span>`;
}

// One row per stop: when to box, which tyres go on, and a way to take it out again.
function renderSheet() {
  const keep = document.activeElement?.dataset?.key;
  const st = state.stints;
  let html = `<li class="stop"><span class="stop-name">Start</span><span class="stop-lap"></span>${tyrePick(0, st[0].compound, "Starting tyres")}</li>`;
  st.slice(1).forEach((s, k) => {
    const i = k + 1;
    const lap = s.from - 1;
    const loss = pitLoss(race, lap);
    const cheap = loss < race.model.pit_loss_green - 0.5;
    html += `<li class="stop${cheap ? " cheap" : ""}">` +
      `<span class="stop-name">Stop ${i}</span>` +
      `<span class="stop-lap">` +
      `<button class="nudge" data-key="nudge-${i}-earlier" data-act="nudge" data-i="${i}" data-d="-1" aria-label="Stop ${i} a lap earlier">‹</button>` +
      `<span class="lapnum">Lap ${lap}</span>` +
      `<button class="nudge" data-key="nudge-${i}-later" data-act="nudge" data-i="${i}" data-d="1" aria-label="Stop ${i} a lap later">›</button>` +
      `</span>` +
      tyrePick(i, s.compound, `Tyres fitted at stop ${i}`) +
      `<button class="remove" data-key="remove-${i}" data-act="remove" data-i="${i}" aria-label="Remove stop ${i}">✕</button>` +
      `<span class="stop-note">${cheap ? `VSC: ${loss.toFixed(0)}s in the pits` : `${loss.toFixed(0)}s in the pits`}</span>` +
      `</li>`;
  });
  $("stops").innerHTML = html;
  if (keep) $("stops").querySelector(`[data-key="${keep}"]`)?.focus();
}

function renderStaticTimeline() {
  $("ferrari-strip").innerHTML = stintSpans(REAL_STINTS).map((s) =>
    `<span class="seg ${s.compound.toLowerCase()}" style="left:${pct(s.from)};width:${(s.laps / TOTAL) * 100}%">` +
    `${s.i === 0 ? "Ferrari: " : ""}${compoundName(s.compound)} ${s.laps}</span>`).join("");

  const lane = [];
  for (const e of EVENTS.filter((e) => e.kind === "vsc")) {
    lane.push(`<span class="vsc-tag row1" style="left:${pct(e.lap + 1)}" title="${escapeHtml(e.text)}">VSC</span>`);
  }
  for (const e of EVENTS.filter((e) => e.kind === "out")) {
    lane.push(`<span class="out row2" style="left:${pct(e.lap + 0.5)}" title="${escapeHtml(e.text)}">✕ ${escapeHtml(driverByNum[e.driver]?.code || "")}</span>`);
  }
  const flagged = new Set();
  for (const e of EVENTS.filter((e) => e.kind === "incident" && e.driver === HAM)) {
    if (flagged.has(e.driver)) continue;
    flagged.add(e.driver);
    const code = driverByNum[e.driver]?.code || "";
    lane.push(`<span class="incident row2" style="left:${pct(e.lap + 0.5)}" title="${escapeHtml(e.text)}">! ${escapeHtml(code)} off at T1</span>`);
  }
  $("event-lane").innerHTML = lane.join("");
  $("ruler-scale").innerHTML = [1, 10, 20, 30, 40, 50, 62].map((l) => `<span style="left:${pct(l + 0.5)}">${l}</span>`).join("");
}

function updatePlayhead() {
  const ph = $("playhead"), fut = $("future");
  if (!state.ghost) { ph.hidden = true; fut.hidden = true; return; }
  const laps = Math.min(TOTAL, ghostProgress(race, state.ghost, state.t));
  const x = `${(laps / TOTAL) * 100}%`;
  ph.hidden = false;
  fut.hidden = false;
  ph.style.left = x;
  fut.style.left = x;
  $("playhead-label").textContent = laps >= TOTAL ? "Flag" : `Lap ${Math.floor(laps) + 1}`;
  for (const pit of ruler.querySelectorAll(".pit")) {
    const at = state.stints[+pit.dataset.i].from - 1;
    pit.querySelector("span").style.visibility = Math.abs(at - laps) < 3.5 ? "hidden" : "";
  }
}

function movePit(i, from) {
  const st = state.stints;
  const min = st[i - 1].from + 2;
  const max = i + 1 < st.length ? st[i + 1].from - 2 : TOTAL;
  st[i].from = Math.max(min, Math.min(max, from));
  st[i].ageAtStart = 0;
  state.note = "";
  renderRuler();
}

// Box at the end of `lap`: splits the stint it lands in, fitting the other compound.
function addStopAt(lap) {
  const st = state.stints;
  if (st.length >= MAX_STINTS) return;
  const from = lap + 1;
  const k = st.findIndex((s, i) => from >= s.from && (i + 1 === st.length || from < st[i + 1].from));
  const s = st[k];
  const max = k + 1 < st.length ? st[k + 1].from - 2 : TOTAL;
  if (k < 0 || from < s.from + 2 || from > max) {
    state.note = "Stops need at least two laps between them.";
  } else {
    st.splice(k + 1, 0, { compound: s.compound === "SOFT" ? "MEDIUM" : "SOFT", from, ageAtStart: 0 });
    state.note = "";
  }
  renderRuler();
}

function removeStop(i) {
  state.stints.splice(i, 1);
  state.note = "";
  renderRuler();
}

function seekToLaps(laps) {
  if (!state.ghost) return;
  state.t = timeAtGhostLaps(state.ghost, Math.max(0, Math.min(TOTAL, laps)));
  if (state.t < state.ghost.finish) {
    state.finished = false;
    $("finish").hidden = true;
  }
  render();
  updateHud();
  updateTower();
}

// Where on the bar the pointer is, as the lap a stop there would box on.
const boxLapAt = (ev) => {
  const r = ruler.getBoundingClientRect();
  return Math.round(((ev.clientX - r.left) / r.width) * TOTAL);
};

let dragging = false;
ruler.addEventListener("pointermove", (e) => {
  const hint = $("add-hint");
  const lap = boxLapAt(e);
  if (state.running || dragging || e.target.closest(".pit") || state.stints.length >= MAX_STINTS || lap < 1 || lap >= TOTAL) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.style.left = pct(lap + 1);
  hint.querySelector("span").textContent = `+ Box ${lap}`;
});
ruler.addEventListener("pointerleave", () => ($("add-hint").hidden = true));
ruler.addEventListener("click", (e) => {
  if (state.running || e.target.closest(".pit")) return;
  const lap = boxLapAt(e);
  if (lap >= 1 && lap < TOTAL) addStopAt(lap);
});

tl.addEventListener("pointerdown", (e) => {
  const r = ruler.getBoundingClientRect();
  const lapsAt = (ev) => ((ev.clientX - r.left) / r.width) * TOTAL;
  if (state.running) {
    // Scrub the race.
    e.preventDefault();
    tl.setPointerCapture(e.pointerId);
    const wasPlaying = state.playing;
    state.playing = false;
    seekToLaps(lapsAt(e));
    const move = (ev) => seekToLaps(lapsAt(ev));
    const up = () => {
      state.playing = wasPlaying && !state.finished;
      tl.removeEventListener("pointermove", move);
      tl.removeEventListener("pointerup", up);
    };
    tl.addEventListener("pointermove", move);
    tl.addEventListener("pointerup", up);
    return;
  }
  const b = e.target.closest(".pit");
  if (!b) return;
  const i = +b.dataset.i;
  b.setPointerCapture(e.pointerId);
  dragging = true;
  $("add-hint").hidden = true;
  const move = (ev) => movePit(i, Math.round(lapsAt(ev)) + 1);
  const up = () => { dragging = false; b.removeEventListener("pointermove", move); b.removeEventListener("pointerup", up); };
  b.addEventListener("pointermove", move);
  b.addEventListener("pointerup", up);
});

ruler.addEventListener("keydown", (e) => {
  const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  if (state.running) {
    if (!step) return;
    e.preventDefault();
    seekToLaps(Math.floor(ghostProgress(race, state.ghost, state.t)) + step);
    return;
  }
  const b = e.target.closest(".pit");
  if (!b) return;
  const i = +b.dataset.i;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeStop(i);
    $("add-stop").focus();
    return;
  }
  if (!step) return;
  e.preventDefault();
  movePit(i, state.stints[i].from + step);
  ruler.querySelector(`.pit[data-i="${i}"]`)?.focus();
});

$("stops").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b || state.running) return;
  const i = +b.dataset.i;
  const st = state.stints;
  if (b.dataset.act === "nudge") return movePit(i, st[i].from + +b.dataset.d);
  if (b.dataset.act === "remove") { removeStop(i); return $("add-stop").focus(); }
  if (b.dataset.act === "tyre") {
    st[i].compound = b.dataset.c;
    st[i].ageAtStart = 0;
    renderRuler();
  }
});

$("add-stop").addEventListener("click", () => {
  // Halfway through the longest stint.
  const spans = stintSpans(state.stints);
  const longest = spans.reduce((a, b) => (b.laps > a.laps ? b : a));
  addStopAt(longest.from + Math.floor(longest.laps / 2) - 1);
});

$("load-real").addEventListener("click", () => {
  state.stints = REAL_STINTS.map((s) => ({ ...s }));
  state.note = "";
  renderRuler();
});

// ---------------------------------------------------------------- engineer
async function askEngineer(summary) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch("api/engineer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(summary), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`engineer ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- race lifecycle
let last = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.playing) {
    const pit = state.ghost && (ghostInPit(state.t) || realInPit(HAM, state.t));
    state.t += dt * (pit ? Math.min(state.speed, PIT_SPEED) : state.speed);
    const realB = timeline(HAM);
    if (state.ghost && state.t >= state.ghost.finish && state.t >= realB[realB.length - 1][1] && !state.finished) {
      state.finished = true;
      setTimeout(() => state.finished && showFinish(), 900);
    }
    if (state.t > Math.max(raceEnd, state.ghost ? state.ghost.finish : 0) + 5) state.playing = false;
  }
  render();
  if (now - (frame.hud || 0) > 150) {
    frame.hud = now;
    updateHud();
    updateTower();
    const over = state.t > Math.max(raceEnd, state.ghost ? state.ghost.finish : 0) + 5;
    $("pause").textContent = state.playing || over ? "Pause" : "Resume";
    $("pause").disabled = over;
  }
  requestAnimationFrame(frame);
}

function startRace() {
  const ghost = simulateGhost(race, state.stints);
  const odds = raceOdds(race, state.stints, ODDS_RUNS);
  state.odds = odds;
  const summary = buildSummary(race, ghost, state.stints, odds);
  // The built-in engineer covers every race; Opus, when switched on, rewrites what hasn't played yet.
  const ai = { debrief: builtInDebrief(race, ghost, summary, BANK, state.stints, odds), builtIn: true };
  Object.assign(state, { ghost, t: 0, playing: true, running: true, finished: false, ai, summary, note: "" });
  state.radio = builtInRadio(race, ghost, summary, BANK, state.stints).map((m) => ({ ...m, shown: false }));
  const builtIn = state.radio;
  $("radio").innerHTML = "";
  $("tyres").hidden = false;
  $("finish").hidden = true;
  $("pause").textContent = "Pause";
  renderRuler();

  if (!CONFIG.opus) return;
  askEngineer(summary).then((ai) => {
    if (state.ghost !== ghost) return;
    state.ai = ai;
    const keep = state.radio.filter((m) => m.t <= state.t);
    const fresh = timeLapRadio(race, ghost, builtIn, ai.radio || []).filter((m) => m.t > state.t).map((m) => ({ ...m, shown: false }));
    state.radio = [...keep, ...fresh].sort((a, b) => a.t - b.t);
    if (state.finished) fillDebrief();
  }).catch((err) => console.warn("Opus engineer unavailable, keeping the built-in lines:", err.message));
}

function showFinish() {
  const s = state.summary;
  const pos = s.result.your_position;
  const card = document.querySelector(".finish-card");
  const dsq = typeof pos !== "number";
  card.classList.toggle("dsq", dsq);
  card.classList.toggle("worse", !dsq && pos > REAL_POS);
  $("finish-kicker").textContent = dsq ? "Stewards' decision" : "Chequered flag";
  $("finish-pos").textContent = dsq ? "DSQ" : `P${pos}`;
  const gap = s.result.gap_to_ferrari_at_flag_s;
  $("finish-compare").textContent = Math.abs(gap) < 0.05
    ? `Ferrari's call finished P${REAL_POS}. So did you, to the hundredth.`
    : `Ferrari's call finished P${REAL_POS}. You were ${Math.abs(gap).toFixed(1)}s ${gap < 0 ? "faster" : "slower"}.`;
  renderOdds(pos);
  $("finish").hidden = false;
  fillDebrief();
  $("again").focus();
}

// Same strategy, many races with different passing luck: how often each position came up.
function renderOdds(pos) {
  const o = state.odds;
  const box = $("odds");
  if (!o || o.dsq) { box.hidden = true; return; }
  const places = Object.keys(o.pos).map(Number).sort((a, b) => a - b);
  if (places.length < 2) {
    $("odds-title").textContent = `P${places[0]} in all ${o.runs} reruns with different passing luck.`;
    $("odds-bars").innerHTML = "";
  } else {
    $("odds-title").textContent = `This strategy over ${o.runs} reruns with different passing luck:`;
    const most = Math.max(...Object.values(o.pos));
    $("odds-bars").innerHTML = places.map((p) => {
      const share = o.pos[p] / o.runs;
      return `<li class="${p === pos ? "this" : ""}${p > REAL_POS ? " worse" : p < REAL_POS ? " better" : ""}">` +
        `<span class="bar" style="height:${(o.pos[p] / most) * 100}%"></span>` +
        `<span class="share">${Math.round(share * 100)}%</span><span class="place">P${p}</span></li>`;
    }).join("");
  }
  box.hidden = false;
}

function restartRace() {
  Object.assign(state, { t: 0, playing: true, finished: false });
  $("finish").hidden = true;
  $("pause").textContent = "Pause";
}

function backToPlan() {
  Object.assign(state, { ghost: null, t: 0, playing: false, running: false, finished: false });
  $("finish").hidden = true;
  $("delta").hidden = true;
  $("tyres").hidden = true;
  $("radio").innerHTML = "";
  renderRuler();
  updateHud();
  updateTower();
  render();
  $("race").focus();
}

function fillDebrief() {
  if ($("finish").hidden) return;
  const d = state.ai?.debrief;
  $("finish-headline").textContent = d ? d.headline : "The pit wall is writing your debrief…";
  $("finish-headline").classList.toggle("loading", !d);
  $("finish-verdict").textContent = d ? d.verdict : "";
  $("finish-roast").textContent = d ? d.roast : "";
}

$("race").addEventListener("click", startRace);
$("again").addEventListener("click", backToPlan);
$("edit").addEventListener("click", backToPlan);
$("restart").addEventListener("click", restartRace);
$("pause").addEventListener("click", () => {
  if (!state.running) return;
  state.playing = !state.playing;
  $("pause").textContent = state.playing ? "Pause" : "Resume";
});
$("speeds").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-speed]");
  if (!b) return;
  state.speed = +b.dataset.speed;
  for (const x of $("speeds").children) x.setAttribute("aria-checked", String(x === b));
});

// ---------------------------------------------------------------- boot
window.addEventListener("resize", () => { layout(); render(); });
document.fonts?.ready.then(() => render());
layout();
renderRuler();
renderStaticTimeline();
updateTower();
requestAnimationFrame((now) => { last = now; frame(now); });

// For the console and quick checks
window.desk = { race, state, startRace };

// Screenshot hook: ?at=<race seconds>[&vsc=1 | &stints=M1,S31][&finish=1] starts a race and freezes it at that moment.
const qs = new URLSearchParams(location.search);
if (qs.has("vsc")) state.stints = [...REAL_STINTS.map((s) => ({ ...s })), { compound: "SOFT", from: 40, ageAtStart: 0 }];
if (qs.has("stints")) {
  state.stints = qs.get("stints").split(",").map((s) => ({ compound: s[0] === "S" ? "SOFT" : "MEDIUM", from: +s.slice(1), ageAtStart: 0 }));
}
renderRuler();
if (qs.has("at")) {
  startRace();
  state.t = +qs.get("at");
  state.playing = false;
  updateHud();
  updateTower();
  render();
  if (qs.has("finish")) { state.finished = true; showFinish(); }
}
