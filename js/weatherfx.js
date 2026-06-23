// weatherfx.js — full-screen animated weather backdrop + condition palette.
// Feature-detected, never throws. Low-brightness + constant motion so it is safe
// on always-on burn-in screens. Pauses in deep-dim / when hidden; disabled on
// prefers-reduced-motion and throttled on TV-class / weak devices.
//
// The clock NEVER depends on this — it is purely decorative and gated by a setting.

// Condition groups + text palette (light-on-near-black, kept readable).
const GROUPS = {
  clear:   { fg:'#ffe9c9', dim:'#c9a878', accent:'#ffd27a', hand:'#ffe9c9', hsec:'#ff7a5f' },
  clouds:  { fg:'#d6dbe4', dim:'#8b929c', accent:'#9fb4d6', hand:'#d6dbe4', hsec:'#ff6a6f' },
  fog:     { fg:'#cdd0d6', dim:'#888c94', accent:'#aab0ba', hand:'#cdd0d6', hsec:'#d98a8e' },
  rain:    { fg:'#cfe0ff', dim:'#7f93b6', accent:'#6fa8ff', hand:'#cfe0ff', hsec:'#ff7a8a' },
  snow:    { fg:'#e6efff', dim:'#9fb0c8', accent:'#bcd6ff', hand:'#e6efff', hsec:'#ff8aa0' },
  thunder: { fg:'#dcd6f0', dim:'#8d86a8', accent:'#a99cff', hand:'#dcd6f0', hsec:'#ff7a9c' },
};

// WMO weather code → effect group.
export function fxForCode(code){
  const c = Number(code);
  if (c === 0 || c === 1) return 'clear';
  if (c === 2 || c === 3) return 'clouds';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'thunder';
  return 'clouds';
}

export function paletteForCode(code){ return GROUPS[fxForCode(code)] || GROUPS.clouds; }

export class WeatherFX {
  constructor(canvas, { isTV = false, reduceMotion = false } = {}){
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.isTV = !!isTV;
    this.reduceMotion = !!reduceMotion;
    this.active = false;       // setting enabled
    this.paused = false;       // deep-dim / hidden
    this.group = 'clouds';
    this.raf = null;
    this.t = 0;
    this.last = 0;
    this.dpr = Math.min(2, (window.devicePixelRatio || 1));
    this.W = 0; this.H = 0;
    this.particles = [];
    this.clouds = [];
    this.flash = 0; this.nextFlash = 0;
    this._density = this.isTV ? 0.45 : 1;
    this._onResize = () => this._resize();
    this._onVis = () => { if (document.hidden) this._stopLoop(); else this._maybeStart(); };
  }

  get supported(){ return !!this.ctx && typeof requestAnimationFrame === 'function'; }

  setActive(on){
    this.active = !!on;
    if (this.active){
      window.addEventListener('resize', this._onResize);
      document.addEventListener('visibilitychange', this._onVis);
      this._resize();
      this._seed();
      this._maybeStart();
      if (this.canvas) this.canvas.style.opacity = '1';
    } else {
      window.removeEventListener('resize', this._onResize);
      document.removeEventListener('visibilitychange', this._onVis);
      this._stopLoop();
      this._clear();
      if (this.canvas) this.canvas.style.opacity = '0';
    }
  }

  // Pause animation but keep it active (deep-dim).
  setPaused(on){
    this.paused = !!on;
    if (this.paused){ this._stopLoop(); this._clear(); }
    else this._maybeStart();
  }

  setCondition(code){
    const g = fxForCode(code);
    if (g === this.group && this.particles.length) return;
    this.group = g;
    this._seed();
  }

  _maybeStart(){
    if (!this.supported || !this.active || this.paused) return;
    if (this.reduceMotion){ this._clear(); return; } // static: tint only, no motion
    if (document.hidden) return;
    if (!this.raf){ this.last = 0; this.raf = requestAnimationFrame((ts)=>this._frame(ts)); }
  }

  _stopLoop(){ if (this.raf){ cancelAnimationFrame(this.raf); this.raf = null; } }

  _resize(){
    if (!this.canvas) return;
    const w = window.innerWidth, h = window.innerHeight;
    this.W = w; this.H = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._seed();
  }

  _rand(a, b){ return a + Math.random() * (b - a); }

