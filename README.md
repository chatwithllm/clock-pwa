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

In the app, **Settings → Location → Server** uses this. Devices that can't geolocate (TVs, or
boxes on a VLAN with no internet GPS) get the location from the server this way. A user can switch
**Location → Custom** and enter their own **US ZIP** (e.g. `46204`) or a **city name** instead.

**One-click install:** because `localhost` is a secure context, the service worker registers
and Chrome/Edge show an **install icon** in the address bar — click it to install the PWA (or
on a phone over real HTTPS, *Add to Home Screen*). The nginx config serves the manifest with the
correct MIME type and keeps `sw.js` uncached so updates ship.

> To install from another device on your LAN (a phone) you still need **HTTPS** on the LAN IP —
> see *Hosting over LAN HTTPS* below. Put nginx/Caddy in front of this container for TLS, or use
> the cert recipe in that section. Over plain `http://<LAN-IP>` the clock + weather work but the
> service worker / install are blocked by the browser.

---

## Support floor (baseline)

Targeted floor: **iOS Safari 13.4+**, **Android 7+ WebView**, **Tizen**, **Fire TV Silk**.
At this floor `clamp()`, `min()`, `max()`, and CSS grid-gap are all safe and are used freely.

> **Do NOT target iOS 12** — `clamp()` silently fails there and the layout breaks.

Every modern API (Wake Lock, Geolocation, `matchMedia`, rAF) is **feature-detected**; the app
degrades silently and never throws. The **clock never depends on the network**.

The clock shows the **device's local time**, not the weather location's time.

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
  corner readout), 12/24h, seconds on/off, date on/off, night-dim schedule (default **off**),
  **Location** (Server/Custom), ZIP/city search, and "Use my location" (Geolocation where available).
  Temperatures always show **both °F and °C**.

**Sun arc.** A small SVG in the weather card traces the sun from sunrise (left horizon) → solar
noon (apex) → sunset (right horizon), positioned by the current time of day. Elapsed portion is a
warm gold arc, the rest dashed-grey; the sun is a glowing dot that eases between positions and shows
hours-of-light remaining, dimming below the horizon at night. Sunrise/sunset come from the same
Open-Meteo call (no extra request, cached offline). It's toggleable (`sun=on|off`) and never affects
the clock. Note: sun times are in the **weather location's** timezone while the clock shows
**device-local** time — exact when those match (the normal case), slightly off for a far-away city.

**Display: Plain vs Dynamic.** *Plain* (default) is static white text on near-black. *Dynamic* tints
the text to the current condition and draws an animated weather backdrop driven by the WMO code —
drifting clouds, falling rain, snow, fog haze, a warm sun glow, or thunder flashes. It's kept
low-brightness and always moving (burn-in-safe), **pauses in night-dim**, and is **disabled on
`prefers-reduced-motion`** and throttled on TV-class / weak devices. Purely decorative — the clock
never depends on it.

US defaults: **°F** and **12-hour**, both switchable live.

---

## Always-on / burn-in protection

- **Wake Lock** keeps the screen on (phones), re-acquired on `visibilitychange`. Where Wake Lock
  is missing it falls back to a hidden muted looping inline video. On **TV it no-ops** (no video hack).
- **Near-black dark theme** default; no large bright static fills.
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
