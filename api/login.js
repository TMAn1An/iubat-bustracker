import { signSession, ensureSchema } from './_lib.js';
import { verifyStudent } from './_students.js';
import { checkLock, recordFail, clearFails, ipOf, waitText } from './_ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id, password } = req.body || {};
  if (!id || !password || String(id).length > 40) return res.status(400).json({ error: 'Enter your student ID and password.' });
  await ensureSchema();
  const acct = 'student:' + String(id).trim().toLowerCase(), ip = 'ip:' + ipOf(req);
  const lock = await checkLock([acct, ip]);
  if (lock.blocked) {
    res.setHeader('Retry-After', String(lock.retryAfter));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitText(lock.retryAfter)}.`, retryAfter: lock.retryAfter });
  }
  const u = await verifyStudent(id, password);
  if (!u) {
    const f = await recordFail(acct, ip);
    if (f.retryAfter) {
      res.setHeader('Retry-After', String(f.retryAfter));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${waitText(f.retryAfter)}.`, retryAfter: f.retryAfter });
    }
    return res.status(401).json({ error: `Incorrect student ID or password. ${f.attemptsLeft} attempt${f.attemptsLeft === 1 ? '' : 's'} left.`, attemptsLeft: f.attemptsLeft });
  }
  await clearFails(acct);
  res.status(200).json({ token: signSession('s:' + u.id), id: u.id, name: u.name });
}
