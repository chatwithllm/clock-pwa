# Two-Way Home Assistant (Typed Alert Icons + Presence Relay) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Home Assistant integration both ways — HA-sent alerts carry a `type` that renders a blinking icon, and devices report present/away to HA via a sidecar relay.

**Architecture:** Phase 1 adds an optional `type` to the existing alert pipeline and maps it to a blinking emoji in the overlay/banner (pure clock change). Phase 2 has the device POST presence transitions to the sidecar (same-origin, no CORS), which forwards them server-side to an HA webhook. Everything reuses the existing alert API + camera-presence module.

**Tech Stack:** Vanilla-JS ES modules, Python 3 stdlib sidecar (`urllib` for the relay), nginx, Docker Compose. Tests: Node `--test` (pure JS), Python `unittest` (sidecar), manual (device UI / HA).

**Phasing:** Phase 1 = Tasks 1–3 (alert icons — pure clock, zero HA infra, shippable alone). Phase 2 = Tasks 4–6 (presence relay).

## Global Constraints

- **The clock must never break.** Icon render, presence POST, and the relay are wrapped; failure degrades to today's behavior.
- **Backward compatible:** alerts with no `type` render as today (default `⚠️` only if an icon element exists; no crash). Presence relay is a no-op when `HA_WEBHOOK_URL` is unset (`200 relayed:false`).
- **Dependency-free:** clock = vanilla JS/CSS (emoji + CSS blink); sidecar = Python stdlib only.
- **Privacy:** presence sends only `{ room, present }` — never camera frames.
- **Respect `prefers-reduced-motion`:** the blink animation only runs under `@media (prefers-reduced-motion: no-preference)`.
- **Reuse, don't fork** the alert API (`/api/alert`, `/alerts.json`) and the `Presence` module.
- **Token/trust:** `/api/presence` is open on the LAN (low-value boolean relay) — documented trusted-LAN assumption.

---

### Task 1: Alert `type` field (sidecar)

**Files:**
- Modify: `alert-sidecar/alert_sidecar.py` (`validate_alert`)
- Modify: `alert-sidecar/test_alert_sidecar.py`

**Interfaces:**
- Produces: alert objects gain an optional `type` (string `^[a-z0-9_]{1,32}$`), surfaced in `/alerts.json`.

- [ ] **Step 1: Write the failing tests** (append to `test_alert_sidecar.py`, inside `LogicTests`)

```python
    def test_validate_accepts_type(self):
        a, err = A.validate_alert({"key": "k", "title": "t", "message": "m", "type": "water_leak"})
        self.assertIsNone(err)
        self.assertEqual(a["type"], "water_leak")

    def test_validate_default_type_absent(self):
        a, _ = A.validate_alert({"key": "k", "title": "t", "message": "m"})
        self.assertNotIn("type", a)

    def test_validate_rejects_bad_type(self):
        _, err = A.validate_alert({"key": "k", "title": "t", "message": "m", "type": "Bad Type!"})
        self.assertIsNotNone(err)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: FAIL — `KeyError: 'type'` / accepts the bad type.

- [ ] **Step 3: Implement** — in `validate_alert`, before the `return`, add type handling, and include `type` in the returned dict only when present:

```python
    typ = body.get("type")
    if typ is not None and not re.match(r"^[a-z0-9_]{1,32}$", str(typ)):
        return None, "type must match ^[a-z0-9_]{1,32}$"
    out = {"key": key, "severity": sev, "title": title, "message": msg, "target": target}
    if typ is not None:
        out["type"] = typ
    return out, None
