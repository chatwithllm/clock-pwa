// js/ha-protocol.js — pure HA WebSocket message logic (no socket).

export function initHaState(token) {
  return { phase: 'connecting', token, entities: {}, nextId: 1 };
}

function withId(state) {
  const id = state.nextId;
  return { id, state: { ...state, nextId: id + 1 } };
}

export function reduceMessage(haState, msg) {
  let state = haState;
  const sends = [];
  let status = state.phase;

  switch (msg && msg.type) {
    case 'auth_required':
      state = { ...state, phase: 'authenticating' };
      status = 'authenticating';
      sends.push({ type: 'auth', access_token: state.token });
      break;
    case 'auth_ok': {
      const a = withId(state); const b = withId(a.state);
      state = { ...b.state, phase: 'authed' };
      status = 'authed';
      sends.push({ id: a.id, type: 'get_states' });
      sends.push({ id: b.id, type: 'subscribe_events', event_type: 'state_changed' });
      break;
    }
    case 'auth_invalid':
      state = { ...state, phase: 'auth_invalid' };
      status = 'auth_invalid';
      break;
    case 'result':
      if (msg.success && Array.isArray(msg.result)) {
        const entities = { ...state.entities };
        for (const e of msg.result) if (e && e.entity_id) entities[e.entity_id] = e;
        state = { ...state, entities };
      }
      break;
    case 'event':
      if (msg.event && msg.event.event_type === 'state_changed' && msg.event.data) {
        const d = msg.event.data;
        const entities = { ...state.entities };
        if (d.new_state) entities[d.entity_id] = d.new_state;
        else delete entities[d.entity_id];
        state = { ...state, entities };
      }
      break;
    default:
      break;
  }
  return { state, sends, status };
}

export function callServiceMessage(id, action) {
  return { id, type: 'call_service', domain: action.domain, service: action.service, service_data: action.service_data };
}
