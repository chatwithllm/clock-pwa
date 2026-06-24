# Rich-media Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an announcement optionally carry an uploaded image/GIF (shown in the card + a toast thumbnail) and a synthesized preset chime.

**Architecture:** Two optional fields on the announcement object — `image` (a `/uploads/…` path uploaded via a new auth-protected nginx WebDAV endpoint, or an external URL) and `sound` (a preset name synthesized in-browser via Web Audio; no audio files). Audio needs a one-time Settings "Enable sound" gesture to satisfy autoplay policy. Both fields are optional and fully back-compatible with the existing queue.

**Tech Stack:** Static vanilla-JS PWA (ES modules), nginx (alpine) WebDAV PUT/DELETE, Docker, Web Audio API. No build step, no test framework — verification is manual `curl` + Playwright (same as prior features).

## Global Constraints

- No build step, plain JS/HTML/CSS, no dependencies, no bundler.
- Announcement object gains two OPTIONAL fields: `image` (string: `/uploads/<name>` or `http(s)://…`) and `sound` (`"none"|"ding"|"alert"|"chime"`). Absent/empty → today's text-only behavior. The `announce.json` array format is otherwise unchanged.
- Uploads live in `/data/uploads`, served at `/uploads/` (open GET; PUT/DELETE require admin basic-auth via `include /etc/nginx/admin_auth.conf`). Max upload **8 MB** (nginx `client_max_body_size 8m` on that location only; `announce.json` stays 64k).
- Upload name: `<ts>-<rand>.<ext>`, `<ext>` from the file (lowercased, alphanumerics only). Admin builds the name, PUTs bytes, writes `/uploads/<name>` into `image`.
- Chimes are SYNTHESIZED via Web Audio (oscillator) — no audio assets shipped or uploaded. `ding`=one ~880 Hz tone; `alert`=two ~660 Hz beeps; `chime`=ascending triad 523/659/784 Hz.
- Audio plays only when `app.settings.soundEnabled` is true AND after the unlock gesture; every Web Audio call wrapped in try/catch (locked context = silent, never throws). A chime fires ONCE per announcement id when it first becomes the rendered center (tracked in `app._soundedIds`, pruned to the queue).
- Image URLs interpolated into HTML attributes MUST be HTML-escaped (`escHtml`), with an `onerror` that hides a broken image. Center text/icon/sub still use `textContent`/`escHtml` as today.
- SW: `/uploads/*` is cache-first (immutable names); cache version bumped `v13`→`v14`. nginx `/announce.json` and `/profiles.json` routes are otherwise unchanged.

---

### Task 1: Upload endpoint (nginx + Docker)

A new auth-protected `/uploads/` WebDAV location and the writable dir. Backend plumbing, verified entirely by curl.

**Files:**
- Modify: `nginx.conf` (add a `location /uploads/` after the `location = /profiles.json` block)
- Modify: `Dockerfile` (the `mkdir -p /data/tmp …` line)

**Interfaces:**
- Produces: HTTP `/uploads/<name>` — open GET, auth PUT/DELETE, 8 MB cap. Consumed by the admin uploader (Task 3) and the device/SW (Task 2).

- [ ] **Step 1: Add the nginx uploads location**

In `nginx.conf`, immediately after the closing `}` of the `location = /profiles.json` block, add:

```nginx
  # Uploaded announcement media (images / GIFs). Open GET for devices; PUT and
  # DELETE require admin basic-auth. Files live in the writable /data/uploads dir.
  location /uploads/ {
    root /data;
    default_type application/octet-stream;
    add_header Cache-Control "public, max-age=31536000, immutable";
    dav_methods PUT DELETE;
    create_full_put_path on;
    client_body_temp_path /data/tmp;
    client_max_body_size 8m;
    limit_except GET { include /etc/nginx/admin_auth.conf; }
  }
```

- [ ] **Step 2: Create the uploads dir in the image**

In `Dockerfile`, change the line:

```dockerfile
RUN mkdir -p /data/tmp && chown -R nginx:nginx /data && chmod -R u+rwX /data
```

to:

```dockerfile
RUN mkdir -p /data/tmp /data/uploads && chown -R nginx:nginx /data && chmod -R u+rwX /data
```

- [ ] **Step 3: Rebuild and restart**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 4: Verify the endpoint (this is the test)**

