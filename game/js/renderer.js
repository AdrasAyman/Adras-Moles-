// "use strict";
// /* ══════════════════════════════════════════════════════════════
//    MOLEFIELD — 2D Stage Canvas Renderer
//    Handles coordinate transformations and draws the play turf,
//    holes, animated moles, particle effects, and cursor tracking.
//    ══════════════════════════════════════════════════════════════ */

// let VIEW = { x: 0, y: 0, w: 0, h: 0, scale: 1, cw: 0, ch: 0 };
// const MIRROR = true; // Player faces the screen; cursor mirrors like a reflection
// let shake = 0;

// function fitStage() {
//   const stage = document.getElementById("stage");
//   if (!stage || !stage.parentElement) return;

//   const sctx = stage.getContext("2d");
//   const r = stage.parentElement.getBoundingClientRect();
//   const dpr = Math.min(2, window.devicePixelRatio || 1);

//   stage.width = Math.max(1, r.width * dpr);
//   stage.height = Math.max(1, r.height * dpr);
//   sctx.setTransform(dpr, 0, 0, dpr, 0, 0);

//   // Visible physical extent: full width, from yVisTop to yFar
//   const pw = AREA.w;
//   const ph = AREA.yFar - AREA.yVisTop;
//   const scale = Math.min(r.width / pw, r.height / ph);

//   VIEW = {
//     w: pw * scale,
//     h: ph * scale,
//     scale: scale,
//     x: (r.width - pw * scale) / 2.0,
//     y: (r.height - ph * scale) / 2.0,
//     cw: r.width,
//     ch: r.height
//   };
// }

// function toPx(x, y) {
//   const u = MIRROR ? 1.0 - x / AREA.w : x / AREA.w;
//   return [
//     VIEW.x + u * VIEW.w,
//     VIEW.y + ((y - AREA.yVisTop) / (AREA.yFar - AREA.yVisTop)) * VIEW.h
//   ];
// }

// function fromPx(px, py) {
//   let u = (px - VIEW.x) / VIEW.w;
//   if (MIRROR) u = 1.0 - u;
//   return {
//     x: Math.max(-0.05, Math.min(AREA.w + 0.05, u * AREA.w)),
//     y: Math.max(
//       AREA.yVisTop,
//       Math.min(
//         AREA.yFar,
//         AREA.yVisTop + ((py - VIEW.y) / VIEW.h) * (AREA.yFar - AREA.yVisTop)
//       )
//     )
//   };
// }

// function drawStage(dt) {
//   const stage = document.getElementById("stage");
//   if (!stage) return;
//   const sctx = stage.getContext("2d");
//   const W = VIEW.cw;
//   const H = VIEW.ch;

//   sctx.clearRect(0, 0, W, H);
//   sctx.save();

//   if (shake > 0) {
//     sctx.translate(
//       (Math.random() - 0.5) * shake * 18,
//       (Math.random() - 0.5) * shake * 18
//     );
//     shake = Math.max(0, shake - dt * 1.6);
//   }

//   // ── Backdrop ──
//   sctx.fillStyle = "#070A0C";
//   sctx.fillRect(-30, -30, W + 60, H + 60);

//   const [gx0, gy0] = toPx(0, AREA.yNear);
//   const [gx1, gy1] = toPx(AREA.w, AREA.yFar);
//   const left = Math.min(gx0, gx1);
//   const right = Math.max(gx0, gx1);

//   // ── Dead Zone Strip (0.20m to 0.60m from wall) ──
//   const [, dyTop] = toPx(0, AREA.yVisTop);
//   const [, dyBot] = toPx(0, AREA.yNear);
//   const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120.0);

//   sctx.fillStyle = G.alarm
//     ? `rgba(255,77,61,${0.25 + 0.3 * pulse})`
//     : "rgba(255,77,61,.10)";
//   sctx.fillRect(left, dyTop, right - left, dyBot - dyTop);

//   sctx.save();
//   sctx.strokeStyle = G.alarm ? "#FF4D3D" : "rgba(255,77,61,.35)";
//   sctx.lineWidth = 2;
//   sctx.setLineDash([10, 8]);
//   sctx.beginPath();
//   sctx.moveTo(left, dyBot);
//   sctx.lineTo(right, dyBot);
//   sctx.stroke();
//   sctx.restore();

//   sctx.fillStyle = G.alarm ? "#fff" : "rgba(255,77,61,.55)";
//   sctx.font = "600 11px 'JetBrains Mono',ui-monospace,monospace";
//   sctx.textAlign = "center";
//   sctx.fillText(
//     "DEAD ZONE · 0.60 m FROM SCREEN",
//     (left + right) / 2.0,
//     dyTop + (dyBot - dyTop) / 2.0 + 4
//   );

//   // ── Play Turf ──
//   const grad = sctx.createLinearGradient(0, gy0, 0, gy1);
//   grad.addColorStop(0, "#2F7522");
//   grad.addColorStop(1, "#4CA637");
//   sctx.fillStyle = grad;
//   sctx.fillRect(left, Math.min(gy0, gy1), right - left, Math.abs(gy1 - gy0));

//   // Depth calibration stripes every 20 cm
//   sctx.strokeStyle = "rgba(255,255,255,.05)";
//   sctx.lineWidth = 1;
//   for (let d = AREA.yNear; d <= AREA.yFar + 1e-6; d += 0.20) {
//     const [, py] = toPx(0, d);
//     sctx.beginPath();
//     sctx.moveTo(left, py);
//     sctx.lineTo(right, py);
//     sctx.stroke();
//   }

//   const holeR = Math.max(16, VIEW.scale * 0.13);

//   // ── Holes ──
//   for (const h of G.holes) {
//     const [hx, hy] = toPx(h.x, h.y);
//     sctx.save();
//     sctx.translate(hx, hy);
//     sctx.fillStyle = "#20140A";
//     sctx.beginPath();
//     sctx.ellipse(0, 0, holeR, holeR * 0.46, 0, 0, 7);
//     sctx.fill();

//     sctx.fillStyle = "rgba(0,0,0,.55)";
//     sctx.beginPath();
//     sctx.ellipse(0, -holeR * 0.05, holeR * 0.86, holeR * 0.36, 0, 0, 7);
//     sctx.fill();
//     sctx.restore();
//   }

