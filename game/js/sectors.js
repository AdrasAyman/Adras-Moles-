"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Boolean Sector Model & Closed-Form Multilateration

   Replaces the old grid-search + gradient-descent solver with:

     1. MEDIAN pre-filter on each raw range (kills cross-talk spikes
        without the lag a moving average would cost).
     2. BOOLEAN SECTORS. Which sensors in a box fired — and just as
        importantly, which stayed silent — constrains the bearing to
        an angular sector. Because the two sensors in a box overlap
        by ~15 deg, each box yields THREE sectors, not two.
     3. CLOSED-FORM circle intersection. Exact, ~1000x cheaper than
        the grid search, and it exposes the non-intersection case
        (`gap`) that a least-squares residual mathematically cannot
        see when the system is exactly determined.
     4. SECTOR VETO. A fix that lands outside the cone of a sensor
        that fired is rejected. This is real error detection: it uses
        information that is not present in the range equations.
     5. POLAR FALLBACK. Sector (bearing) + range (radius) from a
        SINGLE box still gives a coarse fix, so the cursor degrades
        instead of dying when only one box can see the player.

   Bearing convention everywhere: atan2(dx, dy). 0 deg points straight
   out from the wall; POSITIVE turns toward +x.
   ══════════════════════════════════════════════════════════════ */

/* ── Median ring buffer ──────────────────────────────────────── */
class MedianRing {
  constructor(n) {
    this.n = Math.max(1, n | 0);
    this.buf = [];
  }

  push(v) {
    this.buf.push(v == null ? null : v);
    while (this.buf.length > this.n) this.buf.shift();
  }

  /** Median of the present samples, or null if the window is mostly dropouts. */
  value() {
    const present = this.buf.filter(x => x != null);
    if (!present.length) return null;
    if (this.buf.length >= this.n && present.length * 2 < this.buf.length) return null;
    present.sort((a, b) => a - b);
    const m = present.length >> 1;
    return present.length % 2 ? present[m] : (present[m - 1] + present[m]) / 2;
  }

  /** Fraction of the window that carried an echo — a live dropout rate. */
  fill() {
    if (!this.buf.length) return 0;
    return this.buf.filter(x => x != null).length / this.buf.length;
  }

  clear() {
    this.buf.length = 0;
  }
}

/* ── Geometry helpers ────────────────────────────────────────── */
const DEG = Math.PI / 180.0;

function beamHalf(s) {
  return (s.w != null ? s.w : BEAM.defaultWidth) / 2.0;
}

function bearingTo(box, x, y) {
  return Math.atan2(x - box.x, y - box.y) / DEG;
}

/** Group sensor indices by physical box. Co-located sensors share one box. */
function groupBoxes(sensors) {
  const boxes = [];
  sensors.forEach((s, i) => {
    let b = boxes.find(o => Math.hypot(o.x - s.x, o.y - s.y) < 1e-6);
    if (!b) {
      b = { x: s.x, y: s.y, idx: [], id: boxes.length };
      boxes.push(b);
    }
    b.idx.push(i);
  });
  return boxes;
}

/** Remove `cut` from a list of [lo,hi] intervals. */
function subtractInterval(list, cut) {
  const out = [];
  for (const iv of list) {
    const lo = iv[0], hi = iv[1];
    if (cut[1] <= lo || cut[0] >= hi) {
      out.push(iv);
      continue;
    }
    if (cut[0] > lo) out.push([lo, Math.min(cut[0], hi)]);
    if (cut[1] < hi) out.push([Math.max(cut[1], lo), hi]);
  }
  return out.filter(iv => iv[1] - iv[0] > 1e-9);
}

/**
 * The angular sector implied by which sensors in a box fired.
 * Fired sensors intersect their cones; silent sensors carve theirs out.
 */
