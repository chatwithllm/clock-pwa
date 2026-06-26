#!/bin/sh
# Server-side weather push. Periodically fetch Open-Meteo for the SERVER location
# and write weather.json into the web root. LAN devices WITHOUT internet then read
# weather from this server (same-origin) instead of calling the API themselves.
#
# Needs internet ON THE SERVER. Disable by setting WEATHER_FETCH=off.
ROOT=/usr/share/nginx/html
CONF="$ROOT/config.json"
INTERVAL="${WEATHER_INTERVAL:-900}"   # seconds between fetches (default 15 min)

if [ "$WEATHER_FETCH" = "off" ]; then
  echo "clock: server weather fetcher disabled (WEATHER_FETCH=off)"
  exit 0
fi

coord() {  # $1 = lat|lon — env first, then config.json
  case "$1" in
    lat) [ -n "$CLOCK_LAT" ] && { echo "$CLOCK_LAT"; return; } ;;
    lon) [ -n "$CLOCK_LON" ] && { echo "$CLOCK_LON"; return; } ;;
  esac
  [ -f "$CONF" ] && grep -oE "\"$1\"[[:space:]]*:[[:space:]]*-?[0-9.]+" "$CONF" \
    | grep -oE -- "-?[0-9.]+$" | head -1
}

fetch_loop() {
  while true; do
    LAT=$(coord lat); LON=$(coord lon)
    if [ -n "$LAT" ] && [ -n "$LON" ]; then
      URL="https://api.open-meteo.com/v1/forecast?latitude=$LAT&longitude=$LON&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&temperature_unit=celsius&timezone=auto&forecast_days=1"
      if curl -fsS --max-time 15 "$URL" -o "$ROOT/weather.json.tmp" && [ -s "$ROOT/weather.json.tmp" ]; then
        mv "$ROOT/weather.json.tmp" "$ROOT/weather.json"
        echo "clock: weather.json updated ($LAT,$LON)"
      else
        echo "clock: weather fetch failed (server offline?)"
        rm -f "$ROOT/weather.json.tmp"
      fi
    else
      echo "clock: no lat/lon for server weather"
    fi
    sleep "$INTERVAL"
  done
}

fetch_loop &
echo "clock: server weather fetcher started (every ${INTERVAL}s)"
