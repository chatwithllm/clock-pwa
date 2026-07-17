import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHaClient } from '../js/ha.js';

// Minimal fake WebSocket that captures sends and lets the test push messages.
class FakeWS {
  constructor(url) { this.url = url; this.sent = []; FakeWS.last = this; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; if (this.onclose) this.onclose(); }
  emit(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
}

test('client authenticates then reports authed + entities', () => {
  let status = null; let entities = null;
  const client = createHaClient({
    url: 'https://ha.local', token: 'T',
    socketFactory: (u) => new FakeWS(u),
    onStatus: (s) => { status = s; },
    onEntities: (e) => { entities = e; },
  });
  const ws = FakeWS.last;
  assert.match(ws.url, /\/api\/websocket$/);
  ws.onopen && ws.onopen();
  ws.emit({ type: 'auth_required' });
  assert.deepEqual(ws.sent[0], { type: 'auth', access_token: 'T' });
  ws.emit({ type: 'auth_ok' });
  assert.equal(status, 'authed');
  ws.emit({ type: 'result', success: true, result: [{ entity_id: 'light.a', state: 'on', attributes: {} }] });
  assert.equal(entities['light.a'].state, 'on');
  client.close();
  assert.equal(ws.closed, true);
});

test('callService sends a call_service frame once authed', () => {
  const client = createHaClient({ url: 'https://ha.local', token: 'T', socketFactory: (u) => new FakeWS(u), onStatus() {}, onEntities() {} });
  const ws = FakeWS.last;
  ws.onopen && ws.onopen();
  ws.emit({ type: 'auth_required' });
  ws.emit({ type: 'auth_ok' });
  client.callService({ domain: 'light', service: 'toggle', service_data: { entity_id: 'light.a' } });
  const frame = ws.sent.find((m) => m.type === 'call_service');
  assert.deepEqual({ domain: frame.domain, service: frame.service, service_data: frame.service_data },
    { domain: 'light', service: 'toggle', service_data: { entity_id: 'light.a' } });
});

test('callService no-ops after close() even if still authed', () => {
  const client = createHaClient({ url: 'https://ha.local', token: 'T', socketFactory: (u) => new FakeWS(u), onStatus() {}, onEntities() {} });
  const ws = FakeWS.last;
  ws.onopen && ws.onopen();
  ws.emit({ type: 'auth_required' });
  ws.emit({ type: 'auth_ok' });
  const sentLengthBeforeClose = ws.sent.length;
  client.close();
  client.callService({ domain: 'light', service: 'toggle', service_data: { entity_id: 'light.a' } });
  assert.equal(ws.sent.length, sentLengthBeforeClose, 'no new frame sent after close()');
});
