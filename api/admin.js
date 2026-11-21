import { db, adminFrom, buildGeometry, bumpRev, getRev, sha256, num, CAMPUS, ensureSchema, getSetting, setSetting } from './_lib.js';
import { randomBytes } from 'node:crypto';

const BUS_ID = /^[A-Za-z0-9-]{1,10}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = (v, label) => { v = String(v || '').trim(); if (v && !TIME.test(v)) throw new Error(`${label}: use a time like 06:30.`); return v || null; };
const newToken = () => randomBytes(18).toString('base64url');

function cleanStops(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 80) throw new Error('A route needs at least one stop (the starting point).');
  return list.map((s, i) => {
    const lat = num(s.lat, -90, 90), lng = num(s.lng, -180, 180), name = String(s.name || '').trim().slice(0, 60);
    if (!name) throw new Error(`Stop ${i + 1} needs a name.`);
    if (lat === null || lng === null) throw new Error(`Stop ${i + 1} "${name}" has no location yet. Use Place and click the map.`);
    const stop = { name, lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (s.time) stop.time = time(s.time, `Stop ${i + 1} pick-up time`);   // optional "HH:MM" pick-up time
    if (s.approx) stop.approx = true;   // position found automatically; admin has not confirmed it yet
    return stop;
  });
}

async function state() {
  const [routes, buses, pos] = await Promise.all([
    db().execute('SELECT id, name, color, stops, geometry, updated_at FROM routes ORDER BY name'),
    db().execute('SELECT id, route_id, depart_start, depart_campus, days FROM buses ORDER BY CAST(id AS INTEGER), id'),
    db().execute('SELECT bus_id, ts, speed FROM positions'),
  ]);
  const notices = await db().execute('SELECT id, message, level, created_at, expires_at FROM notices ORDER BY created_at DESC LIMIT 100');
  const sharers = await db().execute({ sql: 'SELECT student_id, bus_id, status, started_at, verified_at, last_ts FROM share_sessions WHERE last_ts > ? ORDER BY last_ts DESC', args: [Date.now() - 30 * 60e3] });
  const blocks = await db().execute('SELECT student_id, at FROM share_blocks ORDER BY at DESC');
  const last = Object.fromEntries(pos.rows.map(p => [p.bus_id, p]));
  return {
    now: Date.now(), campus: CAMPUS, rev: await getRev(),
    routes: routes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, stops: JSON.parse(r.stops), geometry: JSON.parse(r.geometry) })),
    buses: buses.rows.map(b => ({ id: b.id, routeId: b.route_id, departStart: b.depart_start, departCampus: b.depart_campus, days: b.days, lastSeen: last[b.id]?.ts ?? null, speed: last[b.id]?.speed ?? null })),
    crowdEnabled: (await getSetting('crowd_enabled', '1')) === '1',
    sharers: sharers.rows.map(x => ({ studentId: x.student_id, busId: x.bus_id, status: x.status, startedAt: x.started_at, verifiedAt: x.verified_at, lastTs: x.last_ts })),
    blocked: blocks.rows.map(x => ({ studentId: x.student_id, at: x.at })),
    notices: notices.rows.map(n => ({ id: n.id, message: n.message, level: n.level, createdAt: n.created_at, expiresAt: n.expires_at })),
  };
}

