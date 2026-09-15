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
│   ├── telemetry_db.py       # SQLite session store (samples + events)
│   ├── telemetry_api.py      # /api/ endpoints for recording & the logs page
│   ├── analysis.py           # Session summaries, chart series, trends
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
│   ├── logs.html             # Session history, charts, trends & exports
│   ├── css/
│   │   ├── style.css         # UI design system, radar & stage styles
│   │   ├── sensortest.css    # Test bench layout
│   │   └── logs.css          # Logs page layout & chart colour roles
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
│       ├── telemetry.js      # Records samples, game events & anomalies
│       ├── charts.js         # Dependency-free canvas charts for logs.html
│       ├── logs.js           # Logs page: history, session report, trends
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
Simulate the newer upstream styles too:
```bash
python molefield.py --simulate --sim-values 1                       # one 50° reading per box
python molefield.py --simulate --sim-values 2 --sim-timing irregular # box 1 ~10 Hz, box 2 at random
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
Which sensors in a box fired, and which stayed silent, constrains the bearing to an
angular sector. How much that tells you depends on what the box upstreams:

```
   Two values per box (4 × 25°), left box:
   A only : 14.4° … 39.4°   (25° wide)
   B only : 39.4° … 64.4°   (25° wide)

   One value per box (2 × 50°), left box:
   L      : 14.4° … 64.4°   (50° wide)
```

Both setups cover the same 50° per box, so a two-box fix is equally accurate either
way. The narrower sectors only matter when one box is blind, where they tighten the
one-box fallback. Cones that overlap would add a third, narrow sector per box.
Fired sensors intersect their cones; silent sensors carve theirs out.

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

### 6. Jitter control
Players walk, so anything implying faster movement is treated as a glitch. Three layers
work together, and every setting lives in `SOLVER` in `game/js/config.js`:

1. **Range gate** (`maxRangeRate` 2.0 m/s, `rangeGateTolM` 0.12 m). A sensor's new
   reading is ignored if it's further from that sensor's last accepted reading than a
   walker could move in the time since, plus a noise allowance. It never locks up: the
   allowance grows with time, and if 3 ignored readings in a row agree with each other
   (`rangeRejoinCount`), the player really did move and the reading is accepted. A "no
   echo" is never gated. Ignored readings show up in the logs as *Reading ignored*.
2. **Position gate** (`maxSpeed` 2.5 m/s). A solved position implying faster movement
   than this is rejected, re-acquiring after `gateTimeoutMs` so a real jump can't
   freeze the cursor.
3. **Adaptive averaging** (`averageMs` 1000, `averageMinMs` 250). The cursor is the
   time-weighted average position over the last second while the player stands
   still, and the window shrinks to 250 ms as they walk (between `stillSpeed` 0.2 and
   `walkSpeed` 0.6 m/s). Standing on a mole is when steadiness matters; walking to
   the next one is when lag matters. The game's sensor readouts are averaged over the
   same second. Set `averageMs` to 0 to use the old alpha-beta filter instead.

Measured on the sensor test page (simulator, 25 mm noise, 10% wild readings, averaged
over three runs; *wobble* is RMS cursor movement while standing still, *trail* is how
far the cursor lags a player walking at 0.6 m/s):

| Setup | Wobble, standing | Biggest jump, standing | Trail, walking |
|---|---|---|---|
| Before (no gates, alpha filter) | 25 mm | 39 mm | 187 mm |
| Range gate only | 21 mm | 34 mm | 204 mm |
| Gates + fixed 1 s average | 13 mm | 5 mm | 485 mm |
| **Gates + adaptive 1 s → 250 ms (default)** | 10 mm | 5 mm | 284 mm |

Try the settings live on the sensor test page: the *Wild readings*, *Walking speed
limit* and *Averaging window* sliders, with *Cursor wobble* in the Solve panel.

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

## Session Logs & Telemetry

Every visit to the game or the sensor test bench is recorded automatically while the
bridge is running. Open **LOGS** in either page's header, or
`http://localhost:8000/logs.html`.

The database is `logs/molefield.db` (SQLite, git-ignored). Use `--db FILE` to point
the bridge somewhere else. Recording can be paused with the **REC** badge next to LOGS.
A new session starts whenever the position source or sensor layout changes, so each
session is one consistent setup.

### What gets recorded
**Samples**, one per sensor measurement (~15.6 Hz; ~15 Hz from the pointer in mouse
mode, dropping to 1 Hz when nobody is using the page):

| Group | Columns |
|---|---|
| Sensors | `r0`–`r3` raw (latest held) range (mm), `m0`–`m3` median-filtered range (mm), `a0`–`a3` age of each sensor's value (ms) |
| Solver | `mode`, `sigma` (mm), `gap` (mm), `spread` (mm), `miss` (deg), `resid` (mm), `veto`, `split`, `conflict`, `gate` |
| Position | `x_raw`/`y_raw` solver fix, `x`/`y` filtered cursor, `tx`/`ty` ground truth (m) |
| System | `src`, `stale`, `meas_hz`, `fps`, `boxes_alive` |
| Game | `phase`, `score`, `level`, `alarm` |

