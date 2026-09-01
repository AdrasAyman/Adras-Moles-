"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Application Controller & Loop
     BOX 1 (left)  → S0, S1
     BOX 2 (right) → S2, S3
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
  list.innerHTML = BOXES.map(b => {
    const rows = b.idx.map(i => {
      const sen = Tracker.sensors[i];
      return `
      <div class="sensrow" data-i="${i}">
        <span class="sdot"></span>
        <span class="slabel">S${i}<small>Box ${b.id} · S${sen.slot}</small></span>
        <span class="sbar"><i></i></span>
        <span class="sval">—</span>
      </div>`;
    }).join("");
    return `<div class="sgroup">${b.label} · ${b.side}</div>${rows}`;
  }).join("");
}

function buildLayoutPanel() {
  const wrap = $("#boxLayout");
  if (!wrap) return;
  wrap.innerHTML = BOXES.map(b => {
    const rows = b.idx.map(i => {
      const sen = Tracker.sensors[i];
      return `
        <div class="boxrow" data-i="${i}">
          <span class="bslot">S${sen.slot}</span>
          <span class="bval">—</span>
        </div>`;
    }).join("");
    return `
      <div class="boxcard" data-box="${b.id}">
        <div class="boxhead">
          <span class="bdot"></span>
          <span class="bname">${b.label}</span>
          <span class="bside">${b.side}</span>
        </div>
        ${rows}
      </div>`;
  }).join("");
}

const SENSOR_BAR_MAX_M = 3.0;

// Only redraw a number once it has genuinely moved by 1.5 cm.
const DISPLAY_DEADBAND_M = 0.015;
const shownRange = [];

function displayRange(i, r) {
  if (r == null) { shownRange[i] = null; return "—"; }
  if (shownRange[i] == null || Math.abs(r - shownRange[i]) >= DISPLAY_DEADBAND_M) {
    shownRange[i] = r;
  }
  return `${shownRange[i].toFixed(2)} m`;
}

function updateSensorReadings() {
  document.querySelectorAll("#sensorList .sensrow").forEach(row => {
    const i = +row.dataset.i;
    const r = Tracker.ranges[i];
    const has = r != null;
    const dot = row.querySelector(".sdot");
    const bar = row.querySelector(".sbar i");
    const val = row.querySelector(".sval");
    if (dot) dot.classList.toggle("ok", has);
    if (bar) bar.style.width = has ? `${Math.min(100, (r / SENSOR_BAR_MAX_M) * 100.0).toFixed(0)}%` : "0%";
    if (val) val.textContent = displayRange(i, r);
  });

  document.querySelectorAll("#boxLayout .boxrow").forEach(row => {
    const i = +row.dataset.i;
    const r = Tracker.ranges[i];
    const val = row.querySelector(".bval");
    if (val) {
      val.textContent = displayRange(i, r);
      val.classList.toggle("off", r == null);
    }
  });

  document.querySelectorAll("#boxLayout .boxcard").forEach(card => {
    const box = BOXES.find(b => b.id === +card.dataset.box);
    const alive = box ? box.idx.some(i => Tracker.ranges[i] != null) : false;
    const dot = card.querySelector(".bdot");
    if (dot) dot.classList.toggle("ok", alive);
    card.classList.toggle("live", alive);
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

  if (roPos) roPos.textContent = p ? `${p.x.toFixed(2)}, ${p.y.toFixed(2)} m` : "—";
  if (roDepth) roDepth.textContent = p ? `${p.y.toFixed(2)} m` : "—";
  if (roN) roN.textContent = `${Tracker.nSensors} / ${Tracker.sensors.length}`;

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

  // ── Live Individual 4-Sensor Readouts (Prototype Window) ──
  const maxRangeM = 2.50;
  for (let i = 0; i < 4; i++) {
    const r = Tracker.ranges[i];
    const sv = $(`#sv${i}`);
    const ss = $(`#ss${i}`);
    const sb = $(`#sb${i}`);
    const sc = $(`#sc${i}`);
    const ssc = $(`#ssc${i}`);
    const ssv = $(`#ssv${i}`);

    if (r != null && !isNaN(r)) {
      const cm = (r * 100.0).toFixed(1);
      const mm = (r * 1000.0).toFixed(0);
      const pct = Math.min(100, Math.max(4, (r / maxRangeM) * 100.0));

      if (sv) sv.textContent = `${cm} cm`;
      if (ss) ss.textContent = `${mm} mm`;
      if (sb) sb.style.width = `${pct}%`;
      if (sc) {
        sc.classList.add("active");
        if (i >= 2) sc.classList.add("box1");
      }
      if (ssv) ssv.textContent = `${cm} cm`;
      if (ssc) ssc.classList.add("active");
    } else {
      if (sv) sv.textContent = "—";
      if (ss) ss.textContent = "No echo";
      if (sb) sb.style.width = "0%";
      if (sc) sc.classList.remove("active");
      if (ssv) ssv.textContent = "—";
      if (ssc) ssc.classList.remove("active");
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

    const inDead = Tracker.pos && Tracker.pos.y < AREA.yNear && !Tracker.stale;
    if (inDead !== G.alarm) {
      G.alarm = inDead;
      if (dz) dz.classList.toggle("on", inDead);
      if (inDead) Audio_.alarmOn();
      else Audio_.alarmOff();
    }

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

    if (Tracker.pos && !G.alarm && !Tracker.stale) {
      let target = null, bestD = Infinity;
      const grab = 0.17;
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

  

  (function bootFromUrl() {
    const q = new URLSearchParams(location.search);

    const wsPort = q.get("ws");
    const wsUrlInput = $("#wsUrl");
    if (wsPort && wsUrlInput) {
      const url = /^wss?:/.test(wsPort) ? wsPort : `ws://${location.hostname}:${wsPort}`;
      wsUrlInput.value = url;
    }

    if (q.get("src") === "live") {
      const b = document.querySelector('[data-src="live"]');
      if (b) b.click();
    }
  })();

  const srcHint = $("#srcHint");
  const layHint = $("#layHint");
  if (srcHint) srcHint.textContent = SRC_HINT[Tracker.src];
  if (layHint) layHint.textContent = LAYOUTS[Tracker.layout].hint;

  buildSensorRows();
  buildLayoutPanel();
  buildHoles();
  fitStage();
  window.addEventListener("resize", fitStage);
  requestAnimationFrame(mainLoop);
}

window.addEventListener("DOMContentLoaded", initApp);