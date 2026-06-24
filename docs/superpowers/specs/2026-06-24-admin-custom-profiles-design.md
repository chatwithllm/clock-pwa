# Admin-managed custom profiles

**Date:** 2026-06-24
**Status:** Approved (design)

## Problem

Device room profiles (Theater Room, Kitchen, …) are hardcoded in two
places — the device cycle list (`js/app.js`) and the admin targeting
dropdown (`admin.html`). They are never shared; they only happen to match
as strings via `announce.json`'s `target` field. There is no way to add a
room name without editing and redeploying code. The admin should be able
to create custom profiles, and those customs must appear in each device's
own Profile picker so a user there can self-assign.

## Approach

Introduce a shared, admin-managed list of **custom** profile names,
persisted to `/data/profiles.json` and served by nginx like
`announce.json`. The built-in 7 rooms + `None` stay hardcoded in both the
device and admin code, so the system still works if the file is missing,
empty, or corrupt. The file holds only the admin's custom additions; the
effective list is `None + builtins + customs` (deduped).

### Why customs-only (not whole list)

Storing only customs keeps the built-ins guaranteed-present in code. An
empty or corrupt `profiles.json` degrades to the original 7-room behavior
instead of an empty picker.

## Data

`/data/profiles.json`:

```json
{ "profiles": ["Garage Gym", "Patio"] }
```

- `profiles`: array of custom names (strings). May be empty.
- Default shipped in image: `{ "profiles": [] }`.

Built-in constants (unchanged, in code):
`BUILTINS = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage']`
Device cycle list = `['None', ...BUILTINS, ...customs]` deduped.
Admin target dropdown = `['All', ...BUILTINS, ...customs]`.

## Components

### nginx (`nginx.conf`)
Add a `location = /profiles.json` mirroring `announce.json`:
- `root /data;`
- `default_type application/json;`
- no-cache headers, `expires off;`
- `dav_methods PUT;`, `create_full_put_path off;`,
  `client_body_temp_path /data/tmp;`, `client_max_body_size 64k;`
- `limit_except GET { include /etc/nginx/admin_auth.conf; }`
  → device GET is open, PUT requires admin basic-auth (same as announce).

### Dockerfile
Ship a default `/data/profiles.json` = `{ "profiles": [] }` so a device
GET never 404s before the admin first writes the file. Place alongside the
existing `COPY announce.json /data/announce.json` so the `mkdir -p
/data/tmp && chown -R nginx:nginx /data` step covers it.

### Admin page (`admin.html`)
- On load: GET `profiles.json`, render current customs.
- New "Manage profiles" section:
  - text input + **Add** button (trim, ignore empty, ignore duplicates of
    builtins or existing customs, case-insensitive compare).
  - list of customs, each with a **✕ remove** control.
- Add/remove mutates the in-memory custom array, then PUT `profiles.json`
  (`{ "profiles": [...] }`) — reuses the browser-cached basic-auth, same
  as the announcement PUT. Surface HTTP errors in a status line.
- The announcement **target** dropdown is rebuilt from
  `['All', ...BUILTINS, ...customs]` after every load/add/remove.

### Device (`js/app.js`)
- Replace the hardcoded `PROFILES` array with a function that returns
  `['None', ...BUILTINS, ...customs]` from current state.
- Fetch `profiles.json` on app load and on the existing announcement poll
  tick (no new timer). Cache the customs array to `localStorage` for
  offline reuse; on fetch failure, fall back to the cached value, then to
  `[]`.
- Tapping the Profile button cycles the current effective list.
- If a device's saved profile is a custom that was later removed, keep
  displaying it (do not silently reset to None). Cycling still works — the
  current value is treated as a transient extra entry so the cycle never
  gets stuck on a value missing from the list.

## Data flow

```
admin.html --PUT /profiles.json (auth)--> /data/profiles.json
                                                |
device --GET /profiles.json (open)-------------+
   effective list = None + builtins + customs
   user taps Profile -> cycles -> saved to device localStorage
announce.json target matches device profile string -> banner shows
```

## Error handling

- `profiles.json` missing/404 → device uses cached or empty customs →
  builtins still available.
- Corrupt/invalid JSON → treat as empty customs (try/catch), log, keep
  builtins.
- PUT fails (401/5xx) → admin status line shows the HTTP code; in-memory
  list reverts to last-saved so UI matches server.
- Duplicate/empty custom name on add → ignored, no PUT.

## Testing

Manual, via the running container (mirrors the auth test matrix already
used):
- GET `/profiles.json` open (200) before and after a PUT.
- PUT `/profiles.json` without creds → 401; with creds → 204.
- Add a custom in admin → appears in admin target dropdown.
- Device loads → custom appears in Profile cycle; tap selects it.
- Remove custom in admin → device drops it on next poll, but a device
  currently set to it keeps showing it.
- Empty/missing file → device shows exactly `None + 7 builtins`.

## Out of scope (YAGNI)

- Per-device naming pushed from admin (admin only edits the shared list;
  the device user still self-assigns).
- Renaming/reordering builtins.
- Profile metadata beyond the name string.
