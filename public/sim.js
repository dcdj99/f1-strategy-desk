// Race simulator shared by the browser and the Node tests.
// Real cars replay their real lap timelines; the ghost Hamilton runs the fitted tyre model.

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

export function simulateGhost(race, stints) {
  const total = race.race.total_laps;
  const model = race.model;
  const realLaps = race.laps[String(HAM)];
  const realStints = realStrategy(race);
  const vsc = new Set(race.race.neutralised_laps);
  const pitLaps = stints.slice(1).map((s) => s.from - 1);
  const realPitLaps = new Set(realStints.slice(1).map((s) => s.from - 1));

  const laps = [];
  const tyres = [];
  for (let lap = 1; lap <= total; lap++) {
    const t = tyreAt(stints, lap);
    tyres.push(t);
    let dur;
    if (lap === 1 || vsc.has(lap)) {
      // Standing start and neutralised laps: everyone runs the real pace.
      // Swap out the real car's tyre effect for the ghost's on lap 1.
      const r = tyreAt(realStints, lap);
      dur = realLaps[lap - 1];
      if (realPitLaps.has(lap) || realPitLaps.has(lap - 1)) dur = tyreModelLap(model, lap, r.compound, r.age);
      dur += tyreModelLap(model, lap, t.compound, t.age) - tyreModelLap(model, lap, r.compound, r.age);
    } else {
      dur = tyreModelLap(model, lap, t.compound, t.age);
    }
    // Pit loss split across the in-lap and the out-lap.
    if (pitLaps.includes(lap)) dur += 0.35 * pitLoss(race, lap);
    if (pitLaps.includes(lap - 1)) dur += 0.65 * pitLoss(race, lap - 1);
    laps.push(dur);
  }

  const start = race.timelines[String(HAM)][0][0];
  const bounds = [];
  let t = start;
  for (const d of laps) {
    bounds.push([t, t + d]);
    t += d;
  }
  return { laps, tyres, bounds, pitLaps, finish: t, total: t - start };
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
  // Retired cars rank behind everyone still running, by laps completed.
  const total = race.race.total_laps;
  const leaderFinish = Math.min(...rows.filter((r) => r.laps >= total).map((r) => r.finish));
  const classified = (r) => r.laps >= total || r.finish > leaderFinish;
  rows.sort((a, b) => (classified(b) - classified(a)) || (b.laps - a.laps) || (a.finish - b.finish));
  return rows.map((r, i) => ({ ...r, pos: i + 1 }));
}

// Gap (seconds) from the ghost to a real driver at the end of a given lap; positive = ghost behind.
export function gapAtLap(race, ghost, num, lap) {
  const b = race.timelines[String(num)];
  if (!b || !b[lap - 1]) return null;
  return ghost.bounds[lap - 1][1] - b[lap - 1][1];
}
