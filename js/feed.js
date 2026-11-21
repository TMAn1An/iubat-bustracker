/*
 * Feed: polls bus positions every 4 s, matches them to the route to work out
 * direction (inbound/outbound), progress and ETA, and gives the map smooth positions.
 */
(function () {
  // Free-tier friendly: positions arrive every ~10 s and the app polls every 8 s; between updates the bus is
  // moved along its route at its last known speed (dead reckoning), so it still looks live.
  const POLL_MS = 8000, PREDICT_MAX_S = 25, OFFLINE_S = 60, STOP_R = 60, MOVING = 1.0; // m/s
  const rad = Math.PI / 180;
  let lat0 = 23.8882, lng0 = 90.3906, kx = 111320 * Math.cos(lat0 * rad), ky = 110574;
  const xy = (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky];
  const ll = (x, y) => [lng0 + x / kx, lat0 + y / ky];
  const fmtMin = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

  // ---- timetable estimate (used only when there is no live signal) ----
  const EST_KMH = 22, STOP_MIN = 0.5;
  const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  /** "Sat–Wed", "Sun-Thu", "Sat, Mon", "Every day" -> Set of weekday numbers (null = every day / unknown) */
  function parseDays(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t || /every|daily|all/.test(t)) return null;
    const out = new Set();
    for (const part of t.split(/[,/]+/)) {
      const m = part.trim().match(/^([a-z]{3})[a-z]*\s*(?:[-–—]|to)?\s*([a-z]{3})?[a-z]*$/);
      if (!m || !(m[1] in DAY) || (m[2] && !(m[2] in DAY))) return null; // can't read it: don't restrict
      let a = DAY[m[1]]; const b = m[2] ? DAY[m[2]] : a;
      for (let i = 0; i < 7; i++) { out.add(a); if (a === b) break; a = (a + 1) % 7; }
    }
    return out;
  }
  /** Bangladesh time (UTC+6, no daylight saving): weekday and minutes since midnight */
  function dhaka(ms) { const d = new Date(ms + 6 * 3600e3); return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 }; }
  const hm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
  /** Position on the route at distance s (metres from the first stop): { lng, lat, bearing } */
  function pointAt(r, s) {
    s = Math.max(0, Math.min(r.length, s));
    let i = 1; while (i < r.cum.length - 1 && r.cum[i] < s) i++;
    const t = (s - r.cum[i - 1]) / ((r.cum[i] - r.cum[i - 1]) || 1), [ax, ay] = r.xy[i - 1], [bx, by] = r.xy[i];
    const [lng, lat] = ll(ax + (bx - ax) * t, ay + (by - ay) * t);
    return { lng, lat, bearing: (Math.atan2(bx - ax, by - ay) / rad + 360) % 360 };
  }

  function prep(r, campus) {
    r.stops = [...r.stops, { name: campus.name, lat: campus.lat, lng: campus.lng }].map(x => ({ ...x }));
    r.xy = r.geometry.map(([lng, lat]) => xy(lng, lat));
    r.cum = [0];
    for (let i = 1; i < r.xy.length; i++) r.cum.push(r.cum[i - 1] + Math.hypot(r.xy[i][0] - r.xy[i - 1][0], r.xy[i][1] - r.xy[i - 1][1]));
    r.length = r.cum[r.cum.length - 1];
    // Keep the admin's driving order. Each stop is matched to the route at or after the previous stop,
    // so roads that are driven twice (or loop back) do not shuffle the stops.
    let minS = 0;
    r.stops.forEach((st, i) => {
      const last = i === r.stops.length - 1;
      st.s = last ? r.length : project(r, ...xy(st.lng, st.lat), Math.max(0, minS - 30)).s;
      minS = Math.max(minS, st.s);
    });
  }
  // Project a point onto the nearest part of the route: { s (metres), dist, x, y, bearing }
  function project(r, px, py, minS = 0) {
    let best = { dist: Infinity };
    for (let i = 1; i < r.xy.length; i++) {
      if (r.cum[i] < minS) continue; // only the part of the route at or after minS
      const [ax, ay] = r.xy[i - 1], [bx, by] = r.xy[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const x = ax + dx * t, y = ay + dy * t, d = Math.hypot(px - x, py - y);
      if (d < best.dist) best = { dist: d, s: r.cum[i - 1] + t * Math.sqrt(l2), x, y, bearing: (Math.atan2(dx, dy) / rad + 360) % 360 };
    }
    return best;
  }

  const Feed = {
    campus: null, routes: [], notices: [], crowdEnabled: false, rev: null, offset: 0, ok: true, onAuthFail: () => {}, onStatus: () => {}, onRoutes: () => {},
    state: new Map(), token: null, timer: null,

    /** Load routes and bus->route assignment (needs a signed-in token). Safe to call again when `rev` changes. */
    async load(token) {
      const res = await fetch('api/routes', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (res.status === 401) throw Object.assign(new Error('auth'), { auth: true });
      const j = await res.json();
      this.campus = j.campus; this.rev = j.rev; lat0 = j.campus.lat; lng0 = j.campus.lng; kx = 111320 * Math.cos(lat0 * rad);
      const routes = j.routes.filter(r => r.geometry.length > 1);
      routes.forEach(r => prep(r, j.campus));
      this.routes = routes;
      const old = this.state, next = new Map();
      j.buses.forEach(b => {
        const r = routes.find(x => x.id === b.routeId) || null, prev = old.get(b.id);
        next.set(b.id, { id: b.id, r, fix: prev?.fix || null, dir: prev?.dir ?? 1, ema: prev?.ema ?? 22 / 3.6, disp: prev?.disp || null, routeChanged: prev && prev.r !== r });
        const st = next.get(b.id);
        st.schedule = { departStart: b.departStart, departCampus: b.departCampus, days: b.days };
        if (st.routeChanged && st.fix) { st.fix = null; st.disp = null; } // re-match on the next fix
      });
      this.state = next;
      this.crowdEnabled = !!j.crowdEnabled;
      this.notices = (j.notices || []).map(n => ({ ...n, expiresLocal: n.expiresAt ? n.expiresAt - (j.now - Date.now()) : null }));
      this.onRoutes(this);
    },

    async login(id, password) {
      let res;
      try { res = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, password }) }); }
      catch { throw new Error('Cannot reach the server. Check your internet connection.'); }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
      return j;
    },

    start(token) { this.token = token; this.poll(); clearInterval(this.timer); this.timer = setInterval(() => this.poll(), POLL_MS); },
    stop() { clearInterval(this.timer); this.token = null; this.state.forEach(s => { s.fix = null; s.disp = null; }); },

    async poll() {
      if (!this.token || document.hidden) return;
      try {
        const res = await fetch('api/buses', { headers: { Authorization: 'Bearer ' + this.token }, cache: 'no-store' });
        if (res.status === 401) { this.stop(); return this.onAuthFail(); }
        const j = await res.json();
        this.offset = j.now - Date.now();
        if (j.rev !== this.rev) await this.load(this.token); // admin changed routes/buses
        j.buses.forEach(f => this.ingest(f));
        if (!this.ok) { this.ok = true; this.onStatus(true); }
      } catch (e) { if (e.auth) { this.stop(); return this.onAuthFail(); } if (this.ok) { this.ok = false; this.onStatus(false); } }
    },

    ingest(f) {
      const st = this.state.get(String(f.id)); if (!st) return;
      if (st.fix && f.ts <= st.fix.ts) return;
      if (!st.r) { // bus has no route assigned yet: show raw position only
        st.fix = { ...f, s: 0, off: 0, tLng: f.lng, tLat: f.lat, tHead: f.heading ?? 0 };
        if (!st.disp) st.disp = { lng: f.lng, lat: f.lat, heading: st.fix.tHead };
        return;
      }
      const p = xy(f.lng, f.lat), pr = project(st.r, p[0], p[1]);
      // direction: use GPS heading when moving, otherwise compare with the previous position along the route
      if (f.speed > MOVING && f.heading != null) st.dir = Math.abs(angDiff(f.heading, pr.bearing)) < 90 ? 1 : -1;
      else if (st.fix && Math.abs(pr.s - st.fix.s) > 15) st.dir = pr.s > st.fix.s ? 1 : -1;
      if (f.speed > 1.5) st.ema += (f.speed - st.ema) * 0.2;
      const onRoad = pr.dist < 50;
      const [lng, lat] = onRoad ? ll(pr.x, pr.y) : [f.lng, f.lat];
      st.fix = { ...f, s: pr.s, off: pr.dist, tLng: lng, tLat: lat, tHead: onRoad ? (st.dir > 0 ? pr.bearing : (pr.bearing + 180) % 360) : (f.heading ?? 0) };
      if (!st.disp) st.disp = { lng, lat, heading: st.fix.tHead };
    },

    /** Call every frame: smoothed positions (live fix, else timetable estimate, else last known) */
    positions(dt) {
      const k = 1 - Math.exp(-dt / 0.9), out = [];
      this.state.forEach((st, id) => {
        let status = this._status(st), tLng, tLat, tHead;
        const est = status === 'offline' ? this._estimate(st) : null;
        if (est) { status = 'estimated'; tLng = est.lng; tLat = est.lat; tHead = est.heading; }
        else if (st.fix) {
          tLng = st.fix.tLng; tLat = st.fix.tLat; tHead = st.fix.tHead;
          // dead reckoning: keep a moving bus moving along its route between updates
          const f = st.fix, age = Math.min(PREDICT_MAX_S, this._age(st));
          if (st.r && status === 'running' && f.speed > MOVING && f.off < 50) {
            const p = pointAt(st.r, f.s + st.dir * f.speed * age);
            tLng = p.lng; tLat = p.lat; tHead = st.dir > 0 ? p.bearing : (p.bearing + 180) % 360;
          }
        }
        else return;
        if (!st.disp) st.disp = { lng: tLng, lat: tLat, heading: tHead };
        const d = st.disp;
        d.lng += (tLng - d.lng) * k; d.lat += (tLat - d.lat) * k;
        d.heading = (d.heading + angDiff(tHead, d.heading) * k + 360) % 360;
        out.push({ id, lng: d.lng, lat: d.lat, heading: d.heading, color: st.r ? st.r.color : '#6b766f', routeId: st.r ? st.r.id : null, status });
      });
      return out;
    },

    /** Where the timetable says the bus should be now, or null outside its trips. Cached for 1 s. */
    _estimate(st) {
      const now = Date.now();
      if (st.estAt && now - st.estAt < 1000) return st.est;
      st.estAt = now; st.est = null;
      const r = st.r, sc = st.schedule;
      if (!r || !sc) return null;
      const t = dhaka(now + this.offset), days = parseDays(sc.days);
      if (days && !days.has(t.day)) return null;
      const tripMin = (r.length / 1000) / EST_KMH * 60 + Math.max(0, r.stops.length - 2) * STOP_MIN;
      // Inbound trip with pick-up times on the stops: follow the real timetable stop by stop.
      const timed = r.stops.filter(x => hm(x.time) != null);
      if (timed.length >= 2) {
        const first = hm(timed[0].time), last = timed[timed.length - 1];
        const lastT = hm(last.time), endT = lastT + ((r.length - last.s) / 1000) / EST_KMH * 60; // after the last timed stop: average speed
        if (t.min >= first && t.min <= endT) {
          let sPos;
          if (t.min >= lastT) sPos = last.s + (r.length - last.s) * ((t.min - lastT) / Math.max(1, endT - lastT));
          else for (let i = 1; i < timed.length; i++) {
            const a = timed[i - 1], b = timed[i], ta = hm(a.time), tb = hm(b.time);
            if (t.min <= tb) { sPos = a.s + (b.s - a.s) * (tb > ta ? (t.min - ta) / (tb - ta) : 1); break; }
          }
          const p = pointAt(r, sPos);
          st.est = { s: sPos, dir: 1, v: EST_KMH / 3.6, lng: p.lng, lat: p.lat, heading: p.bearing, depart: timed[0].time, byStops: true };
          return st.est;
        }
      }
      for (const [dep, dir] of [[hm(sc.departStart), 1], [hm(sc.departCampus), -1]]) {
        if (dep == null) continue;
        const el = t.min - dep;
        if (el < 0 || el > tripMin) continue;
        const along = r.length * (el / tripMin), sPos = dir > 0 ? along : r.length - along;
        const p = pointAt(r, sPos);
        st.est = { s: sPos, dir, v: EST_KMH / 3.6, lng: p.lng, lat: p.lat, heading: dir > 0 ? p.bearing : (p.bearing + 180) % 360,
          depart: dir > 0 ? sc.departStart : sc.departCampus };
        return st.est;
      }
      return null;
    },

    _age(st) { return st.fix ? Math.max(0, (Date.now() + this.offset - st.fix.ts) / 1000) : Infinity; },
    _status(st) {
      if (!st.fix || this._age(st) > OFFLINE_S) return 'offline';
      return st.fix.speed != null && st.fix.speed < MOVING ? 'stopped' : 'running';
    },

    /** Full info for the UI (called once a second) */
    snapshot() { return [...this.state.values()].map(st => ({ ...this._describe(st), routeId: st.r ? st.r.id : null, schedule: st.schedule })); },
    activeNotices() { const now = Date.now(); return this.notices.filter(n => !n.expiresLocal || n.expiresLocal > now); },
    busList() { return [...this.state.keys()]; },

    _describe(st) {
      const r = st.r, f = st.fix, status = this._status(st);
      if (!r) return { id: st.id, routeName: 'No route assigned', color: '#6b766f', status, noRoute: true, from: '—', to: '—', toCampus: true, speedKmh: f ? Math.round((f.speed || 0) * 3.6) : 0,
        progress: 0, nextStop: null, destEta: 0, destEtaText: '—', nextEtaText: '—', atStop: null, stops: [], noData: !f,
        lastUpdateSec: f ? Math.round(this._age(st)) : null, lng: f?.lng, lat: f?.lat };
      const est = status === 'offline' ? this._estimate(st) : null;
      const dir = est ? est.dir : st.dir;
      const travel = dir > 0 ? r.stops : r.stops.slice().reverse();
      const from = travel[0].name, to = travel[travel.length - 1].name;
      const base = { id: st.id, routeId: r.id, routeName: r.name, color: r.color, status: est ? 'estimated' : status, from, to,
        toCampus: dir > 0, inbound: dir > 0, estimated: !!est, estDepart: est ? est.depart : null, estByStops: !!(est && est.byStops), speedKmh: 0, progress: 0, nextStop: null, destEta: 0, destEtaText: '—',
        nextEtaText: '—', atStop: null, lastUpdateSec: null,
        stops: travel.map(s => ({ name: s.name, state: 'upcoming', etaMin: 0, time: s.time || null })) };
      if (!f && !est) return { ...base, noData: true };

      const s = est ? est.s : f.s, age = this._age(st), approx = est ? '~' : '';
      const v = est ? est.v : Math.max(15 / 3.6, Math.min(40 / 3.6, st.ema)); // ETA speed clamped to 15-40 km/h
      const ahead = x => (dir > 0 ? x.s - s : s - x.s);
      let nextIdx = travel.findIndex(x => ahead(x) > 25);
      const here = status === 'stopped' ? travel.find(x => Math.abs(x.s - s) < STOP_R) : null;
      const stops = travel.map((x, i) => {
        let state = nextIdx === -1 || i < nextIdx ? 'passed' : i === nextIdx ? 'next' : 'upcoming';
        if (here === x) state = 'here';
        const eta = state === 'passed' || state === 'here' ? 0 : ahead(x) / v / 60 + Math.max(0, i - nextIdx) * 0.4;
        return { name: x.name, state, etaMin: eta, time: x.time || null };
      });
      const nextStop = nextIdx === -1 ? null : stops[nextIdx];
      const destEta = nextIdx === -1 ? 0 : stops[stops.length - 1].etaMin;
      return { ...base, stops, nextStop, destEta,
        speedKmh: status === 'offline' || est ? 0 : Math.round((f.speed || 0) * 3.6),
        progress: Math.max(0, Math.min(1, (dir > 0 ? s : r.length - s) / r.length)),
        destEtaText: status === 'offline' && !est ? '—' : approx + fmtMin(destEta),
        nextEtaText: nextStop ? approx + fmtMin(nextStop.etaMin) : '—',
        atStop: here ? here.name : null, lastUpdateSec: f ? Math.round(age) : null,
        lng: est ? est.lng : f.lng, lat: est ? est.lat : f.lat, source: est ? 'schedule' : (f.source || 'device') };
    },
  };
  window.Feed = Feed;
})();
