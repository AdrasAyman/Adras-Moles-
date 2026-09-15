"""
Session Analysis: turns a recorded session's samples and events into the
summary statistics and chart-ready series shown on logs.html.

Everything here is pure (no I/O besides reading from the store) and uses only
the standard library, so the same numbers can be reproduced offline from an
exported CSV.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

from bridge.telemetry_db import MAX_SENSORS, SAMPLE_COLS, TelemetryStore

SUMMARY_VERSION = 2   # 2: configuration label, per-sensor update rates and hold times
MODES = ("two-box", "one-box", "blind", "mouse")
HIST_BIN_MM = 50
HIST_MAX_MM = 2500
REACTION_BIN_MS = 250
PLAY_AREA = {"x0": 0.0, "x1": 1.5, "y0": 0.2, "y1": 2.0}  # matches AREA in config.js
DEAD_ZONE_Y = 0.6
PATH_GAP_MS = 500      # a longer silence breaks the path (no teleport distance)
HEAT_NX, HEAT_NY = 30, 36


# ── small stats helpers ─────────────────────────────────────────────────────
def _pct(sorted_vals: Sequence[float], q: float) -> float | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = q * (len(sorted_vals) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_vals) - 1)
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo))


def describe(vals: Sequence[float]) -> dict[str, Any]:
    v = sorted(x for x in vals if x is not None)
    n = len(v)
    if not n:
        return {"n": 0}
    mean = sum(v) / n
    std = math.sqrt(sum((x - mean) ** 2 for x in v) / n) if n > 1 else 0.0
    return {"n": n, "min": v[0], "max": v[-1], "mean": mean, "std": std,
            "median": _pct(v, 0.5), "p5": _pct(v, 0.05), "p10": _pct(v, 0.10),
            "p90": _pct(v, 0.90), "p95": _pct(v, 0.95)}


def histogram(vals: Sequence[float], width: float, lo: float, hi: float) -> dict[str, Any]:
    nb = max(1, int(math.ceil((hi - lo) / width)))
    counts = [0] * nb
    over = 0
    for x in vals:
        if x is None:
            continue
        i = int((x - lo) // width)
        if i < 0:
            continue
        if i >= nb:
            over += 1
            continue
        counts[i] += 1
    return {"lo": lo, "width": width, "counts": counts, "over": over}


# ── summary ─────────────────────────────────────────────────────────────────
def summarize(store: TelemetryStore, session_id: int) -> dict[str, Any] | None:
    sess = store.session(session_id)
    if sess is None:
        return None
    rows = store.samples(session_id)
    events = store.events(session_id)
    ix = {c: i for i, c in enumerate(SAMPLE_COLS)}
    col = lambda name: [r[ix[name]] for r in rows]

    meta = sess.get("meta") or {}
    n_sensors = int(meta.get("n_sensors") or MAX_SENSORS)
    n_sensors = max(1, min(n_sensors, MAX_SENSORS))

    t = col("t")
    duration_ms = (t[-1] - t[0]) if len(t) > 1 else 0
    if events:
        duration_ms = max(duration_ms, events[-1]["t"] - (t[0] if t else events[0]["t"]))

    src_counts: dict[str, int] = {}
    for s in col("src"):
        src_counts[s or "?"] = src_counts.get(s or "?", 0) + 1

    # anomalies by type (and per sensor where the event names one)
    anomaly_counts: dict[str, int] = {}
    per_sensor_anom = [dict() for _ in range(n_sensors)]
    for e in events:
        if e["category"] != "anomaly":
            continue
        anomaly_counts[e["type"]] = anomaly_counts.get(e["type"], 0) + 1
        si = e["data"].get("sensor")
        if isinstance(si, int) and 0 <= si < n_sensors:
            per_sensor_anom[si][e["type"]] = per_sensor_anom[si].get(e["type"], 0) + 1

    # sensor configuration, taken from what the session itself recorded
    msens = [x for x in (meta.get("sensors") or []) if isinstance(x, dict)]
    widths = sorted({float(x["w"]) for x in msens if isinstance(x.get("w"), (int, float))})
    config = {
        "n_sensors": n_sensors,
        "values_per_box": meta.get("values_per_box") or max(1, round(n_sensors / 2)),
        "widths_deg": widths,
        "label": f"{n_sensors} sensors" + (f" · {'/'.join(f'{w:g}' for w in widths)}°" if widths else ""),
        "names": [str(x.get("n", i)) for i, x in enumerate(msens)][:n_sensors],
        "sim_timing": meta.get("sim_timing"),
    }

    # sensors
    live_rows = [r for r in rows if r[ix["src"]] != "mouse"] or rows
    sensors = []
    for i in range(n_sensors):
        raw = [r[ix[f"r{i}"]] for r in rows]
        med = [r[ix[f"m{i}"]] for r in rows]
        live_raw = [r[ix[f"r{i}"]] for r in live_rows]
        present = [x for x in raw if x is not None]
        longest = 0
        for e in events:
            if e["type"] == "dropout" and e["data"].get("sensor") == i:
                longest = max(longest, int(e["data"].get("duration_ms") or 0))

        # Update timing from the recorded value ages (sessions from v2 on). A new
        # reading shows up as the age dropping; the gap before it is how long the
        # previous value was held.
        updates, intervals, holds = 0, [], []
        prev = None
        for r in live_rows:
            a = r[ix[f"a{i}"]]
            if a is None:
                continue
            holds.append(a)
            if prev is not None and a < prev[0]:
                updates += 1
                intervals.append(prev[0] + (r[ix["t"]] - prev[1]) - a)
            prev = (a, r[ix["t"]])
        span_s = ((live_rows[-1][ix["t"]] - live_rows[0][ix["t"]]) / 1000.0) if len(live_rows) > 1 else 0
        sensors.append({
            "index": i,
            "echo_rate": (sum(1 for x in live_raw if x is not None) / len(live_raw)) if live_raw else None,
            "raw": describe(present),
            "median": describe([x for x in med if x is not None]),
            "hist": histogram(present, HIST_BIN_MM, 0, HIST_MAX_MM),
            "spikes": per_sensor_anom[i].get("spike", 0),
            "dropouts": per_sensor_anom[i].get("dropout", 0),
            "longest_dropout_ms": longest,
            "has_timing": bool(holds),
            "updates": updates if holds else None,
            "update_hz": (updates / span_s) if holds and span_s > 0 else None,
            "hold_ms": describe(holds),
            "interval_ms": describe(intervals),
            "long_holds": per_sensor_anom[i].get("long_hold", 0),
        })

    # solver
    solver_rows = [r for r in rows if r[ix["src"]] != "mouse"]
    mode_share = {m: 0.0 for m in MODES}
    for r in rows:
        m = r[ix["mode"]]
        if m in mode_share:
            mode_share[m] += 1
    if rows:
        mode_share = {k: v / len(rows) for k, v in mode_share.items()}

    def rate(name: str) -> float | None:
        if not solver_rows:
            return None
        return sum(1 for r in solver_rows if r[ix[name]]) / len(solver_rows)

    fixed = [r for r in solver_rows if r[ix["mode"]] in ("two-box", "one-box")]
    solver = {
        "samples": len(solver_rows),
        "mode_share": mode_share,
        "veto_rate": rate("veto"), "split_rate": rate("split"),
        "conflict_rate": rate("conflict"), "stale_rate": rate("stale"),
        "sigma": describe([r[ix["sigma"]] for r in fixed]),
        "sigma_two_box": describe([r[ix["sigma"]] for r in fixed if r[ix["mode"]] == "two-box"]),
        "sigma_one_box": describe([r[ix["sigma"]] for r in fixed if r[ix["mode"]] == "one-box"]),
        "gap": describe([r[ix["gap"]] for r in fixed]),
        "spread": describe([r[ix["spread"]] for r in fixed]),
        "sector_miss": describe([r[ix["miss"]] for r in fixed]),
        "gate_reject_samples": sum(1 for r in solver_rows if (r[ix["gate"]] or 0) > 0),
        "age_spread_ms": describe([
            max(ages) - min(ages) for ages in (
                [r[ix[f"a{i}"]] for i in range(n_sensors)
                 if r[ix[f"a{i}"]] is not None and r[ix[f"m{i}"]] is not None]
                for r in fixed if r[ix["mode"]] == "two-box")
            if len(ages) > 1]),
        "raw_vs_filtered_mm": describe([
            1000.0 * math.hypot(r[ix["x_raw"]] - r[ix["x"]], r[ix["y_raw"]] - r[ix["y"]])
            for r in fixed if None not in (r[ix["x_raw"]], r[ix["y_raw"]], r[ix["x"]], r[ix["y"]])]),
    }

    # accuracy against ground truth (bench truth marker, or the simulated body)
    def _err(xk: str, yk: str, mode: str | None = None) -> dict:
        return describe([1000.0 * math.hypot(r[ix[xk]] - r[ix["tx"]], r[ix[yk]] - r[ix["ty"]])
                         for r in solver_rows
                         if None not in (r[ix[xk]], r[ix[yk]], r[ix["tx"]], r[ix["ty"]])
                         and (mode is None or r[ix["mode"]] == mode)])
    accuracy = {
        "raw_fix_mm": _err("x_raw", "y_raw"),
        "filtered_mm": _err("x", "y"),
        "raw_fix_two_box_mm": _err("x_raw", "y_raw", "two-box"),
        "raw_fix_one_box_mm": _err("x_raw", "y_raw", "one-box"),
    }

    # position, path, speed, heat map, dead zone
    heat = [[0] * HEAT_NY for _ in range(HEAT_NX)]
    path_m = 0.0
    speeds = []
    prev = None
    for r in rows:
        x, y, tt = r[ix["x"]], r[ix["y"]], r[ix["t"]]
        if x is None or y is None:
            prev = None
            continue
        gx = int((x - PLAY_AREA["x0"]) / (PLAY_AREA["x1"] - PLAY_AREA["x0"]) * HEAT_NX)
        gy = int((y - PLAY_AREA["y0"]) / (PLAY_AREA["y1"] - PLAY_AREA["y0"]) * HEAT_NY)
        if 0 <= gx < HEAT_NX and 0 <= gy < HEAT_NY:
            heat[gx][gy] += 1
        if prev is not None and 0 < tt - prev[2] <= PATH_GAP_MS:
            d = math.hypot(x - prev[0], y - prev[1])
            path_m += d
            speeds.append(d / ((tt - prev[2]) / 1000.0))
        prev = (x, y, tt)

    dz_exits = [e for e in events if e["type"] == "deadzone_exit"]
    position = {
        "path_m": path_m,
        "speed_mps": describe(speeds),
        "heat": {"nx": HEAT_NX, "ny": HEAT_NY, **PLAY_AREA, "counts": heat},
        "deadzone_entries": sum(1 for e in events if e["type"] == "deadzone_enter"),
        "deadzone_s": sum((e["data"].get("duration_ms") or 0) for e in dz_exits) / 1000.0,
    }

    # game
    game_events = [e for e in events if e["category"] == "game"]
    hits = [e for e in game_events if e["type"] == "hit"]
    good_hits = [e for e in hits if e["data"].get("kind") != "bomb"]
    escapes = [e for e in game_events if e["type"] == "escape" and e["data"].get("kind") != "bomb"]
    spawns = [e for e in game_events if e["type"] == "spawn"]
    reactions = [e["data"].get("reaction_ms") for e in good_hits if isinstance(e["data"].get("reaction_ms"), (int, float))]
    levels: dict[int, dict] = {}
    for e in game_events:
        lv = e["data"].get("level")
        if not isinstance(lv, int):
            continue
        L = levels.setdefault(lv, {"level": lv, "spawns": 0, "hits": 0, "gold": 0, "bombs_hit": 0,
                                   "escapes": 0, "reactions": []})
        k = e["data"].get("kind")
        if e["type"] == "spawn" and k != "bomb":
            L["spawns"] += 1
        elif e["type"] == "hit":
            if k == "bomb":
                L["bombs_hit"] += 1
            else:
                L["hits"] += 1
                L["gold"] += 1 if k == "gold" else 0
                if isinstance(e["data"].get("reaction_ms"), (int, float)):
                    L["reactions"].append(e["data"]["reaction_ms"])
        elif e["type"] == "escape" and k != "bomb":
            L["escapes"] += 1
    level_rows = []
    for lv in sorted(levels):
        L = levels[lv]
        resolved = L["hits"] + L["escapes"]
        r = describe(L.pop("reactions"))
        level_rows.append({**L, "accuracy": (L["hits"] / resolved) if resolved else None,
                           "reaction_median_ms": r.get("median"), "reaction_n": r["n"]})

    runs = [e["data"] for e in game_events if e["type"] == "run_end"]
    resolved = len(good_hits) + len(escapes)
    game = {
        "rounds": sum(1 for e in game_events if e["type"] == "round_start"),
        "runs_finished": len(runs),
        "spawns": sum(1 for e in spawns if e["data"].get("kind") != "bomb"),
        "bombs_spawned": sum(1 for e in spawns if e["data"].get("kind") == "bomb"),
        "hits": len(good_hits),
        "gold_hits": sum(1 for e in good_hits if e["data"].get("kind") == "gold"),
        "bombs_hit": len(hits) - len(good_hits),
        "escapes": len(escapes),
        "accuracy": (len(good_hits) / resolved) if resolved else None,
        "reaction_ms": describe(reactions),
        "reaction_hist": histogram(reactions, REACTION_BIN_MS, 0, 6000),
        "max_score": max([r[ix["score"]] for r in rows if r[ix["score"]] is not None] +
                         [int(x.get("score") or 0) for x in runs], default=0),
        "best_streak": max([int(x.get("best_streak") or 0) for x in runs] +
                           [int(e["data"].get("streak") or 0) for e in good_hits], default=0),
        "hit_distance_mm": describe([e["data"].get("dist_mm") for e in good_hits
                                     if isinstance(e["data"].get("dist_mm"), (int, float))]),
        "levels": level_rows,
        "runs": runs,
    }

    minutes = duration_ms / 60000.0
    return {
        "version": SUMMARY_VERSION,
        "session_id": session_id,
        "duration_s": duration_ms / 1000.0,
        "n_samples": len(rows),
        "n_events": len(events),
        "n_sensors": n_sensors,
        "config": config,
        "src_counts": src_counts,
        "rates": {"meas_hz": describe([x for x in col("meas_hz") if x]),
                  "fps": describe([x for x in col("fps") if x])},
        "sensors": sensors,
        "solver": solver,
        "position": position,
        "accuracy": accuracy,
        "game": game,
        "anomalies": {"counts": anomaly_counts, "total": sum(anomaly_counts.values()),
                      "per_minute": (sum(anomaly_counts.values()) / minutes) if minutes > 0 else None},
        "calibration": {
            "captures": sum(1 for e in events if e["type"] == "capture_done"),
            "fits": [e["data"] for e in events if e["type"] == "fit"],
        },
    }


# ── bucketed series for charts ──────────────────────────────────────────────
def series(store: TelemetryStore, session_id: int, buckets: int = 600) -> dict[str, Any]:
    rows = store.samples(session_id)
    ix = {c: i for i, c in enumerate(SAMPLE_COLS)}
    if not rows:
        return {"t": [], "n": [], "stats": {}, "mode": {}, "path": []}
    # At least ~2 samples per bucket on average: an empty bucket should mean the
    # value was genuinely missing (a dropout), not that sampling was sparse.
    buckets = max(10, min(int(buckets), 4000, max(10, len(rows) // 2)))
    t0, t1 = rows[0][ix["t"]], rows[-1][ix["t"]]
    span = max(1, t1 - t0)
    width = span / buckets
    nb = buckets

    numeric = ([f"r{i}" for i in range(MAX_SENSORS)] + [f"m{i}" for i in range(MAX_SENSORS)] +
               ["sigma", "gap", "spread", "miss", "meas_hz", "fps", "score", "x", "y", "err"] +
               [f"a{i}" for i in range(MAX_SENSORS)])
    acc = {c: {"sum": [0.0] * nb, "cnt": [0] * nb, "min": [None] * nb, "max": [None] * nb} for c in numeric}
    mode_cnt = {m: [0] * nb for m in MODES}
    veto_cnt = [0] * nb
    n = [0] * nb

    for r in rows:
        b = min(nb - 1, int((r[ix["t"]] - t0) / width))
        n[b] += 1
        m = r[ix["mode"]]
        if m in mode_cnt:
            mode_cnt[m][b] += 1
        if r[ix["veto"]]:
            veto_cnt[b] += 1
        err = None
        if None not in (r[ix["x_raw"]], r[ix["y_raw"]], r[ix["tx"]], r[ix["ty"]]) and r[ix["src"]] != "mouse":
            err = 1000.0 * math.hypot(r[ix["x_raw"]] - r[ix["tx"]], r[ix["y_raw"]] - r[ix["ty"]])
        for c in numeric:
            v = err if c == "err" else r[ix[c]]
            if v is None:
                continue
            a = acc[c]
            a["sum"][b] += v
            a["cnt"][b] += 1
            a["min"][b] = v if a["min"][b] is None else min(a["min"][b], v)
            a["max"][b] = v if a["max"][b] is None else max(a["max"][b], v)

    stats = {}
    for c, a in acc.items():
        if not any(a["cnt"]):
            continue
        stats[c] = {
            "mean": [(a["sum"][i] / a["cnt"][i]) if a["cnt"][i] else None for i in range(nb)],
            "min": a["min"], "max": a["max"],
        }

    step = max(1, len(rows) // 5000)
    path = [[r[ix["t"]], r[ix["x"]], r[ix["y"]], r[ix["mode"]]]
            for r in rows[::step] if r[ix["x"]] is not None]

    return {
        "t0": t0, "t1": t1, "bucket_ms": width,
        "t": [t0 + (i + 0.5) * width for i in range(nb)],
        "n": n,
        "stats": stats,
        "mode": {m: [(mode_cnt[m][i] / n[i]) if n[i] else None for i in range(nb)] for m in MODES},
        "veto": [(veto_cnt[i] / n[i]) if n[i] else None for i in range(nb)],
        "path": path,
    }


# ── trends across sessions ─────────────────────────────────────────────────
def trend_row(sess: dict) -> dict[str, Any]:
    s = sess.get("summary") or {}
    solver = s.get("solver") or {}
    game = s.get("game") or {}
    rates = s.get("rates") or {}
    cfg = s.get("config") or {}
    acc = s.get("accuracy") or {}
    return {
        "id": sess["id"], "started_at": sess["started_at"], "page": sess["page"], "src": sess["src"],
        "layout": sess["layout"], "label": sess["label"],
        "n_sensors": cfg.get("n_sensors") or s.get("n_sensors"),
        "config": cfg.get("label"),
        "error_median_mm": (acc.get("raw_fix_mm") or {}).get("median"),
        "age_spread_median_ms": (solver.get("age_spread_ms") or {}).get("median"),
        "duration_s": s.get("duration_s"), "n_samples": sess["n_samples"],
        "two_box_share": None if sess["src"] == "mouse" else (solver.get("mode_share") or {}).get("two-box"),
        "blind_share": None if sess["src"] == "mouse" else (solver.get("mode_share") or {}).get("blind"),
        "veto_rate": solver.get("veto_rate"),
        "sigma_median_mm": (solver.get("sigma") or {}).get("median"),
        "meas_hz_median": (rates.get("meas_hz") or {}).get("median"),
        "anomalies": (s.get("anomalies") or {}).get("total"),
        "anomalies_per_min": (s.get("anomalies") or {}).get("per_minute"),
        "hits": game.get("hits"), "accuracy": game.get("accuracy"),
        "reaction_median_ms": (game.get("reaction_ms") or {}).get("median"),
        "max_score": game.get("max_score"),
    }
