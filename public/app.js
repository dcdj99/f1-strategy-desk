import {
  HAM, simulateGhost, realStrategy, validateStrategy, progressAt, classify, tyreAt, tyreModelLap,
  realProgress, ghostProgress, timeAtGhostLaps,
} from "./sim.js";

const $ = (id) => document.getElementById(id);
const race = await (await fetch("data/race.json")).json();
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
  radio: [],        // queued messages {lap, from, text, shown}
  ai: null,         // engineer response once it arrives
  summary: null,
};

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

// In the pit lane: the last stretch of an in-lap or the first stretch of an out-lap (official timing).
function pitting(pitLaps, bounds, t) {
  const p = progressAt(bounds, t);
  const lap = Math.floor(p) + 1;
  const f = p % 1;
  return (pitLaps.includes(lap) && f > 0.8) || (pitLaps.includes(lap - 1) && f < 0.25);
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
  geo = {
    dpr,
    pts: pts.map(([f, x, y]) => [f, ox + (x * c - y * s - minX) * scale, oy + (x * s + y * c - minY) * scale]),
  };
  drawTrackLayer(false);
}

function pointAt(frac) {
  const p = geo.pts;
  frac = ((frac % 1) + 1) % 1;
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

function drawLabel(x, y, text, color, dy = -18, size = 16) {
  const d = geo.dpr;
  ctx.save();
  ctx.font = `600 ${size * d}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = 4 * d;
  ctx.strokeStyle = "rgba(8,18,39,0.9)";
  ctx.strokeText(text, x, y + dy * d);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y + dy * d);
  ctx.restore();
}

function drawTrail(progressFn, t, color, dashed) {
  const d = geo.dpr;
  const steps = 26;
  const span = 9; // race seconds of trail
  ctx.save();
  ctx.lineCap = "round";
  for (let i = steps; i > 0; i--) {
    const pa = progressFn(t - (span * i) / steps);
    const pb = progressFn(t - (span * (i - 1)) / steps);
    if (pa <= 0 || pb - pa <= 0) continue;
    const [xa, ya] = pointAt(pa % 1), [xb, yb] = pointAt(pb % 1);
    if (Math.hypot(xb - xa, yb - ya) > 80 * d) continue;
    if (dashed && i % 2) continue;
    ctx.strokeStyle = color;
    ctx.globalAlpha = (1 - i / steps) * 0.85;
    ctx.lineWidth = (dashed ? 4 : 5) * d;
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
  }
  ctx.restore();
}

const realPitLaps = race.pits[String(HAM)] || [];

function render() {
  const t = state.t;
  const vscNow = state.running && vscActive(t);
  if (vscNow !== trackVsc) drawTrackLayer(vscNow);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(trackLayer, 0, 0);

  const gp = state.ghost ? ghostProgress(race, state.ghost, t) : null;
  let leader = null, ahead = null, behind = null;
  for (const d of race.drivers) {
    if (d.num === HAM) continue;
    const b = timeline(d.num);
    if (!b.length) continue;
    const done = t > b[b.length - 1][1];
    if (done && retired(d.num)) continue;
    const p = realProgress(race, d.num, t);
    const [x, y] = pointAt(p % 1);
    drawCar(x, y, 5.5, d.colour, { alpha: done ? 0.35 : 0.9 });
    if (state.running && !done && pitting(race.pits[String(d.num)] || [], b, t)) drawLabel(x, y, `${d.code} pit`, "#ffb547", -14, 13);
    if (!leader || p > leader.p) leader = { p, x, y, code: d.code };
    if (gp !== null && !done) {
      if (p > gp && p - gp < 0.15 && (!ahead || p < ahead.p)) ahead = { p, x, y, code: d.code };
      if (p < gp && gp - p < 0.15 && (!behind || p > behind.p)) behind = { p, x, y, code: d.code };
    }
  }
  if (leader && t > 0) drawLabel(leader.x, leader.y, `P1 ${leader.code}`, "#f3eedd", 22, 14);
  for (const n of [ahead, behind]) if (n && n.code !== leader?.code) drawLabel(n.x, n.y, n.code, "#a9b3c7", 22, 14);

  // Ferrari's real Hamilton
  const realB = timeline(HAM);
  const realFn = (tt) => realProgress(race, HAM, tt);
  const rp = realFn(t);
  const [rx, ry] = pointAt(rp % 1);
  drawTrail(realFn, t, "#e8112d", false);
  drawCar(rx, ry, 8, "#e8112d", { ring: "#ffffff" });
  const realLabel = state.running && pitting(realPitLaps, realB, t) ? "Ferrari (pit)" : "Ferrari";

  // Your ghost Hamilton
  if (state.ghost) {
    const ghostFn = (tt) => ghostProgress(race, state.ghost, tt);
    const [gx, gy] = pointAt(gp % 1);
    drawTrail(ghostFn, t, "#d4e8ff", true);
    drawCar(gx, gy, 9, "rgba(212,232,255,0.92)", { glow: "rgba(212,232,255,0.95)" });
    const youLabel = pitting(state.ghost.pitLaps, state.ghost.bounds, t) ? "You (pit)" : "You";
    if (Math.hypot(gx - rx, gy - ry) < 40 * geo.dpr) {
      drawLabel((gx + rx) / 2, Math.min(gy, ry), `${youLabel} + ${realLabel}`, "#f3eedd");
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
    const note = r.you ? "you" : r.num === HAM ? "Ferrari" : r.out ? "out" : "";
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

  // Radio: show messages up to the lap the ghost is on (works when scrubbing backwards too).
  const ghostLap = Math.floor(gp) + 1;
  let changed = false;
  for (const m of state.radio) {
    const show = m.lap <= ghostLap;
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
    `<li class="${m.from}"><span class="from">${m.from === "engineer" ? "Pit wall" : "Car 44"}, lap ${m.lap}</span>${escapeHtml(m.text)}</li>`,
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

function stintSpans(stints) {
  return stints.map((s, i) => {
    const end = i + 1 < stints.length ? stints[i + 1].from - 1 : TOTAL;
    return { ...s, i, end, laps: end - s.from + 1 };
  });
}

function renderRuler() {
  const st = state.stints;
  let html = "";
  const v = [...VSC].sort((a, b) => a - b);
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    html += `<span class="vsc" title="Virtual safety car, laps ${v[i]}–${v[j]}: pit stops are cheaper" style="left:${pct(v[i])};width:${((v[j] - v[i] + 1) / TOTAL) * 100}%"></span>`;
    i = j;
  }
  for (const s of stintSpans(st)) {
    html += `<button class="stint ${s.compound.toLowerCase()}" data-i="${s.i}" style="left:${pct(s.from)};width:${(s.laps / TOTAL) * 100}%" ` +
      `aria-label="Stint ${s.i + 1}: ${compoundName(s.compound)} tyres for ${s.laps} laps. Tap to swap.">${compoundName(s.compound)} ${s.laps}</button>`;
  }
  st.slice(1).forEach((s, i) => {
    html += `<button class="pit" data-i="${i + 1}" style="left:${pct(s.from)}" aria-label="Pit stop at end of lap ${s.from - 1}. Use arrow keys to move."><span>Box ${s.from - 1}</span></button>`;
  });
  ruler.innerHTML = html;

  const v2 = validateStrategy(race, st);
  const msgs = [...v2.problems];
  if (v2.dsq) msgs.push("Only one tyre compound: the stewards will disqualify you.");
  $("warn").textContent = msgs.join(" ");
  $("race").disabled = !v2.ok || state.running;
  $("add-stop").disabled = st.length >= 4 || state.running;
  $("remove-stop").disabled = st.length <= 1 || state.running;
  $("load-real").disabled = state.running;
  $("ruler-hint").textContent = state.running
    ? "Drag along the timeline to jump to any lap."
    : "Drag the pit markers. Tap a stint to swap tyres.";
  tl.classList.toggle("scrubbable", state.running);
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

ruler.addEventListener("click", (e) => {
  const b = e.target.closest(".stint");
  if (!b || state.running) return;
  const s = state.stints[+b.dataset.i];
  s.compound = s.compound === "SOFT" ? "MEDIUM" : "SOFT";
  s.ageAtStart = 0;
  renderRuler();
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
  const move = (ev) => movePit(i, Math.round(lapsAt(ev)) + 1);
  const up = () => { b.removeEventListener("pointermove", move); b.removeEventListener("pointerup", up); };
  b.addEventListener("pointermove", move);
  b.addEventListener("pointerup", up);
});

ruler.addEventListener("keydown", (e) => {
  const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  if (!step) return;
  if (state.running) {
    e.preventDefault();
    seekToLaps(Math.floor(ghostProgress(race, state.ghost, state.t)) + step);
    return;
  }
  const b = e.target.closest(".pit");
  if (!b) return;
  e.preventDefault();
  const i = +b.dataset.i;
  movePit(i, state.stints[i].from + step);
  ruler.querySelector(`.pit[data-i="${i}"]`)?.focus();
});

$("add-stop").addEventListener("click", () => {
  const st = state.stints;
  let longest = 0, len = 0;
  st.forEach((s, i) => {
    const l = (i + 1 < st.length ? st[i + 1].from : TOTAL + 1) - s.from;
    if (l > len) { len = l; longest = i; }
  });
  const s = st[longest];
  const from = s.from + Math.floor(len / 2);
  st.splice(longest + 1, 0, { compound: s.compound === "SOFT" ? "MEDIUM" : "SOFT", from, ageAtStart: 0 });
  renderRuler();
});

$("remove-stop").addEventListener("click", () => {
  state.stints.pop();
  renderRuler();
});

$("load-real").addEventListener("click", () => {
  state.stints = REAL_STINTS.map((s) => ({ ...s }));
  renderRuler();
});

// ---------------------------------------------------------------- race summary for the engineer
function orderAt(t, excludeNum, extra) {
  const ps = [];
  for (const d of race.drivers) {
    if (d.num === excludeNum) continue;
    const b = timeline(d.num);
    if (b.length) ps.push({ code: d.code, p: progressAt(b, t) });
  }
  if (extra) ps.push(extra);
  ps.sort((a, b) => b.p - a.p);
  return ps;
}

function buildSummary(ghost) {
  const realB = timeline(HAM);
  const realLaps = race.laps[String(HAM)];
  const laps = [];
  let prevAhead = null;
  const moves = [];
  for (let k = 1; k <= TOTAL; k++) {
    const tg = ghost.bounds[k - 1][1];
    const order = orderAt(tg, HAM, { code: "YOU", p: k });
    const gPos = order.findIndex((o) => o.code === "YOU") + 1;
    const ahead = new Set(order.slice(0, gPos - 1).map((o) => o.code));
    if (prevAhead) {
      const passed = [...prevAhead].filter((c) => !ahead.has(c));
      const lost = [...ahead].filter((c) => !prevAhead.has(c));
      if (passed.length || lost.length) moves.push({ lap: k, passed, passed_by: lost });
    }
    prevAhead = ahead;
    const ty = ghost.tyres[k - 1];
    const rty = tyreAt(REAL_STINTS, k);
    const rPos = realB[k - 1] ? orderAt(realB[k - 1][1], null).findIndex((o) => o.code === "HAM") + 1 : null;
    laps.push({
      lap: k,
      you: +ghost.laps[k - 1].toFixed(2), you_pos: gPos, you_tyre: `${ty.compound[0]}${ty.age}`,
      ferrari: realLaps[k - 1], ferrari_pos: rPos, ferrari_tyre: `${rty.compound[0]}${rty.age}`,
      gap_to_ferrari: realB[k - 1] ? +(tg - realB[k - 1][1]).toFixed(2) : null,
    });
  }
  const cls = classify(race, ghost);
  const me = cls.find((r) => r.ghost);
  const v = validateStrategy(race, state.stints);
  const near = cls.filter((r) => Math.abs(r.pos - me.pos) <= 1 && !r.ghost).map((r) => ({ code: r.code, pos: r.pos, gap: +(r.finish - me.finish).toFixed(2) }));
  return {
    track: "Marina Bay, Singapore, 62 laps, night race",
    vsc_laps: race.race.neutralised_laps,
    race_events: EVENTS.filter((e) => e.kind !== "pit").map((e) => ({ lap: e.lap, text: e.text })),
    tyre_model: { soft_cliff_after_laps: race.model.cliff_at.SOFT, normal_pit_loss_s: +race.model.pit_loss_green.toFixed(1), vsc_pit_loss_s: +race.model.pit_loss_vsc.toFixed(1) },
    your_strategy: describe(state.stints),
    ferrari_strategy: describe(REAL_STINTS),
    result: { your_position: v.dsq ? "DSQ (only one compound used)" : me.pos, ferrari_position: REAL_POS, gap_to_ferrari_at_flag_s: +(ghost.finish - realB[TOTAL - 1][1]).toFixed(2), neighbours: near },
    position_changes: moves,
    laps,
  };
}

function describe(stints) {
  return stintSpans(stints).map((s) => ({
    compound: s.compound.toLowerCase(), laps: `${s.from}-${s.end}`, tyre_age_at_start: s.ageAtStart || 0, pitted_end_of_lap: s.i ? s.from - 1 : null,
  }));
}

// Built-in radio for when the engineer API is offline or still thinking.
function localRadio(ghost, summary) {
  const msgs = [{ lap: 1, from: "engineer", text: "Lights out. Your strategy now, car 44. Ferrari's call is racing next to you." }];
  for (const p of ghost.pitLaps) {
    const cheap = VSC.has(p);
    const next = state.stints.find((s) => s.from === p + 1);
    msgs.push({ lap: Math.max(1, p - 1), from: "engineer", text: cheap ? "VSC! Box, box, box. Cheapest stop of the night." : `Box next lap. ${next.compound === "SOFT" ? "Softs" : "Mediums"} ready.` });
    msgs.push({ lap: p + 1, from: "driver", text: "Out of the pits. Tyres feel fresh." });
  }
  for (const l of [8, 39]) if (!ghost.pitLaps.includes(l)) msgs.push({ lap: l, from: "engineer", text: "VSC, VSC. Stay above the delta. We are checking." });
  const cliffLap = ghost.tyres.findIndex((t) => t.age > race.model.cliff_at[t.compound] + 6);
  if (cliffLap >= 0) msgs.push({ lap: cliffLap + 1, from: "driver", text: "These tyres are gone. Completely gone." });
  const g45 = summary.laps[44].gap_to_ferrari;
  msgs.push({ lap: 45, from: "engineer", text: Math.abs(g45) < 0.05 ? "Exactly where Ferrari had us. Bold of you." : `Gap to Ferrari's own call: ${Math.abs(g45).toFixed(1)}s ${g45 < 0 ? "ahead" : "behind"}.` });
  msgs.push({ lap: TOTAL, from: "engineer", text: `Chequered flag. ${typeof summary.result.your_position === "number" ? "P" + summary.result.your_position : "And... we have a problem with the stewards"}.` });
  return msgs.sort((a, b) => a.lap - b.lap);
}

function localDebrief(summary) {
  const pos = summary.result.your_position;
  const gap = summary.result.gap_to_ferrari_at_flag_s;
  const better = typeof pos === "number" && pos < REAL_POS;
  const same = Math.abs(gap) < 0.05;
  return {
    headline: typeof pos !== "number" ? "Disqualified" : better ? "You out-strategised Ferrari" : same ? "You are Ferrari now" : pos === REAL_POS ? "Same result, different headache" : "Somehow worse than Ferrari",
    verdict: same ? "You copied Ferrari's strategy to the lap, so you got Ferrari's result to the hundredth." :
      `You finished ${Math.abs(gap).toFixed(1)}s ${gap < 0 ? "ahead of" : "behind"} Ferrari's real race. ` +
      (VSC.has(state.ghost.pitLaps[state.ghost.pitLaps.length - 1]) ? "Stopping under the VSC paid for itself." : "The VSC windows were the cheap stops on offer."),
    roast: better ? "Maranello would like your number." : "Even the pit wall's group chat is laughing.",
  };
}

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
    state.t += dt * state.speed;
    const realB = timeline(HAM);
    if (state.ghost && state.t >= state.ghost.finish && state.t >= realB[realB.length - 1][1] && !state.finished) {
      state.finished = true;
      setTimeout(() => state.finished && showFinish(), 900);
    }
    if (state.t > Math.max(raceEnd, state.ghost ? state.ghost.finish : 0) + 5) state.playing = false;
  }
  render();
  if (now - (frame.hud || 0) > 150) { frame.hud = now; updateHud(); updateTower(); }
  requestAnimationFrame(frame);
}

