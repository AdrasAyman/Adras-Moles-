"""
Networking Workers: Handles UDP packet ingestion from hardware sensor boxes,
slot synchronization beacon broadcasting, and dry-run simulation loops.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from typing import Callable
from bridge.hub import SensorHub
from bridge.simulator import Walker


def udp_listener(
    hub: SensorHub,
    port: int,
    stop: threading.Event,
    log: Callable[[str], None] = print,
):
    """
    Listens for incoming UDP datagrams containing ultrasonic ranges from ESP32 boxes.
    Expected datagram format: {"box": 0, "t": 184213, "ranges": [1420, 1655]}
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.settimeout(0.5)
    log(f"  listening for sensor boxes on UDP :{port}")

    while not stop.is_set():
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError:
            break

        text = data.decode("utf-8", "replace").strip()
        try:
            msg = json.loads(text)
            hub.ingest(
                box=int(msg.get("box", 0)),
                ranges_mm=list(msg.get("ranges", [])),
                sender=addr[0],
            )
        except (ValueError, TypeError):
            # Fallback parser for string payloads like "Box:1,S1:105.2,S2:98.4"
            if text.startswith("Box:"):
                try:
                    parts = text.split(",")
                    box_id = int(parts[0].split(":")[1])
                    # If 1-indexed (Box:1, Box:2), map to 0-indexed (0, 1)
                    if box_id in (1, 2) and 0 not in hub.map and 1 in hub.map:
                        norm_box = box_id - 1
                    else:
                        norm_box = box_id
                    
                    ranges = []
                    for p in parts[1:]:
                        if ":" in p:
                            val_cm = float(p.split(":")[1])
                            ranges.append(round(val_cm * 10.0) if val_cm > 0 else None)
                    hub.ingest(box=norm_box, ranges_mm=ranges, sender=addr[0])
                except Exception:
                    hub.bad += 1
            else:
                hub.bad += 1

    sock.close()


def sync_beacon(port: int, hz: float, stop: threading.Event):
    """
    Slot beacon broadcaster. Every ESP32 box fires its sensors at a fixed offset
    after this beacon, ensuring sensors do not hear each other's acoustic echoes.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    seq = 0
    period = 1.0 / hz
    nxt = time.monotonic()

    while not stop.is_set():
        try:
            payload = json.dumps({"sync": seq}).encode("utf-8")
            sock.sendto(payload, ("255.255.255.255", port))
        except OSError:
            pass

        seq = (seq + 1) & 0xFFFF
        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))

    sock.close()


def simulator_thread(
    hub: SensorHub,
    walker: Walker,
    box_map: dict[int, list[int]],
    hz: float,
    stop: threading.Event,
):
    """
    Generates synthetic sensor frames and pushes them into the SensorHub
    for offline dry-run testing without physical hardware.
    """
    period = 1.0 / hz
    nxt = time.monotonic()

    while not stop.is_set():
        x, y = walker.truth(period)
        all_ranges = walker.ranges_mm(x, y)

        for box, idxs in box_map.items():
            box_ranges = [all_ranges[i] for i in idxs if i < len(all_ranges)]
            hub.ingest(box=box, ranges_mm=box_ranges, sender="simulated")

        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))
