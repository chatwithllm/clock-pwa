// js/ha-dashboard.js — pure dashboard logic (no DOM, no sockets).

const TILE_TYPES = new Set(['sensor', 'toggle', 'scene', 'button', 'climate']);

function validTile(t) {
  if (!t || typeof t !== 'object' || !TILE_TYPES.has(t.type)) return null;
  const tile = { type: t.type };
  if (typeof t.entity === 'string' && t.entity) tile.entity = t.entity;
  if (typeof t.service === 'string' && t.service) tile.service = t.service;
  if (typeof t.target === 'string' && t.target) tile.target = t.target;
  if (typeof t.label === 'string') tile.label = t.label;
  if (typeof t.icon === 'string') tile.icon = t.icon;
  if (typeof t.unit === 'string') tile.unit = t.unit;
  // Type-specific required bindings.
  if ((t.type === 'sensor' || t.type === 'toggle' || t.type === 'climate') && !tile.entity) return null;
  if ((t.type === 'scene' || t.type === 'button') && !(tile.service && tile.target) && !tile.entity) return null;
  return tile;
}

export function validateDashboards(raw) {
  const out = { version: 1, profiles: {} };
  if (!raw || typeof raw !== 'object' || !raw.profiles || typeof raw.profiles !== 'object') return out;
  for (const [name, block] of Object.entries(raw.profiles)) {
    if (!block || typeof block !== 'object' || !Array.isArray(block.tiles)) continue;
    const tiles = block.tiles.map(validTile).filter(Boolean);
    out.profiles[name] = {
      title: typeof block.title === 'string' && block.title ? block.title : name,
      tiles,
    };
  }
  return out;
}

export function resolveDashboard(dashboards, profileName) {
  if (!dashboards || !dashboards.profiles || !profileName || profileName === 'None') return null;
  return dashboards.profiles[profileName] || null;
}

const CLIMATE_STEP = 0.5;

function domainOf(entityId) { return String(entityId || '').split('.')[0]; }
function isOn(state) { return !!state && state.state === 'on'; }
function isAvailable(state) { return !!state && state.state !== 'unavailable' && state.state !== 'unknown'; }

export function tileAction(tile, state, dir = 0) {
  if (!tile) return null;
  if (tile.type === 'toggle') {
    return { domain: domainOf(tile.entity), service: 'toggle', service_data: { entity_id: tile.entity } };
  }
  if (tile.type === 'scene' || tile.type === 'button') {
    const svc = tile.service || (tile.type === 'button' ? 'button.press' : 'scene.turn_on');
    const [domain, service] = svc.split('.');
    return { domain, service, service_data: { entity_id: tile.target || tile.entity } };
  }
  if (tile.type === 'climate') {
    const cur = state && state.attributes ? Number(state.attributes.temperature) : NaN;
    if (!Number.isFinite(cur)) return null;
    const temperature = Math.round((cur + dir * CLIMATE_STEP) * 10) / 10;
    return { domain: 'climate', service: 'set_temperature', service_data: { entity_id: tile.entity, temperature } };
  }
  return null; // sensor is read-only
}

export function projectTile(tile, state) {
  const available = tile.entity ? isAvailable(state) : true;
  const attrs = (state && state.attributes) || {};
  const base = {
    type: tile.type,
    label: tile.label || tile.entity || tile.target || '',
    icon: tile.icon || '',
    available,
    unit: tile.unit || attrs.unit_of_measurement || '',
    value: available && state ? String(state.state) : '—',
    on: isOn(state),
    current: null,
    setpoint: null,
  };
  if (tile.type === 'climate') {
    base.current = Number.isFinite(Number(attrs.current_temperature)) ? Number(attrs.current_temperature) : null;
    base.setpoint = Number.isFinite(Number(attrs.temperature)) ? Number(attrs.temperature) : null;
  }
  return base;
}
