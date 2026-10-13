// The race engineer: a summary of the race, and the radio and debrief built from pre-written lines
// (data/engineer.json). No network needed. Shared by the browser and the tests.
import { HAM, realStrategy, classify, validateStrategy, tyreAt, progressAt, pitLoss } from "./sim.js";

export function stintSpans(stints, total = 62) {
  return stints.map((s, i) => {
    const end = i + 1 < stints.length ? stints[i + 1].from - 1 : total;
    return { ...s, i, end, laps: end - s.from + 1 };
  });
}

// Running order at race time t, by laps completed. `extra` adds the ghost.
export function orderAt(race, t, excludeNum, extra) {
  const ps = [];
  for (const d of race.drivers) {
    if (d.num === excludeNum) continue;
    const b = race.timelines[String(d.num)] || [];
    if (b.length) ps.push({ code: d.code, p: progressAt(b, t) });
  }
  if (extra) ps.push(extra);
  ps.sort((a, b) => b.p - a.p);
  return ps;
}

const isCopy = (race, ghost) => {
  const real = race.laps[String(HAM)];
  return ghost.laps.every((d, i) => Math.abs(d - real[i]) < 1e-6);
};

// Spells stuck behind the same car, and moves made on track.
export function trafficSummary(ghost) {
  const stuck = [];
  const passes = [];
  ghost.traffic.forEach((info, i) => {
    const lap = i + 1;
    if (info.held) {
      const run = stuck.at(-1);
      if (run && run.behind === info.held && run.to >= lap - 2) { run.to = lap; run.time_lost_s += info.lost; run.chances.push(info.chance); }
      else stuck.push({ behind: info.held, from: lap, to: lap, time_lost_s: info.lost, chances: [info.chance] });
    }
    for (const code of info.passed) passes.push({ lap, car: code, while_copying_ferrari: info.mode === "lewis" });
  });
  return {
    stuck_behind: stuck.map((s) => ({
      car: s.behind, laps: s.from === s.to ? `${s.from}` : `${s.from}-${s.to}`, first_lap: s.from, time_lost_s: +s.time_lost_s.toFixed(1),
      pass_chance_per_lap: +(Math.max(...s.chances)).toFixed(2),
    })),
    passes_on_track: passes,
  };
}

function describe(stints, total) {
  return stintSpans(stints, total).map((s) => ({
    compound: s.compound.toLowerCase(), laps: `${s.from}-${s.end}`, tyre_age_at_start: s.ageAtStart || 0, pitted_end_of_lap: s.i ? s.from - 1 : null,
  }));
}

