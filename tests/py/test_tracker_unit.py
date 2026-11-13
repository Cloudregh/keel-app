"""Unit tests for the tracker's business rules: config, pausing, storage, cleanup, parsing of macOS tool output."""

import datetime
import json
import os
import subprocess
import time

import pytest

DAY_MS = 86_400_000


def iso(days_ago):
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


def ms_on(days_ago, hour=10):
    d = datetime.date.today() - datetime.timedelta(days=days_ago)
    return int(datetime.datetime(d.year, d.month, d.day, hour).timestamp() * 1000)


# ---------- config ----------


def test_config_defaults_when_missing(kt):
    cfg = kt.load_config()
    assert cfg["allowed_origins"] == ["https://cloudregh.github.io"]
    assert cfg["keep_days"] == 30
    assert cfg["max_file_mb"] == 20


@pytest.mark.parametrize("bad", ['{"keep_days": 0}', '{"keep_days": 366}', '{"keep_days": "30"}', '{"keep_days": 7.5}'])
def test_config_rejects_out_of_range_keep_days(kt, bad):
    with open(kt.CONFIG_FILE, "w") as f:
        f.write(bad)
    assert kt.load_config()["keep_days"] == 30


@pytest.mark.parametrize("bad", ['{"max_file_mb": 0}', '{"max_file_mb": 501}', '{"max_file_mb": null}'])
def test_config_rejects_out_of_range_max_file(kt, bad):
    with open(kt.CONFIG_FILE, "w") as f:
        f.write(bad)
    assert kt.load_config()["max_file_mb"] == 20


def test_config_corrupt_file_falls_back_to_defaults(kt):
    with open(kt.CONFIG_FILE, "w") as f:
        f.write("{not json")
    assert kt.load_config()["keep_days"] == 30


def test_config_allowed_origins_must_be_a_list(kt):
    with open(kt.CONFIG_FILE, "w") as f:
        json.dump({"allowed_origins": "https://evil.example"}, f)
    assert kt.load_config()["allowed_origins"] == ["https://cloudregh.github.io"]


def test_save_config_round_trip(kt):
    kt.save_config({"allowed_origins": ["https://a.example"], "keep_days": 7, "max_file_mb": 5})
    cfg = kt.load_config()
    assert cfg["allowed_origins"] == ["https://a.example"]
    assert cfg["keep_days"] == 7
    assert kt.keep_days() == 7


# ---------- pausing ----------


def test_not_paused_by_default(kt):
    assert kt.is_paused() is False


def test_indefinite_pause_persists_to_config(kt):
    kt.set_pause(-1)
    assert kt.is_paused() is True
    assert kt.load_config()["paused_until"] == -1


def test_timed_pause_expires_and_clears(kt):
    now = int(time.time() * 1000)
    kt.set_pause(now + 60_000)
    assert kt.is_paused(now) is True
    assert kt.is_paused(now + 60_000) is False
    assert kt.STATE["paused_until"] is None
    assert kt.load_config()["paused_until"] is None


def test_pause_survives_unwritable_config(kt, monkeypatch):
    def boom(cfg):
        raise OSError("disk full")

    monkeypatch.setattr(kt, "save_config", boom)
    kt.set_pause(-1)
    assert kt.is_paused() is True


# ---------- macOS tool output parsing (tools faked) ----------


def fake_run(outputs):
    def run(cmd, capture_output=True, text=True, timeout=None):
        key = cmd[0] if cmd[0] != "lsappinfo" else f"lsappinfo {cmd[1]}"
        val = outputs[key]
        if isinstance(val, Exception):
            raise val
        if isinstance(val, tuple):
            return subprocess.CompletedProcess(cmd, val[0], val[1], "")
        return subprocess.CompletedProcess(cmd, 0, val, "")

    return run


def test_idle_seconds_parses_ioreg(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"ioreg": '  |   "HIDIdleTime" = 4209416833\n'}))
    assert kt.idle_seconds() == pytest.approx(4.209, abs=0.01)


def test_idle_seconds_missing_value_is_zero(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"ioreg": "nothing here"}))
    assert kt.idle_seconds() == 0.0


def test_run_returns_empty_on_failure(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"ioreg": subprocess.TimeoutExpired("ioreg", 3)}))
    assert kt.run(["ioreg"]) == ""


@pytest.mark.parametrize(
    "info, expected",
    [
        ('"LSDisplayName"="Safari"', "Safari"),
        ('"Claude" ASN:0x0-0xd793786: (in front) \n    bundleID=[ NULL ]', "Claude"),
        ('"LSDisplayName"="Visual Studio Code"', "Visual Studio Code"),
        ("garbage", ""),
    ],
)
def test_front_app_parses_both_lsappinfo_formats(kt, monkeypatch, info, expected):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"lsappinfo front": "ASN:0x0-0x1:", "lsappinfo info": info}))
    assert kt.front_app() == expected


