"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Application Controller & Loop
   Coordinates user input, UI HUD updates, URL bootstrapping,
   dead-zone supervision, and the main animation loop.
   ══════════════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
let lastTimestamp = performance.now();
let lastStageW = 0, lastStageH = 0;

function fitStageIfNeeded() {
  const stage = document.getElementById("stage");
  if (!stage || !stage.parentElement) return;
  const r = stage.parentElement.getBoundingClientRect();
  if (Math.abs(r.width - lastStageW) > 1 || Math.abs(r.height - lastStageH) > 1) {
    lastStageW = r.width;
    lastStageH = r.height;
    fitStage();
  }
}

function buildSensorRows() {
  const list = $("#sensorList");
  if (!list) return;
  list.innerHTML = Tracker.sensors.map((sen, i) => {
    const box = Math.floor(i / 2) + 1;
    const slot = (i % 2) + 1;
    return `
      <div class="sensrow" data-i="${i}">
        <span class="sdot"></span>
        <span class="slabel">S${i}<small>Box ${box} · S${slot}</small></span>
        <span class="sbar"><i></i></span>
        <span class="sval">—</span>
      </div>`;
  }).join("");
}

const SENSOR_BAR_MAX_M = 3.0;

function updateSensorReadings() {
  document.querySelectorAll("#sensorList .sensrow").forEach(row => {
    const r = Tracker.ranges[+row.dataset.i];
    const has = r != null;
    const dot = row.querySelector(".sdot");
    const bar = row.querySelector(".sbar i");
    const val = row.querySelector(".sval");
    if (dot) dot.classList.toggle("ok", has);
    if (bar) bar.style.width = has ? `${Math.min(100, (r / SENSOR_BAR_MAX_M) * 100.0).toFixed(0)}%` : "0%";
    if (val) val.textContent = has ? `${r.toFixed(2)} m` : "—";
  });
}

function updateHUD() {
  if (Tracker.src === "live") Setup.tick();
  updateSensorReadings();

  const uiScore = $("#uiScore");
  const uiLevel = $("#uiLevel");
  const uiStreak = $("#uiStreak");
  const uiMiss = $("#uiMiss");
  const uiTime = $("#uiTime");
  const timefill = $("#timefill");

  if (uiScore) uiScore.textContent = G.score;
  if (uiLevel) uiLevel.textContent = LEVELS[G.li].n;
  if (uiStreak) uiStreak.textContent = "×" + G.streak;
  if (uiMiss) uiMiss.textContent = G.missed;
  if (uiTime) uiTime.textContent = G.t.toFixed(1);

  if (timefill) {
    timefill.style.width = (100.0 * G.t) / LEVELS[G.li].dur + "%";
    timefill.style.background = G.t < 8.0 ? "var(--alarm)" : "var(--signal)";
  }

  const p = Tracker.pos;
  const roPos = $("#roPos");
  const roDepth = $("#roDepth");
  const roN = $("#roN");
  const roRes = $("#roRes");
  const roHz = $("#roHz");

  if (roPos) roPos.textContent = p ? `${p.x.toFixed(3)}, ${p.y.toFixed(3)} m` : "—";
  if (roDepth) roDepth.textContent = p ? `${p.y.toFixed(2)} m` : "—";
  if (roN) roN.textContent = `${Tracker.nSensors} / ${Tracker.sensors.length}`;
  if (roRes) roRes.textContent = Tracker.src === "mouse" ? "n/a" : `${(Tracker.res * 1000.0).toFixed(0)} mm`;
  if (roHz) roHz.textContent = Tracker.hz.toFixed(0) + " Hz";

  const dot = $("#stDot");
  const txt = $("#stText");
  if (dot && txt) {
    if (G.alarm) {
      dot.className = "dot bad";
      txt.textContent = "DEAD ZONE — alarm active";
    } else if (Tracker.stale) {
      dot.className = "dot bad";
      txt.textContent = "No fix — fewer than 2 sensors returning";
    } else if (Tracker.pos) {
      dot.className = "dot ok";
      txt.textContent = "Tracking";
    } else {
      dot.className = "dot";
      txt.textContent = "Waiting for a body in the play area";
    }
  }
}

