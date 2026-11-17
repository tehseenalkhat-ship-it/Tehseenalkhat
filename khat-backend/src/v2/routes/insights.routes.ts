import type { FastifyInstance, FastifyReply } from 'fastify';
import { getActor, requireStaff, type Actor } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import { loadStudentRecords, loadTeamReport, matchesQuery, SEGMENTS, toInsight } from '../lib/insightsData.js';
import { clampDays, compareInsights, emptyCounts } from '../lib/insightsLogic.js';
import { deliverNudges, type NudgeResult } from '../services/nudges.js';
import type { InsightsSummary, NudgeRequest, StudentSegment, TeamMember, TeamReport } from '../contracts.js';
import { pool } from '../../db.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { accountabilityStatus, STATUS_ORDER, type AccountabilityStatus } from '../lib/teacherLogic.js';

// owner: insights — smart student progress, gentle nudges, team self-assessment.
// Registered under prefix '/v2'.

/** Response of POST /v2/insights/nudge (not in contracts.ts; see report). */
export type NudgeResponse = NudgeResult & { skipped: number; message: string };

/**
 * Which branch the caller may look at. Teachers, coordinators and branch admins:
 * their own branch only. Master admins: the requested branch, or all (null).
 */
function resolveBranch(actor: Actor, requested: string | undefined, reply: FastifyReply): string | null | false {
  const wanted = requested?.trim() || null;
  if (actor.isMaster) return wanted;
  if (wanted && wanted !== actor.branchId) {
    reply.code(403).send({ error: 'You can only see the students of your own branch.' });
    return false;
  }
  return actor.branchId;
}

