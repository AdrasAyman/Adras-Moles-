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

const LAYOUTS = {
  "4lin": {
    name: "4 IN LINE",
    hint: "Two boxes, two sensors each, evenly spread. Best lateral coverage, weakest depth resolution at the far corners.",
    s: [
      { x: 0.19, y: 0.30, a: 0 },
      { x: 0.56, y: 0.30, a: 0 },
      { x: 0.94, y: 0.30, a: 0 },
      { x: 1.31, y: 0.30, a: 0 }
    ]
  },
  "2box": {
    name: "2 BOXES",
    hint: "One sensor per box at the outer edges. Cheapest build; the far centre gets thin and the fit goes soft.",
    s: [
      { x: 0.10, y: 0.30, a: 14 },
      { x: 1.40, y: 0.30, a: -14 }
    ]
  },
  "4wide": {
    name: "4 SPLAYED",
    hint: "Outer pair splayed toward the middle. Wider usable footprint, but the beams overlap and cross-talk becomes real.",
    s: [
      { x: 0.06, y: 0.30, a: 26 },
      { x: 0.52, y: 0.30, a: 6 },
      { x: 0.98, y: 0.30, a: -6 },
      { x: 1.44, y: 0.30, a: -26 }
    ]
  }
};

const LEVELS = [
  {
    n: 1,
    name: "Warm up",
    cols: 3,
    rows: 2,
    life: 2.6,
    dwell: 0.50,
    max: 1,
    target: 6,
    dur: 45,
    bombs: false,
    gold: false,
    desc: "Six holes, one mole at a time. Learn how the cursor answers your body."
  },
  {
    n: 2,
    name: "Faster moles",
    cols: 3,
    rows: 2,
    life: 2.0,
    dwell: 0.45,
    max: 2,
    target: 10,
    dur: 45,
    bombs: false,
    gold: true,
    desc: "Two moles can share the field, and gold ones are worth triple."
  },
  {
    n: 3,
    name: "Wider field",
    cols: 4,
    rows: 3,
    life: 1.8,
    dwell: 0.40,
    max: 2,
    target: 14,
    dur: 45,
    bombs: true,
    gold: true,
    desc: "Twelve holes now — and bombs. Sit on a bomb and you lose points and your streak."
  },
  {
    n: 4,
    name: "Twitch",
    cols: 4,
    rows: 3,
    life: 1.4,
    dwell: 0.34,
    max: 3,
    target: 18,
    dur: 45,
    bombs: true,
    gold: true,
    desc: "Three moles up at once. Plan the shortest path between them, don't chase."
  },
  {
    n: 5,
    name: "Endurance",
    cols: 5,
    rows: 3,
    life: 1.15,
    dwell: 0.30,
    max: 3,
    target: 24,
    dur: 60,
    bombs: true,
    gold: true,
    desc: "Fifteen holes, one minute, no mercy. This is the run you demo in week 13."
  }
];

const SRC_HINT = {
  mouse: "The mouse is the body. Sensors are simulated for the top view only — the game reads the pointer directly, so tracking is perfect. Use this to tune the game itself.",
  sim: "The mouse is the true body position. The game only sees four noisy ultrasonic ranges and solves for you. This is the real pipeline, and the cyan dot is the unfiltered fix.",
  live: "Ranges come from your ESP32 boxes over a WebSocket. Same solver, same filter, real hardware. Opens the setup wizard to confirm both boxes are reporting."
};
