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

// ---- Camera presence controller (DOM; in-browser motion only) ----
const SAMPLE_W = 64, SAMPLE_H = 48;        // downscaled grayscale grid
const MOTION_THRESHOLD = 6;                // mean abs delta (0..255) that counts as motion
const TICK_MS = 500;                       // ~2 fps
const AWAY_GRACE_MS = 90000;               // no motion this long -> away
const RETRY_MS = [2000, 4000, 8000, 16000, 32000, 60000];

export class Presence {
  constructor(video, canvas, { onPresence, snapshot } = {}){
    this.video = video;
    this.canvas = canvas;
    this.onPresence = onPresence || (() => {});
    this.snapshot = snapshot || null;
    this._lastSnapMs = -Infinity;
    this.ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    this.stream = null;
    this.timer = null;
    this.retry = 0;
    this.prev = null;
    this.state = { present: false, lastMotionMs: 0 };
    this._running = false;
  }

  async start(){
    this._running = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no getUserMedia');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 }, audio: false,
      });
      if (!this._running){ this._stopStream(); return; }   // stopped while awaiting
      this.video.srcObject = this.stream;
      this.canvas.width = SAMPLE_W; this.canvas.height = SAMPLE_H;
      await this.video.play().catch(() => {});
      this.retry = 0;
      this._loop();
    } catch(_){
      this._scheduleRetry();   // permission denied / unavailable -> back off, then give up
    }
  }

  stop(){
    this._running = false;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    this._stopStream();
    this.prev = null;
  }

  _stopStream(){
    try { if (this.stream) this.stream.getTracks().forEach(t => t.stop()); } catch(_){}
    this.stream = null;
    try { if (this.video) this.video.srcObject = null; } catch(_){}
  }

  _scheduleRetry(){
    if (!this._running) return;
    const delay = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
    this.retry++;
    if (this.retry > RETRY_MS.length + 4){ this._running = false; return; }  // give up quietly
    this.timer = setTimeout(() => this.start(), delay);
  }

  _grayFrame(){
    try {
      this.ctx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
      const d = this.ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const g = new Uint8Array(SAMPLE_W * SAMPLE_H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++){
        g[p] = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0;
      }
      return g;
    } catch(_){ return null; }
  }

  async _maybeSnapshot(now){
    try {
      const s = this.snapshot;
      if (!s || !s.enabled()) return;
      if (!shouldSnapshot(this._lastSnapMs, now, s.cooldownMs)) return;
      this._lastSnapMs = now;
      const cap = document.createElement('canvas');
      cap.width = 480; cap.height = 360;
      cap.getContext('2d').drawImage(this.video, 0, 0, 480, 360);
      const blob = await new Promise(res => cap.toBlob(res, 'image/jpeg', 0.7));
      if (!blob) return;
      const tok = s.token(); if (!tok) return;
      await fetch('api/snapshot?profile=' + encodeURIComponent(s.profile() || 'unknown'), {
        method:'POST', headers:{ 'Authorization':'Bearer ' + tok, 'Content-Type':'image/jpeg' }, body: blob,
      }).catch(() => {});   // upload failure never affects presence/clock
    } catch(_){}
  }

  _loop(){
    if (!this._running) return;
    const curr = this._grayFrame();
    const now = Date.now();
    if (curr){
      const score = motionScore(this.prev, curr);
      const motion = this.prev != null && score >= MOTION_THRESHOLD;
      this.prev = curr;
      const next = presenceReducer(this.state, motion, now, AWAY_GRACE_MS);
      const changed = next.present !== this.state.present;
      this.state = next;
      if (changed && next.present) this._maybeSnapshot(now);
      if (changed || motion) { try { this.onPresence(next.present, motion, now); } catch(_){} }
    }
    this.timer = setTimeout(() => this._loop(), TICK_MS);
  }
}
