# Home Assistant Critical Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (This plan is being executed via the `/loop` skill per the user's request.)

**Goal:** Let Home Assistant push bearer-authenticated critical alerts (water leak, door open, security) onto every clock display, as an urgent channel separate from info announcements.

**Architecture:** A tiny zero-dependency Python sidecar container owns the alert set: it authenticates writes with a bearer token, serves the current alerts as JSON, and persists them atomically. nginx proxies both `GET /alerts.json` and `/api/` to the sidecar (no shared `/data` volume needed). Devices poll `/alerts.json` every 5s and render critical (red overlay) vs warning (amber banner). HA owns each alert's lifecycle via a stable key.

**Tech Stack:** Python 3 stdlib (`http.server`), vanilla JS ES modules, nginx reverse proxy, Docker Compose. Tests: Python `unittest` (sidecar), Node `--test` (pure JS), manual/headless browser (device UI).

**Architecture refinement vs spec:** The spec described nginx serving `/alerts.json` as a static file from a shared `/data` volume. This plan instead has nginx **proxy** `GET /alerts.json` to the sidecar, which serves it directly. Same device-facing behavior (GET `/alerts.json` → JSON array), but no coupling to the clock image's baked-in `/data`. The sidecar persists to its own volume.

## Global Constraints

- **The clock must never break.** Every alert path (poll, parse, render, chime, wake) is wrapped; failure degrades to no alert, never a blank/frozen clock.
- **Auth fails closed.** Unset/blank `ALERT_API_TOKEN` → sidecar rejects all writes with `503`. Wrong/missing bearer → `401`.
- **Atomic writes.** Sidecar writes temp + `os.replace()`; an in-process `threading.Lock` serializes writes.
- **Devices never call the write API.** They only `GET /alerts.json` (open, no-cache, proxied to the sidecar). Only the sidecar writes the file.
- **Two severities:** `warning` and `critical` (default `critical` when omitted).
- **HA owns lifecycle.** Alerts are keyed (`[A-Za-z0-9_.-]{1,64}`); HA upserts and clears by key. Devices do not dismiss criticals locally.
- **No third-party dependencies** anywhere (sidecar = stdlib only; JS tests = Node built-in runner).

---

### Task 1: Alert sidecar service + tests

**Files:**
- Create: `alert-sidecar/alert_sidecar.py`
- Test: `alert-sidecar/test_alert_sidecar.py`

**Interfaces:**
- Produces: HTTP service with `GET /alerts.json`, `GET /api/health`, `POST /api/alert`, `POST /api/alert/clear`, `DELETE /api/alert?key=`. Module funcs `validate_alert(body) -> (alert|None, err|None)`, `upsert(alert) -> int|None`, `clear(key) -> bool`, `now_ms() -> int`. Reads env `ALERT_API_TOKEN`, `ALERTS_FILE`, `ALERT_PORT`, `ALERT_MAX_ACTIVE`.

- [ ] **Step 1: Write the failing tests**

`alert-sidecar/test_alert_sidecar.py`:

```python
import json, os, tempfile, threading, unittest, urllib.request, urllib.error
from http.server import ThreadingHTTPServer

import alert_sidecar as A


class LogicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        A.ALERTS_FILE = self.tmp.name
        A.MAX_ACTIVE = 3
        A.now_ms = lambda: 1000  # deterministic

    def tearDown(self):
        os.unlink(self.tmp.name)

    def test_validate_ok_defaults(self):
        a, err = A.validate_alert({"key": "leak_1", "title": "Leak", "message": "wet"})
        self.assertIsNone(err)
        self.assertEqual(a["severity"], "critical")
        self.assertEqual(a["target"], "all")

    def test_validate_rejects_bad_key(self):
        _, err = A.validate_alert({"key": "bad key!", "title": "x", "message": "y"})
        self.assertIsNotNone(err)

    def test_validate_rejects_bad_severity(self):
        _, err = A.validate_alert({"key": "k", "severity": "boom", "title": "x", "message": "y"})
        self.assertIsNotNone(err)

    def test_validate_rejects_oversized(self):
        _, err = A.validate_alert({"key": "k", "title": "t", "message": "m" * 241})
        self.assertIsNotNone(err)

    def test_upsert_replaces_by_key(self):
        a, _ = A.validate_alert({"key": "k", "title": "a", "message": "1"})
        self.assertEqual(A.upsert(a), 1)
        b, _ = A.validate_alert({"key": "k", "title": "b", "message": "2"})
        self.assertEqual(A.upsert(b), 1)  # replaced, still 1
        items = json.load(open(self.tmp.name))
        self.assertEqual(items[0]["title"], "b")
        self.assertEqual(items[0]["ts"], 1000)

    def test_clear_idempotent(self):
        a, _ = A.validate_alert({"key": "k", "title": "a", "message": "1"})
        A.upsert(a)
        self.assertTrue(A.clear("k"))
        self.assertFalse(A.clear("k"))
        self.assertEqual(json.load(open(self.tmp.name)), [])

    def test_cap_exceeded(self):
        for i in range(3):
            a, _ = A.validate_alert({"key": f"k{i}", "title": "a", "message": "1"})
            self.assertIsNotNone(A.upsert(a))
        a, _ = A.validate_alert({"key": "k3", "title": "a", "message": "1"})
        self.assertIsNone(A.upsert(a))  # cap = 3


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        A.ALERTS_FILE = self.tmp.name
        A.TOKEN = "secret"
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        os.unlink(self.tmp.name)

    def _post(self, path, body, token="secret"):
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, method="POST")
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            r = urllib.request.urlopen(req)
            return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_health_no_auth(self):
        r = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/health")
        self.assertEqual(r.status, 200)

    def test_post_requires_bearer(self):
        code, _ = self._post("/api/alert", {"key": "k", "title": "t", "message": "m"}, token="wrong")
        self.assertEqual(code, 401)

    def test_post_and_get_alerts(self):
        code, body = self._post("/api/alert", {"key": "leak", "title": "Leak", "message": "wet"})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        r = urllib.request.urlopen(f"http://127.0.0.1:{self.port}/alerts.json")
        items = json.load(r)
        self.assertEqual(items[0]["key"], "leak")

    def test_token_unset_fails_closed(self):
        A.TOKEN = ""
        code, _ = self._post("/api/alert", {"key": "k", "title": "t", "message": "m"})
        self.assertEqual(code, 503)
        A.TOKEN = "secret"


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'alert_sidecar'`.

- [ ] **Step 3: Write the sidecar**

`alert-sidecar/alert_sidecar.py`:

```python
#!/usr/bin/env python3
# alert_sidecar.py — bearer-authenticated push API for critical alerts.
# Zero third-party deps. Owns the alert set: validates, persists atomically
# (temp + os.replace under a lock), and serves the current list as JSON.
import json, os, re, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ.get("ALERT_API_TOKEN", "").strip()
ALERTS_FILE = os.environ.get("ALERTS_FILE", "/data/alerts.json")
PORT = int(os.environ.get("ALERT_PORT", "8090"))
MAX_ACTIVE = int(os.environ.get("ALERT_MAX_ACTIVE", "20"))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_lock = threading.Lock()


def now_ms():
    return int(time.time() * 1000)


def _read():
    try:
        with open(ALERTS_FILE) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, ValueError, OSError):
        return []


def _write_atomic(items):
    d = os.path.dirname(ALERTS_FILE) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".alerts.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(items, f)
        os.replace(tmp, ALERTS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate_alert(body):
    if not isinstance(body, dict):
        return None, "body must be a JSON object"
    key = body.get("key")
    if not isinstance(key, str) or not KEY_RE.match(key):
        return None, "key required, [A-Za-z0-9_.-]{1,64}"
    sev = body.get("severity", "critical")
    if sev not in ("warning", "critical"):
        return None, "severity must be warning|critical"
    title = body.get("title")
    if not isinstance(title, str) or not (1 <= len(title) <= 80):
        return None, "title required, 1..80 chars"
    msg = body.get("message")
    if not isinstance(msg, str) or not (1 <= len(msg) <= 240):
        return None, "message required, 1..240 chars"
    target = body.get("target", "all")
    if not isinstance(target, str) or len(target) > 64:
        return None, "target must be a string <=64 chars"
    return {"key": key, "severity": sev, "title": title,
            "message": msg, "target": target}, None


def upsert(alert):
    with _lock:
        items = [a for a in _read() if a.get("key") != alert["key"]]
        if len(items) >= MAX_ACTIVE:
            return None
        items.append(dict(alert, ts=now_ms()))
        _write_atomic(items)
        return len(items)


def clear(key):
    with _lock:
        items = _read()
        kept = [a for a in items if a.get("key") != key]
        changed = len(kept) != len(items)
        if changed:
            _write_atomic(kept)
        return changed


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        # None -> token unset (fail closed); True/False -> bearer match.
        if not TOKEN:
            return None
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def _guard(self):
        a = self._auth()
        if a is None:
            self._json(503, {"error": "ALERT_API_TOKEN not set"})
            return False
        if not a:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b"{}"
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True})
        if path == "/alerts.json":
            return self._json(200, _read())
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._guard():
            return
        path = urlparse(self.path).path
        body = self._body()
        if body is None:
            return self._json(400, {"error": "invalid JSON"})
        if path == "/api/alert":
            alert, err = validate_alert(body)
            if err:
                return self._json(400, {"error": err})
            count = upsert(alert)
            if count is None:
                return self._json(409, {"error": "too many active alerts"})
            return self._json(200, {"ok": True, "count": count})
        if path == "/api/alert/clear":
            key = body.get("key")
            if not isinstance(key, str) or not KEY_RE.match(key):
                return self._json(400, {"error": "key required"})
            return self._json(200, {"ok": True, "cleared": clear(key)})
        return self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._guard():
            return
        if urlparse(self.path).path != "/api/alert":
            return self._json(404, {"error": "not found"})
        key = (parse_qs(urlparse(self.path).query).get("key") or [""])[0]
        if not KEY_RE.match(key or ""):
            return self._json(400, {"error": "key required"})
        return self._json(200, {"ok": True, "cleared": clear(key)})


def main():
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: PASS — all tests OK.

- [ ] **Step 5: Commit**

```bash
git add alert-sidecar/alert_sidecar.py alert-sidecar/test_alert_sidecar.py
git commit -m "feat: alert sidecar service (bearer auth, keyed upsert/clear, atomic writes)"
```

---

### Task 2: Sidecar container + compose service

**Files:**
- Create: `alert-sidecar/Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `alert_sidecar.py` from Task 1.
- Produces: a running `alert-sidecar` service reachable at `alert-sidecar:8090` on the compose network, with `ALERT_API_TOKEN` env and a `/api/health` healthcheck.