const actions = {
  async saveRoute({ route }) {
    const name = String(route?.name || '').trim().slice(0, 60);
    if (!name) throw new Error('Enter a route name.');
    const color = COLOR.test(route.color) ? route.color : '#0b6e1c';
    const stops = cleanStops(route.stops);
    const id = route.id || 'r' + Date.now().toString(36);
    const g = await buildGeometry(stops);
    await db().execute({ sql: `INSERT INTO routes (id,name,color,stops,geometry,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, stops=excluded.stops, geometry=excluded.geometry, updated_at=excluded.updated_at`,
      args: [id, name, color, JSON.stringify(stops), JSON.stringify(g.geometry), Date.now()] });
    // Sanity check, leg by leg: if two neighbouring stops are far apart by road but close in a straight line,
    // one of them is probably misplaced (off the road network) or the stops are out of order.
    const pts = [...stops, CAMPUS]; let warn = null;
    const dist = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102);
    // A stop that forces a big detour between its neighbours is probably misplaced.
    for (let i = 1; i < pts.length - 1 && !warn; i++) {
      const via = dist(pts[i - 1], pts[i]) + dist(pts[i], pts[i + 1]), straight = dist(pts[i - 1], pts[i + 1]);
      if (via - straight > 5 && via > straight * 2.5) warn = `"${pts[i].name}" is far out of the way between "${pts[i - 1].name}" and "${pts[i + 1].name}". It may be in the wrong place or order.`;
    }
    (g.legsKm || []).forEach((km, i) => {
      const a = pts[i], b = pts[i + 1], direct = Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 102);
      if (!warn && km > 3 && km > direct * 3) warn = `"${a.name}" to "${b.name}" is ${km.toFixed(1)} km by road but only ${direct.toFixed(1)} km apart. One of them may be in the wrong place or order.`;
    });
    return { id, snapped: g.snapped, km: g.km, warn };
  },
  async deleteRoute({ id }) {
    await db().execute({ sql: 'UPDATE buses SET route_id = NULL WHERE route_id = ?', args: [id] });
    await db().execute({ sql: 'DELETE FROM routes WHERE id = ?', args: [id] });
    return {};
  },
  // Create a bus, or rename it / change its route. `id` = current number (null when creating), `newId` = number to use.
  async saveBus({ id, newId, routeId, departStart, departCampus, days }) {
    newId = String(newId || '').trim();
    const ds = time(departStart, 'Leaves start'), dc = time(departCampus, 'Leaves campus');
    days = String(days || '').trim().slice(0, 30) || null;
    if (!BUS_ID.test(newId)) throw new Error('Bus number: 1-10 letters, digits or dashes.');
    if (routeId) {
      const r = await db().execute({ sql: 'SELECT id FROM routes WHERE id = ?', args: [routeId] });
      if (!r.rows[0]) throw new Error('Route not found.');
    }
    if (!id) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      const token = newToken();
      await db().execute({ sql: 'INSERT INTO buses (id, route_id, token_hash, depart_start, depart_campus, days) VALUES (?,?,?,?,?,?)', args: [newId, routeId || null, sha256(token), ds, dc, days] });
      return { token };
    }
    if (id !== newId) {
      const ex = await db().execute({ sql: 'SELECT id FROM buses WHERE id = ?', args: [newId] });
      if (ex.rows[0]) throw new Error(`Bus ${newId} already exists.`);
      await db().batch([
        { sql: 'UPDATE buses SET id = ?, route_id = ?, depart_start = ?, depart_campus = ?, days = ? WHERE id = ?', args: [newId, routeId || null, ds, dc, days, id] },
        { sql: 'UPDATE positions SET bus_id = ? WHERE bus_id = ?', args: [newId, id] },
      ], 'write');
    } else {
      await db().execute({ sql: 'UPDATE buses SET route_id = ?, depart_start = ?, depart_campus = ?, days = ? WHERE id = ?', args: [routeId || null, ds, dc, days, id] });
    }
    return {};
  },
  async deleteBus({ id }) {
    await db().batch([{ sql: 'DELETE FROM positions WHERE bus_id = ?', args: [id] }, { sql: 'DELETE FROM buses WHERE id = ?', args: [id] }], 'write');
    return {};
  },
  async addNotice({ message, level, expiresAt }) {
    message = String(message || '').trim();
    if (!message) throw new Error('Write the notice text.');
    if (message.length > 500) throw new Error('Notice is too long (max 500 characters).');
    level = level === 'urgent' ? 'urgent' : 'info';
    const exp = expiresAt ? Number(expiresAt) : null;
    if (exp !== null && (!Number.isFinite(exp) || exp <= Date.now())) throw new Error('Expiry must be in the future.');
    await db().execute({ sql: 'INSERT INTO notices (message, level, created_at, expires_at) VALUES (?,?,?,?)', args: [message, level, Date.now(), exp] });
    return {};
  },
  async deleteNotice({ id }) {
    await db().execute({ sql: 'DELETE FROM notices WHERE id = ?', args: [Number(id)] });
    return {};
  },
  async setCrowd({ enabled }) { await setSetting('crowd_enabled', enabled ? '1' : '0'); return {}; },
  async blockSharer({ studentId }) {
    studentId = String(studentId || '').trim(); if (!studentId) throw new Error('Student ID missing.');
    await db().batch([
      { sql: 'INSERT INTO share_blocks (student_id, at) VALUES (?,?) ON CONFLICT(student_id) DO NOTHING', args: [studentId, Date.now()] },
      { sql: 'DELETE FROM share_sessions WHERE student_id = ?', args: [studentId] },
      { sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [studentId] },
    ], 'write');
    return {};
  },
  async unblockSharer({ studentId }) { await db().execute({ sql: 'DELETE FROM share_blocks WHERE student_id = ?', args: [String(studentId)] }); return {}; },
  async newToken({ id }) {
    const token = newToken();
    const r = await db().execute({ sql: 'UPDATE buses SET token_hash = ? WHERE id = ?', args: [sha256(token), id] });
    if (!r.rowsAffected) throw new Error('Bus not found.');
    return { token };
  },
};

export default async function handler(req, res) {
  if (!adminFrom(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  await ensureSchema();
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json(await state());
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const fn = actions[req.body?.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action.' });
  try {
    const out = await fn(req.body);
    await bumpRev();
    res.status(200).json({ ok: true, ...out, state: await state() });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Request failed.' });
  }
}
