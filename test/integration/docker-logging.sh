#!/usr/bin/env bash
# Integration test for the durable-logging fix.
#
# Proves, against the real docker-compose.yml / nginx.conf / Dockerfile:
#   1. compose validates and renders max-size=10m + max-file=3 for EVERY service
#   2. nginx.conf passes `nginx -t` inside the built image
#   3. docker inspect shows the bounded log config on the running containers
#   4. successful polling GETs are omitted from the access log
#   5. a query string does not defeat the exact-path match
#   6. 404 / 401 / 5xx are still logged
#   7. PUT (admin write) is still logged
#   8. /source.json returns 200 + valid JSON on fresh data
#   9. existing JSON state survives a container restart (never overwritten)
#
# Usage: npm run test:integration    (needs docker + a working daemon)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT=clock-pwa-logtest
CLOCK=clock-pwa-logtest
SIDECAR=clock-alert-sidecar-logtest
BASE=http://127.0.0.1:18080
AUTH='admin:logtest-pass'
DC=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.yml" -f "$ROOT/test/integration/compose.override.yml")

pass=0
ok()   { pass=$((pass+1)); printf '  ok %d - %s\n' "$pass" "$1"; }
fail() { printf '  NOT OK - %s\n' "$1" >&2; exit 1; }

cleanup() { "${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "# 1. compose validation"
"${DC[@]}" config --quiet
docker compose -f "$ROOT/docker-compose.yml" config --quiet
ok "docker compose config --quiet (base + test overlay)"

echo "# 2. every service renders the bounded log config"
docker compose -f "$ROOT/docker-compose.yml" config --format json \
  | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const svc = JSON.parse(s).services, bad = [];
      for (const [name, def] of Object.entries(svc)) {
        const l = def.logging || {}, o = l.options || {};
        if (l.driver !== "json-file")   bad.push(`${name}: driver=${l.driver}`);
        if (o["max-size"] !== "10m")    bad.push(`${name}: max-size=${JSON.stringify(o["max-size"])}`);
        if (o["max-file"] !== "3")      bad.push(`${name}: max-file=${JSON.stringify(o["max-file"])}`);
      }
      if (bad.length) { console.error("  unbounded/incorrect: " + bad.join("; ")); process.exit(1); }
      console.error(`  checked ${Object.keys(svc).length} service(s)`);
    });'
ok "max-size=10m + max-file=3 rendered as YAML strings for every service"

echo "# 3. build + nginx -t"
"${DC[@]}" build >/dev/null
docker run --rm --entrypoint nginx clock-pwa -t
ok "nginx -t passes inside the built image"

echo "# 4. bring the stack up"
"${DC[@]}" up -d >/dev/null
for i in $(seq 1 60); do
  curl -fsS -o /dev/null "$BASE/index.html" 2>/dev/null && break
  [ "$i" = 60 ] && fail "clock container never became ready"
  sleep 1
done
# /alerts.json is proxied; wait for the sidecar too.
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/alerts.json")" = 200 ] && break
  [ "$i" = 60 ] && fail "alert-sidecar never became ready"
  sleep 1
done
ok "stack up and serving"

echo "# 5. effective (not just declared) log config via docker inspect"
for c in "$CLOCK" "$SIDECAR"; do
  cfg="$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$c")"
  [ "$cfg" = "json-file 10m 3" ] || fail "$c effective LogConfig is '$cfg', want 'json-file 10m 3'"
done
ok "docker inspect: json-file max-size=10m max-file=3 on both containers"

echo "# 6. fresh-data JSON endpoints"
code_body() { curl -s -o /tmp/lt.body -w '%{http_code}' "$1"; }
for ep in source.json announce.json profiles.json dashboards.json; do
  c="$(code_body "$BASE/$ep")"
  [ "$c" = 200 ] || fail "GET /$ep returned $c, want 200"
  node -e 'JSON.parse(require("fs").readFileSync("/tmp/lt.body","utf8"))' \
    || fail "/$ep is not valid JSON"
