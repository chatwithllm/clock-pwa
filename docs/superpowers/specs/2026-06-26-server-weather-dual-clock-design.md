# Server-Driven Time/Weather + Dual Clock + Weather-Feel Colors

**Date:** 2026-06-26
**Status:** Approved (design)

## Summary

Three cohesive additions to the clock PWA, all about making the display reflect
the *environment* the server dictates:

1. **Weather-feel digit color** — clock digits/hands tinted by temperature +
   humidity, so a glance tells you how it feels outside.
2. **Second clock as a corner badge** — a small secondary clock (e.g. New Delhi)
   colored by *its own* location's weather.
3. **Unified Source switch + admin push** — one client switch for "server
   dictates time + weather", plus an admin-managed default/forced value.

Much of the plumbing already exists (`timeSource`, `locationMode`, `secondTz`,
condition-based tint). This spec extends those rather than rebuilding.

## Existing behavior (do not break)

- `js/clock.js` — `setClockOffset` lets server time drive every display.
- `js/app.js` — `timeSource` (device/server), `locationMode` (server/custom),
  `secondTz` (tiny label+time in the chrome band), `applyTint(code)` (condition
  palette on `--fg/--hand/...`), `WeatherFX` animated backdrop.
- `js/weatherfx.js` — `paletteForCode` / `fxForCode` group a WMO code to a
  condition palette; this still drives the **backdrop animation**.
- Server files: `config.json` (boot-generated from env, **read-only**),
  `weather.json` (written by entrypoint 40), `announce.json` + `profiles.json`
  (admin-written via auth-gated WebDAV PUT under `/data`).

The clock must never depend on weather/network — every new entry point stays
wrapped so a failure degrades to neutral color / hidden badge, never a blank or
frozen clock.

---

## Component 1 — Weather-feel digit color (temp + humidity)

### Color function

A pure, dependency-free function in a new `js/feelcolor.js`:

```js
// weatherColor(tempC, rh) -> { fg, dim, accent, hand, hsec }
// tempC: number|null (Celsius). rh: number|null (relative humidity %).
// Returns a readable palette for near-black background. Null temp -> neutral.
```

**Temperature → base hue** via smooth piecewise interpolation over stops (no hard
band edges, so transitions never jump):

| Temp (°C) | Feel    | Hue (HSL) |
|-----------|---------|-----------|
| ≤ -5      | winter  | ~200 (icy cyan-blue) |
| 5         | cold    | ~210 (blue) |
| 14        | cool    | ~180 (teal) |
| 21        | mild    | ~140 (green) |
| 27        | warm    | ~45 (amber) |
| ≥ 33      | hot     | ~12 (orange-red) |

Clamp below the first / above the last stop. Interpolate hue linearly between
adjacent stops by temperature.

**Humidity → modifier** on the temp-derived hue:

- Saturation: dry (low RH) → crisp/saturated; humid (high RH) → desaturated.
  `sat = lerp(RH: 20%→90%, 0.90→0.55)`, clamped.
- Muggy hue pull: high RH nudges the hue toward green (~130) by up to ~12°,
  scaled by RH above ~60% — only meaningful for warm/hot temps.
- Lightness pinned around `0.78` (legible on near-black); humid drops it slightly.

Derive the palette from the resulting HSL:

- `fg`   = main color (digits).
- `dim`  = same hue, lower lightness (secondary text).
- `hand` = `fg`.
- `accent` = same hue, slightly brighter.
- `hsec` = warm complementary accent (second hand / AM-PM).

Null/non-finite temp → return a neutral grey palette (no crash, no false signal).

### Wiring

- `applyTint()` in `app.js` switches its source from `paletteForCode(code)` to
  `weatherColor(w.tempC, w.rh)`. It still sets the same `--fg/--fg-dim/--accent/
  --hand/--hand-sec` custom properties, so all renderers (classic flip, block
  matrix, analog) pick it up unchanged.
- **Backdrop animation stays condition-based**: `WeatherFX.setCondition(code)`
  and `fxForCode` are untouched. Sky shows the weather; digits show the feel.
- Gated by the existing **Display: Dynamic** setting. Plain → `clearTint()`
  (neutral), as today. Deep-dim → tint cleared, as today.

### Data: humidity

Add `relative_humidity_2m` to the `current=` list and surface it as `rh`:

- `js/weather.js` `getWeather()` query string.
- `js/weather.js` `normalizeForecast()` → `rh: cur.relative_humidity_2m`.
- Server weather fetcher `docker-entrypoint.d/40-weather-fetch.sh` → include
  `relative_humidity_2m` in the `current=` params it requests, so server-pushed
  `weather.json` carries it for LAN devices.

`getServerWeather()` reuses `normalizeForecast`, so it picks `rh` up for free.

---

## Component 2 — Second clock as corner badge

### Zone data

Extend `SECOND_ZONES` in `app.js` so each non-`off` entry carries `lat`, `lon`,
`city` alongside `tz`. (Coordinates for the curated cities are static constants.)

### Second-location weather

