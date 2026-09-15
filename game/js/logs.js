"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Session Logs page
   History list, per-session report (stats, charts, tables, exports)
   and trends across sessions. Data comes from /api/ (bridge/telemetry_api.py).
   ══════════════════════════════════════════════════════════════ */

const L = {
  sessions: [], selected: null, view: "session",
  charts: [], poll: null, detail: null, eventFilter: "anomaly", eventLimit: 300
};

const SENSOR_COLORS = ["--series-1", "--series-2", "--series-3", "--series-4"];
const MODE_META = [
  { key: "two-box", name: "Two-box exact fix", token: "--status-good" },
  { key: "one-box", name: "One-box polar fix", token: "--status-warning" },
  { key: "blind", name: "No fix", token: "--status-critical" },
  { key: "mouse", name: "Mouse (solver bypassed)", token: "--viz-other" }
];
const ANOMALY_INFO = {
  spike: ["Range spike", "A raw reading more than 300 mm away from that sensor's own median — cross-talk or a multipath echo."],
  dropout: ["Sensor dropout", "A sensor that had been echoing stayed silent for 5+ measurements (~320 ms). partner_echo_share says how often its co-located partner still saw the body."],
  blind: ["No fix", "No sensor returned an echo, so the solver could not place the body."],
  veto: ["Solver veto", "The fix was rejected: circles failed to intersect (gap) or it landed outside a firing sensor's cone."],
  pair_disagree: ["Pair disagreement", "Two sensors in the same box disagreed by more than 250 mm; geometry picked the consistent one."],
  sector_conflict: ["Sector conflict", "Which sensors fired is impossible under the current cone calibration."],
  jump: ["Position jump", "The raw fix moved more than 0.6 m between consecutive measurements."],
  gate_reject: ["Velocity gate", "Measurements implied faster than 4 m/s movement and were rejected by the tracker."],
  long_hold: ["Long hold", "A sensor went 2 s or more without sending a new reading, so the game kept computing with its last value."],
  held_mismatch: ["Held-value mismatch", "One solve combined readings taken 750 ms or more apart, so the fix mixes where the player was then with where they are now."],
  mixed_values: ["Mixed value counts", "One box was sending one value while the other sent two; the layout was kept and the odd box's packets were ignored."],
  stale: ["Stale data (older sessions)", "Before hold-last-value: live frames stopped arriving for more than 400 ms."],
  low_rate: ["Low measurement rate (older sessions)", "Before hold-last-value: fewer than 10 measurements per second for over 2 s."],
  fps_drop: ["Low render rate", "The page rendered below 30 fps for over 2 s."],
  box_down: ["Box offline", "The bridge stopped hearing from a sensor box."],
  bad_packets: ["Bad packets", "The bridge received datagrams it could not parse."]
};

/* ── tiny DOM helpers (textContent only for data) ──────────── */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const color = token => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
const fmtMM = v => (v == null || !isFinite(v) ? "—" : `${Viz.num(v, 0)} mm`);
const fmtMs = v => (v == null || !isFinite(v) ? "—" : v >= 10000 ? `${(v / 1000).toFixed(1)} s` : `${Viz.num(v, 0)} ms`);
const fmtDur = s => (s == null || !isFinite(s) ? "—" : Viz.clock(s * 1000));
const fmtWhen = ts => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const dig = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);

