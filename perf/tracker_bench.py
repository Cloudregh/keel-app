"""Phase 12: latency, throughput and breaking point of the tracker's local API, and its CPU/RSS.

Starts the real tracker (perf/tracker_fake_mac.py) on a free port in a temporary home, then:
  1. sequential latency of /status and /activity?days=30 (what one open Keel tab does);
  2. a concurrency ramp (1 → 512 clients, 10 s each, 90% /status and 10% /activity) until it breaks;
  3. optionally (--cpu-minutes N) CPU and RSS of the idle-polling tracker, sampled every 5 s from /proc.
Writes perf/results/tracker-<date>.json. Standard library only; Linux only (/proc).
"""

import argparse
import http.client
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))], 2)


def req(port, path, origin="https://cloudregh.github.io", timeout=3.0):
    """One request as the web app makes it (new connection, Origin header, 3 s client timeout like trFetch)."""
    t0 = time.perf_counter()
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        c.request("GET", path, headers={"Host": f"127.0.0.1:{port}", "Origin": origin})
        r = c.getresponse()
        body = r.read()
        c.close()
        return (time.perf_counter() - t0) * 1000, r.status, len(body), None
    except Exception as e:  # timeouts, resets, refused connections all count as errors
        return (time.perf_counter() - t0) * 1000, 0, 0, type(e).__name__


def summary(rows):
    ok = [ms for ms, st, _, _ in rows if st == 200]
    errs = {}
    for _, st, _, e in rows:
        if st != 200:
            k = e or f"http {st}"
            errs[k] = errs.get(k, 0) + 1
    return {
        "n": len(rows),
        "ok": len(ok),
        "errorRate": round(1 - len(ok) / len(rows), 4) if rows else None,
        "errors": errs,
        "p50": pct(ok, 50),
        "p95": pct(ok, 95),
        "p99": pct(ok, 99),
        "max": round(max(ok), 2) if ok else None,
    }


def cpu_rss(pid):
    with open(f"/proc/{pid}/stat") as f:
        parts = f.read().rsplit(")", 1)[1].split()
    ticks = int(parts[11]) + int(parts[12]) + int(parts[13]) + int(parts[14])  # utime stime cutime cstime
    with open(f"/proc/{pid}/status") as f:
        rss = next(int(line.split()[1]) for line in f if line.startswith("VmRSS"))
    return ticks / os.sysconf("SC_CLK_TCK"), rss / 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cpu-minutes", type=float, default=0)
    ap.add_argument("--levels", default="1,2,4,8,16,32,64,128,256,512")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--seed-days", type=int, default=30)
    a = ap.parse_args()
    port = free_port()
    home = tempfile.mkdtemp(prefix="keel-perf-")
    env = {**os.environ, "KEEL_TRACKER_PORT": str(port)}
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "perf" / "tracker_fake_mac.py"), home, str(a.seed_days)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    out = {"date": time.strftime("%Y-%m-%d %H:%M:%S"), "python": sys.version.split()[0], "cpus": os.cpu_count(), "seedDays": a.seed_days}
    try:
        for _ in range(100):
            if req(port, "/status", timeout=0.5)[1] == 200:
                break
            time.sleep(0.1)
        else:
            raise SystemExit("tracker didn't start: " + proc.stdout.read())
        status = json.loads(http_get(port, "/status"))
        out["fileBytes"] = status.get("fileBytes") or status.get("storage", {}).get("fileBytes")
        out["status"] = status
        # 1. what one Keel tab does: /status every few seconds, /activity once a minute
        out["sequential"] = {
            "/status": summary([req(port, "/status") for _ in range(1000)]),
            "/activity?days=30": summary([req(port, "/activity?days=30") for _ in range(50)]),
        }
        out["activityBytes"] = req(port, "/activity?days=30")[2]
        out["rssAfterSequentialMb"] = round(cpu_rss(proc.pid)[1], 1)
        # 2. ramp
        ramp = []
        for n in [int(x) for x in a.levels.split(",") if x]:
            rows, stop = [], time.time() + a.seconds
            lock = threading.Lock()

            def worker(i, stop=stop, lock=lock, rows=rows):
                k = 0
                while time.time() < stop:
                    path = "/activity?days=30" if (i + k) % 10 == 0 else "/status"
                    r = req(port, path)
                    with lock:
                        rows.append((path, r))
                    k += 1

            ts = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
            c0 = cpu_rss(proc.pid)
            t0 = time.time()
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            el = time.time() - t0
            c1 = cpu_rss(proc.pid)
            st = summary([r for p, r in rows if p == "/status"])
            ac = summary([r for p, r in rows if p != "/status"])
            allr = summary([r for _, r in rows])
            lvl = {
                "clients": n,
                "seconds": round(el, 1),
                "throughput": round(len(rows) / el, 1),
                "status": st,
                "activity": ac,
                "errorRate": allr["errorRate"],
                "trackerCpuPct": round(100 * (c1[0] - c0[0]) / el, 1),
                "trackerRssMb": round(c1[1], 1),
            }
            ramp.append(lvl)
            print(
                json.dumps({k: lvl[k] for k in ("clients", "throughput", "errorRate", "trackerCpuPct", "trackerRssMb")}),
                "status p95",
                st["p95"],
                "activity p95",
                ac["p95"],
                ac["errors"] or "",
                st["errors"] or "",
                flush=True,
            )
            if (allr["errorRate"] or 0) > 0.2:
                break
            time.sleep(2)
        out["ramp"] = ramp
        # 3. CPU/RSS of the tracker doing its normal job while one tab polls it (status every 5 s, activity every 60 s)
        if a.cpu_minutes:
            samples, c0, t0, k = [], cpu_rss(proc.pid), time.time(), 0
            while time.time() - t0 < a.cpu_minutes * 60:
                req(port, "/status")
                if k % 12 == 0:
                    req(port, "/activity?days=30")
                k += 1
                time.sleep(5)
                c, rss = cpu_rss(proc.pid)
                samples.append({"t": round(time.time() - t0), "cpuS": round(c - c0[0], 3), "rssMb": round(rss, 1)})
            el = time.time() - t0
            out["idle"] = {
                "minutes": round(el / 60, 2),
                "cpuAvgPct": round(100 * samples[-1]["cpuS"] / el, 3),
                "rssMaxMb": max(s["rssMb"] for s in samples),
                "rssEndMb": samples[-1]["rssMb"],
                "samples": samples,
            }
            print("idle", {k: v for k, v in out["idle"].items() if k != "samples"}, flush=True)
    finally:
        proc.terminate()
        proc.wait(5)
    name = ROOT / "perf" / "results" / f"tracker-{time.strftime('%Y%m%d-%H%M%S')}.json"
    name.write_text(json.dumps(out, indent=1) + "\n")
    print("wrote", name.relative_to(ROOT))


def http_get(port, path):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request("GET", path, headers={"Host": f"127.0.0.1:{port}"})
    return c.getresponse().read()


if __name__ == "__main__":
    main()
