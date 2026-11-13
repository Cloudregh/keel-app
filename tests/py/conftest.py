"""Shared fixtures for tracker tests.

Every test gets a freshly loaded copy of tracker/keel_tracker.py whose files live in a temporary
folder, so tests never touch the real ~/Keel Activity. macOS tools are never called: tests replace
them with fakes. API tests run the real request handler on a random free port.
"""

import http.client
import importlib.util
import json
import pathlib
import threading
import time as real_time
from http.server import ThreadingHTTPServer

import pytest

TRACKER = pathlib.Path(__file__).parents[2] / "tracker" / "keel_tracker.py"


def load_tracker(tmp_path):
    spec = importlib.util.spec_from_file_location(f"keel_tracker_{id(tmp_path)}", TRACKER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = tmp_path / "Keel Activity"
    out.mkdir(parents=True, exist_ok=True)
    mod.HOME = str(tmp_path)
    mod.OUT_DIR = str(out)
    mod.OUT_FILE = str(out / "keel-activity.json")
    mod.LOG_FILE = str(out / "tracker.log")
    mod.CONFIG_FILE = str(out / "config.json")
    mod.PLIST = str(tmp_path / "Library" / "LaunchAgents" / (mod.LABEL + ".plist"))
    return mod


@pytest.fixture
def kt(tmp_path, monkeypatch):
    mod = load_tracker(tmp_path)

    def no_macos(*a, **k):
        raise AssertionError("tests must not call real macOS tools")

    monkeypatch.setattr(mod.subprocess, "run", no_macos)
    return mod


class Client:
    def __init__(self, port):
        self.port = port

    def request(self, method, path, body=None, origin=None, host=None, raw_body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Host": host or f"127.0.0.1:{self.port}"}
        if origin is not None:
            h["Origin"] = origin
        if headers:
            h.update(headers)
        data = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
        if data is not None:
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = raw
        return r.status, {k.lower(): v for k, v in r.getheaders()}, parsed


@pytest.fixture
def server(kt):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), kt.Handler)
    kt.PORT = srv.server_address[1]
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield Client(kt.PORT)
    srv.shutdown()
    srv.server_close()


class FakeTime:
    """Stands in for the `time` module inside the tracker: a controllable clock."""

    def __init__(self, start, ticks):
        self.now = start
        self.ticks = ticks
        self.sleeps = 0
        self.altzone = real_time.altzone
        self.timezone = real_time.timezone
        self.localtime = real_time.localtime

    def time(self):
        return self.now

    def sleep(self, s):
        self.sleeps += 1
        if self.sleeps >= self.ticks:
            raise StopIteration
        self.now += s


@pytest.fixture
def fake_time():
    return FakeTime
