# Clock & Weather PWA

An always-on **clock** (digital or analog, user-toggleable) plus **current local weather**.
One vanilla HTML/CSS/JS codebase, **no build step, no dependencies** (except the free
[Open-Meteo](https://open-meteo.com/) HTTP API — no key, no signup).

It runs two ways from the **same files**:

- A **full-screen installed PWA** on retired phones/tablets (iOS, Android).
- A **plain bookmarked page** in TV browsers (Samsung Tizen, Amazon Fire TV Silk,
  Fire-TV-based Insignia) driven by a **D-pad remote only**. No install required —
  nothing is gated behind install, because TVs can't install.

Both orientations, any screen **320px → 4K**, with **zero element overlap, ever**
(the no-overlap is a property of the CSS Grid structure, not per-width breakpoints).

---

## Quick start (Docker)

The repo ships a tiny nginx image (no build step inside — it just serves the static files):

```bash
git clone https://github.com/chatwithllm/clock-pwa.git
cd clock-pwa
docker compose up -d          # or: docker build -t clock-pwa . && docker run -d -p 8080:80 clock-pwa
```

Then open **http://localhost:8080**.

### Set the server location (for a device fleet)

**Option A — env vars in compose** (default). Set them in `docker-compose.yml` and bring it up;
an entrypoint writes `config.json` at container start:

```yaml
environment:
  CLOCK_LAT: "39.7684"
  CLOCK_LON: "-86.1581"
  CLOCK_CITY: "Indianapolis"
```
```bash
docker compose up -d        # change the values and re-run to update
```

**Option B — mounted file** (edit live, no restart). Comment out the `environment:` block,
uncomment the `volumes:` mount, then edit `config.json` on the host (served no-cache, applies on
the next page load). Use one option or the other, not both.

```json
{ "location": { "lat": 39.7684, "lon": -86.1581, "city": "Indianapolis" } }
```

> **Don't edit the in-container `config.json` directly** (e.g. `docker exec … nano`). If
> `CLOCK_LAT`/`CLOCK_LON` are set, the entrypoint **overwrites** that file on the next restart and
> your edit is lost. Change the compose env vars (Option A) or the mounted host file (Option B).

In the app, **Settings → Location → Server** uses this. Devices that can't geolocate (TVs, or
boxes on a VLAN with no internet GPS) get the location from the server this way. A user can switch
**Location → Custom** and enter their own **US ZIP** (e.g. `46204`) or a **city name** instead.

### Device profiles + announcements

Give each display a **profile** (its room) in **Settings → Profile** (Theater Room, Kitchen, Study
Room, …; or `?profile=Kitchen`). Profiles are the basis for room-specific behavior — the first use
is **announcements**.

**Broadcast a message** the easy way — the **admin page** at **`http://<host>:8080/admin.html`**:
type a message, pick a target (All or a room), duration, optional icon, and hit *Send*. Every device
polls every ~15 s; a display only shows messages targeted to `all` or **its own profile**.
Announcements are now a **queue**: a single live message shows centered as a dimmed modal (dismissable
by tap / Enter / Escape, auto-hiding after its duration), exactly as before. When two or more live
messages are queued, the newest appears centered as a card while the rest stack in a top-right
notification tray (Apple-style), oldest at the top, each auto-dismissing on its own duration;
the tray is capped at 4 visible items and shows a **+N more** chip for any overflow. Sends via the
admin page append entries to `announce.json` (a JSON array); **Clear all** empties it for every
device within the next poll cycle. Dismissing a message on a display is local to that device (it
stays hidden there for the rest of its duration); other displays keep showing it until it expires.

Under the hood the admin page `PUT`s `announce.json` via nginx WebDAV — no extra backend. The CLI
helper does the same:

```bash
docker exec clock-pwa /usr/local/bin/announce.sh "Dinner is ready!"
docker exec clock-pwa /usr/local/bin/announce.sh "Movie starting" "Theater Room" 30
```

> The admin page is **unauthenticated** — keep it on a trusted LAN, or put basic-auth in front of
> `/admin.html` and the `PUT` on `/announce.json` if you expose it.

Announcements can now carry **rich media**. Attach an **image or GIF** via the admin page (the file
is stored on the container at `/uploads/`, so it works on offline LAN displays) or paste an external
URL — it appears below the message text in the card and as a small thumbnail in the notification
stack; a broken or missing URL degrades gracefully to text-only. You can also attach a **notification
chime** (choose Ding, Alert, or Chime) that plays once when the announcement appears — the tone is
synthesized in-browser, so no audio files are needed. Because browsers require a user gesture before
playing audio, each display must enable sound once via **Settings → Sound**; that preference is saved
in `localStorage` and persists across reloads.

### Critical alerts (Home Assistant)

A **bearer-authenticated push API** lets [Home Assistant](https://www.home-assistant.io/)
(or anything that can POST JSON) fire **real-time critical alerts** — water leak,
door open, security — onto every display. This is a **separate, urgent channel**
from announcements:

- **`critical`** → a full-screen **red overlay** that overrides night-dim, re-asserts
  the wake-lock, and repeats an urgent chime every 30s until cleared.
- **`warning`** → a non-blocking **amber banner** at the top, chimed once.

**Home Assistant owns each alert's lifecycle** via a stable `key`: it raises the
alert when a sensor trips and clears it when the sensor resets. Devices poll
`GET /alerts.json` every 5s; a missing/unreachable sidecar simply shows no alert —
the clock is never affected.

**Setup.** Set a shared token and rebuild:

```bash
# in docker-compose.yml (or a .env file) set a strong secret:
#   ALERT_API_TOKEN: "your-long-random-token"
ALERT_API_TOKEN=your-long-random-token docker compose up -d --build
```

A tiny zero-dependency **`alert-sidecar`** container owns the alert set; nginx
proxies the API and `/alerts.json` to it. **Use HTTPS** (see the `Caddyfile` in
this repo) so the bearer token isn't sent in clear text over the network.

**API** (all writes require `Authorization: Bearer <ALERT_API_TOKEN>`):

| Method & path | Body | Effect |
| --- | --- | --- |
| `POST /api/alert` | `{key, severity?, title, message, target?}` | Raise/refresh by `key` (`severity` `warning`\|`critical`, default `critical`; `target` a room profile or `all`) |
| `POST /api/alert/clear` | `{key}` | Clear that alert |
| `DELETE /api/alert?key=…` | — | Clear that alert |
| `GET /alerts.json` | — | Current active alerts (open, what devices read) |

**Home Assistant config** (`configuration.yaml`):

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
`off` → `clock_alert_clear`. Use `warning` for low-stakes events, `critical` for
safety. If HA ever fails to clear a stuck alert, the **admin page → Active Alerts**
card can clear it by hand.

### Custom profiles

Built-in room profiles (Theater Room, Kitchen, …) cover most setups. To add
your own (e.g. "Garage Gym"), open the admin page → **Custom profiles** →
type a name → **Add**. Custom profiles are stored server-side
(`/data/profiles.json`, written via authenticated WebDAV PUT) and appear in
every device's Settings → Profile picker within ~15s, as well as in the
announcement **Send to** list. Remove one with the ✕ on its chip. Built-in
rooms are always available even if the file is empty or missing.

### Server-pushed weather (for devices with no internet)

For displays on an isolated LAN/VLAN with **no internet of their own**, the container fetches
weather **on the server** and writes it to `weather.json`; those devices read it from this server
(same origin) instead of calling Open-Meteo themselves.

- The server needs internet; the **display devices do not**.
- It uses the same server location (`CLOCK_LAT/LON` or `config.json`), refreshes every 15 min
  (override with `WEATHER_INTERVAL` seconds), and is **on by default**. Disable with
  `WEATHER_FETCH=off`.
- Devices in **Location → Server** mode prefer `weather.json` automatically (and fall back to the
  direct API, then cache). **Custom**-location devices use the direct API (they need internet for
  their own location).

> **Precipitation-aware condition.** Open-Meteo's `weather_code` over-reports precipitation — it
> returns *thunderstorm* in hot, humid air even when no rain is falling and the chance is ~0%. The
> display corrects this: when a rain/storm code is reported but the current precipitation is **0 mm**
> and the next-hour probability is **< 30%**, it softens to a calm "… possible" label + icon + a calm
> backdrop instead of an active storm. It never hides a real storm (any active precip or a missing
> field shows the raw condition).

**One-click install:** because `localhost` is a secure context, the service worker registers
and Chrome/Edge show an **install icon** in the address bar — click it to install the PWA (or
on a phone over real HTTPS, *Add to Home Screen*). The nginx config serves the manifest with the
correct MIME type and keeps `sw.js` uncached so updates ship.

> To install from another device on your LAN (a phone) you still need **HTTPS** on the LAN IP —
> see *Hosting over LAN HTTPS* below. Put nginx/Caddy in front of this container for TLS, or use
> the cert recipe in that section. Over plain `http://<LAN-IP>` the clock + weather work but the
> service worker / install are blocked by the browser.

### Room awareness — NFC profiles

Dedicated iPhones placed around the house can auto-switch their **profile** (room)
when you dock them, using NFC. iOS has **no Web NFC API**, so the app never touches
NFC — iOS reads the tag and opens a URL; the app just consumes `?profile=`.

- **Kiosk setup:** run the clock in full-screen **Safari** (not an installed PWA —
  needed for the camera presence feature below), locked with **Guided Access**
  (Settings → Accessibility → Guided Access; triple-click the side button on the
  clock tab to lock). Set **Display Auto-Lock = Never** and enable **Mirror
  Display Auto-Lock** (otherwise iOS forces a 20-minute timeout). Serve over
  **HTTPS** (see *Hosting over LAN HTTPS*) — required for the camera.
- **NFC tag:** encode an NDEF **URL record** `https://<clock-host>/?profile=<room>`
  on a tag at each room's charger (URL-encode spaces, e.g. `Theater%20Room`). Place
  it where the phone's top back rests when docked.
- **Automatic switch:** create a per-phone **iOS Shortcuts Personal Automation** →
  *Automation → NFC → scan the tag → Open URL `https://<clock-host>/?profile=<room>`*,
  with **"Ask Before Running" off**. Docking the phone re-rooms the display with no
  prompt. (A plain NDEF-URL tap, which shows the system banner, is the no-Shortcut
  fallback.) The app shows a brief confirmation toast naming the room.

### Presence dimming + arrival snapshots (camera)

The front camera can dim the display when no one's around and (optionally) save a
photo of whoever walks up. Both are **opt-in and off by default**, and need
**HTTPS** + camera permission (iOS shows a permanent red "camera in use" bar).

> **Why Safari, not an installed PWA:** `getUserMedia` is unreliable in iOS
> home-screen PWAs — run the clock in Safari (Guided Access). On a MagSafe charger
> the phone is always powered, so the camera's battery cost is moot.

- **Presence dimming** — **Settings → Presence**. In-browser **motion** detection
  (no face recognition; iOS has no FaceDetector) brightens the clock when someone
  is near and **deep-dims** it after ~90 s of stillness; any motion re-wakes it
  instantly. It composes with the night schedule (dim if night **or** away).
  Frames are analyzed **on-device and never leave the phone**. Under Guided Access
  the app can't truly power the screen off, so "away" is a near-black, burn-in-safe
  screen (backlight stays on). Deny permission → it silently falls back to the
  schedule.
- **Arrival snapshots** — **Settings → Save snapshots** (this one *does* upload).
  Turning it on **starts the camera** even if Presence dimming is off (snapshots
  are captured by the same camera loop). One JPEG per arrival, 5-minute cooldown,
  stored to your NAS. Set a strong **`SNAPSHOT_TOKEN`** in `docker-compose.yml`
  (separate from `ADMIN_PASS` and `ALERT_API_TOKEN`; it can only upload snapshots).
  The kiosk reads it from `snapshot.json`. **Privacy:** this captures whoever
  approaches (household, guests) — you own that trade.
  > **LAN trust:** the snapshot token is served openly to the kiosk over the LAN
  > by design, and the sidecar only checks that uploads start with a JPEG marker.
  > Anyone on your network who reads that token could write images to the NAS
  > (bounded by the per-room retention cap). Keep it on a trusted LAN / behind
  > HTTPS; don't expose `/api/snapshot` or `/snapshot.json` to the internet.
- **TrueNAS / NAS setup:** create a dataset (e.g. `clock-snapshots`) and an **NFS
  share** scoped to the Docker host's IP, then fill the `snapshots` volume in
  `docker-compose.yml` (`addr=<truenas-ip>`,
  `device=:/mnt/<pool>/<dataset>/clock-snapshots`). SMB/CIFS or a host bind-mount
  work too. Browse images straight on the NAS — one subfolder per room. If the NAS
  is down, uploads fail quietly and nothing else breaks. Retention defaults: keep
  30 days / 1000 per room (`SNAPSHOT_RETENTION_DAYS`, `SNAPSHOT_MAX_PER_ROOM`),
  1 MiB per-image cap (`SNAPSHOT_MAX_BYTES`).

### Updating a deployed container

The image is built from source (no published registry image), so update = pull + rebuild on the
host that runs it:

```bash
cd clock-pwa
git pull
docker compose up -d --build     # rebuild image + recreate container in place
docker image prune -f            # optional: drop the old image layer
```

One-liner for routine updates:

```bash
cd clock-pwa && git pull && docker compose up -d --build && docker image prune -f
```

Verify it landed:

```bash
docker compose ps                 # container Up, recreated
git log --oneline -1              # matches GitHub HEAD
curl -s localhost:8080/config.json
```

Notes:
- **Keep your location out of the tracked compose file** so `git pull` never conflicts. Put your
  `CLOCK_LAT/CLOCK_LON/CLOCK_CITY` in a **`.env`** file or a **`docker-compose.override.yml`**
  (both are auto-loaded by compose and aren't overwritten by pulls). If you did edit
  `docker-compose.yml` directly, use `git stash` → `git pull` → `git stash pop`.
- **Client devices** (phones/TVs already open) cache via the service worker. After redeploy each
  device needs **one reload** to pick up the new versioned SW; future loads update automatically.

---

## Support floor (baseline)

Targeted floor: **iOS Safari 13.4+**, **Android 7+ WebView**, **Tizen**, **Fire TV Silk**.
At this floor `clamp()`, `min()`, `max()`, and CSS grid-gap are all safe and are used freely.

> **Do NOT target iOS 12** — `clamp()` silently fails there and the layout breaks.

Every modern API (Wake Lock, Geolocation, `matchMedia`, rAF) is **feature-detected**; the app
degrades silently and never throws. The **clock never depends on the network**.

The clock shows the **device's local time** by default, not the weather location's time.

**Time source (Settings → Time).** *Device* (default) uses each device's own system clock — so
displays disagree if their clocks aren't synced. *Server* syncs every display to the **host's clock**
(read from the HTTP `Date` header, round-trip corrected), so a whole fleet shows the **same time**
regardless of each device's clock — and it works on LAN with no internet (`?time=server` to preset).

**Source (Settings → Source).** A unified **Server / Local** toggle sets both time and weather **authority**
at once:
- **Server** (default) — time from host clock + weather & location from `config.json` / `weather.json`.
- **Local** — device clock + your own location (set via ZIP code, city search, or 'use my location');
  until you set one it falls back to a default city.

Admins can set a **default** source (applies on first load) or **force** the source globally via the
admin page — when forced, each device's Source toggle is disabled and shows "Managed by server". The
setting persists in `localStorage` on each device and obeys the same URL param preset (`?source=local`).
Server-fetched weather works on isolated LANs; Local mode requires the device to have internet for its
own location.

---

## File structure

```
clock-pwa/
  index.html
  manifest.webmanifest
  sw.js                # cache-first app shell; network-first w/ cache fallback for Open-Meteo
  css/styles.css
  js/app.js            # bootstrap, state-machine reducer, input routing, pixel-shift, dim
  js/clock.js          # SVG digital + analog rendering, rAF-vs-tick decision
  js/weather.js        # Open-Meteo fetch, WMO mapping, localStorage cache
  js/wakelock.js       # Wake Lock + video fallback (phone only), no-op on TV
  js/nav.js            # D-pad spatial focus nav (arrows/Enter/Escape), visible focus ring
  js/settings.js       # load/save settings + read config from URL query params
  icons/               # placeholder PNGs: 192, 512, maskable, apple-touch 180
  README.md
```

---

## Location setup (`?lat=&lon=` — zero text entry on TV)

Location precedence:

1. **URL params** `?lat=&lon=` (optional `&city=`) — explicit, highest priority.
2. **localStorage** (last saved).
3. **Geolocation** (only where available and permitted; e.g. phones over HTTPS).
4. **Editable default constant** in `js/settings.js` (`DEFAULT_LOCATION`, ships as New York).

For a TV, **bake the params into the hosted URL and hand the user a pre-built bookmark** so
the TV needs **zero text entry**. Example:

```
https://your-host.example/clock-pwa/?lat=40.7128&lon=-74.0060&city=New%20York&unit=F&mode=digital
```

Extra optional params: `unit=F|C`, `mode=digital|analog`, `hour=12|24`,
`orient=auto|portrait|landscape`, `display=plain|dynamic`, `sun=on|off`,
`clockstyle=classic|block`.

**Clock style** (Settings → Style) is separate from the digital/analog **mode**. In digital mode
you can pick **Classic** (the default split-flap flip clock) or **Block Matrix** (a dot-matrix LED
readout). The choice persists in localStorage (`clockStyle`, default `classic`) and obeys the same
12/24h, seconds, and night-dim settings. Analog mode is unaffected.

A **city search box** exists in Settings for touch devices, but it is **never the only way**
to set location — `?lat=&lon=` always works without typing.

---

## Hosting over LAN HTTPS (for phone install testing)

A service worker + Geolocation require a **secure context** (HTTPS or `localhost`).
To install on a phone on your LAN you need real HTTPS on the LAN IP. Quick options:

**Option A — self-signed cert with `http-server` (Node, global, not part of this project):**
```bash
# generate a cert (one time)
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=$(ipconfig getifaddr en0)"
# serve this folder over HTTPS
npx http-server ./clock-pwa -S -C cert.pem -K key.pem -p 8443 -a 0.0.0.0
# visit https://<your-LAN-IP>:8443/  on the phone, accept the cert warning
```

**Option B — `mkcert` for a locally-trusted cert (no browser warning):**
```bash
mkcert -install
mkcert $(ipconfig getifaddr en0) localhost 127.0.0.1
# then serve with any static HTTPS server pointed at the generated cert/key
```

> These tools are external dev conveniences — the project itself has **no** package.json,
> tooling, or dependency. You can host the folder with anything that serves static files
> over HTTPS.

---

## Plain HTTP (for TV testing)

TVs generally can't install and may choke on self-signed certs. Serve plain HTTP and bookmark it:

```bash
python3 -m http.server 8000 --directory ./clock-pwa
# visit http://<your-LAN-IP>:8000/?lat=..&lon=..  on the TV browser
```

> **Caveat — plain HTTP on a LAN IP:** browsers will **not** register the service worker or
> grant Geolocation over `http://<ip>`. The **clock still ticks** and the **weather cache still
> works** (last-known values from localStorage), but you get **no app-shell offline caching**.
> **True offline on a TV needs real HTTPS.**

---

## Installing

**iOS (Safari):** open the HTTPS URL → Share → *Add to Home Screen*. Launches full-screen
(`apple-mobile-web-app-capable`, `viewport-fit=cover`, status-bar style set).

**Android (Chrome):** open the HTTPS URL → menu → *Install app* / *Add to Home screen*.

---

## Opening on TV

**Samsung Tizen browser** and **Fire TV Silk** (incl. Fire-TV-based Insignia): open the browser,
go to your pre-built `?lat=&lon=` URL, and **bookmark it**. Navigate entirely with the remote:

- **Arrows** move the focus ring between controls.
- **Enter / OK** activates the focused control.
- **Back / Escape** closes the settings panel.

Interact once and the control band fades in; it auto-hides after ~5 seconds of no input.

> **Caveat — remote Back button:** on Tizen / Silk the remote **Back** button is often wired to
> browser history / app-exit and **cannot be reliably intercepted** by the page. Use the on-screen
> **Close** button to dismiss the settings panel.

**Disable the TV's screensaver / sleep timer** so the clock stays on:
- *Fire TV:* Settings → Display & Sounds → Screensaver → set Start Time to **Never** (and check
  Settings → Preferences → power/sleep).
- *Samsung/Tizen:* Settings → General/System → Power & Energy Saving → turn off auto-off /
  screensaver.

> **Roku TVs are explicitly NOT supported** — Roku has no web browser.

---

## Controls

- **Mode** — toggle digital ⇄ analog (persists in localStorage).
- **Unit** — toggle °F ⇄ °C live.
- **Dim** — manual near-black dim toggle.
- **Settings** — orientation (auto/portrait/landscape), **Display** (plain/dynamic), clock
  **Style** (classic/block), **Sun arc** (on/off), **Second clock** (curated timezone, subtle
  corner readout), **Source** (Server/Local authority), 12/24h, seconds on/off, date on/off,
  night-dim schedule (default **off**), **Location** (Server/Custom), ZIP/city search, and "Use my
  location" (Geolocation where available). Temperatures always show **both °F and °C**.

**Sun arc.** A small SVG in the weather card traces the sun from sunrise (left horizon) → solar
noon (apex) → sunset (right horizon), positioned by the current time of day. Elapsed portion is a
warm gold arc, the rest dashed-grey; the sun is a glowing dot that eases between positions and shows
hours-of-light remaining, dimming below the horizon at night. Sunrise/sunset come from the same
Open-Meteo call (no extra request, cached offline). It's toggleable (`sun=on|off`) and never affects
the clock. Note: sun times are in the **weather location's** timezone while the clock shows
**device-local** time — exact when those match (the normal case), slightly off for a far-away city.

**Second clock.** Pick a city / timezone under **Settings → Second**; a small corner badge shows
its **current time** with a **day offset hint** (e.g., `+1d` or `−1d` if the day differs from your
device's local date) and a **tiny temperature chip** (if in Dynamic mode and the device has internet
for that city's weather). The badge digits are tinted to **that city's own weather-feel colors**,
independent of the primary location — so you can see at a glance if it's cold or hot where your
colleague is. The second city requires device internet to fetch weather; a clock remains readable even
if that fetch fails.

**Display: Plain vs Dynamic.** *Plain* (default) is static white text on near-black. *Dynamic* tints
the text to the current condition and draws an animated weather backdrop driven by the WMO code —
drifting clouds, falling rain, snow, fog haze, a warm sun glow, or thunder flashes. It's kept
low-brightness and always moving (burn-in-safe), **pauses in night-dim**, and is **disabled on
`prefers-reduced-motion`** and throttled on TV-class / weak devices. Purely decorative — the clock
never depends on it.

*Dynamic* mode also **tints clock digits and hands to "weather feel"** — a blend of temperature and
humidity:
  - **−5°C and below:** icy cyan-blue (winter)
  - **5°C:** blue (cold)
  - **14°C:** teal (cool)
  - **21°C:** green (mild)
  - **27°C:** amber (warm)
  - **33°C and above:** orange-red (hot)

Humid air desaturates the color and pulls warmer temps slightly toward muggy green. The **animated
backdrop remains sky-condition-based** (rain, snow, clouds, sun) — color reflects the *feel* while
backdrop reflects the *weather*. The second-clock badge (if shown) is also tinted to **its own city's
weather**, independent of the primary location.

US defaults: **°F** and **12-hour**, both switchable live.

---

## Always-on / burn-in protection

- **Wake Lock** keeps the screen on (phones), re-acquired on `visibilitychange`. Where Wake Lock
  is missing it falls back to a hidden muted looping inline **H.264 MP4** video (iOS can't play
  WebM). On **TV it no-ops** (no video hack). Tap once to see the **status dot** in the control band:
  green *Awake* = held, amber *May sleep* = not held.
- **Near-black dark theme** default; no large bright static fills.

> **Keeping an iPhone awake.** A PWA can't match a native app's idle-timer control — it relies on
> the Wake Lock API, which needs all of: **HTTPS** (blocked on plain `http://<LAN-IP>`),
> **iOS 16.4+**, the app **in the foreground**, and **Low Power Mode off**. For a guaranteed
> always-on kiosk, also set **iOS → Settings → Display & Brightness → Auto-Lock → Never** and keep
> the device on power. The MP4 video fallback helps over plain HTTP / older iOS, but HTTPS + Wake
> Lock is the reliable path. If the status dot is amber, one of the conditions above isn't met.
- **Pixel-shift** nudges the whole layout every 60s within the title-safe inset slack, so burn-in
  shifting never reaches a true screen edge.
- **`prefers-reduced-motion`** disables both the analog second-hand sweep and the pixel-shift.
- Optional **night-dim schedule** (default off; editable hours in `js/settings.js`).

---

## How "TV vs phone" is decided

There is no clean signal, so the app **combines**: screen size + a measured ~500ms rAF FPS sample
+ `(hover:none)` / `(pointer:coarse)`. On **any doubt it falls back to a 1Hz tick** (cheaper, safe
on weak WebViews). It does **not** rely on UA strings. The smooth second-hand sweep runs only on
phone-class devices with good measured FPS and no reduced-motion preference.

---

## Serving locally — quick commands

```bash
# Plain HTTP (TV testing, no SW/Geolocation):
python3 -m http.server 8000 --directory ./clock-pwa
#   → http://<LAN-IP>:8000/?lat=40.7128&lon=-74.0060&city=New%20York

# HTTPS (phone install testing, SW + Geolocation work):
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=localhost"
npx http-server ./clock-pwa -S -C cert.pem -K key.pem -p 8443 -a 0.0.0.0
#   → https://<LAN-IP>:8443/
```

(`http-server` / `openssl` / `mkcert` are external conveniences — not part of this project.)
