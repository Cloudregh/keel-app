"""Keel Tracker.app (owner's request, 2026-11-15): setup without Python or Terminal.

tracker/app_main.py is the app's entry point. Opened the first time, it registers itself to start at login (the
login item runs the app's own executable, not a Python script), starts tracking and says so in a dialog. Opened
again, it offers Open Keel / Pause / Turn off tracking. macOS tools are faked here; nothing real is run.
"""

import importlib.util
import pathlib
import subprocess

import pytest

APP_MAIN = pathlib.Path(__file__).parents[2] / "tracker" / "app_main.py"


@pytest.fixture
def app(kt, monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(f"app_main_{id(tmp_path)}", APP_MAIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    calls = {"launchctl": [], "dialogs": [], "open": [], "api": []}
    answers = []

    def fake_run(cmd, **k):
        if cmd[0] == "launchctl":
            calls["launchctl"].append(cmd[1:])
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[0] == "/usr/bin/open":
            calls["open"].append(cmd[1:])
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[0] == "/usr/bin/osascript":
            calls["dialogs"].append(cmd)
            return subprocess.CompletedProcess(cmd, 0, (answers.pop(0) if answers else "") + "\n", "")
        raise AssertionError(f"unexpected command {cmd}")

    monkeypatch.setattr(kt.subprocess, "run", fake_run)
    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    exe = tmp_path / "Applications" / "Keel Tracker.app" / "Contents" / "MacOS" / "Keel Tracker"
    monkeypatch.setattr(mod.sys, "executable", str(exe))
    monkeypatch.setattr(kt.os, "getuid", lambda: 501, raising=False)
    mod.calls, mod.answers, mod.exe = calls, answers, str(exe)
    return mod


def dialog_text(cmd):
    return " ".join(cmd[cmd.index("end run") + 1 :]) if "end run" in cmd else ""


def test_first_open_registers_the_app_itself_at_login_and_says_tracking_is_on(app, kt):
    app.answers.append("OK")
    app.main([], kt)
    plist = open(kt.PLIST).read()
    assert f"<string>{app.exe}</string><string>run</string>" in plist  # the app's own executable, no Python needed
    assert "keel_tracker.py" not in plist and "python" not in plist.lower()
    assert ["bootstrap", "gui/501", kt.PLIST] in app.calls["launchctl"]
    text = dialog_text(app.calls["dialogs"][0])
    assert "Keel Tracker is on" in text and "starts when you log in" in text
    assert "never" in text and "screenshots" in text  # says what it doesn't record


def test_first_open_can_open_keel(app, kt):
    app.answers.append("Open Keel")
    app.main([], kt)
    assert app.calls["open"] == [[app.KEEL_URL]]
    assert app.KEEL_URL.startswith("https://")


def test_reopened_while_running_offers_pause_and_pauses(app, kt, monkeypatch):
    kt.install(program=[app.exe, "run"], quiet=True)
    app.calls["launchctl"].clear()
    monkeypatch.setattr(kt, "api", lambda m, p, b=None: app.calls["api"].append((m, p, b)) or {"running": True, "paused": False})
    app.answers.append("Pause 1 hour")
    app.main([], kt)
    assert ("POST", "/pause", {"minutes": 60}) in app.calls["api"]
    assert app.calls["launchctl"] == []  # already set up: not registered again
    assert "Keel Tracker is running" in dialog_text(app.calls["dialogs"][0])


def test_reopened_while_paused_offers_resume(app, kt, monkeypatch):
    kt.install(program=[app.exe, "run"], quiet=True)
    monkeypatch.setattr(kt, "api", lambda m, p, b=None: app.calls["api"].append((m, p, b)) or {"running": True, "paused": True})
    app.answers.append("Resume")
    app.main([], kt)
    assert ("POST", "/resume", None) in app.calls["api"] or ("POST", "/resume", {}) in app.calls["api"]


def test_turn_off_asks_first_then_removes_the_login_item_and_keeps_the_data(app, kt, monkeypatch):
    kt.install(program=[app.exe, "run"], quiet=True)
    open(kt.OUT_FILE, "w").write('{"days": {}}')
    monkeypatch.setattr(kt, "api", lambda m, p, b=None: {"running": True, "paused": False})
    app.answers.extend(["Turn off tracking", "Cancel"])  # changed their mind
    app.main([], kt)
    assert pathlib.Path(kt.PLIST).exists()
    app.answers.extend(["Turn off tracking", "Turn off"])
    app.main([], kt)
    assert not pathlib.Path(kt.PLIST).exists()
    assert ["bootout", f"gui/501/{kt.LABEL}"] in app.calls["launchctl"]
    assert pathlib.Path(kt.OUT_FILE).exists()  # activity is kept


def test_moved_app_is_registered_again_at_its_new_place(app, kt, monkeypatch):
    kt.install(program=["/Users/x/Downloads/Keel Tracker.app/Contents/MacOS/Keel Tracker", "run"], quiet=True)
    monkeypatch.setattr(kt, "api", lambda m, p, b=None: (_ for _ in ()).throw(OSError("not running")))
    app.answers.append("OK")
    app.main([], kt)
    assert f"<string>{app.exe}</string>" in open(kt.PLIST).read()


def test_installed_but_not_running_is_started_again(app, kt, monkeypatch):
    kt.install(program=[app.exe, "run"], quiet=True)
    app.calls["launchctl"].clear()
    monkeypatch.setattr(kt, "api", lambda m, p, b=None: (_ for _ in ()).throw(OSError("not running")))
    app.answers.append("OK")
    app.main([], kt)
    assert any(c[0] == "bootstrap" for c in app.calls["launchctl"])


def test_run_argument_starts_tracking(app, kt, monkeypatch):
    ran = []
    monkeypatch.setattr(kt, "run_tracker", lambda: ran.append(1))
    app.main(["run"], kt)
    assert ran == [1] and app.calls["dialogs"] == []


def test_dialog_text_goes_in_as_arguments(app, kt):
    app.answers.append("OK")
    app.dialog('x" & (do shell script "touch /tmp/pwned") & "', ["OK"], "OK")
    cmd = app.calls["dialogs"][0]
    script = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-e"]
    assert all("pwned" not in line for line in script)


def test_selftest_answers_status_from_an_allowed_site(kt, capsys):
    assert kt.selftest() == 0
    assert "selftest ok" in capsys.readouterr().out


def test_both_keel_sites_are_allowed_by_default(kt):
    origins = kt.load_config()["allowed_origins"]
    assert "https://cloudregh.github.io" in origins and "https://keel-app-five.vercel.app" in origins
    assert kt.origin_allowed("https://keel-app-five.vercel.app")


def test_plist_paths_are_xml_escaped(kt, monkeypatch):
    monkeypatch.setattr(kt.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "", ""))
    monkeypatch.setattr(kt.os, "getuid", lambda: 501, raising=False)
    kt.install(program=["/Apps/Tom & Jerry <x>.app/Contents/MacOS/Keel Tracker", "run"], quiet=True)
    plist = open(kt.PLIST).read()
    assert "Tom &amp; Jerry &lt;x&gt;.app" in plist and "Tom & Jerry" not in plist


def test_opened_from_a_temporary_location_asks_to_move_to_applications_first(app, kt, monkeypatch):
    """macOS runs a downloaded app from a random temporary path until it's moved (App Translocation). Registering
    that path at login would break after a restart, so the app asks to be moved first."""
    temp = "/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/Keel Tracker.app/Contents/MacOS/Keel Tracker"
    monkeypatch.setattr(app.sys, "executable", temp)
    app.answers.append("OK")
    app.main([], kt)
    assert not pathlib.Path(kt.PLIST).exists() and app.calls["launchctl"] == []
    assert "Applications" in dialog_text(app.calls["dialogs"][0])
