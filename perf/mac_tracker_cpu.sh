#!/bin/bash
# Phase 12: CPU and memory of the Keel tracker that is already running on this Mac, over 10 minutes.
# Read-only: it only reads `ps` and times one `ioreg` call (the idle-time lookup the tracker makes every 5 s).
# It doesn't start, stop or change the tracker, call osascript, or read your activity data.
# Usage: bash perf/mac_tracker_cpu.sh [minutes]   (default 10). Paste the last block of output back.
set -euo pipefail
MIN="${1:-10}"
PID="$(pgrep -f keel_tracker.py | head -1 || true)"
[ -n "$PID" ] || { echo "The Keel tracker isn't running (no keel_tracker.py process)."; exit 1; }
# macOS ps prints CPU time as m:ss.cc (minutes can exceed 59) or h:mm:ss.cc
secs() { awk -F'[:.]' '{ if (NF==4) print $1*3600+$2*60+$3+$4/100; else if (NF==3) print $1*60+$2+$3/100; else print $1 }' <<<"$1"; }
cpu0="$(secs "$(ps -o time= -p "$PID" | tr -d ' ')")"; t0="$(date +%s)"; rssmax=0
echo "Sampling tracker pid $PID for $MIN minutes (one line a minute)..."
for ((i = 1; i <= MIN * 6; i++)); do
  sleep 10
  rss="$(ps -o rss= -p "$PID" | tr -d ' ')"; [ "$rss" -gt "$rssmax" ] && rssmax="$rss"
  if (( i % 6 == 0 )); then echo "  $((i / 6)) min: RSS $((rss / 1024)) MB, %CPU now $(ps -o %cpu= -p "$PID" | tr -d ' ')"; fi
done
cpu1="$(secs "$(ps -o time= -p "$PID" | tr -d ' ')")"; t1="$(date +%s)"
ioreg_ms="$( { /usr/bin/time -p /usr/sbin/ioreg -c IOHIDSystem >/dev/null; } 2>&1 | awk '/user|sys/ { s += $2 } END { printf "%.0f", s * 1000 }')"
echo "---- Keel tracker on $(sw_vers -productName) $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string) ----"
awk -v c0="$cpu0" -v c1="$cpu1" -v t0="$t0" -v t1="$t1" -v r="$rssmax" -v io="$ioreg_ms" 'BEGIN {
  printf "tracker CPU average: %.2f%% of one core over %.1f min\n", 100 * (c1 - c0) / (t1 - t0), (t1 - t0) / 60
  printf "tracker RSS max: %.1f MB\n", r / 1024
  printf "one ioreg call: %d ms CPU, so about %.2f%% of a core for the idle check every 5 s (osascript not measured)\n", io, io / 50 }'
