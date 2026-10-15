import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateGhost, realProgress, ghostProgress, boxStops, boxStill, planStint, BOX_CLEAR, HAM } from "../public/sim.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const LAP_M = 4940; // Marina Bay lap length, metres
const STEP = 0.05;
const plan = (spec) => spec.split(",").map((s) => planStint(race, s[0] === "S" ? "SOFT" : "MEDIUM", +s.slice(1)));
const PLANS = {
  "Ferrari's call": "M1,S19",
  "box lap 2": "S1,M3",
  "box lap 30": "M1,S31",
  "box lap 60": "M1,S61",
  "VSC stop, lap 8": "M1,S9",
  "VSC two-stop": "M1,S19,S40",
};

// Seconds spent below walking pace within 25s either side of crossing the line in the pit lane.
function standstill(progress, line) {
  let still = 0;
  for (let t = line - 25; t < line + 25; t += STEP) {
    if (((progress(t + STEP) - progress(t)) / STEP) * LAP_M < 1) still += STEP;
  }
  return still;
}

test("every ghost stop stands still in the pit box as long as Hamilton's real stop, green or VSC", () => {
  const realLine = race.timelines[String(HAM)][race.pits[String(HAM)][0] - 1][1];
  const real = standstill((t) => realProgress(race, HAM, t), realLine);
  assert.ok(real > 2, `Hamilton's real stop shows ${real}s standing still`);
  for (const [name, spec] of Object.entries(PLANS)) {
    const g = simulateGhost(race, plan(spec));
    for (const p of g.pitLaps) {
      const still = standstill((t) => ghostProgress(race, g, t), g.bounds[p - 1][1]);
      console.log(`${name}, box lap ${p}: ${still.toFixed(1)}s standing still (Hamilton's real stop ${real.toFixed(1)}s)`);
      assert.ok(Math.abs(still - real) < 0.5, `${name}: stop at lap ${p} stands still ${still}s, real ${real}s`);
    }
  }
});

test("the ghost drives in, through and out of the pit lane without jumping or reversing", () => {
  // Fastest the real Hamilton covers ground in one step, over his whole race.
  const rb = race.timelines[String(HAM)];
  let realMax = 0;
  for (let t = rb[1][0]; t < rb.at(-1)[1]; t += STEP) realMax = Math.max(realMax, realProgress(race, HAM, t + STEP) - realProgress(race, HAM, t));
  for (const [name, spec] of Object.entries(PLANS)) {
    const g = simulateGhost(race, plan(spec));
    for (const p of g.pitLaps) {
      let prev = ghostProgress(race, g, g.bounds[p - 1][0]);
      for (let t = g.bounds[p - 1][0] + STEP; t < g.bounds[p][1]; t += STEP) {
        const q = ghostProgress(race, g, t);
        assert.ok(q >= prev - 1e-9, `${name}: went backwards at ${t.toFixed(2)}s`);
        assert.ok(q - prev <= realMax * 1.5, `${name}: jumped ${q - prev} laps at ${t.toFixed(2)}s`);
        prev = q;
      }
    }
  }
});

test("every timed stop has exactly one spell in the pit lane, and every spell is a stop or a pit-lane start", () => {
  for (const d of race.drivers) {
    const n = String(d.num);
    const b = race.timelines[n];
    const wins = race.pit_windows[n] || [];
    const lines = (race.pits[n] || []).map((p) => b[p - 1][1]);
    for (const line of lines) {
      const hits = wins.filter(([a, z]) => a <= line && line <= z).length;
      assert.equal(hits, 1, `${d.code}: ${hits} pit-lane spells around the stop crossing the line at ${line}s`);
    }
    for (const [a, z] of wins) {
      const stop = lines.some((line) => a <= line && line <= z);
      const start = a < 0 && race.pit_lane_starts[n] && z > race.pit_lane_starts[n].join;
      assert.ok(stop || start, `${d.code}: in the pit lane ${a}-${z}s with no stop or pit-lane start`);
    }
  }
});

