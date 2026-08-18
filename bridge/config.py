"""
Geometry and system defaults for MOLEFIELD.
All physical distances are in metres, angles in degrees relative to the wall normal.
"""

from __future__ import annotations

# ─────────────────────────────────────────────────────────────────────────────
# Geometry. These MUST match the layout selected in the game's sidebar.
# x runs across the wall (left -> right), y runs out from the wall into the room.
# Format: (x_pos_m, y_pos_m, angle_deg)
# ─────────────────────────────────────────────────────────────────────────────
LAYOUTS: dict[str, list[tuple[float, float, float]]] = {
    "4lin": [
        (0.19, 0.30, 0.0),
        (0.56, 0.30, 0.0),
        (0.94, 0.30, 0.0),
        (1.31, 0.30, 0.0),
    ],
    "2box": [
        (0.10, 0.30, 14.0),
        (1.40, 0.30, -14.0),
    ],
    "4wide": [
        (0.06, 0.30, 26.0),
        (0.52, 0.30, 6.0),
        (0.98, 0.30, -6.0),
        (1.44, 0.30, -26.0),
    ],
}

# Physical boundary dimensions (in metres)
AREA_W: float = 1.50      # Play area width
AREA_NEAR: float = 0.60   # Play area near boundary (end of dead zone)
AREA_FAR: float = 2.00    # Play area far boundary
BODY_R: float = 0.20      # Modelled torso radius for surface-to-center offset

# Default networking and operational parameters
DEFAULTS: dict[str, int | float] = {
    "http": 8000,
    "ws": 8765,
    "udp": 5000,   # matches the deployed ESP32 test firmware (esp_test_files/ESP_code)
    "sync": 4211,
    "rate": 30.0,         # Frames per second pushed to the game UI over WS
    "sync_hz": 15.6,      # Ping slot beacon cycles per second across all boxes
    "stale_ms": 400,      # Invalidation threshold for lost sensor echoes (ms)
}

# RFC 6455 WebSocket Handshake Magic GUID
WS_GUID: str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
