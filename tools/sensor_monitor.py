#!/usr/bin/env python3
"""
Sensor Monitor: standalone, plain-numbers view of what the sensor boxes send.
No game, no solver, no filtering: just each box's readings and their statistics
over a rolling window, refreshed in place.

Reads the firmware's "<box>: <cm>" packets (JSON {"box":..,"ranges":[mm..]} too)
live over UDP, or replays a capture the bridge saved in logs/udp-*.log. It only
listens, so it can run alongside molefield.py.

Columns (all distances in cm, over the last --window seconds):
    last     newest reading                 rate   packets per second
    mean     average of real echoes         gap    longest silence between packets (ms)
    median   middle value of real echoes    age    time since the last packet (s)
    std      spread = jitter                noecho share of readings that were no echo
    min/max  range of real echoes           offset mean minus --ref (only with --ref)

Usage:
    python tools/sensor_monitor.py
    python tools/sensor_monitor.py --ref 150          # player/board at a taped 150 cm
    python tools/sensor_monitor.py --replay logs/udp-20261005-150550.log
    python tools/sensor_monitor.py --replay FILE --speed 0   # whole file, summary only
    python tools/sensor_monitor.py --csv readings.csv        # also log every reading
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import socket
import statistics
import time
from collections import deque

_BOXVAL = re.compile(r"^\s*(?:box\s*)?(\d+)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*$", re.I)


def parse(text: str) -> tuple[int, float] | None:
    """One packet -> (box, cm). Two/three-value JSON keeps the nearest echo."""
    text = text.strip()
    m = _BOXVAL.match(text)
    if m:
        return int(m.group(1)), float(m.group(2))
    if text.startswith("{"):
        try:
            msg = json.loads(text)
            vals = msg.get("ranges", [msg.get("range")])
            mm = [v for v in vals if isinstance(v, (int, float)) and v > 0]
            return int(msg["box"]), (min(mm) / 10.0 if mm else -1.0)
        except (ValueError, KeyError, TypeError, AttributeError):
            return None
    return None


class Box:
    def __init__(self, window: float):
        self.window = window
        self.samples: deque[tuple[float, float]] = deque()  # (time, cm)
        self.total = 0
        self.last_raw = ""

    def add(self, t: float, cm: float, raw: str):
        self.samples.append((t, cm))
        self.total += 1
        self.last_raw = raw
        if self.window > 0:
            while self.samples and t - self.samples[0][0] > self.window:
                self.samples.popleft()

    def stats(self, now: float, max_cm: float, ref: float | None) -> dict:
        s = list(self.samples)
        cms = [c for _, c in s]
        echo = [c for c in cms if 0 < c < max_cm]
        times = [t for t, _ in s]
        span = times[-1] - times[0] if len(times) > 1 else 0.0
        gaps = [b - a for a, b in zip(times, times[1:])]
        mean = statistics.fmean(echo) if echo else None
        return {
            "last": cms[-1] if cms else None,
            "mean": mean,
            "median": statistics.median(echo) if echo else None,
            "std": statistics.pstdev(echo) if len(echo) > 1 else None,
            "min": min(echo) if echo else None,
            "max": max(echo) if echo else None,
            "rate": (len(times) - 1) / span if span > 0 else None,
            "gap": max(gaps) * 1000.0 if gaps else None,
            "age": now - times[-1] if times else None,
            "noecho": 100.0 * (len(cms) - len(echo)) / len(cms) if cms else None,
            "offset": mean - ref if (mean is not None and ref is not None) else None,
        }


COLS = [("last", "{:7.1f}"), ("mean", "{:7.1f}"), ("median", "{:7.1f}"), ("std", "{:6.2f}"),
        ("min", "{:7.1f}"), ("max", "{:7.1f}"), ("rate", "{:5.1f}"), ("gap", "{:5.0f}"),
        ("age", "{:5.1f}"), ("noecho", "{:5.0f}%")]


def render(boxes: dict[int, Box], now: float, args, source: str, bad: int) -> str:
    cols = COLS + ([("offset", "{:+7.1f}")] if args.ref is not None else [])
    widths = [max(len(n), len(f.format(0))) for n, f in cols]
    win = "whole capture" if args.window <= 0 else f"last {args.window:g} s"
    lines = [
        f"SENSOR MONITOR   {source}   window: {win}"
        + (f"   ref: {args.ref:g} cm" if args.ref is not None else ""),
        f"no echo = reading <= 0 or >= {args.max_cm:g} cm    unreadable packets: {bad}",
        "",
        "box  " + "  ".join(n.rjust(w) for (n, _), w in zip(cols, widths)) + "   packets",
    ]
    if not boxes:
        lines.append("  (waiting for packets...)")
    for b in sorted(boxes):
        st = boxes[b].stats(now, args.max_cm, args.ref)
        cells = []
        for (name, fmt), w in zip(cols, widths):
            v = st[name]
            cells.append(("-" if v is None else fmt.format(v)).rjust(w))
        lines.append(f"{b:>3}  " + "  ".join(cells) + f"   {boxes[b].total:>7}")
    lines.append("")
    for b in sorted(boxes):
        lines.append(f"  box {b} last packet: {boxes[b].last_raw[:60]!r}")
    return "\n".join(lines)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=5000, help="UDP port the boxes send to")
    p.add_argument("--window", type=float, default=5.0, help="seconds of history per statistic (0 = all)")
    p.add_argument("--ref", type=float, help="true distance in cm; adds an offset column")
    p.add_argument("--max-cm", type=float, default=800.0, help="readings at/above this are no echo (MAX_DIST_CM)")
    p.add_argument("--replay", metavar="FILE", help="replay a logs/udp-*.log capture instead of listening")
    p.add_argument("--speed", type=float, default=1.0, help="replay speed; 0 = read it all, print a summary")
    p.add_argument("--csv", metavar="FILE", help="also write every reading to this CSV")
    args = p.parse_args()

    os.system("")  # turns on ANSI cursor codes in the Windows console
    boxes: dict[int, Box] = {}
    bad = 0
    writer = None
    if args.csv:
        csv_file = open(args.csv, "w", newline="", encoding="utf-8", buffering=1)
        writer = csv.writer(csv_file)
        writer.writerow(["time_s", "box", "cm", "sender", "raw"])

    def handle(t: float, sender: str, text: str):
        nonlocal bad
        parsed = parse(text)
        if parsed is None:
            bad += 1
            return
        box, cm = parsed
        boxes.setdefault(box, Box(args.window)).add(t, cm, text.strip())
        if writer:
            writer.writerow([f"{t:.4f}", box, f"{cm:.1f}", sender, text.strip()])

    def draw(now: float, source: str):
        print("\x1b[H\x1b[J" + render(boxes, now, args, source, bad), flush=True)

    try:
        if args.replay:
            rows = []
            with open(args.replay, encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.rstrip("\n").split("\t", 2)
                    if len(parts) == 3:
                        try:
                            rows.append((float(parts[0]), parts[1], parts[2]))
                        except ValueError:
                            pass
            source = f"replay {os.path.basename(args.replay)}"
            if args.speed <= 0:
                args.window = 0  # summary of the whole file
                for b in boxes.values():
                    b.window = 0
                for t, sender, text in rows:
                    handle(t, sender, text)
                print(render(boxes, rows[-1][0] if rows else 0.0, args, source, bad))
                return
            t0, next_draw = time.monotonic(), 0.0
            for t, sender, text in rows:
                while (time.monotonic() - t0) * args.speed < t:
                    time.sleep(0.005)
                handle(t, sender, text)
                if t >= next_draw:
                    draw(t, source)
                    next_draw = t + 0.25
            draw(rows[-1][0] if rows else 0.0, source + " (finished)")
            return

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", args.port))
        sock.settimeout(0.05)
        t0, next_draw = time.monotonic(), 0.0
        source = f"live UDP :{args.port}   Ctrl+C to stop"
        while True:
            try:
                data, addr = sock.recvfrom(2048)
                handle(time.monotonic() - t0, addr[0], data.decode("utf-8", "replace"))
            except socket.timeout:
                pass
            now = time.monotonic() - t0
            if now >= next_draw:
                draw(now, source)
                next_draw = now + 0.25
    except KeyboardInterrupt:
        pass
    finally:
        if writer:
            csv_file.close()


if __name__ == "__main__":
    main()
