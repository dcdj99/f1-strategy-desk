// Race simulator shared by the browser and the Node tests.
// Real cars replay their real race. The ghost Hamilton replays Hamilton's real laps and only
// swaps in the difference your strategy makes: tyre pace (fitted model) and pit-stop cost.

export const HAM = 44;

export function tyreModelLap(model, lap, compound, age) {
  const base = model.driver_base[String(HAM)];
  const softOffset = compound === "SOFT" ? model.soft_offset : 0;
  const cliffAt = model.cliff_at[compound];
  const cliff = model.cliff[compound] * Math.max(0, age - cliffAt) ** 2;
  return base + model.fuel_per_lap * lap + softOffset + model.deg[compound] * age + cliff;
}

// The real strategy, read from the data: [{compound, from, ageAtStart}]
export function realStrategy(race) {
  return race.stints[String(HAM)].map((s) => ({
    compound: s.compound,
    from: s.lap_start,
    ageAtStart: s.age_at_start,
  }));
}

export function validateStrategy(race, stints) {
  const total = race.race.total_laps;
  const problems = [];
  if (!stints.length || stints[0].from !== 1) problems.push("First stint must start on lap 1.");
  for (let i = 1; i < stints.length; i++) {
    if (stints[i].from <= stints[i - 1].from + 1) problems.push(`Stint ${i + 1} is too short.`);
    if (stints[i].from > total) problems.push(`Stint ${i + 1} starts after the flag.`);
  }
  const compounds = new Set(stints.map((s) => s.compound));
  const dsq = compounds.size < 2;
  return { ok: problems.length === 0, problems, dsq };
}

export function tyreAt(stints, lap) {
  let cur = stints[0];
  for (const s of stints) if (s.from <= lap) cur = s;
  return { compound: cur.compound, age: (cur.ageAtStart || 0) + (lap - cur.from), stint: stints.indexOf(cur) };
}

// Pit cost for boxing at the end of `lap`. VSC stops are cheaper.
function pitLoss(race, lap) {
  const m = race.model;
  const vsc = new Set(race.race.neutralised_laps);
  if (vsc.has(lap) && vsc.has(lap + 1)) return m.pit_loss_vsc;
  if (vsc.has(lap) || vsc.has(lap + 1)) return (m.pit_loss_vsc + m.pit_loss_green) / 2;
  return m.pit_loss_green;
}

const pitLapsOf = (stints) => stints.slice(1).map((s) => s.from - 1);

export function simulateGhost(race, stints) {
  const total = race.race.total_laps;
  const model = race.model;
  const realLaps = race.laps[String(HAM)];
  const realStints = realStrategy(race);
  const vsc = new Set(race.race.neutralised_laps);
  const pitLaps = pitLapsOf(stints);
  const realPits = pitLapsOf(realStints);
  const modelReal = (lap) => { const r = tyreAt(realStints, lap); return tyreModelLap(model, lap, r.compound, r.age); };
  const modelYou = (lap) => { const g = tyreAt(stints, lap); return tyreModelLap(model, lap, g.compound, g.age); };

  // What Hamilton's real stop cost on the in-lap and the out-lap, above a clean lap.
  const realIn = {}, realOut = {};
  for (const p of realPits) {
    realIn[p] = realLaps[p - 1] - modelReal(p);
    realOut[p] = realLaps[p] - modelReal(p + 1);
  }
  const p0 = realPits[0];
  const inShare = p0 ? realIn[p0] / (realIn[p0] + realOut[p0]) : 0.35;

  const laps = [];
  const tyres = [];
  const profile = [];
  for (let lap = 1; lap <= total; lap++) {
    tyres.push(tyreAt(stints, lap));
    const realPitLap = realPits.includes(lap) || realPits.includes(lap - 1);
    // Hamilton's real lap with his own pit stop taken out: keeps traffic, battles, VSC.
    const base = realPitLap ? modelReal(lap) : realLaps[lap - 1];
    // Tyres don't matter while everyone crawls behind the VSC.
    const tyreDelta = vsc.has(lap) ? 0 : modelYou(lap) - modelReal(lap);
    let pit = 0;
    if (pitLaps.includes(lap)) pit += realPits.includes(lap) ? realIn[lap] : inShare * pitLoss(race, lap);
    if (pitLaps.includes(lap - 1)) pit += realPits.includes(lap - 1) ? realOut[lap - 1] : (1 - inShare) * pitLoss(race, lap - 1);
    laps.push(base + tyreDelta + pit);

    // Which of Hamilton's real laps to borrow the in-lap motion from (where he braked, crawled, pitted).
    let from = lap;
    if (pitLaps.includes(lap)) from = vsc.has(lap) ? lap : (p0 ?? lap);
    else if (pitLaps.includes(lap - 1)) from = vsc.has(lap) ? lap : (p0 ? p0 + 1 : lap);
    else if (realPitLap) from = [lap - 2, lap + 2, lap - 3].find((l) => l >= 2 && l <= total && !vsc.has(l) && !realPits.includes(l) && !realPits.includes(l - 1)) ?? lap;
    profile.push(from);
  }

  const start = race.timelines[String(HAM)][0][0];
  const bounds = [];
  let t = start;
  for (const d of laps) {
    bounds.push([t, t + d]);
    t += d;
  }
  return { laps, tyres, bounds, pitLaps, profile, finish: t, total: t - start };
}

