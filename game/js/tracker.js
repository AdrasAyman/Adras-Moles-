"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Player Position Tracker

     per-sensor readings -> per-sensor median (time-windowed)
       -> solveSectors() -> velocity gate -> alpha-beta -> Tracker.pos

   Sensor boxes upstream AT THEIR OWN DISCRETION: one box may send ten
   times a second while the other sends at random. So:

   - Every sensor keeps its LAST value until it sends a new one; nothing
     is expired for being old. The game always computes with the most
     recent reading each sensor actually gave.
   - A reading counts as new only when that sensor's update counter
     (`seq`, from the bridge) moves. Each sensor's median filter takes
     only its own new readings, so a quiet sensor is never "refreshed"
     with copies of its old value by a chattier neighbour.
   - A solve happens whenever ANY sensor delivers a new reading. The
     filter predicts every frame and corrects only on those solves.
   - Each box may send one value (one 50° sensor) or two (two 25°
     sensors). In live mode the bridge detects which and the tracker
     switches layout to match (`2box2s` / `2box4s`).
   ══════════════════════════════════════════════════════════════ */

const Tracker = {
  src: "mouse",
  alpha: 0.35,
  raw: null,          // unfiltered fix from the solver
  pos: null,          // filtered cursor {x,y,vx,vy}
  ranges: [],         // median-filtered surface ranges used by the last solve (metres)
  rawRanges: [],      // each sensor's latest (held) reading
  rings: [],          // MedianRing per sensor
  nSensors: 0,
  res: 0,
  hz: 0,              // render rate
  measHz: 0,          // solves per second (= new readings from any sensor)
  sensorHz: [],       // new readings per second, per sensor
  sensorT: [],        // performance.now() of each sensor's latest reading (0 = never)
  frames: 0,
  hzT: 0,
  measCount: 0,
  measSeq: 0,
  measT: 0,
  sensorCounts: [],
  dirty: false,
  stale: false,
  wsState: "closed",  // read by the setup wizard (setup.js)
  layout: "2box4s",
  layoutSource: "default",   // "default" | "user" | "bridge"
  valuesPerBox: 2,
  mixed: false,              // bridge saw boxes sending different value counts
  detected: false,           // bridge has decided the value count from real packets
  ageSpreadMs: 0,            // how far apart in time the readings of the last solve were

  // Jitter control (see SOLVER in config.js)
  gates: [],                 // RangeGate per sensor
  rangeHist: [],             // accepted readings per sensor, for the averaged display
  displayRanges: [],         // per-sensor range averaged over SOLVER.averageMs
  fixHist: [],               // accepted positions, for the averaged cursor
  avgWindowMs: 0,            // current averaging window (adapts to walking speed)
  moveSpeed: 0,              // estimated walking speed, m/s
  lastFix: null,             // last accepted (un-averaged) position
  wobble: [],                // recent cursor positions, for jitterMm
  jitterMm: 0,               // RMS wobble of the cursor over the last 2 s

  // Solver output & diagnostics (read by the HUD, radar and test page)
  fix: null,
  mode: "blind",
  sigma: Infinity,
  veto: false,
  reason: "",
  gateRejects: 0,
  gateRejectedSince: 0,
  lastMeasT: 0,

  get sensors() {
    return LAYOUTS[this.layout].s;
  },

  mouse: { x: AREA.w / 2.0, y: 1.30, has: false },

  live: { ws: null, boxes: [], hub: null, lastSeq: [], lastVal: [], gotData: false, t: 0 },

  simNext: [],

  /** Rebuild per-sensor state when the sensor count no longer matches. */
  ensureRings() {
    const n = this.sensors.length;
    if (this.rings.length !== n) this.resetSensors();
  },

  resetSensors() {
    const n = this.sensors.length;
    this.rings = [];
    for (let i = 0; i < n; i++) this.rings.push(new MedianRing(SOLVER.medianWindow));
    this.ranges = new Array(n).fill(null);
    this.rawRanges = new Array(n).fill(null);
    this.sensorT = new Array(n).fill(0);
    this.sensorHz = new Array(n).fill(0);
    this.sensorCounts = new Array(n).fill(0);
    this.gates = [];
    for (let i = 0; i < n; i++) this.gates.push(new RangeGate());
    this.rangeHist = Array.from({ length: n }, () => []);
    this.displayRanges = new Array(n).fill(null);
    this.fixHist = [];
    this.lastFix = null;
    this.live.lastSeq = new Array(n).fill(null);
    this.live.lastVal = new Array(n).fill(undefined);
    this.simNext = [];
    this.dirty = false;
  },

  /** Switch sensor layout, dropping every per-sensor and solver state. */
  setLayout(key, source) {
    if (!LAYOUTS[key]) return;
    const changed = key !== this.layout;
    this.layout = key;
    this.layoutSource = source || "user";
    this.valuesPerBox = Math.max(1, Math.round(this.sensors.length / 2));
    if (changed || this.rings.length !== this.sensors.length) {
      this.resetSensors();
      this.pos = null;
      this.raw = null;
      this.fix = null;
      this.mode = "blind";
      this.gateRejects = 0;
    }
  },

  /** One genuinely new reading from sensor i (metres, or null for no echo). */
  pushReading(i, v, t) {
    if (i < 0 || i >= this.rings.length) return;
    // A reading no walking player could produce is dropped here, before it can
    // reach the median filter or the solver. The sensor keeps its last good value.
    if (this.gates[i] && !this.gates[i].check(v, t)) return;
    this.rings[i].push(v, t);
    this.rangeHist[i].push({ v: v, t: t });
    this.rawRanges[i] = v;
    this.sensorT[i] = t;
    this.sensorCounts[i]++;
    this.dirty = true;
  },

  /** Milliseconds since each sensor last sent a reading (null = never). */
  ages(now) {
    now = now == null ? performance.now() : now;
    return this.sensorT.map(t => (t ? Math.max(0, Math.round(now - t)) : null));
  },

  /** Per-sensor echo share over its recent readings, for the HUD and test page. */
  fillRates() {
    return this.rings.map(r => r.fill());
  },

  /** Simulated boxes: each box keeps its own schedule, as real ones now do. */
  simulate(now) {
    const boxes = boxesFor(this.layout);
    if (this.simNext.length !== boxes.length) this.simNext = boxes.map(() => now);
    let all = null;
    boxes.forEach((b, k) => {
      if (now < this.simNext[k]) return;
      all = all || simulateRanges(this.mouse, this.sensors);
      for (const i of b.idx) this.pushReading(i, all[i], now);
      let gap;
      if (Sim.timing !== "irregular") gap = 1000 / SOLVER.measureHz;
      else if (k === 0) gap = Math.max(20, 100 + gauss() * 30);
      else gap = Math.min(3000, Math.max(50, -Math.log(1 - Math.random()) * 700));
      this.simNext[k] = now + gap;
    });
  },

  update(dt) {
    this.ensureRings();
    const now = performance.now();

    /* ── 1. Acquire readings ─────────────────────────────────── */
    if (this.src === "mouse") {
      // Direct pointer control: no sensors, no filter, no lag.
      this.rawRanges = simulateRanges(this.mouse, this.sensors);
      this.ranges = this.rawRanges;
      this.sensorT = this.sensors.map(() => now);
      this.nSensors = this.ranges.filter(r => r != null).length;
      this.res = 0;
      this.stale = false;
      this.mode = "mouse";
      this.sigma = 0;
      this.veto = false;
      this.reason = "pointer is the ground truth";
      this.fix = null;
      this.ageSpreadMs = 0;
      if (this.mouse.has) {
        this.raw = { x: this.mouse.x, y: this.mouse.y };
        this.pos = { x: this.mouse.x, y: this.mouse.y, vx: 0, vy: 0 };
      }
      this.displayRanges = this.rawRanges;
      this.measureWobble(now);
      this.tickRates(dt);
      return;
    }

    if (this.src === "sim") {
      this.simulate(now);
      this.stale = false;
    } else {
      // Live readings arrive in onmessage. Held values never expire, so the
      // only "stale" state is having received nothing at all yet.
      this.stale = !this.live.gotData;
    }

    /* ── 2. Solve whenever any sensor delivered a new reading ────── */
    let measured = null;
    if (this.dirty) {
      this.dirty = false;
      this.ranges = this.rings.map(r => r.value(now, SOLVER.medianMaxAgeMs));
      this.measCount++;
      this.measSeq++;     // monotonic: lets observers (telemetry.js) spot new data

      const used = this.sensorT.filter((t, i) => t && this.ranges[i] != null);
      this.ageSpreadMs = used.length > 1 ? Math.round(Math.max(...used) - Math.min(...used)) : 0;

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
      }
    }

    /* ── 3. Predict every frame; correct only on a new solve ──────── */
    if (this.pos) {
      this.pos.x += (this.pos.vx || 0) * dt;
      this.pos.y += (this.pos.vy || 0) * dt;
    }

    if (measured) {
      const dT = Math.max(0.001, (now - (this.lastMeasT || now)) / 1000.0);
      this.lastMeasT = now;
      const averaging = SOLVER.averageMs > 0;

      if (!this.pos || !this.lastFix) {
        this.acceptFix(measured, now, true);
        this.gateRejects = 0;
      } else {
        // Gate against the last ACCEPTED fix. The averaged cursor lags behind by
        // design, so gating against it would wrongly reject real walking.
        const ref = averaging ? this.lastFix : this.pos;
        const rx = measured.x - ref.x;
        const ry = measured.y - ref.y;
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
            this.acceptFix(measured, now, true);     // re-acquire: snap, drop history
          } else if (averaging) {
            this.acceptFix(measured, now, false);
          } else {
            const a = this.alpha;
            const b = (a * a) / (2.0 - a);   // critically damped alpha-beta
            // With irregular updates dT can be seconds; cap the velocity term's
            // gain so one slow box can't fling the cursor.
            const dv = Math.max(dT, 0.05);
            this.pos.x += a * rx;
            this.pos.y += a * ry;
            this.pos.vx = ((this.pos.vx || 0) + (b / dv) * rx) * 0.85;
            this.pos.vy = ((this.pos.vy || 0) + (b / dv) * ry) * 0.85;
            this.lastFix = { x: measured.x, y: measured.y };
          }
          this.gateRejects = 0;
        }
      }
    }

    /* ── 4. Averaging: a long window standing still, a short one walking ── */
    if (SOLVER.averageMs > 0 && this.fixHist.length) {
      const h = this.fixHist;
      const keep = Math.max(SOLVER.averageMs, 500) + 50;
      while (h.length > 1 && h[1].t <= now - keep) h.shift();

      // Walking speed from how far the average moved between two 250 ms slices.
      const a = this.timeAverage(h, now - 250, now, ["x", "y"]);
      const b = this.timeAverage(h, now - 500, now - 250, ["x", "y"]);
      this.moveSpeed = Math.hypot(a.x - b.x, a.y - b.y) / 0.25;

      const lo = Math.min(SOLVER.averageMinMs || SOLVER.averageMs, SOLVER.averageMs);
      const f = Math.max(0, Math.min(1, (this.moveSpeed - SOLVER.stillSpeed) / Math.max(0.01, SOLVER.walkSpeed - SOLVER.stillSpeed)));
      const target = SOLVER.averageMs - f * (SOLVER.averageMs - lo);
      // Ease the window toward its target so a change of window never jerks the cursor.
      if (!this.avgWindowMs) this.avgWindowMs = target;
      this.avgWindowMs += (target - this.avgWindowMs) * Math.min(1, dt / 0.25);

      const avg = this.timeAverage(h, now - this.avgWindowMs, now, ["x", "y"]);
      this.pos = { x: avg.x, y: avg.y, vx: 0, vy: 0 };
    }
    this.updateDisplayRanges(now);
    this.measureWobble(now);

    this.tickRates(dt);
  },

  /** Record an accepted position; `snap` restarts the average from here. */
  acceptFix(p, now, snap) {
    if (snap) {
      this.fixHist = [];
      this.avgWindowMs = 0;
      this.pos = { x: p.x, y: p.y, vx: 0, vy: 0 };
    }
    this.fixHist.push({ t: now, x: p.x, y: p.y });
    this.lastFix = { x: p.x, y: p.y };
  },

  /**
   * Time-weighted average of a step signal over the last `windowMs`.
   * Each entry holds from its own time until the next entry (or now), so a
   * position that was current for 400 ms counts four times as much as one that
   * was current for 100 ms — irregular update rates don't bias the result.
   */
  timeAverage(hist, from, to, keys) {
    const out = {};
    let wsum = 0;
    for (const k of keys) out[k] = 0;
    for (let i = 0; i < hist.length; i++) {
      const start = Math.max(hist[i].t, from);
      const end = Math.min(i + 1 < hist.length ? hist[i + 1].t : to, to);
      const w = end - start;
      if (w <= 0) continue;
      for (const k of keys) out[k] += hist[i][k] * w;
      wsum += w;
    }
    if (wsum <= 0) {
      // Nothing inside the window: the value current at `to` is the answer.
      let last = hist[0];
      for (const e of hist) if (e.t <= to) last = e;
      for (const k of keys) out[k] = last[k];
      return out;
    }
    for (const k of keys) out[k] /= wsum;
    return out;
  },

  /** Per-sensor ranges averaged over the same window, for readouts that jitter. */
  updateDisplayRanges(now) {
    for (let i = 0; i < this.rangeHist.length; i++) {
      const h = this.rangeHist[i];
      if (!h.length) { this.displayRanges[i] = null; continue; }
      if (h[h.length - 1].v == null || !(SOLVER.averageMs > 0)) {
        this.displayRanges[i] = h[h.length - 1].v;
        while (h.length > 1) h.shift();
        continue;
      }
      // Average only the echoes; a recent no-echo inside the window is skipped.
      const echoes = h.filter(e => e.v != null);
      this.displayRanges[i] = echoes.length ? this.timeAverage(echoes, now - SOLVER.averageMs, now, ["v"]).v : null;
      while (h.length > 1 && h[1].t <= now - SOLVER.averageMs) h.shift();
    }
  },

  /** RMS distance of the cursor from its own mean over the last 2 s. */
  measureWobble(now) {
    if (!this.pos) { this.wobble = []; this.jitterMm = 0; return; }
    this.wobble.push({ t: now, x: this.pos.x, y: this.pos.y });
    while (this.wobble.length && this.wobble[0].t < now - 2000) this.wobble.shift();
    const n = this.wobble.length;
    let mx = 0, my = 0;
    for (const w of this.wobble) { mx += w.x; my += w.y; }
    mx /= n; my /= n;
    let ss = 0;
    for (const w of this.wobble) ss += (w.x - mx) ** 2 + (w.y - my) ** 2;
    this.jitterMm = Math.sqrt(ss / n) * 1000;
  },

  /** Readings rejected by each sensor's range gate since the page loaded. */
  rangeRejects() {
    return this.gates.map(g => g.total);
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
      this.sensorHz = this.sensorCounts.map(c => c / this.measT);
      this.measCount = 0;
      this.sensorCounts = this.sensorCounts.map(() => 0);
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

    ws.onopen = () => { this.wsState = "open"; if (wsStateEl) wsStateEl.textContent = "open"; };
    ws.onclose = () => { this.wsState = "closed"; if (wsStateEl) wsStateEl.textContent = "closed"; };
    ws.onerror = () => { this.wsState = "error"; if (wsStateEl) wsStateEl.textContent = "error"; };

    ws.onmessage = ev => {
      try {
        this.onFrame(JSON.parse(ev.data));
      } catch (e) {}
    };
  },

  /**
   * Handle one frame. Accepts the bridge format
   *   {layout, values_per_box, ranges:[mm], seq:[...], age_ms:[...], boxes, hub}
   * and, for direct connections, a single box packet {box, ranges:[mm] (1 or 2)}.
   */
  onFrame(m) {
    if (Array.isArray(m.boxes)) this.live.boxes = m.boxes;
    if (m.hub && typeof m.hub === "object") this.live.hub = m.hub;
    if (!Array.isArray(m.ranges)) return;
    if (this.src !== "live") return;
    const now = performance.now();

    // Which layout does this frame describe?
    let key = null;
    if (m.box != null) key = VALUES_PER_BOX_LAYOUT[m.ranges.length];
    else if (m.layout && LAYOUTS[m.layout]) key = m.layout;
    else key = VALUES_PER_BOX_LAYOUT[m.ranges.length / 2];
    if (!key) return;
    if (m.values_per_box) this.valuesPerBox = m.values_per_box;
    this.detected = m.detected !== false;
    this.mixed = !!m.mixed;
    if (key !== this.layout) this.setLayout(key, "bridge");
    else this.layoutSource = "bridge";
    this.ensureRings();

    const mm = v => (v == null ? null : v / 1000.0);
    if (m.box != null) {
      // Direct single-box packet: every value in it is new.
      const vpb = m.ranges.length;
      m.ranges.forEach((v, k) => this.pushReading((m.box | 0) * vpb + k, mm(v), now));
    } else {
      for (let i = 0; i < this.sensors.length; i++) {
        const v = mm(m.ranges[i]);
        const age = Array.isArray(m.age_ms) && m.age_ms[i] != null ? m.age_ms[i] : 0;
        if (Array.isArray(m.seq) && m.seq[i] != null) {
          // New only if this sensor's own counter moved. The first frame after
          // connecting adopts every held value the bridge already has.
          if (m.seq[i] !== this.live.lastSeq[i]) {
            this.live.lastSeq[i] = m.seq[i];
            if (m.seq[i] > 0) this.pushReading(i, v, now - age);
          }
        } else if (v !== this.live.lastVal[i]) {
          // Older bridges without counters: fall back to "value changed".
          this.live.lastVal[i] = v;
          this.pushReading(i, v, now);
        }
      }
    }
    this.live.t = now;
    if (this.sensorT.some(t => t)) this.live.gotData = true;
  }
};
