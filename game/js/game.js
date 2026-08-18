"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Game State & Rules Engine
   Manages rounds, levels, mole hole grids, spawning probabilities,
   dwell-to-whack mechanics, and scoring streaks.
   ══════════════════════════════════════════════════════════════ */

const G = {
  phase: "start", // "start" | "play" | "levelup" | "over" | "pause"
  li: 0,
  score: 0,
  streak: 1,
  missed: 0,
  hitsThisLevel: 0,
  t: 0,
  holes: [],
  moles: [],
  fx: [],
  dwell: 0,
  dwellTarget: null,
  alarm: false,
  alarmT: 0,
  totalHits: 0,
  totalShown: 0,
  bestStreak: 1
};

function buildHoles() {
  const L = LEVELS[G.li];
  G.holes = [];
  const mx = 0.16, my = 0.16; // Margins in normalized play-field units

  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      const u = L.cols === 1 ? 0.5 : mx + (c / (L.cols - 1)) * (1.0 - 2.0 * mx);
      const v = L.rows === 1 ? 0.5 : my + (r / (L.rows - 1)) * (1.0 - 2.0 * my);
      G.holes.push({
        u,
        v,
        x: u * AREA.w,
        y: AREA.yNear + v * AREA.deep,
        occupied: null
      });
    }
  }
}

function startLevel(i) {
  G.li = i;
  G.t = LEVELS[i].dur;
  G.hitsThisLevel = 0;
  G.moles = [];
  G.fx = [];
  G.dwell = 0;
  G.dwellTarget = null;
  buildHoles();
  G.phase = "play";
  spawn();
}

function resetRun() {
  G.score = 0;
  G.streak = 1;
  G.missed = 0;
  G.totalHits = 0;
  G.totalShown = 0;
  G.bestStreak = 1;
  startLevel(0);
}

function spawn() {
  const L = LEVELS[G.li];
  const free = G.holes.filter(h => !h.occupied);
  if (!free.length) return;

  const h = free[(Math.random() * free.length) | 0];
  let kind = "mole";
  const roll = Math.random();
  if (L.bombs && roll < 0.16) kind = "bomb";
  else if (L.gold && roll < 0.28) kind = "gold";

  const m = {
    hole: h,
    kind,
    life: L.life * (kind === "gold" ? 0.8 : 1.0) * (0.85 + Math.random() * 0.3),
    age: 0,
    state: "rise",
    pop: 0,
    dwell: 0,
    dead: false
  };

  h.occupied = m;
  G.moles.push(m);
  if (kind !== "bomb") G.totalShown++;
}

function hit(m) {
  const L = LEVELS[G.li];

  if (m.kind === "bomb") {
    G.score = Math.max(0, G.score - 15);
    G.streak = 1;
    Audio_.bomb();
    G.fx.push({
      type: "burst",
      x: m.hole.x,
      y: m.hole.y,
      t: 0,
      col: "#FF4D3D",
      text: "−15"
    });
    shake = 0.35;
  } else {
    const base = m.kind === "gold" ? 30 : 10;
    const pts = base * G.streak;
    G.score += pts;
    G.hitsThisLevel++;
    G.totalHits++;
    G.streak = Math.min(8, G.streak + 1);
    G.bestStreak = Math.max(G.bestStreak, G.streak);

    if (m.kind === "gold") Audio_.gold();
    else Audio_.whack();

    G.fx.push({
      type: "burst",
      x: m.hole.x,
      y: m.hole.y,
      t: 0,
      col: m.kind === "gold" ? "#FFB020" : "#9BE86B",
      text: "+" + pts
    });
  }

  m.dead = true;
  m.state = "hit";
  if (G.hitsThisLevel >= L.target) levelComplete();
}

function levelComplete() {
  if (G.li >= LEVELS.length - 1) {
    endRun("You cleared every level");
    return;
  }
  G.phase = "levelup";
  Audio_.level();
  Audio_.alarmOff();
  const dz = document.getElementById("dz");
  if (dz) dz.classList.remove("on");

  const nx = LEVELS[G.li + 1];
  const lvBig = document.getElementById("lvBig");
  const lvName = document.getElementById("lvName");
  const lvDesc = document.getElementById("lvDesc");

  if (lvBig) lvBig.textContent = nx.n;
  if (lvName) lvName.textContent = nx.name;
  if (lvDesc) lvDesc.textContent = nx.desc;

  showOverlay("#ovLevel");
}

function endRun(title) {
  G.phase = "over";
  Audio_.over();
  Audio_.alarmOff();
  const dz = document.getElementById("dz");
  if (dz) dz.classList.remove("on");

  const endTitle = document.getElementById("endTitle");
  const endScore = document.getElementById("endScore");
  const endStats = document.getElementById("endStats");

  if (endTitle) endTitle.textContent = title;
  if (endScore) endScore.textContent = G.score;

  const acc = G.totalShown ? Math.round((100 * G.totalHits) / G.totalShown) : 0;
  if (endStats) {
    endStats.textContent = `Level ${LEVELS[G.li].n} · ${G.totalHits} whacked · ${acc}% of moles caught · best streak ×${G.bestStreak}`;
  }

  showOverlay("#ovEnd");
}

function showOverlay(sel) {
  ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
    const el = document.querySelector(s);
    if (el) el.hidden = s !== sel;
  });
}

function hideAllOverlays() {
  ["#ovStart", "#ovLevel", "#ovEnd", "#ovPause", "#ovSetup"].forEach(s => {
    const el = document.querySelector(s);
    if (el) el.hidden = true;
  });
}
