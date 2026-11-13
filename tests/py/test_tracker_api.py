"""API tests for every tracker endpoint: success, every error code, access rules, contract (docs/tracker-api.md),
error-message hygiene and concurrency."""

import json
import os
import threading
import time

import pytest

GOOD = "https://cloudregh.github.io"
EVIL = "https://evil.example"


# ---------- contract helpers (docs/tracker-api.md) ----------

STATUS_KEYS = {"app", "version", "running", "paused", "pausedUntil", "startedAt", "current", "idle", "todayMs", "device", "now", "storage"}
STORAGE_KEYS = {"fileBytes", "logBytes", "keepDays", "maxFileMb", "days", "lastCleanup"}


def assert_status(s):
    assert set(s) == STATUS_KEYS, set(s) ^ STATUS_KEYS
    assert s["app"] == "keel-tracker" and s["version"] == 2 and s["running"] is True
    assert isinstance(s["paused"], bool) and isinstance(s["idle"], bool)
    assert s["pausedUntil"] is None or isinstance(s["pausedUntil"], int)
    assert isinstance(s["startedAt"], int) and isinstance(s["now"], int) and isinstance(s["todayMs"], int)
    assert s["current"] is None or (set(s["current"]) == {"app", "domain"} and all(isinstance(v, str) for v in s["current"].values()))
    assert isinstance(s["device"], str)
    assert set(s["storage"]) == STORAGE_KEYS
    st = s["storage"]
    assert all(isinstance(st[k], int) for k in ("fileBytes", "logBytes", "keepDays", "days"))
    assert isinstance(st["maxFileMb"], (int, float))
    assert st["lastCleanup"] is None or isinstance(st["lastCleanup"], int)


def assert_activity(a):
    assert set(a) == {"source", "version", "device", "updatedAt", "tzOffsetMin", "days"}
    assert a["source"] == "keel-tracker" and a["version"] == 2
    for k, segs in a["days"].items():
        assert len(k) == 10 and k[4] == "-" and k[7] == "-"
        for s in segs:
            assert set(s) <= {"s", "e", "app", "domain", "title"} and {"s", "e", "app"} <= set(s)
            assert isinstance(s["s"], int) and isinstance(s["e"], int) and s["e"] - s["s"] >= 1000
            assert "domain" not in s or (s["domain"] == s["domain"].lower() and not s["domain"].startswith("www."))
            assert "title" not in s or len(s["title"]) <= 90


def assert_json_headers(h):
    assert h["content-type"] == "application/json; charset=utf-8"
    assert h["cache-control"] == "no-store"


def assert_cors(h, origin):
    assert h["access-control-allow-origin"] == origin
    assert h["vary"] == "Origin"
    assert h["access-control-allow-private-network"] == "true"


def no_internals(body):
    text = json.dumps(body)
    leaks = ("Traceback", 'File "', "keel_tracker.py", "Exception", "/Users/", "/tmp/")  # noqa: S108 - strings searched for, not paths used
    for leak in leaks:
        assert leak not in text, f"internal detail leaked: {leak}"


# ---------- GET /status ----------


def test_status_from_allowed_origin(server):
    code, h, body = server.request("GET", "/status", origin=GOOD)
    assert code == 200
    assert_json_headers(h)
    assert_cors(h, GOOD)
    assert_status(body)


def test_status_without_origin_is_allowed_for_cli(server):
    code, h, body = server.request("GET", "/status")
    assert code == 200
    assert "access-control-allow-origin" not in h
    assert_status(body)


def test_status_with_query_string(server):
    assert server.request("GET", "/status?x=1", origin=GOOD)[0] == 200


@pytest.mark.parametrize("origin", [EVIL, "null", "http://localhost.evil.com", "https://cloudregh.github.io.evil.com"])
def test_status_from_disallowed_origin_is_403(server, origin):
    code, h, body = server.request("GET", "/status", origin=origin)
    assert code == 403
    assert "access-control-allow-origin" not in h
    assert set(body) == {"error"}
    no_internals(body)


@pytest.mark.parametrize("host", ["evil.example", "evil.example:{port}", "127.0.0.1", "localhost:1", "", "127.0.0.1:{port}.evil.com"])
def test_wrong_host_header_is_403_dns_rebinding(server, host):
    code, h, body = server.request("GET", "/status", host=host.format(port=server.port) if host else " ")
    assert code == 403
    assert "access-control-allow-origin" not in h


def test_localhost_host_header_is_allowed(server):
    assert server.request("GET", "/status", host=f"localhost:{server.port}")[0] == 200


def test_allowed_origin_from_config_file(server, kt):
    kt.save_config({"allowed_origins": ["https://my.domain"], "keep_days": 30, "max_file_mb": 20})
    assert server.request("GET", "/status", origin="https://my.domain")[0] == 200
    assert server.request("GET", "/status", origin=GOOD)[0] == 403  # default replaced by config


# ---------- GET /activity ----------