def test_front_app_no_frontmost(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"lsappinfo front": ""}))
    assert kt.front_app() == ""


@pytest.mark.parametrize(
    "app, out, expected",
    [
        ("Safari", "https://www.YouTube.com/watch?v=1\nLo-fi beats", ("youtube.com", "Lo-fi beats")),
        ("Google Chrome", "https://github.com:443/x\nPull requests", ("github.com", "Pull requests")),
        ("Arc", "file:///Users/x/a.html\nLocal file", ("", "Local file")),
        ("Brave Browser", "brave://settings\nSettings", ("", "Settings")),
        ("Safari", "https://example.com\n" + "T" * 200, ("example.com", "T" * 90)),
        ("Safari", "", ("", "")),
    ],
)
def test_browser_tab_parsing(kt, monkeypatch, app, out, expected):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"osascript": out}))
    assert kt.browser_tab(app) == expected


def test_browser_tab_not_a_browser(kt):
    assert kt.browser_tab("Finder") == ("", "")


def test_browser_tab_permission_denied_backs_off_10_minutes(kt, monkeypatch):
    calls = []

    def run(cmd, **k):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 1, "", "Not authorized to send Apple events")

    monkeypatch.setattr(kt.subprocess, "run", run)
    assert kt.browser_tab("Safari") == ("", "")
    assert kt.browser_tab("Safari") == ("", "")
    assert len(calls) == 1
    kt._browser_fail["Safari"] -= 601
    kt.browser_tab("Safari")
    assert len(calls) == 2


