# Physical Room Awareness — NFC Profiles + Camera Presence + Arrival Snapshots

**Date:** 2026-06-28
**Status:** Approved (design)

## Summary

Make the dedicated-iPhone clock displays aware of their physical room and the
people near them, within what iOS actually allows:

- **A. Kiosk setup** — run full-screen Safari under Guided Access, served over
  HTTPS. Ops/config, not code.
- **B. NFC → profile** — an NFC tag at each room's MagSafe charger switches the
  display's profile when the phone docks. iOS does the NFC reading (the Web NFC
  API does not exist on iOS); the app just consumes a `?profile=` URL.
- **C. Camera presence dimming** — the front camera does in-browser **motion**
  detection to brighten the display when someone is near and deep-dim it when not.
- **D. Arrival snapshots → NAS** — on each arrival, capture one JPEG and store it
  to a dedicated TrueNAS folder via the sidecar (scoped upload token).

This is a personal project; storing images of people is an accepted, owner-chosen
trade. Everything camera-related is **opt-in and off by default**.

## Verified platform constraints (these decided the design)

All iOS browsers are WebKit; these are current as of 2026:

- **Web NFC API: unsupported on iOS.** A web app cannot read NFC. iOS *can* read
  an NDEF **URL record** at the OS level and open it. → NFC works via a URL tag +
  iOS Shortcuts, not via web code.
- **Battery Status API: unsupported on Safari/iOS.** "On charger" cannot be
  detected from the web → the NFC tag at the charger is the trigger, not charge
  state.
- **`getUserMedia`: works in Safari** (needs a **secure context / HTTPS**); long
  buggy in *standalone* home-screen PWAs, so we run in **Safari**, not an
  installed PWA. Shows a permanent red "camera in use" bar; may re-prompt for
  permission. Requires the screen on + app foregrounded — guaranteed by Guided
  Access with auto-lock off.
- **No FaceDetector / Shape Detection API on Safari.** Presence = **motion
  detection** (frame differencing), not face recognition.
- **Guided Access ignores the web Wake-Lock API.** The app **cannot power the
  screen off**; the OS does. So presence "off" = the app's existing **deep-dim /
  near-black** content (backlight stays on, burn-in-safe), not a real screen-off.

## Global constraints (bind every component)

- **The clock must never break.** Camera, presence, snapshot, and NFC paths are
  all wrapped; any failure (permission denied, no camera, network down, NAS
  unmounted) degrades silently to today's behavior — never a blank/frozen clock.
- **Camera is opt-in, off by default.** Two independent toggles: **Presence**
  (camera on → drives dimming) and **Save snapshots** (upload arrival JPEGs).
  Presence can run with snapshots off.
- **Presence analysis is in-browser only.** Raw frames are never stored or sent;
  only a present/away boolean leaves the detector. The *only* image that leaves
  the device is the arrival snapshot, and only when **Save snapshots** is on.
- **Snapshot upload is least-privilege.** A dedicated `SNAPSHOT_TOKEN` that can
  ONLY upload snapshots — never the admin password or `ALERT_API_TOKEN`.
- **Bounded storage.** Per-upload size cap + retention prune so snapshots can't
  fill the NAS.
- **No new browser dependencies.** Presence/motion is dependency-free vanilla JS
  (no face-model/WASM). Sidecar stays Python stdlib only.

---

## Component A — Kiosk runtime + setup (docs)

Documentation in the README; no app code.

- Run the clock in **full-screen Safari**, locked with **Guided Access**
  (Settings → Accessibility → Guided Access; triple-click to start on the clock
  tab). Set **Display Auto-Lock = Never** and enable **Mirror Display Auto-Lock**
  (otherwise iOS forces a 20-minute timeout).
- Serve over **HTTPS** (the repo's `Caddyfile`) — mandatory for `getUserMedia`.
  Grant camera permission once per site.
- Each phone sits on its room's MagSafe charger (always powered, so camera
  battery cost is moot).

## Component B — NFC → profile switch

- **Tag:** an NDEF tag at each charger with a **URL record**
  `https://<clock-host>/?profile=<room>` (e.g. `Theater%20Room`). Placed where the
  phone's NFC antenna (top back) rests when docked.
- **Trigger (recommended):** a per-phone **iOS Shortcuts Personal Automation** —
  *Automation → NFC → scan tag → Open URL `https://<clock-host>/?profile=<room>`*,
  with **"Ask Before Running" off** → docking switches the profile automatically,
  no banner. Plain NDEF-URL tap (with the system banner) is the no-Shortcut
  fallback.
- **App change (small):** `js/settings.js` already reads `?profile=` on load.
  Enhancement: when an incoming `?profile=` differs from the stored profile,
  **persist it** and surface a brief **confirmation toast** ("Theater Room") so a
  dock visibly re-rooms the display. No NFC code in the app — iOS reads the tag.
  Reuse the announcement toast styling; the toast auto-dismisses (~4s).