function boxSector(box, sensors, fired) {
  const F = box.idx.filter(i => fired[i]);
  if (!F.length) return null;

  let lo = -Infinity, hi = Infinity;
  for (const i of F) {
    const h = beamHalf(sensors[i]);
    lo = Math.max(lo, sensors[i].a - h);
    hi = Math.min(hi, sensors[i].a + h);
  }

  // Two sensors fired but their cones do not overlap: impossible under the
  // current calibration. Almost always cross-talk or a bad `a`/`w` value.
  if (hi <= lo) {
    const wide = {
      lo: Math.min(...F.map(i => sensors[i].a - beamHalf(sensors[i]))),
      hi: Math.max(...F.map(i => sensors[i].a + beamHalf(sensors[i])))
    };
    return {
      lo: wide.lo, hi: wide.hi, mid: (wide.lo + wide.hi) / 2.0,
      width: wide.hi - wide.lo, fired: F, conflict: true,
      note: "fired cones do not overlap"
    };
  }

  let pieces = [[lo, hi]];
  for (const i of box.idx) {
    if (fired[i]) continue;
    const h = beamHalf(sensors[i]);
    pieces = subtractInterval(pieces, [sensors[i].a - h, sensors[i].a + h]);
  }

  // Silent sensors excluded everything the fired ones allowed. Keep the fired
  // interval but flag it — the silent-sensor evidence is contradictory.
  if (!pieces.length) {
    return {
      lo: lo, hi: hi, mid: (lo + hi) / 2.0, width: hi - lo,
      fired: F, conflict: true, note: "silent sensors exclude the fired overlap"
    };
  }

  pieces.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  const best = pieces[0];
  return {
    lo: best[0], hi: best[1], mid: (best[0] + best[1]) / 2.0,
    width: best[1] - best[0], fired: F, conflict: false,
    fragments: pieces.length
  };
}

/** How far outside [lo,hi] a bearing sits, in degrees. 0 when inside. */
function sectorMiss(sec, bearing) {
  if (!sec) return 0;
  if (bearing < sec.lo) return sec.lo - bearing;
  if (bearing > sec.hi) return bearing - sec.hi;
  return 0;
}

/**
 * Closed-form two-circle intersection.
 * Returns both mirror candidates plus `gap` — how far the circles are from
 * touching at all. gap > 0 means the ranges are mutually inconsistent, which
 * is the failure the old least-squares residual could never report.
 */
function intersectCircles(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1, dy = y2 - y1;
  const D = Math.hypot(dx, dy);
  if (D < 1e-6) return { ok: false, reason: "co-located centres", gap: Infinity };

  let gap = 0;
  if (D > r1 + r2) gap = D - (r1 + r2);
  else if (D < Math.abs(r1 - r2)) gap = Math.abs(r1 - r2) - D;

  const a = (r1 * r1 - r2 * r2 + D * D) / (2.0 * D);
  const h2 = r1 * r1 - a * a;
  const clamped = h2 < 0;
  const h = clamped ? 0 : Math.sqrt(h2);

  const ux = dx / D, uy = dy / D;
  const px = x1 + a * ux, py = y1 + a * uy;

  return {
    ok: true,
    clamped: clamped,
    gap: gap,
    candidates: [
      { x: px - h * uy, y: py + h * ux },
      { x: px + h * uy, y: py - h * ux }
    ]
  };
}

/**
 * Gauss-Newton refinement against every box observation.
 * Only does anything when 3+ distinct box positions report; with exactly two
 * the closed form is already exact.
 */
function refineGaussNewton(obs, seed, iters) {
  let x = seed.x, y = seed.y;
  for (let it = 0; it < (iters || 6); it++) {
    let a = 0, b = 0, c = 0, gx = 0, gy = 0;
    for (const o of obs) {
      const dx = x - o.x, dy = y - o.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const jx = dx / d, jy = dy / d;
      const e = d - o.d;
      a += jx * jx; b += jx * jy; c += jy * jy;
      gx += jx * e; gy += jy * e;
    }
    const lm = 1e-6;
    a += lm; c += lm;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) break;
    const sx = (gx * c - gy * b) / det;
    const sy = (gy * a - gx * b) / det;
    x -= sx; y -= sy;
    if (Math.hypot(sx, sy) < 1e-6) break;
  }
  return { x: x, y: y };
}