def test_browser_tab_timeout_backs_off(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", fake_run({"osascript": subprocess.TimeoutExpired("osascript", 4)}))
    assert kt.browser_tab("Google Chrome") == ("", "")
    assert "Google Chrome" in kt._browser_fail


def test_browser_name_with_quote_is_not_a_browser(kt):
    # Only known browser names reach the AppleScript string, so a crafted app name can't inject script.
    assert kt.browser_tab('Safari" to do shell script "x') == ("", "")


# ---------- storage ----------


def test_day_key_uses_local_date(kt):
    ms = ms_on(0, 23)
    assert kt.day_key(ms) == iso(0)


def test_load_missing_or_corrupt_file_starts_fresh(kt):
    assert kt.load() == {"days": {}}
    with open(kt.OUT_FILE, "w") as f:
        f.write('{"days": [1,2]}')
    assert kt.load() == {"days": {}}
    with open(kt.OUT_FILE, "w") as f:
        f.write("\x00\x01 not json")
    assert kt.load() == {"days": {}}


def test_snapshot_filters_short_and_old_segments(kt):
    data = {
        "days": {
            iso(0): [{"s": 0, "e": 999, "app": "A"}, {"s": 0, "e": 1000, "app": "B"}],
            iso(31): [{"s": 0, "e": 5000, "app": "Old"}],
        }
    }
    snap = kt.snapshot(data)
    assert snap["source"] == "keel-tracker"
    assert snap["version"] == 2
    assert list(snap["days"]) == [iso(0)]
    assert [s["app"] for s in snap["days"][iso(0)]] == ["B"]
    assert isinstance(snap["tzOffsetMin"], int)


def test_snapshot_max_days_never_exceeds_keep_days(kt):
    kt.save_config({"allowed_origins": [], "keep_days": 3, "max_file_mb": 20})
    data = {"days": {iso(i): [{"s": 0, "e": 2000, "app": "A"}] for i in range(10)}}
    assert len(kt.snapshot(data, 100)["days"]) == 4  # today + 3 days back
    assert len(kt.snapshot(data, 1)["days"]) == 2


def test_snapshot_copies_segments(kt):
    seg = {"s": 0, "e": 5000, "app": "A"}
    snap = kt.snapshot({"days": {iso(0): [seg]}})
    snap["days"][iso(0)][0]["app"] = "changed"
    assert seg["app"] == "A"


def test_save_is_atomic_and_keeps_current_segment(kt):
    cur = {"s": 1, "e": 1, "app": "Now"}
    kt.STATE["cur"] = cur
    data = {"days": {iso(0): [{"s": 0, "e": 500, "app": "Short"}, cur, {"s": 0, "e": 9000, "app": "Long"}]}}
    kt.save(data)
    assert not os.path.exists(kt.OUT_FILE + ".tmp")
    on_disk = json.load(open(kt.OUT_FILE))
    assert [s["app"] for s in on_disk["days"][iso(0)]] == ["Long"]
    assert [s["app"] for s in data["days"][iso(0)]] == ["Now", "Long"]  # in-memory keeps the live segment


def test_fsize_missing_file_is_zero(kt):
    assert kt.fsize("/definitely/not/here") == 0


# ---------- cleanup ----------


def write_days(kt, days):
    kt.STATE["data"] = {"days": days}


def test_cleanup_removes_days_older_than_keep_days(kt):
    write_days(kt, {iso(i): [{"s": ms_on(i), "e": ms_on(i) + 60_000, "app": "A"}] for i in range(40)})
    removed = kt.cleanup()
    assert removed == 9  # days 31..39 (cutoff keeps today-30 and newer)
    assert min(kt.STATE["data"]["days"]) == iso(30)
    assert kt.STATE["last_cleanup"] is not None


def test_cleanup_drops_titles_older_than_7_days_only(kt):
    seg = lambda i: {"s": ms_on(i), "e": ms_on(i) + 60_000, "app": "Safari", "domain": "x.com", "title": "secret"}  # noqa: E731
    write_days(kt, {iso(i): [seg(i)] for i in (0, 7, 8, 20)})
    kt.cleanup()
    d = kt.STATE["data"]["days"]
    assert "title" in d[iso(0)][0] and "title" in d[iso(7)][0]
    assert "title" not in d[iso(8)][0] and "title" not in d[iso(20)][0]
    assert d[iso(8)][0]["domain"] == "x.com"


def test_cleanup_enforces_file_size_cap_by_dropping_oldest(kt):
    kt.save_config({"allowed_origins": [], "keep_days": 30, "max_file_mb": 1})
    big = [{"s": ms_on(0), "e": ms_on(0) + 5000, "app": "A" * 50} for _ in range(4000)]  # ~0.3 MB per day
    write_days(kt, {iso(i): list(big) for i in range(6)})
    removed = kt.cleanup()
    assert os.path.getsize(kt.OUT_FILE) <= 1_000_000
    assert removed >= 2
    assert iso(0) in kt.STATE["data"]["days"]  # newest kept


def test_cleanup_never_deletes_the_last_day_even_if_over_cap(kt):
    kt.save_config({"allowed_origins": [], "keep_days": 30, "max_file_mb": 1})
    huge = [{"s": ms_on(0), "e": ms_on(0) + 5000, "app": "A" * 200} for _ in range(8000)]
    write_days(kt, {iso(0): huge})
    kt.cleanup()
    assert iso(0) in kt.STATE["data"]["days"]


def test_cleanup_trims_log_and_removes_stray_temp_files(kt):
    with open(kt.LOG_FILE, "wb") as f:
        f.write(b"x" * 1_500_000)
    stray = os.path.join(kt.OUT_DIR, "old.tmp")
    open(stray, "w").close()
    write_days(kt, {})
    kt.cleanup()
    assert os.path.getsize(kt.LOG_FILE) == 200_000
    assert not os.path.exists(stray)


def test_storage_obj_reports_sizes_and_settings(kt):
    write_days(kt, {iso(0): [{"s": 0, "e": 5000, "app": "A"}]})
    kt.save(kt.STATE["data"])
    st = kt.storage_obj()
    assert st["fileBytes"] > 0 and st["keepDays"] == 30 and st["maxFileMb"] == 20 and st["days"] == 1


# ---------- origin rules ----------


@pytest.mark.parametrize(
    "origin, ok",
    [
        ("http://localhost", True),
        ("http://localhost:8000", True),
        ("http://127.0.0.1:5173", True),
        ("https://cloudregh.github.io", True),
        ("https://cloudregh.github.io/", True),
        ("https://localhost", False),
        ("http://localhost.evil.com", False),
        ("http://127.0.0.1.evil.com", False),
        ("https://evil.github.io", False),
        ("https://cloudregh.github.io.evil.com", False),
        ("null", False),
        ("", False),
    ],
)
def test_origin_allowed(kt, origin, ok):
    assert kt.origin_allowed(origin) is ok


def test_status_obj_shape_when_paused_hides_current(kt):
    kt.STATE["current"] = {"app": "Safari", "domain": "x.com"}
    kt.set_pause(-1)
    s = kt.status_obj()
    assert s["paused"] is True and s["current"] is None and s["pausedUntil"] is None


def test_status_obj_today_total(kt):
    now = int(time.time() * 1000)
    kt.STATE["data"] = {"days": {kt.day_key(now): [{"s": now - 60_000, "e": now, "app": "A"}]}}
    assert kt.status_obj()["todayMs"] == 60_000


def test_failed_save_leaves_no_temp_file_and_keeps_the_old_file(kt, monkeypatch):
    """Regression for bug 10: an interrupted write never corrupts the activity file or leaves temp files."""
    kt.save({"days": {iso(0): [{"s": 0, "e": 5000, "app": "Before"}]}})

    def broken_dump(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(kt.json, "dump", broken_dump)
    with pytest.raises(OSError):
        kt.save({"days": {iso(0): [{"s": 0, "e": 5000, "app": "After"}]}})
    monkeypatch.undo()
    assert json.load(open(kt.OUT_FILE))["days"][iso(0)][0]["app"] == "Before"
    assert not [f for f in os.listdir(kt.OUT_DIR) if f.endswith(".tmp")]
