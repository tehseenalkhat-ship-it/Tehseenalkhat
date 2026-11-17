/**
 * Applies scripts/migrations/2026-11-10-course-builder-v2.sql statement by statement.
 * Re-runnable: "duplicate column / key / already exists / can't drop missing index" errors are skipped.
 *   npm run migrate:v2                    (uses DB_* from khat-backend/.env)
 *   npm run migrate:v2 -- other-file.sql  (another file in scripts/migrations)
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const SKIPPABLE = [
  1060, // ER_DUP_FIELDNAME     Duplicate column name
  1061, // ER_DUP_KEYNAME       Duplicate key name
  1050, // ER_TABLE_EXISTS_ERROR
  1091, // ER_CANT_DROP_FIELD_OR_KEY  (index already dropped)
  1068, // Multiple primary key defined
];
const SKIP_TEXT = /duplicate (column|key)|already exist|can't drop|check that column\/key exists/i;

/** Splits SQL into statements, ignoring ';' inside quotes and -- comments. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!quote && ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += sql[++i] ?? ''; continue; }
      if (ch === quote) { if (sql[i + 1] === quote) { cur += sql[++i]; continue; } quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function main() {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Set ${name} in khat-backend/.env.`);
    return value;
  };
  const file = process.argv[2] ?? '2026-11-10-course-builder-v2.sql';
  const sql = await readFile(new URL(`./migrations/${file.replace(/^.*[\\/]/, '')}`, import.meta.url), 'utf8');
  const sslCa = process.env.DB_SSL_CA?.trim();
  const connection = await mysql.createConnection({
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(sslCa ? { ssl: { ca: await readFile(sslCa), rejectUnauthorized: true } } : {}),
    connectTimeout: 15_000,
    timezone: 'Z',
  });
  let applied = 0;
  let skipped = 0;
  try {
    console.log(`Applying ${file} to database ${process.env.DB_NAME} …`);
    for (const statement of splitSql(sql)) {
      const first = statement.replace(/\s+/g, ' ').slice(0, 90);
      try {
        await connection.query(statement);
        applied++;
        console.log(`  ok    ${first}`);
      } catch (error) {
        const e = error as { errno?: number; message?: string };
        if ((e.errno && SKIPPABLE.includes(e.errno)) || SKIP_TEXT.test(e.message ?? '')) {
          skipped++;
          console.log(`  skip  ${first}  (${e.message})`);
          continue;
        }
        console.error(`  FAIL  ${first}\n        ${e.message}`);
        throw error;
      }
    }
    console.log(`Done: ${applied} applied, ${skipped} already in place.`);
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && /apply-v2-migration/.test(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Could not apply the v2 migration.');
    process.exitCode = 1;
  });
}
