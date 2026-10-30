import { pool } from '../db.js';

// Phone + ITS columns on users. Added on startup if missing; existing data is never changed.
export async function ensureUserDetailColumns(): Promise<void> {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(32) NULL`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS its_number VARCHAR(8) NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_its_number_key ON users (its_number)`);
}

export const JAMEA_EMAIL = /^[^\s@]+@jameasaifiyah\.edu$/;
const PHONE = /^\+\d{1,4} \d{5,15}$/; // "+254 712345678": country code, space, number
const ITS = /^\d{8}$/;

export type DetailChanges = { name?: string; email?: string; phone?: string | null; itsNumber?: string | null; trNumber?: string };

type Db = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Validates and saves profile details for one user. Returns an error message (and HTTP status)
 * instead of throwing, so both the self-service and admin routes answer the same way.
 * TR changes are only passed in by the admin route.
 */
export async function updateUserDetails(db: Db, userId: string, input: DetailChanges): Promise<{ error: string; status: number } | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  const { rows: [user] } = await db.query(`SELECT id, role, branch_id, tr_number FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!user) return { error: 'Account not found', status: 404 };

  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name || name.length > 120) return { error: 'Please enter a name (up to 120 characters).', status: 400 };
    set('name', name);
  }

  if (input.email !== undefined) {
    const email = String(input.email).trim().toLowerCase();
    if (!JAMEA_EMAIL.test(email)) return { error: 'The email must end in @jameasaifiyah.edu.', status: 400 };
    const { rows } = await db.query(`SELECT id FROM users WHERE email = $1 AND id <> $2`, [email, userId]);
    if (rows.length) return { error: 'Another account already uses that email.', status: 409 };
    set('email', email);
  }

  if (input.phone !== undefined) {
    const phone = String(input.phone ?? '').trim();
    if (phone && !PHONE.test(phone)) return { error: 'Choose a country and enter a phone number (digits only).', status: 400 };
    set('phone', phone || null);
  }

  if (input.itsNumber !== undefined) {
    const its = input.itsNumber ? String(input.itsNumber).trim() : '';
    if (its && !ITS.test(its)) return { error: 'The ITS number must be exactly 8 digits.', status: 400 };
    if (its) {
      const { rows } = await db.query(`SELECT id FROM users WHERE its_number = $1 AND id <> $2`, [its, userId]);
      if (rows.length) return { error: 'Another account already uses that ITS number.', status: 409 };
    }
    set('its_number', its || null);
  }

  if (input.trNumber !== undefined) {
    if (user.role !== 'student') return { error: 'Only students have a TR number.', status: 400 };
    const tr = String(input.trNumber).trim().toUpperCase();
    if (tr !== user.tr_number) {
      const { rows: [approved] } = await db.query(`SELECT tr_number, branch_id, used, student_id FROM approved_tr_numbers WHERE upper(trim(tr_number)) = $1`, [tr]);
      if (!approved) return { error: 'That TR number is not on the approved list.', status: 400 };
      if (approved.used && approved.student_id !== userId) return { error: 'That TR number is already used by another student.', status: 409 };
      if (approved.branch_id && approved.branch_id !== user.branch_id) return { error: 'That TR number belongs to a different branch.', status: 400 };
      if (user.tr_number) await db.query(`UPDATE approved_tr_numbers SET used = false, student_id = NULL WHERE tr_number = $1`, [user.tr_number]);
      await db.query(`UPDATE approved_tr_numbers SET used = true, student_id = $1 WHERE tr_number = $2`, [userId, approved.tr_number]);
      set('tr_number', approved.tr_number);
    }
  }

  if (!sets.length) return null;
  params.push(userId);
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  return null;
}

/** The fields the Settings page and the admin edit form show. */
export async function readUserDetails(userId: string) {
  const { rows: [u] } = await pool.query(
    `SELECT id, role, name, email, phone, its_number, tr_number, branch_id, is_coordinator, photo_storage_key
     FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  if (!u) return null;
  return {
    id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, itsNumber: u.its_number,
    trNumber: u.tr_number, branchId: u.branch_id, isCoordinator: Boolean(u.is_coordinator), photoStorageKey: u.photo_storage_key,
  };
}
