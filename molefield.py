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

from bridge.cli import DIVIDER_BAR, build_arg_parser, status_loop
from bridge.config import DEFAULTS, LAYOUTS, LIVE_LAYOUT
from bridge.hub import SensorHub
from bridge.networking import replay_thread, simulator_thread, sync_beacon, udp_listener
from bridge.pipeline import pump
from bridge.telemetry_api import TelemetryAPI
from bridge.telemetry_db import TelemetryStore, default_db_path
from bridge.simulator import Walker
from bridge.websocket_server import WebSocketServer


def main():
    parser = build_arg_parser()
    args = parser.parse_args()

    stop_event = threading.Event()
    start_layout = LIVE_LAYOUT

    print(DIVIDER_BAR)
    print("  MOLEFIELD  -  Full-Body Whack-a-Mole")
    print(DIVIDER_BAR)
    print(
        "  sensors: two boxes, one 50 deg sensor each; "
        + ("values held until each box sends again" if args.stale_ms == 0
           else f"values expire after {args.stale_ms} ms")
    )

    # Resolve game asset root (handles source tree and PyInstaller --onefile bundle)
    here = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    game_dir = os.path.join(here, "game")
    if not os.path.isdir(game_dir):
        sys.exit(f"  Error: Game directory not found at {game_dir}")

    # ── Telemetry store (session logs for logs.html) ─────────────────────────
    db_path = args.db or default_db_path(os.path.dirname(os.path.abspath(__file__)))
    store = TelemetryStore(db_path)
    api = TelemetryAPI(store)
    threading.Thread(
        target=api.reap_forever, args=(stop_event,), daemon=True, name="telemetry-reaper"
    ).start()
    print(f"  Telemetry database: {db_path}")

    # ── Static HTTP Server + /api/ ───────────────────────────────────────────
    class GameHTTPHandler(SimpleHTTPRequestHandler):
        def __init__(self, *h_args, **h_kwargs):
            super().__init__(*h_args, directory=game_dir, **h_kwargs)

        def do_GET(self):
            if not api.handle(self):
                super().do_GET()

        def do_HEAD(self):
            if not api.handle(self):
                super().do_HEAD()

        def do_POST(self):
            if not api.handle(self):
                self.send_error(404)

        def do_DELETE(self):
            if not api.handle(self):
                self.send_error(404)

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
            ["t_s", "layout"]
            + [f"raw{i}_mm" for i in range(4)]
            + [f"med{i}_mm" for i in range(4)]
            + [f"age{i}_ms" for i in range(4)]
            + [
                "x_m", "y_m", "mode", "sigma_mm", "gap_mm", "spread_mm",
                "sector_miss_deg", "residual_mm", "veto", "n_sensors", "reason",
            ]
        )
        print(f"  Logging telemetry frames to {args.log}")

    # ── Sensor Hub & Workers ─────────────────────────────────────────────────
    hub = SensorHub(args.stale_ms, DEFAULTS["alive_s"])
    capture_file = None

    if args.replay:
        threading.Thread(
            target=replay_thread,
            args=(hub, args.replay, args.units, stop_event, args.replay_speed),
            daemon=True,
            name="replay",
        ).start()
        print(f"  REPLAY: feeding {args.replay} at {args.replay_speed:g}x")
    elif args.simulate:
        walker = Walker(
            sensors=LAYOUTS[start_layout],
            noise=args.noise / 1000.0,
            drop=args.dropout / 100.0,
        )
        threading.Thread(
            target=simulator_thread,
            args=(hub, walker, 1, args.sync_hz, args.sim_timing, stop_event),
            daemon=True,
            name="sim",
        ).start()
        print(f"  SIMULATE: synthetic body, one value per box, {args.sim_timing} timing.")
    else:
        # Every raw datagram is kept so a live test can be sent back and replayed.
        cap_dir = os.path.join(os.path.dirname(db_path), "")
        os.makedirs(cap_dir, exist_ok=True)
        cap_path = os.path.join(cap_dir, time.strftime("udp-%Y%m%d-%H%M%S.log"))
        capture_file = open(cap_path, "a", encoding="utf-8", buffering=1)
        print(f"  Raw packet capture: {cap_path}")
        threading.Thread(
            target=udp_listener,
            args=(hub, args.udp, stop_event, print, args.units, capture_file),
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
        f"?src={'sim' if args.simulate else 'live'}&ws={args.ws}&layout={start_layout}"
    )
    test_url = (
        f"http://localhost:{args.http}/sensortest.html"
        f"?src={'sim' if args.simulate else 'live'}&ws={args.ws}&layout={start_layout}"
    )
    print(DIVIDER_BAR)
    print(f"  GAME CLIENT: {game_url}")
    print(f"  SENSOR TEST: {test_url}")
    print(f"  LOGS:        http://localhost:{args.http}/logs.html")
    print(DIVIDER_BAR)

    if not args.no_open:
        webbrowser.open(game_url)

    # ── Terminal Live Status Monitor ─────────────────────────────────────────
    threading.Thread(
        target=status_loop,
        args=(hub, ws_server, stop_event),
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
        for sid in store.stale_open_sessions(0):
            api.end(sid)
        store.close()
        if capture_file:
            capture_file.close()


if __name__ == "__main__":
    main()
