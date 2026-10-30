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
         WHERE e.student_id = $1 AND l.course_id = $2 AND l.level_type = 'test'
           AND e.source_type = 'checkpoint' AND e.status = 'reviewed'`,
        [studentId, request.params.courseId]
      );
      const passedCheckpoints = new Set(passedCheckpointRows.map((row: { level_id: string }) => row.level_id));
      // Secondary/self-learning courses have no locks at all — every level is
      // open regardless of order unless an earlier checkpoint is still unpassed.
      const withLockState = levels.map((l) => ({
        ...l,
        locked: l.level_type === 'test'
          ? l.order_index > enrollment.current_level_index || levels.some((checkpoint) =>
              checkpoint.level_type === 'test' && checkpoint.order_index < l.order_index && !passedCheckpoints.has(checkpoint.id)
            )
          : !isSecondary && (l.order_index > enrollment.current_level_index || levels.some((checkpoint) =>
              checkpoint.level_type === 'test' && checkpoint.order_index < l.order_index && !passedCheckpoints.has(checkpoint.id)
            )),
      }));

      return { enrollment, levels: withLockState };
    }
  );

  // Compatibility endpoint for older clients. New clients use POST /entries
  // directly; both paths now create a teacher-marked timeline entry.
  app.post<{ Params: { levelId: string }; Body: SubmitBody }>(
    '/:levelId/submissions',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { fileStorageKey, originalFilename, timeSpentMinutes } = request.body;
      if (!fileStorageKey || !Number.isInteger(timeSpentMinutes) || timeSpentMinutes <= 0) {
        return reply.code(400).send({ error: 'fileStorageKey and a positive whole timeSpentMinutes are required' });
      }

      const { rows: levelRows } = await pool.query(`SELECT * FROM levels WHERE id = $1`, [request.params.levelId]);
      const level = levelRows[0];
      if (!level) return reply.code(404).send({ error: 'Level not found' });
      if (level.level_type === 'test') {
        return reply.code(400).send({ error: 'Checkpoint tests are submitted via POST /entries, not here' });
      }

      const { rows: courseRows } = await pool.query(`SELECT category FROM courses WHERE id = $1`, [level.course_id]);
      const isSecondary = courseRows[0]?.category === 'secondary';

      const { rows: enrollmentRows } = await pool.query(
        `SELECT * FROM enrollments WHERE student_id = $1 AND course_id = $2`,
        [studentId, level.course_id]
      );
      const enrollment = enrollmentRows[0];
      if (!enrollment) return reply.code(403).send({ error: 'Enroll in this course before submitting work' });

      if (!isSecondary) {
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

        if (level.order_index > enrollment.current_level_index) {
          return reply.code(403).send({ error: 'This level is locked — complete the earlier work first' });
        }
      }

      const entryKind = isSecondary ? 'secondary_marking' : 'practice_marking';
      const { rows: submissionRows } = await pool.query(
        `INSERT INTO entries (student_id, source_type, level_id, khat_image_storage_key, original_filename, entry_kind, time_spent_minutes)
         VALUES ($1, 'checkpoint', $2, $3, $4, $5, $6) RETURNING *`,
        [studentId, level.id, fileStorageKey, originalFilename ?? null, entryKind, timeSpentMinutes]
      );
      await autoAssignEntry(submissionRows[0].id);
      return reply.code(201).send(submissionRows[0]);
    }
  );
}
