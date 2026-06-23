// app.js — bootstrap, state-machine reducer, input routing, pixel-shift, dim.
// Every render/setup entry point is wrapped in try/catch so one failure (e.g.
// weather) NEVER blanks the clock.

import { loadSettings, saveSettings, DEFAULT_LOCATION } from './settings.js';
import { Clock, sampleFPS } from './clock.js';
import { getWeather, geocodeCity, bothTemps, wmoInfo, loadCache } from './weather.js';
import { DpadNav } from './nav.js';
import { WakeKeeper } from './wakelock.js';
import { WeatherFX, paletteForCode } from './weatherfx.js';
import { SunArc } from './sunarc.js';

const $ = (id) => document.getElementById(id);

// ---- State machine (explicit reducer) ----
const REST = 'REST', ACTIVE = 'ACTIVE', PANEL = 'PANEL';

const app = {
  settings: null,
  clock: null,
  nav: null,
  wake: null,
  isTV: false,
  reduceMotion: false,
  state: REST,
  idleTimer: null,
  shiftTimer: null,
  weatherTimer: null,
  nightTimer: null,
  lastWeather: null,
  deepDim: false,
};

// ---------- State transitions ----------
function setState(next){
  const chrome = $('chrome');
  const panel = $('panel');
  app.state = next;

  if (next === REST){
    chrome.classList.remove('is-visible');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden','true');
    clearIdle();
    app.nav.setScope(document);
  } else if (next === ACTIVE){
    chrome.classList.add('is-visible');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden','true');
    app.nav.setScope(document);
    resetIdle();
  } else if (next === PANEL){
    chrome.classList.add('is-visible');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden','false');
    clearIdle(); // idle PAUSED while panel open
    app.nav.setScope(panel);
    app.nav.focusFirst();
  }
}

function clearIdle(){ if (app.idleTimer){ clearTimeout(app.idleTimer); app.idleTimer = null; } }
function resetIdle(){
  clearIdle();
  app.idleTimer = setTimeout(() => { if (app.state === ACTIVE) setState(REST); }, 5000);
}

// Any input wakes REST→ACTIVE; on TV also move focus to first control.
function onInput(){
  if (app.state === REST){
    setState(ACTIVE);
    if (app.isTV) app.nav.focusFirst();
  } else if (app.state === ACTIVE){
    resetIdle();
  }
  // PANEL: idle stays paused; do nothing here.
}

// ---------- Pixel-shift (orthogonal, runs regardless of state) ----------
function startPixelShift(){
  if (app.shiftTimer) clearInterval(app.shiftTimer);
  if (app.reduceMotion) return; // reduced-motion disables shift
  const budget = 8; // px, < safe inset
  let i = 0;
  const positions = [[0,0],[budget,0],[budget,budget],[0,budget],[-budget,0],[-budget,-budget],[0,-budget]];
  app.shiftTimer = setInterval(() => {
    i = (i+1) % positions.length;
    document.documentElement.style.setProperty('--shift-x', positions[i][0]+'px');
    document.documentElement.style.setProperty('--shift-y', positions[i][1]+'px');
  }, 60000);
}

// ---------- Orientation override (orthogonal; auto => follow device @media) ----------
function applyOrientation(){
  const o = app.settings.orientation;
  const el = $('app');
  el.classList.toggle('force-portrait', o === 'portrait');
  el.classList.toggle('force-landscape', o === 'landscape');
  // 'auto' => neither class => CSS @media reacts to the device automatically.
}

// ---------- Dynamic display (weather-tinted text + animated backdrop) ----------
const TINT_VARS = ['--fg','--fg-dim','--accent','--hand','--hand-sec'];
function clearTint(){
  const r = document.documentElement;
  for (const v of TINT_VARS) r.style.removeProperty(v);
}
function applyTint(code){
  const p = paletteForCode(code);
  const r = document.documentElement;
  r.style.setProperty('--fg', p.fg);
  r.style.setProperty('--fg-dim', p.dim);
  r.style.setProperty('--accent', p.accent);
  r.style.setProperty('--hand', p.hand);
  r.style.setProperty('--hand-sec', p.hsec);
}
function isDynamic(){ return app.settings.display === 'dynamic'; }

function applyDisplay(){
  if (!app.fx) return;
  if (isDynamic()){
    app.fx.setActive(true);
    if (app.lastWeather){ app.fx.setCondition(app.lastWeather.code); if (!app.deepDim) applyTint(app.lastWeather.code); }
  } else {
    app.fx.setActive(false);
    clearTint();
  }
}

