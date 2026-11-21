// Local demo data:      node db/seed.js
// Production:           TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node db/seed.js --no-demo   (no demo admin; dummy student is still created)
// Import students:      node db/seed.js --students students.csv      (columns: id,name,password)
// Create/reset admin:   node db/seed.js --admin <username> <password>
// Remove dummy student: node db/seed.js --remove-dummy
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db, hashPassword, sha256, buildGeometry, bumpRev, ensureSchema } from '../api/_lib.js';

const c = db();
await ensureSchema();
const args = process.argv.slice(2);
const after = f => args[args.indexOf(f) + 1];

if (args.includes('--students')) {
  const rows = readFileSync(after('--students'), 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(l => l.split(','));
  for (const [id, name, pw] of rows) {
    await c.execute({ sql: 'INSERT INTO students (id,name,pass) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, pass=excluded.pass', args: [id.trim(), (name || '').trim(), hashPassword(pw.trim())] });
  }
  console.log(`${rows.length} students imported`); process.exit(0);
}
if (args.includes('--remove-dummy')) {
  const r = await c.execute({ sql: `DELETE FROM students WHERE name = 'Dummy Student'` });
  console.log(`Removed ${r.rowsAffected} dummy student account(s)`); process.exit(0);
}
if (args.includes('--admin')) {
  const [u, p] = [after('--admin'), args[args.indexOf('--admin') + 2]];
  if (!u || !p || p.length < 8) { console.error('Usage: --admin <username> <password (8+ chars)>'); process.exit(1); }
  await c.execute({ sql: 'INSERT INTO admins (username,pass) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET pass=excluded.pass', args: [u, hashPassword(p)] });
  console.log('Admin saved:', u); process.exit(0);
}

// ---- starter data: the Rajendrapur route / Bus 11 (stops are added later from the admin dashboard) ----
const hasRoute = (await c.execute(`SELECT id FROM routes WHERE id='rajendrapur'`)).rows[0];
if (!hasRoute) {
  const stops = [{ name: 'Rajendrapur Chowrastha', lat: 24.09537, lng: 90.40187 }];
  const g = await buildGeometry(stops);
  await c.execute({ sql: 'INSERT INTO routes (id,name,color,stops,geometry,updated_at) VALUES (?,?,?,?,?,?)', args: ['rajendrapur', 'Rajendrapur', '#0b6e1c', JSON.stringify(stops), JSON.stringify(g.geometry), Date.now()] });
  console.log(`Route "Rajendrapur" created (${g.snapped ? 'road-snapped' : 'straight-line fallback'})`);
}
if (!(await c.execute(`SELECT id FROM buses WHERE id='11'`)).rows[0]) {
  const t = randomBytes(18).toString('base64url');
  // schedule from the printed "Stoppage Wise Bus Reporting Schedule": leaves 6:30 AM, leaves campus 5:40 PM (Sat–Wed)
  await c.execute({ sql: 'INSERT INTO buses (id, route_id, token_hash, depart_start, depart_campus, days) VALUES (?,?,?,?,?,?)', args: ['11', 'rajendrapur', sha256(t), '06:30', '17:40', 'Sat–Wed'] });
  writeFileSync(new URL('../.bus-tokens.json', import.meta.url), JSON.stringify({ 11: t }, null, 1));
  console.log('Bus 11 created. Tracker token saved to .bus-tokens.json (git-ignored)');
}
// ONE dummy student account, only so the prototype can be viewed. Remove it with --remove-dummy.
// Override with DUMMY_STUDENT_ID / DUMMY_STUDENT_PASSWORD.
const dId = process.env.DUMMY_STUDENT_ID || '2025001', dPw = process.env.DUMMY_STUDENT_PASSWORD || 'demo1234';
await c.execute({ sql: `DELETE FROM students WHERE name = 'Dummy Student' AND id <> ?`, args: [dId] }); // keep only one
await c.execute({ sql: 'INSERT INTO students (id,name,pass) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET pass=excluded.pass', args: [dId, 'Dummy Student', hashPassword(dPw)] });
console.log(`Dummy student -> ${dId} / ${process.env.DUMMY_STUDENT_PASSWORD ? '(from env)' : dPw}`);
if (!args.includes('--no-demo')) {
  await c.execute({ sql: 'INSERT INTO admins (username,pass) VALUES (?,?) ON CONFLICT(username) DO NOTHING', args: ['admin', hashPassword('admin1234')] });
  console.log('Demo admin -> admin / admin1234 (local only; use --no-demo and --admin in production)');
}
await bumpRev();
