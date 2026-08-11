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
from bridge.simulator import Walker
from bridge.solver import solve


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
    walker = Walker(sensors, noise / 1000.0, drop / 100.0, beam)
    errs: list[float] = []
    nofix = 0
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

                fix = solve(r, sensors)
                if fix is None:
                    nofix += 1
                    continue

                e = math.hypot(fix[0] - tx, fix[1] - ty)
                errs.append(e)
                cell_errs.append(e)

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

    return {
        "name": name,
        "n": len(sensors),
        "fixrate": 100.0 * (1.0 - nofix / total),
        "mean_sensors": statistics.mean(nsens) if nsens else 0.0,
        "median": percentile(0.50),
        "p90": percentile(0.90),
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
    parser.add_argument("--beam", type=float, default=30.0, help="Beam half-angle (deg)")
    parser.add_argument("--grid", type=int, default=11, help="Grid resolution per axis")
    parser.add_argument("--trials", type=int, default=40, help="Trials per grid point")
    parser.add_argument("--seed", type=int, default=7, help="Random seed for repeatability")
    parser.add_argument("--csv", help="Optional output CSV path for heat map data")
    args = parser.parse_args()

    random.seed(args.seed)
    rows: list[list[str]] | None = [] if args.csv else None

    print(
        f"\n  noise std={args.noise:.0f} mm | dropout {args.dropout:.0f}% | "
        f"beam +- {args.beam:.0f} deg | {args.grid}x{args.grid} grid x {args.trials} trials\n"
    )
    print(
        f"  {'layout':8} {'sens':>4} {'fix rate':>9} {'echoes':>7} "
        f"{'median':>8} {'p90':>8} {'worst cell':>11}"
    )
    print("  " + "-" * 62)

    for name, s in LAYOUTS.items():
        res = bench_layout(
            name, s, args.noise, args.dropout, args.beam, args.grid, args.trials, rows
        )
        print(
            f"  {res['name']:8} {res['n']:>4} {res['fixrate']:>8.1f}% "
            f"{res['mean_sensors']:>7.2f} {res['median']:>7.0f}mm {res['p90']:>7.0f}mm "
            f"{res['worst']:>8.0f}mm @({res['worst_at'][0]:.2f},{res['worst_at'][1]:.2f})"
        )
    print()

    if args.csv and rows is not None:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["layout", "x_m", "y_m", "median_err_mm", "fix_rate_pct"])
            wr.writerows(rows)
        print(f"  Heat map data written to {args.csv}\n")


if __name__ == "__main__":
    main()
