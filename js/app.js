// app.js — bootstrap, state-machine reducer, input routing, pixel-shift, dim.
// Every render/setup entry point is wrapped in try/catch so one failure (e.g.
// weather) NEVER blanks the clock.

import { loadSettings, saveSettings, DEFAULT_LOCATION } from './settings.js';
import { Clock, sampleFPS, setClockOffset, nowDate } from './clock.js';
import { getWeather, getServerWeather, geocodeCity, zipLookup, bothTemps, wmoInfo, loadCache } from './weather.js';
import { DpadNav } from './nav.js';
import { WakeKeeper } from './wakelock.js';
import { WeatherFX, paletteForCode } from './weatherfx.js';
import { SunArc } from './sunarc.js';

const $ = (id) => document.getElementById(id);

// Curated secondary-clock zones (D-pad friendly cycle). 'off' hides it.
const SECOND_ZONES = [
  { id:'off',    label:'Off' },
  { id:'utc',    label:'UTC',          tz:'UTC' },
  { id:'nyc',    label:'New York',     tz:'America/New_York' },
  { id:'chi',    label:'Chicago',      tz:'America/Chicago' },
  { id:'la',     label:'Los Angeles',  tz:'America/Los_Angeles' },
  { id:'london', label:'London',       tz:'Europe/London' },
  { id:'paris',  label:'Paris',        tz:'Europe/Paris' },
  { id:'india',  label:'India',        tz:'Asia/Kolkata' },
  { id:'tokyo',  label:'Tokyo',        tz:'Asia/Tokyo' },
  { id:'sydney', label:'Sydney',       tz:'Australia/Sydney' },
];
const SERVERLOC_KEY = 'clockpwa.serverloc.v1';

// Built-in device room profiles. Custom ones are fetched from /profiles.json
// (admin-managed) and merged in; built-ins always present even if that's empty.
const BUILTINS = ['Theater Room','Study Room','Kitchen','Living Room','Bedroom','Office','Garage'];
const PROFILES_KEY = 'clockpwa.profiles.v1';
const ANNOUNCE_SEEN_KEY = 'clockpwa.announceSeen';
const ANNOUNCE_POLL_MS = 15000;

// Effective Profile cycle list: None + builtins + admin customs (deduped,
// case-insensitive). The device's current value is appended if missing so a
// custom that was removed admin-side still cycles instead of getting stuck.
function effectiveProfiles(){
  const out = [];
  const seen = new Set();
  const push = (name) => {
    const v = String(name == null ? '' : name).trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push(v);
  };
  push('None');
  BUILTINS.forEach(push);
  (app._customProfiles || []).forEach(push);
  const cur = (app.settings && app.settings.profile) || 'None';
  push(cur);
  return out;
}

// ---- State machine (explicit reducer) ----
const REST = 'REST', ACTIVE = 'ACTIVE', PANEL = 'PANEL';

const app = {
  settings: null,
  clock: null,
  nav: null,
  wake: null,
  isTV: false,
  _customProfiles: [],
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
  try { updateSun(); } catch(_){}   // compact sun-arc depends on effective orientation
}

// Effective portrait: honor a forced orientation setting, else the device.
function isEffectivePortrait(){
  const o = app.settings && app.settings.orientation;
  if (o === 'portrait') return true;
  if (o === 'landscape') return false;
  try { return window.matchMedia('(orientation:portrait)').matches; } catch(_){ return true; }
}

// Is the sun currently below the horizon (after sunset / before sunrise)?
function isAfterDark(){
  try {
    const w = app.lastWeather; if (!w || !w.sunrise || !w.sunset) return false;
    const rise = Date.parse(w.sunrise), set = Date.parse(w.sunset);
    if (isNaN(rise) || isNaN(set)) return false;
    const now = nowDate().getTime();
    return now < rise || now > set;
  } catch(_){ return false; }
}

