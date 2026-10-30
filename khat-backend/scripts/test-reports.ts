// Runnable check for "Report a problem": send a report, mark it fixed on /logs, answer "works" and "still".
//   1. start the server with LOGS_PASSWORD set:   npm run dev
//   2. in another terminal:                       npm run test:reports
// Uses the same .env as the server (database + JWT_SECRET + LOGS_PASSWORD). Everything it creates is deleted
// at the end. Refuses to run against anything but localhost unless ALLOW_REMOTE_TEST=1.
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pool } from '../src/db.js';

const BASE = process.env.TEST_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const PASSWORD = process.env.LOGS_PASSWORD;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.ALLOW_REMOTE_TEST !== '1') {
  throw new Error(`Refusing to run against ${BASE}; this test writes data. Set ALLOW_REMOTE_TEST=1 to override.`);
}
if (!PASSWORD) throw new Error('Set LOGS_PASSWORD in .env (the server must use the same value).');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const created: string[] = [];
let passed = 0;

function jwtFor(user: { id: string; role: string; branch_id: string; is_coordinator: boolean }): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ id: user.id, role: user.role, branchId: user.branch_id, isCoordinator: Boolean(user.is_coordinator), iat: Math.floor(Date.now() / 1000) });
  return `${head}.${body}.${createHmac('sha256', process.env.JWT_SECRET!).update(`${head}.${body}`).digest('base64url')}`;
}

async function api(path: string, body: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function logs(path: string, init: RequestInit = {}, cookie = '') {
  const res = await fetch(BASE + path, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } });
  return { status: res.status, text: await res.text(), cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '', location: res.headers.get('location') ?? '' };
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

function ok(name: string, condition: unknown) {
  assert.ok(condition, name);
  passed++;
  console.log(`  ok  ${name}`);
}

