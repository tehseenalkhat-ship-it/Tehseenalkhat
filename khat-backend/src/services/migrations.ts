/**
 * Applies the v2 / v3 database updates when the server starts, so going live needs no
 * database access from outside the hosting panel. Each file is applied once and recorded in
 * khat_migrations; statements that are already in place ("duplicate column", "already exists")
 * are skipped, exactly like `npm run migrate:v2` / `migrate:v3`.
 * The .sql files are copied next to dist/server.cjs by `npm run bundle` (dist/migrations).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { splitSql } from '../../scripts/apply-v2-migration.js';

export const MIGRATION_FILES = [
  '2026-11-10-course-builder-v2.sql',
  '2026-11-14-v3-shared.sql',
  '2026-11-14-v3-builder.sql',
  '2026-11-14-v3-teacher.sql',
  '2026-11-14-v3-chat.sql',
  '2026-11-14-v3-admin-comms.sql',
  '2026-11-14-v3-content.sql',
  '2026-11-14-v3-student-task.sql',
  '2026-11-15-v3-fixer-b.sql',
];

const SKIPPABLE = [1060, 1061, 1050, 1091, 1068];
const SKIP_TEXT = /duplicate (column|key)|already exist|can't drop|check that column\/key exists/i;

function migrationsDir(): string | null {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    typeof __dirname !== 'undefined' ? path.join(__dirname, 'migrations') : undefined, // dist/migrations (bundled)
    path.join(process.cwd(), 'migrations'),
    path.join(process.cwd(), 'scripts', 'migrations'), // dev (tsx from khat-backend)
  ];
  return candidates.find(dir => dir && existsSync(path.join(dir, MIGRATION_FILES[0]))) ?? null;
}

export async function runStartupMigrations(log: (msg: string) => void = console.log): Promise<{ applied: string[] }> {
  const dir = migrationsDir();
  if (!dir) throw new Error('Database update files (migrations folder) not found next to the server.');
  const db = config.database;
  const connection = await mysql.createConnection({
    host: db.host, port: db.port, database: db.name, user: db.user, password: db.password,
    ...(db.sslCa ? { ssl: { ca: await readFile(db.sslCa), rejectUnauthorized: true } } : {}),
    connectTimeout: 15_000, timezone: 'Z',
  });
  const applied: string[] = [];
  try {
    // Several app processes may start together: only one runs the updates.
    const [lock] = await connection.query<mysql.RowDataPacket[]>(`SELECT GET_LOCK('khat_migrations', 300) AS ok`);
    if (!lock[0]?.ok) throw new Error('Could not get the database update lock.');
    await connection.query(`CREATE TABLE IF NOT EXISTS khat_migrations (name VARCHAR(191) NOT NULL PRIMARY KEY, applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6))`);
    const [doneRows] = await connection.query<mysql.RowDataPacket[]>(`SELECT name FROM khat_migrations`);
    const done = new Set(doneRows.map(r => String(r.name)));
    for (const file of MIGRATION_FILES) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      let ok = 0, skipped = 0;
      for (const statement of splitSql(sql)) {
        try {
          await connection.query(statement);
          ok++;
        } catch (error) {
          const e = error as { errno?: number; message?: string };
          if ((e.errno && SKIPPABLE.includes(e.errno)) || SKIP_TEXT.test(e.message ?? '')) { skipped++; continue; }
          throw new Error(`Database update ${file} stopped: ${e.message} — in: ${statement.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
      await connection.query(`INSERT INTO khat_migrations (name) VALUES (?)`, [file]);
      applied.push(file);
      log(`Database update ${file}: ${ok} applied, ${skipped} already in place.`);
    }
  } finally {
    await connection.query(`SELECT RELEASE_LOCK('khat_migrations')`).catch(() => undefined);
    await connection.end();
  }
  return { applied };
}