Run:
```bash
B=http://localhost:8080
echo "PUT no-auth:  $(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary 'x' $B/uploads/t.png)"          # 401
echo "PUT auth:     $(curl -s -o /dev/null -w '%{http_code}' -u admin:change-me -X PUT --data-binary 'hello' $B/uploads/t.png)"  # 201 or 204
echo "GET open:     $(curl -s -o /dev/null -w '%{http_code}' $B/uploads/t.png)"                                    # 200
echo "GET body:     $(curl -s $B/uploads/t.png)"                                                                    # hello
echo "DELETE auth:  $(curl -s -o /dev/null -w '%{http_code}' -u admin:change-me -X DELETE $B/uploads/t.png)"        # 204
echo "GET gone:     $(curl -s -o /dev/null -w '%{http_code}' $B/uploads/t.png)"                                    # 404
# 8 MB limit: a 9 MB body should be rejected 413
head -c 9000000 /dev/zero > /tmp/big.bin
echo "PUT 9MB:      $(curl -s -o /dev/null -w '%{http_code}' -u admin:change-me -X PUT --data-binary @/tmp/big.bin $B/uploads/big.bin)"  # 413
curl -s -u admin:change-me -X DELETE $B/uploads/big.bin >/dev/null 2>&1; rm -f /tmp/big.bin
```
Expected: 401; 201/204; 200; `hello`; 204; 404; 413.

- [ ] **Step 5: Commit**

```bash
git add nginx.conf Dockerfile
git commit -m "feat: /uploads WebDAV endpoint for announcement media (auth PUT/DELETE, 8MB)"
```

---

### Task 2: Device image rendering + SW caching

Render `image` in the center card and as a toast thumbnail; cache `/uploads/*` in the SW.

**Files:**
- Modify: `index.html` (add `#announceImage` inside `.announce-body`)
- Modify: `css/styles.css` (image + thumb rules, after the `.toast-more` block from the stacked-announcements feature)
- Modify: `js/app.js` (`renderAnnounce` center image + toast thumb)
- Modify: `sw.js` (cache version `v13`→`v14`; `/uploads/` cache-first rule)

**Interfaces:**
- Consumes: `/uploads/<name>` GET (Task 1); the announcement `image` field.
- Produces: visible image rendering. No new functions other tasks depend on.

- [ ] **Step 1: Add the image element to the center markup**

In `index.html`, inside `.announce-body` (currently holds `#announceText` and `#announceSub`), add a third child after `#announceSub`:

```html
        <img class="announce-img" id="announceImage" alt="" hidden onerror="this.hidden=true">
```

So the body becomes text, sub, then the image.

- [ ] **Step 2: Add image + thumbnail CSS**

In `css/styles.css`, directly after the `.toast-more{…}` rule (from the stacked-announcements feature), add:

```css
/* Announcement image (center card) + toast thumbnail */
.announce-img{display:block;margin-top:12px;max-width:100%;max-height:38vh;
  object-fit:contain;border-radius:10px}
.announce-img[hidden]{display:none}
.toast-thumb{width:40px;height:40px;flex:0 0 auto;object-fit:cover;border-radius:8px}
```

- [ ] **Step 3: Render the center image in `renderAnnounce`**

In `js/app.js`, in `renderAnnounce`, after the line that sets the center sub
(`$('announceSub').textContent = sub ? ('— ' + sub) : '';`) and before
`el.dataset.id = c.id;`, add:

```javascript
    const img = $('announceImage');
    if (img){
      if (c.image){ img.hidden = false; img.src = c.image; }
      else { img.hidden = true; img.removeAttribute('src'); }
    }
```

- [ ] **Step 4: Add the toast thumbnail**

In `js/app.js`, in `renderAnnounce`, replace the toast-building loop body. Find:

```javascript
      for (const a of view.stack){
        const s = announceSub(a);
        html += '<div class="toast"><span class="toast-icon">' + escHtml(a.icon || '📢') + '</span>'
              + '<span class="toast-text">' + escHtml(a.text)
              + (s ? ('<span class="toast-sub">— ' + escHtml(s) + '</span>') : '')
              + '</span></div>';
      }
```

with:

```javascript
      for (const a of view.stack){
        const s = announceSub(a);
        const lead = a.image
          ? '<img class="toast-thumb" src="' + escHtml(a.image) + '" alt="" onerror="this.style.display=\'none\'">'
          : '<span class="toast-icon">' + escHtml(a.icon || '📢') + '</span>';
        html += '<div class="toast">' + lead
              + '<span class="toast-text">' + escHtml(a.text)
              + (s ? ('<span class="toast-sub">— ' + escHtml(s) + '</span>') : '')
              + '</span></div>';
      }
```

