/**
 * Pure logic for v3 admin-comms (no database): roster parsing, recipient lists,
 * survey answers + results, people roles, merit export rows. Unit tested in
 * tests/v2/v3-admin-comms.test.ts.
 */
import type { AnnouncementInput, PersonRole, SurveyQuestion, SurveyResults } from './commsTypes.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { headerKey, matchBranchName } from './csv.js';

// ---------------------------------------------------------------- roster (JHS export)
export type RosterRecord = { branchId: string; trNumber: string; name: string; className: string | null; email: string | null };
export type RosterParse = { records: RosterRecord[]; skipped: { row: number; reason: string }[] };

const HEADERS: Record<keyof Omit<RosterRecord, 'branchId'> | 'branch', string[]> = {
  name: ['name', 'full name', 'student name', 'student', 'naam'],
  trNumber: ['tr', 'tr no', 'tr number', 'trno', 'tr num', 'tr #', 'its', 'its id', 'jamea id', 'id'],
  className: ['class', 'class name', 'darajah', 'grade', 'std', 'standard'],
  email: ['email', 'e mail', 'email address', 'mail'],
  branch: ['branch', 'campus', 'jamea', 'markaz', 'location'],
};

function findCol(headers: string[], names: string[]): number {
  const keys = headers.map(h => headerKey(h));
  for (const n of names) { const i = keys.indexOf(n); if (i >= 0) return i; }
  for (const n of names) { const i = keys.findIndex(k => k.startsWith(`${n} `) || k.endsWith(` ${n}`)); if (i >= 0) return i; }
  return -1;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Rows from CSV or Excel (first row = headers: Name, TR, Class, Branch, Email — any order,
 * common spellings accepted). `defaultBranchId` is used when there is no Branch column or it
 * is empty; `allowedBranchIds` limits where rows may go (branch admins: only their own).
 */
export function parseRosterRows(rows: string[][], branches: { id: string; name: string }[], defaultBranchId: string | null, allowedBranchIds: string[] | null): RosterParse {
  const skipped: RosterParse['skipped'] = [];
  if (!rows.length) return { records: [], skipped: [{ row: 1, reason: 'The file is empty.' }] };
  const headers = rows[0];
  const col = {
    name: findCol(headers, HEADERS.name), tr: findCol(headers, HEADERS.trNumber), cls: findCol(headers, HEADERS.className),
    email: findCol(headers, HEADERS.email), branch: findCol(headers, HEADERS.branch),
  };
  if (col.name < 0 || col.tr < 0) {
    return { records: [], skipped: [{ row: 1, reason: 'The first row must have the column names — at least “Name” and “TR”.' }] };
  }
  const names = branches.map(b => b.name);
  const byKey = new Map<string, RosterRecord>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    const get = (c: number) => (c >= 0 ? String(r[c] ?? '').trim() : '');
    const name = get(col.name).replace(/\s+/g, ' ');
    const tr = get(col.tr).replace(/\s+/g, '').replace(/\.0+$/, '');
    if (!name && !tr) continue;
    if (!name) { skipped.push({ row: rowNo, reason: 'No name.' }); continue; }
    if (!tr) { skipped.push({ row: rowNo, reason: `No TR number for ${name}.` }); continue; }
    if (tr.length > 50) { skipped.push({ row: rowNo, reason: `TR number too long for ${name}.` }); continue; }
    let branchId = defaultBranchId;
    const branchText = get(col.branch);
    if (branchText) {
      const match = matchBranchName(branchText, names);
      if (!match) { skipped.push({ row: rowNo, reason: `Unknown branch “${branchText}” for ${name}.` }); continue; }
      branchId = branches.find(b => b.name === match)!.id;
    }
    if (!branchId) { skipped.push({ row: rowNo, reason: `No branch for ${name} — choose a branch or add a Branch column.` }); continue; }
    if (allowedBranchIds && !allowedBranchIds.includes(branchId)) { skipped.push({ row: rowNo, reason: `${name} belongs to another branch.` }); continue; }
    const emailRaw = get(col.email).toLowerCase();
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
    if (emailRaw && !email) skipped.push({ row: rowNo, reason: `Email “${emailRaw}” for ${name} does not look right — saved without email.` });
    byKey.set(`${branchId}:${tr.toLowerCase()}`, { branchId, trNumber: tr, name: name.slice(0, 200), className: get(col.cls).slice(0, 100) || null, email });
  }
  return { records: [...byKey.values()], skipped };
}

