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

test('validateDashboards keeps a valid status tile, drops one missing entity', () => {
  const out = validateDashboards({
    version: 1,
    profiles: {
      Kitchen: {
        tiles: [
          {
            type: 'status', entity: 'sensor.sonoff_s31_two_energy_power', label: 'Dishwasher', unit: 'W',
            thresholds: [{ above: 10, text: 'Running', icon: '🟢' }],
            default: { text: 'Idle', icon: '⚪' },
          },
          { type: 'status', label: 'No entity here' }, // missing entity -> dropped
        ],
      },
    },
  });
  assert.equal(out.profiles.Kitchen.tiles.length, 1);
  const tile = out.profiles.Kitchen.tiles[0];
  assert.equal(tile.type, 'status');
  assert.equal(tile.entity, 'sensor.sonoff_s31_two_energy_power');
  assert.equal(tile.label, 'Dishwasher');
  assert.equal(tile.unit, 'W');
  assert.deepEqual(tile.thresholds, [{ above: 10, text: 'Running', icon: '🟢' }]);
  assert.deepEqual(tile.default, { text: 'Idle', icon: '⚪' });
});

test('validateDashboards drops malformed threshold entries but keeps well-formed ones', () => {
  const out = validateDashboards({
    version: 1,
    profiles: {
      Kitchen: {
        tiles: [
          {
            type: 'status', entity: 'sensor.x',
            thresholds: [
              { above: 10, text: 'Running' },
              { above: 'nope', text: 'Bad above' },
              { above: 5, text: 42 },
              { text: 'No above' },
              { above: 20, text: 'High', icon: '🔥' },
            ],
          },
        ],
      },
    },
  });
  const tile = out.profiles.Kitchen.tiles[0];
  assert.deepEqual(tile.thresholds, [
    { above: 10, text: 'Running' },
    { above: 20, text: 'High', icon: '🔥' },
  ]);
});

test('tileAction: status is read-only', () => {
  assert.equal(tileAction({ type: 'status', entity: 'sensor.x' }, { state: '42' }), null);
});

test('projectTile: status picks matching threshold band', () => {
  const tile = {
    type: 'status', entity: 'sensor.power', label: 'Dishwasher', unit: 'W',
    thresholds: [{ above: 10, text: 'Running', icon: '🟢' }],
    default: { text: 'Idle', icon: '⚪' },
  };
  const running = projectTile(tile, { state: '42' });
  assert.equal(running.available, true);
  assert.equal(running.statusText, 'Running');
  assert.equal(running.statusIcon, '🟢');
  assert.equal(running.value, '42');
  assert.equal(running.unit, 'W');

  const idle = projectTile(tile, { state: '2' });
  assert.equal(idle.statusText, 'Idle');
  assert.equal(idle.statusIcon, '⚪');
  assert.equal(idle.value, '2');
});

test('projectTile: status falls back to default when entity unavailable', () => {
  const tile = {
    type: 'status', entity: 'sensor.power', label: 'Dishwasher',
    thresholds: [{ above: 10, text: 'Running', icon: '🟢' }],
    default: { text: 'Idle', icon: '⚪' },
  };
  const p = projectTile(tile, undefined);
  assert.equal(p.available, false);
  assert.equal(p.statusText, 'Idle');
  assert.equal(p.statusIcon, '⚪');
  assert.equal(p.value, '—');
});

test('projectTile: status picks the highest matching threshold', () => {
  const tile = {
    type: 'status', entity: 'sensor.power',
    thresholds: [
      { above: 10, text: 'Running', icon: '🟢' },
      { above: 100, text: 'High Load', icon: '🔴' },
      { above: 50, text: 'Busy', icon: '🟡' },
    ],
    default: { text: 'Idle', icon: '⚪' },
  };
  assert.equal(projectTile(tile, { state: '150' }).statusText, 'High Load');
  assert.equal(projectTile(tile, { state: '75' }).statusText, 'Busy');
  assert.equal(projectTile(tile, { state: '15' }).statusText, 'Running');
  assert.equal(projectTile(tile, { state: '5' }).statusText, 'Idle');
});

test('projectTile: status with no thresholds always uses default', () => {
  const tile = { type: 'status', entity: 'sensor.power', default: { text: 'Idle', icon: '⚪' } };
  assert.equal(projectTile(tile, { state: '999' }).statusText, 'Idle');
});

test('projectTile: status non-finite value falls back to default', () => {
  const tile = {
    type: 'status', entity: 'sensor.power',
    thresholds: [{ above: 10, text: 'Running', icon: '🟢' }],
    default: { text: 'Idle', icon: '⚪' },
  };
  const p = projectTile(tile, { state: 'garbage' });
  assert.equal(p.statusText, 'Idle');
});

test('projectTile: non-status tile has no statusText/statusIcon', () => {
  const p = projectTile({ type: 'sensor', entity: 'sensor.x', unit: '°C' }, { state: '5' });
  assert.ok(p.statusText === undefined || p.statusText === null);
  assert.ok(p.statusIcon === undefined || p.statusIcon === null);
});