- [ ] **Step 5: Bump SW cache version and add the uploads rule**

In `sw.js`, change lines 4-5:

```javascript
const SHELL = 'clockpwa-shell-v13';
const RUNTIME = 'clockpwa-runtime-v13';
```

to:

```javascript
const SHELL = 'clockpwa-shell-v14';
const RUNTIME = 'clockpwa-runtime-v14';
```

Then, inside the `fetch` handler, directly BEFORE the "App shell: cache-first" block (the `e.respondWith(caches.match(req)…` near the end), add:

```javascript
  // Uploaded media: immutable filenames — cache-first, populate runtime cache.
  if (url.pathname.startsWith('/uploads/')){
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(()=>{});
        return res;
      }))
    );
    return;
  }
```

- [ ] **Step 6: Rebuild, restart, verify served code**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done
B=http://localhost:8080
echo "img node:   $(curl -s $B/index.html | grep -c 'id=\"announceImage\"')"        # 1
echo "img css:    $(curl -s $B/css/styles.css | grep -c 'announce-img')"             # >=1
echo "thumb css:  $(curl -s $B/css/styles.css | grep -c 'toast-thumb')"              # >=1
echo "sw v14:     $(curl -s $B/sw.js | grep -c 'clockpwa-shell-v14')"                # 1
echo "sw uploads: $(curl -s $B/sw.js | grep -c \"startsWith('/uploads/')\")"          # 1
echo "render img: $(curl -s $B/js/app.js | grep -c 'announceImage')"                 # >=1 (render)
```
Expected: 1, ≥1, ≥1, 1, 1, ≥1. (Visual render verified by the controller in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add index.html css/styles.css js/app.js sw.js
git commit -m "feat: render announcement image in card + toast thumbnail (SW v14 caches /uploads)"
```

---

### Task 3: Admin image upload UI

Add a file picker + URL field + preview to the admin page; upload bytes then attach the path to the sent announcement.

**Files:**
- Modify: `admin.html` (markup in the form + the `send` handler script)

**Interfaces:**
- Consumes: `/uploads/` PUT (Task 1); the device `image` field (Task 2).
- Produces: nothing other tasks depend on (UI task).

- [ ] **Step 1: Add the image markup to the form**

In `admin.html`, inside the main `.card`, after the `.row` containing the
`target`/`dur`/`icon` fields (just before the `.actions` div with the Send
button), add:

```html
      <label for="imgFile">Image / GIF (optional)</label>
      <div class="row">
        <div style="flex:2"><input id="imgFile" type="file" accept="image/*"></div>
        <div style="flex:2"><input id="imgUrl" type="text" placeholder="…or paste an image URL"></div>
      </div>
      <img id="imgPreview" alt="" hidden style="max-height:120px;margin-top:8px;border-radius:8px">
```

- [ ] **Step 2: Wire the preview**

In `admin.html`, in the `<script>` (after the `setStatus` function), add:

```javascript
    $('imgFile').addEventListener('change', function(){
      var f = this.files && this.files[0];
      var p = $('imgPreview');
      if (f){ p.src = URL.createObjectURL(f); p.hidden = false; $('imgUrl').value = ''; }
      else { p.hidden = true; p.removeAttribute('src'); }
    });
    $('imgUrl').addEventListener('input', function(){
      var u = this.value.trim(), p = $('imgPreview');
      if (u && !($('imgFile').files && $('imgFile').files[0])){ p.src = u; p.hidden = false; }
    });
```

- [ ] **Step 3: Add the upload helper**

In `admin.html` `<script>`, after the `putQueue` function, add:

```javascript
    // Upload the chosen image (if any) and resolve to its path, else the URL, else ''.
    function resolveImage(){
      var f = $('imgFile').files && $('imgFile').files[0];
      if (f){
        if (f.size > 8 * 1024 * 1024) return Promise.reject(new Error('image too large (max 8 MB)'));
        var ext = (f.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'img';
        var name = String(Date.now()) + '-' + Math.floor(Math.random() * 100000) + '.' + ext;
        return fetch('uploads/' + name, {
          method: 'PUT', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f
        }).then(function(r){
          if (!r.ok) throw new Error(r.status === 413 ? 'image too large (max 8 MB)' : 'upload HTTP ' + r.status);
          return '/uploads/' + name;
        });
      }
      return Promise.resolve($('imgUrl').value.trim());
    }
```