function toast(msg) {
  const t = h("div", { class: "toast", role: "status", text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

/* ── chart card: title, caption, Table + PNG actions ───────── */
function card(title, caption, mountFn, opts) {
  opts = opts || {};
  const host = h("div", { class: "chart" });
  const tableWrap = h("div", { class: "tablewrap", hidden: true });
  const tableBtn = h("button", { type: "button", "aria-pressed": "false", text: "TABLE" });
  const pngBtn = h("button", { type: "button", text: "PNG" });
  const el = h("figure", { class: "card" + (opts.wide ? " wide" : "") },
    h("div", { class: "cardhead" },
      h("figcaption", {}, h("h3", { text: title }), caption ? h("p", { class: "cap", text: caption }) : null),
      h("div", { class: "cardact" }, tableBtn, opts.noPng ? null : pngBtn)),
    host, tableWrap);
  let chart = null;
  const mountLater = () => {
    chart = mountFn(host);
    if (chart) L.charts.push(chart);
    else { tableBtn.remove(); pngBtn.remove(); }
  };
  tableBtn.addEventListener("click", () => {
    const on = tableWrap.hidden;
    tableWrap.hidden = !on;
    tableBtn.setAttribute("aria-pressed", String(on));
    if (on && chart && chart.table) {
      const t = chart.table();
      tableWrap.replaceChildren(dataTable(t.columns, t.rows));
    }
  });
  pngBtn.addEventListener("click", () => {
    if (!chart) return;
    const sid = L.detail ? `session${L.detail.id}_` : "";
    Viz.exportPNG(chart, title, caption, `molefield_${sid}${title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`);
  });
  return { el: el, mount: mountLater };
}

function dataTable(columns, rows, wrapCols) {
  return h("table", { class: "dt" },
    h("thead", {}, h("tr", {}, columns.map(c => h("th", { scope: "col", text: c })))),
    h("tbody", {}, rows.map(r => h("tr", {}, r.map((v, i) =>
      h("td", { class: wrapCols && wrapCols.includes(i) ? "wrap" : null, text: v == null ? "—" : String(v) }))))));
}

function tableCard(title, caption, columns, rows, opts) {
  opts = opts || {};
  return h("figure", { class: "card" + (opts.wide ? " wide" : "") },
    h("div", { class: "cardhead" }, h("figcaption", {}, h("h3", { text: title }), caption ? h("p", { class: "cap", text: caption }) : null)),
    h("div", { class: "tablewrap", style: "max-height:none" }, dataTable(columns, rows, opts.wrapCols)),
    opts.after || null);
}

function tile(label, value, sub) {
  return h("div", { class: "tile" }, h("div", { class: "lab", text: label }), h("div", { class: "val", text: value }),
    sub ? h("div", { class: "sub", text: sub }) : null);
}

function section(title, blurb) {
  return h("div", { class: "section" }, h("h2", { text: title }), blurb ? h("p", { text: blurb }) : null);
}

function destroyCharts() {
  for (const c of L.charts) c.destroy();
  L.charts = [];
}

/* ════════════════════ SESSION LIST ════════════════════ */
function filtered() {
  const q = document.getElementById("fSearch").value.trim().toLowerCase();
  const pg = document.getElementById("fPage").value;
  const src = document.getElementById("fSrc").value;
  const cfg = document.getElementById("fCfg").value;
  const hideShort = document.getElementById("fShort").checked;
  return L.sessions.filter(s =>
    (!pg || s.page === pg) && (!src || s.src === src) && (!cfg || String(s.n_sensors) === cfg) &&
    (!hideShort || s.open || (s.duration_s || 0) >= 10) &&
    (!q || (s.label || "").toLowerCase().includes(q) || (s.notes || "").toLowerCase().includes(q) || String(s.id) === q));
}

function sessionTitle(s) {
  if (s.label) return s.label;
  const pg = s.page === "bench" ? "Sensor test" : "Game";
  return `${pg} · ${s.src} · #${s.id}`;
}

function renderList() {
  const host = document.getElementById("sessList");
  const rows = filtered();
  if (!rows.length) {
    host.replaceChildren(h("p", { class: "emptynote",
      text: L.sessions.length ? "No sessions match these filters." :
        "No sessions recorded yet. Open the game or the sensor test page while the bridge is running — recording starts automatically." }));
    return;
  }
  host.replaceChildren(...rows.map(s => h("button", {
    class: "sesscard", type: "button", "aria-current": String(s.id === L.selected),
    onclick: () => select(s.id)
  },
    h("div", { class: "top" }, h("span", { class: "ttl", text: sessionTitle(s) }), h("span", { class: "when", text: fmtWhen(s.started_at) })),
    h("div", { class: "chips" },
      s.open ? h("span", { class: "chipx live", text: "● recording" }) : null,
      h("span", { class: "chipx", text: s.page === "bench" ? "sensor test" : "game" }),
      h("span", { class: "chipx", text: s.src }),
      h("span", { class: "chipx", text: s.config || s.layout })),
    h("div", { class: "nums" },
      h("span", {}, h("b", { text: fmtDur(s.duration_s) })),
      h("span", {}, h("b", { text: Viz.num(s.n_samples, 0) }), " samples"),
      s.src !== "mouse" && s.two_box_share != null ? h("span", {}, h("b", { text: Viz.pct(s.two_box_share) }), " 2-box") : null,
      s.hits ? h("span", {}, h("b", { text: String(s.hits) }), " hits") : null,
      s.anomalies ? h("span", {}, h("b", { text: String(s.anomalies) }), " anom.") : null)
  )));
}

async function loadList() {
  try {
    const [list, status] = await Promise.all([api("/api/sessions?limit=1000"), api("/api/status")]);
    L.sessions = list.sessions;
    document.getElementById("hSessions").textContent = Viz.num(list.total, 0);
    document.getElementById("hSamples").textContent = Viz.num(L.sessions.reduce((a, s) => a + (s.n_samples || 0), 0), 0);
    document.getElementById("hDb").textContent = status.db;
    document.getElementById("hDb").title = status.db;
    renderList();
    return true;
  } catch (e) {
    document.getElementById("sessList").replaceChildren(h("p", { class: "emptynote",
      text: "Can't reach the bridge. Start it with  python3 molefield.py  (or --simulate) and open this page from http://localhost:8000/logs.html." }));
    return false;
  }
}

/* ════════════════════ SESSION REPORT ════════════════════ */
async function select(id, keepScroll) {
  L.selected = id;
  history.replaceState(null, "", `#s=${id}`);
  renderList();
  if (L.view !== "session") showView("session");
  const view = document.getElementById("viewSession");
  view.querySelectorAll(".chart").forEach(c => c.classList.add("refetching"));
  try {
    const [sess, series, ev] = await Promise.all([
      api(`/api/sessions/${id}`), api(`/api/sessions/${id}/series?buckets=500`), api(`/api/sessions/${id}/events`)]);
    if (L.selected !== id) return;
    const y = window.scrollY;
    L.detail = sess;
    renderSession(sess, series, ev.events);
    if (keepScroll) window.scrollTo(0, y);
  } catch (e) {
    view.replaceChildren(h("p", { class: "emptynote", text: `Couldn't load session #${id}: ${e.message}` }));
  }
  clearTimeout(L.poll);
  if (L.detail && L.detail.open && L.selected === id) {
    L.poll = setTimeout(async () => { await loadList(); select(id, true); }, 5000);
  }
}

function renderSession(sess, series, events) {
  destroyCharts();
  const view = document.getElementById("viewSession");
  const S = sess.summary || {};
  const meta = sess.meta || {};
  const names = (meta.sensors || []).map((s, i) => (s && s.n != null ? String(s.n) : `S${i}`));
  const nS = Math.min(S.n_sensors || names.length || 4, 4);
  const sensorName = i => `Sensor ${names[i] != null ? names[i] : i}`;
  const mounts = [];
  const add = c => { mounts.push(c); return c.el; };
  const hasSolver = sess.src !== "mouse" && dig(S, "solver.samples") > 0;
  const game = S.game || {};
  const hasGame = (game.spawns || 0) + (game.hits || 0) + (game.rounds || 0) > 0;
  const acc = S.accuracy || {};
  const hasTruth = dig(acc, "raw_fix_mm.n") > 0;
  const t0 = series.t.length ? series.t0 : 0;
  const t1 = Math.max(series.t.length ? series.t1 : 0, events.length ? events[events.length - 1].t : 0);

  /* header */
  const labelIn = h("input", { class: "label-in", value: sess.label || "", placeholder: "Label this session (e.g. \"Calibration run 1\")", "aria-label": "Session label" });
  const notesIn = h("textarea", { class: "note-in", rows: "1", placeholder: "Notes for the report — setup, who played, what changed…", "aria-label": "Session notes" });
  notesIn.value = sess.notes || "";
  const saveMeta = async () => {
    try {
      await api(`/api/sessions/${sess.id}/meta`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: labelIn.value, notes: notesIn.value }) });
      const row = L.sessions.find(s => s.id === sess.id);
      if (row) { row.label = labelIn.value; row.notes = notesIn.value; renderList(); }
      toast("Saved");
    } catch (e) { toast("Couldn't save: " + e.message); }
  };
  labelIn.addEventListener("change", saveMeta);
  notesIn.addEventListener("change", saveMeta);

  const head = h("div", { class: "sesshead" },
    h("div", {},
      h("h1", { text: sessionTitle(sess) }),
      h("div", { class: "metaline" },
        h("span", { text: `#${sess.id}` }),
        h("span", { text: fmtWhen(sess.started_at) }),
        h("span", { text: sess.page === "bench" ? "sensor test" : "game" }),
        h("span", { text: `source: ${sess.src}` }),
        h("span", { text: `sensors: ${dig(S, "config.label") || sess.layout}` }),
        dig(S, "config.sim_timing") ? h("span", { text: `sim timing: ${S.config.sim_timing}` }) : null,
        sess.open ? h("span", { style: "color:var(--alarm)", text: "● still recording — refreshes every 5 s" }) : null)),
    h("div", { class: "actions" },
      h("a", { class: "cta ghost", href: `/api/sessions/${sess.id}/samples.csv`, text: "Samples CSV" }),
      h("a", { class: "cta ghost", href: `/api/sessions/${sess.id}/events.csv`, text: "Events CSV" }),
      h("a", { class: "cta ghost", href: `/api/sessions/${sess.id}/summary.json`, text: "Summary JSON" }),
      h("button", { class: "cta ghost", type: "button", text: "Copy summary", onclick: () => copySummary(sess, names) }),
      h("button", { class: "cta danger", type: "button", text: "Delete", onclick: () => removeSession(sess) })),
    h("div", { class: "editrow" }, labelIn, notesIn));

  /* KPI row */
  const kpis = h("div", { class: "kpis" },
    tile("Duration", fmtDur(S.duration_s)),
    tile("Measurements", Viz.num(S.n_samples, 0), hasSolver ? `${Viz.num(dig(S, "rates.meas_hz.median"), 1)} Hz median` : "pointer sampled at ~15 Hz"),
    hasSolver ? tile("Two-box exact fix", Viz.pct(dig(S, "solver.mode_share.two-box")), `one-box ${Viz.pct(dig(S, "solver.mode_share.one-box"))} · none ${Viz.pct(dig(S, "solver.mode_share.blind"))}`) : null,
    hasSolver ? tile("Median uncertainty", fmtMM(dig(S, "solver.sigma.median")), `p90 ${fmtMM(dig(S, "solver.sigma.p90"))}`) : null,
    hasTruth ? tile("Median error vs truth", fmtMM(dig(acc, "raw_fix_mm.median")), `p90 ${fmtMM(dig(acc, "raw_fix_mm.p90"))} · n=${Viz.num(acc.raw_fix_mm.n, 0)}`) : null,
    tile("Anomalies", Viz.num(dig(S, "anomalies.total") || 0, 0), dig(S, "anomalies.per_minute") != null ? `${Viz.num(S.anomalies.per_minute, 1)} per minute` : null),
    hasGame ? tile("Moles hit", Viz.num(game.hits || 0, 0), game.accuracy != null ? `${Viz.pct(game.accuracy)} caught · ${game.escapes} escaped` : null) : null,
    hasGame && dig(game, "reaction_ms.n") ? tile("Median reaction", fmtMs(game.reaction_ms.median), `p90 ${fmtMs(game.reaction_ms.p90)}`) : null,
    hasGame ? tile("Best score", Viz.num(game.max_score || 0, 0), `best streak ×${game.best_streak || 1}`) : null,
    tile("Distance moved", `${Viz.num(dig(S, "position.path_m"), 1)} m`, `median ${Viz.num(dig(S, "position.speed_mps.median"), 2)} m/s`)
  );

  const blocks = [head, kpis];
  const st = series.stats || {};

  /* ── Sensors ── */
  blocks.push(section("Sensors", sess.src === "mouse" ? "Mouse mode: these ranges are simulated from the pointer, not measured." : null));
  const sensorsGrid = h("div", { class: "grid2" });
  const rangeSeries = [];
  for (let i = 0; i < nS; i++) {
    const med = st["m" + i], raw = st["r" + i];
    if (!med && !raw) continue;
    rangeSeries.push({ name: sensorName(i), color: color(SENSOR_COLORS[i]),
      values: (med || raw).mean, band: raw ? { min: raw.min, max: raw.max } : null });
  }
  if (rangeSeries.length) {
    sensorsGrid.appendChild(add(card("Sensor ranges over time",
      "Line: median-filtered range. Shaded band: min–max of the raw readings in each time slice, so spikes show as sudden band flares.",
      el => Viz.line(el, { x: series.t, series: rangeSeries, yUnit: "mm", height: 280 }), { wide: true })));
  }
  const ageSeries = [];
  for (let i = 0; i < nS; i++) {
    const a = st["a" + i];
    if (a) ageSeries.push({ name: sensorName(i), color: color(SENSOR_COLORS[i]), values: a.max });
  }
  if (ageSeries.length && sess.src !== "mouse") {
    sensorsGrid.appendChild(add(card("How old each sensor's value was",
      "Boxes send whenever they like and the game holds each sensor's last value. This is how long ago each value was sent (the oldest in each time slice). A saw-tooth means regular updates; tall teeth mean long holds.",
      el => Viz.line(el, { x: series.t, series: ageSeries, yUnit: "ms", height: 240 }), { wide: true })));
  }
  const sensors = S.sensors || [];
  if (sensors.length) {
    sensorsGrid.appendChild(add(card("Echo rate by sensor",
      sess.src === "mouse" ? "Share of samples in which each simulated sensor could see the pointer." : "Share of measurements in which each sensor returned an echo.",
      el => Viz.hbars(el, { categories: sensors.map(s => sensorName(s.index)), values: sensors.map(s => s.echo_rate),
        max: 1, format: Viz.pct, color: color("--series-1"), valueName: "echo rate", categoryName: "Sensor",
        extra: i => [{ name: "spikes", value: String(sensors[i].spikes) }, { name: "dropouts", value: String(sensors[i].dropouts) }] }))));

    // shared x range for the small multiples: trim empty bins at the far end
    let lastBin = 0, yMax = 1;
    for (const s of sensors) {
      s.hist.counts.forEach((v, k) => { if (v) lastBin = Math.max(lastBin, k); });
      yMax = Math.max(yMax, ...s.hist.counts);
    }
    const nb = Math.min(sensors[0].hist.counts.length, lastBin + 2);
    const multi = card("Range distribution by sensor",
      "How often each raw range was seen, in 50 mm bins, on a shared scale. The vertical line marks the median.",
      el => {
        const grid = h("div", { class: "smallmult" });
        el.appendChild(grid);
        const charts = sensors.map(s => {
          const cell = h("div", { style: "min-width:0" });
          grid.appendChild(cell);
          return Viz.histogram(cell, { title: sensorName(s.index), counts: s.hist.counts.slice(0, nb), lo: 0, width: s.hist.width,
            yMax: yMax, color: color("--series-1"), marker: dig(s, "raw.median"), height: 150, xFormat: v => Viz.num(v, 0),
            binName: "Range (mm)", countName: "readings" });
        });
        charts.forEach(c => L.charts.push(c));
        return { destroy() {}, table: () => ({
          columns: ["Range (mm)"].concat(sensors.map(s => sensorName(s.index))),
          rows: Array.from({ length: nb }, (_, k) => [`${k * 50}–${(k + 1) * 50}`].concat(sensors.map(s => String(s.hist.counts[k] || 0)))) }) };
      }, { wide: true, noPng: true });
    sensorsGrid.appendChild(add(multi));
    sensorsGrid.appendChild(tableCard("Sensor statistics", "Raw ranges in millimetres.",
      ["Sensor", "Echo", "Min", "P5", "Median", "Mean", "P95", "Max", "Std dev", "Spikes", "Dropouts", "Longest dropout"],
      sensors.map(s => [sensorName(s.index), Viz.pct(s.echo_rate), Viz.num(s.raw.min, 0), Viz.num(s.raw.p5, 0), Viz.num(s.raw.median, 0),
        Viz.num(s.raw.mean, 0), Viz.num(s.raw.p95, 0), Viz.num(s.raw.max, 0), Viz.num(s.raw.std, 1), s.spikes, s.dropouts, fmtMs(s.longest_dropout_ms)]),
      { wide: true }));
    if (sensors.some(s => s.has_timing) && sess.src !== "mouse") {
      sensorsGrid.appendChild(tableCard("Update timing by sensor",
        "How often each sensor sent a new reading, and how long the game held each value in between.",
        ["Sensor", "Updates", "Per second", "Gap median", "Gap p90", "Longest gap", "Held value age, median", "Long holds (2 s+)"],
        sensors.map(s => [sensorName(s.index), s.has_timing ? Viz.num(s.updates, 0) : "—", s.has_timing ? Viz.num(s.update_hz, 1) : "—",
          fmtMs(dig(s, "interval_ms.median")), fmtMs(dig(s, "interval_ms.p90")), fmtMs(dig(s, "interval_ms.max")),
          fmtMs(dig(s, "hold_ms.median")), s.long_holds]), { wide: true }));
    }
  }
  blocks.push(sensorsGrid);

  /* ── Solver ── */
  if (hasSolver) {
    blocks.push(section("Triangulation", "How the sector solver performed on this data."));
    const g = h("div", { class: "grid2" });
    const modes = MODE_META.filter(m => (series.mode[m.key] || []).some(v => v));
    g.appendChild(add(card("Solve mode over time", "Share of measurements in each solver mode per time slice.",
      el => Viz.share(el, { x: series.t, series: modes.map(m => ({ name: m.name, color: color(m.token), values: series.mode[m.key] })), height: 190 }), { wide: true })));
    if (st.sigma) g.appendChild(add(card("Position uncertainty (σ)", "The solver's own estimate of how far off the fix could be. Line: mean; band: min–max per slice.",
      el => Viz.line(el, { x: series.t, series: [{ name: "σ", color: color("--series-1"), values: st.sigma.mean, band: { min: st.sigma.min, max: st.sigma.max } }], yUnit: "mm" }))));
    if (st.gap) g.appendChild(add(card("Circle gap", "How far the two range circles were from touching. Above 350 mm the ranges are treated as inconsistent.",
      el => Viz.line(el, { x: series.t, series: [{ name: "gap", color: color("--series-1"), values: st.gap.mean, band: { min: st.gap.min, max: st.gap.max } }], yUnit: "mm" }))));
    if (st.err) g.appendChild(add(card("Error against ground truth", "Distance from the raw fix to the true position (truth marker, or the simulated body). Line: mean; band: min–max.",
      el => Viz.line(el, { x: series.t, series: [{ name: "error", color: color("--series-1"), values: st.err.mean, band: { min: st.err.min, max: st.err.max } }], yUnit: "mm" }), { wide: true })));
    const sv = S.solver;
    const row = (name, d) => [name, fmtMM(d && d.median), fmtMM(d && d.p90), fmtMM(d && d.max), Viz.num(d && d.n, 0)];
    g.appendChild(tableCard("Solver statistics", null, ["Metric", "Median", "P90", "Max", "n"], [
      row("σ, all fixes", sv.sigma), row("σ, two-box", sv.sigma_two_box), row("σ, one-box", sv.sigma_one_box),
      row("Circle gap", sv.gap), row("Pair spread", sv.spread),
      ["Sector miss", Viz.num(dig(sv, "sector_miss.median"), 1) + "°", Viz.num(dig(sv, "sector_miss.p90"), 1) + "°", Viz.num(dig(sv, "sector_miss.max"), 1) + "°", Viz.num(dig(sv, "sector_miss.n"), 0)],
      row("Raw fix → filtered cursor", sv.raw_vs_filtered_mm),
      ["Time between boxes' readings", fmtMs(dig(sv, "age_spread_ms.median")), fmtMs(dig(sv, "age_spread_ms.p90")),
       fmtMs(dig(sv, "age_spread_ms.max")), Viz.num(dig(sv, "age_spread_ms.n"), 0)]
    ]));
    g.appendChild(tableCard("Solver rates", "Share of non-mouse measurements.", ["Condition", "Share"], [
      ["Two-box exact fix", Viz.pct(sv.mode_share["two-box"])], ["One-box polar fix", Viz.pct(sv.mode_share["one-box"])],
      ["No fix", Viz.pct(sv.mode_share.blind)], ["Vetoed", Viz.pct(sv.veto_rate)], ["Pair disagreement", Viz.pct(sv.split_rate)],
      ["Sector conflict", Viz.pct(sv.conflict_rate)], ["Stale data", Viz.pct(sv.stale_rate)],
      ["Velocity-gated", Viz.pct(sv.samples ? sv.gate_reject_samples / sv.samples : null)]]));
    if (hasTruth) {
      const arow = (name, d) => [name, fmtMM(d.median), fmtMM(d.mean), fmtMM(d.p90), fmtMM(d.max), Viz.num(d.n, 0)];
      g.appendChild(tableCard("Accuracy against ground truth", "Only measurements where the page knew the true position.",
        ["Estimate", "Median", "Mean", "P90", "Max", "n"], [
          arow("Raw solver fix", acc.raw_fix_mm), arow("Filtered cursor", acc.filtered_mm),
          arow("Raw fix, two-box only", acc.raw_fix_two_box_mm), arow("Raw fix, one-box only", acc.raw_fix_one_box_mm)], { wide: true }));
    }
    blocks.push(g);
  }

  /* ── Position ── */
  blocks.push(section("Position", null));
  const pg = h("div", { class: "grid2" });
  const spawnXY = {};
  for (const e of events) if (e.type === "spawn" && e.data.id != null) spawnXY[e.data.id] = e.data;
  const markers = [];
  for (const e of events) {
    if (e.type === "hit" && e.data.x != null) {
      markers.push({ x: e.data.x, y: e.data.y, kind: e.data.kind === "bomb" ? "bomb" : "hit", label: `${e.data.kind} hit · t = ${Viz.clock(e.t)}`,
        rows: [{ name: "reaction", value: fmtMs(e.data.reaction_ms) }, { name: "cursor to hole", value: fmtMM(e.data.dist_mm) },
               { name: "solver mode", value: String(e.data.mode) }] });
    } else if (e.type === "escape" && spawnXY[e.data.id]) {
      markers.push({ x: spawnXY[e.data.id].x, y: spawnXY[e.data.id].y, kind: "escape", label: `${e.data.kind} escaped · t = ${Viz.clock(e.t)}` });
    }
  }
  if (S.position && S.position.heat) {
    pg.appendChild(add(card("Where the player spent time", "Top-down view, wall at the top. Colour: share of positioned samples in each cell.",
      el => Viz.field(el, { heat: S.position.heat, sensors: meta.sensors || [], deadY: 0.6, markers: markers, height: 460 }))));
  }
  pg.appendChild(tableCard("Movement", null, ["Metric", "Value"], [
    ["Distance moved", `${Viz.num(S.position.path_m, 2)} m`],
    ["Speed, median", `${Viz.num(dig(S, "position.speed_mps.median"), 2)} m/s`],
    ["Speed, p95", `${Viz.num(dig(S, "position.speed_mps.p95"), 2)} m/s`],
    ["Speed, max", `${Viz.num(dig(S, "position.speed_mps.max"), 2)} m/s`],
    ["Dead-zone entries", Viz.num(S.position.deadzone_entries, 0)],
    ["Time in dead zone", `${Viz.num(S.position.deadzone_s, 1)} s`]]));
  blocks.push(pg);

  /* ── Game ── */
  if (hasGame) {
    blocks.push(section("Game", null));
    const gg = h("div", { class: "grid2" });
    if (st.score) gg.appendChild(add(card("Score over time", null,
      el => Viz.line(el, { x: series.t, series: [{ name: "score", color: color("--series-1"), values: st.score.max }], height: 220 }))));
    if (dig(game, "reaction_ms.n")) {
      const rh = game.reaction_hist;
      let last = 0;
      rh.counts.forEach((v, k) => { if (v) last = k; });
      gg.appendChild(add(card("Reaction time", "From a mole appearing to it being whacked (includes the dwell hold). 250 ms bins.",
        el => Viz.histogram(el, { counts: rh.counts.slice(0, last + 2), lo: rh.lo, width: rh.width, color: color("--series-1"),
          marker: game.reaction_ms.median, height: 220, xFormat: v => `${(v / 1000).toFixed(1)}s`, binName: "Reaction", countName: "hits" }))));
    }
    const gameRows = events.filter(e => e.category === "game" && ["spawn", "hit", "escape", "deadzone_enter"].includes(e.type));
    const byType = type => gameRows.filter(e => e.type === type).map(e => ({ t: e.t, detail: e.data }));
    gg.appendChild(add(card("Game timeline", "Each tick is one event.",
      el => Viz.strip(el, { t0: t0, t1: t1, color: color("--series-1"), rows: [
        { name: "Mole appeared", events: byType("spawn") }, { name: "Hit", events: byType("hit") },
        { name: "Escaped", events: byType("escape") }, { name: "Dead zone", events: byType("deadzone_enter"), color: color("--status-critical") }] }), { wide: true })));
    if ((game.levels || []).length) {
      gg.appendChild(tableCard("By level", null, ["Level", "Shown", "Hit", "Gold", "Escaped", "Bombs hit", "Caught", "Median reaction"],
        game.levels.map(l => [l.level, l.spawns, l.hits, l.gold, l.escapes, l.bombs_hit, Viz.pct(l.accuracy), fmtMs(l.reaction_median_ms)]), { wide: true }));
    }
    if ((game.runs || []).length) {
      gg.appendChild(tableCard("Finished runs", null, ["Result", "Level", "Score", "Hits", "Shown", "Caught", "Best streak"],
        game.runs.map(r => [r.title, r.level, r.score, r.hits, r.shown, Viz.pct(r.accuracy), `×${r.best_streak}`]), { wide: true }));
    }
    blocks.push(gg);
  }

  /* ── Anomalies ── */
  blocks.push(section("Anomalies", "Detected live in the browser while recording. Definitions below."));
  const ag = h("div", { class: "grid2" });
  const anomalies = events.filter(e => e.category === "anomaly");
  const types = Object.keys(ANOMALY_INFO).filter(k => anomalies.some(e => e.type === k))
    .concat([...new Set(anomalies.map(e => e.type))].filter(k => !ANOMALY_INFO[k]));
  ag.appendChild(add(card("Anomaly timeline", anomalies.length ? "Each tick is one detection. Hover a tick for its details." : "Nothing was detected in this session.",
    el => Viz.strip(el, { t0: t0, t1: t1, color: color("--status-warning"),
      rows: types.map(k => ({ name: (ANOMALY_INFO[k] || [k])[0], events: anomalies.filter(e => e.type === k).map(e => ({ t: e.t, detail: e.data })) })) }),
    { wide: true })));
  const minutes = (S.duration_s || 0) / 60;
  ag.appendChild(tableCard("What each anomaly means", null, ["Anomaly", "Count", "Per minute", "Definition"],
    Object.entries(ANOMALY_INFO).map(([k, [name, def]]) => {
      const n = (dig(S, "anomalies.counts") || {})[k] || 0;
      return [name, n, minutes > 0 ? Viz.num(n / minutes, 2) : "—", def];
    }), { wide: true, wrapCols: [3] }));
  blocks.push(ag);

  /* ── Performance ── */
  blocks.push(section("Performance", null));
  const perf = h("div", { class: "grid2" });
  if (st.meas_hz && sess.src !== "mouse") perf.appendChild(add(card("Measurement rate", "New sensor measurements per second. The rig pings at 15.6 Hz.",
    el => Viz.line(el, { x: series.t, series: [{ name: "Hz", color: color("--series-1"), values: st.meas_hz.mean }], yUnit: "Hz", height: 200 }))));
  if (st.fps) perf.appendChild(add(card("Render rate", "Frames per second the page drew.",
    el => Viz.line(el, { x: series.t, series: [{ name: "fps", color: color("--series-1"), values: st.fps.mean }], yUnit: "fps", height: 200 }))));
  blocks.push(perf);

  /* ── Calibration ── */
  const fits = dig(S, "calibration.fits") || [];
  if (fits.length || dig(S, "calibration.captures")) {
    blocks.push(section("Calibration", `${S.calibration.captures} capture bursts, ${fits.length} fit${fits.length === 1 ? "" : "s"}.`));
    const rows = [];
    fits.forEach((f, k) => (f.sensors || []).forEach(s => rows.push([
      `Fit ${k + 1}`, `Sensor ${s.name}`, `${Viz.num(s.before_a, 2)}° / ${Viz.num(s.before_w, 1)}°`,
      `${Viz.num(s.after_a, 2)}° / ${Viz.num(s.after_w, 1)}°`,
      s.fit ? (s.fit.poor ? s.fit.why : `${Viz.num(s.fit.aim, 1)}° / ${Viz.num(s.fit.width, 1)}° (${s.fit.edges} edges)`) : "no data"])));
    if (rows.length) blocks.push(h("div", { class: "grid2" }, tableCard("Cone fits", "Aim / full width before and after each fit.",
      ["Fit", "Sensor", "Before", "After", "Measured"], rows, { wide: true, wrapCols: [4] })));
  }

  /* ── Event log ── */
  blocks.push(section("Event log", `${Viz.num(events.length, 0)} events.`));
  const cats = ["anomaly", "game", "calibration", "system", "all"];
  const logHost = h("div");
  const renderLog = () => {
    const rows = events.filter(e => L.eventFilter === "all" || e.category === L.eventFilter);
    const shown = rows.slice(0, L.eventLimit);
    logHost.replaceChildren(
      dataTable(["Time", "Category", "Event", "Detail"], shown.map(e => [Viz.clock(e.t), e.category, e.type, JSON.stringify(e.data)]), [3]),
      rows.length > shown.length ? h("button", { class: "cta ghost", type: "button", style: "margin-top:0.5rem",
        text: `Show all ${rows.length}`, onclick: () => { L.eventLimit = Infinity; renderLog(); } }) : null);
  };
  const filt = h("div", { class: "evfilter", role: "group", "aria-label": "Event category" }, cats.map(c => h("button", {
    class: "chip", type: "button", "aria-pressed": String(c === L.eventFilter),
    text: `${c} (${c === "all" ? events.length : events.filter(e => e.category === c).length})`,
    onclick: ev => { L.eventFilter = c; L.eventLimit = 300; filt.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === ev.currentTarget))); renderLog(); }
  })));
  renderLog();
  blocks.push(h("figure", { class: "card wide" }, filt, h("div", { class: "tablewrap", style: "max-height:520px" }, logHost)));

  view.replaceChildren(...blocks);
  for (const m of mounts) m.mount();   // charts need their real width, so mount after insertion
}

