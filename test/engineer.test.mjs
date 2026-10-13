import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateGhost, realStrategy, raceOdds } from "../public/sim.js";
import { buildSummary, builtInRadio, builtInDebrief } from "../public/engineer.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const bank = JSON.parse(readFileSync(new URL("../public/data/engineer.json", import.meta.url), "utf8"));
const TOTAL = race.race.total_laps;
const M = "MEDIUM", S = "SOFT";
const stint = (compound, from) => ({ compound, from, ageAtStart: 0 });

// A spread of plans: Ferrari's, one-stops all race long, two-stops, three stops, and an illegal one.
const PLANS = [realStrategy(race)];
for (let p = 5; p <= 57; p += 4) for (const [a, b] of [[M, S], [S, M]]) PLANS.push([stint(a, 1), stint(b, p + 1)]);
for (const p1 of [8, 14, 20, 26]) for (const p2 of [39, 44, 50]) for (const c of [[M, S, S], [S, M, S], [M, S, M], [S, S, M]]) {
  PLANS.push([stint(c[0], 1), stint(c[1], p1 + 1), stint(c[2], p2 + 1)]);
}
PLANS.push([stint(S, 1), stint(M, 13), stint(S, 29), stint(S, 46)]);
PLANS.push([stint(S, 1), stint(S, 30)]);

const races = PLANS.map((st) => {
  const ghost = simulateGhost(race, st);
  const odds = raceOdds(race, st, 40);
  const summary = buildSummary(race, ghost, st, odds);
  return {
    st, ghost, odds, summary,
    radio: builtInRadio(race, ghost, summary, bank, st),
    debrief: builtInDebrief(race, ghost, summary, bank, st, odds),
  };
});

const slotsIn = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

test("every line uses only slots the engineer fills, and radio calls stay short", () => {
  const radioSlots = new Set(["car", "tyres", "Tyres", "laps", "loss", "green", "pct", "gap", "pos", "realPos"]);
  const debriefSlots = new Set(["pos", "realPos", "gap", "green", "stops", "ferrariStops", "extra", "laps", "lap", "saved", "loss", "car", "usual", "usualPct"]);
  for (const [key, group] of Object.entries(bank.radio)) {
    assert.ok(["engineer", "driver"].includes(group.from), key);
    assert.ok(group.lines.length >= 2, `${key} needs variety`);
    for (const line of group.lines) {
      for (const s of slotsIn(line)) assert.ok(radioSlots.has(s), `${key}: unknown slot {${s}}`);
      assert.ok(line.split(/\s+/).length <= 16, `${key}: too long for radio: ${line}`);
    }
  }
  for (const [group, keys] of Object.entries(bank.debrief)) {
    for (const [key, lines] of Object.entries(keys)) {
      assert.ok(lines.length >= 2, `${group}.${key} needs variety`);
      for (const line of lines) for (const s of slotsIn(line)) assert.ok(debriefSlots.has(s), `${group}.${key}: unknown slot {${s}}`);
    }
  }
});

test("every race gets a start, a call before each stop, the flag, and no unfilled slots", () => {
  for (const { st, ghost, radio, debrief } of races) {
    const plan = st.map((s) => `${s.compound[0]}${s.from}`).join(" ");
    assert.ok(radio.length >= 8 && radio.length <= 16, `${plan}: ${radio.length} messages`);
    assert.ok(radio.every((m, i) => i === 0 || m.lap >= radio[i - 1].lap), `${plan}: out of order`);
    assert.equal(radio[0].lap, 1, plan);
    assert.match(radio[0].key, /^start_/, plan);
    assert.equal(radio.at(-1).lap, TOTAL + 1, plan);
    assert.match(radio.at(-1).key, /^flag_/, plan);
    for (const p of ghost.pitLaps) {
      assert.ok(radio.some((m) => /^box_/.test(m.key) && (m.lap === p || m.lap === p - 1)), `${plan}: no call for the lap-${p} stop`);
    }
    for (const text of [...radio.map((m) => m.text), debrief.headline, debrief.verdict, debrief.roast]) {
      assert.ok(text && !/[{}]/.test(text), `${plan}: ${text}`);
    }
    assert.ok(debrief.verdict.split(/(?<=[.!?])\s+/).length <= 3, `${plan}: verdict too long`);
  }
});

test("every situation in the line bank comes up in some race", () => {
  const radio = new Set(races.flatMap((r) => r.radio.map((m) => m.key)));
  const debrief = new Set(races.flatMap((r) => r.debrief.used));
  // Fallbacks for races no plan here produces; the luck lines have their own test below.
  const fallback = new Set(["reason.generic_behind", "luck.lucky", "luck.unlucky"]);
  for (const key of Object.keys(bank.radio)) assert.ok(radio.has(key), `radio ${key} never plays`);
  for (const [group, keys] of Object.entries(bank.debrief)) {
    for (const key of Object.keys(keys)) {
      const k = `${group}.${key}`;
      if (!fallback.has(k)) assert.ok(debrief.has(k), `debrief ${k} never used`);
    }
  }
});

test("the debrief calls the race lucky or unlucky against where the plan usually finishes", () => {
  // A race whose verdict has room for a third sentence (one reason, no traffic note).
  const { st, ghost, summary } = races.find((r) => r.debrief.outcome !== "copy" && r.debrief.outcome !== "dsq"
    && r.debrief.used.filter((k) => k.startsWith("reason.")).length === 1);
  const pos = summary.result.your_position;
  const usually = (p) => ({ runs: 40, dsq: 0, pos: { [p]: 30, [pos]: 10 } });
  const lucky = builtInDebrief(race, ghost, summary, bank, st, usually(pos + 1));
  const unlucky = builtInDebrief(race, ghost, summary, bank, st, usually(pos - 1));
  const usual = builtInDebrief(race, ghost, summary, bank, st, { runs: 40, dsq: 0, pos: { [pos]: 40 } });
  assert.ok(lucky.used.includes("luck.lucky"), lucky.verdict);
  assert.match(lucky.verdict, new RegExp(`P${pos + 1}`));
  assert.ok(unlucky.used.includes("luck.unlucky"), unlucky.verdict);
  assert.ok(!usual.used.some((k) => k.startsWith("luck.")), usual.verdict);
});

test("the same plan always hears the same lines", () => {
  const { st } = races[5];
  const ghost = simulateGhost(race, st);
  const odds = raceOdds(race, st, 40);
  const summary = buildSummary(race, ghost, st, odds);
  assert.deepEqual(builtInRadio(race, ghost, summary, bank, st), races[5].radio);
  assert.deepEqual(builtInDebrief(race, ghost, summary, bank, st, odds), races[5].debrief);
});

test("Ferrari's plan: the engineer tells Hamilton's real race", () => {
  const { radio, debrief } = races[0];
  const at = (key) => radio.find((m) => m.key === key);
  assert.ok(at("start_copy"));
  assert.ok(at("stuck_driver") && at("stuck_driver").lap === 2 && /Leclerc/.test(at("stuck_driver").text));
  assert.ok(at("box_next_lap") && at("box_next_lap").lap === 17);
  assert.ok(at("pass_made") && at("pass_made").lap === 20 && /Lawson/.test(at("pass_made").text));
  assert.ok(at("t1_you") && at("t1_you").lap === 54);
  assert.ok(at("gap_level"));
  assert.equal(radio.at(-1).key, "flag_copy");
  assert.equal(debrief.outcome, "copy");
});
