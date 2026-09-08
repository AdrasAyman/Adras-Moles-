"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Sensor Test Bench

   A sub-application for characterising the real hardware and
   debugging the triangulation chain. It answers three questions
   the game itself cannot:

     HOW FAR does each sensor actually reach?   -> per-sensor max
        observed range, accumulated over the whole session.
     HOW WIDE is each cone, really?             -> bearing histogram
        of fired vs silent, binned against a known ground truth.
     WHY did the solver produce THAT?           -> both intersection
        candidates, every sector, the veto and its reason, plus the
        old least-squares answer side by side.
   ══════════════════════════════════════════════════════════════ */

const SCOL = ["#45D0E8", "#9BE86B", "#FFB020", "#FF7BD5", "#B48CFF", "#FF8A5B"];
const BIN_DEG = 2.0;            // bearing histogram bin width
const BIN_LO = -95.0, BIN_HI = 95.0;
const NBINS = Math.round((BIN_HI - BIN_LO) / BIN_DEG);
const MIN_BIN_SAMPLES = 3;   // samples before a bearing bin counts as evidence
const MIN_BINS = 6;          // distinct bearings needed before a fit is meaningful

const ST = {
  layers: {
    cones: true, arcs: true, sectors: true, cands: true,
    legacy: false, samples: true, heat: false, grid: true
  },
  truth: null,          // manually placed ground-truth marker {x,y}
  ptr: null,            // last pointer position in world coords
  samples: [],          // { x, y, fired[], ranges[] }
  hist: [],             // per sensor: { fired:Int32Array, total:Int32Array }
  stats: [],            // per sensor: { min, max, count }
  capture: { active: false, left: 0, t0: 0 },
  pristine: null,       // deep copy of the layout for "reset to config"
  coverage: null,       // cached coverage map
  coverageKey: "",
  lastKey: "",
  notice: null,          // { text, cls, until } — sticky status message
  legacyFix: null,
  view: { ox: 0, oy: 0, s: 1 }
};

/** Post a status message that survives the per-frame sidebar refresh. */
function notify(text, cls, ms) {
  ST.notice = { text: text, cls: cls || "", until: performance.now() + (ms || 5000) };
}

/* ── Canvas plumbing ─────────────────────────────────────────── */
const Y_TOP = -0.12, Y_BOT = 2.18;

function fitField() {
  const cv = document.getElementById("field");
  const box = document.getElementById("fieldbox");
  if (!cv || !box) return;
  const r = box.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = 34;
  const s = Math.min((r.width - pad * 2) / AREA.w, (r.height - pad * 2) / (Y_BOT - Y_TOP));
  ST.view = {
    s: s,
    ox: (r.width - AREA.w * s) / 2.0,
    oy: (r.height - (Y_BOT - Y_TOP) * s) / 2.0 - Y_TOP * s,
    cw: r.width, ch: r.height
  };
}

const PX = (x, y) => [ST.view.ox + x * ST.view.s, ST.view.oy + y * ST.view.s];
const UNPX = (px, py) => ({
  x: (px - ST.view.ox) / ST.view.s,
  y: (py - ST.view.oy) / ST.view.s
});

/* ── Per-sensor bookkeeping ──────────────────────────────────── */
function sensorCount() { return Tracker.sensors.length; }

function ensureBuffers() {
  const n = sensorCount();
  if (ST.hist.length !== n) {
    ST.hist = [];
    ST.stats = [];
    for (let i = 0; i < n; i++) {
      ST.hist.push({ fired: new Int32Array(NBINS), total: new Int32Array(NBINS) });
      ST.stats.push({ min: Infinity, max: 0, count: 0 });
    }
    ST.samples = [];
    buildSensorRows();
    buildHistRows();
    buildTuneRows();
    ST.coverageKey = "";
  }
  if (!ST.pristine || ST.pristine.key !== Tracker.layout) {
    ST.pristine = {
      key: Tracker.layout,
      s: Tracker.sensors.map(s => ({ a: s.a, w: s.w }))
    };
  }
}

function binOf(bearing) {
  const b = Math.floor((bearing - BIN_LO) / BIN_DEG);
  return (b < 0 || b >= NBINS) ? -1 : b;
}

/** The ground truth this frame: the placed marker, else the pointer in mouse/sim. */
function truthNow() {
  if (ST.truth) return { p: ST.truth, src: "marker" };
  if (Tracker.src !== "live" && Tracker.mouse.has) {
    return { p: { x: Tracker.mouse.x, y: Tracker.mouse.y }, src: "pointer" };
  }
  return { p: null, src: "none" };
}

function rangeKey() {
  return Tracker.rawRanges.map(v => (v == null ? "-" : Math.round(v * 1000))).join(",");
}

/** Record one measurement against a known truth. */
function recordSample() {
  const t = truthNow();
  if (!t.p) return false;
  const sensors = Tracker.sensors;
  const fired = [], ranges = [];
  for (let i = 0; i < sensors.length; i++) {
    const r = Tracker.rawRanges[i];
    fired.push(r != null);
    ranges.push(r);
    const b = binOf(bearingTo(sensors[i], t.p.x, t.p.y));
    if (b >= 0) {
      ST.hist[i].total[b]++;
      if (r != null) ST.hist[i].fired[b]++;
    }
  }
  ST.samples.push({ x: t.p.x, y: t.p.y, fired: fired, ranges: ranges });
  if (ST.samples.length > 20000) ST.samples.shift();
  return true;
}

