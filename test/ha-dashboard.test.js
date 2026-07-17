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
