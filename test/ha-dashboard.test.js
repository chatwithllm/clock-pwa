import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDashboards, resolveDashboard, tileAction, projectTile } from '../js/ha-dashboard.js';

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

test('projectTile: stateless scene/button tile is available', () => {
  const p = projectTile({ type: 'scene', service: 'scene.turn_on', target: 'scene.night', label: 'Night' }, undefined);
  assert.equal(p.available, true);
});

test('tileAction: climate with no setpoint attribute is a no-op', () => {
  assert.equal(tileAction({ type: 'climate', entity: 'climate.t' }, { state: 'off', attributes: {} }, +1), null);
});
