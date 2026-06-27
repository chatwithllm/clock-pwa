// source.js — pure helpers for the unified time+weather "Source" switch.

// A client Source value maps to the two underlying modes.
export function sourceToModes(source){
  return source === 'local'
    ? { timeSource:'device', locationMode:'custom' }
    : { timeSource:'server', locationMode:'server' };
}

// Display "source" for a device with no stored unified value (pre-upgrade).
// Mixed/local-leaning legacy modes show as 'local'; both-server shows 'server'.
export function legacySource(timeSource, locationMode){
  return (timeSource === 'server' && locationMode === 'server') ? 'server' : 'local';
}

// Decide whether an admin-pushed source.json should change the client.
// file: parsed { mode, force } | null.  userSet: has the user manually chosen?
// Returns { source, locked } to apply, or null for "no change".
export function resolveServerSource(file, userSet){
  if (!file || (file.mode !== 'server' && file.mode !== 'local')) return null;
  if (file.force) return { source:file.mode, locked:true };
  if (!userSet) return { source:file.mode, locked:false };
  return null;
}
