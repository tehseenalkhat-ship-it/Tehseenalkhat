import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

async function main() {
  if (process.env.DB_NAME !== 'khat_test') {
    throw new Error('Dashboard migration runner is restricted to DB_NAME=khat_test. Apply the SQL migration separately to other environments after review.');
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
    const sql = await readFile(new URL('./migrations/2026-10-17-student-dashboard-catalog.sql', import.meta.url), 'utf8');
    await connection.query(sql);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT kt.code, c.category, c.title, COUNT(l.id) AS level_count
       FROM courses c
       JOIN khat_types kt ON kt.id = c.khat_type_id
       LEFT JOIN levels l ON l.course_id = c.id
       GROUP BY c.id, kt.code, c.category, c.title
       ORDER BY c.category, kt.code`,
    );
    console.log('Student dashboard catalog migration applied to khat_test.');
    for (const row of rows) console.log(`${row.category.padEnd(14)} ${row.code.padEnd(28)} ${String(row.level_count).padStart(2)} levels · ${row.title}`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not apply the student dashboard migration.');
  process.exitCode = 1;
});
