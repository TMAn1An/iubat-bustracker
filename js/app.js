(function () {
  const $ = s => document.querySelector(s);
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };
  const local = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS = { running: 'Running', stopped: 'Stopped', offline: 'Offline', estimated: 'Estimated' };
  const isMobile = () => matchMedia('(max-width: 860px)').matches;
  const ICON_BUS = '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r=".6" fill="currentColor"/><circle cx="15.5" cy="14.5" r=".6" fill="currentColor"/></svg>';
  const ICON_BACK = '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
  const ICON_CHEV = '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
  const ICON_CLOCK = '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  // view: { name: 'routes' } | { name: 'route', routeId, busId } | { name: 'notices' }
  let map = null, view = { name: 'routes' }, snap = [], seenNotices = new Set(local.get('iubat_seen_notices') || []), knownNotices = null;

  /* ================= Sign in ================= */
  const loginEl = $('#login'), appEl = $('#app');
  $('#pwToggle').addEventListener('click', e => {
    const pw = $('#pw'), show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });
  const showErr = msg => {
    const err = $('#loginErr'); err.textContent = msg; err.hidden = false;
    err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
  };
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = $('#sid').value.trim(), pw = $('#pw').value, btn = e.currentTarget.querySelector('button[type=submit]');
    if (!id || !pw) return showErr(!id ? 'Enter your student ID.' : 'Enter your password.');
    $('#loginErr').hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const u = await Feed.login(id, pw);
      store.set('iubat_token', u.token); store.set('iubat_user', u.name || u.id);
      await enter(u.token, u.name || u.id);
    } catch (err) { showErr(err.message); }
    btn.disabled = false; btn.textContent = 'Sign in';
  });
  $('#logout').addEventListener('click', logout);
  function logout() {
    Share.stop();
    store.del('iubat_token'); store.del('iubat_user'); Feed.stop();
    appEl.hidden = true; loginEl.hidden = false; $('#pw').value = ''; view = { name: 'routes' };
  }

  async function enter(token, name) {
    loginEl.hidden = true; appEl.hidden = false;
    $('#userChip').textContent = name;
    await Feed.load(token);
    if (!map) await boot();
    Feed.start(token);
    map.resize();
  }

  /* ================= App ================= */
  async function boot() {
    Feed.onAuthFail = () => { logout(); showErr('Your session has expired. Please sign in again.'); };
    Feed.onStatus = ok => { $('#conn').hidden = ok; };
    map = createMap();
    Feed.onRoutes = f => {
      map.setRoutes(f.routes);
      if (view.name === 'route' && view.routeId && !f.routes.some(r => r.id === view.routeId)) go({ name: 'routes' });
      checkNewNotices(); refresh();
    };
    checkNewNotices();
    Share.onChange = () => render();
    // The list, notices and live data never wait for the map: on a slow mobile connection the map can take long to load.
    let last = performance.now();
    (function loop(now) {
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      map.setBuses(Feed.positions(dt));
      requestAnimationFrame(loop);
    })(last);
    refresh(); setInterval(refresh, 1000);

    $('#panelBody').addEventListener('click', e => {
      const t = e.target;
      if (t.closest('[data-back]')) return go({ name: 'routes' });
      const r = t.closest('[data-route]'); if (r) return openRoute(r.dataset.route);
      const b = t.closest('[data-bus]'); if (b) return openBus(b.dataset.bus);
      if (t.closest('[data-share]')) return askShare(t.closest('[data-share]').dataset.share);
      if (t.closest('[data-unshare]')) return Share.stop();
      if (t.closest('[data-gosh]')) return openBus(Share.busId);
    });
    $('#notices').addEventListener('click', e => {
      if (e.target.closest('[data-all]')) return go({ name: 'notices' });
      const x = e.target.closest('[data-dismiss]'); if (x) { markSeen([+x.dataset.dismiss]); renderNotices(); }
    });
    $('#bell').addEventListener('click', () => go(view.name === 'notices' ? { name: 'routes' } : { name: 'notices' }));
    $('#handle').addEventListener('click', () => { $('#panel').classList.toggle('open'); pad(); });
    addEventListener('resize', pad); pad();

    const tView = $('#tView');
    tView.addEventListener('click', () => {
      const top = map.isTop(); map.setView(top ? '3d' : 'top'); tView.textContent = top ? '3D' : '2D';
    });
    $('#tRotL').addEventListener('click', () => map.rotate(-45));
    $('#tRotR').addEventListener('click', () => map.rotate(45));
    $('#tZin').addEventListener('click', () => map.zoom(0.5));
    $('#tZout').addEventListener('click', () => map.zoom(2));
    $('#tLoc').addEventListener('click', () => map.recenter());
  }

  /* ---------- map (loads in the background) ---------- */
  function createMap() {
    const msg = $('#mapMsg');
    const show = (text, isErr) => { msg.textContent = text; msg.className = 'map-msg' + (isErr ? ' err' : ''); msg.hidden = false; };
    show('Loading map…');
    let m;
    try { m = new BusMap($('#map'), { routes: Feed.routes, campus: Feed.campus, onSelect: openBus }); }
    catch (e) {
      show('This browser cannot show the map. Live bus times in the list still work.', true);
      const noop = () => {};
      return { setRoutes: noop, setBuses: noop, select: noop, selectRoute: noop, setPadding: noop, isTop: () => false, setView: noop, rotate: noop, zoom: noop, recenter: noop, resize: noop };
    }
    const slow = setTimeout(() => show('The map is slow to load on this connection. Live bus info in the list works meanwhile.', true), 15000);
    m.ready.then(() => { clearTimeout(slow); msg.hidden = true; });
    return m;
  }

  /* ---------- navigation ---------- */
  function go(v) {
    const prev = view; view = v;
    if (v.name === 'routes' && prev.name === 'route') map.select(null);
    if (v.name === 'notices') { markSeen(Feed.activeNotices().map(n => n.id)); }
    if (isMobile()) { $('#panel').classList.toggle('open', v.name !== 'routes'); pad(); }
    render(); $('#panelBody').scrollTop = 0;
  }
  function busesOn(routeId) { return snap.filter(b => b.routeId === routeId); }
  // pick the most useful bus on a route: live first, then most recently seen
  function bestBus(list) {
    const rank = b => ({ running: 0, stopped: 1, estimated: 2 }[b.status] ?? 3);
    return list.slice().sort((a, b) => rank(a) - rank(b) || (a.lastUpdateSec ?? 1e9) - (b.lastUpdateSec ?? 1e9))[0];
  }
  function openRoute(routeId, busId) {
    snap = Feed.snapshot();
    const bus = busId ? snap.find(b => b.id === busId) : bestBus(busesOn(routeId));
    go({ name: 'route', routeId, busId: bus ? bus.id : null });
    map.selectRoute(routeId, bus ? bus.id : null);
  }
  function openBus(busId) {
    snap = Feed.snapshot();
    const b = snap.find(x => x.id === busId); if (!b) return;
    if (b.routeId) return openRoute(b.routeId, busId);
    go({ name: 'route', routeId: null, busId }); map.select(busId);
  }

  // On mobile the bottom sheet covers the lower part of the map: shift the camera centre up
  function pad() {
    if (!map) return;
    map.setPadding(!isMobile() ? 0 : ($('#panel').classList.contains('open') ? innerHeight * 0.62 : 124));
  }

  function refresh() { snap = Feed.snapshot(); render(); }

  function render() {
    renderNotices();
    const body = $('#panelBody'), top = body.scrollTop;
    body.innerHTML = shareBar() + (view.name === 'route' ? routeView() : view.name === 'notices' ? noticesView() : routesView());
    body.scrollTop = top;
  }

  /* ---------- notices ---------- */
  function markSeen(ids) { ids.forEach(i => seenNotices.add(i)); local.set('iubat_seen_notices', [...seenNotices].slice(-200)); }
  function checkNewNotices() {
    const list = Feed.activeNotices(), ids = new Set(list.map(n => n.id));
    if (knownNotices) {
      const fresh = list.filter(n => !knownNotices.has(n.id));
      if (fresh.length) flash(fresh[0]);
    }
    knownNotices = ids;
  }
  let flashT;
  function flash(n) {
    const t = $('#ntoast');
    t.className = 'ntoast ' + n.level; t.innerHTML = `<b>${n.level === 'urgent' ? 'Urgent notice' : 'New notice'}</b>${esc(n.message)}`;
    t.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => (t.hidden = true), 8000);
  }
  function renderNotices() {
    const list = Feed.activeNotices(), unread = list.filter(n => !seenNotices.has(n.id));
    const cnt = $('#bellCount'); cnt.hidden = !unread.length; cnt.textContent = unread.length;
    $('#bell').classList.toggle('on', view.name === 'notices');
    const n = unread[0];
    const html = (!n || view.name === 'notices') ? '' :
      `<div class="notice ${n.level}"><div><b>${n.level === 'urgent' ? 'Urgent' : 'Notice'}</b><p>${esc(n.message)}</p>${list.length > 1 ? `<button class="link" data-all>View all ${list.length} notices</button>` : ''}</div><button class="x" data-dismiss="${n.id}" aria-label="Dismiss notice">&times;</button></div>`;
    const el = $('#notices'); if (el.innerHTML !== html) el.innerHTML = html;
  }
  function noticesView() {
    const list = Feed.activeNotices();
    return `<button class="ghost back" data-back>${ICON_BACK} All routes</button><div class="section-title">Notices</div>` +
      (list.length ? list.map(n => `<article class="nitem ${n.level}"><span class="pill ${n.level === 'urgent' ? 'urgent' : 'info'}">${n.level === 'urgent' ? 'Urgent' : 'Notice'}</span><p>${esc(n.message)}</p><time>${when(n.createdAt)}</time></article>`).join('')
        : '<p class="muted-p">No notices right now.</p>');
  }
  const when = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

  /* ---------- formatting ---------- */
  const fmt = m => (m < 1 ? 'Now' : Math.ceil(m) + ' min');
  const short = n => n.replace(/^IUBAT /, '');
  const lastSeen = b => b.lastUpdateSec == null ? 'No data yet' : b.lastUpdateSec < 90 ? b.lastUpdateSec + ' s ago' : Math.round(b.lastUpdateSec / 60) + ' min ago';
  const t12 = v => { if (!v) return null; const [h, m] = v.split(':').map(Number); return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  function schedLine(b) {
    const s = b.schedule || {}, parts = [];
    if (s.departStart) parts.push(`Leaves ${esc(short(b.from === Feed.campus.name ? b.to : b.from))} ${t12(s.departStart)}`);
    if (s.departCampus) parts.push(`Leaves campus ${t12(s.departCampus)}`);
    if (!parts.length) return '';
    return parts.join(' · ') + (s.days ? ` · ${esc(s.days)}` : '');
  }
  const dirText = b => (b.inbound ? 'Inbound · to campus' : 'Outbound · from campus');

  /* ---------- crowd sharing ---------- */
  function askShare(busId) {
    const dlg = $('#shareDlg');
    dlg.returnValue = '';
    dlg.onclose = () => { if (dlg.returnValue === 'yes') Share.start(busId, store.get('iubat_token')); };
    dlg.showModal();
  }
  const SH_CLASS = { verified: 'ok', backup: 'ok', checking: 'wait', starting: 'wait', weak_gps: 'wait', paused: 'wait', off_route: 'bad', jump: 'bad', disagree: 'bad' };
  function shareBar() {
    if (!Share.active && !Share.message) return '';
    if (!Share.active) return `<div class="sharebar ${Share.error ? 'bad' : 'ok'}"><p>${esc(Share.message)}</p></div>`;
    const cls = SH_CLASS[Share.status] || 'wait';
    return `<div class="sharebar ${cls}"><div><b>Sharing for Bus ${esc(Share.busId)}</b><p>${esc(Share.message)}</p></div>
      <span class="sb-act">${view.name !== 'route' || view.busId !== Share.busId ? '<button class="link" data-gosh>View</button>' : ''}<button class="btn-stop" data-unshare>Stop</button></span></div>`;
  }
  function shareCta(b) {
    if (!Feed.crowdEnabled || b.noRoute || Share.active) return '';
    return `<div class="sharecta"><div><b>On this bus?</b><p>Share your phone's location so everyone can see where Bus ${esc(b.id)} is${b.status === 'offline' ? ' (it has no live signal right now)' : ''}.</p></div><button class="btn primary sm" data-share="${esc(b.id)}">Share location</button></div>`;
  }
  const srcText = b => (b.source === 'crowd' ? 'via a rider on board' : b.source === 'schedule' ? 'estimated from the timetable' : 'via bus GPS');

  /* ---------- routes list ---------- */
  function routesView() {
    const routes = Feed.routes;
    if (!routes.length && !snap.length) return '<p class="section-title">No routes have been set up yet.</p>';
    const live = snap.filter(b => b.status !== 'offline').length;
    let html = `<div class="section-title">Routes · ${live} bus${live === 1 ? '' : 'es'} live</div>`;
    html += routes.map(r => {
      const list = busesOn(r.id), b = bestBus(list);
      const origin = r.stops[0]?.name || r.name;
      const liveLine = !b ? '<span class="muted-s">No bus assigned yet</span>'
        : b.status === 'offline' ? `<span class="pill offline">Bus ${esc(b.id)} · Offline</span>`
        : b.status === 'estimated' ? `<span class="pill estimated">Bus ${esc(b.id)} · Estimated</span><span class="muted-s">${dirText(b)} · ${b.destEtaText}</span>`
        : `<span class="pill ${b.status}">Bus ${esc(b.id)} · ${STATUS[b.status]}</span><span class="muted-s">${dirText(b)}${b.destEtaText !== '—' ? ' · ' + b.destEtaText : ''}</span>`;
      const sched = b ? schedLine(b) : '';
      return `<button class="rcard" data-route="${esc(r.id)}" style="--route:${esc(r.color)}">
        <span class="rbar"></span>
        <span class="rmain">
          <h3>${esc(r.name)}</h3>
          <span class="rsub">${esc(short(origin))} <span class="arrow">⇄</span> Campus${list.length ? ` · Bus ${list.map(x => esc(x.id)).join(', ')}` : ''}</span>
          ${sched ? `<span class="rsched">${ICON_CLOCK}${sched}</span>` : ''}
          <span class="rlive">${liveLine}</span>
        </span>
        <span class="chev">${ICON_CHEV}</span>
      </button>`;
    }).join('');
    const loose = snap.filter(b => !b.routeId);
    if (loose.length) html += `<div class="section-title">Other buses</div>` + loose.map(b => `
      <button class="rcard" data-bus="${esc(b.id)}" style="--route:#9aa29b"><span class="rbar"></span>
        <span class="rmain"><h3>Bus ${esc(b.id)}</h3><span class="rsub">No route assigned yet</span><span class="rlive"><span class="pill ${b.status}">${STATUS[b.status]}</span></span></span>
        <span class="chev">${ICON_CHEV}</span></button>`).join('');
    return html;
  }

  /* ---------- one route ---------- */
  function routeView() {
    const back = `<button class="ghost back" data-back>${ICON_BACK} All routes</button>`;
    const r = view.routeId && Feed.routes.find(x => x.id === view.routeId);
    const list = r ? busesOn(r.id) : snap.filter(b => b.id === view.busId);
    const b = list.find(x => x.id === view.busId) || bestBus(list);
    const title = r ? esc(r.name) : `Bus ${esc(view.busId)}`;
    let html = back + `<div class="r-head" style="--route:${r ? esc(r.color) : '#9aa29b'}"><span class="rbar"></span><div><h2>${title}</h2>
      <span class="rsub">${r ? `${esc(short(r.stops[0].name))} <span class="arrow">⇄</span> IUBAT Campus` : 'No route assigned yet'}</span></div></div>`;
    if (list.length > 1) html += `<div class="seg" role="tablist">${list.map(x => `<button role="tab" data-bus="${esc(x.id)}" aria-selected="${x.id === b.id}"><i class="dot ${({ running: 'run', stopped: 'stop', estimated: 'est' })[x.status] || 'off'}"></i>Bus ${esc(x.id)}</button>`).join('')}</div>`;
    if (!b) return html + `<p class="muted-p">No bus is assigned to this route yet.</p>` + (r ? stopsOnly(r) : '');
    const sched = schedLine(b);
    if (sched) html += `<div class="sched">${ICON_CLOCK}<span>${sched}</span></div>`;
    return html + busDetail(b, r);
  }
  const stopsOnly = r => `<div class="section-title">Route stops</div><ol class="timeline">${r.stops.map(s => `<li class="upcoming"><i></i><div class="nm"><span>${esc(s.name)}</span><span class="tm">${s.time ? t12(s.time) : ''}</span></div></li>`).join('')}</ol>`;

  function busDetail(b, r) {
    const head = `<div class="d-head"><span class="badge ${b.status}">${esc(b.id)}</span><div><h2>Bus ${esc(b.id)}</h2><span class="pill ${b.status}">${STATUS[b.status]}${b.atStop && b.status === 'stopped' ? ' · ' + esc(b.atStop) : ''}</span>${(b.noRoute || b.noData) ? '' : ` <span class="pill dir">${dirText(b)}</span>`}</div></div>`;
    if (b.noData) return head + shareCta(b) + `<p class="muted-p">No live location yet. It appears as soon as the bus phone or a rider on board shares.</p>` + (r ? stopsOnly(r) : '');
    if (b.noRoute) return head + `<p class="muted-p">No route assigned yet. Live position is shown on the map.</p>`;
    const off = b.status === 'offline', est = b.status === 'estimated';
    const next = off ? 'Offline' : (b.nextStop ? esc(b.nextStop.name) : 'Arrived');
    const estNote = est ? `<div class="estnote"><b>No live signal right now.</b> This position is estimated from the timetable (left ${esc(short(b.from))} at ${t12(b.estDepart)}${b.estByStops ? ', following the stop pick-up times' : ', assuming about 22 km/h'}). The real bus may be ahead or behind.</div>` : '';
    return `${head}${estNote}
      <div class="journey">
        <div class="j-ends">
          <div><small>From</small><b>${esc(b.from)}</b></div>
          <div class="to"><small>To</small><b>${esc(b.to)}</b></div>
        </div>
        <div class="track" aria-hidden="true">
          <div class="fill" style="width:${(b.progress * 100).toFixed(1)}%"></div>
          <div class="bus" style="left:${(b.progress * 100).toFixed(1)}%">${ICON_BUS}</div>
        </div>
        <div class="j-foot">${off ? '<b>No signal</b> · last seen ' + lastSeen(b) : '<b>' + (b.inbound ? 'Heading to campus' : 'Leaving campus') + '</b> · ' + srcText(b)}</div>
      </div>
      ${shareCta(b)}
      <div class="stats">
        <div class="stat hot"><small>Arrives in</small><strong>${b.destEtaText}</strong></div>
        <div class="stat warm"><small>Next stop</small><strong style="font-size:16px">${next}</strong>${!off && b.nextStop ? `<em> · ${b.nextEtaText}</em>` : ''}</div>
        <div class="stat"><small>Speed</small><strong>${est ? '—' : `${b.speedKmh} <em>km/h</em>`}</strong></div>
        <div class="stat"><small>${est ? 'Last live signal' : 'Last update'}</small><strong style="font-size:16px">${lastSeen(b)}</strong></div>
      </div>
      <div class="section-title">Route stops</div>
      <ol class="timeline">
        ${b.stops.map(s => `
          <li class="${s.state}">
            <i></i>
            <div class="nm"><span>${esc(s.name)}${s.state === 'here' ? ' <span class="tag">Here</span>' : ''}${s.state === 'next' ? ' <span class="tag">Next</span>' : ''}${s.time && b.inbound ? `<small class="sched-t">${t12(s.time)}</small>` : ''}</span>
              <span class="tm">${s.state === 'passed' ? 'Passed' : s.state === 'here' ? 'Now' : off ? '' : fmt(s.etaMin)}</span></div>
          </li>`).join('')}
      </ol>`;
  }

  /* ---------- installable app (PWA) ---------- */
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  let installEvt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').hidden = false; });
  addEventListener('appinstalled', () => { installEvt = null; $('#installBtn').hidden = true; });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').hidden = true;
  });

  // Resume an existing session
  const tk = store.get('iubat_token');
  if (tk) enter(tk, store.get('iubat_user') || '').catch(() => { store.del('iubat_token'); loginEl.hidden = false; appEl.hidden = true; });
})();