//   // ── Moles ──
//   for (const m of G.moles) {
//     const [hx, hy] = toPx(m.hole.x, m.hole.y);
//     const up = m.pop * holeR * 1.05;
//     sctx.save();
//     sctx.beginPath();
//     sctx.ellipse(hx, hy, holeR * 1.02, holeR * 0.5, 0, 0, 7);
//     sctx.rect(hx - holeR * 1.2, hy - holeR * 3, holeR * 2.4, holeR * 3);
//     sctx.clip();
//     sctx.translate(hx, hy - up);

//     const bodyCol =
//       m.kind === "gold" ? "#E8B23A" : m.kind === "bomb" ? "#232A31" : "#A9662F";
//     const bellyCol =
//       m.kind === "gold" ? "#F6D98A" : m.kind === "bomb" ? "#39434D" : "#C98A54";
//     const r = holeR * 0.72;

//     sctx.fillStyle = bodyCol;
//     sctx.beginPath();
//     sctx.ellipse(0, 0, r * 0.95, r * 1.05, 0, Math.PI, 0);
//     sctx.rect(-r * 0.95, 0, r * 1.9, r * 1.4);
//     sctx.fill();

//     sctx.fillStyle = bellyCol;
//     sctx.beginPath();
//     sctx.ellipse(0, r * 0.25, r * 0.55, r * 0.62, 0, 0, 7);
//     sctx.fill();

//     if (m.kind === "bomb") {
//       sctx.strokeStyle = "#FFB020";
//       sctx.lineWidth = Math.max(2, r * 0.11);
//       sctx.lineCap = "round";
//       sctx.beginPath();
//       sctx.moveTo(0, -r * 0.95);
//       sctx.quadraticCurveTo(r * 0.4, -r * 1.5, r * 0.15, -r * 1.75);
//       sctx.stroke();

//       sctx.fillStyle = "#FF4D3D";
//       sctx.beginPath();
//       sctx.arc(
//         r * 0.15,
//         -r * 1.8,
//         r * 0.16 * (1 + 0.3 * Math.sin(performance.now() / 60.0)),
//         0,
//         7
//       );
//       sctx.fill();

//       sctx.fillStyle = "#0B0E11";
//       sctx.beginPath();
//       sctx.arc(-r * 0.3, -r * 0.15, r * 0.13, 0, 7);
//       sctx.arc(r * 0.3, -r * 0.15, r * 0.13, 0, 7);
//       sctx.fill();
//     } else {
//       // Eyes
//       sctx.fillStyle = "#1A1008";
//       sctx.beginPath();
//       sctx.arc(-r * 0.3, -r * 0.3, r * 0.12, 0, 7);
//       sctx.arc(r * 0.3, -r * 0.3, r * 0.12, 0, 7);
//       sctx.fill();

//       // Snout
//       sctx.fillStyle = "#F0C39A";
//       sctx.beginPath();
//       sctx.ellipse(0, r * 0.12, r * 0.32, r * 0.26, 0, 0, 7);
//       sctx.fill();

//       sctx.fillStyle = "#5A3418";
//       sctx.beginPath();
//       sctx.ellipse(0, r * 0.02, r * 0.12, r * 0.09, 0, 0, 7);
//       sctx.fill();

//       // Whiskers
//       sctx.strokeStyle = "rgba(40,24,10,.6)";
//       sctx.lineWidth = Math.max(1, r * 0.045);
//       for (const sgn of [-1, 1]) {
//         for (const dy of [-0.04, 0.08]) {
//           sctx.beginPath();
//           sctx.moveTo(sgn * r * 0.28, r * (0.1 + dy));
//           sctx.lineTo(sgn * r * 0.85, r * (0.02 + dy * 1.6));
//           sctx.stroke();
//         }
//       }
//     }
//     if (m.kind === "prof") drawProfMole(sctx, r);
//     sctx.restore();

//     // Dwell ring on targeted mole
//     if (m.dwell > 0.01 && !m.dead) {
//       const L = LEVELS[G.li];
//       sctx.save();
//       sctx.translate(hx, hy - up);
//       sctx.strokeStyle = "rgba(255,255,255,.25)";
//       sctx.lineWidth = Math.max(3, holeR * 0.13);
//       sctx.beginPath();
//       sctx.arc(0, 0, holeR * 0.95, 0, 7);
//       sctx.stroke();

//       sctx.strokeStyle = m.kind === "bomb" ? "#FF4D3D" : "#9BE86B";
//       sctx.lineCap = "round";
//       sctx.beginPath();
//       sctx.arc(
//         0,
//         0,
//         holeR * 0.95,
//         -Math.PI / 2,
//         -Math.PI / 2 + (7 * (m.dwell / L.dwell)) / 1.114
//       );
//       sctx.stroke();
//       sctx.restore();
//     }
//   }

//   // ── Score & Effect Bursts ──
//   for (const f of G.fx) {
//     const [fx, fy] = toPx(f.x, f.y);
//     const k = f.t / 0.6;
//     sctx.save();
//     sctx.globalAlpha = Math.max(0, 1.0 - k);
//     sctx.strokeStyle = f.col;
//     sctx.lineWidth = Math.max(2, holeR * 0.12 * (1.0 - k));
//     sctx.beginPath();
//     sctx.arc(fx, fy, holeR * (0.5 + k * 1.6), 0, 7);
//     sctx.stroke();

//     sctx.fillStyle = f.col;
//     sctx.font = `700 ${Math.max(16, holeR * 0.62)}px 'Bahnschrift','DIN Alternate',sans-serif`;
//     sctx.textAlign = "center";
//     sctx.fillText(f.text, fx, fy - holeR - k * 44);
//     sctx.restore();
//   }

//   // ── Player Cursor ──
//   if (Tracker.pos) {
//     const [cx, cy] = toPx(Tracker.pos.x, Tracker.pos.y);
//     const R = holeR * 0.8;
//     sctx.save();
//     if (Tracker.stale) {
//       sctx.globalAlpha = 0.35;
//     }
//     // A one-box polar fix is a real fix but a coarse one (a couple of hundred
//     // mm rather than a couple of dozen). Draw it dashed and amber so nobody
//     // mistakes a degraded cursor for a confident one during testing.
//     const degraded = Tracker.mode === "one-box" || (Tracker.veto && !(Tracker.fix && Tracker.fix.vetoSoft));
//     sctx.strokeStyle = G.alarm ? "#FF4D3D"
//                      : Tracker.veto ? "#FF4D3D"
//                      : degraded ? "#FFB020"
//                      : "rgba(255,255,255,.9)";
//     sctx.lineWidth = 3;
//     if (degraded) sctx.setLineDash([6, 5]);
//     sctx.beginPath();
//     sctx.arc(cx, cy, R, 0, 7);
//     sctx.stroke();
//     sctx.setLineDash([]);

