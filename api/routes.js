import { db, anyFrom, getRev, CAMPUS, ensureSchema, activeNotices, getSetting } from './_lib.js';

// Routes, bus->route assignment, schedules and notices for the student app. Reloaded only when `rev` changes.
export default async function handler(req, res) {
  if (!anyFrom(req)) return res.status(401).json({ error: 'Please sign in.' });
  await ensureSchema();
  const [routes, buses, rev, notices, crowd] = await Promise.all([
    db().execute('SELECT id, name, color, stops, geometry FROM routes ORDER BY name'),
    db().execute('SELECT id, route_id, depart_start, depart_campus, days FROM buses ORDER BY CAST(id AS INTEGER), id'),
    getRev(), activeNotices(), getSetting('crowd_enabled', '1'),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    campus: CAMPUS, rev,
    routes: routes.rows.map(r => ({ id: r.id, name: r.name, color: r.color, stops: JSON.parse(r.stops), geometry: JSON.parse(r.geometry) })),
    buses: buses.rows.map(b => ({ id: b.id, routeId: b.route_id, departStart: b.depart_start, departCampus: b.depart_campus, days: b.days })),
    notices, now: Date.now(), crowdEnabled: crowd === '1',
  });
}
