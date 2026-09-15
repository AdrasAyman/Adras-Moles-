"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Chart primitives for logs.html (canvas, no dependencies)

   Every chart:
     - reads its colours from CSS custom properties (logs.css),
     - redraws on resize,
     - has a hover layer (crosshair + tooltip for time series, per-mark
       tooltip for bars / cells / ticks),
     - exposes table() so the card can show a table view, and
     - can be exported as a self-contained PNG.

   Mark specs follow the data-viz method: 2px lines, bars <= 24px with a
   4px rounded data end, 2px surface gaps, >= 8px markers with a surface
   ring, hairline solid grid, text in text tokens (never series colour).
   ══════════════════════════════════════════════════════════════ */

const Viz = (() => {
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const T = () => ({
    surface: css("--viz-surface"), grid: css("--viz-grid"), axis: css("--viz-axis"),
    text: css("--viz-text"), text2: css("--viz-text-2"), muted: css("--viz-muted"),
    series: [css("--series-1"), css("--series-2"), css("--series-3"), css("--series-4")],
    good: css("--status-good"), warning: css("--status-warning"), critical: css("--status-critical"),
    other: css("--viz-other"),
    ramp: css("--seq-ramp").split(",").map(s => s.trim())
  });
  const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

  /* ── formatting ─────────────────────────────────────────── */
  function clock(ms) {
    if (ms == null || !isFinite(ms)) return "—";
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  }
  function num(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    const d = digits == null ? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2) : digits;
    return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function pct(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v === 0) return "0%";
    const p = v * 100;
    if (Math.abs(p - 100) < 0.05) return "100%";
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  }

  function niceTicks(lo, hi, count, integer) {
    if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
    if (hi === lo) { hi = lo + 1; }
    const span = hi - lo;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || raw;
    if (integer) step = Math.max(1, Math.ceil(step));
    const start = Math.floor(lo / step) * step;
    const out = [+start.toFixed(10)];
    while (out[out.length - 1] < hi - step * 1e-9) out.push(+(out[out.length - 1] + step).toFixed(10));
    if (out.length < 2) out.push(+(start + step).toFixed(10));
    return out;
  }

  /* ── canvas plumbing ────────────────────────────────────── */
  function surface(el, height) {
    let cv = el.querySelector("canvas");
    if (!cv) {
      cv = document.createElement("canvas");
      cv.setAttribute("role", "img");
      el.appendChild(cv);
    }
    const w = Math.max(200, el.clientWidth);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = w + "px";
    cv.style.height = height + "px";
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(height * dpr);
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, height);
    c.lineJoin = "round";
    c.lineCap = "round";
    return { cv: cv, c: c, w: w, h: height };
  }

  function roundBar(c, x, y, w, h, r, horizontal) {
    // Rounded data end, square at the baseline.
    r = Math.min(r, horizontal ? h / 2 : w / 2, horizontal ? Math.abs(w) : Math.abs(h));
    c.beginPath();
    if (horizontal) {
      c.moveTo(x, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
      c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x, y + h);
    } else {
      c.moveTo(x, y + h); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
      c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h);
    }
    c.closePath();
    c.fill();
  }

  function text(c, str, x, y, color, opts) {
    opts = opts || {};
    c.font = `${opts.weight || 400} ${opts.size || 11}px ${FONT}`;
    c.fillStyle = color;
    c.textAlign = opts.align || "left";
    c.textBaseline = opts.baseline || "alphabetic";
    c.fillText(str, x, y);
  }

  function withAlpha(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map(x => x + x).join("") : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ── tooltip (one shared element, textContent only) ─────── */
  let tip = null;
  function tooltip() {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "viz-tip";
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(evt, title, rows) {
    const el = tooltip();
    el.replaceChildren();
    if (title) {
      const h = document.createElement("div");
      h.className = "viz-tip-title";
      h.textContent = title;
      el.appendChild(h);
    }
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "viz-tip-row";
      if (r.color) {
        const k = document.createElement("span");
        k.className = "viz-tip-key" + (r.shape === "box" ? " box" : "");
        k.style.background = r.color;
        row.appendChild(k);
      }
      const v = document.createElement("b");
      v.textContent = r.value;
      row.appendChild(v);
      const n = document.createElement("span");
      n.textContent = r.name;
      row.appendChild(n);
      el.appendChild(row);
    }
    el.hidden = false;
    const pad = 14, bw = el.offsetWidth, bh = el.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + bw > window.innerWidth - 8) x = evt.clientX - bw - pad;
    if (y + bh > window.innerHeight - 8) y = evt.clientY - bh - pad;
    el.style.left = x + "px";
    el.style.top = y + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }

  /* ── base: a chart object that re-renders on resize and hover ── */
  function mount(el, height, draw, hit) {
    const state = { hover: null, hidden: new Set() };
    const render = () => draw(surface(el, height), state);
    const ro = new ResizeObserver(() => render());
    ro.observe(el);
    const cv = () => el.querySelector("canvas");
    render();
    const onMove = e => {
      const r = cv().getBoundingClientRect();
      const res = hit(e.clientX - r.left, e.clientY - r.top, state);
      const key = res ? res.key : null;
      if (key !== state.hover) { state.hover = key; render(); }
      if (res && res.tip) showTip(e, res.tip.title, res.tip.rows);
      else hideTip();
      if (res && res.legendClick) cv().style.cursor = "pointer";
      else cv().style.cursor = res ? "crosshair" : "default";
    };
    const onLeave = () => { state.hover = null; hideTip(); render(); };
    const onClick = e => {
      const r = cv().getBoundingClientRect();
      const res = hit(e.clientX - r.left, e.clientY - r.top, state);
      if (res && res.legendClick) { res.legendClick(); render(); }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("click", onClick);
    return {
      render: render,
      state: state,
      canvas: cv,
      clean() { const h = state.hover; state.hover = null; render(); return () => { state.hover = h; render(); }; },
      destroy() { ro.disconnect(); hideTip(); }
    };
  }

  /* ── legend drawn inside the canvas (so PNG exports keep it) ── */
  function legend(c, items, x, y, state, maxW) {
    const boxes = [];
    let cx = x;
    c.font = `400 11px ${FONT}`;
    for (const it of items) {
      const tw = c.measureText(it.name).width;
      const w = 18 + tw + 16;
      if (cx + w > x + maxW && cx > x) { cx = x; y += 18; }
      const off = state.hidden.has(it.name);
      c.globalAlpha = off ? 0.35 : 1;
      if (it.shape === "box") { c.fillStyle = it.color; c.fillRect(cx, y - 8, 12, 10); }
      else { c.strokeStyle = it.color; c.lineWidth = 2; c.beginPath(); c.moveTo(cx, y - 3); c.lineTo(cx + 12, y - 3); c.stroke(); }
      text(c, it.name, cx + 18, y, T().text2);
      c.globalAlpha = 1;
      boxes.push({ name: it.name, x0: cx - 4, x1: cx + w - 8, y0: y - 12, y1: y + 5 });
      cx += w;
    }
    return { boxes: boxes, bottom: y + 8 };
  }

  /* ════════════════════ LINE / BAND over time ════════════════════ */
  /**
   * opts: { x: number[] (ms), series: [{name,color,values,band?:{min,max}}],
   *         height, yFormat, yUnit, zero, xFormat, markers?: [{x, label}] ,
   *         categoricalX?: string[] (ordinal x, e.g. trends), points?: bool }
   */
  function line(el, opts) {
    const H = opts.height || 240;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const vis = opts.series.filter(s => !state.hidden.has(s.name));
      const multi = opts.series.length > 1;
      let top = 14;
      let leg = { boxes: [], bottom: top };
      if (multi) leg = legend(c, opts.series.map(s => ({ name: s.name, color: s.color })), 52, 16, state, w - 60);
      top = (multi ? leg.bottom + 8 : 12) + (opts.yUnit ? 12 : 0);
      const left = 52, right = opts.endLabels === false ? 16 : 70, bottom = 28;
      const pw = w - left - right, ph = h - top - bottom;
      const xs = opts.x;
      const n = xs.length;
      const x0 = n ? xs[0] : 0, x1 = n ? xs[n - 1] : 1;
      const X = v => left + (x1 === x0 ? pw / 2 : ((v - x0) / (x1 - x0)) * pw);

      let lo = Infinity, hi = -Infinity;
      for (const s of vis) {
        const arrs = [s.values].concat(s.band ? [s.band.min, s.band.max] : []);
        for (const a of arrs) for (const v of a) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (opts.zero !== false) lo = Math.min(0, lo);
      if (opts.yMax != null) hi = Math.max(hi, opts.yMax);
      const ticks = niceTicks(lo, hi, Math.max(2, Math.floor(ph / 42)));
      const y0 = ticks[0], y1 = ticks[ticks.length - 1];
      const Y = v => top + ph - ((v - y0) / (y1 - y0 || 1)) * ph;

      // grid + y ticks
      c.lineWidth = 1;
      for (const tk of ticks) {
        const yy = Math.round(Y(tk)) + 0.5;
        c.strokeStyle = tk === y0 ? t.axis : t.grid;
        c.beginPath(); c.moveTo(left, yy); c.lineTo(left + pw, yy); c.stroke();
        text(c, (opts.yFormat || num)(tk), left - 8, yy + 4, t.muted, { align: "right" });
      }
      // x ticks
      if (opts.categoricalX) {
        const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 90))));
        for (let i = 0; i < n; i += every) text(c, opts.categoricalX[i], X(xs[i]), top + ph + 18, t.muted, { align: "center" });
      } else {
        const xt = niceTicks(0, x1 - x0, Math.max(2, Math.floor(pw / 90)));
        for (const tk of xt) {
          if (tk > x1 - x0) continue;
          text(c, (opts.xFormat || clock)(tk), X(x0 + tk), top + ph + 18, t.muted, { align: "center" });
        }
      }
      if (opts.yUnit) text(c, opts.yUnit, left - 8, top - 12, t.muted, { align: "right", size: 10 });

      // event markers (thin hairlines, recessive)
      if (opts.markers) {
        c.strokeStyle = t.axis;
        for (const m of opts.markers) {
          const xx = Math.round(X(m.x)) + 0.5;
          c.beginPath(); c.moveTo(xx, top); c.lineTo(xx, top + ph); c.stroke();
        }
      }

      // bands (10% wash), then lines
      for (const s of vis) {
        if (!s.band) continue;
        c.fillStyle = withAlpha(s.color, 0.12);
        let open = false;
        const flushBand = (from, to) => {
          if (to <= from) return;
          c.beginPath();
          for (let i = from; i <= to; i++) c.lineTo(X(xs[i]), Y(s.band.max[i]));
          for (let i = to; i >= from; i--) c.lineTo(X(xs[i]), Y(s.band.min[i]));
          c.closePath(); c.fill();
        };
        let start = -1;
        for (let i = 0; i <= n; i++) {
          const ok = i < n && s.band.min[i] != null && s.band.max[i] != null;
          if (ok && start < 0) start = i;
          if (!ok && start >= 0) { flushBand(start, i - 1); start = -1; }
        }
      }
      for (const s of vis) {
        c.strokeStyle = s.color;
        c.lineWidth = 2;
        c.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          const v = s.values[i];
          if (v == null || !isFinite(v)) { pen = false; continue; }
          if (pen) c.lineTo(X(xs[i]), Y(v)); else { c.moveTo(X(xs[i]), Y(v)); pen = true; }
        }
        c.stroke();
        if (opts.points) {
          for (let i = 0; i < n; i++) {
            const v = s.values[i];
            if (v == null || !isFinite(v)) continue;
            c.fillStyle = t.surface; c.beginPath(); c.arc(X(xs[i]), Y(v), 6, 0, 7); c.fill();
            c.fillStyle = s.color; c.beginPath(); c.arc(X(xs[i]), Y(v), 4, 0, 7); c.fill();
          }
        }
      }

      // direct end labels (<= 4 series), skipped when they would collide
      if (opts.endLabels !== false && vis.length && vis.length <= 4) {
        const ends = [];
        for (const s of vis) {
          let i = n - 1;
          while (i >= 0 && (s.values[i] == null || !isFinite(s.values[i]))) i--;
          if (i >= 0) ends.push({ s: s, y: Y(s.values[i]), v: s.values[i] });
        }
        ends.sort((a, b) => a.y - b.y);
        const collide = ends.some((e, k) => k && e.y - ends[k - 1].y < 13);
        if (!collide) {
          for (const e of ends) {
            c.strokeStyle = e.s.color; c.lineWidth = 2;
            c.beginPath(); c.moveTo(left + pw + 6, e.y); c.lineTo(left + pw + 14, e.y); c.stroke();
            text(c, multi ? e.s.name : (opts.yFormat || num)(e.v), left + pw + 18, e.y + 4, t.text2);
          }
        }
      }

      // crosshair
      if (state.hover != null && typeof state.hover === "number") {
        const i = state.hover;
        const xx = Math.round(X(xs[i])) + 0.5;
        c.strokeStyle = t.muted; c.lineWidth = 1;
        c.beginPath(); c.moveTo(xx, top); c.lineTo(xx, top + ph); c.stroke();
        for (const s of vis) {
          const v = s.values[i];
          if (v == null || !isFinite(v)) continue;
          c.fillStyle = t.surface; c.beginPath(); c.arc(xx, Y(v), 6, 0, 7); c.fill();
          c.fillStyle = s.color; c.beginPath(); c.arc(xx, Y(v), 4, 0, 7); c.fill();
        }
      }
      layout = { left: left, pw: pw, top: top, ph: ph, X: X, legend: leg.boxes };
    };

    const hit = (mx, my, state) => {
      if (!layout) return null;
      for (const b of layout.legend) {
        if (mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) {
          return { key: "legend:" + b.name, legendClick: () => {
            if (state.hidden.has(b.name)) state.hidden.delete(b.name);
            else if (state.hidden.size < opts.series.length - 1) state.hidden.add(b.name);
          }, tip: { title: null, rows: [{ name: state.hidden.has(b.name) ? "click to show" : "click to hide", value: b.name }] } };
        }
      }
      if (mx < layout.left || mx > layout.left + layout.pw || my < layout.top || my > layout.top + layout.ph) return null;
      const xs = opts.x;
      if (!xs.length) return null;
      let best = 0, bd = Infinity;
      for (let i = 0; i < xs.length; i++) {
        const d = Math.abs(layout.X(xs[i]) - mx);
        if (d < bd) { bd = d; best = i; }
      }
      const rows = opts.series.filter(s => !state.hidden.has(s.name)).map(s => {
        const v = s.values[best];
        let val = v == null || !isFinite(v) ? "—" : (opts.yFormat || num)(v);
        if (s.band && s.band.min[best] != null && isFinite(s.band.min[best])) {
          val += `  (${(opts.yFormat || num)(s.band.min[best])}–${(opts.yFormat || num)(s.band.max[best])})`;
        }
        return { color: s.color, name: s.name, value: val };
      });
      const title = opts.categoricalX ? opts.categoricalX[best] : (opts.xTitle || "t = ") + (opts.xFormat || clock)(xs[best] - xs[0]);
      return { key: best, tip: { title: title, rows: rows } };
    };

    const chart = mount(el, H, draw, hit);
    chart.table = () => ({
      columns: [opts.categoricalX ? (opts.xName || "Session") : "Time"].concat(
        opts.series.flatMap(s => s.band ? [s.name, s.name + " min", s.name + " max"] : [s.name])),
      rows: opts.x.map((xv, i) => [opts.categoricalX ? opts.categoricalX[i] : clock(xv - opts.x[0])].concat(
        opts.series.flatMap(s => {
          const f = v => (v == null || !isFinite(v) ? "" : (opts.yFormat || num)(v));
          return s.band ? [f(s.values[i]), f(s.band.min[i]), f(s.band.max[i])] : [f(s.values[i])];
        })))
    });
    return chart;
  }

  /* ════════════════════ STACKED SHARE over time ════════════════════ */
  function share(el, opts) {
    const H = opts.height || 180;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const leg = legend(c, opts.series.map(s => ({ name: s.name, color: s.color, shape: "box" })), 52, 16, { hidden: new Set() }, w - 60);
      const top = leg.bottom + 8, left = 52, right = 16, bottom = 28;
      const pw = w - left - right, ph = h - top - bottom;
      const xs = opts.x, n = xs.length;
      const x0 = n ? xs[0] : 0, x1 = n ? xs[n - 1] : 1;
      const bw = pw / Math.max(1, n);
      for (const tk of [0, 0.5, 1]) {
        const yy = Math.round(top + ph - tk * ph) + 0.5;
        c.strokeStyle = tk === 0 ? t.axis : t.grid; c.lineWidth = 1;
        c.beginPath(); c.moveTo(left, yy); c.lineTo(left + pw, yy); c.stroke();
        text(c, pct(tk), left - 8, yy + 4, t.muted, { align: "right" });
      }
      for (let i = 0; i < n; i++) {
        let acc = 0;
        const xx = left + i * bw;
        for (const s of opts.series) {
          const v = s.values[i];
          if (!v) continue;
          const y = top + ph - (acc + v) * ph;
          // 2px surface gap between stacked segments (only where the segment is tall enough)
          const segH = v * ph - (acc > 0 && v * ph > 4 ? 2 : 0);
          c.fillStyle = s.color;
          c.globalAlpha = state.hover == null || state.hover === i ? 1 : 0.85;
          c.fillRect(xx, y, Math.max(1, bw + 0.5), Math.max(0, segH));
          acc += v;
        }
      }
      c.globalAlpha = 1;
      const xt = niceTicks(0, x1 - x0, Math.max(2, Math.floor(pw / 90)));
      for (const tk of xt) {
        if (tk > x1 - x0) continue;
        text(c, clock(tk), left + (x1 === x0 ? 0 : (tk / (x1 - x0)) * pw), top + ph + 18, t.muted, { align: "center" });
      }
      if (state.hover != null) {
        const xx = Math.round(left + (state.hover + 0.5) * bw) + 0.5;
        c.strokeStyle = t.text; c.lineWidth = 1;
        c.beginPath(); c.moveTo(xx, top); c.lineTo(xx, top + ph); c.stroke();
      }
      layout = { left: left, top: top, pw: pw, ph: ph, bw: bw };
    };
    const hit = mx => {
      if (!layout || mx < layout.left || mx > layout.left + layout.pw) return null;
      const i = Math.min(opts.x.length - 1, Math.max(0, Math.floor((mx - layout.left) / layout.bw)));
      return { key: i, tip: { title: "t = " + clock(opts.x[i] - opts.x[0]),
        rows: opts.series.map(s => ({ color: s.color, shape: "box", name: s.name, value: pct(s.values[i]) })) } };
    };
    const chart = mount(el, H, draw, hit);
    chart.table = () => ({
      columns: ["Time"].concat(opts.series.map(s => s.name)),
      rows: opts.x.map((xv, i) => [clock(xv - opts.x[0])].concat(opts.series.map(s => pct(s.values[i]))))
    });
    return chart;
  }

  /* ════════════════════ HORIZONTAL BARS ════════════════════ */
  function hbars(el, opts) {
    const rowH = 30;
    const H = (opts.categories.length * rowH) + 34;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const left = opts.labelWidth || 90, right = 64, top = 8;
      const pw = w - left - right;
      const max = opts.max != null ? opts.max : Math.max(1e-9, ...opts.values.filter(v => v != null));
      const ticks = niceTicks(0, max, 4).filter(v => v <= max * 1.0001);
      for (const tk of ticks) {
        const xx = Math.round(left + (tk / max) * pw) + 0.5;
        c.strokeStyle = tk === 0 ? t.axis : t.grid; c.lineWidth = 1;
        c.beginPath(); c.moveTo(xx, top); c.lineTo(xx, top + opts.categories.length * rowH); c.stroke();
        text(c, (opts.format || num)(tk), xx, h - 8, t.muted, { align: "center" });
      }
      opts.categories.forEach((name, i) => {
        const cy = top + i * rowH + rowH / 2;
        text(c, name, left - 10, cy + 4, t.text2, { align: "right" });
        const v = opts.values[i];
        if (v == null || !isFinite(v)) { text(c, "no data", left + 4, cy + 4, t.muted); return; }
        const bh = Math.min(opts.barHeight || 16, 24);
        const bw = Math.max(2, (v / max) * pw);
        c.fillStyle = Array.isArray(opts.color) ? opts.color[i] : opts.color;
        c.globalAlpha = state.hover == null || state.hover === i ? 1 : 0.7;
        roundBar(c, left, cy - bh / 2, bw, bh, 4, true);
        c.globalAlpha = 1;
        text(c, (opts.format || num)(v), left + bw + 8, cy + 4, t.text, { weight: 600 });
      });
      layout = { top: top, rowH: rowH };
    };
    const hit = (mx, my) => {
      if (!layout) return null;
      const i = Math.floor((my - layout.top) / layout.rowH);
      if (i < 0 || i >= opts.categories.length) return null;
      return { key: i, tip: { title: opts.categories[i], rows: [{ name: opts.valueName || "", value: (opts.format || num)(opts.values[i]) }]
        .concat(opts.extra ? opts.extra(i) : []) } };
    };
    const chart = mount(el, H, draw, hit);
    chart.table = () => ({ columns: [opts.categoryName || "Category", opts.valueName || "Value"],
      rows: opts.categories.map((c, i) => [c, (opts.format || num)(opts.values[i])]) });
    return chart;
  }

  /* ════════════════════ HISTOGRAM (small multiples aware) ════════════════════ */
  function histogram(el, opts) {
    const H = opts.height || 150;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const left = 40, right = 10, top = opts.title ? 22 : 8, bottom = 24;
      const pw = w - left - right, ph = h - top - bottom;
      const counts = opts.counts;
      const nb = counts.length;
      const ymax = opts.yMax || Math.max(1, ...counts);
      if (opts.title) text(c, opts.title, left, 14, t.text, { weight: 600 });
      const ticks = niceTicks(0, ymax, 3, true);   // counts: whole numbers only
      for (const tk of ticks) {
        const yy = Math.round(top + ph - (tk / ticks[ticks.length - 1]) * ph) + 0.5;
        c.strokeStyle = tk === 0 ? t.axis : t.grid; c.lineWidth = 1;
        c.beginPath(); c.moveTo(left, yy); c.lineTo(left + pw, yy); c.stroke();
        text(c, num(tk, 0), left - 6, yy + 4, t.muted, { align: "right", size: 10 });
      }
      const slot = pw / nb;
      const gap = Math.min(2, slot * 0.25);
      const bw = Math.min(24, slot - gap);
      const ytop = ticks[ticks.length - 1];
      for (let i = 0; i < nb; i++) {
        const v = counts[i];
        if (!v) continue;
        const bh = (v / ytop) * ph;
        c.fillStyle = opts.color;
        c.globalAlpha = state.hover == null || state.hover === i ? 1 : 0.75;
        roundBar(c, left + i * slot + (slot - bw) / 2, top + ph - bh, bw, bh, Math.min(4, bw / 2), false);
      }
      c.globalAlpha = 1;
      const labEvery = Math.max(1, Math.ceil(nb / Math.max(2, Math.floor(pw / 56))));
      for (let i = 0; i <= nb; i += labEvery) {
        text(c, (opts.xFormat || num)(opts.lo + i * opts.width), left + i * slot, h - 8, t.muted, { align: "center", size: 10 });
      }
      if (opts.marker != null && isFinite(opts.marker)) {
        const xx = Math.round(left + ((opts.marker - opts.lo) / opts.width) * slot) + 0.5;
        c.strokeStyle = t.text; c.lineWidth = 1;
        c.beginPath(); c.moveTo(xx, top); c.lineTo(xx, top + ph); c.stroke();
        text(c, opts.markerLabel || "median", xx + 4, top + 10, t.text2, { size: 10 });
      }
      layout = { left: left, slot: slot, top: top, ph: ph };
    };
    const hit = (mx, my) => {
      if (!layout) return null;
      const i = Math.floor((mx - layout.left) / layout.slot);
      if (i < 0 || i >= opts.counts.length || my < layout.top || my > layout.top + layout.ph) return null;
      const lo = opts.lo + i * opts.width;
      const total = opts.counts.reduce((a, b) => a + b, 0) || 1;
      return { key: i, tip: { title: `${(opts.xFormat || num)(lo)} – ${(opts.xFormat || num)(lo + opts.width)}`,
        rows: [{ name: opts.countName || "count", value: num(opts.counts[i], 0) },
               { name: "of total", value: pct(opts.counts[i] / total) }] } };
    };
    const chart = mount(el, H, draw, hit);
    chart.table = () => ({ columns: [opts.binName || "Bin", opts.countName || "Count"],
      rows: opts.counts.map((v, i) => [`${(opts.xFormat || num)(opts.lo + i * opts.width)}–${(opts.xFormat || num)(opts.lo + (i + 1) * opts.width)}`, String(v)]) });
    return chart;
  }

  /* ════════════════════ TOP-DOWN FIELD HEAT MAP ════════════════════ */
  /** opts: { heat:{nx,ny,x0,x1,y0,y1,counts}, sensors:[{x,y,n}], deadY, markers:[{x,y,kind,label}], height } */
  function field(el, opts) {
    const H = opts.height || 420;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const hm = opts.heat;
      const yTop = Math.min(0, hm.y0), yBot = hm.y1;
      const pad = 34, legendH = 62;   // x tick labels (~16px) + scale/marker legend
      const s = Math.min((w - pad * 2) / (hm.x1 - hm.x0), (h - pad - legendH - 10) / (yBot - yTop));
      const ox = (w - (hm.x1 - hm.x0) * s) / 2, oy = pad - yTop * s;
      const P = (x, y) => [ox + (x - hm.x0) * s, oy + y * s];

      // wall
      const [wx, wy] = P(hm.x0, 0);
      c.fillStyle = t.axis; c.fillRect(wx - 6, wy - 5, (hm.x1 - hm.x0) * s + 12, 4);
      text(c, "Screen / wall", wx + ((hm.x1 - hm.x0) * s) / 2, wy - 10, t.muted, { align: "center", size: 10 });

      // cells (sqrt scale so light traffic stays visible)
      let max = 0;
      for (const col of hm.counts) for (const v of col) max = Math.max(max, v);
      const cw = ((hm.x1 - hm.x0) / hm.nx) * s, ch = ((hm.y1 - hm.y0) / hm.ny) * s;
      const ramp = t.ramp;
      for (let i = 0; i < hm.nx; i++) {
        for (let j = 0; j < hm.ny; j++) {
          const v = hm.counts[i][j];
          if (!v) continue;
          const k = Math.min(ramp.length - 1, Math.floor(Math.sqrt(v / max) * ramp.length));
          c.fillStyle = ramp[k];
          const [px, py] = P(hm.x0 + (i / hm.nx) * (hm.x1 - hm.x0), hm.y0 + (j / hm.ny) * (hm.y1 - hm.y0));
          c.fillRect(px, py, cw + 0.4, ch + 0.4);
        }
      }
      // dead zone line + play area outline (hairlines)
      const [, dy] = P(0, opts.deadY);
      c.strokeStyle = t.critical; c.lineWidth = 1;
      c.beginPath(); c.moveTo(wx, Math.round(dy) + 0.5); c.lineTo(wx + (hm.x1 - hm.x0) * s, Math.round(dy) + 0.5); c.stroke();
      text(c, "dead zone edge", wx + 4, dy - 4, t.muted, { size: 10 });
      c.strokeStyle = t.axis;
      const [ax, ay] = P(hm.x0, hm.y0);
      c.strokeRect(Math.round(ax) + 0.5, Math.round(ay) + 0.5, (hm.x1 - hm.x0) * s, (hm.y1 - hm.y0) * s);
      // metre ticks
      for (let x = 0; x <= hm.x1 + 1e-9; x += 0.5) text(c, x.toFixed(1) + " m", P(x, 0)[0], P(0, yBot)[1] + 14, t.muted, { align: "center", size: 10 });
      for (let y = 0.5; y <= yBot + 1e-9; y += 0.5) text(c, y.toFixed(1), wx - 6, P(0, y)[1] + 3, t.muted, { align: "right", size: 10 });

      // sensors
      for (const sn of opts.sensors || []) {
        const [px, py] = P(sn.x, sn.y);
        c.fillStyle = t.text2; c.fillRect(px - 5, py - 4, 10, 8);
      }
      // markers: hits (filled, surface ring) and escapes (hollow)
      for (const m of opts.markers || []) {
        const [px, py] = P(m.x, m.y);
        c.fillStyle = t.surface; c.beginPath(); c.arc(px, py, 6, 0, 7); c.fill();
        if (m.kind === "escape") { c.strokeStyle = t.text2; c.lineWidth = 1.5; c.beginPath(); c.arc(px, py, 4, 0, 7); c.stroke(); }
        else { c.fillStyle = m.kind === "bomb" ? t.critical : t.text; c.beginPath(); c.arc(px, py, 4, 0, 7); c.fill(); }
      }

      // scale legend + marker legend
      const ly = h - 22, lx = Math.max(12, ox);
      text(c, "Time spent", lx, ly - 8, t.muted, { size: 10 });
      const sw = Math.min(160, w * 0.35) / ramp.length;
      ramp.forEach((col, k) => { c.fillStyle = col; c.fillRect(lx + k * sw, ly, sw, 8); });
      text(c, "less", lx, ly + 20, t.muted, { size: 10 });
      text(c, "more", lx + sw * ramp.length, ly + 20, t.muted, { size: 10, align: "right" });
      if ((opts.markers || []).length) {
        let mx = lx + sw * ramp.length + 28;
        const item = (label, drawMark) => {
          drawMark(mx + 5, ly + 4);
          text(c, label, mx + 14, ly + 8, t.text2, { size: 11 });
          c.font = `400 11px ${FONT}`;
          mx += 22 + c.measureText(label).width;
        };
        item("hit", (x, y) => { c.fillStyle = t.text; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); });
        item("escaped", (x, y) => { c.strokeStyle = t.text2; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 4, 0, 7); c.stroke(); });
        item("bomb hit", (x, y) => { c.fillStyle = t.critical; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); });
      }
      if (state.hover && state.hover.startsWith("cell:")) {
        const [i, j] = state.hover.slice(5).split(",").map(Number);
        const [px, py] = P(hm.x0 + (i / hm.nx) * (hm.x1 - hm.x0), hm.y0 + (j / hm.ny) * (hm.y1 - hm.y0));
        c.strokeStyle = t.text; c.lineWidth = 1.5; c.strokeRect(px, py, cw, ch);
      }
      layout = { P: P, s: s, ox: ox, oy: oy, max: max };
    };
    const hit = (mx, my) => {
      if (!layout) return null;
      const hm = opts.heat;
      const x = hm.x0 + (mx - layout.ox) / layout.s;
      const y = (my - layout.oy) / layout.s;
      for (const m of opts.markers || []) {
        const [px, py] = layout.P(m.x, m.y);
        if (Math.hypot(px - mx, py - my) <= 12) {
          return { key: "m:" + m.x + m.y, tip: { title: m.label || m.kind, rows: m.rows || [] } };
        }
      }
      if (x < hm.x0 || x > hm.x1 || y < hm.y0 || y > hm.y1) return null;
      const i = Math.min(hm.nx - 1, Math.floor(((x - hm.x0) / (hm.x1 - hm.x0)) * hm.nx));
      const j = Math.min(hm.ny - 1, Math.floor(((y - hm.y0) / (hm.y1 - hm.y0)) * hm.ny));
      const total = hm.counts.flat().reduce((a, b) => a + b, 0) || 1;
      return { key: `cell:${i},${j}`, tip: { title: `x ${x.toFixed(2)} m · depth ${y.toFixed(2)} m`,
        rows: [{ name: "samples here", value: num(hm.counts[i][j], 0) }, { name: "of all positioned time", value: pct(hm.counts[i][j] / total) }] } };
    };
    const chart = mount(el, H, draw, hit);
    chart.table = () => {
      const hm = opts.heat, rows = [];
      for (let i = 0; i < hm.nx; i++) for (let j = 0; j < hm.ny; j++) {
        if (!hm.counts[i][j]) continue;
        rows.push([(hm.x0 + ((i + 0.5) / hm.nx) * (hm.x1 - hm.x0)).toFixed(3), (hm.y0 + ((j + 0.5) / hm.ny) * (hm.y1 - hm.y0)).toFixed(3), String(hm.counts[i][j])]);
      }
      return { columns: ["x (m)", "depth (m)", "Samples"], rows: rows };
    };
    return chart;
  }

  /* ════════════════════ EVENT STRIP (rows of ticks over time) ════════════════════ */
  /** opts: { t0, t1, rows:[{name, events:[{t, detail}]}], color } */
  function strip(el, opts) {
    const rowH = 26;
    const H = Math.max(1, opts.rows.length) * rowH + 36;
    let layout = null;
    const draw = ({ c, w, h }, state) => {
      const t = T();
      const left = 132, right = 44, top = 6;
      const pw = w - left - right;
      const span = Math.max(1, opts.t1 - opts.t0);
      const X = v => left + ((v - opts.t0) / span) * pw;
      if (!opts.rows.length) { text(c, "No events of this kind in the session", left, 24, t.muted); layout = null; return; }
      opts.rows.forEach((r, k) => {
        const cy = top + k * rowH + rowH / 2;
        text(c, r.name, left - 10, cy + 4, t.text2, { align: "right" });
        c.strokeStyle = t.grid; c.lineWidth = 1;
        c.beginPath(); c.moveTo(left, Math.round(cy) + 0.5); c.lineTo(left + pw, Math.round(cy) + 0.5); c.stroke();
        c.strokeStyle = r.color || opts.color;
        c.lineWidth = 2;
        for (let i = 0; i < r.events.length; i++) {
          const xx = X(r.events[i].t);
          const hov = state.hover === `${k}:${i}`;
          c.beginPath(); c.moveTo(xx, cy - (hov ? 10 : 7)); c.lineTo(xx, cy + (hov ? 10 : 7)); c.stroke();
        }
        text(c, String(r.events.length), left + pw + 8, cy + 4, t.text, { weight: 600 });
      });
      const xt = niceTicks(0, span, Math.max(2, Math.floor(pw / 90)));
      for (const tk of xt) if (tk <= span) text(c, clock(tk), X(opts.t0 + tk), h - 8, t.muted, { align: "center" });
      layout = { left: left, pw: pw, top: top, X: X };
    };
    const hit = (mx, my) => {
      if (!layout) return null;
      const k = Math.floor((my - layout.top) / rowH);
      const r = opts.rows[k];
      if (!r) return null;
      let best = -1, bd = 12;
      r.events.forEach((e, i) => { const d = Math.abs(layout.X(e.t) - mx); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return null;
      const e = r.events[best];
      return { key: `${k}:${best}`, tip: { title: `${r.name} · t = ${clock(e.t - opts.t0)}`,
        rows: Object.entries(e.detail || {}).slice(0, 8).map(([name, v]) => ({
          name: name, value: typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v) })) } };
    };
    const chart = mount(el, H, draw, hit);
    chart.table = () => ({ columns: ["Type", "Time", "Detail"],
      rows: opts.rows.flatMap(r => r.events.map(e => [r.name, clock(e.t - opts.t0), JSON.stringify(e.detail || {})])) });
    return chart;
  }

  /* ── PNG export: title + subtitle + the clean chart on the surface ── */
  function exportPNG(chart, title, subtitle, filename) {
    const restore = chart.clean();
    const src = chart.canvas();
    const dpr = src.width / src.clientWidth;
    const t = T();
    const pad = 20, head = subtitle ? 52 : 34;
    const out = document.createElement("canvas");
    out.width = src.width + pad * 2 * dpr;
    out.height = src.height + (head + pad) * dpr;
    const c = out.getContext("2d");
    c.fillStyle = t.surface;
    c.fillRect(0, 0, out.width, out.height);
    c.scale(dpr, dpr);
    text(c, title, pad, 26, t.text, { weight: 600, size: 15 });
    if (subtitle) text(c, subtitle, pad, 44, t.muted, { size: 11 });
    c.drawImage(src, pad, head, src.clientWidth, src.clientHeight);
    restore();
    out.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  return { line: line, share: share, hbars: hbars, histogram: histogram, field: field, strip: strip,
           exportPNG: exportPNG, clock: clock, num: num, pct: pct, tokens: T };
})();