// Format an Open-Meteo naive ISO time ("…T06:17") as a clock string.
function fmtSunTime(iso){
  const m = /T(\d{2}):(\d{2})/.exec(iso || ''); if (!m) return '';
  let h = parseInt(m[1], 10); const mm = m[2];
  if (app.settings.hour24) return (h < 10 ? '0'+h : ''+h) + ':' + mm;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + mm + ' ' + ap;
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
  const h = nowDate().getHours();
  const { nightStart, nightEnd } = app.settings;
  let on;
  if (nightStart <= nightEnd) on = (h >= nightStart && h < nightEnd);
  else on = (h >= nightStart || h < nightEnd); // wraps midnight
  if (on !== app.deepDim) applyDim(on);
}

// ---------- Server-provided location (/config.json) ----------
function loadServerLocCache(){
  try { const r = localStorage.getItem(SERVERLOC_KEY); return r ? JSON.parse(r) : null; } catch(_){ return null; }
}
async function loadServerConfig(){
  // Seed from cache so 'server' mode works instantly / offline.
  app.serverLoc = loadServerLocCache();
  if (typeof fetch !== 'function') return;
  let ctrl = null, t = null;
  try { ctrl = new AbortController(); t = setTimeout(()=>ctrl.abort(), 4000); } catch(_) { ctrl = null; }
  try {
    const r = await fetch('config.json', ctrl ? { cache:'no-store', signal:ctrl.signal } : { cache:'no-store' });
    if (t) clearTimeout(t);
    if (!r.ok) return;
    const j = await r.json();
    const L = j && j.location;
    if (L && Number.isFinite(L.lat) && Number.isFinite(L.lon)){
      app.serverLoc = { lat:L.lat, lon:L.lon, city:L.city || 'Server location' };
      try { localStorage.setItem(SERVERLOC_KEY, JSON.stringify(app.serverLoc)); } catch(_){}
    }
  } catch(_) { if (t) clearTimeout(t); /* keep cached/none — clock unaffected */ }
}

// Resolve the location to fetch weather for, honoring the Location mode.
function effectiveLocation(){
  const s = app.settings;
  if (s._locationSource === 'url') return { lat:s.lat, lon:s.lon, city:s.city }; // explicit URL wins
  if (s.locationMode === 'server' && app.serverLoc) return app.serverLoc;
  if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) return { lat:s.lat, lon:s.lon, city:s.city };
  if (app.serverLoc) return app.serverLoc;
  return { lat:s.lat, lon:s.lon, city:s.city };
}

// ---------- Time source (Device vs Server) ----------
// Server mode measures the host clock from an HTTP Date header (corrected for the
// round trip) so every display shows the same time regardless of its own system
// clock. Uses config.json (network-first in the SW) so the Date header is fresh.
async function syncServerTime(){
  if (app.settings.timeSource !== 'server'){ setClockOffset(0); return; }
  if (typeof fetch !== 'function') return;
  try {
    const t0 = Date.now();
    const r = await fetch('config.json?ts=' + t0, { cache:'no-store' });
    const t1 = Date.now();
    const hdr = r.headers.get('date');
    if (!hdr) return;
    const serverMs = Date.parse(hdr);
    if (isNaN(serverMs)) return;
    // The server stamped Date ~ the midpoint of the round trip.
    setClockOffset(serverMs - (t0 + t1) / 2);
  } catch(_) { /* keep the previous offset; clock keeps running */ }
}
function applyTimeSource(){
  if (app.settings.timeSource === 'server') syncServerTime();
  else setClockOffset(0);
}

