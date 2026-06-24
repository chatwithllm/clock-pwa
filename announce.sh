#!/bin/sh
# Broadcast an announcement to the clock displays.
#   Usage: announce.sh "message" [target] [duration_seconds]
#     target   = all (default) or a device profile, e.g. "Kitchen"
#     duration = seconds the banner stays up (default 20)
#
# Run inside the container, e.g.:
#   docker exec clock-pwa /usr/local/bin/announce.sh "Dinner is ready!"
#   docker exec clock-pwa /usr/local/bin/announce.sh "Movie starting" "Theater Room" 30
ROOT=/data
TEXT="$1"
TARGET="${2:-all}"
DUR="${3:-20}"

if [ -z "$TEXT" ]; then
  echo "usage: announce.sh \"message\" [target] [duration]" >&2
  exit 1
fi

# Escape backslashes and double quotes for JSON.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
NOW=$(date +%s)

printf '{ "id": "%s", "text": "%s", "ts": %s000, "duration": %s, "target": "%s" }\n' \
  "$NOW-$$" "$(esc "$TEXT")" "$NOW" "$DUR" "$(esc "$TARGET")" > "$ROOT/announce.json"

echo "announced to '$TARGET' for ${DUR}s: $TEXT"
