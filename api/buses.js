import { db, anyFrom, getRev, ensureSchema } from './_lib.js';

// The student app polls this every ~4 s. Server time is returned too (so a wrong client clock does not matter).
export default async function handler(req, res) {
  if (!anyFrom(req)) return res.status(401).json({ error: 'Please sign in.' });
  await ensureSchema();
  const [r, rev] = await Promise.all([db().execute('SELECT bus_id AS id, lat, lng, speed, heading, ts, source FROM positions'), getRev()]);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ now: Date.now(), rev, buses: r.rows.map(x => ({ ...x })) });
}
