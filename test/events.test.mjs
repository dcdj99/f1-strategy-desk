import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simulateGhost, realStrategy, realProgress, ghostProgress, pitLoss, progressAt, inWindow, stackedBehind, HAM } from "../public/sim.js";
import { buildSummary, builtInRadio } from "../public/engineer.js";
import { vscPeriods, outAt, raceMoments, timelineMarks } from "../public/moments.js";

const race = JSON.parse(readFileSync(new URL("../public/data/race.json", import.meta.url), "utf8"));
const bank = JSON.parse(readFileSync(new URL("../public/data/engineer.json", import.meta.url), "utf8"));
const TOTAL = race.race.total_laps;
const plan = (spec) => spec.split(",").map((s) => ({ compound: s[0] === "S" ? "SOFT" : "MEDIUM", from: +s.slice(1), ageAtStart: 0 }));
const PLANS = {
  "Ferrari's call": realStrategy(race),
  "box lap 2": plan("S1,M3"),
  "box lap 7, just before the VSC": plan("M1,S8"),
  "box lap 8, under the VSC": plan("M1,S9"),
  "box lap 9, just after the VSC": plan("M1,S10"),
  "box lap 30": plan("M1,S31"),
  "box lap 38, just before the VSC": plan("M1,S39"),
  "VSC two-stop": [...realStrategy(race), { compound: "SOFT", from: 40, ageAtStart: 0 }],
  "box lap 60": plan("M1,S61"),
  "box lap 24, stacked behind Leclerc": plan("S1,M25"),
};
const VSCS = vscPeriods(race);
const inVsc = (t) => VSCS.some(([a, z]) => a <= t && t <= z);
const byName = Object.fromEntries(race.drivers.map((d) => [d.name.split(/\s+/).at(-1).toLowerCase(), d.num]));
const events = (kind, driver) => race.events.filter((e) => e.kind === kind && (driver === undefined || e.driver === driver));

test("every radio call plays just after what it talks about", () => {
  for (const [name, st] of Object.entries(PLANS)) {
    const ghost = simulateGhost(race, st);
    const summary = buildSummary(race, ghost, st, null);
    const radio = builtInRadio(race, ghost, summary, bank, st);
    const wins = ghost.pitWindows;
    assert.equal(wins.length, ghost.pitLaps.length, name);
    assert.ok(radio.every((m, i) => i === 0 || m.t >= radio[i - 1].t), `${name}: radio out of order`);
    for (const m of radio) {
      const where = `${name}: ${m.key} at ${m.t}s ("${m.text}")`;
      // Nobody mentions the VSC unless it's out.
      if (/\bVSC\b|virtual safety car/i.test(m.text)) assert.ok(inVsc(m.t), `${where} with no VSC out`);
      const next = wins.find(([a]) => a > m.t);
      const last = wins.filter(([a]) => a <= m.t).at(-1);
      if (m.key === "box_vsc") {
        assert.ok(next && inVsc(next[0]), `${where}: should come before a stop made under the VSC`);
      } else if (/^box_/.test(m.key)) {
        assert.ok(next && next[0] - m.t < 200, `${where}: should come within a lap or so before a stop`);
      } else if (/^out_lap/.test(m.key)) {
        assert.ok(last && m.t >= last[1], `${where}: should come after leaving the pit lane`);
      } else if (m.key === "vsc_stay_out") {
        assert.ok(!wins.some(([a, z]) => VSCS.some(([va, vz]) => a <= vz && z >= va && va <= m.t && m.t <= vz)), `${where}: pitting under this VSC`);
      } else if (m.key === "stacked") {
        assert.ok(stackedBehind(ghost, m.t), `${where}: not waiting at the box then`);
      } else if (m.key === "car_out") {
        assert.ok(events("out").some((e) => e.t < m.t && m.t - e.t < 30), `${where}: no car had just stopped`);
      } else if (m.key === "t1_you" || m.key === "ferrari_off") {
        assert.ok(m.t > events("incident", HAM)[0].t, `${where}: before the stewards noted it`);
      } else if (m.key === "t1_cleared") {
        assert.ok(m.t > events("incident", HAM).find((e) => /no further action/.test(e.text)).t, `${where}: before the stewards cleared it`);
      } else if (m.key === "pass_made" || m.key === "passed_by") {
        const num = Object.entries(byName).find(([n]) => m.text.toLowerCase().includes(n))?.[1];
        assert.ok(num, `${where}: no driver named`);
        const ghostAhead = ghostProgress(race, ghost, m.t) > realProgress(race, num, m.t);
        assert.equal(ghostAhead, m.key === "pass_made", `${where}: the map doesn't show it yet`);
      } else if (m.key === "last_lap") {
        assert.equal(Math.floor(progressAt(ghost.bounds, m.t)) + 1, TOTAL, where);
      } else if (/^flag_/.test(m.key)) {
        assert.ok(m.t > ghost.finish, `${where}: before the ghost's flag`);
      }
    }
  }
});

test("a stop is priced as under the VSC only when the ghost comes in while the VSC is out", () => {
  const green = race.model.pit_loss_green;
  let cheap = 0;
  for (let p = 2; p < TOTAL; p++) {
    const ghost = simulateGhost(race, plan(`M1,S${p + 1}`));
    const vsc = pitLoss(race, p) < green - 0.5;
    cheap += vsc;
    assert.equal(vsc, inVsc(ghost.pitWindows[0][0]), `box at the end of lap ${p}: pit entry ${ghost.pitWindows[0][0].toFixed(1)}s, priced ${pitLoss(race, p).toFixed(1)}s`);
  }
  assert.equal(cheap, VSCS.length, "one cheap lap per VSC");
});

