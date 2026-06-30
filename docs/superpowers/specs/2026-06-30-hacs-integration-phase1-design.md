# HACS Integration (Phase 1) — Clock-PWA Control Plane in Home Assistant

**Date:** 2026-06-30
**Status:** Approved (design)

## Summary

Make Home Assistant the control plane for the clock displays via a HACS custom
integration. Phase 1 covers **alerts + presence**: HA gets services to send/clear
typed alerts and entities for active alerts and per-room presence. It is a thin
HA-side client over the existing sidecar API, plus a small server-side addition so
presence can be **polled** (the sidecar currently only relays it).

Two cohesive pieces:
- **A. Server (clock-pwa repo):** the sidecar stores presence state and serves it
  at `GET /presence.json`; the device adds a light presence heartbeat.
- **B. Integration (new repo `~/dev/active/clock-pwa-ha`):** a HACS custom
  integration (`clock_pwa` domain) — config flow, polling coordinator, services,
  and entities.

Admin (announcements/profiles/source) = Phase 2; per-device registry = Phase 3
(both deferred; Phase 3 needs more server-side work).

## Context (what already exists)

- **Sidecar** (`alert-sidecar/alert_sidecar.py`, Python stdlib): `POST /api/alert`
  `{key, severity, type?, title, message, target?}` (bearer `ALERT_API_TOKEN`),
  `POST /api/alert/clear` `{key}`, `GET /alerts.json` (open), `GET /api/health`,
  and `POST /api/presence` `{room, present}` which **relays** to `HA_WEBHOOK_URL`
  server-side but does **not** store state.
- **Devices** post presence transitions (`postPresence` in `js/app.js`) to
  `/api/presence`, room = device profile, 5 s debounce, transition-only.
- nginx proxies `/api/` and `/alerts.json` to the sidecar; tokens/files are served
  via small served JSON (`snapshot.json` pattern).

## Constraints (bind both pieces)

- **The clock must never break.** The new sidecar paths + heartbeat are wrapped;
  failure degrades silently. The integration never affects the clock/sidecar
  beyond the documented API.
- **Reuse, don't fork:** extend `/api/presence` (add storage) and the existing
  `postPresence`; do not duplicate the relay.