New small fetch path (in `weather.js`, reusing `getWeather`/`normalizeForecast`):

- Fetch weather for the active second zone's `lat`/`lon` (direct Open-Meteo only;
  LAN-offline devices simply get no second-clock color → neutral).
- Cache per-zone in localStorage under a distinct key (`clockpwa.weather2.<id>`).
- Refresh on zone change and on the existing 15-min weather interval.
- Fully wrapped: any failure → badge shows time only, neutral color.

### Badge UI

Restyle the existing `#secondClock` element into the **corner card** layout:

```
+------------------------+
|              +-------+ |
|              |9:45 PM| |   <- secondary time, digits colored by Delhi weather
|     1 2:4 5  |DELHI  | |   <- city label + day hint (+1d/-1d)
|     Mon Jun  | 34°   | |   <- tiny temp chip (°F primary)
+------------------------+
```

- Position: top/side corner card; does not disturb the primary clock layout.
- Content: secondary time (`Intl.DateTimeFormat` in the zone, as today), city
  label, day-offset hint (`+1d`/`−1d`, already computed), and a **tiny temp**
  chip (`34°`, °F primary — matches the rest of the app).
- Digit color: a scoped CSS variable on the badge (e.g. `--sfg`) set from
  `weatherColor(w2.tempC, w2.rh).fg`. Only applied when Display: Dynamic; plain
  or missing weather → neutral.
- Feature-detected and hidden on `secondTz === 'off'` or unsupported `Intl`, as
  today. Updates every second (existing `app.secondTimer`).

---

## Component 3 — Unified Source switch + admin push

### Client setting

- New setting `source: 'server' | 'local'`, **default `server`** (the feature is
  about server authority; note this flips the prior default Time from device to
  server).
- A single panel button **"Source: Server/Local"** replaces the two existing
  buttons (`setTime`, `setLocMode`). Switching sets *both* `timeSource` and
  `locationMode` to match (`server` → both server; `local` → device time +
  custom location).
- Per-key URL params (`?time=`, `?loc=`) still override individually for power
  users; `?source=server|local` added as a convenience that sets both.
- Track `_sourceUserSet` (transient) when the user toggles, so an admin *default*
  (non-forced) push won't stomp an explicit local choice.

### Admin-managed file

New served file **`source.json`** under `/data`, mirroring `announce.json`:

- nginx: copy the `announce.json` location block — `root /data`, open GET,
  auth-gated `dav_methods PUT`, `client_body_temp_path /data/tmp`, no-cache.
- Shape: `{ "mode": "server" | "local", "force": true | false }`. Absent / `404`
  / `{}` → no server opinion.

### Client polling

Poll `source.json` alongside `announce`/`profiles` (same interval + on refocus):

- `force: true` → set `source = mode`, apply (sets time + location), **disable**
  the local Source button (greyed) with a "Managed by server" note.
- `force: false` → apply `mode` only if `_sourceUserSet` is false (a default).
- On removal/`{}` → re-enable the local button; keep current value.

### Admin UI

New section in `admin.html` (reusing the existing PUT helper + auth):

- Server/Local picker + a **Force** checkbox.
- **Save** → PUT `source.json` with `{ mode, force }`.
- **Clear** → PUT `{}` (or DELETE) to drop the server opinion.

### Service worker

- Bump `sw.js` cache version.
- Add `source.json` to the **network-first** set (like `announce.json` /
  `profiles.json`) so it's always fresh and never stale-served.

---

## Non-goals (YAGNI)

- No per-zone custom city entry for the second clock (curated list only).
- No historical/forecast coloring — current conditions only.
- No new color settings UI (bands are fixed constants; tune in code).
- No change to the announcement/profile systems.

## Risks & mitigations

- **Default flip (Time device→server).** Documented; existing devices keep their
  stored settings, so only fresh installs see server-time by default.
- **Second-location fetch on LAN-only devices.** Degrades to neutral color +
  time-only badge; never blocks.
- **Two color systems (feel digits vs condition backdrop).** Intentional and
  separated by channel; verify they read well together for each condition.
- **Legibility across the hue range.** Lightness pinned; spot-check hot/cold/
  humid extremes on the near-black background and the block-matrix LEDs.

## Affected files

- `js/feelcolor.js` (new) — `weatherColor(tempC, rh)`.
- `js/weather.js` — humidity in query + normalize; second-location fetch.
- `js/app.js` — use `weatherColor` in `applyTint`; `SECOND_ZONES` coords;
  second-weather refresh; corner-badge render; `source` setting + unified
  button; `source.json` poll + managed lock.
- `js/settings.js` — `source` default + URL param; persist `source`.
- `css/styles.css` — corner badge card; `--sfg`; managed-note styling.
- `admin.html` — source section (picker + force + save/clear).
- `nginx.conf` — `source.json` location block.
- `docker-entrypoint.d/40-weather-fetch.sh` — request `relative_humidity_2m`.
- `sw.js` — cache bump + `source.json` network-first.
- `index.html` — corner-badge markup (temp chip), managed-note element.
- `README.md` — document the three features.
