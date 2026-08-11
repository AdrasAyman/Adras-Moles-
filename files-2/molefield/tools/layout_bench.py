#!/usr/bin/env python3
"""
Layout bench — how well does each sensor arrangement actually cover the area?

Sweeps a grid of true body positions across the play area, simulates the
ultrasonic ranges many times at each point, solves for position, and reports
coverage and error. Use it to justify your layout choice with numbers instead
of a hunch, and to show the V1-to-V2 improvement in your change register.

    python tools/layout_bench.py
    python tools/layout_bench.py --noise 20 --beam 45 --trials 60
    python tools/layout_bench.py --grid 15 --csv bench.csv
"""
import argparse
import csv
import math
import os
import random
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from molefield import LAYOUTS, AREA_W, AREA_NEAR, AREA_FAR, BODY_R, Walker, solve  # noqa: E402


def bench(name, sensors, noise, drop, beam, grid, trials, rows=None):
    w = Walker(sensors, noise / 1000, drop / 100, beam)
    errs, nofix, total, nsens = [], 0, 0, []
    worst = (0.0, None)
    for gi in range(grid):
        for gj in range(grid):
            tx = 0.12 + (gi / (grid - 1)) * (AREA_W - 0.24)
            ty = AREA_NEAR + 0.1 + (gj / (grid - 1)) * (AREA_FAR - AREA_NEAR - 0.2)
            cell = []
            for _ in range(trials):
                total += 1
                mm = w.ranges_mm(tx, ty)
                r = [None if v is None else v / 1000 for v in mm]
                nsens.append(sum(1 for v in r if v is not None))
                fix = solve(r, sensors)
                if fix is None:
                    nofix += 1
                    continue
                e = math.hypot(fix[0] - tx, fix[1] - ty)
                errs.append(e)
                cell.append(e)
            if cell:
                med = statistics.median(cell)
                if med > worst[0]:
                    worst = (med, (tx, ty))
                if rows is not None:
                    rows.append([name, f"{tx:.3f}", f"{ty:.3f}", f"{med * 1000:.1f}",
                                 f"{100 * sum(1 for _ in cell) / trials:.0f}"])
    errs.sort()
    p = lambda q: errs[min(len(errs) - 1, int(q * len(errs)))] * 1000 if errs else float("nan")
    return dict(name=name, n=len(sensors), fixrate=100 * (1 - nofix / total),
                mean_sensors=statistics.mean(nsens), median=p(.5), p90=p(.9),
                worst=worst[0] * 1000, worst_at=worst[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--noise", type=float, default=8.0, help="range noise σ, mm")
    ap.add_argument("--dropout", type=float, default=3.0, help="missing echoes, %%")
    ap.add_argument("--beam", type=float, default=30.0, help="beam half-angle, deg")
    ap.add_argument("--grid", type=int, default=11)
    ap.add_argument("--trials", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--csv", help="write the per-cell heat map here")
    a = ap.parse_args()
    random.seed(a.seed)

    rows = [] if a.csv else None
    print(f"\n  noise σ={a.noise:.0f} mm · dropout {a.dropout:.0f}% · "
          f"beam ±{a.beam:.0f}° · {a.grid}×{a.grid} grid × {a.trials} trials\n")
    print(f"  {'layout':8} {'sens':>4} {'fix rate':>9} {'echoes':>7} "
          f"{'median':>8} {'p90':>8} {'worst cell':>11}")
    print("  " + "─" * 62)
    for name, s in LAYOUTS.items():
        r = bench(name, s, a.noise, a.dropout, a.beam, a.grid, a.trials, rows)
        print(f"  {r['name']:8} {r['n']:>4} {r['fixrate']:>8.1f}% "
              f"{r['mean_sensors']:>7.2f} {r['median']:>7.0f}mm {r['p90']:>7.0f}mm "
              f"{r['worst']:>8.0f}mm @({r['worst_at'][0]:.2f},{r['worst_at'][1]:.2f})")
    print()
    if a.csv:
        with open(a.csv, "w", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["layout", "x_m", "y_m", "median_err_mm", "fix_rate_pct"])
            wr.writerows(rows)
        print(f"  heat map written to {a.csv}\n")


if __name__ == "__main__":
    main()
