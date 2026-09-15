"""
Telemetry Store: SQLite persistence for recorded sessions.

Every page load of the game or the sensor test bench becomes a *session*. The
browser streams two kinds of rows into it:

  samples  one row per sensor measurement (~15.6 Hz): raw and median ranges,
           solver state, raw and filtered position, rates, and game state.
  events   discrete happenings: game events (spawn, hit, escape...), anomalies
           detected in the sensor stream, calibration actions, system changes.

Sessions are summarised by bridge/analysis.py when they end, and the summary is
cached on the session row. Uses only the standard library.
"""

from __future__ import annotations

import csv
import io
import json
import os
import sqlite3
import threading
import time
from typing import Any, Iterable

SCHEMA_VERSION = 2   # 2: per-sensor value ages (a0-a3), for boxes that upstream at their own pace
MAX_SENSORS = 4  # every layout in config.py/config.js has at most four

# Column order for samples. Shared by insert, CSV export and analysis.
SAMPLE_COLS: list[str] = (
    ["t", "src", "mode", "phase"]
    + [f"r{i}" for i in range(MAX_SENSORS)]      # raw surface range, mm
    + [f"m{i}" for i in range(MAX_SENSORS)]      # median-filtered range, mm
    + ["x_raw", "y_raw", "x", "y",               # metres: solver fix, filtered cursor
       "tx", "ty",                                # metres: ground truth, when the page knows it
       "sigma", "gap", "spread", "miss", "resid",  # mm, mm, mm, deg, mm
       "veto", "split", "conflict", "stale", "alarm",
       "gate", "meas_hz", "fps", "score", "level", "boxes_alive"]
    + [f"a{i}" for i in range(MAX_SENSORS)]      # ms since that sensor last sent (v2)
)
_INT_COLS = {f"r{i}" for i in range(MAX_SENSORS)} | {f"m{i}" for i in range(MAX_SENSORS)} | {
    f"a{i}" for i in range(MAX_SENSORS)} | {
    "t", "veto", "split", "conflict", "stale", "alarm", "gate", "score", "level", "boxes_alive"}
_TEXT_COLS = {"src", "mode", "phase"}

EVENT_CATEGORIES = {"game", "anomaly", "system", "calibration"}