/** RMS range residual of a point against the box observations. */
function rmsResidual(obs, p) {
  if (!obs.length) return 0;
  let s = 0;
  for (const o of obs) {
    const e = Math.hypot(p.x - o.x, p.y - o.y) - o.d;
    s += e * e;
  }
  return Math.sqrt(s / obs.length);
}

/**
 * Full pipeline.
 *
 * @param ranges   surface ranges in metres, null for no echo, already median-filtered
 * @param sensors  layout array
 * @param opts     { prev: {x,y} | null }
 * @returns a rich diagnostic object; `mode` is "two-box" | "one-box" | "blind"
 */
function solveSectors(ranges, sensors, opts) {
  opts = opts || {};
  const prev = opts.prev || null;
  const boxes = groupBoxes(sensors);
  const fired = sensors.map((s, i) => ranges[i] != null);

  // Per-box: angular sector, plus the range(s) that box reported.
  const info = boxes.map(b => {
    const sec = boxSector(b, sensors, fired);
    const rs = b.idx.filter(i => ranges[i] != null).map(i => ranges[i]);
    if (!rs.length) {
      return { box: b, sec: sec, d: null, spread: 0, n: 0, raw: [] };
    }
    const lo = Math.min.apply(null, rs);
    const hi = Math.max.apply(null, rs);
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    return {
      box: b,
      sec: sec,
      d: mean + AREA.bodyR,   // surface range -> body-centre range
      spread: hi - lo,        // co-located disagreement: a usable residual
      n: rs.length,
      raw: rs
    };
  });

  const live = info.filter(o => o.d != null);
  const result = {
    mode: "blind",
    x: null, y: null,
    boxes: info,
    live: live.length,
    fired: fired,
    candidates: [],
    chosen: -1,
    gap: 0,
    spread: info.reduce((m, o) => Math.max(m, o.spread), 0),
    residual: 0,
    sigma: Infinity,
    veto: false,
    split: false,
    worstMiss: 0,
    reason: "",
    conflict: info.some(o => o.sec && o.sec.conflict)
  };

  if (!live.length) {
    result.reason = "no sensor returned an echo";
    return result;
  }

  /* ── Two or more boxes: closed-form fix ─────────────────────── */
  if (live.length >= 2) {
    // Widest baseline gives the best-conditioned pair.
    let pa = live[0], pb = live[1], bestD = -1;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const D = Math.hypot(live[i].box.x - live[j].box.x, live[i].box.y - live[j].box.y);
        if (D > bestD) { bestD = D; pa = live[i]; pb = live[j]; }
      }
    }

    // Distance hypotheses per box. Co-located sensors that disagree badly are
    // NOT averaged — one of them is wrong, and the mean is then guaranteed
    // wrong too. Offer both and let the cross-box geometry arbitrate.
    const hypOf = o => (o.n > 1 && o.spread > SOLVER.pairSpreadWarn)
      ? o.raw.map(v => v + AREA.bodyR)
      : [o.d];
    const hA = hypOf(pa), hB = hypOf(pb);
    result.split = (hA.length > 1 || hB.length > 1);

    let best = null;
    for (const dA of hA) {
      for (const dB of hB) {
        const ix = intersectCircles(pa.box.x, pa.box.y, dA, pb.box.x, pb.box.y, dB);
        if (!ix.ok) continue;
        for (let ci = 0; ci < ix.candidates.length; ci++) {
          const c = ix.candidates[ci];
          let miss = 0;
          for (const o of live) {
            if (o.sec) miss += sectorMiss(o.sec, bearingTo(o.box, c.x, c.y));
          }
          const outside =
            (c.x < -0.30 ? -0.30 - c.x : 0) + (c.x > AREA.w + 0.30 ? c.x - AREA.w - 0.30 : 0) +
            (c.y < AREA.yVisTop ? AREA.yVisTop - c.y : 0) +
            (c.y > AREA.yFar + 0.30 ? c.y - AREA.yFar - 0.30 : 0);
          const cont = prev ? Math.hypot(c.x - prev.x, c.y - prev.y) : 0;
          const score = miss * 0.05 + outside * 2.0 + ix.gap * 0.5 + cont * 0.10;
          if (!best || score < best.score) {
            best = {
              score: score, miss: miss, outside: outside, cont: cont,
              gap: ix.gap, clamped: ix.clamped, p: c, ci: ci,
              dA: dA, dB: dB, cands: ix.candidates
            };
          }
        }
      }
    }

    if (best) {
      result.gap = best.gap;
      result.chosen = best.ci;
      result.candidates = best.cands;
      result.usedRanges = { boxA: pa.box.id, dA: best.dA, boxB: pb.box.id, dB: best.dB };

      let p = best.p;
      const obs = live.map(o => ({
        x: o.box.x, y: o.box.y,
        d: (o === pa ? best.dA : (o === pb ? best.dB : o.d))
      }));
      // 3+ distinct boxes: the closed form used only the best pair, so refine
      // against everything. With exactly two it is already exact.
      if (live.length > 2) p = refineGaussNewton(obs, p, 6);

      result.x = p.x;
      result.y = p.y;
      result.residual = rmsResidual(obs, p);
      result.mode = "two-box";
      result.sigma = Math.max(0.02, best.gap / 2.0 + (result.split ? 0.10 : result.spread / 2.0));

      // ── Sector veto: information the range equations do not contain ──
      let worstMiss = 0, worstBox = -1;
      for (const o of live) {
        if (!o.sec) continue;
        const m = sectorMiss(o.sec, bearingTo(o.box, p.x, p.y));
        if (m > worstMiss) { worstMiss = m; worstBox = o.box.id; }
      }
      result.worstMiss = worstMiss;

      // Two different failures deserve two different responses.
      //
      // A large GAP means the ranges contradict each other, so the fix is a
      // clamped fiction — a polar estimate really is better.
      //
      // A sector MISS means the ranges are self-consistent but disagree with
      // the angular model, which is almost always a calibration error. Two
      // precise ranges beat a coarse angular bracket, so keep the fix and
      // raise the flag; substituting a sector-midpoint guess would be worse.
      let allowFallback = false;
      if (best.gap > SOLVER.maxGap) {
        result.veto = true;
        allowFallback = true;
        result.reason = "ranges inconsistent: circles miss by " + (best.gap * 1000).toFixed(0) + " mm";
      } else if (worstMiss > SOLVER.sectorTolDeg) {
        result.veto = true;
        result.sigma = Math.max(result.sigma, best.dA * Math.sin(worstMiss * DEG));
        result.reason = "fix sits " + worstMiss.toFixed(1) + " deg outside box " + worstBox +
                        "'s cone — check the aim / width calibration";
      } else if (result.split) {
        result.reason = "box pair disagreed by " + (result.spread * 1000).toFixed(0) +
                        " mm; geometry picked the consistent reading";
      }

      if (!allowFallback) return result;
    } else {
      result.reason = "no usable circle intersection";
    }
  }

  /* ── One box, or ranges that contradict each other: polar fallback ── */
  // Bearing from the sector, radius from the range. Coarse but alive.
  const usable = live.filter(o => o.sec && isFinite(o.sec.mid));
  if (usable.length) {
    // Tightest sector = most confident bearing.
    const pick = usable.slice().sort((p, q) => p.sec.width - q.sec.width)[0];
    const th = pick.sec.mid * DEG;
    const wasVetoed = result.veto;

    result.mode = "one-box";
    result.x = pick.box.x + pick.d * Math.sin(th);
    result.y = pick.box.y + pick.d * Math.cos(th);
    result.polarBox = pick.box.id;
    result.polarSector = pick.sec;
    // Tangential spread dominates: half-extent of the sector arc at this range.
    result.sigma = Math.max(0.05, pick.d * Math.sin((pick.sec.width / 2.0) * DEG));
    result.residual = 0;
    result.reason = wasVetoed
      ? result.reason + " — fell back to box " + pick.box.id + " polar fix"
      : "only box " + pick.box.id + " has line of sight";
    return result;
  }

  result.mode = "blind";
  result.x = null;
  result.y = null;
  if (!result.reason) result.reason = "no usable sector";
  return result;
}
