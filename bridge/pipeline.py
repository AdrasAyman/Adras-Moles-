"""
Data Pipeline: Pushes merged range frames to connected game clients at a fixed frame rate
and records synchronized telemetry to CSV for engineering analysis and design reviews.
"""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any, Sequence, TextIO
from bridge.config import SOLVER
from bridge.hub import SensorHub
from bridge.sectors import MedianRing, solve_sectors
from bridge.websocket_server import WebSocketServer


def pump(
    hub: SensorHub,
    ws: WebSocketServer,
    sensors: Sequence[tuple[float, float, float]],
    rate: float,
    writer: Any,
    stop: threading.Event,
    logfile: TextIO | None = None,
):
    """
    Main frame pump running at `rate` FPS.
    Snapshots the latest sensor ranges, streams JSON over WebSocket,
    and optionally logs positions to CSV.
    """
    period = 1.0 / rate
    nxt = time.monotonic()
    t0 = time.monotonic()
    last_flush = t0

    # Median rings mirror the browser's filter so the CSV matches what the
    # game actually solved from. Only genuinely new range vectors are pushed:
    # this pump runs faster than the sensors ping, so most frames are repeats.
    rings = [MedianRing(int(SOLVER["median_window"])) for _ in sensors]
    last_key: tuple | None = None
    prev_fix: dict | None = None

    while not stop.is_set():
        r = hub.snapshot()

        # Broadcast frame to WebSocket clients, including per-box health so the
        # site's setup wizard can show which sensor boxes are actually reporting.
        frame_payload = {
            "t": int((time.monotonic() - t0) * 1000),
            "ranges": [None if v is None else round(v * 1000) for v in r],
            "boxes": hub.health(),
        }
        ws.broadcast(json.dumps(frame_payload))

        # Optional CSV logging with offline position solution
        if writer:
            key = tuple(None if v is None else round(v * 1000) for v in r)
            if key != last_key:
                last_key = key
                for i, ring in enumerate(rings):
                    ring.push(r[i] if i < len(r) else None)
            med = [ring.value() for ring in rings]

            fix = solve_sectors(med, sensors, prev_fix)
            if fix["x"] is not None:
                prev_fix = {"x": fix["x"], "y": fix["y"]}

            elapsed_str = f"{time.monotonic() - t0:.3f}"
            raw_cols = ["" if v is None else round(v * 1000) for v in r]
            med_cols = ["" if v is None else round(v * 1000) for v in med]

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
            writer.writerow([elapsed_str] + raw_cols + med_cols + fix_cols)

            if logfile and (time.monotonic() - last_flush > 1.0):
                logfile.flush()
                last_flush = time.monotonic()

        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))
