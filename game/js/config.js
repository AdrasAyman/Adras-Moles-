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

   !! THESE ARE UNCALIBRATED DEFAULTS !!
   The 40deg width is a bench estimate, not a measurement, and the
   aim angles are reconstructed from the intended mounting rather
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
  medianWindow: 5,      // Samples of median filtering on each raw range
  measureHz: 15.6,      // True sensor ping rate; sim generates at this rate
  maxSpeed: 4.0,        // m/s — measurements implying more are rejected
  gateTimeoutMs: 500,   // ...but after this long we re-acquire anyway
  sectorTolDeg: 6.0,    // Slack before a fix is vetoed for leaving its cone
  maxGap: 0.35,         // m — circle separation above this is not a real fix
  pairSpreadWarn: 0.25  // m — co-located sensors disagreeing by more than this
};

const LAYOUTS = {
  "4lin": {
    name: "4 IN LINE",
    hint: "Two boxes, two sensors each, evenly spread in a straight line across the wall.",
    s: [
<<<<<<< HEAD
      { n: "0", x: 0.19, y: 0.30, a: 0, w: 40 },
      { n: "1", x: 0.56, y: 0.30, a: 0, w: 40 },
      { n: "2", x: 0.94, y: 0.30, a: 0, w: 40 },
      { n: "3", x: 1.31, y: 0.30, a: 0, w: 40 }
=======
      { x: 0.19, y: 0.30, a: 0, box: 1, slot: 1 },
      { x: 0.56, y: 0.30, a: 0, box: 1, slot: 2 },
      { x: 0.94, y: 0.30, a: 0, box: 2, slot: 1 },
      { x: 1.31, y: 0.30, a: 0, box: 2, slot: 2 }
>>>>>>> origin/main
    ]
  },
  "2box4s": {
    name: "2 CORNER BOXES (4 SENSORS)",
    hint: "The built rig. Box 0 (A,B) bottom-left, Box 1 (X,Y) bottom-right. Each sensor is ~40 deg wide but the pair is mounted only 25 deg apart, so each box covers ~65 deg with ~15 deg of overlap in the middle. That overlap is what gives the boolean sector solver three sectors per box instead of two.",
    s: [
<<<<<<< HEAD
      { n: "A", x: 0.00, y: 0.30, a:  26.85, w: 40 },  // left box, aimed forward
      { n: "B", x: 0.00, y: 0.30, a:  51.85, w: 40 },  // left box, aimed along the wall
      { n: "X", x: 1.50, y: 0.30, a: -51.85, w: 40 },  // right box, aimed along the wall
      { n: "Y", x: 1.50, y: 0.30, a: -26.85, w: 40 }   // right box, aimed forward
    ]
  },
  "2box": {
    name: "2 BOXES (2 SENSORS)",
    hint: "One sensor per box at the outer edges. Cheapest build; the far centre gets thin and the fit goes soft.",
    s: [
      { n: "L", x: 0.10, y: 0.30, a: 14, w: 40 },
      { n: "R", x: 1.40, y: 0.30, a: -14, w: 40 }
=======
      { x: 0.00, y: 0.30, a: 45.0, box: 1, slot: 1 },
      { x: 0.00, y: 0.30, a: -90.0, box: 1, slot: 2 },
      { x: 1.50, y: 0.30, a: 90.0, box: 2, slot: 1 },
      { x: 1.50, y: 0.30, a: -45.0, box: 2, slot: 2 }
>>>>>>> origin/main
    ]
  },
  "4wide": {
    name: "4 SPLAYED",
    hint: "Outer pair splayed toward the middle. Wider usable footprint, but the beams overlap.",
    s: [
<<<<<<< HEAD
      { n: "0", x: 0.06, y: 0.30, a: 26, w: 40 },
      { n: "1", x: 0.52, y: 0.30, a: 6, w: 40 },
      { n: "2", x: 0.98, y: 0.30, a: -6, w: 40 },
      { n: "3", x: 1.44, y: 0.30, a: -26, w: 40 }
=======
      { x: 0.06, y: 0.30, a: 26, box: 1, slot: 1 },
      { x: 0.52, y: 0.30, a: 6, box: 1, slot: 2 },
      { x: 0.98, y: 0.30, a: -6, box: 2, slot: 1 },
      { x: 1.44, y: 0.30, a: -26, box: 2, slot: 2 }
>>>>>>> origin/main
    ]
  }
};

LAYOUTS["2box"] = LAYOUTS["2box4s"];

const BOXES = [
  { id: 1, label: "BOX 1", side: "LEFT",  idx: [0, 1] },
  { id: 2, label: "BOX 2", side: "RIGHT", idx: [2, 3] }
];

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
  sim: "The mouse is the true body position. The game only sees four noisy ultrasonic ranges and solves for you. This is the real pipeline, and the cyan dot is the unfiltered fix.",
  live: "Ranges come from your ESP32 boxes over a WebSocket. Same solver, same filter, real hardware."
};