## Component C — Camera presence dimming

**New `js/presence.js`** — owns the camera stream + motion detection, exposing a
small interface to `app.js`. Gated by a **Presence** setting (default off).

- **Start:** on enabling Presence (and on boot if persisted on), call
  `getUserMedia({ video:{ facingMode:'user', width:320, height:240 }, audio:false })`.
  On reject/error → disable silently, leave a one-line status, never throw.
- **Detect (motion):** a low-rate loop (~2 fps via `setTimeout`, not rAF) draws
  the video to an offscreen `<canvas>` downscaled to ~64×48 grayscale.
  `motionScore(prev, curr)` = mean absolute per-pixel delta. Score over
  `MOTION_THRESHOLD` → motion this tick.
- **State machine (pure):** `presenceReducer(state, motionNow, nowMs)` →
  `{ present, lastMotionMs }`. Motion → `present=true` immediately. No motion for
  `AWAY_GRACE_MS` (default 90 000) → `present=false`. Any motion re-arms instantly.
- **Effect:** the module calls back into `app.js` with `present`. Brightness rule:
  **bright only when `present` AND not night**; `away` OR night → the existing
  **deep-dim**. This composes with (does not replace) the current night schedule —
  effective dim = `night || away`. Re-uses `applyDim` / the `deepDim` path.
- **Resilience:** if the stream ends/errors, retry with backoff (e.g. 2s→4s→…
  capped ~60s); after repeated failure, give up quietly and fall back to the
  schedule-only behavior. Stopping Presence releases the camera (red bar clears).
- **Privacy:** frames live only in the offscreen canvas for the duration of one
  comparison; nothing is retained or transmitted by this component. Only the
  `present` boolean and (if Component D is enabled) the arrival snapshot leave.
- **Settings/UI:** a **Presence** toggle in the panel (off default). When on, the
  camera starts and the red bar appears. A small status line reflects
  on/denied/unavailable.
- **Testable units:** `motionScore(prev, curr)` and `presenceReducer(...)` are
  pure → Node `--test`. Camera glue + dim integration are DOM/manual (headless
  screenshot with a synthetic stream is out of scope; verify on-device).

## Component D — Arrival snapshots → TrueNAS

Capture one JPEG per arrival and store it to the NAS via the sidecar.

- **Capture (`js/presence.js`):** on an `away→present` transition, if **Save
  snapshots** is on, draw a larger frame (~480×360) to a canvas and
  `toBlob('image/jpeg', 0.7)`. A **cooldown** (`SNAPSHOT_COOLDOWN_MS`, default
  300 000 = 5 min per device) prevents repeated arrivals from flooding.
- **Upload:** `POST /api/snapshot?profile=<room>` to the sidecar, header
  `Authorization: Bearer <SNAPSHOT_TOKEN>`, `Content-Type: image/jpeg`, body = the
  JPEG bytes. The kiosk reads `SNAPSHOT_TOKEN` from server config (served to the
  page — see below), not hardcoded in source. Upload failure is swallowed (never
  affects the clock or presence dimming).
- **Sidecar (`alert-sidecar/alert_sidecar.py`):** add `POST /api/snapshot`:
  - Auth: a **separate** `SNAPSHOT_TOKEN` env (distinct from `ALERT_API_TOKEN`);
    unset → 503 (snapshots disabled, fail closed); wrong/missing bearer → 401.
    Constant-time compare.
  - Validate `profile` against the key charset; cap body at `SNAPSHOT_MAX_BYTES`
    (default 1 MiB); require `Content-Type: image/jpeg`.
  - Write atomically (temp + `os.replace`) to
    `SNAPSHOTS_DIR/<profile>/<UTC-YYYYMMDD-HHMMSS-mmm>.jpg`
    (`SNAPSHOTS_DIR` default `/data/snapshots`). Create the per-room dir as needed.
  - **Retention prune** after each write: delete files in that room older than
    `SNAPSHOT_RETENTION_DAYS` (default 30) and, if still over
    `SNAPSHOT_MAX_PER_ROOM` (default 1000), delete oldest first.
  - Returns `200 {ok, stored:<relpath>}`.
- **Serving `SNAPSHOT_TOKEN` to the kiosk:** the clock container exposes it to the
  page via a tiny served value — extend `config.json` generation
  (`docker-entrypoint.d/30-clock-config.sh`) to include
  `"snapshotToken": "<SNAPSHOT_TOKEN>"` when set. `js/settings.js`/`app.js` read it
  from the already-fetched `config.json`. (Low-privilege by design; on a trusted
  LAN this is acceptable. Documented as snapshot-upload-only.)