- **Sidecar stays Python stdlib only.** The integration is standard HA (no exotic
  deps; uses `aiohttp` via HA's shared session + `homeassistant.helpers`).
- **Auth:** writes (`send_alert`/`clear_alert`) use the bearer `ALERT_API_TOKEN`;
  reads (`/alerts.json`, `/presence.json`) are open (LAN/HTTPS), as today.
- **Presence freshness:** because device posts are transition-only, the heartbeat
  keeps `ts` fresh so a dead device is distinguishable from a quiet one via a TTL.
- **HACS-valid:** the integration passes `hassfest` + HACS validation; public repo
  with a description; versioned `manifest.json`.

---

## Component A1 — Sidecar presence state + `GET /presence.json`

`alert-sidecar/alert_sidecar.py`:
- Add an in-memory `_presence = {}` (room → `{present: bool, ts: int}`), guarded by
  the existing lock, persisted atomically to `PRESENCE_FILE`
  (env, default `/data/presence.json`) so it survives a restart.
- In `_handle_presence` (after validation, regardless of relay outcome): record
  `_presence[room] = {present, ts: now_ms()}` and write it atomically. The relay to
  `HA_WEBHOOK_URL` is unchanged (still best-effort).
- Add `GET /presence.json` (open, no auth — mirrors `/alerts.json`): returns the
  full map `{ room: {present, ts} }`. Served via nginx proxy (Component A3).
- Pure helper `presence_view(store)` → the JSON-serializable map (testable).

## Component A2 — Device presence heartbeat

`js/app.js` (`postPresence` / `applyPresence` area):
- Keep transition posts. **Add a heartbeat:** while camera Presence is active and
  the profile is a real room, re-POST the *current* `present` every
  `PRESENCE_HEARTBEAT_MS` (default 120000 = 2 min) via the existing `postPresence`
  path (bypassing the 5 s transition debounce, but on its own timer). This keeps
  the server's `ts` fresh so the integration's TTL can detect a dead device.
- Started/stopped with the presence controller; fully wrapped; a failed post never
  affects the clock. Skipped when profile is `None`.

## Component A3 — nginx

Add a `GET /presence.json` location mirroring the `/alerts.json` proxy block
(open GET, no-cache, `proxy_pass` to the sidecar via the existing
`$alert_up` resolver/variable). No other nginx change.

## Component B — HACS integration (`~/dev/active/clock-pwa-ha`)

New **public GitHub repo**, domain `clock_pwa`. Layout:

```
clock-pwa-ha/
├── hacs.json                     # {name, homeassistant min, render_readme}
├── README.md                     # repo description required by HACS
├── custom_components/clock_pwa/
│   ├── __init__.py               # setup entry: create coordinator, forward platforms, register services
│   ├── manifest.json             # domain, name, version (SemVer), config_flow:true, iot_class:local_polling, codeowners
│   ├── const.py                  # DOMAIN, defaults (scan interval, TTL)
│   ├── config_flow.py            # UI: base_url + token; validate via /api/health
│   ├── coordinator.py            # DataUpdateCoordinator: poll /alerts.json + /presence.json
│   ├── sensor.py                 # sensor.clock_active_alerts
│   ├── binary_sensor.py          # binary_sensor.clock_presence_<room> (dynamic)
│   ├── services.yaml             # send_alert / clear_alert schemas
│   └── strings.json              # config-flow + service strings
├── .github/workflows/validate.yml# hassfest + HACS action
└── tests/                        # pytest-homeassistant-custom-component
```

- **Config flow** (`config_flow.py`): inputs `base_url` (e.g.
  `https://clock.npalakurla.com`) and `api_token`. Validate by `GET {base_url}/api/health`
  (expect `{ok:true}`); on success create the config entry. Single instance per
  base_url (unique_id = base_url).
- **Coordinator** (`coordinator.py`): `DataUpdateCoordinator` with
  `update_interval = 15 s` (configurable). Each refresh fetches `/alerts.json` and
  `/presence.json` (HA's shared `aiohttp` session, short timeout). On fetch
  failure → `UpdateFailed` (entities go `unavailable`). First refresh via
  `async_config_entry_first_refresh` (raises `ConfigEntryNotReady` on a bad host).
- **`sensor.clock_active_alerts`** (`sensor.py`): state = number of active alerts;
  attributes = the list (key/severity/type/title/message/target/ts). `icon`
  reflects whether any are critical.
- **`binary_sensor.clock_presence_<room>`** (`binary_sensor.py`): one per room key
  in `/presence.json`, `device_class = occupancy`. `is_on = present`. Marked
  `available = (now - ts) < PRESENCE_TTL` (default 300 s; the 2-min heartbeat keeps
  live devices well inside it). Rooms are added dynamically as they appear (the
  coordinator drives entity creation via an `async_add_entities` callback that
  diffs known vs seen rooms).
- **Services** (`services.yaml` + registration in `__init__.py`):
  - `clock_pwa.send_alert` — fields `key` (req), `severity` (warning|critical,
    default critical), `type` (optional), `title` (req), `message` (req), `target`
    (optional). POSTs to `{base_url}/api/alert` with `Authorization: Bearer
    <token>`.
  - `clock_pwa.clear_alert` — field `key` (req). POSTs to `/api/alert/clear`.
  - Both surface a clear error if the host rejects (e.g. 401 bad token).
- A HA **device** ("Clock PWA — <host>") groups the entities; entities link to it.

## Component C — Testing + distribution

- **Sidecar (`unittest`):** `_handle_presence` stores `{present, ts}`;
  `GET /presence.json` returns the map; `presence_view` pure-tests; atomic write
  round-trips; relay still fires (existing tests unaffected).
- **Device:** static check that the heartbeat re-posts current presence on its
  timer and is skipped when profile is `None` / presence off; `node --test` green.
- **Integration (`pytest-homeassistant-custom-component`):** config-flow happy +
  bad-host; coordinator parses alerts/presence; `clock_active_alerts` count;
  presence binary_sensor on/off + TTL-unavailable; `send_alert`/`clear_alert` issue
  the right POST (mocked aiohttp). `hassfest` + HACS validation in CI.
- **Distribution:** README documents adding the repo as a HACS **custom
  repository** (category: Integration), installing, restarting HA, then adding the
  integration (base_url + token). Also: set the clock's `HA_WEBHOOK_URL` is **not
  required** for Phase 1 (presence is polled now), but remains supported.

## Non-goals (YAGNI — Phase 1)

- No announcements / profile management / Source-mode control (Phase 2).
- No per-display device registry / per-device controls (Phase 3 — needs a device
  heartbeat-with-identity + registry endpoint).
- No HA-side admin basic-auth (Phase 1 uses only the bearer token + open reads).
- No Lovelace card (separate concern).
- No people-count (parked).

## Risks & mitigations

- **Stale presence on a dead device** → the 2-min heartbeat + TTL (`available=false`
  after 5 min) surfaces it as `unavailable` rather than a stuck `on`.
- **Presence file growth** → it's a small fixed map keyed by room (a handful of
  rooms); no unbounded growth.
- **Integration vs HA API drift** → pin a `homeassistant` minimum in `hacs.json`/
  `manifest.json`; CI runs `hassfest` against it.
- **Token exposure** → the bearer token lives only in the HA config entry; reads
  are open by existing design; HTTPS recommended (the user has it).
- **Two-repo coordination** → the integration depends on `/presence.json`; ship the
  sidecar change first (or together) and note the minimum clock-pwa version in the
  integration README.

## Affected / new files

**clock-pwa repo:**
- `alert-sidecar/alert_sidecar.py` — presence store + `GET /presence.json` +
  `presence_view`; `PRESENCE_FILE` env.
- `alert-sidecar/test_alert_sidecar.py` — presence-state tests.
- `js/app.js` — presence heartbeat timer.
- `nginx.conf` — `GET /presence.json` proxy.
- `docker-compose.yml` — `PRESENCE_FILE` (optional, default fine); SW unaffected.
- `README.md` — note `/presence.json` + the HACS integration pointer.

**New repo `~/dev/active/clock-pwa-ha`:** the full `custom_components/clock_pwa/`
integration + `hacs.json` + CI + tests as laid out in Component B.
