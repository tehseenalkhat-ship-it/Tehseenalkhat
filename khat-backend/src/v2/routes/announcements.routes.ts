import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../../db.js';
import { config } from '../../config.js';
import { canManageBranch, getActor, requireAnyAdmin, requireMaster, type Actor } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { parseCsv } from '../lib/csv.js';
import {
  buildRecipients, cleanAnnouncement, cleanAnswers, parseRosterRows, signSurveyToken, summariseSurvey, verifySurveyToken, type CleanAnnouncement,
} from '../lib/commsLogic.js';
import type {
  ActiveAnnouncement, Announcement, AnnouncementInput, AudiencePreview, EmailQueueStatus, EmailTemplateRow,
  RosterImportResult, RosterRow, RosterSummary, SurveyQuestion, SurveyResults,
} from '../lib/commsTypes.js';
import {
  appUrl, DEFAULT_TEMPLATES, EMAIL_DAILY_CAP, EMAIL_KEYS, EMAIL_PER_RUN, isEmailKey, loadTemplate, queueEmail, queueEmailMany,
  renderWith, sentInLast24h,
} from '../lib/emailTemplates.js';
import { iso } from '../lib/threadData.js';
import { readXlsx } from '../lib/xlsx.js';

// owner: admin-comms (v3) — announcements & surveys, email templates + queue, JHS student roster.
// Registered under prefix '/v2'.