async function main() {
  const { rows: users } = await pool.query(`SELECT id, role, branch_id, is_coordinator, name FROM users WHERE deleted_at IS NULL ORDER BY role, name LIMIT 50`);
  const student = users.find((u: any) => u.role === 'student');
  const other = users.find((u: any) => u.id !== student?.id);
  assert.ok(student && other, 'need at least two users in the database');
  const studentToken = jwtFor(student);
  const otherToken = jwtFor(other);

  console.log('Sending reports');
  ok('empty text is refused', (await api('/api/reports', { text: '   ' })).status === 400);
  ok('a non-image screenshot is refused', (await api('/api/reports', { text: 'x', screenshot: 'data:image/png;base64,SGVsbG8=' })).status === 400);

  const anon = await api('/api/reports', {
    text: 'Anonymous: the <script>alert(1)</script> button does nothing',
    page: 'http://localhost/#login',
    screenshot: TINY_PNG,
    browserInfo: { userAgent: 'test-agent', screen: '1920x1080' },
    recentErrors: [{ message: 'TypeError: x is undefined' }],
  });
  ok('anonymous report is saved (201)', anon.status === 201 && anon.json.id && /^[0-9a-f]{64}$/.test(anon.json.reporterToken));
  created.push(anon.json.id);

  const signed = await api('/api/reports', { text: 'Signed in: my course will not open', page: 'http://localhost/#course' }, studentToken);
  ok('signed-in report is saved (201)', signed.status === 201);
  created.push(signed.json.id);
  const byId = Object.fromEntries((await pool.query(`SELECT id, person_role, person_id, name, screenshot FROM problem_reports WHERE id IN ($1, $2)`, [anon.json.id, signed.json.id])).rows.map((r: any) => [r.id, r]));
  ok('anonymous report is stored as anonymous with a screenshot', byId[anon.json.id].person_role === 'anonymous' && !byId[anon.json.id].person_id && byId[anon.json.id].screenshot?.startsWith('reports/'));
  ok('signed-in report stores who it was', byId[signed.json.id].person_id === student.id && byId[signed.json.id].name === student.name);

  ok('nothing is pending before a fix', (await api('/api/reports/pending', { tokens: [anon.json.reporterToken] })).json.reports.length === 0);

  console.log('/logs page');
  ok('/logs asks for the password', (await logs('/logs')).text.includes('type="password"'));
  ok('a wrong password is refused', (await logs('/logs/login', form({ password: 'wrong-password' }))).status === 401);
  const login = await logs('/logs/login', form({ password: PASSWORD! }));
  ok('the right password signs in', login.status === 303 && login.cookie.startsWith('khat_logs='));
  const cookie = login.cookie;
  const reportsPage = await logs('/logs', {}, cookie);
  ok('report text is shown escaped (no HTML injection)', reportsPage.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !reportsPage.text.includes('<script>alert(1)'));
  ok('new reports show status New', reportsPage.text.includes('b-New'));
  const shotKey = byId[anon.json.id].screenshot;
  ok('screenshot needs the /logs password', (await logs(`/logs/shot?key=${encodeURIComponent(shotKey)}`)).status === 401);
  ok('screenshot is served after sign-in', (await logs(`/logs/shot?key=${encodeURIComponent(shotKey)}`, {}, cookie)).status === 200);

  console.log('Mark fixed, then "It works now"');
  const fix1 = await logs(`/logs/reports/${anon.json.id}/fix`, form({ note: 'The login button works again.' }), cookie);
  ok('mark as fixed redirects back with a message', fix1.status === 303 && fix1.location.includes('Marked'));
  const pendingAnon = (await api('/api/reports/pending', { tokens: [anon.json.reporterToken] })).json.reports;
  ok('the anonymous reporter now sees it as fixed, with the note', pendingAnon.length === 1 && pendingAnon[0].fix_note === 'The login button works again.');
  ok('someone else cannot answer it', (await api(`/api/reports/${anon.json.id}/answer`, { answer: 'works' }, otherToken)).status === 403);
  ok('"It works now" is saved', (await api(`/api/reports/${anon.json.id}/answer`, { answer: 'works', tokens: [anon.json.reporterToken] })).status === 200);
  ok('it is no longer pending', (await api('/api/reports/pending', { tokens: [anon.json.reporterToken] })).json.reports.length === 0);
  ok('it cannot be answered twice', (await api(`/api/reports/${anon.json.id}/answer`, { answer: 'still', reply: 'x', tokens: [anon.json.reporterToken] })).status === 409);

  console.log('Mark fixed, then "Still a problem", then fixed again');
  await logs(`/logs/reports/${signed.json.id}/fix`, form({ note: 'Fixed the course link.' }), cookie);
  ok('the signed-in reporter sees it by account', (await api('/api/reports/pending', { tokens: [] }, studentToken)).json.reports.some((r: any) => r.id === signed.json.id));
  ok('"Still a problem" needs a reply', (await api(`/api/reports/${signed.json.id}/answer`, { answer: 'still', reply: '' }, studentToken)).status === 400);
  ok('"Still a problem" with reply + screenshot is saved', (await api(`/api/reports/${signed.json.id}/answer`, { answer: 'still', reply: 'Level 3 still shows a blank page', screenshot: TINY_PNG }, studentToken)).status === 200);
  const { rows: [still] } = await pool.query(`SELECT answer, reply, reply_shot, answered_at FROM problem_reports WHERE id = $1`, [signed.json.id]);
  ok('answer, reply and reply screenshot are stored', still.answer === 'still' && still.reply === 'Level 3 still shows a blank page' && still.reply_shot?.startsWith('reports/') && still.answered_at);
  const afterStill = await logs('/logs', {}, cookie);
  ok('/logs shows "Still a problem" with their reply', afterStill.text.includes('b-Still') && afterStill.text.includes('Level 3 still shows a blank page'));
  await logs(`/logs/reports/${signed.json.id}/fix`, form({ note: 'Second fix.' }), cookie);
  ok('fixing again asks them again', (await api('/api/reports/pending', {}, studentToken)).json.reports.some((r: any) => r.id === signed.json.id && r.fix_note === 'Second fix.'));

  console.log('Browser error log');
  const message = `Test browser error ${Date.now()}`;
  ok('a browser error is accepted', (await api('/api/clientlog', { message, url: 'http://localhost/#dashboard' })).status === 202);
  ok('the same error right away is dropped as a duplicate', (await api('/api/clientlog', { message })).json.duplicate === true);
  ok('it appears on the Errors tab', (await logs('/logs?tab=errors&source=browser', {}, cookie)).text.includes(message));
  await pool.query(`DELETE FROM error_log WHERE message = $1`, [message]);

  console.log('Rate limit');
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) {
    const r = await api('/api/reports', { text: `rate limit probe ${i}` });
    if (r.status === 201) created.push(r.json.id);
    if (r.status === 429) limited = true;
  }
  ok('more than 20 reports per hour from one IP are refused', limited);

  console.log(`\nAll ${passed} checks passed.`);
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (created.length) await pool.query(`DELETE FROM problem_reports WHERE id IN (${created.map((_, i) => `$${i + 1}`).join(', ')})`, created);
    await pool.end();
  });
