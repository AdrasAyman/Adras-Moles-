"""
Sensor Hub: Aggregates incoming UDP range frames from multiple ESP32 boxes
into a synchronized global sensor frame with staleness timeout tracking.
"""

from __future__ import annotations

import threading
import time


class SensorHub:
    """
    Thread-safe buffer merging per-box datagrams into a unified global sensor frame.
    """

    def __init__(self, n_sensors: int, box_map: dict[int, list[int]], stale_ms: int):
        self.n = n_sensors
        self.map = box_map
        self.stale = stale_ms / 1000.0
        self.ranges: list[float | None] = [None] * n_sensors
        self.stamp: list[float] = [0.0] * n_sensors
        self.boxes: dict[int, dict] = {}
        self.lock = threading.Lock()
        self.frames = 0
        self.bad = 0

    def ingest(self, box: int, ranges_mm: list[int | float | None], sender: str = ""):
        """
        Record a range frame from an ESP32 sensor box.
        `ranges_mm` contains readings in millimetres (None = no echo).
        """
        now = time.monotonic()
        idx = self.map.get(box)
        if idx is None:
            self.bad += 1
            return

        with self.lock:
            for i, mm in enumerate(ranges_mm):
                if i >= len(idx):
                    break
                g = idx[i]
                if g >= self.n:
                    continue
                self.ranges[g] = None if mm is None else float(mm) / 1000.0
                self.stamp[g] = now

            b = self.boxes.setdefault(
                box,
                dict(count=0, last=0.0, hz=0.0, _t0=now, _c0=0, addr=sender),
            )
            b["count"] += 1
            b["last"] = now
            b["addr"] = sender or b["addr"]
            if now - b["_t0"] >= 1.0:
                b["hz"] = (b["count"] - b["_c0"]) / (now - b["_t0"])
                b["_t0"], b["_c0"] = now, b["count"]
            self.frames += 1

    def snapshot(self) -> list[float | None]:
        """
        Returns current sensor ranges in metres.
        Any reading older than `stale` seconds is cleared to None.
        """
        now = time.monotonic()
        with self.lock:
            return [
                r if (r is not None and now - t <= self.stale) else None
                for r, t in zip(self.ranges, self.stamp)
            ]

    def live_boxes(self) -> list[tuple[int, dict]]:
        """
        Returns active sensor boxes with their packet rates and health status.
        """
        now = time.monotonic()
        with self.lock:
            return sorted(
                (b, dict(v, alive=(now - v["last"]) < 1.0))
                for b, v in self.boxes.items()
            )

    def health(self) -> list[dict]:
        """
        Returns a JSON-serializable per-box health summary (id, alive, packet
        rate, sender address, time since last packet) for setup/status UIs.
        """
        now = time.monotonic()
        return [
            {
                "box": b,
                "alive": v["alive"],
                "hz": round(v["hz"], 1),
                "addr": v["addr"],
                "age_ms": round((now - v["last"]) * 1000.0),
            }
            for b, v in self.live_boxes()
        ]
