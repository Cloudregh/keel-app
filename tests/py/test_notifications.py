"""Mac notifications from the tracker (owner's request, 2026-11-15).

Keel sends the tracker a short schedule (POST /schedule); the tracker shows macOS notifications at those times, even
with no Keel tab open, plus its own alerts: still paused after 2 h, didn't shut down cleanly, Keel hasn't connected by
midday, and the end-of-day summary. osascript is never really called here: notify() is replaced, or subprocess.run is.
"""

import datetime
import json
import os
import stat
import subprocess

import pytest
from test_tracker_integration import run_loop, scripted

GOOD = "https://cloudregh.github.io"
MIN = 60_000
HOUR = 60 * MIN


def local_ms(hour, minute=0, days=0):
    d = datetime.datetime.now().replace(hour=hour, minute=minute, second=0, microsecond=0) + datetime.timedelta(days=days)
    return int(d.timestamp() * 1000)


@pytest.fixture
def shown(kt, monkeypatch):
    out = []
    monkeypatch.setattr(kt, "notify", lambda title, body="": out.append((title, body)) or True)
    return out


def item(id_, at, kind="plan", title="Next up: Write report", body="Starts at 10:00"):
    return {"id": id_, "at": at, "kind": kind, "title": title, "body": body}


# ---------- the schedule API ----------


def test_schedule_is_accepted_from_an_allowed_site_and_saved_privately(server, kt):
    now = local_ms(9)
    kt.NOW_MS = lambda: now
    body = {"items": [item("p1", now + 10 * MIN)], "prefs": {"plan": True}, "summaryAt": now + 8 * HOUR, "tasksDone": 3}
    st, _, out = server.request("POST", "/schedule", body=body, origin=GOOD)
    assert st == 200 and out["scheduled"] == 1
    saved = json.load(open(kt.schedule_file()))
    assert [i["id"] for i in saved["items"]] == ["p1"] and saved["tasks_done"] == 3
    assert stat.S_IMODE(os.stat(kt.schedule_file()).st_mode) == 0o600


@pytest.mark.parametrize("origin", ["https://example.com", "https://cloudregh.github.io.evil.example"])
def test_schedule_is_refused_from_other_sites(server, kt, origin):
    st, _, _ = server.request("POST", "/schedule", body={"items": [item("x", 1)]}, origin=origin)
    assert st == 403
    assert kt.NOTES["items"] == [] and not os.path.exists(kt.schedule_file())


def test_schedule_validation_drops_bad_items_and_caps_sizes(kt):
    now = local_ms(9)
    good = [item(f"g{i}", now + (i + 1) * MIN) for i in range(60)]
    bad = [
        "not a dict",
        item("past", now - 5 * MIN),
        item("far", now + 25 * HOUR),
        item("kind", now + MIN, kind="shell"),
        {**item("bool", 0), "at": True},
        {**item("float", 0), "at": float("nan")},
        {**item("str", 0), "at": str(now + MIN)},
        item("", now + MIN),
        item("notitle", now + MIN, title="   "),
    ]
    n = kt.set_schedule({"items": bad + good, "prefs": {"plan": "yes", "focus": False}, "tasksDone": -4, "summaryAt": "x"}, now)
    assert n == 50  # capped
    ids = [i["id"] for i in kt.NOTES["items"]]
    assert ids == [f"g{i}" for i in range(50)]  # soonest first; every bad item dropped
    assert kt.NOTES["prefs"]["plan"] is True  # a non-boolean doesn't change a setting
    assert kt.NOTES["prefs"]["focus"] is False
    assert kt.NOTES["tasks_done"] == 0 and kt.NOTES["summary_at"] is None


def test_text_is_cleaned_and_shortened(kt):
    now = local_ms(9)
    kt.set_schedule({"items": [item("t", now + MIN, title="Next up:\n\x07" + "x" * 200, body="a\tb\x00c" + "y" * 300)]}, now)
    it = kt.NOTES["items"][0]
    assert len(it["title"]) <= 80 and it["title"].startswith("Next up: x") and it["title"].endswith("…")
    assert "\n" not in it["title"] and "\x07" not in it["title"]
    assert len(it["body"]) <= 120 and "\x00" not in it["body"] and "\t" not in it["body"]


def test_a_new_schedule_replaces_the_old_one(kt):
    now = local_ms(9)
    kt.set_schedule({"items": [item("a", now + MIN), item("b", now + 2 * MIN)]}, now)
    kt.set_schedule({"items": [item("c", now + 3 * MIN)]}, now)
    assert [i["id"] for i in kt.NOTES["items"]] == ["c"]


# ---------- firing ----------


def test_items_fire_once_at_their_time_and_not_before(kt, shown):
    now = local_ms(9)
    kt.set_schedule(
        {"items": [item("p1", now + 2 * MIN), item("f1", now + 30 * MIN, kind="focus", title="Focus session done", body="")]}, now
    )
    kt.check_notifications(now + MIN)
    assert shown == []
    kt.check_notifications(now + 2 * MIN)
    kt.check_notifications(now + 3 * MIN)
    assert shown == [("Next up: Write report", "Starts at 10:00")]
    kt.check_notifications(now + 31 * MIN)
    assert shown[-1] == ("Focus session done", "") and len(shown) == 2


