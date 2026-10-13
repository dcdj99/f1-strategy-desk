import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  simulateGhost, realStrategy, classify, validateStrategy, realProgress, ghostProgress, timeAtGhostLaps, HAM, TRAFFIC,
} from "../public/sim.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const realBounds = race.timelines[String(HAM)];
const realLaps = race.laps[String(HAM)];
const realTotal = realBounds.at(-1)[1] - realBounds[0][0];
const vscTwoStop = () => [...realStrategy(race), { compound: "SOFT", from: 40, ageAtStart: 0 }];

test("control: Ferrari's real strategy reproduces every one of Hamilton's real laps", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  const worst = Math.max(...ghost.laps.map((d, i) => Math.abs(d - realLaps[i])));
  console.log(`real ${realTotal.toFixed(3)}s  model ${ghost.total.toFixed(3)}s  worst lap error ${worst.toExponential(1)}s`);
  assert.ok(worst < 1e-6, `worst lap off by ${worst}s`);
  // Official timing has sub-hundredth gaps between laps; summed over 62 laps they stay under 0.05s.
  assert.ok(Math.abs(ghost.finish - realBounds.at(-1)[1]) < 0.05);
});

test("control: real strategy classifies where Hamilton really finished", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  const me = classify(race, ghost).find((r) => r.ghost);
  const realPos = race.drivers.find((d) => d.num === HAM).final_pos;
  assert.equal(me.pos, realPos);
});

test("control: with the real strategy the ghost sits on the real car all race", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  let worst = 0;
  for (let t = 0; t < realBounds.at(-1)[1]; t += 7) {
    worst = Math.max(worst, Math.abs(ghostProgress(race, ghost, t) - realProgress(race, HAM, t)));
  }
  console.log(`worst on-track separation ${(worst * 1000).toFixed(1)} thousandths of a lap`);
  assert.ok(worst < 0.01, `ghost drifted ${worst} laps from the real car`);
});

test("real car positions agree with official lap timing at every line crossing", () => {
  let worst = 0, who = null;
  for (const d of race.drivers) {
    const b = race.timelines[String(d.num)];
    if (!race.progress[String(d.num)]) continue;
    for (let k = 1; k < b.length; k++) {
      const err = Math.abs(realProgress(race, d.num, b[k][0]) - k);
      if (err > worst) { worst = err; who = `${d.code} lap ${k + 1}`; }
    }
  }
  console.log(`worst line-crossing mismatch ${(worst * 100).toFixed(2)}% of a lap (${who})`);
  assert.ok(worst < 0.05, `${who} off by ${worst} laps`);
});

test("the real classification is reproduced for every car", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  const ours = classify(race, ghost).map((r) => (r.ghost ? "HAM" : r.code));
  const official = [...race.drivers].sort((a, b) => a.final_pos - b.final_pos).map((d) => d.code);
  assert.deepEqual(ours, official);
});

test("pitting under the lap-39 VSC for fresh softs beats staying out", () => {
  const ghost = simulateGhost(race, vscTwoStop());
  const me = classify(race, ghost).find((r) => r.ghost);
  console.log(`VSC two-stop: ${(ghost.total - realTotal).toFixed(2)}s vs real, P${me.pos}`);
  assert.ok(ghost.total < realTotal);
});

test("the same extra stop under green flags costs more than under the VSC", () => {
  const green = simulateGhost(race, [...realStrategy(race), { compound: "SOFT", from: 44, ageAtStart: 0 }]);
  const vsc = simulateGhost(race, vscTwoStop());
  assert.ok(vsc.total < green.total);
});

test("scrubbing: time at a lap count round-trips through ghost timing", () => {
  const ghost = simulateGhost(race, vscTwoStop());
  for (const laps of [0.5, 10, 38.25, 61.9]) {
    const t = timeAtGhostLaps(ghost, laps);
    const i = Math.floor(laps);
    assert.ok(t >= ghost.bounds[i][0] && t <= ghost.bounds[i][1]);
  }
});

