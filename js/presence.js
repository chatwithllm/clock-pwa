// presence.js — front-camera motion presence (in-browser only) + arrival snapshots.
// Pure helpers first; the camera/DOM controller is added below in Task 3.

// Mean absolute per-pixel delta of two equal-length grayscale arrays (0..255).
// Returns 0 when there is no valid baseline (null/empty/length mismatch).
export function motionScore(prev, curr){
  if (!prev || !curr || prev.length === 0 || prev.length !== curr.length) return 0;
  let sum = 0;
  for (let i = 0; i < curr.length; i++){
    const d = curr[i] - prev[i];
    sum += d < 0 ? -d : d;
  }
  return sum / curr.length;
}

// Presence state machine. motionNow brightens immediately; absence past graceMs dims.
export function presenceReducer(state, motionNow, nowMs, graceMs){
  if (motionNow) return { present: true, lastMotionMs: nowMs };
  const present = (nowMs - state.lastMotionMs) < graceMs;
  return { present, lastMotionMs: state.lastMotionMs };
}

// Snapshot cooldown gate.
export function shouldSnapshot(lastSnapMs, nowMs, cooldownMs){
  return (nowMs - lastSnapMs) >= cooldownMs;
}
