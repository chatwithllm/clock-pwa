#!/bin/sh
# Stamp the served app with a content hash so running displays can tell the
# server was redeployed and reload themselves (js/appversion.js polls it).
# Hashes the files the browser actually executes, so an unchanged rebuild keeps
# the same id and does NOT make the whole fleet reload.
set -e

ROOT=/usr/share/nginx/html
V=$(cd "$ROOT" && cat index.html sw.js css/*.css js/*.js | md5sum | cut -c1-12)
printf '{"v":"%s"}\n' "$V" > "$ROOT/version.json"
echo "clock: app version $V"
