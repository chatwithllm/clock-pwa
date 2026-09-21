#!/bin/sh
# Seed the writable /data dir with valid, empty JSON for every admin-managed
# file the clients poll. Without this a fresh deployment 404s on each poll —
# /source.json alone produced a continuous 404 stream (4 req/min/device), and
# every one of those 404s is (correctly) written to the access log.
#
# Also creates the dirs nginx WebDAV needs, which are otherwise only present
# because the image build made them — a bind-mounted /data has neither.
#
# NEVER overwrites an existing non-empty file. Announcements, custom profiles,
# the source selection and the per-profile dashboards survive restarts,
# rebuilds and container recreation (see the clockdata volume in compose).
set -e

DATA=/data
mkdir -p "$DATA/tmp" "$DATA/uploads"

# seed <filename> <default-json>
seed() {
  f="$DATA/$1"
  if [ -s "$f" ]; then
    echo "clock: $f present — kept"
  else
    printf '%s\n' "$2" > "$f"
    echo "clock: $f initialized"
  fi
}

seed announce.json   '[]'
seed profiles.json   '{"profiles":[]}'
seed source.json     '{}'
seed dashboards.json '{"version":1,"profiles":{}}'

# nginx workers write these via WebDAV PUT.
chown -R nginx:nginx "$DATA" 2>/dev/null || true
chmod -R u+rwX "$DATA" 2>/dev/null || true
