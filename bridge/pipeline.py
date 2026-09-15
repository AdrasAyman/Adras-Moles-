"""
Data Pipeline: streams sensor frames to the game over WebSocket, and records
telemetry to CSV for engineering analysis (--log).

Frames are pushed as soon as any box sends a packet (with a periodic refresh
for health), because boxes now upstream at their own discretion rather than on
a fixed slot schedule.
"""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any, TextIO

from bridge.config import LAYOUTS, SOLVER
from bridge.hub import SensorHub
from bridge.sectors import MedianRing, solve_sectors
from bridge.websocket_server import WebSocketServer

MAX_SENSORS = 4


def pump(
    hub: SensorHub,
    ws: WebSocketServer,
    rate: float,
    writer: Any,
    stop: threading.Event,
    logfile: TextIO | None = None,
):
    """
    Broadcast a frame whenever the hub changes, and at least every 1/`rate` s.

    Frame: {t, layout, values_per_box, detected, mixed, ranges (mm), seq, age_ms,
            boxes (health), hub (packet counters)}
    `seq[i]` increments each time sensor i sends a new reading, so clients can
    tell new readings from held ones.
    """
    period = 1.0 / rate
    t0 = time.monotonic()
    last_flush = t0

    layout = None
    rings: list[MedianRing] = []
    last_seq: list[int] = []
    prev_fix: dict | None = None

    while not stop.is_set():
        hub.changed.wait(period)
        hub.changed.clear()
        snap = hub.snapshot()
        r = snap["ranges"]

        frame_payload = {
            "t": int((time.monotonic() - t0) * 1000),
            "layout": snap["layout"],
            "values_per_box": snap["values_per_box"],
            "detected": snap["detected"],
            "mixed": snap["mixed"],
            "ranges": [None if v is None else round(v * 1000) for v in r],
            "seq": snap["seq"],
            "age_ms": snap["age_ms"],
            "boxes": hub.health(),
            "hub": {"frames": hub.frames, "bad": hub.bad, "switches": hub.switches},
        }
        ws.broadcast(json.dumps(frame_payload))

        if writer:
            now = time.monotonic()
            if snap["layout"] != layout:
                layout = snap["layout"]
                rings = [MedianRing(int(SOLVER["median_window"])) for _ in r]
                last_seq = [0] * len(r)
                prev_fix = None
            fresh = False
            for i, ring in enumerate(rings):
                if snap["seq"][i] != last_seq[i]:
                    last_seq[i] = snap["seq"][i]
                    ring.push(r[i], now)
                    fresh = True
            if not fresh:
                continue
            max_age = SOLVER["median_max_age_ms"] / 1000.0
            med = [ring.value(now, max_age) for ring in rings]
            sensors = LAYOUTS[layout]
            fix = solve_sectors(med, sensors, prev_fix)
            if fix["x"] is not None:
                prev_fix = {"x": fix["x"], "y": fix["y"]}

            pad = lambda vals: (vals + [None] * MAX_SENSORS)[:MAX_SENSORS]
            mm = lambda v: "" if v is None else round(v * 1000)
            ages = pad(list(snap["age_ms"]))
            fix_cols = [
                "" if fix["x"] is None else f"{fix['x']:.4f}",
                "" if fix["y"] is None else f"{fix['y']:.4f}",
                fix["mode"],
                "" if not math.isfinite(fix["sigma"]) else f"{fix['sigma'] * 1000.0:.0f}",
                f"{fix['gap'] * 1000.0:.0f}",
                f"{fix['spread'] * 1000.0:.0f}",
                f"{fix['worst_miss']:.1f}",
                f"{fix['residual'] * 1000.0:.1f}",
                1 if fix["veto"] else 0,
                sum(1 for v in med if v is not None),
                fix["reason"],
            ]
            writer.writerow([f"{now - t0:.3f}", layout]
                            + [mm(v) for v in pad(r)] + [mm(v) for v in pad(med)]
                            + ["" if a is None else a for a in ages] + fix_cols)

            if logfile and (now - last_flush > 1.0):
                logfile.flush()
                last_flush = now
