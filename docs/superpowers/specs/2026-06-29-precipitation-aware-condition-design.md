# Precipitation-Aware Weather Condition

**Date:** 2026-06-29
**Status:** Approved (design)

## Summary

Open-Meteo's `weather_code` over-reports precipitation — it returns thunderstorm
(95) in hot/humid convective air even when its own `precipitation` is 0 mm and
`precipitation_probability` is ~0%. The display shows `weather_code` verbatim, so a
clear-but-muggy day reads "Thunderstorm" with a lightning backdrop. Fix: trust the
precipitation fields. When a precip code is reported but it's actually dry now and
unlikely soon, soften the icon, label, and animated backdrop to a calm "… possible"
state. Temperature/humidity digit color is unaffected.

## Root cause (verified, from debugging)

Live Open-Meteo for the configured location returned `weather_code: 95`,
`precipitation: 0.0` mm, next-hour `precipitation_probability: 0%`, temp 31 °C,
humidity 64%. The code contradicts the API's own precip fields. This is upstream
data behavior, not a clock bug, not stale cache, not the location — confirmed
across two coordinate sets in the same air mass.

## Constraints

- **The clock must never break.** New fetch fields + the correction are fully
  guarded; missing/garbage data degrades to today's raw-`weather_code` behavior.
- **Fail safe — never hide a real storm.** The dry-override fires ONLY with
  explicit evidence (`precip === 0` AND `precipProb < 30`). Any missing field →
  no override (show the raw condition).
- **Dependency-free** vanilla JS / Python-stdlib; no new deps.
- **Don't touch the weather-feel digit color** — it's temperature/humidity-driven,
  independent of condition.
- Works for both weather sources: direct Open-Meteo (`getWeather`) and
  server-pushed `weather.json` (`getServerWeather`), via the shared
  `normalizeForecast`.

## Component 1 — Fetch + normalize the precip fields

**`js/weather.js`**
- `getWeather` query: add `precipitation` to `current=` and
  `precipitation_probability` to a new `hourly=` parameter. With `timezone=auto`
  the hourly arrays align to local midnight, so the current hour's probability is
  at index = the hour parsed from `current.time`.
- `normalizeForecast(j, loc)` gains two fields:
  - `precip: cur.precipitation` (mm now; may be `undefined`).
  - `precipProb`: from `j.hourly.precipitation_probability` at the current-hour
    index, or `null` if absent. Computed defensively:
    ```js
    let precipProb = null;
    const hp = j.hourly && j.hourly.precipitation_probability;
    if (Array.isArray(hp) && cur.time){
      const h = parseInt(String(cur.time).slice(11, 13), 10);
      if (Number.isFinite(h) && h >= 0 && h < hp.length) precipProb = hp[h];
    }
    ```
- `getServerWeather` already reuses `normalizeForecast`, so it inherits both fields
  once the server pushes them.

**`docker-entrypoint.d/40-weather-fetch.sh`** — add `precipitation` to the
`current=` list and `hourly=precipitation_probability` to the fetch URL so
server-pushed `weather.json` carries them for LAN devices.

## Component 2 — `effectiveCondition` (pure, tested)

New exported pure function in `js/weather.js` (it already owns `wmoInfo`):

```
effectiveCondition(code, precip, precipProb) -> { code, icon, label, dry }
```

- **Precip-code families** (the set eligible for softening):
  drizzle `51..57`, rain `61..67`, rain showers `80..82`, snow `71..77` + `85,86`,
  thunderstorm `95,96,99`.
- **Dry-override condition:** `code` is in a precip family AND `precip === 0` AND
  `Number.isFinite(precipProb)` AND `precipProb < 30`.
  - Note `precip === 0` requires `precip` to be exactly `0` (a number). `undefined`
    / `null` precip → not dry → raw (fail safe).
- **When dry:** return
  - `dry: true`
  - `icon: '⛅'` (calm, signals "not active")
  - `label`: by family —
    drizzle → `'Drizzle possible'`, rain → `'Rain possible'`,
    showers → `'Showers possible'`, snow → `'Snow possible'`,
    thunderstorm → `'Storms possible'`
  - `code: 2` (partly cloudy) — so any downstream `fxForCode`/code-based logic
    yields a calm backdrop group (`clouds`).
- **Otherwise:** `dry: false`, and `icon`/`label` from the existing `wmoInfo(code)`,
  `code` unchanged.

This keeps the raw `wmoInfo` mapping intact and layers the correction on top.

## Component 3 — Wire into the display (`js/app.js`)

- `paintWeather(w)`: replace the `wmoInfo(w.code)` lookup feeding `wxIcon`/`wxCond`
  with `effectiveCondition(w.code, w.precip, w.precipProb)` → use its `icon`/`label`.
- Every `app.fx.setCondition(<...>.code)` call (in `refreshWeather`, `applyDisplay`,
  the boot cached branch) passes the **effective** code so the animated Dynamic
  backdrop calms to clouds when dry. Compute the effective condition once where the
  weather object is in hand and reuse its `code`.
- `applyTint(w)` / `weatherColor` are **unchanged** (temperature/humidity color).

## Testing

- **Node `--test`** for `effectiveCondition`:
  - thunderstorm `95`, `precip 0`, `prob 0` → `dry:true`, label `'Storms possible'`,
    icon `'⛅'`, `code 2`.
  - thunderstorm `95`, `precip 2`, `prob 0` → `dry:false`, raw label `'Thunderstorm'`
    (it's actually raining).
  - thunderstorm `95`, `precip 0`, `prob 60` → `dry:false` (brewing, likely soon).
  - rain `63`, `precip 0`, `prob 10` → `dry:true`, `'Rain possible'`.
  - clear `0` (not a precip code) → `dry:false`, raw.
  - missing precip (`undefined`/`null`) → `dry:false`, raw (fail safe).
- **Node `--test`** for `normalizeForecast`: surfaces `precip` and `precipProb`
  (current-hour index); tolerates absent `hourly`.
- **Manual:** the live case (code 95, 0 mm, 0%) now shows `⛅ Storms possible` with a
  calm cloud backdrop, not lightning.

## Non-goals (YAGNI)

- No change to the temperature/humidity digit color.
- No new "chance of rain %" UI element — the correction is internal to the
  condition icon/label/backdrop.
- No reverse correction (claiming rain when the code says clear) — only softening
  over-reported precip.
- The config-via-env gotcha (editing in-container `config.json` gets overwritten by
  the entrypoint on restart) is documented in the README, not code.

## Risks & mitigations

- **Hiding a real storm** → dry-override needs hard evidence (`precip===0` AND
  `prob<30`); any missing field or active precip → raw. Probability cutoff 30%
  keeps brewing storms loud.
- **Hourly-index mismatch** (DST / timezone) → guarded `parseInt` + bounds check;
  on any doubt `precipProb` stays `null` → no override.
- **Stale cache without precip fields** → `precip` undefined → raw (safe).

## Affected / new files

- `js/weather.js` — fetch `precipitation` + `precipitation_probability`; `precip`
  + `precipProb` in `normalizeForecast`; new `effectiveCondition`.
- `test/weather-condition.test.js` (new) — `effectiveCondition` + normalize tests.
- `js/app.js` — `paintWeather` + `fx.setCondition` use `effectiveCondition`.
- `docker-entrypoint.d/40-weather-fetch.sh` — request the precip fields.
- `README.md` — brief note on the correction + the config-via-env gotcha.