- [ ] **Step 4: Use it in the send handler**

In `admin.html`, replace the body of the `$('send')` click handler. Find:

```javascript
      setStatus('Sending…');
      getQueue().then(function(q){
        return putQueue(trimQueue(q.concat([obj])));
      }).then(function(r){
        if (r.ok) setStatus('Sent to ' + obj.target + ' — displays will show it within ~15s.', true);
        else setStatus('Failed (HTTP ' + r.status + '). Is WebDAV PUT allowed?', false);
      }).catch(function(e){ setStatus('Failed: ' + e, false); });
```

with:

```javascript
      setStatus('Sending…');
      resolveImage().then(function(image){
        if (image) obj.image = image;
        return getQueue();
      }).then(function(q){
        return putQueue(trimQueue(q.concat([obj])));
      }).then(function(r){
        if (r.ok){
          setStatus('Sent to ' + obj.target + ' — displays will show it within ~15s.', true);
          $('imgFile').value = ''; $('imgUrl').value = ''; $('imgPreview').hidden = true;
        } else {
          setStatus('Failed (HTTP ' + r.status + '). Is WebDAV PUT allowed?', false);
        }
      }).catch(function(e){ setStatus('Failed: ' + (e && e.message ? e.message : e), false); });
```

- [ ] **Step 5: Rebuild and verify markup served**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done
A=$(curl -s -u admin:change-me http://localhost:8080/admin.html)
for id in imgFile imgUrl imgPreview; do echo "$id: $(printf '%s' "$A" | grep -c "id=\"$id\"")"; done   # each 1
echo "resolveImage: $(printf '%s' "$A" | grep -c 'function resolveImage')"   # 1
```
Expected: each 1. (Full upload→render flow verified by the controller in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add admin.html
git commit -m "feat: admin uploads an announcement image/GIF (file or URL) with preview"
```

---

### Task 4: Synthesized chimes + audio unlock

Device-side Web Audio chime synth + the once-per-id trigger, a Settings "Sound" toggle (the unlock gesture), `soundEnabled` in the settings schema, and the admin sound dropdown + Test button.

**Files:**
- Modify: `js/settings.js` (`DEFAULTS` + `saveSettings`)
- Modify: `index.html` (Settings "Sound" row)
- Modify: `js/app.js` (synth + trigger + state + toggle wiring + `syncButtons` + `_soundedIds` init + prune)
- Modify: `admin.html` (sound dropdown + Test button + `obj.sound`)

**Interfaces:**
- Consumes: the announcement `sound` field; `app.settings.soundEnabled`.
- Produces: `playChime(name)`, `ensureAudio()`; `app._soundedIds` (Set), `app._audioCtx`.

- [ ] **Step 1: Add `soundEnabled` to the settings schema**

In `js/settings.js`, in `DEFAULTS`, add after the `secondTz: 'off',` line:

```javascript
  soundEnabled: false,  // notification chimes (requires a one-time enable gesture per device)
```

In `saveSettings`, add `soundEnabled` to the persisted `out` object — change the line:

```javascript
    locationMode: s.locationMode, timeSource: s.timeSource, profile: s.profile, secondTz: s.secondTz,
```

to:

```javascript
    locationMode: s.locationMode, timeSource: s.timeSource, profile: s.profile, secondTz: s.secondTz,
    soundEnabled: s.soundEnabled,
```

- [ ] **Step 2: Add the Settings "Sound" row**

In `index.html`, directly after the Night-dim row (the block containing
`<span class="row-label">Night dim</span>` and `id="setNight"`), add an
identical-structure row:

```html
        <span class="row-label">Sound</span>
        <button class="ctrl" id="setSound" type="button" data-nav>Off</button>
```

Wrap it in the SAME element type that wraps the Night-dim row (match the
sibling row's container exactly — e.g. if Night dim is inside a
`<div class="set-row">…</div>`, use the same).

- [ ] **Step 3: Add audio state fields**

In `js/app.js`, in the `app` object literal, add next to the other
`_announce*` fields (e.g. after `_announceModal: false,`):

```javascript
  _audioCtx: null,
  _soundedIds: null,
```

- [ ] **Step 4: Add the chime synth**

