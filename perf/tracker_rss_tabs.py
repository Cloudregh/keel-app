"""Finding 64 repro: tracker memory when 1, 2 and 3 Keel tabs pull /activity?days=30 at the same moment.

Starts the real tracker with 30 heavy days (perf/tracker_fake_mac.py) and prints RSS in MB after each step.
Target (docs/test-strategy.md §6): RSS < 60 MB. Linux only (/proc). Usage: python3 perf/tracker_rss_tabs.py
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tracker_bench as tb  # noqa: E402

ROOT = pathlib.Path(__file__).parents[1]


def pull_together(port, n):
    ts = [threading.Thread(target=tb.req, args=(port, "/activity?days=30")) for _ in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()


def main():
    port = tb.free_port()
    env = {**os.environ, "KEEL_TRACKER_PORT": str(port)}
    cmd = [sys.executable, str(ROOT / "perf" / "tracker_fake_mac.py"), tempfile.mkdtemp(prefix="keel-perf-"), "30"]
    p = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if tb.req(port, "/status", timeout=0.5)[1] == 200:
                break
            time.sleep(0.1)
        out = {"start": tb.cpu_rss(p.pid)[1]}
        for n in (1, 2, 3):
            pull_together(port, n)
            out[f"after {n} together"] = tb.cpu_rss(p.pid)[1]
        for _ in range(20):
            pull_together(port, 3)
        out["after 20 x 3 together"] = tb.cpu_rss(p.pid)[1]
    finally:
        p.terminate()
    print({k: round(v, 1) for k, v in out.items()})


if __name__ == "__main__":
    main()
