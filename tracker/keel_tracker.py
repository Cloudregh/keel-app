#!/usr/bin/env python3
"""Keel tracker for macOS.

Records which app is in front (and, for browsers, which site and tab) every few
seconds, skips idle time, and writes it to ~/Keel Activity/keel-activity.json.

It also serves a small private API on http://127.0.0.1:47821 so the Keel web app
can show whether the tracker is running, pause or resume it, and load activity
without importing the file. Only web pages listed in ~/Keel Activity/config.json
("allowed_origins") may use it, and it only listens on this Mac.

Commands:
  python3 keel_tracker.py install    start now and at every login
  python3 keel_tracker.py uninstall  stop and remove from login
  python3 keel_tracker.py status     show whether it's running and today's total
  python3 keel_tracker.py run        run in this terminal (Ctrl+C to stop)
  python3 keel_tracker.py pause      pause tracking (resume with "resume")
  python3 keel_tracker.py resume     resume tracking

  python3 keel_tracker.py cleanup    tidy storage now (also runs automatically every hour)

Storage stays small on its own: history older than "keep_days" (default 30) is
deleted, tab titles older than 7 days are dropped, the activity file is capped at
"max_file_mb" (default 20 MB) and the log is trimmed at 1 MB. Change these in
~/Keel Activity/config.json or from Keel's Settings page.

Nothing leaves your Mac: the tracker only writes a local file.
"""

import contextlib
import datetime
import json
import math
import os
import re
import socket
import subprocess
import tempfile
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

VERSION = 2
PORT = int(os.environ.get("KEEL_TRACKER_PORT", "47821"))  # override only for tests; the web app expects 47821
if not 1024 <= PORT <= 65535:
    raise SystemExit("KEEL_TRACKER_PORT must be between 1024 and 65535")
INTERVAL = 5  # seconds between samples
IDLE_LIMIT = 180  # seconds without keyboard/mouse input before time stops counting
KEEP_DAYS = 30  # default days of history kept (config: keep_days)
MAX_FILE_MB = 20  # default cap for the activity file (config: max_file_mb)
TITLE_DAYS = 7  # tab titles are dropped from days older than this
LOG_MAX = 1_000_000  # bytes; the log is trimmed past this
CLEAN_EVERY = 3600  # seconds between automatic cleanups
SAVE_EVERY = 30  # seconds between file writes
TITLE_MAX = 90

HOME = os.path.expanduser("~")
OUT_DIR = os.path.join(HOME, "Keel Activity")
OUT_FILE = os.path.join(OUT_DIR, "keel-activity.json")
LOG_FILE = os.path.join(OUT_DIR, "tracker.log")
CONFIG_FILE = os.path.join(OUT_DIR, "config.json")
DEFAULT_ORIGINS = ["https://cloudregh.github.io"]
LABEL = "com.keel.tracker"
PLIST = os.path.join(HOME, "Library", "LaunchAgents", LABEL + ".plist")

CHROMIUM = {
    "Google Chrome",
    "Google Chrome Canary",
    "Arc",
    "Brave Browser",
    "Microsoft Edge",
    "Chromium",
    "Opera",
    "Vivaldi",
    "Comet",
    "Dia",
}
SAFARI = {"Safari", "Safari Technology Preview"}
_browser_fail: dict[str, float] = {}  # browser -> time of last failed read, so we don't retry constantly
LOCK = threading.Lock()  # guards the in-memory activity data
SAVE_LOCK = threading.RLock()  # one file write at a time (main loop and API requests both save)
# Fix 64: one /activity copy at a time, from snapshot to encoded bytes. Several tabs pulling at once used to hold a
# full copy each while it was encoded (tracker RSS over 60 MB with 3 tabs); the send happens outside this lock.
ACTIVITY_LOCK = threading.Lock()
STATE: dict[str, Any] = {"data": {"days": {}}, "paused_until": None, "current": None, "idle": False, "started": int(time.time() * 1000)}


def load_config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    if not isinstance(cfg.get("allowed_origins"), list):
        cfg["allowed_origins"] = list(DEFAULT_ORIGINS)
    if not isinstance(cfg.get("keep_days"), int) or not 1 <= cfg["keep_days"] <= 365:
        cfg["keep_days"] = KEEP_DAYS
    if not isinstance(cfg.get("max_file_mb"), (int, float)) or not 1 <= cfg["max_file_mb"] <= 500:
        cfg["max_file_mb"] = MAX_FILE_MB
    return cfg