In `js/app.js`, immediately before `function announceSub(a){` (around line 505), add:

```javascript
// ---- Notification chimes (synthesized; no audio files) ----
function ensureAudio(){
  try {
    if (!app._audioCtx){
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      app._audioCtx = new C();
    }
    if (app._audioCtx.state === 'suspended') app._audioCtx.resume();
    return app._audioCtx;
  } catch(_) { return null; }
}
function chimeTone(ctx, freq, startOffset, dur){
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  o.connect(g); g.connect(ctx.destination);
  const t0 = ctx.currentTime + startOffset;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function playChime(name){
  if (!name || name === 'none') return;
  if (!(app.settings && app.settings.soundEnabled)) return;
  const ctx = ensureAudio(); if (!ctx) return;
  try {
    if (name === 'ding'){ chimeTone(ctx, 880, 0, 0.15); }
    else if (name === 'alert'){ chimeTone(ctx, 660, 0, 0.12); chimeTone(ctx, 660, 0.2, 0.12); }
    else if (name === 'chime'){ chimeTone(ctx, 523, 0, 0.12); chimeTone(ctx, 659, 0.12, 0.12); chimeTone(ctx, 784, 0.24, 0.14); }
  } catch(_){}
}
```

- [ ] **Step 5: Fire the chime once per id in `renderAnnounce`**

In `js/app.js`, in `renderAnnounce`, right after `el.hidden = false;` (the
line that reveals the center), add:

```javascript
    if (c.sound && app._soundedIds && !app._soundedIds.has(c.id)){
      app._soundedIds.add(c.id);
      playChime(c.sound);
    }
```

- [ ] **Step 6: Prune `_soundedIds` alongside the dismissed-set**

In `js/app.js`, in `pruneDismissed`, after the existing loop that prunes
`app._announceDismissed`, add a parallel prune (inside the same `try`):

```javascript
    if (app._soundedIds){
      for (const id of Array.from(app._soundedIds)){
        if (!ids.has(id)) app._soundedIds.delete(id);
      }
    }
```

(`ids` is the queue-id Set already built at the top of `pruneDismissed`.)

- [ ] **Step 7: Initialize `_soundedIds` in the announce init block**

In `js/app.js`, in the announcements init block where `app._announceQueue = [];`
is set, add directly after it:

```javascript
  app._soundedIds = new Set();
```

- [ ] **Step 8: Reflect the toggle in `syncButtons` and wire the click**

In `js/app.js`, in `syncButtons`, after the `$('setNight').textContent = …` line, add:

```javascript
  $('setSound').textContent = (app.settings && app.settings.soundEnabled) ? 'On' : 'Off';
```

In the wiring section, after the `$('setNight').addEventListener(…)` line, add:

```javascript
  $('setSound').addEventListener('click', () => {
    app.settings.soundEnabled = !app.settings.soundEnabled;
    if (app.settings.soundEnabled){ ensureAudio(); playChime('ding'); }
    persist(); syncButtons();
  });
```

- [ ] **Step 9: Add the admin sound dropdown + Test**

In `admin.html`, after the image markup added in Task 3 (the `#imgPreview`
line) and before the `.actions` div, add:

```html
      <label for="sound">Sound</label>
      <div class="row">
        <div style="flex:2">
          <select id="sound">
            <option value="none">None</option>
            <option value="ding">Ding</option>
            <option value="alert">Alert</option>
            <option value="chime">Chime</option>
          </select>
        </div>
        <div style="flex:0"><button class="ghost" id="soundTest" type="button">Test</button></div>
      </div>
```

In the `obj` built by the `send` handler, add the `sound` field — change:

```javascript
        duration: dur, target: $('target').value || 'all'
```

to:

```javascript
        duration: dur, target: $('target').value || 'all', sound: ($('sound').value || 'none')
```

