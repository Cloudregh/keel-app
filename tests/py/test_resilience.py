"""Phase 13: resilience of the tracker when the things it depends on fail, and recovery when they come back.

Dependencies: the disk (activity file, config), the macOS helpers (ioreg, lsappinfo, osascript), and the tracker's
own code paths (an unexpected error while sampling or while answering an API request). For each one the tracker
must not hang, must keep going or fall back, must say what happened in its log (stderr → ~/Keel Activity/tracker.log
under launchd), and must recover once the dependency works again. macOS tools are faked; nothing real is called.
"""

import glob
import json
import os
import subprocess
import time

import pytest
from test_tracker_integration import run_loop, scripted

GOOD = "https://cloudregh.github.io"


def frames_of(app, n):
    return [(0, app, "", "")] * n


# ---------- disk ----------


def test_disk_full_then_space_returns_everything_is_saved(kt, monkeypatch, fake_time, capsys):
    real_save, calls = kt.save, []

    def flaky(data):
        calls.append(1)
        if len(calls) <= 2:
            raise OSError(28, "No space left on device")
        return real_save(data)

    frames = frames_of("Code", 12)
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    monkeypatch.setattr(kt, "save", flaky)
    monkeypatch.setattr(kt, "SAVE_EVERY", 10)
    run_loop(kt, monkeypatch, fake_time, frames)
    err = capsys.readouterr().err
    assert err.count("Couldn't write activity file") == 2  # said so each time it failed
    assert len(calls) >= 3  # kept trying on schedule, no tight retry loop
    on_disk = json.load(open(kt.OUT_FILE))
    segs = [s for d in on_disk["days"].values() for s in d]
    assert [s["app"] for s in segs] == ["Code"]  # what was recorded while the disk was full is on disk now
    assert segs[0]["e"] - segs[0]["s"] >= 40_000


def test_config_unwritable_then_writable_pause_is_kept(kt, monkeypatch):
    real = kt.save_config

    def deny(cfg):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(kt, "save_config", deny)
    kt.set_pause(None)
    kt.set_pause(int(time.time() * 1000) + 3_600_000)
    assert kt.is_paused(int(time.time() * 1000))  # works in memory while the disk refuses
    monkeypatch.setattr(kt, "save_config", real)
    kt.set_pause(int(time.time() * 1000) + 3_600_000)
    assert kt.load_config()["paused_until"] is not None  # and is persisted once it can be


