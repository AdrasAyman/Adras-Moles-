#!/usr/bin/env python3
"""
MOLEFIELD — sensor bridge and game host
ENGG3000 SPINE · full-body Whack-a-Mole

One process, no third-party packages. It does four jobs:

  1. HTTP     serves the game to a browser on http://localhost:8000
  2. UDP in   receives range frames from the ESP32 sensor boxes on :4210
  3. SYNC out broadcasts a ping-slot beacon on :4211 so the boxes take turns
              firing and stop hearing each other's echoes
  4. WS out   pushes merged frames to the game on ws://localhost:8765

Run it:
    python molefield.py                 hardware mode
    python molefield.py --simulate      no hardware, synthetic walker
    python molefield.py --log run1.csv  record every frame for the design review

Wire protocol from each box (UDP, JSON, one datagram per cycle):
    {"box": 0, "t": 184213, "ranges": [1420, 1655]}
`ranges` are millimetres to the nearest surface, null where no echo returned.
Index within the datagram is the sensor's position in that box; the bridge maps
(box, index) to a global sensor index with --map.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import math
import os
import random
import signal
import socket
import struct
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# ─────────────────────────────────────────────────────────────────────────────
# Geometry. These MUST match the layout selected in the game's sidebar.
# x runs across the wall, y runs out from the wall. Metres.
# ─────────────────────────────────────────────────────────────────────────────
LAYOUTS = {
    "4lin":  [(0.19, 0.30, 0), (0.56, 0.30, 0), (0.94, 0.30, 0), (1.31, 0.30, 0)],
    "2box":  [(0.10, 0.30, 14), (1.40, 0.30, -14)],
    "4wide": [(0.06, 0.30, 26), (0.52, 0.30, 6), (0.98, 0.30, -6), (1.44, 0.30, -26)],
}

AREA_W, AREA_NEAR, AREA_FAR, BODY_R = 1.50, 0.60, 2.00, 0.20

DEFAULTS = dict(http=8000, ws=8765, udp=4210, sync=4211,
                rate=30.0, sync_hz=15.6, stale_ms=400)


# ─────────────────────────────────────────────────────────────────────────────
# Sensor hub — merges datagrams from several boxes into one global frame
# ─────────────────────────────────────────────────────────────────────────────
class SensorHub:
    def __init__(self, n_sensors: int, box_map: dict[int, list[int]], stale_ms: int):
        self.n = n_sensors
        self.map = box_map
        self.stale = stale_ms / 1000.0
        self.ranges: list[float | None] = [None] * n_sensors
        self.stamp: list[float] = [0.0] * n_sensors
        self.boxes: dict[int, dict] = {}
        self.lock = threading.Lock()
        self.frames = 0
        self.bad = 0

    def ingest(self, box: int, ranges_mm: list, sender: str = ""):
        now = time.monotonic()
        idx = self.map.get(box)
        if idx is None:
            self.bad += 1
            return
        with self.lock:
            for i, mm in enumerate(ranges_mm):
                if i >= len(idx):
                    break
                g = idx[i]
                if g >= self.n:
                    continue
                self.ranges[g] = None if mm is None else float(mm) / 1000.0
                self.stamp[g] = now
            b = self.boxes.setdefault(box, dict(count=0, last=0.0, hz=0.0,
                                                _t0=now, _c0=0, addr=sender))
            b["count"] += 1
            b["last"] = now
            b["addr"] = sender or b["addr"]
            if now - b["_t0"] >= 1.0:
                b["hz"] = (b["count"] - b["_c0"]) / (now - b["_t0"])
                b["_t0"], b["_c0"] = now, b["count"]
            self.frames += 1

    def snapshot(self) -> list[float | None]:
        """Current ranges in metres, with anything older than `stale` cleared."""
        now = time.monotonic()
        with self.lock:
            return [r if (r is not None and now - t <= self.stale) else None
                    for r, t in zip(self.ranges, self.stamp)]

    def live_boxes(self) -> list[tuple[int, dict]]:
        now = time.monotonic()
        with self.lock:
            return sorted((b, dict(v, alive=(now - v["last"]) < 1.0))
                          for b, v in self.boxes.items())


# ─────────────────────────────────────────────────────────────────────────────
# Minimal RFC 6455 server. Text frames out, ping/close handled, nothing else.
# ─────────────────────────────────────────────────────────────────────────────
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketServer(threading.Thread):
    def __init__(self, host: str, port: int, on_log=print):
        super().__init__(daemon=True, name="ws")
        self.host, self.port, self.log = host, port, on_log
        self.clients: set[socket.socket] = set()
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(8)

    def run(self):
        while True:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn, addr),
                             daemon=True, name="ws-client").start()

    # ---- handshake ---------------------------------------------------------
    def _client(self, conn: socket.socket, addr):
        try:
            conn.settimeout(5.0)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(2048)
                if not chunk:
                    raise ConnectionError
                data += chunk
                if len(data) > 16384:
                    raise ConnectionError
            key = None
            for line in data.split(b"\r\n"):
                if line.lower().startswith(b"sec-websocket-key:"):
                    key = line.split(b":", 1)[1].strip().decode()
            if not key:
                conn.close()
                return
            accept = base64.b64encode(
                hashlib.sha1((key + GUID).encode()).digest()).decode()
            conn.sendall((
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
            conn.settimeout(None)
            with self.lock:
                self.clients.add(conn)
            self.log(f"  game connected from {addr[0]}")
            self._read_loop(conn)
        except Exception:
            pass
        finally:
            with self.lock:
                self.clients.discard(conn)
            try:
                conn.close()
            except OSError:
                pass

    # ---- inbound frames (we only care about ping and close) ----------------
    def _read_loop(self, conn: socket.socket):
        while True:
            hdr = self._recv_exact(conn, 2)
            if not hdr:
                return
            opcode = hdr[0] & 0x0F
            masked = hdr[1] & 0x80
            ln = hdr[1] & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(conn, 2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(conn, 8))[0]
            mask = self._recv_exact(conn, 4) if masked else b""
            payload = self._recv_exact(conn, ln) if ln else b""
            if masked and payload:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:                       # close
                return
            if opcode == 0x9:                       # ping -> pong
                self._send_raw(conn, 0xA, payload)

    @staticmethod
    def _recv_exact(conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    # ---- outbound ----------------------------------------------------------
    @staticmethod
    def _frame(opcode: int, payload: bytes) -> bytes:
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        return head + payload

    def _send_raw(self, conn, opcode, payload):
        try:
            conn.sendall(self._frame(opcode, payload))
        except OSError:
            with self.lock:
                self.clients.discard(conn)

    def broadcast(self, text: str):
        frame = self._frame(0x1, text.encode())
        with self.lock:
            targets = list(self.clients)
        for c in targets:
            try:
                c.sendall(frame)
            except OSError:
                with self.lock:
                    self.clients.discard(c)

    @property
    def count(self) -> int:
        with self.lock:
            return len(self.clients)


# ─────────────────────────────────────────────────────────────────────────────
# Sensor model — mirrors the JavaScript exactly so --simulate is honest
# ─────────────────────────────────────────────────────────────────────────────
class Walker:
    """A body wandering the play area, for testing the whole chain dry."""

    def __init__(self, sensors, noise=0.008, drop=0.03, beam=30.0):
        self.sensors, self.noise, self.drop = sensors, noise, drop
        self.beam = math.radians(beam)
        self.t = 0.0

    def truth(self, dt):
        self.t += dt
        x = AREA_W * (0.5 + 0.42 * math.sin(self.t * 0.7))
        y = AREA_NEAR + (AREA_FAR - AREA_NEAR) * (0.5 + 0.38 * math.sin(self.t * 0.43 + 1.1))
        return x, y

    def ranges_mm(self, x, y):
        out = []
        for (sx, sy, ang) in self.sensors:
            dx, dy = x - sx, y - sy
            d = math.hypot(dx, dy)
            bearing = math.atan2(dx, dy)
            if abs(bearing - math.radians(ang)) > self.beam or d > 4.0:
                out.append(None)
            elif random.random() < self.drop:
                out.append(None)
            else:
                surface = max(0.02, d - BODY_R + random.gauss(0, self.noise))
                out.append(round(surface * 1000))
        return out


# ─────────────────────────────────────────────────────────────────────────────
# Solver — same least-squares fit the game runs, used only for CSV logging so
# your logs carry a position column without the browser in the loop.
# ─────────────────────────────────────────────────────────────────────────────
def solve(ranges_m, sensors):
    obs = [(sensors[i], r + BODY_R) for i, r in enumerate(ranges_m) if r is not None]
    if len(obs) < 2:
        return None
    def cost(x, y):
        return sum((math.hypot(x - s[0], y - s[1]) - d) ** 2 for s, d in obs)
    bx, by, bc = AREA_W / 2, 1.2, float("inf")
    G = 26
    for i in range(G + 1):
        for j in range(G + 1):
            x = i / G * AREA_W
            y = 0.2 + j / G * (AREA_FAR - 0.2)
            c = cost(x, y)
            if c < bc:
                bc, bx, by = c, x, y
    x, y, step = bx, by, 0.06
    for _ in range(60):
        gx = gy = 0.0
        for s, d in obs:
            dx, dy = x - s[0], y - s[1]
            dist = math.hypot(dx, dy) or 1e-6
            e = dist - d
            gx += 2 * e * dx / dist
            gy += 2 * e * dy / dist
        x -= step * gx
        y -= step * gy
        x = min(max(x, -0.3), AREA_W + 0.3)
        y = min(max(y, 0.05), AREA_FAR + 0.3)
        step *= 0.97
    return x, y, math.sqrt(cost(x, y) / len(obs)), len(obs)


# ─────────────────────────────────────────────────────────────────────────────
# Threads
# ─────────────────────────────────────────────────────────────────────────────
def udp_listener(hub: SensorHub, port: int, stop: threading.Event, log):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.settimeout(0.5)
    log(f"  listening for sensor boxes on UDP :{port}")
    while not stop.is_set():
        try:
            data, addr = s.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError:
            break
        try:
            msg = json.loads(data.decode("utf-8", "replace"))
            hub.ingest(int(msg.get("box", 0)), list(msg.get("ranges", [])), addr[0])
        except (ValueError, TypeError):
            hub.bad += 1
    s.close()


def sync_beacon(port: int, hz: float, stop: threading.Event):
    """Slot beacon. Every box fires its sensors at a fixed offset after this,
    so no sensor ever hears another sensor's echo."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    seq, period = 0, 1.0 / hz
    nxt = time.monotonic()
    while not stop.is_set():
        try:
            s.sendto(json.dumps({"sync": seq}).encode(),
                     ("255.255.255.255", port))
        except OSError:
            pass
        seq = (seq + 1) & 0xFFFF
        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))
    s.close()