  _seed(){
    const area = Math.max(1, this.W * this.H);
    this.particles = [];
    this.clouds = [];
    const g = this.group;

    if (g === 'rain' || g === 'thunder'){
      const n = Math.round(Math.min(260, area / 7000) * this._density);
      for (let i=0;i<n;i++) this.particles.push({
        x:this._rand(0,this.W), y:this._rand(0,this.H),
        len:this._rand(12,26), spd:this._rand(620,980), slant:this._rand(1.6,2.6),
      });
      this.nextFlash = this.t + this._rand(4,10);
    } else if (g === 'snow'){
      const n = Math.round(Math.min(180, area / 11000) * this._density);
      for (let i=0;i<n;i++) this.particles.push({
        x:this._rand(0,this.W), y:this._rand(0,this.H),
        r:this._rand(1.2,3.2), spd:this._rand(28,70), sway:this._rand(0.4,1.2), ph:this._rand(0,6.28),
      });
    } else if (g === 'clouds' || g === 'fog'){
      const n = g === 'fog' ? 5 : Math.round(this._rand(5,7));
      for (let i=0;i<n;i++) this.clouds.push({
        x:this._rand(-0.2,1.2)*this.W, y:this._rand(0.05,0.9)*this.H,
        r:this._rand(0.18,0.4)*Math.max(this.W,this.H),
        spd:this._rand(6,16)*(g==='fog'?0.6:1)*(Math.random()<0.5?1:-1),
        a:g==='fog'?this._rand(0.05,0.09):this._rand(0.05,0.11),
      });
    } else if (g === 'clear'){
      // a few slow drifting motes; the warm glow is drawn procedurally
      const n = Math.round(24 * this._density);
      for (let i=0;i<n;i++) this.particles.push({
        x:this._rand(0,this.W), y:this._rand(0,this.H),
        r:this._rand(0.6,1.6), spd:this._rand(6,16), ph:this._rand(0,6.28),
      });
    }
  }

  _clear(){ if (this.ctx) this.ctx.clearRect(0,0,this.W,this.H); }

  _frame(ts){
    if (!this.raf) return;
    if (!this.last) this.last = ts;
    let dt = (ts - this.last) / 1000; this.last = ts;
    if (dt > 0.1) dt = 0.1;             // clamp after tab-switch
    this.t += dt;
    this._draw(dt);
    this.raf = requestAnimationFrame((t)=>this._frame(t));
  }

  _draw(dt){
    const ctx = this.ctx; if (!ctx) return;
    ctx.clearRect(0,0,this.W,this.H);
    const pal = GROUPS[this.group] || GROUPS.clouds;
    const g = this.group;

    if (g === 'rain' || g === 'thunder'){
      ctx.strokeStyle = 'rgba(150,190,255,0.34)';
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const p of this.particles){
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.slant*4, p.y + p.len);
        p.y += p.spd * dt; p.x += p.slant * p.spd * dt * 0.18;
        if (p.y > this.H + 20){ p.y = -20; p.x = this._rand(0, this.W); }
        if (p.x > this.W + 20) p.x = -20;
      }
      ctx.stroke();
      if (g === 'thunder') this._thunder(dt);

    } else if (g === 'snow'){
      ctx.fillStyle = 'rgba(235,242,255,0.78)';
      for (const p of this.particles){
        p.y += p.spd * dt;
        p.x += Math.sin(this.t * p.sway + p.ph) * 8 * dt;
        if (p.y > this.H + 6){ p.y = -6; p.x = this._rand(0, this.W); }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }

    } else if (g === 'clouds' || g === 'fog'){
      for (const c of this.clouds){
        const grd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        const col = g === 'fog' ? '180,186,196' : '150,160,178';
        grd.addColorStop(0, `rgba(${col},${c.a})`);
        grd.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = grd;
        ctx.fillRect(c.x - c.r, c.y - c.r, c.r*2, c.r*2);
        c.x += c.spd * dt;
        if (c.x - c.r > this.W) c.x = -c.r;
        if (c.x + c.r < 0) c.x = this.W + c.r;
      }

    } else if (g === 'clear'){
      // warm sun glow, gently bobbing — low alpha, always moving
      const gx = this.W * 0.78, gy = this.H * (0.20 + 0.02*Math.sin(this.t*0.3));
      const rad = Math.max(this.W, this.H) * 0.55;
      const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad);
      const a = 0.16 + 0.03*Math.sin(this.t*0.5);
      grd.addColorStop(0, `rgba(255,200,120,${a})`);
      grd.addColorStop(0.5, `rgba(255,170,90,${a*0.4})`);
      grd.addColorStop(1, 'rgba(255,170,90,0)');
      ctx.fillStyle = grd; ctx.fillRect(0,0,this.W,this.H);
      ctx.fillStyle = 'rgba(255,231,196,0.5)';
      for (const p of this.particles){
        p.y -= p.spd * dt; p.x += Math.sin(this.t*0.4 + p.ph) * 4 * dt;
        if (p.y < -4){ p.y = this.H + 4; p.x = this._rand(0,this.W); }
        ctx.globalAlpha = 0.35 + 0.25*Math.sin(this.t + p.ph);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  _thunder(dt){
    const ctx = this.ctx;
    if (this.reduceMotion){ return; }
    if (this.flash > 0){
      this.flash -= dt * 3.2;
      const a = Math.max(0, this.flash) * 0.18;
      ctx.fillStyle = `rgba(200,205,235,${a})`;
      ctx.fillRect(0,0,this.W,this.H);
    } else if (this.t >= this.nextFlash){
      this.flash = 1;
      this.nextFlash = this.t + this._rand(5, 12);
    }
  }

  destroy(){ this.setActive(false); }
}
