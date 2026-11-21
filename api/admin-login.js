import { db, checkPassword, signSession, dummyHash, ensureSchema } from './_lib.js';
import { checkLock, recordFail, clearFails, ipOf, waitText } from './_ratelimit.js';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter username and password.' });
  await ensureSchema();
  const acct = 'admin:' + String(username).trim().toLowerCase(), ip = 'ip:' + ipOf(req);
  const lock = await checkLock([acct, ip]);
  if (lock.blocked) {
    res.setHeader('Retry-After', String(lock.retryAfter));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitText(lock.retryAfter)}.`, retryAfter: lock.retryAfter });
  }
  const r = await db().execute({ sql: 'SELECT username, pass FROM admins WHERE username = ?', args: [String(username).trim()] });
  const u = r.rows[0];
  const ok = checkPassword(String(password), u ? u.pass : dummyHash());
  if (!u || !ok) {
    const f = await recordFail(acct, ip);
    if (f.retryAfter) {
      res.setHeader('Retry-After', String(f.retryAfter));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitText(f.retryAfter)}.`, retryAfter: f.retryAfter });
    }
    return res.status(401).json({ error: `Incorrect username or password. ${f.attemptsLeft} attempt${f.attemptsLeft === 1 ? '' : 's'} left.` });
  }
  await clearFails(acct);
  res.status(200).json({ token: signSession('a:' + u.username, 8), username: u.username });
}
