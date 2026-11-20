// Runnable check for editing account details + the staff first-password rule.
//   1. start the server with STAFF_DEFAULT_PASSWORD set:   npm run dev
//   2. in another terminal:                                npm run test:account
// Uses the same .env as the server. Creates a throwaway staff account and two throwaway students
// (removed again at the end). Refuses to run against anything but localhost unless ALLOW_REMOTE_TEST=1.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pool } from '../src/db.js';

const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const DEFAULT = process.env.STAFF_DEFAULT_PASSWORD;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE_TEST !== '1') {
  throw new Error(`Refusing to run against ${BASE}; this test writes data. Set ALLOW_REMOTE_TEST=1 to override.`);
}
if (!DEFAULT) throw new Error('Set STAFF_DEFAULT_PASSWORD in .env (the server must use the same value).');

let passed = 0;
let staffId: string | null = null;
let student: any = null;
let otherStudent: any = null;
const testTrs: string[] = [];

function ok(name: string, condition: unknown) {
  assert.ok(condition, name);
  passed++;
  console.log(`  ok  ${name}`);
}

function jwtFor(user: { id: string; role: string; branch_id: string; is_coordinator: boolean }): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ id: user.id, role: user.role, branchId: user.branch_id, isCoordinator: Boolean(user.is_coordinator), iat: Math.floor(Date.now() / 1000) });
  return `${head}.${body}.${createHmac('sha256', process.env.JWT_SECRET!).update(`${head}.${body}`).digest('base64url')}`;
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function main() {
  const { rows: [admin] } = await pool.query(`SELECT id, role, branch_id, is_coordinator FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1`);
  assert.ok(admin, 'need an admin');
  const stamp = Date.now();
  const digits = (n: number) => String(90000000 + ((stamp + n) % 9999999)); // throwaway 8-digit ITS numbers
  // Two throwaway students with approved TR numbers (+ one spare approved TR).
  for (const n of [1, 2, 3]) {
    const tr = `TEST${stamp}${n}`;
    testTrs.push(tr);
    await pool.query(`INSERT INTO approved_tr_numbers (tr_number, branch_id, used) VALUES ($1, $2, false)`, [tr, admin.branch_id]);
  }
  for (const n of [1, 2]) {
    await pool.query(
      `INSERT INTO users (role, name, email, password_hash, branch_id, tr_number, its_number) VALUES ('student', $1, $2, 'x', $3, $4, $5)`,
      [`Test Student ${n}`, `test.student.${stamp}.${n}@jameasaifiyah.edu`, admin.branch_id, testTrs[n - 1], digits(n)]);
    await pool.query(`UPDATE approved_tr_numbers SET used = true, student_id = (SELECT id FROM users WHERE tr_number = $1) WHERE tr_number = $1`, [testTrs[n - 1]]);
  }
  const { rows: students } = await pool.query(`SELECT id, role, branch_id, is_coordinator, tr_number, its_number, phone, name FROM users WHERE tr_number IN ($1, $2) ORDER BY tr_number`, [testTrs[0], testTrs[1]]);
  [student, otherStudent] = students;
  const adminToken = jwtFor(admin);
  const email = `test.staff.${stamp}@jameasaifiyah.edu`;
  let its = digits(10);

  console.log('New staff: first password + forced change');
  ok('admin cannot add staff without an ITS number', (await call('POST', '/admin/users', { role: 'teacher', name: 'Test Staff', email, branchId: admin.branch_id }, adminToken)).status === 400);
  const created = await call('POST', '/admin/users', { role: 'teacher', name: 'Test Staff', email, itsNumber: its, branchId: admin.branch_id }, adminToken);
  staffId = created.json.id;
  ok('admin creates staff with the default first password', created.status === 201 && created.json.tempPassword === DEFAULT);
  const login = await call('POST', '/auth/login', { its, password: DEFAULT });
  ok('staff can sign in with the first password and is told to change it', login.status === 200 && login.json.user.mustChangePassword === true);
  const firstToken = login.json.token;
  ok('nothing else opens before the change (403)', (await call('GET', '/auth/me', undefined, firstToken)).json.code === 'MUST_CHANGE_PASSWORD'
    && (await call('GET', '/notifications', undefined, firstToken)).status === 403);
  ok('a new password under 8 characters is refused', (await call('POST', '/auth/change-password', { currentPassword: DEFAULT, newPassword: 'short' }, firstToken)).status === 400);
  const changed = await call('POST', '/auth/change-password', { currentPassword: DEFAULT, newPassword: 'MyOwnPass#2026' }, firstToken);
  ok('changing the password returns a working token', changed.status === 200 && (await call('GET', '/auth/me', undefined, changed.json.token)).status === 200);
  ok('the first password no longer works', (await call('POST', '/auth/login', { its, password: DEFAULT })).status === 401);
  ok('sign-in with an email is refused (ITS only)', (await call('POST', '/auth/login', { its: email, password: 'MyOwnPass#2026' })).status === 400);
  const staffToken = (await call('POST', '/auth/login', { its, password: 'MyOwnPass#2026' })).json.token;

  console.log('Editing my own details');
  ok('name is saved', (await call('PATCH', '/auth/me', { name: 'Test Staff Renamed' }, staffToken)).json.name === 'Test Staff Renamed');
  ok('phone without a country code is refused', (await call('PATCH', '/auth/me', { phone: '0712345678' }, staffToken)).status === 400);
  ok('phone with country code is saved', (await call('PATCH', '/auth/me', { phone: '+254 712345678' }, staffToken)).json.phone === '+254 712345678');
  ok('ITS that is not 8 digits is refused', (await call('PATCH', '/auth/me', { itsNumber: '1234567' }, staffToken)).status === 400);
  ok('ITS cannot be removed (it is the sign-in name)', (await call('PATCH', '/auth/me', { itsNumber: '' }, staffToken)).status === 400);
  const newIts = digits(20);
  ok('ITS is saved', (await call('PATCH', '/auth/me', { itsNumber: newIts }, staffToken)).json.itsNumber === newIts);
  ok('sign-in works with the new ITS', (await call('POST', '/auth/login', { its: newIts, password: 'MyOwnPass#2026' })).status === 200);
  ok('sign-in with the old ITS no longer works', (await call('POST', '/auth/login', { its, password: 'MyOwnPass#2026' })).status === 401);
  its = newIts;
  ok('an ITS already used by someone else is refused (409)', (await call('PATCH', '/auth/me', { itsNumber: otherStudent.its_number }, staffToken)).status === 409);

  console.log('Changing my email');
  const newEmail = `test.renamed.${stamp}@jameasaifiyah.edu`;
  ok('email change without the password is refused', (await call('PATCH', '/auth/me', { email: newEmail }, staffToken)).status === 401);
  ok('email change with a wrong password is refused', (await call('PATCH', '/auth/me', { email: newEmail, currentPassword: 'nope' }, staffToken)).status === 401);
  ok('a non-@jameasaifiyah.edu email is refused', (await call('PATCH', '/auth/me', { email: 'me@gmail.com', currentPassword: 'MyOwnPass#2026' }, staffToken)).status === 400);
  const { rows: [someone] } = await pool.query(`SELECT email FROM users WHERE id = $1`, [otherStudent.id]);
  ok('an email used by another account is refused', [400, 409].includes((await call('PATCH', '/auth/me', { email: someone.email, currentPassword: 'MyOwnPass#2026' }, staffToken)).status));
  ok('email change with the password is saved', (await call('PATCH', '/auth/me', { email: newEmail.toUpperCase(), currentPassword: 'MyOwnPass#2026' }, staffToken)).json.email === newEmail);
  ok('sign-in still works with the ITS after an email change', (await call('POST', '/auth/login', { its, password: 'MyOwnPass#2026' })).status === 200);

  console.log('TR numbers');
  const studentToken = jwtFor(student);
  await call('PATCH', '/auth/me', { trNumber: 'HACK1' }, studentToken);
  ok('a student cannot change their own TR', (await call('GET', '/auth/me', undefined, studentToken)).json.trNumber === student.tr_number);
  ok('admin: a TR not on the approved list is refused', (await call('PATCH', `/admin/users/${student.id}/details`, { trNumber: 'NOT-A-TR' }, adminToken)).status === 400);
  ok('admin: a TR used by another student is refused', (await call('PATCH', `/admin/users/${student.id}/details`, { trNumber: otherStudent.tr_number }, adminToken)).status === 409);
  const { rows: [free] } = await pool.query(`SELECT tr_number FROM approved_tr_numbers WHERE used = false AND (branch_id IS NULL OR branch_id = $1) LIMIT 1`, [student.branch_id]);
  if (free) {
    const moved = await call('PATCH', `/admin/users/${student.id}/details`, { trNumber: free.tr_number }, adminToken);
    const { rows: [oldTr] } = await pool.query(`SELECT used, student_id FROM approved_tr_numbers WHERE tr_number = $1`, [student.tr_number]);
    const { rows: [newTr] } = await pool.query(`SELECT used, student_id FROM approved_tr_numbers WHERE tr_number = $1`, [free.tr_number]);
    ok('admin: moving to a free approved TR frees the old one', moved.json.trNumber === free.tr_number && !oldTr.used && !oldTr.student_id && newTr.used && newTr.student_id === student.id);
    ok('admin: and it can be moved back', (await call('PATCH', `/admin/users/${student.id}/details`, { trNumber: student.tr_number }, adminToken)).json.trNumber === student.tr_number);
  }
  ok('non-admins cannot use the admin edit', (await call('PATCH', `/admin/users/${otherStudent.id}/details`, { name: 'x' }, studentToken)).status === 403);

  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const tr of testTrs) {
      await pool.query(`UPDATE approved_tr_numbers SET used = false, student_id = NULL WHERE tr_number = $1`, [tr]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE tr_number = $1`, [tr]).catch(() => {});
    }
    for (const tr of testTrs) await pool.query(`DELETE FROM approved_tr_numbers WHERE tr_number = $1`, [tr]).catch(() => {});
    if (staffId) {
      for (const table of ['notifications', 'activity_log']) await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [staffId]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [staffId]);
    }
    await pool.end();
  });
