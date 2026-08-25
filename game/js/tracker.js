"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Player Position Tracker

   Filtering pipeline (per frame):
     1. median-of-3 on each sensor      -> kills single-frame false echoes
     2. least-squares fit on all sensors -> one position from all 4 ranges
     3. adaptive EMA on the position     -> still when you stand, snappy when you move

   Sensor wiring is fixed: Box 1 (left) = S0,S1 · Box 2 (right) = S2,S3
   ══════════════════════════════════════════════════════════════ */

// Adaptive smoothing. Small corrections are damped hard (kills jitter);
// large corrections pass through almost untouched (kills lag).
const ALPHA_STILL = 0.10;  // smoothing when the fix barely moves
const ALPHA_MOVE  = 1.00;  // smoothing when the fix jumps a long way
const JUMP_FULL   = 0.06;  // metres of jump at which we fully trust the new fix

const Tracker = {
  src: "mouse",
  alpha: 0.35,
  raw: null,
  pos: null,
  ranges: [],
  nSensors: 0,
  res: 0,
  lastFrame: 0,
  stale: false,
  layout: "2box",
  wsState: "closed",

  // Rolling 3-sample history per sensor, for the median filter
  hist: [[], [], [], []],

  get sensors() {
    return LAYOUTS[this.layout].s;
  },

  mouse: { x: AREA.w / 2.0, y: 1.30, has: false },

  live: { ws: null, ranges: [], boxes: [], t: 0 },

  /* Median-of-3 per sensor. A false echo has to survive two more frames
     to move the output, so one-off spikes are discarded outright. */
  medianFilter(raw) {
    return raw.map((r, i) => {
      const h = this.hist[i] || (this.hist[i] = []);
      if (r == null) { h.length = 0; return null; }
      h.push(r);
      if (h.length > 3) h.shift();
      const sorted = h.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    });
  },

  update(dt) {
    let measured = null;

    if (this.src === "mouse") {
      this.ranges = this.medianFilter(simulateRanges(this.mouse, this.sensors));
      measured = this.mouse.has ? { x: this.mouse.x, y: this.mouse.y } : null;
      this.nSensors = this.ranges.filter(r => r != null).length;
      this.res = 0;
      this.stale = false;
    } else {
      const age = performance.now() - this.live.t;
      this.stale = age > 400 || !this.live.ranges.length;
      const rawRanges = this.stale ? this.sensors.map(() => null) : this.live.ranges;
      this.ranges = this.medianFilter(rawRanges);
      this.nSensors = this.ranges.filter(r => r != null).length;
      if (!this.stale) {
        // One position solved from every sensor that reported
        const fix = solvePosition(this.ranges, this.sensors);
        if (fix) {
          measured = fix;
          this.res = fix.res;
        } else {
          this.stale = true;
        }
      }
    }

    if (measured) {
      this.raw = measured;
      if (!this.pos) {
        this.pos = { x: measured.x, y: measured.y };
      } else if (this.src === "mouse") {
        this.pos.x = measured.x;
        this.pos.y = measured.y;
      } else {
        // How far is the new fix from where we think we are?
        const jump = Math.hypot(measured.x - this.pos.x, measured.y - this.pos.y);
        const a = ALPHA_STILL +
                  (ALPHA_MOVE - ALPHA_STILL) * Math.min(1.0, jump / JUMP_FULL);
        const k = 1.0 - Math.pow(1.0 - a, Math.min(3.0, dt * 60.0));
        this.pos.x += (measured.x - this.pos.x) * k;
        this.pos.y += (measured.y - this.pos.y) * k;
      }
    }
  },

  connect(url) {
    try { if (this.live.ws) this.live.ws.close(); } catch (e) {}

    this.wsState = "connecting";
    const ws = new WebSocket(url);
    this.live.ws = ws;

    ws.onopen  = () => { this.wsState = "open"; };
    ws.onclose = () => { this.wsState = "closed"; };
    ws.onerror = () => { this.wsState = "error"; };
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (Array.isArray(m.ranges)) {
          const off = (m.box | 0) * m.ranges.length;
          const out = this.live.ranges.length === this.sensors.length
            ? this.live.ranges.slice()
            : this.sensors.map(() => null);
          m.ranges.forEach((v, i) => {
            const idx = m.box == null ? i : off + i;
            if (idx < out.length) out[idx] = v == null ? null : v / 1000.0;
          });
          this.live.ranges = out;
        } else if (m.id != null) {
          const out = this.live.ranges.length === this.sensors.length
            ? this.live.ranges.slice()
            : this.sensors.map(() => null);
          out[m.id] = m.mm == null ? null : m.mm / 1000.0;
          this.live.ranges = out;
        }
        if (Array.isArray(m.boxes)) this.live.boxes = m.boxes;
        this.live.t = performance.now();
      } catch (e) {}
    };
  }
};