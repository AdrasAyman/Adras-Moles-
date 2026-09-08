"""
Boolean Sector Model & Closed-Form Multilateration.

A line-for-line port of game/js/sectors.js so that CSV telemetry and the
terminal status monitor report exactly what the browser is showing. The
browser remains authoritative for gameplay; this exists for logging,
benchmarking and offline analysis.

Bearing convention: atan2(dx, dy). 0 deg points straight out from the wall,
POSITIVE turns toward +x.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

from bridge.config import (
    AREA_FAR,
    AREA_W,
    BEAM_DEFAULT_W,
    BODY_R,
    SOLVER,
)

Y_VIS_TOP = 0.20  # mirrors AREA.yVisTop in game/js/config.js


class MedianRing:
    """Rolling median over the last `n` samples. None means 'no echo'."""

    def __init__(self, n: int):
        self.n = max(1, int(n))
        self.buf: list[float | None] = []

    def push(self, v: float | None) -> None:
        self.buf.append(v)
        while len(self.buf) > self.n:
            self.buf.pop(0)

    def value(self) -> float | None:
        present = sorted(x for x in self.buf if x is not None)
        if not present:
            return None
        # Mostly dropouts -> report no echo rather than a stale median.
        if len(self.buf) >= self.n and len(present) * 2 < len(self.buf):
            return None
        m = len(present) // 2
        if len(present) % 2:
            return present[m]
        return (present[m - 1] + present[m]) / 2.0

    def fill(self) -> float:
        if not self.buf:
            return 0.0
        return sum(1 for x in self.buf if x is not None) / len(self.buf)

    def clear(self) -> None:
        self.buf.clear()


def _half(sensor: Sequence[float]) -> float:
    """Half beam width in degrees."""
    return (sensor[3] if len(sensor) > 3 else BEAM_DEFAULT_W) / 2.0


def bearing_to(bx: float, by: float, x: float, y: float) -> float:
    return math.degrees(math.atan2(x - bx, y - by))


def group_boxes(sensors: Sequence[Sequence[float]]) -> list[dict]:
    """Group sensor indices by physical box. Co-located sensors share a box."""
    boxes: list[dict] = []
    for i, s in enumerate(sensors):
        hit = None
        for b in boxes:
            if math.hypot(b["x"] - s[0], b["y"] - s[1]) < 1e-6:
                hit = b
                break
        if hit is None:
            hit = {"x": s[0], "y": s[1], "idx": [], "id": len(boxes)}
            boxes.append(hit)
        hit["idx"].append(i)
    return boxes


def subtract_interval(
    intervals: list[list[float]], cut: Sequence[float]
) -> list[list[float]]:
    out: list[list[float]] = []
    for lo, hi in intervals:
        if cut[1] <= lo or cut[0] >= hi:
            out.append([lo, hi])
            continue
        if cut[0] > lo:
            out.append([lo, min(cut[0], hi)])
        if cut[1] < hi:
            out.append([max(cut[1], lo), hi])
    return [iv for iv in out if iv[1] - iv[0] > 1e-9]


def box_sector(
    box: dict, sensors: Sequence[Sequence[float]], fired: Sequence[bool]
) -> dict | None:
    """
    Angular sector implied by which sensors in a box fired.
    Fired sensors intersect their cones; silent sensors carve theirs out.
    """
    F = [i for i in box["idx"] if fired[i]]
    if not F:
        return None

    lo, hi = -math.inf, math.inf
    for i in F:
        h = _half(sensors[i])
        lo = max(lo, sensors[i][2] - h)
        hi = min(hi, sensors[i][2] + h)

    if hi <= lo:
        wlo = min(sensors[i][2] - _half(sensors[i]) for i in F)
        whi = max(sensors[i][2] + _half(sensors[i]) for i in F)
        return {
            "lo": wlo, "hi": whi, "mid": (wlo + whi) / 2.0, "width": whi - wlo,
            "fired": F, "conflict": True, "note": "fired cones do not overlap",
        }

    pieces = [[lo, hi]]
    for i in box["idx"]:
        if fired[i]:
            continue
        h = _half(sensors[i])
        pieces = subtract_interval(pieces, [sensors[i][2] - h, sensors[i][2] + h])

    if not pieces:
        return {
            "lo": lo, "hi": hi, "mid": (lo + hi) / 2.0, "width": hi - lo,
            "fired": F, "conflict": True,
            "note": "silent sensors exclude the fired overlap",
        }

    pieces.sort(key=lambda p: p[1] - p[0], reverse=True)
    a, b = pieces[0]
    return {
        "lo": a, "hi": b, "mid": (a + b) / 2.0, "width": b - a,
        "fired": F, "conflict": False, "fragments": len(pieces),
    }


def sector_miss(sec: dict | None, bearing: float) -> float:
    if not sec:
        return 0.0
    if bearing < sec["lo"]:
        return sec["lo"] - bearing
    if bearing > sec["hi"]:
        return bearing - sec["hi"]
    return 0.0


def intersect_circles(
    x1: float, y1: float, r1: float, x2: float, y2: float, r2: float
) -> dict:
    """
    Closed-form two-circle intersection.

    `gap` is how far the circles are from touching at all. gap > 0 means the
    ranges are mutually inconsistent -- the failure a least-squares residual
    cannot report when the system is exactly determined.
    """
    dx, dy = x2 - x1, y2 - y1
    D = math.hypot(dx, dy)
    if D < 1e-6:
        return {"ok": False, "reason": "co-located centres", "gap": math.inf}

    gap = 0.0
    if D > r1 + r2:
        gap = D - (r1 + r2)
    elif D < abs(r1 - r2):
        gap = abs(r1 - r2) - D

    a = (r1 * r1 - r2 * r2 + D * D) / (2.0 * D)
    h2 = r1 * r1 - a * a
    clamped = h2 < 0
    h = 0.0 if clamped else math.sqrt(h2)

    ux, uy = dx / D, dy / D
    px, py = x1 + a * ux, y1 + a * uy

    return {
        "ok": True,
        "clamped": clamped,
        "gap": gap,
        "candidates": [
            {"x": px - h * uy, "y": py + h * ux},
            {"x": px + h * uy, "y": py - h * ux},
        ],
    }


def refine_gauss_newton(obs: list[dict], seed: dict, iters: int = 6) -> dict:
    x, y = seed["x"], seed["y"]
    for _ in range(iters):
        a = b = c = gx = gy = 0.0
        for o in obs:
            dx, dy = x - o["x"], y - o["y"]
            d = math.hypot(dx, dy) or 1e-6
            jx, jy = dx / d, dy / d
            e = d - o["d"]
            a += jx * jx
            b += jx * jy
            c += jy * jy
            gx += jx * e
            gy += jy * e
        a += 1e-6
        c += 1e-6
        det = a * c - b * b
        if abs(det) < 1e-12:
            break
        sx = (gx * c - gy * b) / det
        sy = (gy * a - gx * b) / det
        x -= sx
        y -= sy
        if math.hypot(sx, sy) < 1e-6:
            break
    return {"x": x, "y": y}


def rms_residual(obs: list[dict], p: dict) -> float:
    if not obs:
        return 0.0
    s = sum((math.hypot(p["x"] - o["x"], p["y"] - o["y"]) - o["d"]) ** 2 for o in obs)
    return math.sqrt(s / len(obs))


def solve_sectors(
    ranges: Sequence[float | None],
    sensors: Sequence[Sequence[float]],
    prev: dict | None = None,
) -> dict[str, Any]:
    """
    Full pipeline. `ranges` are surface ranges in metres (None = no echo),
    already median-filtered. Returns a diagnostic dict whose `mode` is
    "two-box", "one-box" or "blind".
    """
    boxes = group_boxes(sensors)
    fired = [ranges[i] is not None for i in range(len(sensors))]

    info = []
    for b in boxes:
        sec = box_sector(b, sensors, fired)
        rs = [ranges[i] for i in b["idx"] if ranges[i] is not None]
        if not rs:
            info.append({"box": b, "sec": sec, "d": None, "spread": 0.0, "n": 0, "raw": []})
        else:
            info.append({
                "box": b,
                "sec": sec,
                "d": sum(rs) / len(rs) + BODY_R,   # surface -> body centre
                "spread": max(rs) - min(rs),       # co-located disagreement
                "n": len(rs),
                "raw": list(rs),
            })

    live = [o for o in info if o["d"] is not None]
    result: dict[str, Any] = {
        "mode": "blind", "x": None, "y": None, "boxes": info, "live": len(live),
        "fired": fired, "candidates": [], "chosen": -1, "gap": 0.0,
        "spread": max([o["spread"] for o in info], default=0.0),
        "residual": 0.0, "sigma": math.inf, "veto": False, "split": False,
        "worst_miss": 0.0, "reason": "",
        "conflict": any(o["sec"] and o["sec"]["conflict"] for o in info),
    }

    if not live:
        result["reason"] = "no sensor returned an echo"
        return result

    if len(live) >= 2:
        pa, pb, best_d = live[0], live[1], -1.0
        for i in range(len(live)):
            for j in range(i + 1, len(live)):
                D = math.hypot(
                    live[i]["box"]["x"] - live[j]["box"]["x"],
                    live[i]["box"]["y"] - live[j]["box"]["y"],
                )
                if D > best_d:
                    best_d, pa, pb = D, live[i], live[j]

        # Distance hypotheses per box. Co-located sensors that disagree badly
        # are NOT averaged -- one of them is wrong, so the mean is wrong too.
        # Offer both and let the cross-box geometry arbitrate.
        def hyp_of(o):
            if o["n"] > 1 and o["spread"] > SOLVER["pair_spread_warn"]:
                return [v + BODY_R for v in o["raw"]]
            return [o["d"]]

        hA, hB = hyp_of(pa), hyp_of(pb)
        result["split"] = len(hA) > 1 or len(hB) > 1

        best = None
        for dA in hA:
            for dB in hB:
                ix = intersect_circles(
                    pa["box"]["x"], pa["box"]["y"], dA,
                    pb["box"]["x"], pb["box"]["y"], dB,
                )
                if not ix["ok"]:
                    continue
                for ci, c in enumerate(ix["candidates"]):
                    miss = sum(
                        sector_miss(
                            o["sec"],
                            bearing_to(o["box"]["x"], o["box"]["y"], c["x"], c["y"]),
                        )
                        for o in live if o["sec"]
                    )
                    outside = (
                        max(0.0, -0.30 - c["x"]) + max(0.0, c["x"] - AREA_W - 0.30)
                        + max(0.0, Y_VIS_TOP - c["y"]) + max(0.0, c["y"] - AREA_FAR - 0.30)
                    )
                    cont = (
                        math.hypot(c["x"] - prev["x"], c["y"] - prev["y"]) if prev else 0.0
                    )
                    score = miss * 0.05 + outside * 2.0 + ix["gap"] * 0.5 + cont * 0.10
                    if best is None or score < best["score"]:
                        best = {
                            "score": score, "miss": miss, "outside": outside,
                            "cont": cont, "gap": ix["gap"], "clamped": ix["clamped"],
                            "p": c, "ci": ci, "dA": dA, "dB": dB,
                            "cands": ix["candidates"],
                        }

        if best is not None:
            result["gap"] = best["gap"]
            result["chosen"] = best["ci"]
            result["candidates"] = best["cands"]
            result["used_ranges"] = {
                "box_a": pa["box"]["id"], "d_a": best["dA"],
                "box_b": pb["box"]["id"], "d_b": best["dB"],
            }

            p = best["p"]
            obs = [{
                "x": o["box"]["x"], "y": o["box"]["y"],
                "d": best["dA"] if o is pa else (best["dB"] if o is pb else o["d"]),
            } for o in live]
            if len(live) > 2:
                p = refine_gauss_newton(obs, p, 6)

            result["x"], result["y"] = p["x"], p["y"]
            result["residual"] = rms_residual(obs, p)
            result["mode"] = "two-box"
            result["sigma"] = max(
                0.02,
                best["gap"] / 2.0 + (0.10 if result["split"] else result["spread"] / 2.0),
            )

            worst_miss, worst_box = 0.0, -1
            for o in live:
                if not o["sec"]:
                    continue
                m = sector_miss(
                    o["sec"], bearing_to(o["box"]["x"], o["box"]["y"], p["x"], p["y"])
                )
                if m > worst_miss:
                    worst_miss, worst_box = m, o["box"]["id"]
            result["worst_miss"] = worst_miss

            # Two different failures deserve two different responses.
            #
            # A large GAP means the ranges contradict each other, so the fix
            # is a clamped fiction -- a polar estimate really is better.
            #
            # A sector MISS means the ranges are self-consistent but disagree
            # with the angular model, which is almost always a calibration
            # error. Two precise ranges beat a coarse angular bracket, so keep
            # the fix and raise the flag rather than substituting a guess.
            allow_fallback = False
            if best["gap"] > SOLVER["max_gap"]:
                result["veto"] = True
                allow_fallback = True
                result["reason"] = (
                    f"ranges inconsistent: circles miss by {best['gap'] * 1000:.0f} mm"
                )
            elif worst_miss > SOLVER["sector_tol_deg"]:
                result["veto"] = True
                result["sigma"] = max(
                    result["sigma"], best["dA"] * math.sin(math.radians(worst_miss))
                )
                result["reason"] = (
                    f"fix sits {worst_miss:.1f} deg outside box {worst_box}'s cone"
                    " - check the aim / width calibration"
                )
            elif result["split"]:
                result["reason"] = (
                    f"box pair disagreed by {result['spread'] * 1000:.0f} mm; "
                    "geometry picked the consistent reading"
                )

            if not allow_fallback:
                return result
        else:
            result["reason"] = "no usable circle intersection"

    usable = [o for o in live if o["sec"] and math.isfinite(o["sec"]["mid"])]
    if usable:
        pick = sorted(usable, key=lambda o: o["sec"]["width"])[0]
        th = math.radians(pick["sec"]["mid"])
        was_vetoed = result["veto"]

        result["mode"] = "one-box"
        result["x"] = pick["box"]["x"] + pick["d"] * math.sin(th)
        result["y"] = pick["box"]["y"] + pick["d"] * math.cos(th)
        result["polar_box"] = pick["box"]["id"]
        result["polar_sector"] = pick["sec"]
        result["sigma"] = max(
            0.05, pick["d"] * math.sin(math.radians(pick["sec"]["width"] / 2.0))
        )
        result["residual"] = 0.0
        if was_vetoed:
            result["reason"] += f" - fell back to box {pick['box']['id']} polar fix"
        else:
            result["reason"] = f"only box {pick['box']['id']} has line of sight"
        return result

    result["mode"] = "blind"
    result["x"] = result["y"] = None
    if not result["reason"]:
        result["reason"] = "no usable sector"
    return result
