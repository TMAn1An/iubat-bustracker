/*
 * Share: lets a student on the bus share their phone's location for that bus (crowd mode).
 * The server verifies every fix (on the route, moving like a vehicle, no jumps) before it is shown to others.
 */
(function () {
  const SEND_MS = 10000; // every 10 s: enough for the map (the app fills the gaps) and kind to the free hosting quota
  const Share = {
    busId: null, status: null, message: '', error: null, onChange: () => {},
    watch: null, wake: null, pending: null, lastPos: null, timer: null, last: 0, token: null,

    get active() { return this.watch !== null; },

    start(busId, token) {
      if (!('geolocation' in navigator)) { this._set(null, 'Location is not available on this device.', true); return; }
      this.stop(true);
      this.busId = busId; this.token = token; this.status = 'starting'; this.message = 'Getting your location…'; this.error = null;
      this.lastPos = null;
      this.watch = navigator.geolocation.watchPosition(p => { this.pending = p; this.lastPos = p; this._flush(); }, e => {
        if (e.code === 1) { this.stop(); this._set(null, 'Location permission was denied. Allow it in your browser settings to share.', true); }
        else this._set('weak_gps', 'Waiting for a GPS signal…');
      }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
      this.timer = setInterval(() => this._flush(), 1000);
      this._lock();
      document.addEventListener('visibilitychange', this._vis = () => { if (document.visibilityState === 'visible' && this.active) this._lock(); });
      this.onChange(this);
    },

    async stop(silent) {
      const was = this.active, bus = this.busId, token = this.token;
      if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
      this.watch = null; clearInterval(this.timer); this.pending = null; this.lastPos = null;
      try { this.wake && this.wake.release(); } catch {} this.wake = null;
      if (this._vis) document.removeEventListener('visibilitychange', this._vis);
      if (was && token) fetch('api/share', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action: 'stop', busId: bus }) }).catch(() => {});
      if (!silent) { this.busId = null; this.status = null; this.message = ''; this.onChange(this); }
    },

    async _lock() { try { if ('wakeLock' in navigator) this.wake = await navigator.wakeLock.request('screen'); } catch {} },
    _set(status, message, isError) { this.status = status; this.message = message; this.error = !!isError; this.onChange(this); },

    async _flush() {
      // A phone that is not moving gets no new GPS events, so re-send the last position:
      // the server needs it to show a bus waiting in traffic and to notice a rider who got off.
      const pos = this.pending || this.lastPos;
      if (!pos || Date.now() - this.last < SEND_MS) return;
      const { coords: c } = pos; this.pending = null; this.last = Date.now();
      try {
        const res = await fetch('api/share', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + this.token },
          body: JSON.stringify({ busId: this.busId, lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed ?? undefined, heading: c.heading ?? undefined }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { this.stop(); this._set(null, j.error || 'Sharing stopped.', true); return; }
        if (j.status === 'arrived') { await this.stop(true); this.busId = null; this._set(null, j.message); return; }
        this._set(j.status, j.message);
      } catch { this._set(this.status, 'Network problem, retrying…'); }
    },
  };
  window.Share = Share;
})();
