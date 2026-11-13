"""Phase 6: who can use the tracker's local API, and what malformed requests do.

Keel has no accounts or roles. The "roles" are the kinds of caller that can reach 127.0.0.1:47821:
  - the owner's Keel site (an allowed origin) and local development pages (http://localhost / 127.0.0.1 on any port)
  - a local program with no Origin header (the `keel_tracker.py pause` command, curl)
  - every other website open in the owner's browser (CSRF), including look-alike origins
  - a DNS-rebinding page, whose requests carry a foreign Host header
Every action is tried by every caller. A blocked call must return 403, carry no CORS grant, and change nothing.
"""

import copy
import json

import pytest

from test_tracker_api import seed

OWNER = "https://cloudregh.github.io"

ALLOWED = {
    "owner site": {"origin": OWNER},
    "local dev page": {"origin": "http://localhost:5173"},
    "local dev page (IP)": {"origin": "http://127.0.0.1:8000"},
    "local program (no Origin)": {},
}
BLOCKED = {
    "other website": {"origin": "https://evil.example"},
    "opaque origin (sandbox, file://)": {"origin": "null"},
    "look-alike: suffix": {"origin": "https://cloudregh.github.io.evil.example"},
    "look-alike: subdomain": {"origin": "https://evil.cloudregh.github.io"},
    "look-alike: http": {"origin": "http://cloudregh.github.io"},
    "look-alike: port": {"origin": "https://cloudregh.github.io:8443"},
    "look-alike: localhost suffix": {"origin": "http://localhost.evil.example"},
    "look-alike: 127.0.0.1 suffix": {"origin": "http://127.0.0.1.evil.example"},
    "look-alike: https localhost": {"origin": "https://localhost"},
    "DNS rebinding (owner Origin)": {"origin": OWNER, "host": "evil.example:{port}"},
    "DNS rebinding (no Origin)": {"host": "evil.example:{port}"},
    "wrong port in Host": {"origin": OWNER, "host": "127.0.0.1:1"},
}
ACTIONS = [
    ("GET", "/status", None),
    ("GET", "/activity", None),
    ("POST", "/pause", {"minutes": 30}),
    ("POST", "/resume", {}),
    ("POST", "/cleanup", {}),
    ("POST", "/settings", {"keepDays": 2, "maxFileMb": 1}),
    ("OPTIONS", "/pause", None),
]


def world(kt):
    """Everything an action could change: config, pause state, recorded activity."""
    with open(kt.CONFIG_FILE, encoding="utf-8") as f:
        cfg = f.read()
    return cfg, kt.STATE["paused_until"], json.dumps(kt.STATE["data"], sort_keys=True)


def call(server, method, path, body, who):
    host = who.get("host")
    return server.request(method, path, body=body, origin=who.get("origin"), host=host.format(port=server.port) if host else None)


@pytest.fixture
def ready(server, kt):
    seed(kt, 40)
    kt.set_pause(None)  # writes config.json, so there is a file to compare
    return server


@pytest.mark.parametrize("who", list(BLOCKED), ids=list(BLOCKED))
@pytest.mark.parametrize("action", ACTIONS, ids=[f"{m} {p}" for m, p, _ in ACTIONS])
def test_blocked_callers_get_403_and_change_nothing(ready, kt, who, action):
    method, path, body = action
    before = copy.deepcopy(world(kt))
    code, headers, _ = call(ready, method, path, body, BLOCKED[who])
    assert code == 403
    assert "access-control-allow-origin" not in headers
    assert world(kt) == before


@pytest.mark.parametrize("who", list(ALLOWED), ids=list(ALLOWED))
@pytest.mark.parametrize("action", ACTIONS, ids=[f"{m} {p}" for m, p, _ in ACTIONS])
def test_allowed_callers_succeed(ready, kt, who, action):
    method, path, body = action
    code, headers, _ = call(ready, method, path, body, ALLOWED[who])
    assert code == (204 if method == "OPTIONS" else 200)
    origin = ALLOWED[who].get("origin")
    if origin:
        assert headers["access-control-allow-origin"] == origin  # echoes the caller, never "*"
        assert headers["vary"] == "Origin"
    else:
        assert "access-control-allow-origin" not in headers


