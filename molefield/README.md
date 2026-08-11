# MOLEFIELD

Full-body Whack-a-Mole for ENGG3000 SPINE. A person moves in front of a screen,
four ultrasonic sensors work out where they are, and the game maps that to a
cursor on a field of moles.

Three pieces:

| Piece | What it is | Where |
|---|---|---|
| The game | One HTML file, no dependencies, runs in any browser | `game/index.html` |
| The bridge | Python, no dependencies, hosts the game and merges sensor data | `molefield.py` |
| The firmware | ESP32 sketch, one per sensor box | `firmware/molefield_sensor/` |

---

## Run it

**Without any hardware** — the whole chain, with a synthetic body walking the area:

```
python molefield.py --simulate
```

**With hardware:**

```
python molefield.py
```

Either way it opens the game in your browser, already switched to live mode.
Ctrl-C to stop.

**On a laptop with no Python:** run `build_windows.bat` once on any Windows
machine that does have Python. You get `dist\MOLEFIELD.exe` — a single file that
runs the bridge and opens the game with nothing installed. That is the
deliverable for "code can be downloaded and installed on a Windows laptop".

---

## How position is worked out

Each sensor reports a distance to the nearest surface. A single range says the
body is somewhere on an arc. Two arcs cross at a point. More arcs than that
rarely agree exactly, because every reading carries noise, so the solver finds
the point that disagrees with all of them as little as possible:

```
minimise  Σ ( ‖p − sᵢ‖ − dᵢ )²      over p in the play area
```

Coarse grid search first so we never land in a local minimum, then gradient
descent to refine. Ranges are measured to the *surface* of a body, so the solver
adds a 200 mm torso radius to get back to the centre before fitting.

The output goes through an exponential moving average. Low α is smooth and
laggy, high α is responsive and jittery — that slider is the single most
important trade-off in the system and you should have a number to defend for it.

The **fit residual** shown in the sidebar and logged to CSV is your health
metric: it is the RMS disagreement between the ranges and the solved position.
A residual that jumps from 10 mm to 80 mm means a sensor is lying, usually
cross-talk, and it is a much better fault signal than watching the cursor.

---

## Wire protocol

Each box sends one UDP datagram per cycle to port **4210**, JSON, ranges in
millimetres, `null` where no echo came back:

```json
{"box": 0, "t": 184213, "ranges": [1420, 1655], "batt": 5210}
```

`box` selects which global sensor indices this datagram fills. Default map is
box 0 → sensors 0,1 and box 1 → sensors 2,3; change it with
`--map "0:0,1 1:2,3"`.

The bridge merges boxes into one frame and pushes it to the game over
WebSocket at 30 Hz. A range older than 400 ms is dropped rather than reused,
so a dead box degrades the fit instead of freezing the cursor somewhere wrong.

### Ping slots

The bridge broadcasts a beacon on UDP **4211** about 15 times a second. Every
box waits for the beacon, then waits its own offset, then fires:

```
beacon ──▶ │ box0 s0 │ box0 s1 │ box1 s0 │ box1 s1 │ idle │
            0 ms      16 ms     32 ms     48 ms     64 ms
```

This exists because four ultrasonic sensors aimed at the same person will hear
each other's bursts. A sensor that catches a neighbour's echo reports a short,
confident, wrong range — and one wrong range drags the fit further off than one
missing range ever does. Slots cost update rate; cross-talk costs correctness.

**A worthwhile V2 optimisation:** sensors 0 and 3 sit at opposite ends and point
away from each other, so they can safely fire together. Same for 1 and 2. That
halves the cycle to 32 ms and doubles your update rate to ~31 Hz. Measure the
residual before and after — if it doesn't rise, you have earned the rate, and
you have a change-register entry with evidence behind it.

---

## Choosing a sensor layout

`tools/layout_bench.py` sweeps a grid of true positions, simulates ranges,
solves, and reports how often a fix was possible and how wrong it was.

```
python tools/layout_bench.py --beam 45
```

Results at ±45° beam, 8 mm noise, 3% dropout:

| layout | sensors | fix rate | mean echoes | median error | p90 |
|---|---|---|---|---|---|
| 4 in line | 4 | 96.9% | 3.25 | 13 mm | 37 mm |
| 2 boxes | 2 | 75.6% | 1.75 | 11 mm | 25 mm |
| **4 splayed** | 4 | **98.2%** | **3.74** | **9 mm** | **22 mm** |

Read the fix rate before the error. The two-sensor layout looks accurate, but
that number only counts the frames where a fix was possible at all — a quarter
of the time it has fewer than two echoes and the cursor is coasting on stale
data. Splaying the outer pair inward is the clear winner, and it costs nothing
but a mounting angle.

Whatever you pick, set it in **both** places: the game's sidebar and the
bridge's `--layout` flag. They must agree or the solver is fitting to sensors
that aren't where it thinks they are.

---

## Recording data for the design review

```
python molefield.py --log run1.csv
```

Every frame: timestamp, all four raw ranges, solved position, fit residual,
number of sensors contributing. It flushes as it goes, so closing the window
mid-run doesn't cost you the data. This is the file you plot when you have to
show V1-to-V2 improvement with evidence.

---

## Hardware notes

The RCWL-1601 runs on 3.3 V logic, so ECHO connects straight to an ESP32 pin —
no divider, unlike the 5 V HC-SR04 it otherwise resembles.

Set `BOX_ID` to 0 on the first box and 1 on the second before flashing. Two
boxes sharing an ID will fire in the same slot and cross-talk with each other,
which looks exactly like a flaky sensor and will cost you an afternoon.

The sketch reports pack voltage in every datagram. Log a full session and you
have your discharge curve for the one-hour battery benchmark without a separate
test rig.

For power: `WiFi.setSleep(true)` and reduced TX power are already set. If you
are still short of an hour, `setCpuFrequencyMhz(80)` is the next lever, and
after that it is the ping rate — every ping is a burst of current, and you may
not need 15 Hz once the smoothing filter is tuned.

---

## Gameplay decisions worth defending

**Dwell to whack.** There is no button and no hammer, so a whack is holding your
body over a mole for 300–500 ms. It is the only gesture ultrasound reads
reliably. A forward lunge would feel better but needs clean depth velocity,
which you will not get through a torso at this update rate.

**Mirrored cursor.** The player faces the screen, so left and right are flipped
like a reflection. Get this backwards in a demo and the game feels broken
instantly. It's the `MIRROR` constant in the game file.

**The alarm is not a game feature.** Dead-zone supervision runs off the tracker
directly, so it fires while paused, between levels and on the menu. Safety
interlocks that only work during normal operation are not safety interlocks.

---

## Ports

| Port | Direction | Purpose |
|---|---|---|
| 8000 TCP | bridge → browser | serves the game |
| 8765 TCP | bridge → browser | WebSocket sensor frames |
| 4210 UDP | boxes → bridge | range data |
| 4211 UDP | bridge → boxes | ping slot beacon |

All configurable — `python molefield.py --help`.
