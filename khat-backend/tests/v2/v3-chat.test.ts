/**
 * v3 chat tests — pure logic (always) + live API checks against the e2e backend when it is up.
 * Run: npx tsx --test tests/v2/v3-chat.test.ts   (live part only with KHAT_LIVE_API=http://127.0.0.1:4100 — it writes test messages)
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

for (const [k, v] of Object.entries({
  DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test',
})) process.env[k] ??= v;

const C = await import('../../src/v2/lib/chatLogic.js');
const DB = await import('../../src/db.js');
after(async () => { await DB.pool.end(); });

describe('friendly labels (no internal codes)', () => {
  test('numberFromCode', () => {
    assert.equal(C.numberFromCode('LV02'), 2);
    assert.equal(C.numberFromCode('S01'), 1);
    assert.equal(C.numberFromCode('', 0), 1);
    assert.equal(C.numberFromCode(null, null), null);
  });
  test('course kinds', () => {
    assert.equal(C.courseKindLabel('certification'), 'Certification course');
    assert.equal(C.courseKindLabel('crash'), 'Crash course');
    assert.equal(C.courseKindLabel('mashq'), 'Mashq worksheets');
    assert.equal(C.courseKindLabel('other'), null);
  });
  test('step label', () => {
    assert.equal(C.friendlyStepLabel({ levelCode: 'LV02', stepCode: 'S03', title: 'Level 2 assessment' }), 'Level 2 · Step 3 — Level 2 assessment');
    assert.equal(C.friendlyStepLabel({ levelCode: 'LV01', stepCode: 'S05', title: 'Final sheet', hideLevel: true }), 'Step 5 — Final sheet');
    assert.equal(C.friendlyStepLabel({}), 'this step');
  });
  test('thread label hides the single level of crash/mashq courses and never shows codes', () => {
    const cert = C.friendlyThreadLabel({ courseTitle: 'Fann al-Khat 1', levelCode: 'LV01', code: 'S02', title: 'Joins', courseType: 'certification' });
    assert.equal(cert, 'Fann al-Khat 1, Level 1 · Step 2 — Joins');
    const mashq = C.friendlyThreadLabel({ courseTitle: 'Urs', levelCode: 'LV01', code: 'S04', title: 'Sheet 4', courseType: 'mashq' });
    assert.equal(mashq, 'Urs, Step 4 — Sheet 4');
    assert.doesNotMatch(cert + mashq, /LV\d|S0\d|TKH|FNK/);
  });
});

describe('voice meta', () => {
  test('keeps duration and clamps a waveform', () => {
    const m = C.sanitiseVoiceMeta({ durationSec: 12.345, waveform: [0, 0.5, 2, -1, 0.25, 0.75, 1, 0.1, 'x'], other: 1 });
    assert.equal(m.durationSec, 12.3);
    assert.deepEqual(m.waveform, [0, 0.5, 1, 0, 0.25, 0.75, 1, 0.1]);
    assert.equal((m as Record<string, unknown>).other, undefined);
  });
  test('drops tiny or bad waveforms and caps length', () => {
    assert.equal(C.sanitiseVoiceMeta({ waveform: [0.1, 0.2] }).waveform, undefined);
    assert.equal(C.sanitiseVoiceMeta({ waveform: Array(200).fill(0.5) }).waveform?.length, 64);
    assert.deepEqual(C.sanitiseVoiceMeta(null), {});
    assert.equal(C.sanitiseVoiceMeta({ durationSec: 99999 }).durationSec, 3600);
  });
});

describe('previews, meet message, sorting, throttling', () => {
  test('preview text', () => {
    assert.equal(C.messagePreview({ kind: 'voice', body: null }), '🎤 Voice note');
    assert.equal(C.messagePreview({ kind: 'files', body: null }), '📷 Photo');
    assert.equal(C.messagePreview({ kind: 'text', body: 'x', meta: { event: 'meet_request' } }), 'Request to meet at the Funun al-Quran office');
    assert.match(C.MEET_REQUEST_TEXT, /Funun al-Quran office/);
  });
  test('unread first, then latest, then names', () => {
    const rows = [
      { studentId: 'a', name: 'Zed', lastAt: null, unread: 0 },
      { studentId: 'b', name: 'Amy', lastAt: '2026-11-10T00:00:00Z', unread: 0 },
      { studentId: 'c', name: 'Bob', lastAt: '2026-11-01T00:00:00Z', unread: 2 },
      { studentId: 'd', name: 'Ali', lastAt: null, unread: 0 },
      { studentId: 'e', name: 'Eve', lastAt: '2026-11-12T00:00:00Z', unread: 0 },
    ];
    assert.deepEqual(C.sortDeptThreads(rows).map(r => r.studentId), ['c', 'e', 'b', 'd', 'a']);
  });
  test('staff email throttle', () => {
    const now = new Date('2026-11-14T10:00:00Z');
    assert.equal(C.shouldEmailStaff(null, now), true);
    assert.equal(C.shouldEmailStaff(new Date('2026-11-14T09:50:00Z'), now, 30), false);
    assert.equal(C.shouldEmailStaff(new Date('2026-11-14T09:20:00Z'), now, 30), true);
  });
});

describe('AI helper', () => {
  test('normalise', () => {
    assert.deepEqual(C.normaliseAssist({ mode: 'ask', text: '' }), { error: 'Type your question first.' });
    const r = C.normaliseAssist({ mode: 'weird', text: ' hello ' });
    assert.ok(!('error' in r) && r.mode === 'polish' && r.text === 'hello');
    const reply = C.normaliseAssist({ mode: 'reply', text: '' });
    assert.ok(!('error' in reply));
  });
  test('prompts speak calligraphy, no markdown', () => {
    const p = C.buildAssistPrompt({ mode: 'ask', text: 'How do I fix a slanting alif?', context: 'Student: my alif leans' });
    assert.match(p.system, /calligraphy/);
    assert.match(p.user, /slanting alif/);
    assert.match(p.user, /my alif leans/);
  });
  test('offline answers are useful and honest', () => {
    assert.match(C.offlineAssist({ mode: 'ask', text: 'alif problem' }), /alif/i);
    assert.match(C.offlineAssist({ mode: 'ask', text: 'zzz' }), /not connected/);
    const polished = C.offlineAssist({ mode: 'polish', text: 'nuqta too big', studentName: 'Zainab Ali' });
    assert.match(polished, /^Zainab, nuqta too big\./);
    assert.match(C.offlineAssist({ mode: 'reply', text: '', studentName: 'Ammar' }), /Salaam Ammar/);
  });
  test('tidy', () => {
    assert.equal(C.tidyAssist('"**Keep** your alif straight."'), 'Keep your alif straight.');
  });
});

/* ---------------- live API (skipped when the e2e backend is not running) ---------------- */
const API = process.env.KHAT_LIVE_API ?? '';
const live = !!API && await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);

