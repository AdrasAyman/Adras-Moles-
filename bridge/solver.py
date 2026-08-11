"""
Multilateration Solver: Estimates 2D body coordinates from ultrasonic range measurements
using a two-phase optimizer (coarse grid search + gradient descent refinement).
"""

from __future__ import annotations

import math
from typing import Sequence
from bridge.config import AREA_W, AREA_FAR, BODY_R


def solve(
    ranges_m: Sequence[float | None],
    sensors: Sequence[tuple[float, float, float]],
) -> tuple[float, float, float, int] | None:
    """
    Solves for the player's (x, y) position from sensor range observations.

    Args:
        ranges_m: Distance readings to the body surface in metres (None for no echo).
        sensors: List of sensor tuples (x, y, angle_deg).

    Returns:
        A tuple of (x_m, y_m, residual_m, active_sensor_count), or None if fewer
        than 2 sensors returned an echo.
    """
    obs = [
        (sensors[i], r + BODY_R)
        for i, r in enumerate(ranges_m)
        if r is not None
    ]
    if len(obs) < 2:
        return None

    def cost(x: float, y: float) -> float:
        return sum((math.hypot(x - s[0], y - s[1]) - d) ** 2 for s, d in obs)

    # Phase 1: Coarse 2D Grid Search to avoid local minima
    bx, by, bc = AREA_W / 2.0, 1.2, float("inf")
    grid_res = 26
    for i in range(grid_res + 1):
        for j in range(grid_res + 1):
            x = (i / grid_res) * AREA_W
            y = 0.2 + (j / grid_res) * (AREA_FAR - 0.2)
            c = cost(x, y)
            if c < bc:
                bc, bx, by = c, x, y

    # Phase 2: Gradient Descent Refinement
    x, y, step = bx, by, 0.06
    for _ in range(60):
        gx = gy = 0.0
        for s, d in obs:
            dx, dy = x - s[0], y - s[1]
            dist = math.hypot(dx, dy) or 1e-6
            e = dist - d
            gx += 2.0 * e * dx / dist
            gy += 2.0 * e * dy / dist
        x -= step * gx
        y -= step * gy
        x = min(max(x, -0.3), AREA_W + 0.3)
        y = min(max(y, 0.05), AREA_FAR + 0.3)
        step *= 0.97

    residual_rms = math.sqrt(cost(x, y) / len(obs))
    return x, y, residual_rms, len(obs)
