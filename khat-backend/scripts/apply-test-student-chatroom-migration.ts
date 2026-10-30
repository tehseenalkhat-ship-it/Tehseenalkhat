import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

async function main() {
  if (process.env.DB_NAME !== 'khat_test') {
    throw new Error('Student chatroom migration runner is restricted to DB_NAME=khat_test. Apply the SQL migration separately to other environments after review.');
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
    const sql = await readFile(new URL('./migrations/2026-10-19-student-chatroom.sql', import.meta.url), 'utf8');
    await connection.query(sql);

    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SHOW TABLES LIKE 'direct_chat_messages';
       SHOW COLUMNS FROM course_chat_messages LIKE 'student_read_at';
       SHOW COLUMNS FROM course_chat_read_state;`,
    );

    console.log('Student chatroom migration applied to khat_test.');
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Could not apply the student chatroom migration.');
  process.exitCode = 1;
});
