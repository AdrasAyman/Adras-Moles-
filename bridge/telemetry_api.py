"""
Telemetry HTTP API, served under /api/ by the same local HTTP server that
serves the game. Bound to 127.0.0.1 only (see molefield.py).

  POST   /api/sessions                    start a session         -> {id}
  POST   /api/sessions/<id>/batch         append samples + events
  POST   /api/sessions/<id>/end           final batch, then summarise
  POST   /api/sessions/<id>/meta          set label / notes
  DELETE /api/sessions/<id>               delete a session and its rows
  GET    /api/sessions                    history list (with headline metrics)
  GET    /api/sessions/<id>               session + full summary
  GET    /api/sessions/<id>/series        bucketed time series for charts
  GET    /api/sessions/<id>/events        every event
  GET    /api/sessions/<id>/samples.csv   raw samples export
  GET    /api/sessions/<id>/events.csv    events export
  GET    /api/sessions/<id>/summary.json  summary export
  GET    /api/trends                      one headline row per session
  GET    /api/status                      store health
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from bridge.analysis import series, summarize, trend_row
from bridge.telemetry_db import TelemetryStore

MAX_BODY = 4 * 1024 * 1024
MAX_ROWS_PER_BATCH = 5000
IDLE_END_S = 120.0

_SESSION = re.compile(r"^/api/sessions/(\d+)(?:/([a-z]+(?:\.(?:csv|json))?))?/?$")


def _send(h: BaseHTTPRequestHandler, code: int, body: bytes, ctype: str, filename: str | None = None) -> None:
    h.send_response(code)
    h.send_header("Content-Type", ctype)
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-store")
    if filename:
        h.send_header("Content-Disposition", f'attachment; filename="{filename}"')
    h.end_headers()
    if h.command != "HEAD":
        h.wfile.write(body)


def _json(h: BaseHTTPRequestHandler, code: int, obj) -> None:
    _send(h, code, json.dumps(obj, allow_nan=False, default=_nan_safe).encode(), "application/json")


def _nan_safe(o):
    return None


def _clean(obj):
    """Replace NaN/inf (not valid JSON) with None, recursively."""
    if isinstance(obj, float):
        return obj if obj == obj and obj not in (float("inf"), float("-inf")) else None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def _body(h: BaseHTTPRequestHandler) -> dict:
    n = int(h.headers.get("Content-Length") or 0)
    if n <= 0:
        return {}
    if n > MAX_BODY:
        raise ValueError("body too large")
    data = json.loads(h.rfile.read(n).decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("body must be a JSON object")
    return data


class TelemetryAPI:
    def __init__(self, store: TelemetryStore):
        self.store = store
        self._summary_lock = threading.Lock()

    # ── summaries (cached once a session has ended) ─────────────────────────
    def summary_for(self, sess: dict) -> dict | None:
        fresh = (sess.get("summary") is not None and sess.get("ended_at") is not None
                 and (sess.get("summary_at") or 0) >= (sess.get("last_seen") or 0)
                 and (sess["summary"] or {}).get("version") is not None)
        if fresh:
            return sess["summary"]
        with self._summary_lock:
            s = _clean(summarize(self.store, sess["id"]))
            if s is not None and sess.get("ended_at") is not None:
                self.store.cache_summary(sess["id"], s)
            return s

    def end(self, session_id: int) -> None:
        sess = self.store.session(session_id)
        if sess is None:
            return
        if sess["n_samples"] == 0:
            # A page opened and closed before a single measurement: not a session
            # anyone wants in their history.
            self.store.delete_session(session_id)
            return
        with self._summary_lock:
            self.store.end_session(session_id, _clean(summarize(self.store, session_id)))

    def reap_forever(self, stop: threading.Event, period_s: float = 30.0) -> None:
        """Close sessions whose page vanished without saying goodbye."""
        while not stop.wait(period_s):
            try:
                for sid in self.store.stale_open_sessions(IDLE_END_S):
                    self.end(sid)
            except Exception:
                pass

    # ── routing ────────────────────────────────────────────────────────────
    def handle(self, h: BaseHTTPRequestHandler) -> bool:
        """Serve the request if it is an /api/ route. Returns False otherwise."""
        url = urlparse(h.path)
        if not url.path.startswith("/api/"):
            return False
        try:
            self._route(h, h.command, url.path, parse_qs(url.query))
        except KeyError:
            _json(h, 404, {"error": "no such session"})
        except (ValueError, json.JSONDecodeError) as e:
            _json(h, 400, {"error": str(e)[:200]})
        except Exception as e:  # never take the game server down
            _json(h, 500, {"error": type(e).__name__})
        return True

    def _route(self, h, method: str, path: str, q: dict) -> None:
        st = self.store
        if path == "/api/status" and method in ("GET", "HEAD"):
            return _json(h, 200, {"ok": True, "db": st.path, "sessions": st.count_sessions()})

        if path in ("/api/sessions", "/api/sessions/"):
            if method == "POST":
                b = _body(h)
                meta = b.get("meta") if isinstance(b.get("meta"), dict) else {}
                meta["server_time"] = time.time()
                sid = st.create_session(str(b.get("page") or ""), str(b.get("src") or ""),
                                        str(b.get("layout") or ""), meta)
                return _json(h, 201, {"id": sid})
            if method in ("GET", "HEAD"):
                limit = int((q.get("limit") or ["200"])[0])
                offset = int((q.get("offset") or ["0"])[0])
                rows = []
                for s in st.list_sessions(limit, offset):
                    s["summary"] = self.summary_for(s)
                    rows.append({**trend_row(s), "ended_at": s["ended_at"], "notes": s["notes"],
                                 "n_events": s["n_events"], "open": s["ended_at"] is None})
                return _json(h, 200, _clean({"sessions": rows, "total": st.count_sessions()}))

        if path == "/api/trends" and method in ("GET", "HEAD"):
            rows = []
            for s in reversed(st.list_sessions(1000, 0)):
                s["summary"] = self.summary_for(s)
                rows.append(trend_row(s))
            return _json(h, 200, _clean({"trends": rows}))

        m = _SESSION.match(path)
        if not m:
            return _json(h, 404, {"error": "unknown endpoint"})
        sid, sub = int(m.group(1)), m.group(2)

        if method == "DELETE" and sub is None:
            if not st.delete_session(sid):
                raise KeyError(sid)
            return _json(h, 200, {"ok": True})

        if method == "POST":
            b = _body(h)
            if sub in ("batch", "end"):
                samples = b.get("samples") if isinstance(b.get("samples"), list) else []
                events = b.get("events") if isinstance(b.get("events"), list) else []
                if len(samples) + len(events) > MAX_ROWS_PER_BATCH:
                    raise ValueError("batch too large")
                ns, ne = st.add_batch(sid, samples, events)
                if sub == "end":
                    self.end(sid)
                return _json(h, 200, {"ok": True, "samples": ns, "events": ne})
            if sub == "meta":
                if st.session(sid) is None:
                    raise KeyError(sid)
                label = b.get("label") if isinstance(b.get("label"), str) else None
                notes = b.get("notes") if isinstance(b.get("notes"), str) else None
                st.set_meta(sid, label, notes)
                return _json(h, 200, {"ok": True})
            return _json(h, 404, {"error": "unknown endpoint"})

        if method not in ("GET", "HEAD"):
            return _json(h, 405, {"error": "method not allowed"})

        sess = st.session(sid)
        if sess is None:
            raise KeyError(sid)
        if sub is None:
            sess["summary"] = self.summary_for(sess)
            sess["open"] = sess["ended_at"] is None
            return _json(h, 200, _clean(sess))
        if sub == "series":
            return _json(h, 200, _clean(series(st, sid, int((q.get("buckets") or ["600"])[0]))))
        if sub == "events":
            return _json(h, 200, _clean({"events": st.events(sid)}))
        stamp = time.strftime("%Y%m%d-%H%M", time.localtime(sess["started_at"]))
        base = f"molefield_session{sid}_{stamp}"
        if sub == "samples.csv":
            return _send(h, 200, st.samples_csv(sid).encode(), "text/csv; charset=utf-8", base + "_samples.csv")
        if sub == "events.csv":
            return _send(h, 200, st.events_csv(sid).encode(), "text/csv; charset=utf-8", base + "_events.csv")
        if sub == "summary.json":
            sess["summary"] = self.summary_for(sess)
            body = json.dumps(_clean(sess), indent=2).encode()
            return _send(h, 200, body, "application/json", base + "_summary.json")
        return _json(h, 404, {"error": "unknown endpoint"})