//     sctx.fillStyle = G.alarm ? "rgba(255,77,61,.25)"
//                    : degraded ? "rgba(255,176,32,.14)"
//                    : "rgba(255,255,255,.14)";
//     sctx.beginPath();
//     sctx.arc(cx, cy, R, 0, 7);
//     sctx.fill();

//     // Uncertainty halo: how far the solver thinks it could actually be.
//     if (Tracker.src !== "mouse" && isFinite(Tracker.sigma) && Tracker.sigma > 0.05) {
//       const [ex] = toPx(Tracker.pos.x + Tracker.sigma, Tracker.pos.y);
//       sctx.strokeStyle = "rgba(255,176,32,.30)";
//       sctx.lineWidth = 1.5;
//       sctx.beginPath();
//       sctx.arc(cx, cy, Math.abs(ex - cx), 0, 7);
//       sctx.stroke();
//     }

//     sctx.beginPath();
//     sctx.moveTo(cx - R * 0.45, cy);
//     sctx.lineTo(cx + R * 0.45, cy);
//     sctx.moveTo(cx, cy - R * 0.45);
//     sctx.lineTo(cx, cy + R * 0.45);
//     sctx.stroke();

//     // Raw (unfiltered) marker to visualize smoothing trade-off
//     if (Tracker.raw && Tracker.src !== "mouse") {
//       const [rx, ry] = toPx(Tracker.raw.x, Tracker.raw.y);
//       sctx.fillStyle = "rgba(69,208,232,.75)";
//       sctx.beginPath();
//       sctx.arc(rx, ry, 4, 0, 7);
//       sctx.fill();
//     }
//     sctx.restore();
//   }

//   sctx.restore();
// }
// // ── Professor mole ("Iain") ──
// // Drawn at the mole's centre with radius r, in the same coordinate frame as the
// // normal mole. It paints over the whole mole body, so it can be called after the
// // normal mole has been drawn.
// function drawProfMole(c, r) {
//   const skin = "#E2A37F", skinShade = "#C98462";
//   const hair = "#B7B2AB", hairDark = "#8D8882";

//   // Body shape (same outline as the normal mole), filled with a navy shirt
//   c.fillStyle = "#2C3E5C";
//   c.beginPath();
//   c.ellipse(0, 0, r * 0.95, r * 1.05, 0, Math.PI, 0);
//   c.rect(-r * 0.95, 0, r * 1.9, r * 1.4);
//   c.fill();

//   // Ears
//   c.fillStyle = skinShade;
//   c.beginPath();
//   c.ellipse(-r * 0.86, -r * 0.22, r * 0.14, r * 0.2, 0, 0, 7);
//   c.ellipse(r * 0.86, -r * 0.22, r * 0.14, r * 0.2, 0, 0, 7);
//   c.fill();

//   // Head
//   c.fillStyle = skin;
//   c.beginPath();
//   c.ellipse(0, -r * 0.18, r * 0.82, r * 0.9, 0, 0, 7);
//   c.fill();

//   // White shirt collar
//   c.fillStyle = "#F4F1EA";
//   c.beginPath();
//   c.moveTo(-r * 0.5, r * 0.62);
//   c.lineTo(0, r * 0.95);
//   c.lineTo(-r * 0.12, r * 1.15);
//   c.lineTo(-r * 0.62, r * 0.82);
//   c.closePath();
//   c.moveTo(r * 0.5, r * 0.62);
//   c.lineTo(0, r * 0.95);
//   c.lineTo(r * 0.12, r * 1.15);
//   c.lineTo(r * 0.62, r * 0.82);
//   c.closePath();
//   c.fill();

//   // Short grey hair, slightly higher at the temples
//   c.save();
//   c.beginPath();
//   c.ellipse(0, -r * 0.18, r * 0.84, r * 0.92, 0, 0, 7);
//   c.clip();
//   c.fillStyle = hair;
//   c.beginPath();
//   c.moveTo(-r, -r * 0.2);
//   c.lineTo(-r * 0.78, -r * 0.42);
//   c.quadraticCurveTo(-r * 0.55, -r * 0.62, -r * 0.42, -r * 0.7);
//   c.quadraticCurveTo(0, -r * 0.6, r * 0.42, -r * 0.7);
//   c.quadraticCurveTo(r * 0.55, -r * 0.62, r * 0.78, -r * 0.42);
//   c.lineTo(r, -r * 0.2);
//   c.lineTo(r, -r * 1.3);
//   c.lineTo(-r, -r * 1.3);
//   c.closePath();
//   c.fill();
//   // salt-and-pepper texture
//   c.strokeStyle = hairDark;
//   c.lineWidth = Math.max(1, r * 0.04);
//   c.lineCap = "round";
//   for (let i = -3; i <= 3; i++) {
//     const x = i * r * 0.2;
//     c.beginPath();
//     c.moveTo(x - r * 0.04, -r * 0.82 - Math.abs(i) * r * 0.01);
//     c.lineTo(x + r * 0.05, -r * 0.98);
//     c.stroke();
//   }
//   c.restore();

//   // Eyebrows
//   c.strokeStyle = "#6F6A64";
//   c.lineWidth = Math.max(1.5, r * 0.07);
//   c.lineCap = "round";
//   c.beginPath();
//   c.moveTo(-r * 0.56, -r * 0.5);
//   c.quadraticCurveTo(-r * 0.36, -r * 0.6, -r * 0.14, -r * 0.5);
//   c.moveTo(r * 0.14, -r * 0.5);
//   c.quadraticCurveTo(r * 0.36, -r * 0.6, r * 0.56, -r * 0.5);
//   c.stroke();

//   // Happy, slightly squinting eyes
//   c.strokeStyle = "#2A1A10";
//   c.lineWidth = Math.max(1.5, r * 0.07);
//   c.beginPath();
//   c.arc(-r * 0.34, -r * 0.24, r * 0.1, Math.PI * 1.1, Math.PI * 1.9);
//   c.moveTo(r * 0.24, -r * 0.27);
//   c.arc(r * 0.34, -r * 0.24, r * 0.1, Math.PI * 1.1, Math.PI * 1.9);
//   c.stroke();

