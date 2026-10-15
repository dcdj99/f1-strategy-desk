import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  simulateGhost, realStrategy, classify, validateStrategy, realProgress, ghostProgress, timeAtGhostLaps, HAM, TRAFFIC,
  passingModel, luck, raceOdds, usedSets, fitSets,
} from "../public/sim.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const realBounds = race.timelines[String(HAM)];
const realLaps = race.laps[String(HAM)];
const realTotal = realBounds.at(-1)[1] - realBounds[0][0];
const plan = (spec) => fitSets(race, spec.split(",").map((s) => ({ compound: s[0] === "S" ? "SOFT" : "MEDIUM", from: +s.slice(1) })));
const vscTwoStop = () => fitSets(race, [...realStrategy(race), { compound: "SOFT", from: 40 }]);
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

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
  // The lap-40 stop again, priced as a green-flag stop, timed without the laps lost behind cars and
  // averaged over passing luck. On the used softs Ferrari had, the cheaper stop often comes out
  // behind a car it can't pass, which can eat what it saved; stopping later is no fair contrast
  // either, since by lap 40 the old set is past its cliff.
  const greenPriced = { ...race, model: { ...race.model, pit_loss_vsc: race.model.pit_loss_green } };
  const clean = (r) => SEEDS.reduce((sum, seed) => {
    const g = simulateGhost(r, vscTwoStop(), { seed });
    return sum + g.total - g.traffic.reduce((s, t) => s + t.lost, 0);
  }, 0) / SEEDS.length;
  const green = clean(greenPriced);
  const vsc = clean(race);
  assert.ok(vsc < green, `VSC ${vsc} vs green ${green}`);
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
  "early stop": plan("M1,S11"),
  "long first stint": plan("M1,S31"),
  "soft start": plan("S1,M26"),
  "VSC two-stop": vscTwoStop(),
  "three stops": plan("S1,M13,S29,S46"),
};
const P = passingModel(race);
const inPits = (num, lap) => (race.pits[String(num)] || []).some((p) => p === lap || p === lap - 1);

test("traffic: every car the ghost gets past on track, it earned the pass", () => {
  for (const seed of SEEDS) {
    for (const [name, st] of Object.entries(DIVERGING)) {
      const g = simulateGhost(race, st, { seed });
      for (let lap = 1; lap <= 62; lap++) {
        const [s, e] = g.bounds[lap - 1];
        for (const d of race.drivers) {
          const b = race.timelines[String(d.num)];
          if (d.num === HAM || !b[lap - 1] || inPits(d.num, lap)) continue;
          const [cs, ce] = b[lap - 1];
          if (!(cs < s && ce > e)) continue; // started the lap ahead, finished it behind: a pass
          const where = `seed ${seed} ${name} lap ${lap}: ${d.code}`;
          const info = g.traffic[lap - 1];
          assert.ok(info.passed.includes(d.code), `${where} passed without a move`);
          // Either Hamilton's own pass, copied from where he was, or a roll that came up.
          const [rs, re] = realBounds[lap - 1];
          const hamiltonsPass = info.mode === "lewis" && cs < rs && ce > re;
          const won = info.attempts.some((a) => a.car === d.code && a.made);
          assert.ok(hamiltonsPass || won, `${where} passed without winning a roll`);
          assert.ok(!race.race.neutralised_laps.includes(lap), `${where} passed under the VSC`);
        }
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
      assert.ok(Math.abs(g.bounds[i][1] - (carEnd + P.followGap)) < 1e-6, `${name} lap ${i + 1}`);
    });
  }
  console.log(`held-up laps across test strategies: ${heldLaps}`);
  assert.ok(heldLaps > 0, "no strategy ever met traffic");
});

