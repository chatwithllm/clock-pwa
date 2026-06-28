import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionScore, presenceReducer, shouldSnapshot } from '../js/presence.js';

test('motionScore: identical frames score 0', () => {
  assert.equal(motionScore([10,20,30], [10,20,30]), 0);
});

test('motionScore: full swing scores ~255', () => {
  assert.equal(motionScore([0,0,0], [255,255,255]), 255);
});

test('motionScore: null / mismatched -> 0 (no baseline)', () => {
  assert.equal(motionScore(null, [1,2,3]), 0);
  assert.equal(motionScore([1,2], [1,2,3]), 0);
});

test('presenceReducer: motion -> present, stamps lastMotion', () => {
  const s = presenceReducer({present:false, lastMotionMs:0}, true, 1000, 90000);
  assert.equal(s.present, true);
  assert.equal(s.lastMotionMs, 1000);
});

test('presenceReducer: no motion within grace stays present', () => {
  const s = presenceReducer({present:true, lastMotionMs:1000}, false, 1000+89000, 90000);
  assert.equal(s.present, true);
});

test('presenceReducer: no motion past grace -> away', () => {
  const s = presenceReducer({present:true, lastMotionMs:1000}, false, 1000+90000, 90000);
  assert.equal(s.present, false);
});

test('shouldSnapshot: gated by cooldown', () => {
  assert.equal(shouldSnapshot(1000, 1000+299999, 300000), false);
  assert.equal(shouldSnapshot(1000, 1000+300000, 300000), true);
  assert.equal(shouldSnapshot(-Infinity, 0, 300000), true);
});
