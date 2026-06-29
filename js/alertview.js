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
