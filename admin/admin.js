(function () {
  const $ = s => document.querySelector(s);
  const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} }, del(k) { try { sessionStorage.removeItem(k); } catch {} } };
  const API = '../api/';
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#0b6e1c', '#d92d20', '#1d6fe0', '#8a3ffc', '#f08a00', '#00a3a3', '#c2188a', '#5b6b00'];

  let token = store.get('iubat_admin'), S = null, E = null, dirty = false, map = null, markers = [], mapReady = null;

  /* ---------- helpers ---------- */
  let toastT;
  function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'a-toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 5000 : 2600); }
  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { signOut(); throw new Error('Session expired. Please sign in again.'); }
    if (!res.ok) throw new Error(j.error || 'Request failed.');
    return j;
  }
  const act = async (action, body) => { const j = await api('admin', { method: 'POST', body: JSON.stringify({ action, ...body }) }); S = j.state; return j; };
  const ago = ts => { if (!ts) return null; const s = Math.max(0, (S.now - ts) / 1000); return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };

  /* ---------- sign in / out ---------- */
  $('#signinForm').addEventListener('submit', async e => {
    e.preventDefault(); const err = $('#aerr'); err.hidden = true;
    try {
      const res = await fetch(API + 'admin-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#au').value, password: $('#ap').value }) });
      const j = await res.json(); if (!res.ok) throw new Error(j.error || 'Sign-in failed.');
      token = j.token; store.set('iubat_admin', token); await start();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });
  function signOut() { token = null; store.del('iubat_admin'); $('#adminApp').hidden = true; $('#signin').hidden = false; $('#ap').value = ''; }
  $('#aout').addEventListener('click', signOut);

  async function start() {
    S = await api('admin');
    $('#signin').hidden = true; $('#adminApp').hidden = false;
    renderBuses(); renderRouteList(); renderNotices(); renderSharing();
    setInterval(async () => { if (!$('#tab-sharing').hidden && !document.hidden) { try { S = await api('admin'); renderSharing(); } catch {} } }, 10000);
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', x === b));
    ['buses', 'routes', 'notices', 'sharing'].forEach(t => { $('#tab-' + t).hidden = b.dataset.tab !== t; });
    if (b.dataset.tab === 'routes') { initMap().then(() => { map.resize(); drawRoute(); }); }
  }));

  /* ---------- Buses ---------- */
  const routeOpts = sel => '<option value="">— No route —</option>' + S.routes.map(r => `<option value="${esc(r.id)}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  // Reminder for admins: which other buses already run a route (sharing a route is fine).
  const busesOn = (routeId, except) => routeId ? S.buses.filter(b => b.routeId === routeId && b.id !== except).map(b => b.id) : [];
  const alsoText = (routeId, except) => { const o = busesOn(routeId, except); return o.length ? `Also on this route: Bus ${o.join(', ')}` : ''; };
  function renderBuses() {
    $('#newBusRoute').innerHTML = routeOpts('');
    $('#busEmpty').hidden = S.buses.length > 0;
    $('#busRows').innerHTML = S.buses.map(b => {
      const seen = ago(b.lastSeen), live = b.lastSeen && S.now - b.lastSeen < 60000;
      return `<tr data-id="${esc(b.id)}">
        <td><input class="no" value="${esc(b.id)}" maxlength="10" aria-label="Bus number"></td>
        <td><select class="rt" aria-label="Route">${routeOpts(b.routeId)}</select><small class="also">${esc(alsoText(b.routeId, b.id))}</small></td>
        <td><input class="tm ds" type="time" value="${esc(b.departStart || '')}" aria-label="Leaves start"></td>
        <td><input class="tm dc" type="time" value="${esc(b.departCampus || '')}" aria-label="Leaves campus"></td>
        <td><input class="dy" list="dayPresets" value="${esc(b.days || '')}" maxlength="30" placeholder="Sat–Wed" aria-label="Days"></td>
        <td><span class="seen ${live ? 'on' : ''}"><i></i>${seen ? seen : 'Never'}</span></td>
        <td class="r"><button class="btn ghost-btn sm save" hidden>Save</button><button class="btn ghost-btn sm tok">New token</button><button class="btn ghost-btn sm danger del">Delete</button></td></tr>`;
    }).join('');
  }
  $('#busRows').addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr) tr.querySelector('.save').hidden = false; });
  $('#busRows').addEventListener('change', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    tr.querySelector('.save').hidden = false;
    if (e.target.classList.contains('rt')) tr.querySelector('.also').textContent = alsoText(e.target.value, tr.dataset.id);
  });
  $('#newBusRoute').addEventListener('change', e => { $('#newBusAlso').textContent = alsoText(e.target.value, null); });
  $('#busRows').addEventListener('click', async e => {
    const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id;
    try {
      if (e.target.closest('.save')) {
        await act('saveBus', { id, newId: tr.querySelector('.no').value, routeId: tr.querySelector('.rt').value || null,
          departStart: tr.querySelector('.ds').value, departCampus: tr.querySelector('.dc').value, days: tr.querySelector('.dy').value });
        const others = busesOn(tr.querySelector('.rt').value, tr.querySelector('.no').value.trim());
        toast(others.length ? `Bus saved. Bus ${others.join(', ')} also runs this route.` : 'Bus saved'); renderBuses(); renderRouteList();
      }
      else if (e.target.closest('.tok')) { if (!confirm(`Generate a new tracker token for bus ${id}? The old token will stop working.`)) return; const j = await act('newToken', { id }); showToken(id, j.token); }
      else if (e.target.closest('.del')) { if (!confirm(`Delete bus ${id}? Its tracker token will stop working.`)) return; await act('deleteBus', { id }); toast('Bus deleted'); renderBuses(); renderRouteList(); }
    } catch (x) { toast(x.message, true); }
  });
  $('#addBus').addEventListener('submit', async e => {
    e.preventDefault(); const no = $('#newBusNo').value.trim();
    try {
      const routeId = $('#newBusRoute').value || null, others = busesOn(routeId, no);
      const j = await act('saveBus', { id: null, newId: no, routeId });
      $('#newBusNo').value = ''; $('#newBusAlso').textContent = ''; renderBuses(); renderRouteList(); showToken(no, j.token);
      if (others.length) toast(`Bus ${no} added. Bus ${others.join(', ')} also runs this route.`);
    }
    catch (x) { toast(x.message, true); }
  });
  function showToken(no, t) {
    $('#tokTitle').textContent = `Tracker token · Bus ${no}`;
    $('#tokVal').value = t; $('#tokLink').value = `${location.origin}/tracker/?key=${t}`;
    $('#tokDlg').showModal();
  }
  $('#tokCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#tokLink').value); toast('Link copied'); } catch { $('#tokLink').select(); toast('Press Ctrl+C to copy'); } });

  /* ---------- Sharing ---------- */
  const ST = { verified: ['Verified · in use', 'ok'], backup: ['Verified · standby (bus phone live)', 'ok'], checking: ['Checking movement', 'wait'], paused: ['Paused · not moving', 'wait'],
    weak_gps: ['Weak GPS', 'wait'], off_route: ['Not on route', 'bad'], jump: ['Impossible jump', 'bad'], disagree: ['Does not match other rider', 'bad'] };
  function renderSharing() {
    $('#crowdOn').checked = !!S.crowdEnabled;
    $('#sharerEmpty').hidden = S.sharers.length > 0;
    $('#sharerRows').innerHTML = S.sharers.map(x => {
      const [label, cls] = ST[x.status] || [x.status, 'wait'];
      return `<tr><td><b>${esc(x.studentId)}</b></td><td>Bus ${esc(x.busId)}</td><td class="st-${cls}">${esc(label)}</td><td class="small">${fmtWhen(x.startedAt)}</td><td class="small">${ago(x.lastTs) || ''}</td>
        <td class="r"><button class="btn ghost-btn sm danger" data-block="${esc(x.studentId)}">Block</button></td></tr>`;
    }).join('');
    $('#blockEmpty').hidden = S.blocked.length > 0;
    $('#blockRows').innerHTML = S.blocked.map(x => `<tr><td><b>${esc(x.studentId)}</b></td><td class="small">Blocked ${fmtWhen(x.at)}</td><td class="r"><button class="btn ghost-btn sm" data-unblock="${esc(x.studentId)}">Unblock</button></td></tr>`).join('');
  }
  $('#crowdOn').addEventListener('change', async e => {
    try { await act('setCrowd', { enabled: e.target.checked }); toast(e.target.checked ? 'Student sharing turned on' : 'Student sharing turned off'); renderSharing(); }
    catch (x) { toast(x.message, true); e.target.checked = !e.target.checked; }
  });
  $('#tab-sharing').addEventListener('click', async e => {
    const b = e.target.closest('[data-block]'), u = e.target.closest('[data-unblock]');
    try {
      if (b && confirm(`Block student ${b.dataset.block} from sharing location?`)) { await act('blockSharer', { studentId: b.dataset.block }); toast('Student blocked'); renderSharing(); }
      if (u) { await act('unblockSharer', { studentId: u.dataset.unblock }); toast('Student unblocked'); renderSharing(); }
    } catch (x) { toast(x.message, true); }
  });

  /* ---------- Notices ---------- */
  const fmtWhen = ts => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  function renderNotices() {
    $('#noticeEmpty').hidden = S.notices.length > 0;
    $('#noticeRows').innerHTML = S.notices.map(n => {
      const live = !n.expiresAt || n.expiresAt > S.now;
      return `<tr data-id="${n.id}"><td class="ntext">${esc(n.message)}</td>
        <td><span class="pill ${n.level === 'urgent' ? 'urgent' : 'info'}">${n.level === 'urgent' ? 'Urgent' : 'Notice'}</span></td>
        <td class="small">${fmtWhen(n.createdAt)}</td>
        <td class="small">${live ? (n.expiresAt ? 'Showing until ' + fmtWhen(n.expiresAt) : 'Showing') : 'Expired'}</td>
        <td class="r"><button class="btn ghost-btn sm danger ndel">Delete</button></td></tr>`;
    }).join('');
  }
  $('#nMsg').addEventListener('input', e => { $('#nCount').textContent = `${e.target.value.length} / 500`; });
  $('#noticeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const exp = $('#nExp').value ? new Date($('#nExp').value).getTime() : null;
    try {
      await act('addNotice', { message: $('#nMsg').value, level: $('#nLevel').value, expiresAt: exp });
      $('#nMsg').value = ''; $('#nExp').value = ''; $('#nCount').textContent = '0 / 500';
      toast('Notice published to all apps'); renderNotices();
    } catch (x) { toast(x.message, true); }
  });
  $('#noticeRows').addEventListener('click', async e => {
    const b = e.target.closest('.ndel'); if (!b) return;
    if (!confirm('Delete this notice? It will disappear from all apps.')) return;
    try { await act('deleteNotice', { id: b.closest('tr').dataset.id }); toast('Notice deleted'); renderNotices(); } catch (x) { toast(x.message, true); }
  });

  /* ---------- Routes ---------- */
  function renderRouteList() {
    $('#routeList').innerHTML = S.routes.map(r => {
      const ids = busesOn(r.id, null);
      return `<li><button data-id="${esc(r.id)}" aria-current="${E && E.id === r.id}"><i style="background:${esc(r.color)}"></i><span>${esc(r.name)}</span><small>${ids.length ? 'Bus ' + ids.map(esc).join(', ') : 'No bus'}</small></button></li>`;
    }).join('') || '<li class="muted small" style="padding:8px">No routes yet.</li>';
  }
  $('#routeList').addEventListener('click', e => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const r = S.routes.find(x => x.id === b.dataset.id);
    edit({ id: r.id, name: r.name, color: r.color, stops: r.stops.map(({ approx, ...s }) => ({ ...s, ...(approx ? { auto: true } : {}) })) }, true);
  });
  $('#newRoute').addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    edit({ id: null, name: '', color: COLORS[S.routes.length % COLORS.length], stops: [] }, false);
  });

  function edit(route, fit) {
    E = route; dirty = false; placing = null; $('#placing').hidden = true;
    $('#routeForm').hidden = false; $('#routeHint').hidden = true;
    $('#rName').value = E.name; $('#rColor').value = E.color; $('#delRoute').hidden = !E.id; $('#rMsg').textContent = '';
    const on = busesOn(E.id, null); $('#rBuses').textContent = E.id ? (on.length ? `Buses on this route: ${on.join(', ')}` : 'No bus is assigned to this route yet (assign one in Buses).') : '';
    renderStops(); renderRouteList();
    initMap().then(() => { map.resize(); drawRoute(); if (fit) fitRoute(); });
  }
  $('#rName').addEventListener('input', e => { E.name = e.target.value; dirty = true; });
  $('#rColor').addEventListener('input', e => { E.color = e.target.value; dirty = true; drawRoute(); });

  let placing = null; // index of the stop waiting for a map click
  function setPlacing(i) {
    placing = i;
    const el = $('#placing');
    el.hidden = i === null; if (i !== null) el.textContent = `Click the map to place stop ${i + 1} "${E.stops[i].name}"`;
    if (map) map.getCanvas().style.cursor = i === null ? '' : 'crosshair';
  }
  const hasPos = s => s.lat != null && s.lng != null;
  function renderStops() {
    const n = E.stops.length;
    $('#stopList').innerHTML = E.stops.map((s, i) => {
      const flag = !hasPos(s) ? '<span class="flag bad" title="Not on the map yet">No location</span>' : s.auto ? '<span class="flag wait" title="Found automatically: check the marker">Check</span>' : '';
      return `<li data-i="${i}" class="${placing === i ? 'placing' : ''}">
        <span class="n ${!hasPos(s) ? 'miss' : s.auto ? 'auto' : ''}">${i + 1}</span>
        <span class="nm-wrap"><input class="nm" value="${esc(s.name)}" maxlength="60" aria-label="Stop ${i + 1} name">${flag}</span>
        <input class="tm" type="time" value="${esc(s.time || '')}" aria-label="Stop ${i + 1} pick-up time">
        <span class="act"><button data-a="place" title="Place on map" aria-label="Place on map">&#128205;</button><button data-a="focus" title="Show on map" aria-label="Show on map" ${hasPos(s) ? '' : 'disabled'}>&#9678;</button><button data-a="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&uarr;</button><button data-a="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">&darr;</button><button data-a="del" aria-label="Delete stop">&times;</button></span></li>`;
    }).join('')
      + `<li class="campus"><span class="n">${n + 1}</span><span class="nm-wrap"><input value="IUBAT Campus (fixed end point)" disabled aria-label="Campus"></span><span></span><span class="act"></span></li>`;
    if (!n) $('#stopList').insertAdjacentHTML('afterbegin', '<li class="muted small" style="display:block">No stops yet. Click the map, search a place, or use Add stops in bulk.</li>');
  }
  $('#stopList').addEventListener('input', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const st = E.stops[+li.dataset.i];
    if (e.target.classList.contains('nm')) st.name = e.target.value; else if (e.target.classList.contains('tm')) st.time = e.target.value;
    dirty = true;
  });
  $('#stopList').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('li').dataset.i, a = b.dataset.a;
    if (a === 'place') {
      setPlacing(placing === i ? null : i); renderStops();
      if (placing !== null) $('.a-mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' }); // the map is below a long stop list
      return;
    }
    if (a === 'focus') { $('.a-mapbox').scrollIntoView({ behavior: 'smooth', block: 'center' }); map.flyTo({ center: [E.stops[i].lng, E.stops[i].lat], zoom: 15.5 }); return; }
    if (a === 'del') E.stops.splice(i, 1);
    else if (a === 'up') [E.stops[i - 1], E.stops[i]] = [E.stops[i], E.stops[i - 1]];
    else if (a === 'down') [E.stops[i + 1], E.stops[i]] = [E.stops[i], E.stops[i + 1]];
    setPlacing(null); dirty = true; renderStops(); drawRoute();
  });

  /* ---- bulk add: paste the stop list, then look each stop up near the route ---- */
  function parseStops(text) {
    const out = [];
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/^\s*\d{1,3}[.)\-\s]+(?=\D)/, '').trim();   // drop a leading serial number like "01" or "1."
      if (!line) continue;
      let time = '';
      const m = line.match(/[\s,|\-–]*(\d{1,2})[:.](\d{2})\s*([ap])\.?\s*m\.?\s*$/i) || line.match(/[\s,|\-–]*(\d{1,2})[:.](\d{2})\s*$/);
      if (m) {
        let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toLowerCase();
        if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
        if (h < 24 && mi < 60) { time = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'); line = line.slice(0, m.index).trim(); }
      }
      line = line.replace(/[\s,|\-–]+$/, '');
      if (!line || /^(iubat\s*)?campus$/i.test(line)) continue;    // campus is the fixed end point
      out.push({ name: line.slice(0, 60), time, lat: null, lng: null });
    }
    return out;
  }
  function searchBox() {
    const saved = E.id && S.routes.find(r => r.id === E.id);
    const pts = [[S.campus.lng, S.campus.lat], ...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), ...(saved ? saved.geometry : [])];
    let [w, so, e, n] = [180, 90, -180, -90];
    for (const [x, y] of pts) { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); }
    const pad = pts.length > 2 ? 0.04 : 0.35; // only the campus known: search a wide area around it
    return [w - pad, n + pad, e + pad, so - pad].map(v => v.toFixed(4)).join(',');
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Common Bangla-English spelling variants seen in stop names, to give OpenStreetMap search a better chance.
  const SPELL = [[/chowr?astha|chourastha|chourasta|chorasta|chowrasta/gi, 'Chowrasta'], [/purabari/gi, 'Porabari'], [/\bmor\b/gi, 'More'],
    [/bazaar/gi, 'Bazar'], [/\bbr?idge\b/gi, 'Bridge'], [/\s*&\s*/g, ' and ']];
  function variants(name) {
    const out = [name];
    let v = name; for (const [re, to] of SPELL) v = v.replace(re, to);
    if (v !== name) out.push(v);
    const short = v.replace(/\s+(bridge|more|bus stop|stand|stoppage)$/i, '').trim();  // "Salna Bridge" -> "Salna" (area)
    if (short !== v && short.length >= 4) out.push(short);
    return out;
  }
  async function geocode(name, box) {
    for (const q of variants(name)) {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bd&bounded=1&viewbox=' + box + '&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (j[0]) return { lat: +(+j[0].lat).toFixed(6), lng: +(+j[0].lon).toFixed(6) };
      await sleep(1100); // about one request per second (OpenStreetMap search policy)
    }
    return null;
  }
  async function locateMissing() {
    const todo = E.stops.filter(s => !hasPos(s));
    if (!todo.length) return;
    const box = searchBox(); let found = 0;
    for (let k = 0; k < todo.length; k++) {
      $('#rMsg').textContent = `Looking up stops on the map… ${k + 1} / ${todo.length}`;
      try { const p = await geocode(todo[k].name, box); if (p) { Object.assign(todo[k], p, { auto: true }); found++; } } catch { /* leave it unplaced */ }
      renderStops(); drawRoute();
      await sleep(1100); // OpenStreetMap's search service allows about one request per second
    }
    const missing = todo.length - found;
    $('#rMsg').textContent = `${found} of ${todo.length} stops found. ${missing ? `${missing} not found: use 📍 Place and click the map.` : ''} Check every marker, then Save.`;
    fitRoute();
  }
  $('#bulkBtn').addEventListener('click', () => { $('#bulkText').value = ''; $('#bulkDlg').returnValue = ''; $('#bulkDlg').showModal(); });
  $('#bulkDlg').addEventListener('close', async () => {
    if ($('#bulkDlg').returnValue !== 'yes') return;
    const list = parseStops($('#bulkText').value);
    if (!list.length) return toast('No stops found in the text', true);
    E.stops.push(...list); dirty = true; renderStops();
    await initMap(); await locateMissing();
  });

  $('#saveRoute').addEventListener('click', async () => {
    const miss = E.stops.findIndex(x => !hasPos(x));
    if (miss >= 0) { toast(`Stop ${miss + 1} "${E.stops[miss].name}" has no location yet. Use 📍 Place and click the map.`, true); return; }
    const btn = $('#saveRoute'); btn.disabled = true; btn.textContent = 'Saving…'; $('#rMsg').textContent = '';
    try {
      // "approx" keeps the Check flag for stops whose position was found automatically and not yet confirmed
      const stops = E.stops.map(({ name, lat, lng, time, auto }) => ({ name, lat, lng, ...(time ? { time } : {}), ...(auto ? { approx: true } : {}) }));
      const j = await act('saveRoute', { route: { id: E.id, name: E.name, color: E.color, stops } });
      renderStops();
      E.id = j.id; dirty = false; $('#delRoute').hidden = false;
      $('#rMsg').textContent = j.snapped ? `Saved · ${j.km.toFixed(1)} km, snapped to roads` : 'Saved · road service unavailable, drawn as straight lines';
      if (j.warn) { $('#rMsg').textContent += ' · Check: ' + j.warn; toast(j.warn, true); }
      toast('Route saved'); renderRouteList(); renderBuses(); drawRoute();
    } catch (x) { toast(x.message, true); }
    btn.disabled = false; btn.textContent = 'Save route';
  });
  $('#delRoute').addEventListener('click', async () => {
    const n = S.buses.filter(b => b.routeId === E.id).length;
    if (!confirm(`Delete route "${E.name}"?${n ? ` ${n} bus(es) will be left without a route.` : ''}`)) return;
    try { await act('deleteRoute', { id: E.id }); E = null; dirty = false; $('#routeForm').hidden = true; $('#routeHint').hidden = false; toast('Route deleted'); renderRouteList(); renderBuses(); drawRoute(); }
    catch (x) { toast(x.message, true); }
  });
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- Map ---------- */
  function initMap() {
    if (mapReady) return mapReady;
    map = new maplibregl.Map({ container: 'amap', style: STYLE, center: [S.campus.lng, S.campus.lat], zoom: 11, pitch: 0, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapReady = new Promise(res => map.on('load', () => {
      map.addSource('draft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('saved', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'saved-casing', type: 'line', source: 'saved', paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': .9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'saved-line', type: 'line', source: 'saved', paint: { 'line-color': ['get', 'color'], 'line-width': 5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
      map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 2] } });
      new maplibregl.Marker({ element: pin('★', 'campus') }).setLngLat([S.campus.lng, S.campus.lat]).addTo(map);
      res();
    }));
    map.on('click', e => {
      if (!E) { toast('Select or create a route first'); return; }
      if (placing !== null && E.stops[placing]) {
        const done = placing;
        Object.assign(E.stops[done], { lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) }); delete E.stops[done].auto;
        setPlacing(null); dirty = true; renderStops(); drawRoute();
        toast(`Stop ${done + 1} placed. Drag the marker to adjust.`);
        const row = $(`#stopList li[data-i="${done}"]`); if (row) setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 600);
        return;
      }
      E.stops.push({ name: `Stop ${E.stops.length + 1}`, lat: +e.lngLat.lat.toFixed(6), lng: +e.lngLat.lng.toFixed(6) });
      dirty = true; renderStops(); drawRoute();
      const inp = $('#stopList li[data-i="' + (E.stops.length - 1) + '"] input'); if (inp) { inp.focus(); inp.select(); }
    });
    return mapReady;
  }
  function pin(txt, cls) { const el = document.createElement('div'); el.className = 'a-pin ' + (cls || ''); el.textContent = txt; return el; }

  function drawRoute() {
    if (!map || !map.getSource('draft')) return;
    markers.forEach(m => m.remove()); markers = [];
    if (!E) { map.getSource('draft').setData({ type: 'FeatureCollection', features: [] }); map.getSource('saved').setData({ type: 'FeatureCollection', features: [] }); return; }
    E.stops.forEach((s, i) => {
      if (!hasPos(s)) return;
      const m = new maplibregl.Marker({ element: pin(i + 1, s.auto ? 'auto' : ''), draggable: true }).setLngLat([s.lng, s.lat]).addTo(map);
      m.on('dragend', () => { const p = m.getLngLat(); s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); delete s.auto; dirty = true; renderStops(); drawRoute(); });
      markers.push(m);
    });
    const pts = [...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
    const saved = E.id && S.routes.find(r => r.id === E.id);
    const showDraft = dirty || !saved; // unsaved edits: dashed straight preview; saved: solid road-snapped line
    map.getSource('draft').setData({ type: 'FeatureCollection', features: showDraft ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: pts } }] : [] });
    map.getSource('saved').setData({ type: 'FeatureCollection', features: saved && !dirty ? [{ type: 'Feature', properties: { color: E.color }, geometry: { type: 'LineString', coordinates: saved.geometry } }] : [] });
  }
  function fitRoute() {
    const pts = [...E.stops.filter(hasPos).map(s => [s.lng, s.lat]), [S.campus.lng, S.campus.lat]];
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 600 });
  }

  // Place search (OpenStreetMap Nominatim) — only used while editing routes
  $('#placeSearch').addEventListener('submit', async e => {
    e.preventDefault(); const q = $('#placeQ').value.trim(); if (!q) return;
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bd&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (!j[0]) return toast('Place not found', true);
      await initMap(); const at = [+j[0].lon, +j[0].lat]; map.flyTo({ center: at, zoom: 15.5 });
      if (E) {
        const box = document.createElement('div'); box.className = 'a-pop';
        box.innerHTML = `<b>${esc(j[0].display_name.split(',').slice(0, 2).join(','))}</b><button class="btn primary sm">Add “${esc(q)}” as stop</button>`;
        const pop = new maplibregl.Popup({ closeOnClick: true, maxWidth: '260px' }).setLngLat(at).setDOMContent(box).addTo(map);
        box.querySelector('button').onclick = () => { E.stops.push({ name: q.slice(0, 60), lat: +at[1].toFixed(6), lng: +at[0].toFixed(6) }); dirty = true; renderStops(); drawRoute(); pop.remove(); toast('Stop added. Drag the marker if needed.'); };
      }
    } catch { toast('Search failed. Try again.', true); }
  });

  if (token) start().catch(() => signOut());
})();
