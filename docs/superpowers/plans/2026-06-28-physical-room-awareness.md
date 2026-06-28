# Physical Room Awareness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dedicated-iPhone clock displays aware of their room (NFC→profile) and the people near them (front-camera motion presence → dim; arrival snapshots → TrueNAS), within iOS's real limits.

**Architecture:** iOS does the NFC reading (a URL tag + Shortcut hits `?profile=`); the app just persists it and toasts. A dependency-free `js/presence.js` runs in-browser motion detection (no faces, no web NFC, no battery API — all unsupported on iOS) and drives the existing deep-dim. On arrival it can capture one JPEG and POST it to the alert sidecar, which writes it to a NAS-mounted folder under a separate low-privilege token.

**Tech Stack:** Vanilla-JS ES modules, Python 3 stdlib sidecar, nginx reverse proxy, Docker Compose + NFS volume. Tests: Node `--test` (pure JS), Python `unittest` (sidecar), manual on-device (camera).

**Phasing:** Phase 1 = Task 1 (NFC profile + kiosk docs). Phase 2 = Tasks 2–3 (camera presence dimming). Phase 3 = Tasks 4–7 (arrival snapshots → NAS). Each phase ships independently.

## Global Constraints

- **The clock must never break.** Camera/presence/snapshot/NFC paths are all wrapped; any failure degrades silently to today's behavior — never a blank/frozen clock.
- **Camera is opt-in, off by default.** Two independent settings: `presence` (camera→dimming) and `saveSnapshots` (upload arrival JPEGs). Presence runs with snapshots off.
- **Presence analysis is in-browser only** — raw frames are never stored/sent; only a present/away boolean leaves the detector. The only image that leaves the device is the arrival snapshot, only when `saveSnapshots` is on.
- **Least-privilege upload.** A dedicated `SNAPSHOT_TOKEN` (env) authorizes ONLY `/api/snapshot` — never the admin password or `ALERT_API_TOKEN`. The two tokens must not cross-authorize.
- **Bounded storage.** Per-upload size cap (`SNAPSHOT_MAX_BYTES`, default 1 MiB) + retention prune (`SNAPSHOT_RETENTION_DAYS` 30, `SNAPSHOT_MAX_PER_ROOM` 1000).
- **No new browser dependencies** — motion is plain vanilla JS (no face model/WASM). Sidecar stays Python stdlib only.
- **Camera needs HTTPS** (secure context) — documented as a hard requirement.
- **Under Guided Access the app cannot power the screen** — "away" = the existing deep-dim/near-black, not a real screen-off.

**Refinement vs spec:** the spec delivered `SNAPSHOT_TOKEN` to the kiosk via `config.json`. This plan uses a dedicated served `snapshot.json` written by its own entrypoint instead — `config.json` is only (re)written when `CLOCK_LAT/LON` are set, so folding the token in there would be unreliable. Same trust model (low-privilege token, trusted LAN).

---

### Task 1: NFC → profile confirmation toast + kiosk/NFC docs

**Files:**
- Modify: `index.html` (toast element)
- Modify: `css/styles.css` (toast style)
- Modify: `js/app.js` (show toast when loaded with `?profile=`)
- Modify: `README.md` (Guided Access kiosk setup + NFC tag + Shortcut)

**Interfaces:**
- Consumes: existing `?profile=` handling (`js/settings.js` already reads + persists `profile`).
- Produces: `showProfileToast(name)` in `app.js`.

- [ ] **Step 1: Add the toast element** to `index.html` (after the `#alertBanner` element):

```html
    <!-- Brief confirmation when a dock/NFC tap re-roomed this display. -->
    <div class="profile-toast" id="profileToast" hidden role="status"></div>
```

- [ ] **Step 2: Add the toast style** to `css/styles.css` (append):

```css
/* Profile-switch confirmation toast (NFC dock). */
.profile-toast{
  position:fixed; left:50%; bottom:calc(env(safe-area-inset-bottom,0px) + 24px);
  transform:translateX(-50%);
  z-index:42; padding:10px 18px; border-radius:999px;
  background:rgba(20,22,28,.92); color:var(--fg,#e6e6e6);
  font-size:clamp(13px,2.4vmin,18px); font-weight:600; letter-spacing:.04em;
  box-shadow:0 6px 24px rgba(0,0,0,.4); opacity:0; transition:opacity .3s ease;
}
.profile-toast.show{ opacity:1; }
.profile-toast[hidden]{ display:none; }
```

- [ ] **Step 3: Add `showProfileToast` + call it on boot** in `js/app.js`

Add the function near the other UI helpers:

