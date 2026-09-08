"""
Simulation Model: Generates synthetic walking body kinematics and models ultrasonic
beam physics (angular aperture, distance falloff, Gaussian noise, and echo dropout).
"""

from __future__ import annotations

import math
import random
from typing import Sequence
from bridge.config import AREA_W, AREA_NEAR, AREA_FAR, BODY_R, BEAM_DEFAULT_W, BEAM_MAX_RANGE


class Walker:
    """
    Simulates a human body moving smoothly within the active play area.
    """

    def __init__(
        self,
        sensors: Sequence[tuple[float, float, float]],
        noise: float = 0.008,
        drop: float = 0.03,
        beam: float | None = None,
    ):
        """
        `beam` overrides every sensor's FULL cone width, in degrees — the same
        units as the layout's `w` and as Sim.beamOverride in the browser. Leave
        it None to sense with each sensor's own calibrated width, which is what
        the solver assumes. Setting it simulates a MIS-CALIBRATED rig: sense at
        one width, solve at another.
        """
        self.sensors = sensors
        self.noise = noise
        self.drop = drop
        self.beam_override = None if beam is None else math.radians(beam / 2.0)
        self.t = 0.0

    def _half(self, sensor: Sequence[float]) -> float:
        """Half beam width in radians for one sensor."""
        if self.beam_override is not None:
            return self.beam_override
        full = sensor[3] if len(sensor) > 3 else BEAM_DEFAULT_W
        return math.radians(full / 2.0)

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
        for sensor in self.sensors:
            sx, sy, ang = sensor[0], sensor[1], sensor[2]
            dx, dy = x - sx, y - sy
            d = math.hypot(dx, dy)
            bearing = math.atan2(dx, dy)

            # Check if player is outside the sensor's angular cone or maximum range
            if abs(bearing - math.radians(ang)) > self._half(sensor) or d - BODY_R > BEAM_MAX_RANGE:
                out.append(None)
            elif random.random() < self.drop:
                out.append(None)
            else:
                surface_dist = max(0.02, d - BODY_R + random.gauss(0, self.noise))
                out.append(round(surface_dist * 1000.0))
        return out