//   // Thick black rectangular glasses
//   const gw = r * 0.5, gh = r * 0.34, gy = -r * 0.42, rad = r * 0.08;
//   c.strokeStyle = "#111";
//   c.lineWidth = Math.max(2, r * 0.11);
//   c.lineJoin = "round";
//   for (const cx of [-r * 0.34, r * 0.34]) {
//     c.beginPath();
//     c.roundRect(cx - gw / 2, gy, gw, gh, rad);
//     c.stroke();
//   }
//   c.beginPath();
//   c.moveTo(-r * 0.09, gy + gh * 0.35);
//   c.lineTo(r * 0.09, gy + gh * 0.35);           // bridge
//   c.moveTo(-r * 0.59, gy + gh * 0.3);
//   c.lineTo(-r * 0.8, gy + gh * 0.2);            // arms
//   c.moveTo(r * 0.59, gy + gh * 0.3);
//   c.lineTo(r * 0.8, gy + gh * 0.2);
//   c.stroke();

//   // Mole nose, so he's still a mole
//   c.fillStyle = "#C9605A";
//   c.beginPath();
//   c.ellipse(0, r * 0.06, r * 0.12, r * 0.09, 0, 0, 7);
//   c.fill();

//   // Big toothy grin
//   c.fillStyle = "#5A1E1E";
//   c.beginPath();
//   c.moveTo(-r * 0.4, r * 0.24);
//   c.quadraticCurveTo(0, r * 0.3, r * 0.4, r * 0.24);
//   c.quadraticCurveTo(r * 0.32, r * 0.58, 0, r * 0.6);
//   c.quadraticCurveTo(-r * 0.32, r * 0.58, -r * 0.4, r * 0.24);
//   c.fill();
//   c.save();
//   c.clip();
//   c.fillStyle = "#FFFFFF";
//   c.fillRect(-r * 0.45, r * 0.2, r * 0.9, r * 0.17);
//   c.restore();

//   // Little pink mole paws resting on the hole edge
//   for (const sgn of [-1, 1]) {
//     const px = sgn * r * 0.6, py = r * 1.12;
//     c.fillStyle = "#E8A9A0";
//     c.beginPath();
//     c.ellipse(px, py, r * 0.26, r * 0.16, 0, 0, 7);
//     c.fill();
//     c.strokeStyle = "#F7EDE6";
//     c.lineWidth = Math.max(1, r * 0.05);
//     c.lineCap = "round";
//     for (const k of [-1, 0, 1]) {
//       c.beginPath();
//       c.moveTo(px + k * r * 0.11, py - r * 0.1);
//       c.lineTo(px + k * r * 0.13, py - r * 0.22);
//       c.stroke();
//     }
//   }

//   // Whiskers
//   c.strokeStyle = "rgba(60,30,20,.55)";
//   c.lineWidth = Math.max(1, r * 0.04);
//   for (const sgn of [-1, 1]) {
//     for (const dy of [-0.03, 0.06]) {
//       c.beginPath();
//       c.moveTo(sgn * r * 0.2, r * (0.08 + dy));
//       c.lineTo(sgn * r * 0.58, r * (0.02 + dy * 1.6));
//       c.stroke();
//     }
//   }
// }

"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — 2D Stage Canvas Renderer
   Handles coordinate transformations and draws the play turf,
   holes, animated moles, particle effects, and cursor tracking.
   ══════════════════════════════════════════════════════════════ */

let VIEW = { x: 0, y: 0, w: 0, h: 0, scale: 1, cw: 0, ch: 0 };
const MIRROR = true; // Player faces the screen; cursor mirrors like a reflection
let shake = 0;
let lastHits = 0;
let hitPulse = 0;

function fitStage() {
  const stage = document.getElementById("stage");
  if (!stage || !stage.parentElement) return;

  const sctx = stage.getContext("2d");
  const r = stage.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  stage.width = Math.max(1, r.width * dpr);
  stage.height = Math.max(1, r.height * dpr);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Visible physical extent: full width, from yVisTop to yFar
  const pw = AREA.w;
  const ph = AREA.yFar - AREA.yVisTop;
  const scale = Math.min(r.width / pw, r.height / ph);

  VIEW = {
    w: pw * scale,
    h: ph * scale,
    scale: scale,
    x: (r.width - pw * scale) / 2.0,
    y: (r.height - ph * scale) / 2.0,
    cw: r.width,
    ch: r.height
  };
}

function toPx(x, y) {
  const u = MIRROR ? 1.0 - x / AREA.w : x / AREA.w;
  return [
    VIEW.x + u * VIEW.w,
    VIEW.y + ((y - AREA.yVisTop) / (AREA.yFar - AREA.yVisTop)) * VIEW.h
  ];
}

function fromPx(px, py) {
  let u = (px - VIEW.x) / VIEW.w;
  if (MIRROR) u = 1.0 - u;
  return {
    x: Math.max(-0.05, Math.min(AREA.w + 0.05, u * AREA.w)),
    y: Math.max(
      AREA.yVisTop,
      Math.min(
        AREA.yFar,
        AREA.yVisTop + ((py - VIEW.y) / VIEW.h) * (AREA.yFar - AREA.yVisTop)
      )
    )
  };
}