done
ok "/source.json, /announce.json, /profiles.json, /dashboards.json → 200 + valid JSON"
grep -q '^{}$' <(curl -s "$BASE/source.json") || fail "/source.json is not the expected empty {} shape"
ok "/source.json seeded to {} + newline"

echo "# 7. drive the polling traffic"
for i in 1 2 3; do
  curl -s -o /dev/null "$BASE/alerts.json?ts=$i"
  curl -s -o /dev/null "$BASE/announce.json?ts=$i"
  curl -s -o /dev/null "$BASE/profiles.json?ts=$i"
  curl -s -o /dev/null "$BASE/source.json?ts=$i"
done
sleep 1
LOG="$(docker logs "$CLOCK" 2>&1)"
for ep in alerts.json announce.json profiles.json source.json; do
  if grep -q "\"GET /$ep" <<<"$LOG"; then
    grep "GET /$ep" <<<"$LOG" >&2
    fail "successful GET /$ep was logged — suppression not in effect"
  fi
done
ok "successful polling GETs omitted from the access log (incl. ?ts= query strings)"

echo "# 8. everything else is still logged"
curl -s -o /dev/null "$BASE/nope.json"                        # 404
curl -s -o /dev/null "$BASE/admin.html"                       # 401 (auth failure)
curl -s -o /dev/null "$BASE/source.json/../../etc/passwd"     # unusual request
printf '[{"id":"t1","text":"integration test"}]' \
  | curl -s -o /dev/null -u "$AUTH" -X PUT --data-binary @- "$BASE/announce.json"
sleep 1
LOG="$(docker logs "$CLOCK" 2>&1)"
grep -q '"GET /nope.json[^"]*" 404'   <<<"$LOG" || fail "404 was NOT logged"
ok "404 still logged"
grep -q '"GET /admin.html[^"]*" 401'  <<<"$LOG" || fail "401 auth failure was NOT logged"
ok "401 auth failure still logged"
grep -q '"PUT /announce.json[^"]*" 2' <<<"$LOG" || fail "admin PUT was NOT logged"
ok "PUT /announce.json (admin write) still logged"

echo "# 9. 5xx on a suppressed path is still logged"
# With the upstream stopped nginx keeps the cached DNS answer for `valid=30s`
# and stalls; once it expires the name goes NXDOMAIN and nginx answers 502.
# Poll until we actually observe a 5xx rather than guessing the timing.
docker stop "$SIDECAR" >/dev/null
got5xx=""
for i in $(seq 1 45); do
  c="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE/alerts.json?ts=5xx$i" || echo 000)"
  case "$c" in 5*) got5xx="$c"; break ;; esac
  sleep 1
done
[ -n "$got5xx" ] || fail "never observed a 5xx from /alerts.json with the sidecar down"
sleep 1
docker logs "$CLOCK" 2>&1 | grep -q "\"GET /alerts.json[^\"]*\" $got5xx" \
  || fail "$got5xx on /alerts.json was NOT logged"
ok "$got5xx on a suppressed path still logged"
docker start "$SIDECAR" >/dev/null

echo "# 10. existing state survives recreation"
"${DC[@]}" restart clock >/dev/null
for i in $(seq 1 60); do
  curl -fsS -o /dev/null "$BASE/announce.json" 2>/dev/null && break
  [ "$i" = 60 ] && fail "clock did not come back after restart"
  sleep 1
done
curl -s "$BASE/announce.json" | grep -q 'integration test' \
  || fail "announce.json was overwritten on restart — operator state lost"
ok "existing non-empty announce.json preserved across restart"

# Recreate the container entirely (new container, same named volume).
"${DC[@]}" up -d --force-recreate clock >/dev/null
for i in $(seq 1 60); do
  curl -fsS -o /dev/null "$BASE/announce.json" 2>/dev/null && break
  [ "$i" = 60 ] && fail "clock did not come back after recreate"
  sleep 1
done
curl -s "$BASE/announce.json" | grep -q 'integration test' \
  || fail "announce.json lost on container recreation — /data is not persistent"
ok "existing state survives full container recreation (clockdata volume)"

echo
echo "# integration: $pass/$pass checks passed"
