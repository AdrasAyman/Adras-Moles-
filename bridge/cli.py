"""
Command-Line Interface: Argument parsing, box mapping utilities, and live terminal status monitor.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from typing import Sequence
from bridge.config import DEFAULTS, LAYOUTS
from bridge.hub import SensorHub
from bridge.solver import solve
from bridge.websocket_server import WebSocketServer

DIVIDER_BAR: str = "-" * 62


def parse_map(spec: str, n_sensors: int) -> dict[int, list[int]]:
    """
    Parses a box-to-sensor map string into a dictionary.
    Example:
        '0:0,1 1:2,3' -> {0: [0, 1], 1: [2, 3]}
    """
    if not spec:
        per_box = 2
        return {
            b: [b * per_box + i for i in range(per_box)]
            for b in range((n_sensors + per_box - 1) // per_box)
        }

    out: dict[int, list[int]] = {}
    for part in spec.split():
        box_str, idxs_str = part.split(":")
        out[int(box_str)] = [int(i) for i in idxs_str.split(",")]
    return out


def status_loop(
    hub: SensorHub,
    ws: WebSocketServer,
    sensors: Sequence[tuple[float, float, float]],
    stop: threading.Event,
):
    """
    Renders a live, single-line telemetry status update in the terminal.
    """
    time.sleep(1.0)
    while not stop.is_set():
        r = hub.snapshot()
        n = sum(1 for v in r if v is not None)
        fix = solve(r, sensors)

        cells = " ".join(
            f"{i}:{'----' if v is None else f'{v * 1000.0:4.0f}'}"
            for i, v in enumerate(r)
        )
        pos = (
            f"x={fix[0]:.2f} y={fix[1]:.2f} res={fix[2] * 1000.0:3.0f}mm"
            if fix
            else "no fix"
        )
        boxes = " ".join(
            f"box{b}:{v['hz']:4.1f}Hz{'' if v['alive'] else ' DEAD'}"
            for b, v in hub.live_boxes()
        ) or "no boxes reporting"

        sys.stdout.write(
            f"\r  {n}/{len(r)} echoes | {cells} | {pos} | {boxes} | "
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
        "--layout",
        choices=list(LAYOUTS.keys()),
        default="4lin",
        help="sensor geometry; must match the game sidebar",
    )
    parser.add_argument(
        "--map",
        default="",
        help='box to sensor-index map, e.g. "0:0,1 1:2,3"',
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
        help="drop a sensor's range if it is older than this (ms)",
    )
    parser.add_argument(
        "--simulate",
        action="store_true",
        help="synthesise a walking body instead of reading hardware",
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
        "--no-open",
        action="store_true",
        help="do not open a browser automatically",
    )
    return parser