// ---------------------------------------------------------------- recipients
export type Recipient = { email: string; name: string; kind: 'student' | 'roster' | 'teacher'; ref?: string };

/**
 * Who gets an announcement email. Registered students always; with audience 'roster' also
 * every branch student from the JHS list who has an email (also those not signed up);
 * teachers of the branch when includeTeachers. One email per address.
 */
export function buildRecipients(opts: {
  registered: { email: string | null; name: string; trNumber: string | null; id?: string }[];
  roster: { email: string | null; name: string; trNumber: string; id?: string }[];
  teachers: { email: string | null; name: string; id?: string }[];
  audience: 'registered' | 'roster';
  includeTeachers: boolean;
}): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  const add = (email: string | null, name: string, kind: Recipient['kind'], ref?: string) => {
    const e = (email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return;
    seen.add(e);
    out.push(ref ? { email: e, name, kind, ref } : { email: e, name, kind });
  };
  for (const s of opts.registered) add(s.email, s.name, 'student', s.id ? `u:${s.id}` : undefined);
  if (opts.audience === 'roster') {
    const registeredTr = new Set(opts.registered.map(s => (s.trNumber ?? '').toLowerCase()).filter(Boolean));
    for (const r of opts.roster) {
      if (registeredTr.has(r.trNumber.toLowerCase())) continue; // already emailed at their site address
      add(r.email, r.name, 'roster', r.id ? `r:${r.id}` : undefined);
    }
  }
  if (opts.includeTeachers) for (const t of opts.teachers) add(t.email, t.name, 'teacher', t.id ? `u:${t.id}` : undefined);
  return out;
}

// ---------------------------------------------------------------- announcements input
export type CleanAnnouncement = {
  kind: 'announcement' | 'survey'; title: string; body: string; showOnSite: boolean; sendEmail: boolean;
  audience: 'registered' | 'roster'; includeTeachers: boolean; questions: SurveyQuestion[]; endsAt: Date | null;
  /** v3 audit 17: how it appears on the site — a slim banner (default) or a pop-up. */
  siteStyle?: 'banner' | 'popup';
};

export function cleanQuestions(input: unknown): SurveyQuestion[] | string {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return 'Questions must be a list.';
  if (input.length > 20) return 'Please keep a survey to 20 questions or fewer.';
  const out: SurveyQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const q = input[i] as Partial<SurveyQuestion>;
    const text = String(q?.text ?? '').trim().slice(0, 300);
    if (!text) return `Question ${i + 1} has no words.`;
    const type = q?.type === 'rating' || q?.type === 'text' ? q.type : 'choice';
    const id = /^[a-z0-9_-]{1,24}$/i.test(String(q?.id ?? '')) ? String(q!.id) : `q${i + 1}`;
    if (out.some(o => o.id === id)) return 'Two questions have the same id.';
    const item: SurveyQuestion = { id, text, type, required: q?.required !== false };
    if (type === 'choice') {
      const options = (Array.isArray(q?.options) ? q!.options : []).map(o => String(o ?? '').trim().slice(0, 120)).filter(Boolean);
      if (options.length < 2) return `Question ${i + 1} needs at least two choices.`;
      if (options.length > 10) return `Question ${i + 1} has more than ten choices.`;
      item.options = [...new Set(options)];
    }
    out.push(item);
  }
  return out;
}

