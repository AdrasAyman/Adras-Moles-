"""
RFC 6455 WebSocket Server: Lightweight, zero-dependency implementation for
broadcasting real-time position and telemetry frames to connected browser clients.
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading
from typing import Callable
from bridge.config import WS_GUID


class WebSocketServer(threading.Thread):
    """
    RFC 6455 compliant WebSocket server running as a background daemon thread.
    """

    def __init__(self, host: str, port: int, on_log: Callable[[str], None] = print):
        super().__init__(daemon=True, name="ws")
        self.host = host
        self.port = port
        self.log = on_log
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
            threading.Thread(
                target=self._client_handler,
                args=(conn, addr),
                daemon=True,
                name="ws-client",
            ).start()

    # ── Handshake ─────────────────────────────────────────────────────────────
    def _client_handler(self, conn: socket.socket, addr: tuple[str, int]):
        try:
            conn.settimeout(5.0)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(2048)
                if not chunk:
                    raise ConnectionError("Socket closed during handshake")
                data += chunk
                if len(data) > 16384:
                    raise ConnectionError("Handshake request header too large")

            key = None
            for line in data.split(b"\r\n"):
                if line.lower().startswith(b"sec-websocket-key:"):
                    key = line.split(b":", 1)[1].strip().decode()

            if not key:
                conn.close()
                return

            accept = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode()).digest()
            ).decode()

            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            conn.sendall(response.encode())
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

    # ── Inbound Frame Reader ──────────────────────────────────────────────────
    def _read_loop(self, conn: socket.socket):
        while True:
            hdr = self._recv_exact(conn, 2)
            if not hdr:
                return
            opcode = hdr[0] & 0x0F
            masked = hdr[1] & 0x80
            length = hdr[1] & 0x7F

            if length == 126:
                length = struct.unpack(">H", self._recv_exact(conn, 2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(conn, 8))[0]

            mask = self._recv_exact(conn, 4) if masked else b""
            payload = self._recv_exact(conn, length) if length else b""

            if masked and payload:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

            if opcode == 0x8:  # Close frame
                return
            if opcode == 0x9:  # Ping frame -> Respond with Pong
                self._send_raw(conn, 0xA, payload)

    @staticmethod
    def _recv_exact(conn: socket.socket, n: int) -> bytes | None:
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    # ── Outbound Frame Writer ─────────────────────────────────────────────────
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

    def _send_raw(self, conn: socket.socket, opcode: int, payload: bytes):
        try:
            conn.sendall(self._frame(opcode, payload))
        except OSError:
            with self.lock:
                self.clients.discard(conn)

    def broadcast(self, text: str):
        """
        Pushes a UTF-8 text frame to all connected WebSocket clients.
        """
        frame = self._frame(0x1, text.encode("utf-8"))
        with self.lock:
            targets = list(self.clients)
        for client in targets:
            try:
                client.sendall(frame)
            except OSError:
                with self.lock:
                    self.clients.discard(client)

    @property
    def count(self) -> int:
        """Returns the number of currently connected WebSocket clients."""
        with self.lock:
            return len(self.clients)