// ---------- Night dim (orthogonal boolean) ----------
function applyDim(on){
  app.deepDim = !!on;
  $('dim').style.opacity = on ? '0.55' : '0';
  $('app').classList.toggle('night', !!on);
  if (app.clock) app.clock.setDeepDim(!!on);
  // Dynamic backdrop pauses in deep-dim; night palette takes over the text tint.
  if (app.fx && isDynamic()){
    app.fx.setPaused(!!on);
    if (on) clearTint(); else if (app.lastWeather) applyTint(app.lastWeather.code);
  }
  syncDimButton();
}

function checkNightSchedule(){
  if (!app.settings.night){ if (app.deepDim) applyDim(false); return; }
  const h = new Date().getHours();
  const { nightStart, nightEnd } = app.settings;
  let on;
  if (nightStart <= nightEnd) on = (h >= nightStart && h < nightEnd);
  else on = (h >= nightStart || h < nightEnd); // wraps midnight
  if (on !== app.deepDim) applyDim(on);
}

// ---------- Weather ----------
async function refreshWeather(){
  try {
    const loc = { lat: app.settings.lat, lon: app.settings.lon, city: app.settings.city };
    const w = await getWeather(loc);
    if (w){
      app.lastWeather = w; paintWeather(w);
      if (app.fx && isDynamic()){ app.fx.setCondition(w.code); if (!app.deepDim) applyTint(w.code); }
      updateSun();
    }
    else paintWeatherError();
  } catch(_) { paintWeatherError(); }
}

// Refresh the sun arc from the last known weather (sunrise/sunset). Cheap; safe to
// call every minute. Hides itself if data is missing — clock unaffected either way.
function updateSun(){
  try {
    if (!app.sun) return;
    if (!app.settings.sunArc){ app.sun.hide(); return; } // gated by the Sun-arc setting
    const w = app.lastWeather;
    if (w && w.sunrise && w.sunset) app.sun.update({ sunrise: w.sunrise, sunset: w.sunset });
    else app.sun.hide();
  } catch(_){}
}

function paintWeather(w){
  try {
    // Always show BOTH units: °F primary (hero/big), °C secondary (small). Data is Celsius.
    const cur = bothTemps(w.tempC), feels = bothTemps(w.feelsC),
          hi = bothTemps(w.hiC), lo = bothTemps(w.loC);
    $('wxEmpty').hidden = true;
    $('wxCard').hidden = false;
    const [icon, label] = wmoInfo(w.code);
    $('wxIcon').textContent = icon;
    $('wxTemp').innerHTML =
      '<span class="big">' + cur.f + '°<span class="u">F</span></span>' +
      '<span class="small">' + cur.c + '°C</span>';
    $('wxCond').textContent = label;
    $('wxFeels').textContent = 'Feels like ' + feels.f + '°F (' + feels.c + '°C)';
    $('wxHiLo').textContent = 'High ' + hi.f + '°F (' + hi.c + '°C)   Low ' + lo.f + '°F (' + lo.c + '°C)';
    $('wxPlace').textContent = w.city || (app.settings.city || '');
    const stale = $('wxStale');
    if (w.stale && w.ts){
      const t = new Date(w.ts);
      stale.hidden = false;
      stale.textContent = 'stale since ' + t.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
    } else stale.hidden = true;
  } catch(_) {}
}

function paintWeatherError(){
  const c = loadCache();
  if (c){ paintWeather(Object.assign({}, c, {stale:true})); return; }
  try { $('wxEmpty').hidden = false; $('wxEmpty').textContent = 'Weather unavailable'; $('wxCard').hidden = true; } catch(_){}
}

// ---------- Controls / button labels ----------
function syncButtons(){
  const s = app.settings;
  $('btnMode').textContent = s.mode === 'analog' ? 'Digital' : 'Analog';
  // settings panel mirror buttons
  $('setMode').textContent = s.mode === 'analog' ? 'Analog' : 'Digital';
  $('setStyle').textContent = s.clockStyle === 'block' ? 'Block Matrix' : 'Classic';
  $('setOrient').textContent = s.orientation === 'portrait' ? 'Portrait'
    : s.orientation === 'landscape' ? 'Landscape' : 'Auto';
  $('setDisplay').textContent = s.display === 'dynamic' ? 'Dynamic' : 'Plain';
  $('setSun').textContent = s.sunArc ? 'On' : 'Off';
  $('setHour').textContent = s.hour24 ? '24h' : '12h';
  $('setSeconds').textContent = s.seconds ? 'On' : 'Off';
  $('setDate').textContent = s.date ? 'On' : 'Off';
  $('setNight').textContent = s.night ? 'On' : 'Off';
  syncDimButton();
}
function syncDimButton(){
  $('btnDim').textContent = app.deepDim ? 'Undim' : 'Dim';
}

