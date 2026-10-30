import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

async function main() {
  if (process.env.DB_NAME !== 'khat_test') {
    throw new Error('Style migration runner is restricted to DB_NAME=khat_test. Review and apply the SQL migration separately to other environments.');
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
    const sql = await readFile(new URL('./migrations/2026-10-30-add-cut-pen-style-variants.sql', import.meta.url), 'utf8');
    await connection.query(sql);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT kt.code, c.title, COUNT(l.id) AS level_count
       FROM courses c
       JOIN khat_types kt ON kt.id = c.khat_type_id
       LEFT JOIN levels l ON l.course_id = c.id
       WHERE c.category = 'certification'
         AND c.title LIKE '%Style %'
         AND kt.code IN ('naskh', 'istinsaakh')
       AND c.course_style IN ('style-1', 'style-2')
       GROUP BY kt.code, c.id, c.title
       ORDER BY kt.code, c.title`,
    );
    console.log('Cut-pen course style migration applied to khat_test.');
    for (const row of rows) console.log(`${row.code}: ${row.title} (${row.level_count} levels)`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not apply the cut-pen course style migration.');
  process.exitCode = 1;
});
