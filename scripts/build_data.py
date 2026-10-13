"""Fetch the 2026 Singapore GP race from OpenF1, fit a tyre model, write public/data/race.json.

Run: python.exe -B scripts/build_data.py <output_json_path>
"""
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timezone

BASE = "https://api.openf1.org/v1/"
SESSION = 11388
TOTAL_LAPS = 62
REF_DRIVER = 3  # Verstappen: led every lap, clean reference lap for the track outline
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")


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
    track = []
    for p in sorted(loc, key=lambda p: p["date"]):
        f = (ts(p["date"]) - t_start) / ref["lap_duration"]
        if -0.01 <= f <= 1.01:
            track.append([round(f, 5), p["x"], p["y"]])

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
            best = min((seg((hint + k) % n_ref) for k in range(-8, 30)), key=lambda r: r[0])
            if best[0] < 300 ** 2:
                return best
        return min((seg(i) for i in range(n_ref)), key=lambda r: r[0])

    race_end = max(b[-1][1] for b in timelines.values() if b) + 20
    grid_n = int(race_end) + 1
    progress = {}
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
        # unwrap the lap fraction into continuous laps
        series, hint, prev_f, u = [], None, None, 0.0
        for st, x, y in samples:
            if x == 0 and y == 0:
                continue  # samples without a position fix
            _, f, hint = project(x, y, hint)
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
        # Anchor: crossing the line to start lap 2 is exactly one lap of progress.
        offset = round(1.0 - interp(bounds[1][0]))
        finish = bounds[-1][1]
        vals, peak = [], -1e9
        for k in range(grid_n):
            p = interp(float(k)) + offset
            if k > finish:
                p = min(p, float(len(bounds)))
            peak = max(peak, p)  # never run backwards (projection jitter in the pit box)
            vals.append(int(round(peak * 10000)))
        progress[str(dn)] = vals
        print("progress %s: %d samples, offset %d, laps at flag %.3f (timing says %d)" % (
            dn, len(series), offset, vals[min(grid_n - 1, int(finish))] / 10000, len(bounds)))

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
                key = (num, status)
                if key in seen_inc or (status == "NOTED" and msg.startswith("UPDATE")):
                    continue
                seen_inc.add(key)
                why = re.sub(r"\s*\(\d\d:\d\d:\d\d\)", "", (why or "")).strip().lower()
                where = ("Turn %s: " % turn) if turn else ""
                add(t_, lap, "incident", "%s%s %s (%s)" % (where, code, why or "incident", status.lower()), int(num))
    for p in pits:
        t_ = ts(p["date"]) - race_t0
        add(t_, p["lap_number"], "pit", "%s pits" % codes.get(p["driver_number"], p["driver_number"]), p["driver_number"])
    leader_finish = min(b[TOTAL_LAPS - 1][1] for b in timelines.values() if len(b) >= TOTAL_LAPS)
    for dn, b in timelines.items():
        if b and len(b) < TOTAL_LAPS and b[-1][1] < leader_finish:
            add(b[-1][1], len(b) + 1, "out", "%s retires" % codes.get(dn, dn), dn)
    events.sort(key=lambda e: e["t"])

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
