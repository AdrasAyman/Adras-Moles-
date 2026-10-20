#!/usr/bin/env python3
"""
UDP Sniffer: prints every datagram the sensor boxes send over Wi-Fi, with each
variable decoded, so the raw input can be checked before it reaches the bridge.

Listens on 5000 (bridge default, Sensor_wifi.ino) and 4210 (molefield_sensor.ino)
at once. The boxes broadcast, so this can run alongside molefield.py.

Usage:
    python tools/udp_sniff.py
    python tools/udp_sniff.py --ports 5000 --units mm
"""

from __future__ import annotations

import argparse
import json
import os
import select
import socket
import sys
import time

# Ensure workspace root is on sys.path so bridge can be imported
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.networking import parse_datagram


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ports", type=int, nargs="+", default=[5000, 4210])
    p.add_argument("--units", default="cm", help='unit of a bare "<box>: <value>" packet (cm or mm)')
    args = p.parse_args()

    socks = {}
    for port in args.ports:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
        socks[s] = port
        print(f"listening on UDP :{port}")
    print("Ctrl+C to stop\n")

    t0 = time.monotonic()
    try:
        while True:
            ready, _, _ = select.select(list(socks), [], [], 0.5)
            for s in ready:
                data, addr = s.recvfrom(2048)
                text = data.decode("utf-8", "replace").strip()
                print(f"[{time.monotonic() - t0:8.3f}s] :{socks[s]} from {addr[0]}")
                print(f"    raw     {text}")
                if text.startswith("{"):
                    try:
                        for k, v in json.loads(text).items():
                            print(f"    {k:<7} {v}")
                    except ValueError:
                        pass
                parsed = parse_datagram(text, args.units)
                if parsed is None:
                    print("    !! bridge would REJECT this packet")
                else:
                    box, vals, _ = parsed
                    print(f"    bridge  box={box} ranges_mm={vals}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
