import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

// config.ts requires these at import time; the pool is lazy and never connects in these tests.
for (const [k, v] of Object.entries({
  DB_HOST: 'localhost', DB_NAME: 'test', DB_USER: 'test', DB_PASSWORD: 'test', JWT_SECRET: 'test',
  R2_ACCOUNT_ID: 'test', R2_ACCESS_KEY_ID: 'test', R2_SECRET_ACCESS_KEY: 'test', R2_BUCKET_NAME: 'test',
})) process.env[k] ??= v;

const { buildRecipients, checkRoleChange, cleanAnnouncement, cleanAnswers, meritExportTable, parseRosterRows, personRole, policyKeyFromEntity, roleColumns, summariseSurvey } = await import('../../src/v2/lib/commsLogic.ts');
const { DEFAULT_TEMPLATES, EMAIL_KEYS, fillTemplate, normaliseVars, renderWith, sendAllowance } = await import('../../src/v2/lib/emailTemplates.ts');
const { IN_APP_ALLOWED_TYPES, allowedTypesSql, isAllowedInApp } = await import('../../src/services/notify.ts');
const { colName, crc32, readXlsx, unzip, writeXlsx, zipStore } = await import('../../src/v2/lib/xlsx.ts');
const DB = await import('../../src/db.ts');
after(async () => { await DB.pool.end(); });


const BR = [{ id: 'b-nai', name: 'Nairobi' }, { id: 'b-mar', name: 'Marol / Mumbai' }];

