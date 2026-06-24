# Admin Custom Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin create/remove custom room profiles that sync to every device's Profile picker and the admin targeting dropdown.

**Architecture:** A shared list of *custom* profile names is persisted to `/data/profiles.json` and served by nginx exactly like `announce.json` (open GET, auth-protected PUT). The built-in 7 rooms + `None` stay hardcoded in both device and admin code; the effective list is `None + builtins + customs` (deduped). Admin edits the customs via a new section in `admin.html` (WebDAV PUT). Devices fetch `profiles.json` on load and on the existing announcement poll tick, caching to localStorage for offline use.

**Tech Stack:** Static vanilla-JS PWA, nginx (alpine) with WebDAV PUT, Docker. No build step, no test framework — verification is manual via `curl` against the running container and browser checks (same pattern as the existing admin-auth tests).

## Global Constraints

- No build step. Plain ES5/ES6 in `js/*.js`, plain `<script>` in `admin.html`. No new dependencies, no bundler.
- `profiles.json` stores **only** custom names: `{ "profiles": ["Name", ...] }`. Built-ins live in code and are always present even if the file is missing/empty/corrupt.
- `BUILTINS = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage']` — exact strings, must match between `js/app.js` and `admin.html`.
- Device effective cycle list = `['None', ...BUILTINS, ...customs]`, deduped (case-insensitive), original casing preserved.
- Admin target dropdown = `All` + `BUILTINS` + `customs`.
- Custom-name validation on add: trim; reject empty; reject case-insensitive duplicate of any builtin, `None`, `All`, or existing custom.
- PUT requests reuse the browser's cached basic-auth (no explicit credentials in fetch), same as the existing announcement PUT.
- All dynamic JSON (`profiles.json`) must be served no-cache and network-first in the service worker, never precached in the shell.

---

### Task 1: Ship default `profiles.json` + nginx route + Docker copy

Backend plumbing so a device GET of `/profiles.json` returns `{"profiles":[]}` (200, not 404) and an authenticated PUT can write it. This is one task because the route, the default file, and the image copy are useless individually and are verified by a single curl matrix.

**Files:**
- Create: `profiles.json` (repo root, next to `announce.json`)
- Modify: `nginx.conf` (add `location = /profiles.json` after the `announce.json` block, currently ends at line 62)
- Modify: `Dockerfile:20` area (add a `COPY profiles.json /data/profiles.json` so the existing `chown -R nginx:nginx /data` at line 21 covers it)

**Interfaces:**
- Produces: HTTP route `GET /profiles.json` (open) and `PUT /profiles.json` (admin basic-auth). Response/body shape `{ "profiles": string[] }`.

- [ ] **Step 1: Create the default file**

Create `profiles.json` (repo root):

```json
{ "profiles": [] }
```

- [ ] **Step 2: Add the nginx location**

In `nginx.conf`, immediately after the closing `}` of the `location = /announce.json` block (line 62), add:

```nginx
  # Admin-managed custom room profiles — served from the writable /data dir,
  # written via WebDAV PUT from the admin page. Polled by every device.
  location = /profiles.json {
    root /data;
    default_type application/json;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    expires off;
    dav_methods PUT;
    create_full_put_path off;
    client_body_temp_path /data/tmp;
    client_max_body_size 64k;
    # GET (device polling) stays open; writing (PUT) requires admin auth.
    limit_except GET { include /etc/nginx/admin_auth.conf; }
  }
```

- [ ] **Step 3: Copy the default file into the image**

In `Dockerfile`, directly below line 20 (`COPY announce.json /data/announce.json`), add:

```dockerfile
COPY profiles.json /data/profiles.json
```

(The existing `RUN mkdir -p /data/tmp && chown -R nginx:nginx /data ...` on the next line already covers ownership.)

- [ ] **Step 4: Rebuild the image**

Run: `docker compose build`
Expected: build succeeds, ends with `clock  Built`.

- [ ] **Step 5: Restart and wait for readiness**

