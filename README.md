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
│   ├── config.py             # Geometries, beam widths, solver tuning & defaults
│   ├── hub.py                # SensorHub datagram merger & staleness tracker
│   ├── sectors.py            # Boolean sector model & closed-form solver
│   ├── solver.py             # LEGACY least-squares solver (comparison only)
│   ├── simulator.py          # Synthetic walker kinematics & beam model
│   ├── websocket_server.py   # RFC 6455 WebSocket streaming server
│   ├── networking.py         # UDP range listener & slot sync broadcaster
│   ├── pipeline.py           # Frame pump & CSV telemetry recorder
│   └── cli.py                # Live console status monitor & CLI parser
│
├── game/                     # Browser game client (zero dependencies)
│   ├── index.html            # Clean semantic HTML markup
│   ├── sensortest.html       # Triangulation test bench (cones & calibration)
│   ├── css/
│   │   ├── style.css         # UI design system, radar & stage styles
│   │   └── sensortest.css    # Test bench layout
│   └── js/
│       ├── config.js         # Play area, beam model & solver tuning
│       ├── audio.js          # Web Audio procedural sound synthesizer
│       ├── sectors.js        # Boolean sector model & closed-form solver
│       ├── solver.js         # Beam simulation + LEGACY solver (comparison)
│       ├── tracker.js        # Mouse / sim / WebSocket tracking & filtering
│       ├── renderer.js       # 2D Canvas stage & mole animations
│       ├── radar.js          # Top-down radar & sensor arcs view
│       ├── game.js           # Whack-a-Mole rules, spawning & scoring
│       ├── sensortest.js     # Test bench: cones, calibration, diagnostics
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
* **ESP32 Box 0** automatically broadcasts its own Wi-Fi network: **`Molefield`** (Password: **`molefield123`**).
* **ESP32 Box 1** connects automatically to Box 0.
* Connect your Laptop / PC Wi-Fi to **`Molefield`**, then run:
```bash
python molefield.py
```
*(No external router, internet, or mobile hotspot required!)*

### 3. Record Telemetry to CSV
Record every frame and solved position for analysis and design reviews:
```bash
python molefield.py --log run1.csv
```
Columns: raw ranges, median-filtered ranges, solved `x`/`y`, `mode`
(`two-box` / `one-box` / `blind`), `sigma_mm` uncertainty, `gap_mm`,
`spread_mm`, `sector_miss_deg`, `residual_mm`, `veto` and a human-readable
`reason`.

### 4. Build Standalone Windows Executable
On any Windows PC with Python:
```cmd
build_windows.bat
```
Produces `dist\MOLEFIELD.exe` — a single self-contained executable that launches the bridge and opens the browser game without requiring Python on target laptops.

---

## Position Estimation

Each ultrasonic sensor gives two independent pieces of information, and the solver
uses both. The **range** puts you on a circle around that sensor. The fact that the
sensor **fired at all** puts you inside its cone — and the fact that its neighbour
stayed silent puts you outside *that* cone. The second kind of information is not
present in the range equations, which is exactly why it is worth having.

### 1. Median pre-filter
Each raw range passes through a median-of-5 (`SOLVER.medianWindow`). A median
*deletes* a cross-talk spike; a moving average would smear one fifth of it across
the next five frames. There is deliberately **no smoothing in the firmware** — the
EMA that used to live there cost ~180 ms of lag, about 70% of the whole latency
budget.

### 2. Boolean sectors
The two sensors in a box are ~40° wide but mounted only 25° apart, so they overlap
by ~15°. That splits each box into **three** angular sectors rather than two:

```
   A only  :  6.9° … 31.9°   (25° wide)
   A AND B : 31.9° … 46.9°   (15° wide)  <- tightest, most informative
   B only  : 46.9° … 71.9°   (25° wide)
```

Three left sectors × three right sectors = **nine boolean regions**. Fired sensors
intersect their cones; silent sensors carve theirs out.

### 3. Closed-form intersection
Two circles are solved directly rather than by grid search plus gradient descent:

```
d = ‖s₂ − s₁‖ ,  a = (d₁² − d₂² + d²)/(2d) ,  h = √(d₁² − a²)
p = s₁ + a·û ± h·n̂
```

