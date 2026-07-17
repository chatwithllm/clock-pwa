# Per-Profile Home Assistant Dashboards — Design

**Date:** 2026-07-17
**Repo:** clock-pwa (the display app). The companion `clock-pwa-ha` HACS
integration is **not** touched by this work.
**Status:** Approved design, pre-plan.

## Context

The clock-pwa displays are wall-mounted kiosks (e.g. one per room). Today the
Home Assistant relationship is **inbound only**: HA pushes typed alerts and
polls presence via the `alert-sidecar`. The display can show alerts but cannot
show or control HA entities.

We want each display to also act as a **room control panel**: place a clock in
the guest room and it shows a dashboard of that room's entities (lights, temp,
scenes, thermostat) and can act on them. Because this is our own app, we do NOT
embed Home Assistant's Lovelace UI — we build a native dashboard UI and use a
Home Assistant **long-lived access token** purely as the API credential to read
entity state and call services.

**Intended outcome:** a display, once given an HA URL + token and assigned a
profile, renders that profile's custom dashboard with live entity state and
tap-to-act controls.

## Decisions (locked during brainstorming)

1. **Native render, not iframe.** The clock draws its own tiles from HA data.
   A long-lived token is an API credential; it does not authenticate HA's
   Lovelace UI, and HA blocks framing by default. Native render sidesteps both.
2. **Connection is per-device; dashboards are per-profile.**
   - HA base URL + long-lived token are entered on each physical display and
     stored in that device's `localStorage`. They never touch the shared
     `/data` store or the sidecar.
   - Dashboard layouts are defined per profile in a shared
     `dashboards.json`, edited in `admin.html`, polled by all devices. This
     file holds **no secrets**.
3. **Transport = WebSocket.** Connect to `<haUrl>/api/websocket`, authenticate
   with the token, `get_states` for the initial snapshot, subscribe to
   `state_changed` for live updates, `call_service` for actions. One
   authenticated socket does reads, pushes, and writes — this is how HA's own
   frontend works. REST polling was rejected (chattier, laggy, needs CORS on
   every call).
4. **MVP tile types = 4:** `sensor`, `toggle`, `scene`/`button`, `climate`.

## Architecture

New/changed pieces, all in clock-pwa:

| Piece | Location | Follows existing pattern |
|---|---|---|
| HA connection config (`haUrl`, `haToken`) | device `localStorage` key `clockpwa.settings.v1` | Pattern A — `js/settings.js` DEFAULTS + `saveSettings` persist-list (`js/settings.js:16-40,122-133`) |
| `js/ha.js` — HA WebSocket client | new module | new; mirrors the module style of `js/source.js` (pure logic + small runtime) |
| Per-profile dashboard defs | new shared `/data/dashboards.json` | Pattern B — like `profiles.json`/`source.json`: admin PUT + device poll + cache |
| Dashboard view | new full-screen overlay in `index.html`, sibling of `#alertOverlay` (`index.html:77`) | toggled like the alert overlay (`renderAlerts()` `js/app.js:758-814`) |
| Nav entry + lifecycle | button in `#chrome`; wired in `wireControls()` | existing control-band handler pattern (`js/app.js:930-1014`) |
| Admin editor | new "Dashboards" section in `admin.html` | like `putProfiles`/`loadProfiles` (`admin.html:264-286`) |

### Data flow

- **Config:** device stores URL+token locally → `js/ha.js` opens
  `wss://<haUrl>/api/websocket`, sends `auth`.
- **Reads:** on auth, `get_states` seeds a local entity-state cache;
  `subscribe_events(state_changed)` keeps it live → tiles re-render on change.
- **Writes:** tile tap → `call_service` over the same socket.
- **Layout:** admin edits `dashboards.json[<profile>]` → devices poll every 15s
  (alongside the existing profiles/source/announce polls, `js/app.js:1212-1214`)
  → active profile's `tiles[]` drives what renders.

## Data model — `dashboards.json`

Shared, keyed by profile name, no secrets:

```json
{
  "version": 1,
  "profiles": {
    "Guest Room": {
      "title": "Guest Room",
      "tiles": [
        { "type": "toggle",  "entity": "light.guest_ceiling", "label": "Ceiling", "icon": "💡" },
        { "type": "sensor",  "entity": "sensor.guest_temp",   "label": "Temp", "unit": "°C" },
        { "type": "scene",   "service": "scene.turn_on", "target": "scene.goodnight", "label": "Goodnight", "icon": "🌙" },
        { "type": "climate", "entity": "climate.guest_thermostat", "label": "Thermostat" }
      ]
    }
  }
}
```