const DIVERGING = {
  "early stop": [{ compound: "MEDIUM", from: 1, ageAtStart: 0 }, { compound: "SOFT", from: 11, ageAtStart: 0 }],
  "long first stint": [{ compound: "MEDIUM", from: 1, ageAtStart: 0 }, { compound: "SOFT", from: 31, ageAtStart: 0 }],
  "soft start": [{ compound: "SOFT", from: 1, ageAtStart: 0 }, { compound: "MEDIUM", from: 26, ageAtStart: 0 }],
  "VSC two-stop": vscTwoStop(),
  "three stops": [{ compound: "SOFT", from: 1, ageAtStart: 0 }, { compound: "MEDIUM", from: 13, ageAtStart: 0 },
    { compound: "SOFT", from: 29, ageAtStart: 0 }, { compound: "SOFT", from: 46, ageAtStart: 0 }],
};
const inPits = (num, lap) => (race.pits[String(num)] || []).some((p) => p === lap || p === lap - 1);

test("traffic: every car the ghost gets past on track, it earned the pass", () => {
  for (const [name, st] of Object.entries(DIVERGING)) {
    const g = simulateGhost(race, st);
    for (let lap = 1; lap <= 62; lap++) {
      const [s, e] = g.bounds[lap - 1];
      for (const d of race.drivers) {
        const b = race.timelines[String(d.num)];
        if (d.num === HAM || !b[lap - 1] || inPits(d.num, lap)) continue;
        const [cs, ce] = b[lap - 1];
        if (!(cs < s && ce > e)) continue; // started the lap ahead, finished it behind: a pass
        const info = g.traffic[lap - 1];
        assert.ok(info.passed.includes(d.code), `${name} lap ${lap}: got past ${d.code} without a pass`);
        if (info.mode === "lewis") {
          // Copying Hamilton: only passes he really made on this lap.
          const [rs, re] = realBounds[lap - 1];
          const lewisPassed = cs < rs && ce > re;
          const fastEnough = (ce - cs) - (e - s) >= TRAFFIC.passDelta;
          assert.ok(lewisPassed || fastEnough, `${name} lap ${lap}: copied a pass on ${d.code} that Hamilton never made`);
        }
        assert.ok(!race.race.neutralised_laps.includes(lap), `${name} lap ${lap}: passed ${d.code} under the VSC`);
      }
    }
  }
});

test("traffic: when held up, the ghost sits exactly the following gap behind that car", () => {
  let heldLaps = 0;
  for (const [name, st] of Object.entries(DIVERGING)) {
    const g = simulateGhost(race, st);
    g.traffic.forEach((info, i) => {
      if (!info.held) return;
      heldLaps++;
      const d = race.drivers.find((x) => x.code === info.held);
      const carEnd = race.timelines[String(d.num)][i][1];
      assert.ok(Math.abs(g.bounds[i][1] - (carEnd + TRAFFIC.followGap)) < 1e-6, `${name} lap ${i + 1}`);
    });
  }
  console.log(`held-up laps across test strategies: ${heldLaps}`);
  assert.ok(heldLaps > 0, "no strategy ever met traffic");
});

test("traffic: the ghost only copies Hamilton's lap while it is where he was", () => {
  for (const [name, st] of Object.entries(DIVERGING)) {
    const g = simulateGhost(race, st);
    g.traffic.forEach((info, i) => {
      const offset = Math.abs(g.bounds[i][0] - realBounds[i][0]);
      assert.equal(info.mode, offset < TRAFFIC.sameSpot ? "lewis" : "own", `${name} lap ${i + 1}`);
    });
  }
});

test("one-compound race is flagged for disqualification", () => {
  const v = validateStrategy(race, [{ compound: "SOFT", from: 1, ageAtStart: 0 }, { compound: "SOFT", from: 30, ageAtStart: 0 }]);
  assert.equal(v.dsq, true);
  const ok = validateStrategy(race, realStrategy(race));
  assert.equal(ok.dsq, false);
  assert.equal(ok.ok, true);
});
