"""
Command-Line Interface: Argument parsing, box mapping utilities, and live terminal status monitor.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from bridge.config import DEFAULTS, LAYOUT_NAMES, LAYOUTS, MAX_PLAYER_RANGE
from bridge.hub import SensorHub
from bridge.sectors import solve_sectors
from bridge.websocket_server import WebSocketServer

DIVIDER_BAR: str = "-" * 62


def status_loop(
    hub: SensorHub,
    ws: WebSocketServer,
    stop: threading.Event,
):
    """
    Renders a live, single-line telemetry status update in the terminal.
    """
    time.sleep(1.0)
    held: dict[int, float] = {}
    while not stop.is_set():
        snap = hub.snapshot()
        r = snap["ranges"]
        n = sum(1 for v in r if v is not None)
        # Out of range means "nothing found": keep the last real value, as the game does.
        for i, v in enumerate(r):
            if v is not None and v <= MAX_PLAYER_RANGE:
                held[i] = v
        fix = solve_sectors([held[i] if (v is not None and v > MAX_PLAYER_RANGE) else v for i, v in enumerate(r)],
                            LAYOUTS[snap["layout"]])

        names = LAYOUT_NAMES.get(snap["layout"], [str(i) for i in range(len(r))])
        cells = " ".join(
            f"{names[i]}:{'----' if v is None else ('edge' if v > MAX_PLAYER_RANGE else f'{v * 1000.0:4.0f}')}"
            + ("" if snap["age_ms"][i] is None or snap["age_ms"][i] < 1000 else f"({snap['age_ms'][i] / 1000:.0f}s)")
            for i, v in enumerate(r)
        )
        if fix["x"] is None:
            pos = "no fix"
        else:
            tag = {"two-box": "2BOX", "one-box": "1BOX"}.get(fix["mode"], fix["mode"])
            flag = " VETO" if fix["veto"] else ""
            pos = (
                f"{tag} x={fix['x']:.2f} y={fix['y']:.2f} "
                f"+-{fix['sigma'] * 1000.0:3.0f}mm{flag}"
            )
        mode = "2x50deg"
        boxes = " ".join(
            f"box{b + 1}:{v['hz']:4.1f}Hz{'' if v['alive'] else ' OFF'}"
            for b, v in hub.live_boxes()
        ) or "no boxes reporting"

        sys.stdout.write(
            f"\r  {mode} | {n}/{len(r)} echoes | {cells} | {pos} | {boxes} | "
            f"games:{ws.count}   "
        )
        sys.stdout.flush()
        time.sleep(0.25)


def build_arg_parser() -> argparse.ArgumentParser:
    """
    Constructs the CLI argument parser for MOLEFIELD.
    """
    d = DEFAULTS
    parser = argparse.ArgumentParser(
        description="MOLEFIELD — Ultrasonic sensor bridge and game host",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--units",
        choices=("cm", "mm"),
        default=d["units"],
        help="unit of the bare number in a '<box>: <value>' datagram",
    )
    parser.add_argument(
        "--replay",
        metavar="FILE",
        default="",
        help="replay a logs/udp-*.log capture instead of listening for boxes",
    )
    parser.add_argument(
        "--replay-speed",
        type=float,
        default=1.0,
        help="replay speed multiplier",
    )
    parser.add_argument("--http", type=int, default=d["http"], help="HTTP port")
    parser.add_argument("--ws", type=int, default=d["ws"], help="WebSocket port")
    parser.add_argument("--udp", type=int, default=d["udp"], help="UDP range port")
    parser.add_argument("--sync", type=int, default=d["sync"], help="UDP beacon port")
    parser.add_argument(
        "--sync-hz",
        type=float,
        default=d["sync_hz"],
        help="ping cycles per second across all sensors",
    )
    parser.add_argument(
        "--rate",
        type=float,
        default=d["rate"],
        help="frames per second pushed to the game",
    )
    parser.add_argument(
        "--stale-ms",
        type=int,
        default=d["stale_ms"],
        help="expire a sensor's value after this long without an update (ms); "
             "0 holds each sensor's last value indefinitely",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="synthesise a walking body instead of reading hardware",
    )
    parser.add_argument(
        "--sim-timing",
        choices=("regular", "irregular"),
        default="regular",
        help="simulated upstream timing: fixed rate, or one fast jittery box and one random box",
    )
    parser.add_argument(
        "--noise",
        type=float,
        default=8.0,
        help="sim range noise, mm",
    )
    parser.add_argument(
        "--dropout",
        type=float,
        default=3.0,
        help="sim missing echoes, %%",
    )
    parser.add_argument(
        "--log",
        metavar="FILE",
        help="write every frame to CSV",
    )
    parser.add_argument(
        "--db",
        metavar="FILE",
        default="",
        help="telemetry database for logs.html; empty means logs/molefield.db",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="do not open a browser automatically",
    )
    return parser