// Laps completed (with fraction) at race time t, for a timeline of [start, end] pairs.
export function progressAt(bounds, t) {
  if (!bounds.length || t < bounds[0][0]) return 0;
  for (let i = 0; i < bounds.length; i++) {
    const [s, e] = bounds[i];
    if (t < e) return i + (t - s) / (e - s);
  }
  return bounds.length;
}

// Real on-track progress (laps, fractional) from the car-position feed, on a 1-second race clock.
export function realProgress(race, num, t) {
  const series = race.progress?.[String(num)];
  if (!series) return progressAt(race.timelines[String(num)] || [], t);
  if (t <= 0) return series[0] / 10000;
  const i = Math.floor(t);
  if (i >= series.length - 1) return series[series.length - 1] / 10000;
  const k = t - i;
  return (series[i] * (1 - k) + series[i + 1] * k) / 10000;
}

// The ghost's on-track progress: its own lap timing, with the in-lap motion of the real lap it borrows.
export function ghostProgress(race, ghost, t) {
  const b = ghost.bounds;
  if (t < b[0][0]) return realProgress(race, HAM, t);
  if (t >= b[b.length - 1][1]) return b.length;
  let i = 0;
  while (i < b.length - 1 && t >= b[i][1]) i++;
  const tau = (t - b[i][0]) / (b[i][1] - b[i][0]);
  const from = ghost.profile[i];
  const rb = race.timelines[String(HAM)][from - 1];
  if (!rb || !race.progress?.[String(HAM)]) return i + tau;
  // Where the real car was at the same point through the borrowed lap, shifted to this lap.
  const within = realProgress(race, HAM, rb[0] + tau * (rb[1] - rb[0])) - (from - 1);
  return i + Math.min(1.02, Math.max(-0.02, within));
}

// Race time at which the ghost reaches a given number of laps (for scrubbing the timeline).
export function timeAtGhostLaps(ghost, laps) {
  const b = ghost.bounds;
  if (laps <= 0) return 0;
  if (laps >= b.length) return b[b.length - 1][1];
  const i = Math.floor(laps);
  return b[i][0] + (laps - i) * (b[i][1] - b[i][0]);
}

// Classification for the ghost at the flag: real cars keep their real result, HAM is replaced.
export function classify(race, ghost) {
  const rows = [];
  for (const d of race.drivers) {
    if (d.num === HAM) continue;
    const b = race.timelines[String(d.num)] || [];
    if (!b.length) continue;
    rows.push({ num: d.num, code: d.code, laps: b.length, finish: b[b.length - 1][1], ghost: false });
  }
  rows.push({ num: HAM, code: "YOU", laps: ghost.bounds.length, finish: ghost.finish, ghost: true });
  // Cars that stopped short of 90% distance rank behind every classified car, by laps completed.
  const total = race.race.total_laps;
  const leaderFinish = Math.min(...rows.filter((r) => r.laps >= total).map((r) => r.finish));
  const classified = (r) => r.laps >= total || r.finish > leaderFinish || r.laps >= Math.floor(0.9 * total);
  rows.sort((a, b) => (classified(b) - classified(a)) || (b.laps - a.laps) || (a.finish - b.finish));
  return rows.map((r, i) => ({ ...r, pos: i + 1 }));
}
