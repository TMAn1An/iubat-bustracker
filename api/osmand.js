import { saveFix } from './_lib.js';

// Traccar Client অ্যাপের জন্য (OsmAnd প্রোটোকল): /api/osmand?id=<টোকেন>&lat=&lon=&speed=<নট>&bearing=&timestamp=
export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const knots = Number(q.speed);
  const r = await saveFix({
    token: q.id, lat: q.lat, lng: q.lon, heading: q.bearing, acc: q.accuracy,
    speed: Number.isFinite(knots) ? knots * 0.514444 : null,
    ts: q.timestamp ? Number(q.timestamp) * (Number(q.timestamp) < 1e12 ? 1000 : 1) : undefined,
  });
  res.status(r.status).send(r.error || 'OK');
}
