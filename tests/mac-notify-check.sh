#!/bin/bash
# Checks that Mac notifications from the Keel tracker really appear, through the same path Keel uses (POST /schedule
# to the running tracker). Run it after installing the updated tracker. It schedules one test notification about
# 20 seconds ahead. It replaces the tracker's current schedule; Keel sends its own again within 10 minutes, or at
# once if you change something in Keel.
# Usage: bash tests/mac-notify-check.sh
set -euo pipefail
ORIGIN="${1:-https://keel-app-five.vercel.app}"
AT=$(( $(date +%s) * 1000 + 20000 ))
ID="check-$(date +%s)"
echo "Asking the tracker to show a test notification in about 20 seconds..."
curl -sS -m 5 -X POST "http://127.0.0.1:47821/schedule" -H "Origin: $ORIGIN" -H "Content-Type: application/json" \
  -d "{\"items\":[{\"id\":\"$ID\",\"at\":$AT,\"kind\":\"plan\",\"title\":\"Keel: notifications work\",\"body\":\"Sent by tests/mac-notify-check.sh\"}],\"prefs\":{\"plan\":true}}" \
  || { echo "Couldn't reach the tracker. Is it installed and running? (python3 ~/\"Keel Activity\"/keel_tracker.py status)"; exit 1; }
echo
sleep 30
echo "Did a notification titled 'Keel: notifications work' appear? If not:"
echo "  - System Settings > Notifications > Script Editor: allow notifications;"
echo "  - check that Focus / Do Not Disturb is off;"
echo "  - look at ~/Keel Activity/tracker.log for errors."