This is exact, ~1000× cheaper, and — the part that matters — `h² < 0` exposes the
case where the two ranges **cannot both be true**. That failure is invisible to a
least-squares residual: with two sensors the system is exactly determined, so the
residual is identically zero no matter how wrong the answer is.

### 4. Candidate selection and the sector veto
Two circles meet at two mirrored points. The sector constraint picks between them,
with play-area membership and continuity as tie-breakers. A fix that then lands
outside the cone of a sensor that fired is **vetoed** — real error detection, using
information the ranges do not contain.

A disagreeing co-located pair is never averaged: one of the two is wrong, so the
mean is wrong too. Both readings are offered as competing hypotheses and the
cross-box geometry arbitrates.

### 5. One-box polar fallback
Sector gives a bearing, range gives a radius. That is a coarse fix from a **single**
box, so the cursor degrades instead of dying when only one box has line of sight.
It is drawn dashed and amber so a degraded cursor is never mistaken for a confident
one. Measured on the built layout this lifts the "cursor alive" rate from ~88% to
~99.5%.

### 6. Alpha-beta filter
The filter **predicts** every animation frame and **corrects** only when a new
measurement actually arrives — sensors ping at 15.6 Hz while the browser runs at
60 Hz, and treating each repeat as a fresh observation is what used to make the
cursor staircase. A velocity gate rejects measurements implying more than
`SOLVER.maxSpeed` (4 m/s), re-acquiring after `gateTimeoutMs` so a genuine
teleport cannot freeze the cursor permanently.

---

## Sensor Test Bench

`sensortest.html` — reachable from the **SENSOR TEST** button in the game header, or
directly at `http://localhost:8000/sensortest.html`.

It exists to answer the three questions the game itself cannot:

| Question | Where to look |
|---|---|
| How **far** does each sensor really reach? | `Max` column in the live sensor table — the furthest echo ever returned |
| How **wide** is each cone, really? | Measured beam width panel — bearing histogram of fired vs silent, with the configured cone drawn over it |
| **Why** did the solver produce that? | Solve panel — both intersection candidates, every sector, gap, spread, veto and reason, plus the old solver side by side |

### Calibrating a live rig
1. Switch source to **LIVE** and connect.
2. Stand on a marked spot. Click that spot on the field to place the truth marker.
3. Press **C** (or *Capture burst*) to record ~30 measurements there.
4. Repeat across 10–15 spots spread over the play area.
5. Press **Fit cones**, then **Copy config** and paste the result into
   `game/js/config.js` and `bridge/config.py`.

> The aim angles and 40° widths shipped in the config are **reconstructed
> defaults, not measurements**. Every sector result depends on them, so calibrate
> before trusting the boolean logic.

### Mis-calibration testing
Set *Sim beam width* away from 40° to sense at one width while the solver still
assumes the calibrated one. Watch the veto rate climb — that is the sector logic
detecting that its angular model no longer matches reality.

## Network Protocol

### Inbound Range Datagrams (UDP Port 4210)
Each ESP32 sensor box sends one JSON datagram per ping cycle:
```json
{"box": 0, "t": 184213, "ranges": [1420, 1655], "batt": 5210}
```
* `ranges`: Distances in millimetres to the nearest reflective surface (`null` if no echo was detected).

### Slot Synchronization Beacon (UDP Port 4211)
The PC bridge broadcasts a slot synchronization beacon at ~15.6 Hz:
```
beacon ──▶ │ box0 s0 │ box0 s1 │ box1 s0 │ box1 s1 │ ...idle... │
            0 ms      16 ms     32 ms     48 ms     64 ms
```
Staggering sensor pings into distinct time slots prevents acoustic cross-talk and false echo detections.

---

## Sensor Geometry Benchmark

Evaluate geometric error and coverage across different sensor arrangements:
```bash
python tools/layout_bench.py
```
It reports the legacy solver and the sector solver side by side, splitting the new
one into exact two-box fixes and coarse one-box fallbacks.

Options:
- `--noise <mm>`: Standard deviation of ultrasonic range noise.
- `--dropout <pct>`: Percentage of dropped acoustic returns.
- `--beam <deg>`: Override the **sensing** cone full-width. Omit it to sense with
  each sensor's calibrated `w`; set it to deliberately mis-calibrate.
- `--csv <file>`: Write spatial heat map data to CSV.
