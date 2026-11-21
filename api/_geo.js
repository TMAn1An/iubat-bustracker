// Route geometry helpers (server side): project a GPS point onto a route polyline.
const rad = Math.PI / 180;

/** Prepare a route ([[lng,lat],...]) for fast projection: local metres + cumulative distance. */
export function prepRoute(geometry) {
  const [lng0, lat0] = geometry[0];
  const kx = 111320 * Math.cos(lat0 * rad), ky = 110574;
  const xy = geometry.map(([lng, lat]) => [(lng - lng0) * kx, (lat - lat0) * ky]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  return { xy, cum, length: cum[cum.length - 1], toXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky] };
}

/** Nearest point on the route: { s: metres along the route, dist: metres off the route } */
export function project(route, lat, lng) {
  const [px, py] = route.toXY(lng, lat);
  let best = { dist: Infinity, s: 0 };
  for (let i = 1; i < route.xy.length; i++) {
    const [ax, ay] = route.xy[i - 1], [bx, by] = route.xy[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best.dist) best = { dist: d, s: route.cum[i - 1] + t * Math.sqrt(l2) };
  }
  return best;
}

export function metres(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
