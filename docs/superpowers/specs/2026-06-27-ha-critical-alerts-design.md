# Home Assistant Critical Alerts — Push API + Urgent Channel

**Date:** 2026-06-27
**Status:** Approved (design)

## Summary

Give the clock PWA a bearer-authenticated push API so Home Assistant (HA) can
fire **critical, real-time alerts** (water leak, door open, security) onto every
display. Alerts are a **separate channel** from the existing info announcements:
distinct urgent rendering, a faster poll, and HA-owned lifecycle (HA raises and
clears each alert by a stable key).

A tiny zero-dependency **sidecar** service owns writes to `alerts.json`; nginx
proxies the API to it and serves the file (open GET) to devices. The clock never
breaks: any failure of the sidecar, network, or file degrades to "no alert
shown," never a blank or frozen clock.

**Execution note:** this feature will be built using the `/loop` skill
(autonomous recurring execution of the implementation plan), not interactive
task-by-task dispatch.

## Existing system this builds on

- `announce.json` — info-announcement queue (array). Admin writes it via
  basic-auth WebDAV PUT; devices poll every 15s and render center card + stack,
  with chimes (`playChime`), icons, images, and `target` (profile) routing.
- `/data` volume holds admin-written files (`announce.json`, `profiles.json`,
  `source.json`, `/uploads`). nginx serves them open-GET, no-cache; PUT is
  basic-auth gated (`/etc/nginx/admin_auth.conf`).
- `profiles.json` / device `profile` setting — used for room targeting.
- Synthesized chimes in `js/app.js` (`playChime`, `ensureAudio`), Settings sound
  toggle (`soundEnabled`).
- Service worker (`sw.js`) network-first set for the JSON control files.

Critical alerts reuse the `target`/profile concept and the chime synthesizer but
are otherwise an independent channel.

## Global constraints (bind every component)

- **The clock must never break.** Every alert path (poll, parse, render, chime,
  wake) is wrapped; failure degrades to no alert, never a blank/frozen clock.
- **Auth fails closed.** If `ALERT_API_TOKEN` is unset/blank, the sidecar rejects
  all writes (`503`). Wrong/missing bearer → `401`.
- **Atomic file writes.** The sidecar writes a temp file + `rename()` so a device
  never reads a half-written `alerts.json`; an in-process lock serializes POSTs.
- **Devices never call the API.** They only GET `alerts.json` (open, no-cache).
  Only the sidecar writes it. This mirrors the `announce.json` pattern.
- **Two severities:** `warning` and `critical` (default `critical` when omitted).
- **HA owns lifecycle.** Alerts are keyed; HA raises (upsert) and clears (delete)
  by key. Devices do not dismiss criticals locally.

---

## Component 1 — Alert sidecar service

A single-file, zero-dependency service (Python 3 stdlib `http.server` +
`socketserver.ThreadingMixIn`), new container `alert-sidecar` in
`docker-compose.yml`, sharing the `/data` volume with nginx.

**Responsibilities**
- Authenticate every write with `Authorization: Bearer <ALERT_API_TOKEN>`.
- Maintain the active-alert set in `/data/alerts.json` (atomic writes, in-process
  `threading.Lock`).
- Validate and normalize input; reject malformed requests with clear 4xx.

**Endpoints**
- `POST /api/alert` — upsert one alert by `key`.
  - Body: `{ key, severity?, title, message, target? }`.
  - `key` (required, string, `[A-Za-z0-9_.-]{1,64}`): stable per alert source.
  - `severity` (optional): `warning` | `critical`; default `critical`.
  - `title` (required, ≤80 chars), `message` (required, ≤240 chars).
  - `target` (optional): profile/room name or `all`; default `all`.
  - Behavior: if `key` exists, replace it (refresh `ts`); else append. Cap the
    active set at 20; if exceeded, reject with `409` (HA should clear stale keys).
  - Returns `200 { ok: true, count: <active> }`.
- `POST /api/alert/clear` — body `{ key }` → remove that key. Returns
  `200 { ok: true, cleared: <bool> }` (`cleared:false` if key was absent —
  idempotent, not an error).
- `DELETE /api/alert?key=<key>` — same as clear (convenience for HA `DELETE`).
- `GET /api/health` — `200 { ok: true }` (no auth; for compose healthcheck).

