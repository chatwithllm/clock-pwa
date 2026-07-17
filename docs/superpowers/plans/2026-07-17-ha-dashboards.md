# Per-Profile Home Assistant Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each clock display render a native, per-profile Home Assistant control dashboard (live entity state + tap-to-act) using a per-device HA long-lived token over a WebSocket.

**Architecture:** A per-device HA URL + token live in `localStorage`. A pure protocol layer (`js/ha-protocol.js`) turns the HA WebSocket handshake/events into cache updates and outgoing messages; a thin runtime (`js/ha.js`) wraps a real socket with reconnect. Pure dashboard logic (`js/ha-dashboard.js`) validates the shared `dashboards.json`, projects entity state into tile render-models, and maps taps to service calls. A DOM view (`js/dashboard-view.js`) draws the overlay. Dashboards are edited in `admin.html`, served from `/data/dashboards.json`, and polled like `profiles.json`.

**Tech Stack:** Vanilla ES modules, `node --test` (built-in test runner, no deps), nginx WebDAV for the shared JSON, Home Assistant WebSocket API.

## Global Constraints

- **No new runtime dependencies.** Vanilla ES modules only; tests use `node:test` + `node:assert/strict` (see `test/source.test.js`).
- **Secrets never touch `/data` or the sidecar.** `haUrl`/`haToken` persist only in the device `localStorage` key `clockpwa.settings.v1`; `dashboards.json` holds no secrets.
- **A field absent from `saveSettings`'s persist-list will not persist** (`js/settings.js:122-133`) — every new setting must be added there.
- **Pure logic is separated from I/O.** Socket/DOM plumbing stays out of the unit-tested modules (`ha-protocol.js`, `ha-dashboard.js`).
- **MVP tile types are exactly four:** `sensor`, `toggle`, `scene`/`button`, `climate`. New types are additive; do not add others in this plan.
- Test files live in `test/`, named `<module>.test.js`, run by `npm test` (`node --test`).

---

### Task 1: Dashboard schema validation + resolve

**Files:**
- Create: `js/ha-dashboard.js`
- Test: `test/ha-dashboard.test.js`

**Interfaces:**
- Produces:
  - `validateDashboards(raw) -> { version: 1, profiles: { [name]: { title: string, tiles: Tile[] } } }` — always returns a well-formed object; drops malformed profiles/tiles; never throws.
  - `resolveDashboard(dashboards, profileName) -> { title, tiles } | null`
  - `Tile` shape: `{ type:'sensor'|'toggle'|'scene'|'button'|'climate', entity?:string, service?:string, target?:string, label?:string, icon?:string, unit?:string }`

- [ ] **Step 1: Write the failing test**

```javascript
// test/ha-dashboard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDashboards, resolveDashboard } from '../js/ha-dashboard.js';

test('validateDashboards keeps valid tiles, drops malformed ones', () => {
  const out = validateDashboards({
    version: 1,
    profiles: {
      'Guest Room': {
        title: 'Guest Room',
        tiles: [
          { type: 'toggle', entity: 'light.guest', label: 'Ceiling' },
          { type: 'sensor', entity: 'sensor.temp', unit: '°C' },
          { type: 'nonsense', entity: 'x.y' },        // bad type -> dropped
          { type: 'toggle' },                          // no entity -> dropped
          { type: 'scene', service: 'scene.turn_on', target: 'scene.night' },
        ],
      },
    },
  });
  assert.equal(out.version, 1);
  assert.equal(out.profiles['Guest Room'].tiles.length, 3);
  assert.equal(out.profiles['Guest Room'].title, 'Guest Room');
});

test('validateDashboards tolerates garbage input', () => {
  assert.deepEqual(validateDashboards(null), { version: 1, profiles: {} });
  assert.deepEqual(validateDashboards({ profiles: 'nope' }), { version: 1, profiles: {} });
});

test('resolveDashboard returns the profile block or null', () => {
  const d = validateDashboards({ version: 1, profiles: { Kitchen: { tiles: [{ type: 'sensor', entity: 'sensor.k' }] } } });
  assert.equal(resolveDashboard(d, 'Kitchen').tiles.length, 1);
  assert.equal(resolveDashboard(d, 'Missing'), null);
  assert.equal(resolveDashboard(d, 'None'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ha-dashboard.test.js`
Expected: FAIL — `Cannot find module '../js/ha-dashboard.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// js/ha-dashboard.js — pure dashboard logic (no DOM, no sockets).

const TILE_TYPES = new Set(['sensor', 'toggle', 'scene', 'button', 'climate']);

function validTile(t) {
  if (!t || typeof t !== 'object' || !TILE_TYPES.has(t.type)) return null;
  const tile = { type: t.type };
  if (typeof t.entity === 'string' && t.entity) tile.entity = t.entity;
  if (typeof t.service === 'string' && t.service) tile.service = t.service;
  if (typeof t.target === 'string' && t.target) tile.target = t.target;
  if (typeof t.label === 'string') tile.label = t.label;
  if (typeof t.icon === 'string') tile.icon = t.icon;
  if (typeof t.unit === 'string') tile.unit = t.unit;
  // Type-specific required bindings.
  if ((t.type === 'sensor' || t.type === 'toggle' || t.type === 'climate') && !tile.entity) return null;
  if ((t.type === 'scene' || t.type === 'button') && !(tile.service && tile.target) && !tile.entity) return null;
  return tile;
}

export function validateDashboards(raw) {
  const out = { version: 1, profiles: {} };
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') return out;
  for (const [name, block] of Object.entries(raw.profiles)) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.tiles)) continue;
    const tiles = block.tiles.map(validTile).filter(Boolean);
    out.profiles[name] = {
      title: typeof block.title === 'string' && block.title ? block.title : name,
      tiles,
    };
  }
  return out;
}

export function resolveDashboard(dashboards, profileName) {
  if (!dashboards || !dashboards.profiles || !profileName || profileName === 'None') return null;
  return dashboards.profiles[profileName] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ha-dashboard.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add js/ha-dashboard.js test/ha-dashboard.test.js
git commit -m "feat: dashboard schema validation + resolve (pure)"
```

