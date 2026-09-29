"""
Sensor Hub: merges per-box datagrams into one two-sensor frame.

The rig is two boxes in the corners nearest the screen, each reporting ONE
distance (a 50 deg sensor). Boxes send whenever they like, at any rate; the
hub keeps each box's LAST value until that box sends again, and stamps every
value with an update counter (`seq`) and its age so a held value is never
mistaken for a new reading downstream.

A packet carrying two values (the older two-transducer firmware) is collapsed
to one reading: the nearer echo, since whichever transducer sees the player
reads closer than one seeing the room behind.
"""

from __future__ import annotations

import threading
import time

from bridge.config import LIVE_LAYOUT

N_BOXES = 2


class SensorHub:
    """Thread-safe merge of per-box datagrams."""

    def __init__(self, stale_ms: int = 0, alive_s: float = 10.0):
        self.stale = stale_ms / 1000.0          # 0 -> hold forever
        self.alive_s = alive_s
        self.lock = threading.Lock()
        self.changed = threading.Event()        # set on every accepted packet
        self.frames = 0
        self.bad = 0
        self.boxes: dict[int, dict] = {}        # health bookkeeping
        self.ranges: list[float | None] = [None] * N_BOXES
        self.seq: list[int] = [0] * N_BOXES
        self.stamp: list[float] = [0.0] * N_BOXES

    @property
    def layout(self) -> str:
        return LIVE_LAYOUT

    @property
    def n_sensors(self) -> int:
        return N_BOXES

    @staticmethod
    def normalise_box(box: int, one_based: bool | None) -> int | None:
        """0/1 from JSON and the '<box>: <value>' format; 1/2 from legacy 'Box:N' text."""
        idx = box - 1 if one_based else box
        return idx if 0 <= idx < N_BOXES else None

    def ingest(self, box: int, ranges_mm: list, sender: str = "", one_based: bool | None = None) -> bool:
        """
        Record one packet. `ranges_mm` holds one reading in millimetres (None or
        <= 0 = no echo); a two-reading list is collapsed to the nearer echo.
        Returns False if the packet was rejected.
        """
        now = time.monotonic()
        b = self.normalise_box(int(box), one_based)
        if b is None or not isinstance(ranges_mm, list) or len(ranges_mm) not in (1, 2):
            self.bad += 1
            return False
        vals: list[float] = []
        for mm in ranges_mm:
            try:
                f = None if mm is None else float(mm)
            except (TypeError, ValueError):
                self.bad += 1
                return False
            if f is not None and f == f and f > 0:
                vals.append(f / 1000.0)
        v = min(vals) if vals else None

        with self.lock:
            self.ranges[b] = v
            self.seq[b] += 1
            self.stamp[b] = now
            h = self.boxes.setdefault(b, dict(count=0, last=0.0, hz=0.0, _t0=now, _c0=0,
                                             addr=sender, values=len(ranges_mm)))
            h["count"] += 1
            h["last"] = now
            h["values"] = len(ranges_mm)
            h["addr"] = sender or h["addr"]
            if now - h["_t0"] >= 1.0:
                h["hz"] = (h["count"] - h["_c0"]) / (now - h["_t0"])
                h["_t0"], h["_c0"] = now, h["count"]
            self.frames += 1
        self.changed.set()
        return True

    def snapshot(self) -> dict:
        """Current frame: held ranges (m), per-sensor update counters and ages."""
        now = time.monotonic()
        with self.lock:
            ranges = list(self.ranges)
            if self.stale > 0:
                ranges = [r if (r is not None and now - t <= self.stale) else None
                          for r, t in zip(ranges, self.stamp)]
            return {
                "layout": self.layout,
                "values_per_box": 1,
                "ranges": ranges,
                "seq": list(self.seq),
                "age_ms": [None if t == 0 else round((now - t) * 1000.0) for t in self.stamp],
            }

    def live_boxes(self) -> list[tuple[int, dict]]:
        now = time.monotonic()
        with self.lock:
            return sorted((b, dict(v, alive=(now - v["last"]) < self.alive_s))
                          for b, v in self.boxes.items())

    def health(self) -> list[dict]:
        """Per-box health for the setup wizard and telemetry."""
        now = time.monotonic()
        return [
            {"box": b, "alive": v["alive"], "hz": round(v["hz"], 1), "addr": v["addr"],
             "values": v["values"], "age_ms": round((now - v["last"]) * 1000.0)}
            for b, v in self.live_boxes()
        ]
