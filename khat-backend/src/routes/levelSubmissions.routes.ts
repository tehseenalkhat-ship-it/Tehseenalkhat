import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notify, notifyAllAdmins } from '../services/notify.js';

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

      const { rows: submissionRows } = await pool.query(
        `INSERT INTO level_submissions (student_id, level_id, time_spent_minutes, file_storage_key, original_filename)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [studentId, level.id, timeSpentMinutes, fileStorageKey, originalFilename ?? null]
      );

      // Only advance the unlock pointer if this was the next expected level —
      // resubmitting an earlier (already-passed) level shouldn't move it backward.
      const { rows: totalRows } = await pool.query(`SELECT COUNT(*) AS total FROM levels WHERE course_id = $1`, [
        level.course_id,
      ]);
      const totalLevels = Number(totalRows[0].total);

      if (level.order_index === enrollment.current_level_index) {
        const newIndex = level.order_index + 1;
        const percentComplete = totalLevels > 0 ? Math.min(100, (newIndex / totalLevels) * 100) : 0;
        const justCompleted = newIndex >= totalLevels;

        await pool.query(
          `UPDATE enrollments SET current_level_index = $1, percent_complete = $2, status = $3 WHERE id = $4`,
          [newIndex, percentComplete, justCompleted ? 'completed' : 'active', enrollment.id]
        );

        // Primary certification courses can award at any configured level.
        // Secondary courses only award their configured certificate on completion.
        if (!isSecondary) {
          const { rows: templateRows } = await pool.query(
            `SELECT * FROM certificate_templates WHERE level_id = $1`,
            [level.id]
          );
          const template = templateRows[0];
          if (template) {
            const { rows: certificateRows } = await pool.query(
              `INSERT INTO certificates (student_id, khat_type_id, level_id, title, file_storage_key, status, template_id)
               SELECT $1, $2, $3, $4, $5, 'pending', $6
               WHERE NOT EXISTS (
                 SELECT 1 FROM certificates WHERE student_id = $1 AND template_id = $6
               ) RETURNING id, title`,
              [studentId, template.khat_type_id, level.id, template.title, template.file_storage_key, template.id]
            );
            const certificate = certificateRows[0];
            if (certificate) {
              await Promise.all([
                notify(studentId, 'certificate_pending_review', { certificateId: certificate.id, title: certificate.title }),
                notifyAllAdmins('certificate_pending_review', { certificateId: certificate.id, studentId, title: certificate.title }),
              ]);
            }
          }
        }

        if (justCompleted && isSecondary) {
          const { rows: templateRows } = await pool.query(
            `SELECT * FROM certificate_templates WHERE course_id = $1`,
            [level.course_id]
          );
          const template = templateRows[0];
          if (template) {
            const { rows: certificateRows } = await pool.query(
              `INSERT INTO certificates (student_id, khat_type_id, course_id, title, file_storage_key, status, template_id)
               SELECT $1, $2, $3, $4, $5, 'pending', $6
               WHERE NOT EXISTS (
                 SELECT 1 FROM certificates WHERE student_id = $1 AND template_id = $6
               ) RETURNING id, title`,
              [studentId, template.khat_type_id, level.course_id, template.title, template.file_storage_key, template.id]
            );
            const certificate = certificateRows[0];
            if (certificate) {
              await Promise.all([
                notify(studentId, 'certificate_pending_review', { certificateId: certificate.id, title: certificate.title }),
                notifyAllAdmins('certificate_pending_review', { certificateId: certificate.id, studentId, title: certificate.title }),
              ]);
            }
          }
        }
      }

      return reply.code(201).send(submissionRows[0]);
    }
  );
}