// ---------- Weather ----------
async function refreshWeather(){
  try {
    const loc = effectiveLocation();
    let w = null;
    // Server-location devices prefer server-pushed weather.json — works on LAN
    // devices WITHOUT internet. Custom location uses the direct API. Either way
    // falls back to the other, then to cache; the clock is never affected.
    if (app.settings.locationMode === 'server') w = await getServerWeather(loc);
    if (!w) w = await getWeather(loc);
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
    const note = $('wxSunrise');
    const w = app.lastWeather;
    const dark = isAfterDark();
    $('app').classList.toggle('nightsky', dark);   // night → bigger clock hero
    if (app.clock && app.clock.setHero) app.clock.setHero(dark ? 1 : 0);
    if (!app.settings.sunArc || !(w && w.sunrise && w.sunset)){
      app.sun.hide(); if (note) note.hidden = true; return;
    }
    if (dark){
      // After sunset: no sun tile at all — just a subtle inline "next sunrise" note.
      app.sun.hide();
      if (note){ note.textContent = '☾ Sunrise ' + fmtSunTime(w.sunrise); note.hidden = false; }
    } else {
      if (note) note.hidden = true;
      // Day → show the arc (dome in portrait, compact line in the landscape strip).
      app.sun.update({ sunrise: w.sunrise, sunset: w.sunset, preferCompact: !isEffectivePortrait() });
    }
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
  const sz = SECOND_ZONES.find(z => z.id === s.secondTz);
  $('setSecond').textContent = sz ? sz.label : 'Off';
  $('setLocMode').textContent = s.locationMode === 'custom' ? 'Custom' : 'Server';
  $('setTime').textContent = s.timeSource === 'server' ? 'Server' : 'Device';
  $('setProfile').textContent = s.profile || 'None';
  $('setHour').textContent = s.hour24 ? '24h' : '12h';
  $('setSeconds').textContent = s.seconds ? 'On' : 'Off';
  $('setDate').textContent = s.date ? 'On' : 'Off';
  $('setNight').textContent = s.night ? 'On' : 'Off';
  syncDimButton();
}
function syncDimButton(){
  $('btnDim').textContent = app.deepDim ? 'Undim' : 'Dim';
}

// Secondary clock — small subtle label + time in a chosen timezone. Feature-detected
// (Intl timeZone); hides on 'off' or if unsupported. Never throws.
function updateSecondClock(){
  try {
    const el = $('secondClock'); if (!el) return;
    const z = SECOND_ZONES.find(x => x.id === app.settings.secondTz);
    if (!z || z.id === 'off' || !z.tz){ el.hidden = true; return; }
    const now = nowDate();
    let time;
    try {
      time = new Intl.DateTimeFormat(undefined,
        { timeZone: z.tz, hour:'numeric', minute:'2-digit', hour12: !app.settings.hour24 }).format(now);
    } catch(_) { el.hidden = true; return; }   // zone unsupported on this engine
    el.hidden = false;
    $('secondLabel').textContent = z.label.toUpperCase();
    $('secondTime').textContent = time;
    // Day offset hint (+1d / -1d) relative to device local date.
    let dayHint = '';
    try {
      const zoneYmd = new Intl.DateTimeFormat('en-CA', { timeZone: z.tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
      const localYmd = new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
      if (zoneYmd > localYmd) dayHint = '+1d';
      else if (zoneYmd < localYmd) dayHint = '−1d';
    } catch(_){}
    $('secondDay').textContent = dayHint;
  } catch(_){}
}

// Reflect wake-lock state in the chrome-band indicator. Hidden where it doesn't
// apply (TV / unsupported); green "Awake" when held, amber when the screen may sleep.
function updateWakeIndicator(status){
  try {
    const el = $('wlStatus'); if (!el) return;
    const dot = $('wlText');
    el.classList.remove('is-on','is-off');
    if (status === 'lock' || status === 'video'){
      el.hidden = false; el.classList.add('is-on'); dot.textContent = 'Awake';
      el.title = status === 'video' ? 'Keeping screen awake (video fallback)' : 'Screen wake lock active';
    } else if (status === 'off'){
      el.hidden = false; el.classList.add('is-off'); dot.textContent = 'May sleep';
      el.title = 'Wake lock not held — needs HTTPS and the page in foreground';
    } else {
      el.hidden = true;  // 'na' (TV) or 'unsupported'
    }
  } catch(_){}
}

function persist(){ try { saveSettings(app.settings); } catch(_){} }

function applyClockOptions(){
  const s = app.settings;
  app.clock.setOptions({
    mode: s.mode, style: s.clockStyle, hour24: s.hour24, seconds: s.seconds, date: s.date,
    sweep: app.sweepAllowed && s.mode === 'analog',
  });
}

// ---------- Announcements (server-pushed broadcast) ----------
// Poll announce.json (network-first); when a NEW announcement targets this device
// (target 'all' or matches the profile) and isn't stale, show the overlay.
async function pollAnnounce(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('announce.json?ts=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || !j.id || !j.text) return;
    if (j.id === app._announceSeen) return;
    const target = String(j.target || 'all');
    const prof = (app.settings.profile || 'None');
    if (target.toLowerCase() !== 'all' && target.toLowerCase() !== prof.toLowerCase()){
      app._announceSeen = j.id; return;                 // not for this device
    }
    const dur = Number(j.duration) > 0 ? Number(j.duration) : 20;
    const ageSec = j.ts ? (Date.now() - Number(j.ts)) / 1000 : 0;
    if (ageSec > dur + 10){ app._announceSeen = j.id; return; }   // stale, don't pop on load
    showAnnouncement(j, Math.max(4, Math.round(dur - ageSec)));
    app._announceSeen = j.id;
    try { localStorage.setItem(ANNOUNCE_SEEN_KEY, j.id); } catch(_){}
  } catch(_) { /* offline / no file — ignore */ }
}

// Fetch the admin-managed custom profile list (network-first); cache to
// localStorage so it survives offline. Never throws.
async function pollProfiles(){
  if (typeof fetch !== 'function') return;
  try {
    const r = await fetch('profiles.json?ts=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const list = (j && Array.isArray(j.profiles)) ? j.profiles : [];
    app._customProfiles = list.map(function(x){ return String(x).trim(); }).filter(Boolean);
    try { localStorage.setItem(PROFILES_KEY, JSON.stringify(app._customProfiles)); } catch(_){}
    syncButtons();
  } catch(_) { /* offline / no file — keep cached value */ }
}

function showAnnouncement(j, secondsLeft){
  try {
    const el = $('announce'); if (!el) return;
    $('announceIcon').textContent = j.icon || '📢';
    $('announceText').textContent = j.text;
    const from = (j.from || (j.target && j.target !== 'all' ? j.target : '')) ;
    $('announceSub').textContent = from ? ('— ' + from) : '';
    el.hidden = false;
    // Make it remote-operable: scope D-pad to the overlay and focus Dismiss.
    if (app.nav){ app.nav.setScope(el); app.nav.focusFirst(); }
    if (app._announceTimer) clearTimeout(app._announceTimer);
    app._announceTimer = setTimeout(dismissAnnounce, secondsLeft * 1000);
  } catch(_){}
}

function dismissAnnounce(){
  try {
    const el = $('announce'); if (!el || el.hidden) return;
    el.hidden = true;
    if (app._announceTimer){ clearTimeout(app._announceTimer); app._announceTimer = null; }
    if (app.nav) app.nav.setScope(app.state === PANEL ? $('panel') : document);
  } catch(_){}
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
  $('setSecond').addEventListener('click', () => {
    const ids = SECOND_ZONES.map(z => z.id);
    const i = ids.indexOf(app.settings.secondTz);
    app.settings.secondTz = ids[(i + 1) % ids.length] || 'off';
    persist(); updateSecondClock(); syncButtons();
  });
  $('setLocMode').addEventListener('click', () => {
    app.settings.locationMode = app.settings.locationMode === 'server' ? 'custom' : 'server';
    persist(); syncButtons(); refreshWeather();
  });
  $('setTime').addEventListener('click', () => {
    app.settings.timeSource = app.settings.timeSource === 'server' ? 'device' : 'server';
    persist(); applyTimeSource(); syncButtons();
  });
  $('setProfile').addEventListener('click', () => {
    const list = effectiveProfiles();
    const i = list.indexOf(app.settings.profile);
    app.settings.profile = list[(i + 1) % list.length] || 'None';
    persist(); syncButtons();
  });
  $('announceClose').addEventListener('click', dismissAnnounce);
  $('announce').addEventListener('click', (e) => { if (e.target === $('announce')) dismissAnnounce(); });
  $('setClose').addEventListener('click', () => setState(ACTIVE));

  $('setCityGo').addEventListener('click', doCitySearch);
  $('setCity').addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); doCitySearch(); } });
  $('setGeo').addEventListener('click', doGeolocate);

  // Outside-tap closes panel.
  $('panel').addEventListener('click', (e) => { if (e.target === $('panel')) setState(ACTIVE); });
}

