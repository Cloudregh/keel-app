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
    cfg = load_config()
    cfg["paused_until"] = until
    with contextlib.suppress(Exception):  # pausing still works in memory if the config can't be written
        save_config(cfg)


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
        print(f"The activity file couldn't be read. It was kept as {kept} and a new one was started.", file=sys.stderr, flush=True)
    except OSError as e:
        print(f"The activity file couldn't be read, and couldn't be kept aside either: {e}", file=sys.stderr, flush=True)
    return {"days": {}}


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
            print(f"API error on {self.command} {self.path.split('?')[0][:64]}: {where(e)}", file=sys.stderr, flush=True)
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


def serve():
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print(f"Couldn't start the local API on port {PORT}: {e}", file=sys.stderr, flush=True)
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Local API on http://127.0.0.1:{PORT}", flush=True)


def track():
    make_private()
    data = load()
    STATE["data"] = data
    cfg = load_config()
    if not os.path.exists(CONFIG_FILE):
        save_config(cfg)
    STATE["paused_until"] = cfg.get("paused_until")
    serve()
    try:
        cleanup()
    except Exception as e:
        print(f"Cleanup failed: {e}", file=sys.stderr, flush=True)
    last_clean = time.time()
    cur, cur_key, last_save = None, None, 0.0
    last_err: dict[str, float] = {}
    print(f"Keel tracker running. Writing to {OUT_FILE}", flush=True)
    while True:
        now = time.time()
        now_ms = int(now * 1000)
        if now - last_clean >= CLEAN_EVERY:
            try:
                cleanup()
            except Exception as e:
                print(f"Cleanup failed: {e}", file=sys.stderr, flush=True)
            last_clean = now
        if is_paused(now_ms):
            cur, cur_key = None, None
            STATE["current"] = None
            STATE["cur"] = None
            if now - last_save >= SAVE_EVERY:
                try:
                    save(data)
                except Exception as e:
                    print(f"Couldn't write activity file: {e}", file=sys.stderr, flush=True)
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
                print(f"Skipped one activity sample: {msg}", file=sys.stderr, flush=True)
                last_err[msg] = now
        if now - last_save >= SAVE_EVERY:
            try:
                save(data)
            except Exception as e:
                print(f"Couldn't write activity file: {e}", file=sys.stderr, flush=True)
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


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    {
        "install": install,
        "uninstall": uninstall,
        "status": status,
        "run": track,
        "pause": pause_cmd,
        "resume": resume_cmd,
        "cleanup": cleanup_cmd,
    }.get(cmd, track)()