export function buildSummary(race, ghost, stints, odds) {
  const TOTAL = race.race.total_laps;
  const realStints = realStrategy(race);
  const realB = race.timelines[String(HAM)];
  const realLaps = race.laps[String(HAM)];
  const realPos = race.drivers.find((d) => d.num === HAM).final_pos;
  const laps = [];
  let prevAhead = null;
  const moves = [];
  for (let k = 1; k <= TOTAL; k++) {
    const tg = ghost.bounds[k - 1][1];
    const order = orderAt(race, tg, HAM, { code: "YOU", p: k });
    const gPos = order.findIndex((o) => o.code === "YOU") + 1;
    const ahead = new Set(order.slice(0, gPos - 1).map((o) => o.code));
    if (prevAhead) {
      const passed = [...prevAhead].filter((c) => !ahead.has(c));
      const lost = [...ahead].filter((c) => !prevAhead.has(c));
      if (passed.length || lost.length) moves.push({ lap: k, passed, passed_by: lost });
    }
    prevAhead = ahead;
    const ty = ghost.tyres[k - 1];
    const rty = tyreAt(realStints, k);
    const rPos = realB[k - 1] ? orderAt(race, realB[k - 1][1], null).findIndex((o) => o.code === "HAM") + 1 : null;
    laps.push({
      lap: k,
      you: +ghost.laps[k - 1].toFixed(2), you_pos: gPos, you_tyre: `${ty.compound[0]}${ty.age}`,
      ferrari: realLaps[k - 1], ferrari_pos: rPos, ferrari_tyre: `${rty.compound[0]}${rty.age}`,
      gap_to_ferrari: realB[k - 1] ? +(tg - realB[k - 1][1]).toFixed(2) : null,
    });
  }
  const cls = classify(race, ghost);
  const me = cls.find((r) => r.ghost);
  const v = validateStrategy(race, stints);
  const near = cls.filter((r) => Math.abs(r.pos - me.pos) <= 1 && !r.ghost).map((r) => ({ code: r.code, pos: r.pos, gap: +(r.finish - me.finish).toFixed(2) }));
  return {
    track: "Marina Bay, Singapore, 62 laps, night race",
    vsc_laps: race.race.neutralised_laps,
    race_events: (race.events || []).filter((e) => e.kind !== "pit").map((e) => ({ lap: e.lap, text: e.text })),
    tyre_model: { soft_cliff_after_laps: race.model.cliff_at.SOFT, normal_pit_loss_s: +race.model.pit_loss_green.toFixed(1), vsc_pit_loss_s: +race.model.pit_loss_vsc.toFixed(1) },
    your_strategy: describe(stints, TOTAL),
    ferrari_strategy: describe(realStints, TOTAL),
    odds_over_reruns: odds && !odds.dsq ? { runs: odds.runs, finishes_by_position: odds.pos } : null,
    result: { your_position: v.dsq ? "DSQ (only one compound used)" : me.pos, ferrari_position: realPos, gap_to_ferrari_at_flag_s: +(ghost.finish - realB[TOTAL - 1][1]).toFixed(2), neighbours: near },
    position_changes: moves,
    traffic: trafficSummary(ghost),
    laps,
  };
}

// ---------------------------------------------------------------- picking lines

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

// The same plan always hears the same lines; a different plan usually hears different ones.
const picker = (stints) => {
  const plan = stints.map((s) => `${s.compound[0]}${s.from}`).join("-");
  return (lines, key, salt = "") => lines[fnv(`${plan}|${key}|${salt}`) % lines.length];
};

export function fill(text, slots) {
  return text.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in slots)) throw new Error(`no value for {${k}} in "${text}"`);
    return String(slots[k]);
  });
}

const surname = (name) => {
  const last = name.trim().split(/\s+/).at(-1);
  return last[0] + last.slice(1).toLowerCase();
};

const surnameOf = (race, code) => {
  const d = race.drivers.find((x) => x.code === code);
  return d ? surname(d.name) : code;
};

// Laps in the pit lane for this car (in-lap and out-lap).
const inPits = (race, num, lap) => (race.pits[String(num)] || []).some((p) => p === lap || p === lap - 1);

// Spells where the ghost crossed the line within a second of the same car, lap after lap.
export function followingSpells(race, ghost) {
  const TOTAL = race.race.total_laps;
  const vsc = new Set(race.race.neutralised_laps);
  const code = Object.fromEntries(race.drivers.map((d) => [String(d.num), d.code]));
  const following = [];
  for (let lap = 2; lap <= TOTAL; lap++) {
    const [gs, ge] = ghost.bounds[lap - 1];
    let best = null;
    if (!vsc.has(lap) && !ghost.pitLaps.some((p) => p === lap || p === lap - 1)) {
      for (const [n, b] of Object.entries(race.timelines)) {
        const c = b[lap - 1];
        if (n === String(HAM) || !c || inPits(race, n, lap)) continue;
        if (c[0] < gs && c[1] < ge && ge - c[1] <= 1.0 && (!best || c[1] > best.end)) best = { num: n, end: c[1] };
      }
    }
    following.push(best ? best.num : null);
  }
  const spells = [];
  following.forEach((n, i) => {
    const lap = i + 2;
    if (!n) return;
    const run = spells.at(-1);
    if (run && run.num === n && run.to >= lap - 2) run.to = lap;
    else spells.push({ num: n, car: code[n], from: lap, to: lap });
  });
  for (const s of spells) {
    const laps = ghost.traffic.slice(s.from - 1, s.to);
    s.length = s.to - s.from + 1;
    s.lost = laps.reduce((sum, t) => sum + t.lost, 0);
    s.chance = Math.max(0, ...laps.map((t) => t.chance));
  }
  return spells.filter((s) => s.length >= 3);
}