test("a retired car stops where the position feed shows it stopping, not back at the line", () => {
  const stops = Object.entries(race.retired || {});
  assert.ok(stops.length >= 1);
  for (const [n, s] of stops) {
    const code = race.drivers.find((d) => String(d.num) === n).code;
    const b = race.timelines[n];
    assert.ok(s.t >= b.at(-1)[1] && s.t < b.at(-1)[1] + 600, `${code}: stops ${s.t}s, last lap ended ${b.at(-1)[1]}s`);
    const p = realProgress(race, n, s.t);
    assert.ok(realProgress(race, n, s.t + 120) - p < 1e-3, `${code} moves after stopping`);
    assert.ok(p - realProgress(race, n, s.t - 30) > 0.005, `${code} wasn't moving before the stop`);
    assert.ok(p - b.length > 0.005 && p - b.length < 1, `${code}: held at ${p} laps, timing has ${b.length}`);
    assert.ok(events("out", +n).some((e) => e.t === s.t), `${code}: the retirement should show when it stopped`);
    if (s.pit != null) assert.ok(s.pit <= s.t && s.t - s.pit < 60, `${code}: into the pit lane at ${s.pit}s`);
  }
});

test("each incident is placed when it happened, before the stewards' message", () => {
  const first = {};
  for (const e of events("incident")) {
    assert.ok(e.at != null, `${e.text}: no time`);
    assert.ok(e.at < e.t && e.t - e.at < 1800, `${e.text}: happened ${e.at}s, posted ${e.t}s`);
    first[e.driver] ??= e;
  }
  // Two cars noted at Turn 1, an hour and a half apart: the times put both at the same spot.
  const t1 = Object.values(first).filter((e) => / at Turn 1$/.test(e.what));
  assert.ok(t1.length >= 2);
  const spots = t1.map((e) => realProgress(race, e.driver, e.at) % 1);
  console.log(`Turn 1 incidents at ${spots.map((f) => f.toFixed(3)).join(", ")} of a lap`);
  assert.ok(Math.max(...spots) - Math.min(...spots) < 0.03, `Turn 1 at ${spots}`);
});

test("the map, the ticker, the marks under the strategy bar and the tower agree on when each thing happened", () => {
  const moments = raceMoments(race);
  const code = Object.fromEntries(race.drivers.map((d) => [d.num, d.code]));
  // A stop shows in the ticker as the map shows the car turning into the pit lane.
  for (const e of moments.filter((m) => m.kind === "pit")) {
    const wins = race.pit_windows[String(e.driver)];
    assert.ok(!inWindow(wins, e.t - 0.5) && inWindow(wins, e.t + 0.5), `${e.text} at ${e.t}s, pit lane ${JSON.stringify(wins)}`);
  }
  // A car is out (tower, ticker, map) when it stops, not when its last timed lap ends.
  for (const d of race.drivers) {
    const out = outAt(race, d.num);
    const events = moments.filter((m) => m.kind === "out" && m.driver === d.num);
    if (out === null) { assert.equal(events.length, 0, d.code); continue; }
    assert.deepEqual(events.map((e) => e.t), [out], `${d.code}: out at ${out}s`);
    if (race.retired[String(d.num)]) assert.equal(out, race.retired[String(d.num)].t, d.code);
  }
  // Going off shows at the moment it happened.
  for (const e of moments.filter((m) => m.kind === "incident")) {
    assert.ok(moments.some((m) => m.kind === "off" && m.driver === e.driver && m.t === e.at), `${e.text}: no moment for it`);
  }
  // Marks under the bar sit where the playhead is when it happens: a lapped car's retirement too.
  const ghost = simulateGhost(race, realStrategy(race));
  const lapsAt = (t) => ghostProgress(race, ghost, t);
  const marks = timelineMarks(race, lapsAt);
  assert.deepEqual(marks.filter((m) => m.kind === "vsc").map((m) => [m.t, m.end]), vscPeriods(race));
  assert.deepEqual(marks.filter((m) => m.kind === "off").map((m) => m.t), [moments.find((m) => m.kind === "incident" && m.driver === HAM).at]);
  for (const m of marks) {
    assert.equal(m.at, lapsAt(m.t), `${m.kind} at ${m.t}s`);
    if (m.kind === "out") {
      assert.equal(m.t, outAt(race, m.driver), code[m.driver]);
      const own = race.timelines[String(m.driver)].length;
      console.log(`${code[m.driver]} stops at ${m.t}s: playhead on ${m.at.toFixed(2)} laps; its own lap count ${own}`);
    }
  }
  // The VSC band covers the stops priced as VSC stops, and not the laps either side.
  const green = race.model.pit_loss_green;
  for (const m of timelineMarks(race, (t) => realProgress(race, HAM, t)).filter((x) => x.kind === "vsc")) {
    for (let p = Math.floor(m.at) - 1; p <= Math.ceil(m.to) + 1; p++) {
      assert.equal(p >= m.at && p <= m.to, pitLoss(race, p) < green - 0.5, `VSC ${m.at.toFixed(2)}-${m.to.toFixed(2)} laps, box at the end of lap ${p}`);
    }
  }
});
