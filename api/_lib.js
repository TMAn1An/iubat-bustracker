// Shared helpers: DB, tokens, password hashing. (A leading underscore keeps Vercel from exposing this as an endpoint.)
import { createClient } from '@libsql/client';
import { createHmac, randomBytes, scryptSync, pbkdf2Sync, timingSafeEqual, createHash } from 'node:crypto';

let _db;
export function db() {
  if (!_db) _db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return _db;
}

export const CAMPUS = { name: 'IUBAT Campus', lat: 23.8882231, lng: 90.3906409 };

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, name TEXT, pass TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admins (username TEXT PRIMARY KEY, pass TEXT NOT NULL)`,
  // stops: JSON [{name,lat,lng}] (far end -> campus; campus is appended automatically), geometry: JSON [[lng,lat],...]
  `CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
     stops TEXT NOT NULL, geometry TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS buses (id TEXT PRIMARY KEY, route_id TEXT, token_hash TEXT NOT NULL)`,
  // one row per bus: always the latest position
  `CREATE TABLE IF NOT EXISTS positions (bus_id TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL,
     speed REAL, heading REAL, acc REAL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, last INTEGER NOT NULL)`,
  // Crowd mode: students on the bus share their phone location. One session per student, plus a short window of recent fixes.
  `CREATE TABLE IF NOT EXISTS share_sessions (student_id TEXT PRIMARY KEY, bus_id TEXT NOT NULL, status TEXT NOT NULL,
     started_at INTEGER NOT NULL, verified_at INTEGER, last_ts INTEGER NOT NULL, last_lat REAL, last_lng REAL, last_s REAL, jumps INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS share_fixes (student_id TEXT NOT NULL, ts INTEGER NOT NULL, s REAL NOT NULL, off REAL NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS share_fixes_student ON share_fixes (student_id, ts)`,
  `CREATE TABLE IF NOT EXISTS share_blocks (student_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info',
     created_at INTEGER NOT NULL, expires_at INTEGER)`,
];
// Columns added after the first release (applied to existing databases; "duplicate column" errors are ignored).
const MIGRATIONS = [
  `ALTER TABLE buses ADD COLUMN depart_start TEXT`,   // e.g. "06:30" — leaves the first stop
  `ALTER TABLE buses ADD COLUMN depart_campus TEXT`,  // e.g. "17:40" — leaves campus
  `ALTER TABLE buses ADD COLUMN days TEXT`,           // e.g. "Sat–Wed"
  `ALTER TABLE positions ADD COLUMN source TEXT`,     // 'device' (bus phone) or 'crowd' (verified student on board)
];

// Bump SCHEMA_V whenever SCHEMA or MIGRATIONS change.
const SCHEMA_V = '4';
// Create any missing tables once per serverless instance (cheap: CREATE TABLE IF NOT EXISTS).
let _schema;
export function ensureSchema() {
  return (_schema ||= (async () => {
    // Fast path: one query when the database is already up to date.
    try { const r = await db().execute(`SELECT value FROM settings WHERE key = 'schema_v'`); if (r.rows[0]?.value === SCHEMA_V) return; } catch { /* settings table missing: first run */ }
    await db().batch(SCHEMA, 'write');
    for (const m of MIGRATIONS) { try { await db().execute(m); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
    await db().execute({ sql: `INSERT INTO settings (key,value) VALUES ('schema_v',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [SCHEMA_V] });
  })().catch(e => { _schema = null; throw e; }));
}

/** Active notices, newest first. */
export async function activeNotices() {
  const r = await db().execute({ sql: 'SELECT id, message, level, created_at, expires_at FROM notices WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC LIMIT 20', args: [Date.now()] });
  return r.rows.map(n => ({ id: n.id, message: n.message, level: n.level, createdAt: n.created_at, expiresAt: n.expires_at }));
}

/** Bump the config revision so clients reload routes/buses. */
export async function bumpRev() {
  await db().execute({ sql: `INSERT INTO settings (key,value) VALUES ('rev',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [String(Date.now())] });
}
export async function getSetting(key, fallback = null) {
  const r = await db().execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  return r.rows[0] ? r.rows[0].value : fallback;
}
export async function setSetting(key, value) {
  await db().execute({ sql: `INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [key, String(value)] });
}
export async function getRev() {
  const r = await db().execute(`SELECT value FROM settings WHERE key='rev'`);
  return r.rows[0]?.value || '0';
}

