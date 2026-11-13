"""Regression test for bug 7: the tracker port can be overridden for tests, and the default is unchanged."""

import os
import pathlib
import subprocess
import sys

TRACKER = pathlib.Path(__file__).parents[2] / "tracker" / "keel_tracker.py"


def port_with(env_value):
    env = {k: v for k, v in os.environ.items() if k != "KEEL_TRACKER_PORT"}
    if env_value is not None:
        env["KEEL_TRACKER_PORT"] = env_value
    code = f"import runpy; m = runpy.run_path({str(TRACKER)!r}, run_name='keel_test'); print(m['PORT'])"
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=20)


def test_default_port_is_47821():
    r = port_with(None)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "47821"


def test_port_can_be_overridden_for_tests():
    r = port_with("48999")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "48999"


def test_out_of_range_port_is_rejected():
    r = port_with("80")
    assert r.returncode != 0
    assert "KEEL_TRACKER_PORT" in (r.stderr + r.stdout)
