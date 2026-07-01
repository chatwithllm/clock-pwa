// alertview.js — pure: choose + order the alerts a device should show.
// alertView(list, profile) -> array, critical first then newest ts.
export function alertView(list, profile){
  const prof = String(profile == null ? '' : profile).toLowerCase();
  const out = [];
  for (const a of (Array.isArray(list) ? list : [])){
    if (!a || !a.key || !a.message) continue;
    const tgt = String(a.target || 'all').toLowerCase();
    if (tgt !== 'all' && tgt !== prof) continue;
    out.push(a);
  }
  const rank = (s) => (s === 'critical' ? 0 : 1);
  out.sort((x, y) => rank(x.severity) - rank(y.severity) || (Number(y.ts) || 0) - (Number(x.ts) || 0));
  return out;
}

// Map a Home-Assistant alert `type` to a display emoji. Unknown/missing -> warning.
const ALERT_ICONS = {
  water_leak: '💧', door: '🚪', window: '🪟', security: '🔒', smoke: '🔥',
  co: '☣️', motion: '🚶', freeze: '🧊', power: '🔌', temperature: '🌡️',
};
export function alertIcon(type){
  return ALERT_ICONS[type] || '⚠️';
}

// Fixed-position alert rail: 6 slots along the top edge, 6 along the bottom.
// Each slot renders only when its type has an active alert — true blank
// space otherwise. Positions never move, so a room learns "top-left = leak"
// by muscle memory instead of reading a list every time. 'other' catches any
// type not in ALERT_ICONS; 'spare' is reserved for a future 11th type.
export const RAIL_TOP = ['water_leak', 'window', 'security', 'temperature', 'motion', 'power'];
export const RAIL_BOTTOM = ['door', 'smoke', 'co', 'freeze', 'other', 'spare'];
const RAIL_KNOWN = new Set([...RAIL_TOP, ...RAIL_BOTTOM].filter(t => t !== 'other' && t !== 'spare'));

// alertRailView(list, profile) -> { [slotType]: 'critical'|'warning', ... }
// Only slots with an active alert appear as keys. Multiple alerts of the same
// type collapse into one slot at its worst (critical-over-warning) severity.
export function alertRailView(list, profile){
  const out = {};
  for (const a of alertView(list, profile)){
    const t = RAIL_KNOWN.has(a.type) ? a.type : 'other';
    const sev = a.severity === 'critical' ? 'critical' : 'warning';
    if (out[t] !== 'critical') out[t] = sev;
  }
  return out;
}
