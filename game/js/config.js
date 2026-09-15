"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Game Configuration & Physical Constants
   ENGG3000 SPINE · Full-Body Whack-a-Mole

   Coordinate system (all metres, physical):
     x : 0 .. 1.50   left -> right across the wall
     y : 0            at the wall/screen plane
         0 .. 0.60    DEAD ZONE (visual & audio alarm)
         0.60 .. 2.00 PLAY AREA (1.40 m active depth)
     Sensor boxes sit at y <= 0.50 (inside the dead zone strip,
     never inside the play area) as the brief requires.
   ══════════════════════════════════════════════════════════════ */

const AREA = {
  w: 1.50,           // Play area width in metres
  deep: 1.40,        // Play area depth in metres
  dead: 0.60,        // Dead zone depth from screen plane
  yNear: 0.60,       // Active play area near boundary
  yFar: 2.00,        // Active play area far boundary
  yVisTop: 0.20,     // Top visual boundary for rendering and mouse input
  bodyR: 0.20        // Modelled torso radius (surface to centre)
};

/* ── Acoustic beam model ──────────────────────────────────────
   `w` on each sensor below is the FULL cone width in degrees.
   Bearing convention throughout the codebase is atan2(dx, dy):
   0deg points straight out from the wall, POSITIVE turns toward +x.

   Widths follow the electrical design: 25° per sensor when a box
   upstreams two values, 50° per box when it upstreams one normalised
   value. Aims are reconstructed from the intended mounting rather
   than measured off the built hardware. Run sensortest.html,
   capture a calibration sweep, and paste the fitted values back
   in here before trusting any of the sector logic.
   ────────────────────────────────────────────────────────────── */
const BEAM = {
  defaultWidth: 40.0,  // Full cone width (deg) when a sensor omits `w`
  maxRange: 2.40,      // Hard ceiling from ECHO_TIMEOUT_US in the firmware
  minRange: 0.04       // Firmware rejects anything below this
};

/* ── Solver / filter tuning ───────────────────────────────────── */
const SOLVER = {
  medianWindow: 5,      // At most this many readings of one sensor are medianed
  medianMaxAgeMs: 500,  // ...and only readings this recent. A sensor that has
                        // gone quiet contributes just its last value, so a slow
                        // or irregular upstream is never outvoted by old copies.
  holdMismatchMs: 750,  // Two boxes' values this far apart in time get flagged
  measureHz: 15.6,      // Regular sim rate (the old slotted ping rate)

  /* ── Jitter control ────────────────────────────────────────────
     Players walk. These limits reject readings no walking person
     could produce, then average what is left. */
  maxRangeRate: 2.0,    // m/s — a sensor's range can't change faster than a brisk
                        // walk; a reading further from that sensor's last accepted
                        // value than (maxRangeRate × time since) + tolerance is
                        // ignored. 0 turns the range gate off.
  rangeGateTolM: 0.12,  // m — allowance for ordinary sensor noise on top of that
  rangeRejoinCount: 3,  // ...unless this many rejected readings in a row agree with
                        // each other: then the player really is there, so accept.
  averageMs: 1000,      // Cursor = time-weighted average position over this window
                        // while the player stands still. 0 = no averaging (alpha-beta).
  averageMinMs: 250,    // ...shrinking to this while they walk. A fixed 1 s average
                        // trails a walking player by ~45 cm; standing still on a mole
                        // is where steadiness matters, walking is where lag does.
  stillSpeed: 0.20,     // m/s — at or below: full window
  walkSpeed: 0.60,      // m/s — at or above: shortest window
  maxSpeed: 2.5,        // m/s — solved positions implying faster movement are rejected
  gateTimeoutMs: 600,   // ...but after this long we re-acquire anyway
  sectorTolDeg: 6.0,    // Slack before a fix is vetoed for leaving its cone
  maxGap: 0.35,         // m — circle separation above this is not a real fix
  pairSpreadWarn: 0.25  // m — co-located sensors disagreeing by more than this
};

