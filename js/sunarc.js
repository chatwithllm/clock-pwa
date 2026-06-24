// sunarc.js — small SVG that shows the sun's position along its daily arc,
// from sunrise (left horizon) through solar noon (apex) to sunset (right horizon).
//
// Data is the sunrise/sunset that weather.js already fetches from Open-Meteo
// (no extra network). Pure local math afterward — works offline from cache and
// never blocks the clock. Updated once a minute; the sun eases between positions
// via a CSS transform transition so it reads as a gentle animation.

const SVGNS = 'http://www.w3.org/2000/svg';
function el(name, attrs){
  const n = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// Geometry of the arc in viewBox units.
const VBW = 200, VBH = 116;
const CX = 100, BASE = 100, R = 84;         // semicircle baseline + radius
const X0 = CX - R, X1 = CX + R;             // horizon endpoints

// Point on the day arc for progress p in [0,1].
function arcPoint(p){
  const a = p * Math.PI;                     // 0 = sunrise (left), π = sunset (right)
  return { x: CX - R * Math.cos(a), y: BASE - R * Math.sin(a) };
}

// Parse a naive ISO local datetime ("2026-06-22T05:25") into ms.
// Falls back to Date parsing; returns NaN if unusable.
function parseLocal(iso){
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

export class SunArc {
  constructor(container){
    this.container = container;
    this.svg = null;
    this.sunG = null;
    this.elapsed = null;
    this.riseLabel = null;
    this.setLabel = null;
    this.statusLabel = null;
    this._reduceMotion = false;
    try { this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(_){}
    this._build();
  }

  _build(){
    if (!this.container) return;
    const svg = el('svg', {
      class: 'sunarc-svg', viewBox: `0 0 ${VBW} ${VBH}`,
      preserveAspectRatio: 'xMidYMid meet', width: '100%', height: '100%',
      role: 'img', 'aria-label': 'Sun position',
    });

    // Soft glow filter for the sun.
    const defs = el('defs');
    const f = el('filter', { id:'sunGlow', x:'-60%', y:'-60%', width:'220%', height:'220%' });
    f.appendChild(el('feGaussianBlur', { in:'SourceGraphic', stdDeviation:'2.4' }));
    defs.appendChild(f);
    svg.appendChild(defs);

    const arcD = `M ${X0} ${BASE} A ${R} ${R} 0 0 1 ${X1} ${BASE}`;

    // Horizon line.
    svg.appendChild(el('line', { x1:X0-6, y1:BASE, x2:X1+6, y2:BASE,
      stroke:'var(--fg-dim)', 'stroke-width':1, 'stroke-opacity':'0.45' }));

    // Full day track (faint, dashed).
    svg.appendChild(el('path', { d:arcD, fill:'none',
      stroke:'var(--fg-dim)', 'stroke-width':1.4, 'stroke-opacity':'0.4',
      'stroke-dasharray':'2 4', 'stroke-linecap':'round' }));

    // Elapsed portion (warm), revealed via dashoffset on a pathLength=1000 path.
    this.elapsed = el('path', { d:arcD, fill:'none',
      stroke:'var(--sun, #ffce82)', 'stroke-width':2.2, 'stroke-linecap':'round',
      pathLength:'1000', 'stroke-dasharray':'1000', 'stroke-dashoffset':'1000' });
    svg.appendChild(this.elapsed);

    // Endpoint ticks.
    svg.appendChild(el('circle', { cx:X0, cy:BASE, r:2, fill:'var(--fg-dim)' }));
    svg.appendChild(el('circle', { cx:X1, cy:BASE, r:2, fill:'var(--fg-dim)' }));

    // The sun: a <g> we move with a transform (CSS-transitionable).
    this.sunG = el('g', { class:'sunarc-sun' });
    this.sunG.appendChild(el('circle', { r:7.5, fill:'var(--sun, #ffce82)', filter:'url(#sunGlow)', opacity:'0.55' }));
    this.sunG.appendChild(el('circle', { class:'sunarc-core', r:4.6, fill:'var(--sun, #ffce82)' }));
    svg.appendChild(this.sunG);

    // Labels.
    this.riseLabel = el('text', { x:X0, y:BASE+12, 'text-anchor':'start',
      'font-size':'9', fill:'var(--fg-dim)', 'font-family':'system-ui,sans-serif' });
    this.setLabel = el('text', { x:X1, y:BASE+12, 'text-anchor':'end',
      'font-size':'9', fill:'var(--fg-dim)', 'font-family':'system-ui,sans-serif' });
    // Status sits at the apex (above the arc) so it never collides with the time labels.
    this.statusLabel = el('text', { x:CX, y:10, 'text-anchor':'middle',
      'font-size':'8', fill:'var(--fg-dim)', 'font-family':'system-ui,sans-serif', 'letter-spacing':'1' });
    svg.appendChild(this.riseLabel);
    svg.appendChild(this.setLabel);
    svg.appendChild(this.statusLabel);

    // Compact one-liner shown at night in portrait (the dome is useless after dark).
    this.compact = el('text', { class:'sunarc-compact', x:CX, y:19, 'text-anchor':'middle',
      'font-size':'12', fill:'var(--fg-dim)', 'font-family':'system-ui,sans-serif', 'letter-spacing':'1' });
    svg.appendChild(this.compact);

    this.container.textContent = '';
    this.container.appendChild(svg);
    this.svg = svg;
    if (this._reduceMotion) this.sunG.style.transition = 'none';
  }

  _fmt(ms){
    try {
      return new Date(ms).toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
    } catch(_){ return ''; }
  }

  hide(){ if (this.container) this.container.hidden = true; }
  show(){ if (this.container) this.container.hidden = false; }

  /**
   * @param {{sunrise:string, sunset:string, now?:number, portrait?:boolean}} data
   * Pass naive-local ISO strings (as Open-Meteo returns with timezone=auto).
   * `now` defaults to Date.now(). At night (sun below horizon) the dome collapses
   * to a compact one-liner in both orientations to free the wasted space.
   */
  update(data){
    if (!this.svg || !data) { this.hide(); return; }
    const rise = parseLocal(data.sunrise);
    const set  = parseLocal(data.sunset);
    if (Number.isNaN(rise) || Number.isNaN(set) || set <= rise){ this.hide(); return; }
    this.show();

    const now = (typeof data.now === 'number') ? data.now : Date.now();
    const raw = (now - rise) / (set - rise);
    const p = Math.max(0, Math.min(1, raw));
    const isNight = raw < 0 || raw > 1;

    // At night the dome conveys nothing, so collapse it to a single "next sunrise"
    // line in BOTH orientations (frees the wasted space). Day keeps the full arc.
    const compact = isNight;
    this.svg.classList.toggle('is-compact', compact);
    if (compact){
      this.svg.setAttribute('viewBox', '0 0 200 30');
      this.compact.textContent = '☾  Sunrise ' + this._fmt(rise);
      return;
    }
    this.svg.setAttribute('viewBox', `0 0 ${VBW} ${VBH}`);

    // Sun position (rest at the near horizon when below it).
    const pt = arcPoint(p);
    this.sunG.setAttribute('transform', `translate(${pt.x} ${pt.y})`);

    // Reveal elapsed arc up to p.
    this.elapsed.setAttribute('stroke-dashoffset', String(Math.round(1000 * (1 - p))));

    // Night styling: dim the sun, cool the labels.
    this.svg.classList.toggle('is-night', isNight);

    this.riseLabel.textContent = '↑ ' + this._fmt(rise);
    this.setLabel.textContent  = this._fmt(set) + ' ↓';

    if (isNight){
      this.statusLabel.textContent = raw < 0 ? 'BEFORE SUNRISE' : 'AFTER SUNSET';
    } else {
      const left = set - now;
      const mins = Math.round(left / 60000);
      if (mins <= 0) this.statusLabel.textContent = '';
      else if (mins < 90) this.statusLabel.textContent = mins + ' MIN OF LIGHT';
      else this.statusLabel.textContent = (mins/60).toFixed(1) + ' H OF LIGHT';
    }
  }
}
