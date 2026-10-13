import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateGhost, realStrategy, classify, validateStrategy, HAM } from "../public/sim.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const realBounds = race.timelines[String(HAM)];
const realTotal = realBounds.at(-1)[1] - realBounds[0][0];

test("control: Ferrari's real strategy reproduces Hamilton's real race time", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  const delta = ghost.total - realTotal;
  console.log(`real ${realTotal.toFixed(2)}s  model ${ghost.total.toFixed(2)}s  delta ${delta.toFixed(2)}s`);
  assert.ok(Math.abs(delta) < 3, `model off by ${delta.toFixed(2)}s`);
});

test("control: real strategy classifies where Hamilton really finished", () => {
  const ghost = simulateGhost(race, realStrategy(race));
  const me = classify(race, ghost).find((r) => r.ghost);
  const realPos = race.drivers.find((d) => d.num === HAM).final_pos;
  console.log(`model P${me.pos}, real P${realPos}`);
  assert.equal(me.pos, realPos);
});

test("pitting under the lap-39 VSC for fresh softs beats staying out", () => {
  const twoStop = [...realStrategy(race), { compound: "SOFT", from: 40, ageAtStart: 0 }];
  const ghost = simulateGhost(race, twoStop);
  const me = classify(race, ghost).find((r) => r.ghost);
  console.log(`VSC two-stop: ${ghost.total.toFixed(2)}s (${(ghost.total - realTotal).toFixed(2)}s vs real), P${me.pos}`);
  assert.ok(ghost.total < realTotal);
});

test("one-compound race is flagged for disqualification", () => {
  const v = validateStrategy(race, [{ compound: "SOFT", from: 1, ageAtStart: 0 }, { compound: "SOFT", from: 30, ageAtStart: 0 }]);
  assert.equal(v.dsq, true);
  const ok = validateStrategy(race, realStrategy(race));
  assert.equal(ok.dsq, false);
  assert.equal(ok.ok, true);
});