```js
// Brief "you're now in <room>" toast — shown when the page loads with a ?profile=
// param (an NFC dock / Shortcut just re-roomed this display). Auto-dismisses.
let _profileToastTimer = null;
function showProfileToast(name){
  try {
    const el = $('profileToast'); if (!el || !name) return;
    el.textContent = name;
    el.hidden = false;
    void el.offsetWidth;            // reflow so the transition runs
    el.classList.add('show');
    if (_profileToastTimer) clearTimeout(_profileToastTimer);
    _profileToastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 350);
    }, 4000);
  } catch(_){}
}
```

In `boot()`, after `app.settings = loadSettings();` succeeds and `syncButtons()` has run, add:

```js
  // NFC dock / Shortcut opens the page with ?profile=<room> — confirm the switch.
  try {
    const urlProfile = new URLSearchParams(location.search).get('profile');
    if (urlProfile && urlProfile.trim()) showProfileToast(urlProfile.trim());
  } catch(_){}
```

- [ ] **Step 4: Verify the toast**

```bash
node --check js/app.js && echo OK
python3 -m http.server 8088 >/dev/null 2>&1 & SRV=$!; sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --window-size=900,600 --virtual-time-budget=6000 --screenshot=/tmp/toast.png \
  "http://localhost:8088/?profile=Theater%20Room&debug=1" 2>/dev/null
kill $SRV; echo "screenshot /tmp/toast.png — expect 'Theater Room' pill near the bottom"
```
(The toast is visible ~4s; the virtual-time screenshot may or may not catch it — if not, confirm via DevTools that `#profileToast` got `.show` with text "Theater Room". The logic is simple/guarded.)

- [ ] **Step 5: Document kiosk + NFC** in `README.md`

Add a "Room awareness — NFC profiles" section covering:
- **Kiosk:** run the clock in full-screen **Safari** (not an installed PWA — see why under presence), locked with **Guided Access** (Settings → Accessibility → Guided Access). Set **Display Auto-Lock = Never** + enable **Mirror Display Auto-Lock**. Serve over **HTTPS** (the repo `Caddyfile`).
- **NFC tag:** encode an NDEF **URL record** `https://<clock-host>/?profile=<room>` (URL-encode spaces, e.g. `Theater%20Room`) on a tag at each charger.
- **Automatic switch:** create a per-phone **iOS Shortcuts Personal Automation** → *NFC → scan tag → Open URL* with **"Ask Before Running" off**. Docking the phone re-rooms the display with no prompt. (A plain NDEF-URL tap with the system banner is the no-Shortcut fallback.)
- Note: iOS has **no Web NFC API** — the app never touches NFC; iOS reads the tag and opens the URL.

- [ ] **Step 6: Commit**

```bash
git add index.html css/styles.css js/app.js README.md
git commit -m "feat: NFC dock profile confirmation toast + kiosk/NFC setup docs"
```

---

### Task 2: Presence pure functions + tests

**Files:**
- Create: `js/presence.js` (pure exports only for now)
- Test: `test/presence.test.js`

**Interfaces:**
- Produces:
  - `motionScore(prev, curr) -> number` — mean absolute per-pixel delta of two equal-length grayscale arrays (0–255). Returns `0` if either is null/empty/mismatched (no motion baseline).
  - `presenceReducer(state, motionNow, nowMs, graceMs) -> {present, lastMotionMs}` — motion → present immediately; no motion for ≥ `graceMs` since `lastMotionMs` → away.
  - `shouldSnapshot(lastSnapMs, nowMs, cooldownMs) -> boolean` — true when the cooldown has elapsed.

- [ ] **Step 1: Write the failing tests**

`test/presence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionScore, presenceReducer, shouldSnapshot } from '../js/presence.js';

test('motionScore: identical frames score 0', () => {
  assert.equal(motionScore([10,20,30], [10,20,30]), 0);
});

test('motionScore: full swing scores ~255', () => {
  assert.equal(motionScore([0,0,0], [255,255,255]), 255);
});

test('motionScore: null / mismatched -> 0 (no baseline)', () => {
  assert.equal(motionScore(null, [1,2,3]), 0);
  assert.equal(motionScore([1,2], [1,2,3]), 0);
});

test('presenceReducer: motion -> present, stamps lastMotion', () => {
  const s = presenceReducer({present:false, lastMotionMs:0}, true, 1000, 90000);
  assert.equal(s.present, true);
  assert.equal(s.lastMotionMs, 1000);
});

test('presenceReducer: no motion within grace stays present', () => {
  const s = presenceReducer({present:true, lastMotionMs:1000}, false, 1000+89000, 90000);
  assert.equal(s.present, true);
});

test('presenceReducer: no motion past grace -> away', () => {
  const s = presenceReducer({present:true, lastMotionMs:1000}, false, 1000+90000, 90000);
  assert.equal(s.present, false);
});

test('shouldSnapshot: gated by cooldown', () => {
  assert.equal(shouldSnapshot(1000, 1000+299999, 300000), false);
  assert.equal(shouldSnapshot(1000, 1000+300000, 300000), true);
  assert.equal(shouldSnapshot(-Infinity, 0, 300000), true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/presence.test.js`
