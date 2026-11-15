"""Phase 13: nothing private reaches the tracker's log.

Under launchd the tracker's stdout and stderr go to ~/Keel Activity/tracker.log. This plants private-looking
values everywhere the tracker sees data (app names, sites, window titles, request bodies, query strings, Origin
headers, a token-like string), then drives the tracking loop and every API and error path that can print, and
searches the full captured output for any planted value. Approved log content (docs/resilience.md): start-up
lines, the activity file's path, and error messages about the tracker's own files.
"""

import json
import socket

from test_tracker_integration import run_loop, scripted

GOOD = "https://cloudregh.github.io"
PLANTED = {
    "app": "PlantedSecretApp",
    "domain": "planted-bank.example",
    "title": "Planted diagnosis for Jane Doe",
    "token": "sk-planted-0000-token",
    "body": "planted-body-value",
    "query": "planted-query-value",
    "origin": "https://planted-origin.example",
}


def raw(port, text):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as s:
        s.sendall(text.encode())
        s.settimeout(3)
        out = b""
        while chunk := s.recv(65536):
            out += chunk
    return out.decode(errors="replace")


def test_nothing_private_reaches_the_tracker_log(kt, server, monkeypatch, fake_time, capfd):
    p = PLANTED
    # 1. The loop records private activity, and its error paths run (disk full, cleanup failure).
    frames = [(0, p["app"], "", "")] * 2 + [(0, "Safari", p["domain"], p["title"] + " " + p["token"])] * 4
    scripted(kt, monkeypatch, frames)
    monkeypatch.setattr(kt, "CLEAN_EVERY", 4)
    real_cleanup = kt.cleanup
    monkeypatch.setattr(kt, "cleanup", lambda: (_ for _ in ()).throw(OSError(5, "Input/output error")))
    real_save, n = kt.save, {"v": 0}

    def flaky(data):
        n["v"] += 1
        if n["v"] == 1:
            raise OSError(28, "No space left on device", kt.OUT_FILE)
        return real_save(data)

    monkeypatch.setattr(kt, "save", flaky)
    monkeypatch.setattr(kt, "SAVE_EVERY", 5)
    run_loop(kt, monkeypatch, fake_time, frames)
    assert any(s.get("title", "").startswith(p["title"]) for d in kt.STATE["data"]["days"].values() for s in d)

    monkeypatch.setattr(kt, "cleanup", real_cleanup)
    monkeypatch.setattr(kt, "save", real_save)

    # 2. Every API path, good and bad, with private values in the query, body and headers.
    server.request("GET", f"/status?x={p['query']}", origin=GOOD)
    server.request("GET", f"/activity?days=7&x={p['query']}", origin=GOOD)
    server.request("GET", "/status", origin=p["origin"])  # refused origin
    server.request("POST", "/pause", body={"minutes": 15, "note": p["body"]}, origin=GOOD)
    server.request("POST", "/resume", body={"note": p["body"]}, origin=GOOD)
    server.request("POST", "/settings", body={"keepDays": p["body"]}, origin=GOOD)  # invalid value
    server.request("POST", "/cleanup", body={"x": p["body"]}, origin=GOOD)
    server.request("POST", f"/nope?{p['query']}", body={"x": p["body"]}, origin=GOOD)
    raw(server.port, f"GET /status HTTP/1.1\r\nHost: {p['domain']}\r\nOrigin: {GOOD}\r\nConnection: close\r\n\r\n")  # bad Host
    bad = f"{{not json {p['body']}"
    head = f"POST /pause HTTP/1.1\r\nHost: 127.0.0.1:{kt.PORT}\r\nOrigin: {GOOD}\r\nContent-Type: application/json\r\n"
    raw(server.port, head + f"Content-Length: {len(bad)}\r\nConnection: close\r\n\r\n{bad}")
    raw(server.port, f"BREW /{p['query']} HTTP/1.1\r\nHost: 127.0.0.1:{kt.PORT}\r\nConnection: close\r\n\r\n")
    raw(server.port, f"{p['token']}\r\n\r\n")  # not HTTP at all

    # 3. A handler error (prints a traceback) while answering with private data loaded.
    real_snap = kt.snapshot
    monkeypatch.setattr(kt, "snapshot", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    try:
        server.request("GET", "/activity", origin=GOOD)
    except Exception:  # noqa: S110 - before fix 67 the connection dropped; only the log matters here
        pass
    monkeypatch.setattr(kt, "snapshot", real_snap)

    out, err = capfd.readouterr()
    log = out + err
    assert "Couldn't write activity file" in log and "Cleanup failed" in log  # the error paths did print
    assert "API error on GET /activity: RuntimeError" in log and "boom" not in log  # fix 67: logged without the message
    found = {k: v for k, v in p.items() if v in log}
    assert not found, f"private values in the tracker log: {found}\n---\n{log[-2000:]}"
    for line in log.splitlines():  # nothing that looks like activity data either
        assert '"app"' not in line and '"title"' not in line, line
    json.dumps(log)  # the whole log is plain text
