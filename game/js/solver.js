"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Sensor Simulation & Multilateration Solver
   Solves 2D body coordinates from acoustic ranges using least-squares
   grid search followed by gradient descent optimization.
   ══════════════════════════════════════════════════════════════ */

const Sim = {
  noise: 0.008, // Range noise std dev in metres (8 mm)
  drop: 0.03,   // Missing echo probability (3%)
  beam: 30      // Sensor half-beam aperture in degrees
};

let gauss_spare = null;

/**
 * Standard normal Gaussian distribution sample generator (Box-Muller).
 */
function gauss() {
  if (gauss_spare !== null) {
    const v = gauss_spare;
    gauss_spare = null;
    return v;
  }
  let u = 0, v = 0;
  while (!u) u = Math.random();
  v = Math.random();
  const m = Math.sqrt(-2.0 * Math.log(u));
  gauss_spare = m * Math.sin(2.0 * Math.PI * v);
  return m * Math.cos(2.0 * Math.PI * v);
}

/**
 * Models each RCWL-1601 sensor as an ultrasonic cone facing +y,
 * rotated by mount angle `a`. Returns distance to body surface in metres.
 */
function simulateRanges(truth, sensors) {
  return sensors.map(s => {
    const dx = truth.x - s.x;
    const dy = truth.y - s.y;
    const d = Math.hypot(dx, dy);
    const facing = ((s.a || 0) * Math.PI) / 180;
    const bearing = Math.atan2(dx, dy);

    if (Math.abs(bearing - facing) > (Sim.beam * Math.PI) / 180) return null; // Outside beam
    if (d > 4.0 || d < 0.02) return null;                                    // Range limits
    if (Math.random() < Sim.drop) return null;                              // Packet drop

    const surface = d - AREA.bodyR;
    return Math.max(0.02, surface + gauss() * Sim.noise);
  });
}

/**
 * Least-squares multilateration: coarse grid search then gradient descent.
 * Returns { x, y, res, n } or null when fewer than 2 sensors report.
 */
function solvePosition(ranges, sensors) {
  const obs = [];
  for (let i = 0; i < ranges.length; i++) {
    if (ranges[i] == null) continue;
    obs.push({ s: sensors[i], d: ranges[i] + AREA.bodyR });
  }
  if (obs.length < 2) return null;

  const cost = (x, y) => {
    let c = 0;
    for (const o of obs) {
      const e = Math.hypot(x - o.s.x, y - o.s.y) - o.d;
      c += e * e;
    }
    return c;
  };

  // Phase 1: Coarse Grid Search
  let bx = AREA.w / 2.0, by = 1.2, bc = Infinity;
  const G = 26;
  for (let i = 0; i <= G; i++) {
    for (let j = 0; j <= G; j++) {
      const x = (i / G) * AREA.w;
      const y = AREA.yVisTop + (j / G) * (AREA.yFar - AREA.yVisTop);
      const c = cost(x, y);
      if (c < bc) {
        bc = c;
        bx = x;
        by = y;
      }
    }
  }

  // Phase 2: Gradient Descent
  let x = bx, y = by, step = 0.06;
  for (let it = 0; it < 60; it++) {
    let gx = 0, gy = 0;
    for (const o of obs) {
      const dx = x - o.s.x;
      const dy = y - o.s.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const e = d - o.d;
      gx += (2.0 * e * dx) / d;
      gy += (2.0 * e * dy) / d;
    }
    x -= step * gx;
    y -= step * gy;
    x = Math.max(-0.3, Math.min(AREA.w + 0.3, x));
    y = Math.max(0.05, Math.min(AREA.yFar + 0.3, y));
    step *= 0.97;
  }

  return {
    x,
    y,
    res: Math.sqrt(cost(x, y) / obs.length),
    n: obs.length
  };
}