test("the pit lane runs beside the track, from before the line to after it", () => {
  const lane = race.pit_lane;
  assert.ok(lane[0][0] < 1 && lane.at(-1)[0] > 1, "pit lane should cross the timing line");
  const track = race.track;
  const metres = Math.max(...lane.map(([, x, y]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < track.length; i++) {
      const [, x0, y0] = track[i], [, x1, y1] = track[i + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const s = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x0 + s * dx - x, y0 + s * dy - y));
    }
    return best;
  })) / (race.track.reduce((s, p, i) => (i ? s + Math.hypot(p[1] - track[i - 1][1], p[2] - track[i - 1][2]) : 0), 0) / LAP_M);
  console.log(`pit lane strays up to ${metres.toFixed(1)} m from the racing line`);
  assert.ok(metres > 5 && metres < 30, `pit lane ${metres} m from the track`);
});

test("cars speed up and slow down on the map like real cars, not in jerks", () => {
  // Drawn speed at 60 frames a second at 1x, mapping progress to the outline as the app does.
  const T = race.track;
  const unitsPerM = T.reduce((s, p, i) => (i ? s + Math.hypot(p[1] - T[i - 1][1], p[2] - T[i - 1][2]) : 0), 0) / LAP_M;
  const at = (laps) => {
    const f = ((laps % 1) + 1) % 1;
    let lo = 0, hi = T.length - 1;
    if (f <= T[0][0]) return T[0].slice(1);
    if (f >= T[hi][0]) return T[hi].slice(1);
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid][0] <= f) lo = mid; else hi = mid; }
    const k = (f - T[lo][0]) / (T[hi][0] - T[lo][0] || 1);
    return [T[lo][1] + (T[hi][1] - T[lo][1]) * k, T[lo][2] + (T[hi][2] - T[lo][2]) * k];
  };
  for (const [num, lap] of [[HAM, 11], [HAM, 30], [1, 25], [16, 50]]) {
    const [a, z] = race.timelines[String(num)][lap - 1];
    const v = [];
    for (let t = a; t < z; t += 1 / 60) {
      const [x0, y0] = at(realProgress(race, num, t)), [x1, y1] = at(realProgress(race, num, t + 1 / 60));
      v.push((Math.hypot(x1 - x0, y1 - y0) / unitsPerM) * 60 * 3.6);
    }
    // Turning points in speed of 8 km/h or more: a real lap here has about two per corner (~40).
    let turns = 0, dir = 0, ref = v[0];
    for (const s of v) {
      if (dir >= 0 && s < ref - 8) { if (dir > 0) turns++; dir = -1; ref = s; }
      else if (dir <= 0 && s > ref + 8) { if (dir < 0) turns++; dir = 1; ref = s; }
      else if ((dir > 0 && s > ref) || (dir < 0 && s < ref) || dir === 0) ref = s;
    }
    const jump = Math.max(...v.slice(1).map((s, k) => Math.abs(s - v[k])));
    console.log(`#${num} lap ${lap}: ${turns} speed turning points, biggest change between frames ${jump.toFixed(1)} km/h`);
    // Before the averaged lap-fraction scale: about 180 turning points and single-frame jumps of 260+ km/h.
    assert.ok(turns < 70, `#${num} lap ${lap}: speed turns ${turns} times`);
    assert.ok(jump < 25, `#${num} lap ${lap}: speed jumps ${jump} km/h in one frame`);
  }
});

test("smoothed positions move steadily", () => {
  // Mean change in speed from one second to the next, in thousandths of a lap per second.
  // Resampling the raw feed without smoothing gave about 1.1; the fit brings it to about 0.3.
  let sum = 0, count = 0;
  for (const s of Object.values(race.progress)) {
    for (let i = 2; i < s.length; i++) { sum += Math.abs(s[i] - 2 * s[i - 1] + s[i - 2]) / 10; count++; }
  }
  console.log(`mean change in speed ${(sum / count).toFixed(2)} thousandths of a lap per second`);
  assert.ok(sum / count < 0.5);
});

