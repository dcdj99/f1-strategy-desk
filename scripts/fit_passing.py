"""Fit how often a car gets past the one in front at Marina Bay, from every Singapore GP on OpenF1.

For every lap where a car starts within 1.0s of the car ahead (same lap, green flag, nobody pitting),
record whether it was ahead by the end of the lap, and how much quicker it was than that car.
Fit P(pass) = 1 / (1 + exp(-(a + b * advantage))) by maximum likelihood.

Run on its own to update public/data/race.json in place:
    python.exe -B scripts/fit_passing.py public/data/race.json
build_data.py calls fit() too.
"""
import json
import math
import os
import statistics
import sys
import time
import urllib.request
from datetime import datetime

BASE = "https://api.openf1.org/v1/"
SESSIONS = {2023: 9165, 2024: 9606, 2025: 9896, 2026: 11388}
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache", "passing")
IN_RANGE = 1.0      # starts the lap this close behind: a passing chance (DRS range)
CLEAR_AIR = 2.0     # this far behind the car ahead: a clean-air lap
WINDOW = 5          # clean-air pace is the median of clean laps within this many laps


def get(path):
    os.makedirs(CACHE, exist_ok=True)
    name = os.path.join(CACHE, "".join(c if c.isalnum() else "_" for c in path) + ".json")
    if os.path.exists(name):
        with open(name, encoding="utf-8") as f:
            return json.load(f)
    last = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(BASE + path, timeout=90) as r:
                data = json.loads(r.read().decode("utf-8"))
            time.sleep(0.4)  # free tier: 3 requests a second
            with open(name, "w", encoding="utf-8") as f:
                json.dump(data, f)
            return data
        except Exception as e:  # network blips: retry
            last = e
            time.sleep(2)
    raise RuntimeError("OpenF1 request failed: %s (%s)" % (path, last))


def ts(s):
    return datetime.fromisoformat(s).timestamp()


def neutralised_laps(rc):
    """Safety car and VSC laps, plus the restart lap after each (cold tyres, bunched field)."""
    out, start = set(), None
    for m in sorted(rc, key=lambda m: m["date"]):
        msg = (m.get("message") or "").upper()
        lap = m.get("lap_number")
        if "SAFETY CAR DEPLOYED" in msg or "VSC DEPLOYED" in msg or "RED FLAG" in msg:
            start = start or lap
        elif start and ("ENDING" in msg or "IN THIS LAP" in msg or "GREEN FLAG" in msg and "RED" not in msg):
            out.update(range(start, (lap or start) + 2))
            start = None
    return out


