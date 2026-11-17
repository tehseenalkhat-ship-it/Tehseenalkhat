import type { FastifyInstance } from 'fastify';
import { canSeeBranch, getActor, requireStaff } from '../lib/access.js';
import { loadCohortAnalysis, loadStudentAnalysis, studentBranch } from '../lib/analysisData.js';
import { clampInt } from '../lib/analysisLogic.js';
import type { CohortAnalysis, StudentAnalysis } from '../lib/analysisTypes.js';

// owner: analysis — smart analysis of one student (student + staff view) and of a class.
// Registered under prefix '/v2'. Types: src/v2/lib/analysisTypes.ts (copy in the frontend).

const ID_RE = /^[0-9A-Za-z-]{8,64}$/;

export async function analysisV2Routes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };
  const staff = { preHandler: [app.authenticate, requireStaff(app)] };

  /** The student's own "My progress". */
  app.get('/analysis/me', auth, async (request, reply) => {
    const actor = await getActor(request);
    if (actor.role !== 'student') return reply.code(403).send({ error: 'My progress is for students. Teachers can open a student from Student insights.' });
    const body: StudentAnalysis | null = await loadStudentAnalysis(actor.id, 'student');
    if (!body) return reply.code(404).send({ error: 'We could not find your student record.' });
    return body;
  });

  /** Staff drill-down: teachers / coordinators / branch admins for their branch, master admins for any. */
  app.get<{ Params: { id: string } }>('/analysis/student/:id', staff, async (request, reply) => {
    const actor = await getActor(request);
    const id = String(request.params.id ?? '');
    if (!ID_RE.test(id)) return reply.code(400).send({ error: 'This student link is not valid.' });
    const branchId = await studentBranch(id);
    if (!branchId) return reply.code(404).send({ error: 'Student not found.' });
    if (!canSeeBranch(actor, branchId)) return reply.code(403).send({ error: 'You can only open students of your own branch.' });
    const body: StudentAnalysis | null = await loadStudentAnalysis(id, 'staff');
    if (!body) return reply.code(404).send({ error: 'Student not found.' });
    return body;
  });

  /** Class view. Teachers: their branch. Master admins: any branch, or all when branchId is empty. */
  app.get<{ Querystring: { branchId?: string; courseId?: string; stuckDays?: string } }>('/analysis/cohort', staff, async (request, reply) => {
    const actor = await getActor(request);
    const wanted = request.query.branchId?.trim() || null;
    let branchId: string | null;
    if (actor.isMaster) branchId = wanted;
    else {
      if (wanted && wanted !== actor.branchId) return reply.code(403).send({ error: 'You can only see the class of your own branch.' });
      branchId = actor.branchId;
    }
    if (branchId && !ID_RE.test(branchId)) return reply.code(400).send({ error: 'This branch is not valid.' });
    const courseId = request.query.courseId?.trim() || null;
    if (courseId && !ID_RE.test(courseId)) return reply.code(400).send({ error: 'This course is not valid.' });
    const body: CohortAnalysis = await loadCohortAnalysis({ branchId, courseId, stuckDays: clampInt(request.query.stuckDays, 14, 3, 365) });
    return body;
  });
}
