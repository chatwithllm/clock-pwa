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
      // Tiny silent looping clip — no asset dependency. Ensure it's our data URI
      // (an accidental empty assignment resolves to the page URL, which won't play).
      if (!this.video.src || this.video.src.indexOf('data:video') !== 0){
        this.video.src = makeTinyVideoDataURI();
      }
      this.video.muted = true;
      this.video.setAttribute('playsinline','');
      this.video.playsInline = true;
      this.video.loop = true;
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

// Tiny silent black H.264 MP4 (~1.4KB, 2x2, 1s). MP4/H.264 plays on iOS Safari
// (which does NOT support WebM), Android, and desktop — so the keep-awake video
// fallback actually works on iPhones when the Wake Lock API isn't available.
function makeTinyVideoDataURI(){
  return 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMQbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGzbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR5zdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAe/+EAGGdCwB7ZH4iIwEQAAAMABAAAAwAIPFi5IAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFDAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAoYAAAABAAAAFHN0Y28AAAAAAAAAAQAAA0AAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAwAAAACGZyZWUAAAKObWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAOZYiEBX///w9FAAFC34A=';
}
