/**
 * Check for src/services/migrations.ts. Run against a COPY of the database (DATABASE_URL / DB_* in .env):
 *   npm run test:migrations
 * Runs the startup database update twice: the second run must apply nothing, every file must be
 * recorded, and the v3 tables must exist.
 */
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { MIGRATION_FILES, runStartupMigrations } from '../src/services/migrations.js';

const first = await runStartupMigrations();
console.log(`first run applied: ${first.applied.length ? first.applied.join(', ') : 'nothing (already up to date)'}`);
const second = await runStartupMigrations();
assert.deepEqual(second.applied, [], 'second run must apply nothing');

const db = config.database;
const c = await mysql.createConnection({ host: db.host, port: db.port, database: db.name, user: db.user, password: db.password });
const [rec] = await c.query<mysql.RowDataPacket[]>('SELECT name FROM khat_migrations');
assert.deepEqual(new Set(rec.map(r => r.name)), new Set(MIGRATION_FILES), 'every update file is recorded');
for (const table of ['step_submissions', 'dept_messages', 'email_queue', 'badge_designs', 'sheet_ids']) {
  const [rows] = await c.query<mysql.RowDataPacket[]>('SHOW TABLES LIKE ?', [table]);
  assert.equal(rows.length, 1, `table ${table} exists`);
}
await c.end();
console.log('OK: startup database update works and is safe to repeat.');
