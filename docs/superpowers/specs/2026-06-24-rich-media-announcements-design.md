# Rich-media announcements (image/GIF + synthesized chimes)

**Date:** 2026-06-24
**Status:** Approved (design)

## Problem

Announcements are text-only. We want an admin to optionally attach an
image or GIF and a notification chime. Displays may sit on an offline LAN,
so media must be hostable on the container, and there is no backend — only
nginx WebDAV PUT, the same mechanism `announce.json` already uses.

## Approach

Two optional fields on each announcement object:
- `image` — a `/uploads/…` path (uploaded to the container) or an external
  URL. Rendered in the announcement.
- `sound` — a preset chime name (`"none" | "ding" | "alert" | "chime"`).
  **Synthesized in-browser via Web Audio** (oscillator); no audio files are
  shipped or uploaded, so it works offline with zero binary assets.

Images are uploaded by the admin page via WebDAV PUT to a new
auth-protected `/uploads/` location (or referenced by URL). Audio requires
a one-time user gesture to satisfy browser autoplay policy; a Settings
toggle provides it.

Both fields are optional — absent means today's behavior, so this is purely
additive and back-compatible with the existing queue.

## Data

Announcement object (existing fields unchanged), two new optional fields:

```json
{
  "id": "1750000000-12", "text": "Dinner is ready!", "icon": "🍽️",
  "ts": 1750000000000, "duration": 30, "target": "all", "from": "",
  "image": "/uploads/1750000000-4821.gif",
  "sound": "chime"
}
```

- `image` (optional string): `/uploads/<name>` or an `http(s)://…` URL.
  Absent/empty → no image.
- `sound` (optional string): one of `none|ding|alert|chime`. Absent or
  `none` → no chime.
- The queue file (`announce.json`) format is unchanged (still the array
  from the stacked-announcements feature); only per-entry fields are added.

### Uploads

- nginx serves and accepts `/uploads/` from the writable `/data/uploads`
  dir (Docker creates it, nginx-owned).
- Upload name: `<ts>-<rand>.<ext>`, where `<ext>` derives from the file's
  MIME/type (`png|jpg|jpeg|gif|webp`). The admin page builds the name,
  PUTs the bytes, then writes that `/uploads/<name>` path into the
  announcement's `image` field.