And add a Test-button handler in the `<script>` (after the send handler),
with its own small preview synth (the admin page is not a module and cannot
import the app's synth):

```javascript
    $('soundTest').addEventListener('click', function(){
      var name = $('sound').value;
      if (name === 'none') return;
      try {
        var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        if (!window.__adAc) window.__adAc = new C();
        var ctx = window.__adAc; if (ctx.state === 'suspended') ctx.resume();
        var tone = function(freq, off, dur){
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
          var t0 = ctx.currentTime + off;
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          o.start(t0); o.stop(t0 + dur + 0.02);
        };
        if (name === 'ding'){ tone(880, 0, 0.15); }
        else if (name === 'alert'){ tone(660, 0, 0.12); tone(660, 0.2, 0.12); }
        else if (name === 'chime'){ tone(523, 0, 0.12); tone(659, 0.12, 0.12); tone(784, 0.24, 0.14); }
      } catch(_){}
    });
```

- [ ] **Step 10: Rebuild and verify served code**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done
B=http://localhost:8080
echo "default soundEnabled:false: $(curl -s $B/js/settings.js | grep -c 'soundEnabled: false')"   # 1
echo "save soundEnabled:          $(curl -s $B/js/settings.js | grep -c 'soundEnabled: s.soundEnabled')"  # 1
echo "setSound row:               $(curl -s $B/index.html | grep -c 'id=\"setSound\"')"            # 1
echo "playChime:                  $(curl -s $B/js/app.js | grep -c 'function playChime')"          # 1
echo "soundedIds init:            $(curl -s $B/js/app.js | grep -c '_soundedIds = new Set')"       # 1
echo "admin sound select:         $(curl -s -u admin:change-me $B/admin.html | grep -c 'id=\"sound\"')"   # 1
echo "admin soundTest:            $(curl -s -u admin:change-me $B/admin.html | grep -c 'id=\"soundTest\"')" # 1
```
Expected: all 1. (Audible/visual behavior verified by the controller in Task 5.)

- [ ] **Step 11: Commit**

```bash
git add js/settings.js index.html js/app.js admin.html
git commit -m "feat: synthesized notification chimes + Settings sound toggle + admin sound picker"
```

---

### Task 5: End-to-end browser verification + docs

Controller-run Playwright e2e of the full feature, then document it. The implementer does ONLY the README update (Steps 5-6); the controller runs the browser steps and records results.

**Files:**
- Modify: `README.md` (announcements section)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Image round-trip (controller, Playwright)**

Using a no-auth throwaway container on a spare port (e.g. 8081, `-e ADMIN_AUTH=off`) so the admin page loads without basic-auth (same technique as prior features): on the admin page, pick a small GIF, Send. On the device page (`localhost:8081`), confirm the center card shows the image below the text. Seed a 2nd announcement and confirm the older one shows a toast thumbnail. Confirm the uploaded file is GET-able at `/uploads/<name>`.

- [ ] **Step 2: External URL + broken image (controller)**

Send with a reachable image URL → renders. Send with a bogus URL → text still shows, no broken-image box (the `onerror` hides it).

- [ ] **Step 3: Audio enable + chime (controller)**

On the device page, Settings → Sound → Enable (confirm a `ding` plays and the button shows `On`). Reload → confirm `soundEnabled` persisted (the setting survives in `localStorage`). Send an announcement with `sound:"chime"` while enabled → chime plays once on show (not again on re-render/promotion, verified by the `_soundedIds` guard). Disable → send again → silent.

- [ ] **Step 4: Cleanup**

Reset: `curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '[]' http://localhost:8080/announce.json` and remove the throwaway container.

- [ ] **Step 5: Update the README**

In `README.md`, extend the announcements section: announcements can now carry an **image or GIF** (uploaded via the admin page — stored on the container at `/uploads/`, so it works on offline LAN displays — or pasted as a URL) shown in the card and as a thumbnail in the stack, and a **notification chime** (preset Ding/Alert/Chime, synthesized in-browser). Note each display must enable sound once via **Settings → Sound** (a browser autoplay requirement). Match the surrounding heading level and prose; keep concise.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document announcement images and chimes"
```
(Push handled by the controller during branch finishing.)

---

## Notes for the implementer

- Container `clock-pwa` runs on `localhost:8080`; admin auth `admin` / `change-me`. Authenticated PUT/DELETE write `/uploads/` and `announce.json`; open GET reads them.
- No automated test framework — every "test" step is a manual curl/grep/code-read check; run it and confirm the stated output before checking the box. Browser/audio behavior (Task 5 Steps 1-4) is run by the controller via Playwright; the implementer does only the README.
- `docker compose build && docker compose up -d` after each code change; the `until … admin_auth.conf` loop waits for readiness before curl.
- `ts` is MILLISECONDS, `duration` SECONDS. Image/sound fields are OPTIONAL — never break the text-only path.
- The admin page is not an ES module; it cannot import `js/app.js` helpers, so its Test-button synth is intentionally a small standalone copy.