async function doCitySearch(){
  const raw = ($('setCity').value || '').trim();
  const status = $('cityStatus');
  if (!raw){ status.textContent = 'Enter a ZIP or city.'; return; }
  status.textContent = 'Searching…';
  try {
    // 5-digit input → US ZIP via zippopotam; otherwise a city/place name.
    const hit = /^\d{5}$/.test(raw) ? await zipLookup(raw) : await geocodeCity(raw);
    if (!hit){ status.textContent = 'Not found.'; return; }
    app.settings.lat = hit.lat; app.settings.lon = hit.lon; app.settings.city = hit.city;
    app.settings.locationMode = 'custom';        // choosing your own location => custom mode
    app.settings._locationSource = 'stored';
    persist(); syncButtons();
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
        app.settings.locationMode = 'custom';
        app.settings._locationSource = 'stored';
        persist(); syncButtons();
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
    onEscape: () => {
      if ($('announce') && !$('announce').hidden){ dismissAnnounce(); return; }
      if (app.state === PANEL) setState(ACTIVE);
    },
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
  const reg = () => { try { navigator.serviceWorker.register('sw.js').catch(()=>{}); } catch(_){} };
  // ES modules are deferred, so the window 'load' event may have ALREADY fired by
  // the time we run — register now in that case, else wait for load.
  if (document.readyState === 'complete') reg();
  else window.addEventListener('load', reg);
}

// ---------- Boot ----------
async function boot(){
  try {
    app.settings = loadSettings();
  } catch(_) {
    app.settings = { mode:'digital', clockStyle:'classic', orientation:'auto', display:'dynamic',
                     sunArc:true, hour24:false, seconds:true, date:true, night:true,
                     nightStart:21, nightEnd:7, locationMode:'server', timeSource:'device', profile:'None', secondTz:'off',
                     lat:DEFAULT_LOCATION.lat, lon:DEFAULT_LOCATION.lon, city:DEFAULT_LOCATION.city };
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

  // Wake lock (phone only; no-op on TV) + on-screen status indicator.
  try {
    app.wake = new WakeKeeper({ isTV: app.isTV, video: $('wlVideo') });
    app.wake.onStatus(updateWakeIndicator);
    app.wake.enable();
  } catch(_){}

  startPixelShift();

  // Night-dim schedule check now + every minute.
  try { checkNightSchedule(); app.nightTimer = setInterval(checkNightSchedule, 60000); } catch(_){}

  // Sun-position arc (decorative; driven by cached sunrise/sunset, no extra network).
  try { app.sun = new SunArc($('wxSun')); } catch(_){}

  // Secondary clock (subtle; updates every second). Hidden unless a zone is chosen.
  try { updateSecondClock(); app.secondTimer = setInterval(updateSecondClock, 1000); } catch(_){}

  // Server-provided location (/config.json) — seeds 'server' mode before first fetch.
  try { await loadServerConfig(); } catch(_){}

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
  // Re-evaluate compact sun-arc on rotation (portrait <-> landscape).
  try { window.addEventListener('resize', updateSun, { passive:true }); } catch(_){}

  // Time source: sync now (if Server), resync every 5 min and when the tab refocuses.
  try {
    applyTimeSource();
    app.timeTimer = setInterval(syncServerTime, 5*60*1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncServerTime(); });
  } catch(_){}

  // Custom profiles: load cached list, then fetch fresh + poll alongside announcements.
  try {
    app._customProfiles = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]') || [];
  } catch(_) { app._customProfiles = []; }

  // Announcements: poll the server for broadcasts (now + every 15s + on refocus).
  try {
    app._announceSeen = localStorage.getItem(ANNOUNCE_SEEN_KEY) || '';
  } catch(_) { app._announceSeen = ''; }
  try {
    pollAnnounce(); pollProfiles();
    app.announceTimer = setInterval(() => { pollAnnounce(); pollProfiles(); }, ANNOUNCE_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden){ pollAnnounce(); pollProfiles(); } });
  } catch(_){}

  setState(REST);
  registerSW();

  // Optional debug handle (only when ?debug=1) for manual FX/condition testing.
  try { if (location.search.indexOf('debug=1') !== -1) window.__app = app; } catch(_){}
}

// Kick off — wrapped so a throw never blanks the page.
try { boot(); } catch(e){ /* clock fallback already attempted */ }