**Stored shape** — `/data/alerts.json` is an array:
```json
[ { "key": "water_leak_basement", "severity": "critical",
    "title": "Water Leak", "message": "Basement sensor wet",
    "target": "all", "ts": 1750000000000 } ]
```
`ts` is server epoch ms, stamped by the sidecar on upsert.

**Errors:** `401` (bad/no bearer), `503` (token unset — fail closed), `400`
(missing/invalid field), `409` (active cap exceeded), `404`/`405` otherwise.
All responses are JSON. The sidecar never crashes on bad input; it catches and
returns 4xx.

**Config (env):** `ALERT_API_TOKEN` (required to enable writes),
`ALERT_PORT` (default `8090`), `ALERTS_FILE` (default `/data/alerts.json`),
`ALERT_MAX_ACTIVE` (default `20`).

## Component 2 — nginx wiring

- `location /api/ { proxy_pass http://alert-sidecar:8090; }` — forwards the API
  (including the `Authorization` header) to the sidecar. Keep `/api/` reserved
  for this; no other use.
- `location = /alerts.json { root /data; default_type application/json;
   add_header Cache-Control "no-cache, no-store, must-revalidate"; expires off; }`
  — open GET, mirrors the `announce.json` block. No PUT (sidecar owns writes via
  the volume, not WebDAV).
- The sidecar is reachable by service name on the compose network; the API is
  **not** basic-auth gated at nginx (it has its own bearer auth).

## Component 3 — Device rendering (`js/app.js`, `index.html`, `css/styles.css`)

- **Poll:** `pollAlerts()` fetches `alerts.json?ts=…` (no-store) every **5s**
  (its own interval + on visibility refocus). Pure `alertView(list, profile)`
  decides what to show: filter `target` (`all` or case-insensitive match to the
  device `profile`), sort **critical first, then newest `ts`**.
- **Critical** (`severity:'critical'`): full-screen red overlay. Not dismissible
  on device. Forces the screen bright — clears deep-dim and re-asserts wake-lock
  while any critical is active. Shows `title`, `message`, and "raised
  <time>". Repeating urgent chime every **30s** while active (tunable constant),
  gated by the existing `soundEnabled` setting.
- **Warning** (`severity:'warning'`): amber top banner strip, non-blocking (clock
  stays visible). Single chime on first appearance. Does **not** override
  night-dim.
- **Multiple active:** stacked list; the highest-priority critical owns the
  overlay, remaining alerts list compactly. Warnings stack as banners.
- **Clear:** when a key disappears from `alerts.json`, the device removes it next
  poll (≤5s); the critical overlay closes and its chime stops once no critical
  remains.
- **Chime:** reuse `ensureAudio`/oscillator pattern; add an `alert` urgent
  pattern (distinct from announcement chimes). Track which keys have chimed to
  avoid re-chiming a still-present warning every poll.
- All wrapped in try/catch — a malformed `alerts.json`, unsupported audio, or
  render error never affects the clock.

**Interaction with announcements:** independent. A critical overlay sits above
announcement cards (higher z-index). Both can be present; critical wins focus.

## Component 4 — Admin backstop (`admin.html`)

A new "Active Alerts" card (uses existing admin basic-auth):
- Read-only list of current alerts (GET `alerts.json`): key, severity, title,
  message, age.
- A **Clear** button per key → `POST /api/alert/clear` **with the admin's
  session**. Because the API requires a bearer token, the admin page calls clear
  through a basic-auth-gated nginx alias: `location = /admin/alert-clear { ...
  auth_basic; proxy_pass http://alert-sidecar:8090/api/alert/clear; proxy_set_header
  Authorization "Bearer <token>"; }` — i.e. nginx injects the token from a file
  written at startup so the admin never handles the raw token. (Token file
  written by an entrypoint script from `ALERT_API_TOKEN`, same mechanism as
  `admin_auth.conf`.)
- Purpose: a human can clear a stuck alert if HA fails to send the clear.

## Component 5 — Service worker + deploy

- `sw.js`: add `/alerts.json` to the network-first set; never cache `/api/`.
  Bump both cache constants (v16 → v17). Add no new shell files (sidecar is not
  served to the browser).