def simulator(hub: SensorHub, walker: Walker, box_map, hz: float,
              stop: threading.Event):
    period = 1.0 / hz
    nxt = time.monotonic()
    while not stop.is_set():
        x, y = walker.truth(period)
        allr = walker.ranges_mm(x, y)
        for box, idx in box_map.items():
            hub.ingest(box, [allr[i] for i in idx if i < len(allr)], "simulated")
        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))


def pump(hub: SensorHub, ws: WebSocketServer, sensors, rate: float,
         writer, stop: threading.Event, logfile=None):
    period = 1.0 / rate
    nxt = time.monotonic()
    t0 = time.monotonic()
    last_flush = t0
    while not stop.is_set():
        r = hub.snapshot()
        ws.broadcast(json.dumps({
            "t": int((time.monotonic() - t0) * 1000),
            "ranges": [None if v is None else round(v * 1000) for v in r],
        }))
        if writer:
            fix = solve(r, sensors)
            writer.writerow(
                [f"{time.monotonic() - t0:.3f}"]
                + ["" if v is None else round(v * 1000) for v in r]
                + ([f"{fix[0]:.4f}", f"{fix[1]:.4f}", f"{fix[2] * 1000:.1f}", fix[3]]
                   if fix else ["", "", "", 0]))
            if logfile and time.monotonic() - last_flush > 1.0:
                logfile.flush()
                last_flush = time.monotonic()
        nxt += period
        time.sleep(max(0.0, nxt - time.monotonic()))