// The nearest car within `window` seconds ahead as the ghost finishes `lap`.
function carJustAhead(race, ghost, lap, window) {
  const ge = ghost.bounds[lap - 1][1];
  let best = null;
  for (const [n, b] of Object.entries(race.timelines)) {
    const c = b[lap - 1];
    if (n === String(HAM) || !c || inPits(race, n, lap)) continue;
    if (c[1] < ge && ge - c[1] <= window && (!best || c[1] > best.end)) best = { num: n, end: c[1] };
  }
  return best?.num ?? null;
}

const MAX_RADIO = 16;

export function builtInRadio(race, ghost, summary, bank, stints) {
  const TOTAL = race.race.total_laps;
  const green = race.model.pit_loss_green;
  const realStints = realStrategy(race);
  const realPos = summary.result.ferrari_position;
  const names = Object.fromEntries(race.drivers.map((d) => [String(d.num), surname(d.name)]));
  const byCode = Object.fromEntries(race.drivers.map((d) => [d.code, String(d.num)]));
  const nameOfCode = (c) => names[byCode[c]] || c;
  const pick = picker(stints);
  const copy = isCopy(race, ghost);
  const msgs = [];
  // Priority 0 always plays; higher numbers are dropped first when the race is busy.
  const say = (lap, key, slots = {}, priority = 2) => {
    const group = bank.radio[key];
    if (!group) throw new Error(`no radio lines for ${key}`);
    msgs.push({ lap, from: group.from, text: fill(pick(group.lines, key, lap), slots), key, priority, order: msgs.length });
  };

  // Lights out.
  say(1, copy ? "start_copy" : stints[0].compound === "SOFT" && realStints[0].compound !== "SOFT" ? "start_softs" : "start_own", {}, 0);

  // Each stop: the call, then where it put us.
  ghost.pitLaps.forEach((p, k) => {
    const loss = pitLoss(race, p);
    const fitted = stints[k + 1].compound === "SOFT" ? "softs" : "mediums";
    const slots = { tyres: fitted, Tyres: fitted[0].toUpperCase() + fitted.slice(1), laps: TOTAL - p, loss: loss.toFixed(0), green: green.toFixed(0) };
    if (loss < green - 0.5) say(p, "box_vsc", slots, 0);
    else say(Math.max(1, p - 1), p <= 14 ? "box_early" : p >= 45 ? "box_late" : "box_next_lap", slots, 0);
    if (p + 1 > TOTAL) return;
    const ahead = carJustAhead(race, ghost, p + 1, 2.0);
    if (ahead) say(p + 1, "out_lap_traffic", { car: names[ahead] }, 2);
    else say(p + 1, "out_lap_clear", {}, 2);
    if (k === 0) say(p + 1, "out_lap_reply", {}, 4);
  });

  // VSCs we stay out for.
  const v = [...race.race.neutralised_laps].sort((a, b) => a - b);
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    if (!ghost.pitLaps.some((p) => p >= v[i] - 1 && p <= v[j])) say(v[i], "vsc_stay_out", {}, 1);
    i = j;
  }

  // Stuck behind someone: the two longest spells.
  const spells = followingSpells(race, ghost).sort((a, b) => b.length - a.length).slice(0, 2);
  for (const s of spells) {
    const car = names[s.num];
    say(s.from, "stuck_driver", { car }, 1);
    if (s.chance > 0) say(s.from + 1, s.chance < 0.15 ? "stuck_odds_low" : "stuck_odds_high", { pct: Math.round(s.chance * 100) }, 2);
    if (s.length >= 6) {
      const mid = s.from + Math.floor(s.length / 2);
      const stopsLater = (race.pits[s.num] || []).some((p) => p > mid);
      say(mid, stopsLater ? "stuck_long_pits_later" : "stuck_long", { car, laps: mid - s.from + 1 }, 3);
    }
  }

  // Moves on track, both ways.
  summary.traffic.passes_on_track.slice(0, 2).forEach((m, i) => say(m.lap, "pass_made", { car: nameOfCode(m.car) }, i ? 3 : 1));
  const pitWindow = (lap) => ghost.pitLaps.some((p) => p === lap || p === lap - 1);
  const lost = summary.position_changes.find((m) => !pitWindow(m.lap) && m.passed_by.some((c) => !inPits(race, byCode[c], m.lap)));
  if (lost) say(lost.lap, "passed_by", { car: nameOfCode(lost.passed_by.find((c) => !inPits(race, byCode[c], lost.lap))) }, 2);

  // Tyres past their best.
  const cliffLap = ghost.tyres.findIndex((t) => t.compound === "SOFT" && t.age > race.model.cliff_at.SOFT + 6);
  if (cliffLap >= 0) say(cliffLap + 1, "cliff_soft", {}, 1);
  const longMed = ghost.tyres.findIndex((t) => t.compound === "MEDIUM" && t.age > race.model.cliff_at.MEDIUM);
  if (longMed >= 0) say(longMed + 1, "long_mediums", {}, 3);

  // Where we stand against Ferrari's call with a third of the race left.
  const check = Math.round(TOTAL * 0.72);
  const g = summary.laps[check - 1].gap_to_ferrari;
  say(check, copy || Math.abs(g) < 0.05 ? "gap_level" : g < 0 ? "gap_ahead" : "gap_behind", { gap: Math.abs(g).toFixed(1) }, 3);

  // Hamilton's Turn 1 moment: ours too if we're where he was.
  const t1 = (race.events || []).filter((e) => e.kind === "incident" && e.driver === HAM);
  if (t1.length) {
    const first = t1[0].lap;
    if (ghost.traffic[first - 1]?.mode === "lewis") {
      say(first, "t1_you", {}, 3);
      const cleared = t1.find((e) => /no further action/i.test(e.text));
      if (cleared) say(cleared.lap, "t1_cleared", {}, 4);
    } else {
      say(first, "ferrari_off", {}, 4);
    }
  }

  // The retirement nearest to us on the road.
  let nearest = null;
  for (const e of (race.events || []).filter((x) => x.kind === "out" && x.lap < TOTAL)) {
    const order = orderAt(race, ghost.bounds[e.lap - 1][0], HAM, { code: "YOU", p: e.lap - 1 });
    const me = order.findIndex((o) => o.code === "YOU");
    const them = order.findIndex((o) => o.code === race.drivers.find((d) => d.num === e.driver)?.code);
    if (them >= 0 && (!nearest || Math.abs(me - them) < nearest.dist)) nearest = { e, dist: Math.abs(me - them) };
  }
  if (nearest) say(nearest.e.lap, "car_out", { car: names[String(nearest.e.driver)] }, 4);

  // The finish.
  say(TOTAL, "last_lap", {}, 2);
  const pos = summary.result.your_position;
  const flag = typeof pos !== "number" ? "flag_dsq" : copy ? "flag_copy" : pos <= 3 ? "flag_podium"
    : pos < realPos ? "flag_better" : pos === realPos ? "flag_same" : "flag_worse";
  say(TOTAL + 1, flag, { pos, realPos }, 0);

  const kept = [...msgs].sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, MAX_RADIO);
  return kept.sort((a, b) => a.lap - b.lap || a.order - b.order).map(({ lap, from, text, key }) => ({ lap, from, text, key }));
}