Expected: FAIL — `Cannot find module '../js/presence.js'`.

- [ ] **Step 3: Write the pure functions**

`js/presence.js` (pure section — the camera class is added in Task 3):

```js
// presence.js — front-camera motion presence (in-browser only) + arrival snapshots.
// Pure helpers first; the camera/DOM controller is added below in Task 3.

// Mean absolute per-pixel delta of two equal-length grayscale arrays (0..255).
// Returns 0 when there is no valid baseline (null/empty/length mismatch).
export function motionScore(prev, curr){
  if (!prev || !curr || prev.length === 0 || prev.length !== curr.length) return 0;
  let sum = 0;
  for (let i = 0; i < curr.length; i++){
    const d = curr[i] - prev[i];
    sum += d < 0 ? -d : d;
  }
  return sum / curr.length;
}

// Presence state machine. motionNow brightens immediately; absence past graceMs dims.
export function presenceReducer(state, motionNow, nowMs, graceMs){
  if (motionNow) return { present: true, lastMotionMs: nowMs };
  const present = (nowMs - state.lastMotionMs) < graceMs;
  return { present, lastMotionMs: state.lastMotionMs };
}

// Snapshot cooldown gate.
export function shouldSnapshot(lastSnapMs, nowMs, cooldownMs){
  return (nowMs - lastSnapMs) >= cooldownMs;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/presence.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add js/presence.js test/presence.test.js
git commit -m "feat: presence pure helpers (motionScore, presenceReducer, shouldSnapshot) + tests"
```

---

### Task 3: Camera presence controller + dim integration

**Files:**
- Modify: `js/presence.js` (add the `Presence` controller class)
- Modify: `js/settings.js` (`presence` setting + URL param + persist)
- Modify: `index.html` (Presence toggle + hidden `<video>`/`<canvas>`)
- Modify: `css/styles.css` (hide the capture elements)
- Modify: `js/app.js` (wire start/stop + dim composition)

**Interfaces:**
- Consumes: `motionScore`, `presenceReducer` from Task 2.
- Produces: `new Presence(video, canvas, { onPresence })` with `.start()` / `.stop()`; `app.presence`, `app.presentNow` (bool).

- [ ] **Step 1: Add the `presence` setting** in `js/settings.js`

In `DEFAULTS` (near `soundEnabled`):

```js
  presence: false,      // front-camera motion presence -> dim when no one is near (opt-in; needs HTTPS + camera)
```

In `readURL`, add:

```js
    const pres = (q.get('presence') || '').toLowerCase();
    if (pres === 'on' || pres === '1' || pres === 'true') out.presence = true;
    if (pres === 'off' || pres === '0' || pres === 'false') out.presence = false;
```

In `saveSettings`'s persisted `out` object, add `presence: s.presence,`.

- [ ] **Step 2: Add capture elements** to `index.html` (after `#profileToast`):

```html
    <!-- Off-screen capture surface for camera presence (hidden; never shown). -->
    <video class="presence-cam" id="presenceVideo" playsinline muted hidden></video>
    <canvas class="presence-cam" id="presenceCanvas" hidden></canvas>
```

And in `css/styles.css` (append) keep them out of layout/view:

```css
.presence-cam{ position:fixed; width:1px; height:1px; opacity:0; pointer-events:none; left:-9999px; }
```

- [ ] **Step 3: Add the `Presence` controller** to `js/presence.js` (append below the pure helpers):