/** Range extremes per sensor, accumulated over the whole session.
 *  This is the direct answer to "how far does each sensor actually reach",
 *  so it must run on every measurement — not only during a capture burst. */
function accumulateStats() {
  for (let i = 0; i < ST.stats.length; i++) {
    const r = Tracker.rawRanges[i];
    if (r == null) continue;
    ST.stats[i].min = Math.min(ST.stats[i].min, r);
    ST.stats[i].max = Math.max(ST.stats[i].max, r);
    ST.stats[i].count++;
  }
}

/* ── Coverage map ────────────────────────────────────────────── */
function coneKey() {
  return Tracker.sensors.map(s => `${s.x},${s.y},${s.a},${s.w}`).join("|");
}

function computeCoverage() {
  const k = coneKey();
  if (ST.coverageKey === k) return ST.coverage;
  const sensors = Tracker.sensors;
  const boxes = groupBoxes(sensors);
  const NX = 56, NY = 52;
  const cells = new Uint8Array(NX * NY);
  let two = 0, one = 0, none = 0;

  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY; j++) {
      const x = ((i + 0.5) / NX) * AREA.w;
      const y = AREA.yNear + ((j + 0.5) / NY) * (AREA.yFar - AREA.yNear);
      let live = 0;
      for (const b of boxes) {
        let sees = false;
        for (const si of b.idx) {
          const s = sensors[si];
          const d = Math.hypot(x - s.x, y - s.y) - AREA.bodyR;
          if (d > BEAM.maxRange || d < BEAM.minRange) continue;
          if (Math.abs(bearingTo(s, x, y) - s.a) <= beamHalf(s)) { sees = true; break; }
        }
        if (sees) live++;
      }
      const v = live >= 2 ? 2 : (live === 1 ? 1 : 0);
      cells[i * NY + j] = v;
      if (v === 2) two++; else if (v === 1) one++; else none++;
    }
  }
  const tot = NX * NY;
  ST.coverage = { cells: cells, NX: NX, NY: NY, two: two / tot, one: one / tot, none: none / tot };
  ST.coverageKey = k;
  return ST.coverage;
}