function bad(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

async function allBranches(): Promise<{ id: string; name: string }[]> {
  const { rows } = await pool.query(`SELECT id, name FROM branches ORDER BY name`);
  return rows.map((r: any) => ({ id: String(r.id), name: String(r.name) }));
}

const ANN_SELECT = `SELECT a.*, b.name AS branch_name, u.name AS created_by_name,
    (SELECT COUNT(*) FROM announcement_seen s WHERE s.announcement_id = a.id) AS seen_count,
    (SELECT COUNT(*) FROM survey_responses r WHERE r.announcement_id = a.id) AS response_count
  FROM announcements a LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN users u ON u.id = a.created_by`;

function mapAnnouncement(r: any, actor: Actor): Announcement {
  return {
    id: r.id, kind: r.kind === 'survey' ? 'survey' : 'announcement', title: r.title, body: r.body,
    branchId: r.branch_id ?? null, branchName: r.branch_name ?? null,
    showOnSite: Boolean(r.show_on_site), sendEmail: Boolean(r.send_email), siteStyle: r.site_style === 'popup' ? 'popup' : 'banner',
    audience: r.audience === 'roster' ? 'roster' : 'registered', includeTeachers: Boolean(r.include_teachers),
    questions: parseJson<SurveyQuestion[]>(r.questions, []),
    status: r.status === 'published' || r.status === 'closed' ? r.status : 'draft',
    endsAt: iso(r.ends_at), createdAt: iso(r.created_at) ?? new Date(0).toISOString(), publishedAt: iso(r.published_at),
    createdByName: r.created_by_name ?? null, emailsQueued: Number(r.emails_queued ?? 0),
    seenCount: Number(r.seen_count ?? 0), responseCount: Number(r.response_count ?? 0),
    canEdit: actor.isMaster || (r.branch_id !== null && canManageBranch(actor, r.branch_id)),
  };
}

function toClean(a: Announcement): CleanAnnouncement {
  return {
    kind: a.kind, title: a.title, body: a.body, showOnSite: a.showOnSite, sendEmail: a.sendEmail, audience: a.audience,
    includeTeachers: a.includeTeachers, questions: a.questions, endsAt: a.endsAt ? new Date(a.endsAt) : null, siteStyle: a.siteStyle,
  };
}

async function loadAnnouncement(id: string, actor: Actor): Promise<Announcement | null> {
  const { rows } = await pool.query(`${ANN_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? mapAnnouncement(rows[0], actor) : null;
}

/** People in scope of an announcement (branch or all branches). */
async function audienceLists(branchId: string | null) {
  const where = branchId ? `AND branch_id = $1` : '';
  const params = branchId ? [branchId] : [];
  const [registered, roster, teachers] = await Promise.all([
    pool.query(`SELECT id, name, email, tr_number, branch_id FROM users WHERE role = 'student' AND deleted_at IS NULL ${where}`, params),
    pool.query(`SELECT id, name, email, tr_number FROM student_roster WHERE 1 = 1 ${where}`, params),
    pool.query(`SELECT id, name, email FROM users WHERE deleted_at IS NULL AND (role = 'teacher' OR (role = 'admin' AND admin_scope = 'branch')) ${where}`, params),
  ]);
  return {
    registered: registered.rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? ''), email: r.email ?? null, trNumber: r.tr_number ?? null })),
    roster: roster.rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? ''), email: r.email ?? null, trNumber: String(r.tr_number ?? '') })),
    teachers: teachers.rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? ''), email: r.email ?? null })),
  };
}

// ---------------------------------------------------------------- email queue timer
// Started here (not in server.ts) so the email queue owns its own schedule: every 2 minutes a
// few queued emails go out (capped per run and per day — see emailTemplates.ts).

export async function announcementsV2Routes(app: FastifyInstance): Promise<void> {
  const admins = { preHandler: [app.authenticate, requireAnyAdmin(app)] };
  const master = { preHandler: [app.authenticate, requireMaster(app)] };

  // The email queue is sent by the background job runner in server.ts.

  // ================================================================ announcements & surveys (admin)
  app.get<{ Querystring: { kind?: string } }>('/announcements', admins, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [];
    let where = '1 = 1';
    if (!actor.isMaster) { params.push(actor.branchId); where = `(a.branch_id IS NULL OR a.branch_id = $1)`; }
    if (request.query.kind === 'survey' || request.query.kind === 'announcement') {
      params.push(request.query.kind);
      where += ` AND a.kind = $${params.length}`;
    }
    const { rows } = await pool.query(`${ANN_SELECT} WHERE ${where} ORDER BY (a.status = 'draft') DESC, COALESCE(a.published_at, a.created_at) DESC LIMIT 200`, params);
    return rows.map((r: any) => mapAnnouncement(r, actor)) as Announcement[];
  });

  app.get<{ Querystring: { branchId?: string; audience?: string; includeTeachers?: string } }>('/announcements/audience', admins, async (request, reply) => {
    const actor = await getActor(request);
    const branchId = actor.isMaster ? request.query.branchId || null : actor.branchId;
    if (branchId && !canManageBranch(actor, branchId)) return bad(reply, 403, 'You can only write to your own branch.');
    const lists = await audienceLists(branchId);
    const audience = request.query.audience === 'roster' ? 'roster' : 'registered';
    const includeTeachers = request.query.includeTeachers !== '0';
    const recipients = buildRecipients({ ...lists, audience, includeTeachers });
    const registeredTr = new Set(lists.registered.map(s => (s.trNumber ?? '').toLowerCase()).filter(Boolean));
    const notRegistered = audience === 'roster' ? lists.roster.filter(r => !registeredTr.has(r.trNumber.toLowerCase())).length : 0;
    const totalPeople = lists.registered.length + notRegistered + (includeTeachers ? lists.teachers.length : 0);
    const body: AudiencePreview = {
      students: lists.registered.length + notRegistered, notRegistered,
      teachers: includeTeachers ? lists.teachers.length : 0,
      withEmail: recipients.length, withoutEmail: Math.max(0, totalPeople - recipients.length),
    };
    return body;
  });

  app.post<{ Body: AnnouncementInput }>('/announcements', admins, async (request, reply) => {
    const actor = await getActor(request);
    const input = request.body ?? {};
    const branchId = actor.isMaster ? (input.branchId || null) : actor.branchId;
    if (branchId && !canManageBranch(actor, branchId)) return bad(reply, 403, 'You can only write to your own branch.');
    const clean = cleanAnnouncement(input);
    if (typeof clean === 'string') return bad(reply, 400, clean);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO announcements (id, kind, title, body, branch_id, show_on_site, send_email, audience, include_teachers, questions, status, ends_at, created_by, site_style)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13)`,
      [id, clean.kind, clean.title, clean.body, branchId, clean.showOnSite, clean.sendEmail, clean.audience, clean.includeTeachers, JSON.stringify(clean.questions), clean.endsAt, actor.id, clean.siteStyle ?? 'banner'],
    );
    await logAudit({ actorId: actor.id, branchId, action: `${clean.kind}.create`, entityType: 'announcement', entityId: id, summary: `${clean.kind === 'survey' ? 'Survey' : 'Announcement'} drafted: ${clean.title}` });
    return reply.code(201).send(await loadAnnouncement(id, actor));
  });

  app.patch<{ Params: { id: string }; Body: AnnouncementInput }>('/announcements/:id', admins, async (request, reply) => {
    const actor = await getActor(request);
    const current = await loadAnnouncement(request.params.id, actor);
    if (!current) return bad(reply, 404, 'This announcement was not found.');
    if (!current.canEdit) return bad(reply, 403, 'Only the branch that wrote this (or the master team) can change it.');
    const input = request.body ?? {};
    if (current.status !== 'draft' && (input.kind !== undefined || input.questions !== undefined || input.audience !== undefined)) {
      return bad(reply, 409, 'Once sent, only the words and the end date can change.');
    }
    const clean = cleanAnnouncement(input, toClean(current));
    if (typeof clean === 'string') return bad(reply, 400, clean);
    let branchId = current.branchId;
    if (current.status === 'draft' && actor.isMaster && input.branchId !== undefined) branchId = input.branchId || null;
    await pool.query(
      `UPDATE announcements SET kind = $1, title = $2, body = $3, branch_id = $4, show_on_site = $5, send_email = $6, audience = $7,
         include_teachers = $8, questions = $9, ends_at = $10, updated_at = $11, site_style = $13 WHERE id = $12`,
      [clean.kind, clean.title, clean.body, branchId, clean.showOnSite, clean.sendEmail, clean.audience, clean.includeTeachers, JSON.stringify(clean.questions), clean.endsAt, new Date(), current.id, clean.siteStyle ?? 'banner'],
    );
    return loadAnnouncement(current.id, actor);
  });

  app.post<{ Params: { id: string } }>('/announcements/:id/publish', admins, async (request, reply) => {
    const actor = await getActor(request);
    const a = await loadAnnouncement(request.params.id, actor);
    if (!a) return bad(reply, 404, 'This announcement was not found.');
    if (!a.canEdit) return bad(reply, 403, 'Only the branch that wrote this (or the master team) can send it.');
    if (a.status !== 'draft') return bad(reply, 409, 'This has already been sent.');
    const now = new Date();
    const res = await pool.query(`UPDATE announcements SET status = 'published', published_at = $1, updated_at = $1 WHERE id = $2 AND status = 'draft'`, [now, a.id]);
    if (!res.rowCount) return bad(reply, 409, 'This has already been sent.');

    const lists = await audienceLists(a.branchId);
    let queued = 0;
    if (a.sendEmail) {
      const recipients = buildRecipients({ ...lists, audience: a.audience, includeTeachers: a.includeTeachers });
      queued = await queueEmailMany(
        recipients.map(r => ({
          to: r.email,
          vars: {
            name: r.name.split(/\s+/)[0], title: a.title, message: a.body, branch: a.branchName ?? 'all branches',
            // surveys: a personal link that opens the questions without signing in (one answer per person)
            link: a.kind === 'survey' && r.ref ? appUrl(`survey?t=${signSurveyToken(config.jwtSecret, a.id, r.ref)}`) : appUrl(r.kind === 'roster' ? 'login' : 'dashboard'),
          },
        })),
        a.kind === 'survey' ? 'survey' : 'announcement',
        { refType: 'announcement', refId: a.id, branchId: a.branchId },
      );
      await pool.query(`UPDATE announcements SET emails_queued = $1 WHERE id = $2`, [queued, a.id]);
    }
    // No bell pop-up: the site banner (GET /announcements/active) shows it once, and email covers the rest.
    await logAudit({
      actorId: actor.id, branchId: a.branchId, action: `${a.kind}.publish`, entityType: 'announcement', entityId: a.id,
      summary: `${a.kind === 'survey' ? 'Survey' : 'Announcement'} sent: ${a.title}${a.sendEmail ? ` — ${queued} emails queued` : ''}`,
    });
    return { announcement: await loadAnnouncement(a.id, actor), emailsQueued: queued };
  });

  app.post<{ Params: { id: string } }>('/announcements/:id/close', admins, async (request, reply) => {
    const actor = await getActor(request);
    const a = await loadAnnouncement(request.params.id, actor);
    if (!a) return bad(reply, 404, 'This announcement was not found.');
    if (!a.canEdit) return bad(reply, 403, 'Only the branch that wrote this (or the master team) can close it.');
    await pool.query(`UPDATE announcements SET status = 'closed', updated_at = $1 WHERE id = $2`, [new Date(), a.id]);
    return loadAnnouncement(a.id, actor);
  });

  app.delete<{ Params: { id: string } }>('/announcements/:id', admins, async (request, reply) => {
    const actor = await getActor(request);
    const a = await loadAnnouncement(request.params.id, actor);
    if (!a) return bad(reply, 404, 'This announcement was not found.');
    if (!a.canEdit) return bad(reply, 403, 'Only the branch that wrote this (or the master team) can delete it.');
    if (a.status !== 'draft') return bad(reply, 409, 'Sent announcements are kept — close it instead.');
    await pool.query(`DELETE FROM announcements WHERE id = $1 AND status = 'draft'`, [a.id]);
    return { deleted: true };
  });

  // ================================================================ banner (everyone signed in)
  app.get('/announcements/active', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    if (actor.isMaster) return [] as ActiveAnnouncement[];
    const isStaff = actor.role !== 'student';
    const { rows } = await pool.query(
      `SELECT a.*, b.name AS branch_name,
          (SELECT COUNT(*) FROM survey_responses r WHERE r.announcement_id = a.id AND r.user_id = $1) AS answered
         FROM announcements a LEFT JOIN branches b ON b.id = a.branch_id
        WHERE a.status = 'published' AND a.show_on_site = 1
          AND (a.branch_id IS NULL OR a.branch_id = $2)
          AND (a.ends_at IS NULL OR a.ends_at > $3)
          AND ($4 = 0 OR a.include_teachers = 1)
          AND NOT EXISTS (SELECT 1 FROM announcement_seen s WHERE s.announcement_id = a.id AND s.user_id = $1)
        ORDER BY a.published_at DESC LIMIT 5`,
      [actor.id, actor.branchId, new Date(), isStaff ? 1 : 0],
    );
    return rows.map((r: any): ActiveAnnouncement => ({
      id: r.id, kind: r.kind === 'survey' ? 'survey' : 'announcement', title: r.title, body: r.body, branchName: r.branch_name ?? null,
      questions: parseJson<SurveyQuestion[]>(r.questions, []), answered: Number(r.answered ?? 0) > 0,
      publishedAt: iso(r.published_at), endsAt: iso(r.ends_at), siteStyle: r.site_style === 'popup' ? 'popup' : 'banner',
    })).filter(a => !(a.kind === 'survey' && a.answered));
  });

  app.post<{ Params: { id: string } }>('/announcements/:id/seen', { preHandler: [app.authenticate] }, async request => {
    const actor = await getActor(request);
    await pool.query(
      `INSERT INTO announcement_seen (announcement_id, user_id, seen_at) VALUES ($1, $2, $3) ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at)`,
      [request.params.id, actor.id, new Date()],
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { answers?: unknown } }>('/surveys/:id/responses', { preHandler: [app.authenticate] }, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT * FROM announcements WHERE id = $1 AND kind = 'survey'`, [request.params.id]);
    const s = rows[0];
    if (!s) return bad(reply, 404, 'This survey was not found.');
    if (s.status !== 'published' || (s.ends_at && new Date(s.ends_at) <= new Date())) return bad(reply, 409, 'This survey is closed. Thank you all the same!');
    if (s.branch_id && s.branch_id !== actor.branchId && !actor.isMaster) return bad(reply, 403, 'This survey is for another branch.');
    const answers = cleanAnswers(parseJson<SurveyQuestion[]>(s.questions, []), request.body?.answers);
    if (typeof answers === 'string') return bad(reply, 400, answers);
    await pool.query(
      `INSERT INTO survey_responses (id, announcement_id, user_id, answers) VALUES ($1, $2, $3, $4)
       ON DUPLICATE KEY UPDATE answers = VALUES(answers), created_at = CURRENT_TIMESTAMP(6)`,
      [randomUUID(), s.id, actor.id, JSON.stringify(answers)],
    );
    await pool.query(`INSERT INTO announcement_seen (announcement_id, user_id, seen_at) VALUES ($1, $2, $3) ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at)`, [s.id, actor.id, new Date()]);
    return { ok: true };
  });

  // ================================================================ survey by emailed link (no sign-in)
  // `/#survey?t=<token>` — roster students who are not registered (and anyone emailed) answer here.
  type LinkTarget = { survey: any; respondentId: string; name: string; branchId: string | null };
  async function surveyFromToken(token: unknown): Promise<LinkTarget | string> {
    const data = verifySurveyToken(config.jwtSecret, token);
    if (!data) return 'This survey link is not valid. Please use the link in your email.';
    const { rows } = await pool.query(`SELECT a.*, b.name AS branch_name FROM announcements a LEFT JOIN branches b ON b.id = a.branch_id WHERE a.id = $1 AND a.kind = 'survey'`, [data.surveyId]);
    const survey = rows[0];
    if (!survey || survey.status === 'draft') return 'This survey was not found.';
    if (data.kind === 'user') {
      const { rows: u } = await pool.query(`SELECT id, name, branch_id FROM users WHERE id = $1 AND deleted_at IS NULL`, [data.id]);
      if (!u[0]) return 'This survey link is no longer valid.';
      return { survey, respondentId: String(u[0].id), name: String(u[0].name ?? ''), branchId: u[0].branch_id ?? null };
    }
    const { rows: r } = await pool.query(`SELECT id, name, branch_id, tr_number FROM student_roster WHERE id = $1`, [data.id]);
    if (!r[0]) return 'This survey link is no longer valid.';
    // a roster student who has since signed up answers once, as their site account
    const { rows: reg } = await pool.query(
      `SELECT id FROM users WHERE role = 'student' AND deleted_at IS NULL AND branch_id = $1 AND tr_number = $2 LIMIT 1`,
      [r[0].branch_id, r[0].tr_number],
    );
    return { survey, respondentId: String(reg[0]?.id ?? r[0].id), name: String(r[0].name ?? ''), branchId: r[0].branch_id ?? null };
  }
  const isClosed = (s: any) => s.status !== 'published' || (s.ends_at && new Date(s.ends_at) <= new Date());

  app.get<{ Querystring: { t?: string } }>('/surveys/by-link', async (request, reply) => {
    const target = await surveyFromToken(request.query.t);
    if (typeof target === 'string') return bad(reply, 404, target);
    const { survey: s, respondentId, name, branchId } = target;
    if (s.branch_id && branchId && s.branch_id !== branchId) return bad(reply, 403, 'This survey is for another branch.');
    const { rows } = await pool.query(`SELECT answers, created_at FROM survey_responses WHERE announcement_id = $1 AND user_id = $2`, [s.id, respondentId]);
    return {
      id: s.id, title: s.title, body: s.body, branchName: s.branch_name ?? null,
      firstName: name.split(/\s+/)[0] || null,
      questions: parseJson<SurveyQuestion[]>(s.questions, []),
      closed: Boolean(isClosed(s)),
      answered: Boolean(rows[0]),
      answers: rows[0] ? parseJson<Record<string, unknown>>(rows[0].answers, {}) : null,
      endsAt: iso(s.ends_at),
    };
  });

  app.post<{ Body: { t?: string; answers?: unknown } }>('/surveys/by-link', async (request, reply) => {
    const target = await surveyFromToken(request.body?.t);
    if (typeof target === 'string') return bad(reply, 404, target);
    const { survey: s, respondentId, branchId } = target;
    if (isClosed(s)) return bad(reply, 409, 'This survey is closed. Thank you all the same!');
    if (s.branch_id && branchId && s.branch_id !== branchId) return bad(reply, 403, 'This survey is for another branch.');
    const answers = cleanAnswers(parseJson<SurveyQuestion[]>(s.questions, []), request.body?.answers);
    if (typeof answers === 'string') return bad(reply, 400, answers);
    // one answer per person: answering again replaces the earlier answer
    await pool.query(
      `INSERT INTO survey_responses (id, announcement_id, user_id, answers) VALUES ($1, $2, $3, $4)
       ON DUPLICATE KEY UPDATE answers = VALUES(answers), created_at = CURRENT_TIMESTAMP(6)`,
      [randomUUID(), s.id, respondentId, JSON.stringify(answers)],
    );
    await pool.query(`INSERT INTO announcement_seen (announcement_id, user_id, seen_at) VALUES ($1, $2, $3) ON DUPLICATE KEY UPDATE seen_at = VALUES(seen_at)`, [s.id, respondentId, new Date()]);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/surveys/:id/results', admins, async (request, reply) => {
    const actor = await getActor(request);
    const a = await loadAnnouncement(request.params.id, actor);
    if (!a || a.kind !== 'survey') return bad(reply, 404, 'This survey was not found.');
    if (!actor.isMaster && a.branchId && a.branchId !== actor.branchId) return bad(reply, 403, 'This survey belongs to another branch.');
    const params: unknown[] = [a.id];
    let scope = '';
    if (!actor.isMaster) { params.push(actor.branchId); scope = `AND COALESCE(u.branch_id, sr.branch_id) = $2`; }
    // answers from site users and from JHS-roster students who answered by the emailed link
    const { rows } = await pool.query(
      `SELECT r.answers, COALESCE(u.name, sr.name) AS name FROM survey_responses r
         LEFT JOIN users u ON u.id = r.user_id LEFT JOIN student_roster sr ON sr.id = r.user_id
        WHERE r.announcement_id = $1 AND (u.id IS NOT NULL OR sr.id IS NOT NULL) ${scope} ORDER BY r.created_at ASC`,
      params,
    );
    return summariseSurvey({ id: a.id, title: a.title, questions: a.questions }, rows.map((r: any) => ({ name: String(r.name ?? ''), answers: parseJson<Record<string, unknown>>(r.answers, {}) }))) as SurveyResults;
  });

  // ================================================================ email templates
  app.get('/email-templates', admins, async () => {
    const out: EmailTemplateRow[] = [];
    for (const key of EMAIL_KEYS) {
      const def = DEFAULT_TEMPLATES[key];
      const t = await loadTemplate(key);
      out.push({ key, label: def.label, group: def.group, description: def.description, vars: def.vars, subject: t.subject, body: t.body, isCustom: t.isCustom, updatedAt: t.updatedAt, defaultSubject: def.subject, defaultBody: def.body });
    }
    return out;
  });

  app.put<{ Params: { key: string }; Body: { subject?: string; body?: string } }>('/email-templates/:key', master, async (request, reply) => {
    const actor = await getActor(request);
    const key = request.params.key;
    if (!isEmailKey(key)) return bad(reply, 404, 'Unknown email.');
    const subject = String(request.body?.subject ?? '').trim().slice(0, 290);
    const body = String(request.body?.body ?? '').trim().slice(0, 8000);
    if (!subject) return bad(reply, 400, 'Please write a subject line.');
    if (!body) return bad(reply, 400, 'Please write the email.');
    await pool.query(
      `INSERT INTO email_templates (template_key, subject, body, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [key, subject, body, actor.id, new Date()],
    );
    await logAudit({ actorId: actor.id, action: 'email_template.set', entityType: 'email_template', entityId: key, summary: `Email “${DEFAULT_TEMPLATES[key].label}” wording changed`, after: { subject, body } });
    return { ok: true };
  });

  app.delete<{ Params: { key: string } }>('/email-templates/:key', master, async (request, reply) => {
    const actor = await getActor(request);
    const key = request.params.key;
    if (!isEmailKey(key)) return bad(reply, 404, 'Unknown email.');
    await pool.query(`DELETE FROM email_templates WHERE template_key = $1`, [key]);
    await logAudit({ actorId: actor.id, action: 'email_template.reset', entityType: 'email_template', entityId: key, summary: `Email “${DEFAULT_TEMPLATES[key].label}” back to the standard wording` });
    return { ok: true };
  });

  app.post<{ Body: { key?: string; subject?: string; body?: string } }>('/email-templates/preview', admins, async (request, reply) => {
    const key = String(request.body?.key ?? '');
    if (!isEmailKey(key)) return bad(reply, 404, 'Unknown email.');
    const def = DEFAULT_TEMPLATES[key];
    return renderWith({ subject: request.body?.subject ?? def.subject, body: request.body?.body ?? def.body }, SAMPLE_VARS);
  });

  app.post<{ Params: { key: string } }>('/email-templates/:key/test', admins, async (request, reply) => {
    const actor = await getActor(request);
    const key = request.params.key;
    if (!isEmailKey(key)) return bad(reply, 404, 'Unknown email.');
    const ok = await queueEmail(actor.email, key, { ...SAMPLE_VARS, name: actor.name }, { refType: 'template_test', refId: key });
    if (!ok) return bad(reply, 400, 'Your account has no email address we can use.');
    return { ok: true, to: actor.email };
  });

  app.get('/email-queue', admins, async request => {
    const actor = await getActor(request);
    const params: unknown[] = [];
    let where = '1 = 1';
    if (!actor.isMaster) { params.push(actor.branchId); where = `branch_id = $1`; }
    const [recent, counts, sent] = await Promise.all([
      pool.query(`SELECT id, to_email, template_key, subject, status, created_at, sent_at, last_error FROM email_queue WHERE ${where} ORDER BY created_at DESC LIMIT 40`, params),
      pool.query(`SELECT status, COUNT(*) AS n FROM email_queue WHERE ${where} GROUP BY status`, params),
      sentInLast24h(),
    ]);
    const count = (s: string) => Number(counts.rows.find((r: any) => r.status === s)?.n ?? 0);
    const body: EmailQueueStatus = {
      dailyCap: EMAIL_DAILY_CAP, perRun: EMAIL_PER_RUN, sentLast24h: sent, waiting: count('queued'), failed: count('failed'),
      recent: recent.rows.map((r: any) => ({
        id: r.id, to: actor.isMaster ? r.to_email : r.to_email.replace(/^(.{2}).*(@.*)$/, '$1…$2'), templateKey: r.template_key, subject: r.subject,
        status: r.status === 'sent' || r.status === 'failed' ? r.status : 'queued', createdAt: iso(r.created_at) ?? '', sentAt: iso(r.sent_at), lastError: r.last_error ?? null,
      })),
    };
    return body;
  });

  app.post('/email-queue/retry-failed', master, async () => {
    const res = await pool.query(`UPDATE email_queue SET status = 'queued', attempts = 0 WHERE status = 'failed'`);
    return { requeued: res.rowCount };
  });

  // ================================================================ JHS student roster
  const rosterScope = (actor: Actor, requested?: string | null): string | null => (actor.isMaster ? requested || null : actor.branchId);

  app.get('/roster/summary', admins, async request => {
    const actor = await getActor(request);
    const branches = (await allBranches()).filter(b => actor.isMaster || b.id === actor.branchId);
    const { rows } = await pool.query(
      `SELECT r.branch_id, COUNT(*) AS total, SUM(CASE WHEN r.email IS NOT NULL AND r.email <> '' THEN 1 ELSE 0 END) AS with_email,
              SUM(CASE WHEN EXISTS (SELECT 1 FROM users u WHERE u.tr_number = r.tr_number AND u.deleted_at IS NULL) THEN 1 ELSE 0 END) AS registered,
              MAX(r.updated_at) AS last_import
         FROM student_roster r GROUP BY r.branch_id`,
    );
    const by = new Map(rows.map((r: any) => [String(r.branch_id), r]));
    const body: RosterSummary = {
      branches: branches.map(b => {
        const r: any = by.get(b.id);
        return { branchId: b.id, branchName: b.name, total: Number(r?.total ?? 0), withEmail: Number(r?.with_email ?? 0), registered: Number(r?.registered ?? 0), lastImport: iso(r?.last_import) };
      }),
    };
    return body;
  });

  app.get<{ Querystring: { branchId?: string; q?: string; limit?: string; offset?: string } }>('/roster', admins, async request => {
    const actor = await getActor(request);
    const branchId = rosterScope(actor, request.query.branchId);
    const params: unknown[] = [];
    const cond: string[] = [];
    if (branchId) { params.push(branchId); cond.push(`r.branch_id = $${params.length}`); }
    const q = (request.query.q ?? '').trim();
    if (q) { params.push(`%${q}%`); cond.push(`(r.name LIKE $${params.length} OR r.tr_number LIKE $${params.length} OR r.email LIKE $${params.length} OR r.class_name LIKE $${params.length})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Number(request.query.limit) || 100));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    const [list, total] = await Promise.all([
      pool.query(
        `SELECT r.*, b.name AS branch_name, EXISTS (SELECT 1 FROM users u WHERE u.tr_number = r.tr_number AND u.deleted_at IS NULL) AS registered
           FROM student_roster r JOIN branches b ON b.id = r.branch_id ${where} ORDER BY b.name, r.class_name, r.name LIMIT ${limit} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*) AS n FROM student_roster r ${where}`, params),
    ]);
    const rows: RosterRow[] = list.rows.map((r: any) => ({
      id: r.id, branchId: r.branch_id, branchName: r.branch_name, trNumber: r.tr_number, name: r.name, className: r.class_name ?? null,
      email: r.email ?? null, registered: Boolean(Number(r.registered ?? 0)), updatedAt: iso(r.updated_at),
    }));
    return { rows, total: Number(total.rows[0]?.n ?? 0) };
  });

  /**
   * Import the JHS export. Body: { branchId?, csvText? | xlsxBase64? | rows? }.
   * `rows` (array of objects with name, tr, class, branch, email) is the shape a future JHS
   * API sync can post directly. Existing students (same branch + TR) are updated, never duplicated.
   */
  app.post<{ Body: { branchId?: string | null; csvText?: string; xlsxBase64?: string; rows?: Record<string, unknown>[]; fileName?: string } }>(
    '/roster/import', { ...admins, bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
      const actor = await getActor(request);
      const body = request.body ?? {};
      const branches = await allBranches();
      const defaultBranch = rosterScope(actor, body.branchId ?? null);
      if (defaultBranch && !branches.some(b => b.id === defaultBranch)) return bad(reply, 404, 'Branch not found.');
      let table: string[][];
      try {
        if (body.xlsxBase64) table = readXlsx(Buffer.from(body.xlsxBase64.replace(/^data:[^,]*,/, ''), 'base64'));
        else if (typeof body.csvText === 'string') table = parseCsv(body.csvText);
        else if (Array.isArray(body.rows)) {
          const keys = ['name', 'tr', 'class', 'branch', 'email'];
          table = [keys, ...body.rows.map(r => [r.name, r.tr ?? r.trNumber ?? r.tr_number, r.class ?? r.className, r.branch ?? r.branchName, r.email].map(v => (v === null || v === undefined ? '' : String(v))))];
        } else return bad(reply, 400, 'Please choose a CSV or Excel file.');
      } catch (error) {
        return bad(reply, 400, error instanceof Error ? error.message : 'Could not read this file.');
      }
      if (table.length > 20_001) return bad(reply, 400, 'Please import at most 20,000 students at a time.');
      const parsed = parseRosterRows(table, branches, defaultBranch, actor.isMaster ? null : [actor.branchId]);
      const result: RosterImportResult = { total: parsed.records.length, added: 0, updated: 0, unchanged: 0, skipped: parsed.skipped };
      if (!parsed.records.length) return result; // nothing usable — the skipped list says why

      // existing rows for the branches involved
      const ids = [...new Set(parsed.records.map(r => r.branchId))];
      const { rows: existing } = await pool.query(
        `SELECT id, branch_id, tr_number, name, class_name, email FROM student_roster WHERE branch_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids,
      );
      const byKey = new Map(existing.map((r: any) => [`${r.branch_id}:${String(r.tr_number).toLowerCase()}`, r]));
      const now = new Date();
      const inserts: unknown[][] = [];
      for (const rec of parsed.records) {
        const old: any = byKey.get(`${rec.branchId}:${rec.trNumber.toLowerCase()}`);
        if (!old) { inserts.push([randomUUID(), rec.branchId, rec.trNumber, rec.name, rec.className, rec.email, Array.isArray(body.rows) ? 'api' : 'upload', actor.id, now, now]); continue; }
        const email = rec.email ?? old.email ?? null; // a blank email in the file never wipes a known one
        if (old.name === rec.name && (old.class_name ?? null) === rec.className && (old.email ?? null) === email) { result.unchanged++; continue; }
        await pool.query(`UPDATE student_roster SET name = $1, class_name = $2, email = $3, updated_at = $4, imported_by = $5 WHERE id = $6`, [rec.name, rec.className, email, now, actor.id, old.id]);
        result.updated++;
      }
      for (let i = 0; i < inserts.length; i += 200) {
        const chunk = inserts.slice(i, i + 200);
        const values: unknown[] = [];
        const tuples = chunk.map(r => { const s = values.length; values.push(...r); return `(${r.map((_, n) => `$${s + n + 1}`).join(', ')})`; });
        await pool.query(`INSERT INTO student_roster (id, branch_id, tr_number, name, class_name, email, source, imported_by, created_at, updated_at) VALUES ${tuples.join(', ')}`, values);
        result.added += chunk.length;
      }
      await logAudit({
        actorId: actor.id, branchId: defaultBranch, action: 'roster.import', entityType: 'roster', entityId: defaultBranch ?? 'all',
        summary: `Student list imported${body.fileName ? ` from ${String(body.fileName).slice(0, 80)}` : ''}: ${result.added} new, ${result.updated} updated, ${result.skipped.length} skipped`,
      });
      return result;
    });

  app.delete<{ Params: { id: string } }>('/roster/:id', admins, async (request, reply) => {
    const actor = await getActor(request);
    const { rows } = await pool.query(`SELECT branch_id, name FROM student_roster WHERE id = $1`, [request.params.id]);
    if (!rows[0]) return bad(reply, 404, 'Not found.');
    if (!canManageBranch(actor, rows[0].branch_id)) return bad(reply, 403, 'You can only change your own branch’s list.');
    await pool.query(`DELETE FROM student_roster WHERE id = $1`, [request.params.id]);
    return { deleted: true };
  });

  app.get('/roster/template.csv', admins, async (_request, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="student-list-template.csv"');
    return 'Name,TR,Class,Branch,Email\nFatema Hussain,40231,5,Marol,fatema@example.com\n';
  });
}

const SAMPLE_VARS = {
  name: 'Fatema', course: 'Naskh — Al-Usloob al-Awwal', step: 'Level 1 · Step 3', mark: 8, band: 'pass',
  comment: '"Your alif is standing straight now — keep the same care with the nuqta."', teacher: 'Ustad Ali Hakimuddin',
  title: 'Urs Mubarak exhibition', message: 'Salaam! The calligraphy exhibition opens on Thursday after Maghrib in the Funun al-Quran hall. Please bring one framed piece.',
  branch: 'Nairobi', kind: 'Certification course', link: appUrl('dashboard'),
};
