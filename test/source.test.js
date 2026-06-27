import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceToModes, resolveServerSource, legacySource } from '../js/source.js';

test('server maps to host time + server location', () => {
  assert.deepEqual(sourceToModes('server'), { timeSource:'server', locationMode:'server' });
});

test('local maps to device time + custom location', () => {
  assert.deepEqual(sourceToModes('local'), { timeSource:'device', locationMode:'custom' });
});

test('forced server push locks the client', () => {
  assert.deepEqual(resolveServerSource({ mode:'server', force:true }, true), { source:'server', locked:true });
});

test('default push applies only when the user has not chosen', () => {
  assert.deepEqual(resolveServerSource({ mode:'local', force:false }, false), { source:'local', locked:false });
  assert.equal(resolveServerSource({ mode:'local', force:false }, true), null);
});

test('absent or malformed file means no server opinion', () => {
  assert.equal(resolveServerSource(null, false), null);
  assert.equal(resolveServerSource({ mode:'bogus' }, false), null);
});

test('legacySource: both server -> server', () => { assert.equal(legacySource('server','server'), 'server'); });
test('legacySource: any non-both-server -> local', () => {
  assert.equal(legacySource('device','server'), 'local');
  assert.equal(legacySource('server','custom'), 'local');
  assert.equal(legacySource('device','custom'), 'local');
});