/* ── Drawing ─────────────────────────────────────────────────── */
function drawField() {
  const cv = document.getElementById("field");
  if (!cv) return;
  const c = cv.getContext("2d");
  const W = ST.view.cw, H = ST.view.ch;
  const s = ST.view.s;
  const sensors = Tracker.sensors;
  c.clearRect(0, 0, W, H);

  // Coverage heat map, underneath everything
  if (ST.layers.heat) {
    const cov = computeCoverage();
    const cw = (AREA.w / cov.NX) * s;
    const chh = ((AREA.yFar - AREA.yNear) / cov.NY) * s;
    for (let i = 0; i < cov.NX; i++) {
      for (let j = 0; j < cov.NY; j++) {
        const v = cov.cells[i * cov.NY + j];
        c.fillStyle = v === 2 ? "rgba(155,232,107,.20)"
                    : v === 1 ? "rgba(255,176,32,.20)"
                    : "rgba(255,77,61,.22)";
        const [px, py] = PX((i / cov.NX) * AREA.w, AREA.yNear + (j / cov.NY) * (AREA.yFar - AREA.yNear));
        c.fillRect(px, py, cw + 0.6, chh + 0.6);
      }
    }
  }

  // Wall / screen plane
  const [wx, wy] = PX(0, 0);
  c.fillStyle = "#2A353F";
  c.fillRect(wx - 12, wy - 9, AREA.w * s + 24, 9);
  c.fillStyle = "#7C8A99";
  c.font = "600 10px 'JetBrains Mono',monospace";
  c.textAlign = "center";
  c.fillText("SCREEN / WALL", wx + (AREA.w * s) / 2, wy - 14);

  // Dead zone + play area
  c.fillStyle = "rgba(255,77,61,.10)";
  c.fillRect(wx, wy, AREA.w * s, AREA.dead * s);
  const [, ny] = PX(0, AREA.yNear);
  c.strokeStyle = "rgba(255,77,61,.45)";
  c.setLineDash([5, 4]); c.lineWidth = 1;
  c.beginPath(); c.moveTo(wx, ny); c.lineTo(wx + AREA.w * s, ny); c.stroke();
  c.setLineDash([]);

  c.strokeStyle = "rgba(155,232,107,.5)";
  c.lineWidth = 1.5;
  c.strokeRect(wx, ny, AREA.w * s, (AREA.yFar - AREA.yNear) * s);

  // Metre grid
  if (ST.layers.grid) {
    c.strokeStyle = "rgba(124,138,153,.16)";
    c.lineWidth = 1;
    c.font = "500 8px 'JetBrains Mono',monospace";
    c.fillStyle = "rgba(124,138,153,.7)";
    for (let gx = 0; gx <= AREA.w + 1e-6; gx += 0.25) {
      const [px] = PX(gx, 0);
      c.beginPath(); c.moveTo(px, PX(0, 0)[1]); c.lineTo(px, PX(0, AREA.yFar)[1]); c.stroke();
      c.textAlign = "center";
      c.fillText(gx.toFixed(2), px, PX(0, AREA.yFar)[1] + 12);
    }
    for (let gy = 0.25; gy <= AREA.yFar + 1e-6; gy += 0.25) {
      const [, py] = PX(0, gy);
      c.beginPath(); c.moveTo(wx, py); c.lineTo(wx + AREA.w * s, py); c.stroke();
      c.textAlign = "right";
      c.fillText(gy.toFixed(2), wx - 5, py + 3);
    }
  }

  // Calibration samples
  if (ST.layers.samples && ST.samples.length) {
    for (const smp of ST.samples) {
      const [px, py] = PX(smp.x, smp.y);
      const n = smp.fired.filter(Boolean).length;
      c.fillStyle = n >= 3 ? "rgba(155,232,107,.55)"
                  : n === 2 ? "rgba(69,208,232,.5)"
                  : n === 1 ? "rgba(255,176,32,.5)"
                  : "rgba(255,77,61,.5)";
      c.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
  }

  // Sensor cones
  const maxR = BEAM.maxRange * s;
  sensors.forEach((sen, i) => {
    const [px, py] = PX(sen.x, sen.y);
    const face = sen.a * DEG, half = beamHalf(sen) * DEG;
    const col = SCOL[i % SCOL.length];

    if (ST.layers.cones) {
      c.save();
      c.beginPath();
      c.moveTo(px, py);
      c.arc(px, py, maxR, Math.PI / 2 - face - half, Math.PI / 2 - face + half);
      c.closePath();
      c.fillStyle = col + "16";
      c.fill();
      c.strokeStyle = col + "66";
      c.lineWidth = 1;
      c.stroke();
      // Centre line
      c.strokeStyle = col + "44";
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px + Math.sin(face) * maxR, py + Math.cos(face) * maxR);
      c.stroke();
      c.setLineDash([]);
      c.restore();
    }

    // Live range arc
    const r = Tracker.ranges[i];
    if (ST.layers.arcs && r != null) {
      const d = (r + AREA.bodyR) * s;
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(px, py, d, Math.PI / 2 - face - half, Math.PI / 2 - face + half);
      c.stroke();
    }
  });

  // Active sector wedges
  if (ST.layers.sectors && Tracker.fix && Tracker.fix.boxes) {
    for (const bi of Tracker.fix.boxes) {
      if (!bi.sec || bi.d == null) continue;
      const [px, py] = PX(bi.box.x, bi.box.y);
      const d = bi.d * s;
      c.save();
      c.beginPath();
      c.moveTo(px, py);
      c.arc(px, py, d, Math.PI / 2 - bi.sec.hi * DEG, Math.PI / 2 - bi.sec.lo * DEG);
      c.closePath();
      c.fillStyle = bi.sec.conflict ? "rgba(255,77,61,.20)" : "rgba(255,255,255,.13)";
      c.fill();
      c.strokeStyle = bi.sec.conflict ? "rgba(255,77,61,.8)" : "rgba(255,255,255,.55)";
      c.lineWidth = 1.5;
      c.stroke();
      c.restore();
    }
  }

  // Both intersection candidates
  if (ST.layers.cands && Tracker.fix && Tracker.fix.candidates) {
    Tracker.fix.candidates.forEach((cand, i) => {
      const [px, py] = PX(cand.x, cand.y);
      const chosen = i === Tracker.fix.chosen;
      c.strokeStyle = chosen ? "rgba(155,232,107,.95)" : "rgba(255,77,61,.75)";
      c.lineWidth = chosen ? 2 : 1.5;
      c.beginPath(); c.arc(px, py, chosen ? 9 : 6, 0, 7); c.stroke();
      if (!chosen) {
        c.beginPath();
        c.moveTo(px - 4, py - 4); c.lineTo(px + 4, py + 4);
        c.moveTo(px + 4, py - 4); c.lineTo(px - 4, py + 4);
        c.stroke();
      }
    });
  }

  // Legacy solver answer
  if (ST.layers.legacy && ST.legacyFix) {
    const [px, py] = PX(ST.legacyFix.x, ST.legacyFix.y);
    c.strokeStyle = "rgba(180,140,255,.9)";
    c.lineWidth = 2;
    c.beginPath(); c.rect(px - 7, py - 7, 14, 14); c.stroke();
    c.fillStyle = "rgba(180,140,255,.9)";
    c.font = "600 9px 'JetBrains Mono',monospace";
    c.textAlign = "left";
    c.fillText("old", px + 10, py + 3);
  }

  // Sensor bodies (drawn over the cones)
  sensors.forEach((sen, i) => {
    const [px, py] = PX(sen.x, sen.y);
    const lit = Tracker.ranges[i] != null;
    c.fillStyle = lit ? SCOL[i % SCOL.length] : "#3A4550";
    c.fillRect(px - 8, py - 7, 16, 14);
    c.fillStyle = "#0C1014";
    c.font = "700 9px 'JetBrains Mono',monospace";
    c.textAlign = "center";
    c.fillText(sen.n != null ? sen.n : i, px, py + 3);
  });

  // Truth marker
  const t = truthNow();
  if (t.p) {
    const [px, py] = PX(t.p.x, t.p.y);
    c.strokeStyle = "#FFFFFF";
    c.lineWidth = 1.5;
    c.setLineDash([4, 3]);
    c.beginPath(); c.arc(px, py, 13, 0, 7); c.stroke();
    c.setLineDash([]);
    c.beginPath();
    c.moveTo(px - 17, py); c.lineTo(px + 17, py);
    c.moveTo(px, py - 17); c.lineTo(px, py + 17);
    c.stroke();
  }

  // Solved position + uncertainty
  if (Tracker.pos) {
    const [px, py] = PX(Tracker.pos.x, Tracker.pos.y);
    const degraded = Tracker.mode === "one-box" || Tracker.veto;
    const col = Tracker.veto ? "#FF4D3D" : degraded ? "#FFB020" : "#9BE86B";

    if (isFinite(Tracker.sigma) && Tracker.sigma > 0.02) {
      c.strokeStyle = col + "55";
      c.lineWidth = 1;
      c.beginPath(); c.arc(px, py, Tracker.sigma * s, 0, 7); c.stroke();
    }
    c.fillStyle = col + "26";
    c.beginPath(); c.arc(px, py, AREA.bodyR * s, 0, 7); c.fill();
    c.strokeStyle = col;
    c.lineWidth = 2;
    if (degraded) c.setLineDash([6, 5]);
    c.beginPath(); c.arc(px, py, AREA.bodyR * s, 0, 7); c.stroke();
    c.setLineDash([]);
    c.fillStyle = col;
    c.beginPath(); c.arc(px, py, 4, 0, 7); c.fill();
  }

  // Unfiltered fix
  if (Tracker.raw && Tracker.src !== "mouse") {
    const [px, py] = PX(Tracker.raw.x, Tracker.raw.y);
    c.fillStyle = "rgba(255,255,255,.6)";
    c.beginPath(); c.arc(px, py, 2.5, 0, 7); c.fill();
  }
}