# ─────────────────────────────────────────────────────────────────────────────
# Console
# ─────────────────────────────────────────────────────────────────────────────
BAR = "─" * 62


def status_loop(hub: SensorHub, ws: WebSocketServer, sensors, stop: threading.Event):
    time.sleep(1.0)
    while not stop.is_set():
        r = hub.snapshot()
        n = sum(1 for v in r if v is not None)
        fix = solve(r, sensors)
        cells = " ".join(f"{i}:{'----' if v is None else f'{v * 1000:4.0f}'}"
                         for i, v in enumerate(r))
        pos = (f"x={fix[0]:.2f} y={fix[1]:.2f} res={fix[2] * 1000:3.0f}mm"
               if fix else "no fix")
        boxes = " ".join(f"box{b}:{v['hz']:4.1f}Hz{'' if v['alive'] else ' DEAD'}"
                         for b, v in hub.live_boxes()) or "no boxes reporting"
        sys.stdout.write(
            f"\r  {n}/{len(r)} echoes | {cells} | {pos} | {boxes} | "
            f"games:{ws.count}   ")
        sys.stdout.flush()
        time.sleep(0.25)


def parse_map(spec: str, n_sensors: int) -> dict[int, list[int]]:
    """--map "0:0,1 1:2,3"  →  {0:[0,1], 1:[2,3]}"""
    if not spec:
        per = 2
        return {b: [b * per + i for i in range(per)]
                for b in range((n_sensors + per - 1) // per)}
    out = {}
    for part in spec.split():
        box, idxs = part.split(":")
        out[int(box)] = [int(i) for i in idxs.split(",")]
    return out


def main():
    d = DEFAULTS
    p = argparse.ArgumentParser(
        description="MOLEFIELD sensor bridge and game host",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--layout", choices=list(LAYOUTS), default="4lin",
                   help="sensor geometry; must match the game sidebar")
    p.add_argument("--map", default="",
                   help='box to sensor-index map, e.g. "0:0,1 1:2,3"')
    p.add_argument("--http", type=int, default=d["http"])
    p.add_argument("--ws", type=int, default=d["ws"])
    p.add_argument("--udp", type=int, default=d["udp"])
    p.add_argument("--sync", type=int, default=d["sync"])
    p.add_argument("--sync-hz", type=float, default=d["sync_hz"],
                   help="ping cycles per second across all sensors")
    p.add_argument("--rate", type=float, default=d["rate"],
                   help="frames per second pushed to the game")
    p.add_argument("--stale-ms", type=int, default=d["stale_ms"],
                   help="drop a sensor's range if it is older than this")
    p.add_argument("--simulate", action="store_true",
                   help="synthesise a walking body instead of reading hardware")
    p.add_argument("--noise", type=float, default=8.0, help="sim range noise, mm")
    p.add_argument("--dropout", type=float, default=3.0, help="sim missing echoes, %%")
    p.add_argument("--log", metavar="FILE", help="write every frame to CSV")
    p.add_argument("--no-open", action="store_true", help="do not open a browser")
    a = p.parse_args()

    sensors = LAYOUTS[a.layout]
    box_map = parse_map(a.map, len(sensors))
    stop = threading.Event()

    print(BAR)
    print("  MOLEFIELD  ·  full-body Whack-a-Mole")
    print(BAR)
    print(f"  layout {a.layout}: {len(sensors)} sensors, "
          f"{len(box_map)} boxes  {box_map}")

    # PyInstaller --onefile unpacks bundled data to a temp dir it names in
    # sys._MEIPASS; running from source we just look next to this file.
    here = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    root = os.path.join(here, "game")
    if not os.path.isdir(root):
        sys.exit(f"  game folder missing: {root}")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=root, **kw)

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", a.http), Handler)
    threading.Thread(target=http.serve_forever, daemon=True, name="http").start()

    ws = WebSocketServer("127.0.0.1", a.ws)
    ws.start()
    print(f"  websocket on ws://localhost:{a.ws}")

    writer = None
    logfile = None
    if a.log:
        logfile = open(a.log, "w", newline="")
        writer = csv.writer(logfile)
        writer.writerow(["t_s"] + [f"r{i}_mm" for i in range(len(sensors))]
                        + ["x_m", "y_m", "residual_mm", "n_sensors"])
        print(f"  logging every frame to {a.log}")

    hub = SensorHub(len(sensors), box_map, a.stale_ms)

    if a.simulate:
        walker = Walker(sensors, a.noise / 1000, a.dropout / 100)
        threading.Thread(target=simulator,
                         args=(hub, walker, box_map, a.sync_hz, stop),
                         daemon=True, name="sim").start()
        print("  SIMULATE: no hardware needed, synthetic body walking the area")
    else:
        threading.Thread(target=udp_listener, args=(hub, a.udp, stop, print),
                         daemon=True, name="udp").start()
        threading.Thread(target=sync_beacon, args=(a.sync, a.sync_hz, stop),
                         daemon=True, name="sync").start()
        print(f"  sync beacon broadcasting on UDP :{a.sync} at {a.sync_hz:.1f} Hz")

    threading.Thread(target=pump,
                     args=(hub, ws, sensors, a.rate, writer, stop, logfile),
                     daemon=True, name="pump").start()

    # A closed console window sends SIGTERM, not Ctrl-C. Treat both the same
    # so a recorded run is never left half-written.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))

    url = f"http://localhost:{a.http}/index.html?src=live&ws={a.ws}&layout={a.layout}"
    print(BAR)
    print(f"  GAME: {url}")
    print(BAR)
    if not a.no_open:
        webbrowser.open(url)

    threading.Thread(target=status_loop, args=(hub, ws, sensors, stop),
                     daemon=True, name="status").start()

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        print("\n  stopping")
        if logfile:
            logfile.close()
        http.shutdown()


if __name__ == "__main__":
    main()
