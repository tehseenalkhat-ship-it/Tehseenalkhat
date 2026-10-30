import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

async function main() {
  if (process.env.DB_NAME !== 'khat_test') {
    throw new Error('Mashq migration runner is restricted to DB_NAME=khat_test. Review and apply the SQL migration separately to other environments.');
  }
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in khat-backend/.env.`);
    return value;
  };
  const sslCa = process.env.DB_SSL_CA?.trim();
  const connection = await mysql.createConnection({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    database: 'khat_test',
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(sslCa ? { ssl: { ca: await readFile(sslCa), rejectUnauthorized: true } } : {}),
    multipleStatements: true,
    connectTimeout: 15_000,
    timezone: 'Z',
  });
  try {
    const sql = await readFile(new URL('./migrations/2026-10-18-mashq-review-chat.sql', import.meta.url), 'utf8');
    await connection.query(sql);
    const indexes: Array<[string, string, string]> = [
      ['entries', 'idx_entries_mashq_thread', '(student_id, mashq_category_key, created_at)'],
      ['course_chat_messages', 'idx_course_chat_thread_key', '(student_id, course_id, thread_key, created_at)'],
    ];
    for (const [table, index, columns] of indexes) {
      const [indexRows] = await connection.query<mysql.RowDataPacket[]>(
        `SELECT index_name FROM information_schema.statistics
         WHERE table_schema = 'khat_test' AND table_name = ? AND index_name = ? LIMIT 1`,
        [table, index],
      );
      if (indexRows.length === 0) await connection.query(`CREATE INDEX \`${index}\` ON \`${table}\` ${columns}`);
    }
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT mashq_category_key, COUNT(*) AS level_count
       FROM levels
       WHERE mashq_category_key IS NOT NULL
       GROUP BY mashq_category_key ORDER BY mashq_category_key`,
    );
    console.log('Mashq review/chat migration applied to khat_test.');
    for (const row of rows) console.log(`${row.mashq_category_key}: ${row.level_count} linked worksheet levels`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not apply the Mashq review/chat migration.');
  process.exitCode = 1;
});