export function builtInDebrief(race, ghost, summary, bank, stints, odds) {
  const D = bank.debrief;
  const pick = picker(stints);
  const green = race.model.pit_loss_green;
  const pos = summary.result.your_position;
  const realPos = summary.result.ferrari_position;
  const gap = summary.result.gap_to_ferrari_at_flag_s;
  const dsq = typeof pos !== "number";
  const copy = !dsq && isCopy(race, ghost);
  const slots = { pos, realPos, gap: Math.abs(gap).toFixed(1), green: green.toFixed(0) };
  const used = [];
  const line = (group, key) => { used.push(`${group}.${key}`); return fill(pick(D[group][key], key), slots); };

  const outcome = dsq ? "dsq" : copy ? "copy" : pos <= 3 && pos < realPos ? "podium" : pos < realPos ? "better"
    : pos === realPos ? (gap < 0 ? "same_faster" : "same_slower") : "worse";
  const sentences = [line("result", dsq ? "dsq" : copy ? "copy" : gap < 0 ? "ahead" : "behind")];

  if (!dsq && !copy) {
    const realPits = realStrategy(race).slice(1).map((s) => s.from - 1);
    const vscStop = ghost.pitLaps.find((p) => pitLoss(race, p) < green - 0.5);
    const last = stints.at(-1);
    const worst = [...summary.traffic.stuck_behind].sort((a, b) => b.time_lost_s - a.time_lost_s)[0];
    const cliffLaps = ghost.tyres.filter((t) => t.age > race.model.cliff_at[t.compound] + 3).length;
    Object.assign(slots, {
      stops: ghost.pitLaps.length, ferrariStops: realPits.length,
      extra: ((ghost.pitLaps.length - realPits.length) * green).toFixed(0), laps: cliffLaps,
    });
    if (vscStop) Object.assign(slots, { lap: vscStop, saved: (green - pitLoss(race, vscStop)).toFixed(0) });
    else if (stints.length > 1) slots.lap = last.from;
    if (worst) Object.assign(slots, { loss: worst.time_lost_s.toFixed(0), car: surnameOf(race, worst.car), laps: worst.laps });
    const traffic = worst && worst.time_lost_s > 5;

    const firstStop = ghost.pitLaps[0];
    if (gap < 0) {
      let reason = "generic_ahead";
      if (vscStop) reason = "vsc_stop";
      else if (last.compound === "SOFT" && last.from >= 36 && stints.length > 1) reason = "fresh_tyres";
      else if (stints[0].compound === "SOFT" && realStrategy(race)[0].compound !== "SOFT") reason = "soft_start";
      else if (firstStop >= realPits[0] + 6) { reason = "later_stop"; slots.lap = firstStop; }
      sentences.push(line("reason", reason));
      if (traffic) sentences.push(line("reason", "traffic_note"));
    } else {
      // Name whichever cost the most time.
      const m = race.model;
      const cliffCost = ghost.tyres.reduce((sum, t) => sum + m.cliff[t.compound] * Math.max(0, t.age - m.cliff_at[t.compound]) ** 2, 0);
      const extraPit = !vscStop ? Math.max(0, ghost.pitLaps.length - realPits.length) * green : 0;
      const costs = [["traffic", worst ? worst.time_lost_s : 0], ["extra_stop", extraPit], ["cliff", cliffCost]].sort((a, b) => b[1] - a[1]);
      let reason = costs[0][1] > 3 ? costs[0][0] : "generic_behind";
      if (reason === "traffic") Object.assign(slots, { loss: worst.time_lost_s.toFixed(0), car: surnameOf(race, worst.car), laps: worst.laps });
      if (reason === "cliff") Object.assign(slots, { laps: cliffLaps, loss: cliffCost.toFixed(0) });
      sentences.push(line("reason", reason));
    }

    // Was this one lucky? Compare with where the plan usually finishes.
    if (odds && !odds.dsq && sentences.length < 3) {
      const [usual, n] = Object.entries(odds.pos).sort((a, b) => b[1] - a[1])[0];
      Object.assign(slots, { usual, usualPct: Math.round((n / odds.runs) * 100) });
      if (pos < +usual) sentences.push(line("luck", "lucky"));
      if (pos > +usual) sentences.push(line("luck", "unlucky"));
    }
  }

  const roast = dsq ? "dsq" : copy ? "copy" : pos < realPos ? "beat" : pos === realPos ? "same" : "worse";
  const headline = line("headline", outcome);
  return { headline, verdict: sentences.join(" "), roast: line("roast", roast), outcome, used };
}