- A tile binds to an `entity` (state), and/or a service `target` (action).
- `icon` = emoji (reuses the emoji convention in `js/alertview.js:18-24`);
  default derived from the entity domain when omitted.
- Unknown / `unavailable` entity → tile renders `—` with muted styling.

### MVP tile types

| Type | Reads | Tap action | HA service call |
|---|---|---|---|
| `sensor` | entity state + `unit` | none (read-only) | — |
| `toggle` | on/off state | flip | `<domain>.toggle` (light / switch / fan / input_boolean) |
| `scene` / `button` | none (stateless) | fire once | `scene.turn_on` / `script.turn_on` / `button.press` |
| `climate` | current temp + setpoint | `−` / `+` setpoint | `climate.set_temperature` |

**Deferred (additive later — schema's `type` leaves room):** `cover`,
light brightness slider, `media_player`, camera snapshot. Per-tile `size`
(`"2x1"`) deferred — MVP is a uniform responsive grid, tiles in `tiles[]` order.

## UX

### Device connection (settings panel — Pattern A)

- Two new rows in `#panel`: **HA URL** (text input, reuse the city-search input
  pattern `js/app.js:1016-1032`) and **HA Token** (masked input).
- New `haUrl` / `haToken` keys in `js/settings.js` DEFAULTS and the
  `saveSettings` persist-list (a field absent from that list will not persist).
- **Test/Connect** button opens the WS, sends `auth`, and reports inline:
  ● connected / auth-failed / unreachable. This status gates the dashboard
  button's visibility.

### Dashboard editing (admin — Pattern B)

- New "Dashboards" section: pick a profile → edit its `tiles[]` as a
  **validated JSON textarea** (MVP; matches the app's simple admin style, admin
  is basic-auth gated and technical). PUT to `/data/dashboards.json`.
- Add the file to `sw.js` network-first list (one line, like `sw.js:51`) and an
  `nginx.conf` location block mirroring the `profiles.json` block
  (`nginx.conf:65-76`).
- Form-based tile builder + live entity autocomplete → deferred.

### Navigation & lifecycle

- Dashboard = full-screen overlay, opened by a `#chrome` button; tiles are
  `[data-nav]` so the d-pad remote (`js/nav.js`) can walk them; close returns
  to the clock.
- Auto-return to the clock on idle (reuse existing idle handling).
- The dashboard button is hidden unless **HA is connected** AND the **active
  profile has a dashboard** defined.

## Security

- The long-lived token is high-privilege (inherits its HA user's permissions).
  It lives **only** in the device's `localStorage`, is masked in the UI, and is
  never written to `/data` or sent to the sidecar. The browser needs it locally
  to call HA directly — there is no server-side proxy in this design.
- **README guidance:** create a *dedicated HA user* for displays so the token's
  blast radius is scoped to that user.

## External constraints (HA-side config — documented, not coded)

- **CORS:** a browser calling HA from the clock's origin needs the clock URL in
  HA's `http.cors_allowed_origins` (`configuration.yaml`). WebSocket is more
  lenient than REST, but document it.
- **Mixed content:** if the clock is served over HTTPS, HA must be reachable
  over HTTPS / `wss`, or the browser blocks the connection.

Both belong in the install docs; neither is code in this app.

## Error handling & resilience (`js/ha.js`)

- WS reconnect with exponential backoff.
- While disconnected: tiles grey out and show last-known state.
- `auth_invalid` surfaces in the settings panel (not a silent fail).
- Missing / `unavailable` entity → `—` tile.

## Testing (follow existing `test/*.test.js` node pattern)

Pure functions, no live HA required:
- Dashboard-schema validation (accept valid, reject malformed tiles).
- Tile → service mapping (`toggle` on a `switch.` vs `light.` entity, `scene`
  vs `button`, `climate` setpoint delta).
- Entity-state projection (state → tile render model; `unavailable` handling).
- `js/ha.js` message handling against a **mock WebSocket** (auth handshake,
  `get_states` seed, `state_changed` cache update, reconnect).

## Out of scope

- The `clock-pwa-ha` HACS integration (untouched).
- Deferred tile types and the form-based tile editor.
- Any server-side HA proxy (token stays client-side by design).
- Embedding HA's Lovelace UI.