/* ── Sidebar: static row construction ────────────────────────── */
function buildSensorRows() {
  const body = document.getElementById("sensBody");
  if (!body) return;
  body.innerHTML = "";
  Tracker.sensors.forEach((sen, i) => {
    const tr = document.createElement("tr");
    tr.id = "srow" + i;
    tr.innerHTML =
      `<td><span class="swatch" style="background:${SCOL[i % SCOL.length]}"></span>` +
      `${sen.n != null ? sen.n : i}</td>` +
      `<td id="sraw${i}">—</td><td id="smed${i}">—</td><td id="sech${i}">—</td>` +
      `<td id="smin${i}">—</td><td id="smax${i}">—</td><td id="sbrg${i}">—</td>`;
    body.appendChild(tr);
  });
}

function buildHistRows() {
  const host = document.getElementById("histList");
  if (!host) return;
  host.innerHTML = "";
  Tracker.sensors.forEach((sen, i) => {
    const d = document.createElement("div");
    d.className = "histrow";
    d.innerHTML =
      `<div class="histlab"><span><span class="swatch" style="background:${SCOL[i % SCOL.length]}"></span>` +
      `${sen.n != null ? sen.n : i}</span><span id="hfit${i}">no samples</span></div>` +
      `<canvas class="hist" id="hist${i}" width="360" height="26"></canvas>`;
    host.appendChild(d);
  });
}

function buildTuneRows() {
  const host = document.getElementById("tuneList");
  if (!host) return;
  host.innerHTML = "";
  Tracker.sensors.forEach((sen, i) => {
    const d = document.createElement("div");
    d.innerHTML =
      `<div class="tunerow"><span style="color:${SCOL[i % SCOL.length]}">${sen.n != null ? sen.n : i}a</span>` +
      `<input type="range" id="ta${i}" min="-90" max="90" step="0.5" value="${sen.a}">` +
      `<b id="tav${i}">${sen.a.toFixed(1)}°</b></div>` +
      `<div class="tunerow"><span style="color:${SCOL[i % SCOL.length]}">${sen.n != null ? sen.n : i}w</span>` +
      `<input type="range" id="tw${i}" min="10" max="100" step="1" value="${beamHalf(sen) * 2}">` +
      `<b id="twv${i}">${(beamHalf(sen) * 2).toFixed(0)}°</b></div>`;
    host.appendChild(d);
    d.querySelector("#ta" + i).oninput = e => {
      Tracker.sensors[i].a = +e.target.value;
      document.getElementById("tav" + i).textContent = (+e.target.value).toFixed(1) + "°";
    };
    d.querySelector("#tw" + i).oninput = e => {
      Tracker.sensors[i].w = +e.target.value;
      document.getElementById("twv" + i).textContent = (+e.target.value).toFixed(0) + "°";
    };
  });
}

