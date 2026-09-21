// test/ha-protocol.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initHaState, reduceMessage } from '../js/ha-protocol.js';

test('auth_required triggers an auth message', () => {
  const s0 = initHaState('TOKEN');
  const { state, sends, status } = reduceMessage(s0, { type: 'auth_required' });
  assert.equal(status, 'authenticating');
  assert.deepEqual(sends, [{ type: 'auth', access_token: 'TOKEN' }]);
  assert.equal(state.phase, 'authenticating');
});

test('auth_ok subscribes and requests states', () => {
  let s = initHaState('T');
  s = reduceMessage(s, { type: 'auth_required' }).state;
  const r = reduceMessage(s, { type: 'auth_ok' });
  assert.equal(r.status, 'authed');
  assert.equal(r.sends.length, 2);
  assert.equal(r.sends[0].type, 'get_states');
  assert.deepEqual(r.sends[1], { id: r.sends[1].id, type: 'subscribe_events', event_type: 'state_changed' });
});

test('auth_invalid is terminal', () => {
  const s0 = initHaState('bad');
  const r = reduceMessage(s0, { type: 'auth_invalid' });
  assert.equal(r.status, 'auth_invalid');
  assert.deepEqual(r.sends, []);
});

test('get_states result seeds the entity cache', () => {
  let s = initHaState('T');
  const r = reduceMessage(s, {
    type: 'result', success: true,
    result: [{ entity_id: 'light.a', state: 'on', attributes: {} }],
  });
  assert.equal(r.state.entities['light.a'].state, 'on');
});

test('state_changed event updates one entity', () => {
  let s = initHaState('T');
  s.entities['light.a'] = { entity_id: 'light.a', state: 'on', attributes: {} };
  const r = reduceMessage(s, {
    type: 'event',
    event: { event_type: 'state_changed', data: { entity_id: 'light.a', new_state: { entity_id: 'light.a', state: 'off', attributes: {} } } },
  });
  assert.equal(r.state.entities['light.a'].state, 'off');
});
