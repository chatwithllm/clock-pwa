# Server-Driven Time/Weather + Dual Clock + Weather-Feel Colors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the clock reflect the environment — digit colors driven by temperature+humidity, a second city clock colored by its own weather, and one client "Source" switch (plus admin push) that lets the server dictate time + weather.

**Architecture:** Extend the existing vanilla-ESM PWA. A new pure `weatherColor()` function maps temp+humidity to a readable palette; `app.js` feeds it the primary weather (for digits/hands) while the condition-based animated backdrop stays untouched. The second clock becomes a corner badge with its own weather fetch. A new `source` setting maps to the existing `timeSource`/`locationMode`, and an admin-written `source.json` (auth-gated WebDAV PUT, like `announce.json`) can default or force it.

**Tech Stack:** Vanilla JS ES modules, SVG/CSS rendering, nginx + WebDAV, Open-Meteo API. Tests: Node's built-in test runner (`node --test`) for pure modules; manual browser verification for DOM/integration.

## Global Constraints

- **The clock must never break.** Every weather/network/DOM entry point stays wrapped in try/catch; failure degrades to neutral color / hidden badge / time-only — never a blank or frozen clock.
- **Temperature data is Celsius** end to end; display temps are °F primary (use `bothTemps()`).
- **Weather-feel colors are gated by `Display: Dynamic`.** Plain or deep-dim → `clearTint()` / neutral, as today.
- **Backdrop animation stays condition-based** (`WeatherFX` / `fxForCode` untouched). Only digit/hand colors switch to temp+humidity.
- **No package-manager dependencies.** Pure-function tests use `node --test` only.
- ES modules in the browser require a root `package.json` with `"type":"module"` so Node can import the same `.js` files for tests; this does not affect the browser or `sw.js` (registered as a classic worker).

---

### Task 1: `weatherColor()` pure palette function + Node test harness

**Files:**
- Create: `package.json`
- Create: `js/feelcolor.js`
- Test: `test/feelcolor.test.js`

**Interfaces:**
- Produces: `weatherColor(tempC: number|null, rh: number|null) -> { fg, dim, accent, hand, hsec }` (all CSS color strings). Null/non-finite `tempC` → a fixed neutral grey palette.

- [ ] **Step 1: Create the root `package.json`** so Node treats `.js` as ESM.

```json
{
  "name": "clock-pwa",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/feelcolor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherColor } from '../js/feelcolor.js';

const hue = (c) => Number(/hsl\((\d+)/.exec(c.fg)[1]);
const sat = (c) => Number(/hsl\(\d+,\s*(\d+)%/.exec(c.fg)[1]);

test('null temp returns the neutral palette', () => {
  const p = weatherColor(null, 50);
  assert.equal(p.fg, '#e6e6e6');
});

test('hot has a warmer (lower) hue than cold', () => {
  assert.ok(hue(weatherColor(35, 40)) < hue(weatherColor(-10, 40)));
});

test('freezing clamps to an icy blue hue (~200)', () => {
  const h = hue(weatherColor(-20, 40));
  assert.ok(h >= 195 && h <= 215, `hue was ${h}`);
});

test('high humidity desaturates vs dry air at the same temp', () => {
  assert.ok(sat(weatherColor(25, 85)) < sat(weatherColor(25, 25)));
});

test('always returns all five palette keys as truthy strings', () => {
  const p = weatherColor(20, 50);
  for (const k of ['fg', 'dim', 'accent', 'hand', 'hsec']) assert.ok(p[k], `missing ${k}`);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/feelcolor.test.js`
Expected: FAIL — `Cannot find module '../js/feelcolor.js'`.

- [ ] **Step 4: Write the implementation**

`js/feelcolor.js`:

```js
// feelcolor.js — map temperature + humidity to a readable digit palette.
// Pure, no DOM, no deps. Used for the primary clock AND the second-clock badge.

// Temperature (°C) -> base hue stops. Hue is interpolated linearly between
// adjacent stops and clamped past the ends. Lower hue = warmer (red/orange).
const TEMP_STOPS = [
  [-5, 200],  // winter  — icy cyan-blue
  [ 5, 210],  // cold    — blue
  [14, 180],  // cool    — teal
  [21, 140],  // mild    — green
  [27,  45],  // warm    — amber
  [33,  12],  // hot     — orange-red
];

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

function hueForTemp(tempC){
  const s = TEMP_STOPS;
  if (tempC <= s[0][0]) return s[0][1];
  if (tempC >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++){
    const [t0, h0] = s[i], [t1, h1] = s[i + 1];
    if (tempC >= t0 && tempC <= t1) return lerp(h0, h1, (tempC - t0) / (t1 - t0));
  }
  return s[s.length - 1][1];
}

function hsl(h, sPct, lPct){
  return `hsl(${Math.round(h)}, ${Math.round(sPct * 100)}%, ${Math.round(lPct * 100)}%)`;
}

const NEUTRAL = { fg:'#e6e6e6', dim:'#9aa0a6', accent:'#cfd3d8', hand:'#e6e6e6', hsec:'#ff7a5f' };

// weatherColor(tempC, rh) -> { fg, dim, accent, hand, hsec }
export function weatherColor(tempC, rh){
  if (tempC == null || !Number.isFinite(tempC)) return Object.assign({}, NEUTRAL);
  let hue = hueForTemp(tempC);
  const h = (rh != null && Number.isFinite(rh)) ? clamp(rh, 0, 100) : 50;
  // Humidity: dry -> crisp/saturated; humid -> desaturated + a muggy green pull
  // (only meaningful for warm/hot temps). humidT: 0 at 20% RH, 1 at 90% RH.
  const humidT = clamp((h - 20) / 70, 0, 1);
  const sat = lerp(0.90, 0.55, humidT);
  if (tempC > 18) hue = lerp(hue, 130, humidT * 0.5);
  const light = lerp(0.80, 0.74, humidT);
  const fg = hsl(hue, sat, light);
  const dim = hsl(hue, sat * 0.7, light * 0.62);
  const accent = hsl(hue, sat, Math.min(0.88, light + 0.06));
  const hsec = hsl((hue + 180) % 360, Math.min(0.9, sat + 0.15), 0.66);
  return { fg, dim, accent, hand: fg, hsec };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/feelcolor.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json js/feelcolor.js test/feelcolor.test.js
git commit -m "feat: weatherColor() temp+humidity palette + node test harness"
```

---

### Task 2: Add relative humidity to weather data

**Files:**
- Modify: `js/weather.js` (`getWeather` query, `normalizeForecast`)
- Modify: `docker-entrypoint.d/40-weather-fetch.sh` (server fetch URL)
- Test: `test/weather-normalize.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: normalized weather objects now carry `rh: number|null` (relative humidity %). `getServerWeather` inherits it (same `normalizeForecast`).

- [ ] **Step 1: Write the failing test** (extract `normalizeForecast` so it's importable)

`test/weather-normalize.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForecast } from '../js/weather.js';

test('normalizeForecast surfaces relative_humidity_2m as rh', () => {
  const j = { current: { temperature_2m: 22, relative_humidity_2m: 64, weather_code: 1 }, daily: {} };
  const out = normalizeForecast(j, { city: 'X' });
  assert.equal(out.rh, 64);
});