---

### Task 2: Tile action mapping + state projection

**Files:**
- Modify: `js/ha-dashboard.js` (append)
- Test: `test/ha-dashboard.test.js` (append)

**Interfaces:**
- Consumes: `Tile` from Task 1; an HA `state` object `{ entity_id, state, attributes }` or `undefined`.
- Produces:
  - `tileAction(tile, state) -> { domain, service, service_data } | null` — the `call_service` payload for a tap; `null` for read-only tiles.
  - `projectTile(tile, state) -> { type, label, icon, available, value, unit, on, current, setpoint }` — render model.

- [ ] **Step 1: Write the failing test** (append to `test/ha-dashboard.test.js`)

```javascript
import { tileAction, projectTile } from '../js/ha-dashboard.js';

test('tileAction: toggle uses the entity domain', () => {
  assert.deepEqual(
    tileAction({ type: 'toggle', entity: 'switch.fan' }, { state: 'off' }),
    { domain: 'switch', service: 'toggle', service_data: { entity_id: 'switch.fan' } });
});

test('tileAction: scene/button fire their configured service', () => {
  assert.deepEqual(
    tileAction({ type: 'scene', service: 'scene.turn_on', target: 'scene.night' }, undefined),
    { domain: 'scene', service: 'turn_on', service_data: { entity_id: 'scene.night' } });
});

test('tileAction: climate +/- nudges the setpoint by 0.5', () => {
  const st = { state: 'heat', attributes: { temperature: 20 } };
  assert.deepEqual(
    tileAction({ type: 'climate', entity: 'climate.t' }, st, +1),
    { domain: 'climate', service: 'set_temperature', service_data: { entity_id: 'climate.t', temperature: 20.5 } });
});

test('tileAction: sensor is read-only', () => {
  assert.equal(tileAction({ type: 'sensor', entity: 'sensor.x' }, { state: '5' }), null);
});

test('projectTile: unavailable when state is missing', () => {
  const p = projectTile({ type: 'sensor', entity: 'sensor.x', unit: '°C' }, undefined);
  assert.equal(p.available, false);
  assert.equal(p.value, '—');
});

test('projectTile: toggle on-state', () => {
  const p = projectTile({ type: 'toggle', entity: 'light.x', label: 'Lamp' }, { state: 'on' });
  assert.equal(p.on, true);
  assert.equal(p.available, true);
  assert.equal(p.label, 'Lamp');
});

test('projectTile: climate exposes current + setpoint', () => {
  const p = projectTile({ type: 'climate', entity: 'climate.t' },
    { state: 'heat', attributes: { current_temperature: 19, temperature: 21 } });
  assert.equal(p.current, 19);
  assert.equal(p.setpoint, 21);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ha-dashboard.test.js`
Expected: FAIL — `tileAction is not a function` / `projectTile is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `js/ha-dashboard.js`)

```javascript
const CLIMATE_STEP = 0.5;

function domainOf(entityId) { return String(entityId || '').split('.')[0]; }
function isOn(state) { return !!state && state.state === 'on'; }
function isAvailable(state) { return !!state && state.state !== 'unavailable' && state.state !== 'unknown'; }

export function tileAction(tile, state, dir = 0) {
  if (!tile) return null;
  if (tile.type === 'toggle') {
    return { domain: domainOf(tile.entity), service: 'toggle', service_data: { entity_id: tile.entity } };
  }
  if (tile.type === 'scene' || tile.type === 'button') {
    const svc = tile.service || (tile.type === 'button' ? 'button.press' : 'scene.turn_on');
    const [domain, service] = svc.split('.');
    return { domain, service, service_data: { entity_id: tile.target || tile.entity } };
  }
  if (tile.type === 'climate') {
    const base = (state && state.attributes && Number(state.attributes.temperature)) || 0;
    const temperature = Math.round((base + dir * CLIMATE_STEP) * 10) / 10;
    return { domain: 'climate', service: 'set_temperature', service_data: { entity_id: tile.entity, temperature } };
  }
  return null; // sensor is read-only
}

