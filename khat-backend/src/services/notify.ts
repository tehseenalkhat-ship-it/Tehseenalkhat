import { pool } from '../db.js';

/**
 * In-app notifications — ONE central allow-list (owner's rule, v3 note 1.11 / E 1.3 / 5.6):
 * the bell and pop-ups are only for marks, teacher comments/replies, replies from the
 * Funun al-Quran Department, a new course, and announcements. Everything else
 * (nudges, "new work", merit reminders, theme changes, course edits, events …) is
 * dropped here so nobody is disturbed — those reach people by email or on their pages.
 * Callers keep calling notify() as before; a type that is not allowed is a silent no-op.
 */
export const IN_APP_ALLOWED_TYPES: readonly string[] = [
  'work_marked',      // v2 mark given
  'work_reviewed',    // v2 feedback (istinsakh) given
  'teacher_replied',  // teacher comment / reply in a step chat
  'dept_reply',       // reply from the Funun al-Quran Department chat
  'new_course',       // a course was published for the student's branch
  'announcement',     // announcement / survey (also shown as the site banner)
  // legacy (pre-v2) equivalents of the same events
  'entry_marked',
  'test_result',
  'course_created',
  'competition_results', // student's competition result (selected / award)
];

const ALLOWED = new Set(IN_APP_ALLOWED_TYPES);

export function isAllowedInApp(type: string): boolean {
  return ALLOWED.has(type);
}

/** SQL fragment + params for reading only allowed notifications (used by the bell). */
export function allowedTypesSql(startIndex = 1): { sql: string; params: string[] } {
  const params = [...IN_APP_ALLOWED_TYPES];
  return { sql: `type IN (${params.map((_, i) => `$${startIndex + i}`).join(', ')})`, params };
}

export async function notify(userId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!isAllowedInApp(type)) return;
  await pool.query(`INSERT INTO notifications (user_id, type, payload) VALUES ($1, $2, $3)`, [
    userId,
    type,
    JSON.stringify(payload),
  ]);
}

export async function notifyAllAdmins(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!isAllowedInApp(type)) return;
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`);
  for (const admin of rows) {
    await notify(admin.id, type, payload);
  }
}

export async function notifyAllStudents(type: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!isAllowedInApp(type)) return;
  const { rows } = await pool.query(`SELECT id FROM users WHERE role = 'student' AND deleted_at IS NULL`);
  for (const student of rows) await notify(student.id, type, payload);
}

export async function notifyAllTeachers(type: string, payload: Record<string, unknown> = {}, excludeUserId?: string): Promise<void> {
  if (!isAllowedInApp(type)) return;
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'teacher' AND deleted_at IS NULL AND ($1::uuid IS NULL OR id <> $1)`,
    [excludeUserId ?? null]
  );
  for (const teacher of rows) await notify(teacher.id, type, payload);
}

export async function notifyBranchStudents(branchId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!isAllowedInApp(type)) return;
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'student' AND branch_id = $1 AND deleted_at IS NULL`,
    [branchId]
  );
  for (const student of rows) await notify(student.id, type, payload);
}