- Max upload size: **8 MB** (enforced by nginx `client_max_body_size` on
  the `/uploads/` location; `announce.json`'s 64k limit is unchanged).

## Components

### nginx (`nginx.conf`)
Add a `location /uploads/` (prefix match) that mirrors the announce auth
split:
- `root /data;` (so `/uploads/x` → `/data/uploads/x`)
- `add_header Cache-Control "public, max-age=31536000, immutable";`
  (upload names are unique/immutable)
- `dav_methods PUT DELETE;`, `create_full_put_path on;`,
  `client_body_temp_path /data/tmp;`, `client_max_body_size 8m;`
- `limit_except GET { include /etc/nginx/admin_auth.conf; }` — open GET
  (devices fetch), auth required for PUT/DELETE.

### Dockerfile
`mkdir -p /data/uploads` alongside the existing `/data/tmp` so it is
covered by the current `chown -R nginx:nginx /data`. Default image ships
with an empty uploads dir.

### Device — image (`js/app.js`, `index.html`, `css/styles.css`)
- `index.html`: add an `<img id="announceImage" hidden>` inside the center
  `.announce-box` (below the text body). Toasts get an optional leading
  `<img class="toast-thumb">` built in the stack HTML.
- `renderAnnounce()`:
  - Center: if `center.image` is a non-empty string, set
    `#announceImage.src` (escaped) and unhide it; else hide and clear src.
  - Toast HTML: if `a.image`, prepend `<img class="toast-thumb" src="…">`
    with the URL HTML-escaped in the attribute (alongside the existing
    `escHtml` of text/icon/sub).
- `css/styles.css`: `.announce-box` image — `max-height:38vh; max-width:100%;
  object-fit:contain; border-radius`. `.toast-thumb` — small fixed box
  (e.g. 40×40), `object-fit:cover`, rounded. Card-mode image inherits the
  non-modal layout.

### Device — chimes (`js/app.js`)
- Web Audio synth. A single `AudioContext` (`app._audioCtx`), created/resumed
  only on the Settings unlock gesture.
- `playChime(name)`:
  - `ding` → one ~880 Hz sine, ~150 ms, quick decay.
  - `alert` → two ~660 Hz beeps, ~120 ms each, ~80 ms gap.
  - `chime` → ascending triad (e.g. 523/659/784 Hz), ~120 ms each.
  - Uses a gain envelope to avoid clicks; wrapped in try/catch; no-op if
    `name` is falsy/`none`, audio not enabled, or no `AudioContext`.
- A chime fires **once** when an announcement with a `sound` first becomes
  the rendered center (track the last-sounded id so re-renders/promotions
  don't replay it; reuse the dismissed/seen pattern — a `app._soundedIds`
  Set, pruned to the queue like the dismissed-set).

### Device — audio unlock (`js/app.js`, `index.html`)
- Settings panel gains a **Sound** row with an Enable/Disable button
  (`#setSound`), mirroring the existing toggle rows (e.g. `#setNight`).
- Tapping it: lazily create `AudioContext`, call `.resume()`, set
  `app.settings.soundEnabled = true`, persist via the existing settings
  store, and play a short `ding` as confirmation. Tapping again disables
  (`soundEnabled=false`).
- `soundEnabled` defaults to `false` and is added to the settings schema
  + defaults (so it round-trips through `loadSettings`/`saveSettings`).
- On load, if `soundEnabled` is true the context is created lazily on the
  first chime attempt (a reload loses the prior gesture; many browsers
  still allow resume if the user has interacted with the origin before —
  best-effort; the toggle re-arms it explicitly).

### Admin (`admin.html`)
- **Image:** a file input (`accept="image/*"`), an optional URL text field,
  and a small preview `<img>`. On Send:
  1. If a file is selected, build `<ts>-<rand>.<ext>` and
     `PUT /uploads/<name>` with the file bytes (reuses browser-cached
     basic-auth, like the announce PUT). On success, set `obj.image` to
     `/uploads/<name>`.
  2. Else if the URL field is non-empty, set `obj.image` to it.
  3. Else no image.
  Then append to the queue and PUT `announce.json` as today.
- **Sound:** a dropdown (None / Ding / Alert / Chime) → `obj.sound`. A
  **Test** button plays the selected chime locally (its click satisfies the
  gesture; admin page creates its own short-lived AudioContext for preview).
- Surface upload errors in the status line; if the image upload fails, do
  not send the announcement (so a broken `image` path is never queued).

### Service worker (`sw.js`)
Add `/uploads/` to a **cache-first** runtime rule (names are immutable):
serve from cache if present, else fetch and cache. Bump the cache version
(`v13` → `v14`) so the new SW activates. Synth audio needs no caching.

## Error handling

- Image fails to load on a device (`<img>` error) → hide the broken image,
  keep showing text (an `onerror` handler clears/hides the element). Never
  blocks the announcement.
- Upload PUT fails (401/413/5xx/network) → admin status line shows the
  HTTP code; the announcement is **not** queued.
- `client_max_body_size` exceeded → nginx returns 413; surfaced as an
  "image too large (max 8 MB)" hint in the admin status.
- Audio: every Web Audio call is wrapped in try/catch; a blocked/locked
  context simply produces no sound, never an error.
- Missing/empty `image`/`sound` → rendered exactly like a text-only
  announcement (full back-compat).

## Testing

Manual (curl + Playwright), matching prior features. No automated framework.

Server/curl:
- `PUT /uploads/test.png` without auth → 401; with auth → 201/204; `GET
  /uploads/test.png` open → 200; `DELETE` with auth → 204.
- A >8 MB body → 413.
- `announce.json` still accepts the array (unchanged) with `image`/`sound`
  fields present.

Browser (Playwright, against the running container; admin tested via a
no-auth throwaway instance on a spare port, as with prior features):
- Send an announcement with an uploaded GIF → device center card shows the
  animating GIF below the text; in 2+ mode the toast shows a thumbnail.
- Send with an external image URL → renders (when reachable).
- Broken image URL → text still shows, no broken-image box.
- Settings → Sound: Enable → a confirmation ding plays; toggle persists
  across reload (setting round-trips).
- Send with `sound:"chime"` while enabled → chime plays once on show, not
  again on re-render/promotion. While disabled → silent.
- Reduce-motion unaffected (audio/image independent of motion).

## Out of scope (YAGNI)

- Audio file uploads / custom sounds (presets only, synthesized).
- Auto garbage-collection of orphaned uploads (manual `docker exec`
  cleanup; admin can DELETE individual uploads).
- Video, multiple images per announcement, image captions.
- Per-device volume control.