def situations(year, session):
    laps = get("laps?session_key=%d" % session)
    pits = get("pit?session_key=%d" % session)
    rc = get("race_control?session_key=%d" % session)
    neutral = neutralised_laps(rc)

    t0 = min(ts(l["date_start"]) for l in laps if l["lap_number"] == 1 and l.get("date_start"))
    bounds, durs = {}, {}
    for l in laps:
        if l.get("date_start") and l.get("lap_duration"):
            s = ts(l["date_start"]) - t0
            bounds[(l["driver_number"], l["lap_number"])] = (s, s + l["lap_duration"])
            durs[(l["driver_number"], l["lap_number"])] = l["lap_duration"]
    pitting = set()
    for p in pits:
        pitting.update({(p["driver_number"], p["lap_number"]), (p["driver_number"], p["lap_number"] + 1)})
    drivers = sorted({d for d, _ in bounds})
    last_lap = max(k for _, k in bounds)

    def car_ahead(d, k):
        s = bounds[(d, k)][0]
        best = None
        for o in drivers:
            b = bounds.get((o, k))
            if o != d and b and b[0] < s and (best is None or b[0] > best[1][0]):
                best = (o, b)
        return best

    usable = lambda d, k: k >= 2 and k not in neutral and (d, k) not in pitting and (d, k) in bounds

    # Clean-air laps per driver, for an estimate of what each car could do on its own.
    clean = {}
    for d in drivers:
        for k in range(2, last_lap + 1):
            if not usable(d, k):
                continue
            a = car_ahead(d, k)
            if a is None or bounds[(d, k)][0] - a[1][0] >= CLEAR_AIR:
                clean.setdefault(d, {})[k] = durs[(d, k)]

    def potential(d, k):
        for w in (WINDOW, 2 * WINDOW, 3 * WINDOW):
            near = [t for j, t in clean.get(d, {}).items() if abs(j - k) <= w and j != k]
            if len(near) >= 3:
                return statistics.median(near)
        return None

    rows = []
    for d in drivers:
        for k in range(2, last_lap + 1):
            if not usable(d, k):
                continue
            a = car_ahead(d, k)
            if a is None:
                continue
            o, (os_, oe) = a
            s, e = bounds[(d, k)]
            gap = s - os_
            if gap > IN_RANGE or not usable(o, k):
                continue
            pot, opp = potential(d, k), potential(o, k)
            if pot is None or opp is None:
                continue
            rows.append({
                "year": year, "lap": k, "car": d, "ahead": o, "gap": gap,
                "advantage": opp - pot,                   # + means the car behind is quicker on pace
                "advantage_on_lap": (oe - os_) - pot,     # against the defender's actual (fought) lap
                "passed": e < oe,
                "lap_vs_pace": durs[(d, k)] - pot,         # what the attempt cost against its own pace
                "end_gap": e - oe,                         # + behind the car at the line, - ahead
            })
    return rows


def logistic(rows):
    """Two-parameter logistic regression by Newton's method."""
    a, b = -2.0, 0.5
    for _ in range(50):
        ga = gb = haa = hab = hbb = 0.0
        for r in rows:
            x = r["advantage"]
            p = 1 / (1 + math.exp(-(a + b * x)))
            y = 1.0 if r["passed"] else 0.0
            ga += y - p
            gb += (y - p) * x
            w = p * (1 - p)
            haa += w
            hab += w * x
            hbb += w * x * x
        det = haa * hbb - hab * hab
        da = (hbb * ga - hab * gb) / det
        db = (haa * gb - hab * ga) / det
        a, b = a + da, b + db
        if abs(da) + abs(db) < 1e-9:
            break
    return a, b


def fit():
    rows = []
    per_year = {}
    for year, session in SESSIONS.items():
        r = situations(year, session)
        per_year[year] = {"chances": len(r), "passes": sum(x["passed"] for x in r)}
        rows += r
    a, b = logistic(rows)
    passes = [r for r in rows if r["passed"]]
    held = [r for r in rows if not r["passed"] and r["end_gap"] < IN_RANGE]
    chance = lambda x: 1 / (1 + math.exp(-(a + b * x)))
    observed = []
    for lo, hi in ((-9, 0), (0, 1), (1, 2), (2, 9)):
        sel = [r for r in rows if lo <= r["advantage"] < hi]
        observed.append({"advantage": [lo, hi], "chances": len(sel), "passes": sum(r["passed"] for r in sel)})
    return {
        "a": a, "b": b,
        "chance_at": {str(x): round(chance(x), 3) for x in (0, 0.5, 1, 1.5, 2, 3)},
        "observed": observed,
        "pass_cost": statistics.median(r["lap_vs_pace"] for r in passes),       # attacker's lap vs its own pace
        "follow_gap": statistics.median(r["end_gap"] for r in held),            # how close a car stays behind
        "in_range": IN_RANGE,
        "chances": len(rows), "passes": len(passes), "by_year": per_year,
        "note": "every Singapore GP on OpenF1 (%s): laps starting within %.1fs of the car ahead, green flag"
                % (", ".join(str(y) for y in SESSIONS), IN_RANGE),
    }


if __name__ == "__main__":
    out = fit()
    print(json.dumps(out, indent=2))
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as f:
            race = json.load(f)
        race["model"]["passing"] = out
        with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
            json.dump(race, f, separators=(",", ":"))
        print("wrote", sys.argv[1])
