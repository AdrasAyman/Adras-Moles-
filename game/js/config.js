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
    hint: "Two boxes, two sensors each, evenly spread in a straight line across the wall.",
    s: [
      { x: 0.19, y: 0.30, a: 0, box: 1, slot: 1 },
      { x: 0.56, y: 0.30, a: 0, box: 1, slot: 2 },
      { x: 0.94, y: 0.30, a: 0, box: 2, slot: 1 },
      { x: 1.31, y: 0.30, a: 0, box: 2, slot: 2 }
    ]
  },
  "2box4s": {
    name: "2 CORNER BOXES (4 SENSORS)",
    hint: "Box 0 on left, Box 1 on right. Sensor 0/2 faces 45° into the table, and Sensor 1/3 faces the wall along the edge (±90°).",
    s: [
      { x: 0.00, y: 0.30, a: 45.0, box: 1, slot: 1 },
      { x: 0.00, y: 0.30, a: -90.0, box: 1, slot: 2 },
      { x: 1.50, y: 0.30, a: 90.0, box: 2, slot: 1 },
      { x: 1.50, y: 0.30, a: -45.0, box: 2, slot: 2 }
    ]
  },
  "4wide": {
    name: "4 SPLAYED",
    hint: "Outer pair splayed toward the middle. Wider usable footprint, but the beams overlap.",
    s: [
      { x: 0.06, y: 0.30, a: 26, box: 1, slot: 1 },
      { x: 0.52, y: 0.30, a: 6, box: 1, slot: 2 },
      { x: 0.98, y: 0.30, a: -6, box: 2, slot: 1 },
      { x: 1.44, y: 0.30, a: -26, box: 2, slot: 2 }
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
    cols: 5,
    rows: 3,
    life: 2.50,
    dwell: 0.3,
    max: 3,
    target: 14,
    dur: 30,
    bombs: true,
    gold: true,
    desc: "Fifteen holes, one minute, no mercy. This is the run you demo in week 13."
  }
];

const SRC_HINT = {
  mouse: "The mouse is the body. Sensors are simulated for the top view only — the game reads the pointer directly, so tracking is perfect. Use this to tune the game itself.",
  sim: "The mouse is the true body position. The game only sees four noisy ultrasonic ranges and solves for you. This is the real pipeline, and the cyan dot is the unfiltered fix.",
  live: "Ranges come from your ESP32 boxes over a WebSocket. Same solver, same filter, real hardware."
};