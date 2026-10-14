// What happened in the race and when, in one place, so the map, the ticker, the marks under the
// strategy bar and the timing tower show each event at the same moment. Shared by the browser and the tests.
import { HAM } from "./sim.js";

// VSC periods from race control, [deployed, ending] in race seconds.
export function vscPeriods(race) {
  const out = [];
  for (const e of race.events || []) {
    if (e.kind === "vsc") out.push([e.t, Infinity]);
    else if (e.kind === "vsc_end" && out.length && out.at(-1)[1] === Infinity) out.at(-1)[1] = e.t;
  }
  return out;
}

// When a car is out of the race: when the position feed shows it stopping (it drives on after its
// last timed lap), or after that lap if the feed shows no stop. Null for a car that took the flag.
export function outAt(race, num) {
  const total = race.race.total_laps;
  const b = race.timelines[String(num)] || [];
  const leaderFinish = Math.min(...Object.values(race.timelines).filter((x) => x.length >= total).map((x) => x[total - 1][1]));
  if (!b.length || b.length >= total || b.at(-1)[1] >= leaderFinish) return null;
  return race.retired?.[String(num)]?.t ?? b.at(-1)[1];
}

// Race control's messages, plus the moment each incident happened ("off"): the stewards post an
// incident a minute or more later, with the time it happened. In race-time order.
export function raceMoments(race) {
  const code = Object.fromEntries(race.drivers.map((d) => [d.num, d.code]));
  const out = [...(race.events || [])];
  for (const e of race.events || []) {
    if (e.kind !== "incident" || e.at == null || out.some((m) => m.kind === "off" && m.driver === e.driver && m.t === e.at)) continue;
    out.push({ t: e.at, kind: "off", driver: e.driver, what: e.what, text: `${code[e.driver]} ${e.what}` });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Marks under the strategy bar, each where the playhead is when it happens. `lapsAt(t)` is laps done
// at race time t along the bar: the ghost's once you race, Hamilton's while you plan. A car's own
// lap count would put a lapped car's retirement laps early.
export function timelineMarks(race, lapsAt) {
  const marks = vscPeriods(race).map(([a, z]) => ({ kind: "vsc", t: a, end: z, at: lapsAt(a), to: lapsAt(Math.min(z, 1e9)) }));
  for (const m of raceMoments(race)) {
    if (m.kind === "out") marks.push({ kind: "out", t: m.t, at: lapsAt(m.t), driver: m.driver, text: m.text });
    // Hamilton going off, once.
    if (m.kind === "off" && m.driver === HAM && !marks.some((x) => x.kind === "off")) marks.push({ kind: "off", t: m.t, at: lapsAt(m.t), driver: m.driver, what: m.what, text: m.text });
  }
  return marks;
}
