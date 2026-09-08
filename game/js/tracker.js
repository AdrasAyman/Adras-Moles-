"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Player Position Tracker

   Owns the path from raw ranges to a smoothed cursor:

     raw ranges -> median-of-5 -> solveSectors() -> velocity gate
                -> alpha-beta predict/correct -> Tracker.pos

   Two structural fixes over the previous version:

   1. MEASUREMENT-RATE DECOUPLING. Sensors ping at ~15.6 Hz but the
      browser runs at ~60 Hz. The old code re-solved the same stale
      ranges every frame and fed each repeat to the filter as if it
      were a fresh independent observation. Now the filter PREDICTS
      every frame and only CORRECTS when new data actually arrives,
      which is the correct alpha-beta structure for asynchronous
      measurements and is what makes the cursor glide instead of
      staircase.

   2. The velocity gate is a real speed limit (m/s x elapsed) rather
      than the old fixed 1.0 m per-frame clamp, which at 60 fps was
      a 60 m/s limit and therefore never fired.
   ══════════════════════════════════════════════════════════════ */

const Tracker = {
  src: "mouse",
  alpha: 0.35,
<<<<<<< HEAD
  raw: null,          // unfiltered fix from the solver
  pos: null,          // filtered cursor {x,y,vx,vy}
  ranges: [],         // median-filtered surface ranges (metres)
  rawRanges: [],      // pre-median, straight off the wire
  rings: [],          // MedianRing per sensor
=======
  raw: null,
  history: [], // Buffer of recent raw measurements for median filtering
  pos: null,
  ranges: [],
>>>>>>> origin/main
  nSensors: 0,
  res: 0,
  hz: 0,              // render rate
  measHz: 0,          // true measurement rate
  frames: 0,
  hzT: 0,
  measCount: 0,
  measT: 0,
  stale: false,
<<<<<<< HEAD
  layout: "2box4s",

  // Solver output & diagnostics (read by the HUD, radar and test page)
  fix: null,
  mode: "blind",
  sigma: Infinity,
  veto: false,
  reason: "",
  gateRejects: 0,
  gateRejectedSince: 0,
  lastMeasT: 0,
=======
  wsState: "closed",
  layout: "2box4s",
>>>>>>> origin/main

  get sensors() {
    return LAYOUTS[this.layout].s;
  },

  mouse: { x: AREA.w / 2.0, y: 1.30, has: false },

  live: { ws: null, ranges: [], t: 0, pending: false, lastKey: "" },

  simAcc: 0,

  /** Rebuild the median rings when the layout (and so the sensor count) changes. */
  ensureRings() {
    const n = this.sensors.length;
    if (this.rings.length !== n) {
      this.rings = [];
      for (let i = 0; i < n; i++) this.rings.push(new MedianRing(SOLVER.medianWindow));
      this.ranges = new Array(n).fill(null);
      this.rawRanges = new Array(n).fill(null);
    }
  },

<<<<<<< HEAD
  /** Push one raw range vector through the median filter. */
  ingest(raw) {
    this.ensureRings();
    this.rawRanges = raw.slice();
    for (let i = 0; i < this.rings.length; i++) {
      this.rings[i].push(i < raw.length ? raw[i] : null);
    }
    this.ranges = this.rings.map(r => r.value());
    this.measCount++;
  },

  /** Per-sensor echo rate over the median window, for the HUD and test page. */
  fillRates() {
    return this.rings.map(r => r.fill());
=======
  live: {
    ws: null,
    ranges: [],
    boxes: [],
    t: 0
>>>>>>> origin/main
  },

  update(dt) {
    this.ensureRings();
    const now = performance.now();
    let fresh = false;

    /* ── 1. Acquire a measurement, at the true sensor rate ──────── */
    if (this.src === "mouse") {
      // Direct pointer control: no sensors, no filter, no lag.
      this.rawRanges = simulateRanges(this.mouse, this.sensors);
      this.ranges = this.rawRanges;
      this.nSensors = this.ranges.filter(r => r != null).length;
      this.res = 0;
      this.stale = false;
      this.mode = "mouse";
      this.sigma = 0;
      this.veto = false;
      this.reason = "pointer is the ground truth";
      this.fix = null;
      if (this.mouse.has) {
        this.raw = { x: this.mouse.x, y: this.mouse.y };
        this.pos = { x: this.mouse.x, y: this.mouse.y, vx: 0, vy: 0 };
      }
      this.tickRates(dt);
      return;
    }

    if (this.src === "sim") {
      this.simAcc += dt;
      const period = 1.0 / SOLVER.measureHz;
      if (this.simAcc >= period) {
        this.simAcc = Math.min(this.simAcc - period, period);
        this.ingest(simulateRanges(this.mouse, this.sensors));
        fresh = true;
      }
    } else {
      // Live: ingest happens in onmessage; `pending` marks genuinely new data.
      if (this.live.pending) {
        this.live.pending = false;
        fresh = true;
      }
      const age = now - this.live.t;
      if (age > 400 || !this.live.ranges.length) {
        if (!this.stale) {
          for (const r of this.rings) r.clear();
          this.ranges = this.rings.map(() => null);
        }
        this.stale = true;
      }
    }

    /* ── 2. Solve, only when there is something new to solve ────── */
    let measured = null;
    if (fresh) {
      this.stale = false;
      const fix = solveSectors(this.ranges, this.sensors, { prev: this.pos });
      this.fix = fix;
      this.mode = fix.mode;
      this.sigma = fix.sigma;
      this.veto = fix.veto;
      this.reason = fix.reason;
      this.res = fix.residual;
      this.nSensors = this.ranges.filter(r => r != null).length;
      if (fix.x != null) {
        measured = { x: fix.x, y: fix.y };
        this.raw = measured;
      } else {
        this.stale = true;
      }
    }

    /* ── 3. Predict every frame; correct only on a new measurement ── */
    if (this.pos) {
      this.pos.x += (this.pos.vx || 0) * dt;
      this.pos.y += (this.pos.vy || 0) * dt;
    }

    if (measured) {
<<<<<<< HEAD
      const dT = Math.max(0.001, (now - this.lastMeasT) / 1000.0);
      this.lastMeasT = now;

      if (!this.pos) {
        this.pos = { x: measured.x, y: measured.y, vx: 0, vy: 0 };
        this.gateRejects = 0;
      } else {
        const rx = measured.x - this.pos.x;
        const ry = measured.y - this.pos.y;
        const jump = Math.hypot(rx, ry);

        // ── Velocity gate ──
        // A body cannot move further than maxSpeed * elapsed. Reject anything
        // that claims otherwise — but only for a while: after gateTimeoutMs of
        // solid rejection the measurement is probably right and we are the ones
        // who are lost, so re-acquire rather than freezing the cursor forever.
        const budget = SOLVER.maxSpeed * dT + 3.0 * Math.min(this.sigma, 0.5);
        const stuck = this.gateRejects > 0 &&
                      (now - this.gateRejectedSince) > SOLVER.gateTimeoutMs;

        if (jump > budget && !stuck) {
          this.gateRejects++;
          if (this.gateRejects === 1) this.gateRejectedSince = now;
        } else {
          if (stuck) {
            // Re-acquire: snap and drop the stale velocity.
            this.pos.x = measured.x;
            this.pos.y = measured.y;
            this.pos.vx = 0;
            this.pos.vy = 0;
          } else {
            const a = this.alpha;
            const b = (a * a) / (2.0 - a);   // critically damped alpha-beta
            this.pos.x += a * rx;
            this.pos.y += a * ry;
            this.pos.vx = ((this.pos.vx || 0) + (b / dT) * rx) * 0.85;
            this.pos.vy = ((this.pos.vy || 0) + (b / dT) * ry) * 0.85;
          }
          this.gateRejects = 0;
        }
=======
      this.raw = measured;

      // 1. Maintain History Buffer (Windowed median to reject ultrasonic multi-path bounce)
      if (this.src !== "mouse") {
         this.history.push({ x: measured.x, y: measured.y });
         if (this.history.length > 15) this.history.shift(); // ~250ms window
      } else {
         this.history = [{ x: measured.x, y: measured.y }];
      }

      let medX = measured.x, medY = measured.y;
      if (this.history.length > 0) {
        const sortedX = [...this.history].sort((a, b) => a.x - b.x);
        const sortedY = [...this.history].sort((a, b) => a.y - b.y);
        const mid = Math.floor(this.history.length / 2);
        medX = sortedX[mid].x;
        medY = sortedY[mid].y;
      }

      const a = this.src === "mouse" ? 1.0 : this.alpha;
      const b = (a * a) / (2.0 - a);

      if (!this.pos) {
        this.pos = { x: medX, y: medY, vx: 0, vy: 0 };
      } else {
        // 2. Predict next state based on current velocity
        let px = this.pos.x + (this.pos.vx || 0) * dt;
        let py = this.pos.y + (this.pos.vy || 0) * dt;

        // Calculate residual (error between predicted and median measured)
        let rx = medX - px;
        let ry = medY - py;

        // 3. Strict Kinematic Speed Thresholding (V_MAX)
        // Max human sideways movement ~ 4.0 meters per second
        const V_MAX = 4.0;
        const maxJump = V_MAX * dt;
        const jumpDist = Math.hypot(rx, ry);

        if (this.src !== "mouse" && jumpDist > maxJump) {
             rx = (rx / jumpDist) * maxJump;
             ry = (ry / jumpDist) * maxJump;
        }

        // 4. Smooth Gradiate Update
        const safeDt = Math.max(dt, 0.001);
        this.pos.x = px + a * rx;
        this.pos.y = py + a * ry;
        this.pos.vx = (this.pos.vx || 0) + (b / safeDt) * rx;
        this.pos.vy = (this.pos.vy || 0) + (b / safeDt) * ry;

        // Apply friction
        this.pos.vx *= 0.85;
        this.pos.vy *= 0.85;
>>>>>>> origin/main
      }
    }

    this.tickRates(dt);
  },

  tickRates(dt) {
    this.frames++;
    this.hzT += dt;
    this.measT += dt;
    if (this.hzT >= 0.5) {
      this.hz = this.frames / this.hzT;
      this.frames = 0;
      this.hzT = 0;
    }
    if (this.measT >= 1.0) {
      this.measHz = this.measCount / this.measT;
      this.measCount = 0;
      this.measT = 0;
    }
  },

  connect(url) {
    try {
      if (this.live.ws) this.live.ws.close();
    } catch (e) {}

    this.wsState = "connecting";
    const wsStateEl = document.getElementById("wsState");
    if (wsStateEl) wsStateEl.textContent = "connecting";

    const ws = new WebSocket(url);
    this.live.ws = ws;

<<<<<<< HEAD
    ws.onopen = () => { if (wsStateEl) wsStateEl.textContent = "open"; };
    ws.onclose = () => { if (wsStateEl) wsStateEl.textContent = "closed"; };
    ws.onerror = () => { if (wsStateEl) wsStateEl.textContent = "error"; };

=======
    ws.onopen = () => {
      this.wsState = "open";
      if (wsStateEl) wsStateEl.textContent = "open";
    };
    ws.onclose = () => {
      this.wsState = "closed";
      if (wsStateEl) wsStateEl.textContent = "closed";
    };
    ws.onerror = () => {
      this.wsState = "error";
      if (wsStateEl) wsStateEl.textContent = "error";
    };
>>>>>>> origin/main
    ws.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        this.ensureRings();
        const n = this.sensors.length;
        let out = this.live.ranges.length === n ? this.live.ranges.slice()
                                                : new Array(n).fill(null);

        if (Array.isArray(m.ranges)) {
          const off = (m.box | 0) * m.ranges.length;
          m.ranges.forEach((v, i) => {
            const idx = m.box == null ? i : off + i;
            if (idx < out.length) out[idx] = v == null ? null : v / 1000.0;
          });
        } else if (m.id != null) {
          out[m.id] = m.mm == null ? null : m.mm / 1000.0;
        } else {
          return;
        }
<<<<<<< HEAD

        this.live.ranges = out;
=======
        // Per-box health from bridge/pipeline.py — the setup wizard needs this
        if (Array.isArray(m.boxes)) this.live.boxes = m.boxes;

>>>>>>> origin/main
        this.live.t = performance.now();

        // The bridge pumps at 30 Hz but the sensors only ping at ~15.6 Hz, so
        // roughly half the frames are byte-identical repeats. Feeding those to
        // the median filter would double-count them and shrink the effective
        // window, so only accept a genuinely changed vector.
        const key = out.map(v => (v == null ? "-" : Math.round(v * 1000))).join(",");
        if (key !== this.live.lastKey) {
          this.live.lastKey = key;
          this.ingest(out);
          this.live.pending = true;
        }
      } catch (e) {}
    };
  }
};