function drawStage(dt) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const sctx = stage.getContext("2d");
  const W = VIEW.cw;
  const H = VIEW.ch;

  sctx.clearRect(0, 0, W, H);
  sctx.save();

  if (shake > 0) {
    sctx.translate(
      (Math.random() - 0.5) * shake * 18,
      (Math.random() - 0.5) * shake * 18
    );
    shake = Math.max(0, shake - dt * 1.6);
  }

  // ── Backdrop ──
  sctx.fillStyle = "#070A0C";
  sctx.fillRect(-30, -30, W + 60, H + 60);

  const [gx0, gy0] = toPx(0, AREA.yNear);
  const [gx1, gy1] = toPx(AREA.w, AREA.yFar);
  const left = Math.min(gx0, gx1);
  const right = Math.max(gx0, gx1);

  // ── Dead Zone Strip (0.20m to 0.60m from wall) ──
  const [, dyTop] = toPx(0, AREA.yVisTop);
  const [, dyBot] = toPx(0, AREA.yNear);
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120.0);

  sctx.fillStyle = G.alarm
    ? `rgba(255,77,61,${0.25 + 0.3 * pulse})`
    : "rgba(255,77,61,.10)";
  sctx.fillRect(left, dyTop, right - left, dyBot - dyTop);

  sctx.save();
  sctx.strokeStyle = G.alarm ? "#FF4D3D" : "rgba(255,77,61,.35)";
  sctx.lineWidth = 2;
  sctx.setLineDash([10, 8]);
  sctx.beginPath();
  sctx.moveTo(left, dyBot);
  sctx.lineTo(right, dyBot);
  sctx.stroke();
  sctx.restore();

  sctx.fillStyle = G.alarm ? "#fff" : "rgba(255,77,61,.55)";
  sctx.font = "600 11px 'JetBrains Mono',ui-monospace,monospace";
  sctx.textAlign = "center";
  sctx.fillText(
    "DEAD ZONE · 0.60 m FROM SCREEN",
    (left + right) / 2.0,
    dyTop + (dyBot - dyTop) / 2.0 + 4
  );

  // ── Play Turf ──
  const grad = sctx.createLinearGradient(0, gy0, 0, gy1);
  grad.addColorStop(0, "#2F7522");
  grad.addColorStop(1, "#4CA637");
  sctx.fillStyle = grad;
  sctx.fillRect(left, Math.min(gy0, gy1), right - left, Math.abs(gy1 - gy0));

  // Depth calibration stripes every 20 cm
  sctx.strokeStyle = "rgba(255,255,255,.05)";
  sctx.lineWidth = 1;
  for (let d = AREA.yNear; d <= AREA.yFar + 1e-6; d += 0.20) {
    const [, py] = toPx(0, d);
    sctx.beginPath();
    sctx.moveTo(left, py);
    sctx.lineTo(right, py);
    sctx.stroke();
  }

  const holeR = Math.max(16, VIEW.scale * 0.13);

  // ── Holes ──
  for (const h of G.holes) {
    const [hx, hy] = toPx(h.x, h.y);
    sctx.save();
    sctx.translate(hx, hy);
    sctx.fillStyle = "#20140A";
    sctx.beginPath();
    sctx.ellipse(0, 0, holeR, holeR * 0.46, 0, 0, 7);
    sctx.fill();

    sctx.fillStyle = "rgba(0,0,0,.55)";
    sctx.beginPath();
    sctx.ellipse(0, -holeR * 0.05, holeR * 0.86, holeR * 0.36, 0, 0, 7);
    sctx.fill();
    sctx.restore();
  }

  // ── Moles ──
  for (const m of G.moles) {
    const [hx, hy] = toPx(m.hole.x, m.hole.y);
    const up = m.pop * holeR * 1.05;
    sctx.save();
    sctx.beginPath();
    sctx.ellipse(hx, hy, holeR * 1.02, holeR * 0.5, 0, 0, 7);
    sctx.rect(hx - holeR * 1.2, hy - holeR * 3, holeR * 2.4, holeR * 3);
    sctx.clip();
    sctx.translate(hx, hy - up);

    const bodyCol =
      m.kind === "gold" ? "#E8B23A" : m.kind === "bomb" ? "#232A31" : "#A9662F";
    const bellyCol =
      m.kind === "gold" ? "#F6D98A" : m.kind === "bomb" ? "#39434D" : "#C98A54";
    const r = holeR * 0.72;

    sctx.fillStyle = bodyCol;
    sctx.beginPath();
    sctx.ellipse(0, 0, r * 0.95, r * 1.05, 0, Math.PI, 0);
    sctx.rect(-r * 0.95, 0, r * 1.9, r * 1.4);
    sctx.fill();

    sctx.fillStyle = bellyCol;
    sctx.beginPath();
    sctx.ellipse(0, r * 0.25, r * 0.55, r * 0.62, 0, 0, 7);
    sctx.fill();

    if (m.kind === "bomb") {
      sctx.strokeStyle = "#FFB020";
      sctx.lineWidth = Math.max(2, r * 0.11);
      sctx.lineCap = "round";
      sctx.beginPath();
      sctx.moveTo(0, -r * 0.95);
      sctx.quadraticCurveTo(r * 0.4, -r * 1.5, r * 0.15, -r * 1.75);
      sctx.stroke();

      sctx.fillStyle = "#FF4D3D";
      sctx.beginPath();
      sctx.arc(
        r * 0.15,
        -r * 1.8,
        r * 0.16 * (1 + 0.3 * Math.sin(performance.now() / 60.0)),
        0,
        7
      );
      sctx.fill();

      sctx.fillStyle = "#0B0E11";
      sctx.beginPath();
      sctx.arc(-r * 0.3, -r * 0.15, r * 0.13, 0, 7);
      sctx.arc(r * 0.3, -r * 0.15, r * 0.13, 0, 7);
      sctx.fill();
    } else {
      // Eyes
      sctx.fillStyle = "#1A1008";
      sctx.beginPath();
      sctx.arc(-r * 0.3, -r * 0.3, r * 0.12, 0, 7);
      sctx.arc(r * 0.3, -r * 0.3, r * 0.12, 0, 7);
      sctx.fill();

      // Snout
      sctx.fillStyle = "#F0C39A";
      sctx.beginPath();
      sctx.ellipse(0, r * 0.12, r * 0.32, r * 0.26, 0, 0, 7);
      sctx.fill();

      sctx.fillStyle = "#5A3418";
      sctx.beginPath();
      sctx.ellipse(0, r * 0.02, r * 0.12, r * 0.09, 0, 0, 7);
      sctx.fill();

      // Whiskers
      sctx.strokeStyle = "rgba(40,24,10,.6)";
      sctx.lineWidth = Math.max(1, r * 0.045);
      for (const sgn of [-1, 1]) {
        for (const dy of [-0.04, 0.08]) {
          sctx.beginPath();
          sctx.moveTo(sgn * r * 0.28, r * (0.1 + dy));
          sctx.lineTo(sgn * r * 0.85, r * (0.02 + dy * 1.6));
          sctx.stroke();
        }
      }
    }
    if (m.kind === "prof") drawProfMole(sctx, r);
    sctx.restore();

    // Dwell ring on targeted mole
    if (m.dwell > 0.01 && !m.dead) {
      const L = LEVELS[G.li];
      sctx.save();
      sctx.translate(hx, hy - up);
      sctx.strokeStyle = "rgba(255,255,255,.25)";
      sctx.lineWidth = Math.max(3, holeR * 0.13);
      sctx.beginPath();
      sctx.arc(0, 0, holeR * 0.95, 0, 7);
      sctx.stroke();

      sctx.strokeStyle = m.kind === "bomb" ? "#FF4D3D" : "#9BE86B";
      sctx.lineCap = "round";
      sctx.beginPath();
      sctx.arc(
        0,
        0,
        holeR * 0.95,
        -Math.PI / 2,
        -Math.PI / 2 + (7 * (m.dwell / L.dwell)) / 1.114
      );
      sctx.stroke();
      sctx.restore();
    }
  }

  // ── Score & Effect Bursts ──
  for (const f of G.fx) {
    const [fx, fy] = toPx(f.x, f.y);
    const k = f.t / 0.6;
    sctx.save();
    sctx.globalAlpha = Math.max(0, 1.0 - k);
    sctx.strokeStyle = f.col;
    sctx.lineWidth = Math.max(2, holeR * 0.12 * (1.0 - k));
    sctx.beginPath();
    sctx.arc(fx, fy, holeR * (0.5 + k * 1.6), 0, 7);
    sctx.stroke();

    sctx.fillStyle = f.col;
    sctx.font = `700 ${Math.max(16, holeR * 0.62)}px 'Bahnschrift','DIN Alternate',sans-serif`;
    sctx.textAlign = "center";
    sctx.fillText(f.text, fx, fy - holeR - k * 44);
    sctx.restore();
  }

  // ── Player Cursor ──
  if (Tracker.pos) {
    const [cx, cy] = toPx(Tracker.pos.x, Tracker.pos.y);
    const R = holeR * 0.8;
    sctx.save();
    if (Tracker.stale) {
      sctx.globalAlpha = 0.35;
    }
    // A one-box polar fix is a real fix but a coarse one (a couple of hundred
    // mm rather than a couple of dozen). Draw it dashed and amber so nobody
    // mistakes a degraded cursor for a confident one during testing.
    const degraded = Tracker.mode === "one-box" || (Tracker.veto && !(Tracker.fix && Tracker.fix.vetoSoft));
    sctx.strokeStyle = G.alarm ? "#FF4D3D"
                     : Tracker.veto ? "#FF4D3D"
                     : degraded ? "#FFB020"
                     : "rgba(255,255,255,.9)";
    sctx.lineWidth = 3;
    if (degraded) sctx.setLineDash([6, 5]);
    sctx.beginPath();
    sctx.arc(cx, cy, R, 0, 7);
    sctx.stroke();
    sctx.setLineDash([]);

    sctx.fillStyle = G.alarm ? "rgba(255,77,61,.25)"
                   : degraded ? "rgba(255,176,32,.14)"
                   : "rgba(255,255,255,.14)";
    sctx.beginPath();
    sctx.arc(cx, cy, R, 0, 7);
    sctx.fill();

    // Uncertainty halo: how far the solver thinks it could actually be.
    if (Tracker.src !== "mouse" && isFinite(Tracker.sigma) && Tracker.sigma > 0.05) {
      const [ex] = toPx(Tracker.pos.x + Tracker.sigma, Tracker.pos.y);
      sctx.strokeStyle = "rgba(255,176,32,.30)";
      sctx.lineWidth = 1.5;
      sctx.beginPath();
      sctx.arc(cx, cy, Math.abs(ex - cx), 0, 7);
      sctx.stroke();
    }

    sctx.beginPath();
    sctx.moveTo(cx - R * 0.45, cy);
    sctx.lineTo(cx + R * 0.45, cy);
    sctx.moveTo(cx, cy - R * 0.45);
    sctx.lineTo(cx, cy + R * 0.45);
    sctx.stroke();

    // Raw (unfiltered) marker to visualize smoothing trade-off
    if (Tracker.raw && Tracker.src !== "mouse") {
      const [rx, ry] = toPx(Tracker.raw.x, Tracker.raw.y);
      sctx.fillStyle = "rgba(69,208,232,.75)";
      sctx.beginPath();
      sctx.arc(rx, ry, 4, 0, 7);
      sctx.fill();
    }
    sctx.restore();
  }

  sctx.restore();
  drawTargetPanel(sctx, dt);
  drawScoreboardPanel(sctx, dt);
}