async function login(email: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
  const d = await r.json() as { token: string };
  return d.token;
}
async function call(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${API}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) as any };
}

describe('live: Funun al-Quran Department chat', { skip: !live && 'set KHAT_LIVE_API to run against the e2e backend' }, () => {
  test('student writes, branch teacher sees it unread and replies, other branch is refused', async () => {
    const st = await login('student@demo.khat');
    const te = await login('teacher@demo.khat');
    const marol = await login('marol.teacher@demo.khat');
    const me = await call(st, '/v2/dept-chat');
    assert.equal(me.status, 200);
    assert.equal(me.data.mode, 'student');
    const sid = me.data.studentId as string;

    const sent = await call(st, '/v2/dept-chat/me/messages', { method: 'POST', body: { kind: 'text', body: 'Test: is the office open on Friday?' } });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.senderRole, 'student');

    const list = await call(te, '/v2/dept-chat');
    assert.equal(list.status, 200);
    const row = list.data.threads.find((t: any) => t.studentId === sid);
    assert.ok(row && row.unread >= 1 && row.lastFromStudent);

    const other = await call(marol, `/v2/dept-chat/${sid}/messages`);
    assert.equal(other.status, 403);

    const reply = await call(te, `/v2/dept-chat/${sid}/messages`, { method: 'POST', body: { kind: 'text', body: 'Yes, from 9 to 12.' } });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.senderRole, 'teacher');
    assert.ok(reply.data.senderName.length > 0);

    const read = await call(te, `/v2/dept-chat/${sid}/messages`);
    assert.equal(read.status, 200);
    const after = await call(te, '/v2/dept-chat');
    assert.equal(after.data.threads.find((t: any) => t.studentId === sid).unread, 0);

    const stu = await call(st, '/v2/dept-chat');
    assert.ok(stu.data.unread >= 1);
    await call(st, '/v2/dept-chat/me/messages');
    assert.equal((await call(st, '/v2/dept-chat')).data.unread, 0);
  });

  test('students cannot read others or send meeting requests; validation', async () => {
    const st = await login('student@demo.khat');
    const other = await login('fatema@demo.khat');
    const otherId = (await call(other, '/v2/dept-chat')).data.studentId;
    assert.equal((await call(st, `/v2/dept-chat/${otherId}/messages`)).status, 403);
    assert.equal((await call(st, '/v2/dept-chat/me/messages', { method: 'POST', body: { event: 'meet_request' } })).status, 403);
    assert.equal((await call(st, '/v2/dept-chat/me/messages', { method: 'POST', body: { kind: 'text', body: '  ' } })).status, 400);
    assert.equal((await call(st, '/v2/dept-chat/me/messages', { method: 'POST', body: { kind: 'voice', attachments: [] } })).status, 400);
  });

  test('staff meeting request + AI helper', async () => {
    const te = await login('teacher@demo.khat');
    const st = await login('student@demo.khat');
    const sid = (await call(st, '/v2/dept-chat')).data.studentId;
    const meet = await call(te, `/v2/dept-chat/${sid}/messages`, { method: 'POST', body: { event: 'meet_request' } });
    assert.equal(meet.status, 201);
    assert.equal(meet.data.meta.event, 'meet_request');
    assert.match(meet.data.body, /Funun al-Quran office/);
    const ai = await call(te, '/v2/ai/chat-assist', { method: 'POST', body: { mode: 'ask', text: 'How do I correct the nuqta?' } });
    assert.equal(ai.status, 200);
    assert.ok(typeof ai.data.answer === 'string' && ai.data.answer.length > 10);
    assert.equal((await call(st, '/v2/ai/chat-assist', { method: 'POST', body: { mode: 'ask', text: 'x' } })).status, 403);
  });

  test('step thread: friendly labels and meet-request endpoint', async () => {
    const te = await login('teacher@demo.khat');
    const inbox = await call(te, '/v2/review/inbox?status=all');
    assert.equal(inbox.status, 200);
    const item = inbox.data[0];
    if (!item) return;
    const thread = await call(te, `/v2/threads/${item.step.id}?studentId=${item.student.id}`);
    assert.equal(thread.status, 200);
    assert.ok(typeof thread.data.step.friendlyLabel === 'string');
    assert.doesNotMatch(thread.data.step.friendlyLabel, /LV\d\d|\bS\d\d\b/);
    const meet = await call(te, `/v2/threads/${item.step.id}/meet-request`, { method: 'POST', body: { studentId: item.student.id } });
    assert.equal(meet.status, 201);
    assert.equal(meet.data.meta.event, 'meet_request');
  });
});
