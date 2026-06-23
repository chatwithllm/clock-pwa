// wakelock.js — Wake Lock API with hidden-video fallback (phone only). No-op on TV.
// Feature-detected; never throws. Re-acquires on visibilitychange.

export class WakeKeeper {
  /** @param {{isTV:boolean, video:HTMLVideoElement}} opts */
  constructor({ isTV, video } = {}){
    this.isTV = !!isTV;
    this.video = video || null;
    this._lock = null;
    this._usingVideo = false;
    this._enabled = false;
    this._status = 'off';     // 'lock' | 'video' | 'off' | 'na' | 'unsupported'
    this._onStatus = null;
    this._onVis = () => this._reacquire();
  }

  // Subscribe to status changes (for an on-screen indicator). Fires immediately.
  onStatus(cb){ this._onStatus = (typeof cb === 'function') ? cb : null; if (this._onStatus) this._onStatus(this._status); }
  getStatus(){ return this._status; }
  _setStatus(s){ if (s === this._status) return; this._status = s; if (this._onStatus) { try { this._onStatus(s); } catch(_){} } }

  get supported(){
    return !this.isTV && (this._hasWakeLock() || !!this.video);
  }
  _hasWakeLock(){
    try { return 'wakeLock' in navigator && typeof navigator.wakeLock.request === 'function'; }
    catch(_) { return false; }
  }

  async enable(){
    if (this.isTV){ this._setStatus('na'); return false; }   // TV: no video hack, no-op
    if (!this.supported){ this._setStatus('unsupported'); return false; }
    this._enabled = true;
    document.addEventListener('visibilitychange', this._onVis);
    return this._acquire();
  }

  async _acquire(){
    if (!this._enabled) return false;
    if (this._hasWakeLock()){
      try {
        this._lock = await navigator.wakeLock.request('screen');
        this._lock.addEventListener && this._lock.addEventListener('release', () => {
          this._lock = null; if (this._enabled) this._setStatus('off');  // system released it
        });
        this._usingVideo = false;
        this._setStatus('lock');
        return true;
      } catch(_) { /* fall through to video */ }
    }
    return this._startVideo();
  }

  _startVideo(){
    if (!this.video){ this._setStatus('off'); return false; }
    try {
      // 1x1 silent black looping clip generated at runtime — no asset dependency.
      if (!this.video.src){
        this.video.src = makeTinyVideoDataURI();
      }
      this.video.muted = true;
      const p = this.video.play();
      if (p && typeof p.catch === 'function') p.catch(()=>{});
      this._usingVideo = true;
      this._setStatus('video');
      return true;
    } catch(_) { this._setStatus('off'); return false; }
  }

  async _reacquire(){
    if (!this._enabled) return;
    if (document.visibilityState === 'visible'){
      if (!this._lock) await this._acquire();
      if (this._usingVideo && this.video && this.video.paused){
        try { const p = this.video.play(); if (p&&p.catch) p.catch(()=>{}); } catch(_){}
      }
    }
  }

  async disable(){
    this._enabled = false;
    document.removeEventListener('visibilitychange', this._onVis);
    if (this._lock){ try { await this._lock.release(); } catch(_){} this._lock = null; }
    if (this._usingVideo && this.video){ try { this.video.pause(); } catch(_){} }
    this._usingVideo = false;
    this._setStatus('off');
  }
}

// Minimal valid MP4 is large to inline; instead use a tiny silent WebM data URI.
// This base64 is a ~1s 2x2 black VP8 webm; enough to satisfy "playing video" wake.
function makeTinyVideoDataURI(){
  // Tiny black webm (generated offline). Loops via the loop attribute.
  return 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////FUmpZpkq17GDD0JATYCGQ2hyb21lV0GGQ2hyb21lFlSua7+uvdeBAXPFh7vMS+1+L/PrtL2DfLdYsAA';
}