```js
// ---- Camera presence controller (DOM; in-browser motion only) ----
const SAMPLE_W = 64, SAMPLE_H = 48;        // downscaled grayscale grid
const MOTION_THRESHOLD = 6;                // mean abs delta (0..255) that counts as motion
const TICK_MS = 500;                       // ~2 fps
const AWAY_GRACE_MS = 90000;               // no motion this long -> away
const RETRY_MS = [2000, 4000, 8000, 16000, 32000, 60000];

export class Presence {
  constructor(video, canvas, { onPresence } = {}){
    this.video = video;
    this.canvas = canvas;
    this.onPresence = onPresence || (() => {});
    this.ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    this.stream = null;
    this.timer = null;
    this.retry = 0;
    this.prev = null;
    this.state = { present: false, lastMotionMs: 0 };
    this._running = false;
  }

  async start(){
    this._running = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no getUserMedia');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 }, audio: false,
      });
      if (!this._running){ this._stopStream(); return; }   // stopped while awaiting
      this.video.srcObject = this.stream;
      this.canvas.width = SAMPLE_W; this.canvas.height = SAMPLE_H;
      await this.video.play().catch(() => {});
      this.retry = 0;
      this._loop();
    } catch(_){
      this._scheduleRetry();   // permission denied / unavailable -> back off, then give up
    }
  }

  stop(){
    this._running = false;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    this._stopStream();
    this.prev = null;
  }

  _stopStream(){
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch(_){}
    this.stream = null;
    try { if (this.video) this.video.srcObject = null; } catch(_){}
  }

  _scheduleRetry(){
    if (!this._running) return;
    const delay = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    if (this.retry > RETRY_MS.length + 4){ this._running = false; return; }  // give up quietly
    this.timer = setTimeout(() => this.start(), delay);
  }

  _grayFrame(){
    try {
      this.ctx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
      const d = this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const g = new Uint8Array(SAMPLE_W * SAMPLE_H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++){
        g[p] = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0;
      }
      return g;
    } catch(_){ return null; }
  }

  _loop(){
    if (!this._running) return;
    const curr = this._grayFrame();
    const now = Date.now();
    if (curr){
      const score = motionScore(this.prev, curr);
      const motion = this.prev != null && score >= MOTION_THRESHOLD;
      this.prev = curr;
      const next = presenceReducer(this.state, motion, now, AWAY_GRACE_MS);
      const changed = next.present !== this.state.present;
      this.state = next;
      if (changed || motion) { try { this.onPresence(next.present, motion, now); } catch(_){} }
    }
    this.timer = setTimeout(() => this._loop(), TICK_MS);
  }
}
```

- [ ] **Step 4: Wire presence into `js/app.js`**

Import: `import { Presence } from './presence.js';`

Add to the `app` object literal: `presence: null, presentNow: true,` (default `true` so the clock is bright until presence proves otherwise).

Add a setup + dim-composition helper:

```js
// Presence -> brightness. Bright only when present AND not night; away or night -> deep-dim.
function applyPresence(present){
  app.presentNow = present;
  try { checkNightSchedule(); } catch(_){}   // recompute dim with the new presence input
}

function startPresence(){
  try {
    if (app.presence) return;
    app.presence = new Presence($('presenceVideo'), $('presenceCanvas'), {
      onPresence: (present) => applyPresence(present),
    });
    app.presence.start();
  } catch(_){}
}
function stopPresence(){
  try { if (app.presence){ app.presence.stop(); app.presence = null; } app.presentNow = true; applyPresence(true); } catch(_){}
}
```

Compose presence into `checkNightSchedule` — change its dim decision so "away" also dims. Replace the existing `on` computation tail so the final dim is `night OR away`:

```js
  // (existing night-window computation produces `on`)
  const away = (app.settings.presence && !app.presentNow);
  const wantDim = on || away;
  if (wantDim !== app.deepDim) applyDim(wantDim);
```

(Keep the early-returns already at the top of `checkNightSchedule`, including the `app.alertActive` critical-alert override added by the alerts feature.)

Add a **Presence** toggle button. In `index.html`'s settings panel, add a row (next to Sound):

```html
      <div class="row">
        <span class="row-label">Presence</span>
        <button class="ctrl" id="setPresence" type="button" data-nav>Off</button>
      </div>
```

In `syncButtons()` add: `$('setPresence').textContent = app.settings.presence ? 'On' : 'Off';`

In `wireControls()` add:

```js
  $('setPresence').addEventListener('click', () => {
    app.settings.presence = !app.settings.presence;
    if (app.settings.presence) startPresence(); else stopPresence();
    persist(); syncButtons();
  });
```

In `boot()`, after settings load, start presence if enabled:

```js
  try { if (app.settings.presence) startPresence(); } catch(_){}
```

- [ ] **Step 5: Verify**

```bash
node --check js/app.js js/presence.js js/settings.js && echo "syntax OK"
node --test    # presence + all earlier suites green
```
Device check (real iPhone, HTTPS): enable Presence → camera permission + red bar → wave a hand brightens, stillness past ~90s deep-dims, hand re-wakes instantly. Deny permission → silently stays on the schedule. Describe in the report.

- [ ] **Step 6: Commit**

```bash
git add js/presence.js js/settings.js index.html css/styles.css js/app.js
git commit -m "feat: camera motion-presence dimming (opt-in, in-browser, graceful fallback)"
```

---

### Task 4: Sidecar `POST /api/snapshot` + tests

**Files:**
- Modify: `alert-sidecar/alert_sidecar.py`
- Modify: `alert-sidecar/test_alert_sidecar.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /api/snapshot?profile=<room>` — bearer `SNAPSHOT_TOKEN`, `Content-Type: image/jpeg`, body = JPEG. Helpers `snap_name(ms)`, `prune_room(dir)`.

