"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Game Configuration & Physical Constants

   HARDWARE LAYOUT (fixed — 2 boxes, 2 sensors each):
     BOX 1  → FAR LEFT  edge → S0 (down-field) , S1 (across-field)
     BOX 2  → FAR RIGHT edge → S2 (down-field) , S3 (across-field)
   ══════════════════════════════════════════════════════════════ */

const AREA = {
  w: 1.50,
  deep: 1.40,
  dead: 0.60,
  yNear: 0.60,
  yFar: 2.00,
  yVisTop: 0.20,
  bodyR: 0.20
};

const LAYOUTS = {
  "2box": {
    name: "2 BOXES",
    hint: "Box 1 hard against the left edge, Box 2 hard against the right, two sensors side by side in each. In every box one sensor looks down the field and the other is splayed sharply across it, so the two cones together sweep the full 1.50 x 1.40 m area.",
    s: [
      { x: 0.04, y: 0.30, a:  17, box: 1, slot: 1 },
      { x: 0.11, y: 0.30, a:  54, box: 1, slot: 2 },
      { x: 1.46, y: 0.30, a: -17, box: 2, slot: 1 },
      { x: 1.39, y: 0.30, a: -54, box: 2, slot: 2 }
    ]
  }
};

/* Safety net: old code may still ask for "4lin" or "4wide".
   Point those at the same two-box layout so nothing can crash. */
LAYOUTS["4lin"]  = LAYOUTS["2box"];
LAYOUTS["4wide"] = LAYOUTS["2box"];

const BOXES = [
  { id: 1, label: "BOX 1", side: "LEFT",  idx: [0, 1] },
  { id: 2, label: "BOX 2", side: "RIGHT", idx: [2, 3] }
];

const LEVELS = [
  { n: 1, name: "Warm up",      cols: 3, rows: 2, life: 2.60, dwell: 0.50, max: 1, target: 6,  dur: 45, bombs: false, gold: false, desc: "Six holes, one mole at a time. Learn how the cursor answers your body." },
  { n: 2, name: "Faster moles", cols: 3, rows: 2, life: 2.00, dwell: 0.45, max: 2, target: 10, dur: 45, bombs: false, gold: true,  desc: "Two moles can share the field, and gold ones are worth triple." },
  { n: 3, name: "Wider field",  cols: 4, rows: 3, life: 1.80, dwell: 0.40, max: 2, target: 14, dur: 45, bombs: true,  gold: true,  desc: "Twelve holes now — and bombs. Sit on a bomb and you lose points and your streak." },
  { n: 4, name: "Twitch",       cols: 4, rows: 3, life: 1.40, dwell: 0.34, max: 3, target: 18, dur: 45, bombs: true,  gold: true,  desc: "Three moles up at once. Plan the shortest path between them, don't chase." },
  { n: 5, name: "Endurance",    cols: 5, rows: 3, life: 1.15, dwell: 0.30, max: 3, target: 24, dur: 60, bombs: true,  gold: true,  desc: "Fifteen holes, one minute, no mercy. This is the run you demo in week 13." }
];

const SRC_HINT = {
  mouse: "The mouse is the body. The four ranges shown are modelled from the pointer for the top view only — the game reads the pointer directly, so tracking is perfect. Use this to tune the game itself.",
  live: "Ranges come from Box 1 and Box 2 over the WebSocket bridge. Four real ultrasonic ranges in, one solved body position out. Opens the setup wizard so you can confirm both boxes are reporting."
};