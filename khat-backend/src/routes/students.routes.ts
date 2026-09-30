import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

type Viewer = 'self' | 'teacher' | 'admin';

function resolveViewer(requester: AuthUser, studentId: string): Viewer | null {
  if (requester.id === studentId) return 'self';
  if (requester.role === 'admin') return 'admin';
  if (requester.role === 'teacher') return 'teacher'; // org-wide, any branch — see §4.3.1
  return null; // a student viewing another student — not allowed
}

export async function studentProfileRoutes(app: FastifyInstance) {
  // ---- Directory list — admin sees everyone; a branch coordinator only ever
  // sees their own branch (enforced from their token, not a client-supplied
  // param); a plain teacher gets no roster, only individual profile lookups
  // when they actually have a reason to (e.g. reviewing an entry). ----
  app.get<{ Querystring: { branchId?: string } }>(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      let branchFilter: string | null = null;

      if (user.role === 'admin') {
        branchFilter = request.query.branchId ?? null;
      } else if (user.role === 'teacher' && user.isCoordinator) {
        branchFilter = user.branchId; // coordinators cannot widen this to another branch
      } else {
        return reply.code(403).send({ error: 'Not authorized to list students' });
      }

      const params: unknown[] = [user.role === 'admin'];
      let where = `WHERE role = 'student' AND deleted_at IS NULL`;
      if (branchFilter) {
        params.push(branchFilter);
        where += ` AND branch_id = $${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT id, name, tr_number, branch_id, created_at,
                CASE WHEN $1::boolean THEN photo_storage_key ELSE NULL END AS photo_storage_key
         FROM users ${where} ORDER BY name`,
        params
      );
      return rows;
    }
  );

  // ---- The tiered profile view ----
  app.get<{ Params: { id: string } }>('/:id/profile', { preHandler: [app.authenticate] }, async (request, reply) => {
    const requester = request.user as AuthUser;
    const viewer = resolveViewer(requester, request.params.id);
    if (!viewer) return reply.code(403).send({ error: 'Not authorized to view this profile' });

    const { rows: userRows } = await pool.query(
      `SELECT id, name, email, tr_number, branch_id, photo_storage_key, created_at
       FROM users WHERE id = $1 AND role = 'student' AND deleted_at IS NULL`,
      [request.params.id]
    );
    const student = userRows[0];
    if (!student) return reply.code(404).send({ error: 'Student not found' });

    const [enrollments, submissions, certificates, badges, activity, timeSpent] = await Promise.all([
      pool.query(
        `SELECT e.*, c.title AS course_title, c.category, c.khat_type_id
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         WHERE e.student_id = $1`,
        [student.id]
      ),
      // Every regular upload, individually — not just a count — so a teacher
      // can actually look at what was produced, not only how much.
      pool.query(
        `SELECT ls.*, l.title AS level_title, l.order_index, l.level_type, c.khat_type_id, c.id AS course_id
         FROM level_submissions ls
         JOIN levels l ON l.id = ls.level_id
         JOIN courses c ON c.id = l.course_id
         WHERE ls.student_id = $1
         ORDER BY ls.submitted_at DESC`,
        [student.id]
      ),
      pool.query(`SELECT * FROM certificates WHERE student_id = $1 ORDER BY issued_at DESC`, [student.id]),
      pool.query(`SELECT * FROM badges WHERE student_id = $1`, [student.id]),
      pool.query(`SELECT activity_date, login_count FROM activity_log WHERE user_id = $1 ORDER BY activity_date`, [
        student.id,
      ]),
      pool.query(
        `SELECT c.khat_type_id, SUM(ls.time_spent_minutes) AS total_minutes
         FROM level_submissions ls
         JOIN levels l ON l.id = ls.level_id
         JOIN courses c ON c.id = l.course_id
         WHERE ls.student_id = $1
         GROUP BY c.khat_type_id`,
        [student.id]
      ),
    ]);

    const base = {
      id: student.id,
      name: student.name,
      branchId: student.branch_id,
      enrollments: enrollments.rows,
      levelSubmissions: submissions.rows,
      certificates: certificates.rows,
      badges: badges.rows,
      activity: activity.rows,
      timeSpentByKhatType: timeSpent.rows,
    };

    if (viewer === 'teacher') {
      return base; // practice + activity only — no email, no photo, no contact fields
    }
    // 'self' and 'admin' both get the fuller view, including contact fields.
    // Admin additionally has the /export and DELETE routes below for governance.
    return {
      ...base,
      email: student.email,
      trNumber: student.tr_number,
      photoStorageKey: student.photo_storage_key,
      joinedAt: student.created_at,
    };
  });

  // ---- Admin: full data export across every table that references this student ----
  app.get<{ Params: { id: string } }>(
    '/:id/export',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1 AND role = 'student'`, [
        request.params.id,
      ]);
      if (!userRows[0]) return reply.code(404).send({ error: 'Student not found' });

      const studentId = request.params.id;
      const [
        enrollments,
        submissions,
        entries,
        certificates,
        badges,
        activity,
        showcasePosts,
        competitionEntries,
        eventAttendance,
      ] = await Promise.all([
        pool.query(`SELECT * FROM enrollments WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM level_submissions WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM entries WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM certificates WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM badges WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM activity_log WHERE user_id = $1`, [studentId]),
        pool.query(`SELECT * FROM showcase_posts WHERE user_id = $1`, [studentId]),
        pool.query(`SELECT * FROM competition_entries WHERE student_id = $1`, [studentId]),
        pool.query(`SELECT * FROM event_attendance WHERE student_id = $1`, [studentId]),
      ]);

      return {
        user: userRows[0],
        enrollments: enrollments.rows,
        levelSubmissions: submissions.rows,
        entries: entries.rows,
        certificates: certificates.rows,
        badges: badges.rows,
        activity: activity.rows,
        showcasePosts: showcasePosts.rows,
        competitionEntries: competitionEntries.rows,
        eventAttendance: eventAttendance.rows,
      };
    }
  );

  // ---- Admin: soft-delete (data governance) — no self-service deletion anywhere else ----
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rows } = await pool.query(
        `UPDATE users SET deleted_at = now() WHERE id = $1 AND role = 'student' RETURNING id`,
        [request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Student not found' });
      return reply.code(204).send();
    }
  );

  app.patch<{ Params: { id: string }; Body: { photoStorageKey: string } }>(
    '/:id/photo',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const requester = request.user as AuthUser;
      if (requester.id !== request.params.id && requester.role !== 'admin') {
        return reply.code(403).send({ error: 'You can only update your own photo' });
      }
      const { photoStorageKey } = request.body;
      if (!photoStorageKey) return reply.code(400).send({ error: 'photoStorageKey is required' });
      await pool.query(`UPDATE users SET photo_storage_key = $1 WHERE id = $2`, [photoStorageKey, request.params.id]);
      return { success: true, photoStorageKey };
    }
  );
}