def test_late_items_are_dropped_not_shown(kt, shown):
    now = local_ms(9)
    kt.set_schedule({"items": [item("p1", now + MIN)]}, now)
    kt.check_notifications(now + 15 * MIN)  # tracker was asleep: a 14-minute-old reminder is no use
    assert shown == [] and kt.NOTES["items"] == []


def test_switched_off_kinds_are_not_shown(kt, shown):
    now = local_ms(9)
    kt.set_schedule(
        {
            "items": [item("p", now + MIN), item("b", now + MIN, kind="break", title="Time for a break")],
            "prefs": {"plan": False, "focus": False},
        },
        now,
    )
    kt.check_notifications(now + MIN)
    assert shown == []


def test_at_most_one_per_minute_per_kind_and_none_are_lost(kt, shown):
    now = local_ms(9)
    kt.set_schedule(
        {"items": [item("a", now + MIN, title="A"), item("b", now + MIN, title="B"), item("f", now + MIN, kind="focus", title="F")]}, now
    )
    kt.check_notifications(now + MIN)
    assert [t for t, _ in shown] == ["A", "F"]  # one plan reminder, and the focus one (another kind)
    kt.check_notifications(now + MIN + 30_000)
    assert [t for t, _ in shown] == ["A", "F"]
    kt.check_notifications(now + 2 * MIN)
    assert [t for t, _ in shown] == ["A", "F", "B"]


def test_an_item_already_shown_isnt_shown_again_after_a_restart(kt, shown):
    now = local_ms(9)
    kt.NOW_MS = lambda: now + MIN
    kt.set_schedule({"items": [item("p1", now + MIN)]}, now)
    kt.check_notifications(now + MIN)
    kt.NOTES.update(kt.fresh_notes())  # restart: memory gone
    kt.load_schedule()
    kt.set_schedule({"items": [item("p1", now + MIN)]}, now + MIN)  # Keel sends the same item again
    kt.check_notifications(now + MIN + 1000)
    assert len(shown) == 1


def test_schedule_survives_a_restart(kt, shown):
    now = local_ms(9)
    kt.NOW_MS = lambda: now + MIN  # restarted a minute later
    kt.set_schedule({"items": [item("p1", now + 5 * MIN)], "prefs": {"summary": False}}, now)
    kt.NOTES.update(kt.fresh_notes())
    kt.load_schedule()
    assert [i["id"] for i in kt.NOTES["items"]] == ["p1"] and kt.NOTES["prefs"]["summary"] is False
    kt.check_notifications(now + 5 * MIN)
    assert len(shown) == 1


def test_notify_passes_text_as_arguments_so_a_title_cant_run_as_a_script(kt, monkeypatch):
    seen = {}

    def fake_run(cmd, **k):
        seen["cmd"], seen["timeout"] = cmd, k.get("timeout")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(kt.subprocess, "run", fake_run)
    evil = 'x" & (do shell script "touch /tmp/pwned") & "'
    assert kt.notify(evil, "body " + evil) is True
    cmd = seen["cmd"]
    assert cmd[0].endswith("osascript")
    script = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-e"]
    assert all(evil not in line for line in script)  # the script itself is fixed
    assert cmd[-2:] == [evil, "body " + evil]  # the text only ever arrives as arguments
    assert seen["timeout"] and seen["timeout"] <= 5


def test_notify_failing_never_stops_tracking(kt, monkeypatch, fake_time):
    monkeypatch.setattr(kt.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("osascript")))
    assert kt.notify("t", "b") is False
    frames = [(0, "Code", "", "")] * 6
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    monkeypatch.setattr(kt, "check_notifications", lambda now_ms: (_ for _ in ()).throw(RuntimeError("boom")))
    run_loop(kt, monkeypatch, fake_time, frames)
    segs = [s for d in kt.STATE["data"]["days"].values() for s in d]
    assert [s["app"] for s in segs] == ["Code"]


def test_the_loop_checks_notifications_every_tick(kt, monkeypatch, fake_time):
    calls = []
    frames = [(0, "Code", "", "")] * 4
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "cleanup", lambda: 0)
    monkeypatch.setattr(kt, "check_notifications", lambda now_ms: calls.append(now_ms))
    run_loop(kt, monkeypatch, fake_time, frames)
    assert len(calls) >= 4


# ---------- end-of-day summary ----------


