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

// Pit cost for boxing at the end of `lap`. A stop is cheaper only when the VSC is out as the car
// comes in: the VSC runs over the line, so that lap and the next are both neutralised. Boxing at the
// end of the lap before (the VSC came out after the car had left the pits) or the lap after (it had
// ended) costs a normal stop.
export function pitLoss(race, lap) {
  const m = race.model;
  const vsc = new Set(race.race.neutralised_laps);
  return vsc.has(lap) && vsc.has(lap + 1) ? m.pit_loss_vsc : m.pit_loss_green;
}

const pitLapsOf = (stints) => stints.slice(1).map((s) => s.from - 1);

// From a car moving off its pit box to the next car stopping in it: one rolls out, the other rolls in.
// Timed on the speed trace in real double stacks on OpenF1 since 2023 where the second car was held
// right behind the box: 2.5 to 3.2s in eight of them, and 3.0 to 3.1s in Ferrari's three.
export const BOX_CLEAR = 3;

// When a Ferrari stood at 0 km/h in its box at each stop, [from, to] in race seconds, from its speed
// trace: the scale BOX_CLEAR was measured on. The position feed (boxStops) is smoothed onto a
// one-second clock, which blurs a stop's ends by up to half a second.
export function boxStill(race, num) {
  return race.box_stops?.[String(num)] ?? boxStops(race, num);
}

// When a car stood still in its pit box at each stop, [from, to] in race seconds: under about 1 m/s
// in the position feed while in the pit lane. This is where the map shows it stopped.
const boxCache = new WeakMap();
export function boxStops(race, num) {
  let byCar = boxCache.get(race);
  if (!byCar) boxCache.set(race, (byCar = {}));
  byCar[num] ??= (race.pit_windows?.[String(num)] || []).map(([a, z]) => {
    let s0 = null, s1 = null;
    for (let t = Math.max(a, 0); t < z; t += 0.05) {
      if (realProgress(race, num, t + 0.05) - realProgress(race, num, t) < 1e-5) { s0 ??= t; s1 = t + 0.05; }
    }
    return s0 === null ? null : [s0, s1];
  }).filter(Boolean);
  return byCar[num];
}

// Traffic rules for when the ghost is somewhere Hamilton wasn't.
export const TRAFFIC = {
  sameSpot: 0.5,    // within this many seconds of the real car: it gets Hamilton's real lap, traffic and all
  dirtyAir: 1.0,    // a car this close ahead at the line counts as traffic
  justAhead: 0.1,   // a completed move crosses the line at least this far ahead
};

// Passing odds fitted on every Singapore GP on OpenF1 (scripts/fit_passing.py).
export function passingModel(race) {
  const m = race.model.passing;
  return {
    chance: (advantage) => 1 / (1 + Math.exp(-(m.a + m.b * advantage))),
    followGap: m.follow_gap,  // how close a car that can't get by sits at the line
    passCost: m.pass_cost,    // what a move costs against the attacker's own pace
    inRange: m.in_range,      // a go at passing needs the lap started this close behind
  };
}