test("passing odds come from Marina Bay history and grow with pace advantage", () => {
  const m = race.model.passing;
  assert.ok(m.chances > 300 && m.passes > 30, `only ${m.chances} chances, ${m.passes} passes`);
  const odds = [-1, 0, 1, 2, 3].map(P.chance);
  for (let i = 1; i < odds.length; i++) assert.ok(odds[i] > odds[i - 1]);
  // The fitted curve stays near what really happened in each band of pace advantage.
  for (const band of m.observed) {
    const rate = band.passes / band.chances;
    const mid = Math.max(-1, Math.min(2.5, (band.advantage[0] + band.advantage[1]) / 2));
    const sd = Math.sqrt(rate * (1 - rate) / band.chances) + 0.02;
    console.log(`advantage ${band.advantage.join("..")}s: ${band.passes}/${band.chances} passed, model ${(P.chance(mid) * 100).toFixed(0)}% a lap`);
    assert.ok(Math.abs(P.chance(mid) - rate) < 3 * sd, `band ${band.advantage}: model ${P.chance(mid)} vs ${rate}`);
  }
});

test("luck: draws are uniform and the same draw comes back for the same lap and car", () => {
  const xs = [];
  for (let seed = 1; seed <= 50; seed++) for (let lap = 1; lap <= 62; lap++) for (const d of race.drivers) xs.push(luck(seed, lap, d.num));
  const deciles = Array(10).fill(0);
  for (const x of xs) { assert.ok(x >= 0 && x < 1); deciles[Math.floor(x * 10)]++; }
  for (const c of deciles) assert.ok(Math.abs(c / xs.length - 0.1) < 0.01, `decile share ${c / xs.length}`);
  assert.equal(luck(7, 33, 12), luck(7, 33, 12));
});

test("luck: moves come off about as often as the odds say", () => {
  let expected = 0, made = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const st of Object.values(DIVERGING)) {
      for (const info of simulateGhost(race, st, { seed }).traffic) {
        for (const a of info.attempts) { expected += a.chance; made += a.made; n++; }
      }
    }
  }
  const sd = Math.sqrt(expected);
  console.log(`${n} passing attempts: ${made} made, ${expected.toFixed(1)} expected`);
  assert.ok(n > 100 && Math.abs(made - expected) < 3 * sd);
});

test("luck: Ferrari's strategy is the real race whatever the luck", () => {
  const odds = raceOdds(race, realStrategy(race), 30);
  assert.deepEqual(odds.pos, { [race.drivers.find((d) => d.num === HAM).final_pos]: 30 });
  const g = simulateGhost(race, realStrategy(race), { seed: 99 });
  assert.ok(Math.max(...g.laps.map((d, i) => Math.abs(d - realLaps[i]))) < 1e-6);
});

test("luck: a strategy that ends up in traffic can finish in more than one place", () => {
  const spread = Object.values(DIVERGING).map((st) => Object.keys(raceOdds(race, st, 60).pos).length);
  assert.ok(spread.some((k) => k > 1), `every strategy finished in one place: ${spread}`);
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

test("a plan gets Ferrari's used sets of each compound first, then new ones", () => {
  // Both cars' real races come back on the sets they really had.
  const team = race.drivers.find((d) => d.num === HAM).team;
  for (const d of race.drivers.filter((x) => x.team === team)) {
    const real = race.stints[String(d.num)].map((s) => ({ compound: s.compound, from: s.lap_start, ageAtStart: s.age_at_start }));
    assert.deepEqual(fitSets(race, real.map(({ compound, from }) => ({ compound, from }))), real, d.code);
  }
  // Two used softs, as each car had; the third soft is new, and so is every medium.
  const soft = usedSets(race, "SOFT");
  assert.deepEqual(plan("S1,M13,S29,S46").map((s) => s.ageAtStart), [soft.age, 0, soft.age, 0]);
});

test("one-compound race is flagged for disqualification", () => {
  const v = validateStrategy(race, [{ compound: "SOFT", from: 1, ageAtStart: 0 }, { compound: "SOFT", from: 30, ageAtStart: 0 }]);
  assert.equal(v.dsq, true);
  const ok = validateStrategy(race, realStrategy(race));
  assert.equal(ok.dsq, false);
  assert.equal(ok.ok, true);
});
