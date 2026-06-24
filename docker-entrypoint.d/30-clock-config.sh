#!/bin/sh
# Generate /config.json from env at container start (nginx runs /docker-entrypoint.d/*.sh).
# When CLOCK_LAT + CLOCK_LON are set, write the server location from env; otherwise leave
# the existing config.json (the image default, or a file you mounted). Use env OR a mounted
# file, not both (a read-only mount can't be overwritten).
set -e

CONF=/usr/share/nginx/html/config.json

if [ -n "$CLOCK_LAT" ] && [ -n "$CLOCK_LON" ]; then
  CITY=${CLOCK_CITY:-Server location}
  CITY=$(printf '%s' "$CITY" | sed 's/\\/\\\\/g; s/"/\\"/g')   # escape \ and " for JSON
  printf '{ "location": { "lat": %s, "lon": %s, "city": "%s" } }\n' \
    "$CLOCK_LAT" "$CLOCK_LON" "$CITY" > "$CONF"
  echo "clock: config.json from env (lat=$CLOCK_LAT lon=$CLOCK_LON city=$CITY)"
else
  echo "clock: CLOCK_LAT/CLOCK_LON not set — using existing config.json"
fi
