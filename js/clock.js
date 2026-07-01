// clock.js — SVG digital + analog rendering. Fit-to-CONTAINER (viewBox), never viewport.
// Shows DEVICE local time (not the weather location's time) — noted in README.
//
// Ticking uses setTimeout re-aligned to the next wall-clock second boundary (NOT
// setInterval, which drifts/skips). Second hand: smooth rAF sweep on phones, 1Hz
// tick on TV-class/large screens or when reduced-motion is set.

const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs){
  const n = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// Shared clock time source. Default 0 offset = device time. When "Time: Server" is
// selected, app.js measures the host clock and sets this offset so every display
// shows the same time regardless of its own (possibly unsynced) system clock.
let _offsetMs = 0;
export function setClockOffset(ms){ _offsetMs = (typeof ms === 'number' && isFinite(ms)) ? ms : 0; }
export function getClockOffset(){ return _offsetMs; }
export function nowDate(){ return new Date(Date.now() + _offsetMs); }

// 3-wide x 5-tall bitmap font for the Block Matrix (dot-matrix LED) style.
// '1' = lit cell, rows top->bottom. ' ' (space) is all-off (12h leading space).
const BLOCK_FONT = {
  '0':'111101101101111', '1':'010110010010111', '2':'111001111100111',
  '3':'111001111001111', '4':'101101111001001', '5':'111100111001111',
  '6':'111100111101111', '7':'111001001010010', '8':'111101111101111',
  '9':'111101111001111', ' ':'000000000000000',
};
// Block geometry (SVG user units).
const BLK = 10, PITCH = 12, GLYPH_W = 34, GLYPH_H = 58, GAP = 10, COLON_W = 10, RX = 2.5;

export class Clock {
  /**
   * @param {HTMLElement} stage
   * @param {object} opts { mode, hour24, seconds, date, sweep }
   */
  constructor(stage, opts){
    this.stage = stage;
    this.opts = Object.assign({ mode:'digital', style:'classic', hour24:false, seconds:true, date:true, sweep:false }, opts);
    this._timer = null;
    this._raf = null;
    this._running = false;
    this._deepDim = false;
    this._buildDigital = null;
    this._analog = null;
    this._block = null;
    this._activePaint = null;
    this._hero = 0;        // 0 = normal, 1 = night hero (bigger)
    this._ro = null;
    this._reduceMotion = false;
    try { this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(_){}

    // Clock-STYLE registry (distinct from digital/analog MODE). Existing renderer is
    // registered untouched as "classic"; "block" is the new dot-matrix LED style.
    // Registry only applies in digital mode; analog is a separate mode.
    this.styles = {
      classic: { label:'Classic',      render:()=>this._renderDigital(), paint:(now)=>this._paintDigital(now) },
      block:   { label:'Block Matrix', render:()=>this._renderBlock(),   paint:(now)=>this._paintBlock(now) },
    };
    this.render();
  }

  // Public: list registered style ids + labels (for the settings selector).
  styleList(){ return Object.keys(this.styles).map(id => ({ id, label: this.styles[id].label })); }

  // Hero size level (0 normal, 1 night-bigger). Re-lays out the flip clock.
  setHero(level){ const l = level|0; if (l === this._hero) return; this._hero = l; try { this._layoutFlip(); } catch(_){} }

  setOptions(patch){
    Object.assign(this.opts, patch);
    this.render();
  }

  setDeepDim(on){
    this._deepDim = !!on;
    // rAF sweep pauses in deep-dim; restart loop to apply.
    this._restartLoop();
  }

  // ---- Build DOM for the chosen mode + style ----
  render(){
    this.stage.textContent = '';
    this._buildDigital = null; this._analog = null; this._block = null;
    if (this.opts.mode === 'analog'){
      this._renderAnalog();
      this._activePaint = (now, smooth) => this._paintAnalog(now, smooth);
    } else {
      // Digital mode: pick the registered style (default classic). Never throw/blank.
      const id = this.styles[this.opts.style] ? this.opts.style : 'classic';
      try {
        this.styles[id].render();
        this._activePaint = this.styles[id].paint;
      } catch(e){
        try { this._renderDigital(); this._activePaint = (now)=>this._paintDigital(now); }
        catch(_){ this._renderTextFallback(); this._activePaint = (now)=>this._paintTextFallback(now); }
      }
    }
    this._restartLoop();
  }

  // Last-resort plain-text clock so the stage is never blank if a renderer fails.
  _renderTextFallback(){
    this._textEl = document.createElement('div');
    this._textEl.className = 'digital';
    this.stage.appendChild(this._textEl);
  }
  _paintTextFallback(now){ try { if (this._textEl) this._textEl.textContent = now.toLocaleTimeString(); } catch(_){} }

  // Flip-clock (split-flap) digital: group tiles HH MM [SS], each 2 digits with a
  // center fold seam; the upper flap folds down on change. Sized to fit the cell.
  _renderDigital(){
    const wrap = document.createElement('div');
    wrap.className = 'flip';

    let dateEl = null;
    if (this.opts.date){
      dateEl = document.createElement('div');
      dateEl.className = 'flip-date';
      wrap.appendChild(dateEl);
    }

    const row = document.createElement('div');
    row.className = 'flip-row';
    wrap.appendChild(row);

    this.stage.appendChild(wrap);
    this._buildDigital = { wrap, row, dateEl, groups:[], ampmEl:null, nGroups:0, hasAmpm:false };
    this._analog = null;

    this._buildFlipGroups();
    this._paintDigital(nowDate(), true);   // initial: no flip animation
    this._layoutFlip();
    this._observeStage();
  }

  _makeCell(v){ const d = document.createElement('div'); d.className = 'fg-cell'; d.textContent = v; return d; }

  _makeGroup(){
    const g = document.createElement('div'); g.className = 'flip-group';
    const reel = document.createElement('div'); reel.className = 'fg-reel';
    g.appendChild(reel);
    return { el:g, reel, value:null, _running:false, _timer:null, _onEnd:null };
  }

  _buildFlipGroups(){
    const b = this._buildDigital;
    b.row.textContent = ''; b.groups = []; b.ampmEl = null;
    const n = this.opts.seconds ? 3 : 2;
    for (let i=0;i<n;i++){ const g = this._makeGroup(); b.groups.push(g); b.row.appendChild(g.el); }
    b.hasAmpm = !this.opts.hour24;
    if (b.hasAmpm){ const a = document.createElement('div'); a.className = 'flip-ampm'; b.ampmEl = a; b.row.appendChild(a); }
    b.nGroups = n;
  }

  // Collapse the reel to a single cell of the current value. Idempotent — safe to
  // call from transitionend AND the fallback timer.
  _finishRoll(g){
    if (!g._running) return;
    g._running = false;
    if (g._timer){ clearTimeout(g._timer); g._timer = null; }
    if (g._onEnd){ g.reel.removeEventListener('transitionend', g._onEnd); g._onEnd = null; }
    g.reel.classList.remove('anim');
    g.reel.style.transform = 'translateY(0)';
    g.reel.textContent = '';
    g.reel.appendChild(this._makeCell(g.value));
  }

  // Set a group's 2-char value; roll old→new vertically unless suppressed.
  _setGroup(g, val, animate){
    if (g.value === val) return;
    const old = g.value;
    if (g._running) this._finishRoll(g);       // settle any in-flight roll first
    g.value = val;
    if (old == null || !animate){
      g.reel.classList.remove('anim');
      g.reel.style.transform = 'translateY(0)';
      g.reel.textContent = '';
      g.reel.appendChild(this._makeCell(val));
      return;
    }
    // Stack new (top) + old (bottom); reel is 2 cells tall, start showing old.
    g.reel.classList.remove('anim');
    g.reel.textContent = '';
    g.reel.appendChild(this._makeCell(val));
    g.reel.appendChild(this._makeCell(old));
    g.reel.style.transform = 'translateY(-50%)'; // show the old (bottom) cell first
    void g.reel.offsetWidth;                    // reflow to lock the start state
    g._running = true;
    g._onEnd = () => this._finishRoll(g);
    g.reel.addEventListener('transitionend', g._onEnd);
    g.reel.classList.add('anim');
    g.reel.style.transform = 'translateY(0)';   // roll down → reveals new from the top
    g._timer = setTimeout(() => this._finishRoll(g), 700); // fallback if transitionend misfires
  }

  // Measure the stage cell and size the tiles to fit (width- or height-bound).
  _layoutFlip(){
    const b = this._buildDigital;
    if (!b || !b.wrap || !b.nGroups) return;
    let availW = this.stage.clientWidth, availH = this.stage.clientHeight;
    try {
      const cs = getComputedStyle(this.stage);
      availW -= parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      availH -= parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    } catch(_){}
    if (availW <= 0 || availH <= 0) return;
    const n = b.nGroups, wK = 1.16, gapK = 0.12, ampmK = b.hasAmpm ? 0.5 : 0;
    const landscape = availW > availH;
    // Landscape is usually height-bound — let the hero clock claim more height.
    // Night (_hero=1) frees the sun tile, so it goes a touch bigger still.
    let vFrac = landscape ? (b.dateEl ? 0.82 : 0.92) : (b.dateEl ? 0.66 : 0.8);
    if (this._hero >= 1) vFrac += 0.06;
    vFrac = Math.min(vFrac, landscape ? 0.95 : 0.9);
    const Hh = availH * vFrac;
    const factor = n*wK + (n-1)*gapK + (ampmK ? (ampmK + gapK) : 0);
    const Hw = availW / factor;
    const H = Math.max(24, Math.min(Hh, Hw));
    b.wrap.style.setProperty('--flip-h', H + 'px');
    b.wrap.style.setProperty('--flip-w', (H*wK) + 'px');
    b.wrap.style.setProperty('--flip-gap', (H*gapK) + 'px');
  }

  _observeStage(){
    if (this._ro) return;
    try { this._ro = new ResizeObserver(() => this._layoutFlip()); this._ro.observe(this.stage); }
    catch(_){ try { window.addEventListener('resize', () => this._layoutFlip()); } catch(__){} }
  }

  _renderAnalog(){
    const size = 1000, c = size/2, r = c - 40;
    const svg = el('svg', {
      class:'analog-svg', viewBox:`0 0 ${size} ${size}`,
      preserveAspectRatio:'xMidYMid meet', width:'100%', height:'100%',
    });

    svg.appendChild(el('circle', { cx:c, cy:c, r:r+20, fill:'var(--face)', stroke:'var(--tick)', 'stroke-width':4 }));

    // Hour/minute ticks.
    for (let i=0;i<60;i++){
      const ang = (i/60) * Math.PI*2;
      const major = i % 5 === 0;
      const outer = r;
      const inner = r - (major ? 48 : 24);
      const x1 = c + Math.sin(ang)*inner, y1 = c - Math.cos(ang)*inner;
      const x2 = c + Math.sin(ang)*outer, y2 = c - Math.cos(ang)*outer;
      svg.appendChild(el('line', {
        x1,y1,x2,y2, stroke:'var(--tick)', 'stroke-width': major?8:3, 'stroke-linecap':'round',
      }));
    }

    // Hands rotate via CSS transform around center.
    const hour = el('line', { x1:c, y1:c, x2:c, y2:c - r*0.5, stroke:'var(--hand)', 'stroke-width':22, 'stroke-linecap':'round' });
    const min  = el('line', { x1:c, y1:c, x2:c, y2:c - r*0.78, stroke:'var(--hand)', 'stroke-width':14, 'stroke-linecap':'round' });
    const sec  = el('line', { x1:c, y1:c, x2:c, y2:c - r*0.88, stroke:'var(--hand-sec)', 'stroke-width':6, 'stroke-linecap':'round' });
    for (const h of [hour,min,sec]){ h.style.transformOrigin = `${c}px ${c}px`; }
    if (!this.opts.seconds) sec.style.display = 'none';

    svg.appendChild(hour); svg.appendChild(min); svg.appendChild(sec);
    svg.appendChild(el('circle', { cx:c, cy:c, r:18, fill:'var(--hand)' }));
    svg.appendChild(el('circle', { cx:c, cy:c, r:8, fill:'var(--hand-sec)' }));

    this.stage.appendChild(svg);
    this._analog = { hour, min, sec, c };
    this._buildDigital = null;
    this._paintAnalog(nowDate(), false);
  }

  // ---- Painting ----
  _two(n){ return n < 10 ? '0'+n : ''+n; }

  _paintDigital(now, noAnim){
    const b = this._buildDigital; if (!b || !b.groups) return;
    let h = now.getHours();
    let suffix = '';
    if (!this.opts.hour24){
      suffix = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (h === 0) h = 12;
    }
    const vals = [ this._two(h), this._two(now.getMinutes()) ];
    if (this.opts.seconds) vals.push(this._two(now.getSeconds()));

    const animate = !noAnim && !this._reduceMotion && !this._deepDim;
    for (let i=0;i<b.groups.length;i++) this._setGroup(b.groups[i], vals[i] || '00', animate);
    if (b.ampmEl) b.ampmEl.textContent = suffix;

    if (b.dateEl){
      try {
        b.dateEl.textContent = now.toLocaleDateString(undefined,
          { weekday:'short', month:'short', day:'numeric' }).toUpperCase();
      } catch(_) {
        b.dateEl.textContent = now.toDateString().toUpperCase();
      }
    }
  }

  _paintAnalog(now, smooth){
    const a = this._analog; if (!a) return;
    const ms = now.getMilliseconds();
    const s = now.getSeconds() + (smooth ? ms/1000 : 0);
    const m = now.getMinutes() + s/60;
    const h = (now.getHours()%12) + m/60;
    a.hour.style.transform = `rotate(${h*30}deg)`;
    a.min.style.transform  = `rotate(${m*6}deg)`;
    if (this.opts.seconds) a.sec.style.transform = `rotate(${s*6}deg)`;
  }

  // ---- Block Matrix (dot-matrix LED) style ----
  // Builds the rect grid ONCE per layout (changes only when seconds toggles); each
  // tick only updates fills/transform classes — never rebuilds the DOM per second.
  _renderBlock(){
    const wrap = document.createElement('div');
    wrap.className = 'block';

    let dateEl = null;
    if (this.opts.date){
      dateEl = document.createElement('div');
      dateEl.className = 'block-date';
      wrap.appendChild(dateEl);
    }

    // Layout: D D : D D [ : D D ]  (drop last colon+SS when seconds off)
    const seconds = this.opts.seconds;
    const seq = seconds
      ? ['d','d','c','d','d','c','d','d']
      : ['d','d','c','d','d'];

    let width = 0;
    for (let i=0;i<seq.length;i++){ width += (seq[i]==='c'?COLON_W:GLYPH_W); if (i) width += GAP; }

    const svg = el('svg', {
      class:'block-svg', viewBox:`0 0 ${width} ${GLYPH_H}`,
      preserveAspectRatio:'xMidYMid meet', width:'100%', height:'100%',
    });

    const digits = [];   // ordered digit slots (rects[15])
    let x = 0;
    for (let i=0;i<seq.length;i++){
      const kind = seq[i];
      if (kind === 'c'){
        // colon: two lit blocks at rows 1 and 3, single column.
        for (const row of [1,3]){
          svg.appendChild(el('rect', { class:'led on', x:x, y:row*PITCH, width:BLK, height:BLK, rx:RX }));
        }
        x += COLON_W + GAP;
      } else {
        const rects = [];
        for (let r=0;r<5;r++) for (let c=0;c<3;c++){
          const rect = el('rect', { class:'led off', x:x + c*PITCH, y:r*PITCH, width:BLK, height:BLK, rx:RX });
          rects.push(rect); svg.appendChild(rect);
        }
        digits.push(rects);
        x += GLYPH_W + GAP;
      }
    }

    wrap.appendChild(svg);
    this.stage.appendChild(wrap);
    this._block = { wrap, svg, dateEl, digits, seconds };
    this._paintBlock(nowDate());
  }

  _paintBlock(now){
    const b = this._block; if (!b) return;
    let h = now.getHours();
    if (!this.opts.hour24){ h = h % 12; if (h === 0) h = 12; }
    // hours: 24h pad with '0'; 12h pad with leading SPACE (3:05, not 03:05).
    const hStr = (h < 10) ? (this.opts.hour24 ? '0'+h : ' '+h) : ''+h;
    const chars = [ hStr[0], hStr[1], this._two(now.getMinutes())[0], this._two(now.getMinutes())[1] ];
    if (b.seconds){ const ss = this._two(now.getSeconds()); chars.push(ss[0], ss[1]); }

    for (let i=0;i<b.digits.length;i++){
      const pat = BLOCK_FONT[chars[i]] || BLOCK_FONT[' '];
      const rects = b.digits[i];
      for (let k=0;k<15;k++){
        const on = pat.charAt(k) === '1';
        const rect = rects[k];
        const cls = on ? 'led on' : 'led off';
        if (rect.getAttribute('class') !== cls) rect.setAttribute('class', cls);
      }
    }

    if (b.dateEl){
      try { b.dateEl.textContent = now.toLocaleDateString(undefined,
        { weekday:'short', month:'short', day:'numeric' }).toUpperCase(); }
      catch(_) { b.dateEl.textContent = now.toDateString().toUpperCase(); }
    }
  }

  // ---- Loop control ----
  _restartLoop(){
    this.stop();
    this._running = true;
    this._tickAligned();
    if (this._wantSweep()) this._sweep();
  }

  _wantSweep(){
    return !!this.opts.sweep && this.opts.mode === 'analog' && this.opts.seconds && !this._deepDim;
  }

  // setTimeout re-aligned to the next wall-clock second boundary.
  _tickAligned(){
    const now = nowDate();
    try { if (this._activePaint) this._activePaint(now, this._wantSweep()); } catch(_){}
    const delay = 1000 - (now.getMilliseconds());
    this._timer = setTimeout(() => {
      if (!this._running) return;
      this._tickAligned();
    }, delay);
  }

  _sweep(){
    const step = () => {
      if (!this._running || !this._wantSweep()){ this._raf = null; return; }
      this._paintAnalog(nowDate(), true);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  stop(){
    this._running = false;
    if (this._timer){ clearTimeout(this._timer); this._timer = null; }
    if (this._raf){ cancelAnimationFrame(this._raf); this._raf = null; }
  }
}

// Measured rAF FPS sample (~500ms) used by app.js for TV detection / sweep decision.
export function sampleFPS(durationMs = 500){
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function'){ resolve(0); return; }
    let frames = 0; let start = null;
    const step = (t) => {
      if (start === null) start = t;
      frames++;
      if (t - start >= durationMs){
        const fps = frames / ((t - start)/1000);
        resolve(fps);
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  });
}