def test_end_of_day_summary_shows_tracked_time_top_apps_and_tasks_done(kt, shown):
    now = local_ms(19)
    day = kt.day_key(now)
    kt.STATE["data"] = {
        "days": {
            day: [
                {"s": now - 5 * HOUR, "e": now - 2 * HOUR, "app": "Code"},
                {"s": now - 2 * HOUR, "e": now - HOUR, "app": "Google Chrome", "domain": "planted-site.example", "title": "planted title"},
                {"s": now - HOUR, "e": now - 30 * MIN, "app": "Slack"},
                {"s": now - 30 * MIN, "e": now - 20 * MIN, "app": "Mail"},
            ]
        }
    }
    kt.set_schedule({"items": [], "summaryAt": now, "tasksDone": 4}, now - MIN)
    kt.NOTES["last_page"] = now - HOUR  # Keel connected today, so only the summary is due
    kt.check_notifications(now)
    kt.check_notifications(now + 2 * MIN)
    assert len(shown) == 1
    title, body = shown[0]
    assert title == "Your day in Keel"
    assert "4h 40m" in body and "Code, Google Chrome, Slack" in body and "4 tasks done" in body
    assert "planted" not in body  # app names only: no sites or window titles


def test_summary_is_off_when_switched_off(kt, shown):
    now = local_ms(19)
    kt.set_schedule({"summaryAt": now, "prefs": {"summary": False}}, now - MIN)
    kt.check_notifications(now)
    assert shown == []


# ---------- tracker problems ----------


def test_still_paused_after_two_hours_is_said_once(kt, shown, monkeypatch):
    t0 = local_ms(9)
    monkeypatch.setattr(kt, "save_config", lambda cfg: None)
    monkeypatch.setattr(kt.time, "time", lambda: t0 / 1000)
    kt.set_pause(-1)  # until resumed
    kt.check_notifications(t0 + HOUR)
    assert shown == []
    kt.check_notifications(t0 + 2 * HOUR)
    kt.check_notifications(t0 + 3 * HOUR)
    assert len(shown) == 1 and "paused" in shown[0][0].lower()
    kt.set_pause(None)
    kt.check_notifications(t0 + 4 * HOUR)
    assert len(shown) == 1


def test_a_short_pause_never_alerts(kt, shown, monkeypatch):
    t0 = local_ms(9)
    monkeypatch.setattr(kt, "save_config", lambda cfg: None)
    monkeypatch.setattr(kt.time, "time", lambda: t0 / 1000)
    kt.set_pause(t0 + HOUR)
    kt.check_notifications(t0 + 2 * HOUR + MIN)  # the pause ended by itself
    assert shown == []


def test_unclean_shutdown_is_reported_on_the_next_start(kt, shown):
    now = local_ms(9)
    kt.start_marker()  # first start: nothing to report
    kt.check_notifications(now)
    assert shown == []
    kt.start_marker()  # started again without a clean stop (the marker is still there)
    kt.check_notifications(now)
    assert len(shown) == 1 and "shut down cleanly" in shown[0][0] + shown[0][1]
    kt.clean_stop()
    assert not os.path.exists(kt.run_marker())
    kt.start_marker()
    kt.check_notifications(now + MIN)
    assert len(shown) == 1


def test_keel_not_connected_by_midday_alerts_once_when_the_mac_is_in_use(kt, shown):
    noon = local_ms(12, 5)
    day = kt.day_key(noon)
    kt.STATE["data"] = {"days": {day: [{"s": noon - 2 * HOUR, "e": noon - HOUR, "app": "Code"}]}}
    kt.check_notifications(local_ms(11, 55))
    assert shown == []  # not yet midday
    kt.check_notifications(noon)
    kt.check_notifications(noon + 30 * MIN)
    assert len(shown) == 1 and "hasn't connected" in shown[0][0]


def test_no_connection_alert_when_keel_loaded_today_or_the_mac_was_barely_used(kt, shown, server):
    noon = local_ms(12, 5)
    day = kt.day_key(noon)
    kt.STATE["data"] = {"days": {day: [{"s": noon - 20 * MIN, "e": noon - 5 * MIN, "app": "Code"}]}}
    kt.check_notifications(noon)
    assert shown == []  # 15 minutes of use: probably away today
    kt.STATE["data"]["days"][day].append({"s": noon - 3 * HOUR, "e": noon - 2 * HOUR, "app": "Code"})
    kt.NOW_MS = lambda: noon - HOUR
    server.request("GET", "/status", origin=GOOD)  # a Keel page connected this morning
    kt.check_notifications(noon)
    assert shown == []


def test_tracker_alerts_respect_the_switch(kt, shown):
    noon = local_ms(12, 5)
    kt.STATE["data"] = {"days": {kt.day_key(noon): [{"s": noon - 2 * HOUR, "e": noon - HOUR, "app": "Code"}]}}
    kt.set_schedule({"prefs": {"tracker": False}}, noon - MIN)
    kt.start_marker()
    kt.start_marker()
    kt.check_notifications(noon)
    assert shown == []


def test_notification_text_is_never_written_to_the_log(kt, monkeypatch, capfd):
    monkeypatch.setattr(kt.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("osascript failed")))
    now = local_ms(9)
    kt.set_schedule({"items": [item("p", now + MIN, title="Next up: Planted secret task")]}, now)
    kt.check_notifications(now + MIN)
    out, err = capfd.readouterr()
    assert "Planted secret task" not in out + err