// ── Professor mole ("Iain") ──
// Drawn at the mole's centre with radius r, in the same coordinate frame as the
// normal mole. It paints over the whole mole body, so it can be called after the
// normal mole has been drawn.
function drawProfMole(c, r) {
  const skin = "#E2A37F", skinShade = "#C98462";
  const hair = "#B7B2AB", hairDark = "#8D8882";

  // Body shape (same outline as the normal mole), filled with a navy shirt
  c.fillStyle = "#2C3E5C";
  c.beginPath();
  c.ellipse(0, 0, r * 0.95, r * 1.05, 0, Math.PI, 0);
  c.rect(-r * 0.95, 0, r * 1.9, r * 1.4);
  c.fill();

  // Ears
  c.fillStyle = skinShade;
  c.beginPath();
  c.ellipse(-r * 0.86, -r * 0.22, r * 0.14, r * 0.2, 0, 0, 7);
  c.ellipse(r * 0.86, -r * 0.22, r * 0.14, r * 0.2, 0, 0, 7);
  c.fill();

  // Head
  c.fillStyle = skin;
  c.beginPath();
  c.ellipse(0, -r * 0.18, r * 0.82, r * 0.9, 0, 0, 7);
  c.fill();

  // White shirt collar
  c.fillStyle = "#F4F1EA";
  c.beginPath();
  c.moveTo(-r * 0.5, r * 0.62);
  c.lineTo(0, r * 0.95);
  c.lineTo(-r * 0.12, r * 1.15);
  c.lineTo(-r * 0.62, r * 0.82);
  c.closePath();
  c.moveTo(r * 0.5, r * 0.62);
  c.lineTo(0, r * 0.95);
  c.lineTo(r * 0.12, r * 1.15);
  c.lineTo(r * 0.62, r * 0.82);
  c.closePath();
  c.fill();

  // Short grey hair, slightly higher at the temples
  c.save();
  c.beginPath();
  c.ellipse(0, -r * 0.18, r * 0.84, r * 0.92, 0, 0, 7);
  c.clip();
  c.fillStyle = hair;
  c.beginPath();
  c.moveTo(-r, -r * 0.2);
  c.lineTo(-r * 0.78, -r * 0.42);
  c.quadraticCurveTo(-r * 0.55, -r * 0.62, -r * 0.42, -r * 0.7);
  c.quadraticCurveTo(0, -r * 0.6, r * 0.42, -r * 0.7);
  c.quadraticCurveTo(r * 0.55, -r * 0.62, r * 0.78, -r * 0.42);
  c.lineTo(r, -r * 0.2);
  c.lineTo(r, -r * 1.3);
  c.lineTo(-r, -r * 1.3);
  c.closePath();
  c.fill();
  // salt-and-pepper texture
  c.strokeStyle = hairDark;
  c.lineWidth = Math.max(1, r * 0.04);
  c.lineCap = "round";
  for (let i = -3; i <= 3; i++) {
    const x = i * r * 0.2;
    c.beginPath();
    c.moveTo(x - r * 0.04, -r * 0.82 - Math.abs(i) * r * 0.01);
    c.lineTo(x + r * 0.05, -r * 0.98);
    c.stroke();
  }
  c.restore();

  // Eyebrows
  c.strokeStyle = "#6F6A64";
  c.lineWidth = Math.max(1.5, r * 0.07);
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(-r * 0.56, -r * 0.5);
  c.quadraticCurveTo(-r * 0.36, -r * 0.6, -r * 0.14, -r * 0.5);
  c.moveTo(r * 0.14, -r * 0.5);
  c.quadraticCurveTo(r * 0.36, -r * 0.6, r * 0.56, -r * 0.5);
  c.stroke();

  // Happy, slightly squinting eyes
  c.strokeStyle = "#2A1A10";
  c.lineWidth = Math.max(1.5, r * 0.07);
  c.beginPath();
  c.arc(-r * 0.34, -r * 0.24, r * 0.1, Math.PI * 1.1, Math.PI * 1.9);
  c.moveTo(r * 0.24, -r * 0.27);
  c.arc(r * 0.34, -r * 0.24, r * 0.1, Math.PI * 1.1, Math.PI * 1.9);
  c.stroke();

  // Thick black rectangular glasses
  const gw = r * 0.5, gh = r * 0.34, gy = -r * 0.42, rad = r * 0.08;
  c.strokeStyle = "#111";
  c.lineWidth = Math.max(2, r * 0.11);
  c.lineJoin = "round";
  for (const cx of [-r * 0.34, r * 0.34]) {
    c.beginPath();
    c.roundRect(cx - gw / 2, gy, gw, gh, rad);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(-r * 0.09, gy + gh * 0.35);
  c.lineTo(r * 0.09, gy + gh * 0.35);           // bridge
  c.moveTo(-r * 0.59, gy + gh * 0.3);
  c.lineTo(-r * 0.8, gy + gh * 0.2);            // arms
  c.moveTo(r * 0.59, gy + gh * 0.3);
  c.lineTo(r * 0.8, gy + gh * 0.2);
  c.stroke();

  // Mole nose, so he's still a mole
  c.fillStyle = "#C9605A";
  c.beginPath();
  c.ellipse(0, r * 0.06, r * 0.12, r * 0.09, 0, 0, 7);
  c.fill();

  // Big toothy grin
  c.fillStyle = "#5A1E1E";
  c.beginPath();
  c.moveTo(-r * 0.4, r * 0.24);
  c.quadraticCurveTo(0, r * 0.3, r * 0.4, r * 0.24);
  c.quadraticCurveTo(r * 0.32, r * 0.58, 0, r * 0.6);
  c.quadraticCurveTo(-r * 0.32, r * 0.58, -r * 0.4, r * 0.24);
  c.fill();
  c.save();
  c.clip();
  c.fillStyle = "#FFFFFF";
  c.fillRect(-r * 0.45, r * 0.2, r * 0.9, r * 0.17);
  c.restore();

  // Little pink mole paws resting on the hole edge
  for (const sgn of [-1, 1]) {
    const px = sgn * r * 0.6, py = r * 1.12;
    c.fillStyle = "#E8A9A0";
    c.beginPath();
    c.ellipse(px, py, r * 0.26, r * 0.16, 0, 0, 7);
    c.fill();
    c.strokeStyle = "#F7EDE6";
    c.lineWidth = Math.max(1, r * 0.05);
    c.lineCap = "round";
    for (const k of [-1, 0, 1]) {
      c.beginPath();
      c.moveTo(px + k * r * 0.11, py - r * 0.1);
      c.lineTo(px + k * r * 0.13, py - r * 0.22);
      c.stroke();
    }
  }

  // Whiskers
  c.strokeStyle = "rgba(60,30,20,.55)";
  c.lineWidth = Math.max(1, r * 0.04);
  for (const sgn of [-1, 1]) {
    for (const dy of [-0.03, 0.06]) {
      c.beginPath();
      c.moveTo(sgn * r * 0.2, r * (0.08 + dy));
      c.lineTo(sgn * r * 0.58, r * (0.02 + dy * 1.6));
      c.stroke();
    }
  }
}

/* ── Target panel (left black margin of the stage) ─────────────
   Moles still to whack this level. Reads G.hitsThisLevel and
   LEVELS[G.li].target, so it counts down on every hit, shows CLEARED
   at zero, and refreshes by itself when startLevel() loads the next
   level (hitsThisLevel resets and the new target is picked up).
   Bombs don't count, matching hit() in game.js. */
function drawTargetPanel(sctx, dt) {
  const L = LEVELS[G.li];
  if (!L) return;

  if (G.hitsThisLevel > lastHits) hitPulse = 1;
  lastHits = G.hitsThisLevel;
  hitPulse = Math.max(0, hitPulse - dt * 3.0);

  if (VIEW.x < 130) return;   // window too narrow: no black margin to use

  const pw = Math.min(VIEW.x - 28, 300);
  const px = Math.max(14, (VIEW.x - pw) / 2);
  const cx = px + pw / 2;
  const py = Math.max(16, VIEW.y + 12);
  const done = Math.min(G.hitsThisLevel, L.target);
  const left = L.target - done;
  const cleared = left === 0;
  const accent = cleared ? "#FFB020" : "#9BE86B";

  const perRow = Math.max(1, Math.floor((pw - 32) / 26));
  const rows = Math.ceil(L.target / perRow);
  const ph = 262 + rows * 26;

  sctx.save();

  // Card
  sctx.fillStyle = "rgba(255,255,255,.04)";
  sctx.strokeStyle = "rgba(255,255,255,.12)";
  sctx.lineWidth = 1;
  sctx.beginPath();
  if (sctx.roundRect) sctx.roundRect(px, py, pw, ph, 14);
  else sctx.rect(px, py, pw, ph);
  sctx.fill();
  sctx.stroke();

  sctx.textAlign = "center";

  sctx.fillStyle = "#7C8A99";
  sctx.font = "600 12px 'JetBrains Mono',ui-monospace,monospace";
  sctx.fillText("TARGET", cx, py + 28);

  sctx.fillStyle = "rgba(255,255,255,.85)";
  sctx.font = "700 16px 'Bahnschrift','DIN Alternate',sans-serif";
  sctx.fillText(`LEVEL ${L.n} · ${L.name.toUpperCase()}`, cx, py + 54, pw - 16);

  // Big countdown number, with a small pop on each hit
  const size = 104 * (1 + 0.22 * hitPulse);
  sctx.fillStyle = accent;
  sctx.font = `700 ${size}px 'Bahnschrift','DIN Alternate',sans-serif`;
  sctx.fillText(String(left), cx, py + 160);

  sctx.fillStyle = "rgba(255,255,255,.6)";
  sctx.font = "600 12px 'JetBrains Mono',ui-monospace,monospace";
  sctx.fillText(cleared ? "LEVEL CLEARED" : (left === 1 ? "MOLE TO GO" : "MOLES TO GO"), cx, py + 186);

  // Progress bar
  const bx = px + 20, bw = pw - 40, by = py + 204;
  sctx.fillStyle = "rgba(255,255,255,.12)";
  sctx.fillRect(bx, by, bw, 8);
  sctx.fillStyle = accent;
  sctx.fillRect(bx, by, bw * (done / L.target), 8);

  sctx.fillStyle = "rgba(255,255,255,.5)";
  sctx.fillText(`${done} / ${L.target} whacked`, cx, py + 236);

  // One pip per mole in the target
  for (let i = 0; i < L.target; i++) {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const n = Math.min(perRow, L.target - r * perRow);
    const x = cx - (n * 26) / 2 + 13 + c * 26;
    const y = py + 262 + r * 26;
    sctx.beginPath();
    sctx.arc(x, y, 8, 0, 7);
    if (i < done) {
      sctx.fillStyle = accent;
      sctx.fill();
    } else {
      sctx.strokeStyle = "rgba(255,255,255,.28)";
      sctx.lineWidth = 2;
      sctx.stroke();
    }
  }

  sctx.restore();
}


/* Scoreboard in the right black margin: top scores from the saved history,
   the current run's live score, and a glow when the best score is beaten.
   Data comes from the Scores object (game.js). */
function drawScoreboardPanel(sctx, dt) {
  if (typeof Scores === "undefined") return;
  const best = Scores.best();
  const live = (G.phase === "play" || G.phase === "count" || G.phase === "levelup" || G.phase === "pause") ? G.score : 0;
  const beating = live > 0 && live > best;
  if (Scores.flash > 0) Scores.flash = Math.max(0, Scores.flash - dt);

  const rightX = VIEW.x + VIEW.w;
  const margin = VIEW.cw - rightX;
  if (margin < 150) return;

  const pw = Math.min(margin - 28, 300);
  const px = rightX + (margin - pw) / 2;
  const cx = px + pw / 2;
  const py = Math.max(16, VIEW.y + 12);
  const rows = Scores.MAX;
  const rh = 28;
  const ph = 132 + rows * rh + 24;
  const glow = beating || Scores.flash > 0;
  const gold = "#FFB020";

  sctx.save();
  sctx.fillStyle = glow ? "rgba(255,176,32,.08)" : "rgba(255,255,255,.04)";
  sctx.strokeStyle = glow ? gold : "rgba(255,255,255,.12)";
  sctx.lineWidth = glow ? 2 : 1;
  sctx.beginPath();
  if (sctx.roundRect) sctx.roundRect(px, py, pw, ph, 14); else sctx.rect(px, py, pw, ph);
  sctx.fill();
  sctx.stroke();

  sctx.textAlign = "center";
  sctx.fillStyle = "#7C8A99";
  sctx.font = "600 12px 'JetBrains Mono',ui-monospace,monospace";
  sctx.fillText("SCOREBOARD", cx, py + 28);

  // This run vs. the record
  sctx.fillStyle = glow ? gold : "rgba(255,255,255,.9)";
  sctx.font = "700 44px 'Bahnschrift','DIN Alternate',sans-serif";
  sctx.fillText(String(live), cx, py + 76);
  sctx.font = "600 12px 'JetBrains Mono',ui-monospace,monospace";
  sctx.fillStyle = glow ? gold : "rgba(255,255,255,.5)";
  const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 160);
  if (glow) sctx.globalAlpha = pulse;
  sctx.fillText(glow ? "★ NEW HIGH SCORE ★" : (best ? "BEST " + best : "NO SCORES YET"), cx, py + 100);
  sctx.globalAlpha = 1;

  sctx.fillStyle = "rgba(255,255,255,.12)";
  sctx.fillRect(px + 16, py + 114, pw - 32, 1);

  // Top scores
  const top = Scores.top(rows);
  sctx.font = "600 14px 'Bahnschrift','DIN Alternate',sans-serif";
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const y = py + 140 + i * rh;
    const mine = e === Scores.lastSaved;
    if (mine) {
      sctx.fillStyle = "rgba(255,176,32,.14)";
      sctx.fillRect(px + 8, y - 17, pw - 16, rh - 4);
    }
    sctx.fillStyle = i === 0 ? gold : "rgba(255,255,255,.4)";
    sctx.textAlign = "left";
    sctx.fillText(String(i + 1), px + 16, y);
    sctx.fillStyle = mine ? gold : "rgba(255,255,255,.85)";
    sctx.fillText(e.name, px + 40, y, pw - 120);
    sctx.textAlign = "right";
    sctx.fillStyle = i === 0 ? gold : "rgba(255,255,255,.85)";
    sctx.fillText(String(e.score), px + pw - 16, y);
  }
  if (!top.length) {
    sctx.textAlign = "center";
    sctx.fillStyle = "rgba(255,255,255,.35)";
    sctx.fillText("Finish a game to set a score", cx, py + 150, pw - 24);
  }
  sctx.restore();
}