- [ ] **Step 1: Write the sidecar Dockerfile**

`alert-sidecar/Dockerfile`:

```dockerfile
# Tiny zero-dependency alert API. Python stdlib only.
FROM python:3.12-alpine
WORKDIR /app
COPY alert_sidecar.py /app/alert_sidecar.py
RUN mkdir -p /data
EXPOSE 8090
CMD ["python3", "/app/alert_sidecar.py"]
```

- [ ] **Step 2: Add the compose service**

In `docker-compose.yml`, under `services:` add (and add a top-level `volumes:` block if absent):

```yaml
  alert-sidecar:
    build: ./alert-sidecar
    image: clock-alert-sidecar
    container_name: clock-alert-sidecar
    environment:
      # Shared secret HA sends as `Authorization: Bearer <token>`. REQUIRED to
      # enable the API — unset/blank means the sidecar rejects all writes (503).
      ALERT_API_TOKEN: "${ALERT_API_TOKEN:-}"
      ALERTS_FILE: "/data/alerts.json"
    volumes:
      - alertdata:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python3", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8090/api/health').status==200 else 1)"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  alertdata:
```

Also add `ALERT_API_TOKEN: "${ALERT_API_TOKEN:-}"` to the existing `clock` service's `environment:` block (the clock container needs it to render the admin clear-proxy token — Task 3).

- [ ] **Step 3: Validate the compose file**

Run: `docker compose config >/dev/null && echo OK`
Expected: `OK` (compose file parses; the new service + volume resolve).

If Docker is available, build + smoke-test the sidecar in isolation:

```bash
docker compose build alert-sidecar
ALERT_API_TOKEN=testtok docker compose run --rm -p 8090:8090 -d --name sc-smoke alert-sidecar
sleep 2
curl -s localhost:8090/api/health                      # {"ok": true}
curl -s -XPOST localhost:8090/api/alert -H "Authorization: Bearer testtok" \
  -H 'Content-Type: application/json' \
  -d '{"key":"t","title":"Test","message":"hi"}'        # {"ok": true, "count": 1}
curl -s localhost:8090/alerts.json                      # [{"key":"t",...}]
docker rm -f sc-smoke
```
Expected: health ok, POST returns `count:1`, `alerts.json` shows the alert. (If Docker is unavailable in this environment, note that and rely on Task 1's unit tests + `docker compose config`.)

- [ ] **Step 4: Commit**

```bash
git add alert-sidecar/Dockerfile docker-compose.yml
git commit -m "feat: containerize alert sidecar + compose service with healthcheck"
```

---

### Task 3: nginx wiring + admin-clear token proxy

**Files:**
- Modify: `nginx.conf`
- Create: `docker-entrypoint.d/20-alert-token.sh`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: the `alert-sidecar:8090` service from Task 2.
- Produces: `GET /alerts.json` and `/api/*` proxied to the sidecar; `POST /admin/alert-clear` (basic-auth gated) that proxies to the sidecar's clear with the bearer token injected from env.

- [ ] **Step 1: Add the nginx locations**

In `nginx.conf`, after the `location = /source.json { … }` block (before `location /uploads/`), add:

```nginx
  # Critical alerts — served by the alert sidecar (not a static file). Devices
  # poll this; it is open GET and must always be fresh. Proxied via a variable +
  # resolver so nginx starts even if the sidecar is briefly down.
  location = /alerts.json {
    resolver 127.0.0.11 ipv6=off valid=30s;
    set $alert_up "alert-sidecar:8090";
    proxy_pass http://$alert_up/alerts.json;
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
  }
  # Write API for Home Assistant. Bearer auth is enforced by the sidecar itself
  # (not nginx). Forwards the Authorization header through.
  location /api/ {
    resolver 127.0.0.11 ipv6=off valid=30s;
    set $alert_up "alert-sidecar:8090";
    proxy_pass http://$alert_up$request_uri;
  }
  # Admin "clear alert" — basic-auth gated. nginx injects the bearer token from
  # env (written to alert_clear.conf at startup) so the admin page never sees it.
  location = /admin/alert-clear {
    include /etc/nginx/admin_auth.conf;
    resolver 127.0.0.11 ipv6=off valid=30s;
    set $alert_up "alert-sidecar:8090";
    include /etc/nginx/alert_clear.conf;
  }
```

- [ ] **Step 2: Write the token-snippet entrypoint**

`docker-entrypoint.d/20-alert-token.sh`:

```sh
#!/bin/sh
# Write the nginx snippet for /admin/alert-clear. When ALERT_API_TOKEN is set,
# proxy the admin clear action to the sidecar with the bearer token injected
# (so the admin page never handles the raw token). Otherwise disable it (503).
CONF=/etc/nginx/alert_clear.conf
if [ -n "$ALERT_API_TOKEN" ]; then
  cat > "$CONF" <<EOF
proxy_set_header Authorization "Bearer $ALERT_API_TOKEN";
proxy_set_header Content-Type application/json;
proxy_pass http://\$alert_up/api/alert/clear;
EOF
  echo "clock: admin alert-clear proxy enabled"
else
  printf 'return 503;\n' > "$CONF"
  echo "clock: ALERT_API_TOKEN unset — admin alert-clear disabled"
fi
```

(Note the escaped `\$alert_up` — the snippet must emit a literal nginx variable, not let the shell expand it.)

- [ ] **Step 3: Wire the entrypoint + pre-create the snippet in the Dockerfile**

In `Dockerfile`, in the entrypoint `COPY`/`chmod` block, add `20-alert-token.sh`:

```dockerfile
COPY docker-entrypoint.d/10-admin-auth.sh    /docker-entrypoint.d/10-admin-auth.sh
COPY docker-entrypoint.d/20-alert-token.sh   /docker-entrypoint.d/20-alert-token.sh
COPY docker-entrypoint.d/30-clock-config.sh  /docker-entrypoint.d/30-clock-config.sh
COPY docker-entrypoint.d/40-weather-fetch.sh /docker-entrypoint.d/40-weather-fetch.sh
RUN chmod +x /docker-entrypoint.d/10-admin-auth.sh /docker-entrypoint.d/20-alert-token.sh /docker-entrypoint.d/30-clock-config.sh /docker-entrypoint.d/40-weather-fetch.sh
```

And next to the existing `RUN : > /etc/nginx/admin_auth.conf` line, add a pre-create so `nginx -t` passes before the entrypoint runs:

```dockerfile
RUN : > /etc/nginx/admin_auth.conf && printf 'return 503;\n' > /etc/nginx/alert_clear.conf
```

- [ ] **Step 4: Full-stack verification**

Run (Docker required):

```bash
ALERT_API_TOKEN=testtok docker compose up -d --build
sleep 4
# write via the nginx-proxied API with the bearer:
curl -s -XPOST localhost:8080/api/alert -H "Authorization: Bearer testtok" \
  -H 'Content-Type: application/json' \
  -d '{"key":"leak1","severity":"critical","title":"Water Leak","message":"Basement wet"}'
# device-facing read (open, proxied):
curl -s localhost:8080/alerts.json                       # shows leak1
# wrong bearer rejected:
curl -s -o /dev/null -w "%{http_code}\n" -XPOST localhost:8080/api/alert \
  -H "Authorization: Bearer nope" -d '{}'                # 401
# clear:
curl -s -XPOST localhost:8080/api/alert/clear -H "Authorization: Bearer testtok" \
  -H 'Content-Type: application/json' -d '{"key":"leak1"}'
curl -s localhost:8080/alerts.json                       # []
docker compose down
```
Expected: POST stores `leak1`, `/alerts.json` reflects it, wrong bearer → 401, clear empties it. (If Docker is unavailable here, validate `nginx.conf` syntax with `docker run --rm -v "$PWD/nginx.conf":/etc/nginx/conf.d/default.conf nginx:1.27-alpine nginx -t` when possible, else note manual verification.)

- [ ] **Step 5: Commit**

```bash
git add nginx.conf docker-entrypoint.d/20-alert-token.sh Dockerfile
git commit -m "feat: proxy /alerts.json + /api to sidecar; admin clear with injected bearer"
```

---

### Task 4: `alertView` pure function + Node test

**Files:**
- Create: `js/alertview.js`
- Test: `test/alertview.test.js`

**Interfaces:**
- Produces: `alertView(list, profile) -> Array` — filters by `target` (`all` or case-insensitive match to `profile`), drops malformed entries, sorts critical-first then newest `ts`.

- [ ] **Step 1: Write the failing test**

`test/alertview.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertView } from '../js/alertview.js';

const A = (o) => Object.assign({ key:'k', severity:'critical', title:'T', message:'m', target:'all', ts:1 }, o);

test('drops entries with no key or message', () => {
  const out = alertView([A({key:''}), A({message:''}), A({key:'ok'})], 'None');
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'ok');
});

test('target all shows everywhere; targeted matches profile only', () => {
  const list = [A({key:'a', target:'all'}), A({key:'b', target:'Kitchen'})];
  assert.deepEqual(alertView(list, 'Kitchen').map(x=>x.key), ['a','b']);
  assert.deepEqual(alertView(list, 'Bedroom').map(x=>x.key), ['a']);
});

test('critical sorts before warning', () => {
  const out = alertView([A({key:'w', severity:'warning', ts:5}), A({key:'c', severity:'critical', ts:1})], 'None');
  assert.deepEqual(out.map(x=>x.key), ['c','w']);
});

test('within a tier, newest ts first', () => {
  const out = alertView([A({key:'old', ts:1}), A({key:'new', ts:9})], 'None');
  assert.deepEqual(out.map(x=>x.key), ['new','old']);
});

test('garbage input yields empty array', () => {
  assert.deepEqual(alertView(null, 'x'), []);
  assert.deepEqual(alertView('nope', 'x'), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/alertview.test.js`
Expected: FAIL — `Cannot find module '../js/alertview.js'`.

- [ ] **Step 3: Write the implementation**

`js/alertview.js`:

```js
// alertview.js — pure: choose + order the alerts a device should show.
// alertView(list, profile) -> array, critical first then newest ts.
export function alertView(list, profile){
  const prof = String(profile == null ? '' : profile).toLowerCase();
  const out = [];
  for (const a of (Array.isArray(list) ? list : [])){
    if (!a || !a.key || !a.message) continue;
    const tgt = String(a.target || 'all').toLowerCase();
    if (tgt !== 'all' && tgt !== prof) continue;
    out.push(a);
  }
  const rank = (s) => (s === 'critical' ? 0 : 1);
  out.sort((x, y) => rank(x.severity) - rank(y.severity) || (Number(y.ts) || 0) - (Number(x.ts) || 0));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/alertview.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add js/alertview.js test/alertview.test.js
git commit -m "feat: alertView() pure filter+sort for device alert rendering"
```

---

### Task 5: Device rendering + service worker

**Files:**
- Modify: `index.html` (alert overlay + warning banner markup)
- Modify: `css/styles.css` (overlay + banner styles)
- Modify: `js/app.js` (poll, render, dim override, alert chime)
- Modify: `sw.js` (alerts.json network-first + cache bump v16→v17)

**Interfaces:**
- Consumes: `alertView` from Task 4; `/alerts.json` from Task 3.
- Produces: `pollAlerts()`, `renderAlerts()`; `app._alerts`, `app._alertChimed` (Set), `app.alertActive` (bool).

- [ ] **Step 1: Add markup** to `index.html`

Immediately after the `#secondClock` block, add:

```html
    <!-- Critical-alert overlay (red, blocks the screen). Hidden unless a critical is active. -->
    <div class="alert-overlay" id="alertOverlay" hidden role="alertdialog" aria-label="Critical alert">
      <div class="alert-card">
        <div class="alert-title" id="alertTitle"></div>
        <div class="alert-message" id="alertMessage"></div>
        <div class="alert-time" id="alertTime"></div>
        <div class="alert-more" id="alertMore"></div>
      </div>
    </div>
    <!-- Warning banner (amber strip, non-blocking). -->
    <div class="alert-banner" id="alertBanner" hidden role="status"></div>
```

- [ ] **Step 2: Add styles** to `css/styles.css` (append)

```css
/* Critical alert overlay — red, blocks the screen, sits above announcements. */
.alert-overlay{
  position:fixed; inset:0; z-index:40;
  display:grid; place-items:center; padding:6vmin;
  background:rgba(90,0,0,.82); backdrop-filter:blur(2px);
  animation:alertPulse 1.6s ease-in-out infinite;
}
.alert-overlay[hidden]{ display:none; }
@keyframes alertPulse{ 0%,100%{background:rgba(90,0,0,.82)} 50%{background:rgba(140,0,0,.9)} }
.alert-card{ text-align:center; max-width:90vw; color:#fff; }
.alert-card .alert-title{ font-size:clamp(28px,7vmin,72px); font-weight:800; letter-spacing:.02em; }
.alert-card .alert-message{ font-size:clamp(16px,3.4vmin,34px); margin-top:.4em; opacity:.95; }
.alert-card .alert-time{ font-size:clamp(11px,1.8vmin,16px); margin-top:.8em; opacity:.7; letter-spacing:.1em; text-transform:uppercase; }
.alert-card .alert-more{ font-size:clamp(12px,2vmin,18px); margin-top:.8em; opacity:.85; }
/* Warning banner — amber top strip, non-blocking. */
.alert-banner{
  position:fixed; top:0; left:0; right:0; z-index:38;
  padding:10px 16px; text-align:center;
  background:rgba(180,120,0,.92); color:#fff; font-weight:600;
  font-size:clamp(13px,2.2vmin,18px);
}
.alert-banner[hidden]{ display:none; }
```

- [ ] **Step 3: Add poll + render + chime + dim override** to `js/app.js`

Add the import near the other imports:

```js
import { alertView } from './alertview.js';
```

Add to the `app` object literal: `_alerts:[], _alertChimed:null, _alertChimeTimer:null, alertActive:false,`.

Add an alert chime pattern inside `playChime` (extend the existing if-chain):

```js
    else if (name === 'alert'){ chimeTone(ctx, 988, 0, 0.16); chimeTone(ctx, 740, 0.18, 0.16); chimeTone(ctx, 988, 0.36, 0.2); }
```

Add the alert functions (near the announcement functions):

```js
// ---- Critical / warning alerts (Home Assistant push channel) ----
const ALERT_POLL_MS = 5000;
const ALERT_RECHIME_MS = 30000;

async function pollAlerts(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('alerts.json?ts=' + Date.now(), { cache:'no-store' });
    app._alerts = r.ok ? (await r.json()) : [];
    if (!Array.isArray(app._alerts)) app._alerts = [];
  } catch(_) { /* sidecar down / offline — keep last; clock unaffected */ }
  renderAlerts();
}

function fmtAlertTime(ts){
  try { return 'Raised ' + new Date(Number(ts)).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
  catch(_){ return ''; }
}

function renderAlerts(){
  try {
    const view = alertView(app._alerts, app.settings && app.settings.profile);
    const criticals = view.filter(a => a.severity === 'critical');
    const warnings = view.filter(a => a.severity !== 'critical');
    const overlay = $('alertOverlay'), banner = $('alertBanner');

    // Critical overlay shows the newest critical; extras summarized.
    if (overlay){
      if (criticals.length){
        const c = criticals[0];
        $('alertTitle').textContent = c.title || 'Alert';
        $('alertMessage').textContent = c.message || '';
        $('alertTime').textContent = fmtAlertTime(c.ts);
        $('alertMore').textContent = criticals.length > 1 ? ('+' + (criticals.length - 1) + ' more critical') : '';
        overlay.hidden = false;
      } else overlay.hidden = true;
    }
    // Warning banner shows the newest warning (count if several).
    if (banner){
      if (warnings.length){
        const w = warnings[0];
        banner.textContent = (w.title ? w.title + ' — ' : '') + (w.message || '')
          + (warnings.length > 1 ? ('  (+' + (warnings.length - 1) + ')') : '');
        banner.hidden = false;
      } else banner.hidden = true;
    }

    const nowActive = criticals.length > 0;
    // Critical overrides night-dim + re-asserts wake while active.
    if (nowActive && !app.alertActive){
      app.alertActive = true;
      if (app.deepDim) applyDim(false);
      try { if (app.wake) app.wake.enable(); } catch(_){}
    } else if (!nowActive && app.alertActive){
      app.alertActive = false;
      try { checkNightSchedule(); } catch(_){}   // restore dim if scheduled
    }

    // Chimes: warning chimes once per key; criticals re-chime on an interval.
    if (!app._alertChimed) app._alertChimed = new Set();
    for (const w of warnings){
      if (!app._alertChimed.has(w.key)){ app._alertChimed.add(w.key); playChime('alert'); }
    }
    const liveKeys = new Set(view.map(a => a.key));
    for (const k of Array.from(app._alertChimed)){ if (!liveKeys.has(k)) app._alertChimed.delete(k); }

    if (nowActive){
      if (!app._alertChimeTimer){
        playChime('alert');
        app._alertChimeTimer = setInterval(() => { if (app.alertActive) playChime('alert'); }, ALERT_RECHIME_MS);
      }
    } else if (app._alertChimeTimer){
      clearInterval(app._alertChimeTimer); app._alertChimeTimer = null;
    }
  } catch(_) { /* never break the clock */ }
}
```

Guard night-dim against criticals — in `checkNightSchedule`, add near the top (after the `if (!app.settings.night)` line):

```js
  if (app.alertActive){ if (app.deepDim) applyDim(false); return; }   // criticals keep the screen bright
```

Wire polling in `boot` (alongside the announcement polling setup):

```js
  app._alertChimed = new Set();
  try {
    pollAlerts();
    app.alertTimer = setInterval(pollAlerts, ALERT_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAlerts(); });
  } catch(_){}
```

- [ ] **Step 4: Service worker** — in `sw.js`, bump both constants `v16` → `v17`, and add `/alerts.json` to the network-first pathname test:

```js
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.pathname === '/profiles.json'
      || url.pathname === '/source.json' || url.pathname === '/alerts.json'
      || url.hostname.endsWith('zippopotam.us')){
```

(`js/alertview.js` is imported by `js/app.js`; add `'./js/alertview.js'` to `SHELL_FILES`.)

- [ ] **Step 5: Verify**

```bash
node --check js/app.js && echo "app.js OK"
node --test            # all pass (alertview + earlier suites)
```

Headless visual check (no Docker needed — serve a static `alerts.json` next to the app):

```bash
printf '[{"key":"leak1","severity":"critical","title":"Water Leak","message":"Basement sensor wet","target":"all","ts":%s}]' "$(date +%s)000" > alerts.json
python3 -m http.server 8080 >/dev/null 2>&1 &
SRV=$!; sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --window-size=1280,800 --virtual-time-budget=8000 --screenshot=/tmp/alert.png \
  "http://localhost:8080/?debug=1" 2>/dev/null
kill $SRV; rm -f alerts.json
echo "screenshot: /tmp/alert.png"   # red overlay with 'Water Leak / Basement sensor wet'
```
Confirm the red critical overlay renders with the title/message. Then test a `"severity":"warning"` entry shows the amber banner instead, and an empty `[]` shows neither. (Remove the temp `alerts.json` after — never commit it.)

- [ ] **Step 6: Commit**

```bash
git add index.html css/styles.css js/app.js sw.js
git commit -m "feat: device renders critical alert overlay + warning banner (5s poll, dim override, chime)"
```

---

### Task 6: Admin "Active Alerts" card

**Files:**
- Modify: `admin.html`

**Interfaces:**
- Consumes: `GET /alerts.json` (read), `POST /admin/alert-clear` (basic-auth gated proxy from Task 3).
- Produces: a read-only active-alert list + per-key Clear.

- [ ] **Step 1: Add the section markup** (match the file's existing `.card`/`.status`/`.hint` style, inside `.wrap`):

```html
    <section class="card">
      <h2>Active Alerts</h2>
      <p class="hint">Live critical/warning alerts pushed by Home Assistant. Clear one if it's stuck (HA normally clears its own).</p>
      <div id="alertList"></div>
      <div class="status" id="alertStatus" aria-live="polite"></div>
    </section>
```

- [ ] **Step 2: Add the handlers** (match the file's ES5-ish `var`/`function`/`$()` style):

```js
    function setAlertStatus(msg, ok){ var s=$('alertStatus'); s.textContent=msg; s.className='status '+(ok===true?'ok':ok===false?'err':''); }

    function loadAlerts(){
      fetch('alerts.json?ts=' + Date.now(), { cache:'no-store' }).then(function(r){
        return r.ok ? r.json() : [];
      }).then(function(list){
        if (!Array.isArray(list) || !list.length){
          $('alertList').innerHTML = '<span class="hint" style="margin:0">No active alerts.</span>';
          return;
        }
        $('alertList').innerHTML = list.map(function(a){
          var sev = a.severity === 'warning' ? 'warning' : 'critical';
          return '<div class="row"><span>['+sev+'] <strong>'+esc(a.title||'')+'</strong> — '+esc(a.message||'')
               + ' <em>('+esc(a.key)+')</em></span>'
               + '<button class="ctrl" type="button" data-key="'+esc(a.key)+'">Clear</button></div>';
        }).join('');
      }).catch(function(){ $('alertList').innerHTML = '<span class="hint" style="margin:0">Could not load alerts.</span>'; });
    }

    $('alertList').addEventListener('click', function(e){
      var btn = e.target.closest ? e.target.closest('button[data-key]') : null;
      if (!btn) return;
      var key = btn.getAttribute('data-key');
      setAlertStatus('Clearing…');
      fetch('admin/alert-clear', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key: key })
      }).then(function(r){
        setAlertStatus(r.ok ? 'Cleared "'+key+'".' : 'Failed (HTTP '+r.status+').', r.ok);
        loadAlerts();
      }).catch(function(e){ setAlertStatus('Failed: '+e, false); });
    });

    loadAlerts();
    setInterval(loadAlerts, 5000);
```

(`esc` already exists in admin.html for HTML escaping — reuse it.)

- [ ] **Step 3: Verify**

Sanity-read: ids `alertList`/`alertStatus` consistent between markup and JS; Clear POSTs to `admin/alert-clear` with `{key}`. With the full stack running (Task 3), push an alert via curl, confirm it appears in the admin list, click Clear, confirm it disappears and `/alerts.json` empties. Describe this in the report.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat: admin Active Alerts card with per-key Clear backstop"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the API + HA integration** in `README.md`

Add a "Critical Alerts (Home Assistant)" section covering:
- What it is: a bearer-authenticated push channel separate from announcements; `warning` (amber banner) vs `critical` (red overlay, overrides night-dim, repeating chime); HA owns clear-by-key.
- Setup: set `ALERT_API_TOKEN` in `docker-compose.yml` (or `.env`), `docker compose up -d --build`. **HTTPS strongly recommended** (the Caddyfile in this repo) so the bearer token isn't sent in clear text.
- API: `POST /api/alert` (header `Authorization: Bearer <token>`, body `{key, severity?, title, message, target?}`), `POST /api/alert/clear` `{key}`, `DELETE /api/alert?key=`. Note device read `GET /alerts.json`.
- The HA `rest_command` + automation example (verbatim from the spec's Component 6).
- Admin backstop: the "Active Alerts" card can clear a stuck alert.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Home Assistant critical-alerts API + setup"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (sidecar: bearer fail-closed, keyed upsert/clear, atomic writes, validation, cap, GET alerts) → Task 1. ✓
- Component 2 (nginx proxy `/api/` + `/alerts.json`, admin clear alias) → Task 3 (serving refined to proxy, noted up top). ✓
- Component 3 (device: 5s poll, critical overlay vs warning banner, dim override, chime, stacking) → Tasks 4 + 5. ✓
- Component 4 (admin Active Alerts + Clear via token-injected proxy) → Tasks 3 + 6. ✓
- Component 5 (SW v17, compose service, token entrypoint) → Tasks 2, 3, 5. ✓
- Component 6 (HA README) → Task 7. ✓
- Two severities, HA-owned lifecycle, fail-closed, atomic writes → Tasks 1, 5. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. Docker-gated verifications name a non-Docker fallback. ✓

**Type consistency:** `alertView(list, profile)` defined in Task 4, consumed in Task 5. Sidecar endpoints (`/api/alert`, `/api/alert/clear`, `/alerts.json`) consistent across Tasks 1/3/5/6. `app.alertActive`/`app._alertChimed`/`app._alerts` defined in the Task 5 app-literal edit and used in `renderAlerts`/`checkNightSchedule`. The `$alert_up` variable + `alert_clear.conf` snippet are consistent between nginx.conf (Task 3 Step 1) and the entrypoint (Task 3 Step 2). ✓