- [ ] **Step 1: Write the failing tests** (append to `test_alert_sidecar.py`)

```python
class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        A.SNAPSHOTS_DIR = self.dir
        A.SNAPSHOT_TOKEN = "snaptok"
        A.TOKEN = "secret"
        A.SNAPSHOT_MAX_PER_ROOM = 3
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), A.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        import shutil; shutil.rmtree(self.dir, ignore_errors=True)

    def _snap(self, body=b"\xff\xd8jpegbytes", ctype="image/jpeg", token="snaptok", profile="Theater"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/snapshot?profile={profile}",
            data=body, method="POST")
        if token is not None: req.add_header("Authorization", f"Bearer {token}")
        if ctype is not None: req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e: return e.code, json.load(e)

    def test_snapshot_token_unset_fails_closed(self):
        A.SNAPSHOT_TOKEN = ""
        code, _ = self._snap()
        self.assertEqual(code, 503)
        A.SNAPSHOT_TOKEN = "snaptok"

    def test_snapshot_bad_bearer(self):
        self.assertEqual(self._snap(token="nope")[0], 401)

    def test_alert_token_does_not_authorize_snapshot(self):
        self.assertEqual(self._snap(token="secret")[0], 401)

    def test_snapshot_rejects_non_jpeg(self):
        self.assertEqual(self._snap(ctype="text/plain")[0], 415)

    def test_snapshot_happy_writes_file(self):
        code, body = self._snap()
        self.assertEqual(code, 200)
        room = os.path.join(self.dir, "Theater")
        files = os.listdir(room)
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".jpg"))

    def test_snapshot_retention_prunes_oldest(self):
        import time as _t
        for i in range(5):
            A.now_ms = (lambda v: (lambda: v))(1000 + i)   # distinct, increasing
            self.assertEqual(self._snap()[0], 200)
            _t.sleep(0.01)
        room = os.path.join(self.dir, "Theater")
        self.assertLessEqual(len(os.listdir(room)), 3)   # MAX_PER_ROOM
        A.now_ms = A.now_ms  # leave as-is
```

- [ ] **Step 2: Run to verify failure**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: FAIL — `AttributeError`/404 on the snapshot path (handler + env not defined).

- [ ] **Step 3: Implement the endpoint** in `alert-sidecar/alert_sidecar.py`

Add near the other env reads:

```python
SNAPSHOT_TOKEN = os.environ.get("SNAPSHOT_TOKEN", "").strip()
SNAPSHOTS_DIR = os.environ.get("SNAPSHOTS_DIR", "/data/snapshots")
SNAPSHOT_MAX_BYTES = int(os.environ.get("SNAPSHOT_MAX_BYTES", str(1024 * 1024)))
SNAPSHOT_RETENTION_DAYS = int(os.environ.get("SNAPSHOT_RETENTION_DAYS", "30"))
SNAPSHOT_MAX_PER_ROOM = int(os.environ.get("SNAPSHOT_MAX_PER_ROOM", "1000"))
PROFILE_RE = re.compile(r"^[A-Za-z0-9 _.\-]{1,64}$")
```

Add helpers (module level):

```python
def snap_name(ms):
    t = time.gmtime(ms / 1000)
    return time.strftime("%Y%m%d-%H%M%S", t) + "-%03d.jpg" % (ms % 1000)


def prune_room(room_dir):
    try:
        entries = []
        cutoff = time.time() - SNAPSHOT_RETENTION_DAYS * 86400
        for e in os.scandir(room_dir):
            if not e.is_file():
                continue
            st = e.stat()
            entries.append((st.st_mtime, e.path))
        # age-based
        for mt, path in entries:
            if mt < cutoff:
                try: os.unlink(path)
                except OSError: pass
        # count-based (newest kept)
        remaining = [p for mt, p in sorted(entries) if os.path.exists(p)]
        excess = len(remaining) - SNAPSHOT_MAX_PER_ROOM
        for path in remaining[:max(0, excess)]:
            try: os.unlink(path)
            except OSError: pass
    except OSError:
        pass
```

Add a snapshot guard + handler method on `Handler`:

```python
    def _guard_snapshot(self):
        if not SNAPSHOT_TOKEN:
            self._json(503, {"error": "SNAPSHOT_TOKEN not set"})
            return False
        if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {SNAPSHOT_TOKEN}"):
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def _handle_snapshot(self):
        if not self._guard_snapshot():
            return
        if (self.headers.get("Content-Type", "").split(";")[0].strip() != "image/jpeg"):
            return self._json(415, {"error": "Content-Type must be image/jpeg"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0:
            return self._json(400, {"error": "empty body"})
        if n > SNAPSHOT_MAX_BYTES:
            return self._json(413, {"error": "snapshot too large"})
        profile = (parse_qs(urlparse(self.path).query).get("profile") or ["unknown"])[0]
        if not PROFILE_RE.match(profile):
            return self._json(400, {"error": "bad profile"})
        body = self.rfile.read(n)
        room_dir = os.path.join(SNAPSHOTS_DIR, profile)
        try:
            os.makedirs(room_dir, exist_ok=True)
            name = snap_name(now_ms())
            fd, tmp = tempfile.mkstemp(dir=room_dir, prefix=".snap.", suffix=".tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, os.path.join(room_dir, name))
            prune_room(room_dir)
            return self._json(200, {"ok": True, "stored": os.path.join(profile, name)})
        except OSError as e:
            return self._json(500, {"error": "store failed: %s" % e})
```

Route it FIRST in `do_POST` (before the alert-token guard), so it uses the snapshot token:

```python
    def do_POST(self):
        if urlparse(self.path).path == "/api/snapshot":
            return self._handle_snapshot()
        if not self._guard():
            return
        # ... existing /api/alert + /api/alert/clear ...
```

- [ ] **Step 4: Run to verify pass**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: PASS — snapshot tests + the earlier alert tests, output pristine.

- [ ] **Step 5: Commit**

```bash
git add alert-sidecar/alert_sidecar.py alert-sidecar/test_alert_sidecar.py
git commit -m "feat: sidecar POST /api/snapshot (scoped token, jpeg validation, atomic write, retention)"
```

---

### Task 5: Kiosk snapshot capture + upload

**Files:**
- Modify: `js/presence.js` (capture + upload on arrival)
- Modify: `js/settings.js` (`saveSnapshots` setting + URL param + persist)
- Modify: `js/app.js` (read `snapshotToken` from `snapshot.json`; pass capture config to `Presence`; toggle)
- Modify: `index.html` (Save-snapshots toggle)

**Interfaces:**
- Consumes: `shouldSnapshot` (Task 2), `POST /api/snapshot` (Task 4), `app.snapshotToken`.
- Produces: arrival snapshots uploaded when `saveSnapshots` is on.

- [ ] **Step 1: Add `saveSnapshots` setting** in `js/settings.js`

`DEFAULTS`: `saveSnapshots: false,   // upload one JPEG per arrival to the server/NAS (needs presence on)`.
`readURL`: accept `?snapshots=on|off` → `out.saveSnapshots`.
`saveSettings` out: `saveSnapshots: s.saveSnapshots,`.

- [ ] **Step 2: Add capture/upload to the `Presence` controller** (`js/presence.js`)

Add constructor options `{ onPresence, snapshot }` where `snapshot` is
`{ enabled:()=>bool, token:()=>string, profile:()=>string, cooldownMs }`. Store
`this.snapshot = snapshot || null; this._lastSnapMs = -Infinity;` and a full-res
capture canvas. In the `_loop`, when a transition to present happens
(`changed && next.present`), call `this._maybeSnapshot(now)`:

```js
  async _maybeSnapshot(now){
    try {
      const s = this.snapshot;
      if (!s || !s.enabled()) return;
      if (!shouldSnapshot(this._lastSnapMs, now, s.cooldownMs)) return;
      this._lastSnapMs = now;
      const cap = document.createElement('canvas');
      cap.width = 480; cap.height = 360;
      cap.getContext('2d').drawImage(this.video, 0, 0, 480, 360);
      const blob = await new Promise(res => cap.toBlob(res, 'image/jpeg', 0.7));
      if (!blob) return;
      const tok = s.token(); if (!tok) return;
      await fetch('api/snapshot?profile=' + encodeURIComponent(s.profile() || 'unknown'), {
        method:'POST', headers:{ 'Authorization':'Bearer ' + tok, 'Content-Type':'image/jpeg' }, body: blob,
      }).catch(() => {});   // upload failure never affects presence/clock
    } catch(_){}
  }
```

Call site inside `_loop` (replace the `if (changed || motion)` block):

```js
      if (changed && next.present) this._maybeSnapshot(now);
      if (changed || motion) { try { this.onPresence(next.present, motion, now); } catch(_){} }
```

- [ ] **Step 3: Deliver the token + wire the toggle** (`js/app.js`)

In `loadServerConfig()` (which already fetches `config.json`), also fetch the token
file. Add after the existing config fetch (own try/catch):

```js
  try {
    const r = await fetch('snapshot.json?ts=' + Date.now(), { cache:'no-store' });
    if (r.ok){ const j = await r.json(); app.snapshotToken = (j && j.token) || ''; }
  } catch(_){ /* absent -> snapshots disabled */ }
```