/* ── Bearing histogram rendering + cone fitting ──────────────── */
function drawHistograms() {
  Tracker.sensors.forEach((sen, i) => {
    const cv = document.getElementById("hist" + i);
    if (!cv) return;
    const c = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#10161C";
    c.fillRect(0, 0, W, H);

    const h = ST.hist[i];
    const bw = W / NBINS;
    for (let b = 0; b < NBINS; b++) {
      if (!h.total[b]) continue;
      const rate = h.fired[b] / h.total[b];
      c.fillStyle = rate >= 0.5
        ? `rgba(155,232,107,${0.35 + 0.6 * rate})`
        : `rgba(255,77,61,${0.30 + 0.5 * (1 - rate)})`;
      c.fillRect(b * bw, 0, Math.ceil(bw), H);
    }

    // Configured cone brackets
    const toX = deg => ((deg - BIN_LO) / (BIN_HI - BIN_LO)) * W;
    const half = beamHalf(sen);
    c.strokeStyle = "#FFFFFF";
    c.lineWidth = 1.5;
    [sen.a - half, sen.a + half].forEach(d => {
      const x = toX(d);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    });
    c.strokeStyle = "rgba(255,255,255,.45)";
    c.setLineDash([2, 3]);
    c.beginPath(); c.moveTo(toX(sen.a), 0); c.lineTo(toX(sen.a), H); c.stroke();
    c.setLineDash([]);

    // Zero bearing reference
    c.strokeStyle = "rgba(124,138,153,.5)";
    c.beginPath(); c.moveTo(toX(0), 0); c.lineTo(toX(0), H); c.stroke();

    const fit = fitCone(i);
    const lab = document.getElementById("hfit" + i);
    if (lab) {
      if (!fit) {
        lab.textContent = "no samples";
        lab.className = "";
      } else if (fit.poor) {
        lab.textContent = fit.why;
        lab.className = "warn";
      } else {
        lab.textContent = `aim ${fit.aim.toFixed(1)}° · width ${fit.width.toFixed(1)}° ` +
                          `(n=${fit.n}${fit.trusted ? "" : ", " + fit.edges + " edge only"})`;
        lab.className = !fit.trusted ? "warn"
                      : Math.abs(fit.width - beamHalf(sen) * 2) > 8 ? "warn" : "ok";
      }
    }
  });
}

/**
 * Fit one cone from the bearing histogram.
 *
 * Sampling is discrete: you stand on a dozen spots, so most 2 deg bins hold no
 * data at all. An empty bin means "never tested here", NOT "the sensor was
 * silent here" — treating the two the same chops a real 40 deg cone into 8 deg
 * fragments. So the fired run extends straight across empty bins and only ever
 * terminates at a bin that has data and was majority-silent.
 *
 * The true edge lies somewhere between the outermost bin that fired and the
 * nearest bin that stayed silent, so the edge estimate is the midpoint of that
 * bracket. Without a silent bin on a side, that side is unbounded and the fit
 * is reported (so you can see it) but refused for Apply.
 */
function binCentre(b) { return BIN_LO + (b + 0.5) * BIN_DEG; }

function fitCone(i) {
  const h = ST.hist[i];
  let total = 0;
  const firedB = [], silentB = [];
  for (let b = 0; b < NBINS; b++) {
    total += h.total[b];
    if (h.total[b] < MIN_BIN_SAMPLES) continue;          // no evidence either way
    (h.fired[b] / h.total[b] >= 0.5 ? firedB : silentB).push(b);
  }
  const binsWithData = firedB.length + silentB.length;

  if (total < 20) return null;
  if (binsWithData < MIN_BINS) {
    return { poor: true, binsWithData: binsWithData,
             why: `only ${binsWithData} bearing${binsWithData === 1 ? "" : "s"} sampled — move around more` };
  }
  if (!firedB.length) {
    return { poor: true, binsWithData: binsWithData,
             why: "never fired at any sampled bearing" };
  }

  // Cluster the fired bins, splitting only where a SILENT bin sits between them.
  let best = [firedB[0]], cur = [firedB[0]];
  for (let k = 1; k < firedB.length; k++) {
    const prev = firedB[k - 1], b = firedB[k];
    const blocked = silentB.some(sb => sb > prev && sb < b);
    if (blocked) cur = [b];
    else cur.push(b);
    if (cur[cur.length - 1] - cur[0] > best[best.length - 1] - best[0]) best = cur.slice();
  }

  const loF = best[0], hiF = best[best.length - 1];
  let sLo = null, sHi = null;
  for (const sb of silentB) {
    if (sb < loF && (sLo === null || sb > sLo)) sLo = sb;
    if (sb > hiF && (sHi === null || sb < sHi)) sHi = sb;
  }

  // Edge = midway between the last bin that fired and the first that did not.
  const edgeLo = sLo !== null ? (binCentre(sLo) + binCentre(loF)) / 2
                              : binCentre(loF) - BIN_DEG / 2;
  const edgeHi = sHi !== null ? (binCentre(hiF) + binCentre(sHi)) / 2
                              : binCentre(hiF) + BIN_DEG / 2;

  let n = 0;
  for (const b of best) n += h.total[b];

  return {
    lo: edgeLo, hi: edgeHi, aim: (edgeLo + edgeHi) / 2, width: edgeHi - edgeLo,
    n: n, binsWithData: binsWithData,
    edges: (sLo !== null && sHi !== null) ? "both" : sLo !== null ? "low" : sHi !== null ? "high" : "none",
    trusted: sLo !== null && sHi !== null,
    why: (sLo !== null && sHi !== null) ? ""
         : "edge unbounded — also capture spots OUTSIDE this sensor's cone"
  };
}

/* ── Sidebar: live values ────────────────────────────────────── */
function setText(id, v, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = v;
  if (cls !== undefined) el.className = el.className.replace(/\b(ok|warn|bad)\b/g, "").trim() + (cls ? " " + cls : "");
}

const MM = v => (v == null ? "—" : (v * 1000).toFixed(0) + " mm");

