// js/ha.js — thin HA WebSocket runtime around the pure protocol reducer.
import { initHaState, reduceMessage, callServiceMessage } from './ha-protocol.js';

const MAX_BACKOFF = 30000;

export function createHaClient({ url, token, socketFactory, onEntities, onStatus }) {
  const mkSocket = socketFactory || ((u) => new WebSocket(u));
  const wsUrl = String(url).trim().replace(/\/+$/, '').replace(/^http/i, 'ws') + '/api/websocket';
  let state = initHaState(token);
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  let nextId = 100; // call_service ids live above the handshake ids

  function connect() {
    if (stopped) return;
    onStatus && onStatus('connecting');
    ws = mkSocket(wsUrl);
    state = initHaState(token);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const r = reduceMessage(state, msg);
      state = r.state;
      for (const out of r.sends) ws.send(JSON.stringify(out));
      onStatus && onStatus(r.status);
      onEntities && onEntities(state.entities);
      if (r.status === 'authed') backoff = 1000; // healthy connection resets backoff
    };
    ws.onclose = () => {
      if (stopped || state.phase === 'auth_invalid') return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    };
  }
  connect();

  return {
    callService(action) {
      if (stopped || !ws || state.phase !== 'authed') return;
      ws.send(JSON.stringify(callServiceMessage(nextId++, action)));
    },
    close() { stopped = true; if (ws) ws.close(); },
  };
}
