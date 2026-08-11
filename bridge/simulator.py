"""
Simulation Model: Generates synthetic walking body kinematics and models ultrasonic
beam physics (angular aperture, distance falloff, Gaussian noise, and echo dropout).
"""

from __future__ import annotations

import math
import random
from typing import Sequence
from bridge.config import AREA_W, AREA_NEAR, AREA_FAR, BODY_R


class Walker:
    """
    Simulates a human body moving smoothly within the active play area.
    """

    def __init__(
        self,
        sensors: Sequence[tuple[float, float, float]],
        noise: float = 0.008,
        drop: float = 0.03,
        beam: float = 30.0,
    ):
        self.sensors = sensors
        self.noise = noise
        self.drop = drop
        self.beam = math.radians(beam)
        self.t = 0.0

    def truth(self, dt: float) -> tuple[float, float]:
        """
        Advances the simulated player trajectory by `dt` seconds and returns (x, y).
        """
        self.t += dt
        x = AREA_W * (0.5 + 0.42 * math.sin(self.t * 0.7))
        y = AREA_NEAR + (AREA_FAR - AREA_NEAR) * (
            0.5 + 0.38 * math.sin(self.t * 0.43 + 1.1)
        )
        return x, y

    def ranges_mm(self, x: float, y: float) -> list[int | None]:
        """
        Computes simulated ultrasonic distances from each sensor to the body surface.
        Returns readings in millimetres (None for no echo / dropped packet).
        """
        out: list[int | None] = []
        for sx, sy, ang in self.sensors:
            dx, dy = x - sx, y - sy
            d = math.hypot(dx, dy)
            bearing = math.atan2(dx, dy)

            # Check if player is outside the sensor's angular cone or maximum range
            if abs(bearing - math.radians(ang)) > self.beam or d > 4.0:
                out.append(None)
            elif random.random() < self.drop:
                out.append(None)
            else:
                surface_dist = max(0.02, d - BODY_R + random.gauss(0, self.noise))
                out.append(round(surface_dist * 1000.0))
        return out