async function removeSession(sess) {
  if (!confirm(`Delete session #${sess.id} (${sessionTitle(sess)}) and all ${sess.n_samples} of its samples? This can't be undone.`)) return;
  try {
    await api(`/api/sessions/${sess.id}`, { method: "DELETE" });
    toast(`Deleted session #${sess.id}`);
    L.selected = null;
    destroyCharts();
    document.getElementById("viewSession").replaceChildren();
    await loadList();
    const first = filtered()[0];
    if (first) select(first.id);
  } catch (e) { toast("Couldn't delete: " + e.message); }
}

function copySummary(sess, names) {
  const S = sess.summary || {};
  const lines = [
    `MOLEFIELD session #${sess.id}${sess.label ? " — " + sess.label : ""}`,
    `${fmtWhen(sess.started_at)} · ${sess.page} · source ${sess.src} · ${dig(S, "config.label") || sess.layout} · duration ${fmtDur(S.duration_s)}`,
    `Measurements: ${S.n_samples} (median ${Viz.num(dig(S, "rates.meas_hz.median"), 1)} Hz)`,
  ];
  if (sess.src !== "mouse" && S.solver) {
    lines.push(`Solve modes: two-box ${Viz.pct(S.solver.mode_share["two-box"])}, one-box ${Viz.pct(S.solver.mode_share["one-box"])}, no fix ${Viz.pct(S.solver.mode_share.blind)}; veto rate ${Viz.pct(S.solver.veto_rate)}`);
    lines.push(`Uncertainty σ: median ${fmtMM(dig(S, "solver.sigma.median"))}, p90 ${fmtMM(dig(S, "solver.sigma.p90"))}`);
  }
  if (dig(S, "accuracy.raw_fix_mm.n")) {
    lines.push(`Error vs truth: raw fix median ${fmtMM(S.accuracy.raw_fix_mm.median)} (p90 ${fmtMM(S.accuracy.raw_fix_mm.p90)}), filtered median ${fmtMM(S.accuracy.filtered_mm.median)}`);
  }
  for (const s of S.sensors || []) {
    lines.push(`Sensor ${names[s.index] != null ? names[s.index] : s.index}: echo ${Viz.pct(s.echo_rate)}, range median ${fmtMM(s.raw.median)} (${fmtMM(s.raw.min)}–${fmtMM(s.raw.max)}), spikes ${s.spikes}, dropouts ${s.dropouts}` +
      (s.has_timing && sess.src !== "mouse" ? `, ${Viz.num(s.update_hz, 1)} updates/s, longest gap ${fmtMs(dig(s, "interval_ms.max"))}` : ""));
  }
  const g = S.game || {};
  if ((g.hits || 0) + (g.spawns || 0)) {
    lines.push(`Game: ${g.hits} hits, ${g.escapes} escaped, caught ${Viz.pct(g.accuracy)}, median reaction ${fmtMs(dig(g, "reaction_ms.median"))}, best score ${g.max_score}`);
  }
  const counts = dig(S, "anomalies.counts") || {};
  lines.push(`Anomalies: ${S.anomalies ? S.anomalies.total : 0}` + (Object.keys(counts).length ? " — " + Object.entries(counts).map(([k, v]) => `${(ANOMALY_INFO[k] || [k])[0].toLowerCase()} ${v}`).join(", ") : ""));
  const txt = lines.join("\n");
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
    .then(() => toast("Summary copied"))
    .catch(() => { prompt("Copy the summary:", txt); });
}

