// js/dashboard-view.js — render the HA dashboard overlay: a thin readout status
// bar over a grid of large, tappable controls (controls-first layout).
import { projectTile } from './ha-dashboard.js';

const INTERACTIVE = new Set(['toggle', 'scene', 'button', 'climate']);

export function tileClassList(p) {
  const cls = ['dash-tile', 'dash-' + p.type];
  if (!p.available) cls.push('is-unavailable');
  if (p.type === 'toggle' && p.on) cls.push('is-on');
  return cls;
}

// Round a raw state string for display, or null if it isn't a number.
// >=100 shows as an integer; smaller values keep one decimal.
function fmtNumber(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return String(Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
}

// Degree units hug the number ("72.5°F"); word units get a space ("75 lx").
function withUnit(value, unit) {
  if (!unit) return value;
  return /^°/.test(unit) ? value + unit : value + ' ' + unit;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function span(cls, text) { const n = el('span', cls); if (text != null) n.textContent = text; return n; }

// One compact chip in the top status bar (a read-only reading).
function statChip(p) {
  const chip = el('div', 'stat' + (p.available ? '' : ' is-unavailable'));
  let value;
  if (p.type === 'status') {
    value = p.available ? `${p.statusIcon || ''} ${p.statusText}`.trim() : '—';
  } else if (!p.available) {
    value = '—';
  } else {
    const num = fmtNumber(p.value);
    if (num != null) {
      value = withUnit(num, p.unit);
    } else {
      const word = String(p.value);
      const on = word === 'on';
      if (on) chip.classList.add('is-on');
      value = on ? 'On' : word === 'off' ? 'Off' : cap(word);
    }
  }
  chip.appendChild(span('s-val', value));
  chip.appendChild(span('s-lab', p.label));
  return chip;
}

// One large tappable control (toggle / scene / button / climate).
function controlCell(tile, p, onTileTap) {
  const node = el('button', tileClassList(p).join(' ') + ' dash-cell control');
  node.type = 'button';
  node.setAttribute('data-nav', '');
  if (p.icon) node.appendChild(span('c-icon', p.icon));
  node.appendChild(span('c-label', p.label));
  if (p.type === 'climate') {
    const cur = p.current == null ? '—' : p.current + '°';
    const set = p.setpoint == null ? '—' : p.setpoint + '°';
    node.appendChild(span('c-state', `${cur} → ${set}`));
    node.addEventListener('click', (ev) => {
      const rect = node.getBoundingClientRect();
      onTileTap(tile, ev.clientX < rect.left + rect.width / 2 ? -1 : +1);
    });
  } else {
    if (p.type === 'toggle') node.appendChild(span('c-state', p.available ? (p.on ? 'On' : 'Off') : '—'));
    node.addEventListener('click', () => onTileTap(tile, 0));
  }
  return node;
}

export function renderDashboard(container, dashboard, entities, onTileTap) {
  container.textContent = '';
  if (!dashboard) return;

  const head = el('div', 'dash-head');
  head.appendChild(span('dash-title', dashboard.title || ''));
  container.appendChild(head);

  const stats = [];
  const controls = [];
  for (const tile of dashboard.tiles) {
    const state = tile.entity ? entities[tile.entity] : undefined;
    const p = projectTile(tile, state);
    if (INTERACTIVE.has(tile.type)) controls.push(controlCell(tile, p, onTileTap));
    else stats.push(statChip(p));
  }
  if (stats.length) {
    const bar = el('div', 'dash-statusbar');
    stats.forEach((s) => bar.appendChild(s));
    container.appendChild(bar);
  }
  if (controls.length) {
    const grid = el('div', 'dash-controls');
    controls.forEach((c) => grid.appendChild(c));
    container.appendChild(grid);
  }
}
