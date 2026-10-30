import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in khat-backend/.env before importing.`);
  return value;
}

async function main() {
  const host = required('DB_HOST');
  const port = Number(process.env.DB_PORT ?? 4000);
  const database = required('DB_NAME');
  const user = required('DB_USER');
  const password = required('DB_PASSWORD');
  const caPath = required('DB_SSL_CA');

  if (database !== 'khat_test') {
    throw new Error('Import blocked: this script only permits DB_NAME=khat_test.');
  }
  if (process.env.ALLOW_DUMP_DATA_IMPORT !== 'YES') {
    throw new Error('Import blocked: review the dump first, then set ALLOW_DUMP_DATA_IMPORT=YES to confirm importing its existing rows.');
  }

  const dumpPath = resolve(process.cwd(), '../khat-frontend/khat_neon_full.mysql.sql');
  const sql = await readFile(dumpPath, 'utf8');
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    ssl: { ca: await readFile(caPath), rejectUnauthorized: true },
    multipleStatements: true,
    connectTimeout: 15_000,
  });

  try {
    const [tableRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [database],
    );
    if (Number(tableRows[0]?.table_count) > 0) {
      throw new Error(`Import blocked: ${database} is not empty. Create a separate empty test database.`);
    }

    console.log(`Importing ${dumpPath} into the empty ${database} database...`);
    await connection.query(sql);

    const [columns] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'entries'`,
      [database],
    );
    const existingColumns = new Set(columns.map(row => String(row.column_name)));
    const additions: Array<[string, string]> = [
      ['entry_kind', 'VARCHAR(40) NULL'],
      ['time_spent_minutes', 'INT NULL'],
      ['mark_out_of_ten', 'SMALLINT NULL'],
      ['mark_passed', 'TINYINT(1) NULL'],
    ];
    for (const [name, definition] of additions) {
      if (!existingColumns.has(name)) {
        await connection.query(`ALTER TABLE entries ADD COLUMN \`${name}\` ${definition}`);
      }
    }

    const [courseColumns] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'courses'`,
      [database],
    );
    if (!courseColumns.some(row => String(row.column_name) === 'guidance_question')) {
      await connection.query('ALTER TABLE courses ADD COLUMN guidance_question LONGTEXT NULL');
    }

    await connection.query(
      `UPDATE entries e
       JOIN levels l ON l.id = e.level_id
       JOIN courses c ON c.id = l.course_id
       SET e.entry_kind = CASE
         WHEN c.category = 'secondary' THEN 'secondary_marking'
         WHEN l.level_type = 'test' THEN 'checkpoint_assessment'
         ELSE 'practice_marking'
       END
       WHERE e.source_type = 'checkpoint' AND e.entry_kind IS NULL`,
    );

    const indexes: Array<[string, string, string]> = [
      ['entries', 'idx_entries_student_level_created', '(student_id, level_id, created_at DESC)'],
      ['entries', 'idx_entries_course_review_queue', '(assigned_teacher_id, status, entry_kind, created_at)'],
      ['level_submissions', 'idx_level_submissions_student_level_date', '(student_id, level_id, submitted_at DESC)'],
    ];
    for (const [table, index, columnsSql] of indexes) {
      const [indexRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1`,
        [database, table, index],
      );
      if (indexRows.length === 0) {
        await connection.query(`CREATE INDEX \`${index}\` ON \`${table}\` ${columnsSql}`);
      }
    }

    console.log('Import and entry-review schema update completed.');
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Test database import failed.');
  process.exitCode = 1;
});