function updateSidebar() {
  const sensors = Tracker.sensors;
  const fix = Tracker.fix;
  const fills = Tracker.fillRates();
  const t = truthNow();

  // Header
  const MODEL = { mouse: "POINTER", "two-box": "TWO-BOX", "one-box": "ONE-BOX", blind: "NO FIX" };
  setText("hMode", MODEL[Tracker.mode] || Tracker.mode);
  const hm = document.getElementById("hMode");
  if (hm) hm.style.color = Tracker.veto ? "var(--alarm)"
                         : Tracker.mode === "one-box" ? "var(--amber)"
                         : Tracker.mode === "blind" ? "var(--text-dim)" : "var(--signal)";
  setText("hEch", `${Tracker.nSensors} / ${sensors.length}`);
  setText("hHz", `${Tracker.measHz.toFixed(1)} Hz`);
  setText("hReason", Tracker.reason || (
    Tracker.mode === "two-box" ? "clean two-box fix, no disagreement" :
    Tracker.mode === "mouse" ? "pointer is the ground truth" : "—"));

  // Per-sensor table
  sensors.forEach((sen, i) => {
    const raw = Tracker.rawRanges[i], med = Tracker.ranges[i];
    const st = ST.stats[i];
    setText("sraw" + i, MM(raw));
    setText("smed" + i, MM(med));
    setText("sech" + i, Tracker.src === "mouse"
      ? (raw != null ? "100%" : "0%")
      : ((fills[i] || 0) * 100).toFixed(0) + "%");
    setText("smin" + i, st.count ? MM(st.min) : "—");
    setText("smax" + i, st.count ? MM(st.max) : "—");
    const ref = t.p || Tracker.pos;
    setText("sbrg" + i, ref ? bearingTo(sen, ref.x, ref.y).toFixed(1) + "°" : "—");
    const row = document.getElementById("srow" + i);
    if (row) row.className = med != null ? "live" : "dead";
  });

  // Solve panel
  setText("kMode", MODEL[Tracker.mode] || Tracker.mode,
          Tracker.veto ? "bad" : Tracker.mode === "one-box" ? "warn" : Tracker.mode === "two-box" ? "ok" : "");
  setText("kPos", Tracker.pos ? `${Tracker.pos.x.toFixed(3)}, ${Tracker.pos.y.toFixed(3)}` : "—");
  setText("kSigma", isFinite(Tracker.sigma) ? MM(Tracker.sigma) : "—");
  setText("kGap", fix ? MM(fix.gap) : "—", fix && fix.gap > SOLVER.maxGap ? "bad" : "");
  setText("kSpread", fix ? MM(fix.spread) : "—",
          fix && fix.spread > SOLVER.pairSpreadWarn ? "warn" : "");
  setText("kMiss", fix ? (fix.worstMiss || 0).toFixed(1) + "°" : "—",
          fix && fix.worstMiss > SOLVER.sectorTolDeg ? "bad" : "");
  setText("kRes", fix ? MM(fix.residual) : "—");
  setText("kGate", String(Tracker.gateRejects), Tracker.gateRejects > 0 ? "warn" : "");
  setText("kReason", Tracker.reason || (
    Tracker.mode === "two-box" ? "clean two-box fix — both boxes agree and the "
      + "fix sits inside every firing sensor's cone" : "—"));

  // Old solver, for comparison
  ST.legacyFix = (Tracker.src === "mouse") ? null : solvePosition(Tracker.ranges, sensors);
  if (ST.legacyFix) {
    setText("kLegacy", `${ST.legacyFix.x.toFixed(3)}, ${ST.legacyFix.y.toFixed(3)}`);
    if (Tracker.raw) {
      const d = Math.hypot(ST.legacyFix.x - Tracker.raw.x, ST.legacyFix.y - Tracker.raw.y);
      setText("kDelta", MM(d));
    } else setText("kDelta", "—");
  } else {
    setText("kLegacy", Tracker.src === "mouse" ? "n/a" : "no fix (needs 2)", "warn");
    setText("kDelta", "—");
  }

  // Sector list
  const host = document.getElementById("sectorList");
  if (host) {
    if (!fix || !fix.boxes) host.innerHTML = '<div class="kv"><span>—</span><span>—</span></div>';
    else {
      host.innerHTML = fix.boxes.map(bi => {
        const names = bi.box.idx.map(i => {
          const s = sensors[i];
          const nm = s.n != null ? s.n : i;
          return fix.fired[i] ? `<b style="color:${SCOL[i % SCOL.length]}">${nm}</b>` : `<span style="opacity:.35">${nm}</span>`;
        }).join(" ");
        const sec = bi.sec;
        const val = !sec ? "silent"
          : `${sec.lo.toFixed(1)}° … ${sec.hi.toFixed(1)}°  (${sec.width.toFixed(1)}° wide)`;
        const cls = !sec ? "" : sec.conflict ? "bad" : sec.width <= 20 ? "ok" : "";
        return `<div class="kv"><span>Box ${bi.box.id} &nbsp;${names}</span>` +
               `<span class="${cls}">${val}</span></div>`;
      }).join("");
    }
  }

  // Field footer
  setText("fPtr", ST.ptr ? `${ST.ptr.x.toFixed(2)}, ${ST.ptr.y.toFixed(2)}` : "—");
  setText("fTruth", t.p ? `${t.p.x.toFixed(2)}, ${t.p.y.toFixed(2)} (${t.src})` : "not set");
  setText("fFix", Tracker.pos ? `${Tracker.pos.x.toFixed(2)}, ${Tracker.pos.y.toFixed(2)}` : "—");
  setText("fErr", (t.p && Tracker.pos)
    ? MM(Math.hypot(Tracker.pos.x - t.p.x, Tracker.pos.y - t.p.y)) : "—");

  // Calibration
  setText("cSamples", String(ST.samples.length));
  setText("cTruthSrc", t.src);
  if (ST.notice && performance.now() > ST.notice.until) ST.notice = null;
  if (ST.capture.active) {
    setText("cStatus", `capturing ${ST.capture.left} more…`, "warn");
  } else if (ST.notice) {
    setText("cStatus", ST.notice.text, ST.notice.cls);
  } else {
    setText("cStatus", "idle", "");
  }

  // Coverage
  const cov = computeCoverage();
  setText("covTwo", (cov.two * 100).toFixed(1) + "%", cov.two > 0.7 ? "ok" : "warn");
  setText("covOne", (cov.one * 100).toFixed(1) + "%");
  setText("covNone", (cov.none * 100).toFixed(1) + "%", cov.none > 0.05 ? "bad" : "ok");
}

