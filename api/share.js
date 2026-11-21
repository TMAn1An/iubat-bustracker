// Crowd mode: a signed-in student on the bus shares their phone location for that bus.
// Every fix is checked on the server before it can move the bus on everyone's map:
//   1. GPS accuracy must be usable                              (MAX_ACC)
//   2. the phone must be on this bus's route (the road)           (ON_ROUTE)
//   3. it must travel along the route like a vehicle, not sit at home:
//      at least MIN_PROGRESS metres along the route over at least MIN_WINDOW, at vehicle speed (MIN_KMH)
//   4. no impossible jumps between fixes                          (MAX_KMH)
//   5. sitting still for STALL_MS (e.g. got off the bus) pauses the share
//   6. with several sharers, the one verified first wins; a newcomer far from it is ignored (AGREE_M)
//   7. the official bus phone always has priority while it is live (DEVICE_FRESH_MS)
// Students' identities are never shown to other students; admins can see and block sharers.
import { db, studentFrom, num, ensureSchema, getSetting } from './_lib.js';
import { prepRoute, project, metres } from './_geo.js';

const MAX_ACC = 60, ON_ROUTE = 80, MIN_PROGRESS = 400, MIN_WINDOW = 90e3, // ~9 fixes at one every 10 s
      MIN_KMH = 8, MAX_KMH = 120;
const WINDOW = 4 * 60e3, STALL_MS = 6 * 60e3, STALL_M = 60, AGREE_M = 500, PEER_FRESH = 20e3, DEVICE_FRESH_MS = 45e3;
const MIN_GAP = 2500, END_M = 150;

const MSG = {
  checking: 'Checking: keep sharing while the bus moves along the route.',
  verified: 'Verified: your location is helping others see this bus.',
  backup: 'Verified. The bus phone is live, so yours is on standby as a backup.',
  disagree: 'Another verified rider is already sharing this bus; your location does not match theirs, so it is not used.',
  paused: 'Paused: you have not moved for a while. Sharing resumes when the bus moves.',
  off_route: 'You are not on this bus route, so your location cannot be used.',
  weak_gps: 'GPS signal is too weak right now. Move near a window.',
  jump: 'Your location jumped impossibly far, so it was ignored.',
  arrived: 'The bus reached the end of the route. Sharing stopped. Thank you!',
};

let routeCache = { rev: null, map: new Map() };
async function routeFor(busId) {
  const r = await db().execute({ sql: `SELECT b.id AS bus, r.id, r.geometry FROM buses b JOIN routes r ON r.id = b.route_id WHERE b.id = ?`, args: [busId] });
  const row = r.rows[0]; if (!row) return null;
  let cached = routeCache.map.get(row.id);
  if (!cached || cached.raw !== row.geometry) { cached = { raw: row.geometry, ...prepRoute(JSON.parse(row.geometry)) }; routeCache.map.set(row.id, cached); }
  return cached;
}

async function stop(sid) {
  await db().batch([{ sql: 'DELETE FROM share_sessions WHERE student_id = ?', args: [sid] }, { sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [sid] }], 'write');
}

