import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertView } from '../js/alertview.js';

const A = (o) => Object.assign({ key:'k', severity:'critical', title:'T', message:'m', target:'all', ts:1 }, o);

test('drops entries with no key or message', () => {
  const out = alertView([A({key:''}), A({message:''}), A({key:'ok'})], 'None');
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'ok');
});

test('target all shows everywhere; targeted matches profile only', () => {
  const list = [A({key:'a', target:'all'}), A({key:'b', target:'Kitchen'})];
  assert.deepEqual(alertView(list, 'Kitchen').map(x=>x.key), ['a','b']);
  assert.deepEqual(alertView(list, 'Bedroom').map(x=>x.key), ['a']);
});

test('critical sorts before warning', () => {
  const out = alertView([A({key:'w', severity:'warning', ts:5}), A({key:'c', severity:'critical', ts:1})], 'None');
  assert.deepEqual(out.map(x=>x.key), ['c','w']);
});

test('within a tier, newest ts first', () => {
  const out = alertView([A({key:'old', ts:1}), A({key:'new', ts:9})], 'None');
  assert.deepEqual(out.map(x=>x.key), ['new','old']);
});

test('garbage input yields empty array', () => {
  assert.deepEqual(alertView(null, 'x'), []);
  assert.deepEqual(alertView('nope', 'x'), []);
});

import { alertIcon } from '../js/alertview.js';

test('alertIcon: known types map to emoji', () => {
  assert.equal(alertIcon('water_leak'), '💧');
  assert.equal(alertIcon('door'), '🚪');
  assert.equal(alertIcon('security'), '🔒');
  assert.equal(alertIcon('smoke'), '🔥');
});

test('alertIcon: unknown / missing -> warning default', () => {
  assert.equal(alertIcon('nope'), '⚠️');
  assert.equal(alertIcon(undefined), '⚠️');
  assert.equal(alertIcon(null), '⚠️');
});

import { alertRailView, RAIL_TOP, RAIL_BOTTOM } from '../js/alertview.js';

test('alertRailView: known type -> its own slot at the right severity', () => {
  const out = alertRailView([A({key:'k1', type:'water_leak', severity:'critical'})], 'None');
  assert.deepEqual(out, { water_leak: 'critical' });
});

test('alertRailView: unrecognized type buckets into "other"', () => {
  const out = alertRailView([A({key:'k1', type:'earthquake', severity:'warning'})], 'None');
  assert.deepEqual(out, { other: 'warning' });
});

test('alertRailView: missing type also buckets into "other"', () => {
  const out = alertRailView([A({key:'k1', severity:'warning'})], 'None');
  assert.deepEqual(out, { other: 'warning' });
});

test('alertRailView: same slot takes the worse (critical) severity', () => {
  const out = alertRailView([
    A({key:'k1', type:'door', severity:'warning'}),
    A({key:'k2', type:'door', severity:'critical'}),
  ], 'None');
  assert.deepEqual(out, { door: 'critical' });
});

test('alertRailView: "spare" is never a real type -> falls into "other"', () => {
  const out = alertRailView([A({key:'k1', type:'spare', severity:'warning'})], 'None');
  assert.deepEqual(out, { other: 'warning' });
});

test('alertRailView: respects target/profile filtering', () => {
  const list = [A({key:'k1', type:'smoke', target:'Kitchen', severity:'critical'})];
  assert.deepEqual(alertRailView(list, 'Kitchen'), { smoke: 'critical' });
  assert.deepEqual(alertRailView(list, 'Bedroom'), {});
});

test('alertRailView: garbage input yields empty object', () => {
  assert.deepEqual(alertRailView(null, 'x'), {});
});

test('RAIL_TOP + RAIL_BOTTOM: 6 slots each, cover all 10 known types + other + spare', () => {
  assert.equal(RAIL_TOP.length, 6);
  assert.equal(RAIL_BOTTOM.length, 6);
  const all = [...RAIL_TOP, ...RAIL_BOTTOM];
  assert.equal(new Set(all).size, 12);
  assert.ok(all.includes('other'));
  assert.ok(all.includes('spare'));
});
