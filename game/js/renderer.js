"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — 2D Stage Canvas Renderer
   Handles coordinate transformations and draws the play turf,
   holes, animated moles, particle effects, and cursor tracking.
   ══════════════════════════════════════════════════════════════ */

let VIEW = { x: 0, y: 0, w: 0, h: 0, scale: 1, cw: 0, ch: 0 };
const MIRROR = true; // Player faces the screen; cursor mirrors like a reflection
let shake = 0;

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
    sctx.strokeStyle = G.alarm ? "#FF4D3D" : "rgba(255,255,255,.9)";
    sctx.lineWidth = 3;
    sctx.beginPath();
    sctx.arc(cx, cy, R, 0, 7);
    sctx.stroke();

    sctx.fillStyle = G.alarm ? "rgba(255,77,61,.25)" : "rgba(255,255,255,.14)";
    sctx.beginPath();
    sctx.arc(cx, cy, R, 0, 7);
    sctx.fill();

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
}
