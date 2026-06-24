# Stacked Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show multiple live announcements at once — newest centered, older ones as an Apple-style top-right notification stack — by turning `announce.json` into a queue.

**Architecture:** `announce.json` becomes a JSON array (queue). Sends append + trim. The device parses the queue, computes the live set (targeting + not-expired − dismissed), and renders: 1 live → today's centered modal; 2+ live → non-modal centered card for the newest + a capped right-side toast stack for the older ones, with newest-promotes-to-center on expiry. A pure `announceView()` helper makes the decision; a `renderAnnounce()` applier touches the DOM.

**Tech Stack:** Static vanilla-JS PWA (ES modules), nginx (alpine) WebDAV PUT, Docker. No build step, no test framework — verification is manual `curl` + Playwright browser checks (same pattern as prior features).

## Global Constraints

- No build step, plain JS/HTML/CSS, no new dependencies, no bundler.
- Announcement object shape (unchanged): `{ id, text, icon?, ts (ms), duration (s), target, from? }`.
- `announce.json` is a **JSON array** (queue). Default shipped file: `[]`.
- Back-compat: a parsed bare object with `id`+`text` is treated as a 1-element queue; anything else (missing/404/corrupt/non-array) → empty queue. Never throw.
- Live filter: entry shows on a device when `target` is `all` (case-insensitive) or equals the device profile (case-insensitive), AND `ageSec < duration` where `ageSec=(now-ts)/1000`, AND its `id` is not in the dismissed-set. Empty `id`/`text` skipped.
- Display: 0 live → nothing; 1 live → centered **modal** (dim + focus trap + Dismiss, today's behavior); 2+ live → **no dim**, newest = non-modal centered **card**, older live = right-side stack oldest-at-top.
- Center invariant: center always shows the newest still-live entry; on its expiry the next-newest promotes to center (falls out of re-render).
- Right-stack cap = **4**. When more than 4 older entries are live, render the 4 most-recent older ones and a "**+N more**" chip at the **top** for the `N` hidden oldest.
- Toast text/sub/icon rendered via innerHTML MUST be HTML-escaped (XSS). Center uses `textContent` (already safe).
- Admin send: GET → append → drop expired → cap last 20 → PUT. `announce.sh`: append-only in pure `sh` (no jq), tolerating missing/empty/legacy file. Clear → PUT `[]`.
- Animations gated on `@media (prefers-reduced-motion: reduce)`.
- nginx `/announce.json` route and `sw.js` are unchanged (already network-first, shape-agnostic).

---

### Task 1: Queue server model (default file + admin + helper)

Make `announce.json` a queue and make both write paths append to it. Backend/JS-write only; verified entirely by curl + reading the resulting file.

**Files:**
- Modify: `announce.json` (repo root) → `[]`
- Modify: `admin.html` — `put`/`send`/`clear` logic (script near lines 96-123)
- Modify: `announce.sh` (repo root)

**Interfaces:**
- Produces: `announce.json` is an array `[{id,text,icon?,ts,duration,target,from?}, ...]`; default `[]`. Consumed by the device renderer (Task 3).

- [ ] **Step 1: Default file to empty array**

Replace the entire contents of `announce.json` with:

```json
[]
```

- [ ] **Step 2: Rework the admin send/clear to append to the queue**

In `admin.html`, replace the `put` function and the two handlers. Find this block (around lines 96-123):

```javascript
    function put(obj){
      return fetch('announce.json', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(obj)
      });
    }

    $('send').addEventListener('click', function(){
      var text = $('msg').value.trim();
      if (!text){ setStatus('Enter a message first.', false); return; }
      var dur = Math.max(3, Math.min(600, parseInt($('dur').value,10) || 20));
      var obj = {
        id: String(Date.now()) + '-' + Math.floor(Math.random()*10000),
        text: text, icon: ($('icon').value||'📢'), ts: Date.now(),
        duration: dur, target: $('target').value || 'all'
      };
      setStatus('Sending…');
      put(obj).then(function(r){
        if (r.ok) setStatus('Sent to ' + obj.target + ' — displays will show it within ~15s.', true);
        else setStatus('Failed (HTTP ' + r.status + '). Is WebDAV PUT allowed?', false);
      }).catch(function(e){ setStatus('Failed: ' + e, false); });
    });

    $('clear').addEventListener('click', function(){
      setStatus('Clearing…');
      put({ id:'', text:'', ts:0, duration:20, target:'all' }).then(function(r){
        setStatus(r.ok ? 'Cleared.' : 'Failed (HTTP '+r.status+').', r.ok);
      }).catch(function(e){ setStatus('Failed: ' + e, false); });
    });
```

with:

```javascript
    // announce.json is a queue (array). Reads tolerate 404/legacy-object/corrupt.
    function getQueue(){
      return fetch('announce.json?ts=' + Date.now(), { cache:'no-store' })
        .then(function(r){ return r.ok ? r.json() : []; })
        .then(function(j){ return Array.isArray(j) ? j : (j && j.id && j.text ? [j] : []); })
        .catch(function(){ return []; });
    }
    // Drop expired entries, then cap to the last 20.
    function trimQueue(arr){
      var now = Date.now();
      var live = arr.filter(function(a){
        if (!a || !a.id) return false;
        var dur = Number(a.duration) > 0 ? Number(a.duration) : 20;
        return !a.ts || (now - Number(a.ts)) / 1000 < dur;
      });
      return live.slice(-20);
    }
    function putQueue(arr){
      return fetch('announce.json', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(arr)
      });
    }

    $('send').addEventListener('click', function(){
      var text = $('msg').value.trim();
      if (!text){ setStatus('Enter a message first.', false); return; }
      var dur = Math.max(3, Math.min(600, parseInt($('dur').value,10) || 20));
      var obj = {
        id: String(Date.now()) + '-' + Math.floor(Math.random()*10000),
        text: text, icon: ($('icon').value||'📢'), ts: Date.now(),
        duration: dur, target: $('target').value || 'all'
      };
      setStatus('Sending…');
      getQueue().then(function(q){
        return putQueue(trimQueue(q.concat([obj])));
      }).then(function(r){
        if (r.ok) setStatus('Sent to ' + obj.target + ' — displays will show it within ~15s.', true);
        else setStatus('Failed (HTTP ' + r.status + '). Is WebDAV PUT allowed?', false);
      }).catch(function(e){ setStatus('Failed: ' + e, false); });
    });

    $('clear').addEventListener('click', function(){
      setStatus('Clearing…');
      putQueue([]).then(function(r){
        setStatus(r.ok ? 'Cleared.' : 'Failed (HTTP '+r.status+').', r.ok);
      }).catch(function(e){ setStatus('Failed: ' + e, false); });
    });
```

- [ ] **Step 3: Rework `announce.sh` to append to the array**

Replace the `printf '{ ... }' ... > "$ROOT/announce.json"` block (the single line that writes the file) and surrounding `NOW=` line with the append logic. The full new tail of the script (everything from `NOW=` to the final `echo`) becomes:

```sh
NOW=$(date +%s)
F="$ROOT/announce.json"

ELEM=$(printf '{ "id": "%s", "text": "%s", "ts": %s000, "duration": %s, "target": "%s" }' \
  "$NOW-$$" "$(esc "$TEXT")" "$NOW" "$DUR" "$(esc "$TARGET")")

CUR=$(cat "$F" 2>/dev/null)
case "$CUR" in
  \[*\]) : ;;          # already a JSON array
  *) CUR="[]" ;;        # missing/empty/legacy-object -> start fresh
esac
INNER=$(printf '%s' "$CUR" | sed 's/^[[:space:]]*\[//; s/\][[:space:]]*$//')
if printf '%s' "$INNER" | grep -q '[^[:space:]]'; then
  printf '[%s,%s]\n' "$INNER" "$ELEM" > "$F"
else
  printf '[%s]\n' "$ELEM" > "$F"
fi

echo "announced to '$TARGET' for ${DUR}s: $TEXT"
```

(Keep the existing shebang, comments, `ROOT=/data`, `TEXT/TARGET/DUR` parsing, the empty-text usage guard, and the `esc()` function above this block unchanged.)

- [ ] **Step 4: Rebuild and restart**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 5: Verify the queue via curl + helper (this is the test)**

Run:
```bash
B=http://localhost:8080
echo "default:   $(curl -s $B/announce.json)"                                   # expect []
# two appends via the helper
docker exec clock-pwa /usr/local/bin/announce.sh "First" all 60 >/dev/null
docker exec clock-pwa /usr/local/bin/announce.sh "Second" Kitchen 60 >/dev/null
echo "after 2:   $(curl -s $B/announce.json)"                                   # expect array w/ 2 objects, First then Second
# admin-style send (authenticated array PUT) appends a third
THIRD='[{"id":"x","text":"First","ts":'$(($(date +%s)*1000))',"duration":60,"target":"all"},{"id":"y","text":"Third","ts":'$(($(date +%s)*1000))',"duration":60,"target":"all"}]'
echo "auth PUT:  $(curl -s -o /dev/null -w '%{http_code}' -u admin:change-me -X PUT -H 'Content-Type: application/json' -d "$THIRD" $B/announce.json)"  # 204
echo "no-auth:   $(curl -s -o /dev/null -w '%{http_code}' -X PUT -d '[]' $B/announce.json)"   # 401
# reset
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '[]' $B/announce.json
echo "reset:     $(curl -s $B/announce.json)"                                   # expect []
```
Expected: `[]`; a 2-element array with `First` then `Second`; `204`; `401`; `[]`.

- [ ] **Step 6: Commit**

```bash
git add announce.json admin.html announce.sh
git commit -m "feat: announce.json is a queue (array); admin/helper append + trim"
```

---

### Task 2: Markup + CSS for the stack and card mode

Add the right-side stack container and the non-modal card styling. No JS behavior yet (the container stays hidden/empty until Task 3 drives it). Verified by rebuild + snapshot showing the new hidden container and no regression to the existing single overlay.

**Files:**
- Modify: `index.html` (announcement markup, around lines 143-153)
- Modify: `css/styles.css` (announcement block, around lines 146-161)

**Interfaces:**
- Produces: DOM nodes `#announceStack` (the stack container) and the existing `#announce` overlay; CSS classes `.announce-stack`, `.toast`, `.toast-icon`, `.toast-text`, `.toast-sub`, `.toast-more`, and the `.announce--card` modifier. Consumed by `renderAnnounce()` in Task 3.

- [ ] **Step 1: Add the stack container to the markup**

In `index.html`, the announcement overlay block currently ends at line ~152 with `</div>` closing `#announce`. Immediately after that closing `</div>`, add:

```html
  <!-- Stacked announcement toasts (shown when 2+ are live) -->
  <div class="announce-stack" id="announceStack" aria-live="polite" hidden></div>
```

- [ ] **Step 2: Add the stack + card CSS**

In `css/styles.css`, directly after the existing `.announce-close{...}` rule (around line 161), add:

```css
/* ---- Right-side notification stack (2+ live announcements) ---- */
.announce-stack{position:fixed;top:var(--safe-top);right:var(--safe-right);z-index:31;
  display:flex;flex-direction:column;gap:10px;max-width:min(360px,42vw);pointer-events:none}
.announce-stack[hidden]{display:none}
.toast{display:flex;align-items:flex-start;gap:10px;
  background:linear-gradient(180deg,#1b2230,#13171f);border:1px solid var(--bd,#2a2f3a);
  border-radius:12px;padding:10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  color:var(--fg);animation:toastIn .2s ease}
.toast-icon{font-size:20px;line-height:1.2;flex:0 0 auto}
.toast-text{font-size:15px;font-weight:600;line-height:1.2;overflow-wrap:anywhere}
.toast-sub{display:block;margin-top:2px;font-size:12px;font-weight:500;color:var(--fg-dim);letter-spacing:.03em}
.toast-more{justify-content:center;font-size:13px;color:var(--fg-dim);font-weight:600}
@keyframes toastIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
/* Card mode: center announcement goes non-modal (no dim backdrop) when 2+ live */
.announce.announce--card{background:transparent;place-items:start center;pointer-events:none}
.announce.announce--card .announce-box{pointer-events:auto;margin-top:8vh;animation:toastIn .2s ease}
.announce.announce--card .announce-close{font-size:13px;padding:6px 12px}
@media (prefers-reduced-motion: reduce){
  .toast,.announce.announce--card .announce-box{animation:none}
}
```

- [ ] **Step 3: Rebuild and restart**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done; echo ready
```
Expected: `ready`.

- [ ] **Step 4: Verify markup served + no regression (this is the test)**

Run:
```bash
B=http://localhost:8080
echo "stack node: $(curl -s $B/index.html | grep -c 'id=\"announceStack\"')"   # expect 1
echo "css class:  $(curl -s $B/css/styles.css | grep -c 'announce-stack')"      # expect >=1
echo "card class: $(curl -s $B/css/styles.css | grep -c 'announce--card')"      # expect >=1
echo "overlay still present: $(curl -s $B/index.html | grep -c 'id=\"announce\"')" # expect >=1
```
Expected: 1, ≥1, ≥1, ≥1. (The container is `hidden`; no visual change until Task 3.)

- [ ] **Step 5: Commit**

```bash
git add index.html css/styles.css
git commit -m "feat: markup + CSS for announcement stack and non-modal card mode"
```

---

### Task 3: Device live-set renderer

Replace the single-announcement logic in `js/app.js` with the queue renderer: a pure decision helper, a DOM applier, queue fetch, dismissed-set, and the per-expiry timer. This is the core behavioral change.

**Files:**
- Modify: `js/app.js` — constants (~lines 34-35), `app` state literal (~line 38), `pollAnnounce`/`showAnnouncement`/`dismissAnnounce` (~lines 442-504), the `#announceClose` wiring (~line 567), and the announcements init block (~lines 760-766).

**Interfaces:**
- Consumes: `announce.json` queue (Task 1); DOM `#announce`, `#announceStack`, `#announceIcon/Text/Sub`, `#announceClose`, classes from Task 2.
- Produces (module-internal, referenced across the steps below):
  - `announceView(queue, profile, nowMs, dismissed)` → `{ center, stack, moreCount, soonestExpiryMs }`.
  - `renderAnnounce(view)` — applies the view to the DOM.
  - `updateAnnounceView()` — recompute from `app._announceQueue` + now + dismissed, then render.
  - `normalizeQueue(j)`, `escHtml(s)`, `pruneDismissed()`, `persistDismissed()`.
  - State: `app._announceQueue` (array), `app._announceDismissed` (Set), `app._announceModal` (bool), `app._announceTimer`.

- [ ] **Step 1: Replace the announcement constants**

In `js/app.js`, replace lines 34-35:

```javascript
const ANNOUNCE_SEEN_KEY = 'clockpwa.announceSeen';
const ANNOUNCE_POLL_MS = 15000;
```

with:

```javascript
const ANNOUNCE_DISMISSED_KEY = 'clockpwa.announceDismissed';
const ANNOUNCE_STACK_CAP = 4;
const ANNOUNCE_POLL_MS = 15000;
```

- [ ] **Step 2: Add announcement state fields to the `app` object**

In the `app` object literal (starts ~line 38), add these fields next to the other `_`-prefixed runtime fields (e.g. right after `_customProfiles: [],` added by the profiles feature):

```javascript
  _announceQueue: [],
  _announceDismissed: null,
  _announceModal: false,
```

- [ ] **Step 3: Replace `pollAnnounce`, `showAnnouncement`, `dismissAnnounce` with the queue renderer**

Replace the whole block from `async function pollAnnounce(){` (line ~445) through the end of `dismissAnnounce` (the closing `}` at line ~504) with:

```javascript
// Minimal HTML escaper for text rendered via innerHTML (toast stack).
function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Coerce a parsed announce.json into an array. Accepts a legacy single object.
function normalizeQueue(j){
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object' && j.id && j.text) return [j];   // legacy single
  return [];
}

// PURE: decide what to show. No DOM, no app state.
// Returns { center, stack, moreCount, soonestExpiryMs }:
//   center  = newest live entry (or null)
//   stack   = older live entries to render as toasts, oldest-first (top->bottom), capped to the
//             ANNOUNCE_STACK_CAP most-recent older entries
//   moreCount = hidden older entries collapsed into the "+N more" chip
//   soonestExpiryMs = ms until the next entry expires (Infinity if none live)
function announceView(queue, profile, nowMs, dismissed){
  const prof = String(profile || 'None').toLowerCase();
  const live = [];
  for (const a of (Array.isArray(queue) ? queue : [])){
    if (!a || !a.id || !a.text) continue;
    if (dismissed && dismissed.has(a.id)) continue;
    const tgt = String(a.target || 'all').toLowerCase();
    if (tgt !== 'all' && tgt !== prof) continue;
    const dur = Number(a.duration) > 0 ? Number(a.duration) : 20;
    const ageSec = a.ts ? (nowMs - Number(a.ts)) / 1000 : 0;
    if (ageSec >= dur) continue;                       // expired
    live.push({ a: a, expiresInMs: (dur - ageSec) * 1000 });
  }
  live.sort((x, y) => Number(x.a.ts) - Number(y.a.ts));  // ascending by ts
  if (live.length === 0) return { center:null, stack:[], moreCount:0, soonestExpiryMs:Infinity };
  const soonest = live.reduce((m, e) => Math.min(m, e.expiresInMs), Infinity);
  const center = live[live.length - 1].a;                // newest
  const olders = live.slice(0, -1).map(e => e.a);        // ascending, all but newest
  const shown = olders.slice(-ANNOUNCE_STACK_CAP);       // most-recent older entries
  const moreCount = Math.max(0, olders.length - shown.length);
  return { center, stack: shown, moreCount, soonestExpiryMs: soonest };
}

function persistDismissed(){
  try { localStorage.setItem(ANNOUNCE_DISMISSED_KEY, JSON.stringify(Array.from(app._announceDismissed))); } catch(_){}
}
// Keep the dismissed-set bounded: forget ids no longer present in the queue.
function pruneDismissed(){
  try {
    const ids = new Set((app._announceQueue || []).map(a => a && a.id).filter(Boolean));
    let changed = false;
    for (const id of Array.from(app._announceDismissed)){
      if (!ids.has(id)){ app._announceDismissed.delete(id); changed = true; }
    }
    if (changed) persistDismissed();
  } catch(_){}
}

function announceSub(a){
  return a.from || (a.target && String(a.target).toLowerCase() !== 'all' ? a.target : '');
}

// Apply a computed view to the DOM. Idempotent.
function renderAnnounce(view){
  try {
    const el = $('announce');
    const stackEl = $('announceStack');
    if (!el) return;

    if (!view.center){                                   // nothing live
      el.hidden = true; el.classList.remove('announce--card');
      if (stackEl){ stackEl.innerHTML = ''; stackEl.hidden = true; }
      if (app._announceModal && app.nav){ app.nav.setScope(app.state === PANEL ? $('panel') : document); }
      app._announceModal = false;
      if (app._announceTimer){ clearTimeout(app._announceTimer); app._announceTimer = null; }
      return;
    }

    const c = view.center;
    $('announceIcon').textContent = c.icon || '📢';
    $('announceText').textContent = c.text;
    const sub = announceSub(c);
    $('announceSub').textContent = sub ? ('— ' + sub) : '';
    el.dataset.id = c.id;
    el.hidden = false;

    const multi = view.stack.length > 0 || view.moreCount > 0;
    if (multi){
      el.classList.add('announce--card');
      el.removeAttribute('aria-modal');
      if (app._announceModal && app.nav){ app.nav.setScope(app.state === PANEL ? $('panel') : document); }
      app._announceModal = false;
      let html = '';
      if (view.moreCount > 0) html += '<div class="toast toast-more">+' + view.moreCount + ' more</div>';
      for (const a of view.stack){
        const s = announceSub(a);
        html += '<div class="toast"><span class="toast-icon">' + escHtml(a.icon || '📢') + '</span>'
              + '<span class="toast-text">' + escHtml(a.text)
              + (s ? ('<span class="toast-sub">— ' + escHtml(s) + '</span>') : '')
              + '</span></div>';
      }
      if (stackEl){ stackEl.innerHTML = html; stackEl.hidden = false; }
    } else {
      el.classList.remove('announce--card');
      el.setAttribute('aria-modal', 'true');
      if (stackEl){ stackEl.innerHTML = ''; stackEl.hidden = true; }
      if (!app._announceModal && app.nav){ app.nav.setScope(el); app.nav.focusFirst(); }
      app._announceModal = true;
    }

    if (app._announceTimer){ clearTimeout(app._announceTimer); app._announceTimer = null; }
    if (isFinite(view.soonestExpiryMs)){
      const delay = Math.max(250, Math.min(view.soonestExpiryMs + 50, 60000));
      app._announceTimer = setTimeout(updateAnnounceView, delay);
    }
  } catch(_){}
}

// Recompute from the current queue and render.
function updateAnnounceView(){
  pruneDismissed();
  const view = announceView(app._announceQueue, app.settings && app.settings.profile, Date.now(), app._announceDismissed);
  renderAnnounce(view);
}

// Poll the server queue (network-first); on success refresh the view.
async function pollAnnounce(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('announce.json?ts=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    app._announceQueue = normalizeQueue(j);
    updateAnnounceView();
  } catch(_) { /* offline / no file — keep current view */ }
}

// Dismiss the currently-centered announcement: remember its id, then re-render
// (promotes the next-newest live entry into the center, or hides if none left).
function dismissAnnounce(){
  try {
    const el = $('announce');
    const id = el && el.dataset ? el.dataset.id : '';
    if (id && app._announceDismissed){ app._announceDismissed.add(id); persistDismissed(); }
    updateAnnounceView();
  } catch(_){}
}
```

- [ ] **Step 4: Initialize the dismissed-set and queue in the init block**

In the announcements init block (~lines 760-766), replace:

```javascript
  try {
    app._announceSeen = localStorage.getItem(ANNOUNCE_SEEN_KEY) || '';
  } catch(_) { app._announceSeen = ''; }
```

with:

```javascript
  try {
    app._announceDismissed = new Set(JSON.parse(localStorage.getItem(ANNOUNCE_DISMISSED_KEY) || '[]') || []);
  } catch(_) { app._announceDismissed = new Set(); }
  app._announceQueue = [];
```

(The `pollAnnounce(); pollProfiles();` calls, the `setInterval`, and the `visibilitychange` listener right below stay unchanged — they already drive `pollAnnounce` which now refreshes the queue view.)

- [ ] **Step 5: Confirm the dismiss wiring still points at `dismissAnnounce`**

The existing line (~567) `$('announceClose').addEventListener('click', dismissAnnounce);` stays as-is — `dismissAnnounce` now records the id and re-renders. No change needed; verify it is still present and unchanged.

- [ ] **Step 6: Rebuild, restart, confirm the new code is served**

Run:
```bash
docker compose build && docker compose up -d
until docker exec clock-pwa test -s /etc/nginx/admin_auth.conf 2>/dev/null; do sleep 0.3; done
A=$(curl -s http://localhost:8080/js/app.js)
for fn in announceView renderAnnounce updateAnnounceView normalizeQueue escHtml; do
  echo "$fn: $(printf '%s' "$A" | grep -c "function $fn")"
done
echo "no _announceSeen left: $(printf '%s' "$A" | grep -c '_announceSeen')"   # expect 0
```
Expected: each function count ≥1, and `_announceSeen` count 0. (Browser behavior is verified by the controller in Task 4.)

- [ ] **Step 7: Commit**

```bash
git add js/app.js
git commit -m "feat: device renders announcement queue (center card + right stack)"
```

---

### Task 4: End-to-end browser verification + docs

Controller-run browser e2e (Playwright) of the full feature, then document it. The implementer does ONLY the README update (Step 5-6); the controller performs the browser steps separately and records results.

**Files:**
- Modify: `README.md` (announcements section)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Reset + seed a single announcement**

```bash
B=http://localhost:8080
NOW=$(($(date +%s)*1000))
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' \
  -d '[{"id":"a1","text":"Solo message","icon":"📢","ts":'$NOW',"duration":120,"target":"all"}]' $B/announce.json
```
Browser (device page, profile None): exactly one live → **centered dimmed modal** with Dismiss (regression check). The stack container stays hidden.

- [ ] **Step 2: Multiple live → card + stack**

```bash
B=http://localhost:8080; NOW=$(($(date +%s)*1000))
curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '[
  {"id":"b1","text":"Oldest","ts":'$((NOW-3000))',"duration":300,"target":"all"},
  {"id":"b2","text":"Middle","ts":'$((NOW-2000))',"duration":300,"target":"all"},
  {"id":"b3","text":"Newest","ts":'$((NOW-1000))',"duration":300,"target":"all"}]' $B/announce.json
```
Browser: dim drops; **Newest** centered as a card; right stack shows **Oldest** (top) then **Middle** (bottom). Verify ordering and that no full-screen dim is present.

- [ ] **Step 3: Cap + "+N more"**

Seed 7 all-targeted live entries (1 newest + 6 older). Browser: center = newest; stack shows the **4 most-recent older** entries; a "**+N more**" chip (N=2) at the **top**.

- [ ] **Step 4: Promotion, dismiss, targeting, clear (controller, Playwright)**

- Let the centered newest expire (short duration) while olders live → next-newest promotes to center.
- Click Dismiss/✕ on the center card → that id does not re-pop on the next poll; an older entry promotes to center.
- Set the device profile to `Kitchen`; seed one entry `target:"Kitchen"` and one `target:"Living Room"` → only the Kitchen one shows.
- Clear all (`PUT []`) → everything disappears.
- Toggle reduce-motion (emulate `prefers-reduced-motion`) → no slide animation.

Reset when done: `curl -s -u admin:change-me -X PUT -H 'Content-Type: application/json' -d '[]' http://localhost:8080/announce.json`.

- [ ] **Step 5: Update the README**

In `README.md`, find the announcements section (search for "announce" / "Announce"). Replace/extend its description so it states announcements are now a **queue**: a single live announcement shows centered (as before); two or more show the newest centered with the rest as a top-right notification stack (Apple-style), each auto-dismissing on its duration, capped at 4 with a "+N more" chip. Note that sends append to `announce.json` (now a JSON array) and "Clear / dismiss all" empties it. Match the surrounding heading level and prose style; keep it to one short paragraph.

- [ ] **Step 6: Commit + push**

```bash
git add README.md
git commit -m "docs: document stacked announcement notifications"
```
(Push is handled by the controller during branch finishing, not here.)

---

## Notes for the implementer

- Container `clock-pwa` runs on `localhost:8080`; admin auth `admin` / `change-me`. Authenticated PUT writes `announce.json`; open GET reads it.
- No automated test framework — every "test" step is a manual curl/code-read check. Run it and confirm the stated output before checking the box. The browser e2e (Task 4 Steps 1-4) is run by the controller via Playwright (subagents can't drive a browser); the implementer does only the README.
- `docker compose build && docker compose up -d` after each code change; the `until ... admin_auth.conf` loop waits for readiness before curl.
- `ts` is in **milliseconds**; `duration` in **seconds**. Keep that straight when seeding test data.