Add `snapshotToken: ''` to the `app` literal. Pass the snapshot config when constructing `Presence` in `startPresence()`:

```js
    app.presence = new Presence($('presenceVideo'), $('presenceCanvas'), {
      onPresence: (present) => applyPresence(present),
      snapshot: {
        enabled: () => !!(app.settings.saveSnapshots && app.snapshotToken),
        token: () => app.snapshotToken,
        profile: () => app.settings.profile || 'unknown',
        cooldownMs: 300000,
      },
    });
```

Add the **Save snapshots** toggle row in `index.html` (under Presence), `syncButtons()` line, and `wireControls()` handler:

```html
      <div class="row">
        <span class="row-label">Save snapshots</span>
        <button class="ctrl" id="setSnapshots" type="button" data-nav>Off</button>
      </div>
```
```js
  $('setSnapshots').textContent = app.settings.saveSnapshots ? 'On' : 'Off';
```
```js
  $('setSnapshots').addEventListener('click', () => {
    app.settings.saveSnapshots = !app.settings.saveSnapshots;
    persist(); syncButtons();
  });
```

- [ ] **Step 4: Verify**

```bash
node --check js/app.js js/presence.js js/settings.js && echo "syntax OK"
node --test   # all green
```
(End-to-end upload is verified with the stack in Task 6 / on-device. Confirm here that `enabled()` is false when `saveSnapshots` off or no token, so nothing uploads.)

- [ ] **Step 5: Commit**

```bash
git add js/presence.js js/settings.js js/app.js index.html
git commit -m "feat: capture + upload one arrival snapshot per cooldown (opt-in, scoped token)"
```

---

### Task 6: Deployment wiring — nginx, compose/NAS, token file, SW

**Files:**
- Modify: `nginx.conf`
- Create: `docker-entrypoint.d/25-snapshot-config.sh`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `sw.js`

- [ ] **Step 1: Dedicated nginx location for `/api/snapshot`** (own larger body cap; keep `/api/` at 16k). Add before the `location /api/ { … }` block in `nginx.conf`:

```nginx
  location = /api/snapshot {
    resolver 127.0.0.11 ipv6=off valid=30s;
    set $alert_up "alert-sidecar:8090";
    client_max_body_size 2m;
    proxy_pass http://$alert_up$request_uri;
  }
  # Snapshot upload token for the kiosk (low-privilege, upload-only). Never cache.
  location = /snapshot.json {
    default_type application/json;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    expires off;
  }
```

- [ ] **Step 2: Entrypoint that writes `snapshot.json`** — `docker-entrypoint.d/25-snapshot-config.sh`:

```sh
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
```

In `Dockerfile`, copy + chmod it alongside the other entrypoints, and pre-create the file so it always exists:

```dockerfile
COPY docker-entrypoint.d/25-snapshot-config.sh /docker-entrypoint.d/25-snapshot-config.sh
RUN chmod +x /docker-entrypoint.d/25-snapshot-config.sh && printf '{}\n' > /usr/share/nginx/html/snapshot.json
```

- [ ] **Step 3: Compose — token env + NAS volume** in `docker-compose.yml`

Add to **both** the `clock` and `alert-sidecar` service `environment:` blocks:

```yaml
      SNAPSHOT_TOKEN: "${SNAPSHOT_TOKEN:-}"
```

Add to the `alert-sidecar` service: `SNAPSHOTS_DIR: "/data/snapshots"` (env) and mount the NAS volume into it:

```yaml
    volumes:
      - alertdata:/data
      - snapshots:/data/snapshots
```

Add the NFS volume to the top-level `volumes:` (edit the placeholders for your TrueNAS):

```yaml
  snapshots:
    driver: local
    driver_opts:
      type: nfs
      o: "addr=TRUENAS_IP,nfsvers=4,rw,soft"
      device: ":/mnt/POOL/DATASET/clock-snapshots"
```

- [ ] **Step 4: Service worker** — in `sw.js`, add `'./js/presence.js'` to `SHELL_FILES` and bump both cache constants `v17` → `v18`.

- [ ] **Step 5: Full-stack verify** (uses a local bind dir in place of NFS so it runs without a NAS)

