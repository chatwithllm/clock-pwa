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
