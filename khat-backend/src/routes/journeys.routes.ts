import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

type JourneyRow = {
  id: string;
  kind: 'enrolled' | 'practice_submission' | 'teacher_entry';
  level_id: string | null;
  level_title: string | null;
  level_order_index: number | null;
  entry_kind: 'practice_marking' | 'checkpoint_assessment' | 'secondary_marking' | null;
  storage_key: string | null;
  original_filename: string | null;
  time_spent_minutes: number | null;
  status: string;
  mark_out_of_ten: number | null;
  mark_passed: boolean | null;
  feedback: string | null;
  correction_image_storage_key: string | null;
  correction_voice_storage_key: string | null;
  redo_of_entry_id: string | null;
  created_at: string;
  reviewed_at: string | null;
};

const JOURNEY_ITEMS_SQL = `
  SELECT id, kind, level_id, level_title, level_order_index, entry_kind,
         storage_key, original_filename, time_spent_minutes, status,
         mark_out_of_ten, mark_passed, feedback, correction_image_storage_key,
         correction_voice_storage_key, redo_of_entry_id, created_at, reviewed_at
  FROM (
    SELECT e.id::text AS id, 'teacher_entry'::text AS kind, e.level_id::text AS level_id,
           l.title AS level_title, l.order_index AS level_order_index,
           COALESCE(e.entry_kind, CASE WHEN l.level_type = 'test' THEN 'checkpoint_assessment' WHEN c.category = 'secondary' THEN 'secondary_marking' ELSE 'practice_marking' END) AS entry_kind,
           e.khat_image_storage_key AS storage_key, e.original_filename,
           e.time_spent_minutes, e.status, e.mark_out_of_ten, e.mark_passed, e.feedback,
           e.correction_image_storage_key, e.correction_voice_storage_key,
           e.redo_of_entry_id::text AS redo_of_entry_id, e.created_at, e.reviewed_at
    FROM entries e
    JOIN levels l ON l.id = e.level_id
    JOIN courses c ON c.id = l.course_id
    WHERE e.student_id = $1 AND c.id = $2 AND e.source_type = 'checkpoint'

    UNION ALL

    SELECT ls.id::text AS id, 'practice_submission'::text AS kind, ls.level_id::text AS level_id,
           l.title AS level_title, l.order_index AS level_order_index,
           CASE WHEN c.category = 'secondary' THEN 'secondary_marking' ELSE 'practice_marking' END AS entry_kind,
           ls.file_storage_key AS storage_key, ls.original_filename, ls.time_spent_minutes,
           'legacy_practice'::text AS status, NULL::smallint AS mark_out_of_ten,
           NULL::boolean AS mark_passed, NULL::text AS feedback, NULL::text AS correction_image_storage_key,
           NULL::text AS correction_voice_storage_key, NULL::text AS redo_of_entry_id,
           ls.submitted_at AS created_at, NULL::timestamptz AS reviewed_at
    FROM level_submissions ls
    JOIN levels l ON l.id = ls.level_id
    JOIN courses c ON c.id = l.course_id
    WHERE ls.student_id = $1 AND c.id = $2

    UNION ALL

    SELECT en.id::text AS id, 'enrolled'::text AS kind, NULL::text AS level_id,
           NULL::text AS level_title, NULL::integer AS level_order_index, NULL::text AS entry_kind,
           NULL::text AS storage_key, NULL::text AS original_filename, NULL::integer AS time_spent_minutes,
           en.status AS status, NULL::smallint AS mark_out_of_ten, NULL::boolean AS mark_passed,
           NULL::text AS feedback, NULL::text AS correction_image_storage_key,
           NULL::text AS correction_voice_storage_key, NULL::text AS redo_of_entry_id,
           en.enrolled_at AS created_at, NULL::timestamptz AS reviewed_at
    FROM enrollments en
    WHERE en.student_id = $1 AND en.course_id = $2
  ) journey_items
  ORDER BY created_at ASC, id ASC
`;

export async function journeyRoutes(app: FastifyInstance) {
  app.get<{ Params: { courseId: string } }>(
    '/courses/:courseId',
    { preHandler: [app.authenticate, app.requireRole('student')] },
    async (request, reply) => {
      const studentId = (request.user as AuthUser).id;
      const { rows: courseRows } = await pool.query(
        `SELECT c.id, c.title, c.category, c.description, kt.display_name AS khat_type_name
         FROM courses c JOIN khat_types kt ON kt.id = c.khat_type_id
         WHERE c.id = $1 AND EXISTS (
           SELECT 1 FROM enrollments en WHERE en.course_id = c.id AND en.student_id = $2
         )`,
        [request.params.courseId, studentId]
      );
      if (!courseRows[0]) return reply.code(404).send({ error: 'Enrolled course not found' });
      const { rows: items } = await pool.query(JOURNEY_ITEMS_SQL, [studentId, request.params.courseId]);
      return { student_id: studentId, course: courseRows[0], items };
    }
  );

  app.get<{ Params: { entryId: string } }>(
    '/entries/:entryId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const { rows: anchorRows } = await pool.query(
        `SELECT e.student_id, l.course_id, e.assigned_teacher_id, e.reviewed_by
         FROM entries e JOIN levels l ON l.id = e.level_id
         WHERE e.id = $1 AND e.source_type = 'checkpoint'`,
        [request.params.entryId]
      );
      const anchor = anchorRows[0];
      if (!anchor) return reply.code(404).send({ error: 'Course entry not found' });
      const isOwner = user.role === 'student' && anchor.student_id === user.id;
      const isAuthorizedTeacher = (user.role === 'teacher' || user.role === 'admin') &&
        (user.role === 'admin' || anchor.assigned_teacher_id === user.id || anchor.reviewed_by === user.id);
      if (!isOwner && !isAuthorizedTeacher) return reply.code(403).send({ error: 'Not authorized to view this course journey' });

      const { rows: courseRows } = await pool.query(
        `SELECT c.id, c.title, c.category, c.description, kt.display_name AS khat_type_name
         FROM courses c JOIN khat_types kt ON kt.id = c.khat_type_id WHERE c.id = $1`,
        [anchor.course_id]
      );
      const { rows: items } = await pool.query(JOURNEY_ITEMS_SQL, [anchor.student_id, anchor.course_id]);
      return { student_id: anchor.student_id, course: courseRows[0], items };
    }
  );
}
