// weather.js — Open-Meteo (no key, no signup). WMO mapping, localStorage cache.
// Clock NEVER depends on this — every entry point is wrapped by the caller.

const CACHE_KEY = 'clockpwa.weather.v1';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE  = 'https://geocoding-api.open-meteo.com/v1/search';

// WMO weather codes → { icon, label }. Mapped here ourselves (no icon dependency).
const WMO = {
  0:['☀️','Clear sky'],
  1:['🌤️','Mainly clear'], 2:['⛅','Partly cloudy'], 3:['☁️','Overcast'],
  45:['🌫️','Fog'], 48:['🌫️','Rime fog'],
  51:['🌦️','Light drizzle'], 53:['🌦️','Drizzle'], 55:['🌧️','Dense drizzle'],
  56:['🌧️','Freezing drizzle'], 57:['🌧️','Freezing drizzle'],
  61:['🌧️','Light rain'], 63:['🌧️','Rain'], 65:['🌧️','Heavy rain'],
  66:['🌧️','Freezing rain'], 67:['🌧️','Freezing rain'],
  71:['🌨️','Light snow'], 73:['🌨️','Snow'], 75:['❄️','Heavy snow'], 77:['❄️','Snow grains'],
  80:['🌦️','Light showers'], 81:['🌧️','Showers'], 82:['⛈️','Violent showers'],
  85:['🌨️','Snow showers'], 86:['🌨️','Snow showers'],
  95:['⛈️','Thunderstorm'], 96:['⛈️','Thunderstorm + hail'], 99:['⛈️','Thunderstorm + hail'],
};

export function wmoInfo(code){
  return WMO[code] || ['·','—'];
}

function safeLSGet(k){ try { return localStorage.getItem(k); } catch(_){ return null; } }
function safeLSSet(k,v){ try { localStorage.setItem(k,v); return true; } catch(_){ return false; } }

export function loadCache(){
  const raw = safeLSGet(CACHE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(_) { return null; }
}

function saveCache(obj){ safeLSSet(CACHE_KEY, JSON.stringify(obj)); }

// Fetch with timeout; never throws past the caller's try/catch but we still guard.
async function fetchJSON(url, ms = 12000){
  if (typeof fetch !== 'function') throw new Error('no fetch');
  let ctrl = null, t = null;
  try { ctrl = new AbortController(); t = setTimeout(()=>ctrl.abort(), ms); } catch(_) { ctrl = null; }
  const opts = ctrl ? { signal: ctrl.signal } : {};
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  } finally {
    if (t) clearTimeout(t);
  }
}

// Normalize an Open-Meteo forecast JSON (direct API or server-pushed weather.json).
export function normalizeForecast(j, loc){
  const cur = j.current || {};
  const daily = j.daily || {};
  return {
    tempC: cur.temperature_2m,
    feelsC: cur.apparent_temperature,
    code: cur.weather_code,
    rh: cur.relative_humidity_2m,
    hiC: daily.temperature_2m_max ? daily.temperature_2m_max[0] : null,
    loC: daily.temperature_2m_min ? daily.temperature_2m_min[0] : null,
    // Sunrise/sunset are naive ISO strings in the LOCATION's timezone (timezone=auto).
    sunrise: daily.sunrise ? daily.sunrise[0] : null,
    sunset: daily.sunset ? daily.sunset[0] : null,
    utcOffsetSec: (typeof j.utc_offset_seconds === 'number') ? j.utc_offset_seconds : null,
    city: (loc && loc.city) || null,
    lat: loc && loc.lat, lon: loc && loc.lon,
    ts: Date.now(),
    stale: false,
  };
}

/**
 * Fetch current weather DIRECTLY from Open-Meteo (needs internet on the device).
 * Returns normalized object and caches it. On failure, returns last cached value
 * flagged stale (or null if none).
 * @param {{lat:number,lon:number,city?:string}} loc
 */
export async function getWeather(loc){
  const url = `${FORECAST}?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code`
    + `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset`
    + `&temperature_unit=celsius&timezone=auto&forecast_days=1`;
  try {
    const data = normalizeForecast(await fetchJSON(url), loc);
    saveCache(data);
    return data;
  } catch (err) {
    const cached = loadCache();
    if (cached){ return Object.assign({}, cached, { stale:true }); }
    return null;
  }
}

/**
 * Read SERVER-PUSHED weather (./weather.json written by the host). Same-origin, so
 * it works on LAN devices WITHOUT internet. Returns null if absent/unfetched yet.
 * @param {{city?:string,lat?:number,lon?:number}} loc  labels the result
 */
export async function getServerWeather(loc){
  try {
    const j = await fetchJSON('weather.json', 8000);
    if (!j || !j.current) return null;
    const data = normalizeForecast(j, loc || {});
    saveCache(data);
    return data;
  } catch (_) { return null; }
}

// Geocode a city name → {lat,lon,city}. Touch-only convenience; returns null on miss.
export async function geocodeCity(name){
  if (!name || !name.trim()) return null;
  const url = `${GEOCODE}?name=${encodeURIComponent(name.trim())}&count=1&language=en&format=json`;
  try {
    const j = await fetchJSON(url, 10000);
    if (j && Array.isArray(j.results) && j.results.length){
      const r = j.results[0];
      const label = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
      return { lat:r.latitude, lon:r.longitude, city:label };
    }
  } catch(_) {}
  return null;
}

// US ZIP → {lat,lon,city} via zippopotam.us (free, no key, no signup). Null on miss.
export async function zipLookup(zip){
  const z = (zip || '').trim();
  if (!/^\d{5}$/.test(z)) return null;
  try {
    const j = await fetchJSON('https://api.zippopotam.us/us/' + z, 8000);
    if (j && Array.isArray(j.places) && j.places.length){
      const p = j.places[0];
      const lat = parseFloat(p.latitude), lon = parseFloat(p.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)){
        const name = [p['place name'], p['state abbreviation']].filter(Boolean).join(', ');
        return { lat, lon, city: name || ('ZIP ' + z) };
      }
    }
  } catch(_) {}
  return null;
}

// Temperature helpers. Data is stored in Celsius; both units are shown on display.
function valid(c){ return c != null && Number.isFinite(c); }
export function fF(c){ return valid(c) ? Math.round(c * 9/5 + 32) : null; } // °F integer
export function fC(c){ return valid(c) ? Math.round(c) : null; }            // °C integer
// "72°F (22°C)" — F primary, C secondary. Falls back to "--" for missing values.
export function bothTemps(c){
  const f = fF(c), cc = fC(c);
  return { f: f == null ? '--' : ''+f, c: cc == null ? '--' : ''+cc };
}