def seed(kt, days):
    import datetime

    out = {}
    for i in range(days):
        d = (datetime.date.today() - datetime.timedelta(days=i)).isoformat()
        base = int(datetime.datetime.fromisoformat(d + "T10:00:00").timestamp() * 1000)
        out[d] = [
            {"s": base, "e": base + 60_000, "app": "Safari", "domain": "x.com", "title": "t"},
            {"s": base, "e": base + 10, "app": "Blip"},
        ]
    kt.STATE["data"] = {"days": out}


def test_activity_default_returns_keep_days(server, kt):
    seed(kt, 40)
    code, h, body = server.request("GET", "/activity", origin=GOOD)
    assert code == 200
    assert_json_headers(h)
    assert_activity(body)
    assert len(body["days"]) == 31
    assert all(len(v) == 1 for v in body["days"].values())  # sub-second blips filtered


@pytest.mark.parametrize("q, n", [("?days=0", 31), ("?days=1", 2), ("?days=7", 8), ("?days=999", 31), ("?days=abc", 31), ("?days=-3", 31)])
def test_activity_days_param(server, kt, q, n):
    seed(kt, 40)
    code, _, body = server.request("GET", "/activity" + q, origin=GOOD)
    assert code == 200 and len(body["days"]) == n


def test_activity_from_disallowed_origin_is_403_and_leaks_nothing(server, kt):
    seed(kt, 2)
    code, _, body = server.request("GET", "/activity", origin=EVIL)
    assert code == 403 and "days" not in body


# ---------- POST /pause, /resume ----------


def test_pause_indefinitely(server, kt):
    code, h, body = server.request("POST", "/pause", body={}, origin=GOOD)
    assert code == 200
    assert_cors(h, GOOD)
    assert_status(body)
    assert body["paused"] is True and body["pausedUntil"] is None
    assert kt.load_config()["paused_until"] == -1


def test_pause_for_minutes(server):
    before = int(time.time() * 1000)
    code, _, body = server.request("POST", "/pause", body={"minutes": 15}, origin=GOOD)
    assert code == 200 and body["paused"] is True
    assert before + 15 * 60_000 <= body["pausedUntil"] <= before + 15 * 60_000 + 5_000


@pytest.mark.parametrize("bad", [{"minutes": -5}, {"minutes": 0}, {"minutes": "10"}, {"minutes": None}, [1, 2]])
def test_pause_with_invalid_minutes_pauses_until_resume(server, bad):
    code, _, body = server.request("POST", "/pause", body=bad, origin=GOOD)
    assert code == 200 and body["paused"] is True and body["pausedUntil"] is None


def test_pause_with_malformed_json_body(server):
    code, _, body = server.request("POST", "/pause", raw_body=b"{nope", origin=GOOD)
    assert code == 200 and body["paused"] is True


def test_pause_with_no_body(server):
    code, _, body = server.request("POST", "/pause", origin=GOOD)
    assert code == 200 and body["paused"] is True


def test_resume(server):
    server.request("POST", "/pause", body={}, origin=GOOD)
    code, _, body = server.request("POST", "/resume", origin=GOOD)
    assert code == 200 and body["paused"] is False


def test_pause_is_idempotent_on_double_submit(server, kt):
    a = server.request("POST", "/pause", body={}, origin=GOOD)[2]
    b = server.request("POST", "/pause", body={}, origin=GOOD)[2]
    assert a["paused"] is b["paused"] is True
    assert kt.load_config()["paused_until"] == -1


@pytest.mark.parametrize("path", ["/pause", "/resume", "/cleanup", "/settings"])
def test_post_from_disallowed_origin_is_403_and_changes_nothing(server, kt, path):
    seed(kt, 40)
    kt.save_config({"allowed_origins": [GOOD], "keep_days": 30, "max_file_mb": 20})
    cfg_before = open(kt.CONFIG_FILE).read()
    days_before = len(kt.STATE["data"]["days"])
    code, h, body = server.request("POST", path, body={"keepDays": 1}, origin=EVIL)
    assert code == 403 and "access-control-allow-origin" not in h
    assert kt.is_paused() is False
    assert open(kt.CONFIG_FILE).read() == cfg_before
    assert len(kt.STATE["data"]["days"]) == days_before


def test_post_with_wrong_host_changes_nothing(server, kt):
    code, _, _ = server.request("POST", "/pause", body={}, host="evil.example")
    assert code == 403 and kt.is_paused() is False


# ---------- POST /cleanup, /settings ----------


def test_cleanup_endpoint(server, kt):
    seed(kt, 40)
    code, _, body = server.request("POST", "/cleanup", origin=GOOD)
    assert code == 200
    assert body["removedDays"] == 9
    body.pop("removedDays")
    assert_status(body)
    assert body["storage"]["lastCleanup"] is not None


def test_settings_valid(server, kt):
    seed(kt, 40)
    code, _, body = server.request("POST", "/settings", body={"keepDays": 7, "maxFileMb": 5}, origin=GOOD)
    assert code == 200
    assert body["storage"]["keepDays"] == 7 and body["storage"]["maxFileMb"] == 5
    assert len(kt.STATE["data"]["days"]) == 8  # cleanup ran with the new setting


