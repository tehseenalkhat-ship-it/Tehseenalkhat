import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';
import { notify } from '../services/notify.js';

type CreateTemplateBody = {
  khatTypeId: string;
  levelId?: string; // a level in the primary certification course
  courseId?: string; // a secondary-course finishing certificate
  title: string;
  fileStorageKey: string;
};

export async function certificateRoutes(app: FastifyInstance) {
  // ---- Admin: create a certificate template, tied to a primary level or secondary course ----
  app.post<{ Body: CreateTemplateBody }>(
    '/templates',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { khatTypeId, levelId, courseId, title, fileStorageKey } = request.body;
      if (!khatTypeId || !title || !fileStorageKey) {
        return reply.code(400).send({ error: 'khatTypeId, title, and fileStorageKey are required' });
      }
      if (Boolean(levelId) === Boolean(courseId)) {
        return reply.code(400).send({ error: 'Provide exactly one target: levelId for a primary course or courseId for a secondary course' });
      }

      const targetQuery = levelId
        ? await pool.query(
          `SELECT c.khat_type_id, c.category FROM levels l JOIN courses c ON c.id = l.course_id WHERE l.id = $1`,
          [levelId]
        )
        : await pool.query(`SELECT khat_type_id, category FROM courses WHERE id = $1`, [courseId]);
      const target = targetQuery.rows[0];
      if (!target) return reply.code(404).send({ error: 'Certificate target not found' });
      if (target.khat_type_id !== khatTypeId) {
        return reply.code(400).send({ error: 'Certificate Khat type must match its course target' });
      }
      if (levelId && target.category !== 'certification') {
        return reply.code(400).send({ error: 'Level certificates can only target a primary certification course' });
      }
      if (courseId && target.category !== 'secondary') {
        return reply.code(400).send({ error: 'Course-completion certificates can only target a secondary course' });
      }

      const adminId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `INSERT INTO certificate_templates (khat_type_id, level_id, course_id, title, file_storage_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [khatTypeId, levelId ?? null, courseId ?? null, title, fileStorageKey, adminId]
      );
      return reply.code(201).send(rows[0]);
    }
  );

  app.get('/templates', { preHandler: [app.authenticate, app.requireRole('admin')] }, async () => {
    const { rows } = await pool.query(
      `SELECT ct.*, COALESCE(level_course.title, completion_course.title) AS course_title,
              COALESCE(level_course.category, completion_course.category) AS course_category,
              l.title AS level_title, l.order_index AS level_order_index
       FROM certificate_templates ct
       LEFT JOIN levels l ON l.id = ct.level_id
       LEFT JOIN courses level_course ON level_course.id = l.course_id
       LEFT JOIN courses completion_course ON completion_course.id = ct.course_id
       ORDER BY ct.created_at DESC`
    );
    return rows;
  });

  app.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { rowCount } = await pool.query(`DELETE FROM certificate_templates WHERE id = $1`, [request.params.id]);
      if (!rowCount) return reply.code(404).send({ error: 'Template not found' });
      return reply.code(204).send();
    }
  );

  // ---- Admin: the approval queue — certificates land here automatically on a pass ----
  app.get('/pending', { preHandler: [app.authenticate, app.requireRole('admin')] }, async () => {
    const { rows } = await pool.query(
      `SELECT c.*, u.name AS student_name FROM certificates c
       JOIN users u ON u.id = c.student_id
       WHERE c.status = 'pending' ORDER BY c.issued_at ASC`
    );
    return rows;
  });

  app.post<{ Params: { id: string } }>(
    '/:id/approve',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const adminId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `UPDATE certificates SET status = 'approved', approved_by = $1, approved_at = now()
         WHERE id = $2 AND status = 'pending' RETURNING *`,
        [adminId, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Pending certificate not found' });
      await notify(rows[0].student_id, 'certificate_approved', { certificateId: rows[0].id, title: rows[0].title });
      return rows[0];
    }
  );

  app.post<{ Params: { id: string } }>(
    '/:id/reject',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const adminId = (request.user as AuthUser).id;
      const { rows } = await pool.query(
        `UPDATE certificates SET status = 'rejected', approved_by = $1, approved_at = now()
         WHERE id = $2 AND status = 'pending' RETURNING *`,
        [adminId, request.params.id]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Pending certificate not found' });
      await notify(rows[0].student_id, 'certificate_rejected', { certificateId: rows[0].id, title: rows[0].title });
      return rows[0];
    }
  );

  // ---- A student's own approved certificates (pending ones stay invisible to them) ----
  app.get('/mine', { preHandler: [app.authenticate, app.requireRole('student')] }, async (request) => {
    const studentId = (request.user as AuthUser).id;
    const { rows } = await pool.query(
      `SELECT * FROM certificates WHERE student_id = $1 AND status = 'approved' ORDER BY issued_at DESC`,
      [studentId]
    );
    return rows;
  });

  app.get<{ Querystring: { status?: string } }>(
    '/',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request) => {
      const { status } = request.query;
      const params: unknown[] = [];
      let where = '';
      if (status) { params.push(status); where = `WHERE status = $1`; }
      const { rows } = await pool.query(`SELECT * FROM certificates ${where} ORDER BY issued_at DESC`, params);
      return rows;
    }
  );
}