/* ════════════════════ TRENDS ════════════════════ */
async function renderTrends() {
  destroyCharts();
  const view = document.getElementById("viewTrends");
  let rows;
  try { rows = (await api("/api/trends")).trends; }
  catch (e) { view.replaceChildren(h("p", { class: "emptynote", text: "Can't reach the bridge." })); return; }
  const keep = new Set(filtered().map(s => s.id));
  rows = rows.filter(r => keep.has(r.id));
  if (rows.length < 2) {
    view.replaceChildren(h("p", { class: "emptynote", text: "Trends need at least two sessions that match the filters on the left." }));
    return;
  }
  const x = rows.map((_, i) => i);
  const labels = rows.map(r => `#${r.id}`);
  const metric = (title, caption, key, fmt, unit) => card(title, caption, el => Viz.line(el, {
    x: x, categoricalX: labels, xName: "Session", series: [{ name: title, color: color("--series-1"), values: rows.map(r => r[key]) }],
    yFormat: fmt, yUnit: unit, points: true, endLabels: false, height: 210 }));
  const mounts = [
    metric("Two-box exact fix share", "Per session, non-mouse sessions only.", "two_box_share", Viz.pct),
    metric("Median uncertainty σ", null, "sigma_median_mm", v => Viz.num(v, 0), "mm"),
    metric("Veto rate", null, "veto_rate", Viz.pct),
    metric("Anomalies per minute", null, "anomalies_per_min", v => Viz.num(v, 1)),
    metric("Median measurement rate", null, "meas_hz_median", v => Viz.num(v, 1), "Hz"),
    metric("Median error against ground truth", "Sensor test sessions with a truth marker or simulated body.", "error_median_mm", v => Viz.num(v, 0), "mm"),
    metric("Moles caught", "Game sessions only.", "accuracy", Viz.pct),
    metric("Median reaction time", "Game sessions only.", "reaction_median_ms", v => Viz.num(v, 0), "ms"),
    metric("Best score", "Game sessions only.", "max_score", v => Viz.num(v, 0))
  ];
  const med = vals => {
    const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
  };
  const groups = {};
  for (const r of rows) (groups[r.config || r.layout] = groups[r.config || r.layout] || []).push(r);
  const cfgTable = tableCard("Sensor setups compared",
    "Median of the per-session values in each setup. Older sessions keep the widths they were recorded with, so earlier calibrations stay separate.",
    ["Setup", "Sessions", "Two-box fix", "σ median", "Error vs truth", "Veto rate", "Anomalies/min", "Time between boxes' readings", "Caught"],
    Object.entries(groups).map(([k, g]) => [k, g.length,
      Viz.pct(med(g.filter(r => r.src !== "mouse").map(r => r.two_box_share))), fmtMM(med(g.map(r => r.sigma_median_mm))),
      fmtMM(med(g.map(r => r.error_median_mm))), Viz.pct(med(g.map(r => r.veto_rate))), Viz.num(med(g.map(r => r.anomalies_per_min)), 1),
      fmtMs(med(g.map(r => r.age_spread_median_ms))), Viz.pct(med(g.map(r => r.accuracy)))]), { wide: true });
  const table = tableCard("All sessions", null,
    ["Session", "Started", "Page", "Source", "Sensors", "Duration", "Samples", "Two-box", "σ median", "Veto", "Anom./min", "Caught", "Reaction", "Best score"],
    rows.slice().reverse().map(r => [`#${r.id}${r.label ? " " + r.label : ""}`, fmtWhen(r.started_at), r.page, r.src, r.config || r.layout, fmtDur(r.duration_s),
      Viz.num(r.n_samples, 0), Viz.pct(r.two_box_share), fmtMM(r.sigma_median_mm), Viz.pct(r.veto_rate), Viz.num(r.anomalies_per_min, 1),
      Viz.pct(r.accuracy), fmtMs(r.reaction_median_ms), r.max_score == null ? "—" : r.max_score]), { wide: true });
  view.replaceChildren(
    h("p", { class: "cap", style: "color:var(--text-dim);font-size:0.75rem;margin-bottom:0.7rem",
      text: `${rows.length} sessions, oldest first. Filters on the left apply here too. Gaps mean the metric doesn't apply to that session.` }),
    h("div", { class: "grid2" }, cfgTable, mounts.map(m => m.el), table));
  mounts.forEach(m => m.mount());
}

