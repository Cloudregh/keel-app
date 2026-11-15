#!/bin/bash
# Phase 12: the CPU cost of the helper programs the Keel tracker starts on every 5 s sample, which `ps` on the
# tracker itself doesn't count (perf/mac_tracker_cpu.sh measured the tracker process only).
# Per sample the tracker runs: ioreg (idle time), lsappinfo twice (front app), and osascript only when a browser is
# in front (to read the tab). This times each one 10 times and reports the worst case (a browser always in front).
# Read-only: osascript runs `return 1`, so it asks no app for anything and reads no tab, URL or title.
# lsappinfo output is discarded. It doesn't touch the tracker or your activity data.
# Usage: bash perf/mac_child_cpu.sh      Paste the last block of output back.
set -euo pipefail
N=10
cpu_ms() { # user+sys CPU of one run of "$@", in ms; the small sh wrapper is counted too, so this errs high
  { /usr/bin/time -p /bin/sh -c '"$@" >/dev/null 2>&1' sh "$@"; } 2>&1 | awk '/^(user|sys)/ { s += $2 } END { printf "%.0f", s * 1000 }'
}
avg() { # average CPU ms of N runs
  local t=0 i
  for ((i = 0; i < N; i++)); do t=$((t + $(cpu_ms "$@"))); done
  echo $((t / N))
}
io="$(avg /usr/sbin/ioreg -r -c IOHIDSystem -k HIDIdleTime -d 1)"
ls1="$(avg /usr/bin/lsappinfo front)"
ls2="$(avg /usr/bin/lsappinfo info -only name "$(/usr/bin/lsappinfo front 2>/dev/null)")"
osa="$(avg /usr/bin/osascript -e 'return 1')"
echo "---- Keel tracker helpers on $(sw_vers -productName) $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string) ----"
awk -v io="$io" -v l1="$ls1" -v l2="$ls2" -v osa="$osa" -v n="$N" 'BEGIN {
  printf "average CPU per call (%d runs each): ioreg %d ms, lsappinfo front %d ms, lsappinfo info %d ms, osascript %d ms\n", n, io, l1, l2, osa
  printf "helpers per 5 s sample: %.2f%% of a core with no browser in front, %.2f%% with a browser always in front\n", (io + l1 + l2) / 50, (io + l1 + l2 + osa) / 50 }'