test('normalizeForecast tolerates a missing humidity field', () => {
  const out = normalizeForecast({ current: { temperature_2m: 10 }, daily: {} }, {});
  assert.equal(out.rh, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/weather-normalize.test.js`
Expected: FAIL — `normalizeForecast` is not exported (`undefined is not a function`).

- [ ] **Step 3: Export `normalizeForecast` and add `rh`**

In `js/weather.js`, change the declaration from `function normalizeForecast(j, loc){` to `export function normalizeForecast(j, loc){`, and add the humidity field inside the returned object (next to `code`):

```js
    code: cur.weather_code,
    rh: cur.relative_humidity_2m,
```

In `getWeather`, add `relative_humidity_2m` to the `current=` list:

```js
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code`
```

- [ ] **Step 4: Update the server fetcher**

In `docker-entrypoint.d/40-weather-fetch.sh`, change the `current=` segment of `URL` to include humidity:

```sh
current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&
```

(i.e. the full param becomes `...&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code&daily=...`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/weather-normalize.test.js`
Expected: PASS — 2 tests passing.

- [ ] **Step 6: Commit**

```bash
git add js/weather.js docker-entrypoint.d/40-weather-fetch.sh test/weather-normalize.test.js
git commit -m "feat: include relative humidity in client + server weather fetch"
```

---

### Task 3: Drive primary digit colors from temp+humidity

**Files:**
- Modify: `js/app.js` (`applyTint`, its call sites, imports)

**Interfaces:**
- Consumes: `weatherColor` from `./feelcolor.js`; weather objects with `tempC`/`rh`.
- Produces: `applyTint(w)` now takes a **weather object** (was a WMO code).

- [ ] **Step 1: Manual baseline check (verify current behavior)**

Serve locally and observe today's behavior so the change is comparable:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/?debug=1`. With internet + `Display: Dynamic`, note the digit color reflects the *condition* group. This is the "before".

- [ ] **Step 2: Add the import**

At the top of `js/app.js`, add:

```js
import { weatherColor } from './feelcolor.js';
```

Remove `paletteForCode` from the existing `weatherfx.js` import (it becomes unused):

```js
import { WeatherFX } from './weatherfx.js';
```

- [ ] **Step 3: Rewrite `applyTint` to take a weather object**

Replace the `applyTint` function body:

```js
function applyTint(w){
  if (!w) return;
  const p = weatherColor(w.tempC, w.rh);
  const r = document.documentElement;
  r.style.setProperty('--fg', p.fg);
  r.style.setProperty('--fg-dim', p.dim);
  r.style.setProperty('--accent', p.accent);
  r.style.setProperty('--hand', p.hand);
  r.style.setProperty('--hand-sec', p.hsec);
}
```

- [ ] **Step 4: Update all `applyTint` call sites** (pass the weather object, not a code)

- In `applyDisplay`: `applyTint(app.lastWeather.code)` → `applyTint(app.lastWeather)`
- In `refreshWeather`: `applyTint(w.code)` → `applyTint(w)`
- In `applyDim`: `applyTint(app.lastWeather.code)` → `applyTint(app.lastWeather)`
- In `boot` (cached branch): `applyTint(cached.code)` → `applyTint(cached)`

Leave every `app.fx.setCondition(...code)` call unchanged — the backdrop stays condition-driven.

- [ ] **Step 5: Manual verify**

Reload `http://localhost:8080/?debug=1`. With `Display: Dynamic`:
- Digits/hands now reflect temperature (warm city → amber/orange, cold → blue).
- The animated backdrop still matches the *condition* (rain particles when raining, etc.).
- Switch `Display: Plain` → digits return to neutral.
- Toggle `Dim` → tint clears while dimmed, as before.
- Confirm the clock keeps ticking if you go offline (DevTools → Network → Offline).

- [ ] **Step 6: Commit**

```bash
git add js/app.js
git commit -m "feat: primary clock digits colored by temperature + humidity"
```

---

### Task 4: Second-location weather fetch + zone coordinates

**Files:**
- Modify: `js/weather.js` (add `getZoneWeather`)
- Modify: `js/app.js` (`SECOND_ZONES` coords, `refreshSecondWeather`, wiring)

**Interfaces:**
- Consumes: `getWeather` / `normalizeForecast`.
- Produces: `getZoneWeather(zone) -> Promise<weather|null>` where `zone` is a `SECOND_ZONES` entry with `lat`/`lon`; caches per-zone under `clockpwa.weather2.<id>`. `app.secondWeather` holds the latest (or null).

- [ ] **Step 1: Add per-zone coordinates** in `js/app.js` `SECOND_ZONES`

Replace the `SECOND_ZONES` array with (UTC has no weather location, so no coords):

```js
const SECOND_ZONES = [
  { id:'off',    label:'Off' },
  { id:'utc',    label:'UTC',          tz:'UTC' },
  { id:'nyc',    label:'New York',     tz:'America/New_York',   lat:40.7128, lon:-74.0060, city:'New York' },
  { id:'chi',    label:'Chicago',      tz:'America/Chicago',    lat:41.8781, lon:-87.6298, city:'Chicago' },
  { id:'la',     label:'Los Angeles',  tz:'America/Los_Angeles',lat:34.0522, lon:-118.2437, city:'Los Angeles' },
  { id:'london', label:'London',       tz:'Europe/London',      lat:51.5074, lon:-0.1278, city:'London' },
  { id:'paris',  label:'Paris',        tz:'Europe/Paris',       lat:48.8566, lon:2.3522, city:'Paris' },
  { id:'india',  label:'India',        tz:'Asia/Kolkata',       lat:28.6139, lon:77.2090, city:'New Delhi' },
  { id:'tokyo',  label:'Tokyo',        tz:'Asia/Tokyo',         lat:35.6762, lon:139.6503, city:'Tokyo' },
  { id:'sydney', label:'Sydney',       tz:'Australia/Sydney',   lat:-33.8688, lon:151.2093, city:'Sydney' },
];
```

- [ ] **Step 2: Add `getZoneWeather` to `js/weather.js`**

Append:

```js
// Weather for a SECOND/secondary location (direct Open-Meteo; needs device internet).
// Cached per-zone so the badge keeps its color offline. Never throws.
export async function getZoneWeather(zone){
  if (!zone || !Number.isFinite(zone.lat) || !Number.isFinite(zone.lon)) return null;
  const key = 'clockpwa.weather2.' + zone.id;
  const loc = { lat:zone.lat, lon:zone.lon, city:zone.city || zone.label };
  const url = `${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code`
    + `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset`
    + `&temperature_unit=celsius&timezone=auto&forecast_days=1`;
  try {
    const data = normalizeForecast(await fetchJSON(url), loc);
    safeLSSet(key, JSON.stringify(data));
    return data;
  } catch (_) {
    const raw = safeLSGet(key);
    if (raw){ try { return Object.assign(JSON.parse(raw), { stale:true }); } catch(__){} }
    return null;
  }
}
```

- [ ] **Step 3: Add `refreshSecondWeather` + wiring in `js/app.js`**

Import `getZoneWeather` (add to the existing `./weather.js` import line).

Add the function near `updateSecondClock`:

```js
// Fetch weather for the active second zone (own-location color for the badge).
async function refreshSecondWeather(){
  try {
    const z = SECOND_ZONES.find(x => x.id === app.settings.secondTz);
    if (!z || !Number.isFinite(z.lat)){ app.secondWeather = null; updateSecondClock(); return; }
    const w = await getZoneWeather(z);
    app.secondWeather = w || null;
    updateSecondClock();
  } catch(_) { app.secondWeather = null; }
}
```

Call `refreshSecondWeather()` from the `setSecond` click handler (after `updateSecondClock()`):

```js
    persist(); updateSecondClock(); refreshSecondWeather(); syncButtons();
```

In `boot`, after the secondary-clock setup line, kick a fetch and fold it into the 15-min weather refresh. Change the weather interval line:

```js
  app.weatherTimer = setInterval(() => { refreshWeather(); refreshSecondWeather(); }, 15*60*1000);
```

and add an initial call right after `updateSecondClock();` in boot:

```js
  refreshSecondWeather();
```

- [ ] **Step 4: Manual verify (no color yet — that's Task 5)**

Reload, open Settings, cycle `Second` to **India**. In DevTools → Application → Local Storage, confirm a `clockpwa.weather2.india` entry appears after a moment, and `app.secondWeather` (via `window.__app.secondWeather` with `?debug=1`) has a `tempC`/`rh`.

- [ ] **Step 5: Commit**

```bash
git add js/weather.js js/app.js
git commit -m "feat: fetch + cache weather for the secondary clock's own city"
```

---

### Task 5: Second clock as a colored corner badge

**Files:**
- Modify: `index.html` (badge markup — add temp chip)
- Modify: `css/styles.css` (corner-card layout + `--sfg`)
- Modify: `js/app.js` (`updateSecondClock` sets color + temp)

**Interfaces:**
- Consumes: `app.secondWeather`, `weatherColor`, `bothTemps`.
- Produces: badge digits colored by the second city's weather; a `#secondTemp` chip.

- [ ] **Step 1: Add the temp-chip element** to `index.html`

Replace the `#secondClock` block (around line 61) with:

```html
    <div class="second-clock" id="secondClock" hidden aria-label="Secondary clock">
      <span class="sc-time" id="secondTime"></span>
      <span class="sc-meta">
        <span class="sc-label" id="secondLabel"></span>
        <span class="sc-day" id="secondDay"></span>
      </span>
      <span class="sc-temp" id="secondTemp" hidden></span>
    </div>
```

- [ ] **Step 2: Style the corner card** in `css/styles.css`

Find the existing `.second-clock` rules. Replace them (keep any existing positioning vars consistent with the chrome) with a corner card:

```css
.second-clock{
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 14px);
  right: calc(env(safe-area-inset-right, 0px) + 14px);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(4px);
  z-index: 5;
  pointer-events: none;
}
.second-clock[hidden]{ display: none; }
.second-clock .sc-time{
  font-size: clamp(18px, 4vw, 30px);
  font-weight: 600;
  line-height: 1;
  color: var(--sfg, var(--fg, #e6e6e6));   /* own-weather color */
}
.second-clock .sc-meta{ display: flex; gap: 6px; align-items: baseline; }
.second-clock .sc-label{ font-size: 11px; letter-spacing: .08em; opacity: .75; }
.second-clock .sc-day{ font-size: 11px; opacity: .55; }
.second-clock .sc-temp{
  font-size: 12px;
  opacity: .8;
  color: var(--sfg, var(--fg, #e6e6e6));
}
```

- [ ] **Step 3: Set color + temp in `updateSecondClock`** (`js/app.js`)

At the end of the `try` block in `updateSecondClock` (after `$('secondDay').textContent = dayHint;`), add:

```js
    // Own-weather color for the badge digits + a tiny temp chip (Dynamic only).
    const tempEl = $('secondTemp');
    const w2 = app.secondWeather;
    if (isDynamic() && w2 && Number.isFinite(w2.tempC) && !app.deepDim){
      const p = weatherColor(w2.tempC, w2.rh);
      el.style.setProperty('--sfg', p.fg);
      if (tempEl){ tempEl.hidden = false; tempEl.textContent = bothTemps(w2.tempC).f + '°'; }
    } else {
      el.style.removeProperty('--sfg');
      if (tempEl){ tempEl.hidden = true; tempEl.textContent = ''; }
    }
```

- [ ] **Step 4: Manual verify**

Reload, set `Second: India`, `Display: Dynamic`. Confirm:
- The badge sits in the top-right corner as a small card.
- Its time digits are colored by **New Delhi's** temperature (independent of the primary clock's color — pick a primary city with very different weather to see the contrast).
- A small temp chip (e.g. `34°`) shows.
- `Display: Plain` or `Dim` → badge color goes neutral, temp hides.
- `Second: Off` → badge hidden.
- `Second: UTC` → badge shows time only, neutral (no coords → no weather), no crash.

- [ ] **Step 5: Commit**

```bash
git add index.html css/styles.css js/app.js
git commit -m "feat: second clock as a corner badge colored by its own city weather"
```

---

### Task 6: Unified `source` setting + single Source button

**Files:**
- Create: `js/source.js` (pure mapping helpers)
- Test: `test/source.test.js`
- Modify: `js/settings.js` (`source` default, URL param, persist)
- Modify: `index.html` (replace Location+Time rows with one Source row)
- Modify: `js/app.js` (apply source → time+location; wire button)

**Interfaces:**
- Produces: `sourceToModes(source) -> { timeSource, locationMode }`; `resolveServerSource(file, userSet) -> { source, locked } | null`.

- [ ] **Step 1: Write the failing test**

`test/source.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceToModes, resolveServerSource } from '../js/source.js';

test('server maps to host time + server location', () => {
  assert.deepEqual(sourceToModes('server'), { timeSource:'server', locationMode:'server' });
});

test('local maps to device time + custom location', () => {
  assert.deepEqual(sourceToModes('local'), { timeSource:'device', locationMode:'custom' });
});

test('forced server push locks the client', () => {
  assert.deepEqual(resolveServerSource({ mode:'server', force:true }, true), { source:'server', locked:true });
});

test('default push applies only when the user has not chosen', () => {
  assert.deepEqual(resolveServerSource({ mode:'local', force:false }, false), { source:'local', locked:false });
  assert.equal(resolveServerSource({ mode:'local', force:false }, true), null);
});

test('absent or malformed file means no server opinion', () => {
  assert.equal(resolveServerSource(null, false), null);
  assert.equal(resolveServerSource({ mode:'bogus' }, false), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/source.test.js`
Expected: FAIL — `Cannot find module '../js/source.js'`.

- [ ] **Step 3: Write `js/source.js`**

```js
// source.js — pure helpers for the unified time+weather "Source" switch.

// A client Source value maps to the two underlying modes.
export function sourceToModes(source){
  return source === 'local'
    ? { timeSource:'device', locationMode:'custom' }
    : { timeSource:'server', locationMode:'server' };
}

// Decide whether an admin-pushed source.json should change the client.
// file: parsed { mode, force } | null.  userSet: has the user manually chosen?
// Returns { source, locked } to apply, or null for "no change".
export function resolveServerSource(file, userSet){
  if (!file || (file.mode !== 'server' && file.mode !== 'local')) return null;
  if (file.force) return { source:file.mode, locked:true };
  if (!userSet) return { source:file.mode, locked:false };
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/source.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Add `source` to settings** (`js/settings.js`)

In `DEFAULTS`, add (default **server** per spec):

```js
  source: 'server',     // unified time+weather authority: 'server' | 'local'
```

In `readURL`, add a `source` param:

```js
    const src = (q.get('source') || '').toLowerCase();
    if (src === 'server' || src === 'local') out.source = src;
```

In `saveSettings`'s `out` object, add `source: s.source,`.

- [ ] **Step 6: Replace the Location + Time rows** in `index.html` (lines 122–129)

```html
      <div class="row">
        <span class="row-label">Source</span>
        <button class="ctrl" id="setSource" type="button" data-nav>Server</button>
      </div>
      <div class="row" id="sourceManagedRow" hidden>
        <span class="row-label"></span>
        <span class="row-note" id="sourceManaged">Managed by server</span>
      </div>
```

(The underlying `timeSource`/`locationMode` settings remain; they're now driven by `source`.)

- [ ] **Step 7: Apply source + wire the button** (`js/app.js`)

Import the helpers (top of file):

```js
import { sourceToModes, resolveServerSource } from './source.js';
```

Add an apply function near `applyTimeSource`:

```js
// Apply the unified Source: set both underlying modes, then re-run their effects.
function applySource(){
  const { timeSource, locationMode } = sourceToModes(app.settings.source);
  app.settings.timeSource = timeSource;
  app.settings.locationMode = locationMode;
  applyTimeSource();
  refreshWeather();
}
```

In `syncButtons`, replace the `setTime` / `setLocMode` lines with:

```js
  $('setSource').textContent = s.source === 'local' ? 'Local' : 'Server';
  $('setSource').disabled = !!app._sourceLocked;
```

Remove the now-dead `$('setLocMode')` and `$('setTime')` label lines from `syncButtons`.

In `wireControls`, remove the `setLocMode` and `setTime` handlers and add:

```js
  $('setSource').addEventListener('click', () => {
    if (app._sourceLocked) return;
    app.settings.source = app.settings.source === 'server' ? 'local' : 'server';
    app._sourceUserSet = true;
    applySource(); persist(); syncButtons();
  });
```

In `boot`, after `app.settings = loadSettings();` succeeds, initialize the underlying modes from source once:

```js
  try { const m = sourceToModes(app.settings.source); app.settings.timeSource = m.timeSource; app.settings.locationMode = m.locationMode; } catch(_){}
```

Initialize the transient flags on the `app` object literal: add `_sourceUserSet:false,` and `_sourceLocked:false,`.

- [ ] **Step 8: Manual verify**

Reload. In Settings:
- One **Source** row (Server/Local); the separate Location/Time rows are gone.
- `Source: Server` → device shows host time and server location/weather.
- `Source: Local` → device clock + your custom location (set via the ZIP/city box).
- `?source=local` in the URL starts in Local.

- [ ] **Step 9: Commit**

```bash
git add js/source.js test/source.test.js js/settings.js index.html js/app.js
git commit -m "feat: unified Source switch (server vs local) driving time + weather"
```

---

### Task 7: `source.json` server file, polling, and managed lock

**Files:**
- Modify: `nginx.conf` (add `source.json` location)
- Modify: `sw.js` (cache bump + network-first)
- Modify: `js/app.js` (poll `source.json`, apply via `resolveServerSource`)

**Interfaces:**
- Consumes: `resolveServerSource`, `applySource`.
- Produces: `pollSource()`; sets `app._sourceLocked`.

- [ ] **Step 1: Add the nginx location** (copy the `announce.json` block) in `nginx.conf`, after the `profiles.json` block:

```nginx
  # Admin-managed time/weather Source authority. Written via WebDAV PUT from the
  # admin page (auth-gated); polled by every device, must be fresh.
  location = /source.json {
    root /data;
    default_type application/json;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    expires off;
    dav_methods PUT;
    create_full_put_path on;
    client_body_temp_path /data/tmp;
    limit_except GET {
      auth_basic "Admin";
      auth_basic_user_file /etc/nginx/admin.htpasswd;
    }
  }
```

(Match the exact auth directives used by the existing `announce.json` block in this file — copy them verbatim so auth is identical.)

- [ ] **Step 2: Bump the SW cache + add network-first** in `sw.js`

Change both version constants `v15` → `v16`:

```js
const SHELL = 'clockpwa-shell-v16';
const RUNTIME = 'clockpwa-runtime-v16';
```

Add `'./js/feelcolor.js'` and `'./js/source.js'` to `SHELL_FILES`.

Add `/source.json` to the network-first path test:

```js
  if (url.pathname === '/config.json' || url.pathname === '/weather.json'
      || url.pathname === '/announce.json' || url.pathname === '/profiles.json'
      || url.pathname === '/source.json'
      || url.hostname.endsWith('zippopotam.us')){
```

- [ ] **Step 3: Add `pollSource` in `js/app.js`**

```js
// Poll the admin-managed Source authority (network-first). Applies force/default.
async function pollSource(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('source.json?ts=' + Date.now(), { cache:'no-store' });
    let file = null;
    if (r.ok){ try { file = await r.json(); } catch(_){ file = null; } }
    const decision = resolveServerSource(file, app._sourceUserSet);
    const wasLocked = app._sourceLocked;
    app._sourceLocked = !!(decision && decision.locked);
    const row = $('sourceManagedRow'); if (row) row.hidden = !app._sourceLocked;
    if (decision && app.settings.source !== decision.source){
      app.settings.source = decision.source;
      applySource(); persist();
    }
    if (app._sourceLocked !== wasLocked || decision) syncButtons();
  } catch(_) { /* offline — keep current */ }
}
```

- [ ] **Step 4: Wire polling into the existing announce/profiles loop** in `boot`

Where `pollAnnounce(); pollProfiles();` are called (initial call, the `setInterval`, and the `visibilitychange` handler), add `pollSource();` alongside each:

```js
    pollAnnounce(); pollProfiles(); pollSource();
    app.announceTimer = setInterval(() => { pollAnnounce(); pollProfiles(); pollSource(); }, ANNOUNCE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden){ pollAnnounce(); pollProfiles(); pollSource(); } });
```

- [ ] **Step 5: Add the managed-note style** in `css/styles.css`

```css
.row-note{ font-size: 12px; opacity: .6; font-style: italic; }
.ctrl:disabled{ opacity: .5; cursor: not-allowed; }
```

- [ ] **Step 6: Manual verify** (against a running container, or by placing a `source.json` next to the page when serving statically)

Create `source.json` = `{"mode":"local","force":true}` served at the origin root. Reload:
- Device switches to Local, the **Source** button is greyed/disabled, and "Managed by server" shows.
- Change to `{"mode":"server","force":false}` and clear the device's localStorage (simulating a fresh client) → it adopts Server; on a client that already toggled manually, it does not override.
- Remove the file (`{}` or 404) → button re-enables, note hides.
- The clock never blanks throughout.

- [ ] **Step 7: Commit**

```bash
git add nginx.conf sw.js js/app.js css/styles.css
git commit -m "feat: admin-managed source.json with force/default and client lock"
```

---

### Task 8: Admin UI for the Source authority

**Files:**
- Modify: `admin.html` (new Source section + handlers)

**Interfaces:**
- Consumes: the same auth + `fetch PUT` pattern used for `profiles.json`.
- Produces: writes/clears `source.json`.

- [ ] **Step 1: Add the Source section markup** in `admin.html`

Place it near the profiles section (match the surrounding card/section markup the file already uses):

```html
    <section class="card">
      <h2>Time &amp; Weather Source</h2>
      <p class="hint">Dictate where devices get time and weather. Force locks the device toggle.</p>
      <div class="row">
        <label><input type="radio" name="srcMode" value="server" checked> Server (host clock + server weather)</label>
        <label><input type="radio" name="srcMode" value="local"> Local (device clock + its own location)</label>
      </div>
      <label class="row"><input type="checkbox" id="srcForce"> Force (lock the device toggle)</label>
      <div class="row">
        <button id="srcSave" type="button">Save</button>
        <button id="srcClear" type="button">Clear (no server opinion)</button>
      </div>
      <div class="status" id="srcStatus" aria-live="polite"></div>
    </section>
```

- [ ] **Step 2: Add the handlers** in `admin.html`'s script (reuse `$`, `setStatus`-style helper)

```js
    function setSrcStatus(msg, ok){ var s=$('srcStatus'); s.textContent=msg; s.className='status '+(ok===true?'ok':ok===false?'err':''); }
    function srcMode(){ var r=document.querySelector('input[name=srcMode]:checked'); return r?r.value:'server'; }

    function putSource(body){
      return fetch('source.json', {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
    }

    function loadSource(){
      fetch('source.json?ts=' + Date.now(), { cache:'no-store' }).then(function(r){
        return r.ok ? r.json() : {};
      }).then(function(j){
        if (j && (j.mode === 'server' || j.mode === 'local')){
          var radio = document.querySelector('input[name=srcMode][value="'+j.mode+'"]');
          if (radio) radio.checked = true;
          $('srcForce').checked = !!j.force;
        }
      }).catch(function(){});
    }

    $('srcSave').addEventListener('click', function(){
      var body = { mode: srcMode(), force: $('srcForce').checked };
      setSrcStatus('Saving…');
      putSource(body).then(function(r){
        setSrcStatus(r.ok ? 'Saved.' : 'Failed (HTTP '+r.status+').', r.ok);
      }).catch(function(e){ setSrcStatus('Failed: '+e, false); });
    });

    $('srcClear').addEventListener('click', function(){
      setSrcStatus('Clearing…');
      putSource({}).then(function(r){
        setSrcStatus(r.ok ? 'Cleared — devices choose for themselves.' : 'Failed (HTTP '+r.status+').', r.ok);
      }).catch(function(e){ setSrcStatus('Failed: '+e, false); });
    });

    loadSource();
```

- [ ] **Step 3: Manual verify**

Open `admin.html` (authenticate). Pick `Local` + check `Force`, Save → confirm `source.json` is written (a device should lock to Local per Task 7). Clear → device toggle re-enables. Reloading admin reflects the saved value via `loadSource()`.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat: admin UI to set/clear the time+weather Source authority"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the three features** in `README.md`

Add a section covering:
- **Source (Server vs Local):** one switch sets both time and weather authority; admin can set a default or **force** it via the admin page (`source.json`).
- **Weather-feel colors:** clock digits are tinted by temperature + humidity (winter blue → hot red; humid air desaturates). Gated by `Display: Dynamic`; the animated backdrop still reflects sky conditions.
- **Second clock:** pick a city under `Second`; it shows as a corner badge with its own time and is colored by **that city's** weather, plus a small temperature chip.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Source switch, weather-feel colors, second-clock badge"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (temp+humidity digit color) → Tasks 1, 2, 3. ✓
- Backdrop stays condition-based → Task 3 Step 4 (call sites unchanged). ✓
- Humidity in client + server data → Task 2. ✓
- Component 2 (corner badge, own-location weather, color + tiny temp) → Tasks 4, 5. ✓
- Component 3 (unified Source, default server) → Task 6. ✓
- `source.json` + force/default + managed lock → Task 7. ✓
- Admin UI → Task 8. ✓
- SW cache bump + network-first → Task 7 Step 2. ✓
- README → Task 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `weatherColor(tempC, rh)` used identically in Tasks 3 and 5. `normalizeForecast` exported (Task 2) and reused in `getZoneWeather` (Task 4). `sourceToModes`/`resolveServerSource` defined in Task 6, consumed in Task 7. `applySource` defined in Task 6, called in Task 7. `app._sourceUserSet`/`app._sourceLocked` initialized in Task 6, read in Tasks 6/7. ✓