Run:
```bash
docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 6: Verify the curl matrix (this is the test)**

Run:
```bash
B=http://localhost:8080
echo "GET no-creds:  $(curl -s -o /dev/null -w '%{http_code}' $B/profiles.json)"      # expect 200
echo "GET body:      $(curl -s $B/profiles.json)"                                      # expect {"profiles":[]}
echo "PUT no-creds:  $(curl -s -o /dev/null -w '%{http_code}' -X PUT -d '{}' $B/profiles.json)"  # expect 401
echo "PUT bad-creds: $(curl -s -o /dev/null -w '%{http_code}' -u admin:wrong -X PUT -d '{}' $B/profiles.json)"  # expect 401
echo "PUT good:      $(curl -s -o /dev/null -w '%{http_code}' -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{\"profiles\":[\"Garage Gym\"]}' $B/profiles.json)"  # expect 204
echo "GET after PUT: $(curl -s -u admin:change-me $B/profiles.json)"                    # expect {"profiles":["Garage Gym"]}
```
Expected: 200, `{"profiles":[]}`, 401, 401, 204, `{"profiles":["Garage Gym"]}`.

- [ ] **Step 7: Reset the test data**

Run:
```bash
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{"profiles":[]}' http://localhost:8080/profiles.json
```

- [ ] **Step 8: Commit**

```bash
git add profiles.json nginx.conf Dockerfile
git commit -m "feat: serve /profiles.json (open GET, auth PUT) for custom profiles"
```

---

### Task 2: Device — dynamic profile list from `profiles.json`

Replace the hardcoded device `PROFILES` const with an effective-list builder fed by a fetched-and-cached customs array. Wire the fetch into app init and the existing announce poll. This is one task: the const, the fetch, the cache, and the cycle handler are a single behavioral change verified together in the browser.

**Files:**
- Modify: `js/app.js:31` (replace the `PROFILES` const)
- Modify: `js/app.js` near line 32 (add `PROFILES_KEY` constant + `app` state field)
- Modify: `js/app.js:522-526` (the `setProfile` click handler — cycle the effective list)
- Modify: `js/app.js:418-441` area (add `pollProfiles()` next to `pollAnnounce()`)
- Modify: `js/app.js:714-722` (call `pollProfiles()` on init and on the announce interval)

**Interfaces:**
- Consumes: HTTP `GET /profiles.json` → `{ "profiles": string[] }` (from Task 1).
- Produces:
  - `BUILTINS: string[]` — the 7 built-in room names.
  - `app._customProfiles: string[]` — current customs (in memory).
  - `effectiveProfiles(): string[]` — returns `['None', ...BUILTINS, ...customs]` deduped case-insensitively, **plus** the device's current saved profile appended if it isn't already in the list (so a removed custom still cycles).
  - `pollProfiles(): Promise<void>` — fetches, validates, updates `app._customProfiles`, caches to localStorage.

- [ ] **Step 1: Replace the `PROFILES` const and add constants**

In `js/app.js`, replace line 31:

```javascript
const PROFILES = ['None','Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage'];
```

with:

```javascript
// Built-in device room profiles. Custom ones are fetched from /profiles.json
// (admin-managed) and merged in; built-ins always present even if that's empty.
const BUILTINS = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage'];
const PROFILES_KEY = 'clockpwa.profiles.v1';
```

- [ ] **Step 2: Add the `effectiveProfiles` helper**

Add this function just below the constants block (after line ~33, before the state machine comment at line 35):

```javascript
// Effective Profile cycle list: None + builtins + admin customs (deduped,
// case-insensitive). The device's current value is appended if missing so a
// custom that was removed admin-side still cycles instead of getting stuck.
function effectiveProfiles(){
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const v = String(name == null ? '' : name).trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push(v);
  };
  push('None');
  BUILTINS.forEach(push);
  (app._customProfiles || []).forEach(push);
  const cur = (app.settings && app.settings.profile) || 'None';
  push(cur);
  return out;
}
```

- [ ] **Step 3: Initialize the customs state from cache**

In the `app` object literal (starts line 38), add a field alongside the existing ones (e.g. after `isTV: false,` at line 43):

```javascript
  _customProfiles: [],
```

- [ ] **Step 4: Add `pollProfiles()`**

Add this function directly after `pollAnnounce()` (after its closing `}` at line 441):

```javascript
// Fetch the admin-managed custom profile list (network-first); cache to
// localStorage so it survives offline. Never throws.
async function pollProfiles(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('profiles.json?ts=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const list = (j && Array.isArray(j.profiles)) ? j.profiles : [];
    app._customProfiles = list.map(function(x){ return String(x).trim(); }).filter(Boolean);
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(app._customProfiles)); } catch(_){}
    syncButtons();
  } catch(_) { /* offline / no file — keep cached value */ }
}
```

- [ ] **Step 5: Load cached customs + start polling in init**

In the announcements init block (lines 714-722), add profile loading. Change:

```javascript
  // Announcements: poll the server for broadcasts (now + every 15s + on refocus).
  try {
    app._announceSeen = localStorage.getItem(ANNOUNCE_SEEN_KEY) || '';
  } catch(_) { app._announceSeen = ''; }
  try {
    pollAnnounce();
    app.announceTimer = setInterval(pollAnnounce, ANNOUNCE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAnnounce(); });
  } catch(_){}
