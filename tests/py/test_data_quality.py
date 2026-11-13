"""Phase 7: data quality of what the tracker records (the planner's activity input).

Invariants every recorded day must satisfy, checked on seeded random sessions and on clock edge cases:
  schema   - every segment has int "s" and "e", a non-empty "app"; "domain"/"title" are optional strings
  values   - no negative durations; "s" falls inside its day key
  order    - segments within a day are sorted and never overlap (time is never counted twice)
"""

import datetime
import random

import pytest

from test_tracker_integration import run_loop, scripted

APPS = [
    ("Code", "", ""),
    ("Google Chrome", "github.com", "Pull requests"),
    ("Safari", "youtube.com", "Video"),
    ("Slack", "", ""),
    ("Notes", "", ""),
]


def day_start_ms(k):
    d = datetime.datetime.strptime(k, "%Y-%m-%d")
    return int(d.timestamp() * 1000)


def problems(days, interval_ms):
    out = []
    for k, segs in days.items():
        lo, hi = day_start_ms(k), day_start_ms(k) + 86_400_000
        prev_e = None
        for i, s in enumerate(segs):
            where = f"{k}[{i}]"
            if not (isinstance(s.get("s"), int) and isinstance(s.get("e"), int)):
                out.append(f"{where}: s/e not ints")
                continue
            if not isinstance(s.get("app"), str) or not s["app"]:
                out.append(f"{where}: missing app")
            for opt in ("domain", "title"):
                if opt in s and not isinstance(s[opt], str):
                    out.append(f"{where}: {opt} not a string")
            if s["e"] < s["s"]:
                out.append(f"{where}: negative duration {s['e'] - s['s']} ms")
            if not lo <= s["s"] < hi:
                out.append(f"{where}: starts outside its day")
            if s["e"] > hi + 3 * interval_ms:  # a segment may run a few ticks past midnight before it is split
                out.append(f"{where}: ends {s['e'] - hi} ms after its day")
            if prev_e is not None and s["s"] < prev_e:
                out.append(f"{where}: overlaps the previous segment by {prev_e - s['s']} ms")
            prev_e = max(prev_e or 0, s["e"])
    return out


def random_frames(rng, n):
    frames, app = [], rng.choice(APPS)
    idle = 0
    for _ in range(n):
        r = rng.random()
        if r < 0.15:
            app = rng.choice(APPS)
        if r > 0.97:  # walk away: idle grows past the 180 s limit, then input resumes
            for j in range(1, 45):
                frames.append((j * 5, *app))
            idle = 0
            continue
        frames.append((idle, *app))
    return frames


@pytest.mark.parametrize("seed", range(60))
def test_random_sessions_produce_clean_data(kt, monkeypatch, fake_time, seed):
    rng = random.Random(20261110 + seed)  # noqa: S311 -- seeded test data, not security
    frames = random_frames(rng, rng.randint(40, 160))
    scripted(kt, monkeypatch, frames)
    # half the sessions start just before midnight so they cross into the next day
    base = datetime.datetime(2026, 11, 10, 23, 55) if seed % 2 else datetime.datetime(2026, 11, 10, 14, 0)
    run_loop(kt, monkeypatch, fake_time, frames, start=base.timestamp())
    days = kt.snapshot(kt.STATE["data"])["days"]
    assert problems(days, kt.INTERVAL * 1000) == []
    assert sum(len(v) for v in days.values()) > 0


class JumpingTime:
    """A clock that jumps back `back_s` seconds after `at` ticks, like a manual clock change or a large time sync."""

    def __init__(self, start, ticks, at, back_s, real):
        self.now, self.ticks, self.sleeps, self.at, self.back = start, ticks, 0, at, back_s
        self.altzone, self.timezone, self.localtime = real.altzone, real.timezone, real.localtime

    def time(self):
        return self.now

    def sleep(self, s):
        self.sleeps += 1
        if self.sleeps >= self.ticks:
            raise StopIteration
        self.now += s - (self.back if self.sleeps == self.at else 0)


@pytest.mark.parametrize("back_s", [20, 600, 3600])
def test_clock_jumping_back_never_creates_negative_or_overlapping_time(kt, monkeypatch, back_s):
    import time as real_time

    frames = [(0, "Code", "", "")] * 30 + [(0, "Slack", "", "")] * 30
    scripted(kt, monkeypatch, frames)
    clock = JumpingTime(datetime.datetime(2026, 11, 10, 14, 0).timestamp(), len(frames), at=40, back_s=back_s, real=real_time)
    monkeypatch.setattr(kt, "time", clock)
    with pytest.raises(StopIteration):
        kt.track()
    days = kt.snapshot(kt.STATE["data"])["days"]
    assert problems(days, kt.INTERVAL * 1000) == []


def test_snapshot_schema_matches_the_api_contract(kt, monkeypatch, fake_time):
    frames = [(0, "Google Chrome", "github.com", "PRs")] * 5 + [(0, "Code", "", "")] * 5
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    snap = kt.snapshot(kt.STATE["data"])
    assert set(snap) >= {"source", "version", "device", "updatedAt", "days"}
    for segs in snap["days"].values():
        for s in segs:
            assert set(s) <= {"s", "e", "app", "domain", "title"}
            assert s["e"] - s["s"] >= 1000  # sub-second blips are dropped from snapshots
