// js/dashboard-view.js — render the HA dashboard overlay from projected tiles.
import { projectTile } from './ha-dashboard.js';

export function tileClassList(p) {
  const cls = ['dash-tile', 'dash-' + p.type];
  if (!p.available) cls.push('is-unavailable');
  if (p.type === 'toggle' && p.on) cls.push('is-on');
  return cls;
}

function tileText(p) {
  if (p.type === 'climate') {
    const cur = p.current == null ? '—' : p.current + '°';
    const set = p.setpoint == null ? '—' : p.setpoint + '°';
    return `${p.label}\n${cur} → ${set}`;
  }
  if (p.type === 'toggle') return `${p.label}\n${p.available ? (p.on ? 'On' : 'Off') : '—'}`;
  if (p.type === 'sensor') return `${p.label}\n${p.value}${p.unit || ''}`;
  if (p.type === 'status') {
    if (!p.available) return `${p.label}\n—`;
    const raw = p.unit ? `${p.value} ${p.unit}` : p.value;
    return `${p.label}\n${p.statusText}${raw ? ' · ' + raw : ''}`;
  }
  return p.label; // scene / button
}

export function renderDashboard(container, dashboard, entities, onTileTap) {
  container.textContent = '';
  if (!dashboard) return;
  for (const tile of dashboard.tiles) {
    const state = tile.entity ? entities[tile.entity] : undefined;
    const p = projectTile(tile, state);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = tileClassList(p).join(' ');
    el.setAttribute('data-nav', '');
    const displayIcon = p.type === 'status' ? (p.statusIcon || p.icon) : p.icon;
    if (displayIcon) { const i = document.createElement('span'); i.className = 'dash-icon'; i.textContent = displayIcon; el.appendChild(i); }
    const label = document.createElement('span');
    label.className = 'dash-text';
    label.textContent = tileText(p);
    el.appendChild(label);
    if (tile.type === 'climate') {
      el.addEventListener('click', (ev) => {
        const rect = el.getBoundingClientRect();
        onTileTap(tile, ev.clientX < rect.left + rect.width / 2 ? -1 : +1);
      });
    } else if (tile.type !== 'sensor' && tile.type !== 'status') {
      el.addEventListener('click', () => onTileTap(tile, 0));
    }
    container.appendChild(el);
  }
}