export default async function handler(req, res) {
  const me = studentFrom(req);
  if (!me) return res.status(401).json({ error: 'Please sign in.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  await ensureSchema();
  const sid = me.sub.slice(2), body = req.body || {};
  const reply = (status, extra = {}) => res.status(200).json({ status, message: MSG[status], ...extra });

  if (body.action === 'stop') { await stop(sid); return res.status(200).json({ status: 'stopped' }); }

  if ((await getSetting('crowd_enabled', '1')) !== '1') return res.status(403).json({ error: 'Location sharing by students is turned off by the admin.' });
  if ((await db().execute({ sql: 'SELECT 1 FROM share_blocks WHERE student_id = ?', args: [sid] })).rows[0])
    return res.status(403).json({ error: 'Location sharing is not available for your account. Contact the transport office.' });

  const busId = String(body.busId || ''), lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180), acc = num(body.acc, 0, 100000);
  if (!busId || lat === null || lng === null) return res.status(400).json({ error: 'Bad request' });
  const route = await routeFor(busId);
  if (!route) return res.status(404).json({ error: 'This bus has no route yet.' });

  const now = Date.now();
  let ses = (await db().execute({ sql: 'SELECT * FROM share_sessions WHERE student_id = ?', args: [sid] })).rows[0];
  if (ses && ses.bus_id !== busId) { await stop(sid); ses = null; }          // switched bus: start over
  if (ses && now - ses.last_ts < MIN_GAP) return reply(ses.status);         // too frequent: ignore quietly
  if (!ses) {
    await db().execute({ sql: 'INSERT INTO share_sessions (student_id, bus_id, status, started_at, last_ts) VALUES (?,?,?,?,?)', args: [sid, busId, 'checking', now, now] });
    ses = { student_id: sid, bus_id: busId, status: 'checking', started_at: now, verified_at: null, last_ts: now, jumps: 0 };
  }
  const save = async (status, extra = {}) => {
    const f = { verified_at: ses.verified_at, jumps: ses.jumps, ...extra };
    await db().execute({ sql: `UPDATE share_sessions SET status=?, last_ts=?, last_lat=?, last_lng=?, last_s=?, verified_at=?, jumps=? WHERE student_id=?`,
      args: [status, now, lat, lng, f.last_s ?? ses.last_s ?? null, f.verified_at ?? null, f.jumps, sid] });
  };

  // 1. accuracy
  if (acc === null || acc > MAX_ACC) { await save('weak_gps'); return reply('weak_gps'); }
  // 4. impossible jump since the previous fix
  if (ses.last_lat != null) {
    const dt = Math.max(1, (now - ses.last_ts) / 1000), d = metres(ses.last_lat, ses.last_lng, lat, lng);
    if (d > 150 && (d / dt) * 3.6 > MAX_KMH) { await save('jump', { jumps: ses.jumps + 1, verified_at: null }); return reply('jump'); }
  }
  // 2. on the route?
  const p = project(route, lat, lng);
  if (p.dist > ON_ROUTE + Math.min(acc, 40)) {
    await db().execute({ sql: 'DELETE FROM share_fixes WHERE student_id = ?', args: [sid] });
    await save('off_route', { verified_at: null }); return reply('off_route');
  }
  await db().batch([
    { sql: 'INSERT INTO share_fixes (student_id, ts, s, off, lat, lng) VALUES (?,?,?,?,?,?)', args: [sid, now, p.s, p.dist, lat, lng] },
    { sql: 'DELETE FROM share_fixes WHERE student_id = ? AND ts < ?', args: [sid, now - WINDOW - 60e3] },
  ], 'write');
  const fixes = (await db().execute({ sql: 'SELECT ts, s FROM share_fixes WHERE student_id = ? AND ts >= ? ORDER BY ts', args: [sid, now - WINDOW] })).rows;

  // 3. moving along the route like a vehicle?
  const first = fixes[0], last = fixes[fixes.length - 1], span = last.ts - first.ts;
  const progress = last.s - first.s, kmh = span > 0 ? (Math.abs(progress) / (span / 1000)) * 3.6 : 0;
  const dir = progress >= 0 ? 1 : -1;
  // backtracking more than 150 m against the travel direction looks like noise or a fake
  let maxBack = 0, peak = first.s;
  for (const f of fixes) { if (dir > 0) { peak = Math.max(peak, f.s); maxBack = Math.max(maxBack, peak - f.s); } else { peak = Math.min(peak, f.s); maxBack = Math.max(maxBack, f.s - peak); } }
  const moving = span >= MIN_WINDOW && Math.abs(progress) >= MIN_PROGRESS && kmh >= MIN_KMH && kmh <= MAX_KMH && maxBack <= 150;

  let verifiedAt = ses.verified_at;
  if (!verifiedAt && moving) verifiedAt = now;
  if (!verifiedAt) { await save('checking', { last_s: p.s }); return reply('checking', { progress: Math.round(Math.abs(progress)) }); }

  // 5. stalled for a long time (e.g. got off the bus)?
  const recent = fixes.filter(f => f.ts >= now - STALL_MS);
  if (span >= STALL_MS - 30e3 && recent.length > 1 && Math.abs(recent[recent.length - 1].s - recent[0].s) < STALL_M) {
    await save('paused', { last_s: p.s, verified_at: verifiedAt }); return reply('paused');
  }
  // arrived at the end of the route in the travel direction
  if ((dir > 0 && p.s >= route.length - END_M) || (dir < 0 && p.s <= END_M)) { await stop(sid); return reply('arrived'); }

  // 7. the official bus phone has priority
  const pos = (await db().execute({ sql: 'SELECT ts, source, lat, lng FROM positions WHERE bus_id = ?', args: [busId] })).rows[0];
  if (pos && pos.source === 'device' && now - pos.ts < DEVICE_FRESH_MS) { await save('backup', { last_s: p.s, verified_at: verifiedAt }); return reply('backup'); }

  // 6. other verified sharers on the same bus: the one verified first wins
  const peers = (await db().execute({ sql: `SELECT student_id, verified_at, last_lat, last_lng FROM share_sessions
      WHERE bus_id = ? AND student_id <> ? AND verified_at IS NOT NULL AND status = 'verified' AND last_ts > ?`, args: [busId, sid, now - PEER_FRESH] })).rows;
  const senior = peers.filter(x => x.verified_at < verifiedAt);
  if (senior.some(x => metres(x.last_lat, x.last_lng, lat, lng) > AGREE_M)) { await save('disagree', { last_s: p.s, verified_at: verifiedAt }); return reply('disagree'); }

  const speed = num(body.speed, 0, 60), heading = num(body.heading, 0, 360);
  await db().execute({ sql: `INSERT INTO positions (bus_id, lat, lng, speed, heading, acc, ts, source) VALUES (?,?,?,?,?,?,?,'crowd')
      ON CONFLICT(bus_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, speed=excluded.speed, heading=excluded.heading, acc=excluded.acc, ts=excluded.ts, source='crowd'`,
    args: [busId, lat, lng, speed ?? (kmh / 3.6), heading, acc, now] });
  await save('verified', { last_s: p.s, verified_at: verifiedAt });
  return reply('verified');
}
