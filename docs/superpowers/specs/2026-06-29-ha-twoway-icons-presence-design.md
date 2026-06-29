# Two-Way Home Assistant: Typed Alert Icons + Presence Relay

**Date:** 2026-06-29
**Status:** Approved (design)

## Summary

Extend the existing Home Assistant integration in both directions:

- **A. Typed alert icons (HA → clock):** each critical/warning alert carries a
  `type` (water_leak, door, …) that the clock maps to a blinking icon in the
  overlay/banner. Reuses the existing alert pipeline; no HA-side infra.
- **B. Presence relay (clock → HA):** a device reports present/away to HA so
  automations can use "is someone at the Kitchen display." A direct browser→HA
  call is CORS-fragile, so the device posts to the **sidecar**, which forwards
  server-side to an HA webhook.

Both reuse what already exists (the alert API/sidecar, the camera presence
module). The clock never breaks: every new path is wrapped and degrades silently.

## What already exists (reuse, do not rebuild)

- **Alert channel:** sidecar `POST /api/alert` `{ key, severity, title, message,
  target }` (bearer `ALERT_API_TOKEN`), `POST /api/alert/clear`; devices poll
  `/alerts.json` (5s) and render a red overlay (critical) / amber banner
  (warning) with a chime; admin "Active Alerts" page. **No per-type icon today.**
- **Camera presence:** `js/presence.js` — in-browser motion detection drives the
  local deep-dim; opt-in (Settings → Presence). **Does not contact HA.** Pure
  helpers `motionScore`/`presenceReducer`; the `Presence` controller fires an
  `onPresence(present, motion, now)` callback on each tick (and a change is
  detectable as `present` flipping).
- **Sidecar** is a zero-dependency Python-stdlib service; nginx proxies `/api/`
  and a dedicated `/api/snapshot` to it; tokens are published to the kiosk via
  small served JSON files (`snapshot.json`) written by entrypoints.

## Verified constraint (decided the architecture)

Posting from an iOS-Safari kiosk **directly** to an HA webhook is unreliable: HA
needs `http.cors_allowed_origins`, and the preflight `OPTIONS` frequently 405s on
webhook/API endpoints. → **Presence goes device → sidecar (same-origin, no CORS)
→ HA (server-to-server, no CORS).** The HA URL/secret stays out of the browser.

## Global constraints

- **The clock must never break.** Icon render, presence POST, and the sidecar
  relay are all wrapped; any failure degrades to today's behavior.
- **Reuse, don't fork** the alert API and presence module — add fields/paths.
- **Dependency-free:** clock = vanilla JS/CSS (emoji icons, CSS blink); sidecar =
  Python stdlib only (`urllib` for the relay).
- **Backward compatible:** alerts without `type` render exactly as today
  (no icon or the default). Presence relay is a no-op when `HA_WEBHOOK_URL` unset.
- **Privacy:** presence sends only `{ room, present }` — never camera frames.
- **Respect `prefers-reduced-motion`:** no blink animation when set.

---

## Component A1 — Alert `type` field (sidecar)

`alert-sidecar/alert_sidecar.py` — `validate_alert` accepts an optional `type`:
- `type` (optional string, `^[a-z0-9_]{1,32}$`, default absent). Reject only on a
  bad shape; an unknown-but-well-formed value is allowed (the clock maps unknown →
  default icon).
- Stored in the alert object and served via `/alerts.json`. `/api/alert/clear`
  unchanged.

## Component A2 — Icon map + render (clock)

**Pure `alertIcon(type)`** in `js/alertview.js` (it already owns alert display
logic):

```
alertIcon(type) -> emoji string
```
Curated map (unknown/missing → `'⚠️'`):
`water_leak:'💧'`, `door:'🚪'`, `window:'🪟'`, `security:'🔒'`, `smoke:'🔥'`,
`co:'☣️'`, `motion:'🚶'`, `freeze:'🧊'`, `power:'🔌'`, `temperature:'🌡️'`.

**Render (`js/app.js`, `renderAlerts`):**
- Critical overlay: show `alertIcon(a.type)` large, above the title; add a
  blink/pulse animation class.
- Warning banner: prefix the text with the icon, blinking.
- The icon element + blink animation are new markup/CSS:
  `#alertIcon` in the overlay, an icon span in the banner, and a CSS
  `@keyframes alertBlink` (opacity/scale pulse) gated by
  `@media (prefers-reduced-motion: no-preference)` so reduced-motion users get a
  static icon.

**HA side:** add `type` to the existing `rest_command` payload, e.g.
`'{"key":"{{ key }}","severity":"{{ severity }}","type":"{{ type }}","title":"{{ title }}","message":"{{ message }}"}'`.

## Component B1 — Presence relay endpoint (sidecar)

