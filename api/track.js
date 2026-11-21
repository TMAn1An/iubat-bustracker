import { saveFix } from './_lib.js';

// The tracker page on the bus phone POSTs here: { token, lat, lng, speed (m/s), heading, acc, ts }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const r = await saveFix(req.body || {});
  res.status(r.status).json(r.error ? { error: r.error } : { ok: true });
}
