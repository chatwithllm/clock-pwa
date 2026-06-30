# HACS Integration (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Home Assistant send/clear typed clock alerts and see per-room presence + active alerts, via a HACS custom integration that polls the clock sidecar.

**Architecture:** Two repos. **clock-pwa** (existing) gains presence-state storage + a `GET /presence.json` endpoint + a device presence heartbeat. A **new repo `clock-pwa-ha`** holds a standard HA custom integration (config flow, polling `DataUpdateCoordinator`, `send_alert`/`clear_alert` services, `sensor.clock_active_alerts`, dynamic `binary_sensor.clock_presence_<room>`).

**Tech Stack:** Python 3 stdlib (sidecar), vanilla JS (clock), nginx; Home Assistant custom integration (Python, `aiohttp` via HA, `DataUpdateCoordinator`); tests = Python `unittest` (sidecar), Node `--test` (clock), `pytest` + `pytest-homeassistant-custom-component` (integration).

**Phasing:** Phase A = Tasks 1–3 (clock-pwa: presence pollable end-to-end). Phase B = Tasks 4–8 (new integration repo). Ship A first (the integration depends on `/presence.json`).

## Global Constraints

- **The clock must never break.** New sidecar paths + the heartbeat are wrapped; failure degrades silently.
- **Reuse, don't fork:** extend `_handle_presence` (add storage) and the existing `postPresence`; the HA relay path stays unchanged.
- **Sidecar = Python stdlib only.** Integration = standard HA (no exotic deps).
- **Auth:** writes (`send_alert`/`clear_alert`) use bearer `ALERT_API_TOKEN`; reads (`/alerts.json`, `/presence.json`) are open (as today).
- **Presence freshness:** the device heartbeat (~2 min) keeps `ts` fresh; the integration marks a room `unavailable` when `now - ts > PRESENCE_TTL` (300 s).
- **HACS-valid:** integration passes `hassfest` + HACS validation; public repo with a description; `manifest.json` has a SemVer `version` and `config_flow: true`.
- **New repo lives at `~/dev/active/clock-pwa-ha`** (per the ~/dev layout rules).

---

### Task 1: Sidecar presence store + `GET /presence.json`

**Files:**
- Modify: `alert-sidecar/alert_sidecar.py`
- Modify: `alert-sidecar/test_alert_sidecar.py`

**Interfaces:**
- Produces: `_handle_presence` records `{room: {present, ts}}` (every valid POST, regardless of relay); `GET /presence.json` returns that map; pure `presence_view(store) -> dict`. Env `PRESENCE_FILE` (default `/data/presence.json`).

- [ ] **Step 1: Write the failing tests** (append to `PresenceTests` in `test_alert_sidecar.py`)

```python
    def test_presence_stored_and_served(self):
        A.HA_WEBHOOK_URL = ""              # storage must work even with no relay
        A.PRESENCE_FILE = self.tmpfile()   # see helper below
        A._presence.clear()
        self._post({"room": "Kitchen", "present": True})
        self._post({"room": "Theater", "present": False})
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/presence.json") as r:
            m = json.load(r)
        self.assertTrue(m["Kitchen"]["present"])
        self.assertFalse(m["Theater"]["present"])
        self.assertIn("ts", m["Kitchen"])

    def test_presence_view_pure(self):
        store = {"Kitchen": {"present": True, "ts": 5}}
        self.assertEqual(A.presence_view(store), {"Kitchen": {"present": True, "ts": 5}})
```