_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  REAL NOT NULL,
    ended_at    REAL,
    last_seen   REAL NOT NULL,
    page        TEXT NOT NULL DEFAULT '',
    src         TEXT NOT NULL DEFAULT '',
    layout      TEXT NOT NULL DEFAULT '',
    label       TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    meta        TEXT NOT NULL DEFAULT '{{}}',
    n_samples   INTEGER NOT NULL DEFAULT 0,
    n_events    INTEGER NOT NULL DEFAULT 0,
    summary     TEXT,
    summary_at  REAL
);
CREATE TABLE IF NOT EXISTS samples (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    {", ".join(c + (" INTEGER" if c in _INT_COLS else " TEXT" if c in _TEXT_COLS else " REAL") for c in SAMPLE_COLS)}
);
CREATE INDEX IF NOT EXISTS samples_session_t ON samples(session_id, t);
CREATE TABLE IF NOT EXISTS events (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    t          INTEGER NOT NULL,
    category   TEXT NOT NULL,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{{}}'
);
CREATE INDEX IF NOT EXISTS events_session_t ON events(session_id, t);
"""


def default_db_path(project_root: str) -> str:
    """logs/molefield.db beside the project (or beside the .exe when frozen)."""
    import sys
    base = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else project_root
    return os.path.join(base, "logs", "molefield.db")


def _num(v: Any, integer: bool) -> int | float | None:
    """Coerce a JSON value to a finite number or None. Never raises."""
    if v is None or isinstance(v, bool):
        return int(v) if isinstance(v, bool) else None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return int(round(f)) if integer else f


def _text(v: Any, limit: int = 64) -> str | None:
    return None if v is None else str(v)[:limit]


class TelemetryStore:
    """Thread-safe wrapper around one SQLite connection."""

    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(_SCHEMA)
            self._migrate()
            self._db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    def _migrate(self) -> None:
        """Bring an older database up to date in place. Existing rows are kept;
        columns added later are simply NULL for sessions recorded before them."""
        have = {r[1] for r in self._db.execute("PRAGMA table_info(samples)")}
        for c in SAMPLE_COLS:
            if c not in have:
                kind = "INTEGER" if c in _INT_COLS else "TEXT" if c in _TEXT_COLS else "REAL"
                self._db.execute(f"ALTER TABLE samples ADD COLUMN {c} {kind}")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ── writes ────────────────────────────────────────────────────────────
    def create_session(self, page: str, src: str, layout: str, meta: dict) -> int:
        now = time.time()
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO sessions (started_at, last_seen, page, src, layout, meta) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (now, now, _text(page, 32) or "", _text(src, 16) or "",
                 _text(layout, 32) or "", json.dumps(meta)[:200_000]),
            )
            return int(cur.lastrowid)

    def add_batch(self, session_id: int, samples: Iterable[dict], events: Iterable[dict]) -> tuple[int, int]:
        srows = []
        for s in samples:
            if not isinstance(s, dict):
                continue
            row = [session_id]
            for c in SAMPLE_COLS:
                v = s.get(c)
                row.append(_text(v) if c in _TEXT_COLS else _num(v, c in _INT_COLS))
            if row[1] is None:  # t is mandatory
                continue
            srows.append(row)

        erows = []
        for e in events:
            if not isinstance(e, dict):
                continue
            t = _num(e.get("t"), True)
            typ = _text(e.get("type"), 48)
            cat = _text(e.get("category"), 16)
            if t is None or not typ or cat not in EVENT_CATEGORIES:
                continue
            data = e.get("data") if isinstance(e.get("data"), dict) else {}
            erows.append((session_id, t, cat, typ, json.dumps(data)[:20_000]))

        ph = ", ".join("?" for _ in range(len(SAMPLE_COLS) + 1))
        with self._lock:
            if not self._exists(session_id):
                raise KeyError(session_id)
            self._db.execute("BEGIN")
            try:
                if srows:
                    self._db.executemany(
                        f"INSERT INTO samples (session_id, {', '.join(SAMPLE_COLS)}) VALUES ({ph})", srows)
                if erows:
                    self._db.executemany(
                        "INSERT INTO events (session_id, t, category, type, data) VALUES (?, ?, ?, ?, ?)", erows)
                self._db.execute(
                    "UPDATE sessions SET n_samples = n_samples + ?, n_events = n_events + ?, "
                    "last_seen = ?, ended_at = NULL WHERE id = ?",
                    (len(srows), len(erows), time.time(), session_id))
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
        return len(srows), len(erows)

    def end_session(self, session_id: int, summary: dict | None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE sessions SET ended_at = COALESCE(ended_at, last_seen), summary = ?, summary_at = ? "
                "WHERE id = ?", (json.dumps(summary) if summary is not None else None, time.time(), session_id))

    def cache_summary(self, session_id: int, summary: dict) -> None:
        with self._lock:
            self._db.execute("UPDATE sessions SET summary = ?, summary_at = ? WHERE id = ?",
                             (json.dumps(summary), time.time(), session_id))

    def set_meta(self, session_id: int, label: str | None, notes: str | None) -> None:
        with self._lock:
            if label is not None:
                self._db.execute("UPDATE sessions SET label = ? WHERE id = ?", (label[:120], session_id))
            if notes is not None:
                self._db.execute("UPDATE sessions SET notes = ? WHERE id = ?", (notes[:5000], session_id))

    def delete_session(self, session_id: int) -> bool:
        with self._lock:
            cur = self._db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            return cur.rowcount > 0

    def stale_open_sessions(self, idle_s: float) -> list[int]:
        with self._lock:
            rows = self._db.execute(
                "SELECT id FROM sessions WHERE ended_at IS NULL AND last_seen < ?",
                (time.time() - idle_s,)).fetchall()
        return [int(r["id"]) for r in rows]

    # ── reads ─────────────────────────────────────────────────────────────
    def _exists(self, session_id: int) -> bool:
        return self._db.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone() is not None

    def session(self, session_id: int) -> dict | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return _session_dict(r) if r else None

    def list_sessions(self, limit: int = 200, offset: int = 0) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ? OFFSET ?",
                (max(1, min(limit, 1000)), max(0, offset))).fetchall()
        return [_session_dict(r) for r in rows]

    def count_sessions(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0])

    def samples(self, session_id: int, cols: list[str] | None = None) -> list[tuple]:
        cols = [c for c in (cols or SAMPLE_COLS) if c in SAMPLE_COLS]
        with self._lock:
            return [tuple(r) for r in self._db.execute(
                f"SELECT {', '.join(cols)} FROM samples WHERE session_id = ? ORDER BY t", (session_id,))]

    def events(self, session_id: int) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT t, category, type, data FROM events WHERE session_id = ? ORDER BY t", (session_id,)).fetchall()
        out = []
        for r in rows:
            try:
                data = json.loads(r["data"])
            except ValueError:
                data = {}
            out.append({"t": r["t"], "category": r["category"], "type": r["type"], "data": data})
        return out

    # ── exports ───────────────────────────────────────────────────────────
    def samples_csv(self, session_id: int) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(SAMPLE_COLS)
        for row in self.samples(session_id):
            w.writerow(["" if v is None else v for v in row])
        return buf.getvalue()

    def events_csv(self, session_id: int) -> str:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["t_ms", "category", "type", "data_json"])
        for e in self.events(session_id):
            w.writerow([e["t"], e["category"], e["type"], json.dumps(e["data"])])
        return buf.getvalue()


def _session_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    for k in ("meta", "summary"):
        try:
            d[k] = json.loads(d[k]) if d[k] else None
        except ValueError:
            d[k] = None
    return d