```bash
cd /Users/assistant/dev/active/clock-pwa
mkdir -p /tmp/snaptest
# temporary compose override so we don't need the real NAS for this test:
cat > docker-compose.override.yml <<'YML'
services:
  alert-sidecar:
    volumes:
      - /tmp/snaptest:/data/snapshots
volumes:
  snapshots:
    driver_opts:
      type: none
      o: bind
      device: /tmp/snaptest
YML
SNAPSHOT_TOKEN=snaptok ALERT_API_TOKEN=testtok docker compose up -d --build
sleep 5
# kiosk reads the token:
curl -s localhost:8080/snapshot.json                       # {"token":"snaptok"}
# upload a fake jpeg with the snapshot token:
printf '\xff\xd8jpeg' | curl -s -XPOST "localhost:8080/api/snapshot?profile=Theater" \
  -H "Authorization: Bearer snaptok" -H "Content-Type: image/jpeg" --data-binary @-   # {"ok":true,...}
# alert token must NOT authorize snapshot:
printf '\xff\xd8' | curl -s -o /dev/null -w "%{http_code}\n" -XPOST "localhost:8080/api/snapshot?profile=Theater" \
  -H "Authorization: Bearer testtok" -H "Content-Type: image/jpeg" --data-binary @-   # 401
ls -R /tmp/snaptest                                        # Theater/<ts>.jpg
docker compose down; rm -f docker-compose.override.yml; rm -rf /tmp/snaptest
```
Expected: `snapshot.json` serves the token, snapshot upload writes `Theater/<ts>.jpg`, the alert token is rejected (401). (If Docker is unavailable, rely on Task 4's unit tests + `docker compose config`.)

- [ ] **Step 6: Commit**

```bash
git add nginx.conf docker-entrypoint.d/25-snapshot-config.sh Dockerfile docker-compose.yml sw.js
git commit -m "feat: snapshot deploy wiring — nginx /api/snapshot, snapshot.json token, NFS volume, SW v18"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document presence + snapshots + TrueNAS** in `README.md`

Extend the room-awareness section with:
- **Presence dimming:** enable **Settings → Presence** (needs HTTPS + camera permission; shows the iOS red camera bar). In-browser **motion** detection brightens when someone's near, deep-dims after ~90s of stillness. Note it can't truly power the screen off under Guided Access (away = near-black). Privacy: frames analyzed on-device, never uploaded.
- **Arrival snapshots:** enable **Settings → Save snapshots** (independent of Presence dimming's privacy — this DOES upload). One JPEG per arrival, 5-min cooldown. Set `SNAPSHOT_TOKEN` (a strong secret, separate from `ADMIN_PASS`/`ALERT_API_TOKEN`) in `docker-compose.yml`. Images go to your NAS folder, one subfolder per room.
- **TrueNAS setup:** create a dataset (e.g. `clock-snapshots`), add an **NFS share** scoped to the Docker host IP, and fill the `snapshots` volume `driver_opts` (`addr=`, `device=:/mnt/<pool>/<dataset>/clock-snapshots`). SMB/CIFS or a host bind-mount are alternatives. If the NAS is down, uploads fail quietly and nothing else breaks.
- **Privacy warning:** snapshots capture whoever approaches (household, guests). Off by default; you own the trade.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: presence dimming, arrival snapshots, TrueNAS NFS setup + privacy notes"
```

---

## Self-Review

**Spec coverage:**
- A (kiosk Safari/Guided Access/HTTPS docs) → Task 1 Step 5 + Task 7. ✓
- B (NFC URL tag + Shortcut + `?profile=` persist + toast) → Task 1. ✓
- C (camera motion presence, in-browser, dim composition, opt-in, graceful) → Tasks 2 + 3. ✓
- D (arrival snapshot capture + scoped-token upload + sidecar store + retention + NAS) → Tasks 4 + 5 + 6. ✓
- Token isolation (`SNAPSHOT_TOKEN` ≠ `ALERT_API_TOKEN`) → Task 4 tests (`test_alert_token_does_not_authorize_snapshot`) + Task 6 stack check. ✓
- Dedicated nginx `/api/snapshot` (keep alert 16k cap) → Task 6 Step 1. ✓
- SW v18 + `presence.js` → Task 6 Step 4. ✓
- README incl. privacy + TrueNAS → Task 7. ✓

**Placeholder scan:** No TBD/TODO. `TRUENAS_IP`/`POOL`/`DATASET`/`<clock-host>`/`<room>` are user config placeholders, called out as such. Docker-gated steps name a non-Docker fallback. ✓

**Type consistency:** `motionScore`/`presenceReducer`/`shouldSnapshot` defined in Task 2, consumed in Tasks 3/5. `Presence` constructor `(video, canvas, {onPresence, snapshot})` consistent between Task 3 (defines) and Task 5 (adds `snapshot`). `app.presentNow`/`app.presence`/`app.snapshotToken` defined in the Task 3/5 app-literal edits and used in `applyPresence`/`checkNightSchedule`/`startPresence`. Sidecar `snap_name`/`prune_room`/`_handle_snapshot` + env names consistent between Task 4 code and tests. `snapshot.json` shape `{token}` consistent between Task 6 entrypoint and Task 5 reader. ✓
