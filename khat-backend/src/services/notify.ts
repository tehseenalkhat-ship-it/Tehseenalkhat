import { pool } from '../db.js';

export async function notify(userId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  await pool.query(`INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)`, [
    userId,
    type,
    JSON.stringify(payload),
  ]);
}

export async function notifyAllAdmins(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`);
  for (const admin of rows) {
    await notify(admin.id, type, payload);
  }
}

export async function notifyAllStudents(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'student' AND deleted_at IS NULL`);
  for (const student of rows) await notify(student.id, type, payload);
}

export async function notifyAllTeachers(type: string, payload: Record<string, unknown> = {}, excludeUserId?: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'teacher' AND deleted_at IS NULL AND ($1::uuid IS NULL OR id <> $1)`,
    [excludeUserId ?? null]
  );
  for (const teacher of rows) await notify(teacher.id, type, payload);
}

export async function notifyBranchStudents(branchId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'student' AND branch_id = $1 AND deleted_at IS NULL`,
    [branchId]
  );
  for (const student of rows) await notify(student.id, type, payload);
}