def test_corrupt_activity_file_is_kept_aside_not_overwritten(kt, monkeypatch, fake_time, capsys):
    """A damaged activity file (here: cut off half-way, as after a crash during a copy) used to be read as empty and
    then overwritten by the next save 30 s later, losing all history with nothing in the log."""
    good = {"days": {"2026-11-01": [{"s": 1, "e": 3_600_000, "app": "Figma"}]}}
    text = json.dumps(good)
    with open(kt.OUT_FILE, "w") as f:
        f.write(text[: len(text) // 2])
    frames = frames_of("Code", 3)
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    run_loop(kt, monkeypatch, fake_time, frames)
    kept = glob.glob(os.path.join(kt.OUT_DIR, "keel-activity.corrupt-*.json"))
    assert kept, "the damaged file was overwritten and not kept anywhere"
    assert open(kept[0]).read() == text[: len(text) // 2]
    assert "activity file" in capsys.readouterr().err.lower()
    assert json.load(open(kt.OUT_FILE))["days"]  # tracking carried on in a fresh file
    kt.cleanup()
    assert os.path.exists(kept[0])  # cleanup never removes the kept copy


# ---------- macOS helpers ----------


def test_idle_and_front_app_lookups_failing_then_returning(kt, monkeypatch, fake_time):
    """ioreg / lsappinfo failing (or timing out after 3 s in `run`) give 0 idle and no app: nothing is recorded,
    the loop keeps going, and recording starts again when they answer."""
    frames = [(0, "", "", "")] * 4 + frames_of("Code", 4)
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    run_loop(kt, monkeypatch, fake_time, frames)
    segs = [s for d in kt.STATE["data"]["days"].values() for s in d]
    assert [s["app"] for s in segs] == ["Code"]


def test_run_times_out_instead_of_hanging(kt, monkeypatch):
    seen = {}

    def hang(cmd, **k):
        seen["timeout"] = k.get("timeout")
        raise subprocess.TimeoutExpired(cmd, k.get("timeout"))

    monkeypatch.setattr(kt.subprocess, "run", hang)
    t0 = time.perf_counter()
    assert kt.run(["lsappinfo", "front"]) == ""
    assert seen["timeout"] == 3 and time.perf_counter() - t0 < 1


def test_browser_automation_denied_then_allowed_reads_the_tab_again(kt, monkeypatch):
    allowed = {"v": False}

    def osa(cmd, **k):
        if not allowed["v"]:
            return subprocess.CompletedProcess(cmd, 1, "", "Not authorized to send Apple events to Safari.")
        return subprocess.CompletedProcess(cmd, 0, "https://www.example.com/a\nExample\n", "")

    monkeypatch.setattr(kt.subprocess, "run", osa)
    assert kt.browser_tab("Safari") == ("", "")  # denied: app is still recorded, without the site
    allowed["v"] = True  # the user grants Automation access
    assert kt.browser_tab("Safari") == ("", "")  # backing off: no prompt storm
    kt._browser_fail["Safari"] -= 601  # 10 minutes later
    assert kt.browser_tab("Safari") == ("example.com", "Example")


def test_unexpected_error_while_sampling_does_not_stop_tracking(kt, monkeypatch, fake_time, capsys):
    """One odd answer from a helper (any exception the parsers didn't foresee) must not end tracking."""
    frames = frames_of("Code", 8)
    scripted(kt, monkeypatch, frames)
    ticks = {"n": 0}

    def front():
        ticks["n"] += 1
        if ticks["n"] == 2:
            raise ValueError("unexpected lsappinfo output")
        return "Code"

    monkeypatch.setattr(kt, "front_app", front)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert ticks["n"] >= 6, f"tracking stopped after tick {ticks['n']}"
    err = capsys.readouterr().err
    assert "Skipped one activity sample: ValueError" in err  # logged, with the error type and code location
    assert "unexpected lsappinfo output" not in err  # but not the message, which can hold the data being parsed
    segs = [s for d in kt.STATE["data"]["days"].values() for s in d]
    assert [s["app"] for s in segs] == ["Code"]  # tracking carried on


# ---------- the local API ----------


def test_api_error_answers_500_json_and_keeps_serving(server, kt, monkeypatch, capsys):
    real, n = kt.snapshot, {"v": 0}

    def once(*a, **k):
        n["v"] += 1
        if n["v"] == 1:
            raise RuntimeError("boom")
        return real(*a, **k)

    monkeypatch.setattr(kt, "snapshot", once)
    try:
        st, _, body = server.request("GET", "/activity", origin=GOOD)
    except Exception as e:  # connection dropped without an answer
        st, body = None, repr(e)
    assert st == 500, f"no JSON error answer: {body}"
    assert "error" in body
    st, _, body = server.request("GET", "/activity", origin=GOOD)
    assert st == 200 and body["source"] == "keel-tracker"
    st, _, _ = server.request("GET", "/status", origin=GOOD)
    assert st == 200
    err = capsys.readouterr().err
    assert "API error on GET /activity: RuntimeError" in err and "boom" not in err  # logged without the message


@pytest.mark.parametrize("path", ["/status", "/activity"])
def test_api_answers_while_the_disk_is_failing(server, kt, monkeypatch, path):
    monkeypatch.setattr(kt, "save", lambda d: (_ for _ in ()).throw(OSError(28, "No space left on device")))
    st, _, _ = server.request("GET", path, origin=GOOD)
    assert st == 200