export function cleanAnnouncement(input: AnnouncementInput, base?: CleanAnnouncement): CleanAnnouncement | string {
  const kind = input.kind === 'survey' || input.kind === 'announcement' ? input.kind : base?.kind ?? 'announcement';
  const title = (input.title ?? base?.title ?? '').toString().trim().slice(0, 200);
  const body = (input.body ?? base?.body ?? '').toString().trim().slice(0, 5000);
  if (!title) return 'Please give it a title.';
  if (!body) return kind === 'survey' ? 'Please write a short note above the questions.' : 'Please write the message.';
  const showOnSite = input.showOnSite ?? base?.showOnSite ?? true;
  const sendEmail = input.sendEmail ?? base?.sendEmail ?? false;
  if (!showOnSite && !sendEmail) return 'Choose at least one: show on the site, or send by email.';
  const audience = input.audience === 'roster' || input.audience === 'registered' ? input.audience : base?.audience ?? 'registered';
  const includeTeachers = input.includeTeachers ?? base?.includeTeachers ?? true;
  const questions = input.questions !== undefined ? cleanQuestions(input.questions) : base?.questions ?? [];
  if (typeof questions === 'string') return questions;
  if (kind === 'survey' && !questions.length) return 'A survey needs at least one question.';
  let endsAt: Date | null = base?.endsAt ?? null;
  if (input.endsAt !== undefined) {
    endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) return 'The end date is not valid.';
  }
  const siteStyle = input.siteStyle === 'popup' || input.siteStyle === 'banner' ? input.siteStyle : base?.siteStyle ?? 'banner';
  return { kind, title, body, showOnSite: Boolean(showOnSite), sendEmail: Boolean(sendEmail), audience, includeTeachers: Boolean(includeTeachers), questions: kind === 'survey' ? questions : [], endsAt, siteStyle };
}

// ---------------------------------------------------------------- survey answers
export function cleanAnswers(questions: SurveyQuestion[], input: unknown): Record<string, string | number> | string {
  const answers = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const q of questions) {
    const v = answers[q.id];
    const empty = v === undefined || v === null || String(v).trim() === '';
    if (empty) {
      if (q.required !== false) return `Please answer: “${q.text}”`;
      continue;
    }
    if (q.type === 'rating') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return `Please choose 1 to 5 for: “${q.text}”`;
      out[q.id] = n;
    } else if (q.type === 'choice') {
      const s = String(v);
      if (!q.options?.includes(s)) return `Please pick one of the choices for: “${q.text}”`;
      out[q.id] = s;
    } else {
      out[q.id] = String(v).trim().slice(0, 2000);
    }
  }
  return out;
}

export function summariseSurvey(meta: { id: string; title: string; questions: SurveyQuestion[] }, responses: { name: string; answers: Record<string, unknown> }[]): SurveyResults {
  return {
    announcementId: meta.id,
    title: meta.title,
    total: responses.length,
    questions: meta.questions.map(q => {
      const values = responses.map(r => r.answers?.[q.id]).filter(v => v !== undefined && v !== null && v !== '');
      if (q.type === 'text') {
        return { id: q.id, text: q.text, type: q.type, counts: [], average: null, answers: responses.filter(r => r.answers?.[q.id]).slice(-200).reverse().map(r => ({ name: r.name, text: String(r.answers[q.id]) })) };
      }
      const options = q.type === 'rating' ? ['1', '2', '3', '4', '5'] : q.options ?? [];
      const counts = options.map(option => ({ option, n: values.filter(v => String(v) === option).length }));
      const nums = values.map(Number).filter(Number.isFinite);
      const average = q.type === 'rating' && nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
      return { id: q.id, text: q.text, type: q.type, counts, average, answers: [] };
    }),
  };
}

// ---------------------------------------------------------------- survey links (no sign-in)
/**
 * A survey link in an email: `/#survey?t=<token>`. The token names the survey and the person
 * (`u:<userId>` for site users, `r:<rosterId>` for JHS-roster students who are not signed up) and is
 * signed with the server secret, so it cannot be guessed or changed. It never expires on its own —
 * closing the survey (or its end date) closes every link.
 */
export type SurveyTokenData = { surveyId: string; ref: string; kind: 'user' | 'roster'; id: string };

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function tokenSig(secret: string, body: string): string {
  return b64url(createHmac('sha256', `survey-link:${secret}`).update(body).digest()).slice(0, 32);
}

export function signSurveyToken(secret: string, surveyId: string, ref: string): string {
  const body = b64url(Buffer.from(`${surveyId}~${ref}`, 'utf8'));
  return `${body}.${tokenSig(secret, body)}`;
}