function startRace() {
  const ghost = simulateGhost(race, state.stints);
  const summary = buildSummary(ghost);
  Object.assign(state, { ghost, t: 0, playing: true, running: true, finished: false, ai: null, summary });
  state.radio = localRadio(ghost, summary).map((m) => ({ ...m, shown: false }));
  $("radio").innerHTML = "";
  $("tyres").hidden = false;
  $("finish").hidden = true;
  $("pause").textContent = "Pause";
  renderRuler();

  askEngineer(summary).then((ai) => {
    if (state.ghost !== ghost) return;
    state.ai = ai;
    const now = Math.floor(progressAt(ghost.bounds, state.t)) + 1;
    const keep = state.radio.filter((m) => m.lap <= now);
    const fresh = (ai.radio || []).filter((m) => m.lap > now).map((m) => ({ ...m, shown: false }));
    state.radio = [...keep, ...fresh].sort((a, b) => a.lap - b.lap);
    if (state.finished) fillDebrief();
  }).catch((err) => {
    console.warn("Engineer offline, using built-in radio:", err.message);
    state.ai = { debrief: localDebrief(summary), offline: true };
    if (state.finished) fillDebrief();
  });
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
  $("finish").hidden = false;
  fillDebrief();
  $("again").focus();
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
$("again").addEventListener("click", () => {
  Object.assign(state, { ghost: null, t: 0, playing: false, running: false, finished: false });
  $("finish").hidden = true;
  $("delta").hidden = true;
  $("tyres").hidden = true;
  $("radio").innerHTML = "";
  renderRuler();
  updateHud();
  $("race").focus();
});
$("pause").addEventListener("click", () => {
  if (!state.running) return;
  state.playing = !state.playing;
  $("pause").textContent = state.playing ? "Pause" : "Resume";
});
$("speed").addEventListener("change", (e) => (state.speed = +e.target.value));

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

// Screenshot hook: ?at=<race seconds>[&vsc=1][&finish=1] starts a race and freezes it at that moment.
const qs = new URLSearchParams(location.search);
if (qs.has("at")) {
  if (qs.has("vsc")) state.stints = [...REAL_STINTS.map((s) => ({ ...s })), { compound: "SOFT", from: 40, ageAtStart: 0 }];
  startRace();
  state.t = +qs.get("at");
  state.playing = false;
  updateHud();
  updateTower();
  render();
  if (qs.has("finish")) { state.finished = true; showFinish(); }
}