- **NAS backing:** `SNAPSHOTS_DIR` (`/data/snapshots` in the sidecar) is a mounted
  **TrueNAS** folder. Recommended: a Docker **NFS volume** in `docker-compose.yml`
  pointing at a dedicated TrueNAS dataset/export, mounted into the sidecar:

  ```yaml
  volumes:
    snapshots:
      driver: local
      driver_opts:
        type: nfs
        o: "addr=<truenas-ip>,nfsvers=4,rw,soft"
        device: ":/mnt/<pool>/<dataset>/clock-snapshots"
  ```
  Alternatives (documented): SMB/CIFS volume, or a host bind-mount of an already-
  mounted share. TrueNAS side: create the dataset, add an **NFS share** scoped to
  the Docker host's IP. If the NAS is unmounted/unreachable, the write fails and
  the sidecar returns 5xx — the kiosk ignores it; nothing else breaks.
- **Browse:** directly on TrueNAS (one folder per room). No admin gallery (YAGNI).

---

## nginx

Snapshots are larger than the 16k body cap the HA-alerts feature set on
`location /api/`. Rather than loosen that cap for all of `/api/` (which would
undo the alert hardening), add a **dedicated exact-match** location that wins for
the snapshot path and carries its own larger cap, proxying to the same sidecar:

```nginx
location = /api/snapshot {
  resolver 127.0.0.11 ipv6=off valid=30s;
  set $alert_up "alert-sidecar:8090";
  client_max_body_size 2m;
  proxy_pass http://$alert_up$request_uri;
}
```

The general `location /api/ { … }` (alerts) keeps its 16k cap. The snapshot
path's own byte cap is also enforced in the sidecar.

## Service worker

`config.json` is already network-first. No new cached shell entries except
`js/presence.js` (add to `SHELL_FILES`); bump the cache version.

## Testing

- **Sidecar (`unittest`):** snapshot auth fail-closed (no `SNAPSHOT_TOKEN` → 503),
  bad bearer → 401, oversized body → 413/400, non-jpeg → 415/400, happy path
  writes a file under `<profile>/`, retention prune deletes old/excess files.
  Token isolation: `ALERT_API_TOKEN` must NOT authorize `/api/snapshot` and vice
  versa.
- **Pure JS (Node `--test`):** `motionScore(prev, curr)` (no-change → ~0; large
  change → high), `presenceReducer` (motion → present; grace elapse → away; motion
  re-arms), snapshot cooldown gate (pure helper).
- **Device/manual:** on an actual iPhone in Safari over HTTPS — camera permission,
  red bar, motion brightens / stillness dims after grace, snapshot lands in the
  room's NAS folder, denial degrades to schedule-only.

## Non-goals (YAGNI)

- No face recognition / identity — motion presence only.
- No real screen power-off (iOS doesn't allow it from the web under Guided Access).
- No in-app snapshot gallery (browse on the NAS).
- No Web NFC code (impossible on iOS) — tags + Shortcuts only.
- No periodic/continuous snapshotting — one per arrival + cooldown.
- No multi-token/per-user snapshot auth — one shared `SNAPSHOT_TOKEN`.

## Risks & mitigations

- **Camera unreliable in Safari kiosk** (re-prompts, red bar) → opt-in, status
  line, backoff-retry, graceful fallback to schedule-only dimming.
- **Motion misses a still person** → grace window (90s) + instant re-wake on any
  motion; tunable threshold/grace constants.
- **Snapshot token visible to the kiosk page** → least-privilege (upload-only),
  trusted-LAN assumption documented, HTTPS-only.
- **NAS fills up** → per-upload size cap + age/count retention prune.
- **NAS down** → upload 5xx swallowed; clock + presence unaffected.
- **Guided Access can't power the screen** → documented; "off" = deep-dim, not
  backlight-off. Set expectations in the README.

## Affected / new files

- `js/presence.js` (new) — camera + `motionScore` + `presenceReducer` + snapshot
  capture/upload + dim hook.
- `test/presence.test.js` (new) — pure-unit tests.
- `js/app.js` — wire presence on/off, dim integration, `?profile=` persist+toast,
  read `snapshotToken` from config.
- `js/settings.js` — `presence`, `saveSnapshots` settings (+ URL params); persist.
- `index.html` / `css/styles.css` — Presence + Save-snapshots toggles; profile
  confirmation toast.
- `alert-sidecar/alert_sidecar.py` — `POST /api/snapshot` (token, validation,
  atomic write, retention).
- `alert-sidecar/test_alert_sidecar.py` — snapshot tests.
- `docker-compose.yml` — `SNAPSHOT_TOKEN` env, NFS `snapshots` volume → sidecar
  `/data/snapshots`.
- `docker-entrypoint.d/30-clock-config.sh` — emit `snapshotToken` into
  `config.json` when set.
- `nginx.conf` — raise `/api/` `client_max_body_size` to ~2m.
- `sw.js` — add `js/presence.js`; cache bump.
- `README.md` — kiosk setup (Guided Access), NFC tag + Shortcut, presence,
  snapshots + TrueNAS NFS setup, privacy notes.
