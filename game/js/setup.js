"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — ESP32 Setup Wizard
   Guides connecting to the Python bridge's WebSocket and shows
   live per-box health (alive / packet rate / address) reported
   by SensorHub so LIVE mode can be verified before playing.
   ══════════════════════════════════════════════════════════════ */

const Setup = {
  open() {
    showOverlay("#ovSetup");
    this.connect();
  },

  connect() {
    const input = document.getElementById("wsUrl");
    if (input && input.value.trim()) Tracker.connect(input.value.trim());
  },

  boxRowHtml(b) {
    const rate = b.alive ? `${b.hz.toFixed(1)} Hz` : "—";
    const age = b.age_ms < 1000 ? `${b.age_ms} ms ago` : `${(b.age_ms / 1000).toFixed(1)} s ago`;
    const sends = b.values === 1 ? "1 value (50°)" : b.values === 2 ? "2 values (25° each)" : "—";
    return `<tr>
      <td><span class="dot ${b.alive ? "ok" : "bad"}"></span></td>
      <td>Box ${b.box + 1}</td>
      <td>${b.addr || "—"}</td>
      <td>${sends}</td>
      <td>${rate}</td>
      <td>${age}</td>
    </tr>`;
  },

  renderBoxes() {
    const body = document.getElementById("boxTableBody");
    if (!body) return;
    const boxes = Tracker.live.boxes || [];
    body.innerHTML = boxes.length
      ? boxes.map(b => this.boxRowHtml(b)).join("")
      : `<tr><td colspan="6" class="hint">No boxes reporting yet… check power and Wi-Fi.</td></tr>`;
  },

  tick() {
    const state = Tracker.wsState;
    const wsState = document.getElementById("wsState");
    const setupWsState = document.getElementById("setupWsState");
    if (wsState) wsState.textContent = state;
    if (setupWsState) setupWsState.textContent = state;

    this.renderBoxes();

    const mode = document.getElementById("setupMode");
    if (mode) {
      const boxes = Tracker.live.boxes || [];
      mode.textContent = !boxes.length ? "waiting for packets"
        : Tracker.mixed ? "boxes disagree — one sends 1 value, the other 2"
        : Tracker.sensors.length === 2 ? "2 sensors · one 50° reading per box"
        : "4 sensors · two 25° readings per box";
      mode.style.color = Tracker.mixed ? "var(--alarm)" : "";
    }

    const doneBtn = document.getElementById("btnSetupDone");
    if (doneBtn) doneBtn.disabled = !(Tracker.live.boxes || []).some(b => b.alive);
  }
};
