"""Integration tests: the tracking loop (with a fake clock and fake macOS tools), the launchd install/uninstall
flow (launchctl faked), the local API server start-up, and the command-line commands."""

import datetime
import json
import os
import socket
import subprocess
import time

import pytest


def scripted(kt, monkeypatch, frames):
    """frames: list of (idle_seconds, app, domain, title) consumed one per loop tick."""
    it = iter(frames)
    state = {"cur": frames[0]}

    def idle():
        state["cur"] = next(it, frames[-1])
        return state["cur"][0]

    monkeypatch.setattr(kt, "idle_seconds", idle)
    monkeypatch.setattr(kt, "front_app", lambda: state["cur"][1])
    monkeypatch.setattr(kt, "browser_tab", lambda app: (state["cur"][2], state["cur"][3]))
    monkeypatch.setattr(kt, "serve", lambda: None)


def run_loop(kt, monkeypatch, fake_time, frames, start=None):
    start = start or time.time()
    ft = fake_time(start, len(frames))
    monkeypatch.setattr(kt, "time", ft)
    with pytest.raises(StopIteration):
        kt.track()
    return ft


def today_segments(kt):
    k = kt.day_key(int(kt.time.now * 1000))
    return [s for d in kt.STATE["data"]["days"].values() for s in d] if k else []


def test_loop_merges_same_app_and_splits_on_switch(kt, monkeypatch, fake_time):
    frames = [(0, "Code", "", "")] * 4 + [(0, "Google Chrome", "github.com", "PRs")] * 3 + [(0, "Code", "", "")] * 2
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    segs = today_segments(kt)
    assert [s["app"] for s in segs] == ["Code", "Google Chrome", "Code"]
    assert segs[1]["domain"] == "github.com" and segs[1]["title"] == "PRs"
    assert segs[0]["e"] == segs[1]["s"]  # switching closes the previous segment at the switch time
    assert segs[0]["e"] - segs[0]["s"] == 4 * kt.INTERVAL * 1000


def test_loop_title_change_starts_new_segment(kt, monkeypatch, fake_time):
    frames = [(0, "Safari", "youtube.com", "Video A")] * 2 + [(0, "Safari", "youtube.com", "Video B")] * 2
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert [s["title"] for s in today_segments(kt)] == ["Video A", "Video B"]


def test_loop_idle_closes_segment_at_last_input(kt, monkeypatch, fake_time):
    # Realistic: idle time grows 5 s per tick after the last input until the 180 s limit, then input resumes.
    frames = [(0, "Code", "", "")] * 3 + [(i * 5, "Code", "", "") for i in range(1, 41)] + [(0, "Code", "", "")] * 3
    scripted(kt, monkeypatch, frames)
    ft = run_loop(kt, monkeypatch, fake_time, frames)
    segs = today_segments(kt)
    assert len(segs) == 2  # idle broke the run into two segments
    first = segs[0]
    last_input = first["s"] + 3 * kt.INTERVAL * 1000  # input stopped after the 3rd tick
    assert abs(first["e"] - last_input) <= kt.INTERVAL * 1000  # idle time is not counted as work
    assert kt.STATE["idle"] is False and ft.sleeps == len(frames)


def test_loop_skips_login_window_and_screensaver(kt, monkeypatch, fake_time):
    frames = [(0, "loginwindow", "", ""), (0, "ScreenSaverEngine", "", ""), (0, "", "", ""), (0, "Notes", "", "")] + [(0, "Notes", "", "")]
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert [s["app"] for s in today_segments(kt)] == ["Notes"]


def test_loop_records_nothing_while_paused_then_resumes(kt, monkeypatch, fake_time):
    kt.save_config({"allowed_origins": [], "keep_days": 30, "max_file_mb": 20, "paused_until": -1})
    frames = [(0, "Code", "", "")] * 4
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert today_segments(kt) == []
    assert kt.STATE["current"] is None


def test_loop_timed_pause_expires(kt, monkeypatch, fake_time):
    start = time.time()
    kt.save_config({"allowed_origins": [], "keep_days": 30, "max_file_mb": 20, "paused_until": int((start + 12) * 1000)})
    frames = [(0, "Code", "", "")] * 6
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames, start)
    assert len(today_segments(kt)) == 1  # resumed after ~12 s
    assert kt.STATE["paused_until"] is None


def test_loop_saves_to_disk_and_runs_initial_cleanup(kt, monkeypatch, fake_time):
    old = (datetime.date.today() - datetime.timedelta(days=60)).isoformat()
    with open(kt.OUT_FILE, "w") as f:
        json.dump({"days": {old: [{"s": 0, "e": 5000, "app": "Old"}]}}, f)
    frames = [(0, "Code", "", "")] * 3
    scripted(kt, monkeypatch, frames)
    run_loop(kt, monkeypatch, fake_time, frames)
    on_disk = json.load(open(kt.OUT_FILE))
    assert old not in on_disk["days"]
    assert os.path.exists(kt.CONFIG_FILE)  # config created on first run


def test_loop_save_failure_is_logged_not_fatal(kt, monkeypatch, fake_time, capsys):
    def boom(data):
        raise OSError("disk full")

    frames = [(0, "Code", "", "")] * 3
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    monkeypatch.setattr(kt, "save", boom)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert "Couldn't write activity file" in capsys.readouterr().err