export function verifySurveyToken(secret: string, token: unknown): SurveyTokenData | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [body, sig, extra] = token.trim().split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = tokenSig(secret, body);
  const a = Buffer.from(sig); const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let raw = '';
  try { raw = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
  const m = /^([0-9a-f-]{36})~([ur]):([0-9a-f-]{36})$/i.exec(raw);
  if (!m) return null;
  return { surveyId: m[1], ref: `${m[2]}:${m[3]}`, kind: m[2] === 'u' ? 'user' : 'roster', id: m[3] };
}

// ---------------------------------------------------------------- people & roles
export function personRole(row: { role: string; admin_scope?: string | null }): PersonRole {
  if (row.role === 'admin') return row.admin_scope === 'branch' ? 'branch_admin' : 'master_admin';
  if (row.role === 'teacher') return 'teacher';
  return 'student';
}

export function roleColumns(role: PersonRole): { role: 'student' | 'teacher' | 'admin'; adminScope: 'master' | 'branch' } {
  if (role === 'master_admin') return { role: 'admin', adminScope: 'master' };
  if (role === 'branch_admin') return { role: 'admin', adminScope: 'branch' };
  return { role, adminScope: 'master' };
}

export const ROLE_WORDS: Record<PersonRole, string> = {
  student: 'Student', teacher: 'Teacher', branch_admin: 'Branch admin', master_admin: 'Master admin',
};

/**
 * May this role change happen? Plain-words reason when not.
 *  - only master admins change roles
 *  - nobody changes their own role (so the last master cannot lock everyone out)
 *  - the last master admin cannot be moved down
 *  - staff are never turned back into students here (their records would mix) — remove access in Data governance
 */
export function checkRoleChange(opts: { actorIsMaster: boolean; actorId: string; targetId: string; from: PersonRole; to: PersonRole; masterCount: number }): string | null {
  if (!opts.actorIsMaster) return 'Only the master admin team can change roles.';
  if (opts.actorId === opts.targetId && opts.from !== opts.to) return 'You cannot change your own role — ask another master admin.';
  if (opts.from === 'master_admin' && opts.to !== 'master_admin' && opts.masterCount <= 1) return 'There must always be at least one master admin.';
  if (opts.from !== 'student' && opts.to === 'student') return 'Staff cannot be turned into students here.';
  return null;
}

// ---------------------------------------------------------------- policy change wording
/** "Marol / Mumbai: setting print.instructions changed …" → the policy key, if any. */
export function policyKeyFromEntity(entityId: string): string | null {
  const i = entityId.indexOf(':');
  return i >= 0 ? entityId.slice(i + 1) : null;
}

// ---------------------------------------------------------------- merit export rows
export type MeritExportEntry = { studentName: string; trNumber: string | null; branchName: string | null; className?: string | null; sourceLabel: string; points: number; earnedMonth: string; status: string; givenByName: string | null; givenAt: string | null };

export function meritExportTable(entries: MeritExportEntry[]): { header: string[]; rows: (string | number)[][]; totals: { students: number; points: number } } {
  const header = ['Student', 'TR number', 'Class', 'Branch', 'For', 'Points', 'Month', 'Status', 'Given by', 'Given on'];
  const sorted = [...entries].sort((a, b) => (a.branchName ?? '').localeCompare(b.branchName ?? '') || a.studentName.localeCompare(b.studentName) || a.earnedMonth.localeCompare(b.earnedMonth));
  const rows = sorted.map(e => [
    e.studentName, e.trNumber ?? '', e.className ?? '', e.branchName ?? '', e.sourceLabel, e.points, e.earnedMonth,
    e.status === 'given' ? 'Given' : e.status === 'void' ? 'Cancelled' : 'To give', e.givenByName ?? '', e.givenAt ? e.givenAt.slice(0, 10) : '',
  ]);
  return { header, rows, totals: { students: new Set(entries.map(e => `${e.studentName}|${e.trNumber}`)).size, points: entries.reduce((s, e) => s + e.points, 0) } };
}