/** Snap the route to roads via OSRM (stops + campus). Falls back to straight lines if OSRM is unreachable. */
export async function buildGeometry(stops) {
  const pts = [...stops, CAMPUS];
  const straight = pts.map(p => [p.lng, p.lat]);
  try {
    const url = 'https://router.project-osrm.org/route/v1/driving/' + pts.map(p => `${p.lng},${p.lat}`).join(';') + '?overview=full&geometries=geojson';
    const r = await fetch(url, { headers: { 'User-Agent': 'iubat-bus-tracker/0.3' }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const g = j.routes?.[0];
    if (g) return { geometry: g.geometry.coordinates.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]), km: g.distance / 1000, snapped: true, legsKm: (g.legs || []).map(l => l.distance / 1000) };
  } catch { /* fall through */ }
  return { geometry: straight, km: null, snapped: false };
}

/* ---------- passwords ---------- */
// New hashes: PBKDF2-SHA256. The iteration count is limited by Cloudflare's free plan (about 10 ms CPU per request);
// online guessing is stopped by the login rate limit. Older scrypt hashes ("salt:hash") are still accepted.
const PBKDF2_ITER = 30000;
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `pbkdf2$${PBKDF2_ITER}$${salt.toString('hex')}$${pbkdf2Sync(String(pw), salt, PBKDF2_ITER, 32, 'sha256').toString('hex')}`;
}
export function checkPassword(pw, stored) {
  stored = String(stored || '');
  let a, b;
  if (stored.startsWith('pbkdf2$')) {
    const [, it, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    a = pbkdf2Sync(String(pw), Buffer.from(salt, 'hex'), Number(it), 32, 'sha256'); b = Buffer.from(hash, 'hex');
  } else {
    const [s, h] = stored.split(':');
    if (!s || !h) return false;
    a = scryptSync(String(pw), Buffer.from(s, 'hex'), 32); b = Buffer.from(h, 'hex');
  }
  return a.length === b.length && timingSafeEqual(a, b);
}
// Hash used when an account does not exist, so a wrong ID takes as long as a wrong password.
// Created on first use: Cloudflare Workers do not allow random numbers at module load time.
let _dummy;
export const dummyHash = () => (_dummy ||= hashPassword('dummy-password-for-timing'));
export const sha256 = v => createHash('sha256').update(String(v)).digest('hex');

/* ---------- session tokens (stateless, HMAC) ---------- */
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s && (process.env.VERCEL || process.env.PRODUCTION)) throw new Error('SESSION_SECRET is not set');
  return s || 'dev-only-secret';
};
const b64 = b => Buffer.from(b).toString('base64url');
export function signSession(sub, hours = 12) {
  const body = b64(JSON.stringify({ sub, exp: Date.now() + hours * 3600e3 }));
  return body + '.' + createHmac('sha256', secret()).update(body).digest('base64url');
}
export function verifySession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export const studentFrom = req => { const p = verifySession(bearer(req)); return p && p.sub.startsWith('s:') ? p : null; };
export const adminFrom = req => { const p = verifySession(bearer(req)); return p && p.sub.startsWith('a:') ? p : null; };
export const anyFrom = req => verifySession(bearer(req));
export const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/* ---------- input ---------- */
export const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

/** Verifies a bus token and stores its latest position. */
export async function saveFix({ token, lat, lng, speed, heading, acc, ts }) {
  await ensureSchema();
  lat = num(lat, -90, 90); lng = num(lng, -180, 180);
  if (lat === null || lng === null || !token) return { status: 400, error: 'Bad request' };
  const r = await db().execute({ sql: 'SELECT id FROM buses WHERE token_hash = ?', args: [sha256(token)] });
  if (!r.rows[0]) return { status: 401, error: 'Invalid token' };
  const now = Date.now();
  let t = Number(ts); if (!Number.isFinite(t) || Math.abs(t - now) > 5 * 60e3) t = now; // use server time if the phone clock is wrong
  await db().execute({
    sql: `INSERT INTO positions (bus_id, lat, lng, speed, heading, acc, ts, source) VALUES (?,?,?,?,?,?,?,'device')
          ON CONFLICT(bus_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, speed=excluded.speed,
          heading=excluded.heading, acc=excluded.acc, ts=excluded.ts, source='device' WHERE excluded.ts >= positions.ts`,
    args: [r.rows[0].id, lat, lng, num(speed, 0, 80), num(heading, 0, 360), num(acc, 0, 5000), t],
  });
  return { status: 200, bus: r.rows[0].id };
}
