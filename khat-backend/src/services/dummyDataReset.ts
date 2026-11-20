/**
 * ONE-TIME clean-up of the test ("dummy") data before real use (Nov 2026).
 *
 * Runs at server start only when the hosting panel has RESET_DUMMY_DATA=yes AND it has not run on
 * this database before (recorded in khat_migrations). Remove the setting after the restart.
 *
 * Deletes every user and everything users did (uploads, marks, chats, showcase, badges given,
 * certificates issued, notifications, logs, the TR number list and the student roster) plus the
 * files on disk that only those records used. Keeps the course material and site content
 * (courses, levels, steps, step files, books, asset library, gallery, live events, competitions,
 * designs, branches, script types, policies, settings, email templates).
 * Then creates the four starting accounts (sign-in by ITS number).
 *
 * Every table must be in KEEP or WIPE: an unknown table stops the clean-up before anything changes.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { deleteObject } from '../storage.js';

export const RESET_MARKER = 'reset-dummy-data-2026-11';

export const KEEP_TABLES = [
  'assets', 'badge_designs', 'books', 'branches', 'certificate_templates', 'competitions', 'course_branches',
  'course_types', 'courses', 'email_templates', 'file_codes', 'gallery_works', 'khat_migrations', 'khat_types',
  'level_steps', 'levels', 'live_events', 'policy_settings', 'site_settings', 'step_files', 'step_types',
];
export const WIPE_TABLES = [
  'activity_log', 'announcement_seen', 'announcements', 'annotations', 'approved_tr_numbers', 'attempt_grants',
  'audit_log', 'badges', 'certificates', 'competition_entries', 'competition_winners', 'course_chat_messages',
  'course_chat_read_state', 'dept_messages', 'direct_chat_messages', 'email_queue', 'enrollments', 'entries',
  'entry_logs', 'error_log', 'event_attendance', 'group_messages', 'level_submissions', 'merit_ledger',
  'notifications', 'password_reset_tokens', 'problem_reports', 'reviewer_spillover', 'sheet_ids', 'showcase_likes',
  'showcase_posts', 'step_progress', 'step_submissions', 'student_badges', 'student_group_members', 'student_groups',
  'student_nudges', 'student_roster', 'survey_responses', 'teacher_khat_assignments', 'thread_messages',
  'user_markers', 'users',
];

/** Kept content that names a person: handed to the new admin (or the new teacher). */
const REASSIGN: [table: string, column: string, to: 'admin' | 'teacher'][] = [
  ['assets', 'uploaded_by', 'admin'], ['books', 'uploaded_by', 'admin'], ['certificate_templates', 'created_by', 'admin'],
  ['competitions', 'created_by', 'admin'], ['competitions', 'judge_teacher_id', 'teacher'], ['courses', 'created_by', 'admin'],
  ['live_events', 'host_teacher_id', 'teacher'], ['badge_designs', 'updated_by', 'admin'], ['email_templates', 'updated_by', 'admin'],
  ['gallery_works', 'uploaded_by', 'admin'], ['policy_settings', 'updated_by', 'admin'], ['step_files', 'uploaded_by', 'admin'],
];

// Passwords chosen by the owner; only their bcrypt hashes are stored here.
const ACCOUNTS = [
  { key: 'admin', role: 'admin', coordinator: false, name: 'Admin', its: '10000001', hash: '$2a$10$dQWV7MC9nw.y699SrjXIkeXVDDSbBEsx7rU5.pzAtR4prk0h1EYdy' },
  { key: 'teacher', role: 'teacher', coordinator: false, name: 'Teacher', its: '10000002', hash: '$2a$10$Bnvdgl1Vjf3SFBFI7Kk31eVOJdKOQVN7LcioVBWOFdpYW6qy6EoIi' },
  { key: 'coordinator', role: 'teacher', coordinator: true, name: 'Coordinator', its: '10000003', hash: '$2a$10$NOYIHoo0opbf3ERFGhttOeic6MVlHSuE0AOsqFqhjqYfwGqZlDAoK' },
  { key: 'student', role: 'student', coordinator: false, name: 'Student', its: '10000004', hash: '$2a$10$MwjmFtLpgzGSbZfriGMMCeu1Vp0dADZYVbLGT6nJHe/D9c1SiZUoq' },
] as const;

/** Storage keys look like "folder/uuid.ext" (also inside JSON text). */
const KEY_RE = /[a-z0-9-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[a-z0-9._-]*/gi;

type Conn = mysql.Connection;

async function textKeys(c: Conn, tables: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const table of tables) {
    const [cols] = await c.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?
         AND data_type IN ('char','varchar','text','mediumtext','longtext','json')`, [table]);
    for (const { c: col } of cols) {
      const [rows] = await c.query<mysql.RowDataPacket[]>(`SELECT \`${col}\` AS v FROM \`${table}\` WHERE \`${col}\` LIKE '%/%'`);
      for (const { v } of rows) for (const m of String(v).match(KEY_RE) ?? []) keys.add(m);
    }
  }
  return keys;
}

