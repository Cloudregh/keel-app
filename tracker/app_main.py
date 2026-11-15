"""Keel Tracker.app: the tracker as a Mac app, so nobody needs Python or Terminal (owner's request, 2026-11-15).

Built with PyInstaller by .github/workflows/tracker-app.yml. Opened the first time, it registers its own
executable to start at login (with the argument "run"), which starts tracking, and says so in a dialog. Opened
again, it offers Open Keel, Pause or Resume, and Turn off tracking. launchd runs it with "run"; the build checks it
with "selftest". Dialogs use osascript with the text passed as arguments, never as part of the script.
"""

import os
import subprocess
import sys

KEEL_URL = "https://keel-app-five.vercel.app"
WELCOME = (
    "Keel Tracker is on.\n\n"
    "It notes which app and website you're using, so Keel can show where your time goes. It never takes screenshots "
    "or records what you type, and everything stays on this Mac.\n\n"
    "It starts when you log in. Open Keel in Chrome, Arc, Brave or Edge to see your time. If macOS asks whether Keel "
    "Tracker may control your browser, choose OK so Keel can see which site you're on."
)


def dialog(text, buttons, default):
    """Shows a dialog and returns the button pressed ("" if closed). Text and buttons go in as arguments."""
    script = [
        "on run argv",
        "set btns to items 3 thru -1 of argv",
        "try",
        'set d to display dialog (item 1 of argv) with title "Keel Tracker" buttons btns default button (item 2 of argv)',
        "return button returned of d",
        "on error",
        'return ""',
        "end try",
        "end run",
    ]
    cmd = ["/usr/bin/osascript"]
    for line in script:
        cmd += ["-e", line]
    try:
        r = subprocess.run(cmd + [text, default, *buttons], capture_output=True, text=True, timeout=600)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def open_keel():
    subprocess.run(["/usr/bin/open", KEEL_URL], capture_output=True)


def program():
    return [sys.executable, "run"]  # in the app, sys.executable is the app's own executable


def status(kt):
    try:
        return kt.api("GET", "/status")
    except Exception:
        return None


def welcome(kt):
    kt.install(program=program(), quiet=True)
    if dialog(WELCOME, ["Open Keel", "OK"], "OK") == "Open Keel":
        open_keel()


def manage(kt, st):
    paused = bool(st.get("paused"))
    text = "Keel Tracker is running" + (", but tracking is paused." if paused else " and tracking your apps.")
    choice = dialog(text, ["Turn off tracking", "Resume" if paused else "Pause 1 hour", "Open Keel"], "Open Keel")
    if choice == "Open Keel":
        open_keel()
    elif choice == "Pause 1 hour":
        kt.api("POST", "/pause", {"minutes": 60})
    elif choice == "Resume":
        kt.api("POST", "/resume", {})
    elif choice == "Turn off tracking":
        sure = dialog(
            "Turn off tracking? Keel Tracker will stop and won't start at login. Your recorded activity is kept. Open "
            "Keel Tracker again to turn it back on.",
            ["Cancel", "Turn off"],
            "Cancel",
        )
        if sure == "Turn off":
            kt.uninstall(quiet=True)


def main(argv, kt):
    if argv[:1] == ["run"]:
        return kt.run_tracker()
    if argv[:1] == ["selftest"]:
        return sys.exit(kt.selftest())
    if "/AppTranslocation/" in sys.executable:  # opened straight from Downloads: macOS runs it from a temporary copy
        dialog(
            "Move Keel Tracker to your Applications folder first, then open it from there. "
            "It needs a fixed place to start from when you log in.",
            ["OK"],
            "OK",
        )
        return None
    if kt.installed_program() != program():  # first open, or the app was moved
        return welcome(kt)
    st = status(kt)
    if st is None:  # set up but not running (stopped or crashed): start it again
        return welcome(kt)
    return manage(kt, st)


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import keel_tracker

    main(sys.argv[1:], keel_tracker)
