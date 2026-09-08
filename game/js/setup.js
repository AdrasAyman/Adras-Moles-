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
    return `<tr>
      <td><span class="dot ${b.alive ? "ok" : "bad"}"></span></td>
      <td>Box ${b.box + 1}</td>
      <td>${b.addr || "—"}</td>
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
      : `<tr><td colspan="5" class="hint">No boxes reporting yet… check power and Wi-Fi.</td></tr>`;
  },

  tick() {
    const state = Tracker.wsState;
    const wsState = document.getElementById("wsState");
    const setupWsState = document.getElementById("setupWsState");
    if (wsState) wsState.textContent = state;
    if (setupWsState) setupWsState.textContent = state;

    this.renderBoxes();

    const doneBtn = document.getElementById("btnSetupDone");
    if (doneBtn) doneBtn.disabled = !(Tracker.live.boxes || []).some(b => b.alive);
  }
};