`alert-sidecar/alert_sidecar.py`:
- New env `HA_WEBHOOK_URL` (e.g. `https://ha.local:8123/api/webhook/<id>`).
- `POST /api/presence`, body `{ room, present }`:
  - Validate `room` (string, the profile charset, ≤64) and `present` (bool).
    Bad body → `400`.
  - **No bearer** (low-value boolean relay; trusted-LAN, documented). If
    `HA_WEBHOOK_URL` is unset → return `200 {ok:true, relayed:false}` (no-op).
  - Else POST `{ room, present }` (JSON) to `HA_WEBHOOK_URL` via `urllib`
    (short timeout, fully caught). Relay failure → still return `200
    {ok:true, relayed:false}` (never surface the kiosk an error). Success →
    `{ok:true, relayed:true}`.
- A small pure helper for the relay body keeps it testable; the HTTP POST is
  exercised against a stub server in tests.

## Component B2 — Device reports presence (clock)

`js/presence.js` / `js/app.js`:
- When the `Presence` controller's `present` value **changes** (transition), and
  the device **profile is a real room** (not `None`), POST `{ room: profile,
  present }` to `api/presence` (same-origin → no CORS), `.catch(()=>{})`.
- **Min-interval guard** (e.g. ≥ 5 s between posts) so rapid flips don't spam.
- Only runs while camera Presence is active (presence only exists then). No new
  Settings toggle — "auto when configured": the device always reports; the
  sidecar relays only if `HA_WEBHOOK_URL` is set.
- Fully wrapped — a failed post never affects dimming, snapshots, or the clock.

## Component B3 — HA-side setup (docs)

README example: an HA **webhook automation** that receives `{ room, present }`
and sets a per-room helper (e.g. `input_boolean.clock_presence_<room>` or a
template `binary_sensor`). Plus the updated `rest_command` for typed alerts.

## Deploy wiring

- `docker-compose.yml`: add `HA_WEBHOOK_URL: "${HA_WEBHOOK_URL:-}"` to the
  `alert-sidecar` service env (commented example; set via `.env`/override).
- No nginx change for presence — `POST /api/presence` is already covered by the
  existing `location /api/` proxy (small JSON body, under the 16k cap).
- SW: bump the cache version (icon CSS/markup changes ship to devices).

## Testing

- **Sidecar (`unittest`):** `validate_alert` accepts `type` (good shape) and
  rejects a malformed one; `/api/presence` validates body (400 on bad),
  returns `relayed:false` when `HA_WEBHOOK_URL` unset, and POSTs the expected
  JSON to a stub HA server when set (assert the stub received `{room, present}`);
  relay failure still returns 200.
- **Pure JS (`node --test`):** `alertIcon` — known types map correctly,
  unknown/missing → `'⚠️'`.
- **Manual:** send a `type:'water_leak'` critical alert → 💧 blinks in the
  overlay; `prefers-reduced-motion` → static. Toggle camera Presence with
  `HA_WEBHOOK_URL` set → HA helper flips with the room; unset → no-op.

## Non-goals (YAGNI)

- No people **count** (parked — motion only).
- No new per-device "report to HA" toggle (auto when configured).
- No bidirectional state sync beyond present/away + typed alerts.
- No SVG icon system — emoji only.
- No browser→HA direct calls (CORS) — sidecar relay only.

## Risks & mitigations

- **Spoofed presence on the LAN** (open `/api/presence`) → low impact (a boolean);
  documented trusted-LAN; can add a token later if needed.
- **HA webhook down / slow** → relay POST is short-timeout + caught; kiosk always
  gets `200`; clock unaffected.
- **Emoji rendering differences** across iOS versions → emoji are universally
  supported on iOS Safari; acceptable.
- **Blink annoyance / accessibility** → `prefers-reduced-motion` disables it.

## Affected / new files

- `alert-sidecar/alert_sidecar.py` — `type` in `validate_alert`; `POST
  /api/presence` relay; `HA_WEBHOOK_URL` env.
- `alert-sidecar/test_alert_sidecar.py` — type + presence-relay tests.
- `js/alertview.js` — `alertIcon(type)`.
- `test/alertview.test.js` — `alertIcon` tests.
- `js/app.js` — render the (blinking) icon in overlay/banner; post presence
  transitions to `/api/presence`.
- `js/presence.js` — surface presence transitions to the app for posting (or post
  from the existing `onPresence` change path).
- `index.html` / `css/styles.css` — icon markup + `alertBlink` keyframes
  (reduced-motion gated).
- `docker-compose.yml` — `HA_WEBHOOK_URL` env on the sidecar.
- `sw.js` — cache bump.
- `README.md` — typed-alert `rest_command` + HA presence webhook automation.
