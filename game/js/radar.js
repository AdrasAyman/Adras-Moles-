"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Top-Down Radar Visualizer
   Renders the physical playing field, screen plane, dead zone,
   sensor positions, acoustic beam arcs, and solved player position.
   ══════════════════════════════════════════════════════════════ */

function drawRadar() {
  const radar = document.getElementById("radar");
  if (!radar) return;
  const rctx = radar.getContext("2d");
  const W = radar.width;
  const H = radar.height;

  rctx.clearRect(0, 0, W, H);

  const pad = 26;
  const sx = (W - pad * 2.0) / AREA.w;
  const sy = (H - pad * 2.0) / AREA.yFar;
  const s = Math.min(sx, sy);
  const ox = (W - AREA.w * s) / 2.0;
  const oy = pad;
  const P = (x, y) => [ox + x * s, oy + y * s];

  // ── Wall / Screen Plane ──
  rctx.fillStyle = "#2A353F";
  rctx.fillRect(ox - 10, oy - 8, AREA.w * s + 20, 8);
  rctx.fillStyle = "#7C8A99";
  rctx.font = "500 9px 'JetBrains Mono',monospace";
  rctx.textAlign = "center";
  rctx.fillText("SCREEN / WALL", ox + (AREA.w * s) / 2.0, oy - 12);

  // ── Dead Zone Strip (0 to 0.60m) ──
  const [, dy] = P(0, AREA.dead);
  rctx.fillStyle = "rgba(255,77,61,.13)";
  rctx.fillRect(ox, oy, AREA.w * s, AREA.dead * s);
  rctx.strokeStyle = "rgba(255,77,61,.5)";
  rctx.setLineDash([5, 4]);
  rctx.lineWidth = 1;
  rctx.beginPath();
  rctx.moveTo(ox, dy);
  rctx.lineTo(ox + AREA.w * s, dy);
  rctx.stroke();
  rctx.setLineDash([]);

  // ── Active Play Area (0.60m to 2.00m) ──
  rctx.fillStyle = "rgba(102,194,71,.10)";
  rctx.fillRect(ox, oy + AREA.yNear * s, AREA.w * s, AREA.deep * s);
  rctx.strokeStyle = "rgba(155,232,107,.55)";
  rctx.strokeRect(ox, oy + AREA.yNear * s, AREA.w * s, AREA.deep * s);

  // ── 50 cm Hardware Mounting Limit ──
  rctx.strokeStyle = "rgba(255,176,32,.45)";
  rctx.setLineDash([3, 3]);
  const [, my] = P(0, 0.50);
  rctx.beginPath();
  rctx.moveTo(ox, my);
  rctx.lineTo(ox + AREA.w * s, my);
  rctx.stroke();
  rctx.setLineDash([]);
  rctx.fillStyle = "rgba(255,176,32,.7)";
  rctx.textAlign = "left";
  rctx.font = "500 8px 'JetBrains Mono',monospace";
  rctx.fillText("50 cm mount limit", ox + 3, my - 3);

  // ── Sensor Range Arcs & Cones ──
  Tracker.sensors.forEach((sen, i) => {
    const r = Tracker.ranges[i];
    const [px, py] = P(sen.x, sen.y);

    if (r != null) {
      const d = (r + AREA.bodyR) * s;
      const face = ((sen.a || 0) * Math.PI) / 180.0;
      const half = (Sim.beam * Math.PI) / 180.0;

      rctx.strokeStyle = "rgba(69,208,232,.5)";
      rctx.lineWidth = 1.5;
      rctx.beginPath();
      rctx.arc(
        px,
        py,
        d,
        Math.PI / 2.0 - face - half,
        Math.PI / 2.0 - face + half
      );
      rctx.stroke();

      rctx.strokeStyle = "rgba(69,208,232,.12)";
      rctx.beginPath();
      rctx.moveTo(px, py);
      rctx.lineTo(px + Math.sin(face - half) * d, py + Math.cos(face - half) * d);
      rctx.moveTo(px, py);
      rctx.lineTo(px + Math.sin(face + half) * d, py + Math.cos(face + half) * d);
      rctx.stroke();
    }

    rctx.fillStyle = r != null ? "#45D0E8" : "#3A4550";
    rctx.fillRect(px - 6, py - 5, 12, 10);
    rctx.fillStyle = "#0C1014";
    rctx.font = "700 8px 'JetBrains Mono',monospace";
    rctx.textAlign = "center";
    rctx.fillText(i, px, py + 3);
  });

  // ── Solved Body Position ──
  if (Tracker.pos) {
    const [px, py] = P(Tracker.pos.x, Tracker.pos.y);
    rctx.fillStyle = "rgba(155,232,107,.18)";
    rctx.beginPath();
    rctx.arc(px, py, AREA.bodyR * s, 0, 7);
    rctx.fill();

    rctx.strokeStyle = "#9BE86B";
    rctx.lineWidth = 2;
    rctx.beginPath();
    rctx.arc(px, py, AREA.bodyR * s, 0, 7);
    rctx.stroke();

    rctx.fillStyle = "#9BE86B";
    rctx.beginPath();
    rctx.arc(px, py, 3.5, 0, 7);
    rctx.fill();
  }

  // ── Raw Unfiltered Fix Marker ──
  if (Tracker.raw && Tracker.src !== "mouse") {
    const [px, py] = P(Tracker.raw.x, Tracker.raw.y);
    rctx.fillStyle = "rgba(255,255,255,.55)";
    rctx.beginPath();
    rctx.arc(px, py, 2.5, 0, 7);
    rctx.fill();
  }
}