const LAYOUTS = {
  "4lin": {
    name: "4 IN LINE",
    hint: "Two boxes, two sensors each, evenly spread in a straight line across the wall.",
    s: [
      { n: "0", x: 0.19, y: 0.30, a: 0, w: 40, box: 1, slot: 1 },
      { n: "1", x: 0.56, y: 0.30, a: 0, w: 40, box: 1, slot: 2 },
      { n: "2", x: 0.94, y: 0.30, a: 0, w: 40, box: 2, slot: 1 },
      { n: "3", x: 1.31, y: 0.30, a: 0, w: 40, box: 2, slot: 2 }
    ]
  },
  "2box4s": {
    name: "2 BOXES · 4 SENSORS (25°)",
    hint: "Four values upstreamed: Box 1 sends A and B, Box 2 sends X and Y. Each sensor covers 25°, and the two in a box are aimed 25° apart so together they tile the box's 50° field. Which of the pair fired tells the sector solver which half of the box's field the player is in.",
    s: [
      { n: "A", x: 0.00, y: 0.30, a:  26.85, w: 25, box: 1, slot: 1 },  // left box, forward half   14.35°–39.35°
      { n: "B", x: 0.00, y: 0.30, a:  51.85, w: 25, box: 1, slot: 2 },  // left box, wall-side half 39.35°–64.35°
      { n: "X", x: 1.50, y: 0.30, a: -51.85, w: 25, box: 2, slot: 1 },  // right box, wall-side half
      { n: "Y", x: 1.50, y: 0.30, a: -26.85, w: 25, box: 2, slot: 2 }   // right box, forward half
    ]
  },
  "2box2s": {
    name: "2 BOXES · 2 SENSORS (50°)",
    hint: "Two values upstreamed: each box normalises its pair of transducers into one reading covering 50°. Same field of view as the four-sensor setup, but each box only knows the player is somewhere in its 50° cone.",
    s: [
      { n: "L", x: 0.00, y: 0.30, a:  39.35, w: 50, box: 1, slot: 1 },  // left box  14.35°–64.35°
      { n: "R", x: 1.50, y: 0.30, a: -39.35, w: 50, box: 2, slot: 1 }   // right box
    ]
  },
  "4wide": {
    name: "4 SPLAYED",
    hint: "Outer pair splayed toward the middle. Wider usable footprint, but the beams overlap.",
    s: [
      { n: "0", x: 0.06, y: 0.30, a: 26, w: 40, box: 1, slot: 1 },
      { n: "1", x: 0.52, y: 0.30, a: 6, w: 40, box: 1, slot: 2 },
      { n: "2", x: 0.98, y: 0.30, a: -6, w: 40, box: 2, slot: 1 },
      { n: "3", x: 1.44, y: 0.30, a: -26, w: 40, box: 2, slot: 2 }
    ]
  }
};

LAYOUTS["2box"] = LAYOUTS["2box4s"];

/* ── Upstream formats ──────────────────────────────────────────
   Each box upstreams either ONE value (normalised on the box, one 50°
   sensor) or TWO values (two 25° sensors). The bridge detects which and
   tags every frame with the matching layout; these are the two layouts
   it can report. */
const VALUES_PER_BOX_LAYOUT = { 1: "2box2s", 2: "2box4s" };

/** Box groupings for a layout, derived from each sensor's `box` field. */
function boxesFor(layoutKey) {
  const sensors = LAYOUTS[layoutKey].s;
  const ids = [...new Set(sensors.map(s => s.box))].sort((a, b) => a - b);
  return ids.map((id, k) => ({
    id: id,
    label: "BOX " + id,
    side: ids.length === 2 ? (k === 0 ? "LEFT" : "RIGHT") : "",
    idx: sensors.map((s, i) => (s.box === id ? i : -1)).filter(i => i >= 0)
  }));
}

const LEVELS = [
  {
    n: 1,
    name: "Warm up",
    cols: 3,
    rows: 3, //2
    life: 5.0,//2.6
    dwell: 0.4,//0.50
    max: 1,
    target: 6,//6
    dur: 50,
    bombs: false,
    gold: false,
    desc: "Six holes, one mole at a time. Learn how the cursor answers your body."
  },
  {
    n: 2,
    name: "Faster moles",
    cols: 3,
    rows: 3,
    life: 4.5,
    dwell: 0.35,
    max: 2,
    target: 8,
    dur: 45,
    bombs: true,
    gold: true,
    desc: "Two moles can share the field, and gold ones are worth triple."
  },
  {
    n: 3,
    name: "Wider field",
    cols: 4,
    rows: 3,
    life: 4.0,
    dwell: 0.30,
    max: 2,
    target: 10,
    dur: 40,
    bombs: true,
    gold: true,
    desc: "Twelve holes now — and bombs. Sit on a bomb and you lose points and your streak."
  },
  {
    n: 4,
    name: "Twitch",
    cols: 4,
    rows: 3,
    life: 3.0,
    dwell: 0.3,
    max: 3,
    target: 12,
    dur: 35,
    bombs: true,
    gold: true,
    desc: "Three moles up at once. Plan the shortest path between them, don't chase."
  },
  {
    n: 5,
    name: "Endurance",
    cols: 4,
    rows: 3,
    life: 2.50,
    dwell: 0.3,
    max: 3,
    target: 14,
    dur: 30,
    bombs: true,
    gold: true,
    randomHoles: true,
    desc: "Fifteen holes, one minute, no mercy. This is the run you demo in week 13."
  }
];

const SRC_HINT = {
  mouse: "The mouse is the body. Sensors are simulated for the top view only — the game reads the pointer directly, so tracking is perfect. Use this to tune the game itself.",
  sim: "The mouse is the true body position. The game only sees noisy ultrasonic ranges — two or four, depending on the layout — and solves for you. This is the real pipeline, and the cyan dot is the unfiltered fix.",
  live: "Ranges come from your ESP32 boxes over a WebSocket. Same solver, same filter, real hardware."
};