"""
Sensor Hub: merges per-box datagrams into one sensor frame.

Upstream contract (see README, "Inbound Range Datagrams"):
  * Each box sends whenever it likes. There is no required rate, and two
    boxes need not match each other. The hub keeps every sensor's LAST value
    until that sensor sends a new one, so the game always computes with the
    most recent reading each sensor actually gave.
  * A box sends either ONE value (a reading normalised on the box, treated as
    one 50 deg sensor) or TWO values (two 25 deg sensors). The hub detects
    which from the packets themselves and reports the matching layout.

Every sensor carries an update counter (`seq`) and the time of its last
update, so consumers can tell a genuinely new reading from a held one - which
matters for filtering: see MedianRing in sectors.js.
"""

from __future__ import annotations

import threading
import time

from bridge.config import VALUES_PER_BOX_LAYOUT

N_BOXES = 2
MODE_HYSTERESIS = 3      # agreeing packets (across boxes) needed to change 1 <-> 2 values
MODE_WINDOW_S = 10.0     # a box counts toward detection if heard this recently


class SensorHub:
    """Thread-safe merge of per-box datagrams with value-count detection."""

    def __init__(self, stale_ms: int = 0, alive_s: float = 10.0,
                 initial_values_per_box: int = 2):
        self.stale = stale_ms / 1000.0          # 0 -> hold forever
        self.alive_s = alive_s
        self.lock = threading.Lock()
        self.changed = threading.Event()        # set on every accepted packet
        self.frames = 0
        self.bad = 0
        self.one_based: bool | None = None      # inferred box numbering

        self.values_per_box = initial_values_per_box
        self.detected = False                   # True once real packets decided it
        self.mixed = False                      # boxes currently disagree
        self.switches = 0

        # per box: latest values, when, how many values it sends, streak toward a switch
        self.box_vals: dict[int, list[float | None]] = {}
        self.box_t: dict[int, float] = {}
        self.box_count: dict[int, int] = {}
        self.box_streak: dict[int, int] = {}
        self.boxes: dict[int, dict] = {}        # health bookkeeping

        # per sensor (flat index), rebuilt on a mode switch
        self._reset_sensors()

    # ── helpers ──────────────────────────────────────────────────────────
    @property
    def layout(self) -> str:
        return VALUES_PER_BOX_LAYOUT[self.values_per_box]

    @property
    def n_sensors(self) -> int:
        return N_BOXES * self.values_per_box

    def _reset_sensors(self) -> None:
        n = N_BOXES * self.values_per_box
        self.ranges: list[float | None] = [None] * n
        self.seq: list[int] = [0] * n
        self.stamp: list[float] = [0.0] * n

    def normalise_box(self, box: int, one_based: bool | None = None) -> int | None:
        """
        Map a box id onto 0 (left) / 1 (right).
        JSON firmware uses BOX_ID 0/1. The plain-text format ("Box:1") is 1-based.
        A JSON sender that ever reports box 2 without box 0 is taken as 1-based.
        """
        if one_based is None:
            if box == 0:
                self.one_based = False
            elif box == 2 and self.one_based is None:
                self.one_based = True
            one_based = bool(self.one_based)
        idx = box - 1 if one_based else box
        return idx if 0 <= idx < N_BOXES else None

    # ── ingest ───────────────────────────────────────────────────────────
    def ingest(self, box: int, ranges_mm: list, sender: str = "", one_based: bool | None = None) -> bool:
        """
        Record one packet: `ranges_mm` holds 1 or 2 readings in millimetres
        (None / <= 0 = no echo). Returns False if the packet was rejected.
        """
        now = time.monotonic()
        with self.lock:
            b = self.normalise_box(int(box), one_based)
            if b is None or not isinstance(ranges_mm, list) or len(ranges_mm) not in (1, 2):
                self.bad += 1
                return False
            vals: list[float | None] = []
            for mm in ranges_mm:
                try:
                    f = None if mm is None else float(mm)
                except (TypeError, ValueError):
                    self.bad += 1
                    return False
                vals.append(None if f is None or f != f or f <= 0 else f / 1000.0)

            count = len(vals)
            self.box_streak[b] = self.box_streak.get(b, 0) + 1 if self.box_count.get(b) == count else 1
            self.box_count[b] = count
            self.box_vals[b] = vals
            self.box_t[b] = now
            switched = self._detect(now)

            # Only a packet whose value count matches the current mode updates
            # sensors. A packet that just caused a switch was already applied.
            if count == self.values_per_box and not switched:
                for k, v in enumerate(vals):
                    i = b * self.values_per_box + k
                    self.ranges[i] = v
                    self.seq[i] += 1
                    self.stamp[i] = now

            h = self.boxes.setdefault(b, dict(count=0, last=0.0, hz=0.0, _t0=now, _c0=0,
                                             addr=sender, values=count))
            h["count"] += 1
            h["last"] = now
            h["values"] = count
            h["addr"] = sender or h["addr"]
            if now - h["_t0"] >= 1.0:
                h["hz"] = (h["count"] - h["_c0"]) / (now - h["_t0"])
                h["_t0"], h["_c0"] = now, h["count"]
            self.frames += 1
        self.changed.set()
        return True

    def _detect(self, now: float) -> bool:
        """Decide 1 vs 2 values per box from recently heard boxes (lock held).
        Returns True if the layout switched (the latest packets are then applied)."""
        recent = [b for b, t in self.box_t.items() if now - t <= MODE_WINDOW_S]
        counts = {self.box_count[b] for b in recent}
        self.mixed = len(counts) > 1
        if len(counts) != 1:
            return False
        want = counts.pop()
        if want == self.values_per_box:
            self.detected = True
            return False
        # Every recently heard box's latest packet agrees on the new count (checked
        # above), and together they have sent it several times in a row - so one
        # malformed packet can never flip the layout, but a box that upstreams
        # rarely doesn't hold the switch hostage either.
        if sum(self.box_streak.get(b, 0) for b in recent) >= MODE_HYSTERESIS or not self.detected:
            self.values_per_box = want
            self.detected = True
            self.switches += 1
            self._reset_sensors()
            for b in recent:
                vals = self.box_vals[b]
                for k, v in enumerate(vals):
                    i = b * want + k
                    self.ranges[i] = v
                    self.seq[i] = 1
                    self.stamp[i] = self.box_t[b]
            return True
        return False

    # ── read ─────────────────────────────────────────────────────────────
    def snapshot(self) -> dict:
        """Current frame: layout, held ranges (m), per-sensor update counters and ages."""
        now = time.monotonic()
        with self.lock:
            ranges = list(self.ranges)
            if self.stale > 0:
                ranges = [r if (r is not None and now - t <= self.stale) else None
                          for r, t in zip(ranges, self.stamp)]
            return {
                "layout": self.layout,
                "values_per_box": self.values_per_box,
                "detected": self.detected,
                "mixed": self.mixed,
                "ranges": ranges,
                "seq": list(self.seq),
                "age_ms": [None if t == 0 else round((now - t) * 1000.0) for t in self.stamp],
            }

    def live_boxes(self) -> list[tuple[int, dict]]:
        now = time.monotonic()
        with self.lock:
            return sorted((b, dict(v, alive=(now - v["last"]) < self.alive_s))
                          for b, v in self.boxes.items())

    def health(self) -> list[dict]:
        """Per-box health for the setup wizard and telemetry."""
        now = time.monotonic()
        return [
            {"box": b, "alive": v["alive"], "hz": round(v["hz"], 1), "addr": v["addr"],
             "values": v["values"], "age_ms": round((now - v["last"]) * 1000.0)}
            for b, v in self.live_boxes()
        ]
