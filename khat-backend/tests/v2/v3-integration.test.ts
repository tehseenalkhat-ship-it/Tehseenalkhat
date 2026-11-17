import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// config.ts requires these at import time; the pool is lazy and never connects in these tests.
for (const [k, v] of Object.entries({
  DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test',
})) process.env[k] ??= v;

const { buildRecipients, signSurveyToken, verifySurveyToken } = await import('../../src/v2/lib/commsLogic.ts');
const { renderWith } = await import('../../src/v2/lib/emailTemplates.ts');
const { buildStepStates, isProvisionalMark } = await import('../../src/v2/lib/courseLogic.ts');
const { friendlyThreadLabel } = await import('../../src/v2/lib/chatLogic.ts');
const { pool } = await import('../../src/db.ts');
after(async () => { await pool.end().catch(() => undefined); });

const SURVEY = '0b6a8a3e-1111-4222-8333-944455566677';
const ROSTER = '7c9d0e1f-aaaa-4bbb-8ccc-ddddeeeeffff';

test('survey link token: signs, verifies, and rejects tampering', () => {
  const t = signSurveyToken('secret', SURVEY, `r:${ROSTER}`);
  assert.deepEqual(verifySurveyToken('secret', t), { surveyId: SURVEY, ref: `r:${ROSTER}`, kind: 'roster', id: ROSTER });
  assert.equal(verifySurveyToken('other-secret', t), null);
  const [body, sig] = t.split('.');
  assert.equal(verifySurveyToken('secret', `${body}x.${sig}`), null);
  assert.equal(verifySurveyToken('secret', `${body}.${sig.slice(0, -1)}A`), null);
  assert.equal(verifySurveyToken('secret', ''), null);
  assert.equal(verifySurveyToken('secret', 42), null);
  const u = signSurveyToken('secret', SURVEY, `u:${ROSTER}`);
  assert.equal(verifySurveyToken('secret', u)?.kind, 'user');
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'URL-safe');
});

test('recipients carry who they are (for personal survey links), roster students skipped when registered', () => {
  const list = buildRecipients({
    registered: [{ id: 'u1', email: 'a@x.org', name: 'Ali', trNumber: '100' }],
    roster: [{ id: 'r1', email: 'b@x.org', name: 'Bilal', trNumber: '200' }, { id: 'r2', email: 'a2@x.org', name: 'Ali', trNumber: '100' }],
    teachers: [{ id: 't1', email: 't@x.org', name: 'Teacher' }],
    audience: 'roster', includeTeachers: true,
  });
  assert.deepEqual(list.map(r => [r.email, r.kind, r.ref]), [
    ['a@x.org', 'student', 'u:u1'], ['b@x.org', 'roster', 'r:r1'], ['t@x.org', 'teacher', 'u:t1'],
  ]);
});

test('an edited survey template that lost {link} still carries the personal link', () => {
  const out = renderWith({ subject: 'Survey', body: 'Salaam {name}, please answer.' }, { name: 'Bilal', link: 'https://site/#survey?t=abc' });
  assert.match(out.text, /https:\/\/site\/#survey\?t=abc/);
  const once = renderWith({ subject: 'Survey', body: 'Answer: {link}' }, { link: 'https://site/#survey?t=abc' });
  assert.equal(once.text.split('https://site/#survey?t=abc').length - 1, 1);
});

test('provisional (automatic 96 h) mark: a mark on work that is still open', () => {
  assert.equal(isProvisionalMark({ status: 'in_review', mark: 7 }), true);
  assert.equal(isProvisionalMark({ status: 'submitted', mark: 6 }), true);
  assert.equal(isProvisionalMark({ status: 'in_review', mark: null }), false);
  assert.equal(isProvisionalMark({ status: 'passed', mark: 7 }), false);
  assert.equal(isProvisionalMark(null), false);
  const types = [{ typeKey: 'assessment', studentAction: 'download_upload' }] as any;
  const states = buildStepStates([{ id: 's1', stepType: 'assessment' }], types, new Set(), [
    { stepId: 's1', attemptNo: 1, status: 'in_review', mark: 7, band: 'pass', createdAt: new Date() },
  ], new Map()) as Record<string, any>;
  assert.equal(states.s1.provisional, true);
  assert.equal(states.s1.done, false, 'the step keeps waiting until the teacher confirms');
  assert.equal(states.s1.mark, 7);
});

test('notification labels never show internal codes', () => {
  const label = friendlyThreadLabel({ courseTitle: 'Fann al-Khat 1', levelCode: 'LV01', levelOrder: 0, code: 'S05', title: 'Joins', courseType: 'certification' });
  assert.doesNotMatch(label, /LV0|S05|FNK/);
  assert.match(label, /Fann al-Khat 1/);
});
