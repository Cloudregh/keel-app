"""Keel served by the tracker at http://127.0.0.1:47821/ (2026-11-23), for Safari, which blocks the https website
from reaching the tracker. Only Keel's own files are served, by exact path, with headers that stop other sites from
embedding the page; the usual Host and Origin checks still apply; a same-origin Keel page counts as Keel connecting."""

import hashlib
import os

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def sha(b):
    return hashlib.sha256(b).hexdigest()


@pytest.mark.parametrize(
    "path,name,ctype",
    [
        ("/", "index.html", "text/html; charset=utf-8"),
        ("/index.html", "index.html", "text/html; charset=utf-8"),
        ("/sw.js", "sw.js", "text/javascript; charset=utf-8"),
        ("/manifest.json", "manifest.json", "application/manifest+json"),
        ("/icon.svg", "icon.svg", "image/svg+xml"),
        ("/icon-maskable.svg", "icon-maskable.svg", "image/svg+xml"),
    ],
)
def test_serves_keels_files_byte_for_byte(server, path, name, ctype):
    st, h, body = server.request("GET", path)
    raw = body if isinstance(body, bytes) else None
    if raw is None:  # the client parses JSON; manifest.json comes back parsed, so fetch the raw bytes again
        import http.client

        c = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
        c.request("GET", path, headers={"Host": f"127.0.0.1:{server.port}"})
        raw = c.getresponse().read()
        c.close()
    assert st == 200
    assert h["content-type"] == ctype
    with open(os.path.join(ROOT, name), "rb") as f:
        assert sha(raw) == sha(f.read())


def test_page_headers_block_embedding_and_sniffing(server):
    st, h, _ = server.request("GET", "/")
    assert st == 200
    assert h["content-security-policy"] == "frame-ancestors 'none'"
    assert h["x-frame-options"] == "DENY"
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["cache-control"] == "no-cache"
    assert "access-control-allow-origin" not in h  # no other site may read the page


@pytest.mark.parametrize(
    "path",
    [
        "/tracker/keel_tracker.py",
        "/../tracker/keel_tracker.py",
        "/%2e%2e/package.json",
        "/package.json",
        "/index.html/",
        "/index.htm",
        "/README.md",
        "/.git/config",
        "/eval/manifest.json",
    ],
)
def test_nothing_else_on_disk_is_reachable(server, path):
    st, _, body = server.request("GET", path)
    assert st == 404
    assert body == {"error": "Not found"}


def test_query_string_still_serves_the_page(server):
    st, h, _ = server.request("GET", "/?utm=x")
    assert st == 200 and h["content-type"].startswith("text/html")


def test_other_sites_cannot_fetch_the_page(server):
    st, h, body = server.request("GET", "/", origin="https://evil.example")
    assert st == 403
    assert "access-control-allow-origin" not in h
    assert "allowed_origins" in body["error"]


def test_dns_rebinding_host_is_refused(server):
    st, _, _ = server.request("GET", "/", host="evil.example:47821")
    assert st == 403


def test_missing_files_answer_with_a_clear_message(server, kt, tmp_path, monkeypatch):
    monkeypatch.setattr(kt, "web_dir", lambda: str(tmp_path / "nowhere"))
    st, h, body = server.request("GET", "/")
    assert st == 404
    assert h["content-type"].startswith("application/json")
    assert "Keel Tracker.app" in body["error"]


def test_app_bundle_reads_from_its_web_folder(kt, monkeypatch, tmp_path):
    monkeypatch.setattr(kt.sys, "frozen", True, raising=False)
    monkeypatch.setattr(kt.sys, "_MEIPASS", str(tmp_path), raising=False)
    assert kt.web_dir() == os.path.join(str(tmp_path), "web")


def test_checkout_reads_from_the_repository(kt):
    assert os.path.isfile(os.path.join(kt.web_dir(), "index.html"))


def test_same_origin_keel_page_counts_as_connected(server, kt):
    kt.NOTES["last_page"] = None
    server.request("GET", "/status", headers={"Sec-Fetch-Site": "same-origin"})
    assert kt.NOTES["last_page"] is not None


@pytest.mark.parametrize("headers", [None, {"Sec-Fetch-Site": "none"}, {"Sec-Fetch-Site": "cross-site"}])
def test_requests_that_are_not_a_keel_page_do_not_count(server, kt, headers):
    kt.NOTES["last_page"] = None
    server.request("GET", "/status", headers=headers)  # e.g. curl, or typing the URL in the address bar
    assert kt.NOTES["last_page"] is None


def test_loading_the_page_itself_does_not_count(server, kt):
    kt.NOTES["last_page"] = None
    server.request("GET", "/", headers={"Sec-Fetch-Site": "same-origin"})
    assert kt.NOTES["last_page"] is None


def test_selftest_fails_when_keels_page_is_not_bundled(kt, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(kt, "web_dir", lambda: str(tmp_path / "nowhere"))
    assert kt.selftest() == 1
    assert "selftest FAILED" in capsys.readouterr().out
