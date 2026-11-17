import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../../db.js';
import type { CourseDetail, CourseSummary, StudentCourse } from '../contracts.js';
import { getActor, type Actor } from '../lib/access.js';
import { logAudit } from '../lib/audit.js';
import {
  buildStepStates, chooseMySize, computeProgressPercent, computeUnlockedLevelIds, passedStepIdsFrom, studentCanSeeCourse,
  studentLevels, type SubmissionLite,
} from '../lib/courseLogic.js';
import { inList, loadCourseDetail, loadCourseSummaries, loadStepTypes } from '../lib/courseQueries.js';
import { creditPassedLevels } from '../lib/builderLogic.js';
import { getEffectivePolicies } from '../lib/policies.js';
import { SIZE_CODES, sizeFromText, sizeLabel } from '../lib/naming.js';

async function isEnrolled(studentId: string, courseId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 AS x FROM enrollments WHERE student_id = $1 AND course_id = $2`, [studentId, courseId]);
  return Boolean(rows[0]);
}

async function savedSize(userId: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT mistar_size FROM users WHERE id = $1`, [userId]);
  return rows[0]?.mistar_size ?? null;
}

/** Loads the course for a student (or a staff preview). Sends 404/403 itself and returns null when not allowed. */
async function courseForViewer(actor: Actor, courseId: string, reply: FastifyReply): Promise<{ detail: CourseDetail; enrolled: boolean } | null> {
  const detail = await loadCourseDetail(courseId);
  if (!detail || detail.structureVersion !== 2) { reply.code(404).send({ error: 'Course not found.' }); return null; }
  const enrolled = actor.role === 'student' ? await isEnrolled(actor.id, courseId) : false;
  if (actor.role === 'student') {
    if (!studentCanSeeCourse(detail, actor.branchId, enrolled)) { reply.code(404).send({ error: 'This course is not available to you.' }); return null; }
  } else if (!actor.isMaster && detail.branchIds.length && !detail.branchIds.includes(actor.branchId)) {
    reply.code(403).send({ error: 'This course is not offered in your branch.' }); return null;
  }
  return { detail, enrolled };
}

async function stepLookup(stepId: string) {
  const { rows } = await pool.query(
    `SELECT s.id, s.course_id, s.level_id, s.step_type, s.code, l.code AS level_code FROM level_steps s JOIN levels l ON l.id = s.level_id WHERE s.id = $1`, [stepId]);
  return rows[0] ?? null;
}

