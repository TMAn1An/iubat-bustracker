// Login throttling, stored in the DB so it works across serverless instances.
// Per account: 5 wrong passwords -> locked for 5 min; each further failure while still failing doubles the wait (max 60 min).
// Per IP: 20 wrong passwords (any accounts) -> same lock, so one client cannot try many IDs.
import { db } from './_lib.js';

export const MAX_FAILS = 5;
const IP_MAX_FAILS = 20, BASE_LOCK_MS = 5 * 60e3, MAX_LOCK_MS = 60 * 60e3, FORGET_MS = 24 * 3600e3;

export const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();

async function get(key) {
  const r = await db().execute({ sql: 'SELECT fails, locked_until, last FROM login_attempts WHERE key = ?', args: [key] });
  const row = r.rows[0];
  if (!row || Date.now() - row.last > FORGET_MS) return { fails: 0, locked_until: 0 };
  return { fails: Number(row.fails), locked_until: Number(row.locked_until) };
}

/** Returns { blocked: true, retryAfter } if either key is locked right now. */
export async function checkLock(keys) {
  const now = Date.now();
  let until = 0;
  for (const k of keys) until = Math.max(until, (await get(k)).locked_until);
  return until > now ? { blocked: true, retryAfter: Math.ceil((until - now) / 1000) } : { blocked: false };
}

/** Record a failed attempt. Returns { attemptsLeft, retryAfter? } for the account key. */
export async function recordFail(accountKey, ipKey) {
  const now = Date.now();
  const out = {};
  for (const [key, max] of [[accountKey, MAX_FAILS], [ipKey, IP_MAX_FAILS]]) {
    const cur = await get(key), fails = cur.fails + 1;
    let lockedUntil = 0;
    if (fails >= max) lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - max));
    await db().execute({ sql: `INSERT INTO login_attempts (key, fails, locked_until, last) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until, last=excluded.last`, args: [key, fails, lockedUntil, now] });
    if (key === accountKey) out.attemptsLeft = Math.max(0, max - fails);
    if (lockedUntil) out.retryAfter = Math.max(out.retryAfter || 0, Math.ceil((lockedUntil - now) / 1000));
  }
  return out;
}

export async function clearFails(accountKey) {
  await db().execute({ sql: 'DELETE FROM login_attempts WHERE key = ?', args: [accountKey] });
}

export const waitText = s => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`);