@pytest.mark.parametrize(
    "bad", [{"keepDays": 0}, {"keepDays": 366}, {"keepDays": "7"}, {"keepDays": 7.5}, {"maxFileMb": 0}, {"maxFileMb": 501}, {}]
)
def test_settings_invalid_values_are_ignored(server, kt, bad):
    code, _, body = server.request("POST", "/settings", body=bad, origin=GOOD)
    assert code == 200
    assert body["storage"]["keepDays"] == 30 and body["storage"]["maxFileMb"] == 20


# ---------- OPTIONS / 404 / errors ----------


def test_preflight_allowed(server):
    code, h, _ = server.request(
        "OPTIONS",
        "/pause",
        origin=GOOD,
        headers={"Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"},
    )
    assert code == 204
    assert_cors(h, GOOD)
    assert h["access-control-allow-methods"] == "GET, POST, OPTIONS"
    assert h["access-control-allow-headers"] == "Content-Type"
    assert h["access-control-max-age"] == "600"


def test_preflight_disallowed(server):
    code, h, _ = server.request("OPTIONS", "/pause", origin=EVIL)
    assert code == 403 and "access-control-allow-origin" not in h


@pytest.mark.parametrize(
    "method, path", [("GET", "/"), ("GET", "/nope"), ("POST", "/status"), ("POST", "/nope"), ("GET", "/../../etc/passwd")]
)
def test_unknown_paths_are_404_json(server, method, path):
    code, h, body = server.request(method, path, origin=GOOD)
    assert code == 404
    assert_json_headers(h)
    assert body == {"error": "Not found"}


@pytest.mark.parametrize("method", ["PUT", "DELETE", "PATCH"])
def test_unsupported_methods_are_rejected_with_json_error(server, method):
    """Contract (docs/tracker-api.md): every response body is JSON with no internals."""
    code, h, body = server.request(method, "/status", origin=GOOD)
    assert code in (405, 501)
    assert "Traceback" not in str(body)
    assert_json_headers(h)
    assert isinstance(body, dict) and set(body) == {"error"}


def test_server_header_does_not_reveal_python_version(server):
    _, h, _ = server.request("GET", "/status", origin=GOOD)
    assert "Python" not in h.get("server", "")


def test_huge_body_does_not_crash(server):
    code, _, body = server.request("POST", "/pause", raw_body=b"{" + b'"a":1,' * 200_000 + b'"minutes":1}', origin=GOOD)
    assert code == 200 and body["paused"] is True
    assert server.request("GET", "/status", origin=GOOD)[0] == 200


def test_errors_never_leak_internals(server):
    for args in [("GET", "/status", None, EVIL), ("GET", "/x", None, GOOD), ("POST", "/pause", None, EVIL)]:
        no_internals(server.request(*args[:2], body=args[2], origin=args[3])[2])


# ---------- concurrency ----------


def test_concurrent_pause_resume_cleanup_keep_file_valid(server, kt):
    seed(kt, 35)
    errors = []

    def hammer(path, n):
        for _ in range(n):
            code = server.request("POST", path, body={}, origin=GOOD)[0]
            if code != 200:
                errors.append((path, code))

    def writer():
        for _ in range(40):
            try:
                kt.save(kt.STATE["data"])
            except Exception as e:  # a failed save is a bug: the tracker would lose this write
                errors.append(("save", repr(e)))

    threads = [threading.Thread(target=hammer, args=(p, 15)) for p in ("/pause", "/resume", "/cleanup", "/pause")] + [
        threading.Thread(target=writer)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert errors == []
    data = json.load(open(kt.OUT_FILE))  # never partially written
    assert_activity(data)
    assert not [f for f in os.listdir(kt.OUT_DIR) if f.endswith(".tmp")]
    assert server.request("GET", "/status", origin=GOOD)[0] == 200


def test_reader_never_sees_a_partial_file(kt):
    seed(kt, 30)
    kt.save(kt.STATE["data"])
    stop = threading.Event()
    bad = []

    def reader():
        while not stop.is_set():
            try:
                json.load(open(kt.OUT_FILE))
            except ValueError as e:
                bad.append(e)

    r = threading.Thread(target=reader)
    r.start()
    for _ in range(60):
        kt.save(kt.STATE["data"])
    stop.set()
    r.join()
    assert bad == []


def test_concurrent_saves_from_two_threads(kt):
    """The tracker saves from its main loop while API requests (/cleanup, /settings) also save."""
    seed(kt, 30)
    errors = []

    def saver():
        for _ in range(50):
            try:
                kt.save(kt.STATE["data"])
            except Exception as e:
                errors.append(repr(e))

    ts = [threading.Thread(target=saver) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(30)
    assert errors == [], errors[:3]
    assert_activity(json.load(open(kt.OUT_FILE)))