// ---------------- notifications allow-list
test('only marks, replies, department replies, new courses and announcements reach the bell', () => {
  for (const t of ['work_marked', 'work_reviewed', 'teacher_replied', 'dept_reply', 'new_course', 'announcement']) assert.ok(isAllowedInApp(t), t);
  for (const t of ['gentle_reminder', 'new_work_to_review', 'merit_points_to_give', 'merit_points_given', 'theme_changed', 'course_updated', 'entry_auto_diverted', 'group_message']) assert.equal(isAllowedInApp(t), false, t);
  const sql = allowedTypesSql(2);
  assert.equal(sql.params.length, IN_APP_ALLOWED_TYPES.length);
  assert.match(sql.sql, /^type IN \(\$2, \$3/);
});

// ---------------- email templates
test('every email key has a template with a subject and body; Funun signature, never Tadreeb', () => {
  for (const k of EMAIL_KEYS) {
    const t = DEFAULT_TEMPLATES[k];
    assert.ok(t.subject && t.body && t.label, k);
    const r = renderWith(t, { name: 'Fatema', title: 'T', message: 'M', comment: 'C', step: 'Level 1 · Step 2', course: 'Naskh', mark: 8, band: 'pass', teacher: 'Ustad Ali' });
    assert.match(r.text, /Funun al-Quran/);
    assert.doesNotMatch(r.text + r.subject, /Tadreeb|\{[a-z_]+\}/i, k);
  }
});

test('fillTemplate fills words, blanks unknown ones and tidies empty lines', () => {
  assert.equal(fillTemplate('Salaam {name},\n\n{missing}\n\n\nBye', { name: 'Ali' }), 'Salaam Ali,\n\nBye');
  const r = renderWith({ subject: 'Hi {name}', body: '<b>{message}</b> https://x.y/#a' }, { name: '', message: 'a & b' });
  assert.equal(r.subject, 'Hi there');
  assert.match(r.html, /&lt;b&gt;a &amp; b&lt;\/b&gt;/);
  assert.match(r.html, /<a href="https:\/\/x\.y\/#a"/);
});

test('normaliseVars maps the words other parts of the site use', () => {
  const v = normaliseVars({ studentName: 'Mustafa Saifee', senderName: 'Ustad Ali', message: 'Well done', stepLabel: 'Level 1 · Step 1', obj: { x: 1 } });
  assert.equal(v.name, 'Mustafa');
  assert.equal(v.teacher, 'Ustad Ali');
  assert.equal(v.comment, 'Well done');
  assert.equal(v.step, 'Level 1 · Step 1');
  assert.equal('obj' in v, false);
});

test('the queue never goes over the per-run or daily cap', () => {
  assert.equal(sendAllowance(0, 95, 12), 12);
  assert.equal(sendAllowance(90, 95, 12), 5);
  assert.equal(sendAllowance(95, 95, 12), 0);
  assert.equal(sendAllowance(140, 95, 12), 0);
});

// ---------------- roster
test('roster: headers in any order and spelling, branch names matched, problems listed', () => {
  const rows = [
    ['Email', 'Student Name', 'TR No', 'Darajah', 'Campus'],
    ['a@x.com', 'Ali  Asgar', '40101.0', '5', 'Marol'],
    ['', 'Zahra', '40102', '6', ''],
    ['bad-email', 'Huzaifa', '40103', '6', 'Mumbai'],
    ['', 'No Tr', '', '6', 'Marol'],
    ['', 'Somewhere', '40104', '6', 'Atlantis'],
    ['', '', '', '', ''],
    ['b@x.com', 'Ali Asgar again', '40101', '5', 'Marol'],
  ];
  const r = parseRosterRows(rows, BR, 'b-mar', null);
  assert.equal(r.records.length, 3); // duplicate TR in the same branch → last one wins
  const ali = r.records.find(x => x.trNumber === '40101')!;
  assert.equal(ali.name, 'Ali Asgar again');
  assert.equal(ali.email, 'b@x.com');
  assert.equal(r.records.find(x => x.trNumber === '40102')!.branchId, 'b-mar');
  assert.equal(r.records.find(x => x.trNumber === '40103')!.email, null);
  assert.deepEqual(r.skipped.map(s => s.row), [4, 5, 6]);
});

test('roster: branch admins cannot import other branches; missing columns explained', () => {
  const r = parseRosterRows([['Name', 'TR', 'Branch'], ['A', '1', 'Nairobi'], ['B', '2', 'Marol']], BR, 'b-mar', ['b-mar']);
  assert.deepEqual(r.records.map(x => x.trNumber), ['2']);
  assert.match(r.skipped[0].reason, /another branch/);
  const none = parseRosterRows([['Email', 'Class'], ['a@b.co', '5']], BR, 'b-mar', null);
  assert.equal(none.records.length, 0);
  assert.match(none.skipped[0].reason, /Name.*TR/);
  const noBranch = parseRosterRows([['Name', 'TR'], ['A', '1']], BR, null, null);
  assert.match(noBranch.skipped[0].reason, /No branch/);
});

// ---------------- recipients
test('recipients: registered students, then roster-only students, then teachers — one email each', () => {
  const base = {
    registered: [{ email: 'S1@x.com', name: 'S1', trNumber: '1' }, { email: null, name: 'S2', trNumber: '2' }],
    roster: [{ email: 's1-home@x.com', name: 'S1', trNumber: '1' }, { email: 'r3@x.com', name: 'R3', trNumber: '3' }, { email: null, name: 'R4', trNumber: '4' }],
    teachers: [{ email: 't@x.com', name: 'T' }, { email: 's1@x.com', name: 'dup' }],
  };
  assert.deepEqual(buildRecipients({ ...base, audience: 'registered', includeTeachers: false }).map(r => r.email), ['s1@x.com']);
  const all = buildRecipients({ ...base, audience: 'roster', includeTeachers: true });
  assert.deepEqual(all.map(r => `${r.kind}:${r.email}`), ['student:s1@x.com', 'roster:r3@x.com', 'teacher:t@x.com']);
});

// ---------------- announcements + surveys
test('announcement validation: title, message, at least one way to reach people, survey questions', () => {
  assert.equal(cleanAnnouncement({ title: '', body: 'x' }), 'Please give it a title.');
  assert.match(String(cleanAnnouncement({ title: 'T', body: 'B', showOnSite: false, sendEmail: false })), /at least one/);
  assert.match(String(cleanAnnouncement({ kind: 'survey', title: 'T', body: 'B' })), /at least one question/);
  assert.match(String(cleanAnnouncement({ kind: 'survey', title: 'T', body: 'B', questions: [{ id: 'a', text: 'Q', type: 'choice', options: ['only'] }] })), /two choices/);
  const ok = cleanAnnouncement({ kind: 'survey', title: ' T ', body: 'B', questions: [{ id: 'x', text: 'Q', type: 'rating' }] });
  assert.ok(typeof ok !== 'string');
  if (typeof ok !== 'string') { assert.equal(ok.title, 'T'); assert.equal(ok.showOnSite, true); assert.equal(ok.includeTeachers, true); assert.equal(ok.questions[0].id, 'x'); }
  const ann = cleanAnnouncement({ title: 'T', body: 'B', questions: [{ id: 'x', text: 'Q', type: 'rating' }] });
  assert.ok(typeof ann !== 'string' && ann.questions.length === 0);
});

test('survey answers are checked and summarised', () => {
  const qs = [
    { id: 'day', text: 'Day?', type: 'choice' as const, options: ['Mon', 'Thu'], required: true },
    { id: 'use', text: 'Useful?', type: 'rating' as const, required: true },
    { id: 'more', text: 'More?', type: 'text' as const, required: false },
  ];
  assert.match(String(cleanAnswers(qs, { day: 'Sun', use: 3 })), /choices/);
  assert.match(String(cleanAnswers(qs, { day: 'Mon', use: 9 })), /1 to 5/);
  assert.match(String(cleanAnswers(qs, { use: 3 })), /Please answer/);
  assert.deepEqual(cleanAnswers(qs, { day: 'Mon', use: '4', more: ' ok ' }), { day: 'Mon', use: 4, more: 'ok' });
  const s = summariseSurvey({ id: 'a', title: 'T', questions: qs }, [
    { name: 'A', answers: { day: 'Mon', use: 4 } }, { name: 'B', answers: { day: 'Thu', use: 5, more: 'Shukran' } }, { name: 'C', answers: { day: 'Thu', use: 3 } },
  ]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.questions[0].counts, [{ option: 'Mon', n: 1 }, { option: 'Thu', n: 2 }]);
  assert.equal(s.questions[1].average, 4);
  assert.deepEqual(s.questions[2].answers, [{ name: 'B', text: 'Shukran' }]);
});

// ---------------- people & roles
test('roles map both ways', () => {
  assert.equal(personRole({ role: 'admin', admin_scope: 'branch' }), 'branch_admin');
  assert.equal(personRole({ role: 'admin', admin_scope: 'master' }), 'master_admin');
  assert.equal(personRole({ role: 'teacher', admin_scope: 'master' }), 'teacher');
  assert.deepEqual(roleColumns('branch_admin'), { role: 'admin', adminScope: 'branch' });
  assert.deepEqual(roleColumns('teacher'), { role: 'teacher', adminScope: 'master' });
});

test('role changes: master only, never yourself, keep one master, staff never back to student', () => {
  const base = { actorIsMaster: true, actorId: 'me', targetId: 'x', masterCount: 2 };
  assert.equal(checkRoleChange({ ...base, from: 'teacher', to: 'branch_admin' }), null);
  assert.match(String(checkRoleChange({ ...base, actorIsMaster: false, from: 'teacher', to: 'branch_admin' })), /master admin team/);
  assert.match(String(checkRoleChange({ ...base, targetId: 'me', from: 'master_admin', to: 'teacher' })), /your own role/);
  assert.match(String(checkRoleChange({ ...base, masterCount: 1, from: 'master_admin', to: 'branch_admin' })), /at least one master/);
  assert.match(String(checkRoleChange({ ...base, from: 'teacher', to: 'student' })), /cannot be turned into students/);
  assert.equal(checkRoleChange({ ...base, from: 'student', to: 'teacher' }), null);
});

test('policy key from the audit entity', () => {
  assert.equal(policyKeyFromEntity('b-mar:print.instructions'), 'print.instructions');
  assert.equal(policyKeyFromEntity('print.instructions'), null);
});

// ---------------- merit export + xlsx
test('merit export table: plain words, sorted by branch then name, totals', () => {
  const t = meritExportTable([
    { studentName: 'Zainab', trNumber: '2', branchName: 'Nairobi', sourceLabel: 'Levels 1–3', points: 1, earnedMonth: '2026-11', status: 'pending', givenByName: null, givenAt: null },
    { studentName: 'Ali', trNumber: '1', branchName: 'Nairobi', className: '5', sourceLabel: 'Certification', points: 10, earnedMonth: '2026-11', status: 'given', givenByName: 'BA', givenAt: '2026-11-20T10:00:00Z' },
  ]);
  assert.equal(t.header[0], 'Student');
  assert.deepEqual(t.rows[0], ['Ali', '1', '5', 'Nairobi', 'Certification', 10, '2026-11', 'Given', 'BA', '2026-11-20']);
  assert.equal(t.rows[1][7], 'To give');
  assert.deepEqual(t.totals, { students: 2, points: 11 });
});

test('xlsx: written file reads back (numbers, unicode, escaping, gaps)', () => {
  const buf = writeXlsx([{ name: 'Merit/points', rows: [['Name', 'TR', 'Pts'], ['فاطمة <Ali> & co', '40101', 3], ['', null, 7]] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const back = readXlsx(buf);
  assert.deepEqual(back, [['Name', 'TR', 'Pts'], ['فاطمة <Ali> & co', '40101', '3'], ['', '', '7']]);
  assert.equal(colName(0), 'A'); assert.equal(colName(25), 'Z'); assert.equal(colName(26), 'AA');
});

test('xlsx: reads deflated Excel files with shared strings', () => {
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>40101</v></c></row></sheetData></worksheet>';
  const ss = '<sst><si><t>Name</t></si><si><r><t>T</t></r><r><t>R</t></r></si><si><t xml:space="preserve">Sakina &amp; Co </t></si></sst>';
  const files = [{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) }, { name: 'xl/sharedStrings.xml', data: Buffer.from(ss) }];
  // build a deflated zip by hand from the stored one
  const stored = zipStore(files);
  const entries = unzip(stored);
  assert.equal(entries.get('xl/sharedStrings.xml')!.toString(), ss);
  const deflated = buildDeflatedZip(files);
  assert.deepEqual(readXlsx(deflated), [['Name', '', 'TR'], ['Sakina & Co', '', '40101']]);
  assert.throws(() => readXlsx(Buffer.from('not a zip at all, sorry')), /not an Excel/);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

function buildDeflatedZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const comp = deflateRawSync(f.data); const crc = crc32(f.data);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(f.data.length, 22); l.writeUInt16LE(name.length, 26);
    locals.push(l, name, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