```

to:

```javascript
  // Custom profiles: load cached list, then fetch fresh + poll alongside announcements.
  try {
    app._customProfiles = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]') || [];
  } catch(_) { app._customProfiles = []; }

  // Announcements: poll the server for broadcasts (now + every 15s + on refocus).
  try {
    app._announceSeen = localStorage.getItem(ANNOUNCE_SEEN_KEY) || '';
  } catch(_) { app._announceSeen = ''; }
  try {
    pollAnnounce(); pollProfiles();
    app.announceTimer = setInterval(() => { pollAnnounce(); pollProfiles(); }, ANNOUNCE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden){ pollAnnounce(); pollProfiles(); } });
  } catch(_){}
```

- [ ] **Step 6: Update the `setProfile` cycle handler**

Replace lines 522-526:

```javascript
  $('setProfile').addEventListener('click', () => {
    const i = PROFILES.indexOf(app.settings.profile);
    app.settings.profile = PROFILES[(i + 1) % PROFILES.length] || 'None';
    persist(); syncButtons();
  });
```

with:

```javascript
  $('setProfile').addEventListener('click', () => {
    const list = effectiveProfiles();
    const i = list.indexOf(app.settings.profile);
    app.settings.profile = list[(i + 1) % list.length] || 'None';
    persist(); syncButtons();
  });
```

- [ ] **Step 7: Rebuild, restart, seed a custom**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{"profiles":["Garage Gym","Patio"]}' http://localhost:8080/profiles.json
```
Expected: PUT returns silently (204).

- [ ] **Step 8: Verify in the browser (this is the test)**

Open `http://localhost:8080/` → Settings → Profile. Tap the Profile button repeatedly and confirm the cycle order is:
`None → Theater Room → Study Room → Kitchen → Living Room → Bedroom → Office → Garage → Garage Gym → Patio → None …`

Then: remove a custom server-side and confirm a device already set to it keeps showing it —
```bash
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{"profiles":["Patio"]}' http://localhost:8080/profiles.json
```
Set the device to `Garage Gym` first, wait ~15s (or refocus the tab), confirm the button still reads `Garage Gym` (not reset), and that cycling still advances past it.

- [ ] **Step 9: Reset test data**

Run:
```bash
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{"profiles":[]}' http://localhost:8080/profiles.json
```

- [ ] **Step 10: Commit**

```bash
git add js/app.js
git commit -m "feat: device Profile picker merges admin custom profiles"
```

---

### Task 3: Service worker — network-first for `profiles.json` + version bump

`profiles.json` must behave like `announce.json` in the SW: network-first with runtime-cache fallback, never precached. Bump the cache version so existing installs pick up the new SW.

**Files:**
- Modify: `sw.js:4-5` (bump `SHELL`/`RUNTIME` to v13)
- Modify: `sw.js:46-47` (add `/profiles.json` to the network-first path test)