Ground truth is known on the sensor test bench: the truth marker, or the pointer in
simulated mode. That is what makes the "error against ground truth" numbers possible.

**Events**, in four categories:
- **game**: `round_start`, `play_start`, `spawn`, `hit` (reaction time, cursor-to-hole
  distance, solver mode at the moment of the hit), `escape`, `level_complete`, `run_end`,
  `pause`/`resume`, `deadzone_enter`/`deadzone_exit`
- **anomaly**: see below
- **calibration**: `capture_start`/`capture_done`, `fit` (before/after aim and width
  per sensor), `tune`, `truth_set`, `export_csv`
- **system**: `session_start`, `ws_state`, `box_up`, `tab_hidden`/`tab_visible`, `page_hide`

### Anomaly definitions
| Anomaly | Detected when |
|---|---|
| Range spike | A raw reading is more than 300 mm from that sensor's own median |
| Sensor dropout | A sensor that had been echoing is silent for 5+ measurements (~320 ms) |
| No fix | No sensor returns an echo |
| Solver veto | Circles fail to intersect, or the fix leaves a firing sensor's cone |
| Pair disagreement | Co-located sensors disagree by more than 250 mm |
| Sector conflict | The set of firing sensors is impossible under the cone calibration |
| Position jump | The raw fix moves more than 0.6 m between measurements |
| Velocity gate | The tracker rejects movement faster than 4 m/s |
| Reading ignored | A reading changes faster than a walking player could move (range gate) |
| Long hold | A sensor goes 2 s or more without sending a new reading |
| Held-value mismatch | One solve combines readings taken 750 ms or more apart |
| Mixed value counts | One box sends one value while the other sends two |
| Stale data *(older sessions)* | Live frames stopped for more than 400 ms |
| Low measurement rate *(older sessions)* | Under 10 measurements/s for over 2 s |
| Low render rate | Under 30 fps for over 2 s |
| Box offline | The bridge stops hearing from a sensor box |
| Bad packets | The bridge receives datagrams it can't parse |

### The logs page
- **Session list**, filterable by page, source and length, and searchable by label and notes
- **Session report**: headline figures, sensor ranges over time, echo rates, range
  distributions, solve modes, uncertainty, circle gap, error against ground truth, a
  heat map of where the player stood (with hits and escapes), score, reaction times,
  per-level results, anomaly and game timelines, and a full filterable event log
- **Trends across sessions**: two-box share, uncertainty, veto rate, anomalies per
  minute, measurement rate, catch rate, reaction time and best score, session by session

Every chart has **TABLE** (the numbers behind it) and **PNG** (a titled image for a
report). Each session also exports **Samples CSV**, **Events CSV** and **Summary JSON**,
and **Copy summary** puts a plain-text summary on the clipboard. Label and notes
fields are saved with the session.

## Network Protocol

### Inbound Range Datagrams (UDP Port 5000)
Each sensor box sends a datagram **whenever it has a reading**. There is no required
rate, and the two boxes don't need to match: one can send ten times a second while
the other sends at random.

**One value or two.** A box sends either:
- **one** value, a reading already normalised on the box, treated as **one 50°
  sensor** per box (layout `2box2s`, sensors `L` and `R`), or
- **two** values, treated as **two 25° sensors** per box (layout `2box4s`, sensors
  `A`, `B` and `X`, `Y`).

The bridge detects which from the packets themselves, and the game and sensor test
page switch to match. It takes three consecutive packets with the new count from
every active box to switch, so one malformed packet can't flip the layout. If the two
boxes disagree, the current layout is kept and the logs flag "mixed value counts".

**Hold last value.** Each sensor's most recent reading is kept until that sensor
sends a new one, so the game always computes with the last value it received. Values
never expire unless you start the bridge with `--stale-ms N`. Each frame to the game
carries a per-sensor update counter and value age, so a held value is never mistaken
for a new reading. See the `Tracker` notes in `game/js/tracker.js`.

**JSON** (box `0` = left, `1` = right; readings in millimetres; `null` or `<= 0` = no echo):
```json
{"box": 0, "ranges": [1420, 1655]}
{"box": 0, "ranges": [1420]}
{"box": 0, "range": 1420}
```
Extra fields such as `"t"` or `"batt"` are ignored.

**Plain text** (box `1` = left, `2` = right; readings in centimetres; `-1` = no echo):
```
Box:1,S1:142.0,S2:165.5
Box:1,S1:142.0
```

The bridge still broadcasts the slot sync beacon on `UDP :4211` (below). Firmware may
use it to avoid cross-talk between boxes, but doesn't have to.

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
It reports the legacy solver and the sector solver side by side, splitting the new
one into exact two-box fixes and coarse one-box fallbacks.

Options:
- `--noise <mm>`: Standard deviation of ultrasonic range noise.
- `--dropout <pct>`: Percentage of dropped acoustic returns.
- `--beam <deg>`: Override the **sensing** cone full-width. Omit it to sense with
  each sensor's calibrated `w`; set it to deliberately mis-calibrate.
- `--csv <file>`: Write spatial heat map data to CSV.