// The same draw for the same lap and car in every strategy, so two plans that meet
// the same car on the same lap get the same luck. Uniform in [0, 1).
export function luck(seed, lap, num) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(lap + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(num + 0x165667b1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Gap (s) from a car to the nearest car ahead on the same lap, as it starts `lap`.
function gapAhead(race, num, lap) {
  const me = race.timelines[String(num)]?.[lap - 1];
  if (!me) return Infinity;
  let best = Infinity;
  for (const [n, b] of Object.entries(race.timelines)) {
    if (n === String(num) || !b[lap - 1]) continue;
    const g = me[0] - b[lap - 1][0];
    if (g > 0 && g < best) best = g;
  }
  return best;
}

// Hamilton's pace with the traffic taken out, lap by lap.
function hamiltonCleanAir(race, modelReal, realPits) {
  const total = race.race.total_laps;
  const realLaps = race.laps[String(HAM)];
  const vsc = new Set(race.race.neutralised_laps);
  const pitLap = (l) => realPits.includes(l) || realPits.includes(l - 1);
  const inTraffic = [];
  const residual = {};
  for (let l = 1; l <= total; l++) {
    const held = gapAhead(race, HAM, l) < TRAFFIC.dirtyAir || gapAhead(race, HAM, l + 1) < TRAFFIC.dirtyAir;
    inTraffic.push(held && l > 1 && !vsc.has(l));
    if (l > 1 && !vsc.has(l) && !pitLap(l) && !held) residual[l] = realLaps[l - 1] - modelReal(l);
  }
  const local = (l) => {
    for (const w of [4, 8, 16]) {
      const near = Object.entries(residual).filter(([k]) => Math.abs(k - l) <= w).map(([, r]) => r);
      if (near.length >= 3) return median(near);
    }
    return 0;
  };
  const clean = [];
  for (let l = 1; l <= total; l++) {
    if (vsc.has(l) || l === 1) clean.push(realLaps[l - 1]);
    else if (pitLap(l) || inTraffic[l - 1]) clean.push(modelReal(l) + local(l));
    else clean.push(realLaps[l - 1]);
  }
  return { clean, inTraffic };
}

export function simulateGhost(race, stints, { seed = 1 } = {}) {
  const total = race.race.total_laps;
  const model = race.model;
  const realLaps = race.laps[String(HAM)];
  const realB = race.timelines[String(HAM)];
  const realStints = realStrategy(race);
  const vsc = new Set(race.race.neutralised_laps);
  const pitLaps = pitLapsOf(stints);
  const realPits = pitLapsOf(realStints);
  const modelReal = (lap) => { const r = tyreAt(realStints, lap); return tyreModelLap(model, lap, r.compound, r.age); };
  const modelYou = (lap) => { const g = tyreAt(stints, lap); return tyreModelLap(model, lap, g.compound, g.age); };
  const { clean } = hamiltonCleanAir(race, modelReal, realPits);
  const codes = Object.fromEntries(race.drivers.map((d) => [String(d.num), d.code]));
  const pitsOf = (n) => race.pits[n] || [];
  const P = passingModel(race);

  // What Hamilton's real stop cost on the in-lap and the out-lap, above a clean lap.
  const realIn = {}, realOut = {};
  for (const p of realPits) {
    realIn[p] = realLaps[p - 1] - modelReal(p);
    realOut[p] = realLaps[p] - modelReal(p + 1);
  }
  const p0 = realPits[0];
  // Double stacking: the ghost shares the Ferrari box with Leclerc. Hamilton's real stop says how long
  // after crossing the timing line (which the pit lane crosses) a car reaches the box: on the map, and
  // on the speed trace, which times the stack.
  const team = race.drivers.find((d) => d.num === HAM)?.team;
  const mates = race.drivers.filter((d) => d.team === team && d.num !== HAM)
    .flatMap((d) => boxStill(race, d.num).map(([a, z]) => ({ code: d.code, a, z })));
  const hamBox = p0 ? boxStops(race, HAM)[0] : null;
  const hamStill = p0 ? boxStill(race, HAM)[0] : null;
  const boxAfterLine = hamBox ? hamBox[0] - realB[p0 - 1][1] : null;
  const stillAfterLine = hamStill ? hamStill[0] - realB[p0 - 1][1] : null;
  const pitWaits = [];
  const inShare = p0 ? realIn[p0] / (realIn[p0] + realOut[p0]) : 0.35;

  const laps = [], tyres = [], profile = [], bounds = [], traffic = [];
  let t = realB[0][0];
  for (let lap = 1; lap <= total; lap++) {
    tyres.push(tyreAt(stints, lap));
    const realPitLap = realPits.includes(lap) || realPits.includes(lap - 1);
    // Tyres don't matter while everyone crawls behind the VSC.
    const tyreDelta = vsc.has(lap) ? 0 : modelYou(lap) - modelReal(lap);
    let pit = 0;
    if (pitLaps.includes(lap)) pit += realPits.includes(lap) ? realIn[lap] : inShare * pitLoss(race, lap);
    if (pitLaps.includes(lap - 1)) pit += realPits.includes(lap - 1) ? realOut[lap - 1] : (1 - inShare) * pitLoss(race, lap - 1);
    if (pitLaps.includes(lap - 1) && stillAfterLine !== null) {
      // Leclerc got to the box first: wait just short of it until he has gone. If the ghost gets there
      // first it goes first (his real stop can't move).
      const arrive = t + stillAfterLine;
      const m = mates.find(({ a, z }) => a <= arrive && arrive < z + BOX_CLEAR);
      const wait = m ? m.z + BOX_CLEAR - arrive : 0;
      pitWaits.push(m ? { wait, behind: m.code } : { wait: 0, behind: null });
      pit += wait;
    }

    const offset = t - realB[lap - 1][0];
    const copying = Math.abs(offset) < TRAFFIC.sameSpot;
    const info = { mode: copying ? "lewis" : "own", held: null, chance: 0, passed: [], attempts: [], lost: 0 };
    // What the ghost could do this lap with nobody in the way.
    const potential = clean[lap - 1] + tyreDelta + pit;
    // Same spot as the real car: Hamilton's real lap, traffic and all. Elsewhere: his clean-air pace.
    const natural = copying ? (realPitLap ? modelReal(lap) : realLaps[lap - 1]) + tyreDelta + pit : potential;
    let end = t + natural;
    const [realS, realE] = realB[lap - 1];
    const ahead = Object.entries(race.timelines)
      .filter(([n, b]) => n !== String(HAM) && b[lap - 1] && b[lap - 1][0] < t)
      .sort((a, b) => b[1][lap - 1][0] - a[1][lap - 1][0]);
    const passedAt = {}; // where each car passed crosses the line
    for (const [n, b] of ahead) {
      const [carStart, carEnd] = b[lap - 1];
      if (end >= carEnd + P.followGap) continue;                           // never gets close to this car
      if (pitsOf(n).includes(lap) || pitsOf(n).includes(lap - 1)) continue; // it's in the pit lane
      // Hamilton started this lap behind this car, the ghost is where he was and no quicker: his result stands.
      if (copying && carStart < realS && natural <= realLaps[lap - 1] + 0.05) {
        if (realE < carEnd) { info.passed.push(codes[n]); passedAt[codes[n]] = carEnd; continue; }
        if (realE < carEnd + P.followGap) continue;
      }
      // A go at passing needs the lap started in range, no VSC, and no car already holding it up.
      const advantage = (carEnd - carStart) - potential;
      const chance = !vsc.has(lap) && !info.held && t - carStart <= P.inRange ? P.chance(advantage) : 0;
      if (chance > 0) {
        const made = luck(seed, lap, +n) < chance;
        info.attempts.push({ car: codes[n], chance, made });
        if (made) {
          // The move costs time, but it crosses the line ahead.
          end = Math.min(end + P.passCost, carEnd - TRAFFIC.justAhead);
          info.passed.push(codes[n]);
          passedAt[codes[n]] = carEnd;
          continue;
        }
      }
      // Stuck behind it. Cars further up the road still count: following a car past another isn't a free pass.
      info.held = codes[n];
      info.chance = chance;
      info.lost += carEnd + P.followGap - end;
      end = carEnd + P.followGap;
    }
    // Caught behind a car further up the road, the ghost can cross the line behind a car it passed.
    info.passed = info.passed.filter((c) => end < passedAt[c]);
    const dur = end - t;
    laps.push(dur);
    traffic.push(info);
    bounds.push([t, t + dur]);
    t += dur;

    // Which of Hamilton's real laps to borrow the in-lap motion from (where he braked, crawled, pitted).
    let from = lap;
    if (pitLaps.includes(lap)) from = vsc.has(lap) ? lap : (p0 ?? lap);
    else if (pitLaps.includes(lap - 1)) from = vsc.has(lap) ? lap : (p0 ? p0 + 1 : lap);
    else if (realPitLap) from = [lap - 2, lap + 2, lap - 3].find((l) => l >= 2 && l <= total && !vsc.has(l) && !realPits.includes(l) && !realPits.includes(l - 1)) ?? lap;
    profile.push(from);
  }
  // Every ghost stop drives Hamilton's real run down the pit lane (entry, stop, exit), lined up on
  // the timing line, which the pit lane crosses.
  let pitRef = null, pitWindows = [];
  const realWin = race.pit_windows?.[String(HAM)]?.[0];
  if (realWin && p0) {
    const line = realB[p0 - 1][1];
    pitRef = {
      lap: p0,
      line,
      fin: realProgress(race, HAM, realWin[0]) - (p0 - 1), // how far round the in-lap the pit lane starts
      fout: realProgress(race, HAM, realWin[1]) - p0,      // how far round the out-lap it ends
      box: boxAfterLine ?? 0,                              // seconds from the line to stopping in the box
      still: stillAfterLine ?? boxAfterLine ?? 0,          // the same, on the speed trace
    };
    pitWindows = pitLaps.map((p, k) => [bounds[p - 1][1] - (line - realWin[0]), bounds[p - 1][1] + (realWin[1] - line) + (pitWaits[k]?.wait || 0)]);
  }
  const start = realB[0][0];
  return { laps, tyres, bounds, pitLaps, profile, traffic, pitRef, pitWindows, pitWaits, finish: t, total: t - start };
}

// When the real Hamilton reached `laps` of progress, searching within one of his laps.
function realTimeAt(race, laps, [lo, hi]) {
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (realProgress(race, HAM, mid) < laps) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Whether race time t falls in any of these [start, end] windows.
// Who the ghost is waiting behind at the box at race time t (a double stack), or null.
export function stackedBehind(ghost, t) {
  for (const [k, w] of (ghost.pitWaits || []).entries()) {
    const from = ghost.bounds[ghost.pitLaps[k] - 1][1] + ghost.pitRef.box - 1;
    if (w.wait > 0 && t >= from && t < from + w.wait) return w.behind;
  }
  return null;
}

export function inWindow(windows, t) {
  return !!windows?.some(([a, z]) => t >= a && t < z);
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

// Real on-track progress (laps, fractional) from the car-position feed, stored once a second.
// Between seconds it follows a monotone cubic, so speed changes smoothly instead of stepping on each
// second, and a car never runs backwards or overshoots a standstill.
export function realProgress(race, num, t) {
  const s = race.progress?.[String(num)];
  if (!s) return progressAt(race.timelines[String(num)] || [], t);
  if (t <= 0) return s[0] / 10000;
  const i = Math.floor(t);
  if (i >= s.length - 1) return s[s.length - 1] / 10000;
  const k = t - i;
  const p1 = s[i], p2 = s[i + 1];
  const d0 = p1 - (s[i - 1] ?? p1), d1 = p2 - p1, d2 = (s[i + 2] ?? p2) - p2;
  // Speed at each whole second: the harmonic mean of the neighbouring steps (zero beside a standstill).
  const m1 = d0 > 0 && d1 > 0 ? (2 * d0 * d1) / (d0 + d1) : 0;
  const m2 = d1 > 0 && d2 > 0 ? (2 * d1 * d2) / (d1 + d2) : 0;
  const k2 = k * k, k3 = k2 * k;
  return ((2 * k3 - 3 * k2 + 1) * p1 + (k3 - 2 * k2 + k) * m1 + (-2 * k3 + 3 * k2) * p2 + (k3 - k2) * m2) / 10000;
}

// The ghost's on-track progress: its own lap timing, with the in-lap motion of the real lap it borrows.
export function ghostProgress(race, ghost, t) {
  const b = ghost.bounds;
  if (t < b[0][0]) return realProgress(race, HAM, t);
  if (t >= b[b.length - 1][1]) return b.length;
  const ref = ghost.pitRef;
  if (ref) {
    // In the pit lane: Hamilton's real run down it, lined up on the timing line.
    const k = ghost.pitWindows.findIndex(([a, z]) => t >= a && t < z);
    if (k >= 0) {
      const p = ghost.pitLaps[k];
      let u = t - b[p - 1][1];
      // Stacked behind Leclerc: held a second short of the box until he has gone, then in.
      const w = ghost.pitWaits?.[k]?.wait || 0;
      if (w > 0 && u > ref.box - 1) u = Math.max(ref.box - 1, u - w);
      return p + realProgress(race, HAM, ref.line + u) - ref.lap;
    }
  }
  let i = 0;
  while (i < b.length - 1 && t >= b[i][1]) i++;
  const from = ghost.profile[i];
  const rb = race.timelines[String(HAM)][from - 1];
  if (!rb || !race.progress?.[String(HAM)]) return i + (t - b[i][0]) / (b[i][1] - b[i][0]);
  // Where the real car was at the same point through the borrowed lap, stretched to this lap's time
  // and shifted to this lap. An in-lap borrows only up to the pit lane; an out-lap from where it ends.
  let [t0, t1] = b[i], [s0, s1] = rb;
  if (ref) {
    const kin = ghost.pitLaps.indexOf(i + 1), kout = ghost.pitLaps.indexOf(i);
    if (kin >= 0) { t1 = ghost.pitWindows[kin][0]; s1 = realTimeAt(race, from - 1 + ref.fin, rb); }
    if (kout >= 0) { t0 = ghost.pitWindows[kout][1]; s0 = realTimeAt(race, from - 1 + ref.fout, rb); }
  }
  const tau = (t - t0) / (t1 - t0);
  const within = realProgress(race, HAM, s0 + tau * (s1 - s0)) - (from - 1);
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

// Re-run the same strategy with different passing luck. `pos` counts finishes per position.
export function raceOdds(race, stints, runs = 200) {
  const pos = {};
  let dsq = 0;
  const v = validateStrategy(race, stints);
  for (let seed = 1; seed <= runs; seed++) {
    const me = classify(race, simulateGhost(race, stints, { seed })).find((r) => r.ghost);
    if (v.dsq) dsq++;
    else pos[me.pos] = (pos[me.pos] || 0) + 1;
  }
  return { runs, pos, dsq };
}