export async function runDummyDataReset(log: (msg: string) => void = console.log): Promise<'done' | 'skipped'> {
  if (process.env.RESET_DUMMY_DATA !== 'yes') return 'skipped';
  const db = config.database;
  const c = await mysql.createConnection({
    host: db.host, port: db.port, database: db.name, user: db.user, password: db.password,
    ...(db.sslCa ? { ssl: { ca: await readFile(db.sslCa), rejectUnauthorized: true } } : {}),
    connectTimeout: 15_000, timezone: 'Z',
  });
  let filesToDelete: string[] = [];
  try {
    const [lock] = await c.query<mysql.RowDataPacket[]>(`SELECT GET_LOCK('khat_migrations', 300) AS ok`);
    if (!lock[0]?.ok) throw new Error('Could not get the database lock.');
    const [done] = await c.query<mysql.RowDataPacket[]>(`SELECT 1 AS x FROM khat_migrations WHERE name = ?`, [RESET_MARKER]);
    if (done.length) { log('Dummy-data clean-up already done on this database — skipped. Remove RESET_DUMMY_DATA from the panel.'); return 'skipped'; }

    const [tableRows] = await c.query<mysql.RowDataPacket[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`);
    const tables = tableRows.map(r => String(r.t));
    const unknown = tables.filter(t => !KEEP_TABLES.includes(t) && !WIPE_TABLES.includes(t));
    if (unknown.length) throw new Error(`Clean-up stopped, nothing changed: tables not sorted into keep/wipe: ${unknown.join(', ')}`);
    const wipe = WIPE_TABLES.filter(t => tables.includes(t));
    const keep = KEEP_TABLES.filter(t => tables.includes(t));

    // Files used only by records that are about to go.
    const kept = await textKeys(c, keep);
    filesToDelete = [...await textKeys(c, wipe)].filter(k => !kept.has(k));

    const [branchRows] = await c.query<mysql.RowDataPacket[]>(`SELECT id FROM branches ORDER BY name = 'Nairobi' DESC, name LIMIT 1`);
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error('Clean-up stopped, nothing changed: no branch found.');

    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    await c.beginTransaction();
    try {
      for (const t of wipe) await c.query(`DELETE FROM \`${t}\``);
      const ids: Record<string, string> = {};
      for (const a of ACCOUNTS) {
        ids[a.key] = randomUUID();
        await c.query(
          `INSERT INTO users (id, role, is_coordinator, name, email, password_hash, must_change_password, branch_id, its_number)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [ids[a.key], a.role, a.coordinator ? 1 : 0, a.name, `${a.its}@jameasaifiyah.edu`, a.hash, branchId, a.its],
        );
      }
      // Teacher and coordinator review every script.
      for (const who of ['teacher', 'coordinator']) {
        await c.query(`INSERT INTO teacher_khat_assignments (teacher_id, khat_type_id, assigned_by) SELECT ?, id, ? FROM khat_types`, [ids[who], ids.admin]);
      }
      for (const [table, column, to] of REASSIGN) {
        if (!tables.includes(table)) continue;
        const [has] = await c.query<mysql.RowDataPacket[]>(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
        if (has.length) await c.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` IS NOT NULL`, [ids[to]]);
      }
      // Safety net: no kept row may still point at a deleted user.
      const [fks] = await c.query<mysql.RowDataPacket[]>(
        `SELECT table_name AS t, column_name AS c FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND referenced_table_name = 'users'`);
      for (const { t, c: col } of fks) {
        const [orphans] = await c.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM \`${t}\` x LEFT JOIN users u ON u.id = x.\`${col}\` WHERE x.\`${col}\` IS NOT NULL AND u.id IS NULL`);
        if (Number(orphans[0].n) > 0) throw new Error(`Clean-up stopped, nothing changed: ${t}.${col} still points at deleted users.`);
      }
      await c.query(`INSERT INTO khat_migrations (name) VALUES (?)`, [RESET_MARKER]);
      await c.commit();
    } catch (err) {
      await c.rollback();
      throw err;
    } finally {
      await c.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    log(`Dummy-data clean-up done: ${wipe.length} tables cleared, 4 starting accounts created.`);
  } finally {
    await c.query(`SELECT RELEASE_LOCK('khat_migrations')`).catch(() => undefined);
    await c.end();
  }
  let removed = 0;
  for (const key of filesToDelete) { try { await deleteObject(key); removed++; } catch { /* already gone */ } }
  log(`Dummy-data clean-up: ${removed} uploaded files removed.`);
  return 'done';
}
