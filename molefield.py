#!/usr/bin/env python3
"""
MOLEFIELD — Ultrasonic Sensor Bridge and Game Host
ENGG3000 SPINE · Full-Body Whack-a-Mole

Coordinates sensor datagrams, beacon synchronization, position solving,
and web client streaming in one clean, zero-dependency process.

Usage:
    python molefield.py                 Hardware mode
    python molefield.py --simulate      Dry-run simulation mode (no hardware)
    python molefield.py --log run1.csv  Record telemetry to CSV for review
"""

from __future__ import annotations

import csv
import os
import signal
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from bridge.cli import DIVIDER_BAR, build_arg_parser, parse_map, status_loop
from bridge.config import LAYOUTS
from bridge.hub import SensorHub
from bridge.networking import simulator_thread, sync_beacon, udp_listener
from bridge.pipeline import pump
from bridge.simulator import Walker
from bridge.websocket_server import WebSocketServer


def main():
    parser = build_arg_parser()
    args = parser.parse_args()

    sensors = LAYOUTS[args.layout]
    box_map = parse_map(args.map, len(sensors))
    stop_event = threading.Event()

    print(DIVIDER_BAR)
    print("  MOLEFIELD  -  Full-Body Whack-a-Mole")
    print(DIVIDER_BAR)
    print(
        f"  layout {args.layout}: {len(sensors)} sensors, "
        f"{len(box_map)} boxes  {box_map}"
    )

    # Resolve game asset root (handles source tree and PyInstaller --onefile bundle)
    here = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    game_dir = os.path.join(here, "game")
    if not os.path.isdir(game_dir):
        sys.exit(f"  Error: Game directory not found at {game_dir}")

    # ── Static HTTP Server ───────────────────────────────────────────────────
    class GameHTTPHandler(SimpleHTTPRequestHandler):
        def __init__(self, *h_args, **h_kwargs):
            super().__init__(*h_args, directory=game_dir, **h_kwargs)

        def log_message(self, *h_args):
            pass  # Suppress routine static asset HTTP access logs

    http_server = ThreadingHTTPServer(("127.0.0.1", args.http), GameHTTPHandler)
    threading.Thread(
        target=http_server.serve_forever, daemon=True, name="http"
    ).start()

    # ── WebSocket Server ─────────────────────────────────────────────────────
    ws_server = WebSocketServer("127.0.0.1", args.ws)
    ws_server.start()
    print(f"  WebSocket server active on ws://localhost:{args.ws}")

    # ── CSV Telemetry Logger ─────────────────────────────────────────────────
    csv_writer = None
    csv_file = None
    if args.log:
        csv_file = open(args.log, "w", newline="", encoding="utf-8")
        csv_writer = csv.writer(csv_file)
        csv_writer.writerow(
            ["t_s"]
            + [f"r{i}_mm" for i in range(len(sensors))]
            + ["x_m", "y_m", "residual_mm", "n_sensors"]
        )
        print(f"  Logging telemetry frames to {args.log}")

    # ── Sensor Hub & Workers ─────────────────────────────────────────────────
    hub = SensorHub(len(sensors), box_map, args.stale_ms)

    if args.simulate:
        walker = Walker(
            sensors=sensors,
            noise=args.noise / 1000.0,
            drop=args.dropout / 100.0,
        )
        threading.Thread(
            target=simulator_thread,
            args=(hub, walker, box_map, args.sync_hz, stop_event),
            daemon=True,
            name="sim",
        ).start()
        print("  SIMULATE: No hardware required. Synthetic body active.")
    else:
        threading.Thread(
            target=udp_listener,
            args=(hub, args.udp, stop_event, print),
            daemon=True,
            name="udp",
        ).start()
        threading.Thread(
            target=sync_beacon,
            args=(args.sync, args.sync_hz, stop_event),
            daemon=True,
            name="sync",
        ).start()
        print(
            f"  Sync beacon broadcasting on UDP :{args.sync} at {args.sync_hz:.1f} Hz"
        )

    # ── Frame Pump ───────────────────────────────────────────────────────────
    threading.Thread(
        target=pump,
        args=(
            hub,
            ws_server,
            sensors,
            args.rate,
            csv_writer,
            stop_event,
            csv_file,
        ),
        daemon=True,
        name="pump",
    ).start()

    # Gracefully treat SIGTERM like KeyboardInterrupt (e.g. when console is closed)
    signal.signal(
        signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt)
    )

    game_url = (
        f"http://localhost:{args.http}/index.html"
        f"?src={'sim' if args.simulate else 'live'}&ws={args.ws}&layout={args.layout}"
    )
    print(DIVIDER_BAR)
    print(f"  GAME CLIENT: {game_url}")
    print(DIVIDER_BAR)

    if not args.no_open:
        webbrowser.open(game_url)

    # ── Terminal Live Status Monitor ─────────────────────────────────────────
    threading.Thread(
        target=status_loop,
        args=(hub, ws_server, sensors, stop_event),
        daemon=True,
        name="status",
    ).start()

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        print("\n  Shutting down MOLEFIELD...")
        if csv_file:
            csv_file.close()
        http_server.shutdown()


if __name__ == "__main__":
    main()
