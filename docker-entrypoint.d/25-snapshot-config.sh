#!/bin/sh
# Publish the low-privilege snapshot-upload token to the kiosk page (snapshot.json),
# only when SNAPSHOT_TOKEN is set. Empty object otherwise (snapshots disabled).
OUT=/usr/share/nginx/html/snapshot.json
if [ -n "$SNAPSHOT_TOKEN" ]; then
  ESC=$(printf '%s' "$SNAPSHOT_TOKEN" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{ "token": "%s" }\n' "$ESC" > "$OUT"
  echo "clock: snapshot.json published (uploads enabled)"
else
  printf '{}\n' > "$OUT"
  echo "clock: SNAPSHOT_TOKEN unset — snapshots disabled"
fi
