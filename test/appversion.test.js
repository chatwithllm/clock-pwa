import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, versionChanged, reloadDelayMs } from '../js/appversion.js';

test('parseVersion reads the stamped build id', () => {
  assert.equal(parseVersion({ v: 'a1b2c3d4e5f6' }), 'a1b2c3d4e5f6');
});

test('parseVersion tolerates missing or malformed payloads', () => {
  assert.equal(parseVersion(null), '');
  assert.equal(parseVersion({}), '');
  assert.equal(parseVersion({ v: '' }), '');
  assert.equal(parseVersion({ v: 42 }), '');
  assert.equal(parseVersion('nope'), '');
});

test('versionChanged fires only on a real, known-to-known change', () => {
  assert.equal(versionChanged('aaa', 'bbb'), true);
  assert.equal(versionChanged('aaa', 'aaa'), false);
  // first observation (nothing known yet) and failed fetches never reload
  assert.equal(versionChanged('', 'bbb'), false);
  assert.equal(versionChanged('aaa', ''), false);
  assert.equal(versionChanged('', ''), false);
});

test('reloadDelayMs spreads the fleet across the jitter window', () => {
  assert.equal(reloadDelayMs(0), 0);
  assert.equal(reloadDelayMs(0.5), 15000);
  assert.ok(reloadDelayMs(0.999999) < 30000);
  // out-of-range randomness is clamped rather than producing a negative or huge delay
  assert.equal(reloadDelayMs(-1), 0);
  assert.ok(reloadDelayMs(5) < 30000);
});
