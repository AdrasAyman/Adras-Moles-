"""
Data Pipeline: Pushes merged range frames to connected game clients at a fixed frame rate
and records synchronized telemetry to CSV for engineering analysis and design reviews.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Sequence, TextIO
from bridge.hub import SensorHub
from bridge.solver import solve
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
            fix = solve(r, sensors)
            elapsed_str = f"{time.monotonic() - t0:.3f}"
            range_cols = ["" if v is None else round(v * 1000) for v in r]

            if fix:
                fix_cols = [
                    f"{fix[0]:.4f}",
                    f"{fix[1]:.4f}",
                    f"{fix[2] * 1000.0:.1f}",
                    fix[3],
                ]
            else:
                fix_cols = ["", "", "", 0]

            writer.writerow([elapsed_str] + range_cols + fix_cols)

            if logfile and (time.monotonic() - last_flush > 1.0):
                logfile.flush()
                last_flush = time.monotonic()

        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))
