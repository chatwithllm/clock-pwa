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
  assert.equal(s.haCalendarEntity, 'calendar.matrix');
  s.haUrl = 'https://ha.local:8123';
  s.haToken = 'llt_secret';
  s.haCalendarEntity = 'calendar.family';
  saveSettings(s);
  const again = loadSettings();
  assert.equal(again.haUrl, 'https://ha.local:8123');
  assert.equal(again.haToken, 'llt_secret');
  assert.equal(again.haCalendarEntity, 'calendar.family');
});