// Registered under prefix '/v2'
export async function studentV2Routes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  app.get('/student/courses', auth, async request => {
    const actor = await getActor(request);
    const all = await loadCourseSummaries({ structureVersion: 2, branchId: actor.role === 'student' || !actor.isMaster ? actor.branchId : undefined });
    if (actor.role !== 'student') return all.filter(c => c.status === 'published' || c.status === 'held');
    const { rows } = await pool.query(`SELECT course_id FROM enrollments WHERE student_id = $1`, [actor.id]);
    const enrolled = new Set(rows.map(r => r.course_id as string));
    const visible: CourseSummary[] = all.filter(c => studentCanSeeCourse(c, actor.branchId, enrolled.has(c.id)));
    // Students do not need missing/file counts of the build process.
    return visible.map(c => ({ ...c, counts: { ...c.counts, missing: 0 } }));
  });

  app.get<{ Params: { id: string } }>('/student/courses/:id', auth, async (request, reply) => {
    const actor = await getActor(request);
    const found = await courseForViewer(actor, request.params.id, reply);
    if (!found) return;
    const { detail, enrolled } = found;
    const [stepTypes, policies, size] = await Promise.all([loadStepTypes(), getEffectivePolicies(actor.branchId), savedSize(actor.id)]);
    const chooseOne = policies['student.choose_one_size'] !== false;
    const mySize = chooseMySize(size, detail.mistarSizes);
    const levels = studentLevels(detail.levels, stepTypes, mySize, chooseOne);
    const steps = levels.flatMap(l => l.steps);
    const stepIds = steps.map(s => s.id);

    let doneIds = new Set<string>();
    let submissions: SubmissionLite[] = [];
    const unread = new Map<string, number>();
    if (actor.role === 'student' && stepIds.length) {
      const ph = inList(stepIds.length, 2);
      const [done, subs, msgs] = await Promise.all([
        pool.query(`SELECT step_id FROM step_progress WHERE student_id = $1 AND step_id IN (${ph})`, [actor.id, ...stepIds]),
        pool.query(`SELECT step_id, attempt_no, status, mark, band, created_at FROM step_submissions WHERE student_id = $1 AND step_id IN (${ph})`, [actor.id, ...stepIds]),
        pool.query(`SELECT step_id, COUNT(*) AS n FROM thread_messages WHERE student_id = $1 AND step_id IN (${ph}) AND student_read_at IS NULL AND sender_role <> 'student' GROUP BY step_id`, [actor.id, ...stepIds]),
      ]);
      doneIds = new Set(done.rows.map(r => r.step_id as string));
      submissions = subs.rows.map(r => ({
        stepId: r.step_id, attemptNo: Number(r.attempt_no ?? 1), status: r.status, mark: r.mark === null || r.mark === undefined ? null : Number(r.mark),
        band: r.band ?? null, createdAt: r.created_at,
      }));
      for (const r of msgs.rows) unread.set(r.step_id, Number(r.n));
    }
    const stepStates = creditPassedLevels(levels, stepTypes, buildStepStates(steps, stepTypes, doneIds, submissions, unread));
    // Staff previews see every level open.
    const unlockedLevelIds = actor.role === 'student' ? computeUnlockedLevelIds(levels, stepTypes, passedStepIdsFrom(submissions)) : levels.map(l => l.id);
    let enrolledAt: string | null = null;
    if (actor.role === 'student' && enrolled) {
      const { rows } = await pool.query(`SELECT enrolled_at FROM enrollments WHERE student_id = $1 AND course_id = $2 LIMIT 1`, [actor.id, detail.id]);
      enrolledAt = rows[0]?.enrolled_at ? new Date(rows[0].enrolled_at).toISOString() : null;
    }
    const body: StudentCourse & { enrolledAt: string | null } = {
      ...detail,
      enrolledAt,
      masterRow: null,
      driveFolderUrl: null,
      counts: { ...detail.counts, missing: 0 },
      levels,
      enrolled,
      unlockedLevelIds,
      progressPercent: computeProgressPercent(stepIds, stepStates),
      stepStates,
      stepTypes,
      policies: {
        'print.instructions': policies['print.instructions'],
        'print.allow_multi': policies['print.allow_multi'],
        'assessment.bands': policies['assessment.bands'],
        'uploads.max_files': policies['uploads.max_files'],
        'student.choose_one_size': policies['student.choose_one_size'],
      },
      mySize,
    };
    return body;
  });

  app.post<{ Params: { id: string } }>('/student/courses/:id/enroll', auth, async (request, reply) => {
    const actor = await getActor(request);
    if (actor.role !== 'student') return reply.code(403).send({ error: 'Only students can join a course.' });
    const detail = await loadCourseDetail(request.params.id);
    if (!detail || detail.structureVersion !== 2) return reply.code(404).send({ error: 'Course not found.' });
    const enrolled = await isEnrolled(actor.id, detail.id);
    if (enrolled) return { enrolled: true, courseId: detail.id, message: 'You are already in this course.' };
    if (detail.branchIds.length && !detail.branchIds.includes(actor.branchId)) return reply.code(404).send({ error: 'This course is not available to you.' });
    if (detail.status === 'held') return reply.code(409).send({ error: 'This course is paused for new students. Please check again later.' });
    if (detail.status !== 'published') return reply.code(404).send({ error: 'This course is not available to you.' });
    await pool.query(`INSERT IGNORE INTO enrollments (student_id, course_id) VALUES ($1, $2)`, [actor.id, detail.id]);
    await logAudit({ actorId: actor.id, branchId: actor.branchId, action: 'student.enroll', entityType: 'course', entityId: detail.id, summary: `${actor.name || 'Student'} joined ${detail.code ?? detail.title}` });
    return { enrolled: true, courseId: detail.id, message: `Welcome to ${detail.title}!` };
  });

  async function checkDoneAllowed(actor: Actor, stepId: string, reply: FastifyReply) {
    if (actor.role !== 'student') { reply.code(403).send({ error: 'Only students mark steps as done.' }); return null; }
    const step = await stepLookup(stepId);
    if (!step) { reply.code(404).send({ error: 'Step not found.' }); return null; }
    const found = await courseForViewer(actor, step.course_id, reply);
    if (!found) return null;
    const stepTypes = await loadStepTypes();
    const def = stepTypes.find(t => t.typeKey === step.step_type);
    if (!def || def.studentAction !== 'watch_download') { reply.code(400).send({ error: 'This step is finished by uploading your work, not by "Mark as done".' }); return null; }
    const levels = studentLevels(found.detail.levels, stepTypes, null, false);
    if (!levels.some(l => l.steps.some(s => s.id === stepId))) { reply.code(404).send({ error: 'This step is not available.' }); return null; }
    const { rows } = await pool.query(`SELECT step_id, attempt_no, status, mark, band, created_at FROM step_submissions WHERE student_id = $1 AND course_id = $2`, [actor.id, step.course_id]);
    const passed = passedStepIdsFrom(rows.map(r => ({ stepId: r.step_id, attemptNo: Number(r.attempt_no), status: r.status, mark: r.mark, band: r.band, createdAt: r.created_at })));
    if (!computeUnlockedLevelIds(levels, stepTypes, passed).includes(step.level_id)) { reply.code(409).send({ error: 'This level is still locked. Pass the assessment of the level before it first.' }); return null; }
    return { step, found };
  }

  app.post<{ Params: { id: string } }>('/student/steps/:id/done', auth, async (request, reply) => {
    const actor = await getActor(request);
    const ctx = await checkDoneAllowed(actor, request.params.id, reply);
    if (!ctx) return;
    if (!ctx.found.enrolled) {
      if (ctx.found.detail.status !== 'published') return reply.code(409).send({ error: 'This course is paused for new students.' });
      await pool.query(`INSERT IGNORE INTO enrollments (student_id, course_id) VALUES ($1, $2)`, [actor.id, ctx.step.course_id]);
    }
    await pool.query(`INSERT IGNORE INTO step_progress (student_id, step_id) VALUES ($1, $2)`, [actor.id, request.params.id]);
    return { stepId: request.params.id, done: true };
  });

  app.delete<{ Params: { id: string } }>('/student/steps/:id/done', auth, async (request, reply) => {
    const actor = await getActor(request);
    if (actor.role !== 'student') return reply.code(403).send({ error: 'Only students mark steps as done.' });
    await pool.query(`DELETE FROM step_progress WHERE student_id = $1 AND step_id = $2`, [actor.id, request.params.id]);
    return { stepId: request.params.id, done: false };
  });

  app.patch<{ Body: { mistarSize?: unknown } }>('/student/preferences', auth, async (request, reply) => {
    const actor = await getActor(request);
    const raw = request.body?.mistarSize;
    let size: string | null;
    if (raw === null || raw === '') size = null;
    else if (typeof raw === 'string') size = (SIZE_CODES as readonly string[]).includes(raw.toUpperCase()) ? raw.toUpperCase() : sizeFromText(raw);
    else return reply.code(400).send({ error: 'Choose a mistar size.' });
    if (raw !== null && raw !== '' && !size) return reply.code(400).send({ error: 'Mistar size must be 0.7 mm, 1 mm, 2 mm, 3 mm or Normal pen.' });
    await pool.query(`UPDATE users SET mistar_size = $1 WHERE id = $2`, [size, actor.id]);
    return { mistarSize: size, label: size ? sizeLabel(size) : null };
  });
}