- `docker-compose.yml`: add the `alert-sidecar` service (build context = a new
  `alert-sidecar/` dir with `Dockerfile` + `alert_sidecar.py`), `ALERT_API_TOKEN`
  env on both the sidecar and (token-file) the clock container, a healthcheck on
  `/api/health`, and `depends_on`. Document `ALERT_API_TOKEN` next to
  `ADMIN_PASS`.
- The clock `Dockerfile`/entrypoint writes the bearer-token file for the admin
  clear alias from `ALERT_API_TOKEN` (empty/disabled if unset).

## Component 6 — Home Assistant integration (README + example)

Ship a copy-paste HA config:
```yaml
rest_command:
  clock_alert:
    url: "https://clock.example.com/api/alert"
    method: POST
    headers: { Authorization: "Bearer !secret clock_alert_token" }
    content_type: "application/json"
    payload: '{"key":"{{ key }}","severity":"{{ severity }}","title":"{{ title }}","message":"{{ message }}"}'
  clock_alert_clear:
    url: "https://clock.example.com/api/alert/clear"
    method: POST
    headers: { Authorization: "Bearer !secret clock_alert_token" }
    content_type: "application/json"
    payload: '{"key":"{{ key }}"}'
```
Example automation: leak sensor `on` → `clock_alert` with `severity: critical`;
`off` → `clock_alert_clear`. Same pattern for door/security sensors (use
`warning` for low-stakes, `critical` for safety). HTTPS strongly recommended so
the bearer token isn't sent in clear text (see the Caddyfile already in the repo).

---

## Testing

- **Sidecar (Python):** unit/integration tests with stdlib `unittest` against the
  request handler (or a spawned server): auth fail-closed (no token → 503), bad
  bearer → 401, upsert creates + replaces by key, clear removes (idempotent),
  validation rejects missing/oversized fields, active cap → 409, atomic write
  produces valid JSON. No third-party test deps.
- **Pure JS:** `alertView(list, profile)` — Node `--test`: target filtering
  (all/match/miss), critical-first + newest sort, empty list.
- **Device DOM/integration:** manual browser verification (critical overlay,
  warning banner, dim override, ≤5s clear, chime gating) — described in the plan,
  the same way the announcement UI is verified.

## Non-goals (YAGNI)

- No per-user/multi-token auth — one shared `ALERT_API_TOKEN`.
- No alert history/log UI — only the active set.
- No push/WebSocket/SSE — 5s polling is sufficient on a LAN.
- No acknowledge-on-device for criticals (HA owns clearing); a manual admin Clear
  is the only human override.
- No change to the existing announcement behavior.

## Risks & mitigations

- **Sidecar down / API unreachable** → devices simply show no alerts (and HA's
  POST fails, which HA can alert on separately); the clock is unaffected. Compose
  healthcheck + `restart: unless-stopped`.
- **Token in clear text over HTTP** → document HTTPS (Caddyfile) as required for
  WAN; on a trusted LAN, plain http is the user's call.
- **Repeating critical chime is annoying** → 30s interval is a tunable constant;
  warning is single-chime. Revisit if too aggressive.
- **Stuck alert (HA never clears)** → admin "Active Alerts" Clear backstop.
- **Concurrent POSTs** → in-process lock + atomic rename keep `alerts.json`
  consistent.

## Affected / new files

- `alert-sidecar/alert_sidecar.py` (new) — the service.
- `alert-sidecar/Dockerfile` (new) — `python:3-alpine`, copies the script.
- `alert-sidecar/test_alert_sidecar.py` (new) — sidecar tests.
- `docker-compose.yml` — add `alert-sidecar` service + `ALERT_API_TOKEN`.
- `nginx.conf` — `/api/` proxy, `/alerts.json` static, `/admin/alert-clear` alias.
- `js/alertview.js` (new) — pure `alertView(list, profile)`.
- `test/alertview.test.js` (new) — Node `--test`.
- `js/app.js` — `pollAlerts`, render critical/warning, dim override, alert chime.
- `index.html` — alert overlay + warning-banner markup.
- `css/styles.css` — critical overlay + warning banner styles.
- `admin.html` — Active Alerts card + Clear.
- `docker-entrypoint.d/` — write the bearer-token file for the admin clear alias.
- `sw.js` — `alerts.json` network-first, cache bump (v17).
- `README.md` — HA integration + API docs.