function persist(){ try { saveSettings(app.settings); } catch(_){} }

function applyClockOptions(){
  const s = app.settings;
  app.clock.setOptions({
    mode: s.mode, style: s.clockStyle, hour24: s.hour24, seconds: s.seconds, date: s.date,
    sweep: app.sweepAllowed && s.mode === 'analog',
  });
}

// ---------- Wiring ----------
function wireControls(){
  // Chrome band
  $('btnMode').addEventListener('click', () => {
    app.settings.mode = app.settings.mode === 'analog' ? 'digital' : 'analog';
    persist(); applyClockOptions(); syncButtons();
  });
  $('btnDim').addEventListener('click', () => applyDim(!app.deepDim));
  $('btnGear').addEventListener('click', () => setState(PANEL));

  // Panel controls
  $('setMode').addEventListener('click', () => {
    app.settings.mode = app.settings.mode === 'analog' ? 'digital' : 'analog';
    persist(); applyClockOptions(); syncButtons();
  });
  $('setStyle').addEventListener('click', () => {
    // Cycle through registered clock styles (classic, block, …).
    const list = (app.clock && app.clock.styleList) ? app.clock.styleList() : [{id:'classic'}];
    const ids = list.map(s => s.id);
    const i = ids.indexOf(app.settings.clockStyle);
    app.settings.clockStyle = ids[(i + 1) % ids.length] || 'classic';
    persist(); applyClockOptions(); syncButtons();
  });
  $('setHour').addEventListener('click', () => { app.settings.hour24 = !app.settings.hour24; persist(); applyClockOptions(); syncButtons(); });
  $('setSeconds').addEventListener('click', () => { app.settings.seconds = !app.settings.seconds; persist(); applyClockOptions(); syncButtons(); });
  $('setDate').addEventListener('click', () => { app.settings.date = !app.settings.date; persist(); applyClockOptions(); syncButtons(); });
  $('setNight').addEventListener('click', () => { app.settings.night = !app.settings.night; persist(); syncButtons(); checkNightSchedule(); });
  $('setOrient').addEventListener('click', () => {
    const order = ['auto','portrait','landscape'];
    const i = order.indexOf(app.settings.orientation);
    app.settings.orientation = order[(i+1) % order.length];
    persist(); applyOrientation(); syncButtons();
  });
  $('setDisplay').addEventListener('click', () => {
    app.settings.display = app.settings.display === 'dynamic' ? 'plain' : 'dynamic';
    persist(); applyDisplay(); syncButtons();
  });
  $('setSun').addEventListener('click', () => {
    app.settings.sunArc = !app.settings.sunArc;
    persist(); updateSun(); syncButtons();
  });
  $('setClose').addEventListener('click', () => setState(ACTIVE));

  $('setCityGo').addEventListener('click', doCitySearch);
  $('setCity').addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); doCitySearch(); } });
  $('setGeo').addEventListener('click', doGeolocate);

  // Outside-tap closes panel.
  $('panel').addEventListener('click', (e) => { if (e.target === $('panel')) setState(ACTIVE); });
}

async function doCitySearch(){
  const name = $('setCity').value;
  const status = $('cityStatus');
  status.textContent = 'Searching…';
  try {
    const hit = await geocodeCity(name);
    if (!hit){ status.textContent = 'Not found.'; return; }
    app.settings.lat = hit.lat; app.settings.lon = hit.lon; app.settings.city = hit.city;
    persist();
    status.textContent = 'Set: ' + hit.city;
    await refreshWeather();
  } catch(_) { status.textContent = 'Search failed.'; }
}

function doGeolocate(){
  const status = $('cityStatus');
  if (!('geolocation' in navigator)){ status.textContent = 'Geolocation unavailable.'; return; }
  status.textContent = 'Locating…';
  try {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        app.settings.lat = pos.coords.latitude;
        app.settings.lon = pos.coords.longitude;
        app.settings.city = null;
        persist();
        status.textContent = 'Location set.';
        await refreshWeather();
      },
      () => { status.textContent = 'Location denied.'; },
      { timeout: 10000, maximumAge: 600000 }
    );
  } catch(_) { status.textContent = 'Location error.'; }
}

function wireInput(){
  const handler = () => onInput();
  document.addEventListener('pointermove', handler, { passive:true });
  document.addEventListener('pointerdown', handler, { passive:true });
  document.addEventListener('click', handler, { passive:true });
  document.addEventListener('keydown', handler, true);

  app.nav = new DpadNav({
    onEscape: () => { if (app.state === PANEL) setState(ACTIVE); },
    onActivate: () => { if (app.state === ACTIVE) resetIdle(); },
  });
}