def test_a_cross_site_form_post_cannot_pause_tracking(ready, kt):
    """A hidden <form method=post> on another site: browsers send its Origin, and text/plain bodies."""
    before = world(kt)
    code, _, _ = ready.request(
        "POST", "/pause", raw_body=b"minutes=600", origin="https://evil.example", headers={"Content-Type": "text/plain"}
    )
    assert code == 403
    assert world(kt) == before


# ---- malformed requests: refused cleanly, and the server keeps serving ----


@pytest.mark.parametrize(
    "headers,body",
    [
        ({"Content-Length": "-1"}, b""),
        ({"Content-Length": "abc"}, b""),
        ({"Content-Length": "99999999999"}, b"{}"),
    ],
    ids=["negative length", "non-numeric length", "huge length, tiny body"],
)
def test_bad_content_length_is_refused_and_server_survives(ready, headers, body):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", ready.port, timeout=3)
    conn.putrequest("POST", "/pause", skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", f"127.0.0.1:{ready.port}")
    conn.putheader("Origin", OWNER)
    for k, v in headers.items():
        conn.putheader(k, v)
    conn.endheaders()
    conn.send(body)
    try:
        status = conn.getresponse().status
    except Exception as e:  # no response at all counts as a failure
        status = repr(e)
    conn.close()
    assert status in (400, 411, 413)
    assert ready.request("GET", "/status", origin=OWNER)[0] == 200


def test_oversized_body_is_refused(ready, kt):
    """Bug 28: bodies over 2 MB are refused before being read (the contract keeps a 1.2 MB body working).
    The server answers without reading, so the client sends the headers and the start of the body only."""
    import http.client

    before = world(kt)
    conn = http.client.HTTPConnection("127.0.0.1", ready.port, timeout=3)
    conn.putrequest("POST", "/settings", skip_host=True, skip_accept_encoding=True)
    for k, v in {
        "Host": f"127.0.0.1:{ready.port}",
        "Origin": OWNER,
        "Content-Type": "application/json",
        "Content-Length": str(3 * 1024 * 1024),
    }.items():
        conn.putheader(k, v)
    conn.endheaders()
    conn.send(b'{"keepDays": 2, "pad": "' + b"x" * 1000)
    code = conn.getresponse().status
    conn.close()
    assert code == 413
    assert world(kt) == before
    assert ready.request("GET", "/status", origin=OWNER)[0] == 200


@pytest.mark.parametrize("raw", [b'{"minutes": Infinity}', b'{"minutes": -Infinity}', b'{"minutes": NaN}', b'{"minutes": 1e400}'])
def test_non_finite_pause_minutes_follow_the_contract_without_crashing(ready, kt, raw):
    """Bug 29. Per docs/tracker-api.md, anything but a positive number pauses until resumed. Before the fix these
    crashed the request (Infinity, 1e400) or slipped through as a number (NaN)."""
    code, _, body = ready.request("POST", "/pause", raw_body=raw, origin=OWNER)
    assert code == 200, body
    assert body["paused"] is True and body["pausedUntil"] is None
    assert kt.STATE["paused_until"] == -1
    assert ready.request("GET", "/status", origin=OWNER)[0] == 200


def test_json_responses_are_not_sniffable(ready):
    for method, path in [("GET", "/status"), ("GET", "/activity"), ("GET", "/nope")]:
        _, headers, _ = ready.request(method, path, origin=OWNER)
        assert headers.get("x-content-type-options") == "nosniff", path


def test_data_folder_and_files_are_private(kt):
    """Bug 33: folder 0700, config/log/activity 0600, including files left 0644 by an older version."""
    import os
    import stat

    os.makedirs(kt.OUT_DIR, mode=0o755, exist_ok=True)
    os.chmod(kt.OUT_DIR, 0o755)  # noqa: S103 -- deliberately recreates the old, too-open folder
    for path in (kt.CONFIG_FILE, kt.LOG_FILE):
        with open(path, "w") as f:
            f.write("{}")
        os.chmod(path, 0o644)
    kt.save_config(kt.load_config())
    kt.save({"days": {}})
    mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)  # noqa: E731
    assert mode(kt.OUT_DIR) == 0o700
    for path in (kt.CONFIG_FILE, kt.LOG_FILE, kt.OUT_FILE):
        assert mode(path) == 0o600, path