export async function insightsV2Routes(app: FastifyInstance): Promise<void> {
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };

  app.get<{ Querystring: { branchId?: string; segment?: string; q?: string; limit?: string; offset?: string } }>(
    '/insights/students', staff, async (request, reply) => {
      const actor = await getActor(request);
      const branchId = resolveBranch(actor, request.query.branchId, reply);
      if (branchId === false) return reply;

      const segment = SEGMENTS.includes(request.query.segment as StudentSegment) ? request.query.segment as StudentSegment : null;
      const q = (request.query.q ?? '').slice(0, 100);
      const limit = Math.min(5000, Math.max(1, Number(request.query.limit) || 50));
      const offset = Math.max(0, Number(request.query.offset) || 0);

      const records = await loadStudentRecords({ branchId });
      const counts = emptyCounts();
      for (const record of records) counts[record.segment] += 1;

      const filtered = records
        .filter(record => (!segment || record.segment === segment) && matchesQuery(record, q))
        .sort(compareInsights);

      const body: InsightsSummary = {
        counts,
        students: filtered.slice(offset, offset + limit).map(toInsight),
        total: filtered.length,
      };
      return body;
    },
  );

  app.post<{ Body: NudgeRequest }>('/insights/nudge', staff, async (request, reply) => {
    const actor = await getActor(request);
    const body = request.body ?? ({} as NudgeRequest);
    const ids = Array.isArray(body.studentIds) ? [...new Set(body.studentIds.filter(id => typeof id === 'string' && id.length <= 64))] : [];
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!ids.length) return reply.code(400).send({ error: 'Choose at least one student.' });
    if (ids.length > 500) return reply.code(400).send({ error: 'Please send to at most 500 students at a time.' });
    if (!message) return reply.code(400).send({ error: 'Please write a message.' });
    if (message.length > 2000) return reply.code(400).send({ error: 'The message is too long (2,000 characters at most).' });

    const records = await loadStudentRecords({ studentIds: ids, branchId: actor.isMaster ? null : actor.branchId });
    const skipped = ids.length - records.length; // not a student, or not in the caller's branch
    if (!records.length) return reply.code(403).send({ error: 'None of these students belong to your branch.' });

    const result = await deliverNudges({
      records,
      template: message,
      sendEmail: Boolean(body.sendEmail),
      kind: 'manual',
      sentBy: actor.id,
      senderName: actor.name,
    });

    await logAudit({
      actorId: actor.id,
      branchId: actor.isMaster ? null : actor.branchId,
      action: 'insights.nudge',
      entityType: 'student_nudge',
      entityId: records.length === 1 ? records[0].studentId : `${records.length} students`,
      summary: `Gentle message sent to ${records.length} student${records.length === 1 ? '' : 's'}${result.emailed ? ` (${result.emailed} by email)` : ''}`,
      after: { studentIds: records.map(r => r.studentId), sendEmail: Boolean(body.sendEmail) },
    });

    const parts = [`Sent to ${result.sent} student${result.sent === 1 ? '' : 's'}.`];
    if (body.sendEmail) parts.push(`${result.emailed} email${result.emailed === 1 ? '' : 's'} sent.`);
    if (result.emailSkipped) parts.push(`${result.emailSkipped} not emailed today (daily email limit) — they still see it in the app.`);
    if (result.failedEmails) parts.push(`${result.failedEmails} email${result.failedEmails === 1 ? '' : 's'} could not be delivered.`);
    if (skipped) parts.push(`${skipped} skipped (not in your branch).`);
    const response: NudgeResponse = { ...result, skipped, message: parts.join(' ') };
    return response;
  });

  app.get<{ Querystring: { branchId?: string; days?: string } }>('/insights/team', staff, async (request, reply) => {
    const actor = await getActor(request);
    const branchId = resolveBranch(actor, request.query.branchId, reply);
    if (branchId === false) return reply;
    const days = clampDays(request.query.days, 30);
    const now = new Date();
    const { branches, team } = await loadTeamReport(branchId, days, now);
    const body: TeamReport = { branches, team, generatedAt: now.toISOString() };
    return body;
  });

  // ---------- v3 (teacher): "Who is responding" — teacher accountability for admins and coordinators ----------
  app.get<{ Querystring: { branchId?: string; days?: string } }>('/insights/accountability', staff, async (request, reply) => {
    const actor = await getActor(request);
    const branchId = resolveBranch(actor, request.query.branchId, reply);
    if (branchId === false) return reply;
    const days = clampDays(request.query.days, 30);
    const now = new Date();
    const { team } = await loadTeamReport(branchId, days, now);
    const ids = team.map(t => t.teacherId);
    const last = new Map<string, Date>();
    const oldest = new Map<string, number>();
    if (ids.length) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
      const [v2, legacy, open] = await Promise.all([
        pool.query(`SELECT reviewed_by AS id, MAX(reviewed_at) AS at FROM step_submissions WHERE auto_marked = 0 AND reviewed_by IN (${ph}) GROUP BY reviewed_by`, ids),
        pool.query(`SELECT reviewed_by AS id, MAX(reviewed_at) AS at FROM entries WHERE reviewed_by IN (${ph}) GROUP BY reviewed_by`, ids).catch(() => ({ rows: [] as any[] })),
        pool.query(`SELECT assigned_teacher_id AS id, MIN(created_at) AS at FROM step_submissions WHERE status IN ('submitted', 'in_review') AND assigned_teacher_id IN (${ph}) GROUP BY assigned_teacher_id`, ids),
      ]);
      for (const r of [...v2.rows, ...legacy.rows]) {
        const at = r.at ? new Date(r.at) : null;
        if (at && !Number.isNaN(at.getTime()) && (!last.has(r.id) || last.get(r.id)! < at)) last.set(r.id, at);
      }
      for (const r of open.rows) if (r.at) oldest.set(r.id, Math.max(0, Math.round((now.getTime() - new Date(r.at).getTime()) / 3_600_000)));
    }
    const divertHours = Number((await getEffectivePolicies(branchId ?? actor.branchId))['review.divert_after_hours']) || 72;
    const teachers: TeacherAccountability[] = team.map(t => {
      const verdict = accountabilityStatus({
        openNow: t.pendingNow, overdueNow: t.overdueNow, oldestWaitingHours: oldest.get(t.teacherId) ?? null,
        reviewed30d: t.reviewed30d, divertedAway30d: t.divertedAway30d, autoMarked30d: t.autoMarked30d,
        lastReviewAt: last.get(t.teacherId) ?? null, now, divertHours,
      });
      return { ...t, oldestWaitingHours: oldest.get(t.teacherId) ?? null, lastReviewAt: last.get(t.teacherId)?.toISOString() ?? null, ...verdict };
    }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.overdueNow - a.overdueNow || a.name.localeCompare(b.name));
    const counts = { not_responding: 0, slow: 0, ok: 0, idle: 0 } as Record<AccountabilityStatus, number>;
    for (const t of teachers) counts[t.status] += 1;
    const body: AccountabilityReport = { days, divertHours, counts, teachers, generatedAt: now.toISOString() };
    return body;
  });
}

/** v3 response types (not in contracts.ts — copied in khat-frontend/src/v2/teacher/teacherTypes.ts). */
export type TeacherAccountability = TeamMember & { oldestWaitingHours: number | null; lastReviewAt: string | null; status: AccountabilityStatus; reason: string };
export type AccountabilityReport = { days: number; divertHours: number; counts: Record<AccountabilityStatus, number>; teachers: TeacherAccountability[]; generatedAt: string };
