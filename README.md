# MOLEFIELD

Full-body Whack-a-Mole for ENGG3000 SPINE. A person moves in front of a screen,
four ultrasonic sensors track their position, and the game maps that to a
cursor on a field of moles.

## Project Structure

```
Adras-Moles-/
├── .gitignore
├── README.md
├── molefield.py              # Root launcher & CLI entrypoint
├── build_windows.bat         # Single-file Windows builder (PyInstaller)
├── run_windows.bat           # Launcher script for Windows
│
├── bridge/                   # Sensor bridge & WebSocket streaming package
│   ├── __init__.py
│   ├── config.py             # Geometries, physical constants & defaults
│   ├── hub.py                # SensorHub datagram merger & staleness tracker
│   ├── solver.py             # 2D multilateration least-squares optimizer
│   ├── simulator.py          # Synthetic walker kinematics & beam model
│   ├── websocket_server.py   # RFC 6455 WebSocket streaming server
│   ├── networking.py         # UDP range listener & slot sync broadcaster
│   ├── pipeline.py           # Frame pump & CSV telemetry recorder
│   └── cli.py                # Live console status monitor & CLI parser
│
├── game/                     # Browser game client (zero dependencies)
│   ├── index.html            # Clean semantic HTML markup
│   ├── css/
│   │   └── style.css         # UI design system, radar & stage styles
│   └── js/
│       ├── config.js         # Physical play area & level configuration
│       ├── audio.js          # Web Audio procedural sound synthesizer
│       ├── solver.js         # Frontend multilateration solver & noise model
│       ├── tracker.js        # Mouse / sim / WebSocket live tracking & EMA
│       ├── renderer.js       # 2D Canvas stage & mole animations
│       ├── radar.js          # Top-down radar & sensor arcs view
│       ├── game.js           # Whack-a-Mole rules, spawning & scoring
│       └── app.js            # HUD updates, UI bindings & animation loop
│
├── firmware/                 # ESP32 sensor hardware sketch
│   └── molefield_sensor/
│       └── molefield_sensor.ino
│
└── tools/                    # Geometric evaluation utilities
    └── layout_bench.py       # Coverage, error & heatmap benchmark
```

---

## Quick Start

### 1. Simulation Mode (Dry-Run, No Hardware Required)
Test the entire pipeline with a synthetic walking body:
```bash
python molefield.py --simulate
```

### 2. Live Hardware Mode (Standalone ESP32 Access Point)
* **ESP32 Box 0** automatically broadcasts its own Wi-Fi network: **`MOLEFIELD`** (Password: **`whackamole`**).
* **ESP32 Box 1** connects automatically to Box 0.
* Connect your Laptop / PC Wi-Fi to **`MOLEFIELD`**, then run:
```bash
python molefield.py
```
*(No external router, internet, or mobile hotspot required!)*

### 3. Record Telemetry to CSV
Record every frame and solved position for analysis and design reviews:
```bash
python molefield.py --log run1.csv
```

### 4. Build Standalone Windows Executable
On any Windows PC with Python:
```cmd
build_windows.bat
```
Produces `dist\MOLEFIELD.exe` — a single self-contained executable that launches the bridge and opens the browser game without requiring Python on target laptops.

---

## Position Estimation Principles

Each ultrasonic sensor measures distance to the nearest surface. The solver minimizes residual disagreement across all active arcs:

$$\text{minimise } \sum_{i} \left( \|\mathbf{p} - \mathbf{s}_i\| - d_i \right)^2 \quad \text{over } \mathbf{p} \in \text{Play Area}$$

1. **Grid Search**: A coarse 2D grid evaluation identifies the global minimum neighborhood to avoid local minima.
2. **Gradient Descent**: Iterative refinement steps converge precisely onto the target coordinates.
3. **Torso Offset**: Sensor readings measure distance to the body *surface*; the solver automatically adds a 200 mm torso radius to track the body center.
4. **EMA Filtering**: An Exponential Moving Average filter smooths the output. The smoothing factor $\alpha$ balances latency against jitter.

---

## Network Protocol

### Inbound Range Datagrams (UDP Port 5000)
The bridge listens on `UDP :5000` — the port used by the deployed ESP32 test
firmware (`esp_test_files/ESP_code/Box1`, `Box2`) — and accepts either wire
format it receives, auto-detected per datagram:

**Plain-text (current hardware, `esp_test_files/ESP_code`):**
```
Box:1,S1:120.5,S2:115.2
```
Box IDs are 1-indexed on the hardware; `Sn` values are centimetres to the
nearest surface, `-1` means no echo. The bridge normalises box IDs to
0-indexed and converts centimetres to millimetres internally.

**JSON (`firmware/molefield_sensor.ino`, not yet flashed):**
```json
{"box": 0, "t": 184213, "ranges": [1420, 1655], "batt": 5210}
```
* `ranges`: Distances in millimetres to the nearest reflective surface (`null` if no echo was detected).

### Setup Wizard
The game's `LIVE` position source opens an in-page setup wizard: enter the
bridge's WebSocket address, connect, and confirm each box shows a green
status dot with a live packet rate before starting a round. Box health
(alive / Hz / sender IP) rides along in the same WebSocket frames the bridge
already streams to the game.

### Slot Synchronization Beacon (UDP Port 4211)
The PC bridge broadcasts a slot synchronization beacon at ~15.6 Hz:
```
beacon ──▶ │ box0 s0 │ box0 s1 │ box1 s0 │ box1 s1 │ ...idle... │
            0 ms      16 ms     32 ms     48 ms     64 ms
```
Staggering sensor pings into distinct time slots prevents acoustic cross-talk and false echo detections. The deployed test firmware doesn't listen for this beacon yet — it's consumed only once boxes are reflashed with `firmware/molefield_sensor.ino`.

---

## Sensor Geometry Benchmark

Evaluate geometric error and coverage across different sensor arrangements:
```bash
python tools/layout_bench.py
```
Options:
- `--noise <mm>`: Standard deviation of ultrasonic range noise.
- `--dropout <pct>`: Percentage of dropped acoustic returns.
- `--beam <deg>`: Half-angle aperture of the ultrasonic cone.
- `--csv <file>`: Write spatial heat map data to CSV.
