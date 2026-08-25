"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Player Position Tracker
   Manages position sources (Mouse, Simulated, Live Hardware WebSocket)
   and applies frame-rate compensated Exponential Moving Average (EMA) filtering.
   ══════════════════════════════════════════════════════════════ */

const Tracker = {
  src: "mouse",
  alpha: 0.35,
  raw: null,
  pos: null,
  ranges: [],
  nSensors: 0,
  res: 0,
  hz: 0,
  lastFrame: 0,
  frames: 0,
  hzT: 0,
  stale: false,
  layout: "4lin",

  get sensors() {
    return LAYOUTS[this.layout].s;
  },

  mouse: {
    x: AREA.w / 2.0,
    y: 1.30,
    has: false
  },

  live: {
    ws: null,
    ranges: [],
    t: 0
  },

  update(dt) {
    let measured = null;

    if (this.src === "mouse") {
      this.ranges = simulateRanges(this.mouse, this.sensors);
      measured = this.mouse.has ? { x: this.mouse.x, y: this.mouse.y } : null;
      this.nSensors = this.ranges.filter(r => r != null).length;
      this.res = 0;
      this.stale = false;
    } else if (this.src === "sim") {
      this.ranges = simulateRanges(this.mouse, this.sensors);
      const fix = solvePosition(this.ranges, this.sensors);
      this.nSensors = this.ranges.filter(r => r != null).length;
      if (fix) {
        measured = fix;
        this.res = fix.res;
        this.stale = false;
      } else {
        this.stale = true;
      }
    } else {
      // Live hardware mode over WebSocket
      const age = performance.now() - this.live.t;
      this.stale = age > 400 || !this.live.ranges.length;
      this.ranges = this.stale ? this.sensors.map(() => null) : this.live.ranges;
      this.nSensors = this.ranges.filter(r => r != null).length;
      if (!this.stale) {
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
      const a = this.src === "mouse" ? 1.0 : this.alpha;
      const b = (a * a) / (2.0 - a); // Optimal beta for critically damped filter
      
      if (!this.pos) {
        this.pos = { x: measured.x, y: measured.y, vx: 0, vy: 0 };
      } else {
        // Alpha-Beta Predict-Correct Filter
        // 1. Predict next state based on current velocity
        let px = this.pos.x + (this.pos.vx || 0) * dt;
        let py = this.pos.y + (this.pos.vy || 0) * dt;
        
        // 2. Calculate residual (measurement error)
        let rx = measured.x - px;
        let ry = measured.y - py;
        
        // 3. Outlier rejection: cap massive instantaneous jumps (>1.0m) to prevent violent jerks
        if (this.src !== "mouse") {
           const jumpDist = Math.hypot(rx, ry);
           if (jumpDist > 1.0) {
             rx = (rx / jumpDist) * 1.0;
             ry = (ry / jumpDist) * 1.0;
           }
        }

        // 4. Correct state
        const safeDt = Math.max(dt, 0.001);
        this.pos.x = px + a * rx;
        this.pos.y = py + a * ry;
        this.pos.vx = (this.pos.vx || 0) + (b / safeDt) * rx;
        this.pos.vy = (this.pos.vy || 0) + (b / safeDt) * ry;
        
        // 5. Apply friction to velocity so cursor stops cleanly when standing still
        this.pos.vx *= 0.85;
        this.pos.vy *= 0.85;
      }
    }

    this.frames++;
    this.hzT += dt;
    if (this.hzT >= 0.5) {
      this.hz = this.frames / this.hzT;
      this.frames = 0;
      this.hzT = 0;
    }
  },

  connect(url) {
    try {
      if (this.live.ws) this.live.ws.close();
    } catch (e) {}

    const wsStateEl = document.getElementById("wsState");
    if (wsStateEl) wsStateEl.textContent = "connecting";

    const ws = new WebSocket(url);
    this.live.ws = ws;

    ws.onopen = () => {
      if (wsStateEl) wsStateEl.textContent = "open";
    };
    ws.onclose = () => {
      if (wsStateEl) wsStateEl.textContent = "closed";
    };
    ws.onerror = () => {
      if (wsStateEl) wsStateEl.textContent = "error";
    };
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (Array.isArray(m.ranges)) {
          const off = (m.box | 0) * m.ranges.length;
          const out =
            this.live.ranges.length === this.sensors.length
              ? this.live.ranges.slice()
              : this.sensors.map(() => null);

          m.ranges.forEach((v, i) => {
            const idx = m.box == null ? i : off + i;
            if (idx < out.length) {
              out[idx] = v == null ? null : v / 1000.0;
            }
          });
          this.live.ranges = out;
        } else if (m.id != null) {
          const out =
            this.live.ranges.length === this.sensors.length
              ? this.live.ranges.slice()
              : this.sensors.map(() => null);
          out[m.id] = m.mm == null ? null : m.mm / 1000.0;
          this.live.ranges = out;
        }
        this.live.t = performance.now();
      } catch (e) {}
    };
  }
};
