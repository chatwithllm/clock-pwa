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
  pickup: '🎒',
};
export function alertIcon(type){
  return ALERT_ICONS[type] || '⚠️';
}

// Fixed-position alert rail: 6 slots per half. Portrait places the halves on
// the top/bottom edges and only renders active alerts; landscape joins them
// into a 12-position bottom dock with quiet placeholders. Positions never
// move, so a room learns where each type lives by muscle memory. 'other'
// catches any type not in ALERT_ICONS. The former spare slot is now a family
// reminder slot (`pickup`) for a school-pickup alert from HA.
export const RAIL_TOP = ['water_leak', 'window', 'security', 'temperature', 'motion', 'power'];
export const RAIL_BOTTOM = ['door', 'smoke', 'co', 'freeze', 'pickup', 'other'];
const RAIL_KNOWN = new Set([...RAIL_TOP, ...RAIL_BOTTOM].filter(t => t !== 'other'));

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