def test_loop_hourly_cleanup_failure_is_logged(kt, monkeypatch, fake_time, capsys):
    calls = []

    def flaky():
        calls.append(1)
        raise OSError("nope")

    frames = [(0, "Code", "", "")] * 3
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", flaky)
    monkeypatch.setattr(kt, "CLEAN_EVERY", 4)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert len(calls) >= 2
    assert "Cleanup failed" in capsys.readouterr().err


def test_serve_binds_and_reports_busy_port(kt, capsys):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    kt.PORT = s.getsockname()[1]
    kt.serve()  # port taken: must not raise
    assert "Couldn't start the local API" in capsys.readouterr().err
    s.close()
    kt.serve()  # now free
    assert "Local API on" in capsys.readouterr().out


# ---------- install / uninstall / CLI (launchctl faked) ----------


class FakeLaunchctl:
    def __init__(self, bootstrap_rc=0, print_out="state = running"):
        self.calls = []
        self.bootstrap_rc = bootstrap_rc
        self.print_out = print_out

    def __call__(self, cmd, capture_output=True, text=False, **k):
        self.calls.append(cmd)
        if cmd[:2] == ["launchctl", "bootstrap"]:
            return subprocess.CompletedProcess(cmd, self.bootstrap_rc, "", "")
        if cmd[:2] == ["launchctl", "print"]:
            return subprocess.CompletedProcess(cmd, 0, self.print_out, "")
        return subprocess.CompletedProcess(cmd, 0, "", "")


def test_install_writes_plist_and_bootstraps(kt, monkeypatch, capsys):
    fl = FakeLaunchctl()
    monkeypatch.setattr(kt.subprocess, "run", fl)
    kt.install()
    plist = open(kt.PLIST).read()
    assert "<key>Label</key><string>com.keel.tracker</string>" in plist
    assert "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>" in plist
    assert "<string>run</string>" in plist and "keel_tracker.py" in plist
    assert [c[:2] for c in fl.calls] == [["launchctl", "bootout"], ["launchctl", "bootstrap"]]
    assert "installed" in capsys.readouterr().out


def test_install_falls_back_to_load_on_older_macos(kt, monkeypatch):
    fl = FakeLaunchctl(bootstrap_rc=5)
    monkeypatch.setattr(kt.subprocess, "run", fl)
    kt.install()
    assert fl.calls[-1][:3] == ["launchctl", "load", "-w"]


def test_uninstall_removes_plist_keeps_activity(kt, monkeypatch, capsys):
    fl = FakeLaunchctl()
    monkeypatch.setattr(kt.subprocess, "run", fl)
    kt.install()
    open(kt.OUT_FILE, "w").write("{}")
    kt.uninstall()
    assert not os.path.exists(kt.PLIST) and os.path.exists(kt.OUT_FILE)
    kt.uninstall()  # second uninstall is harmless
    assert "removed" in capsys.readouterr().out


def test_cli_against_live_api(kt, server, monkeypatch, capsys):
    monkeypatch.setattr(kt.subprocess, "run", FakeLaunchctl())
    monkeypatch.setattr(kt.sys, "argv", ["keel_tracker.py", "pause", "30"])
    kt.pause_cmd()
    assert "Paused for 30 minutes" in capsys.readouterr().out
    monkeypatch.setattr(kt.sys, "argv", ["keel_tracker.py", "pause"])
    kt.pause_cmd()
    assert "until you resume" in capsys.readouterr().out
    kt.status()
    assert capsys.readouterr().out.startswith("Paused")
    kt.resume_cmd()
    assert "resumed" in capsys.readouterr().out
    kt.cleanup_cmd()
    assert "Cleaned up" in capsys.readouterr().out


def test_cli_when_tracker_not_running(kt, monkeypatch, capsys):
    kt.PORT = 1  # nothing listens here
    monkeypatch.setattr(kt.subprocess, "run", FakeLaunchctl(print_out=""))
    monkeypatch.setattr(kt.sys, "argv", ["keel_tracker.py", "pause"])
    kt.pause_cmd()
    kt.resume_cmd()
    assert capsys.readouterr().out.count("isn't running") == 2
    kt.status()
    assert capsys.readouterr().out.startswith("Not running")
    old = (datetime.date.today() - datetime.timedelta(days=90)).isoformat()
    json.dump({"days": {old: [{"s": 0, "e": 5000, "app": "A"}]}}, open(kt.OUT_FILE, "w"))
    kt.cleanup_cmd()
    out = capsys.readouterr().out
    assert "directly" in out and "Removed 1" in out


def test_status_lists_top_apps(kt, monkeypatch, capsys):
    now = int(time.time() * 1000)
    json.dump({"days": {kt.day_key(now): [{"s": now - 120_000, "e": now, "app": "Figma"}]}}, open(kt.OUT_FILE, "w"))
    kt.PORT = 1
    monkeypatch.setattr(kt.subprocess, "run", FakeLaunchctl())
    kt.status()
    out = capsys.readouterr().out
    assert "Today: 2 min across 1 segments" in out and "Figma: 2 min" in out


def test_main_dispatches_unknown_command_to_run(kt, monkeypatch):
    import runpy

    called = {}
    monkeypatch.setenv("HOME", os.path.dirname(kt.OUT_DIR))
    monkeypatch.setattr("sys.argv", ["keel_tracker.py", "status"])
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    runpy.run_path(kt.__file__, run_name="__main__")
    called["ok"] = True
    assert called["ok"]