export function projectTile(tile, state) {
  const available = isAvailable(state);
  const attrs = (state && state.attributes) || {};
  const base = {
    type: tile.type,
    label: tile.label || tile.entity || tile.target || '',
    icon: tile.icon || '',
    available,
    unit: tile.unit || attrs.unit_of_measurement || '',
    value: available ? String(state.state) : '—',
    on: isOn(state),
    current: null,
    setpoint: null,
  };
  if (tile.type === 'climate') {
    base.current = Number.isFinite(Number(attrs.current_temperature)) ? Number(attrs.current_temperature) : null;
    base.setpoint = Number.isFinite(Number(attrs.temperature)) ? Number(attrs.temperature) : null;
  }
  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ha-dashboard.test.js`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add js/ha-dashboard.js test/ha-dashboard.test.js
git commit -m "feat: tile action mapping + state projection (pure)"
```

---

### Task 3: HA WebSocket protocol logic (pure)

**Files:**
- Create: `js/ha-protocol.js`
- Test: `test/ha-protocol.test.js`

**Interfaces:**
- Produces:
  - `initHaState(token) -> { phase:'connecting', token, entities:{}, nextId:number }`
  - `reduceMessage(haState, msg) -> { state, sends: object[], status: string }` — pure; given the current state and one inbound HA message, returns the next state, any outgoing messages to send, and a status string (`'connecting'|'authenticating'|'authed'|'auth_invalid'`).
- Consumes: nothing from other tasks.

Reference — the HA WS handshake: server sends `{type:'auth_required'}` → client sends `{type:'auth', access_token}` → server replies `{type:'auth_ok'}` or `{type:'auth_invalid'}`. After `auth_ok`, client sends `{id, type:'get_states'}` and `{id, type:'subscribe_events', event_type:'state_changed'}`. Results arrive as `{id, type:'result', success, result}`; updates as `{type:'event', event:{event_type:'state_changed', data:{entity_id, new_state}}}`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/ha-protocol.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initHaState, reduceMessage } from '../js/ha-protocol.js';

test('auth_required triggers an auth message', () => {
  const s0 = initHaState('TOKEN');
  const { state, sends, status } = reduceMessage(s0, { type: 'auth_required' });
  assert.equal(status, 'authenticating');
  assert.deepEqual(sends, [{ type: 'auth', access_token: 'TOKEN' }]);
  assert.equal(state.phase, 'authenticating');
});

test('auth_ok subscribes and requests states', () => {
  let s = initHaState('T');
  s = reduceMessage(s, { type: 'auth_required' }).state;
  const r = reduceMessage(s, { type: 'auth_ok' });
  assert.equal(r.status, 'authed');
  assert.equal(r.sends.length, 2);
  assert.equal(r.sends[0].type, 'get_states');
  assert.deepEqual(r.sends[1], { id: r.sends[1].id, type: 'subscribe_events', event_type: 'state_changed' });
});

test('auth_invalid is terminal', () => {
  const s0 = initHaState('bad');
  const r = reduceMessage(s0, { type: 'auth_invalid' });
  assert.equal(r.status, 'auth_invalid');
  assert.deepEqual(r.sends, []);
});

test('get_states result seeds the entity cache', () => {
  let s = initHaState('T');
  const r = reduceMessage(s, {
    type: 'result', success: true,
    result: [{ entity_id: 'light.a', state: 'on', attributes: {} }],
  });
  assert.equal(r.state.entities['light.a'].state, 'on');
});