function mainLoop(now) {
  const dt = Math.min(0.05, (now - lastTimestamp) / 1000.0);
  lastTimestamp = now;

  Tracker.update(dt);

  const dz = $("#dz");

  if (G.phase === "play") {
    const L = LEVELS[G.li];
    G.t -= dt;
    if (G.t <= 0) {
      G.t = 0;
      endRun("Time");
    }

    // Dead-zone supervision — independent of game state
    const inDead = Tracker.pos && Tracker.pos.y < AREA.yNear && !Tracker.stale;
    if (inDead !== G.alarm) {
      G.alarm = inDead;
      if (dz) dz.classList.toggle("on", inDead);
      if (inDead) Audio_.alarmOn();
      else Audio_.alarmOff();
    }

    // Update active moles
    for (const m of G.moles) {
      m.age += dt;
      if (m.state === "rise") {
        m.pop = Math.min(1.0, m.pop + dt * 7.0);
        if (m.pop >= 1.0) m.state = "up";
      } else if (m.state === "up") {
        if (m.age > m.life) m.state = "sink";
      } else if (m.state === "sink" || m.state === "hit") {
        m.pop -= dt * (m.state === "hit" ? 12.0 : 5.0);
        if (m.pop <= 0) {
          m.pop = 0;
          m.hole.occupied = null;
          m.gone = true;
          if (m.state === "sink" && m.kind !== "bomb") {
            G.missed++;
            G.streak = 1;
            Audio_.escaped();
          }
        }
      }
    }

    // Dwell-to-whack detection
    if (Tracker.pos && !G.alarm && !Tracker.stale) {
      let target = null, bestD = Infinity;
      const grab = 0.17; // Metres: body centre must be within 17 cm of hole
      for (const m of G.moles) {
        if (m.dead || m.state === "sink") continue;
        const d = Math.hypot(Tracker.pos.x - m.hole.x, Tracker.pos.y - m.hole.y);
        if (d < grab && d < bestD) {
          bestD = d;
          target = m;
        }
      }

      for (const m of G.moles) {
        if (m !== target) m.dwell = Math.max(0, m.dwell - dt * 2.5);
      }

      if (target) {
        target.dwell += dt;
        if (target.dwell >= L.dwell) hit(target);
      }
    } else {
      for (const m of G.moles) {
        m.dwell = Math.max(0, m.dwell - dt * 2.5);
      }
    }

    G.moles = G.moles.filter(m => !m.gone);
    const liveCount = G.moles.filter(m => m.state !== "sink" && !m.dead).length;
    if (liveCount < L.max && Math.random() < dt * 2.2) spawn();
    if (liveCount === 0 && G.moles.length === 0) spawn();

    // Particle / score effect bursts
    for (const f of G.fx) f.t += dt;
    G.fx = G.fx.filter(f => f.t < 0.6);
  } else if (G.alarm) {
    G.alarm = false;
    if (dz) dz.classList.remove("on");
    Audio_.alarmOff();
  }

  fitStageIfNeeded();
  drawStage(dt);
  drawRadar();
  updateHUD();
  requestAnimationFrame(mainLoop);
}

