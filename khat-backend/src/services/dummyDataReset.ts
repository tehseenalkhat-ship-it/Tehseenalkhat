/**
 * ONE-TIME clean-ups before real use (Nov 2026). Each runs at server start only when its switch is
 * set on the hosting panel AND it has not run on this database before (recorded in khat_migrations).
 * Remove the switch after the restart.
 *
 * 1. RESET_DUMMY_DATA=yes — deletes every user and everything users did (uploads, marks, chats,
 *    showcase, badges given, certificates issued, notifications, logs, TR list, roster) and creates
 *    the four starting accounts (sign-in by ITS number). Keeps courses and site content.
 * 2. RESET_COURSES=yes — deletes every course with its levels, steps, step files and certificate
 *    designs, plus all course work (enrolments, submissions, task chats, marks, badges, certificates).
 *    Keeps accounts, books, asset library, gallery, events, competitions, badge designs, settings,
 *    TR list, roster, announcements and department chats.
 *
 * Both delete the files on disk that only the deleted records used. Every table must be in the
 * keep or wipe list: an unknown table, or a kept row left pointing at deleted data, stops the
 * clean-up before anything changes.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { deleteObject } from '../storage.js';

type Conn = mysql.Connection;
type Reset = {
  name: string;          // shown in the log
  envVar: string;        // the panel switch (value must be "yes")
  marker: string;        // recorded in khat_migrations once done
  keep: string[];
  wipe: string[];
  /** Runs inside the transaction after the wipe (e.g. create accounts, hand content over). */
  after?: (c: Conn, tables: string[]) => Promise<void>;
};

// ---------------------------------------------------------------- 1. dummy users and their work
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

const DUMMY_DATA_RESET: Reset = {
  name: 'Dummy-data clean-up', envVar: 'RESET_DUMMY_DATA', marker: RESET_MARKER, keep: KEEP_TABLES, wipe: WIPE_TABLES,
  after: async (c, tables) => {
    const [branchRows] = await c.query<mysql.RowDataPacket[]>(`SELECT id FROM branches ORDER BY name = 'Nairobi' DESC, name LIMIT 1`);
    const branchId = branchRows[0]?.id;
    if (!branchId) throw new Error('Clean-up stopped, nothing changed: no branch found.');
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
  },
};

// ---------------------------------------------------------------- 2. all courses and course work
export const COURSE_RESET_MARKER = 'reset-courses-2026-11';
export const COURSE_WIPE_TABLES = [
  // the courses themselves
  'courses', 'levels', 'level_steps', 'step_files', 'course_branches', 'certificate_templates',
  // work done on them
  'enrollments', 'entries', 'entry_logs', 'level_submissions', 'certificates', 'badges', 'student_badges',
  'step_progress', 'step_submissions', 'thread_messages', 'annotations', 'sheet_ids', 'attempt_grants',
  'course_chat_messages', 'course_chat_read_state', 'merit_ledger', 'student_nudges',
];
export const COURSE_KEEP_TABLES = [
  'activity_log', 'announcement_seen', 'announcements', 'approved_tr_numbers', 'assets', 'audit_log', 'badge_designs',
  'books', 'branches', 'competition_entries', 'competition_winners', 'competitions', 'course_types', 'dept_messages',
  'direct_chat_messages', 'email_queue', 'email_templates', 'error_log', 'event_attendance', 'file_codes', 'gallery_works',
  'group_messages', 'khat_migrations', 'khat_types', 'live_events', 'notifications', 'password_reset_tokens',
  'policy_settings', 'problem_reports', 'reviewer_spillover', 'showcase_likes', 'showcase_posts', 'site_settings',
  'step_types', 'student_group_members', 'student_groups', 'student_roster', 'survey_responses',
  'teacher_khat_assignments', 'user_markers', 'users',
];
const COURSE_RESET: Reset = {
  name: 'Course clean-up', envVar: 'RESET_COURSES', marker: COURSE_RESET_MARKER, keep: COURSE_KEEP_TABLES, wipe: COURSE_WIPE_TABLES,
};

