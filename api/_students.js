// Student authentication provider.
// Today: students live in our own `students` table (a dummy account for now).
// Later: replace the body of verifyStudent() to check the university's database / API instead.
// Nothing else in the app needs to change; /api/login only uses this function.
import { db, checkPassword, dummyHash } from './_lib.js';

/** @returns {Promise<{id: string, name: string} | null>} the student if ID + password are valid, else null */
export async function verifyStudent(id, password) {
  const r = await db().execute({ sql: 'SELECT id, name, pass FROM students WHERE id = ?', args: [String(id).trim()] });
  const u = r.rows[0];
  const ok = checkPassword(String(password), u ? u.pass : dummyHash()); // same work whether or not the ID exists
  return u && ok ? { id: u.id, name: u.name } : null;
}
