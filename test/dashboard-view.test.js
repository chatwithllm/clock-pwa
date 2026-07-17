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
test('status tile gets dash-status type class', () => {
  assert.ok(tileClassList({ type: 'status', available: true }).includes('dash-status'));
});
test('status tile unavailable gets is-unavailable', () => {
  assert.ok(tileClassList({ type: 'status', available: false }).includes('is-unavailable'));
});