```

(Replace the existing `return {"key": key, …, "target": target}, None`.)

- [ ] **Step 4: Run to verify pass**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: PASS, output pristine.

- [ ] **Step 5: Commit**

```bash
git add alert-sidecar/alert_sidecar.py alert-sidecar/test_alert_sidecar.py
git commit -m "feat: optional type field on alerts (sidecar)"
```

---

### Task 2: `alertIcon(type)` pure function + tests

**Files:**
- Modify: `js/alertview.js`
- Modify: `test/alertview.test.js`

**Interfaces:**
- Produces: `alertIcon(type) -> string` (emoji; unknown/missing → `'⚠️'`).

- [ ] **Step 1: Write the failing tests** (append to `test/alertview.test.js`)

```js
import { alertIcon } from '../js/alertview.js';

test('alertIcon: known types map to emoji', () => {
  assert.equal(alertIcon('water_leak'), '💧');
  assert.equal(alertIcon('door'), '🚪');
  assert.equal(alertIcon('security'), '🔒');
  assert.equal(alertIcon('smoke'), '🔥');
});

test('alertIcon: unknown / missing -> warning default', () => {
  assert.equal(alertIcon('nope'), '⚠️');
  assert.equal(alertIcon(undefined), '⚠️');
  assert.equal(alertIcon(null), '⚠️');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/alertview.test.js`
Expected: FAIL — `alertIcon` not exported.

- [ ] **Step 3: Implement** — append to `js/alertview.js`:

```js
// Map a Home-Assistant alert `type` to a display emoji. Unknown/missing -> warning.
const ALERT_ICONS = {
  water_leak: '💧', door: '🚪', window: '🪟', security: '🔒', smoke: '🔥',
  co: '☣️', motion: '🚶', freeze: '🧊', power: '🔌', temperature: '🌡️',
};
export function alertIcon(type){
  return ALERT_ICONS[type] || '⚠️';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/alertview.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/alertview.js test/alertview.test.js
git commit -m "feat: alertIcon() type->emoji map for alert display"
```

---

### Task 3: Render the blinking icon (overlay + banner)

**Files:**
- Modify: `index.html` (alert overlay icon element)
- Modify: `css/styles.css` (icon + `alertBlink`)
- Modify: `js/app.js` (`renderAlerts` sets the icon; import `alertIcon`)

**Interfaces:**
- Consumes: `alertIcon` (Task 2); alert objects with optional `type` (Task 1).

- [ ] **Step 1: Add the overlay icon element** in `index.html` (inside `.alert-card`, before `#alertTitle`):

```html
        <div class="alert-icon" id="alertIcon" aria-hidden="true"></div>
```

- [ ] **Step 2: Add styles** in `css/styles.css` (append):

```css
/* Typed alert icon (overlay + banner), blinking — calmed under reduced-motion. */
.alert-card .alert-icon{ font-size:clamp(40px,12vmin,110px); line-height:1; margin-bottom:.15em; }
.alert-banner .alert-bicon{ margin-right:.4em; }
@media (prefers-reduced-motion: no-preference){
  .alert-card .alert-icon, .alert-banner .alert-bicon{ animation:alertBlink 1s steps(1,end) infinite; }
}
@keyframes alertBlink{ 0%,60%{opacity:1} 61%,100%{opacity:.25} }
```

- [ ] **Step 3: Set the icon in `renderAlerts`** (`js/app.js`)

Import `alertIcon`: change the `./alertview.js` import to `import { alertView, alertIcon } from './alertview.js';`.

In the critical branch (where `$('alertTitle').textContent = c.title …`), add:

```js
        $('alertIcon').textContent = alertIcon(c.type);
```

In the warning branch (where `banner.textContent = …`), prefix the icon as a span so it can blink independently:

```js
        banner.innerHTML = '<span class="alert-bicon">' + alertIcon(w.title ? w.type : w.type) + '</span>'
          + escHtml((w.title ? w.title + ' — ' : '') + (w.message || '')
            + (warnings.length > 1 ? ('  (+' + (warnings.length - 1) + ')') : ''));
```

(Reuse the existing `escHtml` helper for the text; the icon is a fixed emoji, safe. If `escHtml` isn't in scope here, use `textContent` for the text and prepend the icon span via a small DOM build instead of `innerHTML`.)

- [ ] **Step 4: Verify**

```bash
node --check js/app.js && echo "app.js OK"
node --test    # alertview + alertIcon green
```
Headless visual (serve a static `alerts.json` with a typed critical, screenshot the red overlay → 💧 blinking above the title; then a `type:'door'` warning → 🚪 in the amber banner; reduced-motion → static). Describe the steps in the report (serve `python3 -m http.server <free port>`, capture with headless Chrome at `?debug=1`).

- [ ] **Step 5: Commit**

```bash
git add index.html css/styles.css js/app.js
git commit -m "feat: blinking typed icon in alert overlay + banner (reduced-motion safe)"
```

---

### Task 4: Sidecar `POST /api/presence` relay

**Files:**
- Modify: `alert-sidecar/alert_sidecar.py`
- Modify: `alert-sidecar/test_alert_sidecar.py`

**Interfaces:**
- Produces: `POST /api/presence` `{ room, present }` → relays to `HA_WEBHOOK_URL` server-side; `200 {ok, relayed}`. Env `HA_WEBHOOK_URL`.

- [ ] **Step 1: Write the failing tests** (append a new class to `test_alert_sidecar.py`)

```python
import urllib.parse


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.received = []
        outer = self
        class HA(__import__('http.server', fromlist=['BaseHTTPRequestHandler']).BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                n = int(self.headers.get('Content-Length', '0'))
                outer.received.append(json.loads(self.rfile.read(n) or b'{}'))
                self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
        self.ha = ThreadingHTTPServer(('127.0.0.1', 0), HA)
        threading.Thread(target=self.ha.serve_forever, daemon=True).start()
        self.ha_url = f"http://127.0.0.1:{self.ha.server_address[1]}/hook"
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        self.ha.shutdown(); self.ha.server_close()
        A.HA_WEBHOOK_URL = ""

    def _post(self, body):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/presence",
                                     data=json.dumps(body).encode(), method="POST")
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e: return e.code, json.load(e)

    def test_no_webhook_is_noop(self):
        A.HA_WEBHOOK_URL = ""
        code, body = self._post({"room": "Kitchen", "present": True})
        self.assertEqual(code, 200)
        self.assertFalse(body["relayed"])

    def test_relays_to_ha(self):
        A.HA_WEBHOOK_URL = self.ha_url
        code, body = self._post({"room": "Kitchen", "present": True})
        self.assertEqual(code, 200)
        self.assertTrue(body["relayed"])
        self.assertEqual(self.received[-1], {"room": "Kitchen", "present": True})

    def test_bad_body_400(self):
        A.HA_WEBHOOK_URL = self.ha_url
        self.assertEqual(self._post({"room": "Kitchen"})[0], 400)          # missing present
        self.assertEqual(self._post({"present": True})[0], 400)            # missing room
        self.assertEqual(self._post({"room": "x/y", "present": True})[0], 400)  # bad room
```

- [ ] **Step 2: Run to verify failure**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: FAIL — `/api/presence` 404 / `HA_WEBHOOK_URL` undefined.

- [ ] **Step 3: Implement** in `alert_sidecar.py`

Add env near the others: `HA_WEBHOOK_URL = os.environ.get("HA_WEBHOOK_URL", "").strip()`.

Add a handler method on `Handler`:

```python
    def _handle_presence(self):
        body = self._body()
        if not isinstance(body, dict):
            return self._json(400, {"error": "bad body"})
        room = body.get("room")
        present = body.get("present")
        if not isinstance(room, str) or not PROFILE_RE.match(room) or not isinstance(present, bool):
            return self._json(400, {"error": "room (profile) + present(bool) required"})
        if not HA_WEBHOOK_URL:
            return self._json(200, {"ok": True, "relayed": False})
        try:
            data = json.dumps({"room": room, "present": present}).encode()
            req = urllib.request.Request(HA_WEBHOOK_URL, data=data,
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=4):
                pass
            return self._json(200, {"ok": True, "relayed": True})
        except Exception:
            return self._json(200, {"ok": True, "relayed": False})  # HA down -> never error the kiosk
```

Route it FIRST in `do_POST` (before the alert/snapshot dispatch), so it needs no bearer:

```python
    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/presence":
            return self._handle_presence()
        if path == "/api/snapshot":
            return self._handle_snapshot()
        # ... existing _guard() + /api/alert + /api/alert/clear ...
```

Add `import urllib.request, urllib.error` at the top if not already present (the file already imports `urllib.parse`; ensure `urllib.request` is imported).

- [ ] **Step 4: Run to verify pass**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: PASS (presence + earlier tests), output pristine.

- [ ] **Step 5: Commit**

```bash
git add alert-sidecar/alert_sidecar.py alert-sidecar/test_alert_sidecar.py
git commit -m "feat: sidecar POST /api/presence relays present/away to HA webhook (server-side, no CORS)"
```

---

### Task 5: Device reports presence transitions

**Files:**
- Modify: `js/app.js` (`applyPresence` posts on transition)

**Interfaces:**
- Consumes: `POST /api/presence` (Task 4); `app.settings.profile`, `app.presentNow`.

- [ ] **Step 1: Implement transition-posting in `applyPresence`** (`js/app.js`)

Add to the `app` object literal: `_lastPresencePostMs: -Infinity,`.

Add a poster + call it from `applyPresence` on a real transition (compare BEFORE updating `app.presentNow`):

```js
const PRESENCE_POST_MIN_MS = 5000;
function postPresence(present){
  try {
    if (typeof fetch !== 'function') return;
    const room = app.settings && app.settings.profile;
    if (!room || room === 'None') return;                 // no room -> nothing to report
    const now = Date.now();
    if (now - app._lastPresencePostMs < PRESENCE_POST_MIN_MS) return;
    app._lastPresencePostMs = now;
    fetch('api/presence', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ room: room, present: !!present }),
    }).catch(() => {});   // sidecar relays or drops; failure never affects the clock
  } catch(_){}
}
```

In `applyPresence`, detect the transition and post:

```js
function applyPresence(present){
  if (present !== app.presentNow) { try { postPresence(present); } catch(_){} }
  app.presentNow = present;
  try { checkNightSchedule(); } catch(_){}
}
```

- [ ] **Step 2: Verify**

```bash
node --check js/app.js && echo "OK"
node --test    # all green (no logic regressions)
```
Static check: `applyPresence` posts only when `present` differs from `app.presentNow` and `profile !== 'None'`. Describe in the report. (End-to-end relay is covered by Task 4's sidecar tests + the Task 6 stack check.)

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "feat: device posts presence transitions to /api/presence (room=profile, debounced)"
```

---

### Task 6: Deploy wiring + docs

**Files:**
- Modify: `docker-compose.yml` (sidecar `HA_WEBHOOK_URL`)
- Modify: `sw.js` (cache bump)
- Modify: `README.md`

- [ ] **Step 1: Compose env** — in `docker-compose.yml`, add to the `alert-sidecar` service `environment:`:

```yaml
      # Home Assistant webhook the sidecar relays presence to (server-side, no CORS).
      # Unset = presence relay is a no-op. e.g. https://ha.local:8123/api/webhook/<id>
      HA_WEBHOOK_URL: "${HA_WEBHOOK_URL:-}"
```

- [ ] **Step 2: SW bump** — in `sw.js`, bump both cache constants to the next version (e.g. `v19` → `v20`). (No new shell files; the icon CSS ships in `styles.css` already cached.)

- [ ] **Step 3: README** — add to the alerts/HA docs:
  - **Typed alert icons:** the `rest_command` payload now takes `type` —
    `'{"key":"{{ key }}","severity":"{{ severity }}","type":"{{ type }}","title":"{{ title }}","message":"{{ message }}"}'`;
    list the supported types and that unknown → ⚠️.
  - **Presence → HA:** set `HA_WEBHOOK_URL` (sidecar env, e.g. via `.env`/override). When set, a device with camera Presence on reports present/away (room = its profile) — the sidecar forwards `{ room, present }` to the webhook. Include an HA **webhook automation** example that flips a per-room `input_boolean`/template `binary_sensor` from the payload, and note presence is **off when the profile is None** and that `/api/presence` is open on the LAN by design (trusted-LAN).

- [ ] **Step 4: Full-stack verify** (Docker)

```bash
cd /Users/assistant/dev/active/clock-pwa
# point the sidecar at a throwaway local "HA" so we can see the relay:
python3 -c "import http.server,socketserver,threading,json
class H(http.server.BaseHTTPRequestHandler):
  def log_message(s,*a): pass
  def do_POST(s):
    n=int(s.headers.get('Content-Length','0')); print('HA GOT', s.rfile.read(n)); s.send_response(200); s.send_header('Content-Length','0'); s.end_headers()
socketserver.TCPServer(('0.0.0.0',8123),H).serve_forever()" &
HA=$!; sleep 1
HA_WEBHOOK_URL="http://host.docker.internal:8123/hook" ALERT_API_TOKEN=t docker compose up -d --build
sleep 5
# typed alert -> shows in alerts.json with type:
curl -s -XPOST localhost:8080/api/alert -H "Authorization: Bearer t" -H 'Content-Type: application/json' \
  -d '{"key":"leak1","severity":"critical","type":"water_leak","title":"Leak","message":"wet"}' >/dev/null
curl -s localhost:8080/alerts.json | grep -o '"type": *"water_leak"'        # present
# presence relay (open, no auth):
curl -s -XPOST localhost:8080/api/presence -H 'Content-Type: application/json' -d '{"room":"Kitchen","present":true}'   # {"ok":true,"relayed":true}
# the backgrounded HA stub prints: HA GOT b'{"room": "Kitchen", "present": true}'
docker compose down; kill $HA 2>/dev/null
```
Expected: `alerts.json` carries `type:"water_leak"`; `/api/presence` returns `relayed:true` and the stub HA receives `{room, present}`. (If `host.docker.internal` isn't routable on Linux, use the host's LAN IP for `HA_WEBHOOK_URL`. If Docker is unavailable, rely on the unit tests + `docker compose config`.)

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml sw.js README.md
git commit -m "feat: HA_WEBHOOK_URL wiring, SW bump, typed-alert + presence-webhook docs"
```

---

## Self-Review

**Spec coverage:**
- A1 alert `type` (sidecar validate) → Task 1. ✓
- A2 `alertIcon` map → Task 2. ✓
- A2 render blinking icon + reduced-motion → Task 3. ✓
- A HA `rest_command` with type → Task 6 docs. ✓
- B1 `/api/presence` relay + `HA_WEBHOOK_URL` → Task 4. ✓
- B2 device posts transitions (room=profile, skip None, min-interval) → Task 5. ✓
- B3 HA webhook automation docs → Task 6. ✓
- Compose env + SW bump → Task 6. ✓

**Placeholder scan:** No TBD/TODO; complete code each step. `<id>`/`HA_WEBHOOK_URL` are config placeholders, marked. Docker-gated step names a fallback. ✓

**Type consistency:** `alertIcon(type)` defined Task 2, used Task 3. Alert `type` shape (`^[a-z0-9_]{1,32}$`) consistent Task 1 ↔ Task 2 keys. `/api/presence` body `{room, present}` consistent across Task 4 (sidecar), Task 5 (device), Task 6 (stack test). `app._lastPresencePostMs`/`app.presentNow` defined/used in Task 5. `HA_WEBHOOK_URL` env consistent Task 4 ↔ Task 6. ✓