// ── DOM Event Setup ──────────────────────────────────────────────────────────
function initApp() {
  const stage = $("#stage");
  if (stage) {
    stage.addEventListener("pointermove", e => {
      const r = stage.getBoundingClientRect();
      const p = fromPx(e.clientX - r.left, e.clientY - r.top);
      Tracker.mouse.x = p.x;
      Tracker.mouse.y = p.y;
      Tracker.mouse.has = true;
    });

    stage.addEventListener("pointerleave", () => {
      Tracker.mouse.has = false;
    });
  }

  window.addEventListener("keydown", e => {
    if (e.key === "p" || e.key === "P") {
      const dz = $("#dz");
      if (G.phase === "play") {
        G.phase = "pause";
        Audio_.alarmOff();
        if (dz) dz.classList.remove("on");
        showOverlay("#ovPause");
      } else if (G.phase === "pause") {
        G.phase = "play";
        hideAllOverlays();
      }
    }
    if (e.key === "m" || e.key === "M") {
      Audio_.muted = !Audio_.muted;
      if (Audio_.muted) Audio_.alarmOff();
    }
  });

  const btnStart = $("#btnStart");
  const btnNext = $("#btnNext");
  const btnAgain = $("#btnAgain");
  const btnResume = $("#btnResume");

  if (btnStart) btnStart.onclick = () => { Audio_.init(); hideAllOverlays(); resetRun(); };
  if (btnNext) btnNext.onclick = () => { hideAllOverlays(); startLevel(G.li + 1); };
  if (btnAgain) btnAgain.onclick = () => { hideAllOverlays(); resetRun(); };
  if (btnResume) btnResume.onclick = () => { hideAllOverlays(); G.phase = "play"; };

  // Source segmented buttons (Mouse / Sim / Live)
  document.querySelectorAll("[data-src]").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("[data-src]").forEach(o => o.setAttribute("aria-pressed", o === b));
      Tracker.src = b.dataset.src;
      Tracker.pos = null;
      const hint = $("#srcHint");
      const wsField = $("#wsField");
      if (hint) hint.textContent = SRC_HINT[Tracker.src];
      if (wsField) wsField.hidden = Tracker.src !== "live";
      if (Tracker.src === "live") Setup.open();
    };
  });

  // Layout segmented buttons (4lin / 2box / 4wide)
  document.querySelectorAll("[data-lay]").forEach(b => {
    b.onclick = () => {
      document.querySelectorAll("[data-lay]").forEach(o => o.setAttribute("aria-pressed", o === b));
      Tracker.layout = b.dataset.lay;
      Tracker.live.ranges = [];
      const hint = $("#layHint");
      if (hint) hint.textContent = LAYOUTS[Tracker.layout].hint;
      buildSensorRows();
    };
  });

  // ── Setup Wizard (connect / reconnect ESP32 boxes) ──────────────────────────
  const setupConnect = $("#setupConnect");
  if (setupConnect) setupConnect.onclick = () => Setup.connect();

  const btnReopenSetup = $("#btnReopenSetup");
  if (btnReopenSetup) btnReopenSetup.onclick = () => Setup.open();

  const btnSetupDone = $("#btnSetupDone");
  if (btnSetupDone) {
    btnSetupDone.onclick = () => { Audio_.init(); hideAllOverlays(); resetRun(); };
  }

  const btnSetupSkip = $("#btnSetupSkip");
  if (btnSetupSkip) {
    btnSetupSkip.onclick = () => {
      const mouseBtn = document.querySelector('[data-src="mouse"]');
      if (mouseBtn) mouseBtn.click();
      hideAllOverlays();
    };
  }

  // Simulation Sliders
  const bindSlider = (id, out, fn, fmt) => {
    const el = $(id);
    const outEl = $(out);
    if (!el || !outEl) return;
    const apply = () => {
      fn(+el.value);
      outEl.textContent = fmt(+el.value);
    };
    el.oninput = apply;
    apply();
  };

  bindSlider("#sNoise", "#vNoise", v => (Sim.noise = v / 1000.0), v => v + " mm");
  bindSlider("#sDrop", "#vDrop", v => (Sim.drop = v / 100.0), v => v + " %");
  bindSlider("#sBeam", "#vBeam", v => (Sim.beam = v), v => v + "°");
  bindSlider("#sAlpha", "#vAlpha", v => (Tracker.alpha = v / 100.0), v => (v / 100.0).toFixed(2));

  // ── URL Bootstrapper ───────────────────────────────────────────────────────
  (function bootFromUrl() {
    const q = new URLSearchParams(location.search);
    const lay = q.get("layout");
    if (lay && LAYOUTS[lay]) {
      const b = document.querySelector(`[data-lay="${lay}"]`);
      if (b) b.click();
    }

    const wsPort = q.get("ws");
    const wsUrlInput = $("#wsUrl");
    if (wsPort && wsUrlInput) {
      const url = /^wss?:/.test(wsPort) ? wsPort : `ws://${location.hostname}:${wsPort}`;
      wsUrlInput.value = url;
    }

    const src = q.get("src");
    if (src === "live" || src === "sim") {
      const b = document.querySelector(`[data-src="${src}"]`);
      if (b) b.click(); // "live" click already opens the setup wizard and connects
    }
  })();

  const srcHint = $("#srcHint");
  const layHint = $("#layHint");
  if (srcHint) srcHint.textContent = SRC_HINT[Tracker.src];
  if (layHint) layHint.textContent = LAYOUTS[Tracker.layout].hint;

  buildSensorRows();
  buildHoles();
  fitStage();
  window.addEventListener("resize", fitStage);
  requestAnimationFrame(mainLoop);
}

window.addEventListener("DOMContentLoaded", initApp);
