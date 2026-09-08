#!/usr/bin/env python3
"""
Layout Benchmark Tool: Evaluates geometric coverage and position error for sensor arrangements.

Sweeps a 2D grid of true player positions across the active play area, simulates
ultrasonic ranges across multiple stochastic trials, solves for position, and reports
coverage metrics (fix rate, mean echoes, median error, p90 error, worst cell).

Usage:
    python tools/layout_bench.py
    python tools/layout_bench.py --noise 20 --beam 45 --trials 60
    python tools/layout_bench.py --grid 15 --csv bench.csv
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import random
import statistics
import sys
from typing import Any, Sequence

# Ensure workspace root is on sys.path so bridge can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.config import AREA_FAR, AREA_NEAR, AREA_W, BODY_R, LAYOUTS
from bridge.sectors import solve_sectors
from bridge.simulator import Walker
from bridge.solver import solve as solve_legacy


def bench_layout(
    name: str,
    sensors: Sequence[tuple[float, float, float]],
    noise: float,
    drop: float,
    beam: float,
    grid: int,
    trials: int,
    rows: list[list[str]] | None = None,
) -> dict[str, Any]:
    """
    Simulates position estimation across a spatial grid for a specific sensor layout.
    """
    # beam=None means "sense with each sensor's own calibrated width", which is
    # what the solver assumes. Pass a number to deliberately mis-calibrate.
    walker = Walker(sensors, noise / 1000.0, drop / 100.0, beam)
    errs: list[float] = []
    errs_two: list[float] = []
    errs_one: list[float] = []
    legacy_errs: list[float] = []
    legacy_nofix = 0
    nofix = 0
    vetoes = 0
    total = 0
    nsens: list[int] = []
    worst: tuple[float, tuple[float, float] | None] = (0.0, None)

    for gi in range(grid):
        for gj in range(grid):
            tx = 0.12 + (gi / (grid - 1)) * (AREA_W - 0.24)
            ty = AREA_NEAR + 0.10 + (gj / (grid - 1)) * (AREA_FAR - AREA_NEAR - 0.20)
            cell_errs: list[float] = []

            for _ in range(trials):
                total += 1
                mm = walker.ranges_mm(tx, ty)
                r = [None if v is None else v / 1000.0 for v in mm]
                nsens.append(sum(1 for v in r if v is not None))

                lg = solve_legacy(r, sensors)
                if lg is None:
                    legacy_nofix += 1
                else:
                    legacy_errs.append(math.hypot(lg[0] - tx, lg[1] - ty))

                fix = solve_sectors(r, sensors)
                if fix["veto"]:
                    vetoes += 1
                if fix["x"] is None:
                    nofix += 1
                    continue

                e = math.hypot(fix["x"] - tx, fix["y"] - ty)
                errs.append(e)
                cell_errs.append(e)
                (errs_two if fix["mode"] == "two-box" else errs_one).append(e)

            if cell_errs:
                med = statistics.median(cell_errs)
                if med > worst[0]:
                    worst = (med, (tx, ty))
                if rows is not None:
                    fix_pct = 100.0 * sum(1 for _ in cell_errs) / trials
                    rows.append([
                        name,
                        f"{tx:.3f}",
                        f"{ty:.3f}",
                        f"{med * 1000.0:.1f}",
                        f"{fix_pct:.0f}",
                    ])

    errs.sort()

    def percentile(q: float) -> float:
        if not errs:
            return float("nan")
        idx = min(len(errs) - 1, int(q * len(errs)))
        return errs[idx] * 1000.0

    def pct(vals: list[float], q: float) -> float:
        if not vals:
            return float("nan")
        sv = sorted(vals)
        return sv[min(len(sv) - 1, int(q * len(sv)))] * 1000.0

    return {
        "name": name,
        "n": len(sensors),
        "fixrate": 100.0 * (1.0 - nofix / total),
        "two_pct": 100.0 * len(errs_two) / total,
        "one_pct": 100.0 * len(errs_one) / total,
        "veto_pct": 100.0 * vetoes / total,
        "mean_sensors": statistics.mean(nsens) if nsens else 0.0,
        "median": percentile(0.50),
        "p90": percentile(0.90),
        "two_median": pct(errs_two, 0.50),
        "one_median": pct(errs_one, 0.50),
        "legacy_fixrate": 100.0 * (1.0 - legacy_nofix / total),
        "legacy_median": pct(legacy_errs, 0.50),
        "worst": worst[0] * 1000.0,
        "worst_at": worst[1] or (0.0, 0.0),
    }


def main():
    parser = argparse.ArgumentParser(
        description="MOLEFIELD Sensor Layout Benchmark",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--noise", type=float, default=8.0, help="Range noise σ (mm)")
    parser.add_argument("--dropout", type=float, default=3.0, help="Missing echo rate (%)")
    parser.add_argument(
        "--beam",
        type=float,
        default=None,
        help="Override the SENSING beam full-width (deg). Omit to sense with each "
             "sensor's calibrated w; set it to mis-calibrate deliberately.",
    )
    parser.add_argument("--grid", type=int, default=11, help="Grid resolution per axis")
    parser.add_argument("--trials", type=int, default=40, help="Trials per grid point")
    parser.add_argument("--seed", type=int, default=7, help="Random seed for repeatability")
    parser.add_argument("--csv", help="Optional output CSV path for heat map data")
    args = parser.parse_args()

    random.seed(args.seed)
    rows: list[list[str]] | None = [] if args.csv else None

    beam_txt = "calibrated w" if args.beam is None else f"{args.beam:.0f} deg FULL (mis-cal)"
    print(
        f"\n  noise std={args.noise:.0f} mm | dropout {args.dropout:.0f}% | "
        f"sensing beam {beam_txt} | {args.grid}x{args.grid} grid x {args.trials} trials\n"
    )
    print(
        f"  {'layout':8} {'sens':>4} | {'OLD alive':>9} {'OLD med':>8} | "
        f"{'alive':>6} {'2box':>6} {'1box':>6} {'veto':>6} "
        f"{'2box med':>9} {'1box med':>9} {'p90':>7}"
    )
    print("  " + "-" * 100)

    for name, s in LAYOUTS.items():
        res = bench_layout(
            name, s, args.noise, args.dropout, args.beam, args.grid, args.trials, rows
        )
        print(
            f"  {res['name']:8} {res['n']:>4} | {res['legacy_fixrate']:>8.1f}% "
            f"{res['legacy_median']:>6.0f}mm | "
            f"{res['fixrate']:>5.1f}% {res['two_pct']:>5.1f}% {res['one_pct']:>5.1f}% "
            f"{res['veto_pct']:>5.1f}% {res['two_median']:>7.0f}mm {res['one_median']:>7.0f}mm "
            f"{res['p90']:>5.0f}mm"
        )
    print("\n  OLD = legacy grid-search least squares. 2box = closed-form exact fix,")
    print("  1box = polar fallback from a single box's sector (coarse but alive).\n")

    if args.csv and rows is not None:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["layout", "x_m", "y_m", "median_err_mm", "fix_rate_pct"])
            wr.writerows(rows)
        print(f"  Heat map data written to {args.csv}\n")


if __name__ == "__main__":
    main()