def keep_days():
    return load_config()["keep_days"]


def make_private():
    """The folder and every file in it are readable by this account only (bug 33)."""
    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(OUT_DIR, 0o700)
    for path in (CONFIG_FILE, LOG_FILE, OUT_FILE):
        with contextlib.suppress(OSError):
            os.chmod(path, 0o600)


def save_config(cfg):
    make_private()
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def is_paused(now_ms=None):
    pu = STATE["paused_until"]
    if pu is None:
        return False
    if pu == -1:
        return True
    if (now_ms or int(time.time() * 1000)) >= pu:
        set_pause(None)
        return False
    return True


def set_pause(until):
    STATE["paused_until"] = until
    STATE["paused_since"] = int(time.time() * 1000) if until is not None else None
    cfg = load_config()
    cfg["paused_until"] = until
    with contextlib.suppress(Exception):  # pausing still works in memory if the config can't be written
        save_config(cfg)


# ---------- Mac notifications (owner's request, 2026-11-15) ----------
# Keel sends a short schedule (POST /schedule): plan reminders, focus/break ends, break nudges and the time of the
# end-of-day summary. The tracker shows them as macOS notifications, also with no Keel tab open, and adds its own
# alerts: still paused after 2 h, didn't shut down cleanly, Keel hasn't connected by midday.
NOTE_KINDS = {"plan": "plan", "focus": "focus", "break": "focus"}  # item kind -> the switch that controls it
DEFAULT_PREFS = {"focus": True, "plan": True, "summary": True, "tracker": True}
MAX_ITEMS, MAX_TITLE, MAX_TEXT = 50, 80, 120
HORIZON_MS, STALE_MS, RATE_MS = 24 * 3600 * 1000, 10 * 60 * 1000, 60 * 1000
PAUSE_ALERT_MS, MIDDAY_HOUR, MIN_ACTIVE_MS = 2 * 3600 * 1000, 12, 30 * 60 * 1000


def fresh_notes():
    return {
        "items": [],
        "prefs": dict(DEFAULT_PREFS),
        "summary_at": None,
        "tasks_done": 0,
        "sent": {},
        "last_kind": {},
        "last_page": None,
        "flags": {},
        "pending": [],
    }


NOTES: dict[str, Any] = fresh_notes()


def NOW_MS():  # noqa: N802 - replaced in tests
    return int(time.time() * 1000)


def schedule_file():
    return os.path.join(OUT_DIR, "schedule.json")


def run_marker():
    return os.path.join(OUT_DIR, ".running")


