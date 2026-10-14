"""Fetch the 2026 Singapore GP race from OpenF1, fit a tyre model, write public/data/race.json.

Run: python.exe -B scripts/build_data.py <output_json_path>
"""
import bisect
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timezone

import fit_passing

BASE = "https://api.openf1.org/v1/"
SESSION = 11388
TOTAL_LAPS = 62
REF_DRIVER = 3  # Verstappen: led every lap, clean reference lap for the track outline
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
OFF_LINE = 60  # position-feed units (about 6 m): further than this from the racing line is off it


def get(path):
    url = BASE + path
    last = None
    for _ in range(4):
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                data = json.loads(r.read().decode("utf-8"))
            time.sleep(0.4)  # stay under the free tier's 3 req/s
            return data
        except Exception as e:  # network blips: retry
            last = e
            time.sleep(2)
    raise RuntimeError("OpenF1 request failed: %s (%s)" % (url, last))


def ts(s):
    return datetime.fromisoformat(s).timestamp()


def solve(a, b):
    """Gaussian elimination with partial pivoting; a is n x n, b is n."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            raise ValueError("singular matrix at column %d" % c)
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


def main(out_path):
    os.makedirs(CACHE, exist_ok=True)
    drivers = get("drivers?session_key=%d" % SESSION)
    laps = get("laps?session_key=%d" % SESSION)
    stints = get("stints?session_key=%d" % SESSION)
    pits = get("pit?session_key=%d" % SESSION)
    rc = get("race_control?session_key=%d" % SESSION)
    positions = get("position?session_key=%d" % SESSION)

    # --- VSC / SC laps from race control ---------------------------------
    neutralised = set()
    start_lap = None
    for m in sorted(rc, key=lambda m: m["date"]):
        msg = (m.get("message") or "").upper()
        if "VSC DEPLOYED" in msg or "SAFETY CAR DEPLOYED" in msg:
            start_lap = m.get("lap_number")
        elif ("VSC ENDING" in msg or "SAFETY CAR IN THIS LAP" in msg) and start_lap:
            for l in range(start_lap, (m.get("lap_number") or start_lap) + 1):
                neutralised.add(l)
            start_lap = None
    neutralised = sorted(neutralised)

    # --- per-driver lap tables --------------------------------------------
    by_driver = {}
    for l in laps:
        by_driver.setdefault(l["driver_number"], {})[l["lap_number"]] = l
    race_t0 = min(ts(l["date_start"]) for l in laps if l["lap_number"] == 1 and l.get("date_start"))

    pit_laps = {}
    for p in pits:
        pit_laps.setdefault(p["driver_number"], []).append(p["lap_number"])

    stint_map = {}
    for s in stints:
        stint_map.setdefault(s["driver_number"], []).append(s)
    for v in stint_map.values():
        v.sort(key=lambda s: s["stint_number"])

    def tyre_state(dn, lap):
        for s in stint_map.get(dn, []):
            lo, hi = s["lap_start"], s["lap_end"] or TOTAL_LAPS
            if lo <= lap <= hi:
                return s["compound"], (s.get("tyre_age_at_start") or 0) + (lap - lo)
        return None, None

    # Lap boundaries on a shared race clock (seconds since lights out).
    timelines = {}
    for dn, table in by_driver.items():
        n = max(table)
        bounds = []
        for k in range(1, n + 1):
            l = table.get(k)
            nxt = table.get(k + 1)
            if not l or not l.get("date_start"):
                break
            start = ts(l["date_start"]) - race_t0
            if l.get("lap_duration"):
                end = start + l["lap_duration"]
            elif nxt and nxt.get("date_start"):
                end = ts(nxt["date_start"]) - race_t0
            else:
                break
            bounds.append([round(start, 3), round(end, 3)])
        timelines[dn] = bounds

    # --- tyre model fit -----------------------------------------------------
    # t = b_driver + fuel*lap + off[c] + k[c]*age + cliff[c]*max(0, age - a[c])^2
    # Driver baselines removed by within-driver demeaning (Frisch-Waugh).
    rows = []
    for dn, table in by_driver.items():
        pl = set(pit_laps.get(dn, []))
        bad = set()
        for p in pl:
            bad.update({p, p + 1})
        clean = []
        for k, l in table.items():
            d = l.get("lap_duration")
            if not d or k < 2 or k in bad or k in neutralised or (k - 1) in neutralised or l.get("is_pit_out_lap"):
                continue
            comp, age = tyre_state(dn, k)
            if comp not in ("SOFT", "MEDIUM"):
                continue
            clean.append((k, d, comp, age))
        if len(clean) < 5:
            continue
        med = statistics.median(c[1] for c in clean)
        clean = [c for c in clean if c[1] < med + 6.0]  # keep tyre-cliff laps; drop incidents
        for c in clean:
            rows.append((dn,) + c)

    compounds = ["SOFT", "MEDIUM"]
    HAM = 44

    def features(lap, comp, age):
        # [fuel/track evolution, soft offset vs medium, soft deg, medium deg]
        return [float(lap), 1.0 if comp == "SOFT" else 0.0,
                age if comp == "SOFT" else 0.0, age if comp == "MEDIUM" else 0.0]

    # Pooled linear fit across the field; driver baselines removed by demeaning.
    groups = {}
    for dn, lap, t, comp, age in rows:
        groups.setdefault(dn, []).append((features(lap, comp, age), t, comp, age))
    X, Y = [], []
    for g in groups.values():
        n = len(g)
        mx = [sum(r[0][j] for r in g) / n for j in range(4)]
        my = sum(r[1] for r in g) / n
        for fx, t, _, _ in g:
            X.append([fx[j] - mx[j] for j in range(4)])
            Y.append(t - my)
    ata = [[sum(x[i] * x[j] for x in X) + (1e-6 if i == j else 0) for j in range(4)] for i in range(4)]
    aty = [sum(X[r][i] * Y[r] for r in range(len(X))) for i in range(4)]
    beta = solve(ata, aty)
    sse = sum((sum(X[r][j] * beta[j] for j in range(4)) - Y[r]) ** 2 for r in range(len(X)))

    def lin(lap, comp, age):
        f = features(lap, comp, age)
        return sum(f[j] * beta[j] for j in range(4))

    base = {dn: statistics.mean(t - lin(fx[0], c, a) for fx, t, c, a in g) for dn, g in groups.items()}

    # Tyre cliff: only Hamilton ran a soft this old, so fit the hinge on his stint alone.
    ham = [(fx[0], t, c, a) for fx, t, c, a in groups[HAM]]
    cliff_at, cliff = 99, 0.0
    for _ in range(3):
        best = None
        for a0 in range(15, 46):
            pts = [(t - base[HAM] - lin(l, c, a), max(0.0, a - a0) ** 2) for l, t, c, a in ham if c == "SOFT"]
            hh = sum(h * h for _, h in pts)
            if hh == 0:
                continue
            c0 = sum(r * h for r, h in pts) / hh
            if c0 <= 0:
                continue
            e = sum((r - c0 * h) ** 2 for r, h in pts)
            if best is None or e < best[0]:
                best = (e, a0, c0)
        if best:
            _, cliff_at, cliff = best
        base[HAM] = statistics.mean(t - lin(l, c, a) - (cliff * max(0.0, a - cliff_at) ** 2 if c == "SOFT" else 0.0)
                                    for l, t, c, a in ham)

    medium_cliff_at = cliff_at + 10  # assumption: no medium ran long enough to show its cliff
    model = {
        "fuel_per_lap": beta[0],
        "soft_offset": beta[1],
        "deg": {"SOFT": beta[2], "MEDIUM": beta[3]},
        "cliff": {"SOFT": cliff, "MEDIUM": cliff},
        "cliff_at": {"SOFT": cliff_at, "MEDIUM": medium_cliff_at},
        "cliff_note": "soft cliff fitted on HAM's 44-lap soft stint; medium cliff assumed 10 laps later (not observed)",
        "driver_base": {str(k): v for k, v in base.items()},
        "fit_rows": len(rows),
        "rmse": (sse / len(rows)) ** 0.5,
    }

    def pred(dn, lap, comp, age):
        ca = model["cliff_at"][comp]
        return base[dn] + lin(lap, comp, age) + cliff * max(0.0, age - ca) ** 2

    # --- pit loss -------------------------------------------------------------
    # Green: in-lap + out-lap minus the model's two clean laps.
    # VSC: in-lap + out-lap minus non-pitting cars that were at the same point on track.
    green_losses, vsc_losses = [], []
    for dn, pls in pit_laps.items():
        table = by_driver.get(dn, {})
        if dn not in base:
            continue
        for p in pls:
            a, b = table.get(p), table.get(p + 1)
            if not a or not b or not a.get("lap_duration") or not b.get("lap_duration"):
                continue
            actual = a["lap_duration"] + b["lap_duration"]
            if p in neutralised or (p + 1) in neutralised:
                if p not in neutralised:
                    continue  # pitted the lap before the VSC: mixed, skip
                t_p = ts(a["date_start"])
                field = []
                for o, ot in by_driver.items():
                    if o == dn or any(q in pit_laps.get(o, []) for q in (p - 1, p, p + 1)):
                        continue
                    x, y = ot.get(p), ot.get(p + 1)
                    if x and y and x.get("lap_duration") and y.get("lap_duration") and x.get("date_start") \
                            and abs(ts(x["date_start"]) - t_p) < 25:
                        field.append(x["lap_duration"] + y["lap_duration"])
                if field:
                    vsc_losses.append(actual - statistics.median(field))
            else:
                c1, a1 = tyre_state(dn, p)
                c2, a2 = tyre_state(dn, p + 1)
                if c1 and c2:
                    green_losses.append(actual - pred(dn, p, c1, a1) - pred(dn, p + 1, c2, a2))
    model["pit_loss_green"] = statistics.median(green_losses)
    model["pit_loss_vsc"] = statistics.median(vsc_losses) if vsc_losses else model["pit_loss_green"] * 0.55
    model["pit_loss_samples"] = {"green": len(green_losses), "vsc": [round(v, 2) for v in vsc_losses]}
    model["passing"] = fit_passing.fit()  # passing odds from every Singapore GP on OpenF1

    # --- track outline from the reference driver's fastest clean lap ---------
    ref_table = by_driver[REF_DRIVER]
    ref_pits = set(pit_laps.get(REF_DRIVER, []))
    cands = [l for k, l in ref_table.items() if l.get("lap_duration") and k >= 3 and k not in neutralised
             and (k - 1) not in neutralised and k not in ref_pits and (k - 1) not in ref_pits]
    ref = min(cands, key=lambda l: l["lap_duration"])
    t_start = ts(ref["date_start"])
    t_end = t_start + ref["lap_duration"]
    fmt = "%Y-%m-%dT%H:%M:%S.%f"
    q0 = datetime.fromtimestamp(t_start - 1, timezone.utc).strftime(fmt)
    q1 = datetime.fromtimestamp(t_end + 1, timezone.utc).strftime(fmt)
    loc = get("location?session_key=%d&driver_number=%d&date>%s&date<%s" % (SESSION, REF_DRIVER, q0, q1))
    raw = sorted((ts(p["date"]), p["x"], p["y"]) for p in loc if p.get("x") is not None and (p["x"], p["y"]) != (0, 0))

    def raw_at(tq):
        for (ta, xa, ya), (tb, xb, yb) in zip(raw, raw[1:]):
            if ta <= tq <= tb:
                k = (tq - ta) / ((tb - ta) or 1)
                return (xa + (xb - xa) * k, ya + (yb - ya) * k)
        return raw[0][1:] if tq < raw[0][0] else raw[-1][1:]
    # The outline's shape comes from this lap, from the line round to the line. Its points are first
    # measured by distance round the lap; the lap-fraction scale comes later, from every clean lap.
    # Closed on the starting point: GPS puts the end of the lap a couple of metres from its start,
    # a gap every car would jump at the line.
    verts = [raw_at(t_start)] + [(x, y) for t_, x, y in raw if t_start < t_ < t_end] + [raw_at(t_start)]
    cum = [0.0]
    for (xa, ya), (xb, yb) in zip(verts, verts[1:]):
        cum.append(cum[-1] + math.hypot(xb - xa, yb - ya))
    # Evenly spaced points, about every 5 m, so the lap-fraction scale bends gently between them.
    n_pts = max(2, round(cum[-1] / 51.0))
    track, j = [], 0
    for k in range(n_pts + 1):
        s = cum[-1] * k / n_pts
        while j < len(cum) - 2 and cum[j + 1] < s:
            j += 1
        w = (s - cum[j]) / ((cum[j + 1] - cum[j]) or 1)
        track.append([k / n_pts, verts[j][0] + (verts[j + 1][0] - verts[j][0]) * w, verts[j][1] + (verts[j + 1][1] - verts[j][1]) * w])

    # --- real on-track progress for every car, from the car-position feed -------
    # Each position sample is snapped to the reference outline, giving laps-around on a
    # 1-second race clock. This shows pit-lane crawls, VSC slowdowns and real gaps.
    ref_pts = [(f, x, y) for f, x, y in track]
    n_ref = len(ref_pts)

    def project(x, y, hint):
        def seg(i):
            f0, x0, y0 = ref_pts[i]
            f1, x1, y1 = ref_pts[(i + 1) % n_ref]
            if i + 1 == n_ref:
                f1 += 1.0
            dx, dy = x1 - x0, y1 - y0
            ll = dx * dx + dy * dy or 1.0
            s = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / ll))
            px, py = x0 + s * dx, y0 + s * dy
            return (px - x) ** 2 + (py - y) ** 2, (f0 + s * (f1 - f0)) % 1.0, i
        if hint is not None:
            best = min((seg((hint + k) % n_ref) for k in range(-10, 45)), key=lambda r: r[0])
            if best[0] < 300 ** 2:
                return best
        return min((seg(i) for i in range(n_ref)), key=lambda r: r[0])

    race_end = max(b[-1][1] for b in timelines.values() if b) + 20
    grid_n = int(race_end) + 1
    # Every car's samples, snapped to the outline: (race time, distance round the lap as a fraction,
    # distance from the racing line, x, y).
    snapped = {}
    for dn in sorted(by_driver):
        samples = []
        chunk = 1800
        t = race_t0 - 30
        while t < race_t0 + race_end:
            q0 = datetime.fromtimestamp(t, timezone.utc).strftime(fmt)
            q1 = datetime.fromtimestamp(t + chunk, timezone.utc).strftime(fmt)
            cache = os.path.join(CACHE, "loc_%d_%d.json" % (dn, int(t - race_t0)))
            if os.path.exists(cache):
                with open(cache, encoding="utf-8") as fh:
                    rows_ = json.load(fh)
            else:
                rows_ = get("location?session_key=%d&driver_number=%d&date>%s&date<%s" % (SESSION, dn, q0, q1))
                with open(cache, "w", encoding="utf-8") as fh:
                    json.dump(rows_, fh)
            samples += [(ts(p["date"]) - race_t0, p["x"], p["y"]) for p in rows_ if p.get("x") is not None]
            t += chunk
        samples.sort()
        rows_, hint = [], None
        for st, x, y in samples:
            if x == 0 and y == 0:
                continue  # samples without a position fix
            d2, d, hint = project(x, y, hint)
            rows_.append((st, d, math.sqrt(d2), x, y))
        snapped[dn] = rows_

    # The lap-fraction scale: how far through a typical lap, by time, a car is at each point round
    # the track. Laps are drawn and smoothed on this scale, so a car at steady progress follows the
    # typical lap's braking and acceleration. One lap's clock would carry the feed's timestamp jitter
    # into the outline (a steady car would appear to speed up and slow down between outline points),
    # so it is the median over every clean lap in the race.
    NB = 250  # about 20 m each
    by_bin = [[] for _ in range(NB)]
    for dn, rows_ in snapped.items():
        b = timelines.get(dn) or []
        pits_ = set(pit_laps.get(dn, []))
        times_ = [r[0] for r in rows_]
        for k in range(2, len(b) + 1):
            if k in neutralised or k in pits_ or (k - 1) in pits_:
                continue
            a, z = b[k - 1]
            for st, d, off, _x, _y in rows_[bisect.bisect_left(times_, a):bisect.bisect_right(times_, z)]:
                tau = (st - a) / (z - a)
                if off < OFF_LINE and abs(d - tau) < 0.2:  # on the racing line; not wrapped across the line
                    by_bin[min(NB - 1, int(d * NB))].append((d, tau))
    med = [(statistics.median(p[0] for p in c), statistics.median(p[1] for p in c)) for c in by_bin if len(c) >= 20]
    # Smooth the medians with a local quadratic over +-3 neighbours (about +-60 m, wrapping round the
    # lap): each median still wobbles by a few per cent, which would show as speed steps.
    ext = [(d - 1, t - 1) for d, t in med[-3:]] + med + [(d + 1, t + 1) for d, t in med[:3]]
    smooth_prof = []
    for i in range(3, len(ext) - 3):
        A, B = [[0.0] * 3 for _ in range(3)], [0.0] * 3
        for jj in range(i - 3, i + 4):
            w = 1.0 - abs(jj - i) / 4.0
            x = (ext[jj][0] - ext[i][0]) * NB
            row = (1.0, x, x * x)
            for r in range(3):
                B[r] += w * row[r] * ext[jj][1]
                for c in range(3):
                    A[r][c] += w * row[r] * row[c]
        smooth_prof.append((ext[i][0], solve(A, B)[0]))
    # Shift the curve so it passes through the line at 0 (and 1), where it wraps round.
    (da, ta), (db, tb) = (smooth_prof[-1][0] - 1, smooth_prof[-1][1] - 1), smooth_prof[0]
    at_line = ta + (tb - ta) * (0 - da) / (db - da)
    prof = [(0.0, 0.0)] + [(d, t - at_line) for d, t in smooth_prof] + [(1.0, 1.0)]
    print("lap-fraction scale crosses the line %.4f of a lap from the outline's start" % at_line)
    for i in range(1, len(prof)):
        prof[i] = (prof[i][0], max(prof[i][1], prof[i - 1][1] + 1e-9))  # never back in time
    clean_samples = sum(len(c) for c in by_bin)
    # Join the points with a monotone cubic (slopes: harmonic mean of the neighbouring steps, the same
    # slope either side of the line), so speed changes smoothly round the lap.
    pd_, pt_ = [p[0] for p in prof], [p[1] for p in prof]
    sec = [(pt_[i + 1] - pt_[i]) / (pd_[i + 1] - pd_[i]) for i in range(len(prof) - 1)]
    hm = lambda a, b: 2 * a * b / (a + b) if a > 0 and b > 0 else 0.0
    tan = [hm(sec[-1], sec[0])] + [hm(a, b) for a, b in zip(sec, sec[1:])] + [hm(sec[-1], sec[0])]

    def scale(d):
        i = min(max(bisect.bisect_right(pd_, d) - 1, 0), len(pd_) - 2)
        h = pd_[i + 1] - pd_[i]
        k = (d - pd_[i]) / h
        k2, k3 = k * k, k * k * k
        return ((2 * k3 - 3 * k2 + 1) * pt_[i] + (k3 - 2 * k2 + k) * h * tan[i]
                + (-2 * k3 + 3 * k2) * pt_[i + 1] + (k3 - k2) * h * tan[i + 1])
    track = [[round(scale(d), 5), round(x), round(y)] for d, x, y in track]
    print("lap-fraction scale: %d points from %d samples on clean laps" % (len(prof), clean_samples))

    progress = {}
    geo = {}  # every position sample: (race time, lap fraction, distance from the racing line, x, y)
    stops = {}  # retired cars: when they stopped, and when they turned into the pit lane if they stopped there
    leader_finish = min(b[TOTAL_LAPS - 1][1] for b in timelines.values() if len(b) >= TOTAL_LAPS)
    for dn in sorted(snapped):
        # unwrap the lap fraction into continuous laps
        series, prev_f, u, rows_geo = [], None, 0.0, []
        for st, d, off, x, y in snapped[dn]:
            f = scale(d)
            rows_geo.append((st, f, off, x, y))
            if prev_f is None:
                u = f
            else:
                d = f - prev_f
                if d > 0.5:
                    d -= 1.0
                elif d < -0.5:
                    d += 1.0
                u += d
            prev_f = f
            series.append((st, u))
        bounds = timelines.get(dn) or []
        if len(series) < 10 or len(bounds) < 2:
            continue

        def interp(tq, series=series):
            lo, hi = 0, len(series) - 1
            if tq <= series[0][0]:
                return series[0][1]
            if tq >= series[-1][0]:
                return series[-1][1]
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if series[mid][0] <= tq:
                    lo = mid
                else:
                    hi = mid
            (ta, ua), (tb, ub) = series[lo], series[hi]
            return ua + (ub - ua) * (tq - ta) / ((tb - ta) or 1)
        times = [s[0] for s in series]

        def smooth(tq, W=1.5):
            # The feed's timestamps jitter by about a tenth of a second, so speeds between neighbouring
            # samples swing by +-40%. A straight-line fit over +-1.5 s (nearer samples count more)
            # steadies the motion and still keeps a pit stop's standstill.
            lo, hi = bisect.bisect_left(times, tq - W), bisect.bisect_right(times, tq + W)
            sw = sx = sy = sxx = sxy = 0.0
            for j in range(lo, hi):
                dt = times[j] - tq
                w = 1.0 - abs(dt) / W
                uj = series[j][1]
                sw += w; sx += w * dt; sy += w * uj; sxx += w * dt * dt; sxy += w * dt * uj
            den = sw * sxx - sx * sx
            if hi - lo < 3 or sw < 1e-9 or abs(den) < 1e-9:
                return interp(tq)
            return (sy * sxx - sx * sxy) / den
        # Anchor: crossing the line to start lap 2 is exactly one lap of progress.
        offset = round(1.0 - smooth(bounds[1][0]))
        finish = bounds[-1][1]
        # A car that retires drives on after its last timed lap until it stops: hold it where it
        # stopped (under 10 m in 10 s), not at the line.
        hold_from, hold = finish, float(len(bounds))
        if len(bounds) < TOTAL_LAPS and finish < leader_finish:
            for st, _u in series[bisect.bisect_left(times, finish):]:
                if st > finish + 600:
                    break
                if interp(st + 10) - interp(st) < 0.002:
                    hold_from, hold = st, smooth(st) + offset
                    stops[str(dn)] = {"t": round(st, 1)}
                    # Stopped off the racing line, in the pit lane: from when it turned in.
                    near = [r for r in rows_geo if finish <= r[0] <= st + 20]
                    if near and near[-1][2] > OFF_LINE:
                        on = [r[0] for r in near if r[2] <= OFF_LINE]
                        stops[str(dn)]["pit"] = round(next(r[0] for r in near if r[0] > (on[-1] if on else 0)), 1)
                    break
        vals, peak = [], -1e9
        for k in range(grid_n):
            p = smooth(float(k)) + offset
            if k > hold_from:
                p = min(p, hold)
            peak = max(peak, p)  # never run backwards (projection jitter in the pit box)
            vals.append(int(round(peak * 10000)))
        progress[str(dn)] = vals
        geo[dn] = rows_geo
        print("progress %s: %d samples, offset %d, laps at flag %.3f (timing says %d)" % (
            dn, len(series), offset, vals[min(grid_n - 1, int(finish))] / 10000, len(bounds)))

    # Pit-lane starters wait at the pit exit, which projects onto the track ahead of the grid.
    # Until the field has gone by and they join, their progress (which sets the running order)
    # holds just behind the last car, queued in the order they left the pit lane. Where they
    # really were ("at", laps) is kept for drawing them in the pit lane.
    first_pos = {}
    for r in sorted(positions, key=lambda r: r["date"]):
        first_pos.setdefault(r["driver_number"], r["position"])
    pole = next((dn for dn, pos in first_pos.items() if pos == 1), None)
    behind = 20  # 0.002 laps, about 10 m
    pit_lane_starts = {}
    if pole is not None and str(pole) in progress:
        pole_p0 = progress[str(pole)][0]
        starters = [dn for dn in progress if progress[dn][0] > pole_p0 + behind]
        starters.sort(key=lambda dn: timelines[int(dn)][0][1])
        queue = [dn for dn in progress if dn not in starters]
        for dn in starters:
            vals, at = progress[dn], []
            for k in range(len(vals)):
                last = min(progress[g][k] for g in queue) - behind
                if vals[k] <= last:
                    pit_lane_starts[dn] = {"join": k, "at": at}
                    break
                at.append(vals[k])
                vals[k] = last
            queue.append(dn)
    print("pit-lane starts (driver: joins at s):", {dn: v["join"] for dn, v in pit_lane_starts.items()})

    # --- the pit lane, and when each car was in it -----------------------------------
    # Samples well off the racing line around a timed stop trace the pit lane. Each lane point
    # keeps the lap fraction it projects to (past the line counts as 1.0+), so a car in the pit
    # lane is drawn at the lane point matching its progress.

    def spans_where(rows_, keep):
        spans, cur = [], None
        for r in rows_:
            if not keep(r):
                continue
            if cur and r[0] - cur[-1][0] < 3:
                cur.append(r)
            else:
                cur = [r]
                spans.append(cur)
        return [s for s in spans if s[-1][0] - s[0][0] >= 5]

    lane_pts = []
    for dn, rows_ in geo.items():
        line_times = [timelines[dn][p - 1][1] for p in pit_laps.get(dn, []) if p <= len(timelines[dn])]
        for span in spans_where(rows_, lambda r: r[2] > OFF_LINE):
            if not any(span[0][0] <= e <= span[-1][0] for e in line_times):
                continue
            for a, b in zip(span, span[1:]):
                # Moving samples only: the fast lane, not the boxes beside it.
                if math.hypot(b[3] - a[3], b[4] - a[4]) / max(b[0] - a[0], 1e-3) > 50:
                    lane_pts.append((a[1] + 1.0 if a[1] < 0.5 else a[1], a[3], a[4]))
    BIN = 0.002  # about 10 m
    bins = {}
    for p in lane_pts:
        bins.setdefault(int(p[0] / BIN), []).append(p)
    lane = [[statistics.median(q[i] for q in bins[k]) for i in range(3)] for k in sorted(bins) if len(bins[k]) >= 5]
    for _ in range(2):  # light 3-point smoothing, ends fixed
        lane = [lane[0]] + [[(a[i] + b[i] + c[i]) / 3 for i in range(3)] for a, b, c in zip(lane, lane[1:], lane[2:])] + [lane[-1]]

    def track_at(f):
        f %= 1.0
        for (f0, x0, y0), (f1, x1, y1) in zip(track, track[1:] + [[track[0][0] + 1.0] + track[0][1:]]):
            if f0 <= f <= f1:
                k = (f - f0) / ((f1 - f0) or 1)
                return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]
        return track[0][1:]
    # Taper into the racing line at both ends, where the lane splits off and merges.
    lane = [[lane[0][0] - 0.004] + track_at(lane[0][0] - 0.004)] + lane + [[lane[-1][0] + 0.004] + track_at(lane[-1][0] + 0.004)]
    pit_lane = [[round(f, 5), round(x), round(y)] for f, x, y in lane]

    def lane_dist(x, y):
        best = float("inf")
        for (_, x0, y0), (_, x1, y1) in zip(lane, lane[1:]):
            dx, dy = x1 - x0, y1 - y0
            s = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / ((dx * dx + dy * dy) or 1.0)))
            best = min(best, math.hypot(x0 + s * dx - x, y0 + s * dy - y))
        return best
    # In the pit lane: off the racing line and nearer the lane than the track. Only while the car
    # is racing: not parked in the garage after retiring, nor driving in after the flag.
    pit_windows = {}
    for dn, rows_ in geo.items():
        done = timelines[dn][-1][1]
        spans = spans_where(rows_, lambda r: r[2] > OFF_LINE and lane_dist(r[3], r[4]) < r[2])
        wins = [[round(s[0][0], 1), round(min(s[-1][0], done + 60), 1)] for s in spans if s[0][0] < done]
        if wins:
            pit_windows[str(dn)] = wins
    print("pit lane: %d points, lap fraction %.3f to %.3f, up to %.0f m from the racing line" % (
        len(pit_lane), lane[0][0], lane[-1][0], max(math.sqrt(project(x, y, None)[0]) for _, x, y in lane) / 10.23))
    for dn in sorted(geo):
        wins = pit_windows.get(str(dn), [])
        print("  #%d pit laps %s, in the pit lane %s" % (dn, pit_laps.get(dn, []),
              ", ".join("%.0f-%.0fs (%.0fs)" % (a, b, b - a) for a, b in wins)))

    # --- standing in the box, from the speed trace ---------------------------------
    # The position feed is smoothed onto the one-second clock above, which blurs when a car stops
    # and when it moves off by up to half a second. Ferrari's stops (the ghost shares the box with
    # Leclerc) are also timed the way real double stacks on OpenF1 were: the longest run at 0 km/h
    # in the car's speed trace during each visit to the pit lane.
    team = next(d["team_name"] for d in drivers if d["driver_number"] == HAM)
    box_stops = {}
    for d in drivers:
        dn = d["driver_number"]
        if d["team_name"] != team:
            continue
        for a, z in pit_windows.get(str(dn), []):
            q0 = datetime.fromtimestamp(race_t0 + a, timezone.utc).strftime(fmt)
            q1 = datetime.fromtimestamp(race_t0 + z, timezone.utc).strftime(fmt)
            speeds = sorted((ts(r["date"]) - race_t0, r["speed"]) for r in get(
                "car_data?session_key=%d&driver_number=%d&date>%s&date<%s" % (SESSION, dn, q0, q1))
                if r.get("date") and r.get("speed") is not None)
            best, run = None, None
            for st, v in speeds:
                if v <= 0:
                    run = [st, st] if run is None else [run[0], st]
                    if best is None or run[1] - run[0] > best[1] - best[0]:
                        best = list(run)
                else:
                    run = None
            if best:
                box_stops.setdefault(str(dn), []).append([round(best[0], 2), round(best[1], 2)])
    print("standing in the box (speed trace):", {d["name_acronym"]: box_stops[str(d["driver_number"])]
                                                for d in drivers if str(d["driver_number"]) in box_stops})

    # --- race events for the ticker and the timeline ------------------------------
    codes = {d["driver_number"]: d["name_acronym"] for d in drivers}
    events = []

    def add(t_, lap, kind, text, driver=None):
        events.append({"t": round(t_, 1), "lap": lap, "kind": kind, "text": text, "driver": driver})
    inc_re = re.compile(
        r"(?:TURN (\d+) )?INCIDENT INVOLVING CAR (\d+) \((\w+)\) "
        r"(NOTED|UNDER INVESTIGATION|REVIEWED NO FURTHER INVESTIGATION|NO FURTHER ACTION|WILL BE INVESTIGATED AFTER THE RACE)"
        r"(?: - (.*))?")
    seen_inc = set()
    went_off = {}  # (driver, turn): race time of the incident, from the latest message about it
    incidents = []  # (event, (driver, turn))

    def clock_time(msg, t_msg):
        # Stewards' messages end with the track's local clock time of the incident, "(21:31:36)".
        # The message itself is stamped in UTC; the time zone is a whole number of hours and the
        # incident came less than half an hour before the message.
        m_ = re.search(r"\((\d\d):(\d\d):(\d\d)\)\s*$", msg)
        if not m_:
            return None
        clock = int(m_.group(1)) * 3600 + int(m_.group(2)) * 60 + int(m_.group(3))
        diff = (clock - (t_msg + race_t0)) % 86400
        return t_msg + diff - round(diff / 3600.0) * 3600
    for m in sorted(rc, key=lambda m: m["date"]):
        msg = m.get("message") or ""
        t_ = ts(m["date"]) - race_t0
        lap = m.get("lap_number") or 1
        if t_ < 0:
            continue
        if msg == "VSC DEPLOYED":
            add(t_, lap, "vsc", "VSC deployed")
        elif msg == "VSC ENDING":
            add(t_, lap, "vsc_end", "VSC ending")
        elif msg.startswith("MARSHALS ON TRACK"):
            add(t_, lap, "flag", msg.capitalize().replace("turn", "Turn"))
        elif msg == "CHEQUERED FLAG":
            add(t_, lap, "flag", "Chequered flag")
        else:
            mm = inc_re.search(msg)
            if mm:
                turn, num, code, status, why = mm.groups()
                at = clock_time(msg, t_)
                if at is not None and at >= 0:
                    went_off[(int(num), turn)] = round(at, 1)  # an update corrects the time
                key = (num, status)
                if key in seen_inc or (status == "NOTED" and msg.startswith("UPDATE")):
                    continue
                seen_inc.add(key)
                why = re.sub(r"\s*\(\d\d:\d\d:\d\d\)", "", (why or "")).strip().lower()
                where = ("Turn %s: " % turn) if turn else ""
                add(t_, lap, "incident", "%s%s %s (%s)" % (where, code, why or "incident", status.lower()), int(num))
                what = "off" if why.startswith("leaving the track") else (why or "incident")
                events[-1]["what"] = what + (" at Turn %s" % turn if turn else "")
                incidents.append((events[-1], (int(num), turn)))
    for e, k in incidents:
        if k in went_off:
            e["at"] = went_off[k]
    for p in pits:
        t_ = ts(p["date"]) - race_t0
        # OpenF1 stamps a stop near the pit exit; the map shows the car in the pit lane from its entry.
        win = [w for w in pit_windows.get(str(p["driver_number"]), []) if w[0] - 60 <= t_ <= w[1] + 60]
        if win:
            t_ = win[0][0]
        add(t_, p["lap_number"], "pit", "%s pits" % codes.get(p["driver_number"], p["driver_number"]), p["driver_number"])
    for dn, b in timelines.items():
        if b and len(b) < TOTAL_LAPS and b[-1][1] < leader_finish:
            # When it stopped; its last timed lap if the feed doesn't show a stop.
            s = stops.get(str(dn), {})
            add(s.get("t", b[-1][1]), len(b) + 1, "out", "%s retires%s" % (codes.get(dn, dn), " in the pit lane" if "pit" in s else ""), dn)
    events.sort(key=lambda e: e["t"])
    print("retired cars stop:", {codes.get(int(dn), dn): s for dn, s in stops.items()})
    print("incidents happened at:", {"%s %s" % (codes.get(dn, dn), turn or ""): at for (dn, turn), at in went_off.items()})

    # --- final classification -------------------------------------------------
    last_pos = {}
    for p in sorted(positions, key=lambda p: p["date"]):
        last_pos[p["driver_number"]] = p["position"]

    out = {
        "race": {"name": "2026 Singapore Grand Prix", "session_key": SESSION, "total_laps": TOTAL_LAPS,
                 "neutralised_laps": neutralised, "ref_lap": {"driver": REF_DRIVER, "lap": ref["lap_number"], "duration": ref["lap_duration"]}},
        "drivers": [{"num": d["driver_number"], "code": d["name_acronym"], "name": d["full_name"],
                     "team": d["team_name"], "colour": "#" + (d.get("team_colour") or "888888"),
                     "final_pos": last_pos.get(d["driver_number"])} for d in drivers],
        "laps": {str(dn): [round(table[k]["lap_duration"], 3) if table.get(k) and table[k].get("lap_duration") else None
                           for k in range(1, max(table) + 1)] for dn, table in by_driver.items()},
        "timelines": {str(k): v for k, v in timelines.items()},
        "stints": {str(dn): [{"compound": s["compound"], "lap_start": s["lap_start"], "lap_end": s["lap_end"],
                              "age_at_start": s.get("tyre_age_at_start") or 0} for s in v] for dn, v in stint_map.items()},
        "pits": {str(dn): sorted(v) for dn, v in pit_laps.items()},
        "model": model,
        "track": track,
        "progress": progress,
        "pit_lane_starts": pit_lane_starts,
        "pit_lane": pit_lane,
        "pit_windows": pit_windows,
        "box_stops": box_stops,
        "retired": stops,
        "events": events,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    print("neutralised laps:", neutralised)
    print("fit rows: %d  rmse: %.3fs" % (len(rows), model["rmse"]))
    print("fuel/lap %.4f  soft offset %.3f" % (model["fuel_per_lap"], model["soft_offset"]))
    for c in compounds:
        print("%s deg %.4f s/lap  cliff %.5f s/lap^2 after age %d" % (c, model["deg"][c], model["cliff"][c], model["cliff_at"][c]))
    print("pit loss green %.2fs (n=%d)  vsc %.2fs (n=%d)" % (model["pit_loss_green"], len(green_losses), model["pit_loss_vsc"], len(vsc_losses)))
    print("vsc samples:", model["pit_loss_samples"]["vsc"], " HAM base %.3f" % base[HAM])
    print("ref lap: driver %d lap %d %.3fs, %d track points" % (REF_DRIVER, ref["lap_number"], ref["lap_duration"], len(track)))
    print("final positions:", sorted(((v, next(d["name_acronym"] for d in drivers if d["driver_number"] == k)) for k, v in last_pos.items())))
    print("events:", len(events), sorted(set(e["kind"] for e in events)))
    print("wrote", out_path, "%.1f MB" % (os.path.getsize(out_path) / 1e6))


if __name__ == "__main__":
    main(sys.argv[1])
