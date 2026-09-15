"""
Networking Workers: Handles UDP packet ingestion from hardware sensor boxes,
slot synchronization beacon broadcasting, and dry-run simulation loops.
"""

from __future__ import annotations

import json
import random
import socket
import threading
import time
from typing import Callable
from bridge.hub import SensorHub
from bridge.simulator import Walker


def parse_datagram(text: str) -> tuple[int, list, bool | None] | None:
    """
    Decode one sensor packet into (box, readings_mm, one_based).

    JSON (box id 0 = left, 1 = right, readings in millimetres, null = no echo):
        {"box": 0, "ranges": [1420, 1655]}     two values: two 25 deg sensors
        {"box": 0, "ranges": [1420]}           one value: one 50 deg sensor
        {"box": 0, "range": 1420}              also accepted ("mm" / "value" too)
    Plain text (box id 1-based, readings in centimetres, -1 = no echo):
        Box:1,S1:142.0,S2:165.5                Box:1,S1:142.0
    Returns None when the packet is not recognisable.
    """
    text = text.strip()
    if text.startswith("{"):
        try:
            msg = json.loads(text)
        except ValueError:
            return None
        if not isinstance(msg, dict) or "box" not in msg:
            return None
        try:
            box = int(msg["box"])
        except (TypeError, ValueError):
            return None
        if isinstance(msg.get("ranges"), list):
            return box, list(msg["ranges"]), None
        for key in ("range", "mm", "value"):
            if key in msg:
                return box, [msg[key]], None
        return None
    if text.startswith("Box:"):
        try:
            parts = text.split(",")
            box = int(parts[0].split(":", 1)[1])
            vals = []
            for p in parts[1:]:
                if ":" in p:
                    cm = float(p.split(":", 1)[1])
                    vals.append(round(cm * 10.0) if cm > 0 else None)
            return box, vals, True
        except (ValueError, IndexError):
            return None
    return None


def udp_listener(
    hub: SensorHub,
    port: int,
    stop: threading.Event,
    log: Callable[[str], None] = print,
):
    """
    Listens for sensor packets from the ESP32 boxes (see parse_datagram).
    Boxes may send at any rate; the hub holds each sensor's last value.
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

        parsed = parse_datagram(data.decode("utf-8", "replace"))
        if parsed is None:
            hub.bad += 1
            continue
        box, vals, one_based = parsed
        hub.ingest(box=box, ranges_mm=vals, sender=addr[0], one_based=one_based)

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
    values_per_box: int,
    hz: float,
    timing: str,
    stop: threading.Event,
):
    """
    Synthetic sensor boxes for dry runs without hardware.

    values_per_box  1 -> each box sends one 50 deg reading; 2 -> two 25 deg readings
    timing          "regular"   both boxes send every 1/hz seconds
                    "irregular" box 0 sends about every 100 ms with jitter, box 1 at
                                random intervals (mean ~700 ms, 50 ms - 3 s), which
                                exercises the hold-last-value path end to end
    """
    rng = random.Random()
    period = 1.0 / hz
    t_prev = time.monotonic()
    due = [t_prev, t_prev]

    def next_gap(box: int) -> float:
        if timing != "irregular":
            return period
        if box == 0:
            return max(0.02, rng.gauss(0.10, 0.03))
        return min(3.0, max(0.05, rng.expovariate(1.0 / 0.7)))

    while not stop.is_set():
        now = time.monotonic()
        x, y = walker.truth(now - t_prev)
        t_prev = now
        for box in range(2):
            if now >= due[box]:
                allmm = walker.ranges_mm(x, y)
                vals = allmm[box * values_per_box: (box + 1) * values_per_box]
                hub.ingest(box=box, ranges_mm=vals, sender="simulated")
                due[box] = now + next_gap(box)
        time.sleep(max(0.002, min(due) - time.monotonic()))
