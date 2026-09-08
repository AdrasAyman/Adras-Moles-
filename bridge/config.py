"""
Geometry and system defaults for MOLEFIELD.
All physical distances are in metres, angles in degrees relative to the wall normal.
"""

from __future__ import annotations

# ─────────────────────────────────────────────────────────────────────────────
# Geometry. These MUST match the layout selected in the game's sidebar.
# x runs across the wall (left -> right), y runs out from the wall into the room.
# Bearing convention is atan2(dx, dy): 0 deg points straight out from the wall,
# POSITIVE turns toward +x.
# ─────────────────────────────────────────────────────────────────────────────
# Each entry is (x_m, y_m, aim_deg, full_beam_width_deg).
#
# !! THE AIM ANGLES AND WIDTHS BELOW ARE UNCALIBRATED DEFAULTS !!
# 40 deg is a bench estimate of the real cone, and the aims are reconstructed
# from the intended mounting rather than measured off the built hardware.
# Run the game's sensortest.html page, capture a calibration sweep, and paste
# the fitted values back here before trusting the sector solver.
LAYOUTS: dict[str, list[tuple[float, float, float, float]]] = {
    "4lin": [
        (0.19, 0.30, 0.0, 40.0),
        (0.56, 0.30, 0.0, 40.0),
        (0.94, 0.30, 0.0, 40.0),
        (1.31, 0.30, 0.0, 40.0),
    ],
    # The built rig: box 0 (A,B) bottom-left, box 1 (X,Y) bottom-right.
    # Sensors are ~40 deg wide but mounted only 25 deg apart, so each box
    # spans ~65 deg with ~15 deg of overlap -> three sectors per box.
    "2box4s": [
        (0.00, 0.30,  26.85, 40.0),   # A  left box, aimed forward
        (0.00, 0.30,  51.85, 40.0),   # B  left box, aimed along the wall
        (1.50, 0.30, -51.85, 40.0),   # X  right box, aimed along the wall
        (1.50, 0.30, -26.85, 40.0),   # Y  right box, aimed forward
    ],
    "2box": [
        (0.10, 0.30, 14.0, 40.0),
        (1.40, 0.30, -14.0, 40.0),
    ],
    "4wide": [
        (0.06, 0.30, 26.0, 40.0),
        (0.52, 0.30, 6.0, 40.0),
        (0.98, 0.30, -6.0, 40.0),
        (1.44, 0.30, -26.0, 40.0),
    ],
}

# Sensor labels, parallel to each layout above (used by the test page & logs).
LAYOUT_NAMES: dict[str, list[str]] = {
    "4lin": ["0", "1", "2", "3"],
    "2box4s": ["A", "B", "X", "Y"],
    "2box": ["L", "R"],
    "4wide": ["0", "1", "2", "3"],
}

# Physical boundary dimensions (in metres)
AREA_W: float = 1.50      # Play area width
AREA_NEAR: float = 0.60   # Play area near boundary (end of dead zone)
AREA_FAR: float = 2.00    # Play area far boundary
BODY_R: float = 0.20      # Modelled torso radius for surface-to-center offset

# Acoustic beam model
BEAM_DEFAULT_W: float = 40.0   # Full cone width (deg) when a layout omits it
BEAM_MAX_RANGE: float = 2.40   # Hard ceiling from ECHO_TIMEOUT_US in firmware
BEAM_MIN_RANGE: float = 0.04

# Solver / filter tuning. Must mirror SOLVER in game/js/config.js.
SOLVER: dict[str, float] = {
    "median_window": 5,      # Samples of median filtering on each raw range
    "sector_tol_deg": 6.0,   # Slack before a fix is vetoed for leaving its cone
    "max_gap": 0.35,         # m - circle separation above this is not a real fix
    "pair_spread_warn": 0.25,
}

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
