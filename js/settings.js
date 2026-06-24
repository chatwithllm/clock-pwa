// settings.js — load/save settings, read config from URL query params.
// Tolerates localStorage being wiped: falls back to URL params, then defaults.

const LS_KEY = 'clockpwa.settings.v1';

// Editable default location constant (precedence #4). Default: New York City.
export const DEFAULT_LOCATION = {
  lat: 40.7128,
  lon: -74.0060,
  city: 'New York',
};

// US-friendly defaults.
const DEFAULTS = {
  mode: 'digital',      // 'digital' | 'analog'
  clockStyle: 'classic',// digital STYLE id (distinct from mode): 'classic' | 'block' (default Classic)
  orientation: 'auto',  // 'auto' | 'portrait' | 'landscape' (auto => follow device)
  display: 'dynamic',   // 'plain' | 'dynamic' (default Dynamic: weather-tinted text + animated backdrop)
  sunArc: true,         // show the sunrise→sunset sun-position arc in the weather card
  hour24: false,        // false => 12h (US default)
  seconds: true,
  date: true,
  night: true,          // night-dim schedule enabled by default (dim at night, burn-in safe)
  nightStart: 21,       // hour (local) dim turns on
  nightEnd: 7,          // hour (local) dim turns off
  locationMode: 'server', // 'server' (use /config.json) | 'custom' (lat/lon below)
  timeSource: 'device', // 'device' (own clock) | 'server' (sync to host clock)
  profile: 'None',      // device room profile (Theater Room / Kitchen / …) for targeting + future room behavior
  secondTz: 'off',      // secondary-clock zone id (see SECOND_ZONES in app.js)
  lat: null,            // CUSTOM location (set via ZIP/city/geolocation/URL)
  lon: null,
  city: null,
};

function safeLSGet(key){
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}
function safeLSSet(key, val){
  try { window.localStorage.setItem(key, val); return true; } catch (_) { return false; }
}

// Read URL params: ?lat=&lon=&city=&mode=  (zero text entry on TV)
function readURL(){
  const out = {};
  try {
    const q = new URLSearchParams(window.location.search);
    const lat = parseFloat(q.get('lat'));
    const lon = parseFloat(q.get('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon)) { out.lat = lat; out.lon = lon; }
    const city = q.get('city');
    if (city) out.city = city;
    const mode = q.get('mode');
    if (mode === 'analog' || mode === 'digital') out.mode = mode;
    const orient = (q.get('orient') || '').toLowerCase();
    if (orient === 'portrait' || orient === 'landscape' || orient === 'auto') out.orientation = orient;
    const disp = (q.get('display') || '').toLowerCase();
    if (disp === 'plain' || disp === 'dynamic') out.display = disp;
    const cstyle = (q.get('clockstyle') || '').toLowerCase();
    if (cstyle === 'classic' || cstyle === 'block') out.clockStyle = cstyle;
    const loc = (q.get('loc') || '').toLowerCase();
    if (loc === 'server' || loc === 'custom') out.locationMode = loc;
    const tsrc = (q.get('time') || '').toLowerCase();
    if (tsrc === 'device' || tsrc === 'server') out.timeSource = tsrc;
    const prof = q.get('profile');
    if (prof) out.profile = prof;
    const second = q.get('second');
    if (second) out.secondTz = second.toLowerCase();
    const sun = (q.get('sun') || '').toLowerCase();
    if (sun === 'on' || sun === '1' || sun === 'true') out.sunArc = true;
    if (sun === 'off' || sun === '0' || sun === 'false') out.sunArc = false;
    const h = q.get('hour');
    if (h === '24') out.hour24 = true;
    if (h === '12') out.hour24 = false;
  } catch (_) {}
  return out;
}

export function loadSettings(){
  let stored = {};
  const raw = safeLSGet(LS_KEY);
  if (raw){
    try { stored = JSON.parse(raw) || {}; } catch (_) { stored = {}; }
  }
  const url = readURL();
  // Precedence: URL overrides stored overrides defaults (URL is explicit intent).
  const s = Object.assign({}, DEFAULTS, stored, url);

  // Resolve effective location (precedence 1 URL, 2 stored, 3 geo handled elsewhere, 4 default).
  if (!(Number.isFinite(s.lat) && Number.isFinite(s.lon))){
    s.lat = DEFAULT_LOCATION.lat;
    s.lon = DEFAULT_LOCATION.lon;
    s.city = s.city || DEFAULT_LOCATION.city;
    s._locationSource = 'default';
  } else {
    s._locationSource = url.lat != null ? 'url' : (stored.lat != null ? 'stored' : 'default');
  }
  // An explicit ?lat=&lon= in the URL means the user wants THAT location → custom mode.
  if (url.lat != null && url.locationMode == null) s.locationMode = 'custom';
  return s;
}

// Persist only the user-controlled keys (never the transient _ fields).
export function saveSettings(s){
  const out = {
    mode: s.mode, clockStyle: s.clockStyle, orientation: s.orientation, display: s.display, sunArc: s.sunArc, hour24: s.hour24, seconds: s.seconds, date: s.date,
    night: s.night, nightStart: s.nightStart, nightEnd: s.nightEnd,
    locationMode: s.locationMode, timeSource: s.timeSource, profile: s.profile, secondTz: s.secondTz,
    lat: s.lat, lon: s.lon, city: s.city,
  };
  safeLSSet(LS_KEY, JSON.stringify(out));
}
