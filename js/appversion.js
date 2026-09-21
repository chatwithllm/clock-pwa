// appversion.js — detect a server redeploy so a running display can reload.
// The container stamps /version.json ({"v":"<content hash>"}) at start; the app
// remembers the first value it sees and reloads itself when a later poll differs.

const JITTER_MS = 30000;

export function parseVersion(json){
  return json && typeof json.v === 'string' ? json.v : '';
}

// Only a change between two known versions counts: the first poll just records
// the baseline, and a failed/empty fetch must never trigger a reload.
export function versionChanged(known, next){
  return !!known && !!next && known !== next;
}

// r is Math.random(); spreads a fleet's reloads over 30 s so every display
// doesn't hit the server at the same instant after a deploy.
export function reloadDelayMs(r){
  const x = Math.min(Math.max(Number(r) || 0, 0), 0.999999);
  return Math.floor(x * JITTER_MS);
}
