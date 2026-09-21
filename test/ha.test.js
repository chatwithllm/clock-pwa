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
  assert.ok(ws.url.startsWith('wss://'), 'https:// must convert to wss://: ' + ws.url);
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

test('onclose schedules a reconnect that opens a new socket; close()/auth_invalid suppress it', () => {
  const realSetTimeout = globalThis.setTimeout;
  const calls = [];
  globalThis.setTimeout = (cb, ms) => { calls.push({ cb, ms }); return calls.length; };
  try {
    // Reconnect path: onclose while authed schedules a timer; invoking that
    // timer's callback opens a fresh FakeWS via the factory.
    const client = createHaClient({
      url: 'https://ha.local', token: 'T',
      socketFactory: (u) => new FakeWS(u),
      onStatus() {}, onEntities() {},
    });
    const ws1 = FakeWS.last;
    ws1.onopen && ws1.onopen();
    ws1.emit({ type: 'auth_required' });
    ws1.emit({ type: 'auth_ok' });
    assert.equal(calls.length, 0, 'no reconnect scheduled while still connected');
    ws1.onclose();
    assert.equal(calls.length, 1, 'onclose while authed schedules a reconnect');
    const scheduled = calls[0].cb;
    assert.equal(FakeWS.last, ws1, 'no new socket created until the timer fires');
    scheduled();
    assert.notEqual(FakeWS.last, ws1, 'invoking the scheduled callback opens a new socket');

    // close(): onclose after an explicit close() must NOT schedule a reconnect.
    calls.length = 0;
    const ws2 = FakeWS.last;
    ws2.onopen && ws2.onopen();
    ws2.emit({ type: 'auth_required' });
    ws2.emit({ type: 'auth_ok' });
    client.close();
    ws2.onclose && ws2.onclose();
    assert.equal(calls.length, 0, 'no reconnect scheduled after close()');

    // auth_invalid: onclose after an auth_invalid message must NOT reconnect.
    calls.length = 0;
    const client2 = createHaClient({
      url: 'https://ha.local', token: 'BAD',
      socketFactory: (u) => new FakeWS(u),
      onStatus() {}, onEntities() {},
    });
    const ws3 = FakeWS.last;
    ws3.onopen && ws3.onopen();
    ws3.emit({ type: 'auth_required' });
    ws3.emit({ type: 'auth_invalid' });
    ws3.onclose();
    assert.equal(calls.length, 0, 'no reconnect scheduled after auth_invalid');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('http:// URL converts to ws://', () => {
  const client = createHaClient({ url: 'http://ha.local', token: 'T', socketFactory: (u) => new FakeWS(u), onStatus() {}, onEntities() {} });
  const ws = FakeWS.last;
  assert.ok(ws.url.startsWith('ws://'), 'http:// must convert to ws://: ' + ws.url);
  assert.ok(!ws.url.startsWith('wss://'), 'http:// must not convert to wss://');
});