test("the speed trace and the position feed find the same Ferrari box stops", () => {
  const team = race.drivers.find((d) => d.num === HAM).team;
  for (const d of race.drivers.filter((x) => x.team === team)) {
    const speed = race.box_stops[String(d.num)], pos = boxStops(race, d.num);
    assert.equal(speed.length, pos.length, `${d.code}: ${JSON.stringify(speed)} on the speed trace`);
    speed.forEach(([a, z], k) => {
      const [pa, pz] = pos[k];
      const where = `${d.code} stop ${k + 1}: at 0 km/h ${a.toFixed(2)}-${z.toFixed(2)}s, still on the map ${pa.toFixed(2)}-${pz.toFixed(2)}s`;
      console.log(where);
      assert.ok(Math.abs(a - pa) < 1 && Math.abs(z - pz) < 1, where);
      assert.ok(z - a > 1 && z - a < 6, where);
    });
  }
});

test("a double stack: a ghost that reaches the box while Leclerc is in it waits until he has gone", () => {
  const team = race.drivers.find((d) => d.num === HAM).team;
  const mate = race.drivers.find((d) => d.team === team && d.num !== HAM);
  const theirs = boxStill(race, mate.num);
  assert.ok(theirs.length >= 1, `${mate.code} never stood in the box`);
  const realLine = race.timelines[String(HAM)][race.pits[String(HAM)][0] - 1][1];
  const real = standstill((t) => realProgress(race, HAM, t), realLine);
  const specs = [];
  for (let p = 18; p <= 42; p++) specs.push(`M1,S${p + 1}`, `S1,M${p + 1}`);
  for (const p1 of [8, 14, 20]) for (const p2 of [24, 39]) specs.push(`M1,S${p1 + 1},S${p2 + 1}`, `S1,M${p1 + 1},S${p2 + 1}`);
  let stacked = 0;
  for (const spec of specs) {
    const g = simulateGhost(race, plan(spec));
    g.pitLaps.forEach((p, k) => {
      const line = g.bounds[p - 1][1];
      const would = line + g.pitRef.still; // stopping in the box with nobody in it, on the speed trace
      // When the ghost reaches the box, from its motion on the map.
      const boxAt = p + realProgress(race, HAM, g.pitRef.line + g.pitRef.box) - g.pitRef.lap;
      let reach = null;
      for (let t = line; t < line + 60 && reach === null; t += 0.05) if (ghostProgress(race, g, t) >= boxAt - 1e-6) reach = t;
      // On the speed trace, where the stack is timed, Hamilton's stop starts this much later.
      const reachStill = reach + g.pitRef.still - g.pitRef.box;
      const first = theirs.find(([a, z]) => a <= would && would < z + BOX_CLEAR);
      const where = `${spec}, box at the end of lap ${p}`;
      if (first) {
        stacked++;
        assert.ok(Math.abs(reachStill - (first[1] + BOX_CLEAR)) < 0.1, `${where}: stops in the box at ${reachStill.toFixed(2)}s, ${mate.code} left at ${first[1].toFixed(2)}s`);
      } else {
        assert.equal(g.pitWaits[k].wait, 0, `${where}: waited with nobody in the box`);
      }
      const still = standstill((t) => ghostProgress(race, g, t), line);
      assert.ok(Math.abs(still - (real + g.pitWaits[k].wait)) < 0.5, `${where}: stands still ${still.toFixed(1)}s, waited ${g.pitWaits[k].wait.toFixed(1)}s`);
      if (first) console.log(`${where}: reaches the box ${(would - first[0]).toFixed(1)}s after ${mate.code}, waits ${g.pitWaits[k].wait.toFixed(1)}s`);
    });
  }
  assert.ok(stacked >= 2, `only ${stacked} double stacks`);
});
