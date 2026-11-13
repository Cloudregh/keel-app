"""Phase 4: tracker data integrity: older file formats, config upgrades, backup → restore, retention never
touches today's data."""

import datetime
import json
import shutil

from conftest import load_tracker


def iso(days_ago):
    return (datetime.date.today() - datetime.timedelta(days=days_ago)).isoformat()


def test_version_1_activity_file_loads_and_is_upgraded_on_save(kt):
    v1 = {"source": "keel-tracker", "version": 1, "device": "Mac", "updatedAt": 1, "days": {iso(0): [{"s": 0, "e": 5000, "app": "Code"}]}}
    json.dump(v1, open(kt.OUT_FILE, "w"))
    data = kt.load()
    assert data["days"][iso(0)][0]["app"] == "Code"
    kt.save(data)
    on_disk = json.load(open(kt.OUT_FILE))
    assert on_disk["version"] == 2 and "tzOffsetMin" in on_disk and on_disk["days"][iso(0)][0]["app"] == "Code"


def test_old_config_without_new_keys_keeps_its_values(kt):
    json.dump({"allowed_origins": ["https://me.example"], "paused_until": -1}, open(kt.CONFIG_FILE, "w"))
    cfg = kt.load_config()
    assert cfg["allowed_origins"] == ["https://me.example"] and cfg["paused_until"] == -1
    assert cfg["keep_days"] == 30 and cfg["max_file_mb"] == 20


def test_backup_restore_to_a_separate_home_reproduces_the_data(kt, tmp_path):
    days = {iso(i): [{"s": i, "e": i + 60_000, "app": "Safari", "domain": "x.com", "title": f"t{i}"}] for i in range(5)}
    kt.STATE["data"] = {"days": days}
    kt.save(kt.STATE["data"])
    backup = tmp_path / "backup.json"
    shutil.copy(kt.OUT_FILE, backup)

    other = load_tracker(tmp_path / "restore-target")
    shutil.copy(backup, other.OUT_FILE)
    restored = other.load()
    assert restored["days"] == json.load(open(kt.OUT_FILE))["days"]
    assert other.snapshot(restored)["days"] == kt.snapshot(kt.STATE["data"])["days"]


def test_cleanup_never_removes_today_or_shortens_live_segments(kt):
    now_day = iso(0)
    cur = {"s": 1, "e": 1, "app": "Now"}
    kt.STATE["cur"] = cur
    kt.STATE["data"] = {"days": {now_day: [{"s": 0, "e": 9000, "app": "A"}, cur], iso(45): [{"s": 0, "e": 9000, "app": "Old"}]}}
    kt.save_config({"allowed_origins": [], "keep_days": 1, "max_file_mb": 20})
    kt.cleanup()
    assert now_day in kt.STATE["data"]["days"]
    assert cur in kt.STATE["data"]["days"][now_day]
