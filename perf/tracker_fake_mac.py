"""Run the real Keel tracker (tracker/keel_tracker.py) on Linux for performance tests.

Only the three macOS lookups are replaced (idle time, front app, browser tab); everything else is the
shipped code: the 5-second sampling loop, the threaded local API, saving, cleanup. Files go to a
temporary home folder given as argv[1]; argv[2] is the number of heavy days to seed (default 30).
Never touches ~/Keel Activity. Used by perf/tracker_bench.py.
"""

import importlib.util
import itertools
import json
import os
import pathlib
import random
import sys
import time

home = pathlib.Path(sys.argv[1])
seed_days = int(sys.argv[2]) if len(sys.argv) > 2 else 30
spec = importlib.util.spec_from_file_location("keel_tracker", pathlib.Path(__file__).parents[1] / "tracker" / "keel_tracker.py")
kt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kt)
out = home / "Keel Activity"
out.mkdir(parents=True, exist_ok=True)
kt.HOME, kt.OUT_DIR = str(home), str(out)
kt.OUT_FILE, kt.LOG_FILE, kt.CONFIG_FILE = str(out / "keel-activity.json"), str(out / "tracker.log"), str(out / "config.json")
kt.PLIST = str(home / "Library" / "LaunchAgents" / (kt.LABEL + ".plist"))

# Seed: `seed_days` heavy days of 800 segments each (as in the browser storage test), titles on browser segments.
rnd = random.Random(20261114)  # noqa: S311 - deterministic test data, not security
apps = ["Code", "Google Chrome", "Slack", "Figma", "Terminal", "Safari", "Notes", "Spotify"]
doms = ["github.com", "youtube.com", "docs.google.com", "x.com", "stackoverflow.com"]
days = {}
now = int(time.time() * 1000)
for d in range(1, seed_days + 1):
    t = now - d * 86_400_000 - 8 * 3_600_000
    segs = []
    for _ in range(800):
        app = rnd.choice(apps)
        n = (10 + rnd.randrange(120)) * 1000
        seg = {"s": t, "e": t + n, "app": app}
        if app in ("Google Chrome", "Safari"):
            seg["domain"], seg["title"] = rnd.choice(doms), "Some page title that is fairly long, about this long"
        segs.append(seg)
        t += n + 2000
    days[kt.day_key(segs[0]["s"])] = segs
pathlib.Path(kt.OUT_FILE).write_text(json.dumps({"version": kt.VERSION, "days": days}))

# The fakes: always active, switching app every ~20 s, Chrome with a changing tab.
cycle = itertools.cycle(["Code", "Code", "Code", "Google Chrome", "Slack", "Code"])
state = {"app": "Code", "at": 0.0, "n": 0}


def front_app():
    if time.time() - state["at"] > 20:
        state["app"], state["at"] = next(cycle), time.time()
        state["n"] += 1
    return state["app"]


kt.idle_seconds = lambda: 0
kt.front_app = front_app
kt.browser_tab = lambda app: ("github.com", f"Pull request {state['n']}")
print(f"seeded {seed_days} days, file {os.path.getsize(kt.OUT_FILE)} bytes", flush=True)
kt.track()
