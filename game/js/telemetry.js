"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Telemetry Recorder

   Records everything measurable on the page into the bridge's
   session database (bridge/telemetry_db.py), viewable on logs.html.

     samples  one per sensor measurement (~15.6 Hz): raw + median
              ranges, solver state, raw/filtered/true position,
              rates, and game state.
     events   game events (spawn, hit, escape, levels, dead zone),
              anomalies detected in the sensor stream, calibration
              actions on the test bench, and system changes.

   Game events are captured by wrapping the game's global functions
   (spawn, hit, startLevel, levelComplete, endRun) — game.js itself
   is untouched. A new session starts whenever the position source
   or sensor layout changes, so every session is one consistent setup.

   If the bridge is unreachable (e.g. the page was opened as a file)
   data is buffered and retried; nothing on the page depends on it.
   ══════════════════════════════════════════════════════════════ */

const Telemetry = (() => {
  const API = "/api/sessions";
  const FLUSH_MS = 2000;
  const IDLE_SAMPLE_MS = 1000;       // mouse mode with nobody using the page
  const ACTIVE_SAMPLE_MS = 64;       // mouse mode in use: match the sensor rate
  const MAX_BUFFER = 20000;          // rows kept while the bridge is unreachable
  const PAUSE_KEY = "molefield.telemetry.paused";

  // Anomaly thresholds (documented on logs.html so the report can cite them)
  const SPIKE_MM = 300;              // raw departs from its own median by this much
  const DROPOUT_MIN = 5;             // consecutive silent measurements (~320 ms)
  const JUMP_M = 0.6;                // raw fix moves this far between measurements
  const LOW_RATE_HZ = 10;
  const LOW_FPS = 30;
  const SUSTAIN_MS = 2000;

  const page = location.pathname.indexOf("sensortest") >= 0 ? "bench" : "game";
  const now = () => performance.now();

  const S = {
    sid: null, starting: false, t0: now(), key: "",
    samples: [], events: [], sent: { samples: 0, events: 0 },
    online: null, lastFlush: 0, retryAt: 0,
    paused: false,
    lastSeq: -1, lastSampleAt: 0,
    fps: 0, fpsFrames: 0, fpsT: now(), lastFrame: now(),
    // detector state
    prevRaw: null, dropRun: [], cooldown: {},
    blindSince: null, staleSince: null, lowRateSince: null, lowFpsSince: null,
    prevVeto: false, prevSplit: false, prevConflict: false, prevRejects: 0, maxRejects: 0,
    prevWs: null, boxAlive: {}, badPackets: null,
    // game state
    moleId: 0, moles: new Map(), phase: null, alarm: false, alarmSince: 0,
    // bench state
    captureActive: false, truthKey: ""
  };

  try { S.paused = localStorage.getItem(PAUSE_KEY) === "1"; } catch (e) {}

  const t = () => Math.round(now() - S.t0);
  const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
  const mm = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000));
  const m4 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);

  function event(category, type, data) {
    if (S.paused) return;
    S.events.push({ t: t(), category: category, type: type, data: data || {} });
    if (S.events.length > MAX_BUFFER) S.events.splice(0, S.events.length - MAX_BUFFER);
  }

  /** Emit at most once per `ms` for a given key (so a fault can't flood the log). */
  function limited(key, ms, fn) {
    const n = now();
    if (S.cooldown[key] && n - S.cooldown[key] < ms) return;
    S.cooldown[key] = n;
    fn();
  }

  /* ── Session lifecycle ─────────────────────────────────────── */
  function setupKey() { return Tracker.src + "|" + Tracker.layout; }

  function meta() {
    const sensors = Tracker.sensors.map(s => ({ n: s.n, x: s.x, y: s.y, a: s.a, w: s.w, box: s.box, slot: s.slot }));
    return {
      page: page, url: location.pathname + location.search,
      user_agent: navigator.userAgent,
      screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      n_sensors: sensors.length, sensors: sensors,
      solver: typeof SOLVER !== "undefined" ? SOLVER : null,
      beam: typeof BEAM !== "undefined" ? BEAM : null,
      area: typeof AREA !== "undefined" ? AREA : null,
      alpha: Tracker.alpha,
      thresholds: { spike_mm: SPIKE_MM, dropout_min: DROPOUT_MIN, jump_m: JUMP_M,
                    low_rate_hz: LOW_RATE_HZ, low_fps: LOW_FPS, sustain_ms: SUSTAIN_MS },
      client_started: new Date().toISOString()
    };
  }

  function startSession() {
    S.key = setupKey();
    S.t0 = now();
    S.sid = null;
    S.samples = [];
    S.events = [];
    S.sent = { samples: 0, events: 0 };
    resetDetectors();
    event("system", "session_start", { src: Tracker.src, layout: Tracker.layout, page: page });
    createRemote();
  }

  /** Register the session with the bridge. Local buffers and the clock are untouched,
   *  so a retry after the bridge comes back keeps every buffered row aligned. */
  function createRemote() {
    S.starting = true;
    const key = S.key;
    const body = { page: page, src: Tracker.src, layout: Tracker.layout, meta: meta() };
    fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(j => { if (S.key === key) { S.sid = j.id; S.online = true; } })
      .catch(() => { S.online = false; S.retryAt = now() + 10000; })
      .finally(() => { S.starting = false; });
  }

  function endSession(beacon) {
    if (S.sid == null) return;
    const payload = JSON.stringify({ samples: S.samples, events: S.events });
    const url = API + "/" + S.sid + "/end";
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    } else {
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true })
        .catch(() => {});
    }
    S.samples = [];
    S.events = [];
    S.sid = null;
  }

  function flush() {
    S.lastFlush = now();
    if (S.sid == null) {
      // The bridge was down when the session began: try again, keeping the buffer.
      if (!S.starting && S.online === false && now() > S.retryAt) createRemote();
      return;
    }
    if (!S.samples.length && !S.events.length) return;
    const samples = S.samples, events = S.events;
    S.samples = [];
    S.events = [];
    fetch(API + "/" + S.sid + "/batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: samples, events: events })
    })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(j => { S.online = true; S.sent.samples += j.samples; S.sent.events += j.events; })
      .catch(() => {
        S.online = false;
        S.samples = samples.concat(S.samples).slice(-MAX_BUFFER);
        S.events = events.concat(S.events).slice(-MAX_BUFFER);
      });
  }

  /* ── Sampling ──────────────────────────────────────────────── */
  function truth() {
    if (page === "bench" && typeof truthNow === "function") {
      const tr = truthNow();
      return tr && tr.p ? tr.p : null;
    }
    return null;
  }

  function sample() {
    const fix = Tracker.fix;
    const raw = Tracker.rawRanges || [];
    const med = Tracker.ranges || [];
    const tr = truth();
    const hasG = typeof G !== "undefined";
    const alive = (Tracker.live.boxes || []).filter(b => b.alive).length;
    const row = {
      t: t(), src: Tracker.src, mode: Tracker.mode, phase: hasG ? G.phase : null,
      x_raw: Tracker.raw ? m4(Tracker.raw.x) : null, y_raw: Tracker.raw ? m4(Tracker.raw.y) : null,
      x: Tracker.pos ? m4(Tracker.pos.x) : null, y: Tracker.pos ? m4(Tracker.pos.y) : null,
      tx: tr ? m4(tr.x) : null, ty: tr ? m4(tr.y) : null,
      sigma: isFinite(Tracker.sigma) ? r1(Tracker.sigma * 1000) : null,
      gap: fix ? r1(fix.gap * 1000) : null,
      spread: fix ? r1(fix.spread * 1000) : null,
      miss: fix ? r1(fix.worstMiss) : null,
      resid: fix ? r1(fix.residual * 1000) : null,
      veto: Tracker.veto ? 1 : 0, split: fix && fix.split ? 1 : 0,
      conflict: fix && fix.conflict ? 1 : 0, stale: Tracker.stale ? 1 : 0,
      alarm: hasG && G.alarm ? 1 : 0,
      gate: Tracker.gateRejects || 0,
      meas_hz: r1(Tracker.measHz), fps: r1(S.fps),
      score: hasG ? G.score : null, level: hasG ? G.li + 1 : null,
      boxes_alive: Tracker.src === "live" ? alive : null
    };
    for (let i = 0; i < 4; i++) {
      row["r" + i] = mm(raw[i]);
      row["m" + i] = mm(med[i]);
    }
    S.samples.push(row);
    if (S.samples.length > MAX_BUFFER) S.samples.splice(0, S.samples.length - MAX_BUFFER);
  }

  /* ── Anomaly detection (runs on each genuinely new measurement) ── */
  function resetDetectors() {
    S.prevRaw = null;
    S.dropRun = [];
    S.cooldown = {};
    S.blindSince = S.staleSince = S.lowRateSince = S.lowFpsSince = null;
    S.prevVeto = S.prevSplit = S.prevConflict = false;
    S.prevRejects = S.maxRejects = 0;
    S.liveSeen = false;
    S.seqAtStart = Tracker.measSeq;   // measSeq is page-global; only count this session's data
    S.alarm = false;
    S.moles.clear();
  }

  function detect() {
    const n = now();
    const raw = Tracker.rawRanges || [];
    const med = Tracker.ranges || [];
    const fix = Tracker.fix;
    const sensors = Tracker.sensors;

    for (let i = 0; i < sensors.length; i++) {
      const r = raw[i], m = med[i];
      // Spike: a reading far from its own recent median (cross-talk / multipath suspect)
      if (r != null && m != null && Math.abs(r - m) > SPIKE_MM / 1000) {
        limited("spike" + i, 500, () => event("anomaly", "spike", {
          sensor: i, name: sensors[i].n, raw_mm: mm(r), median_mm: mm(m), delta_mm: mm(r - m) }));
      }
      // Dropout: a sensor that had been echoing goes silent for a run of measurements
      const run = S.dropRun[i] || (S.dropRun[i] = { seen: false, start: null, count: 0, partner: 0 });
      if (r != null) {
        if (run.count >= DROPOUT_MIN) {
          event("anomaly", "dropout", {
            sensor: i, name: sensors[i].n, samples: run.count,
            duration_ms: Math.round(n - run.start),
            partner_echo_share: Math.round((run.partner / run.count) * 100) / 100
          });
        }
        run.seen = true; run.start = null; run.count = 0; run.partner = 0;
      } else if (run.seen) {
        if (run.start == null) run.start = n;
        run.count++;
        const partnerEcho = sensors.some((s, j) => j !== i && s.x === sensors[i].x && s.y === sensors[i].y && raw[j] != null);
        if (partnerEcho) run.partner++;
      }
    }

    if (fix) {
      if (Tracker.veto && !S.prevVeto) {
        event("anomaly", "veto", { reason: Tracker.reason, gap_mm: mm(fix.gap), miss_deg: r1(fix.worstMiss), mode: fix.mode });
      }
      if (fix.split && !S.prevSplit) event("anomaly", "pair_disagree", { spread_mm: mm(fix.spread), reason: fix.reason });
      if (fix.conflict && !S.prevConflict) event("anomaly", "sector_conflict", { fired: fix.fired });
      S.prevVeto = !!Tracker.veto; S.prevSplit = !!fix.split; S.prevConflict = !!fix.conflict;

      if (fix.mode === "blind") {
        if (S.blindSince == null) S.blindSince = n;
      } else if (S.blindSince != null) {
        event("anomaly", "blind", { duration_ms: Math.round(n - S.blindSince) });
        S.blindSince = null;
      }
    }

    // Raw fix teleporting between consecutive measurements
    if (Tracker.raw && S.prevRaw) {
      const d = Math.hypot(Tracker.raw.x - S.prevRaw.x, Tracker.raw.y - S.prevRaw.y);
      if (d > JUMP_M) event("anomaly", "jump", { dist_mm: mm(d), mode: Tracker.mode });
    }
    S.prevRaw = Tracker.raw ? { x: Tracker.raw.x, y: Tracker.raw.y } : null;

    // Velocity gate: report each run of rejections once it ends
    const rej = Tracker.gateRejects || 0;
    if (rej > 0) S.maxRejects = Math.max(S.maxRejects, rej);
    if (rej === 0 && S.prevRejects > 0) {
      event("anomaly", "gate_reject", { rejected: S.maxRejects });
      S.maxRejects = 0;
    }
    S.prevRejects = rej;
  }

  /** Conditions that are about time rather than individual measurements. */
  function detectContinuous() {
    const n = now();
    if (Tracker.src === "live") {
      // Stale only means something once data has actually flowed in this session;
      // before the first frame the tracker is "stale" by definition.
      if (Tracker.measSeq > S.seqAtStart) S.liveSeen = true;
      if (Tracker.stale && S.liveSeen) {
        if (S.staleSince == null) S.staleSince = n;
      } else if (S.staleSince != null) {
        // The collector can run a frame before the tracker clears its stale flag,
        // so ignore sub-400 ms blips: stale means frames stopped for 400 ms+.
        const dur = Math.round(n - S.staleSince);
        if (dur >= 400) event("anomaly", "stale", { duration_ms: dur });
        S.staleSince = null;
      }
      if (Tracker.wsState !== S.prevWs) {
        if (S.prevWs != null) event("system", "ws_state", { state: Tracker.wsState });
        S.prevWs = Tracker.wsState;
      }
      for (const b of Tracker.live.boxes || []) {
        const was = S.boxAlive[b.box];
        if (was !== undefined && was !== b.alive) {
          event(b.alive ? "system" : "anomaly", b.alive ? "box_up" : "box_down",
                { box: b.box + 1, addr: b.addr, hz: b.hz });
        }
        S.boxAlive[b.box] = b.alive;
      }
      const hub = Tracker.live.hub;
      if (hub && typeof hub.bad === "number") {
        if (S.badPackets != null && hub.bad > S.badPackets) {
          event("anomaly", "bad_packets", { new: hub.bad - S.badPackets, total: hub.bad });
        }
        S.badPackets = hub.bad;
      }
    }
    if (Tracker.src !== "mouse") {
      const low = Tracker.measHz > 0 && Tracker.measHz < LOW_RATE_HZ && !Tracker.stale;
      if (low) {
        if (S.lowRateSince == null) S.lowRateSince = n;
        if (n - S.lowRateSince > SUSTAIN_MS) {
          limited("lowrate", 5000, () => event("anomaly", "low_rate", { hz: r1(Tracker.measHz) }));
        }
      } else S.lowRateSince = null;
    }
    if (S.fps > 0 && S.fps < LOW_FPS && document.visibilityState === "visible") {
      if (S.lowFpsSince == null) S.lowFpsSince = n;
      if (n - S.lowFpsSince > SUSTAIN_MS) {
        limited("lowfps", 10000, () => event("anomaly", "fps_drop", { fps: r1(S.fps) }));
      }
    } else S.lowFpsSince = null;
  }

  /* ── Game hooks (game page only) ───────────────────────────── */
  function wrap(name, before, after) {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () {
      const ctx = before ? before.apply(this, arguments) : undefined;
      const out = orig.apply(this, arguments);
      if (after) after(ctx, arguments);
      return out;
    };
  }

  function installGameHooks() {
    if (typeof G === "undefined") return;

    wrap("startLevel", () => { S.moles.clear(); }, (ctx, args) => {
      const L = LEVELS[G.li];
      event("game", "round_start", {
        level: G.li + 1, name: L.name, target: L.target, dur_s: L.dur, cols: L.cols, rows: L.rows,
        life_s: L.life, dwell_s: L.dwell, max: L.max, bombs: !!L.bombs, gold: !!L.gold,
        random_holes: !!L.randomHoles, holes: G.holes.length
      });
    });

    wrap("spawn", () => G.moles.length, before => {
      if (G.moles.length <= before) return;
      const m = G.moles[G.moles.length - 1];
      m._tid = ++S.moleId;
      m._spawnAt = now();
      S.moles.set(m._tid, m);
      event("game", "spawn", {
        id: m._tid, kind: m.kind, level: G.li + 1, hole: G.holes.indexOf(m.hole),
        x: m4(m.hole.x), y: m4(m.hole.y), life_ms: Math.round(m.life * 1000),
        live_moles: G.moles.filter(o => !o.dead && o.state !== "sink").length
      });
    });

    wrap("hit", m => ({ score: G.score, streak: G.streak, m: m }), ctx => {
      const m = ctx.m;
      if (!m) return;
      m._hit = true;
      const p = Tracker.pos;
      event("game", "hit", {
        id: m._tid || null, kind: m.kind, level: G.li + 1, hole: G.holes.indexOf(m.hole),
        reaction_ms: m._spawnAt ? Math.round(now() - m._spawnAt) : Math.round(m.age * 1000),
        points: G.score - ctx.score, score: G.score, streak_before: ctx.streak, streak: G.streak,
        dist_mm: p ? mm(Math.hypot(p.x - m.hole.x, p.y - m.hole.y)) : null,
        x: p ? m4(p.x) : null, y: p ? m4(p.y) : null,
        mode: Tracker.mode, sigma_mm: isFinite(Tracker.sigma) ? r1(Tracker.sigma * 1000) : null,
        src: Tracker.src
      });
      S.moles.delete(m._tid);
    });

    wrap("levelComplete", () => {
      event("game", "level_complete", {
        level: G.li + 1, hits: G.hitsThisLevel, time_left_s: r1(G.t), score: G.score,
        time_used_s: r1(LEVELS[G.li].dur - G.t)
      });
    });

    wrap("endRun", title => {
      event("game", "run_end", {
        title: String(title || ""), level: G.li + 1, score: G.score,
        hits: G.totalHits, shown: G.totalShown, missed: G.missed, best_streak: G.bestStreak,
        accuracy: G.totalShown ? Math.round((G.totalHits / G.totalShown) * 1000) / 1000 : null
      });
    });
  }

  function watchGame() {
    if (typeof G === "undefined") return;
    // Phase transitions
    if (G.phase !== S.phase) {
      const from = S.phase;
      S.phase = G.phase;
      if (from !== null) {
        const map = { play: from === "pause" ? "resume" : "play_start", pause: "pause" };
        if (map[G.phase]) event("game", map[G.phase], { level: G.li + 1, from: from });
      }
    }
    // Escapes: a tracked mole that vanished during play without being hit
    if (S.moles.size) {
      const present = new Set(G.moles);
      for (const [id, m] of S.moles) {
        if (present.has(m)) continue;
        S.moles.delete(id);
        if (!m._hit && G.phase === "play") {
          event("game", "escape", { id: id, kind: m.kind, level: G.li + 1, hole: G.holes.indexOf(m.hole),
                                    life_ms: Math.round(m.life * 1000) });
        }
      }
    }
    // Dead zone. G.alarm can be null (no position yet) as well as true/false,
    // so compare as booleans or a null<->false flip reads as leaving the zone.
    const alarm = !!G.alarm;
    if (alarm !== S.alarm) {
      S.alarm = alarm;
      if (alarm) {
        S.alarmSince = now();
        event("game", "deadzone_enter", { y: Tracker.pos ? m4(Tracker.pos.y) : null, level: G.li + 1 });
      } else {
        event("game", "deadzone_exit", { duration_ms: Math.round(now() - S.alarmSince), level: G.li + 1 });
      }
    }
  }

  /* ── Bench hooks (sensor test page only) ───────────────────── */
  function installBenchHooks() {
    if (page !== "bench") return;
    // Wrapped at script load: sensortest.js hands these functions to its buttons
    // during DOMContentLoaded, which would capture the unwrapped originals.
    wrap("applyFits", () => {
      return Tracker.sensors.map((s, i) => ({ fit: typeof fitCone === "function" ? fitCone(i) : null, a: s.a, w: s.w }));
    }, before => {
      event("calibration", "fit", {
        samples: typeof ST !== "undefined" ? ST.samples.length : null,
        sensors: Tracker.sensors.map((s, i) => ({
          sensor: i, name: s.n, before_a: before[i].a, before_w: before[i].w, after_a: s.a, after_w: s.w,
          fit: before[i].fit
        }))
      });
    });
    wrap("exportCSV", null, () => event("calibration", "export_csv", {
      samples: typeof ST !== "undefined" ? ST.samples.length : null }));
  }

  function installBenchListeners() {
    if (page !== "bench") return;
    const tune = document.getElementById("tuneList");
    if (tune) {
      tune.addEventListener("change", e => {
        const m = /^t([aw])(\d+)$/.exec(e.target.id || "");
        if (!m) return;
        const s = Tracker.sensors[+m[2]];
        event("calibration", "tune", { sensor: +m[2], name: s.n, a: s.a, w: s.w });
      });
    }
  }

  function watchBench() {
    if (page !== "bench" || typeof ST === "undefined") return;
    if (ST.capture.active !== S.captureActive) {
      S.captureActive = ST.capture.active;
      const tr = truth();
      event("calibration", ST.capture.active ? "capture_start" : "capture_done", {
        truth_x: tr ? m4(tr.x) : null, truth_y: tr ? m4(tr.y) : null, samples_total: ST.samples.length });
    }
    const key = ST.truth ? ST.truth.x.toFixed(3) + "," + ST.truth.y.toFixed(3) : "";
    if (key !== S.truthKey) {
      S.truthKey = key;
      event("calibration", ST.truth ? "truth_set" : "truth_cleared",
            ST.truth ? { x: m4(ST.truth.x), y: m4(ST.truth.y) } : {});
    }
  }

  /* ── Recorder badge ────────────────────────────────────────── */
  function badge() {
    const dot = document.getElementById("recDot");
    const txt = document.getElementById("recText");
    const btn = document.getElementById("recToggle");
    if (!dot || !txt) return;
    let state, label;
    if (S.paused) { state = "paused"; label = "PAUSED"; }
    else if (S.online === false) { state = "offline"; label = "OFFLINE"; }
    else if (S.sid == null) { state = "idle"; label = "…"; }
    else { state = "rec"; label = "REC " + compact(S.sent.samples + S.samples.length); }
    dot.className = "recdot " + state;
    txt.textContent = label;
    if (btn) {
      btn.title = S.paused ? "Recording paused — click to resume"
        : S.online === false ? "Bridge unreachable — buffering " + S.samples.length + " samples, retrying"
        : "Recording session #" + S.sid + " — click to pause";
      btn.setAttribute("aria-pressed", String(!S.paused));
    }
  }

  function compact(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k"
         : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  }

  /* ── Main loop ─────────────────────────────────────────────── */
  function frame() {
    const n = now();
    S.fpsFrames++;
    if (n - S.fpsT >= 1000) {
      S.fps = (S.fpsFrames * 1000) / (n - S.fpsT);
      S.fpsFrames = 0;
      S.fpsT = n;
    }

    if (setupKey() !== S.key) {
      endSession(false);   // no-op before the first session exists
      startSession();
    }

    if (!S.paused) {
      if (Tracker.src !== "mouse") {
        if (Tracker.measSeq !== S.lastSeq) {
          S.lastSeq = Tracker.measSeq;
          sample();
          detect();
        }
      } else {
        const active = Tracker.mouse.has ||
          (typeof G !== "undefined" && (G.phase === "play" || G.phase === "count"));
        if (n - S.lastSampleAt >= (active ? ACTIVE_SAMPLE_MS : IDLE_SAMPLE_MS)) {
          S.lastSampleAt = n;
          sample();
        }
      }
      detectContinuous();
      watchGame();
      watchBench();
    }

    if (n - S.lastFlush >= FLUSH_MS) flush();
    badge();
    requestAnimationFrame(frame);
  }

  function init() {
    installBenchListeners();
    const btn = document.getElementById("recToggle");
    if (btn) {
      btn.addEventListener("click", () => {
        S.paused = !S.paused;
        try { localStorage.setItem(PAUSE_KEY, S.paused ? "1" : "0"); } catch (e) {}
        if (!S.paused) event("system", "recording_resumed", {});
        else S.events.push({ t: t(), category: "system", type: "recording_paused", data: {} });
      });
    }
    document.addEventListener("visibilitychange", () => {
      event("system", document.visibilityState === "hidden" ? "tab_hidden" : "tab_visible", {});
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", () => {
      event("system", "page_hide", {});
      endSession(true);
    });
    window.addEventListener("pageshow", e => {
      if (e.persisted) startSession();   // restored from the back/forward cache
    });
    // No session yet: the first frame starts one. By then every page script has
    // applied its URL parameters (?src=live etc.), so the first session already
    // has the right source instead of a throwaway "mouse" session.
    requestAnimationFrame(frame);
  }

  // Wrap globals immediately: this script loads after game.js / sensortest.js
  // define them, and before anything captures a reference to the originals.
  installGameHooks();
  installBenchHooks();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return {
    get sessionId() { return S.sid; },
    get online() { return S.online; },
    get paused() { return S.paused; },
    get buffered() { return { samples: S.samples.length, events: S.events.length }; },
    get sent() { return Object.assign({}, S.sent); },
    event: event,
    flush: flush
  };
})();
