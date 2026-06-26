// feelcolor.js — map temperature + humidity to a readable digit palette.
// Pure, no DOM, no deps. Used for the primary clock AND the second-clock badge.

// Temperature (°C) -> base hue stops. Hue is interpolated linearly between
// adjacent stops and clamped past the ends. Lower hue = warmer (red/orange).
const TEMP_STOPS = [
  [-5, 200],  // winter  — icy cyan-blue
  [ 5, 210],  // cold    — blue
  [14, 180],  // cool    — teal
  [21, 140],  // mild    — green
  [27,  45],  // warm    — amber
  [33,  12],  // hot     — orange-red
];

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }

function hueForTemp(tempC){
  const s = TEMP_STOPS;
  if (tempC <= s[0][0]) return s[0][1];
  if (tempC >= s[s.length - 1][0]) return s[s.length - 1][1];
  for (let i = 0; i < s.length - 1; i++){
    const [t0, h0] = s[i], [t1, h1] = s[i + 1];
    if (tempC >= t0 && tempC <= t1) return lerp(h0, h1, (tempC - t0) / (t1 - t0));
  }
  return s[s.length - 1][1];
}

function hsl(h, sPct, lPct){
  return `hsl(${Math.round(h)}, ${Math.round(sPct * 100)}%, ${Math.round(lPct * 100)}%)`;
}

const NEUTRAL = { fg:'#e6e6e6', dim:'#9aa0a6', accent:'#cfd3d8', hand:'#e6e6e6', hsec:'#ff7a5f' };

// weatherColor(tempC, rh) -> { fg, dim, accent, hand, hsec }
export function weatherColor(tempC, rh){
  if (tempC == null || !Number.isFinite(tempC)) return Object.assign({}, NEUTRAL);
  let hue = hueForTemp(tempC);
  const h = (rh != null && Number.isFinite(rh)) ? clamp(rh, 0, 100) : 50;
  // Humidity: dry -> crisp/saturated; humid -> desaturated + a muggy green pull
  // (only meaningful for warm/hot temps). humidT: 0 at 20% RH, 1 at 90% RH.
  const humidT = clamp((h - 20) / 70, 0, 1);
  const sat = lerp(0.90, 0.55, humidT);
  if (tempC > 18) hue = lerp(hue, 130, humidT * 0.5);
  const light = lerp(0.80, 0.74, humidT);
  const fg = hsl(hue, sat, light);
  const dim = hsl(hue, sat * 0.7, light * 0.62);
  const accent = hsl(hue, sat, Math.min(0.88, light + 0.06));
  const hsec = hsl((hue + 180) % 360, Math.min(0.9, sat + 0.15), 0.66);
  return { fg, dim, accent, hand: fg, hsec };
}
