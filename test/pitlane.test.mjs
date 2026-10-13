import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateGhost, realProgress, ghostProgress, HAM } from "../public/sim.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const LAP_M = 4940; // Marina Bay lap length, metres
const STEP = 0.05;
const plan = (spec) => spec.split(",").map((s) => ({ compound: s[0] === "S" ? "SOFT" : "MEDIUM", from: +s.slice(1), ageAtStart: 0 }));
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