**Interfaces:**
- Consumes: `GET /profiles.json` route (Task 1).
- Produces: offline cache fallback for `/profiles.json` (used by `pollProfiles()` indirectly via cache; the app's own localStorage cache is the primary offline source).

- [ ] **Step 1: Bump the cache version**

In `sw.js`, change lines 4-5:

```javascript
const SHELL = 'clockpwa-shell-v12';
const RUNTIME = 'clockpwa-runtime-v12';
```

to:

```javascript
const SHELL = 'clockpwa-shell-v13';
const RUNTIME = 'clockpwa-runtime-v13';
```

- [ ] **Step 2: Add `profiles.json` to the network-first branch**

Change lines 45-47:

```javascript
  // Server config / weather / announcements / ZIP geocoder: network-first, cache fallback.
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.hostname.endsWith('zippopotam.us')){
```

to:

```javascript
  // Server config / weather / announcements / profiles / ZIP geocoder: network-first, cache fallback.
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.pathname === '/profiles.json'
      || url.hostname.endsWith('zippopotam.us')){
```

- [ ] **Step 3: Rebuild and restart**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 4: Verify the SW serves the new version**

Run:
```bash
curl -s http://localhost:8080/sw.js | grep -E "clockpwa-(shell|runtime)-v13"
```
Expected: both `clockpwa-shell-v13` and `clockpwa-runtime-v13` printed.

- [ ] **Step 5: Commit**

```bash
git add sw.js
git commit -m "feat: service worker network-first for profiles.json (cache v13)"
```

---

### Task 4: Admin page — manage custom profiles

Add a "Manage profiles" section to `admin.html`: load current customs, add (validated), remove, PUT `profiles.json`, and rebuild the target dropdown from `All + builtins + customs`. The announcement targeting must include customs so an admin can target a room they just created.

**Files:**
- Modify: `admin.html:71-74` (insert the manage-profiles card before the `.hint`)
- Modify: `admin.html:78` (replace the hardcoded `PROFILES` const with `BUILTINS` + a customs state var)
- Modify: `admin.html:83-86` (replace the one-shot dropdown population with a rebuildable function)
- Modify: `admin.html` script (add load + add + remove + PUT logic)

**Interfaces:**
- Consumes: `GET`/`PUT /profiles.json` (Task 1); the device merge semantics (Task 2) — the customs the admin writes are exactly what devices read.
- Produces: nothing other tasks depend on (terminal UI task).

- [ ] **Step 1: Add the manage-profiles markup**

In `admin.html`, insert this block between the closing `</div>` of the main `.card` (line 69) and the `.hint` div (line 71):

```html
    <div class="card" style="margin-top:16px">
      <label for="newProfile">Custom profiles</label>
      <div class="row">
        <div style="flex:2"><input id="newProfile" type="text" placeholder="e.g. Garage Gym" maxlength="40"></div>
        <div style="flex:0"><button class="ghost" id="addProfile" type="button">Add</button></div>
      </div>
      <div class="presets" id="profileList" style="margin-top:12px"></div>
      <div class="status" id="profStatus"></div>
    </div>
```

- [ ] **Step 2: Replace the profiles const**

Replace line 78:

```javascript
    var PROFILES = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage'];
```

with:

```javascript
    var BUILTINS = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage'];
    var customProfiles = [];
```

- [ ] **Step 3: Replace one-shot dropdown population with a rebuild function**

Replace lines 83-86:

```javascript
    // populate target dropdown
    var sel = $('target');
    sel.innerHTML = '<option value="all">All displays</option>' +
      PROFILES.map(function(p){ return '<option value="'+p+'">'+p+'</option>'; }).join('');
```

with:

```javascript
    // (Re)build the target dropdown from All + builtins + customs, preserving selection.
    var sel = $('target');
    function rebuildTargets(){
      var prev = sel.value;
      var all = BUILTINS.concat(customProfiles);
      sel.innerHTML = '<option value="all">All displays</option>' +
        all.map(function(p){ return '<option value="'+p+'">'+p+'</option>'; }).join('');
      if (prev){ sel.value = prev; }
    }
    rebuildTargets();
```

- [ ] **Step 4: Add load / render / add / remove / PUT logic**

Add this block at the end of the `<script>`, just before the closing `</script>` (line 124):

```javascript
    function setProfStatus(msg, ok){ var s=$('profStatus'); s.textContent=msg; s.className='status '+(ok===true?'ok':ok===false?'err':''); }

    function putProfiles(){
      return fetch('profiles.json', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ profiles: customProfiles })
      });
    }

    function renderProfiles(){
      $('profileList').innerHTML = customProfiles.length
        ? customProfiles.map(function(p){
            return '<button class="chip" type="button" data-name="'+p.replace(/"/g,'&quot;')+'">'+p+' ✕</button>';
          }).join('')
        : '<span class="hint" style="margin:0">No custom profiles yet. Built-in rooms are always available.</span>';
    }

    function loadProfiles(){
      fetch('profiles.json?ts=' + Date.now(), { cache:'no-store' }).then(function(r){
        return r.ok ? r.json() : { profiles: [] };
      }).then(function(j){
        customProfiles = (j && Array.isArray(j.profiles)) ? j.profiles.map(function(x){ return String(x).trim(); }).filter(Boolean) : [];
        renderProfiles(); rebuildTargets();
      }).catch(function(){ customProfiles = []; renderProfiles(); rebuildTargets(); });
    }

    function isDup(name){
      var k = name.toLowerCase();
      if (k === 'none' || k === 'all') return true;
      var all = BUILTINS.concat(customProfiles);
      return all.some(function(p){ return p.toLowerCase() === k; });
    }

    $('addProfile').addEventListener('click', function(){
      var name = $('newProfile').value.trim();
      if (!name){ setProfStatus('Enter a name first.', false); return; }
      if (isDup(name)){ setProfStatus('"'+name+'" already exists.', false); return; }
      customProfiles.push(name);
      renderProfiles(); rebuildTargets();
      setProfStatus('Saving…');
      putProfiles().then(function(r){
        if (r.ok){ $('newProfile').value=''; setProfStatus('Added "'+name+'".', true); }
        else { customProfiles.pop(); renderProfiles(); rebuildTargets(); setProfStatus('Failed (HTTP '+r.status+').', false); }
      }).catch(function(e){ customProfiles.pop(); renderProfiles(); rebuildTargets(); setProfStatus('Failed: '+e, false); });
    });

    $('newProfile').addEventListener('keydown', function(e){ if (e.key === 'Enter'){ e.preventDefault(); $('addProfile').click(); } });

    $('profileList').addEventListener('click', function(e){
      var btn = e.target.closest ? e.target.closest('.chip') : e.target;
      if (!btn || !btn.getAttribute('data-name')) return;
      var name = btn.getAttribute('data-name');
      var idx = customProfiles.indexOf(name);
      if (idx < 0) return;
      var removed = customProfiles.splice(idx, 1)[0];
      renderProfiles(); rebuildTargets();
      setProfStatus('Saving…');
      putProfiles().then(function(r){
        if (r.ok){ setProfStatus('Removed "'+removed+'".', true); }
        else { customProfiles.splice(idx, 0, removed); renderProfiles(); rebuildTargets(); setProfStatus('Failed (HTTP '+r.status+').', false); }
      }).catch(function(err){ customProfiles.splice(idx, 0, removed); renderProfiles(); rebuildTargets(); setProfStatus('Failed: '+err, false); });
    });

    loadProfiles();
```

- [ ] **Step 5: Rebuild and restart**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 6: Verify in the browser (this is the test)**

Open `http://localhost:8080/admin.html` (log in `admin` / `change-me`). Then:
1. "Custom profiles" section shows "No custom profiles yet."
2. Type `Garage Gym`, click **Add** → chip `Garage Gym ✕` appears, status "Added".
3. The **Send to** dropdown now lists `Garage Gym` after the 7 builtins.
4. Reload the page → `Garage Gym` still present (persisted server-side).
5. Try adding `kitchen` (lowercase) → rejected as duplicate of builtin `Kitchen`.
6. Try adding empty → rejected.
7. Click the `Garage Gym ✕` chip → removed, dropdown drops it, status "Removed".

Confirm server state:
```bash
curl -s -u admin:change-me http://localhost:8080/profiles.json   # expect {"profiles":[]} after removal
```

- [ ] **Step 7: Commit**

```bash
git add admin.html
git commit -m "feat: admin page manages custom profiles (add/remove, WebDAV PUT)"
```

---

### Task 5: End-to-end verification + docs

Confirm the whole loop (admin add → device picker → announcement targeting) and update the README so the feature is discoverable.

**Files:**
- Modify: `README.md` (profiles/announcements section — document custom profiles)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Full loop test (this is the test)**

With the container running:
1. Admin page → add custom `Garage Gym`.
2. Device page → Settings → Profile → cycle to `Garage Gym`, leave it selected.
3. Admin page → Message `Test`, **Send to** `Garage Gym`, **Send announcement**.
4. Within ~15s the device shows the banner with `— Garage Gym`.
5. Set the device Profile to `Kitchen`, send another to `Garage Gym` → device does **not** show it (correct targeting).
6. Reset: `curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '{"profiles":[]}' http://localhost:8080/profiles.json`

- [ ] **Step 2: Update the README**

Find the announcements/profiles section in `README.md` and add a short paragraph (match the surrounding style and heading level):

```markdown
### Custom profiles

Built-in room profiles (Theater Room, Kitchen, …) cover most setups. To add
your own (e.g. "Garage Gym"), open the admin page → **Custom profiles** →
type a name → **Add**. Custom profiles are stored server-side
(`/data/profiles.json`, written via authenticated WebDAV PUT) and appear in
every device's Settings → Profile picker within ~15s, as well as in the
announcement **Send to** list. Remove one with the ✕ on its chip. Built-in
rooms are always available even if the file is empty or missing.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document admin-managed custom profiles"
```

- [ ] **Step 4: Push**

```bash
git push
```

---

## Notes for the implementer

- The container is already running on `localhost:8080` from earlier work; `ADMIN_USER=admin`, `ADMIN_PASS=change-me` (from `docker-compose.yml`). Basic-auth creds are reused by the browser after the first `/admin.html` login.
- There is no automated test suite. Every "test" step is a manual curl/browser check — run it and confirm the stated expected output before checking the box.
- `docker compose build && docker compose up -d` after each code change; the `until ... admin_auth.conf` loop waits for the entrypoint to finish before you curl.
- Keep `BUILTINS` identical in `js/app.js` and `admin.html` — a drift breaks dedup/targeting.