def clean_text(v, n):
    if not isinstance(v, str):
        return ""
    t = " ".join(re.sub(r"[\x00-\x1f\x7f]", " ", v).split())
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def _int_in(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def save_schedule():
    make_private()
    keep = {k: NOTES[k] for k in ("items", "prefs", "summary_at", "tasks_done", "sent", "flags")}
    fd = os.open(schedule_file(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(keep, f)


def load_schedule():
    with contextlib.suppress(Exception):
        with open(schedule_file(), encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            now = NOW_MS()
            set_schedule(
                {
                    "items": saved.get("items"),
                    "prefs": saved.get("prefs"),
                    "summaryAt": saved.get("summary_at"),
                    "tasksDone": saved.get("tasks_done"),
                },
                now,
                persist=False,
            )
            if isinstance(saved.get("sent"), dict):
                NOTES["sent"] = {
                    k: v for k, v in saved["sent"].items() if isinstance(k, str) and _int_in(v, now - HORIZON_MS, now + HORIZON_MS)
                }
            if isinstance(saved.get("flags"), dict):
                NOTES["flags"] = {k: v for k, v in saved["flags"].items() if isinstance(k, str) and isinstance(v, int)}


def set_schedule(body, now_ms, persist=True):
    """Replaces the schedule with what Keel sent. Anything malformed, in the past, more than 24 h ahead or too long
    is dropped; at most 50 items, soonest first. Returns how many were kept."""
    body = body if isinstance(body, dict) else {}
    items, seen = [], set()
    for it in body.get("items") if isinstance(body.get("items"), list) else []:
        if not isinstance(it, dict):
            continue
        id_, kind, at = clean_text(it.get("id"), 60), it.get("kind"), it.get("at")
        title = clean_text(it.get("title"), MAX_TITLE)
        if not id_ or id_ in seen or kind not in NOTE_KINDS or not title or not _int_in(at, now_ms - 60_000, now_ms + HORIZON_MS):
            continue
        seen.add(id_)
        items.append({"id": id_, "at": at, "kind": kind, "title": title, "body": clean_text(it.get("body"), MAX_TEXT)})
    items.sort(key=lambda i: i["at"])
    NOTES["items"] = items[:MAX_ITEMS]
    prefs = body.get("prefs") if isinstance(body.get("prefs"), dict) else {}
    for k in DEFAULT_PREFS:
        if isinstance(prefs.get(k), bool):
            NOTES["prefs"][k] = prefs[k]
    sa = body.get("summaryAt")
    NOTES["summary_at"] = sa if _int_in(sa, now_ms - 60_000, now_ms + HORIZON_MS) else None
    td = body.get("tasksDone")
    NOTES["tasks_done"] = td if _int_in(td, 0, 10_000) else 0
    if persist:
        with contextlib.suppress(Exception):
            save_schedule()
    return len(NOTES["items"])


def notify(title, body=""):
    """Shows a macOS notification. The text goes in as arguments to a fixed script, so a task title can never run
    as AppleScript. Never raises; the text is never logged."""
    try:
        cmd = [
            "/usr/bin/osascript",
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            title,
            body,
        ]
        return subprocess.run(cmd, capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def fmt_minutes(ms):
    m = int(round(ms / 60000))
    return f"{m // 60}h {m % 60}m" if m >= 60 else f"{m}m"


def tracked_today(now_ms):
    with LOCK:
        segs = list(STATE["data"].get("days", {}).get(day_key(now_ms), []))
    apps: dict[str, int] = {}
    for s in segs:
        apps[s["app"]] = apps.get(s["app"], 0) + max(0, s["e"] - s["s"])
    return sum(apps.values()), [a for a, _ in sorted(apps.items(), key=lambda x: -x[1])[:3]]


def start_marker():
    """Called at start-up. A marker left by the previous run means it didn't shut down cleanly."""
    if os.path.exists(run_marker()):
        NOTES["pending"].append(
            (
                "Keel tracker didn't shut down cleanly",
                "It's running again. Activity from just before may be missing; details are in ~/Keel Activity/tracker.log.",
            )
        )
    with contextlib.suppress(Exception):
        make_private()
        with open(run_marker(), "w") as f:
            f.write(str(os.getpid()))


def clean_stop(*_):
    with contextlib.suppress(OSError):
        os.remove(run_marker())


def check_notifications(now_ms):
    changed, prefs = False, NOTES["prefs"]

    def show(kind, title, body=""):
        if now_ms - NOTES["last_kind"].get(kind, -RATE_MS) < RATE_MS:
            return False
        NOTES["last_kind"][kind] = now_ms
        notify(title, body)
        return True

    for it in list(NOTES["items"]):
        if it["at"] > now_ms:
            break
        if it["id"] in NOTES["sent"] or now_ms - it["at"] > STALE_MS or not prefs.get(NOTE_KINDS[it["kind"]], True):
            NOTES["items"].remove(it)
            changed = True
            continue
        if show(it["kind"], it["title"], it["body"]):
            NOTES["items"].remove(it)
            NOTES["sent"][it["id"]] = it["at"]
            changed = True
    sa = NOTES["summary_at"]
    if sa is not None and sa <= now_ms:
        NOTES["summary_at"], changed = None, True
        flag = "summary:" + day_key(now_ms)
        if prefs.get("summary", True) and now_ms - sa <= STALE_MS and flag not in NOTES["flags"]:
            total, top = tracked_today(now_ms)
            n = NOTES["tasks_done"]
            most = f", most in {', '.join(top)}" if top else ""
            show("summary", "Your day in Keel", f"Tracked {fmt_minutes(total)}{most}. {n} task{'' if n == 1 else 's'} done.")
            NOTES["flags"][flag] = now_ms
    if prefs.get("tracker", True):
        while NOTES["pending"]:
            title, body = NOTES["pending"].pop(0)
            show("tracker", title, body)
        since = STATE.get("paused_since")
        if is_paused(now_ms) and since and now_ms - since >= PAUSE_ALERT_MS and ("pause:" + str(since)) not in NOTES["flags"]:
            if show(
                "tracker",
                "Keel tracking is still paused",
                f"Paused for {fmt_minutes(now_ms - since)}. Resume from the Keel sidebar, or run: keel_tracker.py resume",
            ):
                NOTES["flags"]["pause:" + str(since)], changed = now_ms, True
        day = day_key(now_ms)
        local_hour = datetime.datetime.fromtimestamp(now_ms / 1000).hour
        lp = NOTES["last_page"]
        if local_hour >= MIDDAY_HOUR and ("noconn:" + day) not in NOTES["flags"] and not (lp and day_key(lp) == day):
            if tracked_today(now_ms)[0] >= MIN_ACTIVE_MS and show(
                "tracker",
                "Keel hasn't connected today",
                "Your activity is being recorded, but no Keel page has loaded it yet. Open Keel in Chrome, Arc, Brave or Edge.",
            ):
                NOTES["flags"]["noconn:" + day], changed = now_ms, True
    else:
        NOTES["pending"].clear()
    if changed:
        NOTES["flags"] = {k: v for k, v in NOTES["flags"].items() if now_ms - v < 3 * HORIZON_MS}
        NOTES["sent"] = {k: v for k, v in NOTES["sent"].items() if now_ms - v < HORIZON_MS}
        with contextlib.suppress(Exception):
            save_schedule()


def run(cmd, timeout=3):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def idle_seconds():
    out = run(["ioreg", "-r", "-c", "IOHIDSystem", "-k", "HIDIdleTime", "-d", "1"])
    m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
    return int(m.group(1)) / 1e9 if m else 0.0


def front_app():
    asn = run(["lsappinfo", "front"])
    if not asn:
        return ""
    out = run(["lsappinfo", "info", "-only", "name", asn])
    m = re.search(r'"LSDisplayName"\s*=\s*"(.*?)"', out) or re.search(r'^"(.*?)"', out)
    return m.group(1) if m else ""


def browser_tab(app):
    """Returns (domain, title) of the active tab, or ("", "") if not readable."""
    if time.time() - _browser_fail.get(app, 0) < 600:
        return "", ""
    if app in SAFARI:
        script = (
            f'tell application "{app}" to if (count of windows) > 0 then '
            "return (URL of current tab of front window) & linefeed & (name of current tab of front window)"
        )
    elif app in CHROMIUM:
        script = (
            f'tell application "{app}" to if (count of windows) > 0 then '
            "return (URL of active tab of front window) & linefeed & (title of active tab of front window)"
        )
    else:
        return "", ""
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=4)
    except Exception:
        _browser_fail[app] = time.time()
        return "", ""
    if r.returncode != 0:
        _browser_fail[app] = time.time()
        return "", ""
    parts = r.stdout.strip().split("\n", 1)
    url = parts[0] if parts else ""
    title = parts[1] if len(parts) > 1 else ""
    m = re.match(r"^[a-z][a-z0-9+.-]*://([^/:?#]+)", url, re.I)
    domain = m.group(1).lower() if m else ""
    if domain.startswith("www."):
        domain = domain[4:]
    if url.startswith(("file:", "about:", "chrome:", "edge:", "brave:", "arc:")):
        domain = ""
    return domain, title[:TITLE_MAX]


def day_key(ms):
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def load():
    if not os.path.exists(OUT_FILE):
        return {"days": {}}
    with contextlib.suppress(Exception):
        with open(OUT_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("days"), dict):
            return data
    # Fix 65: the file exists but can't be read. Keep it aside (never overwrite history) and start a new one.
    kept = os.path.join(OUT_DIR, datetime.datetime.now().strftime("keel-activity.corrupt-%Y%m%d-%H%M%S.json"))
    try:
        os.replace(OUT_FILE, kept)
        log(f"The activity file couldn't be read. It was kept as {kept} and a new one was started.")
    except OSError as e:
        log(f"The activity file couldn't be read, and couldn't be kept aside either: {e}")
    return {"days": {}}


def log(msg, err=True):
    """One line for tracker.log (stdout/stderr under launchd). Paths are written from ~, so the log never holds the
    macOS user name (accepted risk A6, fixed 2026-11-15)."""
    text = str(msg).replace(HOME + os.sep, "~" + os.sep) if HOME and HOME != os.sep else str(msg)
    print(text, file=sys.stderr if err else sys.stdout, flush=True)


def where(e):
    """Error type and the tracker's own code location, without the message: a message can hold the data being
    parsed (an app name, a window title), and the log must not (Phase 13)."""
    tb, line = e.__traceback__, 0
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == __file__:
            line = tb.tb_lineno
        tb = tb.tb_next
    return f"{type(e).__name__} at keel_tracker.py line {line}"


def snapshot(data, max_days=None):
    max_days = min(max_days or keep_days(), keep_days())
    cutoff = (datetime.date.today() - datetime.timedelta(days=max_days)).isoformat()
    days = {k: [dict(s) for s in v if s["e"] - s["s"] >= 1000] for k, v in data["days"].items() if k >= cutoff}
    offset = -(time.altzone if time.localtime().tm_isdst else time.timezone) // 60
    return {
        "source": "keel-tracker",
        "version": VERSION,
        "device": socket.gethostname(),
        "updatedAt": int(time.time() * 1000),
        "tzOffsetMin": offset,
        "days": days,
    }


def _encode(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def save(data):
    with SAVE_LOCK:
        with LOCK:
            out = snapshot(data)
            data["days"] = {k: [s for s in data["days"][k] if s["e"] - s["s"] >= 1000 or s is STATE.get("cur")] for k in out["days"]}
        make_private()
        fd, tmp = tempfile.mkstemp(dir=OUT_DIR, prefix=".keel-activity-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, OUT_FILE)  # atomic: readers see the old or the new file, never a partial one
        except BaseException:
            with contextlib.suppress(OSError):
                os.remove(tmp)
            raise


def fsize(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def cleanup():
    """Keeps storage small: old days, old titles, file-size cap, log size, stray temp files."""
    cfg = load_config()
    data = STATE["data"]
    today = datetime.date.today()
    cutoff = (today - datetime.timedelta(days=cfg["keep_days"])).isoformat()
    title_cut = (today - datetime.timedelta(days=TITLE_DAYS)).isoformat()
    removed_days = 0
    with LOCK:
        for k in list(data["days"]):
            if k < cutoff:
                del data["days"][k]
                removed_days += 1
            elif k < title_cut:
                for seg in data["days"][k]:
                    seg.pop("title", None)
    save(data)
    cap = cfg["max_file_mb"] * 1_000_000
    while fsize(OUT_FILE) > cap:
        with LOCK:
            days = sorted(data["days"])
            if len(days) <= 1:
                break
            del data["days"][days[0]]
            removed_days += 1
        save(data)
    if fsize(LOG_FILE) > LOG_MAX:
        try:
            with open(LOG_FILE, "rb") as f:
                f.seek(-200_000, 2)
                tail = f.read()
            with open(LOG_FILE, "wb") as f:
                f.write(tail)
        except OSError:
            pass
    with SAVE_LOCK:  # no save is mid-write while stray temp files are removed
        for name in os.listdir(OUT_DIR):
            if name.endswith(".tmp"):
                with contextlib.suppress(OSError):
                    os.remove(os.path.join(OUT_DIR, name))
    STATE["last_cleanup"] = int(time.time() * 1000)
    return removed_days


def storage_obj():
    cfg = load_config()
    return {
        "fileBytes": fsize(OUT_FILE),
        "logBytes": fsize(LOG_FILE),
        "keepDays": cfg["keep_days"],
        "maxFileMb": cfg["max_file_mb"],
        "days": len(STATE["data"]["days"]),
        "lastCleanup": STATE.get("last_cleanup"),
    }


def status_obj():
    now_ms = int(time.time() * 1000)
    paused = is_paused(now_ms)
    with LOCK:
        segs = STATE["data"]["days"].get(day_key(now_ms), [])
        today = sum(s["e"] - s["s"] for s in segs)
    pu = STATE["paused_until"]
    return {
        "app": "keel-tracker",
        "version": VERSION,
        "running": True,
        "paused": paused,
        "pausedUntil": pu if paused and pu != -1 else None,
        "startedAt": STATE["started"],
        "current": None if paused or STATE["idle"] else STATE["current"],
        "idle": STATE["idle"],
        "todayMs": today,
        "device": socket.gethostname(),
        "now": now_ms,
        "storage": storage_obj(),
    }


def origin_allowed(origin):
    if re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", origin):
        return True
    return origin.rstrip("/") in [o.rstrip("/") for o in load_config()["allowed_origins"]]


MAX_BODY = 2 * 1024 * 1024  # bytes; the app sends a few dozen


def _no_constant(name):
    raise ValueError(f"{name} is not valid JSON")  # Python's json accepts NaN/Infinity; JSON doesn't


class Handler(BaseHTTPRequestHandler):
    server_version = "KeelTracker"
    timeout = 5  # seconds; a client that stops sending can't hold a thread forever (bug 28)

    def version_string(self):  # don't reveal the Python version
        return self.server_version

    def send_error(self, code, message=None, explain=None):
        """Errors raised by http.server itself (bad request line, unsupported method) as documented JSON."""
        self.close_connection = True
        body = json.dumps({"error": message or "Request not supported"}).encode("utf-8")
        self.send_response(code, message)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD" and code >= 200 and code not in (204, 304):
            self.wfile.write(body)

    def log_message(self, *args):
        pass

    def _check(self):
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return False, None
        origin = self.headers.get("Origin")
        if origin is None:
            return True, None
        return origin_allowed(origin), origin

    def _cors(self, origin):
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj, origin):
        self._send(code, _encode(obj), origin)

    def _send(self, code, body, origin):
        self.send_response(code)
        self._cors(origin)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        ok, origin = self._check()
        self.send_response(204 if ok else 403)
        if ok:
            self._cors(origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        self._safely(self._get)

    def do_POST(self):
        self._safely(self._post)

    def _safely(self, handler):
        """Fix 67: an unexpected error answers 500 with a JSON error (the documented contract) instead of dropping
        the connection, and is logged without request data."""
        try:
            handler()
        except Exception as e:
            log(f"API error on {self.command} {self.path.split('?')[0][:64]}: {where(e)}")
            origin = self.headers.get("Origin")
            with contextlib.suppress(Exception):  # the answer may already be partly sent; then the client sees a drop
                ok = origin if origin and origin_allowed(origin) else None
                self._json(500, {"error": "The tracker hit an error. Details are in ~/Keel Activity/tracker.log."}, ok)

    def _get(self):
        ok, origin = self._check()
        if not ok:
            return self._json(
                403,
                {"error": "This page isn't allowed to use the Keel tracker. Add it to allowed_origins in ~/Keel Activity/config.json."},
                None,
            )
        path = self.path.split("?")[0]
        if origin and path in ("/status", "/activity"):
            NOTES["last_page"] = NOW_MS()  # a Keel page connected (for the "hasn't connected today" alert)
        if path == "/status":
            return self._json(200, status_obj(), origin)
        if path == "/activity":
            m = re.search(r"days=(\d+)", self.path)
            n = min(KEEP_DAYS, int(m.group(1))) if m else KEEP_DAYS
            with ACTIVITY_LOCK:
                with LOCK:
                    snap = snapshot(STATE["data"], n)
                body = _encode(snap)
                del snap  # free the copy before the next request builds one
            return self._send(200, body, origin)
        return self._json(404, {"error": "Not found"}, origin)

    def _post(self):
        ok, origin = self._check()
        if not ok:
            return self._json(403, {"error": "Not allowed"}, None)
        raw_len = (self.headers.get("Content-Length") or "0").strip()
        if not raw_len.isdigit():  # negative or not a number (bug 28)
            return self._json(400, {"error": "Bad Content-Length"}, origin)
        length = int(raw_len)
        if length > MAX_BODY:
            return self._json(413, {"error": "Request body too large"}, origin)
        try:
            body = json.loads(self.rfile.read(length) or b"{}", parse_constant=_no_constant) if length else {}
        except Exception:  # malformed JSON is treated as an empty body (see docs/tracker-api.md)
            body = {}
        path = self.path.split("?")[0]
        if path == "/pause":
            minutes = body.get("minutes") if isinstance(body, dict) else None
            ok = isinstance(minutes, (int, float)) and not isinstance(minutes, bool) and math.isfinite(minutes) and minutes > 0
            until = int(time.time() * 1000 + float(minutes) * 60000) if ok else -1  # bug 29: 1e400 parses as infinity
            set_pause(until)
            return self._json(200, status_obj(), origin)
        if path == "/resume":
            set_pause(None)
            return self._json(200, status_obj(), origin)
        if path == "/cleanup":
            removed = cleanup()
            out = status_obj()
            out["removedDays"] = removed
            return self._json(200, out, origin)
        if path == "/schedule":
            n = set_schedule(body, NOW_MS())
            return self._json(200, {"scheduled": n, "prefs": NOTES["prefs"]}, origin)
        if path == "/settings":
            cfg = load_config()
            kd = body.get("keepDays") if isinstance(body, dict) else None
            mb = body.get("maxFileMb") if isinstance(body, dict) else None
            if isinstance(kd, int) and 1 <= kd <= 365:
                cfg["keep_days"] = kd
            if isinstance(mb, (int, float)) and 1 <= mb <= 500:
                cfg["max_file_mb"] = mb
            save_config(cfg)
            cleanup()
            return self._json(200, status_obj(), origin)
        return self._json(404, {"error": "Not found"}, origin)


class Server(ThreadingHTTPServer):
    # Accepted risk A5, fixed 2026-11-15: Python's default queue of 5 waiting connections made bursts of 16-32
    # clients wait 1 s for a TCP retry. 64 holds any realistic burst from open tabs.
    request_queue_size = 64
    daemon_threads = True


def serve():
    try:
        srv = Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        log(f"Couldn't start the local API on port {PORT}: {e}")
        return None
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log(f"Local API on http://127.0.0.1:{PORT}", err=False)
    return srv


def track():
    make_private()
    data = load()
    STATE["data"] = data
    cfg = load_config()
    if not os.path.exists(CONFIG_FILE):
        save_config(cfg)
    STATE["paused_until"] = cfg.get("paused_until")
    STATE["paused_since"] = int(time.time() * 1000) if STATE["paused_until"] is not None else None
    load_schedule()
    start_marker()
    with contextlib.suppress(Exception):  # launchd stops the tracker with SIGTERM: a clean stop
        import signal

        signal.signal(signal.SIGTERM, lambda *_: (clean_stop(), sys.exit(0)))
    serve()
    try:
        cleanup()
    except Exception as e:
        log(f"Cleanup failed: {e}")
    last_clean = time.time()
    cur, cur_key, last_save = None, None, 0.0
    last_err: dict[str, float] = {}
    log(f"Keel tracker running. Writing to {OUT_FILE}", err=False)
    while True:
        now = time.time()
        now_ms = int(now * 1000)
        try:
            check_notifications(now_ms)
        except Exception as e:
            msg = where(e)
            if now - last_err.get(msg, 0) >= 60:
                log(f"Skipped a notification check: {msg}")
                last_err[msg] = now
        if now - last_clean >= CLEAN_EVERY:
            try:
                cleanup()
            except Exception as e:
                log(f"Cleanup failed: {e}")
            last_clean = now
        if is_paused(now_ms):
            cur, cur_key = None, None
            STATE["current"] = None
            STATE["cur"] = None
            if now - last_save >= SAVE_EVERY:
                try:
                    save(data)
                except Exception as e:
                    log(f"Couldn't write activity file: {e}")
                last_save = now
            time.sleep(INTERVAL)
            continue
        try:  # fix 66: one bad sample (an answer a parser didn't foresee) must not end tracking
            idle = idle_seconds()
            STATE["idle"] = idle >= IDLE_LIMIT
            if idle >= IDLE_LIMIT:
                if cur:
                    cur["e"] = max(cur["s"], min(cur["e"], int((now - idle) * 1000)))
                cur, cur_key = None, None
            else:
                app = front_app()
                if app and app not in ("loginwindow", "ScreenSaverEngine"):
                    domain, title = browser_tab(app) if (app in CHROMIUM or app in SAFARI) else ("", "")
                    key = (app, domain, title)
                    same_day = cur is not None and day_key(cur["s"]) == day_key(now_ms)
                    STATE["current"] = {"app": app, "domain": domain}
                    if cur and key == cur_key and same_day and now_ms - cur["e"] <= INTERVAL * 3000:
                        with LOCK:
                            cur["e"] = now_ms
                    else:
                        if cur and now_ms - cur["e"] <= INTERVAL * 3000:
                            cur["e"] = now_ms
                        seg = {"s": now_ms, "e": now_ms, "app": app}
                        if domain:
                            seg["domain"] = domain
                        if title:
                            seg["title"] = title
                        with LOCK:
                            data["days"].setdefault(day_key(now_ms), []).append(seg)
                        cur, cur_key = seg, key
                        STATE["cur"] = seg
        except Exception as e:
            msg = where(e)
            if now - last_err.get(msg, 0) >= 60:  # at most once a minute for the same error
                log(f"Skipped one activity sample: {msg}")
                last_err[msg] = now
        if now - last_save >= SAVE_EVERY:
            try:
                save(data)
            except Exception as e:
                log(f"Couldn't write activity file: {e}")
            last_save = now
        time.sleep(INTERVAL)


def install():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(PLIST), exist_ok=True)
    script = os.path.abspath(__file__)
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{sys.executable}</string><string>{script}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{LOG_FILE}</string>
  <key>StandardErrorPath</key><string>{LOG_FILE}</string>
</dict></plist>
"""
    uid = os.getuid()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
    with open(PLIST, "w") as f:
        f.write(plist)
    r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", PLIST], capture_output=True, text=True)
    if r.returncode != 0:
        subprocess.run(["launchctl", "load", "-w", PLIST], capture_output=True)
    print("Keel tracker installed. It's running now and will start at every login.")
    print(f"Activity file: {OUT_FILE}")


def uninstall():
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    if os.path.exists(PLIST):
        os.remove(PLIST)
    print("Keel tracker stopped and removed from login items. Your activity file was kept.")


def api(method, path, body=None):
    import urllib.request

    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}",
        method=method,
        data=json.dumps(body or {}).encode() if method == "POST" else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=3) as r:  # noqa: S310 - fixed http://127.0.0.1 URL built above
        return json.loads(r.read())


def pause_cmd():
    try:
        mins = float(sys.argv[2]) if len(sys.argv) > 2 else None
        s = api("POST", "/pause", {"minutes": mins} if mins else {})
        print("Paused" + (f" for {mins:g} minutes" if mins else " until you resume") if s.get("paused") else "Not paused")
    except Exception:
        print("The tracker isn't running. Start it with: python3 keel_tracker.py install")


def resume_cmd():
    try:
        api("POST", "/resume")
        print("Tracking resumed")
    except Exception:
        print("The tracker isn't running. Start it with: python3 keel_tracker.py install")


def cleanup_cmd():
    try:
        s = api("POST", "/cleanup")
        st = s["storage"]
        print(
            f"Cleaned up. Removed {s.get('removedDays', 0)} old day(s). "
            f"Activity file {st['fileBytes'] / 1e6:.2f} MB, keeping {st['keepDays']} days."
        )
    except Exception:
        STATE["data"] = load()
        n = cleanup()
        print(f"Cleaned up the file directly (tracker not running). Removed {n} old day(s).")


def status():
    r = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], capture_output=True, text=True)
    running = r.returncode == 0 and "state = running" in r.stdout
    paused = False
    with contextlib.suppress(Exception):  # tracker not running: report "Not running" below
        paused = api("GET", "/status").get("paused")
    print(("Paused" if paused else "Running") if running else "Not running")
    data = load()
    today = datetime.date.today().isoformat()
    segs = data["days"].get(today, [])
    total = sum(s["e"] - s["s"] for s in segs) / 60000
    print(f"Today: {total:.0f} min across {len(segs)} segments")
    apps = {}
    for s in segs:
        apps[s["app"]] = apps.get(s["app"], 0) + (s["e"] - s["s"]) / 60000
    for a, m in sorted(apps.items(), key=lambda x: -x[1])[:8]:
        print(f"  {a}: {m:.0f} min")


def run_tracker():
    try:
        track()
    except KeyboardInterrupt:  # Ctrl-C in Terminal is a clean stop
        clean_stop()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    {
        "install": install,
        "uninstall": uninstall,
        "status": status,
        "run": run_tracker,
        "pause": pause_cmd,
        "resume": resume_cmd,
        "cleanup": cleanup_cmd,
    }.get(cmd, run_tracker)()
