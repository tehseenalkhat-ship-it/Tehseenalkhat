import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { autoAssignEntry } from '../services/entryRouting.js';

type EnrollBody = { courseId: string };
type SubmitBody = { fileStorageKey: string; originalFilename?: string; timeSpentMinutes: number };

export async function levelSubmissionRoutes(app: FastifyInstance) {
  // ---- Enroll in a course (idempotent — re-enrolling is a no-op) ----
  app.post<{ Body: EnrollBody }>(
    '/enroll',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { courseId } = request.body;
      if (!courseId) return reply.code(400).send({ error: 'courseId is required' });

      const { rows } = await pool.query(
        `INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2)
         ON CONFLICT (student_id, course_id) DO NOTHING RETURNING *`,
        [studentId, courseId]
      );
      if (rows[0]) return reply.code(201).send(rows[0]);

      const { rows: existing } = await pool.query(
        `SELECT * FROM enrollments WHERE student_id = $1 AND course_id = $2`,
        [studentId, courseId]
      );
      return existing[0];
    }
  );

  // ---- My progress in a course — which levels are unlocked ----
  app.get<{ Params: { courseId: string } }>(
    '/courses/:courseId/progress',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { rows: enrollmentRows } = await pool.query(
        `SELECT * FROM enrollments WHERE student_id = $1 AND course_id = $2`,
        [studentId, request.params.courseId]
      );
      const enrollment = enrollmentRows[0];
      if (!enrollment) return reply.code(404).send({ error: 'Not enrolled in this course' });

      const { rows: courseRows } = await pool.query(`SELECT category FROM courses WHERE id = $1`, [
        request.params.courseId,
      ]);
      const isSecondary = courseRows[0]?.category === 'secondary';

      const { rows: levels } = await pool.query(
        `SELECT * FROM levels WHERE course_id = $1 ORDER BY order_index`,
        [request.params.courseId]
      );
      const { rows: passedCheckpointRows } = await pool.query(
        `SELECT DISTINCT e.level_id
         FROM entries e JOIN levels l ON l.id = e.level_id
         WHERE e.student_id = $1 AND l.course_id = $2
           AND e.source_type IN ('checkpoint', 'level_practice') AND e.status = 'reviewed'`,
        [studentId, request.params.courseId]
      );
      const passedCheckpoints = new Set(passedCheckpointRows.map((row: { level_id: string }) => row.level_id));
      // Preserve the existing enrollment pointer for students who progressed
      // before marking was introduced. New levels move this pointer only after
      // a passing teacher mark. The checkpoint barrier remains unchanged.
      const withLockState = levels.map((l) => ({
        ...l,
        locked: (!isSecondary && l.order_index > enrollment.current_level_index) || levels.some((checkpoint) =>
          checkpoint.level_type === 'test' && checkpoint.order_index < l.order_index && !passedCheckpoints.has(checkpoint.id)
        ),
      }));

      return { enrollment, levels: withLockState };
    }
  );

  // ---- Submit regular practice for a level — the actual missing feature ----
  // Locked levels are rejected server-side, not just hidden by the frontend.
  // Test levels go through POST /entries instead, never through here.
  app.post<{ Params: { levelId: string }; Body: SubmitBody }>(
    '/:levelId/submissions',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { fileStorageKey, originalFilename, timeSpentMinutes } = request.body;
      if (!fileStorageKey || timeSpentMinutes === undefined) {
        return reply.code(400).send({ error: 'fileStorageKey and timeSpentMinutes are required' });
      }

      const { rows: levelRows } = await pool.query(`SELECT * FROM levels WHERE id = $1`, [request.params.levelId]);
      const level = levelRows[0];
      if (!level) return reply.code(404).send({ error: 'Level not found' });
      if (level.level_type === 'test') {
        return reply.code(400).send({ error: 'Checkpoint tests are submitted via POST /entries, not here' });
      }

      const { rows: courseRows } = await pool.query(`SELECT category FROM courses WHERE id = $1`, [level.course_id]);
      const isSecondary = courseRows[0]?.category === 'secondary';

      // Auto-enroll on first submission if there's no enrollment yet — simpler
      // UX than forcing an explicit enroll step before a student can start.
      const { rows: enrollmentRows } = await pool.query(
        `INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2)
         ON CONFLICT (student_id, course_id) DO UPDATE SET student_id = enrollments.student_id
         RETURNING *`,
        [studentId, level.course_id]
      );
      const enrollment = enrollmentRows[0];

      const { rows: blockingCheckpoints } = await pool.query(
        `SELECT l.title FROM levels l
         WHERE l.course_id = $1 AND l.level_type = 'test' AND l.order_index < $2
           AND NOT EXISTS (
             SELECT 1 FROM entries e
             WHERE e.student_id = $3 AND e.level_id = l.id
               AND e.source_type = 'checkpoint' AND e.status = 'reviewed'
           )
         ORDER BY l.order_index LIMIT 1`,
        [level.course_id, level.order_index, studentId]
      );
      if (blockingCheckpoints[0]) {
        return reply.code(403).send({ error: `Pass the earlier checkpoint “${blockingCheckpoints[0].title}” before continuing` });
      }

      // The actual lock enforcement: this level's position must be within
      // what the student has already unlocked. Secondary courses skip sequence
      // locks, but the checkpoint barrier above applies to every course.
      if (!isSecondary && level.order_index > enrollment.current_level_index) {
        return reply.code(403).send({ error: 'This level is locked — complete the checkpoint before it first' });
      }

      const { rows: activeRows } = await pool.query(
        `SELECT id FROM entries WHERE student_id = $1 AND level_id = $2
         AND source_type = 'checkpoint' AND status IN ('pending', 'assigned', 'in_review') LIMIT 1`,
        [studentId, level.id]
      );
      if (activeRows[0]) return reply.code(409).send({ error: 'This level already has an entry awaiting teacher review' });

      const { rows: submissionRows } = await pool.query(
        `INSERT INTO level_submissions (student_id, level_id, time_spent_minutes, file_storage_key, original_filename)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [studentId, level.id, timeSpentMinutes, fileStorageKey, originalFilename ?? null]
      );
      const { rows: entryRows } = await pool.query(
        `INSERT INTO entries (student_id, source_type, level_id, khat_image_storage_key, original_filename)
         VALUES ($1, 'checkpoint', $2, $3, $4) RETURNING *`,
        [studentId, level.id, fileStorageKey, originalFilename ?? null]
      );
      await autoAssignEntry(entryRows[0].id);

      return reply.code(201).send({ ...entryRows[0], level_submission_id: submissionRows[0].id });
    }
  );
}