/* ════════════════════ wiring ════════════════════ */
function showView(v) {
  L.view = v;
  document.getElementById("tabSession").setAttribute("aria-selected", String(v === "session"));
  document.getElementById("tabTrends").setAttribute("aria-selected", String(v === "trends"));
  document.getElementById("viewSession").hidden = v !== "session";
  document.getElementById("viewTrends").hidden = v !== "trends";
  if (v === "trends") { clearTimeout(L.poll); renderTrends(); }
  else if (L.selected != null) select(L.selected);
}

async function init() {
  document.getElementById("tabSession").onclick = () => showView("session");
  document.getElementById("tabTrends").onclick = () => showView("trends");
  const refilter = () => { renderList(); if (L.view === "trends") renderTrends(); };
  ["fSearch", "fPage", "fSrc", "fCfg", "fShort"].forEach(id => document.getElementById(id).addEventListener("input", refilter));

  if (!(await loadList())) return;
  const m = /s=(\d+)/.exec(location.hash);
  const wanted = m ? +m[1] : null;
  const target = (wanted && L.sessions.find(s => s.id === wanted)) || filtered()[0] || L.sessions[0];
  if (target) select(target.id);
  else document.getElementById("viewSession").replaceChildren(h("p", { class: "emptynote",
    text: "No sessions yet. Play the game or use the sensor test page while the bridge is running, then come back here." }));
}

window.addEventListener("DOMContentLoaded", init);