// ---------- TV detection: size + measured FPS + coarse pointer ----------
async function detectTV(){
  let coarse = false, noHover = false;
  try { coarse = window.matchMedia('(pointer:coarse)').matches; } catch(_){}
  try { noHover = window.matchMedia('(hover:none)').matches; } catch(_){}
  const big = Math.max(screen.width || 0, screen.height || 0) >= 1280
           && Math.min(window.innerWidth, window.innerHeight) >= 600;
  let fps = 60;
  try { fps = await sampleFPS(500); } catch(_) { fps = 0; }

  // "Am I a TV?" — combine signals; fall back to tick (treat as TV) on ANY doubt.
  const poorFPS = fps && fps < 45;
  // Large screen with a coarse/no-hover pointer strongly implies TV.
  const tvLike = (big && (coarse || noHover)) || poorFPS;
  return { isTV: tvLike, fps, poorFPS };
}

// ---------- Service worker ----------
function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  // Only registers over https/localhost; silently skipped on plain http LAN IP.
  try {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    });
  } catch(_) {}
}

// ---------- Boot ----------
async function boot(){
  try {
    app.settings = loadSettings();
  } catch(_) {
    app.settings = { mode:'digital', hour24:false, seconds:true, date:true, night:false,
                     nightStart:21, nightEnd:7, lat:DEFAULT_LOCATION.lat, lon:DEFAULT_LOCATION.lon, city:DEFAULT_LOCATION.city };
  }

  try { app.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(_){ app.reduceMotion = false; }

  // Clock first — must run no matter what else fails.
  try {
    app.clock = new Clock($('stage'), {
      mode: app.settings.mode, style: app.settings.clockStyle, hour24: app.settings.hour24,
      seconds: app.settings.seconds, date: app.settings.date, sweep:false,
    });
  } catch(e){
    // Last-resort text clock so the screen is never blank.
    try { $('stage').textContent = ''; const d=document.createElement('div'); d.className='digital';
      $('stage').appendChild(d); setInterval(()=>{ d.textContent=new Date().toLocaleTimeString(); },1000); } catch(__){}
  }

  // TV detection + sweep decision.
  try {
    const det = await detectTV();
    app.isTV = det.isTV;
    // Sweep only on phone-class (not TV, not poor FPS, not reduced motion).
    app.sweepAllowed = !app.isTV && !det.poorFPS && !app.reduceMotion;
  } catch(_) { app.isTV = false; app.sweepAllowed = !app.reduceMotion; }

  try { if (app.clock) applyClockOptions(); } catch(_){}

  try { applyOrientation(); } catch(_){}

  // Weather FX backdrop (decorative; gated by the Display setting).
  try {
    app.fx = new WeatherFX($('fx'), { isTV: app.isTV, reduceMotion: app.reduceMotion });
    applyDisplay();
  } catch(_){}

  wireControls();
  wireInput();
  syncButtons();

  // Wake lock (phone only; no-op on TV).
  try {
    app.wake = new WakeKeeper({ isTV: app.isTV, video: $('wlVideo') });
    if (app.wake.supported) app.wake.enable();
  } catch(_){}

  startPixelShift();

  // Night-dim schedule check now + every minute.
  try { checkNightSchedule(); app.nightTimer = setInterval(checkNightSchedule, 60000); } catch(_){}

  // Sun-position arc (decorative; driven by cached sunrise/sunset, no extra network).
  try { app.sun = new SunArc($('wxSun')); } catch(_){}

  // Weather: never blocks the clock.
  try {
    const cached = loadCache();
    if (cached){
      app.lastWeather = Object.assign({}, cached, {stale:true}); paintWeather(app.lastWeather);
      if (app.fx && isDynamic()){ app.fx.setCondition(cached.code); if (!app.deepDim) applyTint(cached.code); }
      updateSun();
    }
  } catch(_){}
  refreshWeather();
  app.weatherTimer = setInterval(refreshWeather, 15*60*1000);
  // Move the sun along its arc once a minute (CSS eases the transition).
  app.sunTimer = setInterval(updateSun, 60000);

  setState(REST);
  registerSW();

  // Optional debug handle (only when ?debug=1) for manual FX/condition testing.
  try { if (location.search.indexOf('debug=1') !== -1) window.__app = app; } catch(_){}
}

// Kick off — wrapped so a throw never blanks the page.
try { boot(); } catch(e){ /* clock fallback already attempted */ }