/* ── Config export ───────────────────────────────────────────── */
function emitConfig() {
  const sensors = Tracker.sensors;
  const js = sensors.map(s =>
    `      { n: "${s.n}", x: ${s.x.toFixed(2)}, y: ${s.y.toFixed(2)}, ` +
    `a: ${s.a.toFixed(2)}, w: ${(beamHalf(s) * 2).toFixed(1)} }`).join(",\n");
  const py = sensors.map(s =>
    `        (${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.a.toFixed(2)}, ${(beamHalf(s) * 2).toFixed(1)}),  # ${s.n}`
  ).join("\n");
  const out =
    `// game/js/config.js  ->  LAYOUTS["${Tracker.layout}"].s\n` +
    `    s: [\n${js}\n    ]\n\n` +
    `# bridge/config.py  ->  LAYOUTS["${Tracker.layout}"]\n` +
    `    "${Tracker.layout}": [\n${py}\n    ],\n`;
  const el = document.getElementById("cfgOut");
  if (el) { el.value = out; el.select(); }
  try { document.execCommand("copy"); } catch (e) {}
}

function exportCSV() {
  const sensors = Tracker.sensors;
  const head = ["truth_x_m", "truth_y_m"]
    .concat(sensors.map((s, i) => `r_${s.n != null ? s.n : i}_mm`))
    .concat(sensors.map((s, i) => `fired_${s.n != null ? s.n : i}`))
    .concat(sensors.map((s, i) => `bearing_${s.n != null ? s.n : i}_deg`));
  const rows = [head.join(",")];
  for (const smp of ST.samples) {
    const brg = sensors.map(s => bearingTo(s, smp.x, smp.y).toFixed(2));
    rows.push([smp.x.toFixed(4), smp.y.toFixed(4)]
      .concat(smp.ranges.map(r => (r == null ? "" : (r * 1000).toFixed(0))))
      .concat(smp.fired.map(f => (f ? 1 : 0)))
      .concat(brg).join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `molefield_calibration_${Tracker.layout}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function applyFits() {
  let applied = 0;
  const refused = [];
  Tracker.sensors.forEach((sen, i) => {
    const f = fitCone(i);
    const nm = sen.n != null ? sen.n : i;
    if (!f) { refused.push(nm + ": no samples"); return; }
    if (f.poor) { refused.push(nm + ": " + f.why); return; }
    if (!f.trusted) { refused.push(nm + ": " + f.why); return; }
    sen.a = +f.aim.toFixed(2);
    sen.w = +f.width.toFixed(1);
    applied++;
    const ta = document.getElementById("ta" + i), tw = document.getElementById("tw" + i);
    if (ta) { ta.value = sen.a; document.getElementById("tav" + i).textContent = sen.a.toFixed(1) + "°"; }
    if (tw) { tw.value = sen.w; document.getElementById("twv" + i).textContent = sen.w.toFixed(0) + "°"; }
  });

  if (applied && !refused.length) {
    notify(`fitted all ${applied} sensors`, "ok", 6000);
  } else if (applied) {
    notify(`fitted ${applied}, refused ${refused.length} — ${refused[0]}`, "warn", 9000);
  } else {
    notify(`nothing fitted — ${refused[0] || "no samples"}`, "bad", 9000);
  }
  ST.coverageKey = "";
}

/* ── Main loop ───────────────────────────────────────────────── */
let stLast = performance.now();
let stW = 0, stH = 0;

function stLoop(now) {
  const dt = Math.min(0.05, (now - stLast) / 1000);
  stLast = now;

  const box = document.getElementById("fieldbox");
  if (box) {
    const r = box.getBoundingClientRect();
    if (Math.abs(r.width - stW) > 1 || Math.abs(r.height - stH) > 1) {
      stW = r.width; stH = r.height; fitField();
    }
  }

  ensureBuffers();
  Tracker.update(dt);

  // Capture bursts record one sample per genuinely new measurement.
  const key = rangeKey();
  if (key !== ST.lastKey) {
    ST.lastKey = key;
    accumulateStats();
    if (ST.capture.active) {
      if (recordSample()) ST.capture.left--;
      if (ST.capture.left <= 0) {
        ST.capture.active = false;
        notify(`captured — ${ST.samples.length} samples total`, "ok", 4000);
      }
    }
  }
  if (ST.capture.active && now - ST.capture.t0 > 6000) ST.capture.active = false;

  drawField();
  drawHistograms();
  updateSidebar();
  requestAnimationFrame(stLoop);
}

/* ── Wiring ──────────────────────────────────────────────────── */
function initSensorTest() {
  ensureBuffers();

  const cv = document.getElementById("field");
  if (cv) {
    cv.addEventListener("pointermove", e => {
      const r = cv.getBoundingClientRect();
      const p = UNPX(e.clientX - r.left, e.clientY - r.top);
      ST.ptr = p;
      if (Tracker.src !== "live") {
        Tracker.mouse.x = Math.max(0, Math.min(AREA.w, p.x));
        Tracker.mouse.y = Math.max(AREA.yVisTop, Math.min(AREA.yFar, p.y));
        Tracker.mouse.has = true;
      }
    });
    cv.addEventListener("pointerleave", () => { Tracker.mouse.has = false; ST.ptr = null; });
    cv.addEventListener("pointerdown", e => {
      const r = cv.getBoundingClientRect();
      ST.truth = UNPX(e.clientX - r.left, e.clientY - r.top);
    });
  }

  window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "c") {
      ST.capture.active = true;
      ST.capture.left = 30;
      ST.capture.t0 = performance.now();
    }
    if (k === "x") ST.truth = null;
  });

  document.querySelectorAll("[data-layer]").forEach(b => {
    b.onclick = () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      ST.layers[b.dataset.layer] = on;
    };
  });

  document.querySelectorAll("[data-src]").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("[data-src]").forEach(o => o.setAttribute("aria-pressed", String(o === b)));
      Tracker.src = b.dataset.src;
      Tracker.pos = null;
      Tracker.fix = null;
      const hint = document.getElementById("stSrcHint");
      if (hint) hint.textContent = SRC_HINT[Tracker.src];
      const wf = document.getElementById("stWsField");
      if (wf) wf.hidden = Tracker.src !== "live";
    };
  });

  document.querySelectorAll("[data-lay]").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("[data-lay]").forEach(o => o.setAttribute("aria-pressed", String(o === b)));
      Tracker.layout = b.dataset.lay;
      Tracker.live.ranges = [];
      Tracker.live.lastKey = "";
      Tracker.rings = [];
      Tracker.pos = null;
      Tracker.fix = null;
      ST.hist = [];
      ST.pristine = null;
      ensureBuffers();
    };
  });

  const wsc = document.getElementById("wsConnect");
  if (wsc) wsc.onclick = () => {
    const u = document.getElementById("wsUrl");
    if (u) Tracker.connect(u.value.trim());
  };

  const bind = (id, out, fn, fmt) => {
    const el = document.getElementById(id.slice(1));
    const o = document.getElementById(out.slice(1));
    if (!el || !o) return;
    const apply = () => { fn(+el.value); o.textContent = fmt(+el.value); };
    el.oninput = apply; apply();
  };
  bind("#sNoise", "#vNoise", v => (Sim.noise = v / 1000), v => v + " mm");
  bind("#sDrop", "#vDrop", v => (Sim.drop = v / 100), v => v + " %");
  bind("#sBeam", "#vBeam", v => (Sim.beamOverride = v), v => v + "°");
  bind("#sAlpha", "#vAlpha", v => (Tracker.alpha = v / 100), v => (v / 100).toFixed(2));

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on("cCapture", () => {
    ST.capture.active = true; ST.capture.left = 30; ST.capture.t0 = performance.now();
  });
  on("cClear", () => {
    ST.samples = [];
    ST.hist = [];
    ST.stats = [];
    ensureBuffers();
  });
  on("cFit", applyFits);
  on("cExport", exportCSV);
  on("tCopy", emitConfig);
  on("tReset", () => {
    if (!ST.pristine) return;
    Tracker.sensors.forEach((s, i) => {
      s.a = ST.pristine.s[i].a;
      s.w = ST.pristine.s[i].w;
    });
    buildTuneRows();
    ST.coverageKey = "";
  });

  const hint = document.getElementById("stSrcHint");
  if (hint) hint.textContent = SRC_HINT[Tracker.src];

  // Bootstrap from the URL the bridge opens (?src=live&ws=8765&layout=…)
  const q = new URLSearchParams(location.search);
  const lay = q.get("layout");
  if (lay && LAYOUTS[lay]) {
    const b = document.querySelector(`[data-lay="${lay}"]`);
    if (b) b.click();
  }
  const wsPort = q.get("ws");
  const wsUrl = document.getElementById("wsUrl");
  if (wsPort && wsUrl) {
    wsUrl.value = /^wss?:/.test(wsPort) ? wsPort : `ws://${location.hostname}:${wsPort}`;
  }
  const src = q.get("src");
  if (src === "live" || src === "sim") {
    const b = document.querySelector(`[data-src="${src}"]`);
    if (b) b.click();
    if (src === "live" && wsUrl) Tracker.connect(wsUrl.value.trim());
  }

  fitField();
  window.addEventListener("resize", fitField);
  requestAnimationFrame(stLoop);
}

window.addEventListener("DOMContentLoaded", initSensorTest);