// ---------------------------------------------------------------- engine

/** Storage keys look like "folder/uuid.ext" (also inside JSON text). */
const KEY_RE = /[a-z0-9-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[a-z0-9._-]*/gi;

async function textKeys(c: Conn, tables: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const table of tables) {
    const [cols] = await c.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?
         AND data_type IN ('char','varchar','text','mediumtext','longtext','json')`, [table]);
    for (const { c: col } of cols) {
      const [rows] = await c.query<mysql.RowDataPacket[]>(`SELECT \`${col}\` AS v FROM \`${table}\` WHERE \`${col}\` LIKE '%/%'`);
      // JSON columns (e.g. levels.media) come back as objects: search their text form.
      for (const { v } of rows) for (const m of (typeof v === 'string' ? v : JSON.stringify(v)).match(KEY_RE) ?? []) keys.add(m);
    }
  }
  return keys;
}

async function runOneTimeReset(reset: Reset, log: (msg: string) => void): Promise<'done' | 'skipped'> {
  if (process.env[reset.envVar] !== 'yes') return 'skipped';
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
    const [done] = await c.query<mysql.RowDataPacket[]>(`SELECT 1 AS x FROM khat_migrations WHERE name = ?`, [reset.marker]);
    if (done.length) { log(`${reset.name} already done on this database — skipped. Remove ${reset.envVar} from the panel.`); return 'skipped'; }

    const [tableRows] = await c.query<mysql.RowDataPacket[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`);
    const tables = tableRows.map(r => String(r.t));
    const unknown = tables.filter(t => !reset.keep.includes(t) && !reset.wipe.includes(t));
    if (unknown.length) throw new Error(`${reset.name} stopped, nothing changed: tables not sorted into keep/wipe: ${unknown.join(', ')}`);
    const wipe = reset.wipe.filter(t => tables.includes(t));
    const keep = reset.keep.filter(t => tables.includes(t));

    // Files used only by records that are about to go.
    const kept = await textKeys(c, keep);
    filesToDelete = [...await textKeys(c, wipe)].filter(k => !kept.has(k));

    await c.query('SET FOREIGN_KEY_CHECKS = 0');
    await c.beginTransaction();
    try {
      for (const t of wipe) await c.query(`DELETE FROM \`${t}\``);
      await reset.after?.(c, tables);
      // Safety net: no row may still point at deleted data.
      const [fks] = await c.query<mysql.RowDataPacket[]>(
        `SELECT table_name AS t, column_name AS c, referenced_table_name AS rt, referenced_column_name AS rc
         FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`);
      for (const { t, c: col, rt, rc } of fks) {
        const [orphans] = await c.query<mysql.RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM \`${t}\` x LEFT JOIN \`${rt}\` p ON p.\`${rc}\` = x.\`${col}\` WHERE x.\`${col}\` IS NOT NULL AND p.\`${rc}\` IS NULL`);
        if (Number(orphans[0].n) > 0) throw new Error(`${reset.name} stopped, nothing changed: ${t}.${col} still points at deleted ${rt}.`);
      }
      await c.query(`INSERT INTO khat_migrations (name) VALUES (?)`, [reset.marker]);
      await c.commit();
    } catch (err) {
      await c.rollback();
      throw err;
    } finally {
      await c.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    log(`${reset.name} done: ${wipe.length} tables cleared.`);
  } finally {
    await c.query(`SELECT RELEASE_LOCK('khat_migrations')`).catch(() => undefined);
    await c.end();
  }
  let removed = 0;
  for (const key of filesToDelete) { try { await deleteObject(key); removed++; } catch { /* already gone */ } }
  log(`${reset.name}: ${removed} uploaded files removed.`);
  return 'done';
}

/** Runs whichever one-time clean-ups are switched on, in order. */
export async function runDummyDataReset(log: (msg: string) => void = console.log): Promise<void> {
  await runOneTimeReset(DUMMY_DATA_RESET, log);
  await runOneTimeReset(COURSE_RESET, log);
}