Add a `tmpfile` helper to the test class (so `PRESENCE_FILE` writes don't collide):
```python
    def tmpfile(self):
        import tempfile, atexit, os
        fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd)
        atexit.register(lambda: os.path.exists(p) and os.unlink(p))
        return p
```

- [ ] **Step 2: Run to verify failure**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: FAIL — `_presence`/`presence_view`/`/presence.json` undefined.

- [ ] **Step 3: Implement** in `alert_sidecar.py`

Add env + state near the other globals (after `HA_WEBHOOK_URL`):
```python
PRESENCE_FILE = os.environ.get("PRESENCE_FILE", "/data/presence.json")
_presence = {}        # room -> {"present": bool, "ts": int}; guarded by _lock
```

Seed `_presence` from disk at startup (after the helpers are defined, near module load — put it just before `def main()`):
```python
def _load_presence():
    try:
        with open(PRESENCE_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            _presence.update(data)
    except (FileNotFoundError, ValueError, OSError):
        pass
```

Pure view + an atomic writer for the presence map (reuse the tempfile+replace pattern):
```python
def presence_view(store):
    return {k: {"present": bool(v.get("present")), "ts": int(v.get("ts", 0))}
            for k, v in store.items() if isinstance(v, dict)}

def _write_presence():
    d = os.path.dirname(PRESENCE_FILE) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".presence.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(_presence, f)
        os.replace(tmp, PRESENCE_FILE)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
```

In `_handle_presence`, store BEFORE the relay early-return (so storage happens with or without a webhook). Replace the body from the validation line down to the relay:
```python
        if not isinstance(room, str) or not PROFILE_RE.match(room) or not isinstance(present, bool):
            return self._json(400, {"error": "room (profile) + present(bool) required"})
        with _lock:
            _presence[room] = {"present": present, "ts": now_ms()}
            _write_presence()
        if not HA_WEBHOOK_URL:
            return self._json(200, {"ok": True, "relayed": False})
        try:
            data = json.dumps({"room": room, "present": present}).encode()
            req = urllib.request.Request(HA_WEBHOOK_URL, data=data,
                                         headers={"Content-Type": "application/json"}, method="POST")
            with _RELAY_OPENER.open(req, timeout=4):
                pass
            return self._json(200, {"ok": True, "relayed": True})
        except Exception:
            return self._json(200, {"ok": True, "relayed": False})
```

Serve it in `do_GET` (add before the 404):
```python
        if path == "/presence.json":
            with _lock:
                return self._json(200, presence_view(_presence))
```

Call `_load_presence()` at the start of `main()`:
```python
def main():
    _load_presence()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
```
(If `main()` differs, just ensure `_load_presence()` runs once before serving.)

- [ ] **Step 4: Run to verify pass**

Run: `cd alert-sidecar && python3 -m unittest test_alert_sidecar -v`
Expected: PASS, pristine output.

- [ ] **Step 5: Commit**

```bash
git add alert-sidecar/alert_sidecar.py alert-sidecar/test_alert_sidecar.py
git commit -m "feat: sidecar stores presence state + serves GET /presence.json"
```

---

### Task 2: Device presence heartbeat

**Files:**
- Modify: `js/app.js`

**Interfaces:**
- Consumes: `postPresence`, `startPresence`/`stopPresence`, `app.presentNow`.
- Produces: a `PRESENCE_HEARTBEAT_MS` re-post timer (`app._presenceHeartbeat`).

- [ ] **Step 1: Add the heartbeat** in `js/app.js`

Add a constant near `PRESENCE_POST_MIN_MS`:
```js
const PRESENCE_HEARTBEAT_MS = 120000;   // re-post current presence every 2 min (keeps server ts fresh)
```

Add `_presenceHeartbeat: null,` to the `app` object literal (near `_lastPresencePostMs`).

In `startPresence()`, after `app.presence.start();`, start the heartbeat:
```js
    if (!app._presenceHeartbeat){
      app._presenceHeartbeat = setInterval(() => { try { postPresence(app.presentNow); } catch(_){} }, PRESENCE_HEARTBEAT_MS);
    }
```

In `stopPresence()`, clear it (before/after the existing teardown):
```js
    if (app._presenceHeartbeat){ clearInterval(app._presenceHeartbeat); app._presenceHeartbeat = null; }
```

(`postPresence` already skips when `profile === 'None'` and is fully wrapped, so the heartbeat inherits those guards.)

- [ ] **Step 2: Verify**

```bash
node --check js/app.js && echo OK
node --test    # 36/36 (unchanged)
```
Static check: the heartbeat is started only in `startPresence` and cleared in `stopPresence`; it calls `postPresence(app.presentNow)` (current state). Describe in the report.

- [ ] **Step 3: Commit**

```bash
git add js/app.js
git commit -m "feat: presence heartbeat re-posts current state every 2 min (keeps server ts fresh)"
```

---

### Task 3: nginx `/presence.json` + full-stack verify

**Files:**
- Modify: `nginx.conf`

- [ ] **Step 1: Add the proxy** — in `nginx.conf`, after the `location = /alerts.json { … }` block, add an identical block for presence:

```nginx
  # Current presence state (room -> {present, ts}); served by the sidecar, open GET.
  location = /presence.json {
    resolver 127.0.0.11 ipv6=off valid=30s;
    set $alert_up "alert-sidecar:8090";
    proxy_pass http://$alert_up/presence.json;
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
  }
```

- [ ] **Step 2: Full-stack verify** (Docker; host port 8090 is taken by another container — the sidecar publishes none, fine)

```bash
cd /Users/assistant/dev/active/clock-pwa
ALERT_API_TOKEN=t docker compose up -d --build
sleep 5
curl -s -XPOST localhost:8080/api/presence -H 'Content-Type: application/json' -d '{"room":"Kitchen","present":true}'   # {"ok":true,...}
curl -s localhost:8080/presence.json     # {"Kitchen": {"present": true, "ts": ...}}
docker compose down
```
Expected: `/presence.json` (via nginx → sidecar) reflects the posted room. (If Docker is unavailable, validate `nginx.conf` syntax with the nginx-alpine `nginx -t` recipe used in prior tasks, plus Task 1's unit tests.)

- [ ] **Step 3: Commit**

```bash
git add nginx.conf
git commit -m "feat: proxy GET /presence.json to the sidecar"
```

---

### Task 4: Scaffold the HACS integration repo + config flow

**Files (new repo `~/dev/active/clock-pwa-ha`):**
- Create: `hacs.json`, `README.md`, `.github/workflows/validate.yml`
- Create: `custom_components/clock_pwa/{__init__.py, manifest.json, const.py, config_flow.py, strings.json}`
- Create: `tests/{conftest.py, test_config_flow.py}`, `requirements_test.txt`

**Interfaces:**
- Produces: domain `clock_pwa`; config entry with `data = {base_url, api_token}`; `const.py` exports `DOMAIN`, `DEFAULT_SCAN_INTERVAL=15`, `PRESENCE_TTL=300`.

- [ ] **Step 1: Create the repo + skeleton files**

```bash
mkdir -p ~/dev/active/clock-pwa-ha/custom_components/clock_pwa ~/dev/active/clock-pwa-ha/.github/workflows ~/dev/active/clock-pwa-ha/tests
cd ~/dev/active/clock-pwa-ha && git init -q
```

`hacs.json`:
```json
{ "name": "Clock PWA", "homeassistant": "2024.1.0", "render_readme": true }
```

`custom_components/clock_pwa/manifest.json`:
```json
{
  "domain": "clock_pwa",
  "name": "Clock PWA",
  "version": "0.1.0",
  "config_flow": true,
  "documentation": "https://github.com/chatwithllm/clock-pwa-ha",
  "issue_tracker": "https://github.com/chatwithllm/clock-pwa-ha/issues",
  "codeowners": ["@chatwithllm"],
  "iot_class": "local_polling",
  "integration_type": "hub",
  "requirements": []
}
```

`custom_components/clock_pwa/const.py`:
```python
DOMAIN = "clock_pwa"
CONF_BASE_URL = "base_url"
CONF_API_TOKEN = "api_token"
DEFAULT_SCAN_INTERVAL = 15   # seconds
PRESENCE_TTL = 300           # seconds a room stays "available" without a fresh ts
```

`custom_components/clock_pwa/strings.json`:
```json
{
  "config": {
    "step": {
      "user": {
        "title": "Clock PWA",
        "data": { "base_url": "Base URL (e.g. https://clock.example.com)", "api_token": "Alert API token" }
      }
    },
    "error": { "cannot_connect": "Could not reach the clock host (/api/health failed)." },
    "abort": { "already_configured": "This clock host is already configured." }
  }
}
```

- [ ] **Step 2: Write the failing config-flow test**

`tests/requirements_test.txt`:
```
pytest-homeassistant-custom-component
```

`tests/conftest.py`:
```python
import pytest

@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
```

`tests/test_config_flow.py`:
```python
from unittest.mock import patch
from homeassistant import config_entries
from custom_components.clock_pwa.const import DOMAIN

async def test_user_flow_ok(hass):
    with patch("custom_components.clock_pwa.config_flow._async_validate", return_value=None):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"base_url": "https://clock.example.com", "api_token": "tok"})
    assert result["type"] == "create_entry"
    assert result["data"]["base_url"] == "https://clock.example.com"

async def test_user_flow_cannot_connect(hass):
    from custom_components.clock_pwa.config_flow import CannotConnect
    with patch("custom_components.clock_pwa.config_flow._async_validate", side_effect=CannotConnect):
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"base_url": "https://bad", "api_token": "x"})
    assert result["type"] == "form"
    assert result["errors"] == {"base": "cannot_connect"}
```

- [ ] **Step 3: Run to verify failure**

```bash
cd ~/dev/active/clock-pwa-ha && python3 -m pip install -q -r tests/requirements_test.txt
python3 -m pytest tests/test_config_flow.py -q
```
Expected: FAIL — `config_flow`/`__init__` not implemented.

- [ ] **Step 4: Implement the config flow + minimal entry setup**

`custom_components/clock_pwa/config_flow.py`:
```python
from __future__ import annotations
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from .const import DOMAIN, CONF_BASE_URL, CONF_API_TOKEN


class CannotConnect(Exception):
    """Health check failed."""


async def _async_validate(hass, base_url):
    session = async_get_clientsession(hass)
    try:
        async with session.get(base_url.rstrip("/") + "/api/health", timeout=10) as r:
            if r.status != 200:
                raise CannotConnect
    except Exception as err:
        raise CannotConnect from err


class ClockPwaConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            base = user_input[CONF_BASE_URL].rstrip("/")
            await self.async_set_unique_id(base)
            self._abort_if_unique_id_configured()
            try:
                await _async_validate(self.hass, base)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(
                    title=base, data={CONF_BASE_URL: base, CONF_API_TOKEN: user_input[CONF_API_TOKEN]})
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_BASE_URL): str, vol.Required(CONF_API_TOKEN): str}),
            errors=errors,
        )
```

`custom_components/clock_pwa/__init__.py` (minimal; platforms + services wired in Tasks 5–7):
```python
from __future__ import annotations
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from .const import DOMAIN

PLATFORMS: list[str] = []   # "sensor", "binary_sensor" added in Task 6

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.data.setdefault(DOMAIN, {})
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return ok
```

- [ ] **Step 5: Run to verify pass**

```bash
python3 -m pytest tests/test_config_flow.py -q
```
Expected: PASS (2 tests).

- [ ] **Step 6: Validate workflow + commit**

`.github/workflows/validate.yml`:
```yaml
name: Validate
on: [push, pull_request]
jobs:
  hassfest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: home-assistant/actions/hassfest@master
  hacs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hacs/action@main
        with: { category: integration }
```

`README.md` (minimal for now; expanded in Task 8): name + one-line description (required by HACS) + "install via HACS custom repository."

```bash
cd ~/dev/active/clock-pwa-ha
git add -A && git commit -m "feat: scaffold clock_pwa HACS integration + config flow"
```

---

### Task 5: Polling coordinator

**Files (repo `~/dev/active/clock-pwa-ha`):**
- Create: `custom_components/clock_pwa/coordinator.py`
- Modify: `custom_components/clock_pwa/__init__.py` (create the coordinator on setup)
- Create: `tests/test_coordinator.py`

**Interfaces:**
- Produces: `ClockPwaCoordinator(hass, base_url)` with `.data = {"alerts": [...], "presence": {room: {present, ts}}}`; stored at `hass.data[DOMAIN][entry.entry_id]`.

- [ ] **Step 1: Write the failing test**

`tests/test_coordinator.py`:
```python
from custom_components.clock_pwa.coordinator import ClockPwaCoordinator

async def test_coordinator_fetches(hass, aioclient_mock):
    base = "https://clock.example.com"
    aioclient_mock.get(base + "/alerts.json", json=[{"key": "k", "severity": "critical", "title": "T", "message": "m"}])
    aioclient_mock.get(base + "/presence.json", json={"Kitchen": {"present": True, "ts": 5}})
    coord = ClockPwaCoordinator(hass, base)
    data = await coord._async_update_data()
    assert data["alerts"][0]["key"] == "k"
    assert data["presence"]["Kitchen"]["present"] is True
```

- [ ] **Step 2: Run to verify failure**

```bash
python3 -m pytest tests/test_coordinator.py -q
```
Expected: FAIL — `coordinator` missing.

- [ ] **Step 3: Implement**

`custom_components/clock_pwa/coordinator.py`:
```python
from __future__ import annotations
from datetime import timedelta
import logging
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from .const import DOMAIN, DEFAULT_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class ClockPwaCoordinator(DataUpdateCoordinator):
    def __init__(self, hass: HomeAssistant, base_url: str):
        super().__init__(hass, _LOGGER, name=DOMAIN,
                         update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL))
        self.base_url = base_url.rstrip("/")
        self._session = async_get_clientsession(hass)

    async def _get_json(self, path, default):
        try:
            async with self._session.get(self.base_url + path, timeout=10) as r:
                if r.status != 200:
                    return default
                return await r.json()
        except Exception as err:
            raise UpdateFailed(f"{path}: {err}") from err

    async def _async_update_data(self):
        alerts = await self._get_json("/alerts.json", [])
        presence = await self._get_json("/presence.json", {})
        return {"alerts": alerts if isinstance(alerts, list) else [],
                "presence": presence if isinstance(presence, dict) else {}}
```

In `__init__.py`, create + first-refresh the coordinator on setup and stash it:
```python
from .coordinator import ClockPwaCoordinator
from .const import CONF_BASE_URL
# inside async_setup_entry, before forwarding platforms:
    coordinator = ClockPwaCoordinator(hass, entry.data[CONF_BASE_URL])
    await coordinator.async_config_entry_first_refresh()
    hass.data[DOMAIN][entry.entry_id] = {"coordinator": coordinator}
```

- [ ] **Step 4: Run to verify pass**

```bash
python3 -m pytest tests/test_coordinator.py -q
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: polling coordinator for /alerts.json + /presence.json"
```

---

### Task 6: Entities — active-alerts sensor + presence binary_sensors

**Files (repo `~/dev/active/clock-pwa-ha`):**
- Create: `custom_components/clock_pwa/sensor.py`, `custom_components/clock_pwa/binary_sensor.py`
- Modify: `custom_components/clock_pwa/__init__.py` (`PLATFORMS = ["sensor", "binary_sensor"]`)
- Create: `tests/test_entities.py`

**Interfaces:**
- Consumes: the coordinator's `.data` (Task 5).
- Produces: `sensor.clock_active_alerts` (state=count, attrs=list); `binary_sensor.clock_presence_<room>` (occupancy, TTL availability).

- [ ] **Step 1: Write the failing test**

`tests/test_entities.py`:
```python
from custom_components.clock_pwa.const import DOMAIN

async def test_entities_created(hass, aioclient_mock):
    from homeassistant.config_entries import ConfigEntry  # noqa
    from pytest_homeassistant_custom_component.common import MockConfigEntry
    base = "https://clock.example.com"
    aioclient_mock.get(base + "/api/health", json={"ok": True})
    aioclient_mock.get(base + "/alerts.json", json=[{"key": "k", "severity": "critical", "title": "T", "message": "m"}])
    import time
    aioclient_mock.get(base + "/presence.json", json={"Kitchen": {"present": True, "ts": int(time.time()*1000)}})
    entry = MockConfigEntry(domain=DOMAIN, data={"base_url": base, "api_token": "tok"}, unique_id=base)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert hass.states.get("sensor.clock_active_alerts").state == "1"
    assert hass.states.get("binary_sensor.clock_presence_kitchen").state == "on"
```

- [ ] **Step 2: Run to verify failure**

```bash
python3 -m pytest tests/test_entities.py -q
```
Expected: FAIL — platforms not implemented.

- [ ] **Step 3: Implement the sensor**

`custom_components/clock_pwa/sensor.py`:
```python
from __future__ import annotations
from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ActiveAlertsSensor(coordinator, entry)])


class ActiveAlertsSensor(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = True
    _attr_name = "Active alerts"
    _attr_icon = "mdi:bell-alert"

    def __init__(self, coordinator, entry):
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_active_alerts"
        self._attr_device_info = {"identifiers": {(DOMAIN, entry.entry_id)},
                                  "name": f"Clock PWA ({coordinator.base_url})", "manufacturer": "clock-pwa"}

    @property
    def native_value(self):
        return len(self.coordinator.data.get("alerts", []))

    @property
    def extra_state_attributes(self):
        return {"alerts": self.coordinator.data.get("alerts", [])}
```

- [ ] **Step 4: Implement the presence binary_sensors (dynamic + TTL)**

`custom_components/clock_pwa/binary_sensor.py`:
```python
from __future__ import annotations
import time
from homeassistant.components.binary_sensor import BinarySensorEntity, BinarySensorDeviceClass
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN, PRESENCE_TTL


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    known: set[str] = set()

    def _sync():
        rooms = set((coordinator.data or {}).get("presence", {}).keys())
        new = rooms - known
        if new:
            known.update(new)
            async_add_entities([PresenceBinarySensor(coordinator, entry, r) for r in new])

    _sync()
    entry.async_on_unload(coordinator.async_add_listener(_sync))


class PresenceBinarySensor(CoordinatorEntity, BinarySensorEntity):
    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    def __init__(self, coordinator, entry, room):
        super().__init__(coordinator)
        self._room = room
        self._attr_name = f"Presence {room}"
        self._attr_unique_id = f"{entry.entry_id}_presence_{room}"
        self._attr_device_info = {"identifiers": {(DOMAIN, entry.entry_id)},
                                  "name": f"Clock PWA ({coordinator.base_url})", "manufacturer": "clock-pwa"}

    def _entry(self):
        return (self.coordinator.data or {}).get("presence", {}).get(self._room)

    @property
    def is_on(self):
        e = self._entry()
        return bool(e and e.get("present"))

    @property
    def available(self):
        e = self._entry()
        if not e:
            return False
        return (time.time() * 1000 - int(e.get("ts", 0))) < PRESENCE_TTL * 1000
```

In `__init__.py` set `PLATFORMS = ["sensor", "binary_sensor"]`.

- [ ] **Step 5: Run to verify pass**

```bash
python3 -m pytest tests/test_entities.py -q
```
Expected: PASS (sensor=1, kitchen presence=on).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: active-alerts sensor + dynamic presence binary_sensors (occupancy, TTL)"
```

---

### Task 7: Services — send_alert / clear_alert

**Files (repo `~/dev/active/clock-pwa-ha`):**
- Create: `custom_components/clock_pwa/services.yaml`
- Modify: `custom_components/clock_pwa/__init__.py` (register services)
- Create: `tests/test_services.py`

**Interfaces:**
- Consumes: the config entry's `base_url` + `api_token`.
- Produces: `clock_pwa.send_alert` (key, severity, type, title, message, target) → POST `/api/alert`; `clock_pwa.clear_alert` (key) → POST `/api/alert/clear`.

- [ ] **Step 1: Write the failing test**

`tests/test_services.py`:
```python
from custom_components.clock_pwa.const import DOMAIN
from pytest_homeassistant_custom_component.common import MockConfigEntry

async def test_send_alert_posts(hass, aioclient_mock):
    base = "https://clock.example.com"
    aioclient_mock.get(base + "/api/health", json={"ok": True})
    aioclient_mock.get(base + "/alerts.json", json=[])
    aioclient_mock.get(base + "/presence.json", json={})
    aioclient_mock.post(base + "/api/alert", json={"ok": True, "count": 1})
    entry = MockConfigEntry(domain=DOMAIN, data={"base_url": base, "api_token": "tok"}, unique_id=base)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    await hass.services.async_call(DOMAIN, "send_alert",
        {"key": "leak1", "severity": "critical", "type": "water_leak", "title": "Leak", "message": "wet"}, blocking=True)
    last = aioclient_mock.mock_calls[-1]
    assert last[0] == "POST" and str(last[1]).endswith("/api/alert")
    assert last[2]["key"] == "leak1" and last[2]["type"] == "water_leak"
    assert last[3]["Authorization"] == "Bearer tok"
```

- [ ] **Step 2: Run to verify failure**

```bash
python3 -m pytest tests/test_services.py -q
```
Expected: FAIL — services not registered.

- [ ] **Step 3: Implement** — `services.yaml`:
```yaml
send_alert:
  fields:
    key: { required: true, example: "leak_basement", selector: { text: {} } }
    severity: { example: "critical", selector: { select: { options: ["warning", "critical"] } } }
    type: { example: "water_leak", selector: { text: {} } }
    title: { required: true, example: "Water Leak", selector: { text: {} } }
    message: { required: true, example: "Basement sensor wet", selector: { text: {} } }
    target: { example: "all", selector: { text: {} } }
clear_alert:
  fields:
    key: { required: true, example: "leak_basement", selector: { text: {} } }
```

Register services in `__init__.py` (inside `async_setup_entry`, after the coordinator is stored — guard so they register once):
```python
import voluptuous as vol
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from .const import CONF_API_TOKEN

SEND_SCHEMA = vol.Schema({
    vol.Required("key"): cv.string,
    vol.Optional("severity", default="critical"): vol.In(["warning", "critical"]),
    vol.Optional("type"): cv.string,
    vol.Required("title"): cv.string,
    vol.Required("message"): cv.string,
    vol.Optional("target"): cv.string,
})
CLEAR_SCHEMA = vol.Schema({vol.Required("key"): cv.string})

def _register_services(hass, base_url, token):
    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async def _send(call):
        body = {k: v for k, v in call.data.items() if v is not None}
        async with session.post(base_url + "/api/alert", json=body, headers=headers, timeout=10) as r:
            if r.status >= 400:
                raise HomeAssistantError(f"send_alert failed: HTTP {r.status}")

    async def _clear(call):
        async with session.post(base_url + "/api/alert/clear", json={"key": call.data["key"]}, headers=headers, timeout=10) as r:
            if r.status >= 400:
                raise HomeAssistantError(f"clear_alert failed: HTTP {r.status}")

    hass.services.async_register(DOMAIN, "send_alert", _send, schema=SEND_SCHEMA)
    hass.services.async_register(DOMAIN, "clear_alert", _clear, schema=CLEAR_SCHEMA)
```
Add `from homeassistant.exceptions import HomeAssistantError` at the top, and call `_register_services(hass, entry.data[CONF_BASE_URL], entry.data[CONF_API_TOKEN])` once in setup (e.g. guard with `if not hass.services.has_service(DOMAIN, "send_alert"):`).

- [ ] **Step 4: Run to verify pass**

```bash
python3 -m pytest tests/test_services.py -q
python3 -m pytest -q   # whole integration suite green
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: clock_pwa.send_alert / clear_alert services (bearer auth)"
```

---

### Task 8: Docs + distribution + cross-repo note

**Files:**
- Modify (new repo): `README.md`
- Modify (clock-pwa repo): `README.md`

- [ ] **Step 1: Integration README** (`~/dev/active/clock-pwa-ha/README.md`) — cover:
  - What it is (HA control plane for the clock PWA: alert services + presence/active-alert entities).
  - **Install:** HACS → Integrations → ⋮ → Custom repositories → add the repo URL, category Integration → install → restart HA → Settings → Devices & Services → Add Integration → "Clock PWA" → enter base URL + `ALERT_API_TOKEN`.
  - **Entities:** `sensor.clock_active_alerts` (count + `alerts` attribute), `binary_sensor.clock_presence_<room>` (occupancy; `unavailable` if no heartbeat within 5 min — needs camera Presence on + a room profile on that display).
  - **Services:** `clock_pwa.send_alert` / `clock_pwa.clear_alert` with the field list + a YAML example; the alert `type → icon` list.
  - **Requires** clock-pwa serving `/presence.json` (this release) — note the minimum.

- [ ] **Step 2: clock-pwa README** — add a short pointer: "Home Assistant integration (HACS): see the `clock-pwa-ha` repo. It polls `/alerts.json` + `/presence.json` and exposes alert services + presence sensors." Note `/presence.json` is open GET (LAN/HTTPS).

- [ ] **Step 3: Commit (both repos)**

```bash
cd ~/dev/active/clock-pwa-ha && git add -A && git commit -m "docs: install + usage for the Clock PWA HA integration"
cd /Users/assistant/dev/active/clock-pwa && git add README.md && git commit -m "docs: point to the clock-pwa-ha HACS integration + /presence.json"
```

---

## Self-Review

**Spec coverage:**
- A1 sidecar presence store + `GET /presence.json` + `presence_view` → Task 1. ✓
- A2 device heartbeat → Task 2. ✓
- A3 nginx `/presence.json` → Task 3. ✓
- B repo scaffold + config flow → Task 4. ✓
- B coordinator (poll alerts + presence) → Task 5. ✓
- B `sensor.clock_active_alerts` + dynamic `binary_sensor.clock_presence_<room>` (TTL) → Task 6. ✓
- B services send/clear alert (bearer) → Task 7. ✓
- C testing (unittest / node / pytest-HA) → Tasks 1,2,4,5,6,7; hassfest/HACS CI → Task 4; docs/distribution → Task 8. ✓

**Placeholder scan:** No TBD/TODO; complete code per step. The `@chatwithllm` codeowner + repo URLs are real config values. Docker-gated step names a fallback. ✓

**Type consistency:** `presence_view(store)` + `_presence` shape `{room:{present,ts}}` consistent across Task 1 (sidecar), Task 5 (coordinator `data["presence"]`), Task 6 (binary_sensor reads `present`/`ts`). Coordinator `.data = {"alerts","presence"}` consistent Tasks 5→6. Config entry `data = {base_url, api_token}` consistent Tasks 4→5→7. `DOMAIN="clock_pwa"`, `PRESENCE_TTL`, `DEFAULT_SCAN_INTERVAL` from const.py used in 5/6. Service field set (key/severity/type/title/message/target) consistent Task 7 ↔ the sidecar `validate_alert` (Task-1-of-the-prior-feature). ✓