test('state_changed event updates one entity', () => {
  let s = initHaState('T');
  s.entities['light.a'] = { entity_id: 'light.a', state: 'on', attributes: {} };
  const r = reduceMessage(s, {
    type: 'event',
    event: { event_type: 'state_changed', data: { entity_id: 'light.a', new_state: { entity_id: 'light.a', state: 'off', attributes: {} } } },
  });
  assert.equal(r.state.entities['light.a'].state, 'off');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ha-protocol.test.js`
Expected: FAIL — `Cannot find module '../js/ha-protocol.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// js/ha-protocol.js — pure HA WebSocket message logic (no socket).

export function initHaState(token) {
  return { phase: 'connecting', token, entities: {}, nextId: 1 };
}

function withId(state) {
  const id = state.nextId;
  return { id, state: { ...state, nextId: id + 1 } };
}

export function reduceMessage(haState, msg) {
  let state = haState;
  const sends = [];
  let status = state.phase;

  switch (msg && msg.type) {
    case 'auth_required':
      state = { ...state, phase: 'authenticating' };
      status = 'authenticating';
      sends.push({ type: 'auth', access_token: state.token });
      break;
    case 'auth_ok': {
      const a = withId(state); const b = withId(a.state);
      state = { ...b.state, phase: 'authed' };
      status = 'authed';
      sends.push({ id: a.id, type: 'get_states' });
      sends.push({ id: b.id, type: 'subscribe_events', event_type: 'state_changed' });
      break;
    }
    case 'auth_invalid':
      state = { ...state, phase: 'auth_invalid' };
      status = 'auth_invalid';
      break;
    case 'result':
      if (msg.success && Array.isArray(msg.result)) {
        const entities = { ...state.entities };
        for (const e of msg.result) if (e && e.entity_id) entities[e.entity_id] = e;
        state = { ...state, entities };
      }
      break;
    case 'event':
      if (msg.event && msg.event.event_type === 'state_changed' && msg.event.data) {
        const d = msg.event.data;
        const entities = { ...state.entities };
        if (d.new_state) entities[d.entity_id] = d.new_state;
        else delete entities[d.entity_id];
        state = { ...state, entities };
      }
      break;
    default:
      break;
  }
  return { state, sends, status };
}

export function callServiceMessage(id, action) {
  return { id, type: 'call_service', domain: action.domain, service: action.service, service_data: action.service_data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ha-protocol.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add js/ha-protocol.js test/ha-protocol.test.js
git commit -m "feat: HA WebSocket protocol reducer (pure)"
```

---

### Task 4: HA runtime client (socket + reconnect)

**Files:**
- Create: `js/ha.js`
- Test: `test/ha.test.js`

**Interfaces:**
- Consumes: `initHaState`, `reduceMessage`, `callServiceMessage` (Task 3).
- Produces:
  - `createHaClient({ url, token, socketFactory?, onEntities, onStatus }) -> { callService(action), close() }`
  - `socketFactory(wsUrl) -> WebSocket-like` (default `(u) => new WebSocket(u))`; injected in tests. The client appends `/api/websocket` to `url`, drives the handshake via `reduceMessage`, forwards `onEntities(entitiesObj)` and `onStatus(statusString)`, and reconnects with capped backoff on close.

- [ ] **Step 1: Write the failing test**

```javascript
// test/ha.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaClient } from '../js/ha.js';

// Minimal fake WebSocket that captures sends and lets the test push messages.
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
  emit(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

test('client authenticates then reports authed + entities', () => {
  let status = null; let entities = null;
  const client = createHaClient({
    url: 'https://ha.local', token: 'T',
    socketFactory: (u) => new FakeWS(u),
    onStatus: (s) => { status = s; },
    onEntities: (e) => { entities = e; },
  });
  const ws = FakeWS.last;
  assert.match(ws.url, /\/api\/websocket$/);
  ws.onopen && ws.onopen();
  ws.emit({ type: 'auth_required' });
  assert.deepEqual(ws.sent[0], { type: 'auth', access_token: 'T' });
  ws.emit({ type: 'auth_ok' });
  assert.equal(status, 'authed');
  ws.emit({ type: 'result', success: true, result: [{ entity_id: 'light.a', state: 'on', attributes: {} }] });
  assert.equal(entities['light.a'].state, 'on');
  client.close();
  assert.equal(ws.closed, true);
});

test('callService sends a call_service frame once authed', () => {
  const client = createHaClient({ url: 'https://ha.local', token: 'T', socketFactory: (u) => new FakeWS(u), onStatus() {}, onEntities() {} });
  const ws = FakeWS.last;
  ws.onopen && ws.onopen();
  ws.emit({ type: 'auth_required' });
  ws.emit({ type: 'auth_ok' });
  client.callService({ domain: 'light', service: 'toggle', service_data: { entity_id: 'light.a' } });
  const frame = ws.sent.find((m) => m.type === 'call_service');
  assert.deepEqual({ domain: frame.domain, service: frame.service, service_data: frame.service_data },
    { domain: 'light', service: 'toggle', service_data: { entity_id: 'light.a' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ha.test.js`
Expected: FAIL — `Cannot find module '../js/ha.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// js/ha.js — thin HA WebSocket runtime around the pure protocol reducer.
import { initHaState, reduceMessage, callServiceMessage } from './ha-protocol.js';

const MAX_BACKOFF = 30000;

export function createHaClient({ url, token, socketFactory, onEntities, onStatus }) {
  const mkSocket = socketFactory || ((u) => new WebSocket(u));
  const wsUrl = String(url).replace(/\/+$/, '') + '/api/websocket';
  let state = initHaState(token);
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  let nextId = 100; // call_service ids live above the handshake ids

  function connect() {
    if (stopped) return;
    onStatus && onStatus('connecting');
    ws = mkSocket(wsUrl);
    state = initHaState(token);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const r = reduceMessage(state, msg);
      state = r.state;
      for (const out of r.sends) ws.send(JSON.stringify(out));
      onStatus && onStatus(r.status);
      onEntities && onEntities(state.entities);
      if (r.status === 'authed') backoff = 1000; // healthy connection resets backoff
    };
    ws.onclose = () => {
      if (stopped || state.phase === 'auth_invalid') return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
  }
  connect();

  return {
    callService(action) {
      if (!ws || state.phase !== 'authed') return;
      ws.send(JSON.stringify(callServiceMessage(nextId++, action)));
    },
    close() { stopped = true; if (ws) ws.close(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ha.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add js/ha.js test/ha.test.js
git commit -m "feat: HA WebSocket runtime client with reconnect"
```

---

### Task 5: Persist per-device HA connection settings

**Files:**
- Modify: `js/settings.js` (DEFAULTS `:16-40`, `saveSettings` `:122-133`)
- Test: `test/settings-ha.test.js`

**Interfaces:**
- Produces: `loadSettings()` returns `haUrl:''`, `haToken:''` by default; `saveSettings` round-trips both.

- [ ] **Step 1: Write the failing test**

```javascript
// test/settings-ha.test.js — stubs window.localStorage so settings.js can run under node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.window = {
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  },
  location: { search: '' },
};

const { loadSettings, saveSettings } = await import('../js/settings.js');

test('HA connection fields default to empty and persist', () => {
  const s = loadSettings();
  assert.equal(s.haUrl, '');
  assert.equal(s.haToken, '');
  s.haUrl = 'https://ha.local:8123';
  s.haToken = 'llt_secret';
  saveSettings(s);
  const again = loadSettings();
  assert.equal(again.haUrl, 'https://ha.local:8123');
  assert.equal(again.haToken, 'llt_secret');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings-ha.test.js`
Expected: FAIL — `s.haUrl` is `undefined` (defaults not defined yet).

- [ ] **Step 3: Write minimal implementation**

In `js/settings.js` DEFAULTS (after `city: null,` at `:39`), add:

```javascript
  haUrl: '',            // per-device Home Assistant base URL (e.g. https://ha.local:8123)
  haToken: '',          // per-device HA long-lived access token (kept local; never sent to /data)
```

In `saveSettings` (`js/settings.js:122-133`), add to the `out` object (e.g. after the `lat/lon/city` line):

```javascript
    haUrl: s.haUrl, haToken: s.haToken,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/settings-ha.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/settings.js test/settings-ha.test.js
git commit -m "feat: persist per-device HA url + token settings"
```

---

### Task 6: Dashboard overlay renderer (DOM)

**Files:**
- Create: `js/dashboard-view.js`
- Modify: `css/styles.css` (append dashboard styles)
- Test: `test/dashboard-view.test.js`

**Interfaces:**
- Consumes: `resolveDashboard`, `projectTile` (Tasks 1-2).
- Produces:
  - `renderDashboard(container, dashboard, entities, onTileTap) -> void` — clears `container`, appends one `.dash-tile` button per tile (`data-nav` for the d-pad), wires clicks to `onTileTap(tile, dir)` where `dir` is `-1|0|+1` (climate `−`/tap/`+`).
  - `tileClassList(projected) -> string[]` — pure helper (unit-tested): classes for a projected tile (`is-on`, `is-unavailable`, per-type).

The test targets the pure helper only (DOM wiring is verified manually in Task 8).

- [ ] **Step 1: Write the failing test**

```javascript
// test/dashboard-view.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileClassList } from '../js/dashboard-view.js';

test('on toggle gets is-on', () => {
  assert.ok(tileClassList({ type: 'toggle', available: true, on: true }).includes('is-on'));
});
test('unavailable gets is-unavailable', () => {
  assert.ok(tileClassList({ type: 'sensor', available: false }).includes('is-unavailable'));
});
test('type class is always present', () => {
  assert.ok(tileClassList({ type: 'climate', available: true }).includes('dash-climate'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-view.test.js`
Expected: FAIL — `Cannot find module '../js/dashboard-view.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// js/dashboard-view.js — render the HA dashboard overlay from projected tiles.
import { projectTile } from './ha-dashboard.js';

export function tileClassList(p) {
  const cls = ['dash-tile', 'dash-' + p.type];
  if (!p.available) cls.push('is-unavailable');
  if (p.type === 'toggle' && p.on) cls.push('is-on');
  return cls;
}

function tileText(p) {
  if (p.type === 'climate') {
    const cur = p.current == null ? '—' : p.current + '°';
    const set = p.setpoint == null ? '—' : p.setpoint + '°';
    return `${p.label}\n${cur} → ${set}`;
  }
  if (p.type === 'toggle') return `${p.label}\n${p.available ? (p.on ? 'On' : 'Off') : '—'}`;
  if (p.type === 'sensor') return `${p.label}\n${p.value}${p.unit || ''}`;
  return p.label; // scene / button
}

export function renderDashboard(container, dashboard, entities, onTileTap) {
  container.textContent = '';
  if (!dashboard) return;
  for (const tile of dashboard.tiles) {
    const state = tile.entity ? entities[tile.entity] : undefined;
    const p = projectTile(tile, state);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = tileClassList(p).join(' ');
    el.setAttribute('data-nav', '');
    if (p.icon) { const i = document.createElement('span'); i.className = 'dash-icon'; i.textContent = p.icon; el.appendChild(i); }
    const label = document.createElement('span');
    label.className = 'dash-text';
    label.textContent = tileText(p);
    el.appendChild(label);
    if (tile.type === 'climate') {
      el.addEventListener('click', (ev) => {
        const rect = el.getBoundingClientRect();
        onTileTap(tile, ev.clientX < rect.left + rect.width / 2 ? -1 : +1);
      });
    } else if (tile.type !== 'sensor') {
      el.addEventListener('click', () => onTileTap(tile, 0));
    }
    container.appendChild(el);
  }
}
```

Append to `css/styles.css`:

```css
/* HA dashboard overlay */
#dashboard { position: fixed; inset: 0; z-index: 40; display: none; background: rgba(0,0,0,.92);
  padding: 4vmin; overflow: auto; }
#dashboard.is-open { display: block; }
.dash-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(30vmin, 1fr));
  gap: 2vmin; }
.dash-tile { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1vmin; min-height: 22vmin; border-radius: 2vmin; border: 0; cursor: pointer;
  background: #1c1c22; color: #eee; font: inherit; padding: 2vmin; text-align: center; white-space: pre-line; }
.dash-tile.is-on { background: #2f6f3f; }
.dash-tile.is-unavailable { opacity: .45; }
.dash-icon { font-size: 6vmin; }
.dash-close { margin-bottom: 2vmin; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dashboard-view.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add js/dashboard-view.js css/styles.css test/dashboard-view.test.js
git commit -m "feat: HA dashboard overlay renderer"
```

---

### Task 7: Panel + overlay markup

**Files:**
- Modify: `index.html` (panel rows near `:186-206`; chrome band button; new overlay after the announce overlay `:216`)

**Interfaces:**
- Produces DOM ids consumed by Task 8: `setHaUrl`, `setHaToken`, `setHaConnect`, `haStatus`, `btnDashboard`, `dashboard`, `dashGrid`, `dashClose`.

No unit test — verified end-to-end in Task 8.

- [ ] **Step 1: Add the settings-panel rows.** In `index.html`, immediately after the Profile row (`:186-189`), insert:

```html
      <div class="row row-col">
        <label class="row-label" for="setHaUrl">Home Assistant URL</label>
        <input class="city-input" id="setHaUrl" type="url" inputmode="url"
               placeholder="https://ha.local:8123" data-nav autocomplete="off">
      </div>
      <div class="row row-col">
        <label class="row-label" for="setHaToken">HA long-lived token</label>
        <div class="city-wrap">
          <input class="city-input" id="setHaToken" type="password"
                 placeholder="paste token" data-nav autocomplete="off">
          <button class="ctrl" id="setHaConnect" type="button" data-nav>Connect</button>
        </div>
        <div class="city-status" id="haStatus" aria-live="polite"></div>
      </div>
```

- [ ] **Step 2: Add the chrome-band button.** Find the chrome control band (where `btnGear`/`btnDim` live) and add, next to them:

```html
      <button class="ctrl" id="btnDashboard" type="button" data-nav hidden>Dashboard</button>
```

- [ ] **Step 3: Add the overlay.** After the announcement overlay block (closes near `:216`), insert:

```html
  <!-- HA dashboard overlay -->
  <div id="dashboard" role="dialog" aria-modal="true" aria-label="Home Assistant dashboard">
    <button class="ctrl ctrl-primary dash-close" id="dashClose" type="button" data-nav>Close</button>
    <div class="dash-grid" id="dashGrid"></div>
  </div>
```

- [ ] **Step 4: Verify markup loads.** Run: `python3 -m http.server 8000` in the repo root, open `http://localhost:8000`, open the settings panel (gear). Expected: the two HA rows appear under Profile; no console errors.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: HA dashboard panel rows, chrome button, overlay markup"
```

---

### Task 8: Wire HA client + dashboard into app.js

**Files:**
- Modify: `js/app.js` — imports (top), constants near `:37`, `wireControls()` `:930-1014`, `syncButtons()` `:478-500`, poll bootstrap `:1211-1214`
- Modify: `sw.js` — bump cache versions `:4-5`, add new modules to `SHELL_FILES` `:7-28`

**Interfaces:**
- Consumes: `createHaClient` (Task 4), `validateDashboards`/`resolveDashboard`/`tileAction` (Tasks 1-2), `renderDashboard` (Task 6), settings `haUrl`/`haToken` (Task 5), DOM ids (Task 7).

- [ ] **Step 1: Add imports** at the top of `js/app.js` (with the other imports):

```javascript
import { createHaClient } from './ha.js';
import { validateDashboards, resolveDashboard, tileAction } from './ha-dashboard.js';
import { renderDashboard } from './dashboard-view.js';
```

- [ ] **Step 2: Add constants + state** near `PROFILES_KEY` (`js/app.js:37`):

```javascript
const DASHBOARDS_KEY = 'clockpwa.dashboards.v1';
```

And in the `app` object literal (near `_customProfiles: [],` at `:72`):

```javascript
  _dashboards: { version: 1, profiles: {} },
  _entities: {},
  _ha: null,
  _haStatus: 'off',
```

- [ ] **Step 3: Add the HA lifecycle + dashboard functions** (place near `pollProfiles`, around `:916`):

```javascript
// Poll the admin-managed per-profile dashboards (network-first); cache offline.
async function pollDashboards(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('dashboards.json?ts=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    app._dashboards = validateDashboards(j);
    try { localStorage.setItem(DASHBOARDS_KEY, JSON.stringify(app._dashboards)); } catch(_){}
    syncButtons();
    if ($('dashboard').classList.contains('is-open')) renderActiveDashboard();
  } catch(_) { /* offline — keep cached value */ }
}

// (Re)connect the HA client from the current per-device settings.
function connectHA(){
  try { if (app._ha) { app._ha.close(); app._ha = null; } } catch(_){}
  const { haUrl, haToken } = app.settings;
  if (!haUrl || !haToken){ app._haStatus = 'off'; syncButtons(); return; }
  app._ha = createHaClient({
    url: haUrl, token: haToken,
    onStatus: (s) => { app._haStatus = s; setHaStatusText(s); syncButtons(); },
    onEntities: (e) => { app._entities = e; if ($('dashboard').classList.contains('is-open')) renderActiveDashboard(); },
  });
}

function setHaStatusText(s){
  const el = $('haStatus'); if (!el) return;
  el.textContent = s === 'authed' ? '● Connected'
    : s === 'auth_invalid' ? 'Auth failed — check token'
    : s === 'connecting' || s === 'authenticating' ? 'Connecting…' : '';
}

function renderActiveDashboard(){
  const dash = resolveDashboard(app._dashboards, app.settings.profile);
  renderDashboard($('dashGrid'), dash, app._entities, (tile, dir) => {
    const action = tileAction(tile, tile.entity ? app._entities[tile.entity] : undefined, dir);
    if (action && app._ha) app._ha.callService(action);
  });
}

function openDashboard(){ renderActiveDashboard(); $('dashboard').classList.add('is-open'); }
function closeDashboard(){ $('dashboard').classList.remove('is-open'); }
```

- [ ] **Step 4: Wire the controls** — add inside `wireControls()` (`js/app.js:930-1014`), near the other panel handlers:

```javascript
  $('setHaUrl').addEventListener('change', () => { app.settings.haUrl = $('setHaUrl').value.trim(); persist(); });
  $('setHaToken').addEventListener('change', () => { app.settings.haToken = $('setHaToken').value.trim(); persist(); });
  $('setHaConnect').addEventListener('click', () => {
    app.settings.haUrl = $('setHaUrl').value.trim();
    app.settings.haToken = $('setHaToken').value.trim();
    persist(); setHaStatusText('connecting'); connectHA();
  });
  $('btnDashboard').addEventListener('click', openDashboard);
  $('dashClose').addEventListener('click', closeDashboard);
```

- [ ] **Step 5: Reflect state in `syncButtons()`** — add before `syncDimButton();` at `js/app.js:500`:

```javascript
  const hasDash = !!resolveDashboard(app._dashboards, app.settings.profile);
  $('btnDashboard').hidden = !(app._haStatus === 'authed' && hasDash);
  if ($('setHaUrl') && document.activeElement !== $('setHaUrl')) $('setHaUrl').value = app.settings.haUrl || '';
```

- [ ] **Step 6: Bootstrap polling + connect** — in the poll setup (`js/app.js:1211-1214`), add `pollDashboards` to the initial call, the interval, and the refocus handler, then connect HA once at startup. Change the block to:

```javascript
    pollAnnounce(); pollProfiles(); pollSource(); pollDashboards();
    app.announceTimer = setInterval(() => { pollAnnounce(); pollProfiles(); pollSource(); pollDashboards(); }, ANNOUNCE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden){ pollAnnounce(); pollProfiles(); pollSource(); pollDashboards(); } });
```

And after that `try/catch`, restore the cached dashboards + connect:

```javascript
  try { app._dashboards = validateDashboards(JSON.parse(localStorage.getItem(DASHBOARDS_KEY) || 'null')); } catch(_){}
  connectHA();
```

- [ ] **Step 7: Update the service worker** — in `sw.js`, bump `SHELL`/`RUNTIME` to `v21` (`:4-5`), add the new modules to `SHELL_FILES` (`:7-28`):

```javascript
  './js/ha.js',
  './js/ha-protocol.js',
  './js/ha-dashboard.js',
  './js/dashboard-view.js',
```

and add `dashboards.json` to the network-first predicate (`sw.js:50-53`), matching the `profiles.json` clause:

```javascript
      || url.pathname === '/dashboards.json'
```

- [ ] **Step 8: Verify end-to-end.** Run the tests, then drive it:

```bash
npm test
python3 -m http.server 8000
```

Open `http://localhost:8000`, gear → enter a reachable HA URL + long-lived token → **Connect**. Expected: `haStatus` shows `● Connected`. Set the Profile to one that has a dashboard defined (seed `dashboards.json` per Task 9 first, or drop a test file at repo root). Expected: the **Dashboard** button appears in the chrome band; tapping it opens the overlay with live tiles; toggling a `toggle` tile flips the entity in HA. (If you have no HA handy, confirm graceful behavior: `haStatus` shows `Connecting…` then the button stays hidden.)

- [ ] **Step 9: Commit**

```bash
git add js/app.js sw.js
git commit -m "feat: wire HA client + per-profile dashboard into the app"
```

---

### Task 9: Admin editor + server plumbing for dashboards.json

**Files:**
- Modify: `admin.html` (add a Dashboards section mirroring the profiles pattern `:264-323`)
- Modify: `nginx.conf` (add a `location = /dashboards.json` block mirroring `:65-76`)
- Create: `dashboards.json` (repo-root seed: `{ "version": 1, "profiles": {} }`, mirroring `profiles.json`)

**Interfaces:**
- Produces `/data/dashboards.json` served open-GET, PUT gated by admin auth — consumed by `pollDashboards` (Task 8).

- [ ] **Step 1: Seed file.** Create `dashboards.json` at repo root:

```json
{ "version": 1, "profiles": {} }
```

- [ ] **Step 2: nginx block.** In `nginx.conf`, after the `/source.json` block (`:90`), add (identical to the profiles block but for the new path):

```nginx
  # Admin-managed per-profile HA dashboards. Written via WebDAV PUT from the
  # admin page (auth-gated); polled by every device. Holds no secrets.
  location = /dashboards.json {
    root /data;
    default_type application/json;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    expires off;
    dav_methods PUT;
    create_full_put_path off;
    client_body_temp_path /data/tmp;
    client_max_body_size 256k;
    limit_except GET { include /etc/nginx/admin_auth.conf; }
  }
```

- [ ] **Step 3: Admin UI.** In `admin.html`, add a Dashboards section modeled on `putProfiles`/`loadProfiles` (`:264-286`). Add markup near the profiles section:

```html
  <section id="dashboardsSection">
    <h2>Profile dashboards</h2>
    <label for="dashProfile">Profile</label>
    <select id="dashProfile"></select>
    <textarea id="dashJson" rows="16" spellcheck="false"
      placeholder='[{ "type": "toggle", "entity": "light.guest", "label": "Ceiling", "icon": "💡" }]'></textarea>
    <div id="dashStatus" aria-live="polite"></div>
    <button id="dashSave" type="button">Save dashboard</button>
  </section>
```

and the script. Match the existing admin.html style verbatim: the `$()` id-helper, ES5 `function`s, and a bare `PUT` with **only** a `Content-Type` header — the admin page is already behind nginx basic-auth, so the browser attaches credentials automatically (see `putProfiles()` `admin.html:264-269`, which sends no auth header). Reuse the existing `BUILTINS` and `customProfiles` globals the profiles editor maintains (`admin.html:283`):

```javascript
    var dashboards = { version: 1, profiles: {} };

    function putDashboards(){
      return fetch('dashboards.json', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(dashboards, null, 2)
      });
    }
    function setDashStatus(msg, ok){ var s=$('dashStatus'); s.textContent=msg; s.className='status '+(ok===true?'ok':ok===false?'err':''); }

    function loadDashboards(){
      return fetch('dashboards.json?ts=' + Date.now(), { cache:'no-store' }).then(function(r){
        return r.ok ? r.json() : { version:1, profiles:{} };
      }).then(function(j){
        dashboards = (j && typeof j === 'object' && j.profiles) ? j : { version:1, profiles:{} };
        if (!dashboards.profiles) dashboards.profiles = {};
      }).catch(function(){ dashboards = { version:1, profiles:{} }; });
    }
    function fillDashProfiles(){
      var sel = $('dashProfile'); sel.innerHTML = '';
      // Same rooms the profiles editor exposes: built-ins + admin customs.
      BUILTINS.concat(customProfiles).forEach(function(name){
        var o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o);
      });
      showDashJson();
    }
    function showDashJson(){
      var name = $('dashProfile').value;
      var block = dashboards.profiles[name];
      $('dashJson').value = JSON.stringify((block && block.tiles) || [], null, 2);
    }
    function saveDashboard(){
      var name = $('dashProfile').value, tiles;
      try { tiles = JSON.parse($('dashJson').value); }
      catch(e){ setDashStatus('Invalid JSON.', false); return; }
      if (!Array.isArray(tiles)){ setDashStatus('Expected a JSON array of tiles.', false); return; }
      dashboards.version = 1;
      dashboards.profiles[name] = { title: name, tiles: tiles };
      setDashStatus('Saving…');
      putDashboards().then(function(r){
        setDashStatus(r.ok ? 'Saved.' : 'Failed (HTTP '+r.status+').', r.ok);
      }).catch(function(e){ setDashStatus('Failed: '+e, false); });
    }
    $('dashProfile').addEventListener('change', showDashJson);
    $('dashSave').addEventListener('click', saveDashboard);
```

> Implementer note: `BUILTINS` and `customProfiles` are the existing admin.html globals (`admin.html:283`, `:291`). Do not redeclare them. If `customProfiles` is populated asynchronously by `loadProfiles()`, call `fillDashProfiles()` after both `loadProfiles()` and `loadDashboards()` resolve (Step 4).

- [ ] **Step 4: Wire load on page init.** Where `admin.html` calls `loadProfiles()` on startup, also call `loadDashboards().then(fillDashProfiles)`.

- [ ] **Step 5: Verify.** Run the container (or `python3 -m http.server` won't accept PUT — use the real nginx via `docker-compose up`). In `admin.html`, pick a profile, paste the placeholder tile array, Save. Expected: `Saved.`; `GET /dashboards.json` returns the object with your profile. Then on a display set to that profile with HA connected, the Dashboard button appears.

- [ ] **Step 6: Commit**

```bash
git add admin.html nginx.conf dashboards.json
git commit -m "feat: admin editor + nginx serving for per-profile dashboards.json"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md` (add an HA-dashboard section)

- [ ] **Step 1: Document setup.** Add a section to `README.md`:

```markdown
## Home Assistant dashboards (per profile)

Each display can show a native control dashboard for its room, backed by your
Home Assistant instance.

**On the display (per device):** open Settings → enter your **Home Assistant
URL** (e.g. `https://ha.local:8123`) and a **long-lived access token**
(HA → your profile → Security → Long-lived access tokens → Create). Tap
**Connect**. The token is stored only on that device and never uploaded.

> Create a **dedicated Home Assistant user** for displays and generate the token
> as that user — a long-lived token inherits its user's permissions, so this
> scopes the display's blast radius.

**Define a dashboard (admin):** in `admin.html` → *Profile dashboards*, pick a
profile and enter a JSON array of tiles:

- `sensor` — `{ "type": "sensor", "entity": "sensor.guest_temp", "unit": "°C" }`
- `toggle` — `{ "type": "toggle", "entity": "light.guest", "label": "Ceiling", "icon": "💡" }`
- `scene`/`button` — `{ "type": "scene", "service": "scene.turn_on", "target": "scene.night", "label": "Night" }`
- `climate` — `{ "type": "climate", "entity": "climate.guest", "label": "Heat" }` (tap left/right to nudge the setpoint)

The **Dashboard** button appears on a display only when HA is connected and the
device's active Profile has a dashboard defined.

**Home Assistant configuration (required):**

- **CORS** — add the clock's origin to `http.cors_allowed_origins` in HA's
  `configuration.yaml`:
  ```yaml
  http:
    cors_allowed_origins:
      - https://clock.example.com
  ```
- **HTTPS/WSS** — if the clock is served over HTTPS, HA must be reachable over
  HTTPS (`wss://…/api/websocket`) or the browser blocks the connection
  (mixed content).
```

- [ ] **Step 2: Verify.** Render/read the README section; confirm the tile examples match the schema in `js/ha-dashboard.js` (`sensor`/`toggle`/`scene`/`button`/`climate`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Home Assistant per-profile dashboard setup"
```

---

## Self-Review

**Spec coverage:**
- Native render via API — Tasks 1-4, 6, 8. ✓
- Per-device token in localStorage — Task 5. ✓
- Per-profile `dashboards.json`, shared, no secrets — Tasks 1, 9. ✓
- WebSocket transport (auth, get_states, subscribe, call_service) — Tasks 3-4. ✓
- 4 MVP tile types incl. climate — Tasks 1-2, 6. ✓
- Device connection UX + status — Tasks 7-8. ✓
- Admin JSON editor — Task 9. ✓
- Nav/lifecycle + button visibility gate — Tasks 7-8. ✓
- Reconnect/backoff, auth_invalid surfaced, unavailable tiles — Tasks 2, 4, 8. ✓
- CORS + mixed-content docs, dedicated-user guidance — Task 10. ✓
- Testing of pure fns + mock-WS client — Tasks 1-6. ✓
- Out of scope (no sidecar/HACS changes, deferred tile types) respected. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. Task 9 reuses the real admin.html globals `BUILTINS`/`customProfiles` and the header-less `PUT` pattern from `putProfiles()` (`admin.html:264-269`) — verified against source, not invented.

**Type consistency:** `tileAction`/`projectTile`/`resolveDashboard`/`validateDashboards` signatures match across Tasks 1-2, 6, 8. `createHaClient({url, token, socketFactory, onEntities, onStatus})` and `callService(action)` match across Tasks 4 and 8. Status strings (`connecting|authenticating|authed|auth_invalid`, plus app-level `off`) are consistent between Tasks 3, 4, and 8. Settings keys `haUrl`/`haToken` consistent across Tasks 5, 7, 8, 10.
